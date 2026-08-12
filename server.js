require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
const app     = express();

// A deployment dedicated to one sub-app can point the bare domain at it, so a
// link that loses its path — or someone typing the host from memory — lands on
// the right thing instead of the D-backs dashboard. Set ROOT_REDIRECT=/vote/
// on the vote's host. Unset locally, so `npm start` still opens Snake Savant.
//
// Must sit above express.static, which would otherwise serve public/index.html
// for '/' first. 302 rather than 301: browsers cache a permanent redirect hard
// enough that undoing it means telling everyone to clear their cache.
const ROOT_REDIRECT = process.env.ROOT_REDIRECT;
if (ROOT_REDIRECT) {
  app.get('/', (req, res) => res.redirect(302, ROOT_REDIRECT));
  console.log(`[server] '/' redirects to ${ROOT_REDIRECT}`);
}

app.use(express.static(path.join(__dirname, 'public')));

app.use('/mlb',        require('./routes/mlb'));
app.use('/odds',       require('./routes/odds'));
app.use('/weather',    require('./routes/weather'));
app.use('/savant',     require('./routes/savant'));
app.use('/fangraphs',  require('./routes/fangraphs'));
app.use('/kalshi',     require('./routes/kalshi'));
app.use('/pitch-arsenal', require('./routes/arsenal'));
app.use('/flights',    require('./routes/flights'));
app.use('/api/sync',   require('./routes/sync'));
app.use('/api/push',   require('./routes/push'));
// Static above already serves public/vote/*.html; this handles /vote/api/*.
app.use('/vote',       require('./routes/vote'));

// Auto-refresh pitch arsenal on startup if data is missing or older than 24h.
// The daily launchd cron is the primary refresh mechanism; this is a safety net
// for cases where the cron hasn't been installed (new machine) or hasn't fired
// since the file went stale (laptop closed at 4 AM).
function maybeRefreshArsenal() {
  const dataPath = path.join(__dirname, 'data', 'pitch_arsenal.json');
  const STALE_MS = 24 * 60 * 60 * 1000;
  let needsRefresh = false;
  try {
    const stat = fs.statSync(dataPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > STALE_MS) {
      console.log(`[arsenal] data is ${(ageMs / 3600000).toFixed(1)}h old — refreshing in background`);
      needsRefresh = true;
    }
  } catch (e) {
    console.log('[arsenal] data missing — refreshing in background');
    needsRefresh = true;
  }
  if (!needsRefresh) return;
  const script = path.join(__dirname, 'scripts', 'refresh_pitch_arsenal.py');
  const child = spawn('python3', [script], { detached: true, stdio: 'ignore' });
  child.on('error', err => console.warn('[arsenal] refresh spawn failed:', err.message));
  child.unref();
}
maybeRefreshArsenal();

// Schedule lineup + T-30 push notifications (no-op if VAPID keys / DATABASE_URL
// aren't set, so dev environments without push configured stay quiet).
require('./cron').start();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D-backs Predictor running on port ${PORT}`));
