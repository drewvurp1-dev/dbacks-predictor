// Pitcher-domain helpers: advanced metric derivation (FIP, xFIP, SIERA, K-BB%,
// HR/9), the pitch-arsenal cache loader, and pitcher orchestration
// (selectPitcher, onPitcherSearch, loadPitcherStatcast) including the
// pitcher-tied DOM toggles (setThrows, buildPitchMixGrid).
//
// Selecting a pitcher dispatches a `pitcher:selected` CustomEvent so app.js
// can re-run the dashboard / matchup loaders without pitcher.js importing
// upward.

import { S, log } from './state.js';
import { show, hide, setText, parseCSV } from './utils.js';
import { PITCH_TYPES, STAT_INFO } from './constants.js';
import { renderPitcherTab, _renderPitcherSeasonBoxes, statBox } from './ui/render.js';
import * as api from './api.js';

// ── Pitcher rate-stat constants ─────────────────────────────────────────────
const _FIP_CONSTANT = 3.10; // Approximates league-avg (ERA - raw FIP) — stable around 3.0–3.2
const _LG_HRFB = 0.105;     // League-average HR per fly ball, used for xFIP normalization

// ── Advanced pitcher metrics ────────────────────────────────────────────────
// Derives FIP, xFIP, SIERA, K-BB%, HR/9 from MLB Stats API season stats
// (`st`) + Baseball Savant Statcast (`statcast`). Returns nulls when data
// is insufficient (e.g., <1 IP, missing batted-ball mix).
export function _computePitcherMetrics(st, statcast) {
  const ip  = parseFloat(st?.inningsPitched) || 0;
  const hr  = parseInt(st?.homeRuns)     || 0;
  const bb  = parseInt(st?.baseOnBalls)  || 0;
  const hbp = parseInt(st?.hitByPitch)   || 0;
  const k   = parseInt(st?.strikeOuts)   || 0;
  const tbf = parseInt(st?.battersFaced) || 0;
  if (ip < 1 || tbf < 1) return { fip: null, xfip: null, siera: null, kbbPct: null, hr9: null };
  const fip = (13 * hr + 3 * (bb + hbp) - 2 * k) / ip + _FIP_CONSTANT;
  const hr9 = (hr / ip) * 9;
  const kbbPct = ((k - bb) / tbf) * 100;
  let xfip = null;
  const fbPct = statcast?.fbPct;
  const gbPct = statcast?.gbPct;
  if (fbPct != null && fbPct > 0) {
    const bip = Math.max(0, tbf - k - bb - hbp);
    const fbCount = bip * (fbPct / 100);
    const expHR = fbCount * _LG_HRFB;
    xfip = (13 * expHR + 3 * (bb + hbp) - 2 * k) / ip + _FIP_CONSTANT;
  }
  // SIERA — FanGraphs formula. Captures K/BB plus batted-ball mix (GB - FB - PU).
  // Pop-ups aren't in our Statcast cut, so we approximate (GB - FB - PU)/PA with
  // (GB - FB)/PA, knowing this slightly understates the GB-pitcher advantage.
  // Returns null when batted-ball mix isn't loaded.
  let siera = null;
  if (fbPct != null && gbPct != null && ip >= 10) {
    const bip = Math.max(0, tbf - k - bb - hbp);
    const gbCount = bip * (gbPct / 100);
    const fbCount = bip * (fbPct / 100);
    const kPA = k / tbf;
    const bbPA = (bb + hbp) / tbf;
    const battedDiff = (gbCount - fbCount) / tbf;
    const ind = battedDiff >= 0 ? 1 : -1;
    siera = 6.145
          - 16.986 * kPA
          + 11.434 * bbPA
          - 1.858 * battedDiff
          + 7.653 * kPA * kPA
          + ind * 6.664 * battedDiff * battedDiff
          + 10.130 * kPA * battedDiff
          - 5.195 * bbPA * battedDiff;
  }
  return { fip, xfip, siera, kbbPct, hr9 };
}

