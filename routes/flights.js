const express = require('express');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { errorResponse, ErrorCodes } = require('../lib/errors');
const router  = express.Router();

// Caches flight-history lookups so we don't burn AeroDataBox quota on every
// page load. Flight history for a past day is immutable; for "today" we still
// want a short TTL so an in-flight arrival eventually shows up.
const _cache = {};
const TTL_HISTORICAL = 6 * 60 * 60 * 1000;
const TTL_TODAY      = 15 * 60 * 1000;
// The /cached read path accepts entries up to 35 min old — just past the cron
// poller's 30-min cadence — so dashboard loads between polls ride the cron's
// cache instead of triggering their own live AeroDataBox call.
const TTL_CACHED_READ = 35 * 60 * 1000;

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

// AeroDataBox sometimes indexes a charter only under its ICAO callsign
// (e.g. DAL8876) and returns nothing for the IATA flight number we store in
// the registry (DL8876). Map the common MLB-charter airline prefixes so we can
// retry with the ICAO form when the IATA lookup comes back empty.
const IATA_TO_ICAO = { DL: 'DAL', UA: 'UAL', AA: 'AAL', AC: 'ACA', WN: 'SWA' };
function toIcaoCallsign(cs) {
  const m = /^([A-Z]{2})(\d.*)$/.exec(String(cs).toUpperCase());
  if (!m) return null;
  const icao = IATA_TO_ICAO[m[1]];
  return icao ? icao + m[2] : null;
}

