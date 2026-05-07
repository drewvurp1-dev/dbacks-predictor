const express = require('express');
const https   = require('https');
const router  = express.Router();

router.use('/', (req, res) => {
  const url = 'https://statsapi.mlb.com' + req.path + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  https.get(url, (mlbRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    mlbRes.pipe(res);
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

module.exports = router;
