// Unit tests for predict.js — gaussian sampler, slump dampener, MC variance,
// pitch-matchup reason, and sanity bounds on modelProbability.

import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from './state.js';
import {
  gaussianRandom, _slumpPenalty, _mcVariance, _rateUncertaintyPp,
  _pitchMatchupReason, modelProbability, monteCarloConfidence,
} from './predict.js';

// ── gaussianRandom ──────────────────────────────────────────────────────────
test('gaussianRandom — sample mean approaches target over 5000 draws', () => {
  let sum = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) sum += gaussianRandom(50, 10);
  const mean = sum / N;
  // 99% of the time, sample mean of N=5000 with sigma=10 lands within ~0.4 of 50.
  // Using a looser ±1.0 to virtually eliminate flake risk.
  assert.ok(Math.abs(mean - 50) < 1.0, `mean=${mean} too far from 50`);
});

test('gaussianRandom — sample std approaches target over 5000 draws', () => {
  const N = 5000;
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(gaussianRandom(0, 10));
  const mean = samples.reduce((s, v) => s + v, 0) / N;
  const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / N;
  const std = Math.sqrt(variance);
  assert.ok(Math.abs(std - 10) < 0.5, `std=${std} too far from 10`);
});

// ── _slumpPenalty ───────────────────────────────────────────────────────────
test('_slumpPenalty — empty / short log returns 0', () => {
  S.recentGameLog = null;
  assert.equal(_slumpPenalty(), 0);
  S.recentGameLog = [{ stat: { atBats: 4, hits: 1 } }];
  assert.equal(_slumpPenalty(), 0);  // <3 games
});

test('_slumpPenalty — no drought (recent hits) returns 0', () => {
  S.recentGameLog = [
    { stat: { atBats: 4, hits: 2 } },
    { stat: { atBats: 3, hits: 1 } },
    { stat: { atBats: 4, hits: 1 } },
  ];
  assert.equal(_slumpPenalty(), 0);
});

test('_slumpPenalty — 3-game drought adds 1.5', () => {
  const log = Array(5).fill({ stat: { atBats: 4, hits: 0 } });
  // L10 BA of .000 with 20 AB triggers additional penalty too (+3)
  // 3-game drought: +1.5; but 4-game drought triggers +2.5, 5+ triggers +4
  // Here all 5 games are 0-for, so droughtGames will be 5 → +4. L10 BA=0 → +3.
  // Total = min(5, 7) = 5
  S.recentGameLog = log;
  assert.equal(_slumpPenalty(), 5);
});

test('_slumpPenalty — caps at 5', () => {
  S.recentGameLog = Array(10).fill({ stat: { atBats: 4, hits: 0 } });
  assert.equal(_slumpPenalty(), 5);
});

test('_slumpPenalty — pinch appearances (atBats=0) skipped, not counted as drought', () => {
  S.recentGameLog = [
    { stat: { atBats: 0, hits: 0 } },  // pinch appearance — skip
    { stat: { atBats: 4, hits: 2 } },  // good game ends drought consideration
    { stat: { atBats: 3, hits: 1 } },
  ];
  assert.equal(_slumpPenalty(), 0);
});

// ── _mcVariance ─────────────────────────────────────────────────────────────
test('_mcVariance — clamps to [4.5, 15]', () => {
  // Minimum case: no whiff data, large sample, no slump
  S.statcast = {};
  S.seasonStat = { plateAppearances: 500 };
  S.recentGameLog = null;
  const sigma = _mcVariance();
  assert.ok(sigma >= 4.5 && sigma <= 15);
});

test('_mcVariance — low-whiff hitter has lower sigma than high-whiff', () => {
  S.seasonStat = { plateAppearances: 500 };
  S.recentGameLog = null;
  S.statcast = { whiff: 18 };
  const lowWhiff = _mcVariance();
  S.statcast = { whiff: 38 };
  const highWhiff = _mcVariance();
  assert.ok(lowWhiff < highWhiff, `expected ${lowWhiff} < ${highWhiff}`);
});

