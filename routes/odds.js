const express = require('express');
const https   = require('https');
const router  = express.Router();

// Cache odds responses to avoid burning API quota on every page load.
// Events list (game schedule) changes rarely — 1 hour TTL.
// Player props shift more often — 20 minute TTL.
const _cache = {};
const TTL_EVENTS = 60 * 60 * 1000;
const TTL_PROPS  = 20 * 60 * 1000;

function cacheTTL(url) {
  return url.includes('/events/') ? TTL_PROPS : TTL_EVENTS;
}

router.use('/', (req, res) => {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ODDS_API_KEY not configured' }); return; }

  const sep = req.url.includes('?') ? '&' : '?';
  const url = 'https://api.the-odds-api.com' + req.url + sep + 'apiKey=' + apiKey;
  const cacheKey = req.url; // key without API key for safety

  const now = Date.now();
  if (_cache[cacheKey] && now - _cache[cacheKey].ts < cacheTTL(req.url)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'HIT');
    return res.send(_cache[cacheKey].data);
  }

  console.log('Odds API request:', url.replace(apiKey, 'KEY_HIDDEN'));
  https.get(url, (oddsRes) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Cache', 'MISS');
    let data = '';
    oddsRes.on('data', chunk => { data += chunk; });
    oddsRes.on('end', () => {
      console.log('Odds API status:', oddsRes.statusCode, 'for', req.url.split('?')[0]);
      // Only cache successful responses
      if (oddsRes.statusCode === 200) {
        _cache[cacheKey] = { data, ts: now };
      }
      res.status(oddsRes.statusCode).send(data);
    });
    oddsRes.on('error', e => res.status(500).json({ error: e.message }));
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

module.exports = router;
