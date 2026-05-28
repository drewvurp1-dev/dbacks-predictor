// Bet log + grading subsystem.
//
// Owns all reads/writes against S.betLog and the four localStorage stores
// (gradeLog, pending, factorPerf, factorWeights). UI re-renders are decoupled
// via CustomEvents — bets.js never calls renderRecord / renderGradePanel
// directly. app.js subscribes to:
//   • 'bets:changed'   — fired after S.betLog mutates
//   • 'grades:changed' — fired after gradeLog/pending/perf/weights mutate
// This keeps bets.js free of upward imports so ui/record.js (PR3) can layer
// on top without circular dependencies.

import {
  SEASON, CORBET_ROSTER, DEFAULT_WEIGHTS,
  GRADE_LOG_KEY, FACTOR_PERF_KEY, FACTOR_WEIGHTS_KEY, PENDING_KEY,
} from './constants.js';
import { S, log, activeRoster } from './state.js';
import * as api from './api.js';

const _betsChanged   = () => document.dispatchEvent(new CustomEvent('bets:changed'));
const _gradesChanged = () => document.dispatchEvent(new CustomEvent('grades:changed'));

// ── Constants ────────────────────────────────────────────────────────────────

const _MANUAL_PROP_LABELS = {
  batter_hits:'Hits',batter_total_bases:'Total Bases',
  batter_rbis:'RBI',batter_walks:'Walks',batter_strikeouts:'Strikeouts',
  batter_runs_scored:'Runs',batter_hits_runs_rbis:'H+R+RBI',
};

// Map legacy per-metric pitcher labels onto the unified 'Pitcher Quality' label
// so learning stats accumulate in one bucket regardless of which advanced metric
// was available at prediction time. Used by updateFactorPerf / _rebuildFactorPerf
// so historical gradeLog entries written before the consolidation still credit
// the right factor.
const _LEGACY_PITCHER_QUALITY = new Set(['Pitcher SIERA','Pitcher xFIP','Pitcher FIP','Pitcher ERA']);
function _canonicalFactorLabel(label){
  return _LEGACY_PITCHER_QUALITY.has(label) ? 'Pitcher Quality' : label;
}

// Map propKey → function that pulls the relevant stat out of an MLB API actual
// stats object. Mirrors the stats returned by fetchActualStats().
const _PROP_STAT_GETTER = {
  batter_hits:           a => a.hits,
  batter_total_bases:    a => a.totalBases,
  batter_home_runs:      a => a.homeRuns,
  batter_rbis:           a => a.rbi,
  batter_walks:          a => a.walks,
  batter_strikeouts:     a => a.strikeOuts,
  batter_runs_scored:    a => a.runs,
  batter_hits_runs_rbis: a => (a.hits||0)+(a.runs||0)+(a.rbi||0),
};

function _playerIdByName(name){
  if(!name)return null;
  const direct=(S.lineupRoster||[]).concat(CORBET_ROSTER).find(p=>p.name===name);
  return direct?.id??null;
}

// Returns 'win' / 'loss' / 'push' given actual stat value, direction, and line.
function _gradeProp(actual, direction, line){
  if(actual==null||line==null)return null;
  const dir=(direction||'').toLowerCase();
  if(actual===line)return 'push';
  if(dir==='over')  return actual>line ? 'win' : 'loss';
  if(dir==='under') return actual<line ? 'win' : 'loss';
  return null;
}

// Returns true if `date` (YYYY-MM-DD) is strictly before today's Arizona-local
// date. We can't grade a bet on the day-of because the game may still be live.
function _isPastDate(date){
  if(!date)return false;
  const azToday=new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  return date < azToday;
}

// ── localStorage stores ──────────────────────────────────────────────────────

export function getGradeLog()     { return JSON.parse(localStorage.getItem(GRADE_LOG_KEY)||'[]'); }
export function getFactorPerf()   {
  const raw = JSON.parse(localStorage.getItem(FACTOR_PERF_KEY)||'{}');
  // One-shot migration: collapse legacy metric-specific pitcher labels into the
  // unified 'Pitcher Quality' bucket so the learning panel doesn't double-list
  // them after the consolidation. The merged result is persisted so the merge
  // only runs until the next save.
  let dirty = false;
  const out = {};
  for (const [label, data] of Object.entries(raw)) {
    const canon = _canonicalFactorLabel(label);
    if (canon !== label) dirty = true;
    if (!out[canon]) out[canon] = { fires: 0, hits: 0, totalPerf: 0 };
    out[canon].fires += data.fires || 0;
    out[canon].hits += data.hits || 0;
    out[canon].totalPerf += data.totalPerf || 0;
  }
  if (dirty) localStorage.setItem(FACTOR_PERF_KEY, JSON.stringify(out));
  return out;
}
export function getFactorWeights(){ return JSON.parse(localStorage.getItem(FACTOR_WEIGHTS_KEY)||JSON.stringify(DEFAULT_WEIGHTS)); }
export function getPending()      { return JSON.parse(localStorage.getItem(PENDING_KEY)||'[]'); }

