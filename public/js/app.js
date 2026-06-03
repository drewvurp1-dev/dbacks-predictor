// ═══════════ IMPORTS ═════════════════════════════════════════════════════════
import {
  SEASON,
  ALLOWED_BOOKS, PROP_NAMES,
  UMP_DB, VENUE_MAP, STAT_INFO, DEFAULT_WEIGHTS,
  ODDS_CACHE_KEY,
} from './constants.js';
import { show, hide, setText, _parkFactors, parseCSV } from './utils.js';
import {
  S, DEBUG, log,
  enterPlayerContext, exitPlayerContext,
  activeRoster,
} from './state.js';
import {
  gaussianRandom, _slumpPenalty, _mcVariance,
  _pitchMatchupFactor, _pitchMatchupReason,
  modelProbability, monteCarloConfidence,
} from './predict.js';
import {
  impliedProb, americanToDecimal,
  _medianImpliedProb, devig,
} from './betting.js';
import {
  _loadPitchArsenal,
  setThrows, buildPitchMixGrid,
  onPitcherSearch, selectPitcher,
  applyPitcherVenue,
} from './pitcher.js';
import {
  _factorial, _poissonCDF,
  _gamePAs, _paMultiplier, _ttopBonus, _hrrOverPct,
  _shrunkRate, _binomGE, _convolveTBge, _log5,
  _extractSplitStat, _handSplit, _seasonWoba,
} from './player.js';
import { openModal, closeModal } from './ui/modal.js';
import * as api from './api.js';
import {
  _renderStatTip, statBox,
  _renderStatcastGrid, _renderPitchMatchup,
  buildPredictionSummary, renderFactorCards,
  _renderPitcherCard, _renderBestMatchup,
} from './ui/render.js';
import {
  saveBet, setResult, deleteBet, clearRecord,
  addManualBet, toggleAddBetForm, abfSetDir, abfSetResult,
  autoSaveAtFirstPitch, autoRegisterGradePredictions, _getTopBets,
  savePredictionForGrading, dedupePending, fetchActualStats,
  autoGrade, autoGradeBetLog, removePending,
  editGradeEntry, deleteGradeEntry, clearGrades,
  gradePerformance,
  getGradeLog, getFactorPerf, getFactorWeights, getPending,
  saveGradeLog, saveFactorPerf, saveFactorWeights, savePending,
} from './bets.js';
import {
  renderCorbetBets, togglePhantom,
  renderRecord, setRecordSort,
  renderCalibration,
  renderGradePanel,
  togglePlayerAcc,
} from './ui/record.js';
import {
  pushRecord, pullRecord, _initSyncBtnLabel,
} from './sync.js';
import { loadCalibration, recalibrate } from './calibrate.js';
import {
  _pushSubscribe, _pushTest, _initPushBtn, registerSW,
} from './push.js';
import {
  _windDir, fetchWeather,
} from './weather.js';
import {
  loadTeamMomentum, loadTwoWeekSchedule,
  _renderGameBanner, renderDashboard, togglePlayerCard, setTopBetsSort,
} from './ui/dashboard.js';

function rebuildPlayerSelect(roster){
  const sel=document.getElementById('player-select');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML=roster.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  if(roster.some(p=>String(p.id)===String(cur)))sel.value=cur;
  else{sel.selectedIndex=0;loadPlayer();}
}

// ═══════════ MATH / BETTING UTILS ════════════════════════════════════════════

// (_COMPASS_DEGS, _compassDeg, _windDir moved to weather.js)

// (gaussianRandom moved to predict.js)

// (_computePitcherMetrics + _FIP_CONSTANT + _LG_HRFB moved to pitcher.js)

// (_slumpPenalty + _mcVariance moved to predict.js)

// (monteCarloConfidence moved to predict.js)

// ═══════════ MODAL SYSTEM ════════════════════════════════════════════════════
// (openModal / closeModal / _clearModalSlot / _moveToModal moved to ui/modal.js)
// Re-assert the pitcher card after the modal's DOM-move operations finish.
document.addEventListener('modal:closed', () => _renderPitcherCard());

// bets.js owns S.betLog + the gradeLog/pending/perf/weights stores and emits
// these events on mutation. We re-render the affected panels from here so
// bets.js stays free of upward imports (ui/record.js — PR3 — will take over).
document.addEventListener('bets:changed',   () => { renderRecord(); recalibrate(S.betLog); });
document.addEventListener('grades:changed', () => renderGradePanel());

function openPlayerDetails(playerId) {
  const ctx = enterPlayerContext(playerId);
  if (!ctx) return;
  const snap = ctx.snap;
  const C = 2 * Math.PI * 52;
  document.getElementById('gauge-circle').style.strokeDashoffset = C - (snap.score / 100) * C;
  document.getElementById('gauge-circle').style.stroke = snap.tier.color;
  document.getElementById('gauge-score').textContent = snap.score;
  document.getElementById('gauge-label').textContent = snap.tier.label;
  document.getElementById('gauge-label').style.color = snap.tier.color;
  document.getElementById('gauge-desc').textContent = snap.tier.desc;
  const pn = S.pitcher?.name || 'TBD';
  const hand = S.pitcher?.hand || 'R';
  const era = S.pitcher?.st?.era;
  document.getElementById('pred-header').textContent = `${snap.name} · ${pn} (${hand}HP)${era ? ` · ERA ${parseFloat(era).toFixed(2)}` : ''}`;
  renderFactorCards(snap.factors, snap.catTotals, snap.name);
  buildPredictionSummary(snap.factors);
  // Auto-populate the Pitch Mix matchup grid so users see batter vs pitcher arsenal
  // without having to click Run Prediction. enterPlayerContext already set
  // S.playerId so _renderPitchMatchup keys into the right batter row in S.pitchArsenal.
  document.getElementById('pitch-display').innerHTML = _renderPitchMatchup();
  document.getElementById('result-nav-btns').style.display = 'none';
  hide('no-prediction'); show('prediction-output');
  openModal('panel-result', snap.name + ' · Details');
}

function openPlayerCorbet(playerId) {
  const ctx = enterPlayerContext(playerId);
  if (!ctx) return;
  const snap = ctx.snap;
  const playerBets = S.allPlayerBets?.filter(pg => pg.playerName === snap.name) || [];
  if (!playerBets.length) {
    document.getElementById('corbet-no-prediction').textContent = 'No bets available for this player.';
    show('corbet-no-prediction'); hide('corbet-bets'); hide('corbet-player-filter');
  } else {
    // Save allPlayerBets and corbetBetsMap so the full-tab save buttons remain correct
    // after this modal closes. With content-keyed map lookup, the modal buttons also work
    // against the restored full map since each bet's key is stable across both contexts.
    const savedAll = S.allPlayerBets;
    const savedMap = S.corbetBetsMap;
    const savedFlat = S.corbetBets;
    S.allPlayerBets = playerBets;
    hide('corbet-no-prediction'); hide('corbet-loading'); hide('corbet-player-filter');
    renderCorbetBets();
    show('corbet-bets');
    S.allPlayerBets = savedAll;
    S.corbetBetsMap = savedMap || S.corbetBetsMap; // keep player map if no full-tab map exists yet
    S.corbetBets = savedFlat;
  }
  openModal('panel-corbet', snap.name + ' · CorBET');
}

function openPlayerStats(playerId) {
  const ctx = enterPlayerContext(playerId);
  if (!ctx) return;
  const snap = ctx.snap;
  renderSplitsTab(); renderStatsTab();
  // Statcast grid isn't part of renderStatsTab — render it from the swapped-in
  // player snapshot so it doesn't show the last Setup-panel player's numbers.
  _renderStatcastGrid(S.statcast);
  openModal(['panel-splits', 'panel-stats'], snap.name + ' · Stats');
}

function setApiCredits(remaining) {
  const el = document.getElementById('api-credits');
  if (!el) return;
  const n = parseInt(remaining) || 0;
  el.textContent = n + ' credits';
  el.className = 'api-credits' + (n < 50 ? ' critical' : n < 200 ? ' low' : '');
}

// ═══════════ SPORTSBOOK ABBREVIATIONS ════════════════════════════════════════
// (bookAbbrev moved to betting.js)

// ═══════════ ODDS LOCK ════════════════════════════════════════════════════════
// Don't refetch odds once the game has started — live in-game lines move wildly
// and we don't bet live. Lock window: game-start → next calendar day 06:00 MST.
// Arizona is UTC-7 year-round (no DST), so 06:00 MST == 13:00 UTC.
function isOddsLocked(gameDateISO){
  if(!gameDateISO)return false;
  const start=new Date(gameDateISO);
  if(isNaN(start))return false;
  const mstStart=new Date(start.getTime()-7*3600*1000);
  const unlockUTC=Date.UTC(
    mstStart.getUTCFullYear(),
    mstStart.getUTCMonth(),
    mstStart.getUTCDate()+1,
    13,0,0
  );
  const now=Date.now();
  return now>=start.getTime()&&now<unlockUTC;
}

function readOddsCache(gameId){
  if(!gameId)return null;
  try{
    const all=JSON.parse(localStorage.getItem(ODDS_CACHE_KEY)||'{}');
    return all[gameId]||null;
  }catch{return null;}
}
function writeOddsCache(gameId,payload){
  if(!gameId)return;
  try{
    const all=JSON.parse(localStorage.getItem(ODDS_CACHE_KEY)||'{}');
    all[gameId]={savedAt:Date.now(),eventsGame:payload.eventsGame,propData:payload.propData};
    // Keep at most 30 entries, newest first
    const entries=Object.entries(all).sort((a,b)=>(b[1].savedAt||0)-(a[1].savedAt||0)).slice(0,30);
    localStorage.setItem(ODDS_CACHE_KEY,JSON.stringify(Object.fromEntries(entries)));
  }catch{}
}
function setOddsLockBadge(savedAt){
  const el=document.getElementById('odds-lock-badge');
  if(!el)return;
  if(savedAt){
    const t=new Date(savedAt);
    el.textContent='Odds locked · pre-game line';
    el.title=`Frozen at ${t.toLocaleString()}`;
    el.classList.remove('hidden');
  }else{
    el.classList.add('hidden');
  }
}

// ═══════════ TOGGLES ══════════════════════════════════════════════════════════
// (setThrows moved to pitcher.js)
function setHome(v){S.isHome=v;document.getElementById('loc-home').classList.toggle('active',v);document.getElementById('loc-away').classList.toggle('active',!v);}
function setDay(v){S.dayGame=v;document.getElementById('time-day').classList.toggle('active',v);document.getElementById('time-night').classList.toggle('active',!v);}
function setRoof(v){S.roofClosed=v;document.getElementById('roof-closed').classList.toggle('active',v);document.getElementById('roof-open').classList.toggle('active',!v);}
function onStadiumChange(){const sel=document.getElementById('stadium-select');const opt=sel.options[sel.selectedIndex];document.getElementById('roof-row').classList.toggle('hidden',opt.dataset.roof!=='1');}
function toggleManual(){S.pitcherManual=!S.pitcherManual;document.getElementById('pitcher-manual').classList.toggle('hidden',!S.pitcherManual);buildPitchMixManual();}
function toggleWeatherManual(){S.weatherManual=!S.weatherManual;document.getElementById('weather-manual').classList.toggle('hidden',!S.weatherManual);}

// ═══════════ PITCH MIX ════════════════════════════════════════════════════════
// (buildPitchMixGrid moved to pitcher.js)
function buildPitchMixManual(){buildPitchMixGrid('pitch-mix-grid-manual',S.pitcherPitches);}

// ═══════════ PLAYER LOADING ═══════════════════════════════════════════════════
async function loadPlayer(){
  const sel=document.getElementById('player-select');
  S.playerId=sel.value; S.playerName=sel.options[sel.selectedIndex].text.split(' · ')[0];
  show('player-spinner');hide('player-error');hide('splits-pills');
  document.getElementById('splits-card-header').textContent=`📈 ${S.playerName} · ${SEASON} Splits`;
  document.getElementById('stats-card-header').textContent=`📊 ${S.playerName} · Advanced Stats ${SEASON}`;
  showSplitsLoading();showStatsLoading();
  try {
    const [sd,ss,rd]=await Promise.all([
      api.mlbBatterSplits(S.playerId),
      api.mlbBatterSeason(S.playerId),
      api.mlbBatterSplits(S.playerId, 'risp'),
    ]);
    const byCode={};
    (sd?.stats?.[0]?.splits??[]).forEach(s=>{if(s.split?.code)byCode[s.split.code]=_extractSplitStat(s.stat);});
    S.splits=byCode;
    S.seasonStat=ss?.stats?.[0]?.splits?.[0]?.stat??null;
    S.rispStat=rd?.stats?.[0]?.splits?.[0]?.stat??null;
    renderSplitPills();renderSplitsTab();renderStatsTab();
    loadStatcast(S.playerId);
    loadGameLog();
    if(S.pitcher?.id) loadMatchupStats();
  } catch(e){setText('player-error','⚠ Could not load data.');show('player-error');showSplitsError('Could not load.');showStatsError('Could not load.');}
  finally{hide('player-spinner');}
}

// ═══════════ GAME LOG ══════════════════════════════════════════════════════════
async function loadGameLog(){
  try{
    const d=await api.mlbBatterGameLog(S.playerId);
    const games=d?.stats?.[0]?.splits||[];
    S.recentGameLog=games.slice(-10).reverse(); // most recent first
  }catch(e){ S.recentGameLog=null; }
}

// (onPitcherSearch, selectPitcher, loadPitcherStatcast moved to pitcher.js;
//  renderPitcherTab + _renderPitcherSeasonBoxes moved to ui/render.js.
//  pitcher.js dispatches `pitcher:selected` so we can re-fire the matchup +
//  dashboard loaders without pitcher.js importing upward.)
document.addEventListener('pitcher:selected', (e) => {
  loadMatchupStats();
  if (e.detail?.fullReload) loadDashboard();
  else _renderPitcherCard();
});

// ═══════════ UMPIRE ════════════════════════════════════════════════════════════

async function loadUmpireAndWeather(){
  const dv=document.getElementById('game-date').value;
  if(!dv)return;
  await Promise.all([loadUmpire(dv),fetchWeather(),loadLineupContext(dv)]);
}

async function loadUmpire(dv){
  show('ump-spinner');hide('ump-content');setText('ump-empty','');
  try{
    const d=await api.mlbScheduleDate(dv, 'officials');
    const game=d?.dates?.[0]?.games?.[0];
    if(!game){setText('ump-empty','No D-backs game found on that date.');hide('ump-spinner');show('ump-empty');return;}
    const hp=(game.officials||[]).find(o=>o.officialType==='Home Plate');
    if(!hp){setText('ump-empty','Umpire data not yet available.');hide('ump-spinner');show('ump-empty');return;}
    S.umpire=hp.official;
    const ut=UMP_DB[hp.official.fullName]||{tendency:'neutral',adj:0,note:'No significant zone bias on record.'};
    document.getElementById('ump-content').innerHTML=`<div class="ump-box"><div class="ump-sub">Home Plate Umpire</div><div class="ump-name">${hp.official.fullName}</div><div class="ump-tendency ${ut.tendency}">${ut.tendency==='pitcher'?'Pitcher-Friendly':ut.tendency==='hitter'?'Hitter-Friendly':'Neutral Zone'}</div><div style="font-size:11px;color:#999;font-family:\'Chakra Petch\',monospace;margin-top:8px;">${ut.note}</div>${ut.adj!==0?`<div style="font-size:10px;color:#999;font-family:\'Chakra Petch\',monospace;margin-top:4px;">Est. run impact: <strong style="color:${ut.adj>0?'#2ecc71':'#e74c3c'}">${ut.adj>0?'+':''}${ut.adj} R/G</strong></div>`:''}`;
    show('ump-content');
  }catch(e){console.warn('Umpire load failed:',e.message);setText('ump-empty','Could not load umpire data.');show('ump-empty');}
  finally{hide('ump-spinner');}
}

