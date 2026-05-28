// Model self-calibration — learns corrections from graded bets.
//
// Two channels, both fit from S.betLog entries that carry a settled result
// (win/loss) plus the model fields captured at save time:
//
//   1. Platt scaling (per prop + a pooled global fallback) maps the model's
//      raw Over probability onto observed Over-hit frequency:
//          p_cal = σ( a · logit(p_raw) + b )
//      a/b are fit by regularized logistic regression, the L2 prior pulling
//      (a,b) toward identity (1,0) so low-sample props barely move. This is
//      the #2/#4 work — measure calibration error and feed it back into the
//      live probability.
//
//   2. Blend weight (per prop) re-tunes the score↔rate mix inside
//      modelProbability (#1). modelProbability records the score-only and
//      rate-only components on each bet; once enough graded+instrumented bets
//      exist we grid-search the weight W in p = W·score + (1−W)·rate that best
//      predicts outcomes, then shrink W toward DEFAULT_BLEND_W by sample size.
//
// HOT PATH: modelProbability calls applyCalibration / getBlendWeight thousands
// of times per Monte Carlo run, so those read only the in-memory caches below.
// localStorage is touched only by loadCalibration() (bootstrap) and
// recalibrate() (after a result changes). In the node test env (no
// localStorage) the caches stay empty → applyCalibration is identity and
// getBlendWeight returns the default, so existing math tests are unaffected.

import {
  CALIBRATION_KEY, BLEND_WEIGHTS_KEY, DEFAULT_BLEND_W,
  MIN_CAL_SAMPLE, MIN_GLOBAL_CAL_SAMPLE, MIN_BLEND_SAMPLE,
  CAL_PRIOR_LAMBDA, BLEND_PRIOR_N,
} from './constants.js';

// ── In-memory caches (the only thing the hot path reads) ─────────────────────
let _calCache   = {};  // { propKey:{a,b,n}, _global:{a,b,n} }
let _blendCache = {};  // { propKey: w }

// ── Math helpers ──────────────────────────────────────────────────────────────
const _clamp01 = p => Math.max(1e-4, Math.min(1 - 1e-4, p));
const _logit   = p => Math.log(p / (1 - p));
const _sigmoid = z => 1 / (1 + Math.exp(-z));

// ── Apply (hot path) ──────────────────────────────────────────────────────────
// Correct a model Over probability (0–100). Prop-specific params win; otherwise
// the pooled global fit; otherwise identity. Returns the input unchanged when no
// params are loaded (fresh install, node tests, sub-threshold sample).
export function applyCalibration(propKey, pPct) {
  if (pPct == null) return pPct;
  const params = _calCache[propKey] || _calCache._global;
  if (!params) return pPct;
  const z = params.a * _logit(_clamp01(pPct / 100)) + params.b;
  return _sigmoid(z) * 100;
}

// Score-component weight for the score↔rate blend in modelProbability.
export function getBlendWeight(propKey) {
  const w = _blendCache[propKey];
  return typeof w === 'number' ? w : DEFAULT_BLEND_W;
}

// ── Status accessors (for the calibration panel UI) ──────────────────────────
export function getCalibrationParams(propKey) { return _calCache[propKey] || null; }
export function getGlobalCalibration()         { return _calCache._global || null; }
export function isBlendTuned(propKey)          { return typeof _blendCache[propKey] === 'number'; }

// ── Regularized logistic fit (Platt) ─────────────────────────────────────────
// Newton–Raphson on (a,b) with an L2 prior toward identity (1,0). The prior is a
// fixed precision (CAL_PRIOR_LAMBDA) so its pull fades as the data sum grows with
// sample size — strong shrinkage at small n, negligible once well-sampled.
export function fitPlatt(xs, ys, lambda = CAL_PRIOR_LAMBDA) {
  let a = 1, b = 0;
  for (let iter = 0; iter < 30; iter++) {
    let ga = 2 * lambda * (a - 1), gb = 2 * lambda * b;
    let Haa = 2 * lambda, Hab = 0, Hbb = 2 * lambda;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i];
      const s = _sigmoid(a * x + b);
      const w = s * (1 - s);
      const d = s - ys[i];
      ga += d * x;  gb += d;
      Haa += w * x * x;  Hab += w * x;  Hbb += w;
    }
    const det = Haa * Hbb - Hab * Hab;
    if (!isFinite(det) || Math.abs(det) < 1e-9) break;
    const da = (Hbb * ga - Hab * gb) / det;
    const db = (Haa * gb - Hab * ga) / det;
    a -= da;  b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-7) break;
  }
  return { a, b };
}

