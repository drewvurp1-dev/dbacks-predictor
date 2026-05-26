// Unit tests for betting.js — odds conversions, Kelly, devig. All pure.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedProb, americanToDecimal, kellyFraction,
  _medianImpliedProb, devig, bookAbbrev,
} from './betting.js';

// ── impliedProb ─────────────────────────────────────────────────────────────
test('impliedProb — null / zero returns null', () => {
  assert.equal(impliedProb(null), null);
  assert.equal(impliedProb(0), null);
});

test('impliedProb — even money (+100) = 50%', () => {
  assert.equal(impliedProb(100), 50);
});

test('impliedProb — -110 ≈ 52.38%', () => {
  assert.ok(Math.abs(impliedProb(-110) - 52.380952) < 0.001);
});

test('impliedProb — +200 = 33.33%', () => {
  assert.ok(Math.abs(impliedProb(200) - 33.333333) < 0.001);
});

test('impliedProb — -200 = 66.66%', () => {
  assert.ok(Math.abs(impliedProb(-200) - 66.666666) < 0.001);
});

// ── americanToDecimal ───────────────────────────────────────────────────────
test('americanToDecimal — null/zero returns null', () => {
  assert.equal(americanToDecimal(null), null);
  assert.equal(americanToDecimal(0), null);
});

test('americanToDecimal — +100 = 2.0', () => {
  assert.equal(americanToDecimal(100), 2.0);
});

test('americanToDecimal — +150 = 2.5', () => {
  assert.equal(americanToDecimal(150), 2.5);
});

test('americanToDecimal — -110 ≈ 1.909', () => {
  assert.ok(Math.abs(americanToDecimal(-110) - 1.909) < 0.001);
});

// ── kellyFraction ───────────────────────────────────────────────────────────
test('kellyFraction — null odds returns 0', () => {
  assert.equal(kellyFraction(60, null), 0);
  assert.equal(kellyFraction(60, 0), 0);
});

test('kellyFraction — no edge (modelProb < implied) returns 0', () => {
  // At +100 implied is 50%. If we model 40% we have no edge.
  assert.equal(kellyFraction(40, 100), 0);
});

test('kellyFraction — positive edge returns positive fraction', () => {
  // 60% on +100 → b=1, p=0.6, q=0.4 → (1*0.6 - 0.4)/1 = 0.2 → eighth-Kelly = 0.025
  const f = kellyFraction(60, 100);
  assert.ok(Math.abs(f - 0.025) < 1e-9);
});

test('kellyFraction — returns eighth-Kelly (1/8 of full)', () => {
  // 70% on +100: full Kelly = 0.4; eighth = 0.05
  const f = kellyFraction(70, 100);
  assert.ok(Math.abs(f - 0.05) < 1e-9);
});

test('kellyFraction — negative odds handled correctly', () => {
  // -200 implies 66.67%. Model at 75% → b=0.5, p=0.75, q=0.25
  // (0.5*0.75 - 0.25)/0.5 = 0.25 → eighth-Kelly = 0.03125
  const f = kellyFraction(75, -200);
  assert.ok(Math.abs(f - 0.03125) < 1e-9);
});

// ── _medianImpliedProb ──────────────────────────────────────────────────────
test('_medianImpliedProb — empty array returns null', () => {
  assert.equal(_medianImpliedProb([]), null);
});

test('_medianImpliedProb — single odds returns its implied prob', () => {
  assert.equal(_medianImpliedProb([100]), 50);
});

test('_medianImpliedProb — odd-length sorts and picks middle', () => {
  // [+100, -110, +200] → [50, 33.3, 52.38] sorted → [33.3, 50, 52.38] → median 50
  const m = _medianImpliedProb([100, -110, 200]);
  assert.equal(m, 50);
});

test('_medianImpliedProb — even-length averages middle two', () => {
  // [+100, -100] → [50, 50] → 50
  assert.equal(_medianImpliedProb([100, -100]), 50);
});

test('_medianImpliedProb — filters out null odds', () => {
  // [+100, 0, null, +200] → [50, 33.3] sorted → 41.67
  const m = _medianImpliedProb([100, 0, null, 200]);
  assert.ok(Math.abs(m - 41.66666) < 0.01);
});

// ── devig ───────────────────────────────────────────────────────────────────
test('devig — empty arrays return null', () => {
  assert.equal(devig([], [-110]), null);
  assert.equal(devig([-110], []), null);
});

test('devig — fair market (sum ≤ 1) falls back to simple normalize', () => {
  // Two sides both at +100 (50% each, no vig) → 50/50
  const dv = devig([100], [100]);
  assert.ok(Math.abs(dv.overProb - 50) < 0.001);
  assert.ok(Math.abs(dv.underProb - 50) < 0.001);
});

test('devig — standard -110/-110 market produces ~50/50 after devig', () => {
  // Both -110: ~52.4% each. Power devig should pull both to ~50.
  const dv = devig([-110], [-110]);
  assert.ok(Math.abs(dv.overProb - 50) < 0.5);
  assert.ok(Math.abs(dv.underProb - 50) < 0.5);
});

test('devig — preserves overround direction (favorite stays favored)', () => {
  // Over heavily favored: -200 / +150. Over implied ≈ 66.7%, Under ≈ 40%.
  // After devig, Over should still be > 50%.
  const dv = devig([-200], [150]);
  assert.ok(dv.overProb > dv.underProb);
  // And probs should sum to 100% (within rounding)
  assert.ok(Math.abs(dv.overProb + dv.underProb - 100) < 0.01);
});

test('devig — output sums to 100', () => {
  const dv = devig([-115], [-105]);
  assert.ok(Math.abs(dv.overProb + dv.underProb - 100) < 0.01);
});

// ── bookAbbrev ──────────────────────────────────────────────────────────────
test('bookAbbrev — known book returns abbreviation', () => {
  assert.equal(bookAbbrev('DraftKings'), 'DK');
  assert.equal(bookAbbrev('BetMGM'), 'MGM');
  assert.equal(bookAbbrev('Caesars'), 'CZR');
});

test('bookAbbrev — unknown book returns the input unchanged', () => {
  assert.equal(bookAbbrev('SomeNewBook'), 'SomeNewBook');
});
