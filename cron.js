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

// Looks forward up to 2 days for the next Live or Preview D-backs game.
// Used by checkCharterPoll so it can start scouting on the getaway-game day
// or an off day, before the series opener has gone Live.
async function fetchNextSeriesGame() {
  const start = azDate();
  const end   = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${DBACKS_TEAM_ID}&startDate=${start}&endDate=${end}&gameType=R`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MLB API ${r.status}`);
  const d = await r.json();
  const games = (d?.dates || []).flatMap(dt => dt.games || []);
  return games.find(g => g.status?.abstractGameState === 'Live')
      || games.find(g => g.status?.abstractGameState === 'Preview')
      || null;
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
// Runs every 30 minutes. For series-opener travel days the poller works in
// two phases:
//
//   1. SCOUT (T+1h → ETD): once per 2-hour retry interval, calls lookupTeam
//      to get the charter's scheduled departure time (ETD) from AeroDataBox.
//      AeroDataBox includes pre-departure scheduled flights, so the first
//      scout call typically finds ETD on the first try and populates the
//      /cached endpoint so the dashboard shows "scheduled 5:00 PM" well
//      before wheels-up.
//
//   2. ACTIVE POLL (ETD → ETD+6h): once ETD is known (or falls back to
//      T+3h if AeroDataBox has no schedule yet), polls every 30 min until
//      the charter lands or the window closes.
//
// ~3–5 upstream calls total per series opener (1–2 scouts + active polls).

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

// Per-trip ETD (scheduled departure) cache so we don't re-scout on every
// tick once we've found the flight schedule. Keyed by "gameDate|trackedTeam".
const _etdCache   = {};  // { key: etdMs }
const _etdScoutTs = {};  // { key: lastAttemptMs }
const SCOUT_RETRY_MS = 2 * 3600 * 1000; // retry scout at most once per 2h

async function isLanded(gamePk, team) {
  const type = `charter_landed_${team.toLowerCase()}`;
  if (pool()) {
    try {
      const { rowCount } = await pool().query(
        'SELECT 1 FROM notification_log WHERE game_pk=$1 AND type=$2',
        [String(gamePk), type]
      );
      return rowCount > 0;
    } catch (e) {
      return _landedMemory.has(`${gamePk}:${team}`);
    }
  }
  return _landedMemory.has(`${gamePk}:${team}`);
}
async function markLanded(gamePk, team) {
  _landedMemory.add(`${gamePk}:${team}`);
  const type = `charter_landed_${team.toLowerCase()}`;
  if (pool()) {
    try {
      await pool().query(
        'INSERT INTO notification_log (game_pk, type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [String(gamePk), type]
      );
    } catch (e) { /* memory set is the fallback */ }
  }
}