// Grid-search the blend weight W that minimizes log-loss of
//   W·score + (1−W)·rate + adjOffset
// then shrink toward DEFAULT_BLEND_W by sample size. score/rate/adjOffset are in
// pp (0–100 scale). adjOffset is the sum of the additive corrections
// modelProbability layers on top of the blend (park, TTO, pitch-mix, Statcast,
// trend); holding it fixed while searching W makes the fit target match the
// production probability instead of the bare blend. Pass a zero-filled array for
// legacy bets that predate offset instrumentation.
export function fitBlend(scoreBases, rateBases, adjOffsets, ys) {
  let best = DEFAULT_BLEND_W, bestLoss = Infinity;
  for (let wi = 0; wi <= 20; wi++) {
    const w = wi / 20;
    let loss = 0;
    for (let i = 0; i < ys.length; i++) {
      const adj = adjOffsets[i] || 0;
      const p = _clamp01((w * scoreBases[i] + (1 - w) * rateBases[i] + adj) / 100);
      loss -= ys[i] ? Math.log(p) : Math.log(1 - p);
    }
    if (loss < bestLoss) { bestLoss = loss; best = w; }
  }
  const n = ys.length;
  const shrunk = (n * best + BLEND_PRIOR_N * DEFAULT_BLEND_W) / (n + BLEND_PRIOR_N);
  return Math.round(shrunk * 100) / 100;
}

// ── Build the (Over probability, Over-happened) training set ─────────────────
// A bet stores modelProb as the OVER probability regardless of which side was
// recommended, so every settled bet maps to one (overProb, overHappened) pair:
//   Over + win  → over happened     Over + loss → over didn't
//   Under + win → over didn't       Under + loss → over happened
// Prefer the raw (pre-calibration) probability so refits never stack a
// correction on an already-corrected value; fall back to modelProb for legacy
// bets saved before instrumentation.
function _overPair(b) {
  const praw = b.modelProbRaw ?? b.modelProb;
  if (praw == null || !b.direction) return null;
  const isOver = String(b.direction).toLowerCase() === 'over';
  const won = b.result === 'win';
  return { p: praw, y: (isOver === won) ? 1 : 0 };
}

// ── Recompute everything from the bet log, persist, reload caches ────────────
export function recalibrate(betLog) {
  const settled = (betLog || []).filter(b => b.result === 'win' || b.result === 'loss');

  // Group by prop, plus a global pool.
  const byProp = {};                 // propKey → { xs, ys, sb, rb, n }
  const g = { xs: [], ys: [] };
  for (const b of settled) {
    const pair = _overPair(b);
    if (!pair) continue;
    const x = _logit(_clamp01(pair.p / 100));
    g.xs.push(x); g.ys.push(pair.y);
    const key = b.propKey;
    if (!key) continue;
    // sb/rb/sy stay index-aligned with each other (the blend training set); xs/ys
    // include every settled bet for the Platt fit. The two sets differ because
    // only instrumented bets carry component snapshots.
    const bucket = byProp[key] || (byProp[key] = { xs: [], ys: [], sb: [], rb: [], adj: [], sy: [], n: 0 });
    bucket.xs.push(x); bucket.ys.push(pair.y); bucket.n++;
    if (typeof b.scoreBase === 'number' && typeof b.rateBase === 'number') {
      bucket.sb.push(b.scoreBase); bucket.rb.push(b.rateBase);
      // Legacy bets (pre-offset instrumentation) carry no adjOffset → treat as 0.
      bucket.adj.push(typeof b.adjOffset === 'number' ? b.adjOffset : 0);
      bucket.sy.push(pair.y);
    }
  }

  const cal = {};
  const blends = {};
  for (const [key, d] of Object.entries(byProp)) {
    if (d.n >= MIN_CAL_SAMPLE) cal[key] = { ...fitPlatt(d.xs, d.ys), n: d.n };
    // Blend re-tune needs the component snapshots, which only modern bets carry.
    if (d.sb.length >= MIN_BLEND_SAMPLE) blends[key] = fitBlend(d.sb, d.rb, d.adj, d.sy);
  }
  if (g.ys.length >= MIN_GLOBAL_CAL_SAMPLE) cal._global = { ...fitPlatt(g.xs, g.ys), n: g.ys.length };

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
    localStorage.setItem(BLEND_WEIGHTS_KEY, JSON.stringify(blends));
  }
  _calCache = cal;
  _blendCache = blends;
}

// Load persisted params into the in-memory caches. Cheap; called at bootstrap.
export function loadCalibration() {
  if (typeof localStorage === 'undefined') return;
  try { _calCache = JSON.parse(localStorage.getItem(CALIBRATION_KEY) || '{}') || {}; }
  catch { _calCache = {}; }
  try { _blendCache = JSON.parse(localStorage.getItem(BLEND_WEIGHTS_KEY) || '{}') || {}; }
  catch { _blendCache = {}; }
}
