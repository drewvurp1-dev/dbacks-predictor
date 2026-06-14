import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePlayer, computeHotCold, HOTCOLD_WINDOW } from './hotcold.js';

// Build a list of `n` identical games with the given per-game line.
function games(n, line) {
  return Array.from({ length: n }, () => ({ stat: { ...line } }));
}

const HOT_GAME = { atBats: 4, hits: 2, totalBases: 5, homeRuns: 1, baseOnBalls: 1, strikeOuts: 0 };
const COLD_GAME = { atBats: 4, hits: 0, totalBases: 0, homeRuns: 0, baseOnBalls: 0, strikeOuts: 3 };
const AVG_GAME = { atBats: 4, hits: 1, totalBases: 1, homeRuns: 0, baseOnBalls: 0, strikeOuts: 1 };

test('analyzePlayer returns null when the season sample is too thin', () => {
  // 6 games × 4 AB = 24 AB < MIN_SEASON_AB (30)
  const r = analyzePlayer({ id: 1, name: 'Thin', games: games(6, AVG_GAME) });
  assert.equal(r, null);
});

test('analyzePlayer returns null below the 5-game floor', () => {
  assert.equal(analyzePlayer({ id: 1, name: 'X', games: games(4, HOT_GAME) }), null);
});

test('analyzePlayer windows to the most-recent N games', () => {
  // 20 cold games then 10 hot games — the window should see only the hot tail.
  const log = [...games(20, COLD_GAME), ...games(10, HOT_GAME)];
  const r = analyzePlayer({ id: 7, name: 'Surger', games: log });
  assert.equal(r.window, HOTCOLD_WINDOW);
  assert.equal(r.w.hr, 10);          // 10 hot games × 1 HR
  assert.equal(r.w.hitG, 10);        // a hit in every window game
  assert.ok(r.opsDelta > 0);         // recent OPS well above the cold-heavy baseline
  assert.equal(r.hitsSeries.length, 10);
});

test('hitsSeries is oldest→newest within the window', () => {
  const log = [...games(25, AVG_GAME), { stat: { atBats: 4, hits: 3, totalBases: 4 } }];
  const r = analyzePlayer({ id: 9, name: 'Tail', games: log });
  assert.equal(r.hitsSeries[r.hitsSeries.length - 1], 3); // newest game last
});

test('computeHotCold sorts hot by descending swing and cold by ascending', () => {
  const baseline = games(30, AVG_GAME);
  const players = [
    { id: 1, name: 'Blazing', games: [...baseline, ...games(10, HOT_GAME)] },
    { id: 2, name: 'Slumping', games: [...games(10, HOT_GAME), ...games(30, COLD_GAME)] },
    { id: 3, name: 'Steady', games: games(40, AVG_GAME) },
  ];
  const { hot, cold } = computeHotCold(players);
  assert.equal(hot[0].name, 'Blazing');
  assert.equal(cold[0].name, 'Slumping');
  // Steady's swing is ~0 → excluded from both lists by the min-swing gate.
  assert.ok(!hot.some(r => r.name === 'Steady'));
  assert.ok(!cold.some(r => r.name === 'Steady'));
});

test('computeHotCold respects topN', () => {
  const baseline = games(30, AVG_GAME);
  const players = Array.from({ length: 8 }, (_, i) => ({
    id: i, name: `H${i}`, games: [...baseline, ...games(10, HOT_GAME)],
  }));
  const { hot } = computeHotCold(players, { topN: 3 });
  assert.equal(hot.length, 3);
});

test('computeHotCold skips players with insufficient data', () => {
  const players = [
    { id: 1, name: 'NoData', games: [] },
    { id: 2, name: 'Hot', games: [...games(30, AVG_GAME), ...games(10, HOT_GAME)] },
  ];
  const { hot, analyzed } = computeHotCold(players);
  assert.equal(analyzed, 1);
  assert.equal(hot[0].name, 'Hot');
});
