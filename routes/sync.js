const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

// Pool is created lazily so the server starts even without DATABASE_URL.
let _pool = null;
function pool() {
  if (!_pool) {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    _pool.query(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key_hash   TEXT        PRIMARY KEY,
        payload    JSONB       NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(err => console.error('[sync] table init failed:', err.message));
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
  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'DATABASE_URL not configured on server' });
  }
  next();
}

router.get('/', requireKey, async (req, res) => {
  try {
    const hash = hashKey(req.headers['x-sync-key']);
    const { rows } = await pool().query(
      'SELECT payload, updated_at FROM sync_state WHERE key_hash = $1',
      [hash]
    );
    if (!rows.length) {
      return res.json({ betLog: [], gradeLog: [], factorPerf: {}, factorWeights: {}, pending: [], updatedAt: null });
    }
    res.json({ ...rows[0].payload, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('[sync] GET error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', requireKey, express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const hash = hashKey(req.headers['x-sync-key']);
    const { betLog = [], gradeLog = [], factorPerf = {}, factorWeights = {}, pending = [] } = req.body;
    const payload = JSON.stringify({ betLog, gradeLog, factorPerf, factorWeights, pending });
    await pool().query(
      `INSERT INTO sync_state (key_hash, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key_hash) DO UPDATE SET payload = $2::jsonb, updated_at = now()`,
      [hash, payload]
    );
    res.json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[sync] POST error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
