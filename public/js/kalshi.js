// Kalshi prediction-market edge scanner.
//
// Kalshi is an exchange: its MLB player-prop contracts price in cents that equal
// the market's implied probability of YES, with a bid/ask spread instead of
// sportsbook vig. That makes a clean "true probability" reference — comparing
// Kalshi's no-vig YES probability to Snake Savant's model probability surfaces
// genuinely mispriced lines.
//
// This module is deliberately SELF-CONTAINED and ADDITIVE: it renders into its
// own panel and never touches the CorBET prop pipeline, so it cannot destabilize
// the working sportsbook flow. If Kalshi returns nothing (or the deployment's
// network policy blocks api.elections.kalshi.com), the panel shows an empty
// state and everything else is unaffected.
//
// Verified against the live API (2026-06). Confirmed shape, per game-event:
//   event.title     "Los Angeles D vs Arizona: Hits"   (series = one stat)
//   market.title    "Corbin Carroll: 1+ hits?"         (player + threshold)
//   market.floor_strike  0.5 / 1.5 / 2.5 …  (already the half-line; strike_type
//                        "greater" ⇒ Over floor_strike)
//   market.{yes,no}_{bid,ask}_dollars  "0.6100"  (DOLLARS 0–1, ×100 for cents)
//   market.last_price_dollars, volume_fp / volume_24h_fp
// Per-game player-prop series: KXMLBHIT, KXMLBHR, KXMLBTB, KXMLBHRR, KXMLBKS,
// KXMLBRBI (see KALSHI_SERIES_CANDIDATES). The scanner still logs every market
// it sees, so console output remains the first stop if the shape shifts again.

import { S, activeRoster, log } from './state.js';
import { KALSHI_SERIES_CANDIDATES, KALSHI_STAT_MAP, PROP_NAMES } from './constants.js';
import { kalshiImpliedProb, kalshiToAmerican, americanToDecimal } from './betting.js';
import { modelProbability } from './predict.js';
import * as api from './api.js';
import { show, hide } from './utils.js';

// ── Discovery ────────────────────────────────────────────────────────────────
// Find the MLB player-prop series tickers. Primary path: pull the Sports series
// list and keep any whose title maps to a batter prop. Fallback: the hardcoded
// candidate tickers (used if the series list is empty/blocked).
async function _discoverSeries() {
  const tickers = new Set();
  try {
    const res = await api.kalshiSeriesList('Sports');
    const list = res?.series || res?.data || [];
    for (const s of list) {
      const title = (s.title || s.name || '').toLowerCase();
      const ticker = s.ticker || s.series_ticker;
      if (!ticker) continue;
      const isMLB = /mlb|baseball/.test(title) || /^kxmlb/i.test(ticker);
      if (isMLB && _mapProp(title)) tickers.add(ticker);
    }
    log('[kalshi] discovered series from list:', [...tickers].join(', ') || 'none');
  } catch (e) {
    log('[kalshi] series list unavailable:', e.message);
  }
  KALSHI_SERIES_CANDIDATES.forEach(t => tickers.add(t));
  return [...tickers];
}

// ── Field extraction (defensive — see VERIFY-ON-LIVE-DATA note above) ─────────

// Map a market/event title to a prop key via the keyword table. Keywords match
// on a leading word boundary so a substring buried in a player name can't
// false-positive — e.g. "Corbin" contains "rbi", which would otherwise tag a
// hits market as RBI (confirmed against live titles).
function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function _mapProp(title) {
  const t = (title || '').toLowerCase();
  for (const { propKey, keywords } of KALSHI_STAT_MAP) {
    if (keywords.every(k => new RegExp('\\b' + _escapeRe(k)).test(t))) return propKey;
  }
  return null;
}

// Pull the player full name out of the market/event text by matching against the
// active roster — robust to whatever Kalshi puts in title vs subtitle.
function _extractPlayerName(texts) {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  for (const p of activeRoster()) {
    const full = p.name.toLowerCase();
    if (hay.includes(full)) return p;
    const parts = full.split(/\s+/);
    const last = parts[parts.length - 1];
    const init = parts[0]?.[0] || '';
    // "K. Marte" / "K Marte" abbreviated form, scoped to this exact player.
    const re = new RegExp('(^|\\s)' + init + '\\.?\\s+' + last + '(\\s|$|,|\\?)', 'i');
    if (re.test(hay)) return p;
  }
  return null;
}

