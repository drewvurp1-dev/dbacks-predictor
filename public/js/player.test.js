// Unit tests for player.js — probability primitives + stat helpers. The
// S-reading helpers (_gamePAs, _handSplit, _ttopBonus) get mocked S setup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from './state.js';
import {
  _factorial, _poissonCDF,
  _gamePAs, _paMultiplier, _ttopBonus, _hrrOverPct,
  _shrunkRate, _binomGE, _convolveTBge, _log5,
  _extractSplitStat, _handSplit,
} from './player.js';

// ── _factorial ──────────────────────────────────────────────────────────────
test('_factorial — base cases', () => {
  assert.equal(_factorial(0), 1);
  assert.equal(_factorial(1), 1);
  assert.equal(_factorial(2), 2);
  assert.equal(_factorial(5), 120);
});

// ── _poissonCDF ─────────────────────────────────────────────────────────────
test('_poissonCDF — lambda=1, k=0 → e^-1 ≈ 0.3679', () => {
  assert.ok(Math.abs(_poissonCDF(1, 0) - Math.exp(-1)) < 1e-9);
});

test('_poissonCDF — lambda=1, k=∞ approaches 1', () => {
  // k=15 is essentially infinity for lambda=1
  assert.ok(_poissonCDF(1, 15) > 0.9999);
});

test('_poissonCDF — monotonically increases in k', () => {
  const a = _poissonCDF(2, 1);
  const b = _poissonCDF(2, 3);
  const c = _poissonCDF(2, 5);
  assert.ok(a < b);
  assert.ok(b < c);
});

// ── _shrunkRate ─────────────────────────────────────────────────────────────
test('_shrunkRate — zero denominator returns league average', () => {
  assert.equal(_shrunkRate(0, 0, 0.25, 60), 0.25);
  assert.equal(_shrunkRate(5, 0, 0.25, 60), 0.25);
});

test('_shrunkRate — large sample dominates league prior', () => {
  // 500 AB at .300 with priorN=60 toward .245 → ~0.294
  const r = _shrunkRate(150, 500, 0.245, 60);
  assert.ok(Math.abs(r - 0.294) < 0.001);
});

test('_shrunkRate — small sample shrinks heavily toward league', () => {
  // 10 AB with 5 hits (.500) vs league .245 priorN=60 → much closer to league
  const r = _shrunkRate(5, 10, 0.245, 60);
  // (5 + 60*0.245) / (10 + 60) = 19.7/70 ≈ 0.2814
  assert.ok(Math.abs(r - 0.2814) < 0.001);
});

// ── _binomGE ────────────────────────────────────────────────────────────────
test('_binomGE — k≤0 returns 1 (certain)', () => {
  assert.equal(_binomGE(5, 0.3, 0), 1);
  assert.equal(_binomGE(5, 0.3, -1), 1);
});

test('_binomGE — k>n returns 0 (impossible)', () => {
  assert.equal(_binomGE(5, 0.3, 6), 0);
});

test('_binomGE — n=4, p=0.5, k=2 (≥2 successes in 4 trials)', () => {
  // P(≥2) = 1 - P(0) - P(1) = 1 - C(4,0)(0.5)^4 - C(4,1)(0.5)^4
  //       = 1 - 0.0625 - 0.25 = 0.6875
  assert.ok(Math.abs(_binomGE(4, 0.5, 2) - 0.6875) < 1e-9);
});

test('_binomGE — output bounded to [0, 1]', () => {
  for (const n of [3, 10, 25]) {
    for (const p of [0.1, 0.5, 0.9]) {
      for (const k of [1, 2, 5]) {
        const r = _binomGE(n, p, k);
        assert.ok(r >= 0 && r <= 1, `${n},${p},${k} → ${r} out of bounds`);
      }
    }
  }
});

// ── _convolveTBge ───────────────────────────────────────────────────────────
test('_convolveTBge — n=0 returns 1 if k≤0 else 0', () => {
  assert.equal(_convolveTBge([1, 0, 0, 0, 0], 0, 0), 1);
  assert.equal(_convolveTBge([1, 0, 0, 0, 0], 0, 1), 0);
});

test('_convolveTBge — all-outs perAB gives 0 chance of any TB', () => {
  // perAB = [1, 0, 0, 0, 0] → always 0 TB
  const r = _convolveTBge([1, 0, 0, 0, 0], 4, 1);
  assert.ok(Math.abs(r) < 1e-9);
});

test('_convolveTBge — all-HR perAB over 1 AB → P(TB≥4) = 1', () => {
  const r = _convolveTBge([0, 0, 0, 0, 1], 1, 4);
  assert.equal(r, 1);
});

test('_convolveTBge — output bounded to [0, 1]', () => {
  const perAB = [0.6, 0.2, 0.1, 0.05, 0.05];
  for (const n of [1, 2, 4]) {
    for (const k of [0, 1, 2, 3]) {
      const r = _convolveTBge(perAB, n, k);
      assert.ok(r >= 0 && r <= 1, `n=${n}, k=${k} → ${r} out of bounds`);
    }
  }
});

// ── _log5 ───────────────────────────────────────────────────────────────────
test('_log5 — batter and pitcher both at league → returns league', () => {
  const r = _log5(0.25, 0.25, 0.25);
  assert.ok(Math.abs(r - 0.25) < 1e-9);
});

test('_log5 — elite batter vs weak pitcher → > batter rate', () => {
  // batter .350, pitcher allows .280, league .245
  const r = _log5(0.350, 0.280, 0.245);
  assert.ok(r > 0.350, `expected >.350 got ${r}`);
});