export function saveGradeLog(d)     { localStorage.setItem(GRADE_LOG_KEY, JSON.stringify(d)); }
export function saveFactorPerf(d)   { localStorage.setItem(FACTOR_PERF_KEY, JSON.stringify(d)); }
export function saveFactorWeights(d){ localStorage.setItem(FACTOR_WEIGHTS_KEY, JSON.stringify(d)); }
export function savePending(d)      { localStorage.setItem(PENDING_KEY, JSON.stringify(d)); }

// ── Bet log: save / update / delete ──────────────────────────────────────────

export function saveBet(key, btn){
  const b=S.corbetBetsMap?.[key];
  if(!b){
    if(btn){btn.textContent='⚠ Not found';btn.style.color='#e74c3c';setTimeout(()=>{btn.textContent='+ Save';btn.style.color='';},1800);}
    return;
  }
  // Use the loaded game's date (same source as the rest of the dashboard) so
  // the opponent captured from S.opposingTeamAbbr lines up with the date stored.
  // Arizona-local fallback avoids a UTC midnight rollover.
  const date=document.getElementById('game-date').value||new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  const prop=`${b.direction} ${b.line} ${b.prop}`;
  if(S.betLog.some(x=>x.date===date&&x.prop===prop&&(x.player===(b._playerName||S.playerName)))){
    if(btn){btn.textContent='Already saved';setTimeout(()=>{btn.textContent='+ Save';},1800);}
    return;
  }
  const rating=b.edgeStrength==='strong'?'green':b.edgeStrength==='moderate'?'yellow':'red';
  const betOdds=b.direction?.toLowerCase()==='over'?b.overBest?.price:b.underBest?.price;
  const playerName=b._playerName||S.playerName;
  const bet={id:Date.now(),date,player:playerName,playerId:_playerIdByName(playerName),opponent:S.opposingTeamAbbr||'',prop,odds:betOdds,rating,score:b._playerScore||S.lastScore,result:null,
    modelProb:b.modelProb??null,mcConfidence:b.mcConfidence??null,marketOverProb:b.marketOverProb??null,
    modelProbRaw:b.modelProbRaw??null,scoreBase:b.scoreBase??null,rateBase:b.rateBase??null,
    propKey:b.propKey??null,direction:b.direction??null,line:b.line??null,ev:b.ev??null};
  S.betLog.unshift(bet);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  _betsChanged();
  if(btn){btn.textContent='✓ Saved!';btn.style.color='#2ecc71';setTimeout(()=>{btn.textContent='+ Save';btn.style.color='';},2000);}
}

// Single source of truth for "top N bets". All three callers (dashboard panel,
// player-row star icons, auto-save to localStorage) must use this so the lowData
// filter and MC threshold stay consistent.
export function _getTopBets(n=3){
  if(!S.allPlayerBets)return[];
  const edgeOrder={strong:3,moderate:2,small:1,none:0};
  const qualified=[];
  S.allPlayerBets.forEach(pg=>{
    if(pg.lowData)return;
    pg.bets.forEach(b=>{
      if(b.propKey==='batter_home_runs')return;
      if(b.mcConfidence!=null&&b.mcConfidence>=85&&b.edgeStrength!=='none'&&!b.insufficient)
        qualified.push({...b,playerName:pg.playerName});
    });
  });
  const _rankEv=b=>(b.ev??b.absDelta/100)*(b.propKey==='batter_home_runs'?0.7:1);
  qualified.sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||_rankEv(b)-_rankEv(a)||(b.mcConfidence||0)-(a.mcConfidence||0));
  // Hits O/U 1.5 and TB O/U 1.5 on the same player are highly correlated; if
  // both qualify, keep only the better-EV side so the next-best independent
  // bet can take the other slot.
  const HITS_TB=new Set(['batter_hits','batter_total_bases']);
  const seenHitsTb=new Map();
  const filtered=[];
  for(const b of qualified){
    if(HITS_TB.has(b.propKey)){
      const k=`${b.playerName}|${b.line}|${b.direction}`;
      const other=b.propKey==='batter_hits'?'batter_total_bases':'batter_hits';
      if(seenHitsTb.get(k)===other)continue;
      seenHitsTb.set(k,b.propKey);
    }
    filtered.push(b);
    if(filtered.length>=n)break;
  }
  return filtered;
}

