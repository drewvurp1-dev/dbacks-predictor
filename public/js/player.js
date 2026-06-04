// Player-stat utilities. PA estimation, probability primitives (Poisson,
// binomial, total-bases convolution), Bayesian shrinkage, log-5 combine,
// and helpers that read S to derive the active player's context.
//
// The big consumers (modelProbability, monteCarloConfidence) stay in
// app.js for now — they orchestrate everything below plus weather/park
// state and are easier to move alongside the UI extraction in PR4f.

import { S } from './state.js';
import { _parkFactors } from './utils.js';

// ── Probability primitives ──────────────────────────────────────────────────
export function _factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
export function _poissonCDF(lambda, k) {
  let p = 0;
  for (let i = 0; i <= k; i++) p += Math.pow(lambda, i) * Math.exp(-lambda) / _factorial(i);
  return p;
}

// ── Negative-binomial tail — P(X > k) for an overdispersed count ─────────────
// Per-game RBI and Runs are CLUMPY: most games a hitter has zero opportunity
// (no men on, doesn't come around to score), then occasionally a multi-RBI
// burst. A Poisson with the season mean understates the zero-mass and so
// overstates P(≥1) — at the RBI league mean λ≈0.43 Poisson gives 34.9% but the
// empirical ≥1-RBI rate is ~30%. The negative binomial adds a dispersion
// parameter `r` (smaller r = more overdispersion / fatter zero); as r→∞ it
// collapses to the Poisson. We parameterize by the same mean `lambda` so the
// branch's PA-scaling and run-environment multiplier still feed in unchanged.
//
//   X ~ NB(r, p) with p = r/(r+lambda), mean = lambda
//   P(X = i) = C(i+r-1, i) · p^r · (1-p)^i
//
// Returns P(X > k) = 1 − Σ_{i=0..k} P(X=i), matching the Poisson props'
// 1−CDF(floor(line)) = P(X > floor(line)) convention so the threshold semantics
// are identical — only the distribution shape changes. Falls back to the
// Poisson tail when r is non-finite or non-positive.
export function _negBinomTailGT(lambda, r, k) {
  if (!(r > 0) || !isFinite(r)) return 1 - _poissonCDF(lambda, k);
  if (lambda <= 0) return 0;
  const p = r / (r + lambda);
  // P(X=0) = p^r; recur P(X=i) = P(X=i-1) · (i+r-1)/i · (1-p).
  let term = Math.pow(p, r);
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    term *= ((i + r - 1) / i) * (1 - p);
    cdf += term;
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// ── Expected plate appearances per game ─────────────────────────────────────
// Expected plate appearances for the batter in this game. Drives binomial K/BB
// probabilities directly, and a PA-vs-league multiplier (see _paMultiplier) for
// hits/TB/runs/RBI props whose lerp3 anchors are calibrated to league-average PAs.
//
// Three layered effects:
//   1. Lineup spot (biggest signal): top of order gets ~25% more PAs than bottom.
//   2. Home/away: home team in a winning game state doesn't bat in the bottom 9.
//      Empirically ~0.08 fewer PA/spot for the home team across a season.
//   3. Run environment: hits/baserunners beget more PAs for the whole lineup.
//      Estimated from opposing-pitcher WHIP + park hit/HR factors. Skipped on
//      bullpen games since the listed pitcher's WHIP isn't representative.
export function _gamePAs() {
  const o = S.currentOrder;
  // Base PA by lineup spot — calibrated for an average 38-team-PA game.
  // Default 4.2 (population mean) when order is unknown.
  let pa;
  if (!o) pa = 4.2;
  else if (o <= 2) pa = 4.6;
  else if (o <= 4) pa = 4.4;
  else if (o <= 6) pa = 4.2;
  else if (o <= 7) pa = 4.0;
  else pa = 3.7;

  // Home team gets slightly fewer PAs on average — home team in the lead entering
  // the bottom of the 9th doesn't bat. Spread across ~25% of games.
  if (S.isHome) pa -= 0.08;

  // Run environment: more baserunners = more PAs across the order. Apply as a
  // multiplier on the base PA so each spot scales proportionally with team PAs.
  if (!S.pitcher?.bullpenGame) {
    const { hitF, hasRoof } = _parkFactors();
    const rfClosed = hasRoof && S.roofClosed;
    // Park run factor — pure hitF (hits drive baserunners and PAs). hrF was
    // previously blended in (0.3 weight) but that triple-counted park HR effects:
    // park already enters via calcPrediction's score factor and again as a direct
    // ±5pp prop adjustment in modelProbability. Pure hitF keeps the run-environment
    // signal without compounding HR effects three ways.
    const parkRunF = rfClosed ? 1.0 : hitF;
    // WHIP delta — league avg ~1.30. Elite 1.00 → -3% PAs, poor 1.50 → +2% PAs.
    const whip = parseFloat(S.pitcher?.stEff?.whip ?? S.pitcher?.st?.whip);
    const pitcherPaF = isFinite(whip) ? 1.0 + (whip - 1.30) * 0.10 : 1.0;
    const env = parkRunF * pitcherPaF;
    // Cap the combined multiplier at ±8% to keep extreme matchups from compounding.
    pa *= Math.max(0.92, Math.min(1.08, env));
  }

  return pa;
}

// PA multiplier vs league average — used to scale hits/TB/runs/RBI projections
// whose lerp3 anchors assume a league-average ~4.2 PA game. Returns 1.0 when no
// signal is available so callers can multiply unconditionally.
export function _paMultiplier() {
  return _gamePAs() / 4.2;
}

// ── Player's own season PA-per-game ─────────────────────────────────────────
// The reference PA volume for scaling a player's per-game RBI/Runs/H+R+RBI rate
// to TODAY's expected PAs. Those season rates are already PA-loaded — a leadoff
// hitter's RBI/G was earned over games where he averaged ~4.6 PA — so scaling
// them by gamePAs/4.2 (league average) double-counts PA volume and inflates the
// run-scoring props by up to ~10% for the top of the order. Dividing by the
// player's OWN PA/G instead makes the factor ~1.0 when he bats his usual spot
// and only moves it for a genuine promotion/demotion (or a part-timer who is
// starting today). Clamped to a sane range; falls back to the league 4.2 for
// thin samples where PA/G isn't yet stable.
export function _seasonPAperG(ss) {
  const pa = parseInt(ss?.plateAppearances) || 0;
  const gp = parseInt(ss?.gamesPlayed) || 0;
  if (gp < 10 || pa <= 0) return 4.2;
  return Math.max(3.4, Math.min(4.9, pa / gp));
}

// ── Times-Through-the-Order adjustment ──────────────────────────────────────
// Hitters perform noticeably better the more times they see a starter (~+30 pts
// wOBA on 3rd TTO). Top-of-order batters get more TTO3 exposure when starters
// go 5+ innings; bottom-of-order batters get the fewest 3rd looks and face fresh
// relievers sooner. Bullpen games dilute the effect since hitters face fresh
// arms each turn through.
//
// CENTERED on the lineup average so it carries NO standing offset: the old
// version returned {+2, +1, 0} (never negative), which added an uncountered
// OVER push to ~2/3 of the lineup on Hits/TB/HR/HRR every game even though the
// market already prices TTO. Re-centering to {+1, 0, −1} preserves the SAME
// relative familiarity ordering (top > middle > bottom) while summing to ~0
// across the nine spots, so it stops manufacturing a population-wide Over lean.
export function _ttopBonus() {
  if (S.pitcher?.bullpenGame) return 0;
  const o = S.currentOrder;
  if (!o) return 0;
  if (o <= 3) return 1;   // most TTO3 exposure — relative familiarity edge
  if (o <= 6) return 0;   // average TTO exposure — neutral
  return -1;              // bottom of order: fewest 3rd looks, sees relievers sooner
}

// ── H+R+RBI projection ──────────────────────────────────────────────────────
// These three events are positively correlated (a hit often produces a run or
// RBI; HRs produce all three), so summing rates and feeding to a single Poisson
// understates variance and biases OVER probability high. When we have ≥10
// recent games WITH ACTUAL PLATE APPEARANCES, use the empirical CDF directly —
// it captures the real joint distribution. Otherwise fall back to the
// summed-rate Poisson with the caveat that it's biased.
//
// The plate-appearance filter is critical for sporadic players (backup catchers,
// utility bats, defensive subs). Without it, zero-PA appearances in the recent
// log — late-inning defensive replacements, pinch-running cameos, days where
// the player pinch-hit and walked but otherwise sat — encode as "0 H+R+RBI"
// outcomes and crush the Over probability. A starting backup catcher with a 30%
// recent appearance rate at full PA can have his Over 0.5 probability deflated
// from ~60% to ~20% by this alone, which is exactly the failure mode we hit on
// Del Castillo 2026-05-25.
// Negative-binomial dispersion for the clumpy per-game H+R+RBI count (see the
// in-body comment for the rationale). Smaller r = more overdispersion / more
// correction away from Poisson.
const HRR_NB_DISPERSION = 5;
export function _hrrOverPct(line, ss, recentLog, gamePAs, runEnvMult = 1) {
  const k = Math.floor(line);
  // Always compute the Poisson estimate — it's both the no-data fallback AND
  // the Bayesian prior we shrink the empirical CDF toward. The summed-rate
  // Poisson is biased high (events are correlated within a game), but it's a
  // reasonable mean-of-population prior at the rate level we care about.
  // runEnvMult folds in the opposing pitcher's run environment (see
  // _pitcherRunEnvMult) — the R and RBI components of H+R+RBI are otherwise
  // pitcher-blind. It scales the Poisson mean, and since the empirical CDF is
  // shrunk toward that mean, it propagates partially through the empirical path too.
  // Scale by today's expected PAs vs the player's OWN season PA/G (not league
  // 4.2) — the summed H+R+RBI rate is already PA-loaded, so /4.2 double-counts
  // volume for the top of the order. See _seasonPAperG.
  const paMult = gamePAs ? gamePAs / _seasonPAperG(ss) : 1.0;
  const totalHRR = (parseInt(ss?.hits) || 0) + (parseInt(ss?.runs) || 0) + (parseInt(ss?.rbi) || 0);
  const hrrPG = _shrunkRate(totalHRR, parseInt(ss?.gamesPlayed) || 0, 1.6, 60) * paMult * runEnvMult;
  // Negative binomial (not Poisson) on the per-game H+R+RBI rate. H, R, and RBI
  // are positively correlated WITHIN a game (a hit often produces a run or an
  // RBI; a HR produces all three), so the summed-rate count is overdispersed —
  // a Poisson at the summed mean understates the zero/low mass and overstates
  // P(≥k), biasing the prop OVER. This was the dominant bias whenever there were
  // <5 recent games with PA (pure-prior path) and also lifted the shrink target
  // on the empirical path. r=5 is between Runs (r=4, mildly clumpy) and RBI
  // (r=1.3, very clumpy), reflecting that the sum is moderately overdispersed.
  // _negBinomTailGT returns P(X > k) = the same threshold semantics as the old
  // 1−poissonCDF(k), so only the distribution shape changes.
  const poissonOver = _negBinomTailGT(hrrPG, HRR_NB_DISPERSION, k) * 100;
  if (recentLog?.length) {
    const playedGames = recentLog.filter(g => (parseInt(g.stat?.plateAppearances) || parseInt(g.stat?.atBats) || 0) > 0);
    if (playedGames.length >= 5) {
      const counts = playedGames.map(g => (parseInt(g.stat?.hits) || 0) + (parseInt(g.stat?.runs) || 0) + (parseInt(g.stat?.rbi) || 0));
      const cnt = counts.filter(c => c > k).length;
      const empOver = (cnt / playedGames.length) * 100;
      // Bayesian-shrink the empirical CDF toward the Poisson prior with a 15-game
      // pseudo-prior weight. Keeps a 10-game cold streak from dominating the
      // projection — a sporadic catcher with empirical 40% but per-PA bottom-up
      // 60% shrinks to ~55% instead of trusting the noisy 40% directly. Threshold
      // lowered from 10 → 5 games since the shrinkage now provides regularization.
      return (playedGames.length * empOver + 15 * poissonOver) / (playedGames.length + 15);
    }
  }
  return poissonOver;
}

// ── Bayesian shrinkage ──────────────────────────────────────────────────────
// Shrink a player rate toward league average using Bayesian-style mixing.
// `numerator` and `denominator` are the player's totals (e.g., walks / PA).
// `priorN` is the "equivalent prior observations" — higher = more shrinkage.
// For 30-PA player with priorN=60, shrinkage weights player rate 33% vs 67%
// league. For 500-PA player with priorN=60, player rate gets 89% weight.
// Stable for vets, regression-aware for callups.
export function _shrunkRate(numerator, denominator, leagueAvg, priorN) {
  if (!denominator || denominator <= 0) return leagueAvg;
  const n = denominator;
  return (numerator + priorN * leagueAvg) / (n + priorN);
}

// ── Opposing-pitcher run-environment multiplier ─────────────────────────────
// RBI / Runs / H+R+RBI projections are built from the BATTER's own per-game rate
// scaled by lineup PAs. Left alone they are nearly pitcher-blind — only WHIP
// nudges expected PAs (±8%), so a run-producer keeps essentially his full season
// rate whether he faces an ace or a batting-practice arm. Hits/TB/HR/K/BB all
// fold in the pitcher via log-5; this gives the run-scoring props the same hook.
//
// Returns a multiplier on the per-game run rate: <1 suppresses (facing a good
// arm), >1 inflates. Driven by two pitcher signals computed from the season line:
//   • on-base-against  (h+bb)/BF — baserunners ahead of the hitter, league ~.315
//   • slugging-against TB/AB      — extra-base / drive-in environment, league ~.400
// Both Bayesian-shrunk to league (priorN=120; rate-against stabilizes slowly,
// but a 200 prior flattened genuine aces to league-average and was a primary
// cause of the model's phantom Over edges), then combined as a PRODUCT of the
// two league-relative ratios — run scoring follows the runs-created form
// (Runs ∝ OBP × SLG), not a weighted average. The old 60/40 arithmetic mean was
// far too flat: a genuinely good arm (~.278 BAA, sub-1.10 WHIP) suppressed RBIs
// only ~10%, so the model stayed high on run-scoring props against good pitching
// while the market correctly discounted them — exactly the chronic RBI-Over
// over-recommendation. The product lands the same arm near −20%, matching how a
// good starter actually deflates team run scoring, and symmetrically inflates
// weak arms. Clamped to [0.65, 1.25] so a small-sample line can't dominate, and
// gated behind a 50-BF minimum. Bullpen games blend 40% toward league since the
// listed arm isn't representative of who the hitters face.
//
// Note: the "score" composite (calcPrediction) already reflects pitcher quality,
// but at only 40% blend weight and via general ERA/SIERA/whiff factors — the same
// dual-sourcing the log-5 props already have (pitcher in both score AND rate). So
// this keeps the run-scoring props consistent with the rest, not double-counting
// beyond what every other prop already does.
export function _pitcherRunEnvMult() {
  // Venue-blended line (home/road split shrunk into the season aggregate; see
  // pitcher.js _blendVenueLine) so the run-environment multiplier reflects where
  // the pitcher is actually throwing. Falls back to the raw season line.
  const pst = S.pitcher?.stEff || S.pitcher?.st;
  if (!pst) return 1.0;
  const bf = parseInt(pst.battersFaced) || 0;
  if (bf < 50) return 1.0;                       // too little data to trust
  const h   = parseInt(pst.hits) || 0;
  const bb  = parseInt(pst.baseOnBalls) || 0;
  const hr  = parseInt(pst.homeRuns) || 0;
  const dbl = parseInt(pst.doubles) || 0;
  const trp = parseInt(pst.triples) || 0;
  const ab  = parseInt(pst.atBats) || bf;
  const singles = Math.max(0, h - hr - dbl - trp);
  const obA  = _shrunkRate(h + bb, bf, 0.315, 120);
  const slgA = _shrunkRate(singles + 2 * dbl + 3 * trp + 4 * hr, ab || 1, 0.400, 120);
  // Product (runs-created) form: Runs ∝ OBP × SLG. See header comment.
  let mult = (obA / 0.315) * (slgA / 0.400);
  if (S.pitcher?.bullpenGame) mult = mult * 0.4 + 1.0 * 0.6;
  // Floor lowered from 0.80 → 0.65 so genuinely elite arms (sub-0.220 OBA,
  // sub-0.300 SLG-against) can express the full ~35% suppression their line
  // implies. The 0.80 cap was throttling RBI / Runs / H+R+RBI discounts to
  // 20% even for Cy Young–caliber pitchers, producing OVER picks the market
  // (correctly) wasn't paying. _shrunkRate(prior_n=120) already protects
  // against small-sample volatility, so the floor doesn't need to be this
  // conservative.
  return Math.max(0.65, Math.min(1.25, mult));
}

// ── Opposing-pitcher "stuff" multiplier (skill-based, results-independent) ──
// The log-5 props fold in the pitcher via his BAA / HR-against, but those are
// RESULTS stats: they need a large sample to stabilize and are heavily shrunk
// toward league, so a genuinely elite arm with a short or lucky-looking line
// (e.g. an early-season ace sitting on a sub-1.00 ERA over 15 IP) collapses to
// ~league-average inside the rate model. The betting market prices the
// pitcher's STUFF — K-BB%, whiff, batted-ball mix — long before the BAA
// stabilizes, which is exactly why the model kept manufacturing phantom Over
// edges against good pitchers: its probability barely moved while the market's
// did. This multiplier injects that skill signal using the best available DIPS
// estimator (SIERA > xFIP > FIP), which describes true talent independent of
// the BAA the log-5 already consumes — so it adds the signal the rate model is
// blind to rather than double-counting the one it already has.
//
// Returns a multiplier on the batter's offensive event rates: <1 vs a good arm,
// >1 vs a weak one. League-average DIPS ~4.00 → 1.0. Slope 0.15/run (was 0.10
// — too flat to register elite seasons; an Ohtani 3.33 SIERA produced only a 7%
// discount under the old slope when his actual line was suppressing offense by
// 25–30%). Floor 0.60 (was 0.76 — same throttling problem as _pitcherRunEnvMult:
// genuinely otherworldly arms couldn't express their suppression). Sub-1.30
// SIERAs hit the floor; above that the slope governs. Gated behind ip>=8
// (advanced metrics are null below that). Bullpen games blend 40% toward
// neutral since the listed arm isn't representative of who hitters face.
export function _pitcherStuffMult() {
  const adv = S.pitcher?.advanced;
  const st  = S.pitcher?.st;
  if (!adv || !st) return 1.0;
  const ip = parseFloat(st.inningsPitched) || 0;
  if (ip < 8) return 1.0;
  const dips = adv.siera ?? adv.xfip ?? adv.fip;
  if (dips == null || !isFinite(dips)) return 1.0;
  let mult = 1 + (dips - 4.00) * 0.15;
  if (S.pitcher?.bullpenGame) mult = mult * 0.4 + 1.0 * 0.6;
  return Math.max(0.60, Math.min(1.16, mult));
}

// ── Distribution helpers (binomial + total-bases convolution) ───────────────
// P(X ≥ k) where X ~ Binomial(n, p). Used by walks/K props to compute the
// probability of clearing a half-integer line over `gamePAs` independent
// plate appearances. The previous formula hardcoded "P(over 1.5)" for every
// line > 0.5 — a 2.5-line bet was being graded as if it were a 1.5 line.
export function _binomGE(n, p, k) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let cdf = 0;
  let binom = 1; // C(n, 0) = 1
  for (let i = 0; i < k; i++) {
    cdf += binom * Math.pow(p, i) * Math.pow(1 - p, n - i);
    binom = binom * (n - i) / (i + 1);
  }
  return Math.max(0, Math.min(1, 1 - cdf));
}

