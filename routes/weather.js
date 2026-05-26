const express = require('express');
const https   = require('https');
const { errorResponse, ErrorCodes } = require('../lib/errors');
const router  = express.Router();

router.use('/', (req, res) => {
  const url = 'https://wttr.in' + req.url;
  https.get(url, { headers: { 'User-Agent': 'curl/7.64.1' } }, (wRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    wRes.pipe(res);
  }).on('error', (e) => errorResponse(res, 502, e.message, { code: ErrorCodes.UPSTREAM_FAILED }));
});

module.exports = router;
