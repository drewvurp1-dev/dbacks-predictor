// Prediction primitives + the per-prop model + Monte Carlo confidence loop.
// All prediction math lives here; render code in app.js / ui/render.js
// consumes these via imports.

import { S } from './state.js';
import { PITCH_NAMES } from './constants.js';
import { _parkFactors } from './utils.js';
import {
  _gamePAs, _ttopBonus, _hrrOverPct, _pitcherRunEnvMult,
  _shrunkRate, _binomGE, _convolveTBge, _log5,
  _handSplit, _poissonCDF,
} from './player.js';
import { applyCalibration, getBlendWeight } from './calibrate.js';

// ── Gaussian sampler (Box–Muller) ───────────────────────────────────────────
export function gaussianRandom(mean, std) {
  const u1 = Math.random() || 1e-10, u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Slump dampener ──────────────────────────────────────────────────────────
// Widens MC sigma when recent results diverge from the model's positive
// prediction, so cold-streak bets fail the MC confidence threshold instead of
// being recommended at face value. Returns 0–5 sigma points based on active
// hitless streak + L10 batting average. Does NOT change the point prediction
// — only the uncertainty band around it.
export function _slumpPenalty() {
  const log = S.recentGameLog;
  if (!log || log.length < 3) return 0;
  let droughtGames = 0;
  for (const g of log) {
    const ab = parseInt(g.stat?.atBats) || 0;
    const h  = parseInt(g.stat?.hits)   || 0;
    if (ab === 0) continue;            // skip DNP/pinch appearances
    if (h === 0) droughtGames++;
    else break;
  }
  let p = 0;
  if      (droughtGames >= 5) p += 4;
  else if (droughtGames === 4) p += 2.5;
  else if (droughtGames === 3) p += 1.5;
  else if (droughtGames === 2) p += 0.5;
  const recent = log.slice(0, 10);
  const rH  = recent.reduce((s, g) => s + (parseInt(g.stat?.hits)    || 0), 0);
  const rAB = recent.reduce((s, g) => s + (parseInt(g.stat?.atBats) || 0), 0);
  if (rAB >= 15) {
    const avg = rH / rAB;
    if      (avg < 0.150) p += 3;
    else if (avg < 0.200) p += 1.5;
    else if (avg < 0.250) p += 0.5;
  }
  return Math.min(5, p);
}

// ── Monte Carlo sigma ───────────────────────────────────────────────────────
// Score-variance estimate, derived from the hitter's profile. High-whiff
// hitters have wider outcome distributions (more boom/bust), so the model
// score is a less reliable point estimate — σ scales up. Small samples (<50
// PA) also widen σ since the season-rate inputs are noisy. The slump dampener
// widens σ further when recent form contradicts the season profile.
// Maps: whiff 18% → σ≈5.0 (contact hitter), 28% → σ≈6.5 (league avg),
//       38% → σ≈8.0 (three-true-outcomes). Clamped to [4.5, 15].
export function _mcVariance() {
  const sc = S.statcast   || {};
  const ss = S.seasonStat || {};
  // S.statcast stores whiff as `whiff` (already parsed). `whiff_percent` is the
  // raw Savant CSV column name and is never present here — reading that key
  // returned undefined for every hitter, collapsing sigma to the default.
  const whiff = sc.whiff;
  let sigma = (typeof whiff === 'number' && isFinite(whiff)) ? 5 + (whiff - 18) * 0.15 : 6;
  const pa = parseInt(ss.plateAppearances) || 0;
  if (pa > 0 && pa < 50) sigma += 1.5;
  sigma += _slumpPenalty();
  return Math.max(4.5, Math.min(15, sigma));
}

// ── Rate-model uncertainty (probability space, pp) ───────────────────────────
// _mcVariance perturbs the *score*, but score only drives the scoreBase channel
// (~40% of the blend); the rate model (binomial / convolution on season counting
// stats) is score-independent, so a score-only Monte Carlo treats the dominant
// signal as certain and saturates near 100% confidence. This returns the
// sampling uncertainty of the rate estimate in percentage points so the MC loop
// can perturb the assembled probability directly. The season rates are estimated
// from PA observations, so their error shrinks with sample size: well-sampled
// bats (≥400 PA) carry ~3pp, mid-sample (~150 PA) ~6pp, and tiny/zero samples
// ~9pp. Returned value is an independent Gaussian σ added on top of the score
// channel's contribution.
export function _rateUncertaintyPp() {
  const pa = parseInt(S.seasonStat?.plateAppearances) || 0;
  if (pa <= 0) return 9;
  const capped = Math.min(pa, 400);
  return Math.max(3, Math.min(9, 3 + (400 - capped) / 400 * 6));
}

// ── Pitch-mix matchup ───────────────────────────────────────────────────────
// Pitch-mix vs batter weakness. Loaded once per page from /pitch-arsenal (a
// snapshot of Baseball Savant pitcher arsenal + batter pitch-arsenal
// leaderboards, refreshed daily by scripts/refresh_pitch_arsenal.py). Compares
// the batter's per-pitch-type rates (whiff/K/wOBA) weighted by the pitcher's
// actual usage% vs the batter's overall baseline. Captures matchup signal the
// season-wide K%/wOBA stats can't.

// Returns the matchup factor for the current batter/pitcher pair, or null if
// data is missing or sample sizes are too small. Cached per (pitcherId, batterId)
// pair since modelProbability is called multiple times per render.
export function _pitchMatchupFactor() {
  const pid = S.pitcher?.id, bid = S.playerId;
  if (S.pitchMatchupCached?.pid === pid && S.pitchMatchupCached?.bid === bid) {
    return S.pitchMatchupCached.value;
  }
  const cacheMiss = v => { S.pitchMatchupCached = { pid, bid, value: v }; return v; };
  const arsenal = S.pitchArsenal;
  if (!arsenal || !pid || !bid || S.pitcher?.bullpenGame) return cacheMiss(null);
  const pit = arsenal.pitchers?.[String(pid)];
  const bat = arsenal.batters?.[String(bid)];
  if (!pit || !bat) return cacheMiss(null);

  // Batter baseline — weighted by PA per pitch type, all pitches the batter has faced.
  let bWhiffSum = 0, bWobaSum = 0, bKSum = 0, bPaTotal = 0;
  for (const pt in bat.pitches) {
    const r = bat.pitches[pt];
    const w = r.pa || 0;
    if (!w) continue;
    bWhiffSum += (r.whiff || 0) * w;
    bWobaSum  += (r.woba  || 0) * w;
    bKSum     += (r.k_pct || 0) * w;
    bPaTotal  += w;
  }
  if (bPaTotal < 60) return cacheMiss(null); // need a meaningful baseline

  const baseWhiff = bWhiffSum / bPaTotal;
  const baseWoba  = bWobaSum  / bPaTotal;
  const baseK     = bKSum     / bPaTotal;

  // Expected matchup — re-weight batter's per-pitch rates by the pitcher's usage%.
  // Only count pitches the batter has faced ≥20 times (skip noise from rare pitches).
  let expWhiff = 0, expWoba = 0, expK = 0, usageCovered = 0;
  const detail = [];
  for (const pt in pit.pitches) {
    const pu = pit.pitches[pt].usage || 0;
    const br = bat.pitches[pt];
    if (!br || (br.pa || 0) < 20 || !pu) continue;
    expWhiff += pu * (br.whiff || 0);
    expWoba  += pu * (br.woba  || 0);
    expK     += pu * (br.k_pct || 0);
    usageCovered += pu;
    detail.push({ pt, usage: pu, whiff: br.whiff || 0, k: br.k_pct || 0, woba: br.woba || 0 });
  }
  // Require ≥60% of pitcher's mix to be covered by batter's known per-pitch rates.
  if (usageCovered < 60) return cacheMiss(null);
  expWhiff /= usageCovered;
  expWoba  /= usageCovered;
  expK     /= usageCovered;

  const whiffDelta = expWhiff - baseWhiff;
  const kDelta     = expK     - baseK;
  const wobaDelta  = expWoba  - baseWoba;

  // Pick the single pitch type whose contribution moves K% the most — that's what
  // we'll mention in the analysis line ("heavy SL: batter Ks 28% on it vs 22% baseline").
  detail.sort((a, b) => (b.usage * Math.abs(b.k - baseK)) - (a.usage * Math.abs(a.k - baseK)));
  const top = detail[0];
  const pitchLabel = PITCH_NAMES[top?.pt] || top?.pt || '';

  return cacheMiss({
    kDeltaPp: kDelta,
    wobaDelta: wobaDelta,
    whiffDelta: whiffDelta,
    baseWhiff, baseK, baseWoba,
    expWhiff,  expK,  expWoba,
    primaryPitch: top?.pt,
    primaryPitchName: pitchLabel,
    primaryUsage: top?.usage,
    primaryBatterK: top?.k,
    primaryBatterWhiff: top?.whiff,
  });
}

// Short driver string for the analysis text — only emit when the matchup signal
// is meaningful (≥2pp K delta or ≥0.015 wOBA delta).
export function _pitchMatchupReason(direction, propKey) {
  const m = _pitchMatchupFactor();
  if (!m) return null;
  const isK = propKey === 'batter_strikeouts';
  const helpsOver = isK ? (m.kDeltaPp > 0) : (m.wobaDelta > 0);
  const meaningful = isK ? Math.abs(m.kDeltaPp) >= 2 : Math.abs(m.wobaDelta) >= 0.015;
  if (!meaningful) return null;
  // Match direction — only surface when matchup supports the bet direction
  const supports = (direction === 'over' && helpsOver) || (direction === 'under' && !helpsOver);
  if (!supports) return null;
  if (isK) {
    return `${m.primaryUsage.toFixed(0)}% ${m.primaryPitchName} (${m.primaryBatterK.toFixed(0)}% K vs ${m.baseK.toFixed(0)}% base)`;
  }
  return `${m.primaryUsage.toFixed(0)}% ${m.primaryPitchName} mix (${(m.wobaDelta > 0 ? '+' : '')}${m.wobaDelta.toFixed(3)} wOBA matchup)`;
}

// ── Per-prop probability model ──────────────────────────────────────────────
// Composes player rate stats, pitcher rate stats, park/weather, lineup
// protection, pitch-matchup, recent form trend, and a score-based residual
// into a single Over probability for the given prop + line.
// `_components`, when supplied, is filled with the score-only / rate-only blend
// inputs and the pre-calibration probability — generateCorbetBets passes one so
// each saved bet records the data calibrate.js needs to re-tune later.
export function modelProbability(propKey,line,score,_components){
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const gamePAs=_gamePAs();
  let p=null;

  // Learned score↔rate blend weight (defaults to DEFAULT_BLEND_W when untuned).
  // _blend records the two components so calibrate.js can fit W from outcomes.
  const blendW=getBlendWeight(propKey);
  let _scoreBase=null,_rateBase=null,_blendBase=null;
  const _blend=(sb,rb)=>{_scoreBase=sb;_rateBase=rb;_blendBase=sb*blendW+rb*(1-blendW);return _blendBase;};

  // Piecewise linear interpolation between three anchor points (score 20/50/80).
  // Linearly extrapolates outside [s1, s3] using the nearest segment's slope, so
  // MC samples at extreme scores (4-19, 81-96) still produce variable probabilities
  // instead of all collapsing to the anchor endpoint. Final prop-specific clamps
  // at the bottom of modelProbability keep extrapolated values in a sane range.
  function lerp3(sc,s1,p1,s2,p2,s3,p3){
    if(sc<=s2)return p1+(p2-p1)*(sc-s1)/(s2-s1);
    return p2+(p3-p2)*(sc-s2)/(s3-s2);
  }

  // PA delta from league-average (4.2). Used to scale lerp3-based prop probs since
  // those anchors assume a typical-game number of plate appearances.
  const paDelta=gamePAs-4.2;

  if(propKey==='batter_hits'){
    // Distribution-based: P(H >= k) ~ Binomial(expectedAB, p_hit). Replaces the
    // previous lerp3-only path which had no ceiling — a 4-AB game caps Hits 1.5
    // around 45% even for an elite hitter, but the old lerp could extrapolate
    // well above that and produce 60-70%+ outputs.
    const LG_AVG=0.245;
    // Batter hit rate per AB. Prefer L/R-split when stabilized (>=100 PA),
    // shrunk toward the batter's overall rate. Falls back to league.
    const overallH=parseInt(ss?.hits)||0;
    const overallAB=parseInt(ss?.atBats)||0;
    const overallRate=overallAB?overallH/overallAB:LG_AVG;
    const hs=_handSplit();
    const bRate=(hs?.pa>=100&&hs?.ab>0)
      ?_shrunkRate(parseInt(hs.h)||0,hs.ab,overallRate,80)
      :_shrunkRate(overallH,overallAB||1,LG_AVG,80);
    // Pitcher hits-allowed rate (BAA). Shrunk to league with priorN=200
    // since BAA stabilizes slowly. Bullpen games: blend listed pitcher 40% /
    // league-average reliever BAA (~.235) 60% — mirrors the K/BB logic.
    const pAvgRaw=parseFloat(S.pitcher?.st?.avg);
    const pAB=parseInt(S.pitcher?.st?.atBats)||0;
    const pH=parseInt(S.pitcher?.st?.hits)||0;
    let pRate=(pAB>0)
      ?_shrunkRate(pH,pAB,LG_AVG,200)
      :(isFinite(pAvgRaw)?pAvgRaw:LG_AVG);
    if(S.pitcher?.bullpenGame)pRate=pRate*0.4+0.235*0.6;
    // Log-5 combine batter × pitcher × league.
    const b=Math.max(0.05,Math.min(0.55,bRate));
    const pp=Math.max(0.05,Math.min(0.55,pRate));
    const num=b*pp/LG_AVG;
    const den=num+(1-b)*(1-pp)/(1-LG_AVG);
    const pHit=den>0?num/den:b;
    // Expected AB = PA * (1 - BB - HBP). HBP ~1% of PA league-wide.
    const overallBBF=ss?.baseOnBalls?_shrunkRate(parseInt(ss.baseOnBalls)||0,pa,0.09,60):0.09;
    const abPerPA=Math.max(0.78,Math.min(0.94,1-overallBBF-0.01));
    const expectedAB=gamePAs*abPerPA;
    const k=Math.ceil(line+1e-9);
    const rateBase=_binomGE(expectedAB,pHit,k)*100;
    // Keep a small score-based component (25%) so contact-quality signals the
    // rate model doesn't see (whiff, HH%, handOps) still influence the final
    // probability. Anchors recalibrated for realistic ceilings.
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20,45,50,60,80,72);
    else if(line<=1.5) scoreBase=lerp3(score,20,15,50,28,80,42);
    else if(line<=2.5) scoreBase=lerp3(score,20, 3,50, 8,80,18);
    else               scoreBase=lerp3(score,20, 1,50, 3,80, 7);
    p=_blend(scoreBase,rateBase);
    // Pitch-mix wOBA delta — captures matchup signal beyond season-wide AVG/BAA.
    {const mu=_pitchMatchupFactor();
     if(mu)p+=Math.max(-3,Math.min(3,mu.wobaDelta*150));}
    p+=_ttopBonus();
    // NOTE: PA volume and WHIP signal are already inside the binomial via
    // gamePAs and pitcher BAA — no separate paDelta or WHIP adjustment.
  }
  else if(propKey==='batter_total_bases'){
    // Distribution-based: per-AB TB outcome ∈ {0,1,2,3,4} with probabilities
    // from log-5(batter rate, pitcher rate, league rate) for each event class
    // (1B / 2B / 3B / HR). Convolve over expected AB and read off P(TB >= k).
    // Replaces the lerp3-only path which had the same no-ceiling problem as
    // hits — outputs could extrapolate to 70%+ on TB 1.5 lines where the
    // multinomial cap is ~55% even for a true .500-SLG hitter.
    const LG_1B=0.150, LG_2B=0.045, LG_3B=0.005, LG_HR=0.030;

    const bAB=parseInt(ss?.atBats)||0;
    const bH=parseInt(ss?.hits)||0;
    const bHR=parseInt(ss?.homeRuns)||0;
    const b2B=parseInt(ss?.doubles)||0;
    const b3B=parseInt(ss?.triples)||0;
    const b1B=Math.max(0,bH-bHR-b2B-b3B);
    const r_b1B=_shrunkRate(b1B,bAB||1,LG_1B,150);
    const r_b2B=_shrunkRate(b2B,bAB||1,LG_2B,150);
    const r_b3B=_shrunkRate(b3B,bAB||1,LG_3B,200);
    const r_bHR=_shrunkRate(bHR,bAB||1,LG_HR,150);

    const pAB=parseInt(S.pitcher?.st?.atBats)||0;
    const pH=parseInt(S.pitcher?.st?.hits)||0;
    const pHR_=parseInt(S.pitcher?.st?.homeRuns)||0;
    const p2B_=parseInt(S.pitcher?.st?.doubles)||0;
    const p3B_=parseInt(S.pitcher?.st?.triples)||0;
    const p1B_=Math.max(0,pH-pHR_-p2B_-p3B_);
    let r_p1B=pAB>0?_shrunkRate(p1B_,pAB,LG_1B,200):LG_1B;
    let r_p2B=pAB>0?_shrunkRate(p2B_,pAB,LG_2B,250):LG_2B;
    let r_p3B=pAB>0?_shrunkRate(p3B_,pAB,LG_3B,300):LG_3B;
    let r_pHR=pAB>0?_shrunkRate(pHR_,pAB,LG_HR,200):LG_HR;
    if(S.pitcher?.bullpenGame){
      r_p1B=r_p1B*0.4+LG_1B*0.6;
      r_p2B=r_p2B*0.4+LG_2B*0.6;
      r_p3B=r_p3B*0.4+LG_3B*0.6;
      r_pHR=r_pHR*0.4+LG_HR*0.6;
    }

    let q1B=_log5(r_b1B,r_p1B,LG_1B);
    let q2B=_log5(r_b2B,r_p2B,LG_2B);
    let q3B=_log5(r_b3B,r_p3B,LG_3B);
    let qHR=_log5(r_bHR,r_pHR,LG_HR);
    // Sanity cap: total hit prob shouldn't exceed plausible AVG ceiling.
    const totalHit=q1B+q2B+q3B+qHR;
    if(totalHit>0.55){const s=0.55/totalHit;q1B*=s;q2B*=s;q3B*=s;qHR*=s;}
    const perAB=[Math.max(0,1-q1B-q2B-q3B-qHR),q1B,q2B,q3B,qHR];

    // Expected AB from gamePAs (already factors in WHIP & park run-env).
    const overallBBF=ss?.baseOnBalls?_shrunkRate(parseInt(ss.baseOnBalls)||0,pa,0.09,60):0.09;
    const abPerPA=Math.max(0.78,Math.min(0.94,1-overallBBF-0.01));
    const expectedAB=gamePAs*abPerPA;

    const k=Math.ceil(line+1e-9);
    const rateBase=_convolveTBge(perAB,expectedAB,k)*100;

    // Score-based component (25%) — captures contact-quality and OPS-vs-hand
    // signals beyond what season counting stats see. Anchors recalibrated for
    // realistic ceilings (top of the 80-score band ≈ what a true .470-SLG bat
    // produces under typical AB volume).
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20,38,50,55,80,68);
    else if(line<=1.5) scoreBase=lerp3(score,20,18,50,32,80,50);
    else if(line<=2.5) scoreBase=lerp3(score,20, 8,50,16,80,30);
    else               scoreBase=lerp3(score,20, 3,50, 7,80,16);
    p=_blend(scoreBase,rateBase);

    // Pitch-mix wOBA delta — small additive bonus.
    {const mu=_pitchMatchupFactor();
     if(mu)p+=Math.max(-3,Math.min(3,mu.wobaDelta*180));}
    p+=_ttopBonus();
    // Statcast contact-quality bumps at half their previous magnitude — the
    // multinomial already captures season HR/2B rates, so these only correct
    // for hitters whose batted-ball quality leads their results (small-sample
    // rookies, hot/cold contact streaks). League avg hhRate ~40%, barrel% ~8%.
    if(S.statcast?.hhRate!=null) p+=Math.max(-2,Math.min(2,(S.statcast.hhRate-40)*0.08));
    if(S.statcast?.brl!=null)    p+=Math.max(-3,Math.min(3,(S.statcast.brl-8)*0.32));
    // NOTE: PA volume and WHIP signal already captured via expectedAB.
  }
  else if(propKey==='batter_home_runs'){
    // Distribution-based: P(HR >= k) ~ Binomial(gamePAs, p_HR) where p_HR is
    // log-5(batter HR/PA, pitcher HR/PA, league HR/PA). Replaces the lerp3-only
    // path with the same no-ceiling problem as Hits/TB had: elite sluggers
    // were outputting 30%+ on HR 0.5 even though the binomial ceiling at a
    // true 5% HR/PA over 4.4 PA is ~20%.
    const LG_HR_PA=0.030;
    const bPA=parseInt(ss?.plateAppearances)||0;
    const bHR=parseInt(ss?.homeRuns)||0;
    const bHR_PA=_shrunkRate(bHR,bPA||1,LG_HR_PA,150);
    const pPA=parseInt(S.pitcher?.st?.battersFaced)||0;
    const pHRCount=parseInt(S.pitcher?.st?.homeRuns)||0;
    let pHR_PA=pPA>0?_shrunkRate(pHRCount,pPA,LG_HR_PA,200):LG_HR_PA;
    if(S.pitcher?.bullpenGame) pHR_PA=pHR_PA*0.4+LG_HR_PA*0.6;
    const pHRrate=_log5(bHR_PA,pHR_PA,LG_HR_PA);
    const k=Math.ceil(line+1e-9);
    const rateBase=_binomGE(gamePAs,pHRrate,k)*100;
    // Score-based component (25%) — captures barrel%, OPS-vs-hand, and other
    // contact-quality signals the season HR rate misses (esp. for small-sample
    // rookies where xHR/PA leads HR/PA). Line-specific anchors keep blends
    // realistic at HR 1.5+ where the prop is genuinely rare.
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20, 4,50, 9,80,18);
    else if(line<=1.5) scoreBase=lerp3(score,20,0.2,50,0.5,80,1.8);
    else               scoreBase=lerp3(score,20,0.05,50,0.1,80,0.4);
    p=_blend(scoreBase,rateBase);
    p+=_ttopBonus();
    // Barrel% retained at the same magnitude — it's the single best predictor
    // of HR rate and can lead season HR/PA for hot-contact hitters. Cap ±2pp.
    if(S.statcast?.brl!=null) p+=Math.max(-2,Math.min(2,(S.statcast.brl-8)*0.20));
    // NOTE: PA volume already in the binomial via gamePAs — no separate paDelta.
  }
  else if(propKey==='batter_walks'){
    // League avg BB rate ~9%. Stabilization point ~120 PA → priorN=60 (light shrinkage for vets).
    const overallBBF=ss?.baseOnBalls?_shrunkRate(parseInt(ss.baseOnBalls)||0,pa,0.09,60):0.09;
    // Handedness-specific BB rate (BB stabilizes a bit slower than K — require ≥100 PA).
    const hs=_handSplit();
    const bbF=(hs?.pa>=100&&hs?.bb!=null)?_shrunkRate(hs.bb,hs.pa,overallBBF,60):overallBBF;
    const pitcherPA=S.pitcher?.st?.battersFaced||1;
    let pBBF=S.pitcher?.st?.baseOnBalls?_shrunkRate(parseInt(S.pitcher.st.baseOnBalls)||0,pitcherPA,0.08,80):0.08;
    // Bullpen games: hitters face multiple relievers. Blend listed pitcher's BB rate
    // toward league-average reliever BB/PA (~8.5% — BB/9 ≈ 3.2 over ~4.3 PA/IP).
    // 40% listed / 60% reliever pool.
    if(S.pitcher?.bullpenGame) pBBF=pBBF*0.4+0.085*0.6;
    const blended=bbF*0.6+pBBF*0.4;
    // P(walks ≥ k) over gamePAs Bernoulli trials. k = smallest integer > line,
    // so line=0.5→k=1, line=1.5→k=2, line=2.5→k=3, etc.
    const rateBase=_binomGE(gamePAs,blended,Math.ceil(line+1e-9))*100;
    // scoreBase weight dropped 60% → 25% and anchor at 80 trimmed from 48 to
    // 42. The binomial on shrunken BB rate is the principled signal here;
    // score retains weight for ump/recent-form/days-rest factors the binomial
    // doesn't see. Old weighting could push elite-OBP rookies to 48% on Walks
    // 0.5 even when the matchup binomial sat at ~32%.
    const scoreBase=lerp3(score,20,15,50,28,80,42);
    p=_blend(scoreBase,rateBase);
  }
  else if(propKey==='batter_strikeouts'){
    // League avg K rate ~22% batter / ~22% pitcher. K rate stabilizes ~60 PA → priorN=40.
    const overallKF=ss?.strikeOuts?_shrunkRate(parseInt(ss.strikeOuts)||0,pa,0.22,40):0.22;
    // Prefer L/R-handedness-specific K rate when the split has stabilized (≥80 PA).
    // Shrink toward the batter's overall K rate (not league average) so the
    // adjustment captures the handedness gap without small-sample noise.
    const hs=_handSplit();
    const kF=(hs?.pa>=80&&hs?.k!=null)?_shrunkRate(hs.k,hs.pa,overallKF,40):overallKF;
    const pitcherPA=S.pitcher?.st?.battersFaced||1;
    let pKF=S.pitcher?.st?.strikeOuts?_shrunkRate(parseInt(S.pitcher.st.strikeOuts)||0,pitcherPA,0.22,60):0.22;
    // Bullpen games: hitters face multiple relievers, not just the listed arm. Blend the
    // listed pitcher's K rate toward league-average reliever K/PA (~23.5% — relievers
    // strike out batters at a higher clip than starters, K/9 ≈ 9.0 over ~4.3 PA/IP).
    // 40% listed / 60% reliever pool.
    if(S.pitcher?.bullpenGame) pKF=pKF*0.4+0.235*0.6;
    const whiffAdj=S.statcast?.whiff?(S.statcast.whiff-22)*0.01:0;
    // Pitch-mix matchup — adds the gap between the batter's overall K% and their
    // expected K% in this pitcher's actual usage mix. Half-weight, capped ±0.04
    // per-PA rate (≈ ±0.16 expected K shift over 4 PAs).
    const mu=_pitchMatchupFactor();
    const matchupK = mu ? Math.max(-0.04,Math.min(0.04,(mu.kDeltaPp/100)*0.5)) : 0;
    const blended=Math.min(0.45,kF*0.55+pKF*0.45+whiffAdj+matchupK);
    // P(strikeouts ≥ k) over gamePAs Bernoulli trials. Generalized for any line.
    const rateBase=_binomGE(gamePAs,blended,Math.ceil(line+1e-9))*100;
    // scoreBase weight dropped 60% → 25% with line-specific anchors that
    // mirror the binomial's natural distribution across the population at
    // each line. Old single-anchor (28/48/68) was line-agnostic, which
    // overshot K 1.5+ for high-K matchups (model 54% vs binomial truth ~34%)
    // while merely tracking the binomial on K 0.5.
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20,35,50,50,80,65);
    else if(line<=1.5) scoreBase=lerp3(score,20,10,50,20,80,38);
    else if(line<=2.5) scoreBase=lerp3(score,20, 3,50, 8,80,22);
    else               scoreBase=lerp3(score,20, 1,50, 3,80,10);
    p=_blend(scoreBase,rateBase);
  }
  else if(propKey==='batter_rbis'){
    // Poisson on shrunken RBI/G is the principled signal. Scale the per-game
    // rate by today's expected PAs vs league average — high-PA games produce
    // proportionally more RBI opportunities — AND by the opposing pitcher's run
    // environment (_pitcherRunEnvMult), without which this branch was nearly
    // pitcher-blind: facing an ace barely moved the projection. League avg RBI/G ~0.43.
    const rbiPG=_shrunkRate(parseInt(ss?.rbi)||0,parseInt(ss?.gamesPlayed)||0,0.43,60)*(gamePAs/4.2)*_pitcherRunEnvMult();
    // Threshold note: the Poisson props use 1−CDF(floor(line)) = P(X > floor(line)),
    // while the binomial props use _binomGE(…, ceil(line+ε)) = P(X ≥ ceil(line+ε)).
    // These are equivalent for every line (the strict-vs-nonstrict difference
    // cancels the floor-vs-ceil difference), so the two conventions agree — don't
    // "fix" one to match the other.
    const rateBase=(1-_poissonCDF(rbiPG,Math.floor(line)))*100;
    // Line-specific anchors. The 0.5 anchors put league-avg score (50) at the
    // league-avg P(≥1 RBI) of ~30%. Higher lines need their own (much lower)
    // anchors — ≥2 RBI is uncommon (~8-16% for elites) — otherwise the 0.5
    // anchors inject a ~30-42% floor that swamps the Poisson tail on alt lines.
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20,15,50,30,80,42);   // ≥1 RBI
    else if(line<=1.5) scoreBase=lerp3(score,20, 3,50, 8,80,16);   // ≥2 RBI
    else if(line<=2.5) scoreBase=lerp3(score,20,0.5,50,2.0,80, 5); // ≥3 RBI
    else               scoreBase=lerp3(score,20,0.1,50,0.6,80,1.8);// ≥4 RBI
    p=_blend(scoreBase,rateBase);
    // Protection cut from ±5pp to ±3pp — strong protection behind you keeps
    // pitchers from intentionally walking you, but the effect is smaller than
    // the previous magnitude implied.
    if(S.lineupProtection?.tier==='strong')p+=3;
    else if(S.lineupProtection?.tier==='weak')p-=3;
  }
  else if(propKey==='batter_runs_scored'){
    // Poisson on shrunken Runs/G. League avg ~0.55. PA-scaled like RBI, and
    // scaled by the opposing pitcher's run environment (_pitcherRunEnvMult) — a
    // pitcher who allows few baserunners and little extra-base contact suppresses
    // the batter's chance to come around to score, not just his RBI chances.
    const runPG=_shrunkRate(parseInt(ss?.runs)||0,parseInt(ss?.gamesPlayed)||0,0.55,60)*(gamePAs/4.2)*_pitcherRunEnvMult();
    const rateBase=(1-_poissonCDF(runPG,Math.floor(line)))*100;
    // Line-specific anchors. The 0.5 anchors put a true elite leadoff bat
    // (score=80, runs/G ~0.85) at ~57%, matching market consensus on leadoff
    // Runs Over 0.5. Higher lines need their own (much lower) anchors: a single
    // batter scoring ≥2 runs is rare (~10-15% even for elites), so reusing the
    // 0.5 anchors there injected a ~35-50% floor that swamped the Poisson tail
    // and pushed Runs Over 1.5 to ~28% against a 3% market — a phantom edge.
    let scoreBase;
    if(line<=0.5)      scoreBase=lerp3(score,20,15,50,35,80,50);   // ≥1 run
    else if(line<=1.5) scoreBase=lerp3(score,20, 2,50, 7,80,14);   // ≥2 runs
    else if(line<=2.5) scoreBase=lerp3(score,20,0.3,50,1.5,80, 4); // ≥3 runs
    else               scoreBase=lerp3(score,20,0.1,50,0.5,80,1.5);// ≥4 runs
    p=_blend(scoreBase,rateBase);
    // Protection cut from ±5 → ±3 — captured partly by OBP-loaded score.
    if(S.lineupProtection?.tier==='strong')p+=3;
    else if(S.lineupProtection?.tier==='weak')p-=3;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    const rateBase=_hrrOverPct(line,ss,S.recentGameLog,gamePAs,_pitcherRunEnvMult());
    // scoreBase weight dropped 50% → 25%, matching the pattern applied to
    // every other rate-based prop. The Bayesian-shrunk empirical CDF (or
    // Poisson fallback) is the principled signal here; the heavy 50% score
    // weight was pulling low-stat-line starters' projections down by ~25pp
    // even when their per-PA bottom-up math said they were a coin flip.
    const scoreBase=lerp3(score,20,20,50,38,80,60);
    p=_blend(scoreBase,rateBase);
    // Composite of hits (no protection effect) + runs + RBI (both protection-sensitive).
    // Roughly 2/3 the magnitude of RBI/Runs since hits are unaffected.
    if(S.lineupProtection?.tier==='strong')p+=3;
    else if(S.lineupProtection?.tier==='weak')p-=3;
    p+=_ttopBonus();
  }

  if(p===null)return null;

  // Park factor adjustments (prop-specific, separate from general score).
  // Stadiums only carry hrF and hitF data; secondary effects are derived:
  //   K rate ↓ in hitter parks (better visibility, warmer air) — use inverse hitF
  //   Runs/RBI scale with run-scoring environment — blend hitF (contact) + hrF (power)
  // Park effect on walks is small (umpire dominates), so we don't adjust BB.
  {const{hrF,hitF,elev:pElev,hasRoof}=_parkFactors();const rfClosed=hasRoof&&S.roofClosed;
  if(!rfClosed){
    if(propKey==='batter_home_runs'&&pElev<=4000)
      // Direct HR park bump capped at ±5pp (was ±8). The same hrF signal already
      // enters via calcPrediction's score (which feeds lerp3 anchors), so the
      // direct bump should only capture the prop-specific delta on top of the
      // score channel — not the full park effect twice.
      p+=Math.max(-5,Math.min(5,Math.round((hrF-1.0)*60)));
    else if(['batter_hits','batter_total_bases','batter_hits_runs_rbis'].includes(propKey))
      p+=Math.max(-5,Math.min(5,Math.round((hitF-1.0)*40)));
    else if(propKey==='batter_strikeouts')
      p+=Math.max(-3,Math.min(3,Math.round(-(hitF-1.0)*25)));
    else if(propKey==='batter_runs_scored'||propKey==='batter_rbis'){
      const runF=hitF*0.65+hrF*0.35;
      p+=Math.max(-5,Math.min(5,Math.round((runF-1.0)*35)));
    }
  }}

  // Trend adjustments — accumulated then capped at ±6pts total.
  // Recency-weighted with exponential decay (most recent game gets highest weight).
  // decay=0.7 → most recent game ≈3.4× the influence of a game 4 days ago.
  // For 4-game window, normalized weights are roughly [0.40, 0.28, 0.19, 0.14].
  let trendAdj=0;
  const last4=S.recentGameLog?.slice(0,4)||[];
  if(last4.length>=3){
    const decay=0.7;
    let totW=0;
    for(let i=0;i<last4.length;i++)totW+=Math.pow(decay,i);
    const wFrac=(pred)=>{
      let s=0;
      for(let i=0;i<last4.length;i++)if(pred(last4[i]))s+=Math.pow(decay,i);
      return s/totW;
    };
    const wAvg=(get)=>{
      let s=0,vw=0;
      for(let i=0;i<last4.length;i++){
        const v=get(last4[i]);
        if(v==null||isNaN(v))continue;
        const w=Math.pow(decay,i);
        s+=v*w; vw+=w;
      }
      return vw>0?s/vw:0;
    };
    const wSum=(get)=>{
      let s=0;
      for(let i=0;i<last4.length;i++){
        const v=get(last4[i]);
        if(v==null||isNaN(v))continue;
        s+=v*Math.pow(decay,i);
      }
      return s;
    };

    if(propKey==='batter_hits'){
      const hot=wFrac(g=>(parseInt(g.stat.hits)||0)>=2);
      const cold=wFrac(g=>(parseInt(g.stat.hits)||0)===0);
      if(hot>=0.65)trendAdj+=5; else if(hot>=0.4)trendAdj+=2;
      if(cold>=0.5)trendAdj-=5; else if(cold>=0.25)trendAdj-=2;
    } else if(propKey==='batter_total_bases'){
      const avgTB=wAvg(g=>parseInt(g.stat.totalBases)||0);
      if(avgTB>=2.5)trendAdj+=5; else if(avgTB<=0.5)trendAdj-=4;
    } else if(propKey==='batter_home_runs'){
      const recentHR=wSum(g=>parseInt(g.stat.homeRuns)||0);
      if(recentHR>=1.5)trendAdj+=4;
    } else if(propKey==='batter_strikeouts'){
      const avgK=wAvg(g=>parseInt(g.stat.strikeOuts)||0);
      if(avgK>1.5)trendAdj+=4; else if(avgK<0.5)trendAdj-=3;
    } else if(propKey==='batter_walks'){
      const wkGames=wFrac(g=>(parseInt(g.stat.baseOnBalls)||0)>=1);
      if(wkGames>=0.65)trendAdj+=4; else if(wkGames<=0.05)trendAdj-=3;
    } else if(propKey==='batter_runs_scored'){
      const scoringGames=wFrac(g=>(parseInt(g.stat.runs)||0)>=1);
      if(scoringGames>=0.65)trendAdj+=4; else if(scoringGames<=0.05)trendAdj-=3;
    } else if(propKey==='batter_hits_runs_rbis'){
      const avgHRR=wAvg(g=>(parseInt(g.stat.hits)||0)+(parseInt(g.stat.runs)||0)+(parseInt(g.stat.rbi)||0));
      if(avgHRR>=3)trendAdj+=5; else if(avgHRR<=0.5)trendAdj-=4;
    }
  }

  // Pitcher recent form — recency-weighted with same exponential decay as batter form.
  // For a 3-start window, normalized weights are roughly [0.46, 0.32, 0.22], so the
  // most-recent start gets ~2× the weight of one from 3 starts back. A blow-up last
  // outing matters more than a blow-up three starts ago.
  const p3=S.pitcher?.last3;
  if(p3?.length>=1){
    const pDecay=0.7;
    const pWAvg=(get)=>{
      let s=0,vw=0;
      for(let i=0;i<p3.length;i++){
        const v=get(p3[i]);
        if(v==null||isNaN(v))continue;
        const w=Math.pow(pDecay,i);
        s+=v*w; vw+=w;
      }
      return vw>0?s/vw:0;
    };
    if(propKey==='batter_hits'){
      const avgH=pWAvg(g=>parseInt(g.stat.hits)||0);
      if(avgH>=8)trendAdj+=4; else if(avgH<=4)trendAdj-=3;
    } else if(propKey==='batter_strikeouts'){
      const avgK=pWAvg(g=>parseInt(g.stat.strikeOuts)||0);
      if(avgK>=9)trendAdj+=4; else if(avgK<=4)trendAdj-=3;
    } else if(propKey==='batter_total_bases'){
      const avgER=pWAvg(g=>parseInt(g.stat.earnedRuns)||0);
      if(avgER>=4)trendAdj+=3; else if(avgER<=1)trendAdj-=2;
    }
  }

  p+=Math.max(-6,Math.min(6,trendAdj));

  // Additive offset layered on top of the score↔rate blend (park, TTO, pitch-mix,
  // Statcast, recent-form trend). Captured pre-clamp so calibrate.js's blend
  // re-tune can hold these corrections fixed while it searches W — the old fit
  // optimized W against the bare blend and ignored every adjustment, biasing the
  // learned weight relative to the probability the model actually emits.
  const _adjOffset=(_blendBase!=null)?(p-_blendBase):0;

  // Line-specific hard clamps applied as a pre-calibration sanity bound. These
  // run BEFORE applyCalibration so the learned Platt correction is the final
  // word and can't be silently clipped in the tails.
  //
  // FLOORS are deliberately set to conservative *validity backstops* — roughly
  // the lowest plausible true probability for a real MLB starter — NOT to a
  // minimum belief. The old floors (e.g. 38pp for ≥1 hit) sat above the genuine
  // worst-case probability of weak bats in tough matchups, so they suppressed
  // legitimate Under convictions and, when the market sat below the floor, could
  // even flip a marginal call to a spurious Over. The rate model already bounds
  // these distributions naturally; the floor only guards against absurd
  // extrapolation. CEILINGS are kept tight — capping an over-confident Over is
  // the conservative direction for a betting tool.
  if(propKey==='batter_hits'){
    if(line<=0.5)      p=Math.max(22,Math.min(82,p));  // ≥1 hit
    else if(line<=1.5) p=Math.max(10,Math.min(65,p));  // ≥2 hits
    else               p=Math.max(4, Math.min(40,p));  // ≥3 hits (rare)
  } else if(propKey==='batter_total_bases'){
    if(line<=0.5)      p=Math.max(12,Math.min(80,p));  // ≥1 TB
    else if(line<=1.5) p=Math.max(8, Math.min(70,p));  // ≥2 TB
    else if(line<=2.5) p=Math.max(4, Math.min(55,p));  // ≥3 TB
    else               p=Math.max(2, Math.min(35,p));  // ≥4 TB
  } else if(propKey==='batter_home_runs'){
    p=Math.max(3,Math.min(45,p));
  } else if(propKey==='batter_walks'){
    if(line<=0.5)      p=Math.max(8, Math.min(65,p));  // ≥1 walk
    else if(line<=1.5) p=Math.max(3, Math.min(40,p));  // ≥2 walks
    else               p=Math.max(1, Math.min(25,p));  // ≥3 walks
  } else if(propKey==='batter_strikeouts'){
    if(line<=0.5)      p=Math.max(12,Math.min(78,p));  // ≥1 K
    else if(line<=1.5) p=Math.max(7, Math.min(65,p));  // ≥2 K
    else if(line<=2.5) p=Math.max(4, Math.min(50,p));  // ≥3 K
    else               p=Math.max(2, Math.min(30,p));  // ≥4 K
  } else if(propKey==='batter_rbis'){
    if(line<=0.5)      p=Math.max(8, Math.min(65,p));  // ≥1 RBI
    else if(line<=1.5) p=Math.max(3, Math.min(26,p));  // ≥2 RBI
    else if(line<=2.5) p=Math.max(1, Math.min(12,p));  // ≥3 RBI
    else               p=Math.max(0.5,Math.min(6, p)); // ≥4 RBI
  } else if(propKey==='batter_runs_scored'){
    if(line<=0.5)      p=Math.max(10,Math.min(70,p));  // ≥1 run
    else if(line<=1.5) p=Math.max(3, Math.min(24,p));  // ≥2 runs
    else if(line<=2.5) p=Math.max(1, Math.min(10,p));  // ≥3 runs
    else               p=Math.max(0.5,Math.min(5, p)); // ≥4 runs
  } else if(propKey==='batter_hits_runs_rbis'){
    if(line<=1.5)      p=Math.max(12,Math.min(75,p));  // ≥2 H+R+RBI
    else if(line<=2.5) p=Math.max(7, Math.min(60,p));  // ≥3
    else if(line<=3.5) p=Math.max(4, Math.min(45,p));  // ≥4
    else               p=Math.max(2, Math.min(30,p));  // ≥5
  } else{
    p=Math.max(5,Math.min(95,p));
  }

  // Learned Platt correction (identity until enough graded bets accumulate).
  // Capture the pre-calibration value + blend components for the caller before
  // applying, so refits train on the (clamped) raw probability that is the
  // actual input to calibration — never on an already-corrected value.
  const _rawP=p;
  p=applyCalibration(propKey,p);

  // Monotonicity floor: H+R+RBI strictly contains Hits — a single hit is itself
  // ≥1 H+R+RBI — so P(HRR over L) can never fall below P(Hits over L) at the same
  // line. The two props run on independent paths (Hits = binomial log-5; HRR =
  // _hrrOverPct's summed-rate Poisson scaled by _pitcherRunEnvMult) with no shared
  // floor, so a strong-pitcher game can suppress the composite below its own hits
  // component and produce contradictory Over/Under picks (Hits Over + HRR Under,
  // which can never both cash). Enforce the invariant on the final probability.
  if(propKey==='batter_hits_runs_rbis'){
    const hitsOver=modelProbability('batter_hits',line,score);
    if(hitsOver!==null&&p<hitsOver)p=hitsOver;
  }

  if(_components){_components.raw=_rawP;_components.scoreBase=_scoreBase;_components.rateBase=_rateBase;_components.adjOffset=_adjOffset;}

  return p;
}

