// Typed wrappers around the backend proxy routes.
//
// Two flavors:
//   • Parsed-body wrappers (MLB, Savant, Odds, Weather) return the parsed
//     response directly — `await api.mlbBatterSeason(id)` gives you the JSON.
//     No `.json()` / `.text()` call needed by the caller.
//   • Response-returning wrappers (Sync, Push) return the raw Response object
//     so callers can branch on status (401 → wrong sync key, etc.).
//
// Goal: one place to change URL templates, one place to flip JSON vs text,
// one inventory of every endpoint the app uses.

import { SEASON } from './constants.js';

const _MLB    = '/mlb/api/v1';
const _SAVANT = '/savant';
const _ODDS   = '/odds/v4/sports/baseball_mlb';
const _DBACKS_TEAM_ID = 109;

// ── Internal helpers ────────────────────────────────────────────────────────
const _json = (url, init) => fetch(url, init).then(r => r.json());
const _text = (url, init) => fetch(url, init).then(r => r.text());

// ═══════════ MLB STATS API ═══════════════════════════════════════════════════

// Batter splits — sitCodes is comma-separated MLB API split codes
// (h, a, vl, vr, d, n, risp, etc.)
export const mlbBatterSplits = (playerId, sitCodes = 'h,a,vl,vr,d,n') =>
  _json(`${_MLB}/people/${playerId}/stats?stats=statSplits&group=hitting&season=${SEASON}&gameType=R&sitCodes=${sitCodes}`);

export const mlbBatterSeason = (playerId) =>
  _json(`${_MLB}/people/${playerId}/stats?stats=season&group=hitting&season=${SEASON}&gameType=R`);

export const mlbBatterGameLog = (playerId) =>
  _json(`${_MLB}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${SEASON}&gameType=R`);

// Same as gameLog but date-range filtered. Used by autoGrade to pull just one game.
export const mlbBatterGameLogRange = (playerId, mlbDate, seasonOverride) =>
  _json(`${_MLB}/people/${playerId}/stats?stats=gameLog&group=hitting&season=${seasonOverride || SEASON}&gameType=R&startDate=${mlbDate}&endDate=${mlbDate}`);

// Career splits vs a specific pitcher (or all-time if season unset).
export const mlbVsPitcher = (batterId, pitcherId, seasonScoped = true) => {
  const seasonParam = seasonScoped ? `&season=${SEASON}` : '';
  return _json(`${_MLB}/people/${batterId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&gameType=R${seasonParam}`);
};

// Pitcher endpoints.
export const mlbPitcherSeason = (pitcherId) =>
  _json(`${_MLB}/people/${pitcherId}/stats?stats=season&group=pitching&season=${SEASON}&gameType=R`);

export const mlbPitcherGameLog = (pitcherId) =>
  _json(`${_MLB}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${SEASON}&gameType=R`);

// Pitcher game log with team hydrate (used by pitcher-form fetch).
export const mlbPitcherGameLogHydrated = (pitcherId) =>
  _json(`${_MLB}/people/${pitcherId}/stats?stats=gameLog&season=${SEASON}&group=pitching&hydrate=team`);

export const mlbPitcherSplits = (pitcherId) =>
  _json(`${_MLB}/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=${SEASON}&gameType=R&sitCodes=h,a,vl,vr`);

// Person endpoints.
export const mlbPerson = (playerId) =>
  _json(`${_MLB}/people/${playerId}`);

export const mlbPersonSearch = (name) =>
  _json(`${_MLB}/people/search?names=${encodeURIComponent(name)}&sportId=1&active=true`);

// Schedule. Specific date OR a startDate/endDate range. Optional hydrate string.
export const mlbScheduleDate = (date, hydrate) => {
  const h = hydrate ? `&hydrate=${hydrate}` : '';
  return _json(`${_MLB}/schedule?sportId=1&teamId=${_DBACKS_TEAM_ID}&season=${SEASON}&gameType=R${h}&date=${date}`);
};