// ═══════════ BATTER VS PITCHER MATCHUP ════════════════════════════════════════
async function loadMatchupStats(){
  if(!S.playerId||!S.pitcher?.id){hide('matchup-section');return;}
  show('matchup-section');show('matchup-spinner');hide('matchup-content');
  S.matchupStats=null;
  try{
    // Include season-scoped first so new pitchers with no prior history still resolve correctly
    const d=await api.mlbVsPitcher(S.playerId, S.pitcher.id, true);
    let st=d?.stats?.[0]?.splits?.[0]?.stat;

    // If season-scoped query returns nothing, fall back to all-time total
    if(!st||parseInt(st?.atBats)===0){
      const d2=await api.mlbVsPitcher(S.playerId, S.pitcher.id, false);
      st=d2?.stats?.[0]?.splits?.[0]?.stat;
    }

    const ab=parseInt(st?.atBats)||0;
    if(!st||ab===0){
      const pLast=S.playerName.split(' ').pop();
      const pitLast=S.pitcher.name?.split(' ').pop()||S.pitcher.name||'this pitcher';
      document.getElementById('matchup-content').innerHTML=`<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;">${pLast} has no recorded plate appearances vs. ${pitLast} — first-time matchup.</div>`;
      show('matchup-content');hide('matchup-spinner');return;
    }
    const ops=parseFloat(st.ops)||0;
    const h=parseInt(st.hits)||0;
    const hr=parseInt(st.homeRuns)||0;
    const k=parseInt(st.strikeOuts)||0;
    const bb=parseInt(st.baseOnBalls)||0;
    S.matchupStats={ab,h,hr,k,bb,ops,avg:st.avg,obp:st.obp,slg:st.slg};
    const opsColor=ops>=0.900?'#2ecc71':ops>=0.750?'#ccc':ops>=0.600?'#f39c12':'#e74c3c';
    const sample=ab>=20?'Solid sample':ab>=10?'Moderate sample':'⚠ Small sample';
    document.getElementById('matchup-content').innerHTML=`
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:8px;">
        <div><div style="font-size:9px;color:#888;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;text-transform:uppercase;">OPS</div><div style="font-size:26px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:${opsColor}">${st.ops}</div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${[['AVG',st.avg],['OBP',st.obp],['SLG',st.slg],['AB',ab],['H',h],['HR',hr],['K',k],['BB',bb]].map(([l,v])=>`<div><div style="font-size:9px;color:#888;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;text-transform:uppercase;">${l}</div><div style="font-size:13px;font-weight:700;font-family:\'Chakra Petch\',monospace;color:#ccc;">${v}</div></div>`).join('')}
        </div>
      </div>
      <div style="font-size:9px;color:#777;font-family:\'Chakra Petch\',monospace;">${sample} · ${ab} AB vs ${S.pitcher.name}</div>`;
    show('matchup-content');
  }catch(e){
    document.getElementById('matchup-content').innerHTML='<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;">Could not load matchup data.</div>';
    show('matchup-content');
  }finally{hide('matchup-spinner');}
}

// ═══════════ AUTO GAME LOADER ══════════════════════════════════════════════════

// (loadTeamMomentum, loadTwoWeekSchedule, _renderScheduleCell, _shortVenue,
//  and the legacy MVP banner block moved to ui/dashboard.js)

async function autoLoadNextGame(){
  try{
    // Use Arizona local date (UTC-7 year-round, no DST) so late-evening games near UTC midnight
    // aren't excluded by an early date rollover.
    const azNow=new Date(Date.now()-7*60*60*1000);
    // Fetch from yesterday to give Live games a safety margin if game runs past midnight Arizona
    const start=new Date(azNow.getTime()-24*60*60*1000).toISOString().split('T')[0];
    const end=new Date(azNow.getTime()+7*24*60*60*1000).toISOString().split('T')[0];
    const d=await api.mlbScheduleRange(start, end, 'probablePitcher');
    const allGames=(d?.dates||[]).flatMap(dt=>dt.games||[]);
    // Prefer in-progress (Live) game — keep today's lineup/pitcher/bets locked until today's game is over.
    // Only fall through to the next Preview once today's game goes Final.
    const game=allGames.find(g=>g.status?.abstractGameState==='Live')
      ||allGames.find(g=>g.status?.abstractGameState==='Preview')
      ||allGames[allGames.length-1];
    if(!game)return;
    // Set date
    document.getElementById('game-date').value=game.officialDate;
    // Set time — MLB gameDate is UTC; Arizona is UTC-7 year-round (no DST)
    if(!game.status?.startTimeTBD){
      const utc=new Date(game.gameDate);
      const mstH=(utc.getUTCHours()-7+24)%24;
      const mstM=utc.getUTCMinutes().toString().padStart(2,'0');
      document.getElementById('game-time').value=`${mstH.toString().padStart(2,'0')}:${mstM}`;
      setDay(mstH<17);
    }
    // Set home/away
    const isHome=game.teams?.home?.team?.id===109;
    setHome(isHome);
    // Set stadium from venue name
    const stadVal=VENUE_MAP[game.venue?.name];
    if(stadVal){document.getElementById('stadium-select').value=stadVal;onStadiumChange();}
    // Auto-load probable pitcher for the opposing team
    try{
      const isHomeSide=game.teams?.home?.team?.id===109;
      const oppSide=isHomeSide?game.teams.away:game.teams.home;
      S.opposingTeam=oppSide?.team?.name||'';
      S.opposingTeamAbbr=oppSide?.team?.abbreviation||'';
      S.gameStatus=game.status?.abstractGameState||'Preview';
      S.gameDate=game.gameDate||null;
      // Authoritative Arizona-local date of the loaded game. officialDate is the
      // local calendar date (unlike gameDate, which is a UTC timestamp that rolls
      // a day forward for night games — e.g. a 6:40pm MST first pitch is
      // 01:40Z the next day). Grade/bet records anchor to THIS so a drifting
      // #game-date input can't stamp a prediction with a date the pitcher never
      // pitched on, which previously made Fetch & Grade report "game not found".
      S.gameOfficialDate=game.officialDate||null;
      S.gamePk=game.gamePk||null;
      const pp=oppSide?.probablePitcher;
      if(pp?.id&&pp?.fullName&&!S.pitcher){
        await selectPitcher(pp.id,pp.fullName);
      }
    }catch(e){console.warn('Auto-pitcher failed:',e.message);}

    // Travel fatigue detection — compare to last completed game
    try{
      const weekAgo=new Date(Date.now()-8*24*60*60*1000).toISOString().split('T')[0];
      const yesterday=new Date(Date.now()-1*24*60*60*1000).toISOString().split('T')[0];
      const prevD=await api.mlbScheduleRange(weekAgo, yesterday);
      const prevGames=(prevD?.dates||[]).flatMap(d=>d.games||[]).filter(g=>g.status?.abstractGameState==='Final');
      const prevGame=prevGames[prevGames.length-1];
      if(prevGame){
        const prevVenue=prevGame.venue?.name;
        const currVenue=game.venue?.name;
        const daysBetween=(new Date(game.officialDate)-new Date(prevGame.officialDate))/(1000*60*60*24);
        const travelSel=document.getElementById('travel-select');
        // Only flag travel fatigue when the prior game was the immediately
        // preceding day (no rest buffer). daysBetween>=2 means at least one
        // full off day between the road game and this one, so the team is
        // rested — no fatigue penalty regardless of the venue change.
        if(prevVenue&&currVenue&&prevVenue!==currVenue&&daysBetween<=1){
          const prevUTC=new Date(prevGame.gameDate);
          const prevMSTHour=(prevUTC.getUTCHours()-7+24)%24;
          travelSel.value=prevMSTHour>=21?'redeye':'same';
        }else{
          document.getElementById('travel-select').value='none';
        }
      }
    }catch(e){console.warn('Travel detection failed:',e.message);}
    // Load umpire, weather, lineup
    await loadUmpireAndWeather();
    loadDashboard();
  }catch(e){console.warn('Auto game load failed:',e.message);}
}