// Once-per-game snapshot: at first pitch (current time ≥ scheduled gameDate),
// auto-save the top 8 bets into the Record. Tracked by gamePk in localStorage
// so reloading the dashboard mid-game or post-final doesn't re-save.
export function autoSaveAtFirstPitch(){
  if(!S.allPlayerBets||!S.gameDate||!S.gamePk)return;
  const now=Date.now();
  const firstPitchMs=new Date(S.gameDate).getTime();
  if(isNaN(firstPitchMs)||now<firstPitchMs)return;
  let saved;
  try{saved=JSON.parse(localStorage.getItem('autoSavedGamePks')||'[]');}
  catch(e){saved=[];}
  if(saved.includes(S.gamePk))return;
  const top=_getTopBets(8);
  if(!top.length)return;
  const date=document.getElementById('game-date').value||new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  let added=0;
  top.forEach((b,i)=>{
    const prop=`${b.direction} ${b.line} ${b.prop}`;
    if(S.betLog.some(x=>x.date===date&&x.prop===prop&&x.player===b.playerName))return;
    const rating=b.edgeStrength==='strong'?'green':b.edgeStrength==='moderate'?'yellow':'red';
    const betOdds=b.direction?.toLowerCase()==='over'?b.overBest?.price:b.underBest?.price;
    S.betLog.unshift({id:Date.now()+i,date,player:b.playerName,playerId:_playerIdByName(b.playerName),opponent:S.opposingTeamAbbr||'',prop,odds:betOdds,rating,score:b._playerScore,result:null,
      modelProb:b.modelProb??null,mcConfidence:b.mcConfidence??null,marketOverProb:b.marketOverProb??null,
      modelProbRaw:b.modelProbRaw??null,scoreBase:b.scoreBase??null,rateBase:b.rateBase??null,
      propKey:b.propKey??null,direction:b.direction??null,line:b.line??null,ev:b.ev??null});
    added++;
  });
  saved.push(S.gamePk);
  // Cap the saved-gamePks list to avoid unbounded growth (well past a season)
  if(saved.length>500)saved.splice(0,saved.length-500);
  localStorage.setItem('autoSavedGamePks',JSON.stringify(saved));
  if(added){
    localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
    _betsChanged();
  }
}

export function autoRegisterGradePredictions() {
  if (!S.players) return;
  // Don't seed Pending Grades until the actual lineup is posted. Before then
  // we'd be registering speculative cards for players who may not even start
  // (Vargas, Gurriel splits, etc.). loadLineupContext() sets S.lineupRoster
  // only when the MLB API confirms a starting lineup for the day.
  if (!S.lineupRoster || S.lineupRoster.length === 0) return;
  const date = document.getElementById('game-date').value
    || new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  const pitcherName = S.pitcher?.name || '';
  const idBase = Date.now();
  let idOffset = 0;
  // Only register players who are in the confirmed lineup, not the full roster
  const lineupIds = new Set(S.lineupRoster.map(p => String(p.id)));
  Object.entries(S.players).forEach(([playerId, snap]) => {
    if (!snap.score || !snap.factors) return;
    if (!lineupIds.has(String(playerId))) return;
    savePredictionForGrading({
      _id: idBase + idOffset++,
      score: snap.score,
      tier: snap.tier,
      factors: snap.factors,
      playerName: snap.name,
      pitcherName,
      date,
    }, playerId);
  });
}

export function setResult(id,result){
  const bet=S.betLog.find(b=>b.id===id);
  if(!bet)return;
  // Toggle off if same result clicked again
  bet.result=bet.result===result?null:result;
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  _betsChanged();
}

export function deleteBet(id){
  S.betLog=S.betLog.filter(b=>b.id!==id);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  _betsChanged();
}

export function clearRecord(){
  if(!confirm('Clear all bet records?'))return;
  S.betLog=[];
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  _betsChanged();
}

// ── Manual bet entry ─────────────────────────────────────────────────────────

export function toggleAddBetForm(){
  const form=document.getElementById('add-bet-form');
  const btn=document.getElementById('add-bet-toggle');
  const isHidden=form.classList.contains('hidden');
  form.classList.toggle('hidden',!isHidden);
  if(btn)btn.style.color=isHidden?'#2ecc71':'#5bc0de';
  if(isHidden){
    // Default date to today AZ (UTC-7)
    const azToday=new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
    document.getElementById('abf-date').value=azToday;
    // Populate player datalist from current roster
    const dl=document.getElementById('abf-player-list');
    if(dl)dl.innerHTML=activeRoster().map(p=>`<option value="${p.name}">`).join('');
    document.getElementById('abf-player').focus();
  }
}

export function abfSetDir(dir){
  document.getElementById('abf-over').classList.toggle('active',dir==='Over');
  document.getElementById('abf-under').classList.toggle('active',dir==='Under');
}

