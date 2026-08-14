'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { tally, instantRunoff, borda } = require('./rcv');

const DESTS = [
  { id: '1', name: 'Istanbul, Türkiye' },
  { id: '2', name: 'Budapest, Hungary' },
  { id: '3', name: 'Phuket, Thailand' },
];

const b = (voter, ...rankings) => ({ voter, rankings });

test('borda: 1st choice is worth N points, last is worth 1', () => {
  const rows = borda([b('a', '1', '2', '3')], DESTS);
  const byId = Object.fromEntries(rows.map(r => [r.id, r.points]));
  assert.strictEqual(byId['1'], 3);
  assert.strictEqual(byId['2'], 2);
  assert.strictEqual(byId['3'], 1);
});

test('borda: unranked destinations score zero', () => {
  const rows = borda([b('a', '1')], DESTS);
  const byId = Object.fromEntries(rows.map(r => [r.id, r.points]));
  assert.strictEqual(byId['1'], 3);
  assert.strictEqual(byId['2'], 0);
  assert.strictEqual(byId['3'], 0);
});

test('borda: rows come back sorted by points descending', () => {
  const rows = borda([b('a', '3', '2', '1'), b('b', '3', '1', '2')], DESTS);
  assert.strictEqual(rows[0].id, '3');
  assert.strictEqual(rows[0].points, 6);
});

test('borda: tracks firstPlace, timesRanked and avgRank', () => {
  const rows = borda([b('a', '1', '2'), b('b', '2', '1'), b('c', '1')], DESTS);
  const one = rows.find(r => r.id === '1');
  assert.strictEqual(one.firstPlace, 2);
  assert.strictEqual(one.timesRanked, 3);
  assert.strictEqual(one.avgRank, 1.33);  // ranks 1, 2, 1
  const three = rows.find(r => r.id === '3');
  assert.strictEqual(three.avgRank, null);
});

test('irv: outright first-round majority wins immediately', () => {
  const res = instantRunoff([
    b('a', '1'), b('b', '1'), b('c', '2'),
  ], DESTS);
  assert.strictEqual(res.winner.id, '1');
  assert.strictEqual(res.rounds.length, 1);
  assert.strictEqual(res.tie, false);
});

test('irv: the first-round leader can still lose after redistribution', () => {
  // 1 leads 4-3-2 but is short of the 5-vote majority. 3 is eliminated and both
  // of its ballots name 2 next, so 2 wins 5-4.
  const ballots = [
    b('a', '1'), b('b', '1'), b('c', '1'), b('d', '1'),
    b('e', '2'), b('f', '2'), b('g', '2'),
    b('h', '3', '2'), b('i', '3', '2'),
  ];
  const res = instantRunoff(ballots, DESTS);
  assert.strictEqual(res.rounds[0].counts['1'], 4);
  assert.strictEqual(res.rounds[0].winner, null);
  assert.strictEqual(res.rounds[0].eliminated[0].id, '3');
  assert.strictEqual(res.winner.id, '2');
  assert.strictEqual(res.winner.votes, 5);
});

