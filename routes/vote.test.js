'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vote = require('./vote');
const { buildReport } = require('../lib/vote-report');
const { tally } = require('../lib/rcv');

const { _nameKey: nameKey, _cleanName: cleanName, _validateRankings: validate, isOpen, addsOpen } = vote;

const PAST   = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 60_000).toISOString();

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
  assert.strictEqual(isOpen({ status: 'open',   closes_at: FUTURE }), true);
  assert.strictEqual(isOpen({ status: 'open',   closes_at: PAST }),   false);
  assert.strictEqual(isOpen({ status: 'open',   closes_at: null }),   true);
  assert.strictEqual(isOpen({ status: 'closed', closes_at: FUTURE }), false);
  assert.strictEqual(isOpen(null), false);
});

test('addsOpen: nominations can close while voting stays open', () => {
  const poll = { status: 'open', closes_at: FUTURE, allow_adds: true, adds_close_at: PAST };
  assert.strictEqual(isOpen(poll), true, 'voting still open');
  assert.strictEqual(addsOpen(poll), false, 'but nominations are shut');
});

test('addsOpen: open while the nomination deadline is still ahead', () => {
  assert.strictEqual(
    addsOpen({ status: 'open', closes_at: FUTURE, allow_adds: true, adds_close_at: FUTURE }), true);
  assert.strictEqual(
    addsOpen({ status: 'open', closes_at: FUTURE, allow_adds: true, adds_close_at: null }), true);
});

test('addsOpen: closing the poll closes nominations regardless of their own date', () => {
  assert.strictEqual(
    addsOpen({ status: 'closed', closes_at: FUTURE, allow_adds: true, adds_close_at: FUTURE }), false);
  assert.strictEqual(
    addsOpen({ status: 'open', closes_at: PAST, allow_adds: true, adds_close_at: FUTURE }), false);
});

test('addsOpen: the manual toggle still overrides an open nomination window', () => {
  assert.strictEqual(
    addsOpen({ status: 'open', closes_at: FUTURE, allow_adds: false, adds_close_at: FUTURE }), false);
});

// ── two-phase poll: nominate, then vote ───────────────────────────────────

const { votingOpen, phaseOf, _addsUsedBy: addsUsedBy } = vote;

test('votingOpen: ranking is shut until opens_at passes', () => {
  assert.strictEqual(
    votingOpen({ status: 'open', closes_at: FUTURE, opens_at: FUTURE }), false, 'before opening');
  assert.strictEqual(
    votingOpen({ status: 'open', closes_at: FUTURE, opens_at: PAST }), true, 'after opening');
  assert.strictEqual(
    votingOpen({ status: 'open', closes_at: FUTURE, opens_at: null }), true, 'no opening time set');
});

test('votingOpen: a closed poll is never open for voting', () => {
  assert.strictEqual(votingOpen({ status: 'closed', closes_at: FUTURE, opens_at: PAST }), false);
  assert.strictEqual(votingOpen({ status: 'open', closes_at: PAST, opens_at: PAST }), false);
});

test('phaseOf names the three states', () => {
  assert.strictEqual(phaseOf({ status: 'open', closes_at: FUTURE, opens_at: FUTURE }), 'nominate');
  assert.strictEqual(phaseOf({ status: 'open', closes_at: FUTURE, opens_at: PAST }), 'vote');
  assert.strictEqual(phaseOf({ status: 'open', closes_at: PAST, opens_at: PAST }), 'closed');
  assert.strictEqual(phaseOf({ status: 'closed', closes_at: FUTURE, opens_at: PAST }), 'closed');
});

test('nominations stay open during the nominate phase', () => {
  // The whole point: adds allowed, ranking not.
  const poll = { status: 'open', closes_at: FUTURE, opens_at: FUTURE, allow_adds: true, adds_close_at: null };
  assert.strictEqual(addsOpen(poll), true);
  assert.strictEqual(votingOpen(poll), false);
});

test('addsUsedBy counts only this voter, case and spacing insensitive', () => {
  const dests = [
    { name: 'Lisbon', addedBy: 'Drew V' },
    { name: 'Osaka',  addedBy: 'drew  v' },
    { name: 'Oslo',   addedBy: 'Casey' },
    { name: 'Seed',   addedBy: null },
  ];
  assert.strictEqual(addsUsedBy(dests, 'Drew V'), 2, 'both spellings count as Drew');
  assert.strictEqual(addsUsedBy(dests, 'Casey'), 1);
  assert.strictEqual(addsUsedBy(dests, 'Nobody'), 0);
});

test('addsUsedBy ignores seeded destinations with no author', () => {
  assert.strictEqual(addsUsedBy([{ name: 'Istanbul', addedBy: null }], 'Drew'), 0);
});

// ── recovery PIN ──────────────────────────────────────────────────────────