export function abfSetResult(result){
  ['win','loss','push'].forEach(r=>document.getElementById(`abf-${r}`)?.classList.toggle('active',r===result));
  document.getElementById('abf-none')?.classList.toggle('active',result===null);
}

export function addManualBet(){
  const date=document.getElementById('abf-date').value;
  const player=document.getElementById('abf-player').value.trim();
  const propKey=document.getElementById('abf-prop').value;
  const lineRaw=document.getElementById('abf-line').value;
  const lineVal=parseFloat(lineRaw);
  const oddsRaw=document.getElementById('abf-odds').value.trim();
  const oddsVal=oddsRaw?parseInt(oddsRaw,10)||null:null;
  const dir=document.getElementById('abf-over')?.classList.contains('active')?'Over':'Under';
  const resultBtns=['win','loss','push'].filter(r=>document.getElementById(`abf-${r}`)?.classList.contains('active'));
  const result=resultBtns[0]||null;

  if(!date){alert('Please enter a date.');return;}
  if(!player){alert('Please enter a player name.');return;}
  if(isNaN(lineVal)||lineVal<=0){alert('Please enter a valid line (e.g. 1.5).');return;}
  if(oddsVal!=null&&(Math.abs(oddsVal)<100)){alert('Odds must be ≥ +100 or ≤ -100 (e.g. -110, +150).');return;}

  const propLabel=_MANUAL_PROP_LABELS[propKey]||propKey;
  const prop=`${dir} ${lineVal} ${propLabel}`;

  if(S.betLog.some(x=>x.date===date&&x.prop===prop&&x.player===player)){
    alert('This bet is already in your record.');return;
  }

  S.betLog.unshift({
    id:Date.now(),date,player,playerId:_playerIdByName(player)||null,
    opponent:'',prop,propKey,direction:dir,line:lineVal,
    odds:oddsVal,rating:null,score:null,result,
    modelProb:null,mcConfidence:null,marketOverProb:null,ev:null,
  });
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  _betsChanged();
  // Reset for next entry (keep date and prop selected)
  document.getElementById('abf-player').value='';
  document.getElementById('abf-line').value='';
  document.getElementById('abf-odds').value='';
  abfSetDir('Over');
  abfSetResult(null);
  document.getElementById('abf-player').focus();
}

// ── Grading: pending → grade log ─────────────────────────────────────────────

// Called when Run Prediction fires — saves prediction to pending
export function savePredictionForGrading(prediction, overridePlayerId = null) {
  const pending = getPending();
  const entry = {
    id: prediction._id ?? Date.now(),
    date: prediction.date || new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0],
    score: prediction.score,
    tier: prediction.tier?.label || prediction.tier || '',
    playerName: prediction.playerName,
    playerId: String(overridePlayerId ?? S.playerId ?? ''),
    pitcherName: prediction.pitcherName,
    // Persist adj so updateFactorPerf can credit hits by actual sign instead of
    // the magnitude-thresholded impact label (which buckets every |adj|≤2 as
    // 'neutral' and was silently miscounting them as negative).
    factors: prediction.factors.map(f => ({ label: f.label, impact: f.impact, value: f.value, adj: f.adj })),
    graded: false,
  };
  // One card per (player, date) — re-running a prediction for the same player on
  // the same day refreshes that card, but predictions on different days each get
  // their own pending entry and persist until graded. Coerce playerId to String
  // to defeat legacy entries that stored it numerically.
  const existingIdx = pending.findIndex(p =>
    String(p.playerId) === entry.playerId && p.date === entry.date
  );
  if (existingIdx >= 0) pending[existingIdx] = entry;
  else pending.unshift(entry);
  // Cap at 500 (≈8 players × 60 days) to keep localStorage bounded while never
  // pruning entries the user could realistically still want to grade.
  savePending(pending.slice(0, 500));
}