// Pull the over/under threshold (a Snake Savant line is strike − 0.5: Kalshi
// "2+ hits" YES == Over 1.5). Prefer the structured strike field; fall back to
// the first number in the text.
export function _extractThreshold(market, texts) {
  const strike = market.floor_strike ?? market.cap_strike ?? market.strike;
  let n = strike != null ? Number(strike) : NaN;
  if (isNaN(n)) {
    const m = (texts.filter(Boolean).join(' ')).match(/(\d+(?:\.\d+)?)\s*\+?/);
    if (m) n = Number(m[1]);
  }
  if (isNaN(n)) return null;
  // Whole-number "N or more" → Over (N − 0.5). Already-half lines pass through.
  return Number.isInteger(n) ? n - 0.5 : n;
}

// ── Model probability for a Kalshi line ──────────────────────────────────────
// Reuses the per-player snapshot computed during the CorBET pass (S.players) by
// temporarily swapping S into that player's stat context — the same dance the
// CorBET loop does — then calling modelProbability. Returns the OVER (== YES)
// probability as a percentage, or null if the player wasn't scored.
function _modelYesProb(playerId, propKey, line) {
  const snap = S.players?.[playerId];
  if (!snap || snap.score == null) return null;
  const saved = {
    seasonStat: S.seasonStat, splits: S.splits, matchupStats: S.matchupStats,
    statcast: S.statcast, recentGameLog: S.recentGameLog, currentOrder: S.currentOrder,
  };
  try {
    S.seasonStat = snap.seasonStat; S.splits = snap.splits; S.matchupStats = snap.matchupStats;
    S.statcast = snap.statcast; S.recentGameLog = snap.recentGameLog; S.currentOrder = snap.order;
    return modelProbability(propKey, line, snap.score, {});
  } catch (e) {
    log('[kalshi] model prob failed for', playerId, propKey, line, '—', e.message);
    return null;
  } finally {
    Object.assign(S, saved);
  }
}

// Kalshi's live market objects quote prices in DOLLARS (0–1) under `_dollars`
// fields (e.g. yes_bid_dollars: "0.6100"), not the integer-cent fields the
// scanner originally assumed. Read the dollar field and scale to cents (the
// unit kalshiImpliedProb expects), falling back to any legacy bare-cent field.
export function _cents(mk, key) {
  const d = mk[key + '_dollars'];
  if (d != null && d !== '') { const n = Number(d); if (!isNaN(n)) return n * 100; }
  const c = mk[key];
  if (c != null && c !== '') { const n = Number(c); if (!isNaN(n)) return n; }
  return null;
}

// Traded volume — live markets expose `volume_fp` / `volume_24h_fp` (string
// floats); older shapes used `volume` / `volume_24h`. First usable one wins.
export function _volume(mk) {
  for (const k of ['volume', 'volume_24h', 'volume_fp', 'volume_24h_fp']) {
    const v = mk[k];
    if (v != null && v !== '') { const n = Number(v); if (!isNaN(n)) return Math.round(n); }
  }
  return null;
}

// ── Scan ─────────────────────────────────────────────────────────────────────
// Returns an array of edge rows for D-backs roster players found on Kalshi.
async function _scan() {
  const tickers = await _discoverSeries();
  const rows = [];
  const seen = new Set();
  for (const ticker of tickers) {
    let events;
    try {
      const res = await api.kalshiEvents(ticker, 'open');
      events = res?.events || res?.data || [];
    } catch (e) {
      log('[kalshi] events fetch failed for', ticker, '—', e.message);
      continue;
    }
    for (const ev of events) {
      const evTexts = [ev.title, ev.sub_title, ev.subtitle];
      const markets = ev.markets || ev.nested_markets || [];
      for (const mk of markets) {
        const texts = [mk.title, mk.subtitle, mk.no_sub_title, mk.yes_sub_title, mk.yes_subtitle, ...evTexts];
        log('[kalshi] market:', JSON.stringify({ t: mk.ticker, title: mk.title, sub: mk.yes_sub_title, strike: mk.floor_strike, yb: mk.yes_bid_dollars }));
        const propKey = _mapProp(texts.join(' '));
        if (!propKey || !PROP_NAMES[propKey]) continue;
        const player = _extractPlayerName(texts);
        if (!player) continue;
        const line = _extractThreshold(mk, texts);
        if (line == null) continue;

        const kalshiYes = kalshiImpliedProb({
          yesBid: _cents(mk, 'yes_bid'), yesAsk: _cents(mk, 'yes_ask'),
          noBid: _cents(mk, 'no_bid'), noAsk: _cents(mk, 'no_ask'),
          lastPrice: _cents(mk, 'last_price'),
        });
        if (kalshiYes == null) continue;

        const dedupeKey = player.id + '|' + propKey + '|' + line;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const modelYes = _modelYesProb(player.id, propKey, line);
        const edge = modelYes != null ? modelYes - kalshiYes : null; // +ve → YES underpriced
        // Bet the side the model favors vs the market; EV at Kalshi's price.
        let ev = null, direction = null, price = null;
        if (modelYes != null) {
          direction = edge >= 0 ? 'Over' : 'Under';
          const cents = direction === 'Over' ? kalshiYes : 100 - kalshiYes;
          price = kalshiToAmerican(cents);
          const dec = price != null ? americanToDecimal(price) : null;
          const winProb = (direction === 'Over' ? modelYes : 100 - modelYes) / 100;
          if (dec) ev = winProb * (dec - 1) - (1 - winProb);
        }
        rows.push({
          player: player.name, prop: PROP_NAMES[propKey], propKey, line,
          kalshiYes, modelYes, edge, direction, ev,
          price, volume: _volume(mk), ticker: mk.ticker,
        });
      }
    }
  }
  rows.sort((a, b) => (Math.abs(b.ev ?? 0) - Math.abs(a.ev ?? 0)) || (Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0)));
  return rows;
}

