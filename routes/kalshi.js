const express = require('express');
const https   = require('https');
const { errorResponse, ErrorCodes } = require('../lib/errors');
const router  = express.Router();

// Proxy → Kalshi trade-api v2 (https://api.elections.kalshi.com/trade-api/v2).
//
// Only the PUBLIC market-data surface is used (series / events / markets /
// orderbook), which Kalshi serves without authentication — so unlike odds.js
// there is no API key to manage. Trading endpoints (orders, portfolio) require
// RSA-PSS request signing and are intentionally NOT proxied here.
//
// Kalshi prices are quoted in cents (1–99) where the price == the market's
// implied probability of YES, with a bid/ask spread rather than sportsbook vig.
// All probability math lives on the frontend (betting.js:kalshiImpliedProb).
//
// In-memory cache: events/markets discovery shifts slowly (10 min); a single
// market's orderbook moves faster (1 min). The whole feature is a no-op if the
// deployment's network policy blocks api.elections.kalshi.com (proxy → 502).
const _cache = {};
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const TTL_ORDERBOOK = 60 * 1000;
const TTL_DISCOVERY = 10 * 60 * 1000;

function cacheTTL(url) {
  return url.includes('/orderbook') ? TTL_ORDERBOOK : TTL_DISCOVERY;
}

router.use('/', (req, res) => {
  // req.url is the path after the /kalshi mount, e.g. "/events?series_ticker=X".
  const url = BASE + req.url;
  const cacheKey = req.url;

  const now = Date.now();
  if (_cache[cacheKey] && now - _cache[cacheKey].ts < cacheTTL(req.url)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'HIT');
    return res.send(_cache[cacheKey].data);
  }

  console.log('Kalshi API request:', url);
  https.get(url, { headers: { Accept: 'application/json' } }, (kRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'MISS');
    let data = '';
    kRes.on('data', chunk => { data += chunk; });
    kRes.on('end', () => {
      console.log('Kalshi API status:', kRes.statusCode, 'for', req.url.split('?')[0]);
      if (kRes.statusCode === 200) {
        _cache[cacheKey] = { data, ts: now };
      }
      res.status(kRes.statusCode).send(data);
    });
    kRes.on('error', e => errorResponse(res, 502, e.message, { code: ErrorCodes.UPSTREAM_FAILED }));
  }).on('error', (e) => errorResponse(res, 502, e.message, { code: ErrorCodes.UPSTREAM_FAILED }));
});

module.exports = router;
