// Snake Savant — multi-agent collaboration route
//
// Two Claude Opus 4.7 agents collaborate to find the highest-value prop bets:
//   1. Corbin   — Baseball stat savant (Statcast, FanGraphs, pitch arsenals,
//                 park, weather, matchup, lineup, umpire). Produces calibrated
//                 probability estimates for player performance outcomes.
//   2. Carol    — Prop bet expert (live odds, implied probability, vig, EV,
//                 Kelly sizing, line shopping, CLV). Consumes Corbin's
//                 probability estimates, compares to live sportsbook lines,
//                 ranks bets by expected value.
//
// SSE response stream so the frontend can render the agents' work live.

const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const MODEL = 'claude-opus-4-7';
const ARSENAL_PATH = path.join(__dirname, '..', 'data', 'pitch_arsenal.json');

// ════════════════════════════════════════════════════════════════════════
//  TOOL HANDLERS  —  thin wrappers around the same data sources the rest of
//  the app already proxies. Returning compact JSON keeps the agents' context
//  small, which matters because Opus 4.7 tokenizes images and long CSVs
//  aggressively.
// ════════════════════════════════════════════════════════════════════════

async function mlb(pathStr) {
  const r = await fetch('https://statsapi.mlb.com' + pathStr);
  if (!r.ok) throw new Error(`MLB API ${r.status}`);
  return r.json();
}

async function savantCsv(endpoint, year = 2026, type = 'batter') {
  const url = `https://baseballsavant.mlb.com/leaderboard/${endpoint}?type=${type}&year=${year}&min=1&csv=true`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'text/csv',
      'Referer': 'https://baseballsavant.mlb.com/',
    },
  });
  if (!r.ok) throw new Error(`Savant ${endpoint} ${r.status}`);
  return parseCsv(await r.text());
}

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i]; });
    return obj;
  });
}

function parseCsvLine(line) {
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function findPlayerRow(rows, name) {
  const needle = name.toLowerCase();
  return rows.find(r => {
    const full = (r['last_name, first_name'] || r['name'] || '').toLowerCase();
    return full.includes(needle) || needle.split(' ').every(part => full.includes(part));
  });
}

// Tool: look up player ID by name via MLB people search
async function searchPlayer({ name }) {
  const data = await mlb(`/api/v1/people/search?names=${encodeURIComponent(name)}&active=true`);
  const matches = (data.people || []).slice(0, 5).map(p => ({
    id: p.id,
    fullName: p.fullName,
    position: p.primaryPosition?.abbreviation,
    bats: p.batSide?.code,
    throws: p.pitchHand?.code,
    team: p.currentTeam?.name,
  }));
  return { matches };
}

// Tool: full season stats with splits — slash line, advanced, batting hand splits
async function getPlayerStats({ player_id, season = 2026, group = 'hitting' }) {
  const data = await mlb(
    `/api/v1/people/${player_id}/stats?stats=season,statSplits,sabermetrics&sitCodes=vl,vr,h,a,d,n&season=${season}&group=${group}`
  );
  return compactStatsResponse(data);
}

function compactStatsResponse(data) {
  const out = { season: null, splits: {}, saber: null };
  for (const block of data.stats || []) {
    if (block.type?.displayName === 'season' && block.splits?.[0]) {
      out.season = block.splits[0].stat;
    } else if (block.type?.displayName === 'statSplits') {
      for (const s of block.splits || []) {
        const code = s.split?.code;
        if (code) out.splits[code] = s.stat;
      }
    } else if (block.type?.displayName === 'sabermetrics' && block.splits?.[0]) {
      out.saber = block.splits[0].stat;
    }
  }
  return out;
}

// Tool: recent game log (last N games)
async function getRecentGames({ player_id, count = 15, season = 2026, group = 'hitting' }) {
  const data = await mlb(
    `/api/v1/people/${player_id}/stats?stats=gameLog&season=${season}&group=${group}`
  );
  const splits = data.stats?.[0]?.splits || [];
  const recent = splits.slice(-count).map(s => ({
    date: s.date,
    opp: s.opponent?.name,
    isHome: s.isHome,
    stat: s.stat,
  }));
  return { games: recent, count: recent.length };
}

// Tool: career batter vs pitcher matchup
async function getMatchupHistory({ batter_id, pitcher_id }) {
  const data = await mlb(
    `/api/v1/people/${batter_id}/stats?stats=vsPlayerTotal&opposingPlayerId=${pitcher_id}&group=hitting`
  );
  const stat = data.stats?.[0]?.splits?.[0]?.stat;
  return stat ? { matchup: stat } : { matchup: null, note: 'no career PAs' };
}

// Tool: Statcast quality-of-contact metrics for one player
async function getStatcast({ player_name, year = 2026, type = 'batter' }) {
  const rows = await savantCsv('statcast', year, type);
  const row = findPlayerRow(rows, player_name);
  if (!row) return { found: false };
  // Keep the most predictive columns
  const keep = [
    'player_id', 'attempts', 'avg_hit_speed', 'max_hit_speed', 'avg_distance',
    'barrels', 'brl_percent', 'brl_pa', 'ev95plus', 'ev95percent',
    'sweet_spot_percent', 'avg_hit_angle', 'anglesweetspotpercent',
    'gb_percent', 'fb_percent', 'ld_percent', 'ev50', 'hr',
  ];
  const out = { found: true, name: row['last_name, first_name'] };
  keep.forEach(k => { if (row[k] !== undefined) out[k] = row[k]; });
  return out;
}

// Tool: expected stats (quality-of-contact x outcome regression)
async function getExpectedStats({ player_name, year = 2026, type = 'batter' }) {
  const rows = await savantCsv('expected_statistics', year, type);
  const row = findPlayerRow(rows, player_name);
  if (!row) return { found: false };
  return {
    found: true,
    name: row['last_name, first_name'],
    pa: row['pa'],
    ba: row['ba'], est_ba: row['est_ba'], est_ba_minus_ba_diff: row['est_ba_minus_ba_diff'],
    slg: row['slg'], est_slg: row['est_slg'], est_slg_minus_slg_diff: row['est_slg_minus_slg_diff'],
    woba: row['woba'], est_woba: row['est_woba'], est_woba_minus_woba_diff: row['est_woba_minus_woba_diff'],
  };
}

// Tool: bat tracking (bat speed, swing length, fast swing rate)
async function getBatTracking({ player_name, year = 2026 }) {
  const url = `https://baseballsavant.mlb.com/leaderboard/bat-tracking?type=batter&year=${year}&min=1&csv=true`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv', 'Referer': 'https://baseballsavant.mlb.com/' },
  });
  if (!r.ok) throw new Error('bat-tracking ' + r.status);
  const rows = parseCsv(await r.text());
  const row = findPlayerRow(rows, player_name);
  if (!row) return { found: false };
  return {
    found: true,
    name: row['last_name, first_name'],
    avg_bat_speed: row['avg_bat_speed'],
    fast_swing_rate: row['fast_swing_rate'],
    blasts_contact: row['blasts_contact'],
    blasts_swing: row['blasts_swing'],
    squared_up_contact: row['squared_up_contact'],
    swords: row['swords'],
    avg_swing_length: row['avg_swing_length'],
  };
}