// Cleanup duplicate pending entries from repeated prediction runs. Dedup key is
// (playerId, date) so each player keeps one card per game day — entries from
// different days are preserved so the user can grade past games whenever they
// catch up. Newest-first array order means lowest index wins (most recent run).
export function dedupePending() {
  const pending = getPending();
  const seen = new Set();
  const cleaned = [];
  for (const entry of pending) {
    const pid = String(entry.playerId ?? entry.playerName ?? entry.id);
    const key = `${pid}|${entry.date || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(entry);
  }
  if (cleaned.length !== pending.length) {
    log(`[pending] removed ${pending.length - cleaned.length} duplicate(s)`);
    savePending(cleaned);
  }
}

// Fetch actual Carroll stats for a given date from MLB API
export async function fetchActualStats(playerId, date) {
  // Convert YYYY-MM-DD to MM/DD/YYYY for MLB API date filter params
  const [y, m, d] = date.split('-');
  const mlbDate = `${m}/${d}/${y}`;
  const season = y || String(SEASON);
  const data = await api.mlbBatterGameLogRange(playerId, mlbDate, season);
  const splits = data?.stats?.[0]?.splits ?? [];
  if (!splits.length) return null;
  // Use first split (covers doubleheader game 1; acceptable for grading).
  // Guard against the API returning a game from a different date (off-days, postponements).
  const game = splits[0];
  if (game.date && game.date !== date) {
    console.warn(`[grade] fetchActualStats: requested ${date} but MLB API returned ${game.date} — skipping`);
    return null;
  }
  const s = game.stat;
  return {
    hits:         s.hits ?? 0,
    totalBases:   s.totalBases ?? 0,
    homeRuns:     s.homeRuns ?? 0,
    walks:        s.baseOnBalls ?? 0,
    strikeOuts:   s.strikeOuts ?? 0,
    rbi:          s.rbi ?? 0,
    runs:         s.runs ?? 0,
    atBats:       s.atBats ?? 0,
    pa:           s.plateAppearances ?? 0,
    summary:      s.summary ?? '',
    opponent:     game.opponent?.name ?? '',
    isHome:       game.isHome ?? false,
    isWin:        game.isWin ?? false,
    _raw:         s,
  };
}

// Recompute factorPerf from scratch off the current gradeLog. Called after an
// entry is edited or deleted so stale fires/hits from the removed (or changed)
// entry don't linger in the per-factor stats. Mirrors the per-factor
// accumulation inside updateFactorPerf so the two stay in sync.
function _rebuildFactorPerf() {
  const perf = {};
  for (const entry of getGradeLog()) {
    if (!entry.factors || !entry.grade) continue;
    const perfGood = entry.grade.actuallyGood;
    for (const f of entry.factors) {
      // Canonicalize on rebuild too so historical metric-specific pitcher
      // labels collapse into the unified bucket.
      const label = _canonicalFactorLabel(f.label);
      if (!perf[label]) perf[label] = { fires: 0, hits: 0, totalPerf: 0 };
      perf[label].fires++;
      perf[label].totalPerf += (entry.grade.perfScore || 0);
      let factorPositive;
      if (typeof f.adj === 'number') {
        if (f.adj === 0) continue;
        factorPositive = f.adj > 0;
      } else {
        factorPositive = f.impact === 'positive';
      }
      if ((factorPositive && perfGood) || (!factorPositive && !perfGood)) perf[label].hits++;
    }
  }
  saveFactorPerf(perf);
}

// Remove a graded entry. Used when MLB API returns wrong stats or the user
// wants to redo a prediction from scratch.
export function deleteGradeEntry(id) {
  if (!confirm('Remove this graded entry from the log? This also recomputes the factor-performance stats.')) return;
  const next = getGradeLog().filter(g => g.id !== id);
  saveGradeLog(next);
  _rebuildFactorPerf();
  _gradesChanged();
}

// Edit the actual-stats payload for a graded entry. Lets the user correct
// rows where MLB API returned wrong info (DH split miscounted, doubleheader
// games swapped, etc.). Re-runs gradePerformance and rebuilds factorPerf so
// the outcome label + Model Learning stats reflect the corrected values.
export function editGradeEntry(id) {
  const entries = getGradeLog();
  const entry = entries.find(g => g.id === id);
  if (!entry) return;
  const a = entry.actual || {};
  const current = `${a.hits||0},${a.totalBases||0},${a.homeRuns||0},${a.walks||0},${a.strikeOuts||0},${a.rbi||0},${a.runs||0}`;
  const input = prompt(
    `Edit actual stats for ${entry.playerName} on ${entry.date}\n\n` +
    `Format: H,TB,HR,BB,K,RBI,R\n` +
    `Current: ${current}\n\nEnter new values (comma-separated):`,
    current
  );
  if (input == null) return;
  const parts = input.split(',').map(s => parseInt(s.trim(), 10));
  if (parts.length !== 7 || parts.some(n => isNaN(n) || n < 0)) {
    alert('Invalid input — need 7 non-negative integers (H,TB,HR,BB,K,RBI,R).');
    return;
  }
  const [hits, totalBases, homeRuns, walks, strikeOuts, rbi, runs] = parts;
  entry.actual = { ...a, hits, totalBases, homeRuns, walks, strikeOuts, rbi, runs,
    summary: `${hits}-${a.atBats||hits}${walks?', '+walks+' BB':''}${strikeOuts?', '+strikeOuts+' K':''}` };
  entry.grade = gradePerformance(entry.actual, entry.score);
  saveGradeLog(entries);
  _rebuildFactorPerf();
  _gradesChanged();
}

// Grade a performance — returns outcome category + continuous calibration.
export function gradePerformance(actual, predScore) {
  // wOBA-calibrated weights. TB captures hit quality without double-counting raw hits.
  // Walk ≈ 75% of a single → 15 pts vs 20 pts (1 TB). K is unambiguously negative.
  // Cap raised 100 → 150 so monster days (multi-HR, 4-for-4 with XBH) no longer
  // saturate to the same value as a "great" 1-HR day. Outcome thresholds are
  // unchanged so bucket semantics still hold; chart Y axis extended to 150.
  const raw = (actual.totalBases * 20) + (actual.walks * 15)
            + (actual.runs * 5) + (actual.rbi * 5)
            - (actual.strikeOuts * 4);
  const perfScore = Math.max(0, Math.min(150, raw));
  const outcome = perfScore >= 65 ? 'great' : perfScore >= 40 ? 'good' : perfScore >= 15 ? 'avg' : 'poor';

  // Model-accuracy: bucket match between predicted and actual outcome is the
  // primary signal. Residual is a tiebreaker for mismatched buckets only.
  //
  // The pure-residual version (kept around as a tooltip detail) wrongly fires
  // "off" when a player overperforms past the model's structural ceiling —
  // predScore caps at 100, so expectedPerf caps at 80, but perfScore can reach
  // 150. A correctly-predicted Great (score 80, perfScore 126) would otherwise
  // grade as off purely because of the gap between bounded prediction and
  // unbounded outcome.
  //
  // Predicted outcome thresholds mirror the score-driven verdict copy:
  //   ≥75 great · ≥60 good · ≥40 avg · else poor.
  const expectedPerf = Math.max(0, Math.min(150, predScore - 20));
  const residual = perfScore - expectedPerf;
  const absResidual = Math.abs(residual);
  const predOutcome = predScore >= 75 ? 'great' : predScore >= 60 ? 'good' : predScore >= 40 ? 'avg' : 'poor';
  const outcomeRank = { poor: 0, avg: 1, good: 2, great: 3 };
  const bucketDistance = Math.abs(outcomeRank[outcome] - outcomeRank[predOutcome]);
  const accuracy =
    bucketDistance === 0 || absResidual <= 20 ? 'accurate' :
    bucketDistance === 1 || absResidual <= 40 ? 'close' :
    'off';

  // Retained for updateFactorPerf hit/miss attribution — unchanged semantics.
  const actuallyGood = perfScore >= 40;

  return {
    perfScore, outcome, actuallyGood,
    expectedPerf, residual, accuracy,
    // Legacy fields preserved for back-compat with older stored grade entries.
    modelAccurate: accuracy === 'accurate',
    modelExpectedGood: predScore >= 60,
  };
}

// Update factor performance stats after grading.
//
// Hit-rate semantics: a "hit" means the factor pushed the score in the
// direction the actual outcome went. Positive-adj factor + good performance
// = hit; negative-adj factor + poor performance = hit; everything else
// (including zero-adj factors) = no hit, but still a fire.
//
// We use the stored `adj` sign rather than the magnitude-thresholded `impact`
// label. The old impact-based check treated every |adj|≤2 as 'neutral' and
// then in the conditional treated 'neutral' as 'negative' — so every small
// factor (Crosswind −2, Roof Closed −2, High Humidity −1, Lucky/Unlucky
// Pitcher ±2, Same-Day Travel −3, HR Suppressor −2, FB% +2, Extra Rest −2,
// High Prev PC +2, weak Lineup Protection, etc.) was silently miscounted as
// a "negative factor" and earned a phantom hit whenever the player did
// poorly. For older pending entries that lack `adj`, fall back to the
// impact label to preserve historical (biased) behavior rather than
// dropping the data.
function updateFactorPerf(factors, actual, gradeResult) {
  const perf = getFactorPerf();
  const perfGood = gradeResult.actuallyGood;
  factors.forEach(f => {
    // Canonicalize so historical gradeLog entries with metric-specific labels
    // (Pitcher SIERA/xFIP/FIP/ERA) accumulate into the unified bucket.
    const label = _canonicalFactorLabel(f.label);
    if (!perf[label]) perf[label] = { fires: 0, hits: 0, totalPerf: 0 };
    perf[label].fires++;
    perf[label].totalPerf += gradeResult.perfScore;
    let factorPositive;
    if (typeof f.adj === 'number') {
      if (f.adj === 0) return; // factor fired but didn't move the score — no hit either way
      factorPositive = f.adj > 0;
    } else {
      // Legacy entry without persisted adj — fall back to impact label
      factorPositive = f.impact === 'positive';
    }
    if ((factorPositive && perfGood) || (!factorPositive && !perfGood)) perf[label].hits++;
  });
  saveFactorPerf(perf);
  // Auto-adjust weights after 15+ graded games
  const entries = getGradeLog();
  if (entries.length >= 15) autoAdjustWeights(perf, entries.length);
}

// Auto-adjust factor weights using Bayesian shrinkage to prevent small-sample drift.
// Old behavior had stepped adjustments at 5/15/30% with cliffs at 60%/70%/etc.
// hit-rate buckets, so a 5-game hot streak could move weights ±30% from default.
//
// New behavior:
//   1. Posterior hit rate = (hits + α/2) / (fires + α) with α=20 (Beta(10,10) prior).
//      Shrinks raw hit rate toward 0.5 by an amount proportional to sample weakness.
//      Factor with 5 fires/4 hits (raw 80%) → posterior 56% (modest signal).
//      Factor with 100 fires/80 hits (raw 80%) → posterior 75% (strong signal).
//   2. Continuous adjustment: 1 + (postRate - 0.5) * 0.8, capped at [0.5, 1.5].
//      Cap widened (was [0.7, 1.3]) so that learning produces a visible effect
//      given that scoreBase is only 40% of the final probability blend.
//   3. Minimum 10 fires before any adjustment — even with shrinkage, <10 is noise.
function autoAdjustWeights(perf, gameCount) {
  const weights = getFactorWeights();
  const ALPHA = 20; // Beta(10,10) prior — neutral, modest strength
  Object.entries(perf).forEach(([factor, data]) => {
    if (data.fires < 10) return;
    const defaultW = DEFAULT_WEIGHTS[factor];
    if (!defaultW) return;
    const postRate = (data.hits + ALPHA / 2) / (data.fires + ALPHA);
    let mult = 1 + (postRate - 0.5) * 0.8;
    mult = Math.max(0.5, Math.min(1.5, mult));
    weights[factor] = Math.round(defaultW * mult * 10) / 10;
  });
  saveFactorWeights(weights);
}

// Confirm grade for a pending prediction
async function confirmGrade(pendingId, actualStats) {
  const pending = getPending();
  const pred = pending.find(p => p.id === pendingId);
  if (!pred) return;

  const gradeResult = gradePerformance(actualStats, pred.score);
  updateFactorPerf(pred.factors, actualStats, gradeResult);

  // Add to grade log
  const entries = getGradeLog();
  entries.unshift({
    id: pendingId,
    date: pred.date,
    score: pred.score,
    tier: pred.tier,
    playerName: pred.playerName,
    pitcherName: pred.pitcherName,
    factors: pred.factors,
    actual: actualStats,
    grade: gradeResult,
  });
  // Cap at 500 entries (was 100). updateFactorPerf accumulates fires across all
  // graded games, but _rebuildFactorPerf only walks gradeLog — so any cap below
  // the all-time graded count silently drops historical fires whenever a user
  // edits or deletes an entry. 500 matches the pending cap and gives 5× more
  // headroom before that drift can start.
  saveGradeLog(entries.slice(0, 500));

  // Remove from pending
  savePending(pending.filter(p => p.id !== pendingId));
  _gradesChanged();
}

export function clearGrades() {
  if (!confirm('Clear all graded games and reset model weights?')) return;
  localStorage.removeItem(GRADE_LOG_KEY);
  localStorage.removeItem(FACTOR_PERF_KEY);
  localStorage.removeItem(FACTOR_WEIGHTS_KEY);
  localStorage.removeItem(PENDING_KEY);
  _gradesChanged();
}

export async function autoGrade(predId, playerId, date) {
  const btn = document.querySelector(`#grade-actions-${predId} button`);
  if (btn) { btn.textContent = '⟳ Fetching...'; btn.disabled = true; }

  try {
    const actual = await fetchActualStats(playerId, date);
    if (!actual) {
      // Game not found — might not have finished yet
      if (btn) { btn.textContent = '⟳ Fetch & Grade'; btn.disabled = false; }
      const actionsEl = document.getElementById(`grade-actions-${predId}`);
      if (actionsEl && !actionsEl.querySelector('.remove-btn')) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'grade-btn remove-btn';
        removeBtn.textContent = '✕ Remove';
        removeBtn.style.cssText = 'background:#2a1a1a;color:#e74c3c;border:1px solid #e74c3c;';
        removeBtn.onclick = () => removePending(predId);
        actionsEl.appendChild(removeBtn);
        const note = document.createElement('span');
        note.style.cssText = 'font-size:10px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;';
        note.textContent = 'Game not found — may not have played';
        actionsEl.appendChild(note);
      }
      return;
    }

    // Player didn't appear in the game (0 PA = didn't play)
    if ((actual.pa ?? 0) === 0) {
      const actionsEl = document.getElementById(`grade-actions-${predId}`);
      if (actionsEl) {
        actionsEl.innerHTML = `
          <button class="grade-btn remove-btn" style="background:#2a1a1a;color:#e74c3c;border:1px solid #e74c3c;" data-action="remove-pending" data-pred-id="${predId}">✕ Remove (didn't play)</button>
          <span style="font-size:10px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;">Player had 0 PA — no at-bats recorded</span>`;
      }
      return;
    }

    // Show actual stats
    const statMap = { H: actual.hits, TB: actual.totalBases, HR: actual.homeRuns, BB: actual.walks, K: actual.strikeOuts, RBI: actual.rbi };
    Object.entries(statMap).forEach(([key, val]) => {
      const el = document.getElementById(`stat-${predId}-${key}`);
      if (el) { el.textContent = val; el.classList.remove('loading'); el.style.color = val > 0 ? '#2ecc71' : '#fff'; }
    });
    // Add collapsible raw stats for spot-checking against box score
    const statsEl = document.getElementById(`stats-${predId}`);
    if (statsEl && !statsEl.querySelector('.raw-stats-details')) {
      const det = document.createElement('details');
      det.className = 'raw-stats-details';
      det.style.cssText = 'grid-column:1/-1;font-size:9px;font-family:\'Chakra Petch\',monospace;color:#555;margin-top:4px;';
      det.innerHTML = `<summary style="cursor:pointer;color:#444;letter-spacing:1px;">RAW MLB API</summary><pre style="color:#555;white-space:pre-wrap;font-size:9px;margin:4px 0 0;">${JSON.stringify(actual._raw||actual,null,2)}</pre>`;
      statsEl.appendChild(det);
    }
    if (btn) { btn.textContent = '✓ Confirm Grade'; btn.disabled = false; btn.onclick = () => confirmGrade(predId, actual); }
  } catch(e) {
    if (btn) { btn.textContent = '⟳ Fetch & Grade'; btn.disabled = false; }
    alert('Could not fetch stats: ' + e.message);
  }
}

