// Ranked-choice destination vote.
//
// Privacy model
// -------------
// Ballots are stored server-side and are never included in any public response.
// A voter claims a name and the server hands back a random ballot token which
// the browser keeps in localStorage. That token — not the name — is what grants
// read/write access to a ballot, so entering someone else's name does not show
// you their vote. Claiming a name that already exists without its token returns
// 409 NAME_TAKEN; the admin can release a name if somebody genuinely changes
// device (POST /api/admin/reset-voter).
//
// Results — the winner, the counts, anybody's rankings — are only ever served
// from the /api/admin/* endpoints behind VOTE_ADMIN_KEY, open poll or closed.
// There is deliberately no public results endpoint.

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { errorResponse, ErrorCodes } = require('../lib/errors');
const { tally } = require('../lib/rcv');
const { buildReport } = require('../lib/vote-report');
const { sendMail, transportName } = require('../lib/mailer');

const POLL_ID   = process.env.VOTE_POLL_ID || 'trip';
const ADMIN_KEY = process.env.VOTE_ADMIN_KEY;
const RESULT_TO = process.env.VOTE_RESULT_EMAIL;

const MAX_DESTINATIONS = 24;
const MAX_NAME_LEN     = 80;
const MAX_BLURB_LEN    = 280;
const MAX_VOTER_LEN    = 40;

const SEED_DESTINATIONS = [
  { name: 'Istanbul, Türkiye',        blurb: 'Two continents, one city. Big food, big history, easy long-haul award space.' },
  { name: 'Budapest, Hungary',        blurb: 'Thermal baths, ruin bars, and the cheapest week in Europe on this list.' },
  { name: 'Phuket, Thailand',         blurb: 'Islands and beach time. Longest flight, warmest weather, best value on the ground.' },
  { name: 'Beijing, China',           blurb: 'The Wall, the Forbidden City, and a visa-free transit window worth checking.' },
  { name: 'Rio de Janeiro, Brazil',   blurb: 'Summer in the southern hemisphere — beaches, mountains, and a real party city.' },
  { name: 'Hong Kong / Macao, China', blurb: 'Skyline, dim sum, and a ferry ride to the casinos. Strong non-rev options.' },
];

// ── DB ──────────────────────────────────────────────────────────────────────
// Pool + schema are created lazily so the server still boots without a
// DATABASE_URL — every voting route then answers 503 NOT_CONFIGURED.

let _pool = null;
let _ready = null;

// Hosted Postgres (Render, Railway, Neon, Heroku) requires SSL and presents a
// cert we don't pin; a local dev Postgres refuses SSL outright. Decide from the
// host rather than forcing one and breaking the other.
function sslFor(url) {
  if (process.env.DATABASE_SSL === '0') return false;
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch { /* unparseable URL — fall through to SSL on */ }
  return { rejectUnauthorized: false };
}

function pool() {
  if (!_pool) {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    _pool = new Pool({ connectionString: url, ssl: sslFor(url) });
  }
  return _pool;
}