// Pick the flight whose arrival looks most relevant for "the team is on the
// way to / has arrived at the host city": filter to flights with any kind of
// arrival timestamp (actual, estimated, or scheduled), prefer arrivals INTO
// the destination airport, then sort by arrival time desc.
function pickLatestArrival(flights, homeAirport) {
  if (!Array.isArray(flights)) return null;
  const scored = flights
    .map(f => {
      const arrIata = f?.arrival?.airport?.iata || f?.arrival?.airport?.icao;
      // AeroDataBox's schema has shifted: the actual on/off-runway time arrives as
      // `runwayTime` (current) or `actualTime` (older), and the updated ETA as
      // `predictedTime` (ML) or `revisedTime` (ATC). Read both spellings so a
      // landed flight actually registers an arrival time instead of looking
      // permanently "en route" because we only checked the legacy field name.
      const depActual    = f?.departure?.actualTime || f?.departure?.runwayTime   || null;
      const arrActual    = f?.arrival?.actualTime   || f?.arrival?.runwayTime     || null;
      const arrEstimated = f?.arrival?.predictedTime || f?.arrival?.revisedTime   || null;
      const arrScheduledUtc = f?.arrival?.scheduledTime?.utc || null;
      const arrEstimatedUtc = arrEstimated?.utc || null;
      const arrActualUtc    = arrActual?.utc    || null;
      // Sort key: prefer actual > estimated > scheduled.
      const arrUtc = arrActualUtc || arrEstimatedUtc || arrScheduledUtc;
      if (!arrUtc) return null;
      return {
        tail: f?.aircraft?.reg,
        callsign: f?.callSign || f?.number,
        source: f?._source,
        from:  f?.departure?.airport?.iata || f?.departure?.airport?.icao,
        to:    arrIata,
        // Convenience fields (best-available, what the existing UI uses):
        depUtc:   depActual?.utc   || f?.departure?.scheduledTime?.utc,
        depLocal: depActual?.local || f?.departure?.scheduledTime?.local,
        arrUtc,
        arrLocal: arrActual?.local || arrEstimated?.local || f?.arrival?.scheduledTime?.local,
        // Discrete fields so the client can tell "departed yet?" / "landed yet?":
        depScheduledUtc:   f?.departure?.scheduledTime?.utc   || null,
        depScheduledLocal: f?.departure?.scheduledTime?.local || null,
        depActualUtc:      depActual?.utc   || null,
        depActualLocal:    depActual?.local || null,
        arrScheduledUtc,
        arrScheduledLocal: f?.arrival?.scheduledTime?.local   || null,
        arrEstimatedUtc,
        arrEstimatedLocal: arrEstimated?.local || null,
        arrActualUtc,
        arrActualLocal:    arrActual?.local || null,
        intoHome: homeAirport && arrIata === homeAirport,
        status: f?.status,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.arrUtc) - new Date(a.arrUtc));
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

async function lookupTeam(abbr, destAirport) {
  const apiKey = process.env.AERODATABOX_API_KEY;
  if (!apiKey) {
    return { status: 503, data: { error: 'AERODATABOX_API_KEY not configured', code: ErrorCodes.NOT_CONFIGURED } };
  }

  abbr = abbr.toUpperCase();
  destAirport = (destAirport || '').toUpperCase() || null;
  const charters = loadCharters();
  const team = charters[abbr];
  if (!team) return { status: 404, data: { error: `Unknown team ${abbr}`, code: ErrorCodes.NOT_FOUND } };

  const tails     = Array.isArray(team.tails)     ? team.tails     : [];
  const callsigns = Array.isArray(team.callsigns) ? team.callsigns : [];
  if (!tails.length && !callsigns.length) {
    return { status: 200, cache: 'SKIP', data: {
      team: abbr, home_airport: team.home_airport, tails: [], callsigns: [], arrival: null,
      note: `No tail numbers or callsigns registered for ${abbr}. Add them to data/team_charters.json.`,
    }};
  }

  const cacheKey = `${abbr}|${destAirport || ''}`;
  const now = Date.now();
  if (_cache[cacheKey] && now - _cache[cacheKey].ts < TTL_TODAY) {
    return { status: 200, cache: 'HIT', data: _cache[cacheKey].data };
  }

  // The query window is computed in UTC, but every MLB destination city sits at
  // UTC-4 to UTC-10 (PHX is UTC-7 year-round, no DST). A flight's local date can
  // therefore lag the UTC date by a day: once it's evening in Phoenix, UTC has
  // already rolled over, so "yesterday (UTC)" is really "today" locally and a
  // genuine previous-day arrival drops out of a two-date window. Because every
  // North-American airport is behind UTC, going three UTC dates back guarantees
  // we cover local-yesterday + local-today regardless of when in the day we run.
  const today              = ymd(new Date());
  const yesterday          = ymd(new Date(Date.now() - 86400000));
  const dayBeforeYesterday = ymd(new Date(Date.now() - 2 * 86400000));
  // Tomorrow (UTC) is included so PRE-departure scheduled flights are visible:
  // a charter filed for tomorrow's local date (or a late-night Eastern departure
  // that lands on tomorrow's UTC date) would otherwise be invisible to the cron
  // ETD scout until the day of, and the dashboard could never show its ETD.
  const tomorrow           = ymd(new Date(Date.now() + 86400000));
  const lookupDates = [dayBeforeYesterday, yesterday, today, tomorrow];
  const allFlights = [];
  let anySuccess = false;
  let lastError = null;

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

  for (const tail of tails) {
    for (const date of lookupDates) {
      await runLookup(
        `/flights/reg/${encodeURIComponent(tail)}/${date}?withAircraftImage=false&withLocation=false`,
        `tail:${tail}`
      );
    }
  }
  for (const callsign of callsigns) {
    for (const date of lookupDates) {
      await runLookup(
        `/flights/number/${encodeURIComponent(callsign)}/${date}?withAircraftImage=false&withLocation=false`,
        `callsign:${callsign}`
      );
    }
  }

  // ICAO fallback — only fires when the IATA callsign lookups found nothing, so
  // it costs no extra quota on the common path. Keeps the original (IATA) tag so
  // the UI still displays the registered callsign rather than the ICAO form.
  if (!allFlights.length && callsigns.length) {
    for (const callsign of callsigns) {
      const icao = toIcaoCallsign(callsign);
      if (!icao) continue;
      for (const date of lookupDates) {
        await runLookup(
          `/flights/number/${encodeURIComponent(icao)}/${date}?withAircraftImage=false&withLocation=false`,
          `callsign:${callsign}`
        );
      }
    }
  }

  if (!anySuccess && lastError) {
    return { status: 502, data: { error: 'Upstream lookup failed', code: ErrorCodes.UPSTREAM_FAILED, detail: lastError } };
  }

  const targeted = destAirport
    ? allFlights.filter(f => {
        const arr = f?.arrival?.airport?.iata || f?.arrival?.airport?.icao;
        return arr === destAirport;
      })
    : allFlights;

  const arrival = pickLatestArrival(targeted.length ? targeted : allFlights, team.home_airport);
  const out = {
    team: abbr,
    home_airport: team.home_airport,
    tails, callsigns,
    dest_airport: destAirport,
    arrival,
    raw_flight_count: allFlights.length,
    quota: _lastQuota,
  };
  _cache[cacheKey] = { data: out, ts: now };
  return { status: 200, cache: 'MISS', data: out };
}

function readCached(abbr, destAirport) {
  abbr = abbr.toUpperCase();
  destAirport = (destAirport || '').toUpperCase() || null;
  const cacheKey = `${abbr}|${destAirport || ''}`;
  const entry = _cache[cacheKey];
  if (!entry) return null;
  const ageMs = Date.now() - entry.ts;
  // Treat stale entries as a miss so the client's live fallback fires and
  // fetches fresh AeroDataBox data rather than looping on an old EN ROUTE state.
  if (ageMs >= TTL_CACHED_READ) return null;
  return { data: entry.data, ageMs };
}

// GET /flights/team/:abbr  — most recent charter movement for the team.
// Optional ?destAirport=PHX to flag arrival into a specific city.
router.get('/team/:abbr', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const result = await lookupTeam(req.params.abbr, req.query.destAirport);
  if (result.cache) res.setHeader('X-Cache', result.cache);
  if (_lastQuota.remaining != null) res.setHeader('X-Aerodatabox-Remaining', _lastQuota.remaining);
  if (_lastQuota.limit != null)     res.setHeader('X-Aerodatabox-Limit', _lastQuota.limit);
  res.status(result.status).json(result.data);
});

// GET /flights/team/:abbr/cached — returns whatever the scheduled poller has
// last cached for this team, without making any upstream call. Lets the
// dashboard render without burning quota; returns 204 if nothing cached yet.
router.get('/team/:abbr/cached', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const entry = readCached(req.params.abbr, req.query.destAirport);
  if (!entry) return res.status(204).end();
  res.setHeader('X-Cache', 'HIT');
  res.setHeader('X-Cache-Age-Ms', String(entry.ageMs));
  res.json(entry.data);
});

module.exports = router;
module.exports.lookupTeam = lookupTeam;
module.exports.readCached = readCached;