// ── Monte Carlo confidence ──────────────────────────────────────────────────
// % of simulations where the edge holds — an "edge stability" measure, not a win
// probability. Two independent noise sources are combined so the result reflects
// the model's *total* uncertainty rather than only its sensitivity to the score
// input:
//   1. Score channel — perturb the score and re-run modelProbability, which
//      propagates the noise through the blend, clamps and calibration exactly as
//      production does. This captures only the scoreBase contribution.
//   2. Rate channel — add a Gaussian in probability space (pp) sized by
//      _rateUncertaintyPp, representing the sampling error of the season-rate
//      inputs that the score channel can't see. Without this the MC saturated
//      near 100% for any edge, making the confidence gate effectively binary on
//      delta and blind to small-sample players.
export function monteCarloConfidence(propKey, line, score, marketOverProb, direction = 'Over', N = 2000) {
  let edgeCount = 0, valid = 0;
  const isUnder = String(direction).toLowerCase() === 'under';
  const sigmaScore = _mcVariance();
  const sigmaRate = _rateUncertaintyPp();
  for (let i = 0; i < N; i++) {
    const ns = Math.max(4, Math.min(96, gaussianRandom(score, sigmaScore)));
    const prob = modelProbability(propKey, line, ns);
    if (prob === null) continue;
    valid++;
    const noisyProb = Math.max(0, Math.min(100, prob + gaussianRandom(0, sigmaRate)));
    if (isUnder ? noisyProb < marketOverProb : noisyProb > marketOverProb) edgeCount++;
  }
  return valid ? (edgeCount / valid) * 100 : 0;
}