// Tool: pitcher's pitch arsenal (cached daily refresh from local JSON)
async function getPitcherArsenal({ pitcher_id }) {
  try {
    const data = JSON.parse(fs.readFileSync(ARSENAL_PATH, 'utf8'));
    const arsenal = data.pitchers?.[String(pitcher_id)];
    return arsenal || { error: 'no arsenal data for that pitcher' };
  } catch (e) {
    return { error: 'arsenal data unavailable: ' + e.message };
  }
}

// Tool: pitcher CSW%, whiff% by pitch type from Savant
async function getPitcherPitchStats({ pitcher_name, year = 2026 }) {
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=${year}&min=1&csv=true`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv', 'Referer': 'https://baseballsavant.mlb.com/' },
  });
  if (!r.ok) throw new Error('pitch-arsenal ' + r.status);
  const rows = parseCsv(await r.text());
  const matches = rows.filter(r => {
    const name = (r['last_name, first_name'] || '').toLowerCase();
    return pitcher_name.toLowerCase().split(' ').every(p => name.includes(p));
  });
  return {
    pitches: matches.map(r => ({
      pitch_type: r['pitch_name'] || r['pitch_type'],
      usage: r['pitch_usage'],
      whiff_percent: r['whiff_percent'],
      k_percent: r['k_percent'],
      put_away: r['put_away'],
      woba: r['woba'],
      ba: r['ba'],
      slg: r['slg'],
      hard_hit_percent: r['hard_hit_percent'],
    })),
  };
}

// Tool: weather at coordinates
async function getWeather({ lat, lon }) {
  const r = await fetch(`https://wttr.in/${lat},${lon}?format=j1`, {
    headers: { 'User-Agent': 'curl/7.64.1' },
  });
  if (!r.ok) throw new Error('weather ' + r.status);
  const data = await r.json();
  const cur = data.current_condition?.[0] || {};
  return {
    temp_f: cur.temp_F,
    humidity: cur.humidity,
    wind_mph: cur.windspeedMiles,
    wind_dir: cur.winddir16Point,
    pressure: cur.pressure,
    condition: cur.weatherDesc?.[0]?.value,
  };
}