// P(sum TB >= k) where each AB independently produces TB ∈ {0,1,2,3,4} with
// probabilities `perAB`. Convolves the 5-point distribution `n` times. Handles
// fractional `n` by linearly interpolating between floor(n) and ceil(n).
export function _convolveTBge(perAB, n, k) {
  if (n <= 0) return k <= 0 ? 1 : 0;
  const floor = Math.floor(n), frac = n - floor;
  function convN(steps) {
    let dist = [1];
    for (let i = 0; i < steps; i++) {
      const next = new Array(dist.length + 4).fill(0);
      for (let j = 0; j < dist.length; j++) for (let m = 0; m < 5; m++) next[j + m] += dist[j] * perAB[m];
      dist = next;
    }
    return dist;
  }
  const pGE = dist => { let s = 0; for (let i = k; i < dist.length; i++) s += dist[i]; return Math.max(0, Math.min(1, s)); };
  const lo = pGE(convN(floor));
  if (frac === 0) return lo;
  return (1 - frac) * lo + frac * pGE(convN(floor + 1));
}

// ── log-5 combine ───────────────────────────────────────────────────────────
// log-5 combine of two rates against a league baseline. All inputs clamped to
// (0, 0.5) to keep the formula numerically stable on small/large rates (HR/AB
// for elite power can flirt with 0.08, which the clamp still admits).
export function _log5(b, p, lg) {
  const c = v => Math.max(0.001, Math.min(0.5, v));
  const bc = c(b), pc = c(p), lc = c(lg);
  const num = bc * pc / lc;
  const den = num + (1 - bc) * (1 - pc) / (1 - lc);
  return den > 0 ? num / den : bc;
}

