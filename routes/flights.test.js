// Unit tests for routes/flights.js pure helpers (CommonJS — server module).
// Network paths (lookupTeam, openSkyArrival) are not exercised here; these cover
// the deterministic logic the charter tracker depends on.

const test = require('node:test');
const assert = require('node:assert/strict');
const flights = require('./flights.js');

const { _nToIcao24, _destMatches, _iataToIcaoAirport, _icaoToIataAirport } = flights;

// ── N-number → ICAO 24-bit hex ───────────────────────────────────────────────
test('nToIcao24 — known Delta VIP 757 pool airframes', () => {
  assert.equal(_nToIcao24('N652DL'), 'a8947e');   // confirmed DL8876 D-backs charter
  assert.equal(_nToIcao24('N664DN'), 'a8c36d');   // confirmed pool airframe
});

test('nToIcao24 — case-insensitive, US-only', () => {
  assert.equal(_nToIcao24('n652dl'), 'a8947e');
  assert.equal(_nToIcao24('C-FXYZ'), null);       // non-US
  assert.equal(_nToIcao24(''), null);
  assert.equal(_nToIcao24(null), null);
});

// ── Destination matching (multi-airport cities) ──────────────────────────────
test('destMatches — exact and aliased airports', () => {
  assert.equal(_destMatches('STL', 'STL'), true);
  assert.equal(_destMatches('CPS', 'STL'), true);   // St. Louis Downtown
  assert.equal(_destMatches('BLV', 'STL'), true);
  assert.equal(_destMatches('PHX', 'STL'), false);
  assert.equal(_destMatches('PHX', 'PHX'), true);   // city with no aliases
  assert.equal(_destMatches('STL', null), false);
});

// ── Airport code conversion (OpenSky reports ICAO) ───────────────────────────
test('iataToIcaoAirport — US K-prefix with Canadian exception', () => {
  assert.equal(_iataToIcaoAirport('STL'), 'KSTL');
  assert.equal(_iataToIcaoAirport('CPS'), 'KCPS');
  assert.equal(_iataToIcaoAirport('PHX'), 'KPHX');
  assert.equal(_iataToIcaoAirport('YYZ'), 'CYYZ');  // Toronto
});

test('icaoToIataAirport — inverse of iataToIcaoAirport', () => {
  assert.equal(_icaoToIataAirport('KSTL'), 'STL');
  assert.equal(_icaoToIataAirport('KCPS'), 'CPS');
  assert.equal(_icaoToIataAirport('CYYZ'), 'YYZ');
  assert.equal(_icaoToIataAirport(null), null);
});