test('_log5 — weak batter vs elite pitcher → < batter rate', () => {
  const r = _log5(0.180, 0.200, 0.245);
  assert.ok(r < 0.180);
});

test('_log5 — clamps inputs to (0.001, 0.5)', () => {
  // Even with 0.9 input it should clamp to 0.5 and still produce sensible output
  const r = _log5(0.9, 0.9, 0.25);
  assert.ok(r > 0 && r < 1);
});

// ── _extractSplitStat ───────────────────────────────────────────────────────
test('_extractSplitStat — null/undefined input returns null', () => {
  assert.equal(_extractSplitStat(null), null);
  assert.equal(_extractSplitStat(undefined), null);
});

test('_extractSplitStat — extracts all expected fields', () => {
  const r = _extractSplitStat({
    ops: '0.815', avg: '.275', obp: '.350', slg: '.465',
    gamesPlayed: '40', plateAppearances: '160',
    atBats: '140', hits: '38', totalBases: '65', homeRuns: '7',
    rbi: '22', strikeOuts: '32', baseOnBalls: '18',
  });
  assert.equal(r.ops, 0.815);
  assert.equal(r.gp, 40);
  assert.equal(r.pa, 160);
  assert.equal(r.ab, 140);
  assert.equal(r.h, 38);
  assert.equal(r.hr, 7);
  assert.equal(r.k, 32);
  assert.equal(r.bb, 18);
});

// ── _gamePAs ────────────────────────────────────────────────────────────────
// _gamePAs reads S so we mock state for each test. _parkFactors is read from
// the DOM via document.getElementById — in Node it returns the default 1.0
// factors because there's no DOM, which is what we want for these tests.

test('_gamePAs — leadoff hitter (order=1) gets ~4.6 PA', () => {
  S.currentOrder = 1;
  S.isHome = false;
  S.pitcher = { bullpenGame: true };  // skip park/WHIP adjustments
  const pa = _gamePAs();
  assert.ok(Math.abs(pa - 4.6) < 0.01, `expected ~4.6 got ${pa}`);
});

test('_gamePAs — bottom of order (order=9) gets ~3.7 PA', () => {
  S.currentOrder = 9;
  S.isHome = false;
  S.pitcher = { bullpenGame: true };
  const pa = _gamePAs();
  assert.ok(Math.abs(pa - 3.7) < 0.01, `expected ~3.7 got ${pa}`);
});

test('_gamePAs — unknown order defaults to 4.2', () => {
  S.currentOrder = null;
  S.isHome = false;
  S.pitcher = { bullpenGame: true };
  const pa = _gamePAs();
  assert.ok(Math.abs(pa - 4.2) < 0.01);
});

test('_gamePAs — home team gets 0.08 less than away', () => {
  S.currentOrder = 5;
  S.pitcher = { bullpenGame: true };
  S.isHome = false;
  const away = _gamePAs();
  S.isHome = true;
  const home = _gamePAs();
  assert.ok(Math.abs((away - home) - 0.08) < 0.001);
});

test('_paMultiplier — relative to 4.2 league avg', () => {
  S.currentOrder = 1;  // 4.6 PA
  S.isHome = false;
  S.pitcher = { bullpenGame: true };
  const mult = _paMultiplier();
  assert.ok(Math.abs(mult - (4.6 / 4.2)) < 0.001);
});

// ── _ttopBonus ──────────────────────────────────────────────────────────────
test('_ttopBonus — bullpen game returns 0', () => {
  S.currentOrder = 1;
  S.pitcher = { bullpenGame: true };
  assert.equal(_ttopBonus(), 0);
});

test('_ttopBonus — unknown order returns 0', () => {
  S.currentOrder = null;
  S.pitcher = { bullpenGame: false };
  assert.equal(_ttopBonus(), 0);
});

test('_ttopBonus — top of order (1-3) gets +2', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 1; assert.equal(_ttopBonus(), 2);
  S.currentOrder = 3; assert.equal(_ttopBonus(), 2);
});

test('_ttopBonus — middle order (4-6) gets +1', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 4; assert.equal(_ttopBonus(), 1);
  S.currentOrder = 6; assert.equal(_ttopBonus(), 1);
});

test('_ttopBonus — bottom of order (7+) gets 0', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 7; assert.equal(_ttopBonus(), 0);
  S.currentOrder = 9; assert.equal(_ttopBonus(), 0);
});

// ── _handSplit ──────────────────────────────────────────────────────────────
test('_handSplit — null when splits not loaded', () => {
  S.splits = null;
  S.pitcher = { hand: 'R' };
  assert.equal(_handSplit(), null);
});

test('_handSplit — returns vL row for left-handed pitcher', () => {
  S.splits = { vl: { ops: 0.8 }, vr: { ops: 0.7 } };
  S.pitcher = { hand: 'L' };
  assert.deepEqual(_handSplit(), { ops: 0.8 });
});

test('_handSplit — returns vR row for right-handed pitcher', () => {
  S.splits = { vl: { ops: 0.8 }, vr: { ops: 0.7 } };
  S.pitcher = { hand: 'R' };
  assert.deepEqual(_handSplit(), { ops: 0.7 });
});

test('_handSplit — falls back to S.pitcherThrows when pitcher.hand missing', () => {
  S.splits = { vl: { ops: 0.8 }, vr: { ops: 0.7 } };
  S.pitcher = {};  // no hand
  S.pitcherThrows = 'L';
  assert.deepEqual(_handSplit(), { ops: 0.8 });
});
