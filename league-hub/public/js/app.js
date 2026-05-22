'use strict';

/* ============================================================
 * MLB League Hub — frontend logic
 * All data comes through the local /mlb proxy (MLB StatsAPI).
 * ============================================================ */

const SEASON = new Date().getFullYear();
const WINDOW_DAYS = 14;          // rolling window for player stats
const MIN_HIT_PA  = 20;          // qualify threshold, hitters (window)
const MIN_PIT_IP  = 6;           // qualify threshold, pitchers (window)
const MOVER_MIN_WINDOW_PA = 25;
const MOVER_MIN_SEASON_PA = 60;

/* ---------- small helpers ---------- */
const $ = (id) => document.getElementById(id);
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
const fmt3 = (n) => n.toFixed(3).replace(/^0\./, '.');
const fmt2 = (n) => n.toFixed(2);

function ymd(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}
function shortDate(s) {
  const [y, m, d] = s.split('-');
  return `${+m}/${+d}`;
}
function api(path) {
  return fetch('/mlb' + path).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}
// MLB innings-pitched strings ("8.1" = 8 ⅓) -> decimal innings.
function ipToInnings(ipStr) {
  if (ipStr == null) return 0;
  const [whole, frac] = String(ipStr).split('.');
  return (parseInt(whole, 10) || 0) + (parseInt(frac, 10) || 0) / 3;
}

/* ---------- shared state ---------- */
const teamsById = {};            // id -> { name, teamName, abbr }
const standingsById = {};        // id -> standings record
let windowHitById = {};          // id -> window hitting split
let seasonHitById = {};          // id -> season hitting split
let playerData = { hitters: { hot: [], cold: [] }, pitchers: { hot: [], cold: [] } };

/* ============================================================
 * Boot
 * ============================================================ */
(async function init() {
  const today = new Date();
  $('asof').textContent = today.toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  await loadTeams();
  await loadStandings();
  renderHotColdTeams();

  loadTodayResults().catch((e) => fail('winners-body', e));
  loadPlayers().catch((e) => fail('hot-players', e));
  loadNews().catch((e) => fail('news-body', e));

  $('player-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    document.querySelectorAll('#player-toggle .toggle-btn')
      .forEach((b) => b.classList.toggle('active', b === btn));
    renderPlayers(btn.dataset.view);
  });

  // Event delegation for all clickable rows / cards.
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-team]');
    if (t) { openTeam(+t.dataset.team); return; }
    const p = e.target.closest('[data-player]');
    if (p) { openPlayer(+p.dataset.player, p.dataset.group); return; }
  });
})();

function fail(id, err) {
  const el = $(id);
  if (el) el.innerHTML = `<div class="empty">Couldn't load data — ${err.message}</div>`;
  console.error(err);
}

/* ============================================================
 * Teams + standings
 * ============================================================ */
async function loadTeams() {
  const data = await api(`/api/v1/teams?sportId=1&season=${SEASON}`);
  (data.teams || []).forEach((t) => {
    teamsById[t.id] = { name: t.name, teamName: t.teamName, abbr: t.abbreviation };
  });
}

async function loadStandings() {
  const data = await api(
    `/api/v1/standings?leagueId=103,104&season=${SEASON}&standingsTypes=regularSeason`);
  (data.records || []).forEach((div) => {
    (div.teamRecords || []).forEach((tr) => {
      const l10 = (tr.records?.splitRecords || []).find((s) => s.type === 'lastTen')
        || { wins: 0, losses: 0 };
      standingsById[tr.team.id] = {
        id: tr.team.id,
        wins: tr.wins,
        losses: tr.losses,
        pct: tr.winningPercentage,
        rd: tr.runDifferential,
        rs: tr.runsScored,
        ra: tr.runsAllowed,
        streak: tr.streak?.streakCode || '',
        l10w: l10.wins,
        l10l: l10.losses,
        l10pct: (l10.wins + l10.losses) ? l10.wins / (l10.wins + l10.losses) : 0,
        divRank: tr.divisionRank,
      };
    });
  });
}

function abbr(id) { return teamsById[id]?.abbr || '—'; }
function teamName(id) { return teamsById[id]?.name || ('Team ' + id); }