// ── Render ───────────────────────────────────────────────────────────────────
function _evClass(ev) {
  if (ev == null) return 'none';
  return ev >= 0.12 ? 'strong' : ev >= 0.06 ? 'moderate' : ev >= 0.02 ? 'small' : 'none';
}
const _COLORS = { strong: '#2ecc71', moderate: '#5bc0de', small: '#f39c12', none: '#666' };

function _rowHtml(r) {
  const cls = _evClass(r.ev);
  const edgeTxt = r.edge != null ? (r.edge >= 0 ? '+' : '') + r.edge.toFixed(1) + ' pp' : '—';
  const evTxt = r.ev != null ? (r.ev >= 0 ? '+' : '') + (r.ev * 100).toFixed(1) + '%' : '—';
  const modelTxt = r.modelYes != null ? r.modelYes.toFixed(0) + '%' : 'n/a';
  const priceTxt = r.price != null ? (r.price > 0 ? '+' : '') + r.price : '—';
  const pick = r.direction ? `${r.direction} ${r.line}` : `O/U ${r.line}`;
  return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid #1e2d3a;border-left:3px solid ${_COLORS[cls]};border-radius:6px;background:#0c1018;margin-bottom:6px;font-family:'Chakra Petch',monospace;font-size:12px;">
    <div style="flex:1;min-width:0;">
      <div style="color:#dfe7ef;font-weight:600;">${r.player} · ${r.prop}</div>
      <div style="color:#7d8a98;font-size:10px;">${pick} @ Kalshi ${priceTxt}${r.volume != null ? ' · vol ' + r.volume : ''}</div>
    </div>
    <div style="text-align:right;"><div style="color:#9fb0c0;font-size:9px;">KALSHI</div><div style="color:#dfe7ef;">${r.kalshiYes.toFixed(0)}%</div></div>
    <div style="text-align:right;"><div style="color:#9fb0c0;font-size:9px;">MODEL</div><div style="color:#dfe7ef;">${modelTxt}</div></div>
    <div style="text-align:right;"><div style="color:#9fb0c0;font-size:9px;">EDGE</div><div style="color:${_COLORS[cls]};">${edgeTxt}</div></div>
    <div style="text-align:right;min-width:54px;"><div style="color:#9fb0c0;font-size:9px;">EV</div><div style="color:${_COLORS[cls]};font-weight:700;">${evTxt}</div></div>
  </div>`;
}

// ── Public entry ─────────────────────────────────────────────────────────────
// Scans Kalshi and renders the edge panel. Safe to call repeatedly; a no-op-on-
// failure (logs + empty state) so it never blocks the CorBET flow.
export async function loadKalshiEdges() {
  const bets = document.getElementById('kalshi-bets');
  const empty = document.getElementById('kalshi-empty');
  if (!bets) return; // panel not present
  hide('kalshi-empty'); show('kalshi-loading');
  try {
    const rows = await _scan();
    hide('kalshi-loading');
    if (!rows.length) {
      bets.innerHTML = '';
      if (empty) { empty.textContent = 'No Kalshi MLB player-prop markets matched D-backs players (coverage is sparse, or the market isn’t up yet).'; show('kalshi-empty'); }
      return;
    }
    const withEdge = rows.filter(r => r.ev != null);
    bets.innerHTML = rows.map(_rowHtml).join('');
    show('kalshi-bets');
    log('[kalshi] rendered', rows.length, 'markets,', withEdge.length, 'with model edge');
  } catch (e) {
    hide('kalshi-loading');
    if (empty) { empty.textContent = '⚠ Kalshi scan failed: ' + e.message; show('kalshi-empty'); }
    log('[kalshi] scan error:', e.message);
  }
}