// Tool: get list of game events for a date (for finding event_id)
async function getGameEvents({ date }) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { error: 'ODDS_API_KEY not configured' };
  const r = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${apiKey}&dateFormat=iso&commenceTimeFrom=${date}T00:00:00Z&commenceTimeTo=${date}T23:59:59Z`
  );
  if (!r.ok) return { error: 'odds api ' + r.status };
  const events = await r.json();
  return {
    events: events.map(e => ({
      id: e.id,
      commence_time: e.commence_time,
      home_team: e.home_team,
      away_team: e.away_team,
    })),
  };
}

// Tool: live player props for a specific game
async function getPlayerProps({ event_id, markets = 'batter_hits,batter_total_bases,batter_home_runs,batter_rbis,batter_runs_scored,batter_hits_runs_rbis,pitcher_strikeouts' }) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { error: 'ODDS_API_KEY not configured' };
  const r = await fetch(
    `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${event_id}/odds?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`
  );
  if (!r.ok) return { error: 'odds api ' + r.status };
  const data = await r.json();
  // Flatten across bookmakers into one prop-per-line list with per-book pricing
  const props = {};
  for (const bm of data.bookmakers || []) {
    for (const market of bm.markets || []) {
      for (const outcome of market.outcomes || []) {
        const key = `${market.key}|${outcome.description || ''}|${outcome.point || ''}|${outcome.name}`;
        if (!props[key]) {
          props[key] = {
            market: market.key,
            player: outcome.description,
            line: outcome.point,
            side: outcome.name,
            books: [],
          };
        }
        props[key].books.push({ book: bm.key, price: outcome.price });
      }
    }
  }
  // Return only props with at least 2 books for fair-line estimation
  return {
    home_team: data.home_team,
    away_team: data.away_team,
    commence_time: data.commence_time,
    props: Object.values(props),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  TOOL DEFINITIONS  —  schemas Corbin and Carol expose to Claude.
// ════════════════════════════════════════════════════════════════════════

const CORBIN_TOOLS = [
  {
    name: 'search_player',
    description: 'Look up a player ID by name. Use this first whenever you need to query stats and only have a name. Returns the top 5 matches with team, position, batting and throwing hand.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Player name (e.g. "Corbin Carroll" or just "Carroll")' } },
      required: ['name'],
    },
  },
  {
    name: 'get_player_stats',
    description: "Full season stats for a hitter or pitcher including standard, sabermetric, and platoon splits (vs LHP/RHP, home/away, day/night). Use 'hitting' for batters, 'pitching' for pitchers.",
    input_schema: {
      type: 'object',
      properties: {
        player_id: { type: 'integer' },
        season: { type: 'integer', default: 2026 },
        group: { type: 'string', enum: ['hitting', 'pitching'], default: 'hitting' },
      },
      required: ['player_id'],
    },
  },
  {
    name: 'get_recent_games',
    description: 'Game-by-game log for the last N games. Use to assess hot/cold streaks and recent form (last 15 is a good default — gives 60+ PA for hitters).',
    input_schema: {
      type: 'object',
      properties: {
        player_id: { type: 'integer' },
        count: { type: 'integer', default: 15 },
        season: { type: 'integer', default: 2026 },
        group: { type: 'string', enum: ['hitting', 'pitching'], default: 'hitting' },
      },
      required: ['player_id'],
    },
  },
  {
    name: 'get_matchup_history',
    description: 'Career batter vs pitcher head-to-head (AVG/OBP/SLG/AB). Tiny samples — useful as a tiebreaker only, never as primary evidence.',
    input_schema: {
      type: 'object',
      properties: {
        batter_id: { type: 'integer' },
        pitcher_id: { type: 'integer' },
      },
      required: ['batter_id', 'pitcher_id'],
    },
  },
  {
    name: 'get_statcast',
    description: 'Statcast quality-of-contact: barrel%, hard-hit%, exit velocity, sweet-spot%, GB/FB/LD splits. This is the single most predictive batter feature set.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: { type: 'string' },
        year: { type: 'integer', default: 2026 },
        type: { type: 'string', enum: ['batter', 'pitcher'], default: 'batter' },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'get_expected_stats',
    description: 'xBA / xSLG / xwOBA — expected outcomes based on quality of contact. Diff vs actual (est_ba_minus_ba_diff etc.) flags lucky/unlucky performance due for regression.',
    input_schema: {
      type: 'object',
      properties: {
        player_name: { type: 'string' },
        year: { type: 'integer', default: 2026 },
        type: { type: 'string', enum: ['batter', 'pitcher'], default: 'batter' },
      },
      required: ['player_name'],
    },
  },
  {
    name: 'get_bat_tracking',
    description: 'Bat speed (mph), swing length (ft), fast-swing rate, blasts, squared-up rate. Pre-contact metrics that lead exit-velocity outcomes.',
    input_schema: {
      type: 'object',
      properties: { player_name: { type: 'string' }, year: { type: 'integer', default: 2026 } },
      required: ['player_name'],
    },
  },
  {
    name: 'get_pitcher_arsenal',
    description: "Pitcher's pitch mix with per-pitch usage%, whiff%, K%, wOBA, BA, SLG allowed. Critical for projecting K-prop and walk-prop outcomes.",
    input_schema: {
      type: 'object',
      properties: { pitcher_id: { type: 'integer' } },
      required: ['pitcher_id'],
    },
  },
  {
    name: 'get_pitcher_pitch_stats',
    description: 'Same data as get_pitcher_arsenal but by pitcher name, pulled fresh from Savant CSV. Use if arsenal lookup fails.',
    input_schema: {
      type: 'object',
      properties: { pitcher_name: { type: 'string' }, year: { type: 'integer', default: 2026 } },
      required: ['pitcher_name'],
    },
  },
  {
    name: 'get_weather',
    description: 'Live weather at stadium coordinates. Temp, humidity, wind speed + 16-point direction. Wind out at 10+ mph adds 1.5-2 ft per 10° temperature; humidity 70%+ depresses HRs ~3%.',
    input_schema: {
      type: 'object',
      properties: { lat: { type: 'number' }, lon: { type: 'number' } },
      required: ['lat', 'lon'],
    },
  },
];

const CAROL_TOOLS = [
  {
    name: 'get_game_events',
    description: 'List MLB game events for a date. Returns event IDs needed to look up player props.',
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD format' } },
      required: ['date'],
    },
  },
  {
    name: 'get_player_props',
    description: 'Live player prop odds across all US sportsbooks (DraftKings, FanDuel, BetMGM, Caesars, etc.) for a specific game. Returns every line/side with per-book American odds — use these to compute no-vig fair lines, identify the best price (line-shop), and detect outlier books.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        markets: {
          type: 'string',
          description: 'Comma-separated. Defaults cover the main props. Available: batter_hits, batter_total_bases, batter_home_runs, batter_rbis, batter_runs_scored, batter_walks, batter_strikeouts, batter_hits_runs_rbis, pitcher_strikeouts, pitcher_walks, pitcher_earned_runs, pitcher_hits_allowed',
        },
      },
      required: ['event_id'],
    },
  },
];

// ════════════════════════════════════════════════════════════════════════
//  SYSTEM PROMPTS  —  long-form expertise. Cached via prompt caching so we
//  only pay full input price once per ~5 minutes.
// ════════════════════════════════════════════════════════════════════════

const CORBIN_SYSTEM = `You are CORBIN — Snake Savant's resident baseball stat savant. You are a world-class quantitative baseball analyst who knows every facet of modern statistical evaluation, from rate-stat stabilization thresholds to high-leverage Statcast contact metrics.