// ── Venue-adjusted pitcher line ─────────────────────────────────────────────
// The model scores the opposing pitcher off his SEASON aggregate, which is blind
// to the home/road platoon. A pitcher who is dominant in a pitcher-friendly home
// park but ordinary on the road reads as merely league-average, so the bats' own
// season rates dominate the log-5 combine and the slate fills with phantom Overs.
//
// This blends the pitcher's home (or road — whichever venue he is actually in)
// split into the season line via sample-size shrinkage: each venue RATE is mixed
// toward the season rate with weight w = venueBF / (venueBF + VENUE_PRIOR_BF),
// then re-applied to the SEASON denominators (AB / BF / IP unchanged). Keeping the
// denominators at the season sample means every downstream Bayesian shrinkage
// prior (BAA priorN=200, per-event 200-300, run-env 200) still sees the true
// sample size — the venue blend only shifts the rate, it doesn't fabricate
// confidence. A tiny early-season split (e.g. 19 BF) barely nudges (w≈0.16); a
// stabilized split (250+ BF) carries real weight (w≈0.71).
const VENUE_PRIOR_BF = 100;

export function _blendVenueLine(st, venue) {
  if (!st || !venue) return st;
  const vBF = parseInt(venue.battersFaced) || 0;
  const sAB = parseInt(st.atBats)        || 0;
  const sBF = parseInt(st.battersFaced)  || 0;
  const sIP = parseFloat(st.inningsPitched) || 0;
  if (vBF < 1 || !sAB || !sBF || !sIP) return st;
  const w = vBF / (vBF + VENUE_PRIOR_BF);
  const vAB = parseInt(venue.atBats) || 0;
  const num  = k => parseInt(st[k])    || 0;
  const vnum = k => parseInt(venue[k]) || 0;
  // Blend a season rate toward the venue rate, then re-apply to the season
  // denominator. Rounded to match the parseInt() the downstream consumers apply.
  const mix = (sKey, vKey, sDen, vDen, den) => {
    const sr = sDen ? num(sKey)  / sDen : 0;
    const vr = vDen ? vnum(vKey) / vDen : sr;
    return Math.round(((1 - w) * sr + w * vr) * den);
  };
  const eraS = parseFloat(st.era),  eraV = parseFloat(venue.era);
  const whipS = parseFloat(st.whip), whipV = parseFloat(venue.whip);
  const blend = (a, b) => (isFinite(a) && isFinite(b)) ? (1 - w) * a + w * b
    : (isFinite(a) ? a : b);
  const H = mix('hits', 'hits', sAB, vAB, sAB);
  return {
    ...st,
    hits:        H,
    homeRuns:    mix('homeRuns',    'homeRuns',    sAB, vAB, sAB),
    doubles:     mix('doubles',     'doubles',     sAB, vAB, sAB),
    triples:     mix('triples',     'triples',     sAB, vAB, sAB),
    baseOnBalls: mix('baseOnBalls', 'baseOnBalls', sBF, vBF, sBF),
    strikeOuts:  mix('strikeOuts',  'strikeOuts',  sBF, vBF, sBF),
    hitByPitch:  mix('hitByPitch',  'hitByPitch',  sBF, vBF, sBF),
    avg:  (sAB ? H / sAB : 0).toFixed(3).replace(/^0/, ''),
    era:  isFinite(eraS)  ? blend(eraS,  eraV ).toFixed(2) : st.era,
    whip: isFinite(whipS) ? blend(whipS, whipV).toFixed(2) : st.whip,
    // atBats / battersFaced / inningsPitched intentionally left at season values.
  };
}

// Recompute S.pitcher.stEff + advancedEff for the venue the pitcher is currently
// in (home when the D-backs hitters are away, i.e. !S.isHome). Idempotent — safe
// to call on every prediction so a home/away toggle re-applies the right split.
// Leaves stEff null when there is no usable split (model falls back to season).
export function applyPitcherVenue() {
  const p = S.pitcher;
  if (!p) return;
  if (!p.splits) { p.stEff = null; p.advancedEff = null; p.venueApplied = null; return; }
  const pitcherAtHome = !S.isHome;
  const venue = pitcherAtHome ? p.splits.h : p.splits.a;
  const eff = _blendVenueLine(p.st, venue);
  if (eff === p.st) { p.stEff = null; p.advancedEff = null; p.venueApplied = null; return; }
  p.stEff = eff;
  p.advancedEff = _computePitcherMetrics(eff, S.pitcherStatcast);
  p.venueApplied = pitcherAtHome ? 'home' : 'away';
}

