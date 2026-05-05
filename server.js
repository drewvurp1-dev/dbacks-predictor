const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// MLB Stats API proxy
app.use('/mlb', (req, res) => {
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const mlbPath = req.path + query;
  const url = 'https://statsapi.mlb.com' + mlbPath;
  https.get(url, (mlbRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    mlbRes.pipe(res);
  }).on('error', (e) => {
    res.status(500).json({ error: e.message });
  });
});

// Odds API proxy
app.use('/odds', (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ODDS_API_KEY not configured' }); return; }
  const separator = req.url.includes('?') ? '&' : '?';
  const url = 'https://api.the-odds-api.com' + req.url + separator + 'apiKey=' + apiKey;
  console.log('Odds API request:', url.replace(apiKey, 'KEY_HIDDEN'));
  https.get(url, (oddsRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let data = '';
    oddsRes.on('data', chunk => { data += chunk; });
    oddsRes.on('end', () => {
      console.log('Odds API status:', oddsRes.statusCode);
      console.log('Odds API response preview:', data.substring(0, 200));
      res.status(oddsRes.statusCode).send(data);
    });
    oddsRes.on('error', e => {
      console.error('Odds response error:', e.message);
      res.status(500).json({ error: e.message });
    });
  }).on('error', (e) => {
    console.error('Odds request error:', e.message);
    res.status(500).json({ error: e.message });
  });
});

// Weather proxy (wttr.in)
app.use('/weather', (req, res) => {
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const loc = req.path.replace('/weather', '') + query;
  const url = 'https://wttr.in' + loc;
  https.get(url, { headers: { 'User-Agent': 'curl/7.64.1' } }, (wRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    wRes.pipe(res);
  }).on('error', (e) => {
    res.status(500).json({ error: e.message });
  });
});

// Baseball Savant proxy — fetches CSV leaderboards and returns them
function savantFetch(url, res) {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' } }, (sRes) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Access-Control-Allow-Origin', '*');
    let data = '';
    sRes.on('data', chunk => { data += chunk; });
    sRes.on('end', () => {
      // If we got HTML instead of CSV, return error
      if (data.trim().startsWith('<!DOCTYPE') || data.trim().startsWith('<html')) {
        res.status(502).json({ error: 'Savant returned HTML — endpoint may be blocked' });
      } else {
        res.send(data);
      }
    });
    sRes.on('error', e => res.status(500).json({ error: e.message }));
  }).on('error', e => res.status(500).json({ error: e.message }));
}

// Statcast leaderboard — Barrel %, Hard-Hit Rate, Exit Velo
app.get('/savant/statcast', (req, res) => {
  const year = req.query.year || '2026';
  const type = req.query.type || 'batter';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/statcast?type=${type}&year=${year}&position=&team=&min=50&csv=true`, res);
});

// Expected stats leaderboard — xwOBA, xBA, xSLG
app.get('/savant/expected', (req, res) => {
  const year = req.query.year || '2026';
  const type = req.query.type || 'batter';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=${type}&year=${year}&position=&team=&min=50&csv=true`, res);
});

// Bat tracking leaderboard — Whiff Rate, Bat Speed, Swing Length
app.get('/savant/battracking', (req, res) => {
  const year = req.query.year || '2026';
  savantFetch(`https://baseballsavant.mlb.com/leaderboard/bat-tracking?type=batter&year=${year}&min=50&csv=true`, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D-backs Predictor running on port ${PORT}`));
