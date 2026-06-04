// Unit tests for player.js — probability primitives + stat helpers. The
// S-reading helpers (_gamePAs, _handSplit, _ttopBonus) get mocked S setup.

import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from './state.js';
import {
  _factorial, _poissonCDF, _negBinomTailGT,
  _gamePAs, _paMultiplier, _seasonPAperG, _ttopBonus, _hrrOverPct,
  _shrunkRate, _binomGE, _convolveTBge, _log5,
  _extractSplitStat, _handSplit, _pitcherRunEnvMult, _pitcherStuffMult, _seasonWoba,
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

// ── _negBinomTailGT ───────────────────────────────────────────────────────────
test('_negBinomTailGT — large r collapses to the Poisson tail', () => {
  // As r→∞ the negative binomial converges to the Poisson with the same mean.
  const lambda = 0.55;
  const nb = _negBinomTailGT(lambda, 1e6, 0);
  const pois = 1 - _poissonCDF(lambda, 0);
  assert.ok(Math.abs(nb - pois) < 1e-3);
});

test('_negBinomTailGT — overdispersion lowers P(>0) vs Poisson at same mean', () => {
  // The whole point of #3: at the RBI mean, NB(r=1.3) must sit BELOW the Poisson
  // ~34.9% and near the empirical ~30%.
  const lambda = 0.43;
  const nb = _negBinomTailGT(lambda, 1.3, 0);
  const pois = 1 - _poissonCDF(lambda, 0);
  assert.ok(nb < pois);                 // correction is downward
  assert.ok(nb > 0.27 && nb < 0.33);    // lands in the empirical ~30% band
});

test('_negBinomTailGT — lambda<=0 returns 0', () => {
  assert.equal(_negBinomTailGT(0, 1.3, 0), 0);
  assert.equal(_negBinomTailGT(-1, 1.3, 0), 0);
});

test('_negBinomTailGT — non-positive/non-finite r falls back to Poisson tail', () => {
  const lambda = 0.5;
  assert.equal(_negBinomTailGT(lambda, 0, 0), 1 - _poissonCDF(lambda, 0));
  assert.equal(_negBinomTailGT(lambda, -2, 0), 1 - _poissonCDF(lambda, 0));
  assert.equal(_negBinomTailGT(lambda, Infinity, 0), 1 - _poissonCDF(lambda, 0));
});

test('_negBinomTailGT — tail is monotonically decreasing in k', () => {
  const a = _negBinomTailGT(1.2, 1.5, 0);
  const b = _negBinomTailGT(1.2, 1.5, 1);
  const c = _negBinomTailGT(1.2, 1.5, 2);
  assert.ok(a > b);
  assert.ok(b > c);
  assert.ok(c >= 0);
});

test('_negBinomTailGT — stays within [0,1]', () => {
  for (const lam of [0.1, 0.43, 0.55, 1.2, 3.0]) {
    for (const r of [0.5, 1.3, 4.0, 20]) {
      for (const k of [0, 1, 2, 3]) {
        const v = _negBinomTailGT(lam, r, k);
        assert.ok(v >= 0 && v <= 1);
      }
    }
  }
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

// ── _seasonPAperG ────────────────────────────────────────────────────────────
// Player's own PA/G — the reference for scaling run-scoring rates to today's
// PAs. Avoids the /4.2 double-count (season RBI/G is already PA-loaded).
test('_seasonPAperG — returns the player PA/G when sample is adequate', () => {
  assert.ok(Math.abs(_seasonPAperG({ plateAppearances: 460, gamesPlayed: 100 }) - 4.6) < 1e-9);
  assert.ok(Math.abs(_seasonPAperG({ plateAppearances: 400, gamesPlayed: 100 }) - 4.0) < 1e-9);
});

test('_seasonPAperG — thin sample (<10 GP) or missing PA falls back to 4.2', () => {
  assert.equal(_seasonPAperG({ plateAppearances: 30, gamesPlayed: 7 }), 4.2);
  assert.equal(_seasonPAperG({ gamesPlayed: 100 }), 4.2);
  assert.equal(_seasonPAperG(null), 4.2);
});

test('_seasonPAperG — clamps to [3.4, 4.9]', () => {
  assert.equal(_seasonPAperG({ plateAppearances: 200, gamesPlayed: 100 }), 3.4); // 2.0 → floor
  assert.equal(_seasonPAperG({ plateAppearances: 600, gamesPlayed: 100 }), 4.9); // 6.0 → ceil
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

// Centered on the lineup average ({+1, 0, −1}) so it carries no standing OVER
// offset — see _ttopBonus. Top > middle > bottom ordering is preserved.
test('_ttopBonus — top of order (1-3) gets +1', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 1; assert.equal(_ttopBonus(), 1);
  S.currentOrder = 3; assert.equal(_ttopBonus(), 1);
});

test('_ttopBonus — middle order (4-6) is neutral (0)', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 4; assert.equal(_ttopBonus(), 0);
  S.currentOrder = 6; assert.equal(_ttopBonus(), 0);
});

test('_ttopBonus — bottom of order (7+) gets −1', () => {
  S.pitcher = { bullpenGame: false };
  S.currentOrder = 7; assert.equal(_ttopBonus(), -1);
  S.currentOrder = 9; assert.equal(_ttopBonus(), -1);
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

// ── _pitcherRunEnvMult ──────────────────────────────────────────────────────
// Opposing-pitcher run-environment multiplier for the (otherwise pitcher-blind)
// RBI / Runs / H+R+RBI props. Reads S.pitcher.st.
const ELITE_ARM = { st: { atBats: 300, hits: 62, homeRuns: 6, doubles: 11, triples: 0,
  battersFaced: 330, baseOnBalls: 18 } };          // stingy: low OBP/SLG against
const AVG_ARM = { st: { atBats: 300, hits: 75, homeRuns: 10, doubles: 15, triples: 1,
  battersFaced: 330, baseOnBalls: 28 } };          // ~league OBP/SLG against
const BP_ARM = { st: { atBats: 300, hits: 90, homeRuns: 18, doubles: 20, triples: 2,
  battersFaced: 340, baseOnBalls: 40 } };          // batting-practice arm

test('_pitcherRunEnvMult — no pitcher loaded returns neutral 1.0', () => {
  S.pitcher = null;
  assert.equal(_pitcherRunEnvMult(), 1.0);
});

test('_pitcherRunEnvMult — tiny sample (<50 BF) returns neutral 1.0', () => {
  S.pitcher = { st: { battersFaced: 30, hits: 10, baseOnBalls: 4, atBats: 28, homeRuns: 1, doubles: 2, triples: 0 } };
  assert.equal(_pitcherRunEnvMult(), 1.0);
});

test('_pitcherRunEnvMult — average arm sits near 1.0', () => {
  S.pitcher = AVG_ARM;
  const m = _pitcherRunEnvMult();
  assert.ok(Math.abs(m - 1.0) < 0.05, `expected ~1.0 got ${m}`);
});

test('_pitcherRunEnvMult — elite arm suppresses (<1), BP arm inflates (>1)', () => {
  S.pitcher = ELITE_ARM; const me = _pitcherRunEnvMult();
  S.pitcher = BP_ARM;    const mb = _pitcherRunEnvMult();
  assert.ok(me < 0.95, `elite should suppress, got ${me}`);
  assert.ok(mb > 1.05, `BP arm should inflate, got ${mb}`);
  assert.ok(me < mb, 'elite must be below BP arm');
});

test('_pitcherRunEnvMult — clamped to [0.65, 1.25]', () => {
  // Absurdly stingy line — every batter retired, no baserunners.
  S.pitcher = { st: { battersFaced: 300, hits: 10, baseOnBalls: 2, atBats: 290, homeRuns: 0, doubles: 1, triples: 0 } };
  assert.ok(_pitcherRunEnvMult() >= 0.65 - 1e-9);
  // Absurdly hittable line.
  S.pitcher = { st: { battersFaced: 300, hits: 150, baseOnBalls: 60, atBats: 240, homeRuns: 40, doubles: 40, triples: 5 } };
  assert.ok(_pitcherRunEnvMult() <= 1.25 + 1e-9);
});

test('_pitcherRunEnvMult — bullpen game blends 40% toward league', () => {
  S.pitcher = { ...ELITE_ARM, bullpenGame: true };
  const blended = _pitcherRunEnvMult();
  S.pitcher = { ...ELITE_ARM, bullpenGame: false };
  const raw = _pitcherRunEnvMult();
  // Blending toward 1.0 pulls a sub-1.0 multiplier upward (closer to neutral).
  assert.ok(blended > raw, `bullpen blend should pull toward 1.0: blended=${blended} raw=${raw}`);
});

// Product (runs-created) form regression: a clearly-good-but-not-elite arm must
// suppress meaningfully, not the ~10% the old flat 60/40 sum produced. ~.278 BAA,
// sub-1.10 WHIP line → product lands near 0.80 (sum gave ~0.90). Guards against
// reverting to the arithmetic-mean blend that kept the model high on RBI Overs.
test('_pitcherRunEnvMult — good arm suppresses ~20% (product form, not the flat ~10%)', () => {
  S.pitcher = { st: { battersFaced: 360, atBats: 330, hits: 74, baseOnBalls: 26,
    homeRuns: 7, doubles: 12, triples: 1 } };
  const m = _pitcherRunEnvMult();
  assert.ok(m < 0.85, `good arm should suppress >15% under product form, got ${m}`);
  assert.ok(m > 0.65, `but not floor-clamped for a non-elite arm, got ${m}`);
});

// ── _pitcherStuffMult ───────────────────────────────────────────────────────
// DIPS-skill (SIERA/xFIP/FIP) multiplier on the batter's offensive event rates.
// Reads S.pitcher.advanced + S.pitcher.st. <1 vs a good arm, >1 vs a weak one.
test('_pitcherStuffMult — no pitcher / no advanced metrics returns neutral 1.0', () => {
  S.pitcher = null;
  assert.equal(_pitcherStuffMult(), 1.0);
  S.pitcher = { st: { inningsPitched: '70.0' } }; // advanced missing
  assert.equal(_pitcherStuffMult(), 1.0);
});

test('_pitcherStuffMult — under 8 IP returns neutral 1.0 (metrics not stable)', () => {
  S.pitcher = { st: { inningsPitched: '7.0' }, advanced: { siera: 2.5, xfip: 2.6, fip: 2.7 } };
  assert.equal(_pitcherStuffMult(), 1.0);
});

test('_pitcherStuffMult — league-average DIPS (~4.00) sits at 1.0', () => {
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: 4.0, xfip: 4.0, fip: 4.0 } };
  assert.ok(Math.abs(_pitcherStuffMult() - 1.0) < 1e-9);
});

test('_pitcherStuffMult — ace suppresses (<1), weak arm inflates (>1)', () => {
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: 2.8, xfip: 3.0, fip: 2.9 } };
  const ace = _pitcherStuffMult();
  S.pitcher = { st: { inningsPitched: '60.0' }, advanced: { siera: 5.4, xfip: 5.2, fip: 5.3 } };
  const weak = _pitcherStuffMult();
  assert.ok(ace < 1.0, `ace should suppress, got ${ace}`);
  assert.ok(weak > 1.0, `weak arm should inflate, got ${weak}`);
  assert.ok(ace < weak, 'ace must be below weak arm');
});

test('_pitcherStuffMult — prefers SIERA over xFIP over FIP', () => {
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: 2.8, xfip: 9.9, fip: 9.9 } };
  const bySiera = _pitcherStuffMult();
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: null, xfip: 2.8, fip: 9.9 } };
  const byXfip = _pitcherStuffMult();
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: null, xfip: null, fip: 2.8 } };
  const byFip = _pitcherStuffMult();
  assert.ok(Math.abs(bySiera - byXfip) < 1e-9 && Math.abs(byXfip - byFip) < 1e-9,
    `all three should resolve to the same 2.8 DIPS value: ${bySiera}/${byXfip}/${byFip}`);
});