// ═══════════ LINEUP ═══════════════════════════════════════════════════════════
async function loadLineupContext(dv){
  show('lineup-spinner');hide('lineup-content');setText('lineup-empty','');
  try{
    const d=await api.mlbScheduleDate(dv, 'lineups');
    log('[Lineup] raw API response:', d);
    const game=d?.dates?.[0]?.games?.[0];
    if(!game){setText('lineup-empty','No D-backs game on this date.');hide('lineup-spinner');show('lineup-empty');return;}
    log('[Lineup] game found:', game.gamePk, '| lineups:', game.lineups);
    const isHome=game.teams?.home?.team?.id===109;
    const players=(isHome?game.lineups?.homePlayers:game.lineups?.awayPlayers)||[];
    log('[Lineup] players array length:', players.length, '| isHome:', isHome);
    if(!players.length){
      setText('lineup-empty','Lineup not yet posted — check back closer to first pitch.');
      hide('lineup-spinner');show('lineup-empty');return;
    }
    // Players are already in batting order by array position — no battingOrder field present
    const ordered=players.slice();
    if(!ordered.length){setText('lineup-empty','Lineup order not yet available.');hide('lineup-spinner');show('lineup-empty');return;}

    const stats=await Promise.all(ordered.map((p,idx)=>
      api.mlbBatterSeason(p.id)
        .then(d=>{
          const st=d?.stats?.[0]?.splits?.[0]?.stat;
          return{
            id:p.id,name:p.fullName,
            pos:p.primaryPosition?.abbreviation||'—',
            order:idx+1,
            avg:parseFloat(st?.avg)||null,
            ops:parseFloat(st?.ops)||null,
          };
        })
        .catch(()=>({id:p.id,name:p.fullName,pos:'—',order:idx+1,avg:null,ops:null}))
    ));

    // Protection tier from 3-4-5 spots
    const spots345=stats.filter(p=>p.order>=3&&p.order<=5);
    const validOps=spots345.filter(p=>p.ops!=null).map(p=>p.ops);
    const avgOps=validOps.length?validOps.reduce((a,b)=>a+b,0)/validOps.length:null;
    const tier=!avgOps?'average':avgOps>=0.780?'strong':avgOps>=0.690?'average':'weak';
    S.lineupProtection={tier,avgOps,spots:spots345,manual:false};

    // Find selected player and the batter directly behind them
    const selectedRow=stats.find(p=>String(p.id)===String(S.playerId));
    const selectedIdx=stats.findIndex(p=>String(p.id)===String(S.playerId));
    const nextBatter=selectedIdx>=0&&selectedIdx<stats.length-1?stats[selectedIdx+1]:null;
    const weakProtection=nextBatter&&nextBatter.avg!==null&&nextBatter.avg<0.220;
    const avgColor=a=>!a?'#888':a>=0.290?'#2ecc71':a>=0.250?'#ccc':a>=0.220?'#f39c12':'#e74c3c';
    const ordSuffix=n=>['st','nd','rd'][n-1]||'th';
    const playerLastName=S.playerName.split(' ').pop();

    document.getElementById('lineup-content').innerHTML=
      stats.map(p=>{
        const isSelected=String(p.id)===String(S.playerId);
        const isNext=nextBatter&&String(p.id)===String(nextBatter.id);
        const borderStyle=isSelected?'border-left:3px solid #A71930;padding-left:6px;background:#0f0806;':
                          isNext&&weakProtection?'border-left:2px solid #e74c3c44;padding-left:4px;':'';
        return`<div class="lineup-spot" style="${borderStyle}">
          <span class="ls-order">${p.order}.</span>
          <span class="ls-pos">${p.pos}</span>
          <span class="ls-name">${p.name}${isSelected?` <span style="color:#A71930;font-size:9px;">← ${playerLastName}</span>`:''}</span>
          <span class="ls-ops" style="color:${avgColor(p.avg)}">${p.avg!=null?p.avg.toFixed(3):'—'}</span>
          ${isNext&&weakProtection?'<span style="font-size:9px;color:#e74c3c;margin-left:4px;">⚠ weak</span>':''}
        </div>`;
      }).join('')+
      `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a1730;">
        <span class="prot-badge ${tier}">${{strong:'Strong Protection',average:'Average Protection',weak:'Weak Protection'}[tier]}</span>
        ${avgOps?`<span style="font-size:9px;color:#888;font-family:\'Chakra Petch\',monospace;margin-left:8px;">${avgOps.toFixed(3)} OPS (3-4-5)</span>`:''}
        ${selectedRow?`<span style="font-size:9px;color:#999;font-family:\'Chakra Petch\',monospace;margin-left:12px;">${S.playerName} bats ${selectedRow.order}${ordSuffix(selectedRow.order)}</span>`:`<span style="font-size:9px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;margin-left:12px;">${S.playerName} is not in today's starting lineup</span>`}
        ${weakProtection&&nextBatter?`<div style="font-size:10px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;margin-top:6px;">⚠ ${nextBatter.name} bats behind ${playerLastName} (.${Math.round((nextBatter.avg||0)*1000)}) — pitchers may work around him</div>`:''}
      </div>`;
    show('lineup-content');

    // Use confirmed lineup as the active CorBET roster
    const newRoster=stats.map(p=>({name:p.name,id:String(p.id),order:p.order||null,pos:p.pos||null}));
    S.lineupRoster=newRoster;
    rebuildPlayerSelect(newRoster);
    // If bets are already on screen with stale roster, regenerate them
    if(S.allPlayerBets){S.allPlayerBets=null;loadDashboard();}
  }catch(e){setText('lineup-empty','Could not load lineup data.');show('lineup-empty');console.error('Lineup:',e);}
  finally{hide('lineup-spinner');}
}


// ═══════════ WEATHER ════════════════════════════════════════════════════════════
// fetchWeather, _windDir, _COMPASS_DEGS moved to weather.js. updateWeatherForTime
// stays here because it coordinates fetchWeather with setDay (a DOM-toggle helper
// adjacent to the other game-time toggles).
function updateWeatherForTime(){if(S.weather)fetchWeather();const h=parseInt((document.getElementById('game-time').value||'19:10').split(':')[0]);setDay(h<17);}

// ═══════════ PREDICTION ENGINE ════════════════════════════════════════════════
function calcPrediction(){
  let score=50;const factors=[];
  let batScore=0,pitScore=0,conScore=0;
  // Load learned weights once per prediction. The ratio currentWeight/defaultWeight
  // scales each factor's raw adj — at defaults the ratio is 1.0 (no change), and
  // after autoAdjustWeights tunes a weight, the score reflects that learning.
  const _weights=getFactorWeights();
  const add=(l,v,rawAdj,n,cat='batter')=>{
    const d=DEFAULT_WEIGHTS[l];
    const w=_weights[l];
    const mult=(d!=null&&w!=null&&d!==0)?(w/d):1.0;
    const adj=rawAdj*mult;
    score+=adj;
    if(cat==='batter')batScore+=adj;else if(cat==='pitcher')pitScore+=adj;else conScore+=adj;
    factors.push({label:l,value:v,adj,impact:adj>2?'positive':adj<-2?'negative':'neutral',note:n,cat});
  };
  if(S.splits){
    // Sample-size shrinkage for OPS-split factors. A part-time hitter's handedness
    // or home/road OPS over a few dozen PA is mostly noise — regress the observed
    // split toward the player's overall season OPS (best talent estimate) by PA
    // count before scoring it, so a hot 40-PA split can't push +4 on its own.
    // Platoon splits stabilize slower than venue splits, so they regress harder
    // (larger K = more PA of prior weight). At full-season samples the shrinkage
    // is negligible; it only bites on thin splits.
    const PLATOON_SHRINK_PA=200, VENUE_SHRINK_PA=150;
    const priorOps=parseFloat(S.seasonStat?.ops)||0.720;
    const _shrinkOps=(ops,pa,k)=>((ops*(pa||0))+priorOps*k)/((pa||0)+k);
    const hand=S.pitcher?.hand||S.pitcherThrows;
    const hs=hand==='L'?S.splits.vl:S.splits.vr;
    if(hs?.ops){
      const a=(_shrinkOps(hs.ops,hs.pa,PLATOON_SHRINK_PA)-0.720)*70;
      add(`vs ${hand}HP`,hs.ops.toFixed(3)+` OPS · ${hs.pa||0}PA`,a,`${a>0?'Hits well':'Struggles'} vs ${hand==='L'?'lefties':'righties'} this season — regressed to ${hs.pa||0} PA sample`);
    }
    const ls=S.isHome?S.splits.h:S.splits.a;
    if(ls?.ops){
      const a=(_shrinkOps(ls.ops,ls.pa,VENUE_SHRINK_PA)-0.720)*35;
      add(S.isHome?'Home':'Away',ls.ops.toFixed(3)+` OPS · ${ls.pa||0}PA`,a,`OPS ${ls.ops.toFixed(3)} ${S.isHome?'at home':'on the road'} — regressed to ${ls.pa||0} PA sample`);
    }
  }
  if(S.pitcher?.st){
    // Refresh the venue-blended line for the current home/away state, then score
    // off it so the home/road split feeds Pitcher Quality + the rate model. Falls
    // back to the raw season line when no usable split exists.
    applyPitcherVenue();
    const pst=S.pitcher.stEff||S.pitcher.st;
    const era=parseFloat(pst.era);
    const adv=S.pitcher.advancedEff||S.pitcher.advanced||{};
    // Use SIERA > xFIP > FIP > ERA in order of predictive value. The factor
    // label is unified so factor-learning isn't split across four buckets that
    // depend on which advanced metric was available; the specific metric used
    // is surfaced in the value field instead.
    const trueERA=adv.siera??adv.xfip??adv.fip??era;
    const trueLabel=adv.siera!=null?'SIERA':adv.xfip!=null?'xFIP':adv.fip!=null?'FIP':'ERA';
    if(!isNaN(trueERA)&&trueERA!=null){
      // Slope widened ×4 → ×6: an ace (SIERA ~2.8) now pushes ~−7 instead of −5.
      // The score channel was too timid against elite arms — paired with the
      // results-based rate model, the model's Over prob barely moved off a good
      // pitcher while the market dropped hard, producing phantom Over edges.
      const a=(trueERA-4.00)*6;
      add('Pitcher Quality',`${trueLabel} ${trueERA.toFixed(2)}`,a,trueERA<3.25?'Elite arm':trueERA<4.00?'Above-average':trueERA<5.00?'League-average':'Hittable pitcher','pitcher');
    }
    // Transparency note when the venue (home/road) split materially shifted the
    // pitcher's effective line. Carries no score of its own — the effect is
    // already baked into Pitcher Quality + the rate model via the blended line —
    // it just surfaces WHY the projection diverges from the raw season number.
    if(S.pitcher.venueApplied){
      const seasonBaa=parseFloat(S.pitcher.st?.avg),effBaa=parseFloat(pst.avg);
      if(isFinite(seasonBaa)&&isFinite(effBaa)&&Math.abs(effBaa-seasonBaa)>=0.008){
        const where=S.pitcher.venueApplied==='home'?'at home':'on the road';
        add('Venue Split',`${effBaa.toFixed(3).replace(/^0/,'')} BAA ${where}`,0,
          `Pitcher's ${where} split blended into his season line (sample-weighted) — effective BAA ${effBaa.toFixed(3).replace(/^0/,'')} vs ${seasonBaa.toFixed(3).replace(/^0/,'')} season`,'pitcher');
      }
    }
    // ERA-FIP divergence reveals luck/regression — show only when gap is meaningful
    if(adv.fip!=null&&!isNaN(era)){
      const gap=era-adv.fip;
      if(gap>=0.75)add('Unlucky Pitcher',`ERA ${era.toFixed(2)} vs FIP ${adv.fip.toFixed(2)}`,-2,'ERA inflated vs FIP — pitcher likely better than results show, expect regression','pitcher');
      else if(gap<=-0.75)add('Lucky Pitcher',`ERA ${era.toFixed(2)} vs FIP ${adv.fip.toFixed(2)}`,2,'ERA suppressed vs FIP — pitcher likely worse than results show, expect regression','pitcher');
    }
    // K-BB% — linear gradient around league avg ~12. Binary cliffs at 8/18
    // dropped — a 14% K-BB% had no signal but is meaningfully above average.
    // Slope tuned so 18% → -4 (matches old elite cap) and 8% → +2.8 (close to
    // old +3 poor cap). Labels split by sign to preserve learned-weight buckets.
    if(adv.kbbPct!=null){
      const a=Math.max(-4,Math.min(3,-(adv.kbbPct-12)*0.7));
      if(Math.abs(a)>=1){
        const label=a<0?'Elite K-BB%':'Poor K-BB%';
        const note=adv.kbbPct>=16?'Dominant strikeout-to-walk skill gap'
                  :adv.kbbPct<=8 ?'Weak K-BB ratio — hitters get more usable contact'
                  :a<0?'Above-average K-BB skill':'Below-average K-BB skill';
        add(label,adv.kbbPct.toFixed(1)+'%',a,note,'pitcher');
      }
    }
    // HR/9 — linear gradient around league avg ~1.2. Slope tuned so 1.5 → +3
    // (matches old HR-prone cap) and 0.8 → -2 (cap). Labels split by sign.
    if(adv.hr9!=null){
      const a=Math.max(-2,Math.min(3,(adv.hr9-1.2)*10));
      if(Math.abs(a)>=1){
        const label=a>0?'HR-prone':'HR Suppressor';
        const note=adv.hr9>=1.4?'Allows home runs at high rate'
                  :adv.hr9<=0.9?'Limits home runs effectively'
                  :a>0?'Slightly HR-prone':'Slightly HR-suppressing';
        add(label,adv.hr9.toFixed(2)+' HR/9',a,note,'pitcher');
      }
    }
    if(S.pitcher.daysRest!=='—'){if(S.pitcher.daysRest<4)add('Short Rest',S.pitcher.daysRest+'d',3,'Pitcher on short rest — fatigue advantage','pitcher');else if(S.pitcher.daysRest>=6)add('Extra Rest',S.pitcher.daysRest+'d',-2,'Well-rested pitcher — sharper command','pitcher');}
    const lpc=S.pitcher.lastOuting?.numberOfPitches;
    if(lpc&&lpc>=100)add('High Prev PC',lpc+' pitches',2,`${lpc} pitches last outing — possible fatigue`,'pitcher');
    if(S.pitcher.bullpenGame){
      add('Bullpen Game',`<45 PC × 3`,7,'Opener/bullpen game — hitters benefit from facing multiple pitchers and weaker arms throughout','pitcher');
    }
  } else {
    const mEra=parseFloat(document.getElementById('m-pitcher-era')?.value);
    if(!isNaN(mEra)){const a=(mEra-4.00)*6;add('Pitcher Quality',`ERA ${mEra.toFixed(2)}`,a,mEra<3.25?'Elite arm':mEra<4.00?'Above-average':mEra<5.00?'League-average':'Hittable pitcher','pitcher');}
  }
  if(S.matchupStats&&S.matchupStats.ab>=5){
    const{ops,ab}=S.matchupStats;
    const weight=ab>=20?1.0:ab>=10?0.6:0.3;
    const adj=Math.max(-6,Math.min(6,Math.round((ops-0.720)*50*weight)));
    if(adj!==0)add('vs Pitcher (career)',ops.toFixed(3)+' OPS ('+ab+'AB)',adj,
      ops>=0.950?'Owns this pitcher — dominant career numbers':
      ops>=0.800?'Strong career numbers vs this arm':
      ops>=0.650?'Struggles somewhat against this pitcher':
      'Poor career matchup — this pitcher has had his number');
  }
  if(S.seasonStat){
    const pa=S.seasonStat.plateAppearances||1;
    const bbP=(S.seasonStat.baseOnBalls/pa)*100;
    const kP=(S.seasonStat.strikeOuts/pa)*100;
    // BB% — linear gradient around league avg ~9%. Old binary cliff at ≥12%
    // missed gradient (10% vs 11% vs 12% all matter), and ignored low-BB hitters
    // entirely. Slope tuned so 15% → +3 cap, 3% → -3 cap.
    {const a=Math.max(-3,Math.min(3,(bbP-9)*0.5));
     if(Math.abs(a)>=1){
       const note=bbP>=12?'Elite walk rate':bbP<=6?'Poor plate discipline — rarely walks'
                 :a>0?'Above-average walk rate':'Below-average walk rate';
       add('BB%',bbP.toFixed(1)+'%',a,note);
     }}
    // K% — linear gradient around league avg ~22%. Old binary at ≥28% missed
    // contact hitters entirely. Slope tuned so 34% → -3 cap, 10% → +3 cap.
    {const a=Math.max(-3,Math.min(3,-(kP-22)*0.25));
     if(Math.abs(a)>=1){
       const note=kP>=28?'High strikeout rate':kP<=16?'Elite contact — rarely strikes out'
                 :a<0?'Above-average strikeouts':'Above-average contact';
       add('K%',kP.toFixed(1)+'%',a,note);
     }}
  }
  // Recent form — last 5 games. Hot/cold streaks carry real but regression-prone
  // signal beyond season stats, so the weight is moderate and the adj is capped ±6.
  if(S.recentGameLog&&S.recentGameLog.length>=3){
    const recent=S.recentGameLog.slice(0,5);
    const rH=recent.reduce((s,g)=>s+(parseInt(g.stat.hits)||0),0);
    const rAB=recent.reduce((s,g)=>s+(parseInt(g.stat.atBats)||0),0);
    const multiHit=recent.filter(g=>(parseInt(g.stat.hits)||0)>=2).length;
    if(rAB>=8){
      const avg5=rH/rAB;
      let a=0;
      if(avg5>=0.400)a=5;
      else if(avg5>=0.350)a=3;
      else if(avg5<=0.100)a=-5;
      else if(avg5<=0.150)a=-3;
      if(multiHit>=3)a+=2;
      a=Math.max(-6,Math.min(6,a));
      if(a!==0){
        const note=avg5>=0.400?`Scorching — ${avg5.toFixed(3)} with ${multiHit} multi-hit games in his last ${recent.length}`
          :avg5>=0.350?`Hot bat — ${avg5.toFixed(3)} over his last ${recent.length} games`
          :avg5<=0.100?`Ice cold — ${avg5.toFixed(3)} over his last ${recent.length} games`
          :avg5<=0.150?`Slumping — ${avg5.toFixed(3)} over his last ${recent.length} games`
          :`${multiHit} multi-hit games in his last ${recent.length}`;
        add('Recent Form',avg5.toFixed(3)+' L5',a,note);
      }
    }
  }
  // Batter Statcast factors. Barrel% lives only in per-prop adjustments (TB/HR
  // in modelProbability) — it has no causal effect on walks/Ks/runs/RBI and was
  // double-counting against TB through the score → lerp3 pipeline.
  if(S.statcast){
    const {whiff,xwoba,gb,fb}=S.statcast;
    // Whiff% (hitter) — linear gradient around league avg ~24%. Old binary
    // cliffs at 18/30 missed gradient in between. Slope tuned to hit ±3 caps
    // near the old binary thresholds.
    if(whiff!=null){
      const a=Math.max(-3,Math.min(3,-(whiff-24)*0.4));
      if(Math.abs(a)>=1){
        const note=whiff<=18?'Low whiff rate — difficult to strike out'
                  :whiff>=30?'High whiff rate — vulnerable to swing-and-miss stuff'
                  :a>0?'Below-average whiff rate':'Above-average whiff rate';
        add('Whiff%',whiff.toFixed(1)+'%',a,note);
      }
    }
    // xwOBA (hitter) — linear gradient around league avg ~0.320. Asymmetric
    // caps (-3/+4) preserved from old binary: elite hitters are rare and more
    // impactful than below-avg ones are negative.
    if(xwoba!=null){
      const a=Math.max(-3,Math.min(4,(xwoba-0.320)*70));
      if(Math.abs(a)>=1){
        const note=xwoba>=0.380?'Elite expected production — hitting the ball well'
                  :xwoba<=0.290?'Below-average expected production'
                  :a>0?'Above-average expected production':'Slightly below-average production';
        add('xwOBA',xwoba.toFixed(3),a,note);
      }
    }
    // GB%/FB% kept binary — these two are correlated (low GB often = high FB),
    // so converting both to linear would double-count the same batted-ball skew.
    if(gb!=null&&gb>=55)add('GB%',gb.toFixed(1)+'%',-2,'Heavy ground ball hitter — limits extra-base upside');
    if(fb!=null&&fb>=45)add('FB%',fb.toFixed(1)+'%',2,'High fly ball rate — elevated HR and total bases ceiling');
  }
  // Pitcher Statcast factors. xwOBA-against is a composite of Barrel%, HH%, and
  // launch angle, so keeping the components alongside it would triple-count the
  // same suppression skill. Put Away% is Whiff% in 2-strike counts — same K-skill
  // signal again. Both dropped in favor of xwOBA-against + Whiff%.
  if(S.pitcherStatcast){
    const{whiff:pWhiff,gbPct,xwoba:pXwoba}=S.pitcherStatcast;
    // Pitcher Whiff% — linear gradient around league avg ~22%. Slope tuned so
    // 28% → -4 (matches old elite) and 16% → +3 (matches old poor).
    if(pWhiff!=null){
      const a=Math.max(-4,Math.min(3,-(pWhiff-22)*0.7));
      if(Math.abs(a)>=1){
        const note=pWhiff>=28?'Elite whiff rate — dominant swing-and-miss stuff'
                  :pWhiff<=16?'Low pitcher whiff rate — hitter-friendly contact'
                  :a<0?'Above-average whiff rate':'Below-average whiff rate';
        add('Pitcher Whiff%',pWhiff.toFixed(1)+'%',a,note,'pitcher');
      }
    }
    if(gbPct!=null&&gbPct>=50)add('Pitcher GB%',gbPct.toFixed(1)+'%',-2,'Ground ball pitcher — limits extra-base power','pitcher');
    // xwOBA vs (pitcher) — linear gradient around league avg ~0.320. Slope
    // tuned so 0.280 → -3 (elite suppression) and 0.370 → +3 (hitter-friendly).
    if(pXwoba!=null){
      const a=Math.max(-3,Math.min(3,(pXwoba-0.320)*75));
      if(Math.abs(a)>=1){
        const note=pXwoba<=0.280?'Elite expected wOBA suppression'
                  :pXwoba>=0.370?'High xwOBA allowed — hitter-friendly profile'
                  :a<0?'Above-average xwOBA suppression':'Below-average xwOBA suppression';
        add('xwOBA vs',pXwoba.toFixed(3),a,note,'pitcher');
      }
    }
  }
  const w=S.weather;const wm=document.getElementById('weather-manual')&&!document.getElementById('weather-manual').classList.contains('hidden');
  let tempF,windMph,windDir,humidity;
  if(w&&!wm){tempF=w.tempF;windMph=w.windMph;windDir=w.windDir;humidity=w.humidity;}
  else{tempF=parseInt(document.getElementById('temp-slider')?.value)||75;windMph=parseInt(document.getElementById('wind-slider')?.value)||0;windDir=document.getElementById('wind-dir')?.value||'calm';humidity=parseInt(document.getElementById('humid-slider')?.value)||40;}
  const stadOpt=document.getElementById('stadium-select').options[document.getElementById('stadium-select').selectedIndex];
  const hasRoof=stadOpt.dataset.roof==='1',elev=parseInt(stadOpt.dataset.elev);
  const roofClosed=hasRoof&&S.roofClosed;
  const wd=_windDir();
  if(!roofClosed){
    if(tempF>=90)add('Heat',tempF+'°F',4,'Hot thin air — more carry on contact','conditions');
    else if(tempF<=55)add('Cold',tempF+'°F',-4,'Dense cold air suppresses ball flight','conditions');
    // Wind adj capped ±8 — without the cap a 30 mph wind dwarfs every other
    // factor (30*0.35 = +10.5, larger than Altitude's +8 max).
    if(wd==='out'&&windMph>=8)add('Wind Out',windMph+' mph',Math.min(8,windMph*0.35),'Blowing out — HR potential elevated','conditions');
    else if(wd==='in'&&windMph>=8)add('Wind In',windMph+' mph',Math.max(-8,-windMph*0.28),'Blowing in — suppresses power','conditions');
    else if(windMph>=15)add('Crosswind',windMph+' mph',-2,'Strong crosswind affects pitch movement','conditions');
  }
  if(humidity>70)add('High Humidity',humidity+'%',-1,'Heavy air slightly suppresses carry','conditions');
  if(roofClosed)add('Roof Closed','Indoor',-2,'Controlled environment neutralizes weather edge','conditions');
  if(elev>4000)add('Altitude',elev.toLocaleString()+'ft',8,'Thin mile-high air — significant carry boost','conditions');
  else if(elev>2000)add('Elevation',elev.toLocaleString()+'ft',3,'Moderate elevation adds mild carry','conditions');
  if(!roofClosed&&elev<=4000){const{hrF}=_parkFactors();if(hrF>=1.08)add('Hitter Park',`+${Math.round((hrF-1)*100)}% HR vs avg`,Math.round((hrF-1)*20),'Park dimensions and depth favor offense','conditions');else if(hrF<=0.92)add('Pitcher Park',`${Math.round((hrF-1)*100)}% HR vs avg`,Math.round((hrF-1)*20),'Spacious park suppresses power','conditions');}
  const travel=document.getElementById('travel-select').value;
  if(travel==='redeye')add('Red-Eye','Fatigue risk',-6,'Cross-timezone red-eye suppresses performance');
  else if(travel==='same')add('Same-Day Travel','Mild fatigue',-3,'Same-day travel, minor rest concern');
  if(S.umpire){const ut=UMP_DB[S.umpire.fullName];if(ut&&ut.adj!==0)add('Umpire',S.umpire.fullName,ut.adj,ut.note);}
  if(S.lineupProtection&&S.lineupProtection.tier!=='average'){
    const{tier,avgOps,manual}=S.lineupProtection;
    const val=avgOps?avgOps.toFixed(3)+' avg OPS':(tier==='strong'?'Manual: Strong':'Manual: Weak');
    const lastName=S.playerName.split(' ').pop();
    if(tier==='strong'){
      const adj=avgOps?Math.min(5,Math.round((avgOps-0.730)*35)):3;
      add('Protection',val,adj,`Elite lineup behind ${lastName} — pitchers must attack him to avoid a big inning`);
    } else {
      const adj=avgOps?Math.max(-5,Math.round((avgOps-0.730)*35)):-3;
      add('Protection',val,adj,`Thin lineup behind ${lastName} — pitchers can work around him freely`);
    }
  }
  score=Math.max(4,Math.min(96,Math.round(score)));
  const tiers=[{min:75,label:'Strong Game',color:'#2ecc71',desc:'Conditions strongly favor a productive day'},{min:60,label:'Favorable',color:'#a8e063',desc:'More factors lean positive than negative'},{min:42,label:'Neutral',color:'#f39c12',desc:'Mixed bag — could go either way'},{min:28,label:'Tough Spot',color:'#e67e22',desc:'Multiple headwinds against production'},{min:0,label:'Difficult',color:'#e74c3c',desc:'Significant factors stacked against a big day'}];
  return{score,tier:tiers.find(t=>score>=t.min),factors,tempF,windMph,windDir:wd,humidity,catTotals:{batter:Math.round(batScore),pitcher:Math.round(pitScore),conditions:Math.round(conScore)}};
}

