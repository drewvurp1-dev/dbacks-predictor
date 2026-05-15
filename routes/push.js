const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const webpush = require('web-push');

// VAPID keys are loaded from env so they're stable across restarts.
// Generate once with: node -e "console.log(require('web-push').generateVAPIDKeys())"
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:noreply@dbacks-predictor.local';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('[push] VAPID keys not set — /api/push endpoints will return 503');
}

// Pool is created lazily so the server starts even without DATABASE_URL.
let _pool = null;
function pool() {
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    _pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint     TEXT PRIMARY KEY,
        p256dh       TEXT NOT NULL,
        auth         TEXT NOT NULL,
        sync_key_hash TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(err => console.error('[push] table init failed:', err.message));
  }
  return _pool;
}

function hashKey(k) {
  return crypto.createHash('sha256').update(k).digest('hex');
}

function requireKey(req, res, next) {
  const key = req.headers['x-sync-key'];
  if (!key || key !== process.env.SYNC_KEY) {
    return res.status(401).json({ error: 'Invalid sync key' });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: 'VAPID keys not configured on server' });
  }
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DATABASE_URL not configured on server' });
  }
  next();
}

// Public — frontend needs this before it can subscribe.
router.get('/public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'VAPID keys not configured' });
  res.json({ publicKey: VAPID_PUBLIC });
});

// Store a new browser push subscription. Idempotent on endpoint.
router.post('/subscribe', express.json({ limit: '50kb' }), requireKey, async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Bad subscription payload' });
    }
    const hash = hashKey(req.headers['x-sync-key']);
    await pool().query(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, sync_key_hash, last_seen_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (endpoint) DO UPDATE SET
        p256dh = $2, auth = $3, sync_key_hash = $4, last_seen_at = now()
    `, [endpoint, keys.p256dh, keys.auth, hash]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove a subscription (called by SW if push fails or by user toggling off).
router.post('/unsubscribe', express.json({ limit: '50kb' }), requireKey, async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    await pool().query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send a test notification to every subscription tied to this sync key. Used by
// the "Send test" button in the UI to confirm the whole pipeline works.
router.post('/test', requireKey, async (req, res) => {
  try {
    const hash = hashKey(req.headers['x-sync-key']);
    const { rows } = await pool().query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE sync_key_hash = $1',
      [hash]
    );
    if (!rows.length) return res.json({ ok: true, sent: 0, note: 'No subscriptions yet' });
    const payload = JSON.stringify({
      title: 'Snake Savant',
      body: 'Test notification — you’re all set 🐍',
      url: '/',
    });
    let sent = 0, removed = 0;
    for (const r of rows) {
      const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        sent++;
      } catch (err) {
        // 404 / 410 → subscription expired, remove it
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool().query('DELETE FROM push_subscriptions WHERE endpoint = $1', [r.endpoint]);
          removed++;
        } else {
          console.error('[push] test send failed:', err.statusCode, err.body);
        }
      }
    }
    res.json({ ok: true, sent, removed });
  } catch (err) {
    console.error('[push] test error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual triggers for the scheduled jobs. Useful for testing without waiting
// for the 5-min cron tick or for the lineup to actually post.
router.post('/run-cron', requireKey, async (req, res) => {
  try {
    const { checkLineup, checkFirstPitch } = require('../cron');
    const job = req.query.job;
    if (job === 'lineup')      await checkLineup();
    else if (job === 't30')    await checkFirstPitch();
    else { await checkLineup(); await checkFirstPitch(); }
    res.json({ ok: true, ran: job || 'both' });
  } catch (err) {
    console.error('[push] run-cron error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Exposed for the scheduler in server.js to use directly.
async function sendToAll(payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !process.env.DATABASE_URL) return { sent: 0, skipped: 'unconfigured' };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const { rows } = await pool().query('SELECT endpoint, p256dh, auth FROM push_subscriptions');
  let sent = 0, removed = 0;
  for (const r of rows) {
    const sub = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
    try {
      await webpush.sendNotification(sub, body);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool().query('DELETE FROM push_subscriptions WHERE endpoint = $1', [r.endpoint]);
        removed++;
      } else {
        console.error('[push] send failed:', err.statusCode, err.body);
      }
    }
  }
  return { sent, removed };
}

module.exports = router;
module.exports.sendToAll = sendToAll;
