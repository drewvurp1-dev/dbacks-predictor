const express = require('express');
const https   = require('https');
const router  = express.Router();

router.use('/', (req, res) => {
  const url = 'https://wttr.in' + req.url;
  https.get(url, { headers: { 'User-Agent': 'curl/7.64.1' } }, (wRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    wRes.pipe(res);
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

module.exports = router;