test('_pitcherStuffMult — clamped to [0.60, 1.16]', () => {
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: 1.0, xfip: 1.0, fip: 1.0 } };
  assert.ok(_pitcherStuffMult() >= 0.60 - 1e-9);
  S.pitcher = { st: { inningsPitched: '70.0' }, advanced: { siera: 9.0, xfip: 9.0, fip: 9.0 } };
  assert.ok(_pitcherStuffMult() <= 1.16 + 1e-9);
});

// ── _hrrOverPct runEnvMult parameter ────────────────────────────────────────
test('_hrrOverPct — runEnvMult scales the projection (suppress < neutral < inflate)', () => {
  const ss = { hits: 50, runs: 28, rbi: 30, gamesPlayed: 50 };
  const suppress = _hrrOverPct(1.5, ss, null, 4.2, 0.85);
  const neutral  = _hrrOverPct(1.5, ss, null, 4.2, 1.0);
  const inflate  = _hrrOverPct(1.5, ss, null, 4.2, 1.18);
  assert.ok(suppress < neutral, `suppress(${suppress}) should be < neutral(${neutral})`);
  assert.ok(inflate > neutral, `inflate(${inflate}) should be > neutral(${neutral})`);
});

test('_hrrOverPct — runEnvMult defaults to 1.0 (backward compatible)', () => {
  const ss = { hits: 50, runs: 28, rbi: 30, gamesPlayed: 50 };
  assert.equal(_hrrOverPct(1.5, ss, null, 4.2), _hrrOverPct(1.5, ss, null, 4.2, 1.0));
});

