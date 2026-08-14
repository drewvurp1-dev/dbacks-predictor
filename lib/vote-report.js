// Turns a tally() result plus the raw ballots into the results report:
// a plain-text body, an HTML body, and a short push-notification payload.
//
// Kept separate from routes/vote.js so the formatting is unit-testable and the
// email, the push and the admin page can't drift apart.

'use strict';

function _esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// One sentence explaining what a round's elimination actually means. A bare
// "X eliminated" reads as false when Y and Z had the identical vote count and
// survived — this is the one line that has to say a tiebreak happened.
function _elimLine(round) {
  if (!round.eliminated.length) return null;
  if (round.eliminated.length > 1) {
    const names = round.eliminated.map(e => e.name);
    const total = round.eliminated.reduce((a, e) => a + e.votes, 0);
    return `eliminated together: ${names.join('; ')} — ${total} combined, fewer than the ` +
      `${round.batchThreshold} held by the next place up, so none of them could possibly catch it.`;
  }
  const e = round.eliminated[0];
  if (!e.tiedWith.length) return `eliminated: ${e.name} (${e.votes} votes, clear last place).`;
  const others = e.tiedWith.map(t => t.name).join(', ');
  const basis = e.tieBreak === 'alpha'
    ? 'ranking points were tied too, so it came down to alphabetical order'
    : 'it had fewer ranking points across all ballots than the others';
  return `eliminated: ${e.name} — tied at ${e.votes} votes with ${others}, but ${basis}.`;
}

// "Istanbul > Phuket > Budapest" for one person's ballot.
function _ballotLine(ballot, nameById) {
  if (!ballot.rankings || !ballot.rankings.length) return '(no ranking submitted)';
  return ballot.rankings
    .map(id => nameById.get(String(id)))
    .filter(Boolean)
    .join('  >  ');
}

