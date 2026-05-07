const express = require('express');
const https   = require('https');
const router  = express.Router();

router.use('/', (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ODDS_API_KEY not configured' }); return; }
  const sep = req.url.includes('?') ? '&' : '?';
  const url = 'https://api.the-odds-api.com' + req.url + sep + 'apiKey=' + apiKey;
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
    oddsRes.on('error', e => res.status(500).json({ error: e.message }));
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

module.exports = router;