function renderHotColdTeams() {
  const all = Object.values(standingsById).sort((a, b) =>
    (b.l10pct - a.l10pct) || (b.rd - a.rd));
  const teamRow = (t, rank, kind) => `
    <div class="row-item" data-team="${t.id}">
      <span class="rk">${rank}</span>
      <span class="badge">${abbr(t.id)}</span>
      <div class="ri-main">
        <div class="ri-name">${teamName(t.id)}</div>
        <div class="ri-sub">${t.streak || '—'} &middot; ${t.rd >= 0 ? '+' : ''}${t.rd} run diff &middot; ${t.wins}-${t.losses}</div>
      </div>
      <span class="ri-stat ${kind}">${t.l10w}-${t.l10l}</span>
    </div>`;
  $('hot-teams').innerHTML = all.slice(0, 5)
    .map((t, i) => teamRow(t, i + 1, 'hot')).join('');
  $('cold-teams').innerHTML = all.slice(-5).reverse()
    .map((t, i) => teamRow(t, i + 1, 'cold')).join('');
}

/* ============================================================
 * Today's winners / losers
 * ============================================================ */
async function loadTodayResults() {
  let date = new Date();
  let finals = [];
  // Walk back up to 4 days until we find completed games.
  for (let i = 0; i < 5 && finals.length === 0; i++) {
    const data = await api(`/api/v1/schedule?sportId=1&date=${ymd(date)}`);
    const games = (data.dates?.[0]?.games) || [];
    finals = games.filter((g) => g.status?.abstractGameState === 'Final');
    if (finals.length === 0) date.setDate(date.getDate() - 1);
  }
  $('results-date').textContent = finals.length ? shortDate(ymd(date)) : '';

  if (finals.length === 0) {
    $('winners-body').innerHTML = '<div class="empty">No completed games found.</div>';
    $('losers-body').innerHTML = '<div class="empty">No completed games found.</div>';
    return;
  }

  const winners = [], losers = [];
  finals.forEach((g) => {
    const h = g.teams.home, a = g.teams.away;
    const homeWon = h.score > a.score;
    const W = homeWon ? h : a, L = homeWon ? a : h;
    winners.push(resultCard(W, L, true, !homeWon));   // winner home? = homeWon
    losers.push(resultCard(L, W, false, homeWon));    // loser home? = homeWon? -> opposite
  });
  $('winners-body').innerHTML = winners.join('');
  $('losers-body').innerHTML = losers.join('');
}

function resultCard(self, opp, isWin, selfIsHome) {
  const id = self.team.id;
  const cls = isWin ? 'win' : 'loss';
  const vs = selfIsHome ? 'vs' : '@';
  const score = `${self.score}-${opp.score}`;
  return `
    <div class="result-card ${cls}" data-team="${id}">
      <div class="rc-top">
        <span class="badge">${abbr(id)}</span>
        <span class="rc-team">${teamName(id)}</span>
        <span class="rc-score">${score}</span>
      </div>
      <div class="rc-opp">${vs} ${teamName(opp.team.id)}</div>
      <ul class="rc-notes">${gameNotes(id, opp, isWin, selfIsHome)
        .map((n) => `<li>${n}</li>`).join('')}</ul>
    </div>`;
}

// Contextual blurbs built from score margin + season-long standings context.
function gameNotes(id, opp, isWin, selfIsHome) {
  const notes = [];
  const s = standingsById[id];
  const st = s?.streak || '';
  const stType = st[0];
  const stNum = parseInt(st.slice(1), 10) || 0;

  if (isWin) {
    if (stType === 'W' && stNum >= 3) notes.push(`Riding a ${stNum}-game win streak`);
    if (opp.score === 0) notes.push(`Shut out the ${teamName(opp.team.id)}`);
  } else {
    if (stType === 'L' && stNum >= 3) notes.push(`Skidding — ${stNum} straight losses`);
    if (opp.score >= 8) notes.push(`Blown out — allowed ${opp.score} runs`);
  }
  if (s) {
    notes.push(`${s.l10w}-${s.l10l} over their last 10`);
    if (isWin && s.l10l >= 6) notes.push(`A bright spot in a cold stretch`);
    if (!isWin && s.l10w >= 7) notes.push(`Rare stumble for a hot club`);
    if (s.divRank === '1') notes.push(`Currently 1st in the division`);
  }
  return notes.slice(0, 3);
}

/* ============================================================
 * Players: hot / cold + biggest movers
 * ============================================================ */