test('irv: exhausted ballots leave the majority denominator', () => {
  // 6 ballots: three for 1, two for 2, one bullet vote for 3. Nobody clears the
  // round-1 bar of 4. Eliminating 3 exhausts that ballot, which drops the
  // denominator to 5 and the bar to 3 — and that is what lets 1 win on 3 votes.
  const ballots = [
    b('a', '1'), b('b', '1'), b('c', '1'),
    b('d', '2'), b('e', '2'),
    b('f', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);

  assert.strictEqual(res.rounds[0].continuing, 6);
  assert.strictEqual(res.rounds[0].majority, 4);
  assert.strictEqual(res.rounds[0].eliminated[0].id, '3');

  const final = res.rounds[res.rounds.length - 1];
  assert.strictEqual(final.exhausted, 1);
  assert.strictEqual(final.continuing, 5);
  assert.strictEqual(final.majority, 3);
  assert.strictEqual(res.winner.id, '1');
  assert.strictEqual(res.winner.votes, 3);
});

test('irv: a total tie across the whole field is broken by borda and flagged', () => {
  const ballots = [
    b('a', '1', '2', '3'),
    b('b', '2', '1', '3'),
    b('c', '3', '1', '2'),
  ];
  const res = instantRunoff(ballots, DESTS);
  assert.strictEqual(res.tie, true);
  assert.strictEqual(res.tiedAmong.length, 3);
  assert.strictEqual(res.winner.brokenBy, 'borda');
  // 1 collects 3+2+2 = 7 borda points, more than 2 (2+3+1=6) or 3 (1+1+3=5).
  assert.strictEqual(res.winner.id, '1');
});

test('irv: head-to-head 50/50 tie is broken by borda, not by coin flip', () => {
  const two = [{ id: '1', name: 'Istanbul' }, { id: '2', name: 'Budapest' }];
  const res = instantRunoff([b('a', '1', '2'), b('b', '2', '1')], two);
  assert.strictEqual(res.tie, true);
  assert.ok(res.winner);
});

test('irv: elimination ties break by lower borda score', () => {
  // 2 and 3 are both stuck on one first-place vote. Borda separates them —
  // 2 picks up second-place points from the 1-voters (7) while 3 is ranked by
  // nobody else (3) — so 3 goes out. Note alphabetical order would have
  // eliminated Budapest instead, so this only passes if Borda drives the choice.
  const ballots = [
    b('a', '1', '2'), b('b', '1', '2'),
    b('c', '2', '1'),
    b('d', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);
  assert.strictEqual(res.rounds[0].majority, 3);
  assert.strictEqual(res.rounds[0].eliminated[0].id, '3');
});

test('irv: a borda-broken tie reports who survived it and how it was decided', () => {
  // 2 and 3 both sit on one vote — same numbers as the test above, restated to
  // check the explanatory fields rather than just which id lost.
  const ballots = [
    b('a', '1', '2'), b('b', '1', '2'),
    b('c', '2', '1'),
    b('d', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);
  const elim = res.rounds[0].eliminated[0];
  assert.strictEqual(elim.id, '3');
  assert.strictEqual(elim.tieBreak, 'borda');
  assert.deepStrictEqual(elim.tiedWith, [{ id: '2', name: 'Budapest, Hungary' }]);
});

test('irv: a tie that borda cannot separate falls to alphabetical, and says so', () => {
  // 2 and 3 are tied at one vote each, and neither is ranked anywhere else, so
  // their borda points are identical (1 each) — only the name can break it.
  const ballots = [
    b('a', '1'), b('b', '1'),
    b('c', '2'),
    b('d', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);
  const elim = res.rounds[0].eliminated[0];
  // Budapest < Phuket alphabetically, so Budapest is the one eliminated.
  assert.strictEqual(elim.id, '2');
  assert.strictEqual(elim.tieBreak, 'alpha');
  assert.deepStrictEqual(elim.tiedWith, [{ id: '3', name: 'Phuket, Thailand' }]);
});

test('irv: an unambiguous last place carries no tie explanation', () => {
  const ballots = [
    b('a', '1'), b('b', '1'), b('c', '1'),
    b('d', '2'), b('e', '2'),
    b('f', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);
  const elim = res.rounds[0].eliminated[0];
  assert.strictEqual(elim.id, '3');
  assert.deepStrictEqual(elim.tiedWith, []);
  assert.strictEqual(elim.tieBreak, null);
});

test('irv: a safe batch reports the threshold it could not reach', () => {
  const field = [
    { id: '1', name: 'Istanbul' }, { id: '2', name: 'Budapest' },
    { id: '3', name: 'Phuket' },   { id: '4', name: 'Beijing' },
    { id: '5', name: 'Rio' },      { id: '6', name: 'Hong Kong' },
  ];
  const ballots = [
    b('a', '1', '3'), b('b', '1', '3'), b('c', '1', '3'),
    b('d', '3', '1'),
    b('e', '5', '3'), b('f', '5', '3'),
  ];
  const res = instantRunoff(ballots, field);
  const round = res.rounds[0];
  assert.strictEqual(round.batchThreshold, 2, 'Rio had 2 — what the batch of 4 collectively could not reach');
  for (const e of round.eliminated) {
    assert.deepStrictEqual(e.tiedWith, []);
    assert.strictEqual(e.tieBreak, null);
  }
});

test('irv: identical ballots produce identical rounds (deterministic)', () => {
  const ballots = [b('a', '2', '3'), b('b', '3', '2'), b('c', '1', '2'), b('d', '1', '3')];
  const first = JSON.stringify(instantRunoff(ballots, DESTS));
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(JSON.stringify(instantRunoff(ballots, DESTS)), first);
  }
});

test('irv: destinations that cannot catch up are eliminated in one batch', () => {
  // Six destinations, four voters, three of them with zero first-place votes.
  // Eliminating those one per round would pad the report with rounds that say
  // nothing; they go together because 0+0+0 is less than the next total.
  const field = [
    { id: '1', name: 'Istanbul' }, { id: '2', name: 'Budapest' },
    { id: '3', name: 'Phuket' },   { id: '4', name: 'Beijing' },
    { id: '5', name: 'Rio' },      { id: '6', name: 'Hong Kong' },
  ];
  // Istanbul 3, Rio 2, Phuket 1, and three destinations on zero. The three zeros
  // plus Phuket total 1, which is less than Rio's 2, so all four go at once —
  // and Phuket's voter transfers to Istanbul, which then clears the bar of 4.
  const ballots = [
    b('a', '1', '3'), b('b', '1', '3'), b('c', '1', '3'),
    b('d', '3', '1'),
    b('e', '5', '3'), b('f', '5', '3'),
  ];
  const res = instantRunoff(ballots, field);

  assert.strictEqual(res.rounds[0].majority, 4);
  assert.deepStrictEqual(
    res.rounds[0].eliminated.map(e => e.name).sort(),
    ['Beijing', 'Budapest', 'Hong Kong', 'Phuket']
  );
  assert.strictEqual(res.rounds.length, 2);
  assert.strictEqual(res.winner.name, 'Istanbul');
  assert.strictEqual(res.winner.votes, 4);
  assert.strictEqual(res.tie, false);
});

test('irv: batching never eliminates a destination that could still catch up', () => {
  // 3 and 2 sit below 1, but 3+2 = 5 > 4, so they cannot go as a pair — only
  // the bottom one is safe to drop, and it must be a single elimination.
  const ballots = [
    b('a', '1'), b('b', '1'), b('c', '1'), b('d', '1'),
    b('e', '2'), b('f', '2'), b('g', '2'),
    b('h', '3'), b('i', '3'),
  ];
  const res = instantRunoff(ballots, DESTS);
  assert.strictEqual(res.rounds[0].eliminated.length, 1);
  assert.strictEqual(res.rounds[0].eliminated[0].id, '3');
});

test('irv: batching leaves at least one destination standing', () => {
  const res = instantRunoff([b('a', '1')], DESTS);
  assert.strictEqual(res.winner.id, '1');
});

test('normalize: unknown and duplicate ids are dropped from a ballot', () => {
  // '9' was removed by the admin, '1' is listed twice — the ballot still counts
  // as a single vote for 1 then 2.
  const res = instantRunoff([b('a', '9', '1', '1', '2')], DESTS);
  assert.strictEqual(res.countedBallots, 1);
  assert.strictEqual(res.winner.id, '1');
});

test('normalize: a ballot with nothing usable counts as blank, not as a vote', () => {
  const res = instantRunoff([b('a', '9'), b('b', '1')], DESTS);
  assert.strictEqual(res.blankBallots, 1);
  assert.strictEqual(res.countedBallots, 1);
  assert.strictEqual(res.totalBallots, 2);
});

test('irv: no ballots yields no winner instead of throwing', () => {
  const res = instantRunoff([], DESTS);
  assert.strictEqual(res.winner, null);
  assert.strictEqual(res.rounds.length, 0);
});

test('irv: a single destination wins unopposed', () => {
  const res = instantRunoff([b('a', '1')], [DESTS[0]]);
  assert.strictEqual(res.winner.id, '1');
});

test('tally: reports agreement when irv and borda pick the same place', () => {
  const res = tally([b('a', '1', '2', '3'), b('b', '1', '3', '2')], DESTS);
  assert.strictEqual(res.winner.id, '1');
  assert.strictEqual(res.consensusPick.id, '1');
  assert.strictEqual(res.agreement, true);
});

test('tally: flags disagreement when the consensus pick loses the runoff', () => {
  // The case that makes showing both scores worthwhile. Three blocs:
  //   4× 1 > 2 > 3     3× 3 > 2 > 1     2× 2 > 3 > 1
  // Runoff: 2 is eliminated first on 2 votes and hands both ballots to 3,
  // which wins 5-4. Borda: 2 scores 20 to 17 apiece, because it is everyone's
  // acceptable compromise and nobody's last choice. Different winners, same
  // ballots — the group should see that before booking anything.
  const ballots = [
    b('a', '1', '2', '3'), b('b', '1', '2', '3'), b('c', '1', '2', '3'), b('d', '1', '2', '3'),
    b('e', '3', '2', '1'), b('f', '3', '2', '1'), b('g', '3', '2', '1'),
    b('h', '2', '3', '1'), b('i', '2', '3', '1'),
  ];
  const res = tally(ballots, DESTS);

  assert.strictEqual(res.rounds[0].eliminated[0].id, '2');
  assert.strictEqual(res.winner.id, '3');
  assert.strictEqual(res.winner.votes, 5);
  assert.strictEqual(res.consensusPick.id, '2');
  assert.strictEqual(res.consensusPick.points, 20);
  assert.strictEqual(res.agreement, false);
});

test('tally: works on the real six-destination field', () => {
  const field = [
    { id: '1', name: 'Istanbul, Türkiye' },
    { id: '2', name: 'Budapest, Hungary' },
    { id: '3', name: 'Phuket, Thailand' },
    { id: '4', name: 'Beijing, China' },
    { id: '5', name: 'Rio de Janeiro, Brazil' },
    { id: '6', name: 'Hong Kong / Macao, China' },
  ];
  const ballots = [
    b('Drew', '3', '1', '5', '6', '2', '4'),
    b('Sam', '1', '3', '2', '6', '5', '4'),
    b('Alex', '5', '3', '1', '2', '6', '4'),
    b('Jo', '3', '5', '1', '2', '4', '6'),
    b('Pat', '2', '1', '3', '6', '5', '4'),
  ];
  const res = tally(ballots, field);
  assert.strictEqual(res.winner.id, '3');            // Phuket: 2 firsts, grows
  assert.strictEqual(res.countedBallots, 5);
  assert.strictEqual(res.borda.length, 6);
  // Every round's counts must sum to that round's continuing-ballot total.
  for (const r of res.rounds) {
    const sum = Object.values(r.counts).reduce((a, c) => a + c, 0);
    assert.strictEqual(sum, r.continuing);
  }
});