## YOUR JOB
Given a game (date, teams, starting pitchers, target hitters), produce calibrated probability estimates for prop-bet-relevant outcomes:
- P(1+ hit), P(2+ hits)
- P(1+ total base), P(2+ total bases), P(3+ total bases)
- P(1+ HR)
- P(1+ RBI), P(2+ RBI)
- P(1+ run scored)
- For pitchers: P(strikeout count over/under), P(earned runs over/under), P(walks)

You output structured probabilities AND a written scouting report. Probabilities feed directly into the second agent (Carol, the prop bet expert) who compares them to live sportsbook lines.

## YOUR EXPERTISE — knowing what matters and what doesn't

### Statcast quality-of-contact (HIGHEST predictive value)
- **Barrel %** (BBE producing 98+ mph and 26-30° launch): direct HR/SLG indicator
- **Hard-hit %** (≥95 mph EV): floor for power outcomes
- **Sweet-spot %** (8-32° LA): "good contact" baseline
- **Average exit velocity**: stabilizes at ~50 BBE; predictive of BABIP
- **xBA / xSLG / xwOBA**: outcome-blind quality-of-contact regression. Diff vs actual (est_X_minus_X_diff) flags regression candidates
- **Bat speed (mph) + swing length (ft) + fast-swing %**: leading indicators that arrive before raw EV stabilizes
- **GB%/FB%/LD%**: skews matter — high FB rate + warm air + jet-stream wind = HR leverage

### Plate discipline (BB%, K%)
- K% stabilizes around 60 PA — small samples are real
- BB% stabilizes around 120 PA
- O-Swing% (chase rate) and Z-Contact% drive both K% and quality
- CSW% (called + swinging strikes / pitches) is the cleanest pitcher dominance metric
- A 5pp K% improvement in last 30 days is meaningful; chase 7+ pp = lock

### Pitcher arsenal
- Per-pitch usage, velocity, IVB, horizontal break, whiff%, putaway%, wOBA-against
- A reliever-turned-starter usually loses 2-3 mph FB by the 3rd time through
- High-FB% + low-extension pitcher in a hitter's park + warm air = HR leverage
- xFIP and SIERA outperform ERA for projection
- TBF/start and pitches thrown last outing inform pitch-count exits — affects K props

### Park factors (essential)
- Coors: 1.30 HR, 1.18 hit
- Yankee Stadium: 1.16 HR (short porch RF)
- Great American: 1.20 HR
- Citi Field, Oracle Park, Tropicana, Petco: HR suppressors (.82-.88)
- Roof status matters — closed roofs neutralize wind