async function loadPlayers() {
  const today = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (WINDOW_DAYS - 1));
  const ds = ymd(start), de = ymd(today);

  const range = (group) =>
    `/api/v1/stats?stats=byDateRange&group=${group}&gameType=R` +
    `&startDate=${ds}&endDate=${de}&sportId=1&limit=800`;
  const season = (group) =>
    `/api/v1/stats?stats=season&group=${group}&gameType=R` +
    `&season=${SEASON}&sportId=1&limit=1000`;

  const [wHit, wPit, sHit] = await Promise.all([
    api(range('hitting')), api(range('pitching')), api(season('hitting')),
  ]);

  const wHitS = splits(wHit), wPitS = splits(wPit), sHitS = splits(sHit);

  // Hitters: rank qualified players by OPS over the window.
  const hitters = wHitS.filter((p) => num(p.stat.plateAppearances) >= MIN_HIT_PA)
    .sort((a, b) => num(b.stat.ops) - num(a.stat.ops));
  playerData.hitters.hot = hitters.slice(0, 10);
  playerData.hitters.cold = hitters.slice(-10).reverse();

  // Pitchers: rank qualified arms by ERA (low = hot).
  const pitchers = wPitS.filter((p) => ipToInnings(p.stat.inningsPitched) >= MIN_PIT_IP)
    .sort((a, b) => num(a.stat.era) - num(b.stat.era));
  playerData.pitchers.hot = pitchers.slice(0, 10);
  playerData.pitchers.cold = pitchers.slice(-10).reverse();

  windowHitById = byId(wHitS);
  seasonHitById = byId(sHitS);
  renderPlayers('hitters');
  renderMovers();
}

function splits(resp) { return (resp.stats?.[0]?.splits) || []; }
function byId(arr) {
  const m = {};
  arr.forEach((p) => { if (p.player) m[p.player.id] = p; });
  return m;
}

function renderPlayers(view) {
  const isHit = view === 'hitters';
  const grp = isHit ? 'hitting' : 'pitching';
  const set = playerData[view];

  const row = (p, rank, kind) => {
    const st = p.stat;
    const big = isHit ? num(st.ops).toFixed(3).replace(/^0\./, '.') : fmt2(num(st.era));
    const sub = isHit
      ? `${st.avg} AVG &middot; ${st.hits}-${st.atBats} &middot; ${st.homeRuns} HR &middot; ${st.rbi} RBI`
      : `${st.inningsPitched} IP &middot; ${st.strikeOuts} K &middot; ${st.whip} WHIP`;
    return `
      <div class="row-item" data-player="${p.player.id}" data-group="${grp}">
        <span class="rk">${rank}</span>
        <span class="badge">${abbr(p.team?.id)}</span>
        <div class="ri-main">
          <div class="ri-name">${p.player.fullName}</div>
          <div class="ri-sub">${sub}</div>
        </div>
        <span class="ri-stat ${kind}">${big}</span>
      </div>`;
  };
  $('hot-players').innerHTML = set.hot.length
    ? set.hot.map((p, i) => row(p, i + 1, 'hot')).join('')
    : '<div class="empty">No qualified players.</div>';
  $('cold-players').innerHTML = set.cold.length
    ? set.cold.map((p, i) => row(p, i + 1, 'cold')).join('')
    : '<div class="empty">No qualified players.</div>';
}

function renderMovers() {
  const movers = [];
  Object.values(windowHitById).forEach((w) => {
    const s = seasonHitById[w.player.id];
    if (!s) return;
    if (num(w.stat.plateAppearances) < MOVER_MIN_WINDOW_PA) return;
    if (num(s.stat.plateAppearances) < MOVER_MIN_SEASON_PA) return;
    movers.push({
      player: w.player,
      team: w.team,
      delta: num(w.stat.ops) - num(s.stat.ops),
      windowOps: num(w.stat.ops),
      seasonOps: num(s.stat.ops),
    });
  });
  movers.sort((a, b) => b.delta - a.delta);

  const row = (m, rank) => {
    const up = m.delta >= 0;
    return `
      <div class="row-item" data-player="${m.player.id}" data-group="hitting">
        <span class="rk">${rank}</span>
        <span class="badge">${abbr(m.team?.id)}</span>
        <div class="ri-main">
          <div class="ri-name">${m.player.fullName}</div>
          <div class="ri-sub">${fmt3(m.windowOps)} OPS L14 &middot; ${fmt3(m.seasonOps)} season</div>
        </div>
        <span class="ri-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(m.delta).toFixed(3).replace(/^0\./, '.')}</span>
      </div>`;
  };
  $('risers').innerHTML = movers.slice(0, 8).map((m, i) => row(m, i + 1)).join('')
    || '<div class="empty">Not enough data.</div>';
  $('fallers').innerHTML = movers.slice(-8).reverse().map((m, i) => row(m, i + 1)).join('')
    || '<div class="empty">Not enough data.</div>';
}

