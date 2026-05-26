// Two scheduled jobs that fire web push notifications via routes/push.js:
//
//   1. Lineup posted    — once the MLB API has populated game.lineups.{home,away}Players
//                          for today's D-backs game
//   2. First pitch T-30 — fires when the game is 25–35 minutes from first pitch
//
// Both are idempotent via the notification_log table: (game_pk, type) is a
// primary key so an INSERT ... ON CONFLICT DO NOTHING returns 0 rows the second
// time we try to send for the same game.

const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');
const { sendToAll } = require('./routes/push');
const flightsRouter = require('./routes/flights');

const DBACKS_TEAM_ID = 109;

let _pool = null;
function pool() {
  if (!_pool && process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    _pool.query(`
      CREATE TABLE IF NOT EXISTS notification_log (
        game_pk TEXT NOT NULL,
        type    TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (game_pk, type)
      )
    `).catch(err => console.error('[cron] table init failed:', err.message));
  }
  return _pool;
}

// Atomic claim: returns true if this is the first time we're sending (game_pk, type)
async function claimNotification(gamePk, type) {
  if (!pool()) return false;
  try {
    const { rowCount } = await pool().query(
      'INSERT INTO notification_log (game_pk, type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [String(gamePk), type]
    );
    return rowCount > 0;
  } catch (err) {
    console.error('[cron] claim failed:', err.message);
    return false;
  }
}

// Arizona local date (UTC-7, no DST). Used to ask the MLB API for today's game
// without UTC midnight rollover issues.
function azDate() {
  return new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString().split('T')[0];
}

async function fetchTodayGame() {
  const date = azDate();
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${DBACKS_TEAM_ID}&date=${date}&hydrate=lineups,probablePitcher,venue`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MLB API ${r.status}`);
  const d = await r.json();
  return d?.dates?.[0]?.games?.[0] || null;
}

function isPlayableGame(game) {
  const state = game?.status?.abstractGameState;        // Preview / Live / Final
  const detail = game?.status?.detailedState || '';     // Postponed / Cancelled / etc.
  if (state === 'Final') return false;
  if (/Postponed|Cancelled|Suspended/i.test(detail)) return false;
  return true;
}

async function checkLineup() {
  try {
    const game = await fetchTodayGame();
    if (!game || !isPlayableGame(game)) return;
    const isHome = game.teams?.home?.team?.id === DBACKS_TEAM_ID;
    const players = (isHome ? game.lineups?.homePlayers : game.lineups?.awayPlayers) || [];
    if (!players.length) return;                         // not posted yet

    const claimed = await claimNotification(game.gamePk, 'lineup');
    if (!claimed) return;                                // already sent

    const opp = isHome ? game.teams.away : game.teams.home;
    const oppAbbr = opp?.team?.abbreviation || opp?.team?.teamName || 'opponent';
    const pitcherName = opp?.probablePitcher?.fullName || 'TBD';
    const topFive = players.slice(0, 5)
      .map(p => (p.lastName || (p.fullName || '').split(' ').pop()))
      .filter(Boolean)
      .join(' · ');

    const result = await sendToAll({
      title: '🐍 D-backs lineup posted',
      body: `vs ${pitcherName} (${oppAbbr}) — ${topFive}`,
      url: '/',
      tag: `lineup-${game.gamePk}`,
    });
    console.log(`[cron] lineup notification: sent=${result.sent} pruned=${result.removed}`);
  } catch (err) {
    console.error('[cron] checkLineup error:', err.message);
  }
}

async function checkFirstPitch() {
  try {
    const game = await fetchTodayGame();
    if (!game || !isPlayableGame(game) || !game.gameDate) return;

    const firstPitch = new Date(game.gameDate);
    const now = new Date();
    const minsUntil = (firstPitch - now) / 60000;
    // 5-min cron + 10-min window = at least one tick will hit during the window
    if (minsUntil < 25 || minsUntil > 35) return;

    const claimed = await claimNotification(game.gamePk, 'first_pitch_t30');
    if (!claimed) return;

    const isHome = game.teams?.home?.team?.id === DBACKS_TEAM_ID;
    const opp = isHome ? game.teams.away : game.teams.home;
    const oppAbbr = opp?.team?.abbreviation || opp?.team?.teamName || 'opponent';
    const pitcherName = opp?.probablePitcher?.fullName || 'TBD';
    const azTime = firstPitch.toLocaleTimeString('en-US', {
      timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit',
    });

    const result = await sendToAll({
      title: '⚾ First pitch in 30 min',
      body: `vs ${pitcherName} (${oppAbbr}) · ${azTime} AZ`,
      url: '/',
      tag: `t30-${game.gamePk}`,
    });
    console.log(`[cron] T-30 notification: sent=${result.sent} pruned=${result.removed}`);
  } catch (err) {
    console.error('[cron] checkFirstPitch error:', err.message);
  }
}

// ── Charter tracker poller ─────────────────────────────────────────────────
// Fires once an hour during a narrow window after the *getaway game's*
// first pitch — the game the tracked team is flying out of. Window opens
// at first-pitch + 3h, closes at first-pitch + 8h, and stops early once
// the arrival lands. Goal: ~3–5 upstream calls per series opener instead
// of one per page load.