// PA scaling uses the player's OWN season PA/G, not league 4.2. Two hitters with
// the SAME per-game H+R+RBI rate but different season PA/G, evaluated at the same
// gamePAs (4.6 — batting at the top today): the lower-PA/G hitter is effectively
// "promoted" relative to his norm, so his projection scales UP more. The old
// /4.2 scaling was blind to this and double-counted PA volume for everyone.
test('_hrrOverPct — scales by the player\'s own season PA/G, not league 4.2', () => {
  const base = { hits: 100, runs: 55, rbi: 55, gamesPlayed: 100 };
  const highPApg = { ...base, plateAppearances: 460 }; // 4.6 PA/G — usual top-order volume
  const lowPApg  = { ...base, plateAppearances: 400 }; // 4.0 PA/G — usually bats lower
  const atTop = 4.6;
  const pHigh = _hrrOverPct(1.5, highPApg, null, atTop); // paMult = 4.6/4.6 = 1.00
  const pLow  = _hrrOverPct(1.5, lowPApg,  null, atTop); // paMult = 4.6/4.0 = 1.15
  assert.ok(pLow > pHigh, `lower-PA/G hitter promoted to the top scales up more: low=${pLow} high=${pHigh}`);
});

// ── _seasonWoba ─────────────────────────────────────────────────────────────
test('_seasonWoba — null inputs / empty denominator return null', () => {
  assert.equal(_seasonWoba(null), null);
  assert.equal(_seasonWoba({ atBats: 0, baseOnBalls: 0 }), null);
});