// ── Split-row helpers ───────────────────────────────────────────────────────
// Extract the full stat payload from a MLB Stats API statSplits row. Includes
// counting stats (K, BB, PA, AB, H, TB, HR) so handedness-specific rates can
// be computed for the K/BB/Hits projections — not just OPS for the score.
export function _extractSplitStat(st) {
  if (!st) return null;
  return {
    ops: parseFloat(st.ops) || null,
    avg: st.avg, obp: st.obp, slg: st.slg,
    gp:  parseInt(st.gamesPlayed)       || 0,
    pa:  parseInt(st.plateAppearances)  || 0,
    ab:  parseInt(st.atBats)            || 0,
    h:   parseInt(st.hits)              || 0,
    tb:  parseInt(st.totalBases)        || 0,
    hr:  parseInt(st.homeRuns)          || 0,
    rbi: parseInt(st.rbi)               || 0,
    k:   parseInt(st.strikeOuts)        || 0,
    bb:  parseInt(st.baseOnBalls)       || 0,
  };
}

// Return the active L/R split row for the current batter (vs the listed pitcher's
// hand). Returns null if splits aren't loaded or the row is missing.
export function _handSplit() {
  const hand = S.pitcher?.hand || S.pitcherThrows;
  if (!hand || !S.splits) return null;
  return hand === 'L' ? S.splits.vl : S.splits.vr;
}

