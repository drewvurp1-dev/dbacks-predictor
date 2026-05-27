// Pitcher-domain helpers: advanced metric derivation (FIP, xFIP, SIERA, K-BB%,
// HR/9) and the pitch-arsenal cache loader.
//
// More complex pitcher orchestration (selectPitcher, onPitcherSearch,
// _renderPitcherCard, _renderPitchMatchup, loadPitcherStatcast) stays in
// app.js for now — it's heavily UI-coupled and will move with the UI
// extraction in PR4f.

import { S } from './state.js';
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