// ── Pitch mix normalization ─────────────────────────────────────────────────
// Savant arsenal data has two sources of rounding loss: (1) each pitch_usage
// is already truncated to 1 decimal upstream, (2) Savant's min=3 filter drops
// pitch types with <3 thrown all year. Naively rounding each value to an
// integer also compounds when multiple codes fold into one bucket (e.g.
// SL+ST → Slider). Result: a mix like Mahle's renders as 98% instead of 100%.
//
// This helper accumulates raw fractional usages, scales to sum-to-100, then
// uses Hamilton's largest-remainder method so the integer percentages sum
// to exactly 100. Returns an all-zero map if every input is zero.
export function normalizePitchMix(rawMix) {
  const entries = Object.entries(rawMix);
  const total = entries.reduce((s, [, v]) => s + (v || 0), 0);
  if (total <= 0) return Object.fromEntries(entries.map(([k]) => [k, 0]));
  const scaled = entries.map(([k, v]) => {
    const exact = (v || 0) * (100 / total);
    const floor = Math.floor(exact);
    return { k, floor, remainder: exact - floor };
  });
  let leftover = 100 - scaled.reduce((s, x) => s + x.floor, 0);
  scaled.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < scaled.length && leftover > 0; i++) {
    scaled[i].floor += 1;
    leftover -= 1;
  }
  return Object.fromEntries(scaled.map(x => [x.k, x.floor]));
}

// ── Pitcher form (last 3 starts) ────────────────────────────────────────────
// Fetches the pitcher's recent game log, keeps the 3 most recent, and shapes
// each into a render-ready row with a quality class:
//   pf-good  — ER ≤ 2 AND IP ≥ 5
//   pf-bad   — ER ≥ 5 OR IP < 3
//   pf-mixed — anything else
// Returns null on fetch failure / null pitcherId.
export async function loadPitcherForm(pitcherId) {
  if (!pitcherId) return null;
  try {
    const d = await api.mlbPitcherGameLogHydrated(pitcherId);
    const splits = d?.stats?.[0]?.splits || [];
    const last3 = splits.slice(-3).reverse();
    return last3.map(s => {
      const stat = s.stat || {};
      const ip = parseFloat(stat.inningsPitched || 0);
      const er = parseInt(stat.earnedRuns || 0, 10);
      const k  = parseInt(stat.strikeOuts || 0, 10);
      const bb = parseInt(stat.baseOnBalls || 0, 10);
      let cls = 'pf-mixed';
      if (er <= 2 && ip >= 5) cls = 'pf-good';
      else if (er >= 5 || ip < 3) cls = 'pf-bad';
      const date = s.date ? new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : '';
      const oppAbbr = s.opponent?.abbreviation || s.opponent?.teamCode?.toUpperCase() || '';
      const isHome = s.isHome === true || s.isHome === 'true';
      const oppLabel = oppAbbr ? (isHome ? 'vs ' + oppAbbr : '@ ' + oppAbbr) : '';
      return { date, ip, er, k, bb, cls, opp: oppLabel };
    });
  } catch (e) {
    return null;
  }
}

// ── Pitcher splits (Home/Away + vs L/R) ─────────────────────────────────────
// Fetches the season splits and reshapes them into a keyed map:
//   { h: {era,avg,obp,slg,ops}, a: {...}, vl: {...}, vr: {...} }
// Returns null on fetch failure / null pitcherId.
export async function loadPitcherSplits(pitcherId) {
  if (!pitcherId) return null;
  try {
    const d = await api.mlbPitcherSplits(pitcherId);
    const splits = d?.stats?.[0]?.splits || [];
    const out = {};
    splits.forEach(s => {
      const code = s.split?.code;
      if (!code) return;
      out[code] = {
        era: s.stat?.era ? parseFloat(s.stat.era) : null,
        avg: s.stat?.avg || null,
        obp: s.stat?.obp || null,
        slg: s.stat?.slg || null,
        ops: s.stat?.ops ? parseFloat(s.stat.ops) : null,
      };
    });
    return out;
  } catch (e) {
    return null;
  }
}

