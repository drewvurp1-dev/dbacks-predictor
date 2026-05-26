// Pitcher-domain helpers: advanced metric derivation (FIP, xFIP, SIERA, K-BB%,
// HR/9) and the pitch-arsenal cache loader.
//
// More complex pitcher orchestration (selectPitcher, onPitcherSearch,
// _renderPitcherCard, _renderPitchMatchup, loadPitcherStatcast) stays in
// app.js for now — it's heavily UI-coupled and will move with the UI
// extraction in PR4f.

import { S } from './state.js';

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