test('_mcVariance — small sample (<50 PA) inflates sigma', () => {
  S.statcast = { whiff: 25 };
  S.recentGameLog = null;
  S.seasonStat = { plateAppearances: 200 };
  const stable = _mcVariance();
  S.seasonStat = { plateAppearances: 30 };
  const smallSample = _mcVariance();
  assert.ok(smallSample > stable);
});

// ── _rateUncertaintyPp ──────────────────────────────────────────────────────
test('_rateUncertaintyPp — clamps to [3, 9] and shrinks with sample size', () => {
  S.seasonStat = { plateAppearances: 600 };
  const wellSampled = _rateUncertaintyPp();
  S.seasonStat = { plateAppearances: 150 };
  const midSample = _rateUncertaintyPp();
  S.seasonStat = { plateAppearances: 0 };
  const noSample = _rateUncertaintyPp();
  assert.equal(wellSampled, 3, `well-sampled should floor at 3, got ${wellSampled}`);
  assert.equal(noSample, 9, `zero PA should ceil at 9, got ${noSample}`);
  assert.ok(midSample > wellSampled && midSample < noSample,
    `mid (${midSample}) should sit between ${wellSampled} and ${noSample}`);
});

// ── _pitchMatchupReason ─────────────────────────────────────────────────────
// _pitchMatchupReason depends on _pitchMatchupFactor's output, which we
// influence via S.pitchMatchupCached. Pre-populate the cache to skip the
// full computation.

test('_pitchMatchupReason — null when no factor available', () => {
  S.pitcher = { id: 1 };
  S.playerId = 'X';
  S.pitchMatchupCached = { pid: 1, bid: 'X', value: null };
  assert.equal(_pitchMatchupReason('over', 'batter_hits'), null);
});

test('_pitchMatchupReason — null when matchup signal is below threshold', () => {
  S.pitcher = { id: 1 };
  S.playerId = 'X';
  S.pitchMatchupCached = {
    pid: 1, bid: 'X',
    value: {
      kDeltaPp: 1.0,     // below 2pp threshold for K
      wobaDelta: 0.005,  // below 0.015 threshold for non-K
      primaryUsage: 30, primaryPitchName: 'slider',
      primaryBatterK: 25, baseK: 22,
    },
  };
  assert.equal(_pitchMatchupReason('over', 'batter_hits'), null);
  assert.equal(_pitchMatchupReason('over', 'batter_strikeouts'), null);
});

test('_pitchMatchupReason — non-K prop, positive wOBA delta supports Over direction', () => {
  S.pitcher = { id: 1 };
  S.playerId = 'X';
  S.pitchMatchupCached = {
    pid: 1, bid: 'X',
    value: {
      kDeltaPp: 0, wobaDelta: 0.025,  // positive = good for batter
      primaryUsage: 35, primaryPitchName: 'fastball',
      primaryBatterK: 0, baseK: 0,
    },
  };
  const over = _pitchMatchupReason('over', 'batter_hits');
  const under = _pitchMatchupReason('under', 'batter_hits');
  assert.ok(over !== null, 'over should have reason when wOBA delta supports it');
  assert.equal(under, null, 'under should be null when matchup favors over');
});

test('_pitchMatchupReason — K prop direction logic inverts correctly', () => {
  S.pitcher = { id: 1 };
  S.playerId = 'X';
  // High K delta = matchup favors more Ks = supports K Over
  S.pitchMatchupCached = {
    pid: 1, bid: 'X',
    value: {
      kDeltaPp: 4.0, wobaDelta: 0,
      primaryUsage: 30, primaryPitchName: 'slider',
      primaryBatterK: 26, baseK: 22,
    },
  };
  assert.ok(_pitchMatchupReason('over', 'batter_strikeouts') !== null);
  assert.equal(_pitchMatchupReason('under', 'batter_strikeouts'), null);
});

// ── modelProbability sanity bounds ──────────────────────────────────────────
// modelProbability is huge and orchestrates many helpers. Rather than test
// every internal branch we lock in:
//   1. Output is in [0, 100]
//   2. Per-prop clamps fire (lower bound is respected)
//   3. Higher score → higher probability (monotonic) for hits/TB/HR/BB/K/Runs

