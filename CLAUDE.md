# Snake Savant — D-backs Predictor

## Overview

A D-backs-focused prop-bet prediction tool. The backend proxies all external APIs; the frontend contains all prediction logic and UI. The app is also a PWA (installable, web push notifications).

## Project Structure

```
server.js              Express entry point + startup logic
cron.js                Scheduled push notification jobs
lib/
  errors.js            Shared error envelope + ErrorCodes
routes/
  mlb.js               Proxy → statsapi.mlb.com
  odds.js              Proxy → api.the-odds-api.com (in-memory cache)
  savant.js            Proxy → baseballsavant.mlb.com (CSV, in-memory cache)
  fangraphs.js         Proxy → fangraphs.com pitching leaderboard (CSV)
  arsenal.js           Serves data/pitch_arsenal.json (file-backed cache)
  flights.js           Proxy → AeroDataBox via RapidAPI (charter tracker)
  push.js              Web Push subscribe/unsubscribe/send + VAPID setup
  sync.js              Cross-device state sync via PostgreSQL
data/
  pitch_arsenal.json   Pre-built pitcher/batter pitch-arsenal data (daily refresh)
  team_charters.json   MLB charter aircraft tail numbers + callsigns by team
scripts/
  refresh_pitch_arsenal.py  Python script (pybaseball) that builds pitch_arsenal.json
  install-cron.sh      macOS launchd installer for the daily arsenal refresh
  com.dbacks-predictor.refresh-arsenal.plist
public/
  index.html           App shell (minimal — scripts/CSS are external files)
  manifest.webmanifest PWA manifest ("Snake Savant")
  sw.js                Service worker (push notification receipt + tap routing)
  css/
    style.css          All styles (~1,300 lines)
  js/
    constants.js       Pure data: SEASON, rosters, umpire DB, venue map, STAT_INFO
    utils.js           Pure DOM/math helpers: show/hide/setText, parseCSV, _parkFactors
    state.js           Global S object, DEBUG flag, log(), player-context transaction
    api.js             Typed wrappers for every backend proxy endpoint
    player.js          Player-stat primitives: Poisson, binomial, TB convolution, log-5
    predict.js         Gaussian sampler, slump dampener, modelProbability, monteCarloConfidence
    pitcher.js         FIP/xFIP/SIERA/K-BB%, pitch-mix normalization, arsenal cache loader
    betting.js         impliedProb, americanToDecimal, kellyFraction, devig
    sync.js            Cross-device sync (pushRecord/pullRecord) + sync-key helpers
    push.js            Web push notification subscription + service worker registration
    weather.js         Live weather fetch + park-relative wind direction (_windDir, _COMPASS_DEGS)
    app.js             Main orchestrator: data loaders, UI, event delegation, bootstrap
    charter.js         Charter flight tracker UI (classic script, not ES module)
    ui/
      modal.js         Modal lifecycle (open/close + player-context coordination)
      render.js        Shared render helpers: statBox, _renderStatcastGrid, _renderPitchMatchup
    *.test.js          Node test suite (node --test) — 94 tests covering math modules
league-hub/            Standalone MLB-wide dashboard (separate Express app, port 3100)
```

## Stack

- **Backend**: Node.js + Express 5, CommonJS
- **Frontend**: Vanilla JS ES modules (no framework, no build step)
- **Database**: PostgreSQL (push subscriptions + sync state + notification dedup log)
- **External services**: MLB Stats API, Baseball Savant, The Odds API, wttr.in, AeroDataBox (RapidAPI), FanGraphs
- **PWA**: Web push notifications via VAPID + `web-push` library

## Dev Server

