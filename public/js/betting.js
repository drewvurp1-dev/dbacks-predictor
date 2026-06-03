// Sportsbook / odds primitives: conversions, devig, Kelly, and book-name
// shorthand. All pure functions — no S, no DOM, no fetch.

import { BOOK_ABBREVS } from './constants.js';

// ── Odds-format conversions ─────────────────────────────────────────────────
// American → implied probability (returns a percentage, 0–100).
export function impliedProb(odds) {
  if (!odds) return null;
  return odds < 0 ? (-odds) / (-odds + 100) * 100 : 100 / (odds + 100) * 100;
}

// American → decimal odds (e.g. +150 → 2.50, −110 → 1.909).
export function americanToDecimal(price) {
  price = Number(price);
  if (!price) return null;
  return price > 0 ? price / 100 + 1 : 100 / Math.abs(price) + 1;
}

// ── Devig ───────────────────────────────────────────────────────────────────
// Median implied probability across an array of American prices.
export function _medianImpliedProb(prices) {
  const ps = prices.map(impliedProb).filter(x => x != null);
  if (!ps.length) return null;
  const s = [...ps].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Multiplicative (power) devig. Given raw implied probs o and u that sum to
// >1 due to vig, find exponent k such that o^k + u^k = 1. Preserves the
// *ratio of fair odds* rather than the ratio of probabilities, which is the
// more theoretically sound transformation since books typically apply vig
// multiplicatively to fair odds. Better than additive normalization for
// asymmetric overround (one side shaded).
export function devig(overPrices, underPrices) {
  if (!overPrices?.length || !underPrices?.length) return null;
  const rawO = _medianImpliedProb(overPrices);
  const rawU = _medianImpliedProb(underPrices);
  if (rawO == null || rawU == null) return null;
  const o = rawO / 100, u = rawU / 100;
  // No vig (or fair/inverted line): fall back to simple normalization to avoid
  // numerical issues with power method on near-fair markets.
  if (o + u <= 1.0001) {
    const tot = o + u;
    return { overProb: (o / tot) * 100, underProb: (u / tot) * 100 };
  }
  // Binary search for k. f(k)=o^k+u^k is monotonically decreasing for 0<o,u<1,
  // so we can bracket the root. f(1)>1 by assumption; f(3) is always <1 for
  // valid probs in this range (the alt-ladder gate at sideShare>0.85 caps
  // inputs).
  let lo = 1.0, hi = 3.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const sum = Math.pow(o, mid) + Math.pow(u, mid);
    if (sum > 1) lo = mid; else hi = mid;
  }
  const k = (lo + hi) / 2;
  return { overProb: Math.pow(o, k) * 100, underProb: Math.pow(u, k) * 100 };
}

// ── Kalshi (prediction-market) pricing ──────────────────────────────────────
// Kalshi quotes contracts in cents (1–99) where price ≈ implied probability of
// YES. There is no traditional vig — instead there's a bid/ask spread, so the
// fair no-vig probability is the bid/ask midpoint. Pass an object with any of
// { yesBid, yesAsk, noBid, noAsk, lastPrice } (cents). Returns the YES
// probability as a percentage (0–100), or null if nothing usable is present.
//
// Preference order: yes bid/ask midpoint → derive yes-side from no bid/ask
// (yes = 100 − no) → last traded price. Combining yes and no quotes when both
// exist tightens the estimate (yesAsk and 100−noBid are the two sell offers).
export function kalshiImpliedProb(q) {
  if (!q) return null;
  const c = v => (v == null || isNaN(v) ? null : Number(v));
  const yb = c(q.yesBid), ya = c(q.yesAsk);
  const nb = c(q.noBid),  na = c(q.noAsk);
  // Best YES bid/ask, folding in the no-side quotes (a no-bid of X is a yes-ask
  // of 100−X, and a no-ask of Y is a yes-bid of 100−Y).
  const bids = [yb, na != null ? 100 - na : null].filter(v => v != null);
  const asks = [ya, nb != null ? 100 - nb : null].filter(v => v != null);
  const bestBid = bids.length ? Math.max(...bids) : null;
  const bestAsk = asks.length ? Math.min(...asks) : null;
  let cents;
  if (bestBid != null && bestAsk != null) cents = (bestBid + bestAsk) / 2;
  else if (bestBid != null) cents = bestBid;
  else if (bestAsk != null) cents = bestAsk;
  else cents = c(q.lastPrice);
  if (cents == null) return null;
  return Math.max(0, Math.min(100, cents));
}

// Kalshi cents (0–100 implied prob) → American odds, so prediction-market
// prices can flow through the same display/EV path as sportsbook lines.
export function kalshiToAmerican(cents) {
  const p = Number(cents) / 100;
  if (!p || p <= 0 || p >= 1) return null;
  return p > 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

// ── Sportsbook display ──────────────────────────────────────────────────────
export function bookAbbrev(name) { return BOOK_ABBREVS[name] || name; }