### Weather
- Temperature: roughly +1.5 ft per 10°F on FB carry, +2-3 ft per 10°F for HRs near the wall
- Wind: 10 mph blowing out adds ~25 ft of carry on a 350-ft FB; 10 mph in subtracts the same
- Humidity: high humidity (70%+) depresses HR ~3-5% (denser air? actually less dense — but ball mass affects more)
- Pressure: low pressure → ball travels further
- Wind direction: gate to direction-out vs direction-in vs cross — Wrigley/Wrigley/Fenway most exposed

### Umpire impact
- HP umpire strike-zone size shifts K%/BB% by 1-3pp each direction
- Notable expanders: Angel Hernandez (historically), Doug Eddings
- Tight zones favor hitters: lower K%, higher BB%

### Splits and matchup logic
- Platoon disadvantage is real for non-switch hitters: avg ~50 OPS pts vs same-handed
- Career BvP < 30 PA is NOISE. Don't lean on it. Use only as tiebreaker.
- Last 15 games + season-long both matter; weight ~30/70 unless injury changes baseline

### Lineup context
- 1-2 spot batters get more PA (4.5/game vs 3.8 for 8-9 spot)
- 3-4-5 protection: high-OPS hitters behind raise walk rates by 1-2pp for the protected hitter
- 9th-spot hitters in NL parks get fewer high-leverage PA

### Stabilization thresholds (when to trust a sample)
- K%: 60 PA
- BB%: 120 PA
- HR rate: 170 PA
- AVG: 910 AB
- BABIP: 820 BIP
- ISO: 160 AB
- For pitchers: K% 70 BF, BB% 170 BF, GB% 70 BIP

### Outcome modeling (probability calibration)
Convert peripheral inputs to outcome probabilities using base rates + adjustments:

Example for **P(1+ hit)**:
1. Start with player's season AVG (call it p_hit_per_AB).
2. Convert to per-PA: p ≈ AVG × (1 - BB% - HBP%).
3. Estimate expected ABs for the game (3.8-4.2 for 1-2 hole, 3.6 for 5-6, 3.2 for 8-9).
4. P(1+ hit) = 1 - (1-p)^ABs.
5. Adjust for pitcher (allowed BAA), park, weather, platoon. Caps: don't go above 78% or below 38% without strong reasons.

Example for **P(1+ HR)**:
1. Player HR/PA baseline (typical: 2-4%, elite: 6-7%, weak: 1%).
2. Multiply by park HR factor / 1.00.
3. Multiply by pitcher HR/9 ratio relative to league avg (4.27 league).
4. Multiply by weather modifier (out-wind 10+ mph: ×1.10-1.15; in-wind: ×0.85-0.90; cold (<55F): ×0.92; hot (>85F): ×1.05).
5. Expected ABs ≈ 3.8. P(1+ HR) ≈ 1 - (1 - per-PA)^ABs.

For **P(1+ total base)** ≈ P(1+ hit) with small bump from extra-base events.
For **P(2+ total bases)** ≈ P(1+ hit) × (ISO-leveraged extra base bump) — rule of thumb 0.60-0.70 × P(1H) for mid-power, 0.75 × P(1H) for power hitters.

### What to AVOID
- Confirmation bias from one hot week or one hot/cold streak
- Over-weighting tiny BvP samples
- Anchoring to season-long when injury or role change has reset the baseline
- Ignoring lineup spot when projecting PA volume
- Forgetting park + weather + umpire as a unified bundle

## YOUR WORKFLOW
1. Use \`search_player\` to resolve any names you don't have IDs for.
2. Pull \`get_player_stats\` (with splits) for the focus batter(s).
3. Pull \`get_recent_games\` (last 15) for recent form.
4. Pull \`get_statcast\` + \`get_expected_stats\` + \`get_bat_tracking\` for quality-of-contact.
5. Pull pitcher data: \`search_player\` → \`get_player_stats\` (group=pitching) → \`get_pitcher_arsenal\` (or get_pitcher_pitch_stats by name).
6. Pull \`get_weather\` for stadium conditions.
7. Optionally \`get_matchup_history\` as a tiebreaker.
8. Reason explicitly through park, weather, umpire, lineup context, regression candidates.

## OUTPUT FORMAT
After your tool calls, end with a single fenced JSON block (no surrounding text inside the fence) named "CORBIN_REPORT" with this shape:

\`\`\`json
{
  "game": { "date": "YYYY-MM-DD", "away": "Team", "home": "Team", "stadium": "Name" },
  "conditions": {
    "weather_summary": "string",
    "park_hr_factor": 1.00,
    "wind_effect": "out|in|cross|neutral",
    "temperature_effect": "boost|neutral|drag"
  },
  "players": [
    {
      "name": "Full Name",
      "lineup_spot": 2,
      "vs_hand": "L|R",
      "expected_abs": 4.0,
      "probabilities": {
        "1h": 0.62,
        "2h": 0.25,
        "1tb": 0.66,
        "2tb": 0.35,
        "1hr": 0.06,
        "1rbi": 0.55,
        "1r": 0.50,
        "1h1r1rbi": 0.45
      },
      "confidence": "high|medium|low",
      "rationale": "2-4 sentence summary of the strongest factors driving the estimate.",
      "edges": ["short bullet list of the most exploitable signals"]
    }
  ],
  "pitchers": [
    {
      "name": "Full Name",
      "role": "starter",
      "expected_outs": 18,
      "probabilities": {
        "k_over_5p5": 0.55,
        "k_over_6p5": 0.40,
        "er_over_2p5": 0.45,
        "bb_over_1p5": 0.40
      },
      "rationale": "..."
    }
  ],
  "overall_notes": "Anything else Carol should know that doesn't fit above."
}
\`\`\`

Write your reasoning freely in markdown BEFORE the JSON block. The JSON is what gets handed to Carol. Keep probabilities calibrated — if you don't know, mark confidence "low" and stay near base rates rather than overclaiming.`;

