// Global app state and the helpers that mutate it.
//
// S is the single mutable object shared across modules. Top-level fields
// represent everything the prediction loop / UI rendering reads. Mutations
// happen via direct property writes (S.foo = bar); player swaps go through
// enterPlayerContext / exitPlayerContext below to stay atomic and reversible.
//
// charter.js (still a classic script) reads `window.S`, so we re-attach S to
// window at module load. DEBUG / log are exported too.

// ── Persisted reads (run at module load) ────────────────────────────────────
// Repair any duplicate IDs from a prior bug where autoSaveTopBets used the
// same Date.now() timestamp; also derive `rating` for legacy entries that
// stored it as undefined.
function _loadBetLog() {
  const list = JSON.parse(localStorage.getItem('corbetRecord') || '[]');
  const seen = new Set();
  let repaired = false;
  list.forEach((b, i) => {
    if (seen.has(b.id)) { b.id = Date.now() + i; repaired = true; }
    seen.add(b.id);
    if (!['green', 'yellow', 'red'].includes(b.rating)) {
      b.rating = b.ev >= 0.12 ? 'green' : b.ev >= 0.06 ? 'yellow' : b.ev >= 0.02 ? 'red' : 'yellow';
      repaired = true;
    }
  });
  if (repaired) localStorage.setItem('corbetRecord', JSON.stringify(list));
  return list;
}

function _loadRecordSort() {
  try {
    const s = JSON.parse(localStorage.getItem('corbetRecordSort'));
    if (s && s.key && s.dir) return s;
  } catch (e) { /* fall through */ }
  return { key: 'date', dir: 'desc' };
}

// ── State object ────────────────────────────────────────────────────────────
export const S = {
  splits: null, seasonStat: null, rispStat: null,
  playerName: 'Corbin Carroll', playerId: '682998',
  pitcher: null, pitcherThrows: 'R',
  pitcherPitches: { '4-Seam FB': 40, 'Slider': 25, 'Changeup': 20, 'Curveball': 15, 'Sinker': 0, 'Cutter': 0, 'Splitter': 0 },
  isHome: true, dayGame: false, roofClosed: true,
  weather: null, umpire: null, weatherManual: false, pitcherManual: false,
  matchupStats: null,
  lineupProtection: { tier: 'average', avgOps: null, spots: [], manual: true },
  lineupRoster: null,
  recentGameLog: null,
  lastScore: null, lastPrediction: null,
  recordSort: _loadRecordSort(),
  betLog: _loadBetLog(),
};

// charter.js (classic script) reads window.S directly. ES module top-level
// declarations don't auto-attach to window, so we expose it explicitly here.
// The inline-handler exports block in app.js also re-exposes S; this assignment
// just ensures charter.js sees S even if it loads before app.js's export block.
window.S = S;

// ── Gated debug logger ──────────────────────────────────────────────────────
// Opt in via `?debug=1` query param or `localStorage.debug = '1'`.
// Keeps trace output available without spamming the console in production.
export const DEBUG = (() => {
  try {
    return new URLSearchParams(location.search).has('debug')
        || localStorage.getItem('debug') === '1';
  } catch (e) { return false; }
})();

export const log = (...args) => { if (DEBUG) console.log(...args); }; // eslint-disable-line no-console

// ── Player-context transaction (used by modal openers) ──────────────────────
// Modal openers swap a subset of S into the selected player's snapshot so
// render code can read S.* uniformly. closeModal() restores the outer state.
// Atomic, idempotent, and re-entry-safe.

export const PLAYER_CONTEXT_KEYS = [
  'playerName', 'playerId', 'splits', 'seasonStat', 'rispStat',
  'statcast', 'recentGameLog', 'matchupStats', 'lastScore', 'currentOrder',
];

let _activeContext = null;

export function enterPlayerContext(playerId) {
  const p = S.players?.[playerId];
  if (!p) return null;
  // Re-entry: restore outer first so its state isn't permanently lost.
  if (_activeContext) _activeContext.restore();
  const saved = {};
  for (const k of PLAYER_CONTEXT_KEYS) saved[k] = S[k];
  S.playerName    = p.name;
  S.playerId      = playerId;
  S.splits        = p.splits;
  S.seasonStat    = p.seasonStat;
  S.rispStat      = p.rispStat;
  S.statcast      = p.statcast;
  S.recentGameLog = p.recentGameLog;
  S.matchupStats  = p.matchupStats;
  S.lastScore     = p.score;
  S.currentOrder  = p.order;
  let restored = false;
  _activeContext = {
    snap: p,
    restore() {
      if (restored) return;
      restored = true;
      Object.assign(S, saved);
      if (_activeContext && _activeContext.restore === this.restore) _activeContext = null;
    },
  };
  return _activeContext;
}

export function exitPlayerContext() {
  _activeContext?.restore();
}
