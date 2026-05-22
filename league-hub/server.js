const express = require('express');
const https   = require('https');
const path    = require('path');
const app     = express();

app.use(express.static(path.join(__dirname, 'public')));

// Keyless pass-through proxy to the MLB StatsAPI. Keeps API calls off the
// frontend (dodges CORS) and matches the proxy pattern in the parent project.
app.use('/mlb', (req, res) => {
  const url = 'https://statsapi.mlb.com' + req.originalUrl.replace(/^\/mlb/, '');
  https.get(url, (apiRes) => {
    res.setHeader('Content-Type', 'application/json');
    apiRes.pipe(res);
  }).on('error', (e) => res.status(502).json({ error: e.message }));
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`MLB League Hub running on http://localhost:${PORT}`));
