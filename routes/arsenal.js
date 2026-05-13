const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const DATA_PATH = path.join(__dirname, '..', 'data', 'pitch_arsenal.json');

let cached = null;
let cachedMtime = 0;

function load() {
  try {
    const stat = fs.statSync(DATA_PATH);
    if (cached && stat.mtimeMs === cachedMtime) return cached;
    cached = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    cachedMtime = stat.mtimeMs;
    return cached;
  } catch (err) {
    return null;
  }
}

router.get('/', (req, res) => {
  const data = load();
  if (!data) {
    return res.status(503).json({
      error: 'pitch arsenal data unavailable',
      hint: 'run `npm run refresh-arsenal` to generate data/pitch_arsenal.json',
    });
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.json(data);
});

module.exports = router;
