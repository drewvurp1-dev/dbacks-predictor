// Unit tests for utils.js — only pure functions. show/hide/setText and
// _parkFactors read the DOM and would need jsdom to exercise meaningfully.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, safeParseJSON } from './utils.js';

test('safeParseJSON — valid array round-trips', () => {
  assert.deepEqual(safeParseJSON('[{"id":1}]', []), [{ id: 1 }]);
});

test('safeParseJSON — valid object round-trips', () => {
  assert.deepEqual(safeParseJSON('{"a":1}', {}), { a: 1 });
});

test('safeParseJSON — null/missing raw returns fallback', () => {
  assert.deepEqual(safeParseJSON(null, []), []);
  assert.deepEqual(safeParseJSON(undefined, { x: 1 }), { x: 1 });
});

test('safeParseJSON — corrupt/truncated JSON returns fallback (no throw)', () => {
  // This is the bootstrap-bricking case: a truncated corbetRecord must not throw.
  assert.deepEqual(safeParseJSON('[{"id":1,"prop":"Hits"', []), []);
  assert.deepEqual(safeParseJSON('{not json', {}), {});
});

test('safeParseJSON — type mismatch against fallback shape returns fallback', () => {
  assert.deepEqual(safeParseJSON('"a string"', []), []);   // string where array expected
  assert.deepEqual(safeParseJSON('[1,2,3]', {}), {});       // array where object expected
  assert.deepEqual(safeParseJSON('null', []), []);          // null where array expected
  assert.deepEqual(safeParseJSON('42', { d: 1 }), { d: 1 });// number where object expected
});

test('parseCSV — empty input returns []', () => {
  assert.deepEqual(parseCSV(''), []);
});

test('parseCSV — single-line input returns []', () => {
  assert.deepEqual(parseCSV('only_a_header'), []);
});

test('parseCSV — simple two-column CSV', () => {
  const rows = parseCSV('a,b\n1,2\n3,4');
  assert.deepEqual(rows, [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
});

test('parseCSV — quoted fields with embedded commas', () => {
  const rows = parseCSV('name,city\n"Doe, John","New York"\n"Smith","San Diego"');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Doe, John');
  assert.equal(rows[0].city, 'New York');
  assert.equal(rows[1].name, 'Smith');
});

test('parseCSV — missing cells fill as empty string', () => {
  const rows = parseCSV('a,b,c\n1,,3');
  assert.deepEqual(rows[0], { a: '1', b: '', c: '3' });
});

test('parseCSV — strips quotes from output values', () => {
  const rows = parseCSV('x\n"hello"');
  assert.equal(rows[0].x, 'hello');
});
