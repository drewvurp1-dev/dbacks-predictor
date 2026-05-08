const express = require('express');
const https   = require('https');
const router  = express.Router();

function savantFetch(url, res) {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' } }, (sRes) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let data = '';
    sRes.on('data', chunk => { data += chunk; });
    sRes.on('end', () => {
      if (data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
        res.status(502).json({ error: 'Savant returned HTML — endpoint may be blocked' });
      } else {
        res.send(data);
      }
    });
    sRes.on('error', e => res.status(500).json({ error: e.message }));
  }).on('error', e => res.status(500).json({ error: e.message }));
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

module.exports = router;