const CAROL_SYSTEM = `You are CAROL — Snake Savant's prop-bet edge hunter. You take statistically calibrated probability estimates from Corbin (the stat savant) and compare them to live sportsbook lines to surface the highest-value bets on the board.

## YOUR JOB
For each prop the market is offering, compute:
1. **Implied probability** from the offered American odds
2. **No-vig fair probability** when both sides are available (proper market consensus)
3. **Edge** = Corbin's probability − no-vig probability
4. **Expected value (EV)** at the best available price
5. **Kelly fraction** (and recommended unit size at half-Kelly)

Then rank, filter, and explain.

## YOUR EXPERTISE

### Odds math (memorize these)
- **American → implied prob:** negative odds: p = |odds| / (|odds| + 100). Positive odds: p = 100 / (odds + 100).
  - Examples: -120 → 54.5%, -150 → 60.0%, -200 → 66.7%, +100 → 50.0%, +120 → 45.5%, +150 → 40.0%, +200 → 33.3%
- **Decimal → implied prob:** p = 1 / decimal_odds
- **American → decimal:** negative: 1 + 100/|odds|; positive: 1 + odds/100
- **Payout per $1 staked:** decimal_odds − 1

### Removing the vig (CRITICAL)
Books quote both sides with vig (juice/hold) baked in — implied probabilities sum to >100%. To get fair probability:
- Proportional method (most common): p_fair_A = p_imp_A / (p_imp_A + p_imp_B)
- The "hold" or "vig" is the overround: (p_imp_A + p_imp_B − 1)
- Typical vig in MLB player props: 8-14% on midcard markets, 4-8% on top markets
- Anything over 15% vig = book really doesn't want action — be suspicious

### EV calculation
At American odds with your true probability P:
- If odds positive (+X): EV per $100 = P × X − (1−P) × 100
- If odds negative (−X): EV per $100 = P × (100 × 100/X) − (1−P) × 100
- Cleaner: EV% = P × (decimal − 1) − (1 − P)
- A +3% EV bet at 100 units bet is +3 units expected return per bet
- Anything +4% or higher with confirmed pricing = strong play
- +1 to +3% = small edge, still profitable long-run

### Kelly criterion
- f* = (b·p − q) / b where b = (decimal − 1), p = true prob, q = 1 − p
- Full Kelly is volatile — most pros use **half-Kelly** or **quarter-Kelly**
- If Corbin marks confidence "low", use quarter-Kelly or skip
- Max 2-3% bankroll on any single bet regardless of Kelly suggestion

### Line shopping (always do this)
- A -110 vs -115 swing is ~1.5% EV — meaningful
- Compare every book in get_player_props. Recommend the BEST priced book per prop.
- Sharper books (Pinnacle, Circa) are absent in the US for MLB props — assume DK/FD/MGM/Caesars are the universe
- Outlier prices: if 6 books are at -115 and one is at -135, that one is stale — don't bet there. If 6 are at +110 and one is at +130, that's the play (book is slow).

### Market knowledge (props specifically)
- **batter_hits 0.5 Over:** highest-volume market, lowest variance. Hit rates typically 60-80%. Vig usually 6-10%.
- **batter_hits 1.5 Over:** sweet spot for skilled bettors. Hit rate 30-45%. Variance allows edge.
- **batter_total_bases 1.5 Over:** correlates with hits; power hitters have more leverage than contact bats.
- **batter_home_runs 0.5 Over:** highest variance, biggest mispricings. Markets struggle to price extreme park/wind/arsenal combos.
- **batter_hits_runs_rbis (H+R+RBI) 1.5 Over:** lineup-spot dependent. 1-2 hole hitters have huge structural edge.
- **pitcher_strikeouts:** tied to expected pitch count + opp K% + pitcher whiff%. Underbet by recreational books on dominant lefties facing K-prone lineups.
- **pitcher_walks:** soft market. BB rates volatile. Take overs on low-command starters in cold weather.

### Sample size / variance
- Single prop bet has variance of binomial(1, p) — std dev = sqrt(p(1-p))
- Need 50+ bets at +3% EV to reasonably trust profitability
- Daily portfolio approach: 3-7 carefully selected props per day, half-Kelly each, ~95% confidence intervals on bankroll

### Red flags (DON'T bet)
- Single book outlier with no vig confirmation — line is stale, may not stand
- Sharp action signal: if line moves AGAINST your edge in last 30 min before lock, skip
- Corbin confidence "low" + edge < 4%
- Vig over 15% on a single market (book is mispricing intentionally or knows something)
- Conflicting recent form (player on 0-for-20 stretch with no underlying QoC change)

### Anchoring (avoid)
- Don't anchor to your "favorite" players — go where the edge is
- Don't anchor to round numbers — a 5.5% edge is identical to 5.4% in decision terms
- Don't avoid contrarian sides — most edges come from underbet directions

## YOUR WORKFLOW
1. The user message will include CORBIN_REPORT (his structured probabilities). Read it carefully.
2. Call \`get_game_events\` with the game date to find the right event_id.
3. Call \`get_player_props\` for that event_id. Pull the relevant markets.
4. For each player in Corbin's report:
   - For each prop market available, compute: implied prob (best price), no-vig fair prob (using both sides), edge vs Corbin's probability, EV at best price, Kelly fraction.
   - Identify which book offers the best price (line-shop).
5. Filter to bets meeting ALL criteria:
   - Edge ≥ +2.5% (after vig removal)
   - Corbin confidence not "low" (unless edge ≥ +6%)
   - Vig ≤ 14% on that market
   - At least 2 books offering the side
6. Rank by EV percentage (descending).

## OUTPUT FORMAT
Reason in markdown above. End with a JSON block named "CAROL_REPORT":

\`\`\`json
{
  "bets": [
    {
      "rank": 1,
      "player": "Full Name",
      "market": "batter_hits",
      "side": "Over",
      "line": 0.5,
      "best_book": "draftkings",
      "best_price": -135,
      "implied_prob": 0.574,
      "no_vig_prob": 0.547,
      "corbin_prob": 0.62,
      "edge_pct": 7.3,
      "ev_pct": 6.5,
      "kelly_full": 0.0573,
      "kelly_half": 0.0286,
      "recommended_units": 1.4,
      "confidence": "high|medium|low",
      "reasoning": "1-2 sentences on WHY this is +EV. Cite the strongest factor.",
      "books_summary": "DK -135, FD -140, MGM -130"
    }
  ],
  "summary": {
    "total_bets_analyzed": 0,
    "bets_recommended": 0,
    "best_play_summary": "One sentence on the single highest-EV bet.",
    "portfolio_kelly_total": 0.0,
    "expected_units_won": 0.0
  },
  "skipped": [
    { "player": "Name", "market": "...", "reason": "edge too small (1.2%)" }
  ]
}
\`\`\`

Show 5-10 top bets. Be specific about the book to use. Round percentages to one decimal. Never recommend a bet without confirmed live pricing from get_player_props.`;