// ── Pitcher DOM toggles ─────────────────────────────────────────────────────
// setThrows toggles the L/R hand pill in Setup and mirrors `S.pitcherThrows`.
// buildPitchMixGrid renders the slider grid for either the modal or manual tab.
export function setThrows(v) {
  S.pitcherThrows = v;
  document.getElementById('throws-R').classList.toggle('active', v === 'R');
  document.getElementById('throws-L').classList.toggle('active', v === 'L');
}

export function buildPitchMixGrid(cid, pitches) {
  document.getElementById(cid).innerHTML = PITCH_TYPES.map(pt =>
    `<div class="pitch-mix-item"><span class="pitch-mix-label">${pt}</span><input type="range" min="0" max="60" value="${pitches[pt] || 0}" data-action="pitch-mix-slider" data-pitch="${pt}" style="flex:1;accent-color:#A71930"><span style="font-size:11px;color:#ccc;font-family:'Chakra Petch',monospace;min-width:28px;text-align:right">${pitches[pt] || 0}%</span></div>`
  ).join('');
}

// ── Pitcher search (Setup panel) ────────────────────────────────────────────
// Debounced typeahead. Filters MLB Stats people search to pitchers only and
// renders a list of `select-pitcher` action buttons.
let _pitcherTimer = null;
export async function onPitcherSearch(val) {
  clearTimeout(_pitcherTimer);
  if (val.length < 2) { hide('pitcher-search-results'); return; }
  _pitcherTimer = setTimeout(async () => {
    try {
      const d = await api.mlbPersonSearch(val);
      const pitchers = (d.people || []).filter(p => p.primaryPosition?.type === 'Pitcher').slice(0, 8);
      if (!pitchers.length) { hide('pitcher-search-results'); return; }
      document.getElementById('pitcher-search-results').innerHTML = pitchers.map(p =>
        `<div class="search-result-item" data-action="select-pitcher" data-pitcher-id="${p.id}" data-pitcher-name="${p.fullName.replace(/"/g, '&quot;')}"><span>${p.fullName}</span><span class="sr-pos">${p.pitchHand?.code || '?'}HP</span></div>`
      ).join('');
      show('pitcher-search-results');
    } catch (e) {
      console.warn('Pitcher search failed:', e.message);
      hide('pitcher-search-results');
    }
  }, 300);
}