export function removePending(predId) {
  savePending(getPending().filter(p => p.id !== predId));
  _gradesChanged();
}

// ── Auto-grade pending bets ──────────────────────────────────────────────────
// Walks S.betLog for entries with result===null and a past game date, fetches
// the actual MLB game log for the (player, date), and grades the bet against
// its prop line. Bets without a propKey (legacy entries from before the field
// was stored) are left untouched.

export async function autoGradeBetLog(){
  const pending=S.betLog.filter(b=>!b.result&&b.propKey&&b.line!=null&&b.direction&&_isPastDate(b.date));
  if(!pending.length){
    alert('No pending bets to grade (need: past date, prop key, and line).');
    return;
  }
  const btns=document.querySelectorAll('.autograde-btn');
  btns.forEach(b=>{b.textContent='⟳ Grading…';b.disabled=true;});

  // Cache stats per (playerId|date) so duplicate fetches don't hammer the API
  // when the same player has multiple bets on the same date.
  const statCache=new Map();
  let graded=0,skipped=0,errors=0;

  for(const bet of pending){
    const pid=bet.playerId||_playerIdByName(bet.player);
    if(!pid){ skipped++; continue; }
    const cacheKey=`${pid}|${bet.date}`;
    let actual;
    if(statCache.has(cacheKey)){
      actual=statCache.get(cacheKey);
    } else {
      try{
        actual=await fetchActualStats(pid,bet.date);
        statCache.set(cacheKey,actual);
      }catch(e){
        console.error('[autograde] fetch failed for',bet.player,bet.date,e);
        errors++; continue;
      }
    }
    if(!actual){ skipped++; continue; }
    const getter=_PROP_STAT_GETTER[bet.propKey];
    if(!getter){ skipped++; continue; }
    // 0-PA games: player didn't appear. Sportsbooks usually void these (push),
    // but the audit case is clearer for Under bets — 0 < any line ≥ 0.5 is a
    // clean numeric win. Resolve Under as win, skip Over (let user manually
    // mark push or remove, since most books void rather than grading a loss).
    if ((actual.pa ?? 0) === 0) {
      if ((bet.direction || '').toLowerCase() === 'under' && bet.line >= 0.5) {
        bet.result = 'win';
        graded++;
      } else {
        skipped++;
      }
      continue;
    }
    const result=_gradeProp(getter(actual),bet.direction,bet.line);
    if(!result){ skipped++; continue; }
    bet.result=result;
    graded++;
  }

  if(graded>0){
    localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
    _betsChanged();
  }
  btns.forEach(b=>{b.textContent='⟳ Grade';b.disabled=false;});
  alert(`Auto-grade complete\n· Graded: ${graded}\n· Skipped (no game/0 PA/missing data): ${skipped}${errors?`\n· Errors: ${errors}`:''}`);
}
