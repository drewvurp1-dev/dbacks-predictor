# D-backs Predictor

## Project Structure
- `server.js` — Express backend, acts as a proxy for all external APIs
- `public/index.html` — entire frontend (HTML/CSS/JS)
- `package.json` — dependencies

## Stack
- Node.js + Express 5
- Vanilla HTML/JS frontend (no framework)
- No build step — what's in /public is served directly

## Dev Server
npm start
# Runs on port 3000 by default

## Environment Variables
- `ODDS_API_KEY` — required for betting odds data (the-odds-api.com)

## API Proxies (all in server.js)
- `/mlb/*` → statsapi.mlb.com (game schedules, scores, rosters)
- `/odds/*` → the-odds-api.com (betting odds)
- `/weather/*` → wttr.in (game-day weather)
- `/savant/statcast` → Baseball Savant Statcast leaderboard (CSV)
- `/savant/expected` → Baseball Savant xStats leaderboard (CSV)
- `/savant/battracking` → Baseball Savant bat tracking leaderboard (CSV)

## Notes
- All prediction logic and UI lives in public/index.html
- Do not call external APIs directly from the frontend — always route through the proxies in server.js
- Savant endpoints return CSV; handle parsing on the frontend

## Git Workflow
- Develop on a feature branch (`claude/...`)
- After pushing changes, always create a PR and squash-merge it to `main` via the GitHub MCP tools
- Use `git rebase origin/main` if the branch has fallen behind before merging
