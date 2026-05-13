const express = require('express');
const router  = express.Router();

// In-memory cache — Savant CSVs update at most once per day
const _cache  = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const SAVANT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/csv,application/csv,*/*',
  'Referer': 'https://baseballsavant.mlb.com/',
};

async function savantFetch(url, res) {
  const now = Date.now();
  if (_cache[url] && now - _cache[url].ts < CACHE_TTL) {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(_cache[url].data);
  }
  try {
    const r = await fetch(url, { headers: SAVANT_HEADERS });
    const data = await r.text();
    if (data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
      return res.status(502).json({ error: 'Savant returned HTML — endpoint may be blocked' });
    }
    _cache[url] = { data, ts: now };
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Barrel%, Hard-Hit Rate, Exit Velo, GB%, FB%
router.get('/statcast', (req, res) => {
  const year = req.query.year || '2026';
  const type = req.query.type || 'batter';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/statcast?type=${type}&year=${year}&position=&team=&min=3&csv=true`, res);
});

// xwOBA, xBA, xSLG, xERA
router.get('/expected', (req, res) => {
  const year = req.query.year || '2026';
  const type = req.query.type || 'batter';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=3&csv=true`, res);
});

// Whiff Rate, Bat Speed, Swing Length
router.get('/battracking', (req, res) => {
  const year = req.query.year || '2026';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/bat-tracking?type=batter&year=${year}&min=3&csv=true`, res);
});

// Pitcher Whiff%, K%, Put Away% by pitch arsenal
router.get('/csw', (req, res) => {
  const year = req.query.year || '2026';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=${year}&min=3&csv=true`, res);
});

// Batter Whiff% by pitch arsenal (whiff_per_swing is blank in bat-tracking; this endpoint has it per pitch type)
router.get('/batter-arsenal', (req, res) => {
  const year = req.query.year || '2026';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&year=${year}&min=3&csv=true`, res);
});

// GB% and FB% — batted-ball leaderboard (columns: id, gb_rate, fb_rate as 0-1 decimals)
// Note: the statcast (exit-velocity-barrels) leaderboard has columns named `gb` and
// `fbld`, but those are AVERAGE EXIT VELOCITY on those batted-ball types — not rates.
// This endpoint is the correct source for true GB% / FB%.
router.get('/batted-ball', (req, res) => {
  const year = req.query.year || '2026';
  const type = req.query.type || 'batter';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/batted-ball?year=${year}&type=${type}&filter=&min=1&csv=true`, res);
});

module.exports = router;
