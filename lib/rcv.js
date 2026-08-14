// Ranked-choice tally engine.
//
// Pure functions — no I/O, no DB, no Express. The same code backs the admin
// results page, the results email and the push notification, so the number you
// see on screen is the number that gets mailed.
//
// Two scores are produced from the same ballots:
//
//   instantRunoff()  the official winner. Eliminate the last-place destination
//                    each round and redistribute those ballots to their next
//                    surviving choice, until something holds a majority of the
//                    ballots still in play.
//   borda()          a secondary "consensus" view. A destination everyone ranks
//                    2nd scores well here but can lose the runoff to one that is
//                    half the group's 1st choice and half the group's last.
//
// When the two disagree that is worth knowing rather than hiding, so tally()
// reports both plus an `agreement` flag.

'use strict';

// Ballots arrive from the DB as arbitrary JSON. Drop anything that isn't a
// currently-active destination, drop duplicate ranks (a voter listing the same
// place twice), and keep the order. Returns ballots that still have at least one
// usable choice, plus a count of the ones that went empty.
function _normalize(ballots, candidates) {
  const active = new Set(candidates.map(c => String(c.id)));
  const usable = [];
  let blank = 0;

  for (const b of ballots || []) {
    const seen = new Set();
    const ranked = [];
    for (const raw of b.rankings || []) {
      const id = String(raw);
      if (!active.has(id) || seen.has(id)) continue;
      seen.add(id);
      ranked.push(id);
    }
    if (ranked.length) usable.push({ voter: b.voter ?? null, ranked });
    else blank++;
  }

  return { usable, blank };
}

function _nameMap(candidates) {
  const m = new Map();
  for (const c of candidates) m.set(String(c.id), c.name);
  return m;
}

// Points by position: with N destinations a 1st choice is worth N, 2nd N-1, and
// an unranked destination 0. Unequal ballot lengths are fine — someone who ranks
// only their top 3 simply hands out fewer points.
function borda(ballots, candidates) {
  const { usable } = _normalize(ballots, candidates);
  const names = _nameMap(candidates);
  const N = candidates.length;

  const acc = new Map();
  for (const c of candidates) {
    acc.set(String(c.id), { id: String(c.id), name: c.name, points: 0, firstPlace: 0, timesRanked: 0, _rankSum: 0 });
  }

  for (const b of usable) {
    b.ranked.forEach((id, i) => {
      const row = acc.get(id);
      row.points += N - i;
      row.timesRanked += 1;
      row._rankSum += i + 1;
      if (i === 0) row.firstPlace += 1;
    });
  }

  return [...acc.values()]
    .map(r => ({
      id: r.id,
      name: names.get(r.id),
      points: r.points,
      firstPlace: r.firstPlace,
      timesRanked: r.timesRanked,
      avgRank: r.timesRanked ? +(r._rankSum / r.timesRanked).toFixed(2) : null,
    }))
    .sort((a, b2) => b2.points - a.points || b2.firstPlace - a.firstPlace || a.name.localeCompare(b2.name));
}

// Deterministic elimination order. Fewest votes goes first; ties broken by the
// lower Borda score, then alphabetically so the same ballots always produce the
// same rounds (important — the email and the admin page tally independently).
//
// Also reports *how* it was broken, because "X finished last" is misleading
// when Y and Z had the identical vote count and survived — the report and the
// results reveal both need to say a tiebreak happened and on what basis, not
// just name a winner of it.
function _pickLoser(tied, bordaPoints, names) {
  const sorted = [...tied].sort((a, b) =>
    (bordaPoints.get(a) - bordaPoints.get(b)) ||
    names.get(a).localeCompare(names.get(b))
  );
  const loser = sorted[0];
  // Borda alone decided it only if the runner-up in the sort had strictly more
  // points — if they're equal, alphabetical order is what actually chose.
  const decidedByPoints = sorted.length > 1 && bordaPoints.get(loser) < bordaPoints.get(sorted[1]);
  return { loser, byAlpha: !decidedByPoints };
}

// Safe batch elimination.
//
// If the combined vote of the bottom k destinations is strictly less than the
// vote of the one above them, none of those k can overtake it, so eliminating
// them one per round can only pad the report — the outcome is identical either
// way. With a small group and seven destinations that is the difference between
// a readable three-round report and a nine-round one where five rounds just say
// "eliminated something nobody voted for".
//
// Returns the largest safe batch, or [] when no batch is provably safe (in
// which case the caller eliminates exactly one on the Borda tiebreak).
function _safeBatch(ascending) {
  let running = 0;
  let batch = [];
  for (let k = 0; k < ascending.length - 1; k++) {
    running += ascending[k][1];
    if (running < ascending[k + 1][1]) batch = ascending.slice(0, k + 1);
  }
  return batch.map(([id]) => id);
}

