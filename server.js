require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
const app     = express();

app.use(express.static(path.join(__dirname, 'public')));

app.use('/mlb',        require('./routes/mlb'));
app.use('/odds',       require('./routes/odds'));
app.use('/weather',    require('./routes/weather'));
app.use('/savant',     require('./routes/savant'));
app.use('/fangraphs',  require('./routes/fangraphs'));
app.use('/pitch-arsenal', require('./routes/arsenal'));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D-backs Predictor running on port ${PORT}`));
