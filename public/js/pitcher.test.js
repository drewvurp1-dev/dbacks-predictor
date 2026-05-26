// Unit tests for pitcher.js helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePitchMix } from './pitcher.js';

test('normalizePitchMix — all zeros stays zero', () => {
  const out = normalizePitchMix({ FF: 0, SL: 0, CH: 0 });
  assert.deepEqual(out, { FF: 0, SL: 0, CH: 0 });
});

test('normalizePitchMix — Mahle case (98% raw) sums to 100', () => {
  // Real Savant data: FF 47.1 + FC 16.4 + SL 9.7 + FS 24.8 = 98.0
  const out = normalizePitchMix({ FF: 47.1, FC: 16.4, SL: 9.7, FS: 24.8 });
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  assert.equal(sum, 100);
});

test('normalizePitchMix — already-100 input rounds without distortion', () => {
  const out = normalizePitchMix({ FF: 50, SL: 30, CH: 20 });
  assert.deepEqual(out, { FF: 50, SL: 30, CH: 20 });
});

test('normalizePitchMix — Hamilton method picks largest remainder', () => {
  // 33.4 + 33.3 + 33.3 → integer floors sum to 99, leftover goes to the .4
  const out = normalizePitchMix({ A: 33.4, B: 33.3, C: 33.3 });
  assert.equal(Object.values(out).reduce((s, v) => s + v, 0), 100);
  assert.equal(out.A, 34);
});

test('normalizePitchMix — handles small floats summing under 100', () => {
  // Source totals 60 → scaled up to 100; integer sum must still be 100.
  const out = normalizePitchMix({ FF: 30, SL: 20, CH: 10 });
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  assert.equal(sum, 100);
});

test('normalizePitchMix — preserves bucket keys for zero-usage pitches', () => {
  const out = normalizePitchMix({ FF: 50, SL: 50, CH: 0, CU: 0 });
  assert.equal(out.CH, 0);
  assert.equal(out.CU, 0);
  assert.equal(out.FF + out.SL, 100);
});
