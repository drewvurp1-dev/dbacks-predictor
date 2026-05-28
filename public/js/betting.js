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

// ── Sportsbook display ──────────────────────────────────────────────────────
export function bookAbbrev(name) { return BOOK_ABBREVS[name] || name; }
