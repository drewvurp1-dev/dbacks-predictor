const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

// Caches flight-history lookups so we don't burn AeroDataBox quota on every
// page load. Flight history for a past day is immutable; for "today" we still
// want a short TTL so an in-flight arrival eventually shows up.
const _cache = {};
const TTL_HISTORICAL = 6 * 60 * 60 * 1000;
const TTL_TODAY      = 15 * 60 * 1000;

let _charters = null;
function loadCharters() {
  if (_charters) return _charters;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'team_charters.json'), 'utf8');
    const parsed = JSON.parse(raw);
    delete parsed._README;
    _charters = parsed;
  } catch (e) {
    console.warn('[flights] team_charters.json missing or invalid:', e.message);
    _charters = {};
  }
  return _charters;
}

function fetchJSON(host, urlPath, headers) {
  return new Promise((resolve, reject) => {
    https.get({ host, path: urlPath, headers }, (r) => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: r.statusCode, body, headers: r.headers });
      });
    }).on('error', reject);
  });
}

// Most recent RapidAPI rate-limit snapshot, kept in module scope so
// /flights/status can surface it without making a fresh upstream call.
let _lastQuota = { limit: null, remaining: null, ts: null };
function captureQuota(h) {
  if (!h) return;
  const limit     = h['x-ratelimit-requests-limit'];
  const remaining = h['x-ratelimit-requests-remaining'];
  if (limit != null || remaining != null) {
    _lastQuota = { limit, remaining, ts: Date.now() };
  }
}

function ymd(d) { return d.toISOString().slice(0, 10); }

// Pick the flight whose arrival looks most relevant for "did they get in last night?":
// prefer most recent arrival into the team's home airport in the lookback window.
function pickLatestArrival(flights, homeAirport) {
  if (!Array.isArray(flights)) return null;
  const scored = flights
    .map(f => {
      const arrIata = f?.arrival?.airport?.iata || f?.arrival?.airport?.icao;
      const arrTime = f?.arrival?.actualTime?.utc || f?.arrival?.scheduledTime?.utc;
      if (!arrTime) return null;
      return {
        tail: f?.aircraft?.reg,
        callsign: f?.callSign || f?.number,
        source: f?._source,
        from:  f?.departure?.airport?.iata || f?.departure?.airport?.icao,
        to:    arrIata,
        depUtc: f?.departure?.actualTime?.utc || f?.departure?.scheduledTime?.utc,
        arrUtc: arrTime,
        intoHome: homeAirport && arrIata === homeAirport,
        status: f?.status,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.arrUtc) - new Date(a.arrUtc));
  // Prefer arrivals into the away team's destination over arrivals back into home,
  // but fall back to most recent of either.
  return scored[0] || null;
}

// GET /flights/status — health/config check
router.get('/status', (req, res) => {
  const charters = loadCharters();
  const withTails     = Object.values(charters).filter(t => t.tails     && t.tails.length).length;
  const withCallsigns = Object.values(charters).filter(t => t.callsigns && t.callsigns.length).length;
  const withAny       = Object.values(charters).filter(t =>
    (t.tails && t.tails.length) || (t.callsigns && t.callsigns.length)).length;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    configured: !!process.env.AERODATABOX_API_KEY,
    provider:   'AeroDataBox (RapidAPI)',
    teams:      Object.keys(charters).length,
    teamsWithTails:     withTails,
    teamsWithCallsigns: withCallsigns,
    teamsTrackable:     withAny,
    quota:      _lastQuota,
  });
});

// GET /flights/team/:abbr  — most recent charter movement for the team.
// Optional ?destAirport=PHX to flag arrival into a specific city.
router.get('/team/:abbr', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const apiKey = process.env.AERODATABOX_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AERODATABOX_API_KEY not configured', configured: false });
  }

  const abbr = req.params.abbr.toUpperCase();
  const charters = loadCharters();
  const team = charters[abbr];
  if (!team) return res.status(404).json({ error: `Unknown team ${abbr}` });

  const tails     = Array.isArray(team.tails)     ? team.tails     : [];
  const callsigns = Array.isArray(team.callsigns) ? team.callsigns : [];
  if (!tails.length && !callsigns.length) {
    return res.json({
      team: abbr,
      home_airport: team.home_airport,
      tails: [],
      callsigns: [],
      arrival: null,
      note: `No tail numbers or callsigns registered for ${abbr}. Add them to data/team_charters.json.`,
    });
  }

  const destAirport = (req.query.destAirport || '').toUpperCase() || null;
  const cacheKey = `${abbr}|${destAirport || ''}`;
  const now = Date.now();
  if (_cache[cacheKey] && now - _cache[cacheKey].ts < TTL_TODAY) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(_cache[cacheKey].data);
  }

  const today     = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 86400000));
  const allFlights = [];
  let anySuccess = false;
  let lastError = null;

  // Helper: run one upstream call, capture quota, accumulate flights.
  async function runLookup(urlPath, tag) {
    try {
      const result = await fetchJSON('aerodatabox.p.rapidapi.com', urlPath, {
        'X-RapidAPI-Key':  apiKey,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
      });
      captureQuota(result.headers);
      if (result.status === 200 && Array.isArray(result.body)) {
        anySuccess = true;
        for (const f of result.body) allFlights.push({ ...f, _source: tag });
      } else if (result.status === 204 || result.status === 404) {
        anySuccess = true;
      } else {
        lastError = { status: result.status, body: result.body, tag };
      }
    } catch (e) {
      lastError = { message: e.message, tag };
    }
  }

  // Tail-number lookups (dedicated charter aircraft like DET's N313TR).
  for (const tail of tails) {
    for (const date of [yesterday, today]) {
      await runLookup(
        `/flights/reg/${encodeURIComponent(tail)}/${date}?withAircraftImage=false&withLocation=false`,
        `tail:${tail}`
      );
    }
  }

  // Callsign / flight-number lookups (pooled charters like DL8884 for STL).
  for (const callsign of callsigns) {
    for (const date of [yesterday, today]) {
      await runLookup(
        `/flights/number/${encodeURIComponent(callsign)}/${date}?withAircraftImage=false&withLocation=false`,
        `callsign:${callsign}`
      );
    }
  }

  if (!anySuccess && lastError) {
    return res.status(502).json({ error: 'Upstream lookup failed', detail: lastError });
  }

  // If destAirport is given, prefer arrivals INTO that airport.
  const filterTarget = destAirport || null;
  const targeted = filterTarget
    ? allFlights.filter(f => {
        const arr = f?.arrival?.airport?.iata || f?.arrival?.airport?.icao;
        return arr === filterTarget;
      })
    : allFlights;

  const arrival = pickLatestArrival(targeted.length ? targeted : allFlights, team.home_airport);
  const out = {
    team: abbr,
    home_airport: team.home_airport,
    tails: tails,
    callsigns: callsigns,
    dest_airport: destAirport,
    arrival,
    raw_flight_count: allFlights.length,
  };
  out.quota = _lastQuota;
  _cache[cacheKey] = { data: out, ts: now };
  res.setHeader('X-Cache', 'MISS');
  if (_lastQuota.remaining != null) res.setHeader('X-Aerodatabox-Remaining', _lastQuota.remaining);
  if (_lastQuota.limit != null)     res.setHeader('X-Aerodatabox-Limit', _lastQuota.limit);
  res.json(out);
});

module.exports = router;
