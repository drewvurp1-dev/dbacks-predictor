// Prediction primitives. Math-heavy helpers used by the Monte Carlo confidence
// loop and downstream model scoring.
//
// Note: monteCarloConfidence + modelProbability stay in app.js for now because
// modelProbability has many player-helper dependencies (_gamePAs, _handSplit,
// _shrunkRate). Those will move together in PR4d when player.js is extracted.

import { S } from './state.js';

// ── Gaussian sampler (Box–Muller) ───────────────────────────────────────────
export function gaussianRandom(mean, std) {
  const u1 = Math.random() || 1e-10, u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Slump dampener ──────────────────────────────────────────────────────────
// Widens MC sigma when recent results diverge from the model's positive
// prediction, so cold-streak bets fail the MC confidence threshold instead of
// being recommended at face value. Returns 0–5 sigma points based on active
// hitless streak + L10 batting average. Does NOT change the point prediction
// — only the uncertainty band around it.
export function _slumpPenalty() {
  const log = S.recentGameLog;
  if (!log || log.length < 3) return 0;
  let droughtGames = 0;
  for (const g of log) {
    const ab = parseInt(g.stat?.atBats) || 0;
    const h  = parseInt(g.stat?.hits)   || 0;
    if (ab === 0) continue;            // skip DNP/pinch appearances
    if (h === 0) droughtGames++;
    else break;
  }
  let p = 0;
  if      (droughtGames >= 5) p += 4;
  else if (droughtGames === 4) p += 2.5;
  else if (droughtGames === 3) p += 1.5;
  else if (droughtGames === 2) p += 0.5;
  const recent = log.slice(0, 10);
  const rH  = recent.reduce((s, g) => s + (parseInt(g.stat?.hits)    || 0), 0);
  const rAB = recent.reduce((s, g) => s + (parseInt(g.stat?.atBats) || 0), 0);
  if (rAB >= 15) {
    const avg = rH / rAB;
    if      (avg < 0.150) p += 3;
    else if (avg < 0.200) p += 1.5;
    else if (avg < 0.250) p += 0.5;
  }
  return Math.min(5, p);
}

// ── Monte Carlo sigma ───────────────────────────────────────────────────────
// Score-variance estimate, derived from the hitter's profile. High-whiff
// hitters have wider outcome distributions (more boom/bust), so the model
// score is a less reliable point estimate — σ scales up. Small samples (<50
// PA) also widen σ since the season-rate inputs are noisy. The slump dampener
// widens σ further when recent form contradicts the season profile.
// Maps: whiff 18% → σ≈5.0 (contact hitter), 28% → σ≈6.5 (league avg),
//       38% → σ≈8.0 (three-true-outcomes). Clamped to [4.5, 15].
export function _mcVariance() {
  const sc = S.statcast   || {};
  const ss = S.seasonStat || {};
  // S.statcast stores whiff as `whiff` (already parsed). `whiff_percent` is the
  // raw Savant CSV column name and is never present here — reading that key
  // returned undefined for every hitter, collapsing sigma to the default.
  const whiff = sc.whiff;
  let sigma = (typeof whiff === 'number' && isFinite(whiff)) ? 5 + (whiff - 18) * 0.15 : 6;
  const pa = parseInt(ss.plateAppearances) || 0;
  if (pa > 0 && pa < 50) sigma += 1.5;
  sigma += _slumpPenalty();
  return Math.max(4.5, Math.min(15, sigma));
}
