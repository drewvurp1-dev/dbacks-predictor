// "Who's Hot? / Who's Not?" — rolling-window form math over MLB game logs.
//
// Pure math: no DOM, no fetch. Callers (ui/dashboard.js) pass already-parsed
// game arrays so this module is unit-testable alongside the other math modules.
//
// Each player's recent window (last N games) is compared to their season
// baseline via OPS swing — a standard, sample-robust read of form. A minimum
// at-bat gate in both the window and the season keeps a 2-game blip or a thin
// baseline from topping the board.

export const HOTCOLD_WINDOW = 10;   // games in the rolling window
const MIN_WINDOW_AB = 12;           // need a real sample in the window
const MIN_SEASON_AB = 30;           // …and a stable baseline to compare against
const DEFAULT_MIN_SWING = 0.060;    // OPS swing below this isn't "hot" or "cold"
const DEFAULT_TOP_N = 5;

// Pull the box-score fields we use off one gameLog split. Handles both the
// MLB shape ({ stat: {...} }) and a flat object (used by tests).
function _statOf(g) {
  const s = g.stat || g;
  return {
    ab: +s.atBats || 0, h: +s.hits || 0, hr: +s.homeRuns || 0,
    bb: +s.baseOnBalls || 0, k: +s.strikeOuts || 0, tb: +s.totalBases || 0,
    rbi: +s.rbi || 0, r: +s.runs || 0,
    d: +s.doubles || 0, t: +s.triples || 0, sb: +s.stolenBases || 0,
  };
}

// Sum a list of game splits into one aggregate.
function _agg(games) {
  const a = { ab: 0, h: 0, hr: 0, bb: 0, k: 0, tb: 0, rbi: 0, r: 0, xbh: 0, sb: 0, g: games.length, hitG: 0 };
  games.forEach(gm => {
    const s = _statOf(gm);
    a.ab += s.ab; a.h += s.h; a.hr += s.hr; a.bb += s.bb; a.k += s.k;
    a.tb += s.tb; a.rbi += s.rbi; a.r += s.r; a.xbh += s.d + s.t + s.hr; a.sb += s.sb;
    if (s.h > 0) a.hitG++;
  });
  return a;
}

// Rate stats derived from an aggregate. OBP/SLG ignore HBP/SF (not in the game
// log box score) — a close-enough OPS for a relative window-vs-season swing.
function _rates(a) {
  const pa = a.ab + a.bb || 1;
  const ab = a.ab || 1;
  const obp = (a.h + a.bb) / pa;
  const slg = a.tb / ab;
  const g = a.g || 1;
  return {
    avg: a.h / ab, obp, slg, ops: obp + slg,
    kRate: a.k / pa, kPerG: a.k / g, hPerG: a.h / g, tbPerG: a.tb / g, hrPerG: a.hr / g,
  };
}

// Analyze one player. Returns null when the sample (window or season) is too
// thin to be meaningful — those players simply don't appear on the board.
export function analyzePlayer({ id, name, games }, window = HOTCOLD_WINDOW) {
  if (!Array.isArray(games) || games.length < 5) return null;
  // gameLog splits are oldest-first; take the most-recent `window`.
  const recent = games.slice(-window);
  const wa = _agg(recent);
  const sa = _agg(games);
  if (wa.ab < MIN_WINDOW_AB || sa.ab < MIN_SEASON_AB) return null;
  const wr = _rates(wa);
  const sr = _rates(sa);
  return {
    id, name,
    window: recent.length,
    w: wa, s: sa, wr, sr,
    opsDelta: wr.ops - sr.ops,
    hitsSeries: recent.map(g => _statOf(g).h),   // per-game hits, oldest→newest (sparkline)
  };
}

// Split a roster's analyzed rows into Hot (biggest positive OPS swing) and Not
// (biggest negative), each capped at topN and gated by a minimum swing so the
// labels actually mean something.
export function computeHotCold(players, opts = {}) {
  const window = opts.window ?? HOTCOLD_WINDOW;
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const minSwing = opts.minSwing ?? DEFAULT_MIN_SWING;
  const rows = [];
  for (const p of players) {
    const r = analyzePlayer(p, window);
    if (r) rows.push(r);
  }
  const hot = rows.filter(r => r.opsDelta >= minSwing)
    .sort((a, b) => b.opsDelta - a.opsDelta).slice(0, topN);
  const cold = rows.filter(r => r.opsDelta <= -minSwing)
    .sort((a, b) => a.opsDelta - b.opsDelta).slice(0, topN);
  return { hot, cold, window, analyzed: rows.length };
}