async function runPrediction(){
  const{score,tier,factors,tempF,windMph,windDir,humidity,catTotals}=calcPrediction();
  const C=2*Math.PI*52;
  document.getElementById('gauge-circle').style.strokeDashoffset=C-(score/100)*C;
  document.getElementById('gauge-circle').style.stroke=tier.color;
  document.getElementById('gauge-score').textContent=score;
  document.getElementById('gauge-label').textContent=tier.label;
  document.getElementById('gauge-label').style.color=tier.color;
  document.getElementById('gauge-desc').textContent=tier.desc;
  const pn=S.pitcher?.name||document.getElementById('m-pitcher-name')?.value||'Unknown Pitcher';
  const hand=S.pitcher?.hand||S.pitcherThrows;
  const era=S.pitcher?.st?.era||document.getElementById('m-pitcher-era')?.value;
  document.getElementById('pred-header').textContent=`${S.playerName} · ${pn} (${hand}HP)${era?` · ERA ${parseFloat(era).toFixed(2)}`:''}`;
  renderFactorCards(factors,catTotals);
  document.getElementById('pitch-display').innerHTML=_renderPitchMatchup();
  S.lastScore=score;S.lastPrediction={score,tier,factors,catTotals,tempF,windMph,windDir,humidity,playerName:S.playerName,pitcherName:pn,hand,era,date:S.gameOfficialDate||document.getElementById('game-date').value||new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0]};
  savePredictionForGrading(S.lastPrediction);
  // Refresh game log every time prediction runs so Last 10 Games is always current
  await loadGameLog();
  buildPredictionSummary(factors);
  hide('no-prediction');show('prediction-output');
  // Reset corbet state
  hide('corbet-bets');hide('corbet-no-props');hide('corbet-error');hide('corbet-player-filter');
  show('corbet-no-prediction');
  // Show nav buttons (hidden in player-detail modal view)
  const navBtns=document.getElementById('result-nav-btns');
  if(navBtns)navBtns.style.display='';
  openModal('panel-result', S.playerName + ' · Prediction');
}

function toggleFactorCard(cat){
  const body=document.getElementById(`factors-${cat}-body`);
  const arrow=document.getElementById(`factors-${cat}-arrow`);
  if(!body)return;
  const collapsed=body.classList.toggle('hidden');
  if(arrow)arrow.textContent=collapsed?'▶':'▼';
}

// ═══════════ CORBET CARROLL ════════════════════════════════════════════════════

// Score each prop independently based on its specific key drivers (0–100)
function scoreIndividualProp(propKey){
  let score=50;
  const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));

  // Batter season stats
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const avg=parseFloat(ss?.avg)||null;
  const obp=parseFloat(ss?.obp)||null;
  const slg=parseFloat(ss?.slg)||null;
  const babip=parseFloat(ss?.babip)||null;
  const bbPct=ss?(ss.baseOnBalls/pa)*100:null;
  const kPct=ss?(ss.strikeOuts/pa)*100:null;
  const abPerHR=parseFloat(ss?.atBatsPerHomeRun)||null;

  // Pitcher stats
  const pst=S.pitcher?.st;
  const pitcherPA=pst?.battersFaced||1;
  const pEra=parseFloat(pst?.era)||null;
  const pWhip=parseFloat(pst?.whip)||null;
  const pKPct=pst?.strikeOuts?(pst.strikeOuts/pitcherPA)*100:null;
  const pBBPct=pst?.baseOnBalls?(pst.baseOnBalls/pitcherPA)*100:null;

  // Statcast
  const brl=S.statcast?.brl;
  const hhRate=S.statcast?.hhRate;
  const whiff=S.statcast?.whiff;
  const xwoba=S.statcast?.xwoba;
  const gbPct=S.statcast?.gb;
  const fbPct=S.statcast?.fb;

  // Handedness split
  const hand=S.pitcher?.hand||S.pitcherThrows;
  const handSplit=hand==='L'?S.splits?.vl:S.splits?.vr;
  const handOps=handSplit?.ops;

  // Matchup career
  const mu=S.matchupStats;
  const muW=!mu||mu.ab<5?0:mu.ab>=20?1:mu.ab>=10?0.6:0.3;

  // Environment
  const stadOpt=document.getElementById('stadium-select').options[document.getElementById('stadium-select').selectedIndex];
  const elev=parseInt(stadOpt.dataset.elev)||500;
  const hasRoof=stadOpt?.dataset.roof==='1';
  const roofClosed=hasRoof&&S.roofClosed;
  // Closed-roof games neutralize weather: indoor temp ~72°F, no meaningful wind.
  // Without this, e.g. a 95°F Phoenix day at Chase with the roof closed was still
  // adding the +5 HR / +4 TB heat bump to every prop.
  const tempF=roofClosed?72:(S.weather?.tempF||75);
  const windMph=roofClosed?0:(S.weather?.windMph||5);
  // Use _windDir() (which projects compass onto park CF bearing) instead of the
  // raw compass string. Previously corbetPropScore tested S.weather.windDir==='out'
  // directly, which is ALWAYS false for live weather (live data sets directions
  // like "SSW", never "out"/"in") — so wind silently had zero effect on every
  // HR/TB/runs prop on every live-weather game.
  const windDir=roofClosed?'calm':_windDir();
  const umpAdj=S.umpire?(UMP_DB[S.umpire.fullName]?.adj||0):0;
  const protTier=S.lineupProtection?.tier;
  // RISP BA, Bayesian-shrunk toward league RISP avg (~.250). The raw split is a
  // tiny, sac-fly-inflated sample (commonly 25-40 AB) that never stabilizes, so
  // reading it unshrunk injected phantom RBI/H+R+RBI score points — a 27-AB .349
  // RISP line was adding ~+12.6 pts to the RBI score (Moreno 2026-05-30). priorN=80
  // keeps a hot RISP streak from dominating while still rewarding a genuinely
  // strong full-season RISP profile. Falls back to null when no RISP AB exist.
  const rispH=parseInt(S.rispStat?.hits)||0;
  const rispAB=parseInt(S.rispStat?.atBats)||0;
  const rispAvg=rispAB>0?_shrunkRate(rispH,rispAB,0.250,80):null;

  if(propKey==='batter_hits'){
    if(avg!=null)        score+=(avg-0.247)*150;
    if(babip!=null)      score+=(babip-0.291)*80;
    if(kPct!=null)       score-=(kPct-22)*0.5;
    if(handOps)          score+=(handOps-0.720)*35;
    // Higher pitcher WHIP = more baserunners = more hits against. Was previously
    // `score-=`, which incorrectly penalized batters facing hittable pitchers.
    if(pWhip!=null)      score+=(pWhip-1.25)*20;
    if(pKPct!=null)      score-=(pKPct-22)*0.4;
    if(whiff!=null)      score-=(whiff-22)*0.35;
    if(hhRate!=null)     score+=(hhRate-40)*0.15;
    if(mu&&muW>0)        score+=(parseFloat(mu.avg||0)-0.247)*80*muW;
  }
  else if(propKey==='batter_total_bases'){
    if(slg!=null)        score+=(slg-0.405)*100;
    if(xwoba!=null)      score+=(xwoba-0.315)*80;
    if(brl!=null)        score+=(brl-8)*0.7;
    if(hhRate!=null)     score+=(hhRate-40)*0.2;
    if(pEra!=null)       score-=(pEra-4.00)*3;
    if(handOps)          score+=(handOps-0.720)*30;
    if(mu&&muW>0)        score+=(parseFloat(mu.slg||0)-0.405)*60*muW;
    if(gbPct!=null&&gbPct>=55) score-=(gbPct-55)*0.4; // heavy GB = fewer extra bases
    if(fbPct!=null&&fbPct>=45) score+=(fbPct-45)*0.5; // high FB = more extra bases
    if(tempF>=90)        score+=4;
    if(elev>4000)        score+=8;
    else if(elev>2000)   score+=3;
    if(windDir==='out'&&windMph>=8) score+=windMph*0.35;
    else if(windDir==='in'&&windMph>=8) score-=windMph*0.28;
  }
  else if(propKey==='batter_home_runs'){
    if(brl!=null)        score+=(brl-8)*1.5;
    if(xwoba!=null)      score+=(xwoba-0.315)*70;
    if(abPerHR!=null)    score-=(abPerHR-28)*0.5;
    if(hhRate!=null)     score+=(hhRate-40)*0.3;
    if(pEra!=null)       score-=(pEra-4.00)*5;
    if(handOps)          score+=(handOps-0.720)*25;
    if(mu&&muW>0&&mu.hr!=null) score+=(mu.hr/Math.max(mu.ab,1))*300*muW;
    if(gbPct!=null&&gbPct>=55) score-=(gbPct-55)*0.6; // ground balls don't leave the yard
    if(fbPct!=null&&fbPct>=45) score+=(fbPct-45)*0.7; // fly balls = HR opportunities
    if(tempF>=90)        score+=5;
    if(elev>4000)        score+=12;
    else if(elev>2000)   score+=5;
    if(windDir==='out'&&windMph>=8) score+=windMph*0.6;
    else if(windDir==='in'&&windMph>=8) score-=windMph*0.5;
  }
  else if(propKey==='batter_rbis'){
    if(rispAvg!=null)    score+=(rispAvg-0.244)*120;
    // Prefer the handedness-split SLG vs the listed pitcher's hand when it has
    // stabilized (>=100 PA), shrunk toward the batter's overall SLG. The RBI
    // branch was the only score branch with no platoon term, so a strong-side
    // SLG was driving RBI projections even when the batter faces his weak side
    // (Moreno: .420 overall / .393 vs RHP / .500 vs LHP — facing a RHP tonight
    // his power plays down, but the overall SLG hid that). TB/Runs/H+R+RBI
    // already fold the hand split in via handOps, so this only patches RBI.
    // _shrunkRate expects count num/denom, so pass slg*pa as the numerator to
    // shrink the rate toward the overall-SLG prior weighted by PA.
    const hSlg=parseFloat(handSplit?.slg);
    const handSlg=handSplit?.pa>=100&&isFinite(hSlg)
      ?_shrunkRate(hSlg*handSplit.pa,handSplit.pa,slg??0.405,120)
      :slg;
    if(handSlg!=null)    score+=(handSlg-0.405)*60;
    if(protTier==='strong') score+=5;
    else if(protTier==='weak') score-=5;
    if(pEra!=null)       score-=(pEra-4.00)*3.5;
    if(mu&&muW>0)        score+=(mu.ops-0.720)*35*muW;
    if(tempF>=90||elev>4000) score+=3;
  }
  else if(propKey==='batter_walks'){
    if(bbPct!=null)      score+=(bbPct-9)*3;
    // OBP factor removed: high OBP correlates with walks but also with BABIP-
    // driven hits, which double-counted with bbPct above. Hot rookies on a
    // batting-average heater (Waldschmidt .404 OBP from .500 BABIP) were
    // inflating the walks score by ~6 pts, pushing P(BB>=1) projections from
    // a binomial-grounded ~32% to ~48%.
    if(pBBPct!=null)     score+=(pBBPct-7)*2.5;
    if(umpAdj>0)         score+=umpAdj*2.5;
    else if(umpAdj<0)    score+=umpAdj*2;
    const dr=parseInt(S.pitcher?.daysRest);
    if(!isNaN(dr)&&dr<4) score+=4;
    const lpc=S.pitcher?.lastOuting?.numberOfPitches;
    if(lpc&&lpc>=100)    score+=3;
    if(mu&&muW>0&&mu.bb!=null) score+=(mu.bb/Math.max(mu.ab,1))*200*muW;
    // Cold weather hurts pitcher command (stiff fingers, harder to grip ball) → more BB.
    // Effect is small but real for outdoor games.
    if(tempF<=50)        score+=3;
    else if(tempF<=60)   score+=1;
  }
  else if(propKey==='batter_strikeouts'){
    if(kPct!=null)       score+=(kPct-22)*1.8;
    if(pKPct!=null)      score+=(pKPct-20)*1.5;
    if(whiff!=null)      score+=(whiff-22)*1.0;
    const breakingBall=(S.pitcherPitches?.['Slider']||0)+(S.pitcherPitches?.['Curveball']||0);
    if(breakingBall>30)  score+=4;
    if(umpAdj<0)         score+=Math.abs(umpAdj)*2;
    else if(umpAdj>0)    score-=umpAdj*1.5;
    if(mu&&muW>0&&mu.k!=null) score+=(mu.k/Math.max(mu.ab,1))*250*muW;
    if(pEra!=null)       score-=(pEra-4.00)*2;
    // Cold weather slightly boosts K rate (tight grip on bat, reduced contact). Hot
    // weather slightly suppresses Ks (relaxed hitters, sharper vision in good light).
    if(tempF<=50)        score+=2;
    else if(tempF>=90)   score-=1;
  }
  else if(propKey==='batter_runs_scored'){
    if(obp!=null)        score+=(obp-0.318)*80;
    // High pitcher WHIP = more baserunners = more runs scored. Was previously inverted.
    if(pWhip!=null)      score+=(pWhip-1.25)*15;
    if(pBBPct!=null)     score+=(pBBPct-7)*1.5;
    if(handOps)          score+=(handOps-0.720)*25;
    if(mu&&muW>0)        score+=(parseFloat(mu.obp||0)-0.318)*40*muW;
    if(tempF>=90)        score+=2;
    if(elev>4000)        score+=4;
    else if(elev>2000)   score+=2;
    if(windDir==='out'&&windMph>=8) score+=windMph*0.15;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    if(avg!=null)        score+=(avg-0.247)*120;
    if(obp!=null)        score+=(obp-0.318)*60;
    if(slg!=null)        score+=(slg-0.405)*60;
    if(rispAvg!=null)    score+=(rispAvg-0.244)*50;
    if(pEra!=null)       score-=(pEra-4.00)*3;
    if(handOps)          score+=(handOps-0.720)*30;
    if(mu&&muW>0)        score+=(mu.ops-0.720)*50*muW;
    if(tempF>=90)        score+=3;
    if(elev>4000)        score+=6;
    else if(elev>2000)   score+=2;
    if(windDir==='out'&&windMph>=8) score+=windMph*0.25;
  }

  return clamp(Math.round(score),5,95);
}