function buildReport(result, ballots, opts = {}) {
  const pollTitle = opts.pollTitle || 'Trip destination vote';
  const nameById = new Map(result.borda.map(r => [r.id, r.name]));
  const winner = result.winner;

  const L = [];
  L.push(pollTitle.toUpperCase());
  L.push('='.repeat(pollTitle.length));
  L.push('');

  if (!winner) {
    L.push('No winner — no usable ballots were submitted.');
  } else {
    L.push(`WINNER: ${winner.name}`);
    L.push(`Took ${winner.votes} of ${winner.of} continuing ballots in round ${result.rounds.length}.`);
    if (result.tie) {
      L.push(`NOTE: the runoff ended in a dead tie between ${result.tiedAmong.map(t => t.name).join('; ')}.`);
      L.push('      Broken on Borda points (the consensus score below).');
    }
    if (!result.agreement && result.consensusPick) {
      L.push(`NOTE: the consensus score prefers ${result.consensusPick.name}. Worth a look before booking.`);
    }
  }

  L.push('');
  L.push(`Ballots: ${result.countedBallots} counted` + (result.blankBallots ? `, ${result.blankBallots} blank` : ''));
  L.push('');

  L.push('ROUND BY ROUND (instant runoff)');
  L.push('-'.repeat(31));
  for (const r of result.rounds) {
    L.push(`Round ${r.round} — majority needs ${r.majority} of ${r.continuing}` + (r.exhausted ? ` (${r.exhausted} exhausted)` : ''));
    const rows = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
    for (const [id, n] of rows) {
      const pct = r.continuing ? Math.round((n / r.continuing) * 100) : 0;
      L.push(`   ${String(n).padStart(3)}  (${String(pct).padStart(3)}%)  ${r.names[id]}`);
    }
    const elimLine = _elimLine(r);
    if (elimLine) L.push(`   ✗ ${elimLine}`);
    if (r.winner) L.push(`   ✓ winner: ${r.names[r.winner]}`);
    L.push('');
  }

  L.push('CONSENSUS SCORE (Borda points)');
  L.push('-'.repeat(30));
  result.borda.forEach((row, i) => {
    L.push(`   ${_ordinal(i + 1).padStart(4)}  ${String(row.points).padStart(3)} pts  ${row.name}` +
      `  — ${row.firstPlace} first-place, ranked by ${row.timesRanked}` +
      (row.avgRank ? `, avg rank ${row.avgRank}` : ''));
  });
  L.push('');

  L.push('EVERY BALLOT');
  L.push('-'.repeat(12));
  const sorted = [...ballots].sort((a, b) => String(a.voter).localeCompare(String(b.voter)));
  for (const bal of sorted) {
    L.push(`   ${bal.voter}:`);
    L.push(`      ${_ballotLine(bal, nameById)}`);
  }
  if (!sorted.length) L.push('   (nobody voted)');
  L.push('');

  const text = L.join('\n');

  // ── HTML ──
  const H = [];
  H.push(`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#1C2330">`);
  H.push(`<p style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#C4973A;margin:0 0 6px">${_esc(pollTitle)}</p>`);

  if (winner) {
    H.push(`<h1 style="font-size:30px;margin:0 0 4px;color:#1C2330">${_esc(winner.name)}</h1>`);
    H.push(`<p style="margin:0 0 20px;color:#6B7280;font-size:14px">Winner — ${winner.votes} of ${winner.of} continuing ballots, round ${result.rounds.length}</p>`);
  } else {
    H.push(`<h1 style="font-size:26px;margin:0 0 20px">No winner — no ballots</h1>`);
  }

  if (result.tie) {
    H.push(`<p style="background:#FDF3E3;border-left:3px solid #C4973A;padding:10px 12px;margin:0 0 16px;font-size:13px">Dead tie between ${_esc(result.tiedAmong.map(t => t.name).join('; '))} — broken on consensus points.</p>`);
  }
  if (!result.agreement && result.consensusPick && winner) {
    H.push(`<p style="background:#F1F5F2;border-left:3px solid #4E6B51;padding:10px 12px;margin:0 0 16px;font-size:13px">Heads up: the consensus score prefers <strong>${_esc(result.consensusPick.name)}</strong>. The two methods disagree.</p>`);
  }

  H.push(`<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6B7280;margin:24px 0 8px">Round by round</h2>`);
  for (const r of result.rounds) {
    H.push(`<p style="font-size:12px;color:#6B7280;margin:12px 0 4px">Round ${r.round} — needs ${r.majority} of ${r.continuing}${r.exhausted ? ` · ${r.exhausted} exhausted` : ''}</p>`);
    H.push(`<table style="width:100%;border-collapse:collapse;font-size:14px">`);
    for (const [id, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) {
      const pct = r.continuing ? Math.round((n / r.continuing) * 100) : 0;
      const out = r.eliminated.some(e => e.id === id);
      const win = r.winner === id;
      H.push(`<tr style="${out ? 'opacity:.45;text-decoration:line-through' : ''}">` +
        `<td style="padding:4px 0;${win ? 'font-weight:600' : ''}">${_esc(r.names[id])}</td>` +
        `<td style="padding:4px 0;text-align:right;width:70px;color:#6B7280">${n} · ${pct}%</td></tr>`);
    }
    H.push(`</table>`);
    const elimHtml = _elimLine(r);
    if (elimHtml) H.push(`<p style="font-size:12.5px;color:#6B7280;margin:6px 0 0;font-style:italic">${_esc(elimHtml)}</p>`);
  }

  H.push(`<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6B7280;margin:24px 0 8px">Consensus score</h2>`);
  H.push(`<table style="width:100%;border-collapse:collapse;font-size:14px">`);
  result.borda.forEach((row, i) => {
    H.push(`<tr><td style="padding:4px 0">${i + 1}. ${_esc(row.name)}</td>` +
      `<td style="padding:4px 0;text-align:right;color:#6B7280">${row.points} pts · ${row.firstPlace} first</td></tr>`);
  });
  H.push(`</table>`);

  H.push(`<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6B7280;margin:24px 0 8px">Every ballot</h2>`);
  for (const bal of sorted) {
    H.push(`<p style="margin:0 0 10px;font-size:14px"><strong>${_esc(bal.voter)}</strong><br>` +
      `<span style="color:#6B7280">${_esc(_ballotLine(bal, nameById))}</span></p>`);
  }
  if (!sorted.length) H.push(`<p style="color:#6B7280">Nobody voted.</p>`);

  H.push(`</div>`);

  const subject = winner
    ? `Trip winner: ${winner.name}`
    : 'Trip vote closed — no ballots';

  const push = {
    title: winner ? `Winner: ${winner.name}` : 'Vote closed — no ballots',
    body: winner
      ? `${winner.votes}/${winner.of} ballots in round ${result.rounds.length}. ${result.countedBallots} people voted.`
      : 'No usable ballots were submitted.',
    tag: 'vote-result',
    url: '/vote/admin.html',
  };

  return { subject, text, html: H.join('\n'), push };
}

module.exports = { buildReport };
