'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vote = require('./vote');
const { buildReport } = require('../lib/vote-report');
const { tally } = require('../lib/rcv');

const { _nameKey: nameKey, _cleanName: cleanName, _validateRankings: validate, isOpen } = vote;

test('nameKey collapses case and whitespace so one person is one ballot', () => {
  assert.strictEqual(nameKey('Drew  V'), nameKey('drew v'));
  assert.strictEqual(nameKey('  DREW\tV '), 'drew v');
  assert.strictEqual(nameKey(null), '');
});

test('nameKey keeps genuinely different names apart', () => {
  assert.notStrictEqual(nameKey('Drew V'), nameKey('Drew W'));
});

test('cleanName trims, collapses and truncates', () => {
  assert.strictEqual(cleanName('  Rio   de  Janeiro ', 80), 'Rio de Janeiro');
  assert.strictEqual(cleanName('x'.repeat(200), 40).length, 40);
  assert.strictEqual(cleanName(undefined, 40), '');
});

test('validateRankings accepts a well-formed partial ballot', () => {
  const ids = new Set(['1', '2', '3']);
  const v = validate(['2', '1'], ids);
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.rankings, ['2', '1']);
});

test('validateRankings coerces numeric ids to strings', () => {
  const v = validate([2, 1], new Set(['1', '2']));
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.rankings, ['2', '1']);
});

test('validateRankings rejects unknown, duplicate and non-array input', () => {
  const ids = new Set(['1', '2']);
  assert.strictEqual(validate(['9'], ids).ok, false);
  assert.strictEqual(validate(['1', '1'], ids).ok, false);
  assert.strictEqual(validate('1,2', ids).ok, false);
  assert.strictEqual(validate(null, ids).ok, false);
  assert.strictEqual(validate(new Array(101).fill('1'), ids).ok, false);
});

test('validateRankings allows an empty ballot', () => {
  assert.deepStrictEqual(validate([], new Set(['1'])).rankings, []);
});

test('isOpen closes the poll once the deadline passes, even if still marked open', () => {
  const past   = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.strictEqual(isOpen({ status: 'open',   closes_at: future }), true);
  assert.strictEqual(isOpen({ status: 'open',   closes_at: past }),   false);
  assert.strictEqual(isOpen({ status: 'open',   closes_at: null }),   true);
  assert.strictEqual(isOpen({ status: 'closed', closes_at: future }), false);
  assert.strictEqual(isOpen(null), false);
});

// ── report ────────────────────────────────────────────────────────────────

const DESTS = [
  { id: '1', name: 'Istanbul, Türkiye' },
  { id: '2', name: 'Budapest, Hungary' },
  { id: '3', name: 'Phuket, Thailand' },
];
const BALLOTS = [
  { voter: 'Drew', rankings: ['3', '1', '2'] },
  { voter: 'Sam',  rankings: ['3', '2', '1'] },
  { voter: 'Alex', rankings: ['1', '2', '3'] },
];

test('report states the winner in the subject, body and push payload', () => {
  const r = buildReport(tally(BALLOTS, DESTS), BALLOTS, { pollTitle: 'Winter trip' });
  assert.match(r.subject, /Phuket/);
  assert.match(r.text, /WINNER: Phuket, Thailand/);
  assert.match(r.push.title, /Phuket/);
  assert.match(r.html, /Phuket/);
});

test('report lists every voter and their full ranking', () => {
  const r = buildReport(tally(BALLOTS, DESTS), BALLOTS, {});
  for (const b of BALLOTS) assert.ok(r.text.includes(b.voter), `missing ${b.voter}`);
  assert.match(r.text, /Phuket, Thailand {2}> {2}Istanbul, Türkiye {2}> {2}Budapest, Hungary/);
});

test('report shows every destination in the consensus table, including losers', () => {
  const r = buildReport(tally(BALLOTS, DESTS), BALLOTS, {});
  const consensus = r.text.split('CONSENSUS SCORE')[1];
  for (const d of DESTS) assert.ok(consensus.includes(d.name), `missing ${d.name}`);
});

test('report handles an empty poll without throwing', () => {
  const r = buildReport(tally([], DESTS), [], {});
  assert.match(r.text, /No winner/);
  assert.match(r.text, /nobody voted/i);
  assert.ok(r.subject.length);
});

test('report escapes HTML in a user-supplied destination name', () => {
  const dests = [{ id: '1', name: '<script>alert(1)</script>' }];
  const ballots = [{ voter: '<img src=x>', rankings: ['1'] }];
  const r = buildReport(tally(ballots, dests), ballots, {});
  assert.ok(!r.html.includes('<script>'), 'destination name was not escaped');
  assert.ok(!r.html.includes('<img src=x>'), 'voter name was not escaped');
  assert.match(r.html, /&lt;script&gt;/);
});

test('report flags a method disagreement so it is not silently ignored', () => {
  const ballots = [
    { voter: 'a', rankings: ['1', '2', '3'] }, { voter: 'b', rankings: ['1', '2', '3'] },
    { voter: 'c', rankings: ['1', '2', '3'] }, { voter: 'd', rankings: ['1', '2', '3'] },
    { voter: 'e', rankings: ['3', '2', '1'] }, { voter: 'f', rankings: ['3', '2', '1'] },
    { voter: 'g', rankings: ['3', '2', '1'] },
    { voter: 'h', rankings: ['2', '3', '1'] }, { voter: 'i', rankings: ['2', '3', '1'] },
  ];
  const r = buildReport(tally(ballots, DESTS), ballots, {});
  assert.match(r.text, /consensus score prefers Budapest, Hungary/);
});

test('report notes a ballot that ranked nothing', () => {
  const ballots = [{ voter: 'Ghost', rankings: [] }, { voter: 'Drew', rankings: ['1'] }];
  const r = buildReport(tally(ballots, DESTS), ballots, {});
  assert.match(r.text, /no ranking submitted/);
  assert.match(r.text, /1 counted, 1 blank/);
});