function corbetReasoning(propKey,direction,propScore){
  const drivers=[];
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const mu=S.matchupStats;
  const hand=S.pitcher?.hand||S.pitcherThrows;
  const handSplit=hand==='L'?S.splits?.vl:S.splits?.vr;
  const pitcherPA=S.pitcher?.st?.battersFaced||1;

  if(propKey==='batter_hits'){
    if(ss?.avg)    drivers.push(`${ss.avg} BA`);
    if(ss?.babip)  drivers.push(`${ss.babip} BABIP`);
    const pmH=_pitchMatchupReason(direction,'batter_hits');
    if(pmH)        drivers.push(pmH);
    const kp=ss?((ss.strikeOuts/pa)*100).toFixed(0):null;
    if(kp)         drivers.push(`${kp}% K rate`);
    if(handSplit?.ops) drivers.push(`${handSplit.ops} OPS vs ${hand}HP`);
    if(S.pitcher?.st?.whip) drivers.push(`${parseFloat(S.pitcher.st.whip).toFixed(2)} WHIP`);
    if(mu?.ab>=5)  drivers.push(`${mu.avg} AVG in ${mu.ab}AB career`);
  } else if(propKey==='batter_total_bases'){
    if(ss?.slg)    drivers.push(`${ss.slg} SLG`);
    if(S.statcast?.xwoba!=null) drivers.push(`${S.statcast.xwoba.toFixed(3)} xwOBA`);
    const pmTB=_pitchMatchupReason(direction,'batter_total_bases');
    if(pmTB)       drivers.push(pmTB);
    if(S.statcast?.brl!=null)   drivers.push(`${S.statcast.brl.toFixed(1)}% Barrel`);
    if(S.pitcher?.st?.era) drivers.push(`${parseFloat(S.pitcher.st.era).toFixed(2)} ERA`);
    if(mu?.ab>=5)  drivers.push(`${mu.slg} SLG in ${mu.ab}AB career`);
  } else if(propKey==='batter_home_runs'){
    if(S.statcast?.brl!=null)   drivers.push(`${S.statcast.brl.toFixed(1)}% Barrel`);
    if(S.statcast?.xwoba!=null) drivers.push(`${S.statcast.xwoba.toFixed(3)} xwOBA`);
    if(ss?.atBatsPerHomeRun)    drivers.push(`${parseFloat(ss.atBatsPerHomeRun).toFixed(0)} AB/HR`);
    if(S.pitcher?.st?.era) drivers.push(`${parseFloat(S.pitcher.st.era).toFixed(2)} ERA`);
    const stadOpt=document.getElementById('stadium-select').options[document.getElementById('stadium-select').selectedIndex];
    const elev=parseInt(stadOpt.dataset.elev)||500;
    if(elev>2000)  drivers.push(`${elev.toLocaleString()}ft elevation`);
    if(mu?.ab>=5&&mu.hr) drivers.push(`${mu.hr}HR in ${mu.ab}AB career`);
  } else if(propKey==='batter_rbis'){
    if(S.rispStat?.avg) drivers.push(`${S.rispStat.avg} RISP BA`);
    if(ss?.slg)    drivers.push(`${ss.slg} SLG`);
    const pt=S.lineupProtection?.tier;
    if(pt)         drivers.push(`${pt} lineup protection`);
    if(S.pitcher?.st?.era) drivers.push(`${parseFloat(S.pitcher.st.era).toFixed(2)} ERA`);
    if(mu?.ab>=5)  drivers.push(`${mu.ops.toFixed(3)} OPS career vs pitcher`);
  } else if(propKey==='batter_walks'){
    const bbp=ss?((ss.baseOnBalls/pa)*100).toFixed(1):null;
    if(bbp)        drivers.push(`${bbp}% BB rate`);
    const hs=_handSplit();
    if(hs?.pa>=100&&hs?.bb!=null){
      const handBB=(hs.bb/hs.pa)*100;
      const overallBB=parseFloat(bbp);
      if(!isNaN(overallBB)&&Math.abs(handBB-overallBB)>=1.5) drivers.push(`${handBB.toFixed(1)}% BB vs ${hand}HP`);
    }
    if(ss?.obp)    drivers.push(`${ss.obp} OBP`);
    const pBBPct=S.pitcher?.st?.baseOnBalls?((S.pitcher.st.baseOnBalls/pitcherPA)*100).toFixed(1):null;
    if(pBBPct)     drivers.push(`pitcher ${pBBPct}% BB rate`);
    if(S.umpire)   drivers.push(`${S.umpire.fullName} umpire`);
    if(mu?.ab>=5&&mu.bb) drivers.push(`${mu.bb}BB in ${mu.ab}AB career`);
  } else if(propKey==='batter_strikeouts'){
    const kp=ss?((ss.strikeOuts/pa)*100).toFixed(1):null;
    if(kp)         drivers.push(`${kp}% K rate`);
    const hs=_handSplit();
    if(hs?.pa>=80&&hs?.k!=null){
      const handK=(hs.k/hs.pa)*100;
      const overallK=parseFloat(kp);
      // Only surface when materially different from overall (≥2pp) — otherwise it's noise
      if(!isNaN(overallK)&&Math.abs(handK-overallK)>=2) drivers.push(`${handK.toFixed(1)}% K vs ${hand}HP`);
    }
    const pKPct=S.pitcher?.st?.strikeOuts?((S.pitcher.st.strikeOuts/pitcherPA)*100).toFixed(1):null;
    if(pKPct)      drivers.push(`pitcher ${pKPct}% K rate`);
    const pmK=_pitchMatchupReason(direction,'batter_strikeouts');
    if(pmK)        drivers.push(pmK);
    if(S.statcast?.whiff!=null) drivers.push(`${S.statcast.whiff.toFixed(1)}% whiff`);
    const bb=(S.pitcherPitches?.['Slider']||0)+(S.pitcherPitches?.['Curveball']||0);
    if(bb>25)      drivers.push(`${bb.toFixed(0)}% breaking ball usage`);
    if(mu?.ab>=5&&mu.k) drivers.push(`${mu.k}K in ${mu.ab}AB career`);
  } else if(propKey==='batter_runs_scored'){
    if(ss?.obp)    drivers.push(`${ss.obp} OBP`);
    if(ss?.runs&&ss?.gamesPlayed) drivers.push(`${(ss.runs/ss.gamesPlayed).toFixed(2)} R/G`);
    if(S.pitcher?.st?.whip) drivers.push(`${parseFloat(S.pitcher.st.whip).toFixed(2)} pitcher WHIP`);
    const hand=S.pitcher?.hand||S.pitcherThrows;
    const handSplit=hand==='L'?S.splits?.vl:S.splits?.vr;
    if(handSplit?.obp) drivers.push(`${handSplit.obp} OBP vs ${hand}HP`);
    if(mu?.ab>=5&&mu.obp) drivers.push(`${mu.obp} OBP career vs pitcher`);
  } else if(propKey==='batter_hits_runs_rbis'){
    if(ss?.avg)    drivers.push(`${ss.avg} BA`);
    if(ss?.obp)    drivers.push(`${ss.obp} OBP`);
    if(ss?.slg)    drivers.push(`${ss.slg} SLG`);
    if(S.rispStat?.avg) drivers.push(`${S.rispStat.avg} RISP BA`);
    if(S.pitcher?.st?.era) drivers.push(`${parseFloat(S.pitcher.st.era).toFixed(2)} ERA`);
    if(mu?.ab>=5)  drivers.push(`${mu.ops.toFixed(3)} OPS career vs pitcher`);
  }

  const signal=direction==='over'?'bullish':'bearish';
  const prefix=direction==='over'?'Drivers':'Headwinds';
  return`${prefix}: ${drivers.slice(0,4).join(' · ')||'general conditions'}`;
}

// (impliedProb moved to betting.js)

// (player-stat utilities moved to player.js: _factorial, _poissonCDF,
//  _gamePAs, _paMultiplier, _ttopBonus, _hrrOverPct, _shrunkRate,
//  _binomGE, _convolveTBge, _log5, _extractSplitStat, _handSplit)

// Pitch-mix vs batter weakness. Loaded once per page from /pitch-arsenal (a snapshot
// of Baseball Savant pitcher arsenal + batter pitch-arsenal leaderboards, refreshed
// daily by scripts/refresh_pitch_arsenal.py). Compares the batter's per-pitch-type
// rates (whiff/K/wOBA) weighted by the pitcher's actual usage% vs the batter's
// overall baseline. Captures matchup signal the season-wide K%/wOBA stats can't.
// (_loadPitchArsenal moved to pitcher.js)

// (PITCH_NAMES moved to constants.js; _pitchMatchupFactor moved to predict.js)

// Render the Pitch Mix card on the Prediction Score panel as a per-pitch matchup
// table. For each pitch the pitcher throws (sorted by usage), show:
//   - pitcher's usage % (bar)
//   - batter's BA / SLG / K% / wOBA on that pitch
// Stats are colored vs the batter's overall baseline across all pitches:
//   green = batter performs better than baseline on this pitch (or whiffs less)
//   red   = batter performs worse (or whiffs more)
// Falls back to a simple pitcher-only bar view when arsenal data isn't available.
// (_renderPitchMatchup moved to ui/render.js)

// (_pitchMatchupReason moved to predict.js)

// (modelProbability moved to predict.js)

// (americanToDecimal moved to betting.js)

// (probToAmerican moved to ui/record.js — only used there)

// Props whose only canonical line is 0.5 and is naturally lopsided, so the
// alt-ladder line reject in generateCorbetBets must not be applied to them.
const SINGLE_LINE_PROPS=new Set(['batter_strikeouts','batter_walks']);

function generateCorbetBets(score,factors,rawMarketMap){
  const results=[];
  Object.entries(rawMarketMap).forEach(([propKey,mkt])=>{
    if(!PROP_NAMES[propKey])return;
    // Pick the line whose over/under prices are most balanced (closest to 50/50 implied).
    // This selects the main market line (e.g. HRR 1.5 at -119/+105) over extreme alternate
    // lines (e.g. HRR 0.5 at -1900/+1000) which skew the devig probability to 90%+.
    const allLines=new Set([
      ...Object.keys(mkt.overByLine||{}),...Object.keys(mkt.underByLine||{})
    ].map(Number));
    let effectiveLine=null;
    let minImbalance=Infinity;
    // Single-threshold props (strikeouts, walks) have one canonical line at 0.5
    // that is *naturally* lopsided: a hitter usually strikes out at least once,
    // and usually does NOT walk. The alt-ladder reject below was written for
    // HRR/HR ladder markets (0.5/1.5/2.5 rungs) where extreme rungs produce
    // phantom devig edges — applying it to these props wrongly rejects their
    // legitimate main line, so we skip the reject for them.
    const isSingleLineProp=SINGLE_LINE_PROPS.has(propKey);
    for(const l of [...allLines]){
      const oArr=mkt.overByLine[l]||[];
      const uArr=mkt.underByLine[l]||[];
      if(!oArr.length||!uArr.length)continue;
      const rO=_medianImpliedProb(oArr),rU=_medianImpliedProb(uArr);
      if(rO==null||rU==null)continue;
      // Reject alt-ladder rungs (one side >85% raw implied) — books post these
      // as ladders for HRR/HR markets, and devig produces phantom 95% edges.
      const sideShare=rO/(rO+rU);
      if(!isSingleLineProp&&(sideShare>0.85||sideShare<0.15)){
        log('[props]',propKey,'line',l,'rejected: sideShare='+sideShare.toFixed(2),'over='+rO.toFixed(1)+'% under='+rU.toFixed(1)+'%');
        continue;
      }
      const imbalance=Math.abs(sideShare-0.5);
      if(imbalance<minImbalance){minImbalance=imbalance;effectiveLine=l;}
    }
    let line=effectiveLine!=null?effectiveLine:0.5;
    // Total Bases 0.5 is a near-lock with no betting value. Promote to 1.5 when
    // the book actually posts that line, BEFORE computing any probabilities —
    // otherwise modelProb/marketProb/EV/MC are computed at 0.5 while the card
    // displays 1.5 (the old post-hoc relabel produced exactly that mismatch).
    // If 1.5 isn't posted we keep 0.5 so the math stays consistent with the
    // line shown.
    if(propKey==='batter_total_bases'&&line<=0.5
       &&(mkt.overByLine[1.5]?.length)&&(mkt.underByLine[1.5]?.length)){
      line=1.5;
    }
    const calcOver=mkt.overByLine[line]||[];
    const calcUnder=mkt.underByLine[line]||[];
    const overBest=mkt.overBestByLine[line]||null;
    const underBest=mkt.underBestByLine[line]||null;
    // Phantom/teaser lines: every other book-posted line for this prop with
    // both sides quoted. Probabilities are NOT pre-computed — togglePhantom()
    // computes them lazily on user interaction.
    const altLines=[];
    for(const l of [...allLines]){
      if(l===line)continue;
      const oArr=mkt.overByLine[l]||[];
      const uArr=mkt.underByLine[l]||[];
      if(!oArr.length||!uArr.length)continue;
      altLines.push({
        line:l,
        overPrices:oArr,underPrices:uArr,
        overBest:mkt.overBestByLine[l]||null,
        underBest:mkt.underBestByLine[l]||null,
      });
    }
    altLines.sort((a,b)=>a.line-b.line);
    if(!calcOver?.length||!calcUnder?.length){
      log('[props]',propKey,'line',line,'insufficient: over='+calcOver.length+' under='+calcUnder.length,'effectiveLine='+effectiveLine,'allLines=',[...allLines].join(','));
      results.push({prop:PROP_NAMES[propKey],propKey,line,insufficient:true,
        overBest,underBest,edgeStrength:'none',absDelta:0,altLines:[]});
      return;
    }
    const dv=devig(calcOver,calcUnder);
    if(!dv)return;
    const _comp={};
    const modelProb=modelProbability(propKey,line,score,_comp);
    if(modelProb===null){log('[props]',propKey,'line',line,'modelProb null');return;}

    const delta=modelProb-dv.overProb;
    const absDelta=Math.abs(delta);
    const direction=delta>0?'Over':'Under';
    const bestOdds=delta>0?overBest:underBest;

    // EV = winProb × (decimal - 1) - (1 - winProb); normalizes for position on probability spectrum
    let ev=null;
    const _dec=bestOdds?.price!=null?americanToDecimal(bestOdds.price):null;
    if(_dec){
      const winProb=direction==='Under'?(100-modelProb)/100:modelProb/100;
      ev=winProb*(_dec-1)-(1-winProb);
    }
    let edgeStrength;
    if(ev!==null){
      edgeStrength=ev>=0.12?'strong':ev>=0.06?'moderate':ev>=0.02?'small':'none';
    }else{
      edgeStrength=absDelta>=10?'strong':absDelta>=6?'moderate':absDelta>=3?'small':'none';
    }

    // Channel-agreement guard — the recommendation runs on the blended modelProb
    // (score channel + rate channel), but the rate channel is the principled,
    // distribution-based signal. When the pick is carried ENTIRELY by score-
    // channel optimism while the rate model itself lands on the opposite side of
    // the market, that's the phantom-edge signature that produced Overs against
    // good pitchers: the score nudged the blend past the market, but the
    // bottom-up math disagrees. Downgrade such picks one notch (strong→moderate→
    // small→none) and flag them, rather than silently recommending. Skip when the
    // disagreement is marginal (rate within 3pp of market) — that's just noise.
    let channelConflict=false;
    const _rb=_comp.rateBase;
    if(_rb!=null){
      const rateSaysOver=_rb>dv.overProb;
      const pickIsOver=direction==='Over';
      const margin=Math.abs(_rb-dv.overProb);
      if(rateSaysOver!==pickIsOver&&margin>=3&&edgeStrength!=='none'){
        edgeStrength=edgeStrength==='strong'?'moderate':edgeStrength==='moderate'?'small':'none';
        channelConflict=true;
      }
    }

    // Market-confidence flag based on raw imbalance at the selected line. Heavily
    // asymmetric markets (sideShare far from 50/50) are harder to devig accurately —
    // we can't tell if the imbalance is "real" matchup signal or a book-shaded line.
    // Doesn't change the recommendation; just informs the user that EV is more
    // uncertain on these. minImbalance was the |sideShare - 0.5| of the chosen line.
    let marketConfidence='high';
    if(minImbalance>=0.20)marketConfidence='low';
    else if(minImbalance>=0.10)marketConfidence='medium';

    results.push({
      prop:PROP_NAMES[propKey],propKey,line,direction,
      delta,absDelta,ev,edgeStrength,marketConfidence,channelConflict,
      marketOverProb:dv.overProb,marketUnderProb:dv.underProb,
      modelProb,
      // Calibration breadcrumbs — modelProbRaw is the pre-Platt probability,
      // scoreBase/rateBase are the blend inputs, and adjOffset is the additive
      // correction layered on top of the blend. Persisted on save so calibrate.js
      // can re-fit the Platt correction + blend weight from graded outcomes.
      modelProbRaw:_comp.raw??null,scoreBase:_comp.scoreBase??null,rateBase:_comp.rateBase??null,adjOffset:_comp.adjOffset??null,
      overBest,underBest,
      books:mkt.books||[],
      odds:bestOdds?.price||0,
      reasoning:corbetReasoning(propKey,direction.toLowerCase(),modelProb>=50?modelProb:100-modelProb),
      altLines,
    });
  });

  // Logical consistency: OVER total bases requires hits — flag contradiction
  const hitsRec=results.find(r=>r.propKey==='batter_hits'&&!r.insufficient);
  const tbRec=results.find(r=>r.propKey==='batter_total_bases'&&!r.insufficient);
  if(hitsRec&&tbRec&&hitsRec.direction!==tbRec.direction){
    hitsRec.conflict=true;
    hitsRec.edgeStrength='none'; // suppress recommendation on hits — TB is more specific
  }

  const order={strong:0,moderate:1,small:2,none:3};
  results.sort((a,b)=>order[a.edgeStrength]-order[b.edgeStrength]||b.absDelta-a.absDelta);
  return results;
}

