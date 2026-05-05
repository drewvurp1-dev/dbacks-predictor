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
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const oddsPath = req.path + query + (query ? '&' : '?') + 'apiKey=' + apiKey;
  const url = 'https://api.the-odds-api.com' + oddsPath;
  https.get(url, (oddsRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    oddsRes.pipe(res);
  }).on('error', (e) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D-backs Predictor running on port ${PORT}`));