// Standard wOBA linear weights. The MLB Stats API season line doesn't carry wOBA,
// so we reconstruct it from its counting components. Weights are FanGraphs' recent
// multi-year constants — they drift ~±0.01 yearly but the components dominate, so a
// fixed set is plenty accurate for a displayed rate stat. Denominator follows the
// FanGraphs definition: AB + BB − IBB + SF + HBP.
const _WOBA_W = { bb: 0.690, hbp: 0.722, b1: 0.888, b2: 1.271, b3: 1.616, hr: 2.101 };

// Compute season wOBA from an MLB Stats API hitting stat object. Returns a number,
// or null when the line lacks the fields / has no qualifying denominator.
export function _seasonWoba(ss) {
  if (!ss) return null;
  const n = v => parseInt(v) || 0;
  const ab = n(ss.atBats), bb = n(ss.baseOnBalls), ibb = n(ss.intentionalWalks);
  const hbp = n(ss.hitByPitch), sf = n(ss.sacFlies);
  const h = n(ss.hits), b2 = n(ss.doubles), b3 = n(ss.triples), hr = n(ss.homeRuns);
  const b1 = Math.max(0, h - b2 - b3 - hr);
  const ubb = Math.max(0, bb - ibb);
  const denom = ab + bb - ibb + sf + hbp;
  if (denom <= 0) return null;
  const num = _WOBA_W.bb * ubb + _WOBA_W.hbp * hbp
    + _WOBA_W.b1 * b1 + _WOBA_W.b2 * b2 + _WOBA_W.b3 * b3 + _WOBA_W.hr * hr;
  return num / denom;
}