/* ============================================================
 * News / transactions
 * ============================================================ */
async function loadNews() {
  const today = new Date();
  const start = new Date();
  start.setDate(start.getDate() - WINDOW_DAYS);
  const data = await api(
    `/api/v1/transactions?sportId=1&startDate=${ymd(start)}&endDate=${ymd(today)}`);
  const tx = (data.transactions || [])
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 45);
  if (!tx.length) {
    $('news-body').innerHTML = '<div class="empty">No recent transactions.</div>';
    return;
  }
  $('news-body').innerHTML = tx.map((t) => `
    <div class="news-item">
      <span class="news-date">${shortDate(t.date)}</span>
      <span class="news-text"><span class="news-type">${t.typeDesc || 'Move'}</span>${t.description || ''}</span>
    </div>`).join('');
}

/* ============================================================
 * Modals
 * ============================================================ */
function closeModal() { $('modal').classList.remove('open'); }
function showModal(html) {
  $('modal-content').innerHTML = html;
  $('modal').classList.add('open');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function statBox(value, label) {
  return `<div class="stat-box"><div class="sv">${value}</div><div class="sl">${label}</div></div>`;
}

/* ---- Team deep-dive: last 10 games aggregated from game logs ---- */
async function openTeam(id) {
  const s = standingsById[id];
  showModal(`<h3>${teamName(id)}</h3>
    <div class="modal-sub">Loading last 10 games…</div>`);
  try {
    const [hit, pit, risp] = await Promise.all([
      api(`/api/v1/teams/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}&gameType=R`),
      api(`/api/v1/teams/${id}/stats?stats=gameLog&group=pitching&season=${SEASON}&gameType=R`),
      api(`/api/v1/teams/${id}/stats?stats=statSplits&sitCodes=risp&group=hitting&season=${SEASON}`),
    ]);
    const h = aggHitting(splits(hit).slice(-10));
    const p = aggPitching(splits(pit).slice(-10));
    const rispStat = splits(risp)[0]?.stat;

    showModal(`
      <h3>${teamName(id)}</h3>
      <div class="modal-sub">${s ? `${s.wins}-${s.losses} &middot; ${s.l10w}-${s.l10l} L10 &middot; ${s.streak}` : ''}</div>
      <div class="section-label">Batting — last 10 games</div>
      <div class="stat-grid">
        ${statBox(fmt3(h.avg), 'AVG')}
        ${statBox(fmt3(h.obp), 'OBP')}
        ${statBox(fmt3(h.slg), 'SLG')}
        ${statBox(fmt3(h.ops), 'OPS')}
        ${statBox(h.runs, 'Runs')}
        ${statBox(h.homeRuns, 'HR')}
        ${statBox((h.runs / Math.max(h.games, 1)).toFixed(1), 'R/G')}
        ${statBox(rispStat ? rispStat.avg : '—', 'AVG w/RISP*')}
      </div>
      <div class="section-label">Pitching — last 10 games</div>
      <div class="stat-grid">
        ${statBox(fmt2(p.era), 'ERA')}
        ${statBox(fmt2(p.whip), 'WHIP')}
        ${statBox(fmt2(p.k9), 'K/9')}
        ${statBox(p.strikeOuts, 'K')}
        ${statBox(p.earnedRuns, 'ER')}
        ${statBox(p.ip.toFixed(1), 'IP')}
      </div>
      <div class="modal-sub" style="margin:4px 0 0">* AVG w/RISP reflects the full season (no per-game split available).</div>
    `);
  } catch (e) {
    showModal(`<h3>${teamName(id)}</h3><div class="empty">Couldn't load team stats — ${e.message}</div>`);
  }
}

function aggHitting(games) {
  const t = { ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0, runs: 0, homeRuns: 0, games: games.length };
  games.forEach((g) => {
    const s = g.stat;
    t.ab += num(s.atBats); t.h += num(s.hits); t.bb += num(s.baseOnBalls);
    t.hbp += num(s.hitByPitch); t.sf += num(s.sacFlies); t.tb += num(s.totalBases);
    t.runs += num(s.runs); t.homeRuns += num(s.homeRuns);
  });
  const obDen = t.ab + t.bb + t.hbp + t.sf;
  t.avg = t.ab ? t.h / t.ab : 0;
  t.obp = obDen ? (t.h + t.bb + t.hbp) / obDen : 0;
  t.slg = t.ab ? t.tb / t.ab : 0;
  t.ops = t.obp + t.slg;
  return t;
}
function aggPitching(games) {
  const t = { ip: 0, earnedRuns: 0, hits: 0, bb: 0, strikeOuts: 0 };
  games.forEach((g) => {
    const s = g.stat;
    t.ip += ipToInnings(s.inningsPitched);
    t.earnedRuns += num(s.earnedRuns); t.hits += num(s.hits);
    t.bb += num(s.baseOnBalls); t.strikeOuts += num(s.strikeOuts);
  });
  t.era = t.ip ? (9 * t.earnedRuns) / t.ip : 0;
  t.whip = t.ip ? (t.bb + t.hits) / t.ip : 0;
  t.k9 = t.ip ? (9 * t.strikeOuts) / t.ip : 0;
  return t;
}

/* ---- Player deep-dive: window vs season + recent game log ---- */
async function openPlayer(id, group) {
  const isHit = group === 'hitting';
  showModal(`<h3>Loading…</h3><div class="modal-sub">Fetching player stats…</div>`);
  try {
    const log = await api(
      `/api/v1/people/${id}/stats?stats=gameLog&group=${group}&season=${SEASON}`);
    const person = await api(`/api/v1/people/${id}`);
    const name = person.people?.[0]?.fullName || ('Player ' + id);
    const games = splits(log).slice(-10).reverse();

    const win = isHit ? windowHitById[id]?.stat : null;
    const seas = isHit ? seasonHitById[id]?.stat : null;

    let html = `<h3>${name}</h3><div class="modal-sub">${isHit ? 'Hitter' : 'Pitcher'} &middot; last 10 games</div>`;

    if (isHit && win) {
      html += `<div class="section-label">Last 14 days</div><div class="stat-grid">
        ${statBox(win.avg, 'AVG')}${statBox(win.obp, 'OBP')}
        ${statBox(win.slg, 'SLG')}${statBox(win.ops, 'OPS')}
        ${statBox(win.homeRuns, 'HR')}${statBox(win.rbi, 'RBI')}
        ${statBox(win.hits + '-' + win.atBats, 'H-AB')}${statBox(win.strikeOuts, 'K')}
      </div>`;
      if (seas) {
        html += `<div class="section-label">Season</div><div class="stat-grid">
          ${statBox(seas.avg, 'AVG')}${statBox(seas.obp, 'OBP')}
          ${statBox(seas.slg, 'SLG')}${statBox(seas.ops, 'OPS')}
          ${statBox(seas.homeRuns, 'HR')}${statBox(seas.rbi, 'RBI')}
        </div>`;
      }
    }

    html += `<div class="section-label">Game log</div>` + gameLogTable(games, isHit);
    showModal(html);
  } catch (e) {
    showModal(`<h3>Player</h3><div class="empty">Couldn't load player stats — ${e.message}</div>`);
  }
}

function gameLogTable(games, isHit) {
  if (!games.length) return '<div class="empty">No recent games.</div>';
  if (isHit) {
    return `<table class="log"><thead><tr>
      <th>Date</th><th>Opp</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th>
      </tr></thead><tbody>${games.map((g) => {
        const s = g.stat;
        return `<tr><td>${shortDate(g.date)}</td>
          <td>${g.isHome ? 'vs' : '@'} ${g.opponent?.name?.split(' ').pop() || ''}</td>
          <td>${s.atBats}</td><td>${s.hits}</td><td>${s.homeRuns}</td>
          <td>${s.rbi}</td><td>${s.baseOnBalls}</td><td>${s.strikeOuts}</td></tr>`;
      }).join('')}</tbody></table>`;
  }
  return `<table class="log"><thead><tr>
    <th>Date</th><th>Opp</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th>
    </tr></thead><tbody>${games.map((g) => {
      const s = g.stat;
      return `<tr><td>${shortDate(g.date)}</td>
        <td>${g.isHome ? 'vs' : '@'} ${g.opponent?.name?.split(' ').pop() || ''}</td>
        <td>${s.inningsPitched}</td><td>${s.hits}</td><td>${s.earnedRuns}</td>
        <td>${s.baseOnBalls}</td><td>${s.strikeOuts}</td><td>${s.era}</td></tr>`;
    }).join('')}</tbody></table>`;
}