// ── Select pitcher ──────────────────────────────────────────────────────────
// Loads season stats + game log + handedness for the chosen pitcher, renders
// the Setup pitcher card, builds the pitch-mix grid, fires off Statcast +
// matchup loaders, and dispatches `pitcher:selected` so app.js can refresh
// the dashboard / matchup-section render.
//   detail.fullReload — true when the dashboard already loaded without
//                       pitcher data, so factors need to be re-scored.
//                       false → app.js just re-renders the pitcher card.
export async function selectPitcher(id, name) {
  hide('pitcher-search-results');
  document.getElementById('pitcher-search').value = name;
  hide('pitcher-loaded'); hide('pitcher-pitch-mix');
  show('pitcher-spinner'); hide('pitcher-error');
  try {
    const [sd, gd, pd, spd] = await Promise.all([
      api.mlbPitcherSeason(id),
      api.mlbPitcherGameLog(id),
      api.mlbPerson(id),
      api.mlbPitcherSplits(id).catch(() => null),
    ]);
    const st = sd?.stats?.[0]?.splits?.[0]?.stat ?? {};
    // Home/road splits — blended into the season line at score time by
    // applyPitcherVenue() so the model isn't venue-blind (see _blendVenueLine).
    const splitByCode = {};
    (spd?.stats?.[0]?.splits ?? []).forEach(s => { if (s.split?.code) splitByCode[s.split.code] = s.stat; });
    const splits = { h: splitByCode.h || null, a: splitByCode.a || null };
    const gameLogs = gd?.stats?.[0]?.splits ?? [];
    const last3 = gameLogs.slice(-3).reverse();
    const person = pd?.people?.[0] ?? {};
    const hand = person.pitchHand?.code ?? 'R';
    S.pitcherThrows = hand; setThrows(hand);
    let daysRest = '—';
    if (gameLogs.length) { const ld = new Date(gameLogs[gameLogs.length - 1].date); daysRest = Math.round((new Date() - ld) / (1000 * 60 * 60 * 24)); }
    const lastOuting = gameLogs.length ? gameLogs[gameLogs.length - 1].stat : null;
    // Bullpen / opener detection: flag if all of last 3 outings are under 45 pitches
    const bullpenGame = last3.length >= 3 && last3.every(g => (g.stat?.numberOfPitches || 0) < 45);
    const advanced = _computePitcherMetrics(st, null);
    S.pitcher = { id, name, hand, st, splits, last3, daysRest, lastOuting, bullpenGame, advanced };
    applyPitcherVenue();
    const era = parseFloat(st.era) || null;
    const whip = parseFloat(st.whip) || null;
    const ip = st.inningsPitched || '—';
    const pa = st.battersFaced || 1;
    const kPct = st.strikeOuts ? ((st.strikeOuts / pa) * 100).toFixed(1) + '%' : '—';
    const bbPct = st.baseOnBalls ? ((st.baseOnBalls / pa) * 100).toFixed(1) + '%' : '—';
    const k9 = st.strikeOuts && st.inningsPitched ? ((st.strikeOuts / parseFloat(st.inningsPitched)) * 9).toFixed(1) : '—';
    const fip = advanced.fip != null ? advanced.fip.toFixed(2) : '—';
    const kbb = advanced.kbbPct != null ? advanced.kbbPct.toFixed(1) + '%' : '—';
    const hr9 = advanced.hr9 != null ? advanced.hr9.toFixed(2) : '—';
    document.getElementById('pitcher-hand-badge').textContent = `${hand}HP · ${name}`;
    document.getElementById('pitcher-loaded').innerHTML = `<div class="pitcher-loaded"><div class="pl-hand">Throws ${hand === 'L' ? 'Left' : 'Right'}</div><div class="pl-name">${name}</div><div class="pl-stats"><span>ERA <strong>${era ? era.toFixed(2) : '—'}</strong></span><span>FIP <strong>${fip}</strong></span><span>WHIP <strong>${whip ? whip.toFixed(2) : '—'}</strong></span><span>K-BB% <strong>${kbb}</strong></span><span>HR/9 <strong>${hr9}</strong></span><span>K/9 <strong>${k9}</strong></span><span>Days Rest <strong>${daysRest}</strong></span>${lastOuting ? `<span>Last PC <strong>${lastOuting.numberOfPitches || '—'}</strong></span>` : ''}</div></div>`;
    show('pitcher-loaded');
    const mix = hand === 'L'
      ? { '4-Seam FB': 35, 'Sinker': 5, 'Cutter': 10, 'Slider': 20, 'Curveball': 10, 'Changeup': 15, 'Splitter': 5 }
      : { '4-Seam FB': 35, 'Sinker': 10, 'Cutter': 8, 'Slider': 22, 'Curveball': 10, 'Changeup': 12, 'Splitter': 3 };
    Object.assign(S.pitcherPitches, mix);
    buildPitchMixGrid('pitch-mix-grid', S.pitcherPitches);
    show('pitcher-pitch-mix');
    renderPitcherTab(st, last3, daysRest, lastOuting, hand, name, fip, k9, kPct, bbPct, era, whip, ip, kbb, hr9);
    loadPitcherStatcast(id);
    // Dispatch so app.js can re-run dashboard / matchup loaders without pitcher.js
    // importing upward. `fullReload` triggers a complete dashboard re-score; the
    // default just re-renders the dashboard pitcher card.
    const fullReload = !!S.players;
    if (fullReload) { S.allPlayerBets = null; S.players = null; }
    document.dispatchEvent(new CustomEvent('pitcher:selected', { detail: { id, name, fullReload } }));
  } catch (e) {
    setText('pitcher-error', '⚠ Could not load pitcher stats.');
    show('pitcher-error');
  } finally {
    hide('pitcher-spinner');
  }
}