async function _corbetFetchStatcastCSVs(){
  const [t1,t2,t3,t4,t5]=await Promise.all([
    api.savantStatcast('batter'),
    api.savantExpected('batter'),
    api.savantBattracking(),
    api.savantBatterArsenal(),
    api.savantBattedBall('batter'),
  ]);
  return{statRows:parseCSV(t1),expRows:parseCSV(t2),batRows:parseCSV(t3),arsenalRows:parseCSV(t4),battedRows:parseCSV(t5)};
}

function _corbetExtractStatcast(playerId,{statRows,expRows,batRows,arsenalRows,battedRows}){
  const sid=String(playerId);
  const statRow=statRows.find(r=>String(r.player_id||'').trim()===sid);
  const expRow=expRows.find(r=>String(r.player_id||'').trim()===sid);
  const batRow=batRows.find(r=>String(r.id||r.player_id||'').trim()===sid);
  const battedRow=battedRows.find(r=>String(r.id||'').trim()===sid);
  const batArsenalRows=arsenalRows.filter(r=>String(r.player_id||'').trim()===sid);
  const p=v=>{const n=parseFloat(v);return isNaN(n)?null:n};
  let whiffRaw=null;
  if(batArsenalRows.length){
    let total=0,weighted=0;
    batArsenalRows.forEach(r=>{const u=parseFloat(r.pitch_usage)||0,w=parseFloat(r.whiff_percent)||0;weighted+=w*u;total+=u;});
    if(total>0)whiffRaw=weighted/total;
  }
  return{
    xwoba:p(expRow?.est_woba),xba:p(expRow?.est_ba),xslg:p(expRow?.est_slg),
    brl:p(statRow?.brl_percent),hhRate:p(statRow?.ev95percent),avgEV:p(statRow?.avg_hit_speed),
    sweetSpot:p(statRow?.anglesweetspotpercent),
    gb:battedRow?.gb_rate!=null?p(battedRow.gb_rate)*100:null,
    fb:battedRow?.fb_rate!=null?p(battedRow.fb_rate)*100:null,
    whiff:whiffRaw,
    batSpeed:p(batRow?.avg_bat_speed),swingLength:p(batRow?.swing_length),
    squaredUp:batRow?(v=>v!=null?v*100:null)(p(batRow.squared_up_per_bat_contact)):null,
    blast:batRow?(v=>v!=null?v*100:null)(p(batRow.blast_per_bat_contact)):null,
  };
}

async function _corbetFetchMLBStats(playerId,pitcherId){
  const base=`/mlb/api/v1/people/${playerId}/stats`;
  const [a,b,c,d]=await Promise.all([
    fetch(`${base}?stats=statSplits&group=hitting&season=${SEASON}&gameType=R&sitCodes=h,a,vl,vr,d,n`),
    fetch(`${base}?stats=season&group=hitting&season=${SEASON}&gameType=R`),
    fetch(`${base}?stats=statSplits&group=hitting&season=${SEASON}&gameType=R&sitCodes=risp`),
    fetch(`${base}?stats=gameLog&group=hitting&season=${SEASON}&gameType=R`),
  ]);
  const [sd,ss,rd,gd]=await Promise.all([a.json(),b.json(),c.json(),d.json()]);
  const byCode={};
  (sd?.stats?.[0]?.splits??[]).forEach(s=>{if(s.split?.code)byCode[s.split.code]=_extractSplitStat(s.stat);});
  let matchupStats=null;
  if(pitcherId){
    try{
      const mr=await fetch(`${base}?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&gameType=R&season=${SEASON}`);
      const md=await mr.json();
      const st=md?.stats?.[0]?.splits?.[0]?.stat;
      const ab=parseInt(st?.atBats)||0;
      if(st&&ab>0){const ops=parseFloat(st.ops)||0;matchupStats={ab,h:parseInt(st.hits)||0,hr:parseInt(st.homeRuns)||0,k:parseInt(st.strikeOuts)||0,bb:parseInt(st.baseOnBalls)||0,ops,avg:st.avg,obp:st.obp,slg:st.slg};}
    }catch(e){console.warn(`Matchup stats failed for player ${playerId} vs pitcher ${pitcherId}:`,e.message);}
  }
  return{
    splits:byCode,
    seasonStat:ss?.stats?.[0]?.splits?.[0]?.stat??null,
    rispStat:rd?.stats?.[0]?.splits?.[0]?.stat??null,
    recentGameLog:(gd?.stats?.[0]?.splits||[]).slice(-10).reverse(),
    matchupStats,
  };
}

async function loadCorbet(){
  hide('corbet-no-prediction');hide('corbet-bets');hide('corbet-no-props');hide('corbet-error');hide('corbet-player-filter');
  show('corbet-loading');
  try{
    // ── Phase 1: Player stats + predictions (no odds needed) ─────────────────
    // Fetch Statcast CSVs once, then run predictions for all roster players.
    // Cards render immediately so DETAILS / STATS work before props post.
    const csvRows=await _corbetFetchStatcastCSVs();
    S.players=S.players||{};
    for(const player of activeRoster()){
      let saved=null;
      try{
        const mlbStats=await _corbetFetchMLBStats(player.id,S.pitcher?.id);
        const statcast=_corbetExtractStatcast(player.id,csvRows);
        saved={splits:S.splits,seasonStat:S.seasonStat,rispStat:S.rispStat,
          statcast:S.statcast,recentGameLog:S.recentGameLog,matchupStats:S.matchupStats,playerName:S.playerName};
        S.splits=mlbStats.splits;S.seasonStat=mlbStats.seasonStat;
        S.rispStat=mlbStats.rispStat;S.statcast=statcast;
        S.recentGameLog=mlbStats.recentGameLog;S.matchupStats=mlbStats.matchupStats;
        S.playerName=player.name;
        const{score,tier,factors,catTotals}=calcPrediction();
        S.players[player.id]={name:player.name,score,tier,factors,catTotals,
          splits:mlbStats.splits,seasonStat:mlbStats.seasonStat,rispStat:mlbStats.rispStat,
          recentGameLog:mlbStats.recentGameLog,matchupStats:mlbStats.matchupStats,statcast,
          order:player.order||null,
          pos:player.pos||null,
          lowData:(mlbStats.seasonStat?.plateAppearances||0)<50};
      }catch(e){
        console.warn(`Player load failed for ${player.name} (${player.id}):`,e.message);
        // Drop any stale cached entry so the UI shows the player as missing rather than displaying old stats
        delete S.players[player.id];
      }finally{
        // Always restore prior S state so a partial swap doesn't leak into subsequent iterations or UI
        if(saved)Object.assign(S,saved);
      }
    }
    // Render score-only player cards immediately — modals work now
    renderDashboard();

    // ── Phase 2: Odds + bets (optional — cards already visible above) ─────────
    // Lock window: once the game starts, freeze odds until 06:00 MST next morning.
    // Live in-game lines move wildly and we don't bet live, so we replay the last
    // pre-game fetch from localStorage instead of hitting the API.
    const locked=S.gameStatus==='Live'||S.gameStatus==='Final'||isOddsLocked(S.gameDate);
    let dbacksGame, propData;
    if(locked){
      const cached=readOddsCache(S.gamePk);
      if(!cached){
        hide('corbet-loading');
        const msg='Odds locked while game is in progress. No pre-game line was captured for this game.';
        document.getElementById('corbet-no-props').textContent=msg;
        show('corbet-no-props');
        document.getElementById('dash-best-bets').innerHTML=`<div class="dash-empty">${msg}</div>`;
        setOddsLockBadge(null);
        return;
      }
      dbacksGame=cached.eventsGame;
      propData=cached.propData;
      setOddsLockBadge(cached.savedAt);
    }else{
      setOddsLockBadge(null);
      const r=await api.oddsEvents();
      {const rem=r.headers.get('X-Requests-Remaining');if(rem!=null)setApiCredits(rem);}
      const eventsText=await r.text();
      let events;
      try{events=JSON.parse(eventsText);}catch(e){throw new Error('Could not parse Odds API response.');}
      if(!Array.isArray(events)){throw new Error(events?.message||'Unexpected Odds API response');}

      dbacksGame=events.find(e=>e.home_team?.includes('Arizona')||e.away_team?.includes('Arizona'));
      if(!dbacksGame){
        hide('corbet-loading');
        const msg='No D-backs game on the board yet — props usually post the evening before or morning of game day.';
        document.getElementById('corbet-no-props').textContent=msg;
        show('corbet-no-props');
        document.getElementById('dash-best-bets').innerHTML=`<div class="dash-empty">${msg}</div>`;
        return;
      }

      const propMarkets='batter_hits,batter_total_bases,batter_rbis,batter_walks,batter_strikeouts,batter_runs_scored,batter_hits_runs_rbis';
      // No bookmaker filter — let the API return every book that offers these
      // prop markets. The outcome-matching step downstream only keeps D-backs
      // outcomes anyway, so extra books in the response are harmless and let
      // us see exactly which books the Odds API actually feeds props from.
      const pr=await api.oddsProps(dbacksGame.id, propMarkets);
      const propsText=await pr.text();
      try{propData=JSON.parse(propsText);}catch(e){throw new Error('Props endpoint returned invalid response.');}
      if(propData.message||propData.error_code){throw new Error('Odds API: '+(propData.message||propData.error_code));}

      writeOddsCache(S.gamePk,{eventsGame:dbacksGame,propData});
    }

    // Build per-player market maps in one pass through bookmaker data.
    // The fetch only requests DK/MGM/CZR/365/FAN, so every returned book is implicitly trusted.
    // Bad-price defense is the lopsided-line gate in the line picker (generateCorbetBets).
    // Filter to the user's allowed book set before any processing.
    const _allowedBookmakers=(propData.bookmakers||[]).filter(b=>ALLOWED_BOOKS.has(b.title));
    _allowedBookmakers.forEach(book=>{
      const mkts=(book.markets||[]).map(m=>m.key+'('+m.outcomes.length+')');
      log('[props]',book.title,'markets:',mkts.join(', ')||'none');
    });
    const playerMaps={};
    activeRoster().forEach(p=>{playerMaps[p.id]={};});
    _allowedBookmakers.forEach(book=>{
      (book.markets||[]).forEach(market=>{
        if(!PROP_NAMES[market.key])return;
        activeRoster().forEach(player=>{
          const pFullName=player.name.toLowerCase().trim();
          const _pParts=pFullName.split(/\s+/);
          const pLast=_pParts[_pParts.length-1];
          const pFirst=_pParts[0]||'';
          // Match outcome description against the full player name. Books usually return
          // the full name ("Ildemaro Vargas"); fall back to abbreviated forms ("I. Vargas",
          // "I Vargas") only for THIS player's exact first initial + last name.
          const pInitial=pFirst[0]||'';
          const m0=playerMaps[player.id];
          if(!m0[market.key])m0[market.key]={
            overByLine:{},underByLine:{},
            overBestByLine:{},underBestByLine:{},
            books:[],calcBooks:new Set()
          };
          const m=m0[market.key];
          if(!m.books.includes(book.title))m.books.push(book.title);
          market.outcomes
            .filter(o=>{
              // Standard format: description = player name, name = "Over"/"Under"
              // Some books put the player name in `name` with no description.
              // Pick whichever field is not a bare direction keyword.
              const rawDesc=(o.description||'').toLowerCase().trim();
              const rawName=(o.name||'').toLowerCase().trim();
              const d=(rawDesc&&rawDesc!=='over'&&rawDesc!=='under')?rawDesc:rawName;
              if(!d.includes(pLast))return false;
              // Strict full-name match avoids cross-player collisions
              // (e.g. "Ildemaro Vargas" vs "Kenneth Vargas").
              if(d.includes(pFullName))return true;
              // Allow abbreviated form like "I. Vargas" / "I Vargas" only.
              const abbrevRe=new RegExp('(^|\\s)'+pInitial+'\\.?\\s+'+pLast+'(\\s|$|,)','i');
              return abbrevRe.test(d);
            })
            .forEach(o=>{
              const rawName=(o.name||'').toLowerCase();
              const rawDesc=(o.description||'').toLowerCase().trim();
              // Extract direction: prefer a bare "over"/"under" in either field;
              // fall back to word-boundary search for books that embed it in a
              // compound string like "Ketel Marte - Over".
              const dir=(rawName==='over'||rawName==='under')?rawName:
                        (rawDesc==='over'||rawDesc==='under')?rawDesc:
                        /\bover\b/.test(rawName)?'over':
                        /\bunder\b/.test(rawName)?'under':rawName;
              const price=o.price;
              const line=o.point||0.5;
              if(dir==='over'){
                if(!m.overBestByLine[line]||price>m.overBestByLine[line].price)
                  m.overBestByLine[line]={price,book:book.title};
                (m.overByLine[line]=m.overByLine[line]||[]).push(price);
                m.calcBooks.add(book.title);
              }else if(dir==='under'){
                if(!m.underBestByLine[line]||price>m.underBestByLine[line].price)
                  m.underBestByLine[line]={price,book:book.title};
                (m.underByLine[line]=m.underByLine[line]||[]).push(price);
                m.calcBooks.add(book.title);
              }else{
                console.warn('[odds] unrecognized direction for',book.title,market.key,'—',JSON.stringify({name:o.name,desc:o.description}));
              }
            });
        });
      });
    });

    // Visible "which books returned data" indicator so user can see coverage
    // without opening the browser console. Shows every book the API returned
    // for these prop markets — split by whether D-backs outcomes were matched.
    const _booksWithDbacks=new Set();
    Object.values(playerMaps).forEach(pm=>{
      Object.values(pm).forEach(mkt=>{
        (mkt.calcBooks||new Set()).forEach(t=>_booksWithDbacks.add(t));
      });
    });
    const _allowedTitles=_allowedBookmakers.map(b=>b.title);
    const _withDbacks=_allowedTitles.filter(t=>_booksWithDbacks.has(t));
    const _withoutDbacks=_allowedTitles.filter(t=>!_booksWithDbacks.has(t));
    const _allowedSet=new Set(ALLOWED_BOOKS);
    const _notReturned=[..._allowedSet].filter(t=>!_allowedTitles.includes(t));
    const _statusEl=document.getElementById('corbet-books-status');
    if(_statusEl){
      const parts=[];
      if(_withDbacks.length) parts.push(`<span style="color:#2ecc71;">● With Dbacks props:</span> ${_withDbacks.join(', ')}`);
      if(_withoutDbacks.length) parts.push(`<span style="color:#f39c12;">◐ Returned, no Dbacks outcomes:</span> <span style="color:#aaa;">${_withoutDbacks.join(', ')}</span>`);
      if(_notReturned.length) parts.push(`<span style="color:#888;">○ Not in API response:</span> <span style="color:#666;">${_notReturned.join(', ')}</span>`);
      _statusEl.innerHTML=parts.join('<br>');
      _statusEl.classList.remove('hidden');
    }

    // Expose raw market data for browser-console debugging.
    // Call debugProps() in the console to see per-player market summaries.
    window._debugPlayerMaps=playerMaps;
    window._debugPropData=propData;
    /* eslint-disable no-console -- intentional devtools entry: invoked manually from console */
    window.debugProps=function(){
      const PROP_KEYS=['batter_hits','batter_total_bases','batter_home_runs','batter_rbis',
        'batter_walks','batter_strikeouts','batter_runs_scored','batter_hits_runs_rbis'];
      activeRoster().forEach(p=>{
        const mm=playerMaps[p.id]||{};
        console.group(p.name+' ('+p.id+')');
        PROP_KEYS.forEach(k=>{
          const m=mm[k];
          if(!m){console.log(k+': no data');return;}
          const lines=new Set([...Object.keys(m.overByLine||{}),...Object.keys(m.underByLine||{})]);
          if(!lines.size){console.log(k+': no lines');return;}
          lines.forEach(l=>{
            const ov=(m.overByLine[l]||[]).join('/');
            const un=(m.underByLine[l]||[]).join('/');
            console.log(k+' @'+l+' over=['+ov+'] under=['+un+'] books='+JSON.stringify(m.books));
          });
        });
        console.groupEnd();
      });
    };
    /* eslint-enable no-console */
    log('[props] Market map built — call debugProps() in console to inspect per-player lines');

    // Generate bets for each roster player — game context (pitcher, weather, etc.) stays in S
    const allPlayerBets=[];
    for(const player of activeRoster()){
      let savedCtx=null;
      try{
        // Reuse the snapshot already computed in Phase 1 — no re-fetching needed
        const snap=S.players[player.id];
        if(!snap)continue;
        const rawMarketMap=playerMaps[player.id];
        // Swap in this player's stats for the entire bet-generation window. modelProbability
        // (called both inside generateCorbetBets and from monteCarloConfidence) reads
        // S.seasonStat / S.splits / S.statcast / S.recentGameLog / S.currentOrder, so all of
        // them must be swapped before MC runs and restored only after MC finishes.
        savedCtx={seasonStat:S.seasonStat,splits:S.splits,matchupStats:S.matchupStats,statcast:S.statcast,recentGameLog:S.recentGameLog,currentOrder:S.currentOrder};
        S.seasonStat=snap.seasonStat;S.splits=snap.splits;S.matchupStats=snap.matchupStats;S.statcast=snap.statcast;S.recentGameLog=snap.recentGameLog;S.currentOrder=snap.order;
        const bets=generateCorbetBets(snap.score,snap.factors,rawMarketMap);
        bets.forEach(b=>{
          if(!b.insufficient&&b.edgeStrength!=='none'&&b.marketOverProb!=null){
            b.mcConfidence=monteCarloConfidence(b.propKey,b.line,snap.score,b.marketOverProb,b.direction);
          }
        });
        bets.forEach(b=>{b._playerName=player.name;b._playerScore=snap.score;b._playerId=player.id;});
        allPlayerBets.push({playerName:player.name,bets,lowData:(S.players[player.id]?.lowData||false)});
      }catch(e){
        console.warn(`Bet generation failed for ${player.name} (${player.id}):`,e.message);
      }finally{
        // Always restore S so a partial swap doesn't leak into subsequent iterations or UI
        if(savedCtx)Object.assign(S,savedCtx);
      }
    }

    // Register pending grade entries as soon as predictions exist, regardless of
    // whether props are still being offered. This way games that ended (or where
    // sportsbooks pulled props before we visited) still create gradeable cards.
    autoRegisterGradePredictions();

    if(allPlayerBets.reduce((s,pg)=>s+pg.bets.length,0)===0){
      hide('corbet-loading');show('corbet-no-props');
      document.getElementById('dash-best-bets').innerHTML='<div class="dash-empty">Player props not yet posted for this game — check back tonight or tomorrow morning.</div>';
      return;
    }

    S.allPlayerBets=allPlayerBets.filter(pg=>pg.bets.length>0);
    const filterEl=document.getElementById('corbet-player-filter');
    filterEl.innerHTML='<div class="cpf-label">Show players</div>'+
      S.allPlayerBets.map(pg=>`<label data-name="${pg.playerName}"><input type="checkbox" checked data-action="render-corbet-bets"> ${pg.playerName}</label>`).join('');
    show('corbet-player-filter');
    renderCorbetBets();
    show('corbet-bets');
    renderDashboard();
    autoSaveAtFirstPitch();
  }catch(e){
    hide('corbet-loading');
    setText('corbet-error','⚠ '+e.message);
    show('corbet-error');
    document.getElementById('dash-best-bets').innerHTML=`<div class="dash-empty" style="color:#e74c3c;">⚠ ${e.message}</div>`;
  }finally{hide('corbet-loading');}
}