// ════════════════════════════════════════════════════════════════════════
//  TOOL DISPATCH
// ════════════════════════════════════════════════════════════════════════

const TOOL_HANDLERS = {
  search_player: searchPlayer,
  get_player_stats: getPlayerStats,
  get_recent_games: getRecentGames,
  get_matchup_history: getMatchupHistory,
  get_statcast: getStatcast,
  get_expected_stats: getExpectedStats,
  get_bat_tracking: getBatTracking,
  get_pitcher_arsenal: getPitcherArsenal,
  get_pitcher_pitch_stats: getPitcherPitchStats,
  get_weather: getWeather,
  get_game_events: getGameEvents,
  get_player_props: getPlayerProps,
};

async function runTool(name, input) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: `unknown tool: ${name}` };
  try {
    return await handler(input);
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ════════════════════════════════════════════════════════════════════════
//  AGENT LOOP  —  runs one Claude agent until it stops calling tools.
// ════════════════════════════════════════════════════════════════════════

async function runAgent({ client, name, systemPrompt, tools, userMessage, send, maxIterations = 15 }) {
  const messages = [{ role: 'user', content: userMessage }];
  let finalText = '';

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });

    // Surface text and tool use to the client
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        finalText += block.text;
        send('text', { agent: name, text: block.text });
      } else if (block.type === 'tool_use') {
        send('tool_use', { agent: name, name: block.name, input: block.input });
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;
    if (response.stop_reason !== 'tool_use') break;

    // Execute every tool_use block and feed results back
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await runTool(block.name, block.input);
      send('tool_result', { agent: name, name: block.name, summary: summarizeResult(result) });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 30000),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  send('agent_done', { agent: name });
  return finalText;
}