export const mlbScheduleRange = (startDate, endDate, hydrate) => {
  const h = hydrate ? `&hydrate=${hydrate}` : '';
  return _json(`${_MLB}/schedule?sportId=1&teamId=${_DBACKS_TEAM_ID}&season=${SEASON}&gameType=R${h}&startDate=${startDate}&endDate=${endDate}`);
};

// League standings (leagueId 104 = NL).
export const mlbStandings = (leagueId = 104) =>
  _json(`${_MLB}/standings?leagueId=${leagueId}&season=${SEASON}&standingsTypes=regularSeason&hydrate=team`);

// ═══════════ SAVANT (CSV TEXT) ═══════════════════════════════════════════════

export const savantStatcast    = (type) => _text(`${_SAVANT}/statcast?type=${type}&year=${SEASON}`);
export const savantExpected    = (type) => _text(`${_SAVANT}/expected?type=${type}&year=${SEASON}`);
export const savantBattedBall  = (type) => _text(`${_SAVANT}/batted-ball?type=${type}&year=${SEASON}`);
export const savantBattracking = ()     => _text(`${_SAVANT}/battracking?year=${SEASON}`);
export const savantBatterArsenal = ()   => _text(`${_SAVANT}/batter-arsenal?year=${SEASON}`);
export const savantCsw         = ()     => _text(`${_SAVANT}/csw?year=${SEASON}`);

// ═══════════ ODDS API ════════════════════════════════════════════════════════
// Returns Response (not parsed body) so callers can read the rate-limit header
// X-Requests-Remaining to update the credits badge.

export const oddsEvents = () =>
  fetch(`${_ODDS}/events?regions=us&oddsFormat=american`);

export const oddsProps = (eventId, markets) =>
  fetch(`${_ODDS}/events/${eventId}/odds?markets=${markets}&oddsFormat=american&regions=us,us2`);

// ═══════════ KALSHI (PREDICTION MARKET) ══════════════════════════════════════
// Public market-data surface only (no auth). Returns parsed JSON. Kalshi prices
// are cents (≈ implied probability of YES) — see betting.js:kalshiImpliedProb.
const _KALSHI = '/kalshi';

// List sports series (used to discover MLB player-prop series tickers, whose
// exact names can shift season to season).
export const kalshiSeriesList = (category = 'Sports') =>
  _json(`${_KALSHI}/series/?category=${encodeURIComponent(category)}`);

// Open events for a series, with each event's markets nested in the response so
// player/line/price all arrive in one call.
export const kalshiEvents = (seriesTicker, status = 'open') =>
  _json(`${_KALSHI}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=${status}&with_nested_markets=true`);

// Markets filtered by series (fallback discovery path when events nesting is
// unavailable for a series).
export const kalshiMarkets = (seriesTicker, status = 'open') =>
  _json(`${_KALSHI}/markets?series_ticker=${encodeURIComponent(seriesTicker)}&status=${status}&limit=1000`);

// ═══════════ WEATHER ════════════════════════════════════════════════════════

export const weatherAt = (lat, lon) =>
  _json(`/weather/${lat},${lon}?format=j1`);

// ═══════════ SYNC / PUSH (Response-returning) ════════════════════════════════
// These callers check `r.ok` and `r.status === 401` to handle auth failure
// without throwing, so the wrappers return Response objects directly.

export const syncGet = (syncKey) =>
  fetch('/api/sync', { headers: { 'X-Sync-Key': syncKey } });

export const syncPost = (syncKey, payload) =>
  fetch('/api/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': syncKey },
    body:    JSON.stringify(payload),
  });

export const pushPublicKey = () =>
  fetch('/api/push/public-key');

export const pushSubscribe = (syncKey, subscription) =>
  fetch('/api/push/subscribe', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': syncKey },
    body:    JSON.stringify(subscription),
  });

export const pushTest = (syncKey) =>
  fetch('/api/push/test', { method: 'POST', headers: { 'X-Sync-Key': syncKey } });