function instantRunoff(ballots, candidates) {
  const { usable, blank } = _normalize(ballots, candidates);
  const names = _nameMap(candidates);

  const bordaPoints = new Map(borda(ballots, candidates).map(r => [r.id, r.points]));
  const remaining = new Set(candidates.map(c => String(c.id)));
  const rounds = [];

  const result = {
    winner: null,
    tie: false,
    tiedAmong: [],
    rounds,
    totalBallots: usable.length + blank,
    countedBallots: usable.length,
    blankBallots: blank,
  };

  if (!usable.length || !remaining.size) return result;

  // Bounded by the field size — every iteration either finishes or eliminates one.
  for (let guard = 0; guard <= candidates.length + 1; guard++) {
    const counts = new Map();
    for (const id of remaining) counts.set(id, 0);

    let exhausted = 0;
    for (const b of usable) {
      const top = b.ranked.find(id => remaining.has(id));
      if (top) counts.set(top, counts.get(top) + 1);
      else exhausted++;
    }

    const continuing = usable.length - exhausted;
    // Majority of the ballots still in play, which is the standard IRV
    // threshold — exhausted ballots drop out of the denominator.
    const majority = Math.floor(continuing / 2) + 1;

    const round = {
      round: rounds.length + 1,
      counts: Object.fromEntries([...counts].map(([id, n]) => [id, n])),
      names: Object.fromEntries([...remaining].map(id => [id, names.get(id)])),
      continuing,
      exhausted,
      majority,
      eliminated: [],
      winner: null,
    };
    rounds.push(round);

    if (continuing === 0) return result;   // every ballot exhausted

    const ordered = [...counts].sort((a, b) => b[1] - a[1]);
    const [leader, leaderVotes] = ordered[0];

    if (leaderVotes >= majority || remaining.size === 1) {
      round.winner = leader;
      result.winner = { id: leader, name: names.get(leader), votes: leaderVotes, of: continuing };
      return result;
    }

    const minVotes = ordered[ordered.length - 1][1];
    const tiedLast = [...remaining].filter(id => counts.get(id) === minVotes);

    // Clear out every destination that provably cannot catch up, in one go.
    const ascending = [...ordered].reverse();
    const batch = _safeBatch(ascending);
    if (batch.length > 1) {
      for (const id of batch) remaining.delete(id);
      // The count that made the batch provably safe — everyone in it combined
      // still falls short of this, which is the number worth showing rather
      // than just asserting "couldn't catch up".
      const threshold = ascending[batch.length][1];
      round.eliminated = batch.map(id => ({
        id, name: names.get(id), votes: counts.get(id), tiedWith: [], tieBreak: null,
      }));
      round.batchThreshold = threshold;
      continue;
    }

    // Everyone left is tied — eliminating them all would empty the field, so the
    // runoff genuinely cannot separate them. Fall back to Borda and say so.
    if (tiedLast.length === remaining.size) {
      const best = [...remaining].sort((a, b) =>
        (bordaPoints.get(b) - bordaPoints.get(a)) ||
        names.get(a).localeCompare(names.get(b))
      )[0];
      result.tie = true;
      result.tiedAmong = [...remaining].map(id => ({ id, name: names.get(id) }));
      result.winner = { id: best, name: names.get(best), votes: counts.get(best), of: continuing, brokenBy: 'borda' };
      round.winner = best;
      return result;
    }

    const { loser, byAlpha } = _pickLoser(tiedLast, bordaPoints, names);
    const survivedTie = tiedLast.filter(id => id !== loser);
    remaining.delete(loser);
    round.eliminated = [{
      id: loser,
      name: names.get(loser),
      votes: counts.get(loser),
      // Empty when this destination was simply, unambiguously last — no tie to
      // explain. Populated when others shared the same low count and survived,
      // which is the case a bare "finished last" caption gets wrong.
      tiedWith: survivedTie.map(id => ({ id, name: names.get(id) })),
      tieBreak: survivedTie.length ? (byAlpha ? 'alpha' : 'borda') : null,
    }];
  }

  return result;
}

// Everything the admin page / email needs, from one pass over the ballots.
function tally(ballots, candidates) {
  const irv = instantRunoff(ballots, candidates);
  const bordaRows = borda(ballots, candidates);
  const consensus = bordaRows[0] || null;

  return {
    ...irv,
    borda: bordaRows,
    consensusPick: consensus ? { id: consensus.id, name: consensus.name, points: consensus.points } : null,
    agreement: !!(irv.winner && consensus && irv.winner.id === consensus.id),
  };
}

module.exports = { tally, instantRunoff, borda };