```
npm start        # port 3000
npm run lint     # eslint
npm test         # node --test public/js/*.test.js
npm run test:all # lint + test
npm run refresh-arsenal   # rebuild data/pitch_arsenal.json (requires pybaseball)
```

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `ODDS_API_KEY` | Yes | The Odds API betting lines |
| `DATABASE_URL` | Push/sync only | PostgreSQL connection string |
| `VAPID_PUBLIC_KEY` | Push only | Web push VAPID public key |
| `VAPID_PRIVATE_KEY` | Push only | Web push VAPID private key |
| `VAPID_CONTACT` | Push only | mailto: contact for VAPID (default: `noreply@dbacks-predictor.local`) |
| `SYNC_KEY` | Sync/push only | Shared secret for cross-device sync + push subscription auth |
| `AERODATABOX_API_KEY` | Charter tracker only | RapidAPI key for AeroDataBox flight lookups |
| `DISABLE_CRON` | Dev | Set to `1` to suppress all scheduled jobs |

Generate VAPID keys once: `node -e "console.log(require('web-push').generateVAPIDKeys())"`

## API Routes

### Proxy routes (server.js → routes/)

| Mount | Destination | Notes |
|---|---|---|
| `/mlb/*` | statsapi.mlb.com | Pass-through; streams JSON |
| `/odds/*` | api.the-odds-api.com | In-memory cache: 1h (events), 20min (props) |
| `/weather/*` | wttr.in | Pass-through |
| `/savant/statcast` | Baseball Savant Statcast leaderboard | CSV, 1h cache |
| `/savant/expected` | Baseball Savant xStats leaderboard | CSV, 1h cache |
| `/savant/battracking` | Baseball Savant bat tracking | CSV, 1h cache |
| `/savant/csw` | Savant pitcher arsenal stats (whiff/K/put-away by pitch) | CSV, 1h cache |
| `/savant/batter-arsenal` | Savant batter pitch-arsenal stats | CSV, 1h cache |
| `/savant/batted-ball` | Savant batted-ball leaderboard (true GB%/FB%) | CSV, 1h cache |
| `/fangraphs/pitchers` | FanGraphs pitcher leaderboard (xFIP, advanced) | Follows redirects |
| `/pitch-arsenal` | `data/pitch_arsenal.json` | File-backed, refreshed daily |
| `/flights/team/:abbr` | AeroDataBox via RapidAPI | Charter flight lookup, 15min cache |
| `/flights/team/:abbr/cached` | In-memory only — no upstream call | Returns 204 if nothing cached |
| `/flights/status` | Config/quota health check | No upstream call |
| `/api/sync` | PostgreSQL sync_state table | GET/POST, requires X-Sync-Key header |
| `/api/push/*` | Push subscription management | Requires X-Sync-Key header |

### Error envelope

All routes use `lib/errors.js`:
```js
{ error: string, code: ErrorCodes, detail?: any }
```
Status codes: 400 BAD_INPUT, 401 AUTH_FAILED, 404 NOT_FOUND, 502 UPSTREAM_FAILED, 502 UPSTREAM_HTML, 503 NOT_CONFIGURED, 500 INTERNAL.

## Frontend Architecture

### Module dependency graph

```
app.js (orchestrator, ~2,861 lines)
  ├── constants.js    (pure data)
  ├── utils.js        (pure DOM/math)
  ├── state.js        (S global, player-context)
  ├── api.js          (all backend fetches)
  ├── player.js       (stat primitives)
  ├── predict.js      (model + Monte Carlo)
  ├── pitcher.js      (pitcher metrics + arsenal)
  ├── betting.js      (odds math)
  ├── bets.js         (bet log + grading subsystem)
  ├── sync.js         (cross-device sync: pushRecord/pullRecord)
  ├── push.js         (web push subscription — imports _getSyncKey from sync.js)
  ├── weather.js      (fetchWeather + _windDir + _COMPASS_DEGS)
  ├── ui/modal.js     (modal lifecycle)
  ├── ui/render.js    (statBox, Statcast grid, pitch matchup)
  └── ui/record.js    (bet record + grade panel + calibration + CorBET bets)

charter.js (classic script, no imports — reads window.S)
```

### Key conventions

