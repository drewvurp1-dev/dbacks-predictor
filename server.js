const express = require('express');
const https = require('https');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

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

app.listen(3000, () => console.log('D-backs Predictor running at http://localhost:3000'));
