// Unit tests for betting.js — odds conversions, devig. All pure.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  impliedProb, americanToDecimal,
  _medianImpliedProb, devig, bookAbbrev,
  kalshiImpliedProb, kalshiToAmerican,
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
  assert.equal(bookAbbrev('theScore Bet'), 'ESPN');
});

test('bookAbbrev — unknown book returns the input unchanged', () => {
  assert.equal(bookAbbrev('SomeNewBook'), 'SomeNewBook');
});

// ── kalshiImpliedProb ─────────────────────────────────────────────────────────
test('kalshiImpliedProb — null / empty returns null', () => {
  assert.equal(kalshiImpliedProb(null), null);
  assert.equal(kalshiImpliedProb({}), null);
});

test('kalshiImpliedProb — yes bid/ask midpoint', () => {
  assert.equal(kalshiImpliedProb({ yesBid: 40, yesAsk: 44 }), 42);
});

test('kalshiImpliedProb — derives yes side from no quotes', () => {
  // no_bid 55 → yes_ask 45 ; no_ask 60 → yes_bid 40 ; mid = 42.5
  assert.equal(kalshiImpliedProb({ noBid: 55, noAsk: 60 }), 42.5);
});

test('kalshiImpliedProb — combines yes and no quotes into tightest spread', () => {
  // bestBid = max(40, 100-65=35) = 40 ; bestAsk = min(46, 100-58=42) = 42 ; mid 41
  assert.equal(kalshiImpliedProb({ yesBid: 40, yesAsk: 46, noBid: 58, noAsk: 65 }), 41);
});

test('kalshiImpliedProb — falls back to last price', () => {
  assert.equal(kalshiImpliedProb({ lastPrice: 37 }), 37);
});

test('kalshiImpliedProb — clamps to 0–100', () => {
  assert.equal(kalshiImpliedProb({ yesBid: 99, yesAsk: 110 }), 100);
});

// ── kalshiToAmerican ──────────────────────────────────────────────────────────
test('kalshiToAmerican — 50¢ ≈ +100', () => {
  assert.equal(kalshiToAmerican(50), 100);
});

test('kalshiToAmerican — favorite (75¢) → −300', () => {
  assert.equal(kalshiToAmerican(75), -300);
});

test('kalshiToAmerican — underdog (25¢) → +300', () => {
  assert.equal(kalshiToAmerican(25), 300);
});

test('kalshiToAmerican — degenerate (0 / 100) returns null', () => {
  assert.equal(kalshiToAmerican(0), null);
  assert.equal(kalshiToAmerican(100), null);
});