- **All backend calls go through `api.js`** — no direct `fetch()` calls to proxy routes scattered in app.js.
- **No external APIs from the frontend** — everything routes through server.js proxies.
- **Global state lives in `S`** (state.js). Mutate via direct property writes. Player swaps use `enterPlayerContext`/`exitPlayerContext` for atomicity.
- **`charter.js` is a classic script** (not an ES module) and reads `window.S` directly. It must remain a classic script or be refactored carefully.
- **Event delegation** — all interactive elements use `data-action="..."` + optional `data-*` payloads. A single `_dispatchAction` dispatcher at the bottom of app.js routes events to the `ACTIONS` map. **New buttons must register in `ACTIONS`, not use `onclick`**.
- **Savant endpoints return CSV text** — parse with `parseCSV()` from utils.js on the frontend.
- **Cache-bust**: bump `?v=N` on `<script>` and `<link>` tags in index.html with every PR that changes a frontend file.
- **`public/js/package.json`** sets `"type": "module"` so `node --test` can import ES modules. The root package.json stays `commonjs` for server code.
- **`SEASON` constant** in constants.js pins all MLB Stats API + Savant year params. Bump once per year rollover.

### Test suite

```
npm test   # runs public/js/*.test.js via node --test
```
Tests cover math modules only (player.js, predict.js, betting.js, utils.js, pitcher.js). UI and data-flow are not covered — use browser smoke-tests for those.

## Scheduled Jobs (cron.js)

Runs on startup via `require('./cron').start()`. No-ops if the required env vars aren't set.

| Job | Schedule | Trigger condition |
|---|---|---|
| `checkLineup` | Every 5 min | D-backs lineup posted for today's game |
| `checkFirstPitch` | Every 5 min | First pitch is 25–35 min away |
| `checkCharterPoll` | Every 30 min | Scouts for charter ETD from T+1h; active polls from scheduled departure (ETD) to ETD+6h |

Notification dedup uses `notification_log (game_pk, type)` PRIMARY KEY — INSERT … ON CONFLICT DO NOTHING. Falls back to in-memory Set when `DATABASE_URL` isn't configured.

Manual job trigger (dev/testing): `POST /api/push/run-cron?job=lineup|t30` with `X-Sync-Key` header.

## Pitch Arsenal Data

`data/pitch_arsenal.json` — built by `scripts/refresh_pitch_arsenal.py` (requires `pybaseball`). Keyed by MLBAM player ID + pitch type. Contains per-pitcher pitch usage/whiff/K%/wOBA and per-batter per-pitch-type vulnerability.

On server startup, `maybeRefreshArsenal()` checks if the file is missing or >24h old and spawns a background refresh. The macOS launchd cron (`scripts/install-cron.sh`) runs the refresh at 4 AM daily as the primary mechanism.

Frontend loads it once via `/pitch-arsenal` and caches on `S.pitchArsenal` (`pitcher.js:_loadPitchArsenal`).

## Charter Tracker

`data/team_charters.json` — registry of MLB charter aircraft by team (tail numbers + flight callsigns). Sources: airliners.net, FlyerTalk, spotter sightings. **Verify callsigns each season** — Delta's DL88xx block and United's UA37xx block shift annually.

Flight lookups go through `/flights/team/:abbr` → AeroDataBox via RapidAPI. The cron poller (`checkCharterPoll`) pre-warms the in-memory cache in two phases: (1) a scout phase from T-48h before the series opener's first pitch, which fetches the scheduled departure time (ETD) from AeroDataBox and populates the dashboard with "SCHEDULED" state before wheels-up; (2) an active polling phase every 30 min starting at the ETD (falls back to T-6h from opener first pitch if AeroDataBox has no schedule yet), running until the charter lands or ETD+6h. Uses `fetchNextSeriesGame` (2-day lookahead) instead of `fetchTodayGame` so it works on off days and when today's game is already Final.

## app.js Consolidation — Remaining Work