// (renderCorbetBets + togglePhantom moved to ui/record.js)

async function loadDashboard(){
  // Render game banner with current context
  _renderGameBanner();
  _renderPitcherCard();
  // Charter strip auto-fires on series-opener days only; no-op + hidden otherwise
  if (typeof window.renderDashboardCharter === 'function') {
    window.renderDashboardCharter();
  }
  // Make sure pitch-arsenal data is loaded before scoring any props — the matchup
  // factor is a no-op if S.pitchArsenal hasn't resolved yet.
  await _loadPitchArsenal();
  if(!S.players||Object.keys(S.players).length===0){
    document.getElementById('dash-best-bets').innerHTML='<div class="dash-empty">Loading…</div>';
    await loadCorbet();
  } else {
    renderDashboard();
  }
}

// (_renderGameBanner, _windFieldRelative, renderDashboard, togglePlayerCard,
//  _lineupAnalysisText, _matchupCardHtml, _splitsCardHtml, _recentFormHtml
//  moved to ui/dashboard.js)

// (Bet record + model calibration renderers moved to ui/record.js)


// ═══════════ SPLITS ════════════════════════════════════════════════════════════
function opsColor(o){if(!o)return'#777';return o>0.850?'#2ecc71':o>0.720?'#fff':'#e74c3c';}
function renderSplitPills(){document.getElementById('splits-pills').innerHTML=[['vs LHP','vl'],['vs RHP','vr'],['Home','h'],['Away','a'],['Day','d'],['Night','n']].map(([l,c])=>{const s=S.splits?.[c];return`<div class="pill"><div class="pill-label">${l}</div><div class="pill-val" style="color:${opsColor(s?.ops)}">${s?.ops?s.ops.toFixed(3):'—'}</div><div class="pill-sub">OPS</div></div>`;}).join('');show('splits-pills');}
function showSplitsLoading(){show('splits-spinner');hide('splits-error');hide('splits-content');hide('splits-empty');}
function showSplitsError(m){hide('splits-spinner');setText('splits-error','⚠ '+m);show('splits-error');}
function renderSplitsTab(){
  hide('splits-spinner');hide('splits-empty');
  if(S.playerName)document.getElementById('splits-card-header').textContent=`📈 ${S.playerName} · ${SEASON} Splits`;
  const ss=S.seasonStat;
  if(ss)document.getElementById('season-bar').innerHTML=[['AVG',ss.avg],['OBP',ss.obp],['SLG',ss.slg],['OPS',ss.ops],['HR',ss.homeRuns],['RBI',ss.rbi],['GP',ss.gamesPlayed]].map(([l,v])=>`<div><div class="s-label">${l}</div><div class="s-val${l==='OPS'?' green':''}">${v??'—'}</div></div>`).join('');
  document.getElementById('split-grid').innerHTML=[['vs Left-Handed','vl'],['vs Right-Handed','vr'],['Home Games','h'],['Away Games','a'],['Day Games','d'],['Night Games','n']].map(([l,c])=>{const s=S.splits?.[c];return`<div class="split-box"><div class="split-label">${l}</div><div class="split-ops" style="color:${opsColor(s?.ops)}">${s?.ops?s.ops.toFixed(3):'—'}</div><div class="split-sub">OPS</div>${s?.avg?`<div class="split-avg">AVG <span style="color:#666">${s.avg}</span></div>`:''}</div>`;}).join('');
  show('splits-content');
}

// ═══════════ ADVANCED STATS ════════════════════════════════════════════════════
function showStatsLoading(){show('stats-spinner');hide('stats-error');hide('stats-content');hide('stats-empty');}
function showStatsError(m){hide('stats-spinner');setText('stats-error','⚠ '+m);show('stats-error');}
// Renders the structured ⓘ tooltip from a STAT_INFO object.
// Accepts: { title, body, good, avg, bad, note } (all optional)
// Legacy: a plain string is rendered as a single body line.
// (_renderStatTip moved to ui/render.js)
// (statBox moved to ui/render.js)

// League-context tooltips for stat ⓘ icons.
// Object shape: { title, good, avg, bad, note?, body? } — body is for stats
// that don't have clean good/bad thresholds (counting stats, tradeoffs).
function pct(n,d){if(!n||!d||d===0)return'—';return((n/d)*100).toFixed(1)+'%';}
function renderStatsTab(){
  hide('stats-spinner');hide('stats-empty');
  if(S.playerName)document.getElementById('stats-card-header').textContent=`📊 ${S.playerName} · Advanced Stats ${SEASON}`;
  const ss=S.seasonStat,risp=S.rispStat;
  if(!ss){showStatsError('No season stats.');return;}
  const pa=ss.plateAppearances||1;
  const bbPct=pct(ss.baseOnBalls,pa),kPct=pct(ss.strikeOuts,pa);
  // Color thresholds aligned with STAT_INFO so the box color matches the tooltip.
  // AB/HR is inverted (lower = better) — guard against missing value with the ternary head.
  const _v=x=>parseFloat(x), _abhrC=(()=>{const v=ss.atBatsPerHomeRun?_v(ss.atBatsPerHomeRun):null;return v==null?'':(v<=18?'good':v>=50?'bad':'');})();
  document.getElementById('stat-slash').innerHTML=
    statBox('BA',   ss.avg,   `${ss.hits}H / ${ss.atBats}AB`, _v(ss.avg)>=0.290?'good':_v(ss.avg)<=0.220?'bad':'', STAT_INFO.BA)+
    statBox('OBP',  ss.obp,   `${ss.baseOnBalls}BB`,          _v(ss.obp)>=0.360?'good':_v(ss.obp)<=0.290?'bad':'', STAT_INFO.OBP)+
    statBox('SLG',  ss.slg,   `${ss.totalBases}TB`,           _v(ss.slg)>=0.470?'good':_v(ss.slg)<=0.350?'bad':'', STAT_INFO.SLG)+
    statBox('OPS',  ss.ops,   'OBP + SLG',                    _v(ss.ops)>=0.830?'good':_v(ss.ops)<=0.640?'bad':'', STAT_INFO.OPS)+
    (()=>{const w=_seasonWoba(ss);return statBox('wOBA', w!=null?w.toFixed(3).replace(/^0/,''):'—', 'Weighted OBA', w==null?'':(w>=0.370?'good':w<=0.290?'bad':''), STAT_INFO.WOBA);})()+
    statBox('BABIP',ss.babip, 'Balls in play avg',            _v(ss.babip)>=0.340?'good':_v(ss.babip)<=0.270?'bad':'', STAT_INFO.BABIP)+
    statBox('AB/HR',ss.atBatsPerHomeRun?_v(ss.atBatsPerHomeRun).toFixed(1):'—', 'At-bats per HR', _abhrC, STAT_INFO.ABHR);
  const _bbkRaw=ss.baseOnBalls&&ss.strikeOuts?(ss.baseOnBalls/ss.strikeOuts):null;
  document.getElementById('stat-discipline').innerHTML=
    statBox('BB%', bbPct, `${ss.baseOnBalls} walks / ${pa} PA`, parseFloat(bbPct)>=10?'good':parseFloat(bbPct)<=6?'bad':'', STAT_INFO.BBPCT)+
    statBox('K%',  kPct,  `${ss.strikeOuts} Ks / ${pa} PA`,    parseFloat(kPct)<=16?'good':parseFloat(kPct)>=25?'bad':'', STAT_INFO.KPCT_B)+
    statBox('BB/K',_bbkRaw!=null?_bbkRaw.toFixed(2):'—', 'Walk to K ratio', _bbkRaw==null?'':(_bbkRaw>=0.50?'good':_bbkRaw<=0.25?'bad':''), STAT_INFO.BBK)+
    statBox('IBB', ss.intentionalWalks??'0', 'Intentional walks', '', STAT_INFO.IBB)+
    statBox('HBP', ss.hitByPitch??'0',       'Hit by pitch',      '', STAT_INFO.HBP)+
    statBox('SAC', (ss.sacBunts??0)+(ss.sacFlies??0), 'Sac bunts + flies', '', STAT_INFO.SAC);
  document.getElementById('stat-power').innerHTML=statBox('HR',ss.homeRuns,`${ss.atBatsPerHomeRun?parseFloat(ss.atBatsPerHomeRun).toFixed(1):'—'} AB/HR`,'',STAT_INFO.HR)+statBox('2B',ss.doubles,'Doubles','',STAT_INFO.D2B)+statBox('3B',ss.triples,'Triples','',STAT_INFO.D3B)+statBox('XBH',(ss.homeRuns||0)+(ss.doubles||0)+(ss.triples||0),'Extra base hits','',STAT_INFO.XBH)+statBox('RBI',ss.rbi,`${ss.leftOnBase} LOB`,'',STAT_INFO.RBI)+statBox('SB',`${ss.stolenBases}/${(ss.stolenBases||0)+(ss.caughtStealing||0)}`,'SB success','',STAT_INFO.SB);
  if(risp){const ro=((parseFloat(risp.obp)||0)+(parseFloat(risp.slg)||0)).toFixed(3);const rc=parseFloat(risp.avg)>=0.280?'#2ecc71':parseFloat(risp.avg)<=0.200?'#e74c3c':'#fff';document.getElementById('stat-risp').innerHTML=`<div class="risp-box"><div><div class="stat-label" style="margin-bottom:4px">BA w/ RISP</div><div class="risp-main" style="color:${rc}">${risp.avg??'—'}</div></div><div class="risp-detail">OBP <strong style="color:#fff">${risp.obp??'—'}</strong><br>SLG <strong style="color:#fff">${risp.slg??'—'}</strong><br>OPS <strong style="color:#fff">${ro}</strong>${risp.rbi?`<br>RBI <strong style="color:#fff">${risp.rbi}</strong>`:''}</div><div class="risp-detail">H <strong style="color:#fff">${risp.hits??'—'}</strong><br>AB <strong style="color:#fff">${risp.atBats??'—'}</strong><br>PA <strong style="color:#fff">${risp.plateAppearances??'—'}</strong><br>K <strong style="color:#fff">${risp.strikeOuts??'—'}</strong></div></div>`;}
  else document.getElementById('stat-risp').innerHTML='<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;">RISP data not available.</div>';
  show('stats-content');
}

