const express = require('express');
const https   = require('https');
const { errorResponse, ErrorCodes } = require('../lib/errors');
const router  = express.Router();

router.use('/', (req, res) => {
  const url = 'https://statsapi.mlb.com' + req.path + (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
  https.get(url, (mlbRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    mlbRes.pipe(res);
  }).on('error', (e) => errorResponse(res, 502, e.message, { code: ErrorCodes.UPSTREAM_FAILED }));
});

module.exports = router;
