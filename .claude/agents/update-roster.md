---
name: update-roster
description: Fetch the current Arizona Diamondbacks active roster from the MLB API and rewrite the player <select> dropdown in public/index.html. Run whenever players are added, traded, or the roster changes.
tools: Bash, Read, Edit, WebFetch
---

You are updating the Arizona Diamondbacks player select dropdown in `public/index.html`.

## Your task

### Step 1 — Fetch the active roster

Try the local proxy first:
```
curl -s "http://localhost:3000/mlb/api/v1/teams/109/roster?rosterType=active&season=2026"
```
If that returns a connection error, use WebFetch directly against:
`https://statsapi.mlb.com/api/v1/teams/109/roster?rosterType=active&season=2026`

The response has a `roster` array. Each entry has:
- `person.id` — the MLB player ID
- `person.fullName`
- `position.abbreviation` — POS (e.g. CF, SS, 2B, C, LF, RF, 3B, 1B, DH)

### Step 2 — Filter to position players and rank by AB

Exclude any player whose `position.abbreviation` is one of: `SP`, `RP`, `P`.

For each remaining position player, fetch their 2026 season hitting stats:
```
curl -s "http://localhost:3000/mlb/api/v1/people/PLAYER_ID/stats?stats=season&season=2026&group=hitting"
```
or WebFetch `https://statsapi.mlb.com/api/v1/people/PLAYER_ID/stats?stats=season&season=2026&group=hitting`

Read `stats[0].splits[0].stat.atBats` (will be 0 or missing for players with no appearances yet).

Sort all position players by AB descending. **Keep only the top 8.**

### Step 3 — Fetch batting hand for the top 8

For each of the 8 players, fetch:
```
curl -s "http://localhost:3000/mlb/api/v1/people/PLAYER_ID"
```
or WebFetch `https://statsapi.mlb.com/api/v1/people/PLAYER_ID`

Read `people[0].batSide.code` → L, R, or S (switch hitter).

### Step 4 — Update the file

Read `public/index.html` and find the `<select id="player-select">` block. Replace every `<option>` inside it with fresh options in this exact format:

```html
<option value="PLAYER_ID">Full Name · POS · Bats H</option>
```

Where `H` is L, R, or S.

**Ordering**: catchers first, then infielders (1B, 2B, 3B, SS), then outfielders (LF, CF, RF), then DH, then any remainder. Alphabetical within each group.

Only touch the `<option>` elements inside `<select id="player-select">` — nothing else in the file.

### Step 5 — Verify

Run:
```
node --check public/js/app.js
```
to confirm the file is intact. Report the final player count and list the options you wrote.