let _charters = null;
function loadCharters() {
  if (_charters) return _charters;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'team_charters.json'), 'utf8');
    const parsed = JSON.parse(raw);
    delete parsed._README;
    _charters = parsed;
  } catch (e) {
    _charters = {};
  }
  return _charters;
}

async function fetchRecentGameForTeam(teamId, beforeYmd) {
  const start = new Date(new Date(beforeYmd).getTime() - 3 * 86400000).toISOString().slice(0, 10);
  const end   = new Date(new Date(beforeYmd).getTime() - 1 * 86400000).toISOString().slice(0, 10);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${end}&gameType=R`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MLB API ${r.status}`);
  const d = await r.json();
  const games = (d?.dates || []).flatMap(dt => dt.games || []);
  return games[games.length - 1] || null;
}

// Falls back to an in-memory Set when DATABASE_URL isn't configured, so the
// poller still self-limits in dev / when push is disabled.
const _landedMemory = new Set();
async function isLanded(gamePk) {
  if (pool()) {
    try {
      const { rowCount } = await pool().query(
        'SELECT 1 FROM notification_log WHERE game_pk=$1 AND type=$2',
        [String(gamePk), 'charter_landed']
      );
      return rowCount > 0;
    } catch (e) {
      return _landedMemory.has(String(gamePk));
    }
  }
  return _landedMemory.has(String(gamePk));
}
async function markLanded(gamePk) {
  _landedMemory.add(String(gamePk));
  if (pool()) {
    try {
      await pool().query(
        'INSERT INTO notification_log (game_pk, type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [String(gamePk), 'charter_landed']
      );
    } catch (e) { /* memory set is the fallback */ }
  }
}

async function checkCharterPoll() {
  try {
    if (!process.env.AERODATABOX_API_KEY) return;
    if (!flightsRouter.lookupTeam) return;

    const game = await fetchTodayGame();
    if (!game || !isPlayableGame(game) || !game.gamePk) return;
    if (await isLanded(game.gamePk)) return;

    const isHome = game.teams?.home?.team?.id === DBACKS_TEAM_ID;
    const todayOpp = isHome
      ? game.teams.away?.team?.abbreviation
      : game.teams.home?.team?.abbreviation;
    if (!todayOpp) return;

    const todayYmd = azDate();
    const prevDbacksGame = await fetchRecentGameForTeam(DBACKS_TEAM_ID, todayYmd);
    if (prevDbacksGame) {
      const prevHome = prevDbacksGame.teams?.home?.team?.id === DBACKS_TEAM_ID;
      const prevOpp = prevHome
        ? prevDbacksGame.teams.away?.team?.abbreviation
        : prevDbacksGame.teams.home?.team?.abbreviation;
      if (prevOpp === todayOpp) return; // mid-series, no travel
    }

    const trackedTeamAbbr = isHome ? todayOpp : 'ARI';
    const trackedTeamId = isHome
      ? (game.teams.away?.team?.id)
      : DBACKS_TEAM_ID;

    const getawayGame = await fetchRecentGameForTeam(trackedTeamId, todayYmd);
    if (!getawayGame?.gameDate) return;

    const firstPitch = new Date(getawayGame.gameDate).getTime();
    const hoursSince = (Date.now() - firstPitch) / 3600000;
    if (hoursSince < 3 || hoursSince > 8) return;

    const charters = loadCharters();
    const destAirport = isHome
      ? 'PHX'
      : (charters[todayOpp]?.home_airport || null);
    if (!destAirport) return;

    const result = await flightsRouter.lookupTeam(trackedTeamAbbr, destAirport);
    if (!result || result.status !== 200) {
      console.log(`[cron] charter poll: lookup status=${result?.status}`);
      return;
    }
    const arrival = result.data?.arrival;
    if (arrival?.arrUtc && new Date(arrival.arrUtc).getTime() <= Date.now()) {
      await markLanded(game.gamePk);
      console.log(`[cron] charter ${trackedTeamAbbr} landed at ${arrival.to} — polling stopped (gamePk=${game.gamePk})`);
    } else {
      console.log(`[cron] charter ${trackedTeamAbbr}→${destAirport}: T+${hoursSince.toFixed(1)}h, not landed yet`);
    }
  } catch (err) {
    console.error('[cron] checkCharterPoll error:', err.message);
  }
}

function start() {
  if (process.env.DISABLE_CRON === '1') {
    console.log('[cron] disabled via DISABLE_CRON=1');
    return;
  }

  const hasPush = process.env.DATABASE_URL && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY;
  if (hasPush) {
    cron.schedule('*/5 * * * *', checkLineup);
    cron.schedule('*/5 * * * *', checkFirstPitch);
    console.log('[cron] scheduled lineup + T-30 jobs (every 5 minutes)');
  } else {
    console.log('[cron] push jobs disabled (missing DATABASE_URL or VAPID keys)');
  }

  if (process.env.AERODATABOX_API_KEY) {
    cron.schedule('0 * * * *', checkCharterPoll);
    console.log('[cron] scheduled hourly charter poller (T+3h to T+8h after getaway first pitch)');
  } else {
    console.log('[cron] charter poller disabled (AERODATABOX_API_KEY not set)');
  }
}

module.exports = { start, checkLineup, checkFirstPitch, checkCharterPoll };