test('isValidPin accepts exactly four digits and nothing else', () => {
  const { _isValidPin: v } = vote;
  assert.strictEqual(v('0000'), true);
  assert.strictEqual(v('9137'), true);
  for (const bad of ['123', '12345', 'abcd', '12 4', '', '12.4', null, 1234, ' 1234 ']) {
    assert.strictEqual(v(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('hashPin never stores the PIN in recoverable form', async () => {
  const { _hashPin: hashPin } = vote;
  const stored = await hashPin('4821');
  assert.ok(!stored.includes('4821'), 'PIN appears verbatim in the stored value');
  assert.match(stored, /^s1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test('hashPin salts, so the same PIN hashes differently every time', async () => {
  const { _hashPin: hashPin } = vote;
  const a = await hashPin('1234');
  const b = await hashPin('1234');
  assert.notStrictEqual(a, b, 'identical PINs produced identical hashes — unsalted');
});

test('verifyPin accepts the right PIN and rejects the rest', async () => {
  const { _hashPin: hashPin, _verifyPin: verifyPin } = vote;
  const stored = await hashPin('4821');
  assert.strictEqual(await verifyPin('4821', stored), true);
  for (const wrong of ['4822', '1284', '0000', '482', '48210']) {
    assert.strictEqual(await verifyPin(wrong, stored), false, `accepted ${wrong}`);
  }
});

test('verifyPin rejects malformed or absent stored values instead of throwing', async () => {
  const { _verifyPin: verifyPin } = vote;
  for (const stored of [null, undefined, '', 'garbage', 's1$only-one-part', 'md5$aa$bb']) {
    assert.strictEqual(await verifyPin('1234', stored), false, `stored=${stored}`);
  }
});

test('verifyPin cannot be satisfied by an empty or non-string PIN', async () => {
  const { _hashPin: hashPin, _verifyPin: verifyPin } = vote;
  const stored = await hashPin('1234');
  for (const pin of ['', null, undefined, 1234, {}]) {
    assert.strictEqual(await verifyPin(pin, stored), false, `accepted ${JSON.stringify(pin)}`);
  }
});

// ── database SSL selection ────────────────────────────────────────────────
// Getting this wrong doesn't degrade, it refuses to connect: a private-network
// host has no TLS to negotiate, and a public one won't talk without it.

test('sslFor: public hosted Postgres gets SSL', () => {
  const { _sslFor: sslFor } = vote;
  for (const url of [
    'postgres://u:p@dpg-abc123.oregon-postgres.render.com/db',
    'postgres://u:p@ep-cool-name.us-east-2.aws.neon.tech/db',
    'postgres://u:p@viaduct.proxy.rlwy.net:23456/railway',
  ]) {
    assert.deepStrictEqual(sslFor(url), { rejectUnauthorized: false }, url);
  }
});

test('sslFor: private provider networks get no SSL', () => {
  const { _sslFor: sslFor } = vote;
  for (const url of [
    'postgres://u:p@postgres.railway.internal:5432/railway',
    'postgres://u:p@dpg-abc123-a/mydb',        // Render internal: bare hostname
    'postgres://u:p@somehost.local:5432/db',
    'postgres://u:p@db:5432/app',              // docker-compose service name
  ]) {
    assert.strictEqual(sslFor(url), false, url);
  }
});

test('sslFor: a database named *.internal does not disable SSL for a public host', () => {
  // The rule reads the hostname, not the path — a database called "db.internal"
  // sitting on a public host still needs TLS.
  const { _sslFor: sslFor } = vote;
  assert.deepStrictEqual(
    sslFor('postgres://u:p@dpg-abc.oregon-postgres.render.com/db.internal'),
    { rejectUnauthorized: false });
});

test('sslFor: localhost gets no SSL', () => {
  const { _sslFor: sslFor } = vote;
  assert.strictEqual(sslFor('postgres://postgres@localhost:5432/db'), false);
  assert.strictEqual(sslFor('postgres://postgres@127.0.0.1:5433/db'), false);
});

test('sslFor: DATABASE_SSL overrides the hostname in both directions', () => {
  const { _sslFor: sslFor } = vote;
  const prev = process.env.DATABASE_SSL;
  try {
    process.env.DATABASE_SSL = '0';
    assert.strictEqual(sslFor('postgres://u:p@public.example.com/db'), false);
    process.env.DATABASE_SSL = '1';
    assert.deepStrictEqual(
      sslFor('postgres://u:p@postgres.railway.internal/db'), { rejectUnauthorized: false });
  } finally {
    if (prev === undefined) delete process.env.DATABASE_SSL;
    else process.env.DATABASE_SSL = prev;
  }
});

test('sslFor: an unparseable URL defaults to SSL on', () => {
  const { _sslFor: sslFor } = vote;
  assert.deepStrictEqual(sslFor('not a url'), { rejectUnauthorized: false });
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