test('_seasonWoba — all-singles line equals w1B (denominator = AB)', () => {
  // 100 AB, 30 singles, nothing else → wOBA = 0.888 * 30 / 100
  const w = _seasonWoba({ atBats: 100, hits: 30, doubles: 0, triples: 0, homeRuns: 0,
    baseOnBalls: 0, intentionalWalks: 0, hitByPitch: 0, sacFlies: 0 });
  assert.ok(Math.abs(w - 0.2664) < 1e-6, `expected 0.2664, got ${w}`);
});

test('_seasonWoba — IBB removed from walk credit and denominator', () => {
  const withIbb = _seasonWoba({ atBats: 50, hits: 10, doubles: 0, triples: 0, homeRuns: 0,
    baseOnBalls: 10, intentionalWalks: 4, hitByPitch: 0, sacFlies: 0 });
  // uBB = 6, denom = 50 + 10 - 4 = 56, num = 0.888*10 + 0.690*6
  const expected = (0.888 * 10 + 0.690 * 6) / 56;
  assert.ok(Math.abs(withIbb - expected) < 1e-9, `expected ${expected}, got ${withIbb}`);
});

test('_seasonWoba — extra-base hits weighted above singles', () => {
  const singles = _seasonWoba({ atBats: 100, hits: 20, doubles: 0, triples: 0, homeRuns: 0, baseOnBalls: 0, intentionalWalks: 0, hitByPitch: 0, sacFlies: 0 });
  const homers  = _seasonWoba({ atBats: 100, hits: 20, doubles: 0, triples: 0, homeRuns: 20, baseOnBalls: 0, intentionalWalks: 0, hitByPitch: 0, sacFlies: 0 });
  assert.ok(homers > singles, `HR line (${homers}) should exceed singles line (${singles})`);
});