// ═══════════ GRADING & LEARNING SYSTEM ══════════════════════════════════════

// Default factor weights — these get adjusted by the learning system
// Default weight per factor label. Each weight represents the typical |adj|
// magnitude when that factor fires at default sensitivity. calcPrediction
// multiplies every factor's adj by (currentWeight / defaultWeight) so when
// autoAdjustWeights nudges a weight up or down, the actual score moves with it.
//
// Labels MUST match the strings passed to add() in calcPrediction — a typo
// silently drops the multiplier (mult = 1.0) and the factor never learns.

// Bet log + grading subsystem (storage helpers, savePredictionForGrading,
// gradePerformance, autoGrade, clearGrades, …) lives in bets.js. app.js
// listens for 'bets:changed' / 'grades:changed' to refresh the record + grade
// panels.

// (renderGradePanel + drawPerfChart moved to ui/record.js)

// ═══════════ STATCAST ════════════════════════════════════════════════════════
// (parseCSV moved to utils.js)

// Renders the Statcast/Advanced grid from a raw-value statcast object (S.statcast
// shape). Shared by loadStatcast (Setup panel) and openPlayerStats (dashboard
// "More Stats" button) so the grid always reflects the player being viewed.
// (_renderStatcastGrid moved to ui/render.js)

async function loadStatcast(playerId) {
  document.getElementById('stat-statcast').innerHTML = '<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Loading Statcast data...</div>';
  try {
    const [statText, expText, batText, arsenalText, battedText] = await Promise.all([
      api.savantStatcast('batter'),
      api.savantExpected('batter'),
      api.savantBattracking(),
      api.savantBatterArsenal(),
      api.savantBattedBall('batter'),
    ]);

    const statRows    = parseCSV(statText);
    const expRows     = parseCSV(expText);
    const batRows     = parseCSV(batText);
    const arsenalRows = parseCSV(arsenalText);
    const battedRows  = parseCSV(battedText);

    const sid = String(playerId);
    const statRow    = statRows.find(r   => String(r.player_id||'').trim() === sid);
    const expRow     = expRows.find(r    => String(r.player_id||'').trim() === sid);
    const batRow     = batRows.find(r    => String(r.id||r.player_id||'').trim() === sid);
    const battedRow  = battedRows.find(r => String(r.id||'').trim() === sid);

    // Whiff% from batter pitch-arsenal: weighted avg of whiff_percent by pitch_usage
    // (bat-tracking endpoint has blank whiff_per_swing for 2026)
    const batArsenalRows = arsenalRows.filter(r => String(r.player_id||'').trim() === sid);
    let whiffRaw = null;
    if (batArsenalRows.length) {
      let total = 0, weighted = 0;
      batArsenalRows.forEach(r => {
        const usage = parseFloat(r.pitch_usage) || 0;
        const wh    = parseFloat(r.whiff_percent) || 0;
        weighted += wh * usage; total += usage;
      });
      if (total > 0) whiffRaw = weighted / total;
    }

    const p=(v)=>{const n=parseFloat(v);return isNaN(n)?null:n};

    // Expected stats
    const xwobaRaw = p(expRow?.est_woba);
    const xbaRaw   = p(expRow?.est_ba);
    const xslgRaw  = p(expRow?.est_slg);

    // Statcast contact quality
    const brlRaw     = p(statRow?.brl_percent);
    const hhRaw      = p(statRow?.ev95percent);
    const avgEVRaw   = p(statRow?.avg_hit_speed);
    const sweetSpRaw = p(statRow?.anglesweetspotpercent);

    // GB%/FB% from batted-ball leaderboard (gb_rate/fb_rate are 0-1 decimals → multiply by 100)
    const gbRaw      = battedRow?.gb_rate != null ? p(battedRow.gb_rate) * 100 : null;
    const fbRaw      = battedRow?.fb_rate != null ? p(battedRow.fb_rate) * 100 : null;

    // Bat tracking (bat speed, swing length, squared-up, blast)
    const batSpdRaw  = p(batRow?.avg_bat_speed);
    const swLenRaw   = p(batRow?.swing_length);
    const sqdUpRaw   = batRow ? (v => v != null ? v * 100 : null)(p(batRow.squared_up_per_bat_contact)) : null;
    const blastRaw   = batRow ? (v => v != null ? v * 100 : null)(p(batRow.blast_per_bat_contact)) : null;

    S.statcast = {
      xwoba: xwobaRaw, xba: xbaRaw, xslg: xslgRaw,
      brl: brlRaw, hhRate: hhRaw, avgEV: avgEVRaw,
      sweetSpot: sweetSpRaw, gb: gbRaw, fb: fbRaw,
      whiff: whiffRaw, batSpeed: batSpdRaw,
      swingLength: swLenRaw, squaredUp: sqdUpRaw, blast: blastRaw,
    };
    _renderStatcastGrid(S.statcast);

  } catch(e) {
    document.getElementById('stat-statcast').innerHTML = `<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Statcast data unavailable: ${e.message}</div>`;
  }
}

// ═══════════ UTILS ════════════════════════════════════════════════════════════
// show / hide / setText moved to utils.js

// ── Soft-market tooltip (fixed-position, avoids stacking-context issues on mobile) ──
(function(){
  const TIP_SEL='.hdr-info[data-tip],.dpb-soft-market[data-tip],.corbet-info[data-tip],.factor-inflator[data-tip],.inflator-badge[data-tip]';
  let tip=null, activeEl=null;
  function getOrCreate(){
    if(!tip){tip=document.createElement('div');tip.id='soft-market-tip';document.body.appendChild(tip);}
    return tip;
  }
  function show(el){
    const t=getOrCreate();
    t.textContent=el.dataset.tip;
    // Teal (info) by default to match the standard header tooltips; orange only
    // for the soft-market warning so it stays visually distinct as a caution.
    t.style.borderColor=el.classList.contains('dpb-soft-market')?'#f39c12':'#009A8B';
    // Position above the badge, clamped to viewport edges
    const r=el.getBoundingClientRect();
    const w=Math.min(260,window.innerWidth-24);
    t.style.width=w+'px';
    let left=r.left+r.width/2-w/2;
    left=Math.max(12,Math.min(left,window.innerWidth-w-12));
    t.style.left=left+'px';
    // position:fixed means top is viewport-relative; r.top already is, so
    // do NOT add window.scrollY (that pushes the tip off-screen when scrolled).
    t.style.top=r.top+'px';
    t.style.transform='translateY(calc(-100% - 8px))';
    document.body.appendChild(t);
    activeEl=el;
  }
  function dismiss(){
    tip?.remove();tip=null;activeEl=null;
  }
  // Track whether the tooltip is currently hover-driven so a tap (which fires
  // mouseenter then click on touch devices) doesn't immediately toggle it off.
  let hoverShown=false;
  document.addEventListener('click',function(e){
    const badge=e.target.closest(TIP_SEL);
    if(badge){
      e.stopPropagation();
      if(activeEl===badge&&!hoverShown){dismiss();}
      else{show(badge);hoverShown=false;}
      return;
    }
    if(activeEl)dismiss();
  },true);
  document.addEventListener('mouseover',function(e){
    const badge=e.target.closest(TIP_SEL);
    if(!badge||activeEl===badge)return;
    show(badge);
    hoverShown=true;
  });
  document.addEventListener('mouseout',function(e){
    if(!hoverShown||!activeEl)return;
    const badge=e.target.closest(TIP_SEL);
    if(badge!==activeEl)return;
    // Ignore mouseout into a child element of the badge
    if(badge.contains(e.relatedTarget))return;
    dismiss();
    hoverShown=false;
  });
  document.addEventListener('scroll',()=>{dismiss();hoverShown=false;},{passive:true,capture:true});
})();

// ═══════════ INIT ══════════════════════════════════════════════════════════════
document.getElementById('game-date').value=new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0]; // Arizona-local fallback until API responds (UTC would roll a day ahead for evening sessions)

// ═══════════ EVENT DELEGATION ════════════════════════════════════════════════
// Replaces inline `onclick="..."` handlers (audit finding #9). Each interactive
// element carries `data-action="..."` and optional `data-*` payloads; a single
// dispatcher routes events to the named handler in ACTIONS. This pattern
// eliminates the "chained inline handler" bug class (e.g. PR4a missed
// `openPlayerStats` because it appeared *after* `event.stopPropagation();` in
// the onclick string) — every action is a real function reference now, not a
// substring inside an HTML attribute.
//
// Migration is phased. Phase 1 (this PR) covers all chained handlers + the
// `oninput` on the pitch-mix slider. Single-call inline handlers still exist
// and continue to rely on the window-exposure block below; those migrate in a
// follow-up.
const ACTIONS = {
  // ── Page actions (no args) ────────────────────────────────────────────────
  'load-player':           () => loadPlayer(),
  'run-prediction':        () => runPrediction(),
  'fetch-weather':         () => fetchWeather(),
  'toggle-manual':         () => toggleManual(),
  'toggle-weather-manual': () => toggleWeatherManual(),
  'toggle-add-bet':        () => toggleAddBetForm(),
  'check-charter':         () => window.checkCharter(),         // defined in charter.js (classic script)
  'refresh-charter':       () => window.refreshDashboardCharter?.(), // defined in charter.js (classic script)
  'load-umpire-weather':   () => loadUmpireAndWeather(),
  'update-weather-time':   () => updateWeatherForTime(),
  'stadium-change':        () => onStadiumChange(),
  'reload':                () => location.reload(),

  // ── Sync + push ──────────────────────────────────────────────────────────
  'push-record':    () => pushRecord(),
  'pull-record':    () => pullRecord(),
  'push-subscribe': () => _pushSubscribe(),
  'push-test':      () => _pushTest(),

  // ── Bet log ──────────────────────────────────────────────────────────────
  'clear-record':   () => clearRecord(),
  'clear-grades':   () => clearGrades(),
  'add-manual-bet': () => addManualBet(),
  'autograde':      () => autoGradeBetLog(),

  // ── Setup toggles (value in data-value) ──────────────────────────────────
  'set-throws':         (el) => setThrows(el.dataset.value),
  'set-day':            (el) => setDay(el.dataset.value === 'true'),
  'set-home':           (el) => setHome(el.dataset.value === 'true'),
  'set-roof':           (el) => setRoof(el.dataset.value === 'true'),
  'toggle-factor-card': (el) => toggleFactorCard(el.dataset.value),
  'set-record-sort':    (el) => setRecordSort(el.dataset.value),
  'toggle-player-acc':  (el) => togglePlayerAcc(el.dataset.name),
  'set-top-bets-sort':  (el) => setTopBetsSort(el.dataset.value),

  // ── Bet finder (Add bet form) ────────────────────────────────────────────
  'abf-set-dir':    (el) => abfSetDir(el.dataset.value),
  'abf-set-result': (el) => abfSetResult(el.dataset.value === 'null' ? null : el.dataset.value),

  // ── Modal lifecycle ──────────────────────────────────────────────────────
  'open-setup':     () => openModal('panel-setup',   'Setup & Overrides'),
  'open-pitcher':   () => openModal('panel-pitcher', 'Pitcher Analysis'),
  'close-modal':    () => closeModal(),
  // Close only when clicking the backdrop itself, not modal content.
  'close-modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },

  // ── Chained / composite handlers (bug-prone class — see audit #9) ────────
  'open-grade':        () => { openModal('panel-grade',       'Grade & Learn');     renderGradePanel(); },
  'open-record':       () => { openModal('panel-record',      'Bet Record');        renderRecord(); },
  'view-corbet':       () => { closeModal(); openModal('panel-corbet', 'CorBET Carroll'); loadCorbet(); },
  'adjust-conditions': () => { closeModal(); openModal('panel-setup', 'Setup & Overrides'); },
  'open-calibration':  () => { openModal('panel-calibration', 'Model Calibration'); renderCalibration(); },
  // open-player-stats stops propagation so the row's outer click handler
  // (which opens the Details modal) doesn't also fire.
  'open-player-stats':   (el, e) => { e.stopPropagation(); openPlayerStats(el.dataset.playerId); },

  // ── Dynamic actions (inside app.js innerHTML strings) ────────────────────
  'select-pitcher':      (el) => selectPitcher(el.dataset.pitcherId, el.dataset.pitcherName),
  'render-corbet-bets':  () => renderCorbetBets(),
  'toggle-phantom':      (el) => togglePhantom(el.dataset.bk, parseFloat(el.dataset.line), el.checked),
  'save-bet':            (el) => saveBet(el.dataset.bk, el),
  'open-player-corbet':  (el) => openPlayerCorbet(el.dataset.playerId),
  'open-player-details': (el) => openPlayerDetails(el.dataset.playerId),
  'toggle-player-card':  (el) => togglePlayerCard(el.dataset.playerId),
  'set-result':          (el) => setResult(parseInt(el.dataset.betId), el.dataset.value),
  'delete-bet':          (el) => deleteBet(parseInt(el.dataset.betId)),
  'auto-grade':          (el) => autoGrade(parseInt(el.dataset.predId), el.dataset.playerId, el.dataset.date),
  'edit-grade':          (el) => editGradeEntry(parseInt(el.dataset.gradeId)),
  'delete-grade':        (el) => deleteGradeEntry(parseInt(el.dataset.gradeId)),
  'remove-pending':      (el) => removePending(parseInt(el.dataset.predId)),

  // ── Inputs (data-action + delegation on 'input' event) ───────────────────
  'pitcher-search':   (el) => onPitcherSearch(el.value),
  'temp-slider':      (el) => { document.getElementById('temp-label').textContent  = 'Temp: '     + el.value + '°F'; },
  'wind-slider':      (el) => { document.getElementById('wind-label').textContent  = 'Wind: '     + el.value + ' mph'; },
  'humid-slider':     (el) => { document.getElementById('humid-label').textContent = 'Humidity: ' + el.value + '%'; },
  'pitch-mix-slider': (el) => {
    S.pitcherPitches[el.dataset.pitch] = parseInt(el.value);
    el.nextElementSibling.textContent = el.value + '%';
  },
};

function _dispatchAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = ACTIONS[el.dataset.action];
  if (handler) handler(el, e);
}
document.addEventListener('click',  _dispatchAction);
document.addEventListener('input',  _dispatchAction);
document.addEventListener('change', _dispatchAction);

// Audit #9 done: inline handlers are gone; everything routes through the
// data-action delegation above. window.S is still set in state.js for
// charter.js (classic script) which reads it directly.

loadCalibration();         // load persisted Platt/blend params into memory
recalibrate(S.betLog);     // refit from the current bet log (catches synced grades) before any prediction runs
onStadiumChange();
loadPlayer();
dedupePending(); // remove legacy duplicate Pending Grade cards
renderRecord();
renderGradePanel();
_initSyncBtnLabel(); // "↑ Push" on desktop, "↓ Pull" on mobile
_initPushBtn();
registerSW(); // register service worker on every load so it picks up updates
_loadPitchArsenal(); // warm cache for pitch-mix matchup factor
autoLoadNextGame(); // overwrites date/time and pulls umpire, weather, lineup
loadTwoWeekSchedule(); // dashboard 14-day calendar strip
loadTeamMomentum(); // dashboard team standings/streak strip