// ── Pitcher Statcast grid ───────────────────────────────────────────────────
// Fills the Statcast row in the Pitcher Analysis modal and updates
// S.pitcherStatcast (used by the FB%/GB%-dependent xFIP and SIERA recomputes).
// Also overrides the generic hand-based pitch mix with the real Statcast usage
// once arsenal data is in.
export async function loadPitcherStatcast(pitcherId) {
  const el = document.getElementById('pt-statcast');
  if (!el) return;
  el.innerHTML = '<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Loading pitcher Statcast...</div>';
  const pid = String(pitcherId);

  const safeRows = (text, label) => {
    if (!text || text.trim().startsWith('<')) { console.warn(`[PitcherStatcast] ${label} returned HTML or empty`); return []; }
    const rows = parseCSV(text);
    log(`[PitcherStatcast] ${label}: ${rows.length} rows, cols:`, rows[0] ? Object.keys(rows[0]).join(', ') : 'none');
    return rows;
  };
  const findRow = (rows, label) => {
    const row = rows.find(r => String(r.player_id || '').trim() === pid);
    log(`[PitcherStatcast] ${label} match for pid ${pid}:`, row ? 'found' : 'not found');
    return row || null;
  };
  const col = (row, ...keys) => { if (!row) return null; for (const k of keys) { const v = row[k]; if (v != null && v !== '') return v; } return null; };
  const fmtPct = (v, digits = 1) => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(digits) + '%'; };
  const fmtVal = (v, digits = 2) => { const n = parseFloat(v); return isNaN(n) ? '—' : n.toFixed(digits); };

  try {
    const [scRes, expRes, cswRes, bbRes] = await Promise.allSettled([
      api.savantStatcast('pitcher'),
      api.savantExpected('pitcher'),
      api.savantCsw(),
      api.savantBattedBall('pitcher'),
    ]);

    const scRows  = safeRows(scRes.status === 'fulfilled'  ? scRes.value  : '', 'statcast');
    const expRows = safeRows(expRes.status === 'fulfilled' ? expRes.value : '', 'expected');
    const cswRows = safeRows(cswRes.status === 'fulfilled' ? cswRes.value : '', 'arsenal');
    const bbRows  = safeRows(bbRes.status === 'fulfilled'  ? bbRes.value  : '', 'batted-ball');

    const scRow  = findRow(scRows,  'statcast');
    const expRow = findRow(expRows, 'expected');
    // Batted-ball leaderboard keys by `id` rather than `player_id`. Rates are
    // returned as decimals (0.45 = 45%) — multiply by 100 for display/usage.
    const bbRow = bbRows.find(r => String(r.id || r.player_id || '').trim() === pid) || null;

    // Pitch-arsenal: one row per pitch type — weighted average across all pitches
    const arsenalRows = cswRows.filter(r => String(r.player_id || '').trim() === pid);
    log('[PitcherStatcast] arsenal rows for pid:', arsenalRows.length);
    const weightedAvg = (field) => {
      if (!arsenalRows.length) return null;
      let total = 0, weighted = 0;
      arsenalRows.forEach(r => {
        const usage = parseFloat(r.pitch_usage || 0) || 0;
        const val = parseFloat(r[field] || 0) || 0;
        weighted += val * usage; total += usage;
      });
      return total > 0 ? (weighted / total).toFixed(1) : null;
    };
    const whiffRaw   = weightedAvg('whiff_percent');
    const kPctRaw    = weightedAvg('k_percent');
    const putAwayRaw = weightedAvg('put_away');

    // Statcast pitcher: Barrel%, HH%, Avg EV.
    // GB% and FB% come from the batted-ball leaderboard (true rates) — the `gb`
    // and `fbld` columns on the statcast endpoint are avg EV mph on those
    // batted-ball types, not rates.
    const gbDecimal = bbRow ? parseFloat(bbRow.gb_rate) : NaN;
    const fbDecimal = bbRow ? parseFloat(bbRow.fb_rate) : NaN;
    const gbRaw     = isFinite(gbDecimal) ? gbDecimal * 100 : null;
    const fbRaw     = isFinite(fbDecimal) ? fbDecimal * 100 : null;
    const brlRaw    = col(scRow, 'brl_percent', 'brl_pa');
    const hhRaw     = col(scRow, 'ev95percent', 'hard_hit_percent');
    const evRaw     = col(scRow, 'avg_hit_speed', 'avg_exit_velocity');

    // Expected pitcher: xwOBA against, xERA
    const xwobaRaw  = col(expRow, 'est_woba', 'xwoba');
    const xeraRaw   = col(expRow, 'xera', 'xERA');

    const whiffPct     = fmtPct(whiffRaw);
    const kPct         = fmtPct(kPctRaw);
    const putAway      = fmtPct(putAwayRaw);
    const gbPct        = fmtPct(gbRaw);
    const fbPct        = fmtPct(fbRaw);
    const brlAgainst   = fmtPct(brlRaw);
    const hhAgainst    = fmtPct(hhRaw);
    const avgEVAgainst = evRaw ? fmtVal(evRaw, 1) + ' mph' : '—';
    const xwobaPct     = fmtVal(xwobaRaw, 3);

    // Color thresholds must match STAT_INFO entries below (otherwise the box
    // color contradicts what the tooltip says is good/avg/bad).
    const whiffC   = whiffPct   !== '—' ? (parseFloat(whiffPct)   >= 30   ? 'good' : parseFloat(whiffPct)   <= 20   ? 'bad' : '') : '';
    const kC       = kPct       !== '—' ? (parseFloat(kPct)       >= 25   ? 'good' : parseFloat(kPct)       <= 18   ? 'bad' : '') : '';
    const putAwayC = putAway    !== '—' ? (parseFloat(putAway)    >= 22   ? 'good' : parseFloat(putAway)    <= 15   ? 'bad' : '') : '';
    const gbC      = gbPct      !== '—' ? (parseFloat(gbPct)      >= 50   ? 'good' : parseFloat(gbPct)      <= 38   ? 'bad' : '') : '';
    const brlC     = brlAgainst !== '—' ? (parseFloat(brlAgainst) <= 4    ? 'good' : parseFloat(brlAgainst) >= 10   ? 'bad' : '') : '';
    const hhC      = hhAgainst  !== '—' ? (parseFloat(hhAgainst)  <= 35   ? 'good' : parseFloat(hhAgainst)  >= 45   ? 'bad' : '') : '';

    S.pitcherStatcast = {
      whiff:      parseFloat(whiffRaw) || null,
      kPct:       parseFloat(kPctRaw) || null,
      putAway:    parseFloat(putAwayRaw) || null,
      gbPct:      parseFloat(gbRaw) || null,
      fbPct:      parseFloat(fbRaw) || null,
      brlAgainst: parseFloat(brlRaw) || null,
      hhAgainst:  parseFloat(hhRaw) || null,
      xwoba:      parseFloat(xwobaRaw) || null,
      xera:       parseFloat(xeraRaw) || null,
    };

    // Recompute pitcher metrics now that FB% is available — gives us xFIP and SIERA
    if (S.pitcher?.st) {
      S.pitcher.advanced = _computePitcherMetrics(S.pitcher.st, S.pitcherStatcast);
      applyPitcherVenue(); // refresh stEff/advancedEff now that FB%/GB% (xFIP/SIERA) are available
      _renderPitcherSeasonBoxes();
    }

    // SIERA was recomputed above via _computePitcherMetrics once FB%/GB% landed,
    // so S.pitcher.advanced.siera is populated by the time we build these boxes.
    // Headline xERA already lives in the season-stats grid; SIERA fills this
    // slot as the secondary regression-based estimator.
    const sieraNum = S.pitcher?.advanced?.siera;
    const sieraVal = sieraNum != null ? sieraNum.toFixed(2) : '—';
    const sieraC = sieraNum != null ? (sieraNum <= 3.50 ? 'good' : sieraNum >= 4.50 ? 'bad' : '') : '';
    const boxes = [
      statBox('Whiff%',     whiffPct,     'Whiff rate per pitch',  whiffC,   STAT_INFO.WHIFF_P),
      statBox('Arsenal K%', kPct,         'Usage-weighted K% by pitch', kC,   STAT_INFO.KPCT_P),
      statBox('Put Away%',  putAway,      '2-strike put-away rate', putAwayC, STAT_INFO.PUTAWAY),
      statBox('GB%',        gbPct,        'Ground ball rate',      gbC,      STAT_INFO.GB_P),
      statBox('FB%',        fbPct,        'Fly ball rate',         '',       STAT_INFO.FB_P),
      statBox('Barrel% vs', brlAgainst,   'Barrels allowed',       brlC,     STAT_INFO.BARREL_VS),
      statBox('HH% vs',     hhAgainst,    'Hard contact allowed',  hhC,      STAT_INFO.HH_VS),
      statBox('Avg EV vs',  avgEVAgainst, 'Avg exit velo against', '',       STAT_INFO.EV_VS),
      statBox('xwOBA vs',   xwobaPct,     'Expected wOBA against', '',       STAT_INFO.XWOBA_VS),
      statBox('SIERA',      sieraVal,     'Skill-based ERA: K, BB, batted-ball mix', sieraC, STAT_INFO.SIERA),
    ].join('');

    if (!scRow && !expRow && arsenalRows.length === 0) {
      el.innerHTML = '<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">No Statcast data found for this pitcher.</div>';
    } else {
      el.innerHTML = boxes;
    }

    // Update S.pitcherPitches with real Statcast usage so the Pitcher Stats tab
    // and scoring both use actual pitch mix instead of the generic hand default.
    // Sweeper/slurve fold into Slider/Splitter since PITCH_TYPES doesn't split them.
    const CODE_TO_TYPE = { FF: '4-Seam FB', SI: 'Sinker', FC: 'Cutter', SL: 'Slider', ST: 'Slider', SV: 'Slider', CU: 'Curveball', KC: 'Curveball', CH: 'Changeup', FS: 'Splitter', FO: 'Splitter' };
    const arsenalPit = S.pitchArsenal?.pitchers?.[pid];
    // Accumulate raw fractional usages first; normalize+round once at the end so
    // the integer percentages sum to exactly 100 (largest-remainder method).
    const rawMix = Object.fromEntries(PITCH_TYPES.map(t => [t, 0]));
    if (arsenalRows.length) {
      // Live Savant (min=3 per pitch type) — most complete; prefer over local cache
      for (const r of arsenalRows) {
        const type = CODE_TO_TYPE[r.pitch_type];
        if (type) rawMix[type] += parseFloat(r.pitch_usage || 0);
      }
    } else if (arsenalPit) {
      // Fallback: local cache (min=50 per pitch type) — may miss low-volume pitches
      for (const [code, data] of Object.entries(arsenalPit.pitches)) {
        const type = CODE_TO_TYPE[code];
        if (type) rawMix[type] += (data.usage || 0);
      }
    }
    const newMix = normalizePitchMix(rawMix);
    if (Object.values(newMix).some(v => v > 0)) {
      Object.assign(S.pitcherPitches, newMix);
      buildPitchMixGrid('pitch-mix-grid', S.pitcherPitches);
      document.getElementById('pt-pitchmix').innerHTML = PITCH_TYPES.map(pt => {
        const p = S.pitcherPitches[pt] || 0;
        if (!p) return '';
        return `<div class="pitch-row"><span class="pitch-label">${pt}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${p}%;background:${p > 35 ? '#A71930' : '#3a3560'}"></div></div><span class="pitch-pct">${p}%</span></div>`;
      }).join('');
    }
  } catch (e) {
    console.error('[PitcherStatcast] Error:', e);
    el.innerHTML = `<div style="font-size:11px;color:#777;font-family:'Chakra Petch',monospace;grid-column:span 3;">Pitcher Statcast unavailable.</div>`;
  }
}

// ── Pitch arsenal cache ─────────────────────────────────────────────────────
// One-shot fetch of /pitch-arsenal; result cached on S.pitchArsenal.
// Returns the arsenal object, or null if unavailable.
export async function _loadPitchArsenal() {
  if (S.pitchArsenal !== undefined) return S.pitchArsenal; // null or object — cached
  try {
    const r = await fetch('/pitch-arsenal');
    if (!r.ok) { S.pitchArsenal = null; return null; }
    S.pitchArsenal = await r.json();
    return S.pitchArsenal;
  } catch (e) {
    S.pitchArsenal = null;
    return null;
  }
}
