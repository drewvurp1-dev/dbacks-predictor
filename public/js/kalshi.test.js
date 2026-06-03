// Regression tests for the Kalshi scanner's field-extraction helpers.
// These lock in the live-API shape verified 2026-06 (see kalshi.js header):
// prices arrive as `*_dollars` strings, thresholds as `floor_strike`, and the
// prop keyword match must respect word boundaries so a substring buried in a
// player name (e.g. "Co-RBI-n Carroll") can't mis-tag the market.
import { test } from 'node:test';
import assert from 'node:assert';
import { _mapProp, _extractThreshold, _cents, _volume } from './kalshi.js';

test('_mapProp — Corbin Carroll hits market is Hits, not RBI', () => {
  // "Corbin" contains the substring "rbi"; a naive includes() check tagged this
  // hits market as batter_rbis. Word-boundary matching fixes it.
  assert.strictEqual(_mapProp('Corbin Carroll: 1+ hits?'), 'batter_hits');
});

test('_mapProp — home runs map to batter_home_runs, not batter_runs_scored', () => {
  assert.strictEqual(_mapProp('Corbin Carroll: 1+ home runs?'), 'batter_home_runs');
});

test('_mapProp — total bases', () => {
  assert.strictEqual(_mapProp('Ketel Marte: 2+ total bases?'), 'batter_total_bases');
});

test('_mapProp — hits + runs + RBIs is the combo prop', () => {
  assert.strictEqual(_mapProp('Corbin Carroll: 1+ hits + runs + RBIs?'), 'batter_hits_runs_rbis');
});

test('_mapProp — strikeouts', () => {
  assert.strictEqual(_mapProp('Zac Gallen: 2+ strikeouts?'), 'batter_strikeouts');
});

test('_mapProp — RBI prop when the word stands alone', () => {
  assert.strictEqual(_mapProp('Nolan Arenado: 1+ RBIs?'), 'batter_rbis');
});

test('_mapProp — no keyword match returns null', () => {
  assert.strictEqual(_mapProp('Some Player: stolen bases?'), null);
  assert.strictEqual(_mapProp(''), null);
  assert.strictEqual(_mapProp(null), null);
});

test('_extractThreshold — floor_strike is already the half-line', () => {
  // Kalshi "1+ hits" ⇒ floor_strike 0.5, strike_type greater ⇒ Over 0.5.
  assert.strictEqual(_extractThreshold({ floor_strike: 0.5 }, []), 0.5);
  assert.strictEqual(_extractThreshold({ floor_strike: 1.5 }, []), 1.5);
});

test('_extractThreshold — whole-number strike becomes N − 0.5', () => {
  assert.strictEqual(_extractThreshold({ floor_strike: 2 }, []), 1.5);
});

test('_extractThreshold — falls back to first number in text', () => {
  assert.strictEqual(_extractThreshold({}, ['Corbin Carroll: 2+ hits?']), 1.5);
});

test('_extractThreshold — null when no strike and no number', () => {
  assert.strictEqual(_extractThreshold({}, ['no numbers here']), null);
});

test('_cents — dollar string converts to cents', () => {
  assert.strictEqual(_cents({ yes_bid_dollars: '0.6100' }, 'yes_bid'), 61);
  assert.strictEqual(_cents({ last_price_dollars: '0.0200' }, 'last_price'), 2);
});

test('_cents — empty dollar string is not a usable price', () => {
  assert.strictEqual(_cents({ yes_bid_dollars: '' }, 'yes_bid'), null);
  assert.strictEqual(_cents({}, 'yes_bid'), null);
});

test('_cents — falls back to a legacy bare-cent field', () => {
  assert.strictEqual(_cents({ yes_bid: 55 }, 'yes_bid'), 55);
});

test('_volume — reads volume_fp string float, rounded', () => {
  assert.strictEqual(_volume({ volume_fp: '0.00' }), 0);
  assert.strictEqual(_volume({ volume_24h_fp: '12.6' }), 13);
});

test('_volume — prefers legacy volume field, null when absent', () => {
  assert.strictEqual(_volume({ volume: 7 }), 7);
  assert.strictEqual(_volume({}), null);
});
