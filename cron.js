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
const { sendToAll } = require('./routes/push');

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
    _pool.query(`
      CREATE TABLE IF NOT EXISTS agent_cache (
        game_pk       TEXT PRIMARY KEY,
        corbin_report JSONB,
        carol_report  JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(err => console.error('[cron] agent_cache table init failed:', err.message));
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

// In-memory fallback for agent_cache when DATABASE_URL is not configured.
const _agentCacheMem = new Map();

async function triggerAgentAnalysis(game) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const gamePk = String(game.gamePk);

  if (_agentCacheMem.has(gamePk)) return;
  if (pool()) {
    try {
      const { rowCount } = await pool().query(
        'SELECT 1 FROM agent_cache WHERE game_pk = $1', [gamePk]
      );
      if (rowCount > 0) return;
    } catch (e) {
      console.warn('[cron] agent_cache check failed:', e.message);
    }
  }

  const awayTeam = game.teams?.away?.team?.teamName || 'Away';
  const homeTeam = game.teams?.home?.team?.teamName || 'Home';
  const stadium  = game.venue?.name || '';
  const coords   = game.venue?.location?.defaultCoordinates || {};
  const date     = game.gameDate ? game.gameDate.split('T')[0] : azDate();

  const homePlayers = (game.lineups?.homePlayers || []).slice(0, 9);
  const awayPlayers = (game.lineups?.awayPlayers || []).slice(0, 9);
  const players = [...homePlayers, ...awayPlayers].map((p, i) => ({
    name: p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' '),
    bats: p.batSide?.code,
    lineupSpot: i < 9 ? i + 1 : i - 8,
  })).filter(p => p.name);

  const pitchers = [
    game.teams?.home?.probablePitcher
      ? { ...game.teams.home.probablePitcher, teamName: homeTeam } : null,
    game.teams?.away?.probablePitcher
      ? { ...game.teams.away.probablePitcher, teamName: awayTeam } : null,
  ].filter(Boolean).map(p => ({
    name: p.fullName,
    throws: p.pitchHand?.code,
    team: p.teamName,
  }));

  console.log('[cron] starting agent analysis for game', gamePk);
  const { runAgentAnalysis } = require('./routes/agents');
  const { corbinReport, carolReport } = await runAgentAnalysis({
    date, awayTeam, homeTeam, stadium,
    lat: coords.latitude, lon: coords.longitude,
    players, pitchers,
  });

  _agentCacheMem.set(gamePk, { corbinReport, carolReport });
  if (pool()) {
    await pool().query(`
      INSERT INTO agent_cache (game_pk, corbin_report, carol_report)
      VALUES ($1, $2, $3)
      ON CONFLICT (game_pk) DO UPDATE SET
        corbin_report = $2, carol_report = $3, created_at = now()
    `, [gamePk, JSON.stringify(corbinReport), JSON.stringify(carolReport)]);
  }
  console.log('[cron] agent analysis cached for game', gamePk);
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

    const analysisNote = process.env.ANTHROPIC_API_KEY ? ' — bet analysis starting' : '';
    const result = await sendToAll({
      title: '🐍 D-backs lineup posted',
      body: `vs ${pitcherName} (${oppAbbr}) — ${topFive}${analysisNote}`,
      url: '/',
      tag: `lineup-${game.gamePk}`,
    });
    console.log(`[cron] lineup notification: sent=${result.sent} pruned=${result.removed}`);
    triggerAgentAnalysis(game).catch(err =>
      console.warn('[cron] agent analysis failed:', err.message)
    );
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

    let topBets = '';
    try {
      const gamePk = String(game.gamePk);
      let carolReport = _agentCacheMem.get(gamePk)?.carolReport;
      if (!carolReport && pool()) {
        const { rows } = await pool().query(
          'SELECT carol_report FROM agent_cache WHERE game_pk = $1', [gamePk]
        );
        carolReport = rows[0]?.carol_report || null;
      }
      if (carolReport) {
        const parsed = typeof carolReport === 'string' ? JSON.parse(carolReport) : carolReport;
        const top = (parsed.bets || []).slice(0, 2);
        if (top.length) {
          topBets = ' · ' + top.map(b => {
            const lastName = (b.player || '').split(' ').pop();
            const mkt = (b.market || '').replace(/^(batter|pitcher)_/, '');
            const ev = typeof b.ev_pct === 'number' ? ` +${b.ev_pct.toFixed(1)}%` : '';
            return `${lastName} ${mkt}${ev}`;
          }).join(', ');
        }
      }
    } catch (e) {
      console.warn('[cron] bet cache lookup failed:', e.message);
    }

    const result = await sendToAll({
      title: '⚾ First pitch in 30 min',
      body: `vs ${pitcherName} (${oppAbbr}) · ${azTime} AZ${topBets}`,
      url: '/',
      tag: `t30-${game.gamePk}`,
    });
    console.log(`[cron] T-30 notification: sent=${result.sent} pruned=${result.removed}`);
  } catch (err) {
    console.error('[cron] checkFirstPitch error:', err.message);
  }
}

function start() {
  if (process.env.DISABLE_CRON === '1') {
    console.log('[cron] disabled via DISABLE_CRON=1');
    return;
  }
  if (!process.env.DATABASE_URL || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.log('[cron] missing DATABASE_URL or VAPID keys — scheduler not started');
    return;
  }
  cron.schedule('*/5 * * * *', checkLineup);
  cron.schedule('*/5 * * * *', checkFirstPitch);
  console.log('[cron] scheduled lineup + T-30 jobs (every 5 minutes)');
}

module.exports = { start, checkLineup, checkFirstPitch };