Current state: ~1,945 lines (down from 6,156 original, −68.4%). Math, state, constants, betting, pitcher metrics + orchestration (selectPitcher, onPitcherSearch, loadPitcherStatcast), player stats, modal lifecycle, stat-grid rendering, the dashboard pitcher card / prediction-summary / factor cards / pitcher-tab renderer, the bet-log + grading subsystem, the bet-record / grade-panel / calibration / CorBET-bets renderers, the live weather fetch + park-relative wind helpers, and the dashboard (schedule strip / team momentum / game banner / player rows) have all been extracted. What remains is the prediction orchestrators (`calcPrediction` + `runPrediction` + `loadCorbet` and the per-player CSV / MLB helpers it depends on), the auto game loader, and bootstrap.

### Planned extractions (ordered by value/risk)

1. ~~**`ui/render.js` — expand with remaining pitcher render code**~~ ✅ Done
   - Moved: `_renderPitcherCard`, `_renderPitcherForm`, `_renderPitcherSplits`, `_renderBestMatchup` (+ `_buildMatchupSummary` helper), `renderFactorCards`, `buildPredictionSummary`
   - `loadPitcherForm` / `loadPitcherSplits` data loaders moved to `pitcher.js` (alongside `_loadPitchArsenal`)
   - `activeRoster()` accessor moved to `state.js` (used in render + many app.js call sites)

2. ~~**`bets.js` — bet-log + grading subsystem**~~ ✅ Done (~775 lines)
   - Moved: `saveBet`, `addManualBet`, `deleteBet`, `clearRecord`, `setResult`, `toggleAddBetForm`, `abfSetDir`, `abfSetResult`, `_getTopBets`, `autoSaveAtFirstPitch`, `autoRegisterGradePredictions`
   - Grading: `savePredictionForGrading`, `dedupePending`, `fetchActualStats`, `gradePerformance`, `autoGrade`, `autoGradeBetLog`, `confirmGrade` (private), `editGradeEntry`, `deleteGradeEntry`, `clearGrades`, `removePending`
   - Storage helpers: `getGradeLog/getFactorPerf/getFactorWeights/getPending` + matching savers
   - Communication: bets.js dispatches `bets:changed` (S.betLog mutated) and `grades:changed` (gradeLog/pending/perf/weights mutated). app.js subscribes during bootstrap. No upward imports.

3. ~~**`ui/record.js` — bet record + grade panel render**~~ ✅ Done (~720 lines)
   - Moved: `renderRecord` (+ `_propKeyForBet`, `_renderPLSparkline`, `setRecordSort`, `_sortBetLog`, `_RECORD_PROP_ORDER/_SHORT` helpers), `renderGradePanel`, `renderCalibration` (+ `_calBetWinProb`, `_calBucketize`, `_calProfit` helpers), `renderCorbetBets` (+ `togglePhantom` + `probToAmerican` helper), `drawPerfChart`
   - Imports `getPending/getGradeLog/getFactorPerf/getFactorWeights` + `gradePerformance` from bets.js; `modelProbability` from predict.js; `devig`/`bookAbbrev` from betting.js. The 'bets:changed'/'grades:changed' listeners in app.js now call into ui/record.js.

4. ~~**`push.js` + `sync.js` (frontend modules)**~~ ✅ Done (sync.js ~90 lines, push.js ~110 lines)
   - `sync.js`: `pushRecord`, `pullRecord`, `_getSyncKey/_setSyncKey`, `_getSyncKeyPrompted`, `_isMobileDevice`, `_initSyncBtnLabel`
   - `push.js`: `_pushSubscribe`, `_pushTest`, `registerSW`, `_urlBase64ToUint8Array`, `_isStandalonePWA`, `_initPushBtn`. Imports `_getSyncKey/_setSyncKey` from sync.js to share passphrase state.
   - `pullRecord` dispatches `bets:changed` + `grades:changed` CustomEvents instead of calling renders directly — no upward imports.

5. ~~**`weather.js`**~~ ✅ Done (~69 lines)
   - Moved: `_COMPASS_DEGS`, `_compassDeg`, `_windDir`, `fetchWeather`
   - `updateWeatherForTime` stays in app.js (1-liner that coordinates `fetchWeather` + `setDay`; `setDay` is a DOM-toggle helper that lives alongside the other game-time toggles)
   - `_windFieldRelative` in app.js imports `_COMPASS_DEGS` from weather.js