async function checkCharterPoll() {
  try {
    if (!process.env.AERODATABOX_API_KEY) return;
    if (!flightsRouter.lookupTeam) return;

    // Look ahead up to 2 days for the next series opener — covers off days
    // and the case where today's game is Final but the charter for the next
    // series is about to depart or just landed.
    const game = await fetchNextSeriesGame();
    if (!game || !game.gamePk || !game.gameDate) return;
    const detail = game?.status?.detailedState || '';
    if (/Postponed|Cancelled|Suspended/i.test(detail)) return;

    const isHome = game.teams?.home?.team?.id === DBACKS_TEAM_ID;
    const todayOpp = isHome
      ? game.teams.away?.team?.abbreviation
      : game.teams.home?.team?.abbreviation;
    if (!todayOpp) return;

    const todayYmd = azDate();
    const prevDbacksGame = await fetchRecentGameForTeam(DBACKS_TEAM_ID, todayYmd);
    let dbacksPrevAway = false;
    if (prevDbacksGame) {
      const prevHome = prevDbacksGame.teams?.home?.team?.id === DBACKS_TEAM_ID;
      const prevOpp = prevHome
        ? prevDbacksGame.teams.away?.team?.abbreviation
        : prevDbacksGame.teams.home?.team?.abbreviation;
      if (prevOpp === todayOpp) return; // mid-series, no travel
      dbacksPrevAway = !prevHome;
    }

    const charters = loadCharters();

    // Build list of teams to track for this series opener.
    // Home game: opponent flying into PHX is always tracked; D-backs are also
    //   tracked when they're returning from a road trip (prevGame was away).
    // Away game: D-backs flying to the opponent's home airport.
    const toTrack = [];
    if (isHome) {
      toTrack.push({ team: todayOpp, dest: 'PHX' });
      if (dbacksPrevAway) toTrack.push({ team: 'ARI', dest: 'PHX' });
    } else {
      const dest = charters[todayOpp]?.home_airport || null;
      if (!dest) return;
      toTrack.push({ team: 'ARI', dest });
    }

    // Timing bounds: scout/poll from 60h before the series opener's first pitch
    // through 12h after. 60h (vs 48h) ensures the window opens well before a
    // same-day post-game charter departure (e.g. 5 PM game-day flight when the
    // opener is 2.5 days away), so AeroDataBox can be queried while the flight
    // is still in "SCHEDULED" state and the dashboard shows the ETD.
    const openerFirstPitch = new Date(game.gameDate).getTime();
    if (Date.now() < openerFirstPitch - 60 * 3600000) return;
    if (Date.now() > openerFirstPitch + 12 * 3600000) return;

    for (const { team, dest } of toTrack) {
      if (await isLanded(game.gamePk, team)) continue;

      const etdKey = `${todayYmd}|${team}`;

      // ── Phase 1: ETD scout ───────────────────────────────────────────────
      // Call lookupTeam (with its own 15-min cache) to fetch the scheduled
      // departure time before the flight actually departs. AeroDataBox returns
      // pre-departure flights with departure.scheduledTime.utc populated, so
      // this populates the /cached endpoint with "SCHEDULED" state for the
      // dashboard and lets us open the poll window right at departure time
      // rather than at a fixed T+3h offset.
      if (!_etdCache[etdKey]) {
        const lastScout = _etdScoutTs[etdKey] || 0;
        if (Date.now() - lastScout >= SCOUT_RETRY_MS) {
          _etdScoutTs[etdKey] = Date.now();
          const scout = await flightsRouter.lookupTeam(team, dest);
          if (scout.status === 200) {
            const arr = scout.data?.arrival;
            // Only trust ETD when the flight is confirmed into the right airport.
            if (arr && arr.to === dest && arr.depScheduledUtc) {
              const etdMs = new Date(arr.depScheduledUtc).getTime();
              if (!isNaN(etdMs)) {
                _etdCache[etdKey] = etdMs;
                console.log(`[cron] charter ${team} ETD scouted: ${arr.depScheduledUtc}`);
              }
            }
          }
        }
      }

      // ── Phase 2: polling window ──────────────────────────────────────────
      const etdMs = _etdCache[etdKey];
      // Open at ETD; fall back to 6h before opener first pitch if no schedule found.
      const windowStart = etdMs ?? (openerFirstPitch - 6 * 3600000);
      const windowEnd   = etdMs ? etdMs + 6 * 3600000 : openerFirstPitch + 2 * 3600000;

      if (Date.now() < windowStart) {
        if (etdMs) {
          const minUntil = Math.round((windowStart - Date.now()) / 60000);
          console.log(`[cron] charter ${team} ETD in ${minUntil} min — poll window not open yet`);
        }
        continue;
      }
      if (Date.now() > windowEnd) continue;

      // ── Active poll ──────────────────────────────────────────────────────
      const result = await flightsRouter.lookupTeam(team, dest);
      if (!result || result.status !== 200) {
        console.log(`[cron] charter poll: ${team} lookup status=${result?.status}`);
        continue;
      }
      const arrival = result.data?.arrival;
      // Mirror the client's landed logic: arrActualUtc OR a status string that
      // indicates the plane is on the ground. AeroDataBox often updates status
      // before populating arrActualUtc, so checking both avoids missing landings.
      const statusLc = (arrival?.status || '').toLowerCase();
      const arrivedByStatus = /(arrived|landed|on block|canceled|cancelled|diverted)/.test(statusLc);
      const hasLanded = (arrival?.arrActualUtc && new Date(arrival.arrActualUtc).getTime() <= Date.now())
                     || arrivedByStatus;
      if (hasLanded) {
        await markLanded(game.gamePk, team);
        console.log(`[cron] charter ${team} landed at ${arrival.to} — polling stopped (gamePk=${game.gamePk})`);
      } else {
        const refMs = etdMs ?? (openerFirstPitch - 6 * 3600000);
        const minSince = Math.round((Date.now() - refMs) / 60000);
        const tag = etdMs ? 'ETD' : 'T-6h';
        console.log(`[cron] charter ${team}→${dest}: +${minSince}min from ${tag}, not landed`);
      }
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
    cron.schedule('*/30 * * * *', checkCharterPoll);
    console.log('[cron] scheduled charter poller every 30min (ETD-triggered after getaway game)');
  } else {
    console.log('[cron] charter poller disabled (AERODATABOX_API_KEY not set)');
  }
}

module.exports = { start, checkLineup, checkFirstPitch, checkCharterPoll };