function setupAverageBatter() {
  S.seasonStat = {
    plateAppearances: 400, atBats: 350, hits: 90,
    homeRuns: 12, doubles: 18, triples: 1,
    rbi: 50, strikeOuts: 85, baseOnBalls: 40,
    runs: 50, gamesPlayed: 100, avg: '.257',
  };
  S.statcast = { whiff: 25, brl: 8, hhRate: 40 };
  S.pitcher = {
    id: 999, hand: 'R',
    st: { battersFaced: 400, strikeOuts: 88, baseOnBalls: 32,
          atBats: 360, hits: 88, homeRuns: 12, doubles: 16, triples: 1,
          whip: 1.30, avg: '.244' },
    bullpenGame: false,
    last3: [],
  };
  S.pitcherThrows = 'R';
  S.currentOrder = 3;
  S.isHome = false;
  S.roofClosed = false;
  S.recentGameLog = null;
  S.lineupProtection = { tier: 'average' };
  S.splits = null;
  S.pitchArsenal = null;
  S.pitchMatchupCached = null;
}

test('modelProbability — output in [0, 100] for every prop/line/score combo', () => {
  setupAverageBatter();
  const props = ['batter_hits', 'batter_total_bases', 'batter_home_runs',
                 'batter_walks', 'batter_strikeouts', 'batter_rbis',
                 'batter_runs_scored', 'batter_hits_runs_rbis'];
  for (const propKey of props) {
    for (const line of [0.5, 1.5, 2.5, 3.5]) {
      for (const score of [10, 30, 50, 70, 90]) {
        const p = modelProbability(propKey, line, score);
        assert.ok(p === null || (p >= 0 && p <= 100),
          `${propKey} line=${line} score=${score} → ${p} out of bounds`);
      }
    }
  }
});

test('modelProbability — Hits 0.5 monotonically increases in score (avg batter)', () => {
  setupAverageBatter();
  const at20 = modelProbability('batter_hits', 0.5, 20);
  const at50 = modelProbability('batter_hits', 0.5, 50);
  const at80 = modelProbability('batter_hits', 0.5, 80);
  assert.ok(at20 < at50, `at20=${at20}, at50=${at50}`);
  assert.ok(at50 < at80, `at50=${at50}, at80=${at80}`);
});

test('modelProbability — HR 0.5 respects clamps [3, 45]', () => {
  setupAverageBatter();
  // Even at extreme scores HR shouldn't exceed 45 or drop below the 3pp floor
  for (const score of [5, 50, 95]) {
    const p = modelProbability('batter_home_runs', 0.5, score);
    assert.ok(p >= 3 && p <= 45, `score=${score} → ${p}`);
  }
});

test('modelProbability — protection tier shifts RBI/Runs', () => {
  setupAverageBatter();
  S.lineupProtection = { tier: 'strong' };
  const strong = modelProbability('batter_rbis', 0.5, 50);
  S.lineupProtection = { tier: 'weak' };
  const weak = modelProbability('batter_rbis', 0.5, 50);
  // Strong should be ~6pp higher than weak (range capped by clamp)
  assert.ok(strong > weak, `strong=${strong}, weak=${weak}`);
});

// ── monteCarloConfidence ────────────────────────────────────────────────────
test('monteCarloConfidence — output in [0, 100]', () => {
  setupAverageBatter();
  const conf = monteCarloConfidence('batter_hits', 0.5, 60, 50, 'Over', 200);
  assert.ok(conf >= 0 && conf <= 100);
});

test('monteCarloConfidence — high score vs low market threshold → high confidence Over', () => {
  setupAverageBatter();
  // Score 80 with market expecting only 30% should give very high MC confidence
  const conf = monteCarloConfidence('batter_hits', 0.5, 80, 30, 'Over', 500);
  assert.ok(conf > 90, `expected >90, got ${conf}`);
});

test('monteCarloConfidence — low score vs high market threshold → low confidence Over', () => {
  setupAverageBatter();
  const conf = monteCarloConfidence('batter_hits', 0.5, 20, 70, 'Over', 500);
  assert.ok(conf < 10, `expected <10, got ${conf}`);
});