function summarizeResult(result) {
  if (result == null) return 'null';
  if (result.error) return `error: ${result.error}`;
  if (Array.isArray(result.events)) return `${result.events.length} events`;
  if (Array.isArray(result.props)) return `${result.props.length} props`;
  if (Array.isArray(result.matches)) return `${result.matches.length} matches`;
  if (result.found === false) return 'not found';
  if (result.found === true) return `${result.name || 'ok'}`;
  if (result.pitches) return `${result.pitches.length || Object.keys(result.pitches).length} pitch types`;
  if (result.season) return 'season + splits';
  if (result.games) return `${result.games.length} games`;
  if (result.matchup) return 'matchup found';
  return 'ok';
}

// ════════════════════════════════════════════════════════════════════════
//  PROGRAMMATIC API  —  used by the cron for background analysis
// ════════════════════════════════════════════════════════════════════════

function buildCorbinPrompt({ date, awayTeam, homeTeam, stadium, lat, lon, players, pitchers }) {
  return `Analyze the matchup and produce calibrated probabilities for prop-bet outcomes.

**Game:** ${awayTeam} @ ${homeTeam}
**Date:** ${date}
**Stadium:** ${stadium || 'unknown'}
${lat && lon ? `**Stadium coords:** ${lat}, ${lon}` : ''}

**Target hitters:**
${(players || []).map(p => `- ${p.name}${p.bats ? ` (Bats ${p.bats})` : ''}${p.lineupSpot ? `, lineup spot ${p.lineupSpot}` : ''}`).join('\n') || '(none specified — analyze the most relevant hitters from both lineups)'}

**Starting pitchers:**
${(pitchers || []).map(p => `- ${p.name}${p.throws ? ` (Throws ${p.throws})` : ''}${p.team ? `, ${p.team}` : ''}`).join('\n') || '(look up if needed)'}

Run your full workflow. End with the CORBIN_REPORT JSON block.`;
}

function buildCarolPrompt({ date, awayTeam, homeTeam, corbinText }) {
  return `Corbin has finished his statistical analysis. Below is his full report. Find the highest-EV prop bets on the board.

**Game:** ${awayTeam} @ ${homeTeam}
**Date:** ${date}

---
${corbinText}
---

Use get_game_events to find the event_id for this game (date ${date}), then get_player_props for that event_id. Compare every relevant line to Corbin's probabilities, line-shop across books, and rank by EV. Output the CAROL_REPORT JSON block.`;
}

function extractJsonBlock(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
  if (!matches.length) return null;
  try { return JSON.parse(matches[matches.length - 1][1]); } catch { return null; }
}

async function runAgentAnalysis({ date, awayTeam, homeTeam, stadium, players, pitchers, lat, lon }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const client = new Anthropic();
  const noop = () => {};

  const corbinText = await runAgent({
    client, name: 'corbin', systemPrompt: CORBIN_SYSTEM, tools: CORBIN_TOOLS,
    userMessage: buildCorbinPrompt({ date, awayTeam, homeTeam, stadium, lat, lon, players, pitchers }),
    send: noop,
  });

  const carolText = await runAgent({
    client, name: 'carol', systemPrompt: CAROL_SYSTEM, tools: CAROL_TOOLS,
    userMessage: buildCarolPrompt({ date, awayTeam, homeTeam, corbinText }),
    send: noop,
  });

  return {
    corbinReport: extractJsonBlock(corbinText),
    carolReport: extractJsonBlock(carolText),
    corbinText,
    carolText,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  ROUTE  —  POST /api/agents/analyze  →  SSE stream
// ════════════════════════════════════════════════════════════════════════

router.post('/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { date, awayTeam, homeTeam, stadium, players, pitchers, lat, lon } = req.body || {};
  if (!date || !awayTeam || !homeTeam) {
    return res.status(400).json({ error: 'date, awayTeam, homeTeam required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const client = new Anthropic();

  try {
    // ─── Phase 1: Corbin builds the statistical model ───
    send('phase', { phase: 'corbin_starting' });

    const corbinText = await runAgent({
      client,
      name: 'corbin',
      systemPrompt: CORBIN_SYSTEM,
      tools: CORBIN_TOOLS,
      userMessage: buildCorbinPrompt({ date, awayTeam, homeTeam, stadium, lat, lon, players, pitchers }),
      send,
    });

    // ─── Phase 2: Carol hunts edges ───
    send('phase', { phase: 'carol_starting' });

    await runAgent({
      client,
      name: 'carol',
      systemPrompt: CAROL_SYSTEM,
      tools: CAROL_TOOLS,
      userMessage: buildCarolPrompt({ date, awayTeam, homeTeam, corbinText }),
      send,
    });

    send('done', { ok: true });
  } catch (e) {
    console.error('[agents] error:', e);
    send('error', { message: String(e?.message || e), stack: e?.stack });
  } finally {
    res.end();
  }
});

module.exports = router;
module.exports.runAgentAnalysis = runAgentAnalysis;
