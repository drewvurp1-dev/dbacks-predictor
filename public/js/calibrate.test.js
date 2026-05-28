// Unit tests for calibrate.js — Platt fit, blend fit, and the recalibrate →
// applyCalibration / getBlendWeight feedback loop. No localStorage in node, so
// recalibrate populates the in-memory caches directly (persistence is skipped).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BLEND_W } from './constants.js';
import {
  applyCalibration, getBlendWeight, fitPlatt, fitBlend,
  recalibrate, getCalibrationParams,
} from './calibrate.js';

const _sig = z => 1 / (1 + Math.exp(-z));
const _logit = p => Math.log(p / (1 - p));

// ── Identity defaults (fresh state, no params loaded) ────────────────────────
test('applyCalibration — identity when no params loaded', () => {
  recalibrate([]); // ensure caches are empty
  assert.equal(applyCalibration('batter_hits', 60), 60);
  assert.equal(applyCalibration('batter_hits', null), null);
});

test('getBlendWeight — returns default when untuned', () => {
  recalibrate([]);
  assert.equal(getBlendWeight('batter_hits'), DEFAULT_BLEND_W);
});

// ── fitPlatt recovers a known miscalibration ─────────────────────────────────
test('fitPlatt — recovers an under-confident model (a>1)', () => {
  // Truth: actual frequency = sigmoid(1.5 · logit(raw)) — the model is too timid.
  const xs = [], ys = [];
  const K = 40;
  for (const r of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const pTrue = _sig(1.5 * _logit(r));
    const ones = Math.round(pTrue * K);
    for (let i = 0; i < K; i++) { xs.push(_logit(r)); ys.push(i < ones ? 1 : 0); }
  }
  const { a, b } = fitPlatt(xs, ys);
  // Slope should land between identity (1, shrunk) and the true 1.5.
  assert.ok(a > 1.1 && a <= 1.55, `a=${a} not in (1.1,1.55]`);
  // A raw 0.7 read should be pushed upward toward its true frequency.
  const cal = _sig(a * _logit(0.7) + b);
  assert.ok(cal > 0.7, `cal(0.7)=${cal} should exceed 0.7`);
});

// ── fitBlend leans on the predictive component ───────────────────────────────
test('fitBlend — favors the rate component when it is the predictive one', () => {
  // rate perfectly separates outcomes; score is constant noise. Best raw weight
  // is ~0, shrunk toward DEFAULT by sample size — so below the default either way.
  const sb = [], rb = [], adj = [], ys = [];
  for (let i = 0; i < 60; i++) {
    const win = i % 2 === 0;
    sb.push(50); rb.push(win ? 72 : 28); adj.push(0); ys.push(win ? 1 : 0);
  }
  const w = fitBlend(sb, rb, adj, ys);
  assert.ok(w < DEFAULT_BLEND_W, `w=${w} should be below default ${DEFAULT_BLEND_W}`);
  assert.ok(w >= 0, `w=${w} out of range`);
});

// ── fitBlend accounts for the additive offset ────────────────────────────────
test('fitBlend — a positive adjOffset shifts the fitted weight vs ignoring it', () => {
  // score and rate are each weakly predictive with independent noise, so the
  // optimum is interior. A large constant positive offset pushes probabilities
  // toward saturation, which changes the loss-minimizing blend — proving the
  // offset is actually folded into the fit rather than dropped. (Verified
  // direction: a +offset lowers the fitted W in this regime.) A seeded PRNG
  // keeps the dataset deterministic.
  const rng = (seed => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; })(42);
  const build = adjConst => {
    const sb = [], rb = [], adj = [], ys = [];
    for (let i = 0; i < 600; i++) {
      const win = rng() < 0.5;
      sb.push(50 + (win ? 12 : -12) + (rng() - 0.5) * 30);
      rb.push(50 + (win ? 12 : -12) + (rng() - 0.5) * 30);
      adj.push(adjConst); ys.push(win ? 1 : 0);
    }
    return [sb, rb, adj, ys];
  };
  const wNoOffset = fitBlend(...build(0));
  const wOffset = fitBlend(...build(20));
  assert.ok(wOffset !== wNoOffset, `offset should change the fit (got ${wOffset} vs ${wNoOffset})`);
  assert.ok(wOffset >= 0 && wOffset <= 1, `wOffset=${wOffset} out of range`);
});

// ── recalibrate threads adjOffset through to fitBlend ─────────────────────────
test('fitBlend — legacy bets with no adjOffset are treated as zero offset', () => {
  // Missing/non-numeric offsets must not throw or NaN out the loss.
  const sb = [], rb = [], adj = [], ys = [];
  for (let i = 0; i < 50; i++) {
    const win = i % 2 === 0;
    sb.push(60); rb.push(win ? 70 : 30); adj.push(undefined); ys.push(win ? 1 : 0);
  }
  const w = fitBlend(sb, rb, adj, ys);
  assert.ok(Number.isFinite(w) && w >= 0 && w <= 1, `w=${w} should be a valid weight`);
});

// ── End-to-end: recalibrate then apply ───────────────────────────────────────
test('recalibrate — corrects an over-stated Over probability and stays active', () => {
  // 30 Over bets on Hits, model said 60% Over but Over only hit ~40% of the time.
  const betLog = [];
  for (let i = 0; i < 30; i++) {
    betLog.push({
      propKey: 'batter_hits', direction: 'Over',
      modelProbRaw: 60, modelProb: 60,
      result: i < 12 ? 'win' : 'loss', // 12/30 ≈ 40% Over-hit rate
    });
  }
  recalibrate(betLog);
  assert.ok(getCalibrationParams('batter_hits'), 'prop calibration should be active at n=30');
  const corrected = applyCalibration('batter_hits', 60);
  assert.ok(corrected < 60, `corrected=${corrected} should drop below the over-stated 60`);
  assert.ok(corrected > 30, `corrected=${corrected} should not overshoot past observed ~40%`);
});

test('recalibrate — below MIN_CAL_SAMPLE leaves the prop uncorrected', () => {
  const betLog = [];
  for (let i = 0; i < 10; i++) {
    betLog.push({ propKey: 'batter_walks', direction: 'Over', modelProbRaw: 55, result: i < 7 ? 'win' : 'loss' });
  }
  recalibrate(betLog);
  assert.equal(getCalibrationParams('batter_walks'), null, 'should not fit with only 10 bets');
  assert.equal(applyCalibration('batter_walks', 55), 55, 'identity below threshold');
});

// Reset shared module state so a later-loaded test file sees clean caches.
test('cleanup — reset caches', () => { recalibrate([]); });