// Unlike the other routes here we await schema creation before the first query,
// because a claim landing on a half-built schema would hand out a token for a
// ballot row that doesn't exist.
function ready() {
  if (!_ready) {
    _ready = (async () => {
      const p = pool();
      await p.query(`
        CREATE TABLE IF NOT EXISTS vote_poll (
          poll_id      TEXT PRIMARY KEY,
          title        TEXT        NOT NULL DEFAULT 'Trip destination vote',
          status       TEXT        NOT NULL DEFAULT 'open',
          closes_at    TIMESTAMPTZ,
          allow_adds   BOOLEAN     NOT NULL DEFAULT true,
          results_sent BOOLEAN     NOT NULL DEFAULT false,
          closed_at    TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      // Nominations usually close before voting does, so the field is settled
      // while people are still ranking it. Added after the table shipped.
      await p.query(`ALTER TABLE vote_poll ADD COLUMN IF NOT EXISTS adds_close_at TIMESTAMPTZ`);
      await p.query(`ALTER TABLE vote_poll ADD COLUMN IF NOT EXISTS subtitle TEXT`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS vote_destinations (
          id         SERIAL PRIMARY KEY,
          poll_id    TEXT        NOT NULL DEFAULT 'trip',
          name       TEXT        NOT NULL,
          blurb      TEXT,
          added_by   TEXT,
          removed    BOOLEAN     NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS vote_dest_uniq
                     ON vote_destinations (poll_id, lower(name))`);
      await p.query(`
        CREATE TABLE IF NOT EXISTS vote_ballots (
          id         SERIAL PRIMARY KEY,
          poll_id    TEXT        NOT NULL DEFAULT 'trip',
          voter_name TEXT        NOT NULL,
          name_key   TEXT        NOT NULL,
          token_hash TEXT        NOT NULL,
          rankings   JSONB       NOT NULL DEFAULT '[]',
          submitted  BOOLEAN     NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS vote_ballot_uniq
                     ON vote_ballots (poll_id, name_key)`);

      await p.query(
        `INSERT INTO vote_poll (poll_id, title) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [POLL_ID, 'Where are we going?']);

      const { rows } = await p.query(
        'SELECT count(*)::int AS n FROM vote_destinations WHERE poll_id = $1', [POLL_ID]);
      if (rows[0].n === 0) {
        for (const d of SEED_DESTINATIONS) {
          await p.query(
            `INSERT INTO vote_destinations (poll_id, name, blurb) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`, [POLL_ID, d.name, d.blurb]);
        }
        console.log(`[vote] seeded ${SEED_DESTINATIONS.length} destinations for poll "${POLL_ID}"`);
      }
    })().catch(err => {
      _ready = null;   // let the next request retry rather than wedging forever
      throw err;
    });
  }
  return _ready;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const hash = s => crypto.createHash('sha256').update(s).digest('hex');

// Collapses whitespace and case so "drew  V" and "Drew v" are the same person.
function nameKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanName(s, max) {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

// Rankings must be an array of ids that actually exist in this poll, with no
// duplicates. Anything else is a client bug and gets rejected loudly rather
// than silently mangling somebody's ballot.
function validateRankings(raw, validIds) {
  if (!Array.isArray(raw)) return { ok: false, why: 'rankings must be an array' };
  if (raw.length > 100)    return { ok: false, why: 'too many rankings' };
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const id = String(r);
    if (!validIds.has(id)) return { ok: false, why: `unknown destination: ${id}` };
    if (seen.has(id))      return { ok: false, why: `duplicate destination: ${id}` };
    seen.add(id);
    out.push(id);
  }
  return { ok: true, rankings: out };
}

function requireDb(req, res, next) {
  if (!process.env.DATABASE_URL) {
    return errorResponse(res, 503, 'DATABASE_URL not configured on server', { code: ErrorCodes.NOT_CONFIGURED });
  }
  ready().then(() => next()).catch(err => {
    console.error('[vote] schema init failed:', err.message);
    errorResponse(res, 500, 'Database unavailable', { code: ErrorCodes.INTERNAL });
  });
}

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return errorResponse(res, 503, 'VOTE_ADMIN_KEY not configured on server', { code: ErrorCodes.NOT_CONFIGURED });
  }
  const given = req.headers['x-admin-key'];
  // Constant-time compare so the key can't be recovered a byte at a time.
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ADMIN_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return errorResponse(res, 401, 'Invalid admin key', { code: ErrorCodes.AUTH_FAILED });
  }
  next();
}

// Resolves X-Ballot-Token to a ballot row. Never falls back to name lookup —
// that is the whole point of the token.
async function ballotFromToken(req) {
  const token = req.headers['x-ballot-token'];
  if (!token) return null;
  const { rows } = await pool().query(
    'SELECT * FROM vote_ballots WHERE poll_id = $1 AND token_hash = $2',
    [POLL_ID, hash(String(token))]
  );
  return rows[0] || null;
}

async function getPoll() {
  const { rows } = await pool().query('SELECT * FROM vote_poll WHERE poll_id = $1', [POLL_ID]);
  return rows[0];
}

async function getDestinations() {
  const { rows } = await pool().query(
    `SELECT id, name, blurb, added_by, created_at FROM vote_destinations
     WHERE poll_id = $1 AND NOT removed ORDER BY id`, [POLL_ID]);
  return rows.map(r => ({
    id: String(r.id), name: r.name, blurb: r.blurb,
    addedBy: r.added_by, createdAt: r.created_at,
  }));
}

// A poll is effectively closed once it is marked closed OR its deadline passes,
// so a missed cron tick can't leave voting open past the deadline.
function isOpen(poll) {
  if (!poll || poll.status !== 'open') return false;
  if (poll.closes_at && new Date(poll.closes_at).getTime() <= Date.now()) return false;
  return true;
}

// Nominations have their own, usually earlier, deadline: the field should be
// settled while people are still ranking it, so nobody's submitted ballot is
// missing a destination that appeared at the last minute. Closing the poll
// closes nominations too, regardless of this date.
function addsOpen(poll) {
  if (!isOpen(poll)) return false;
  if (!poll.allow_adds) return false;
  if (poll.adds_close_at && new Date(poll.adds_close_at).getTime() <= Date.now()) return false;
  return true;
}

// ── public / voter endpoints ────────────────────────────────────────────────

router.use(express.json({ limit: '64kb' }));

// The public view of the poll. Carries no rankings and no tallies — only who
// has voted, so people can chase the stragglers.
router.get('/api/poll', requireDb, async (req, res) => {
  try {
    const poll = await getPoll();
    const destinations = await getDestinations();
    const { rows } = await pool().query(
      `SELECT voter_name, submitted FROM vote_ballots
       WHERE poll_id = $1 ORDER BY lower(voter_name)`, [POLL_ID]);

    res.json({
      pollId: POLL_ID,
      title: poll.title,
      subtitle: poll.subtitle,
      open: isOpen(poll),
      status: isOpen(poll) ? 'open' : 'closed',
      closesAt: poll.closes_at,
      allowAdds: addsOpen(poll),
      addsCloseAt: poll.adds_close_at,
      destinations,
      voted: rows.filter(r => r.submitted).map(r => r.voter_name),
      startedCount: rows.length,
    });
  } catch (err) {
    console.error('[vote] poll error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Claim a name (or resume with an existing token).
router.post('/api/claim', requireDb, async (req, res) => {
  try {
    const poll = await getPoll();
    const voter = cleanName(req.body?.name, MAX_VOTER_LEN);
    if (voter.length < 2) {
      return errorResponse(res, 400, 'Enter your name (at least 2 characters)', { code: ErrorCodes.BAD_INPUT });
    }
    const key = nameKey(voter);

    const existing = await pool().query(
      'SELECT * FROM vote_ballots WHERE poll_id = $1 AND name_key = $2', [POLL_ID, key]);

    if (existing.rows.length) {
      const row = existing.rows[0];
      const token = String(req.headers['x-ballot-token'] || '');
      if (token && hash(token) === row.token_hash) {
        return res.json({ voter: row.voter_name, rankings: row.rankings, submitted: row.submitted, resumed: true });
      }
      return errorResponse(res, 409,
        `"${row.voter_name}" has already started a ballot on another device. Use that device, add a last initial, or ask the organizer to release the name.`,
        { code: 'NAME_TAKEN' });
    }

    if (!isOpen(poll)) {
      return errorResponse(res, 403, 'Voting is closed', { code: 'POLL_CLOSED' });
    }

    const token = crypto.randomBytes(24).toString('base64url');
    await pool().query(
      `INSERT INTO vote_ballots (poll_id, voter_name, name_key, token_hash, rankings)
       VALUES ($1, $2, $3, $4, '[]'::jsonb)`,
      [POLL_ID, voter, key, hash(token)]);

    res.json({ token, voter, rankings: [], submitted: false, resumed: false });
  } catch (err) {
    console.error('[vote] claim error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Your own ballot, and only ever your own.
router.get('/api/ballot', requireDb, async (req, res) => {
  try {
    const row = await ballotFromToken(req);
    if (!row) return errorResponse(res, 401, 'Ballot not found for this device', { code: ErrorCodes.AUTH_FAILED });
    res.json({ voter: row.voter_name, rankings: row.rankings, submitted: row.submitted, updatedAt: row.updated_at });
  } catch (err) {
    console.error('[vote] ballot GET error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

router.put('/api/ballot', requireDb, async (req, res) => {
  try {
    const row = await ballotFromToken(req);
    if (!row) return errorResponse(res, 401, 'Ballot not found for this device', { code: ErrorCodes.AUTH_FAILED });

    const poll = await getPoll();
    if (!isOpen(poll)) return errorResponse(res, 403, 'Voting is closed', { code: 'POLL_CLOSED' });

    const destinations = await getDestinations();
    const validIds = new Set(destinations.map(d => d.id));
    const v = validateRankings(req.body?.rankings, validIds);
    if (!v.ok) return errorResponse(res, 400, v.why, { code: ErrorCodes.BAD_INPUT });

    const submitted = req.body?.submitted === true;
    await pool().query(
      `UPDATE vote_ballots SET rankings = $1::jsonb, submitted = $2, updated_at = now()
       WHERE id = $3`,
      [JSON.stringify(v.rankings), submitted, row.id]);

    res.json({ ok: true, rankings: v.rankings, submitted });
  } catch (err) {
    console.error('[vote] ballot PUT error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Anyone with a ballot can nominate a destination that isn't listed yet.
router.post('/api/destinations', requireDb, async (req, res) => {
  try {
    const row = await ballotFromToken(req);
    if (!row) return errorResponse(res, 401, 'Claim a ballot first', { code: ErrorCodes.AUTH_FAILED });

    const poll = await getPoll();
    if (!isOpen(poll)) return errorResponse(res, 403, 'Voting is closed', { code: 'POLL_CLOSED' });
    if (!addsOpen(poll)) {
      return errorResponse(res, 403,
        'The deadline for adding destinations has passed — you can still change your ranking.',
        { code: 'ADDS_LOCKED' });
    }

    const name = cleanName(req.body?.name, MAX_NAME_LEN);
    if (name.length < 3) {
      return errorResponse(res, 400, 'Destination needs at least 3 characters', { code: ErrorCodes.BAD_INPUT });
    }
    const blurb = cleanName(req.body?.blurb, MAX_BLURB_LEN) || null;

    const current = await getDestinations();
    if (current.length >= MAX_DESTINATIONS) {
      return errorResponse(res, 400, `That's the maximum of ${MAX_DESTINATIONS} destinations`, { code: ErrorCodes.BAD_INPUT });
    }
    if (current.some(d => nameKey(d.name) === nameKey(name))) {
      return errorResponse(res, 409, `${name} is already on the list`, { code: 'DUPLICATE' });
    }

    const ins = await pool().query(
      `INSERT INTO vote_destinations (poll_id, name, blurb, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (poll_id, lower(name)) DO UPDATE SET removed = false
       RETURNING id, name, blurb, added_by`,
      [POLL_ID, name, blurb, row.voter_name]);

    const d = ins.rows[0];
    res.json({ ok: true, destination: { id: String(d.id), name: d.name, blurb: d.blurb, addedBy: d.added_by } });
  } catch (err) {
    console.error('[vote] add destination error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// ── admin ───────────────────────────────────────────────────────────────────

// Shared by the admin page, the results email and the cron auto-close, so all
// three always agree on the numbers.
async function computeResults() {
  const poll = await getPoll();
  const destinations = await getDestinations();
  const { rows } = await pool().query(
    `SELECT voter_name, rankings, submitted, updated_at FROM vote_ballots
     WHERE poll_id = $1 ORDER BY lower(voter_name)`, [POLL_ID]);

  // Only submitted ballots count. A half-filled draft someone abandoned should
  // not quietly decide the trip.
  const counted = rows.filter(r => r.submitted)
    .map(r => ({ voter: r.voter_name, rankings: r.rankings || [] }));

  const result = tally(counted, destinations);
  const report = buildReport(result, counted, { pollTitle: poll.title });

  return {
    poll: {
      title: poll.title, subtitle: poll.subtitle,
      status: poll.status, open: isOpen(poll),
      closesAt: poll.closes_at, addsCloseAt: poll.adds_close_at,
      allowAdds: poll.allow_adds, addsOpen: addsOpen(poll),
      resultsSent: poll.results_sent, closedAt: poll.closed_at,
    },
    destinations,
    result,
    report,
    ballots: rows.map(r => ({
      voter: r.voter_name,
      rankings: (r.rankings || []).map(String),
      submitted: r.submitted,
      updatedAt: r.updated_at,
      unranked: destinations.filter(d => !(r.rankings || []).map(String).includes(d.id)).map(d => d.name),
    })),
  };
}

router.get('/api/admin/results', requireDb, requireAdmin, async (req, res) => {
  try {
    res.json(await computeResults());
  } catch (err) {
    console.error('[vote] results error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Closes the poll (if open), tallies, and delivers the report by email + push.
// Idempotent on delivery via vote_poll.results_sent unless force is set.
async function closeAndNotify({ force = false, alsoClose = true } = {}) {
  await ready();
  const poll = await getPoll();

  if (alsoClose && poll.status === 'open') {
    await pool().query(
      `UPDATE vote_poll SET status = 'closed', closed_at = now() WHERE poll_id = $1`, [POLL_ID]);
  }
  if (poll.results_sent && !force) {
    return { skipped: 'already-sent' };
  }

  const { report } = await computeResults();

  const to = RESULT_TO;
  const mail = to
    ? await sendMail({ to, subject: report.subject, text: report.text, html: report.html })
    : { sent: false, skipped: 'no VOTE_RESULT_EMAIL' };

  let push = { sent: 0, skipped: 'unavailable' };
  try {
    const { sendToAll } = require('./push');
    push = await sendToAll(report.push);
  } catch (err) {
    console.error('[vote] push failed:', err.message);
    push = { sent: 0, error: err.message };
  }

  await pool().query(`UPDATE vote_poll SET results_sent = true WHERE poll_id = $1`, [POLL_ID]);
  console.log(`[vote] results delivered — mail:${mail.sent ? 'ok' : 'no'} push:${push.sent || 0}`);
  return { mail, push, subject: report.subject };
}

router.post('/api/admin/close', requireDb, requireAdmin, async (req, res) => {
  try {
    const out = await closeAndNotify({ force: req.body?.force === true });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[vote] close error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Send (or re-send) the report without changing the poll's state — handy for
// checking the email renders before the real close.
router.post('/api/admin/send-report', requireDb, requireAdmin, async (req, res) => {
  try {
    const out = await closeAndNotify({ force: true, alsoClose: false });
    res.json({ ok: true, mailTransport: transportName(), ...out });
  } catch (err) {
    console.error('[vote] send-report error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

router.post('/api/admin/reopen', requireDb, requireAdmin, async (req, res) => {
  try {
    await pool().query(
      `UPDATE vote_poll SET status = 'open', closed_at = NULL, results_sent = false,
       closes_at     = CASE WHEN closes_at     <= now() THEN NULL ELSE closes_at END,
       adds_close_at = CASE WHEN adds_close_at <= now() THEN NULL ELSE adds_close_at END
       WHERE poll_id = $1`, [POLL_ID]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[vote] reopen error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

router.post('/api/admin/settings', requireDb, requireAdmin, async (req, res) => {
  try {
    const { title, subtitle, closesAt, addsCloseAt, allowAdds } = req.body || {};
    if (title !== undefined) {
      await pool().query('UPDATE vote_poll SET title = $1 WHERE poll_id = $2',
        [cleanName(title, 120) || 'Trip destination vote', POLL_ID]);
    }
    if (subtitle !== undefined) {
      await pool().query('UPDATE vote_poll SET subtitle = $1 WHERE poll_id = $2',
        [cleanName(subtitle, 160) || null, POLL_ID]);
    }
    for (const [field, col] of [[closesAt, 'closes_at'], [addsCloseAt, 'adds_close_at']]) {
      if (field === undefined) continue;
      const at = field ? new Date(field) : null;
      if (at && isNaN(at.getTime())) {
        return errorResponse(res, 400, `Invalid ${col}`, { code: ErrorCodes.BAD_INPUT });
      }
      await pool().query(`UPDATE vote_poll SET ${col} = $1 WHERE poll_id = $2`, [at, POLL_ID]);
    }
    if (allowAdds !== undefined) {
      await pool().query('UPDATE vote_poll SET allow_adds = $1 WHERE poll_id = $2', [!!allowAdds, POLL_ID]);
    }
    res.json({ ok: true, poll: await getPoll() });
  } catch (err) {
    console.error('[vote] settings error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Releases a name so that person can start again from a new device. Their
// existing ballot is discarded — there is no way to hand the old token over.
router.post('/api/admin/reset-voter', requireDb, requireAdmin, async (req, res) => {
  try {
    const key = nameKey(req.body?.name);
    if (!key) return errorResponse(res, 400, 'name required', { code: ErrorCodes.BAD_INPUT });
    const { rowCount } = await pool().query(
      'DELETE FROM vote_ballots WHERE poll_id = $1 AND name_key = $2', [POLL_ID, key]);
    if (!rowCount) return errorResponse(res, 404, 'No ballot under that name', { code: ErrorCodes.NOT_FOUND });
    res.json({ ok: true, released: key });
  } catch (err) {
    console.error('[vote] reset-voter error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Soft delete — keeps the row so an id already sitting in someone's ballot
// stays resolvable, and the tally just ignores it.
router.delete('/api/admin/destinations/:id', requireDb, requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool().query(
      'UPDATE vote_destinations SET removed = true WHERE poll_id = $1 AND id = $2',
      [POLL_ID, Number(req.params.id)]);
    if (!rowCount) return errorResponse(res, 404, 'No such destination', { code: ErrorCodes.NOT_FOUND });
    res.json({ ok: true });
  } catch (err) {
    console.error('[vote] delete destination error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

router.post('/api/admin/destinations', requireDb, requireAdmin, async (req, res) => {
  try {
    const name = cleanName(req.body?.name, MAX_NAME_LEN);
    if (name.length < 3) return errorResponse(res, 400, 'Destination name too short', { code: ErrorCodes.BAD_INPUT });
    const blurb = cleanName(req.body?.blurb, MAX_BLURB_LEN) || null;
    const ins = await pool().query(
      `INSERT INTO vote_destinations (poll_id, name, blurb, added_by)
       VALUES ($1, $2, $3, 'organizer')
       ON CONFLICT (poll_id, lower(name)) DO UPDATE SET removed = false, blurb = EXCLUDED.blurb
       RETURNING id, name, blurb`, [POLL_ID, name, blurb]);
    const d = ins.rows[0];
    res.json({ ok: true, destination: { id: String(d.id), name: d.name, blurb: d.blurb } });
  } catch (err) {
    console.error('[vote] admin add destination error:', err.message);
    errorResponse(res, 500, 'Server error', { code: ErrorCodes.INTERNAL });
  }
});

// Health/config check — no secrets, tells you what is wired up.
router.get('/api/admin/status', requireDb, requireAdmin, async (req, res) => {
  res.json({
    pollId: POLL_ID,
    mailTransport: transportName(),
    resultEmail: RESULT_TO ? RESULT_TO.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    pushConfigured: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  });
});

module.exports = router;
module.exports.closeAndNotify = closeAndNotify;
module.exports.computeResults = computeResults;
module.exports.isOpen = isOpen;
module.exports.addsOpen = addsOpen;
module.exports._nameKey = nameKey;
module.exports._cleanName = cleanName;
module.exports._validateRankings = validateRankings;
