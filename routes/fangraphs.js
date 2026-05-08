const express = require('express');
const https   = require('https');
const router  = express.Router();

function fgFetch(url, res) {
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/csv,text/plain,*/*',
      'Referer': 'https://www.fangraphs.com/',
    },
  };
  https.get(url, options, (sRes) => {
    if (sRes.statusCode >= 300 && sRes.statusCode < 400 && sRes.headers.location) {
      return fgFetch(sRes.headers.location, res);
    }
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let data = '';
    sRes.on('data', chunk => { data += chunk; });
    sRes.on('end', () => {
      if (data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
        res.status(502).json({ error: 'FanGraphs returned HTML — endpoint may be blocked' });
      } else {
        res.send(data);
      }
    });
    sRes.on('error', e => res.status(500).json({ error: e.message }));
  }).on('error', e => res.status(500).json({ error: e.message }));
}

// Pitcher leaderboard — xFIP and advanced stats
router.get('/pitchers', (req, res) => {
  const year = req.query.year || '2026';
  fgFetch(
    `https://www.fangraphs.com/leaders/major-league?pos=p&stats=pit&lg=all&qual=10&type=8&season=${year}&month=0&season1=${year}&ind=0&startdate=&enddate=&player_type=pitcher&csv=true`,
    res
  );
});

module.exports = router;