6. ~~**`pitcher.js` expansion — pitcher orchestration**~~ ✅ Done (~267 lines)
   - Moved to `pitcher.js`: `setThrows`, `buildPitchMixGrid`, `onPitcherSearch`, `selectPitcher`, `loadPitcherStatcast`
   - Moved to `ui/render.js`: `renderPitcherTab`, `_renderPitcherSeasonBoxes`
   - `selectPitcher` dispatches a `pitcher:selected` CustomEvent (detail `{id, name, fullReload}`) — app.js listens and re-fires `loadMatchupStats()` + either `loadDashboard()` (full reload) or `_renderPitcherCard()`. No upward imports.
   - `loadPitcherForm` / `loadPitcherSplits` already lived in pitcher.js from item #1.

7. ~~**`ui/dashboard.js`**~~ ✅ Done (~622 lines)
   - Moved: `renderDashboard` (+ `_lineupAnalysisText`, `_matchupCardHtml`, `_splitsCardHtml`, `_recentFormHtml`, `togglePlayerCard`), `_renderGameBanner` (+ `_windFieldRelative`), `loadTwoWeekSchedule` (+ `_renderScheduleCell`, `_shortVenue`), `loadTeamMomentum`, and the legacy `_renderMvpBanner` block (kept for potential re-enable)
   - Imports `_renderPitcherCard`/`_renderBestMatchup` from `ui/render.js`, `_getTopBets` from `bets.js`, `bookAbbrev` from `betting.js`, `_COMPASS_DEGS` from `weather.js`, and `S`/`activeRoster` from `state.js`. No upward imports.
   - Charter strip is rendered by `charter.js` (classic script) — `loadDashboard` still calls `window.renderDashboardCharter()` directly.

### What stays in app.js permanently

- Bootstrap (the init calls at the bottom)
- `ACTIONS` event-delegation map + `_dispatchAction`
- `runPrediction` + `calcPrediction` (top-level orchestrators touching every module)
- `loadDashboard` (orchestrator: charter strip → arsenal warm → corbet or render)
- `loadCorbet` + `_corbetFetch*` / `_corbetExtractStatcast` helpers (per-player CSV/MLB plumbing for predictions)
- `autoLoadNextGame` (one-time boot path that wires every subsystem)
- Tiny cross-cutting helpers

### Target

After extraction #7: ~1,945 lines — orchestration + bootstrap + corbet/prediction plumbing.

### Risk-mitigation rules

- 94 unit tests cover **math only** — every extraction needs **browser smoke-testing** of the affected feature
- Modules that need to call back into app.js must use the **CustomEvent pattern** (like `modal:closed`) — no circular imports
- Bump `?v=N` cache-bust in index.html on every PR that touches a frontend file
- All new buttons register in `ACTIONS` — no `onclick` attributes

### Adjacent work (not consolidation)

- `pitcher.js` tests (FIP/xFIP/SIERA/normalizePitchMix)
- `api.js` URL construction tests (mocked fetch)
- Audit #13: modal DOM-move race condition — needs browser scenario to reproduce

## Git Workflow

- Develop on a feature branch (`claude/...`)
- **After every push, ALWAYS create a PR and squash-merge to `main` via the GitHub MCP tools — no exceptions, even for small fixes**
- If the merge fails with a conflict, run `git fetch origin main && git rebase origin/main`, force-push with `--force-with-lease`, then retry the merge
- Use `git rebase origin/main` proactively if the branch has fallen behind before merging

## Custom Agents (.claude/agents/)

- **corbin** — baseball stat analysis, prop-bet probability estimates. Pulls from the running local server (`npm start` must be running). Calls MLB Stats API, Savant, and pitch arsenal endpoints.
- **carol** — prop-bet EV expert. Consumes Corbin's `CORBIN_REPORT` JSON, finds highest-EV bets, line-shops across sportsbooks.
