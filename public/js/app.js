// ═══════════ STATE ════════════════════════════════════════════════════════════
const S = {
  splits:null, seasonStat:null, rispStat:null,
  playerName:'Corbin Carroll', playerId:'682998',
  pitcher:null, pitcherThrows:'R',
  pitcherPitches:{'4-Seam FB':40,'Slider':25,'Changeup':20,'Curveball':15,'Sinker':0,'Cutter':0,'Splitter':0},
  isHome:true, dayGame:false, roofClosed:true,
  weather:null, umpire:null, weatherManual:false, pitcherManual:false,
  matchupStats:null,
  lineupProtection:{tier:'average',avgOps:null,spots:[],manual:true},
  lineupRoster:null,
  recentGameLog:null,
  lastScore:null, lastPrediction:null,
  recordSort: (()=>{
    try{const s=JSON.parse(localStorage.getItem('corbetRecordSort'));if(s&&s.key&&s.dir)return s;}catch(e){}
    return{key:'date',dir:'desc'};
  })(),
  betLog: (()=>{
    const log=JSON.parse(localStorage.getItem('corbetRecord')||'[]');
    // Repair any duplicate IDs from a prior bug where autoSaveTopBets used the same Date.now() timestamp
    const seen=new Set();
    let repaired=false;
    log.forEach((b,i)=>{
      if(seen.has(b.id)){b.id=Date.now()+i;repaired=true;}
      seen.add(b.id);
      // Repair legacy entries from saveBet bug that stored rating as undefined.
      // Derive from EV when possible; default to 'yellow' otherwise.
      if(!['green','yellow','red'].includes(b.rating)){
        b.rating=b.ev>=0.12?'green':b.ev>=0.06?'yellow':b.ev>=0.02?'red':'yellow';
        repaired=true;
      }
    });
    if(repaired)localStorage.setItem('corbetRecord',JSON.stringify(log));
    return log;
  })(),
};

const CORBET_ROSTER = [
  { name: 'Corbin Carroll',   id: '682998' },
  { name: 'Ketel Marte',      id: '606466' },
  { name: 'Gabriel Moreno',   id: '672515' },
  { name: 'Geraldo Perdomo',  id: '672695' },
  { name: 'Ildemaro Vargas',  id: '545121' },
  { name: 'Lourdes Gurriel',  id: '666971' },
  { name: 'Nolan Arenado',    id: '571448' },
];
// Returns the live lineup roster when available, otherwise the hardcoded fallback
function activeRoster(){ return S.lineupRoster||CORBET_ROSTER; }

function rebuildPlayerSelect(roster){
  const sel=document.getElementById('player-select');
  if(!sel)return;
  const cur=sel.value;
  sel.innerHTML=roster.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  if(roster.some(p=>String(p.id)===String(cur)))sel.value=cur;
  else{sel.selectedIndex=0;loadPlayer();}
}

// ═══════════ MATH / BETTING UTILS ════════════════════════════════════════════

// Park orientation helpers
const _COMPASS_DEGS={N:0,NNE:22.5,NE:45,ENE:67.5,E:90,ESE:112.5,SE:135,SSE:157.5,S:180,SSW:202.5,SW:225,WSW:247.5,W:270,WNW:292.5,NW:315,NNW:337.5};
function _compassDeg(pt){return _COMPASS_DEGS[pt]??null;}

// Reads park HR and hit factors from the active stadium dropdown option.
function _parkFactors(){const sel=document.getElementById('stadium-select');const opt=sel?.options[sel?.selectedIndex];return{hrF:parseFloat(opt?.dataset.hr)||1.0,hitF:parseFloat(opt?.dataset.hit)||1.0,elev:parseInt(opt?.dataset.elev)||0,hasRoof:opt?.dataset.roof==='1'};}

// Returns 'out'/'in'/'cross'/'calm' relative to this park's center field orientation.
// Accounts for live vs manual weather mode.
function _windDir(){
  const sel=document.getElementById('stadium-select');const opt=sel?.options[sel?.selectedIndex];
  const cfBearing=parseInt(opt?.dataset.cf)||45;
  const wm=document.getElementById('weather-manual')&&!document.getElementById('weather-manual').classList.contains('hidden');
  const rawDir=(!wm&&S.weather?.windDir)||document.getElementById('wind-dir')?.value||'calm';
  const windMph=(!wm&&S.weather?.windMph)||parseInt(document.getElementById('wind-slider')?.value)||5;
  if(['out','in','cross'].includes(rawDir))return rawDir;
  if(!rawDir||rawDir==='calm'||windMph<3)return 'calm';
  const fromDeg=_compassDeg(rawDir);if(fromDeg===null)return 'cross';
  const toDeg=(fromDeg+180)%360;
  const comp=Math.cos((cfBearing-toDeg)*Math.PI/180);
  return comp>0.35?'out':comp<-0.35?'in':'cross';
}

function gaussianRandom(mean, std) {
  const u1 = Math.random() || 1e-10, u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Eighth-Kelly fraction (0–1 range; 0 means no bet). Conservative sizing to
// dampen variance from model error — full Kelly assumes perfect win-prob estimates.
function kellyFraction(modelProb, odds) {
  if (!odds) return 0;
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const p = modelProb / 100, q = 1 - p;
  return Math.max(0, (b * p - q) / b) * 0.125;
}

// Advanced pitcher metrics (FIP, xFIP, SIERA, K-BB%, HR/9) derived from MLB Stats API
// + Baseball Savant Statcast. Returns nulls when data is insufficient.
const _FIP_CONSTANT = 3.10; // Approximates league-avg (ERA - raw FIP) — stable around 3.0-3.2
const _LG_HRFB = 0.105;     // League-average HR per fly ball, used for xFIP normalization
function _computePitcherMetrics(st, statcast){
  const ip=parseFloat(st?.inningsPitched)||0;
  const hr=parseInt(st?.homeRuns)||0;
  const bb=parseInt(st?.baseOnBalls)||0;
  const hbp=parseInt(st?.hitByPitch)||0;
  const k=parseInt(st?.strikeOuts)||0;
  const tbf=parseInt(st?.battersFaced)||0;
  if(ip<1||tbf<1)return{fip:null,xfip:null,siera:null,kbbPct:null,hr9:null};
  const fip=(13*hr+3*(bb+hbp)-2*k)/ip+_FIP_CONSTANT;
  const hr9=(hr/ip)*9;
  const kbbPct=((k-bb)/tbf)*100;
  let xfip=null;
  const fbPct=statcast?.fbPct;
  const gbPct=statcast?.gbPct;
  if(fbPct!=null&&fbPct>0){
    const bip=Math.max(0,tbf-k-bb-hbp);
    const fbCount=bip*(fbPct/100);
    const expHR=fbCount*_LG_HRFB;
    xfip=(13*expHR+3*(bb+hbp)-2*k)/ip+_FIP_CONSTANT;
  }
  // SIERA — FanGraphs formula. Captures K/BB plus batted-ball mix (GB - FB - PU).
  // Pop-ups aren't in our Statcast cut, so we approximate (GB - FB - PU)/PA with
  // (GB - FB)/PA, knowing this slightly understates the GB-pitcher advantage.
  // Returns null when batted-ball mix isn't loaded.
  let siera=null;
  if(fbPct!=null&&gbPct!=null&&ip>=10){
    const bip=Math.max(0,tbf-k-bb-hbp);
    const gbCount=bip*(gbPct/100);
    const fbCount=bip*(fbPct/100);
    const kPA=k/tbf;
    const bbPA=(bb+hbp)/tbf;
    const battedDiff=(gbCount-fbCount)/tbf;
    const ind = battedDiff>=0 ? 1 : -1;
    siera = 6.145
          - 16.986 * kPA
          + 11.434 * bbPA
          - 1.858 * battedDiff
          + 7.653 * kPA * kPA
          + ind * 6.664 * battedDiff * battedDiff
          + 10.130 * kPA * battedDiff
          - 5.195 * bbPA * battedDiff;
  }
  return{fip,xfip,siera,kbbPct,hr9};
}

// Score-variance estimate for Monte Carlo, derived from the hitter's profile.
// High-whiff hitters have wider outcome distributions (more boom/bust), so the
// model score is a less reliable point estimate — σ scales up. Small samples
// (<50 PA) also widen σ since the season-rate inputs are noisy.
// Maps: whiff 18% → σ≈5.0 (contact hitter), 28% → σ≈6.5 (league avg),
//       38% → σ≈8.0 (three-true-outcomes). Clamped to [4.5, 10].
function _mcVariance(){
  const sc=S.statcast||{};
  const ss=S.seasonStat||{};
  const whiff=parseFloat(sc.whiff_percent);
  let sigma=isFinite(whiff)?5+(whiff-18)*0.15:6;
  const pa=parseInt(ss.plateAppearances)||0;
  if(pa>0&&pa<50)sigma+=1.5;
  return Math.max(4.5,Math.min(10,sigma));
}

// Monte Carlo confidence: % of noisy-score simulations where the edge holds
// Requires S player fields to be swapped in before calling (same window as generateCorbetBets)
function monteCarloConfidence(propKey, line, score, marketOverProb, direction = 'Over', N = 2000) {
  let edgeCount = 0;
  const isUnder = String(direction).toLowerCase() === 'under';
  const sigma = _mcVariance();
  for (let i = 0; i < N; i++) {
    const ns = Math.max(4, Math.min(96, gaussianRandom(score, sigma)));
    const prob = modelProbability(propKey, line, ns);
    if (prob === null) continue;
    if (isUnder ? prob < marketOverProb : prob > marketOverProb) edgeCount++;
  }
  return (edgeCount / N) * 100;
}

// ═══════════ MODAL SYSTEM ════════════════════════════════════════════════════
let _modalPanels = [];
let _modalSavedS = null;

function _clearModalSlot() {
  const content = document.querySelector('.content');
  _modalPanels.forEach(id => {
    const p = document.getElementById(id);
    if (p) content.appendChild(p);
  });
  _modalPanels = [];
  document.getElementById('modal-slot').innerHTML = '';
}

function _moveToModal(panelId) {
  const p = document.getElementById(panelId);
  if (!p) return;
  document.getElementById('modal-slot').appendChild(p);
  _modalPanels.push(panelId);
}

function openModal(panelIds, title) {
  if (typeof panelIds === 'string') panelIds = [panelIds];
  _clearModalSlot();
  document.getElementById('modal-player-name').textContent = title || '';
  panelIds.forEach(id => _moveToModal(id));
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  _clearModalSlot();
  document.getElementById('modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (_modalSavedS) { Object.assign(S, _modalSavedS); _modalSavedS = null; }
  _renderPitcherCard(); // re-assert card after DOM-move operations
}

function _swapToPlayer(playerId) {
  const p = S.players?.[playerId];
  if (!p) return null;
  // If a modal is already open with a stale save slot, restore its outer state
  // before swapping again so the original outer state isn't permanently lost.
  if (_modalSavedS) { Object.assign(S, _modalSavedS); _modalSavedS = null; }
  const saved = {
    playerName: S.playerName, playerId: S.playerId, splits: S.splits, seasonStat: S.seasonStat,
    rispStat: S.rispStat, statcast: S.statcast, recentGameLog: S.recentGameLog,
    matchupStats: S.matchupStats, lastScore: S.lastScore, currentOrder: S.currentOrder
  };
  S.playerName = p.name; S.playerId = playerId; S.splits = p.splits; S.seasonStat = p.seasonStat;
  S.rispStat = p.rispStat; S.statcast = p.statcast;
  S.recentGameLog = p.recentGameLog; S.matchupStats = p.matchupStats;
  S.lastScore = p.score; S.currentOrder = p.order;
  return saved;
}

function openPlayerDetails(playerId) {
  const snap = S.players?.[playerId];
  if (!snap) return;
  _modalSavedS = _swapToPlayer(playerId);
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
  renderFactorCards(snap.factors, snap.catTotals);
  buildPredictionSummary(snap.factors);
  // Auto-populate the Pitch Mix matchup grid so users see batter vs pitcher arsenal
  // without having to click Run Prediction. _swapToPlayer already set S.playerId so
  // _renderPitchMatchup keys into the right batter row in S.pitchArsenal.
  document.getElementById('pitch-display').innerHTML = _renderPitchMatchup();
  document.getElementById('result-nav-btns').style.display = 'none';
  hide('no-prediction'); show('prediction-output');
  openModal('panel-result', snap.name + ' · Details');
}

function openPlayerCorbet(playerId) {
  const snap = S.players?.[playerId];
  if (!snap) return;
  _modalSavedS = _swapToPlayer(playerId);
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
  const snap = S.players?.[playerId];
  if (!snap) return;
  _modalSavedS = _swapToPlayer(playerId);
  renderSplitsTab(); renderStatsTab();
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
const BOOK_ABBREVS={
  'DraftKings':'DK',
  'BetMGM':'MGM',
  'Caesars':'CZR',
  'Bet365':'365',
  'Fanatics':'FAN',
};
function bookAbbrev(name){return BOOK_ABBREVS[name]||name;}

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

const ODDS_CACHE_KEY='corbetOddsCache';
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
function setThrows(v){S.pitcherThrows=v;document.getElementById('throws-R').classList.toggle('active',v==='R');document.getElementById('throws-L').classList.toggle('active',v==='L');}
function setHome(v){S.isHome=v;document.getElementById('loc-home').classList.toggle('active',v);document.getElementById('loc-away').classList.toggle('active',!v);}
function setDay(v){S.dayGame=v;document.getElementById('time-day').classList.toggle('active',v);document.getElementById('time-night').classList.toggle('active',!v);}
function setRoof(v){S.roofClosed=v;document.getElementById('roof-closed').classList.toggle('active',v);document.getElementById('roof-open').classList.toggle('active',!v);}
function onStadiumChange(){const sel=document.getElementById('stadium-select');const opt=sel.options[sel.selectedIndex];document.getElementById('roof-row').classList.toggle('hidden',opt.dataset.roof!=='1');}
function toggleManual(){S.pitcherManual=!S.pitcherManual;document.getElementById('pitcher-manual').classList.toggle('hidden',!S.pitcherManual);buildPitchMixManual();}
function toggleWeatherManual(){S.weatherManual=!S.weatherManual;document.getElementById('weather-manual').classList.toggle('hidden',!S.weatherManual);}

// ═══════════ PITCH MIX ════════════════════════════════════════════════════════
const PITCH_TYPES=['4-Seam FB','Sinker','Cutter','Slider','Curveball','Changeup','Splitter'];
function buildPitchMixGrid(cid,pitches){document.getElementById(cid).innerHTML=PITCH_TYPES.map(pt=>`<div class="pitch-mix-item"><span class="pitch-mix-label">${pt}</span><input type="range" min="0" max="60" value="${pitches[pt]||0}" oninput="S.pitcherPitches['${pt}']=parseInt(this.value);this.nextElementSibling.textContent=this.value+'%'" style="flex:1;accent-color:#A71930"><span style="font-size:11px;color:#ccc;font-family:\'Chakra Petch\',monospace;min-width:28px;text-align:right">${pitches[pt]||0}%</span></div>`).join('');}
function buildPitchMixManual(){buildPitchMixGrid('pitch-mix-grid-manual',S.pitcherPitches);}

// ═══════════ PLAYER LOADING ═══════════════════════════════════════════════════
async function loadPlayer(){
  const sel=document.getElementById('player-select');
  S.playerId=sel.value; S.playerName=sel.options[sel.selectedIndex].text.split(' · ')[0];
  show('player-spinner');hide('player-error');hide('splits-pills');
  document.getElementById('splits-card-header').textContent=`📈 ${S.playerName} · 2026 Splits`;
  document.getElementById('stats-card-header').textContent=`📊 ${S.playerName} · Advanced Stats 2026`;
  showSplitsLoading();showStatsLoading();
  try {
    const [a,b,c]=await Promise.all([
      fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=statSplits&group=hitting&season=2026&gameType=R&sitCodes=h,a,vl,vr,d,n`),
      fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=season&group=hitting&season=2026&gameType=R`),
      fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=statSplits&group=hitting&season=2026&gameType=R&sitCodes=risp`),
    ]);
    const sd=await a.json(),ss=await b.json(),rd=await c.json();
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
    const r=await fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=gameLog&group=hitting&season=2026&gameType=R`);
    const d=await r.json();
    const games=d?.stats?.[0]?.splits||[];
    S.recentGameLog=games.slice(-10).reverse(); // most recent first
  }catch(e){ S.recentGameLog=null; }
}

function buildPredictionSummary(factors){
  const el=document.getElementById('prediction-summary');
  if(!el)return;

  const lastName=S.playerName.split(' ').pop();
  const score=S.lastScore||50;
  const pn=S.pitcher?.name||document.getElementById('m-pitcher-name')?.value||'Unknown Pitcher';
  const pitcherLast=pn.split(' ').pop();
  const hand=S.pitcher?.hand||S.pitcherThrows;
  const era=S.pitcher?.st?.era?parseFloat(S.pitcher.st.era).toFixed(2):null;
  const xera=S.pitcherStatcast?.xera;
  const daysRest=S.pitcher?.daysRest;
  const lastPC=S.pitcher?.lastOuting?.numberOfPitches;
  const gender=S.playerName.toLowerCase().endsWith('a')?'her':'his'; // rough heuristic, fine for D-backs roster

  // Sort factors by absolute impact magnitude
  const sorted=[...factors].sort((a,b)=>Math.abs(b.adj||0)-Math.abs(a.adj||0));
  const drivers=sorted.filter(f=>f.impact==='positive').slice(0,4);
  const headwinds=sorted.filter(f=>f.impact==='negative').slice(0,4);

  // ── VERDICT ────────────────────────────────────────────────────────────
  let verdict='';
  if(score>=75)verdict=`The model sees a strong setup for ${lastName} today — multiple high-confidence signals are stacking up against ${pitcherLast}.`;
  else if(score>=62)verdict=`More factors lean in ${lastName}'s favor than against him today, with ${pitcherLast} presenting a realistic opportunity for production.`;
  else if(score>=50)verdict=`This is a coin-flip setup for ${lastName}. The model finds modest positives but meaningful resistance from ${pitcherLast}.`;
  else if(score>=38)verdict=`${lastName} is facing a tough setup — the factors lean toward a below-average day against ${pitcherLast}.`;
  else verdict=`Difficult day projected for ${lastName}. Multiple headwinds — including the pitcher profile and conditions — significantly suppress the model's outlook.`;

  // ── DRIVERS ─────────────────────────────────────────────────────────────
  const driversHTML=drivers.length?`
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#2ecc71;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Key Drivers</div>
      ${drivers.map(f=>`
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#2ecc71;font-weight:700;font-size:12px;font-family:\'Chakra Petch\',monospace;">${f.label}</span>
            <span style="color:#888;font-size:11px;margin-left:5px;">${f.value}</span>
          </div>
          <div style="color:#aaa;font-size:11px;text-align:right;">${f.note}</div>
        </div>`).join('')}
    </div>`:''

  // ── HEADWINDS ────────────────────────────────────────────────────────────
  const headwindsHTML=headwinds.length?`
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#e74c3c;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Key Headwinds</div>
      ${headwinds.map(f=>`
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#e74c3c;font-weight:700;font-size:12px;font-family:\'Chakra Petch\',monospace;">${f.label}</span>
            <span style="color:#888;font-size:11px;margin-left:5px;">${f.value}</span>
          </div>
          <div style="color:#aaa;font-size:11px;text-align:right;">${f.note}</div>
        </div>`).join('')}
    </div>`:''

  // ── PITCHER READ ─────────────────────────────────────────────────────────
  let pitcherLines=[];
  if(era){
    if(xera){
      const diff=parseFloat(era)-xera;
      if(diff>0.75)pitcherLines.push(`${pitcherLast}'s ERA (${era}) is inflated vs. xERA (${xera.toFixed(2)}) — likely pitching better than results show. Expect strong performance.`);
      else if(diff<-0.75)pitcherLines.push(`${pitcherLast}'s ERA (${era}) sits well below xERA (${xera.toFixed(2)}) — regression risk, has outperformed underlying metrics.`);
      else pitcherLines.push(`${pitcherLast}'s ERA (${era}) aligns with xERA (${xera.toFixed(2)}) — results match underlying performance.`);
    }else{
      pitcherLines.push(`${pitcherLast} carries a ${era} ERA on the season.`);
    }
  }
  const pWhiff=S.pitcherStatcast?.whiff;const pKPct=S.pitcherStatcast?.kPct;
  const pPutAway=S.pitcherStatcast?.putAway;const pGB=S.pitcherStatcast?.gbPct;
  if(pWhiff!=null&&pKPct!=null){
    if(pWhiff>=28&&pKPct>=26)pitcherLines.push(`Dominant swing-and-miss arsenal — ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K rate. Premium strikeout threat.`);
    else if(pWhiff>=24)pitcherLines.push(`Above-average movement: ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K%. Will generate weak contact.`);
    else if(pWhiff<=18)pitcherLines.push(`Below-average swing-and-miss (${pWhiff.toFixed(1)}% Whiff) — ${lastName} can expect to put the ball in play regularly.`);
    else pitcherLines.push(`Moderate arsenal: ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K%.`);
  }
  if(pPutAway!=null&&pPutAway>=32)pitcherLines.push(`Elite 2-strike put-away rate (${pPutAway.toFixed(1)}%) — difficult to battle back once behind in the count.`);
  if(pGB!=null&&pGB>=50)pitcherLines.push(`Pronounced ground ball tendency (${pGB.toFixed(1)}% GB) — power is suppressed, extra-base opportunities limited.`);
  if(daysRest!=='—'&&daysRest!=null){
    if(daysRest<4)pitcherLines.push(`⚠ On short rest (${daysRest} days) — command may waver, pitch count could be managed early.`);
    else if(daysRest>=6)pitcherLines.push(`Well-rested on ${daysRest} days — expect sharp command and a full arsenal.`);
  }
  if(lastPC&&lastPC>=100)pitcherLines.push(`Threw ${lastPC} pitches last outing — possible accumulated fatigue this start.`);

  const pitcherHTML=pitcherLines.length?`
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#a855f7;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Pitcher Read — ${pn} (${hand}HP)</div>
      ${pitcherLines.map(l=>`<div style="font-size:12px;color:#bbb;padding:5px 0;border-bottom:1px solid #0e0c22;line-height:1.5;">${l}</div>`).join('')}
    </div>`:''

  // ── CAREER MATCHUP ───────────────────────────────────────────────────────
  let matchupHTML='';
  const mu=S.matchupStats;
  if(!mu||mu.ab===0){
    matchupHTML=`
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Career vs. ${pitcherLast}</div>
        <div style="font-size:12px;color:#777;font-family:\'Chakra Petch\',monospace;">${lastName} has no recorded plate appearances vs. ${pitcherLast} — first-time matchup. Prediction relies on season-level and Statcast metrics.</div>
      </div>`;
  } else if(mu&&mu.ab>=3){
    const opsColor=mu.ops>=0.850?'#2ecc71':mu.ops<=0.620?'#e74c3c':'#f39c12';
    let muNarr='';
    if(mu.ab>=20){
      if(mu.ops>=0.950)muNarr=`${lastName} owns this matchup historically — consistently damages ${pitcherLast} in a substantial sample.`;
      else if(mu.ops>=0.800)muNarr=`Solid career track record vs. ${pitcherLast} — ${lastName} has handled this arm well over time.`;
      else if(mu.ops<=0.600)muNarr=`${pitcherLast} has historically dominated ${lastName} — clear historical edge for the pitcher.`;
      else if(mu.ops<=0.700)muNarr=`${lastName} has below-average career numbers vs. ${pitcherLast} — the pitcher holds a mild edge.`;
      else muNarr=`Career matchup is relatively neutral — neither player holds a clear historical edge.`;
    }else if(mu.ab>=10){
      muNarr=`Moderate sample (${mu.ab} AB): ${lastName} is batting ${mu.avg} with a ${mu.ops.toFixed(3)} OPS vs. ${pitcherLast}.`;
    }else{
      muNarr=`Small sample (${mu.ab} AB) — directional signal only. ${lastName} is ${mu.ops.toFixed(3)} OPS in limited career matchups.`;
    }
    if(mu.hr>=2)muNarr+=` Has gone deep ${mu.hr}× against ${pitcherLast}.`;
    if(mu.k&&mu.ab>=8){const kr=((mu.k/mu.ab)*100).toFixed(0);if(parseInt(kr)>=30)muNarr+=` High K rate (${kr}%) — ${pitcherLast} generates swing-and-miss from ${lastName} career-wide.`;}
    if(mu.bb&&mu.ab>=8){const bbr=((mu.bb/mu.ab)*100).toFixed(0);if(parseInt(bbr)>=15)muNarr+=` ${lastName} draws walks at a high rate vs. ${pitcherLast} (${bbr}% BB).`;}
    matchupHTML=`
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Career vs. ${pitcherLast} · ${mu.ab} AB</div>
        <div style="display:flex;gap:14px;margin-bottom:8px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:${opsColor};">${mu.ops.toFixed(3)}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">OPS</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${mu.avg}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:${(mu.hr||0)>0?'#A71930':'#ccc'};">${mu.hr||0}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${mu.k||0}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${mu.bb||0}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">BB</div></div>
        </div>
        <div style="font-size:12px;color:#bbb;line-height:1.5;">${muNarr}</div>
      </div>`;
  }

  // ── LAST 10 GAMES ────────────────────────────────────────────────────────
  let recentHTML='';
  if(S.recentGameLog?.length>0){
    const recent=S.recentGameLog.slice(0,10);const n=recent.length;
    const totalH=recent.reduce((s,g)=>s+(parseInt(g.stat.hits)||0),0);
    const totalAB=recent.reduce((s,g)=>s+(parseInt(g.stat.atBats)||0),0);
    const totalHR=recent.reduce((s,g)=>s+(parseInt(g.stat.homeRuns)||0),0);
    const totalRBI=recent.reduce((s,g)=>s+(parseInt(g.stat.rbi)||0),0);
    const totalBB=recent.reduce((s,g)=>s+(parseInt(g.stat.baseOnBalls)||0),0);
    const totalK=recent.reduce((s,g)=>s+(parseInt(g.stat.strikeOuts)||0),0);
    const multiHit=recent.filter(g=>(parseInt(g.stat.hits)||0)>=2).length;
    const hitless=recent.filter(g=>(parseInt(g.stat.hits)||0)===0).length;
    const avg10=totalAB>0?(totalH/totalAB).toFixed(3):'—';
    const last3H=recent.slice(0,3).reduce((s,g)=>s+(parseInt(g.stat.hits)||0),0);
    const last3AB=recent.slice(0,3).reduce((s,g)=>s+(parseInt(g.stat.atBats)||0),0);
    const last5H=recent.slice(0,5).reduce((s,g)=>s+(parseInt(g.stat.hits)||0),0);
    const last5AB=recent.slice(0,5).reduce((s,g)=>s+(parseInt(g.stat.atBats)||0),0);
    const avg3=last3AB>0?last3H/last3AB:0;
    const avg5=last5AB>0?last5H/last5AB:0;
    const avg10N=totalAB>0?totalH/totalAB:0;

    let formNarr='';
    if(avg3>=0.450)formNarr=`🔥 ${lastName} is scorching — batting ${avg3.toFixed(3)} over his last 3 games.`;
    else if(avg3>=0.350&&multiHit>=3)formNarr=`${lastName} is on a tear with ${multiHit} multi-hit games in his last ${n}.`;
    else if(avg3===0&&hitless>=3)formNarr=`❄️ ${lastName} is in a cold stretch — hitless in ${hitless} of his last ${n} games.`;
    else if(avg5>=0.360)formNarr=`${lastName} is trending up, batting ${avg5.toFixed(3)} over his last 5 games.`;
    else if(avg10N>=0.300)formNarr=`${lastName} has been productive over his last ${n}, batting ${avg10} with ${multiHit} multi-hit outings.`;
    else if(avg10N<=0.185)formNarr=`${lastName} has been in a slump over his last ${n} games, batting ${avg10} with ${hitless} hitless outings.`;
    else formNarr=`${lastName} has been average over his last ${n} — batting ${avg10} with ${multiHit} multi-hit games.`;
    if(totalHR>0)formNarr+=` ${totalHR} HR over this stretch.`;
    if(totalBB>=Math.ceil(n*0.5))formNarr+=` Drawing walks at a high clip (${totalBB} BB in ${n} G).`;
    if(totalK>=Math.ceil(n*1.3))formNarr+=` Elevated K rate this stretch (${totalK} K in ${n} G).`;

    const spark=recent.map(g=>{
      const h=parseInt(g.stat.hits)||0;const hr=parseInt(g.stat.homeRuns)||0;
      const rbi=parseInt(g.stat.rbi)||0;
      const bg=hr>0?'#1e3a5f':h>=3?'#14532d':h>=2?'#1a3a1a':h===1?'#3a2800':'#18171f';
      const fg=hr>0?'#60a5fa':h>=3?'#4ade80':h>=2?'#86efac':h===1?'#fbbf24':'#555';
      const lbl=hr>0?`${h}/${hr}HR`:h>0?`${h}H`:'0';
      const dateShort=g.date?g.date.slice(5):'';
      return`<div title="${g.date||''}: ${h}H ${hr}HR ${rbi}RBI" style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;background:${bg};border-radius:4px;padding:4px 2px;">
        <div style="font-size:10px;font-weight:700;font-family:\'Chakra Petch\',monospace;color:${fg};white-space:nowrap;">${lbl}</div>
        <div style="font-size:8px;color:#555;font-family:\'Chakra Petch\',monospace;white-space:nowrap;">${dateShort}</div>
      </div>`;
    }).join('');

    recentHTML=`
      <div style="margin-bottom:4px;">
        <div style="font-size:10px;color:#38bdf8;letter-spacing:1.5px;text-transform:uppercase;font-family:\'Chakra Petch\',monospace;margin-bottom:8px;">Last ${n} Games</div>
        <div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${avg10}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${totalH}/${totalAB}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">H/AB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:${totalHR>0?'#60a5fa':'#ccc'};">${totalHR}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${totalRBI}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">RBI</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${totalBB}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">BB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${totalK}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${multiHit}</div><div style="font-size:9px;color:#666;font-family:\'Chakra Petch\',monospace;margin-top:2px;">2H+</div></div>
        </div>
        <div style="display:flex;gap:3px;margin-bottom:10px;">${spark}</div>
        <div style="font-size:12px;color:#bbb;line-height:1.5;">${formNarr}</div>
      </div>`;
  }

  el.innerHTML=`
    <div>
      <div style="font-size:13px;color:#ddd;line-height:1.7;font-family:Georgia,serif;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #1a1730;">${verdict}</div>
      ${driversHTML}
      ${headwindsHTML}
      ${pitcherHTML}
      ${matchupHTML}
      ${recentHTML}
    </div>`;
}

// ═══════════ PITCHER SEARCH ════════════════════════════════════════════════════
let pitcherTimer=null;
async function onPitcherSearch(val){
  clearTimeout(pitcherTimer);
  if(val.length<2){hide('pitcher-search-results');return;}
  pitcherTimer=setTimeout(async()=>{
    try{
      const r=await fetch(`/mlb/api/v1/people/search?names=${encodeURIComponent(val)}&sportId=1&active=true`);
      const d=await r.json();
      const pitchers=(d.people||[]).filter(p=>p.primaryPosition?.type==='Pitcher').slice(0,8);
      if(!pitchers.length){hide('pitcher-search-results');return;}
      document.getElementById('pitcher-search-results').innerHTML=pitchers.map(p=>`<div class="search-result-item" onclick="selectPitcher(${p.id},'${p.fullName.replace(/'/g,"\\'")}')"><span>${p.fullName}</span><span class="sr-pos">${p.pitchHand?.code||'?'}HP</span></div>`).join('');
      show('pitcher-search-results');
    }catch(e){console.warn('Pitcher search failed:',e.message);hide('pitcher-search-results');}
  },300);
}

async function selectPitcher(id,name){
  hide('pitcher-search-results');
  document.getElementById('pitcher-search').value=name;
  hide('pitcher-loaded');hide('pitcher-pitch-mix');
  show('pitcher-spinner');hide('pitcher-error');
  try{
    const [sr,gr,pr]=await Promise.all([
      fetch(`/mlb/api/v1/people/${id}/stats?stats=season&group=pitching&season=2026&gameType=R`),
      fetch(`/mlb/api/v1/people/${id}/stats?stats=gameLog&group=pitching&season=2026&gameType=R`),
      fetch(`/mlb/api/v1/people/${id}`),
    ]);
    const sd=await sr.json(),gd=await gr.json(),pd=await pr.json();
    const st=sd?.stats?.[0]?.splits?.[0]?.stat??{};
    const gameLogs=gd?.stats?.[0]?.splits??[];
    const last3=gameLogs.slice(-3).reverse();
    const person=pd?.people?.[0]??{};
    const hand=person.pitchHand?.code??'R';
    S.pitcherThrows=hand;setThrows(hand);
    let daysRest='—';
    if(gameLogs.length){const ld=new Date(gameLogs[gameLogs.length-1].date);daysRest=Math.round((new Date()-ld)/(1000*60*60*24));}
    const lastOuting=gameLogs.length?gameLogs[gameLogs.length-1].stat:null;
    // Bullpen / opener detection: flag if all of last 3 outings are under 45 pitches
    const bullpenGame=last3.length>=3&&last3.every(g=>(g.stat?.numberOfPitches||0)<45);
    const advanced=_computePitcherMetrics(st,null);
    S.pitcher={id,name,hand,st,last3,daysRest,lastOuting,bullpenGame,advanced};
    const era=parseFloat(st.era)||null;
    const whip=parseFloat(st.whip)||null;
    const ip=st.inningsPitched||'—';
    const pa=st.battersFaced||1;
    const kPct=st.strikeOuts?((st.strikeOuts/pa)*100).toFixed(1)+'%':'—';
    const bbPct=st.baseOnBalls?((st.baseOnBalls/pa)*100).toFixed(1)+'%':'—';
    const k9=st.strikeOuts&&st.inningsPitched?((st.strikeOuts/parseFloat(st.inningsPitched))*9).toFixed(1):'—';
    const fip=advanced.fip!=null?advanced.fip.toFixed(2):'—';
    const kbb=advanced.kbbPct!=null?advanced.kbbPct.toFixed(1)+'%':'—';
    const hr9=advanced.hr9!=null?advanced.hr9.toFixed(2):'—';
    document.getElementById('pitcher-hand-badge').textContent=`${hand}HP · ${name}`;
    document.getElementById('pitcher-loaded').innerHTML=`<div class="pitcher-loaded"><div class="pl-hand">Throws ${hand==='L'?'Left':'Right'}</div><div class="pl-name">${name}</div><div class="pl-stats"><span>ERA <strong>${era?era.toFixed(2):'—'}</strong></span><span>FIP <strong>${fip}</strong></span><span>WHIP <strong>${whip?whip.toFixed(2):'—'}</strong></span><span>K-BB% <strong>${kbb}</strong></span><span>HR/9 <strong>${hr9}</strong></span><span>K/9 <strong>${k9}</strong></span><span>Days Rest <strong>${daysRest}</strong></span>${lastOuting?`<span>Last PC <strong>${lastOuting.numberOfPitches||'—'}</strong></span>`:''}</div></div>`;
    show('pitcher-loaded');
    const mix=hand==='L'?{'4-Seam FB':35,'Sinker':5,'Cutter':10,'Slider':20,'Curveball':10,'Changeup':15,'Splitter':5}:{'4-Seam FB':35,'Sinker':10,'Cutter':8,'Slider':22,'Curveball':10,'Changeup':12,'Splitter':3};
    Object.assign(S.pitcherPitches,mix);
    buildPitchMixGrid('pitch-mix-grid',S.pitcherPitches);
    show('pitcher-pitch-mix');
    renderPitcherTab(st,last3,daysRest,lastOuting,hand,name,fip,k9,kPct,bbPct,era,whip,ip,kbb,hr9);
    loadPitcherStatcast(id);
    loadMatchupStats();
    // If bets were already loaded without pitcher data, re-run with the new pitcher
    if(S.players){
      // Pitcher changed after dashboard loaded — full re-run so scores use new pitcher data
      S.allPlayerBets=null;S.players=null;loadDashboard();
    }else{_renderPitcherCard();}
  }catch(e){setText('pitcher-error','⚠ Could not load pitcher stats.');show('pitcher-error');}
  finally{hide('pitcher-spinner');}
}

function renderPitcherTab(st,last3,daysRest,lastOuting,hand,name,fip,k9,kPct,bbPct,era,whip,ip,kbb,hr9){
  hide('pitcher-tab-empty');show('pitcher-tab-content');
  document.getElementById('pitcher-tab-header').textContent=`📋 ${name} · Pitcher Analysis`;
  const eraC=era<=3.50?'good':era>=5.00?'bad':'';
  const whipC=whip<=1.10?'good':whip>=1.40?'bad':'';
  const fipNum=parseFloat(fip);
  const fipC=!isNaN(fipNum)?(fipNum<3.50?'good':fipNum>4.50?'bad':''):'';
  _renderPitcherSeasonBoxes();
  document.getElementById('pt-pitchmix').innerHTML=PITCH_TYPES.map(pt=>{const p=S.pitcherPitches[pt]||0;if(!p)return'';return`<div class="pitch-row"><span class="pitch-label">${pt}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${p}%;background:${p>35?'#A71930':'#3a3560'}"></div></div><span class="pitch-pct">${p}%</span></div>`;}).join('');
  document.getElementById('pt-recent').innerHTML=last3.length?last3.map(g=>`<div style="padding:4px 0;border-bottom:1px solid #0e0c22;">${g.date} — ${g.stat.inningsPitched}IP, ${g.stat.hits}H, ${g.stat.earnedRuns}ER, ${g.stat.strikeOuts}K <span style="color:#999;margin-left:8px;">${g.stat.numberOfPitches||'—'} pitches</span></div>`).join(''):'<span style="color:#777;">No recent game log available.</span>';
  document.getElementById('pt-workload').innerHTML=`<div>Days since last outing: <strong style="color:#ccc;">${daysRest}</strong></div>${lastOuting?`<div>Last outing pitch count: <strong style="color:#ccc;">${lastOuting.numberOfPitches||'—'}</strong></div>`:''}${daysRest!=='—'&&daysRest<4?'<div style="color:#e74c3c;margin-top:4px;">⚠ Short rest — possible fatigue factor</div>':''}${daysRest!=='—'&&daysRest>=5?'<div style="color:#2ecc71;margin-top:4px;">✓ Well-rested</div>':''}`;
}

// Renders the season stat boxes (ERA, FIP, xFIP, SIERA, WHIP, K-BB%, HR/9, …).
// Called from renderPitcherTab on initial load and again from loadPitcherStatcast
// once xFIP/SIERA become computable. Pulls everything off S.pitcher.{st,advanced}.
function _renderPitcherSeasonBoxes(){
  const p=S.pitcher;
  if(!p?.st||!document.getElementById('pt-season'))return;
  const st=p.st;
  const pa=parseInt(st.battersFaced)||1;
  const era=parseFloat(st.era);
  const whip=parseFloat(st.whip);
  const ip=st.inningsPitched||'—';
  const kPct=st.strikeOuts?((st.strikeOuts/pa)*100).toFixed(1)+'%':'—';
  const bbPct=st.baseOnBalls?((st.baseOnBalls/pa)*100).toFixed(1)+'%':'—';
  const k9=st.strikeOuts&&st.inningsPitched?((st.strikeOuts/parseFloat(st.inningsPitched))*9).toFixed(1):'—';
  const fip=p.advanced?.fip!=null?p.advanced.fip.toFixed(2):'—';
  const kbb=p.advanced?.kbbPct!=null?p.advanced.kbbPct.toFixed(1)+'%':'—';
  const hr9=p.advanced?.hr9!=null?p.advanced.hr9.toFixed(2):'—';
  const eraC=era<=3.50?'good':era>=5.00?'bad':'';
  const whipC=whip<=1.10?'good':whip>=1.40?'bad':'';
  const fipNum=parseFloat(fip);
  const fipC=!isNaN(fipNum)?(fipNum<3.50?'good':fipNum>4.50?'bad':''):'';
  const xfipNum=p.advanced?.xfip;
  const xfipC=xfipNum!=null?(xfipNum<3.50?'good':xfipNum>4.50?'bad':''):'';
  const xfipDisplay=xfipNum!=null?xfipNum.toFixed(2):'—';
  const sieraNum=p.advanced?.siera;
  const sieraC=sieraNum!=null?(sieraNum<3.50?'good':sieraNum>4.50?'bad':''):'';
  const sieraDisplay=sieraNum!=null?sieraNum.toFixed(2):'—';
  const kbbNum=parseFloat(kbb);
  const kbbC=!isNaN(kbbNum)?(kbbNum>=15?'good':kbbNum<=8?'bad':''):'';
  const hr9Num=parseFloat(hr9);
  const hr9C=!isNaN(hr9Num)?(hr9Num<=0.9?'good':hr9Num>=1.5?'bad':''):'';
  document.getElementById('pt-season').innerHTML=[['ERA',era?parseFloat(era).toFixed(2):'—',eraC,'Earned run average',STAT_INFO.ERA],['FIP',fip,fipC,'Fielding independent (strips luck)',STAT_INFO.FIP],['xFIP',xfipDisplay,xfipC,'FIP w/ normalized HR/FB',STAT_INFO.XFIP],['SIERA',sieraDisplay,sieraC,'Skill-based ERA: K, BB, batted-ball mix',STAT_INFO.SIERA],['WHIP',whip?parseFloat(whip).toFixed(2):'—',whipC,'Walks + hits per IP',STAT_INFO.WHIP],['K-BB%',kbb,kbbC,'Skill gap — best K predictor',STAT_INFO.KBBPCT],['HR/9',hr9,hr9C,'Home runs allowed per 9 IP',STAT_INFO.HR9],['K%',kPct,parseFloat(kPct)>=25?'good':parseFloat(kPct)<=18?'bad':'','Strikeout rate',STAT_INFO.KPCT_P],['BB%',bbPct,parseFloat(bbPct)<=6?'good':parseFloat(bbPct)>=10?'bad':'','Walk rate',STAT_INFO.BBPCT_P],['IP',ip,'','Innings pitched',STAT_INFO.IP],['K/9',k9,'','Strikeouts per 9',STAT_INFO.K9],['GS',st.gamesStarted||'—','','Games started',STAT_INFO.GS]].map(([l,v,c,ctx,info])=>statBox(l,v,ctx,c,info)).join('');
}

async function loadPitcherStatcast(pitcherId){
  const el=document.getElementById('pt-statcast');
  if(!el)return;
  el.innerHTML='<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Loading pitcher Statcast...</div>';
  const pid=String(pitcherId);

  const safeRows=(text,label)=>{
    if(!text||text.trim().startsWith('<')){console.warn(`[PitcherStatcast] ${label} returned HTML or empty`);return[];}
    const rows=parseCSV(text);
    console.log(`[PitcherStatcast] ${label}: ${rows.length} rows, cols:`,rows[0]?Object.keys(rows[0]).join(', '):'none');
    return rows;
  };
  const findRow=(rows,label)=>{
    const row=rows.find(r=>String(r.player_id||'').trim()===pid);
    console.log(`[PitcherStatcast] ${label} match for pid ${pid}:`,row?'found':'not found');
    return row||null;
  };
  const col=(row,...keys)=>{if(!row)return null;for(const k of keys){const v=row[k];if(v!=null&&v!=='')return v;}return null;};
  const fmtPct=(v,digits=1)=>{const n=parseFloat(v);return isNaN(n)?'—':n.toFixed(digits)+'%';};
  const fmtVal=(v,digits=2)=>{const n=parseFloat(v);return isNaN(n)?'—':n.toFixed(digits);};

  try{
    const [scRes,expRes,cswRes,bbRes]=await Promise.allSettled([
      fetch('/savant/statcast?type=pitcher&year=2026').then(r=>r.text()),
      fetch('/savant/expected?type=pitcher&year=2026').then(r=>r.text()),
      fetch('/savant/csw?year=2026').then(r=>r.text()),
      fetch('/savant/batted-ball?type=pitcher&year=2026').then(r=>r.text()),
    ]);

    const scRows  = safeRows(scRes.status==='fulfilled'?scRes.value:'',  'statcast');
    const expRows = safeRows(expRes.status==='fulfilled'?expRes.value:'', 'expected');
    const cswRows = safeRows(cswRes.status==='fulfilled'?cswRes.value:'', 'arsenal');
    const bbRows  = safeRows(bbRes.status==='fulfilled'?bbRes.value:'',   'batted-ball');

    const scRow  = findRow(scRows,  'statcast');
    const expRow = findRow(expRows, 'expected');
    // Batted-ball leaderboard keys by `id` rather than `player_id`. Rates are
    // returned as decimals (0.45 = 45%) — multiply by 100 for display/usage.
    const bbRow = bbRows.find(r=>String(r.id||r.player_id||'').trim()===pid) || null;

    // Pitch-arsenal: one row per pitch type — weighted average across all pitches
    const arsenalRows=cswRows.filter(r=>String(r.player_id||'').trim()===pid);
    console.log('[PitcherStatcast] arsenal rows for pid:',arsenalRows.length);
    const weightedAvg=(field)=>{
      if(!arsenalRows.length)return null;
      let total=0,weighted=0;
      arsenalRows.forEach(r=>{
        const usage=parseFloat(r.pitch_usage||0)||0;
        const val=parseFloat(r[field]||0)||0;
        weighted+=val*usage; total+=usage;
      });
      return total>0?(weighted/total).toFixed(1):null;
    };
    const whiffRaw   = weightedAvg('whiff_percent');
    const kPctRaw    = weightedAvg('k_percent');
    const putAwayRaw = weightedAvg('put_away');

    // Statcast pitcher: Barrel%, HH%, Avg EV.
    // GB% and FB% come from the batted-ball leaderboard (true rates) — the `gb`
    // and `fbld` columns on the statcast endpoint are avg EV mph on those
    // batted-ball types, not rates.
    const gbDecimal   = bbRow ? parseFloat(bbRow.gb_rate) : NaN;
    const fbDecimal   = bbRow ? parseFloat(bbRow.fb_rate) : NaN;
    const gbRaw        = isFinite(gbDecimal) ? gbDecimal*100 : null;
    const fbRaw        = isFinite(fbDecimal) ? fbDecimal*100 : null;
    const brlRaw       = col(scRow,'brl_percent','brl_pa');
    const hhRaw        = col(scRow,'ev95percent','hard_hit_percent');
    const evRaw        = col(scRow,'avg_hit_speed','avg_exit_velocity');

    // Expected pitcher: xwOBA against, xERA
    const xwobaRaw     = col(expRow,'est_woba','xwoba');
    const xeraRaw      = col(expRow,'xera','xERA');

    const whiffPct     = fmtPct(whiffRaw);
    const kPct         = fmtPct(kPctRaw);
    const putAway      = fmtPct(putAwayRaw);
    const gbPct        = fmtPct(gbRaw);
    const fbPct        = fmtPct(fbRaw);
    const brlAgainst   = fmtPct(brlRaw);
    const hhAgainst    = fmtPct(hhRaw);
    const avgEVAgainst = evRaw?fmtVal(evRaw,1)+' mph':'—';
    const xwobaPct     = fmtVal(xwobaRaw,3);
    const xERAVal      = fmtVal(xeraRaw,2);

    // Color thresholds must match STAT_INFO entries below (otherwise the box
     // color contradicts what the tooltip says is good/avg/bad).
    const whiffC  = whiffPct!=='—'?(parseFloat(whiffPct)>=30?'good':parseFloat(whiffPct)<=20?'bad':''):'';
    const kC      = kPct!=='—'?(parseFloat(kPct)>=25?'good':parseFloat(kPct)<=18?'bad':''):'';
    const putAwayC= putAway!=='—'?(parseFloat(putAway)>=22?'good':parseFloat(putAway)<=15?'bad':''):'';
    const gbC     = gbPct!=='—'?(parseFloat(gbPct)>=50?'good':parseFloat(gbPct)<=38?'bad':''):'';
    const brlC    = brlAgainst!=='—'?(parseFloat(brlAgainst)<=4?'good':parseFloat(brlAgainst)>=10?'bad':''):'';
    const hhC     = hhAgainst!=='—'?(parseFloat(hhAgainst)<=35?'good':parseFloat(hhAgainst)>=45?'bad':''):'';
    const xeraC   = xERAVal!=='—'?(parseFloat(xERAVal)<=3.50?'good':parseFloat(xERAVal)>=5.00?'bad':''):'';

    S.pitcherStatcast={
      whiff:    parseFloat(whiffRaw)||null,
      kPct:     parseFloat(kPctRaw)||null,
      putAway:  parseFloat(putAwayRaw)||null,
      gbPct:    parseFloat(gbRaw)||null,
      fbPct:    parseFloat(fbRaw)||null,
      brlAgainst: parseFloat(brlRaw)||null,
      hhAgainst:  parseFloat(hhRaw)||null,
      xwoba:    parseFloat(xwobaRaw)||null,
      xera:     parseFloat(xeraRaw)||null,
    };

    // Recompute pitcher metrics now that FB% is available — gives us xFIP and SIERA
    if(S.pitcher?.st){
      S.pitcher.advanced=_computePitcherMetrics(S.pitcher.st,S.pitcherStatcast);
      _renderPitcherSeasonBoxes();
    }

    const boxes=[
      statBox('Whiff%',    whiffPct,     'Whiff rate per pitch',       whiffC,   STAT_INFO.WHIFF_P),
      statBox('K%',        kPct,         'Strikeout rate',             kC,       STAT_INFO.KPCT_P),
      statBox('Put Away%', putAway,      '2-strike put-away rate',     putAwayC, STAT_INFO.PUTAWAY),
      statBox('GB%',       gbPct,        'Ground ball rate',           gbC,      STAT_INFO.GB_P),
      statBox('FB%',       fbPct,        'Fly ball rate',              '',       STAT_INFO.FB_P),
      statBox('Barrel% vs',brlAgainst,   'Barrels allowed',            brlC,     STAT_INFO.BARREL_VS),
      statBox('HH% vs',   hhAgainst,    'Hard contact allowed',       hhC,      STAT_INFO.HH_VS),
      statBox('Avg EV vs',avgEVAgainst, 'Avg exit velo against',      '',       STAT_INFO.EV_VS),
      statBox('xwOBA vs', xwobaPct,     'Expected wOBA against',      '',       STAT_INFO.XWOBA_VS),
      statBox('xERA',     xERAVal,      'Expected ERA',               xeraC,    STAT_INFO.XERA),
    ].join('');

    if(!scRow&&!expRow&&arsenalRows.length===0){
      el.innerHTML='<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">No Statcast data found for this pitcher.</div>';
    }else{
      el.innerHTML=boxes;
    }
  }catch(e){
    console.error('[PitcherStatcast] Error:',e);
    el.innerHTML=`<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Pitcher Statcast unavailable.</div>`;
  }
}

// ═══════════ UMPIRE ════════════════════════════════════════════════════════════
const UMP_DB={
  'Doug Eddings':    {tendency:'pitcher',adj:-2,note:'Pitcher-friendly zone — calls extra strikes'},
  'CB Bucknor':      {tendency:'hitter', adj: 3,note:'Tight zone — more walks, hitter-friendly'},
  'Laz Diaz':        {tendency:'hitter', adj: 2,note:'Below-average called strike rate'},
  'Bill Miller':     {tendency:'pitcher',adj:-2,note:'Expanded zone — pitcher advantage'},
  'Angel Hernandez': {tendency:'neutral',adj: 0,note:'Inconsistent zone, high variance'},
  'Jeff Nelson':     {tendency:'pitcher',adj:-3,note:'Consistently expanded zone, pitcher-friendly CSW'},
  'Joe West':        {tendency:'pitcher',adj:-2,note:'Large strike zone, extra called strikes'},
  'Mark Wegner':     {tendency:'pitcher',adj:-1,note:'Slight pitcher lean, below-average walk rate'},
  'Alan Porter':     {tendency:'hitter', adj: 2,note:'Tight zone — above-average walk environment'},
  'Gabe Morales':    {tendency:'neutral',adj:-1,note:'Slightly expanded zone on the corners'},
  'Brian Gorman':    {tendency:'neutral',adj: 0,note:'Neutral, consistent zone'},
  'Jerry Meals':     {tendency:'hitter', adj: 2,note:'Tight zone, above-average walk totals'},
  'Alfonso Marquez': {tendency:'neutral',adj: 0,note:'Average zone consistency'},
  'Mike Winters':    {tendency:'pitcher',adj:-2,note:'Expanded zone, extra called strikes'},
  'Todd Tichenor':   {tendency:'neutral',adj: 0,note:'League-average called strike rate'},
  'Chris Guccione':  {tendency:'hitter', adj: 1,note:'Slightly tight zone, mild hitter lean'},
  'Dan Iassogna':    {tendency:'neutral',adj: 0,note:'Consistent, neutral zone'},
  'Larry Vanover':   {tendency:'hitter', adj: 2,note:'Tight strike zone — more ball calls'},
  'Sam Holbrook':    {tendency:'pitcher',adj:-1,note:'Slightly expanded zone'},
  'Adrian Johnson':  {tendency:'neutral',adj: 0,note:'Average zone, high strike call rate'},
  'Rob Drake':       {tendency:'pitcher',adj:-2,note:'Below-average walk rate — wide zone'},
  'Quinn Wolcott':   {tendency:'neutral',adj: 0,note:'No significant zone bias on record'},
  'Chad Fairchild':  {tendency:'hitter', adj: 2,note:'Below-average called strike rate, high walk environment'},
  'Marvin Hudson':   {tendency:'pitcher',adj:-1,note:'Slight zone expansion, pitcher lean'},
  'Ted Barrett':     {tendency:'neutral',adj: 0,note:'Neutral zone, league-average consistency'},
  'Stu Scheurwater': {tendency:'hitter', adj: 1,note:'Slightly tight zone on the edges'},
  'Jim Reynolds':    {tendency:'neutral',adj: 0,note:'Neutral zone, no significant lean'},
  'Lance Barrett':   {tendency:'neutral',adj: 0,note:'Average zone, consistent calls'},
  'Jansen Visconti': {tendency:'neutral',adj: 0,note:'No significant zone bias on record'},
  'Roberto Ortiz':   {tendency:'neutral',adj: 0,note:'Average zone, no meaningful tendency'},
  'Ryan Additon':    {tendency:'pitcher',adj:-1,note:'Slight zone expansion, below-average walk rate'},
};

async function loadUmpireAndWeather(){
  const dv=document.getElementById('game-date').value;
  if(!dv)return;
  await Promise.all([loadUmpire(dv),fetchWeather(),loadLineupContext(dv)]);
}

async function loadUmpire(dv){
  show('ump-spinner');hide('ump-content');setText('ump-empty','');
  try{
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&hydrate=officials&date=${dv}`);
    const d=await r.json();
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
    // Include season=2026 so new pitchers with no prior history still resolve correctly
    const r=await fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${S.pitcher.id}&gameType=R&season=2026`);
    const d=await r.json();
    let st=d?.stats?.[0]?.splits?.[0]?.stat;

    // If 2026-scoped query returns nothing, fall back to all-time total
    if(!st||parseInt(st?.atBats)===0){
      const r2=await fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${S.pitcher.id}&gameType=R`);
      const d2=await r2.json();
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
const VENUE_MAP={
  'Chase Field':'Chase Field (PHX)','Dodger Stadium':'Dodger Stadium (LAD)',
  'Coors Field':'Coors Field (COL)','Oracle Park':'Oracle Park (SF)',
  'Petco Park':'Petco Park (SD)','Wrigley Field':'Wrigley Field (CHC)',
  'Oriole Park at Camden Yards':'Camden Yards (BAL)','Busch Stadium':'Busch Stadium (STL)',
  'T-Mobile Park':'T-Mobile Park (SEA)','Fenway Park':'Fenway Park (BOS)',
  'Yankee Stadium':'Yankee Stadium (NYY)','Citi Field':'Citi Field (NYM)',
  'Great American Ball Park':'Great American (CIN)','PNC Park':'PNC Park (PIT)',
  'Globe Life Field':'Globe Life Field (TEX)',
  'Minute Maid Park':'Minute Maid Park (HOU)',
  'loanDepot park':'loanDepot Park (MIA)','loanDepot Park':'loanDepot Park (MIA)',
  'American Family Field':'American Family Field (MIL)',
  'Rogers Centre':'Rogers Centre (TOR)',
  'Tropicana Field':'Tropicana Field (TB)',
  'Truist Park':'Truist Park (ATL)',
  'Nationals Park':'Nationals Park (WSH)',
  'Citizens Bank Park':'Citizens Bank Park (PHI)',
  'Kauffman Stadium':'Kauffman Stadium (KC)',
  'Target Field':'Target Field (MIN)',
  'Angel Stadium':'Angel Stadium (LAA)',
  'Progressive Field':'Progressive Field (CLE)',
  'Comerica Park':'Comerica Park (DET)',
  'Guaranteed Rate Field':'Guaranteed Rate Field (CWS)',
  'Sutter Health Park':'Sutter Health Park (OAK)',
};

// ── Team momentum bar (dashboard top strip) ─────────────────────────────────
// Pulls D-backs standings: streak, last 10, run differential, NL West rank.
async function loadTeamMomentum(){
  const el=document.getElementById('dash-momentum-bar');
  if(!el)return;
  try{
    const r=await fetch(`/mlb/api/v1/standings?leagueId=104&season=2026&standingsTypes=regularSeason&hydrate=team`);
    const d=await r.json();
    let team=null;
    (d?.records||[]).forEach(div=>{
      (div.teamRecords||[]).forEach(tr=>{
        if(tr.team?.id===109)team=tr;
      });
    });
    if(!team){el.innerHTML='';return;}

    const w=team.wins, l=team.losses;
    const streakCode=team.streak?.streakCode||'—';
    const streakCls=streakCode.startsWith('W')?'streak-w':streakCode.startsWith('L')?'streak-l':'';
    const last10=(team.records?.splitRecords||[]).find(s=>s.type==='lastTen');
    const last10Str=last10?`${last10.wins}-${last10.losses}`:'—';
    const rs=team.runsScored??0;
    const ra=team.runsAllowed??0;
    const diff=rs-ra;
    const diffStr=`${diff>=0?'+':''}${diff}`;
    const diffCls=diff>0?'diff-pos':diff<0?'diff-neg':'';
    const rank=team.divisionRank||'—';
    const gb=team.gamesBack==='-'?'—':team.gamesBack;

    el.innerHTML=`<div class="momentum-bar">
      <div class="momentum-cell">
        <span class="momentum-label">Record</span>
        <span class="momentum-val">${w}-${l}</span>
      </div>
      <div class="momentum-divider"></div>
      <div class="momentum-cell">
        <span class="momentum-label">Streak</span>
        <span class="momentum-val ${streakCls}">${streakCode}</span>
      </div>
      <div class="momentum-divider"></div>
      <div class="momentum-cell">
        <span class="momentum-label">Last 10</span>
        <span class="momentum-val">${last10Str}</span>
      </div>
      <div class="momentum-divider"></div>
      <div class="momentum-cell">
        <span class="momentum-label">Run Diff</span>
        <span class="momentum-val ${diffCls}">${diffStr}</span>
      </div>
      <div class="momentum-divider"></div>
      <div class="momentum-cell">
        <span class="momentum-label">NL West</span>
        <span class="momentum-val">#${rank} · GB ${gb}</span>
      </div>
    </div>`;
  }catch(e){
    el.innerHTML='';
  }
}

// ── Pitcher form (last 3 starts) ────────────────────────────────────────────
// Called from _renderPitcherCard when S.pitcher.id is set. Renders below the
// existing pitcher meta line.
async function loadPitcherForm(pitcherId){
  if(!pitcherId)return null;
  try{
    const r=await fetch(`/mlb/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching&hydrate=team`);
    const d=await r.json();
    const splits=d?.stats?.[0]?.splits||[];
    // Most recent 3, reverse-chronological
    const last3=splits.slice(-3).reverse();
    return last3.map(s=>{
      const stat=s.stat||{};
      const ip=parseFloat(stat.inningsPitched||0);
      const er=parseInt(stat.earnedRuns||0,10);
      const k=parseInt(stat.strikeOuts||0,10);
      const bb=parseInt(stat.baseOnBalls||0,10);
      // Quality indicator: ER<=2 + IP>=5 = good; ER>=5 OR IP<3 = bad; else mixed
      let cls='pf-mixed';
      if(er<=2&&ip>=5)cls='pf-good';
      else if(er>=5||ip<3)cls='pf-bad';
      const date=s.date?new Date(s.date+'T00:00:00').toLocaleDateString('en-US',{month:'numeric',day:'numeric'}):'';
      const oppAbbr=s.opponent?.abbreviation||s.opponent?.teamCode?.toUpperCase()||'';
      const isHome=s.isHome===true||s.isHome==='true';
      const oppLabel=oppAbbr?(isHome?'vs '+oppAbbr:'@ '+oppAbbr):'';
      return{date,ip,er,k,bb,cls,opp:oppLabel};
    });
  }catch(e){
    return null;
  }
}

// Pull pitcher Home/Away and L/R splits in one call
async function loadPitcherSplits(pitcherId){
  if(!pitcherId)return null;
  try{
    const r=await fetch(`/mlb/api/v1/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=2026&gameType=R&sitCodes=h,a,vl,vr`);
    const d=await r.json();
    const splits=d?.stats?.[0]?.splits||[];
    const out={};
    splits.forEach(s=>{
      const code=s.split?.code;
      if(!code)return;
      out[code]={
        era:s.stat?.era?parseFloat(s.stat.era):null,
        avg:s.stat?.avg||null,
        obp:s.stat?.obp||null,
        slg:s.stat?.slg||null,
        ops:s.stat?.ops?parseFloat(s.stat.ops):null,
      };
    });
    return out;
  }catch(e){
    return null;
  }
}

function _renderPitcherForm(starts){
  if(!starts||!starts.length)return'';
  return`<div class="dash-pitcher-form">${starts.map(s=>
    `<div class="pf-row ${s.cls}">
      <span class="pf-row-date">${s.date}</span>
      <span class="pf-row-opp">${s.opp}</span>
      <span class="pf-row-stats">${s.ip} IP &middot; ${s.er} ER &middot; ${s.k} K &middot; ${s.bb} BB</span>
    </div>`
  ).join('')}</div>`;
}

function _renderPitcherSplits(splits,isHomeGame){
  if(!splits)return'';
  const sieraVal=S.pitcher?.advanced?.siera;
  const xfipVal=S.pitcher?.advanced?.xfip;
  const advChip=sieraVal!=null
    ?`<span class="ps-adv">SIERA <b>${sieraVal.toFixed(2)}</b></span>`
    :(xfipVal!=null?`<span class="ps-adv">xFIP <b>${xfipVal.toFixed(2)}</b></span>`:'');
  const homeEra=splits.h?.era;
  const awayEra=splits.a?.era;
  const homeCls=isHomeGame?'ps-active':'';
  const awayCls=!isHomeGame?'ps-active':'';
  const homeStr=homeEra!=null?`Home <b>${homeEra.toFixed(2)}</b>`:'Home <b>—</b>';
  const awayStr=awayEra!=null?`Away <b>${awayEra.toFixed(2)}</b>`:'Away <b>—</b>';
  const vL=splits.vl;
  const vR=splits.vr;
  const vLStr=vL?`vs L <b>${vL.avg||'—'}</b>/${vL.obp||'—'}/${vL.slg||'—'}`:'vs L <b>—</b>';
  const vRStr=vR?`vs R <b>${vR.avg||'—'}</b>/${vR.obp||'—'}/${vR.slg||'—'}`:'vs R <b>—</b>';
  return`<div class="dash-pitcher-splits">
    <div class="ps-row">
      ${advChip}
      <span class="ps-divider"></span>
      <span class="ps-split ${homeCls}">${homeStr}</span>
      <span class="ps-split ${awayCls}">${awayStr}</span>
    </div>
    <div class="ps-row">
      <span class="ps-split">${vLStr}</span>
      <span class="ps-split">${vRStr}</span>
    </div>
  </div>`;
}

// ── Best Matchup card (inside pitcher card) ─────────────────────────────────
// Picks the D-backs hitter with the strongest combined edge against tonight's
// pitcher: 70% vs-handedness OPS this season + 30% career line vs this exact
// pitcher (when sample ≥ 5 AB, otherwise hand-split fully).
function _renderBestMatchup(){
  const el=document.getElementById('dash-best-matchup-slot');
  if(!el)return;
  if(!S.pitcher||!S.players){el.innerHTML='';return;}
  const hand=S.pitcher.hand||'R';
  const candidates=activeRoster()
    .map(p=>{
      const snap=S.players?.[p.id];
      if(!snap||snap.lowData)return null;
      const handSplit=hand==='L'?snap.splits?.vl:snap.splits?.vr;
      const handOps=handSplit?.ops?(typeof handSplit.ops==='number'?handSplit.ops:parseFloat(handSplit.ops)):null;
      const mu=snap.matchupStats;
      const muOps=mu?.ops||null;
      const muAb=mu?.ab||0;
      // Combined matchup score: 70% vs-hand, 30% vs-pitcher (or full hand weight if no sample)
      let mScore=null;
      if(handOps!=null){
        if(muOps!=null&&muAb>=5){
          mScore=handOps*0.7+muOps*0.3;
        }else{
          mScore=handOps;
        }
      }
      return{player:p,snap,handSplit,handOps,mu,muAb,mScore};
    })
    .filter(c=>c&&c.mScore!=null)
    .sort((a,b)=>b.mScore-a.mScore);

  if(!candidates.length){
    el.innerHTML=`<div class="bm-empty">Loading matchup…</div>`;
    return;
  }
  const top=candidates[0];
  const score=top.snap?.score!=null?Math.round(top.snap.score):null;
  const scoreColor=top.snap?.tier?.color||'#aaa';
  const oppHand=hand;
  const handLine=top.handSplit
    ?`<span class="bm-stat-lbl">vs ${oppHand}HP</span> <b>${top.handSplit.avg||'—'}</b>/${top.handSplit.obp||'—'}/${top.handSplit.slg||'—'}`
    :`<span class="bm-stat-lbl">vs ${oppHand}HP</span> <b>—</b>`;
  // Career vs this pitcher (only if sample is meaningful)
  let careerLine='';
  if(top.mu&&top.muAb>=3){
    const sample=`${top.mu.h}-for-${top.muAb}`;
    const extras=[];
    if(top.mu.hr)extras.push(`${top.mu.hr} HR`);
    if(top.mu.bb)extras.push(`${top.mu.bb} BB`);
    if(top.mu.k)extras.push(`${top.mu.k} K`);
    careerLine=`<div class="bm-line bm-career"><span class="bm-stat-lbl">Career vs ${S.pitcher.name.split(' ').pop()}</span> <b>${sample}</b>${extras.length?' · '+extras.join(', '):''}</div>`;
  }
  // Last 7 games recent form (most-recent-first array)
  let recentLine='';
  const log=top.snap?.recentGameLog||[];
  if(log.length){
    const last7=log.slice(0,7);
    let h=0,ab=0,hr=0,bb=0,k=0;
    last7.forEach(g=>{
      h+=parseInt(g.stat?.hits||0);
      ab+=parseInt(g.stat?.atBats||0);
      hr+=parseInt(g.stat?.homeRuns||0);
      bb+=parseInt(g.stat?.baseOnBalls||0);
      k+=parseInt(g.stat?.strikeOuts||0);
    });
    if(ab>0){
      const avg=(h/ab).toFixed(3).replace(/^0\./,'.');
      const extras=[];
      if(hr)extras.push(`${hr} HR`);
      if(bb)extras.push(`${bb} BB`);
      if(k)extras.push(`${k} K`);
      recentLine=`<div class="bm-line"><span class="bm-stat-lbl">Last ${last7.length}G</span> <b>${h}-for-${ab}</b> (${avg})${extras.length?' · '+extras.join(', '):''}</div>`;
    }
  }
  // Top bet for this player (if odds loaded)
  let betLine='';
  const pgBets=(S.allPlayerBets||[]).find(pg=>pg.playerName===top.player.name);
  const bestBet=pgBets?.bets
    ?.filter(b=>!b.insufficient&&b.edgeStrength!=='none')
    ?.sort((a,b)=>(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100))?.[0];
  if(bestBet){
    const evStr=bestBet.ev!=null?`${bestBet.ev>=0?'+':''}${(bestBet.ev*100).toFixed(1)}%`:'—';
    const evCls=bestBet.ev!=null?(bestBet.ev>=0?'pos':'neg'):'pos';
    betLine=`<div class="bm-bet">
      <div class="bm-bet-prop">${bestBet.direction.toUpperCase()} ${bestBet.line} ${bestBet.prop}</div>
      <div class="bm-bet-stat ${evCls}">EV ${evStr}</div>
    </div>`;
  }

  // Build a one-line summary explaining the pick
  const summary=_buildMatchupSummary(top,oppHand);

  el.innerHTML=`<div class="bm-card">
    <div class="bm-header">
      <span class="bm-tag">★ Best Matchup</span>
    </div>
    <div class="bm-name-row">
      <div class="bm-name">${top.player.name}</div>
      ${score!=null?`<div class="bm-score-circle" style="border-color:${scoreColor}"><span class="bm-score-num" style="color:${scoreColor}">${score}</span></div>`:''}
    </div>
    <div class="bm-line">${handLine}</div>
    ${recentLine}
    ${careerLine}
    ${betLine}
    ${summary?`<div class="bm-summary">${summary}</div>`:''}
  </div>`;
}

// Generate a short italic reason explaining why this player is the best matchup pick.
function _buildMatchupSummary(top,oppHand){
  const reasons=[];
  // Strong vs-handedness
  const handOps=top.handOps;
  if(handOps!=null){
    if(handOps>=0.900)reasons.push(`elite vs ${oppHand}HP`);
    else if(handOps>=0.800)reasons.push(`strong vs ${oppHand}HP`);
    else if(handOps>=0.750)reasons.push(`above-average vs ${oppHand}HP`);
  }
  // Hot recent form (compute from recent log if present)
  const log=top.snap?.recentGameLog||[];
  if(log.length){
    const last7=log.slice(0,7);
    let h=0,ab=0;
    last7.forEach(g=>{h+=parseInt(g.stat?.hits||0);ab+=parseInt(g.stat?.atBats||0);});
    if(ab>=10){
      const avg=h/ab;
      if(avg>=0.350)reasons.push('hot streak');
      else if(avg<=0.150)reasons.push('cold of late');
    }
  }
  // Career edge vs this pitcher
  if(top.mu&&top.muAb>=5){
    if(top.mu.hr&&top.mu.hr>=1)reasons.push(`HR history off ${S.pitcher.name.split(' ').pop()}`);
    else if(top.muOps&&top.muOps>=0.800)reasons.push(`hits ${S.pitcher.name.split(' ').pop()} well`);
  }
  if(!reasons.length)return'';
  // Capitalize first reason
  reasons[0]=reasons[0].charAt(0).toUpperCase()+reasons[0].slice(1);
  return reasons.join(' · ');
}

// ── (LEGACY) Projected MVP banner — replaced by Best Matchup card above ─────
// Kept around in case we want to re-enable it. Currently not called.
function _renderMvpBanner(){
  const el=document.getElementById('dash-mvp-banner');
  if(!el)return;

  // Primary path: pick player whose top bet has the highest EV
  const candidates=[];
  (S.allPlayerBets||[]).forEach(pg=>{
    if(pg.lowData)return;
    const bestBet=pg.bets
      .filter(b=>!b.insufficient&&b.edgeStrength!=='none'&&b.mcConfidence>=80)
      .sort((a,b)=>(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100))[0];
    if(!bestBet)return;
    candidates.push({playerName:pg.playerName,bet:bestBet});
  });

  // Fallback: when odds aren't loaded yet, pick the player with the highest prediction score
  if(!candidates.length){
    const topPlayer=activeRoster()
      .map(p=>({player:p,snap:S.players?.[p.id]}))
      .filter(x=>x.snap&&x.snap.score!=null&&!x.snap.lowData)
      .sort((a,b)=>(b.snap.score||0)-(a.snap.score||0))[0];
    if(!topPlayer){el.innerHTML='';return;}
    _renderMvpBannerNoBet(topPlayer.player.name,topPlayer.snap);
    return;
  }

  // Sort: highest EV (or delta proxy) wins
  candidates.sort((a,b)=>(b.bet.ev??b.bet.absDelta/100)-(a.bet.ev??a.bet.absDelta/100));
  const mvp=candidates[0];
  const player=activeRoster().find(p=>p.name===mvp.playerName);
  const snap=player?S.players?.[player.id]:null;
  const bet=mvp.bet;

  // Build strength chips
  const chips=_buildMvpChips(snap,bet);

  // Build reasoning summary
  const summary=_buildMvpSummary(mvp.playerName,snap,bet);

  // Bet display
  const evStr=bet.ev!=null?`${bet.ev>=0?'+':''}${(bet.ev*100).toFixed(1)}%`:'—';
  const deltaStr=`${bet.delta>=0?'+':''}${bet.delta.toFixed(1)}pp`;
  const evCls=bet.ev!=null?(bet.ev>=0?'pos':'neg'):(bet.delta>=0?'pos':'neg');
  const score=snap?.score!=null?Math.round(snap.score):null;
  const scoreColor=snap?.tier?.color||'#aaa';

  el.innerHTML=`<div class="mvp-banner">
    <div class="mvp-header">
      <span class="mvp-tag">★ Projected MVP</span>
      <span class="mvp-name">${mvp.playerName}</span>
      ${score!=null?`<div class="mvp-score-circle" style="border-color:${scoreColor}"><span class="mvp-score-num" style="color:${scoreColor}">${score}</span></div>`:''}
    </div>
    ${chips.length?`<div class="mvp-strengths">${chips.map(c=>`<span class="mvp-chip">${c}</span>`).join('')}</div>`:''}
    <div class="mvp-summary">${summary}</div>
    <div class="mvp-bet-row">
      <div>
        <div class="mvp-bet-label">Top Pick</div>
        <div class="mvp-bet-prop">${bet.direction.toUpperCase()} ${bet.line} ${bet.prop}</div>
      </div>
      <div class="mvp-bet-stat">
        <div><div class="lbl">EV</div><div class="val ${evCls}">${evStr}</div></div>
        <div><div class="lbl">Δ</div><div class="val ${bet.delta>=0?'pos':'neg'}">${deltaStr}</div></div>
        <div><div class="lbl" title="Edge stability % — not win probability">STAB</div><div class="val">${bet.mcConfidence?.toFixed(0)||'—'}%</div></div>
      </div>
    </div>
  </div>`;
}

// MVP banner fallback when odds aren't loaded — show the top-PS player without bet info
function _renderMvpBannerNoBet(name,snap){
  const el=document.getElementById('dash-mvp-banner');
  if(!el)return;
  const chips=_buildMvpChips(snap,null);
  const summary=_buildMvpSummary(name,snap,null);
  const score=snap?.score!=null?Math.round(snap.score):null;
  const scoreColor=snap?.tier?.color||'#aaa';
  el.innerHTML=`<div class="mvp-banner">
    <div class="mvp-header">
      <span class="mvp-tag">★ Projected MVP</span>
      <span class="mvp-name">${name}</span>
      ${score!=null?`<div class="mvp-score-circle" style="border-color:${scoreColor}"><span class="mvp-score-num" style="color:${scoreColor}">${score}</span></div>`:''}
    </div>
    ${chips.length?`<div class="mvp-strengths">${chips.map(c=>`<span class="mvp-chip">${c}</span>`).join('')}</div>`:''}
    <div class="mvp-summary">${summary}</div>
    <div class="mvp-bet-row" style="opacity:0.7;">
      <div>
        <div class="mvp-bet-label">Top Pick</div>
        <div class="mvp-bet-prop" style="color:#888;">Awaiting odds…</div>
      </div>
    </div>
  </div>`;
}

function _buildMvpChips(snap,bet){
  const chips=[];
  if(snap?.order)chips.push(`Batting ${_ordinal(snap.order)}`);
  if(snap?.st?.avg)chips.push(`AVG ${parseFloat(snap.st.avg).toFixed(3)}`);
  if(snap?.st?.ops)chips.push(`OPS ${parseFloat(snap.st.ops).toFixed(3)}`);
  if(bet){
    if(bet.edgeStrength==='strong')chips.push('Strong Edge');
    else if(bet.edgeStrength==='moderate')chips.push('Moderate Edge');
    if(bet.mcConfidence>=90)chips.push(`Stab ${bet.mcConfidence.toFixed(0)}%`);
  }
  return chips.slice(0,5);
}

function _buildMvpSummary(name,snap,bet){
  const reasons=[];
  // Park context
  const venue=document.getElementById('stadium-select')?.value||'';
  if(/Coors/i.test(venue))reasons.push('massive Coors Field boost');
  else if(/Great American/i.test(venue))reasons.push('hitter-friendly Great American Ball Park');
  else if(/Fenway/i.test(venue))reasons.push('Fenway Park dimensions favor contact hitters');
  // Pitcher hand
  if(S.pitcher?.hand){
    const hand=S.pitcher.hand;
    reasons.push(`facing ${hand}HP ${S.pitcher.name}`);
  }
  // Bullpen game
  if(S.pitcher?.bullpenGame)reasons.push('bullpen day means weaker pitching matchups');
  // Weather
  if(S.weather?.windMph>=12){
    const dir=S.weather.windDir||'';
    reasons.push(`${S.weather.windMph} mph ${dir} wind`);
  }
  if(S.weather?.tempF>=85)reasons.push(`hot ${S.weather.tempF}°F air carries the ball`);
  // Pitcher ERA if elevated
  if(S.pitcher?.st?.era&&parseFloat(S.pitcher.st.era)>=4.5){
    reasons.push(`opposing pitcher's ${parseFloat(S.pitcher.st.era).toFixed(2)} ERA`);
  }
  // Bet quality
  if(bet){
    const propPretty=`${bet.direction} ${bet.line} ${bet.prop}`;
    const evPart=bet.ev!=null?`${bet.ev>=0?'+':''}${(bet.ev*100).toFixed(1)}% EV`:`${bet.delta.toFixed(1)}pp delta`;
    if(reasons.length){
      return`${name} headlines today's slate behind ${reasons.slice(0,3).join(', ')}. The model flags ${propPretty} as the highest-edge bet on the board (${evPart}).`;
    }
    return`${name} grades out as the top projected performer based on season form and matchup. Highest-edge bet: ${propPretty} (${evPart}).`;
  }
  // No-bet fallback summary
  if(reasons.length){
    return`${name} projects as the top performer today behind ${reasons.slice(0,3).join(', ')}. Specific prop edges will appear once odds load.`;
  }
  return`${name} grades out as the top projected performer based on season form and matchup.`;
}

function _ordinal(n){
  const s=['th','st','nd','rd'],v=n%100;
  return n+(s[(v-20)%10]||s[v]||s[0]);
}

// ── Two-week schedule (dashboard strip) ─────────────────────────────────────
// Renders a 14-day grid (today + 13 forward) of D-backs games.
// Off days are shown as muted cells. Final games get scores. Live games get a "LIVE" tag.
async function loadTwoWeekSchedule(){
  const el=document.getElementById('dash-schedule');
  if(!el)return;
  try{
    // Arizona-local "today" so late-evening games show on the right day
    const azNow=new Date(Date.now()-7*60*60*1000);
    const todayD=new Date(azNow); todayD.setUTCHours(0,0,0,0);
    // Anchor the strip to the most recent Sunday so rows are always Sun→Sat.
    // When today rolls into Sunday, the old top week falls off and a new bottom week appears.
    const dow=todayD.getUTCDay(); // 0=Sun … 6=Sat
    const startD=new Date(todayD); startD.setUTCDate(startD.getUTCDate()-dow);
    const endD=new Date(startD.getTime()+13*24*60*60*1000);
    const start=startD.toISOString().split('T')[0];
    const end=endD.toISOString().split('T')[0];
    const todayKey=todayD.toISOString().split('T')[0];
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&hydrate=probablePitcher,team&startDate=${start}&endDate=${end}`);
    const d=await r.json();

    // Index games by their officialDate so we can fall through to OFF DAY for missing days
    const byDate={};
    (d?.dates||[]).forEach(dt=>{
      (dt.games||[]).forEach(g=>{
        const k=g.officialDate||dt.date;
        if(!byDate[k])byDate[k]=[];
        byDate[k].push(g);
      });
    });

    const cells=[];
    for(let i=0;i<14;i++){
      const d2=new Date(startD.getTime()+i*24*60*60*1000);
      const dk=d2.toISOString().split('T')[0];
      const dayLabel=d2.toLocaleDateString('en-US',{weekday:'short',timeZone:'UTC'}).toUpperCase();
      // Compact M/D so "THU 5/14" fits on one line in a narrow cell
      const dateLabel=`${d2.getUTCMonth()+1}/${d2.getUTCDate()}`;
      const games=byDate[dk]||[];
      const isToday=dk===todayKey;
      cells.push(_renderScheduleCell({dayLabel,dateLabel,games,isToday}));
    }

    // Two rows of 7
    el.innerHTML=`
      <div class="sched-grid">${cells.slice(0,7).join('')}</div>
      <div class="sched-grid">${cells.slice(7,14).join('')}</div>`;
  }catch(e){
    el.innerHTML=`<div class="dash-empty">Schedule unavailable: ${e.message}</div>`;
  }
}

function _renderScheduleCell({dayLabel,dateLabel,games,isToday}){
  const todayCls=isToday?' sched-today':'';
  if(!games.length){
    return`<div class="sched-cell sched-off${todayCls}">
      <div class="sched-day"><span class="sched-dow">${dayLabel}</span> <span class="sched-date">${dateLabel}</span></div>
      <div class="sched-off-label">OFF DAY</div>
    </div>`;
  }
  // If a doubleheader, show the first game and a "+1" hint
  const game=games[0];
  const extra=games.length>1?` <span style="color:#777">+${games.length-1}</span>`:'';
  const isHome=game.teams?.home?.team?.id===109;
  const opp=isHome?game.teams?.away?.team:game.teams?.home?.team;
  const oppAbbr=opp?.abbreviation||opp?.teamCode?.toUpperCase()||'???';
  const venue=game.venue?.name||'';
  const state=game.status?.abstractGameState||'Preview';

  // Time in MST (Arizona is UTC-7, no DST)
  let timeStr='TBD';
  if(!game.status?.startTimeTBD&&game.gameDate){
    const utc=new Date(game.gameDate);
    const h=(utc.getUTCHours()-7+24)%24;
    const m=utc.getUTCMinutes().toString().padStart(2,'0');
    const ampm=h>=12?'p':'a';
    const h12=h%12===0?12:h%12;
    timeStr=`${h12}:${m}${ampm}`;
  }

  // Probable pitcher (the opposing pitcher when home, ours when away — show opposing for context)
  const oppSide=isHome?game.teams?.away:game.teams?.home;
  const pp=oppSide?.probablePitcher;
  const ppName=pp?.fullName||null;
  const ppLast=ppName?ppName.split(' ').slice(-1)[0]:null;

  // Final games: show W/L score
  if(state==='Final'){
    const ourSide=isHome?game.teams?.home:game.teams?.away;
    const oppGameSide=isHome?game.teams?.away:game.teams?.home;
    const our=ourSide?.score??0;
    const their=oppGameSide?.score??0;
    const win=our>their;
    return`<div class="sched-cell sched-final${todayCls}">
      <div class="sched-day"><span class="sched-dow">${dayLabel}</span> <span class="sched-date">${dateLabel}</span></div>
      <div class="sched-opp">${isHome?'vs':'@'} ${oppAbbr}${extra}</div>
      <div class="sched-venue">${_shortVenue(venue)}</div>
      <div class="sched-result ${win?'sched-w':'sched-l'}">${win?'W':'L'} ${our}-${their}</div>
    </div>`;
  }

  // Live games: show LIVE tag
  if(state==='Live'){
    const inning=game.linescore?.currentInningOrdinal||'';
    return`<div class="sched-cell${todayCls}">
      <div class="sched-day"><span class="sched-dow">${dayLabel}</span> <span class="sched-date">${dateLabel}</span></div>
      <div class="sched-opp">${isHome?'vs':'@'} ${oppAbbr}${extra}</div>
      <div class="sched-venue">${_shortVenue(venue)}</div>
      <div class="sched-live">● LIVE ${inning}</div>
    </div>`;
  }

  // Preview / scheduled
  return`<div class="sched-cell${todayCls}">
    <div class="sched-day">${dayLabel} ${dateLabel}</div>
    <div class="sched-opp">${isHome?'vs':'@'} ${oppAbbr}${extra}</div>
    <div class="sched-time">${timeStr}</div>
    <div class="sched-venue">${_shortVenue(venue)}</div>
    <div class="sched-pp${ppName?'':' sched-pp-tbd'}" title="${ppName||'TBD'}">
      ${ppName?'vs '+ppLast:'PP TBD'}
    </div>
  </div>`;
}

function _shortVenue(name){
  if(!name)return'';
  // Trim common suffixes for tighter cells
  return name
    .replace(/\s+(at\s+)?Park$/i,'')
    .replace(/\s+Stadium$/i,'')
    .replace(/\s+Field$/i,'')
    .replace(/Citizens Bank/i,'CBP')
    .replace(/Oracle Park/i,'Oracle')
    .replace(/Dodger/i,'Dodger')
    .slice(0,18);
}

async function autoLoadNextGame(){
  try{
    // Use Arizona local date (UTC-7 year-round, no DST) so late-evening games near UTC midnight
    // aren't excluded by an early date rollover.
    const azNow=new Date(Date.now()-7*60*60*1000);
    // Fetch from yesterday to give Live games a safety margin if game runs past midnight Arizona
    const start=new Date(azNow.getTime()-24*60*60*1000).toISOString().split('T')[0];
    const end=new Date(azNow.getTime()+7*24*60*60*1000).toISOString().split('T')[0];
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&hydrate=probablePitcher&startDate=${start}&endDate=${end}`);
    const d=await r.json();
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
      S.gamePk=game.gamePk||null;
      const pp=oppSide?.probablePitcher;
      if(pp?.id&&pp?.fullName&&!S.pitcher){
        await selectPitcher(pp.id,pp.fullName);
      }
    }catch(e){console.log('Auto-pitcher failed:',e.message);}

    // Travel fatigue detection — compare to last completed game
    try{
      const weekAgo=new Date(Date.now()-8*24*60*60*1000).toISOString().split('T')[0];
      const yesterday=new Date(Date.now()-1*24*60*60*1000).toISOString().split('T')[0];
      const prevR=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&startDate=${weekAgo}&endDate=${yesterday}`);
      const prevD=await prevR.json();
      const prevGames=(prevD?.dates||[]).flatMap(d=>d.games||[]).filter(g=>g.status?.abstractGameState==='Final');
      const prevGame=prevGames[prevGames.length-1];
      if(prevGame){
        const prevVenue=prevGame.venue?.name;
        const currVenue=game.venue?.name;
        const daysBetween=(new Date(game.officialDate)-new Date(prevGame.officialDate))/(1000*60*60*24);
        const travelSel=document.getElementById('travel-select');
        if(prevVenue&&currVenue&&prevVenue!==currVenue&&daysBetween<=2){
          const prevUTC=new Date(prevGame.gameDate);
          const prevMSTHour=(prevUTC.getUTCHours()-7+24)%24;
          travelSel.value=prevMSTHour>=21?'redeye':'same';
        }else{
          document.getElementById('travel-select').value='none';
        }
      }
    }catch(e){console.log('Travel detection failed:',e.message);}
    // Load umpire, weather, lineup
    await loadUmpireAndWeather();
    loadDashboard();
  }catch(e){console.log('Auto game load failed:',e.message);}
}

// ═══════════ LINEUP ═══════════════════════════════════════════════════════════
async function loadLineupContext(dv){
  show('lineup-spinner');hide('lineup-content');setText('lineup-empty','');
  try{
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&hydrate=lineups&date=${dv}`);
    const d=await r.json();
    console.log('[Lineup] raw API response:', d);
    const game=d?.dates?.[0]?.games?.[0];
    if(!game){setText('lineup-empty','No D-backs game on this date.');hide('lineup-spinner');show('lineup-empty');return;}
    console.log('[Lineup] game found:', game.gamePk, '| lineups:', game.lineups);
    const isHome=game.teams?.home?.team?.id===109;
    const players=(isHome?game.lineups?.homePlayers:game.lineups?.awayPlayers)||[];
    console.log('[Lineup] players array length:', players.length, '| isHome:', isHome);
    if(!players.length){
      setText('lineup-empty','Lineup not yet posted — check back closer to first pitch.');
      hide('lineup-spinner');show('lineup-empty');return;
    }
    // Players are already in batting order by array position — no battingOrder field present
    const ordered=players.slice();
    if(!ordered.length){setText('lineup-empty','Lineup order not yet available.');hide('lineup-spinner');show('lineup-empty');return;}

    const stats=await Promise.all(ordered.map((p,idx)=>
      fetch(`/mlb/api/v1/people/${p.id}/stats?stats=season&group=hitting&season=2026&gameType=R`)
        .then(r=>r.json())
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
    const newRoster=stats.map(p=>({name:p.name,id:String(p.id),order:p.order||null}));
    S.lineupRoster=newRoster;
    rebuildPlayerSelect(newRoster);
    // If bets are already on screen with stale roster, regenerate them
    if(S.allPlayerBets){S.allPlayerBets=null;loadDashboard();}
  }catch(e){setText('lineup-empty','Could not load lineup data.');show('lineup-empty');console.error('Lineup:',e);}
  finally{hide('lineup-spinner');}
}


// ═══════════ WEATHER ════════════════════════════════════════════════════════════
async function fetchWeather(){
  const sel=document.getElementById('stadium-select');
  const opt=sel.options[sel.selectedIndex];
  const lat=opt.dataset.lat,lon=opt.dataset.lon;
  show('weather-spinner');hide('weather-content');
  try{
    const r=await fetch(`/weather/${lat},${lon}?format=j1`);
    const d=await r.json();
    const cur=d.current_condition?.[0];
    if(!cur)throw new Error('No data');
    const tempF=parseInt(cur.temp_F);
    const windMph=parseInt(cur.windspeedMiles);
    const windDir=cur.winddir16Point;
    const humidity=parseInt(cur.humidity);
    const desc=cur.weatherDesc?.[0]?.value||'';
    const hour=parseInt((document.getElementById('game-time').value||'19:10').split(':')[0]);
    const today=d.weather?.[0];
    let fh=null;
    if(today?.hourly)fh=today.hourly.reduce((p,c)=>Math.abs(parseInt(c.time)/100-hour)<Math.abs(parseInt(p.time)/100-hour)?c:p);
    const u=fh||cur;
    const uT=parseInt(u.tempF||u.temp_F||tempF),uW=parseInt(u.windspeedMiles||windMph),uH=parseInt(u.humidity||humidity),uD=u.winddir16Point||windDir;
    S.weather={tempF:uT,windMph:uW,windDir:uD,humidity:uH,desc};
    document.getElementById('weather-grid').innerHTML=`<div class="weather-cell"><div class="wc-label">Temp</div><div class="wc-val" style="color:${uT>=90?'#e74c3c':uT<=55?'#3498db':'#fff'}">${uT}°F</div><div class="wc-sub">${desc}</div></div><div class="weather-cell"><div class="wc-label">Wind</div><div class="wc-val">${uW} mph</div><div class="wc-sub">${uD}</div></div><div class="weather-cell"><div class="wc-label">Humidity</div><div class="wc-val">${uH}%</div><div class="wc-sub">relative</div></div><div class="weather-cell"><div class="wc-label">Sky</div><div class="wc-val" style="font-size:18px;">${desc.includes('Rain')?'🌧':desc.includes('Cloud')||desc.includes('Overcast')?'☁️':'☀️'}</div></div>`;
    const hasRoof=opt.dataset.roof==='1';
    const roofRec=document.getElementById('roof-rec');
    if(hasRoof){if(uT>=90){roofRec.className='roof-recommendation likely-closed';roofRec.textContent=`⚠ ${uT}°F — Roof likely closed.`;roofRec.classList.remove('hidden');}else if(uT<80){roofRec.className='roof-recommendation likely-open';roofRec.textContent=`✓ ${uT}°F — Roof likely open.`;roofRec.classList.remove('hidden');}else roofRec.classList.add('hidden');}else roofRec.classList.add('hidden');
    show('weather-content');
  }catch(e){console.warn('Weather load failed:',e.message);hide('weather-spinner');}
  finally{hide('weather-spinner');}
}

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
    const hand=S.pitcher?.hand||S.pitcherThrows;
    const hs=hand==='L'?S.splits.vl:S.splits.vr;
    if(hs?.ops){const a=(hs.ops-0.720)*70;add(`vs ${hand}HP`,hs.ops.toFixed(3)+' OPS',a,`${a>0?'Hits well':'Struggles'} vs ${hand==='L'?'lefties':'righties'} this season`);}
    const ls=S.isHome?S.splits.h:S.splits.a;
    if(ls?.ops){const a=(ls.ops-0.720)*35;add(S.isHome?'Home':'Away',ls.ops.toFixed(3)+' OPS',a,`OPS ${ls.ops.toFixed(3)} ${S.isHome?'at home':'on the road'}`);}
  }
  if(S.pitcher?.st){
    const era=parseFloat(S.pitcher.st.era);
    const adv=S.pitcher.advanced||{};
    // Use xFIP > FIP > ERA in order of predictive value. Display label reflects source.
    const trueERA=adv.siera??adv.xfip??adv.fip??era;
    const trueLabel=adv.siera!=null?'SIERA':adv.xfip!=null?'xFIP':adv.fip!=null?'FIP':'ERA';
    if(!isNaN(trueERA)&&trueERA!=null){
      const a=(trueERA-4.00)*4;
      add(`Pitcher ${trueLabel}`,trueERA.toFixed(2),a,trueERA<3.25?'Elite arm':trueERA<4.00?'Above-average':trueERA<5.00?'League-average':'Hittable pitcher','pitcher');
    }
    // ERA-FIP divergence reveals luck/regression — show only when gap is meaningful
    if(adv.fip!=null&&!isNaN(era)){
      const gap=era-adv.fip;
      if(gap>=0.75)add('Unlucky Pitcher',`ERA ${era.toFixed(2)} vs FIP ${adv.fip.toFixed(2)}`,-2,'ERA inflated vs FIP — pitcher likely better than results show, expect regression','pitcher');
      else if(gap<=-0.75)add('Lucky Pitcher',`ERA ${era.toFixed(2)} vs FIP ${adv.fip.toFixed(2)}`,2,'ERA suppressed vs FIP — pitcher likely worse than results show, expect regression','pitcher');
    }
    // K-BB% — much more predictive than raw K% alone
    if(adv.kbbPct!=null){
      if(adv.kbbPct>=18)add('Elite K-BB%',adv.kbbPct.toFixed(1)+'%',-4,'Dominant strikeout-to-walk skill gap','pitcher');
      else if(adv.kbbPct<=8)add('Poor K-BB%',adv.kbbPct.toFixed(1)+'%',3,'Weak K-BB ratio — hitters get more usable contact','pitcher');
    }
    // HR/9 — power suppression metric
    if(adv.hr9!=null){
      if(adv.hr9>=1.5)add('HR-prone',adv.hr9.toFixed(2)+' HR/9',3,'Allows home runs at high rate','pitcher');
      else if(adv.hr9<=0.8)add('HR Suppressor',adv.hr9.toFixed(2)+' HR/9',-2,'Limits home runs effectively','pitcher');
    }
    if(S.pitcher.daysRest!=='—'){if(S.pitcher.daysRest<4)add('Short Rest',S.pitcher.daysRest+'d',3,'Pitcher on short rest — fatigue advantage','pitcher');else if(S.pitcher.daysRest>=6)add('Extra Rest',S.pitcher.daysRest+'d',-2,'Well-rested pitcher — sharper command','pitcher');}
    const lpc=S.pitcher.lastOuting?.numberOfPitches;
    if(lpc&&lpc>=100)add('High Prev PC',lpc+' pitches',2,`${lpc} pitches last outing — possible fatigue`,'pitcher');
    if(S.pitcher.bullpenGame){
      add('Bullpen Game',`<45 PC × 3`,7,'Opener/bullpen game — hitters benefit from facing multiple pitchers and weaker arms throughout','pitcher');
    }
  } else {
    const mEra=parseFloat(document.getElementById('m-pitcher-era')?.value);
    if(!isNaN(mEra)){const a=(mEra-4.00)*4;add('Pitcher ERA',mEra.toFixed(2),a,mEra<3.25?'Elite arm':mEra<4.00?'Above-average':mEra<5.00?'League-average':'Hittable pitcher','pitcher');}
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
    if(bbP>=12)add('BB%',bbP.toFixed(1)+'%',3,'Elite walk rate');
    if(kP>=28)add('K%',kP.toFixed(1)+'%',-3,'High strikeout rate');
  }
  // Batter Statcast factors. Barrel% lives only in per-prop adjustments (TB/HR
  // in modelProbability) — it has no causal effect on walks/Ks/runs/RBI and was
  // double-counting against TB through the score → lerp3 pipeline.
  if(S.statcast){
    const {whiff,xwoba,gb,fb}=S.statcast;
    if(whiff!=null){
      if(whiff<=18)add('Whiff%',whiff.toFixed(1)+'%',3,'Low whiff rate — difficult to strike out');
      else if(whiff>=30)add('Whiff%',whiff.toFixed(1)+'%',-3,'High whiff rate — vulnerable to swing-and-miss stuff');
    }
    if(xwoba!=null){
      if(xwoba>=0.380)add('xwOBA',xwoba.toFixed(3),4,'Elite expected production — hitting the ball well');
      else if(xwoba<=0.290)add('xwOBA',xwoba.toFixed(3),-3,'Below-average expected production');
    }
    if(gb!=null&&gb>=55)add('GB%',gb.toFixed(1)+'%',-2,'Heavy ground ball hitter — limits extra-base upside');
    if(fb!=null&&fb>=45)add('FB%',fb.toFixed(1)+'%',2,'High fly ball rate — elevated HR and total bases ceiling');
  }
  // Pitcher Statcast factors. xwOBA-against is a composite of Barrel%, HH%, and
  // launch angle, so keeping the components alongside it would triple-count the
  // same suppression skill. Put Away% is Whiff% in 2-strike counts — same K-skill
  // signal again. Both dropped in favor of xwOBA-against + Whiff%.
  if(S.pitcherStatcast){
    const{whiff:pWhiff,gbPct,xwoba:pXwoba}=S.pitcherStatcast;
    if(pWhiff!=null){
      if(pWhiff>=28)add('Pitcher Whiff%',pWhiff.toFixed(1)+'%',-4,'Elite whiff rate — dominant swing-and-miss stuff','pitcher');
      else if(pWhiff<=16)add('Pitcher Whiff%',pWhiff.toFixed(1)+'%',3,'Low pitcher whiff rate — hitter-friendly contact','pitcher');
    }
    if(gbPct!=null&&gbPct>=50)add('Pitcher GB%',gbPct.toFixed(1)+'%',-2,'Ground ball pitcher — limits extra-base power','pitcher');
    if(pXwoba!=null){
      if(pXwoba<=0.280)add('xwOBA vs',pXwoba.toFixed(3),-3,'Elite expected wOBA suppression','pitcher');
      else if(pXwoba>=0.370)add('xwOBA vs',pXwoba.toFixed(3),3,'High xwOBA allowed — hitter-friendly profile','pitcher');
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
    if(wd==='out'&&windMph>=8)add('Wind Out',windMph+' mph',windMph*0.35,'Blowing out — HR potential elevated','conditions');
    else if(wd==='in'&&windMph>=8)add('Wind In',windMph+' mph',-windMph*0.28,'Blowing in — suppresses power','conditions');
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
  S.lastScore=score;S.lastPrediction={score,tier,factors,catTotals,tempF,windMph,windDir,humidity,playerName:S.playerName,pitcherName:pn,hand,era,date:document.getElementById('game-date').value||new Date().toISOString().split('T')[0]};
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

// ═══════════ FACTOR CARD RENDERING ════════════════════════════════════════════

function renderFactorCards(factors, catTotals){
  const colors={positive:'#2ecc71',negative:'#e74c3c',neutral:'#f39c12'};
  const icons={positive:'▲',negative:'▼',neutral:'●'};
  const fmtRows=fs=>fs.length
    ?fs.map(f=>`<div class="factor-row"><span class="factor-icon" style="color:${colors[f.impact]}">${icons[f.impact]}</span><span class="factor-label">${f.label}</span><span class="factor-value">${f.value}</span><span class="factor-note">${f.note}</span></div>`).join('')
    :'<div style="font-size:11px;color:#555;font-family:\'Chakra Petch\',monospace;padding:4px 0;">No significant factors.</div>';
  const fmtNet=n=>{
    const s=n>0?'+':'',c=n>0?'#2ecc71':n<0?'#e74c3c':'#888';
    return`<span style="color:${c};font-weight:900;font-family:\'Chakra Petch\',monospace;font-size:12px;letter-spacing:0;text-transform:none;">${s}${n}</span>`;
  };
  ['batter','pitcher','conditions'].forEach(cat=>{
    const fs=factors.filter(f=>f.cat===cat);
    const net=catTotals?.[cat]||0;
    const bodyEl=document.getElementById(`factors-${cat}-body`);
    const netEl=document.getElementById(`factors-${cat}-net`);
    if(bodyEl)bodyEl.innerHTML=fmtRows(fs);
    if(netEl)netEl.innerHTML=fmtNet(net);
  });
  // Mini score bars
  const setMini=(id,net)=>{
    const c=net>0?'#2ecc71':net<0?'#e74c3c':'#888';
    const w=Math.min(100,Math.abs(net)/20*100);
    const valEl=document.getElementById(`mini-${id}-val`);
    const barEl=document.getElementById(`mini-${id}-bar`);
    if(valEl){valEl.textContent=(net>0?'+':'')+net;valEl.style.color=c;}
    if(barEl){barEl.style.width=w+'%';barEl.style.background=c;}
  };
  setMini('batter',catTotals?.batter||0);
  setMini('pitcher',catTotals?.pitcher||0);
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
  const rispAvg=parseFloat(S.rispStat?.avg)||null;

  if(propKey==='batter_hits'){
    if(avg!=null)        score+=(avg-0.247)*150;
    if(babip!=null)      score+=(babip-0.291)*80;
    if(kPct!=null)       score-=(kPct-22)*0.5;
    if(handOps)          score+=(handOps-0.720)*35;
    if(pWhip!=null)      score-=(pWhip-1.25)*20;
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
    if(slg!=null)        score+=(slg-0.405)*60;
    if(protTier==='strong') score+=5;
    else if(protTier==='weak') score-=5;
    if(pEra!=null)       score-=(pEra-4.00)*3.5;
    if(mu&&muW>0)        score+=(mu.ops-0.720)*35*muW;
    if(tempF>=90||elev>4000) score+=3;
  }
  else if(propKey==='batter_walks'){
    if(bbPct!=null)      score+=(bbPct-9)*3;
    if(obp!=null)        score+=(obp-0.318)*70;
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
    if(pWhip!=null)      score-=(pWhip-1.25)*15;
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

function impliedProb(odds){
  if(!odds)return null;
  return odds<0?(-odds)/(-odds+100)*100:100/(odds+100)*100;
}

function _factorial(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}
function _poissonCDF(lambda,k){let p=0;for(let i=0;i<=k;i++)p+=Math.pow(lambda,i)*Math.exp(-lambda)/_factorial(i);return p;}

// Expected plate appearances per game by batting order slot.
// Leadoff hitters get ~4.6 PAs; bottom-of-order ~3.7. Used by all PA-based prop models.
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
function _gamePAs(){
  const o=S.currentOrder;
  // Base PA by lineup spot — calibrated for an average 38-team-PA game.
  // Default 4.2 (population mean) when order is unknown.
  let pa;
  if(!o) pa=4.2;
  else if(o<=2) pa=4.6;
  else if(o<=4) pa=4.4;
  else if(o<=6) pa=4.2;
  else if(o<=7) pa=4.0;
  else pa=3.7;

  // Home team gets slightly fewer PAs on average — home team in the lead entering
  // the bottom of the 9th doesn't bat. Spread across ~25% of games.
  if(S.isHome) pa-=0.08;

  // Run environment: more baserunners = more PAs across the order. Apply as a
  // multiplier on the base PA so each spot scales proportionally with team PAs.
  if(!S.pitcher?.bullpenGame){
    const{hitF,hasRoof}=_parkFactors();
    const rfClosed=hasRoof&&S.roofClosed;
    // Park run factor — pure hitF (hits drive baserunners and PAs). hrF was
    // previously blended in (0.3 weight) but that triple-counted park HR effects:
    // park already enters via calcPrediction's score factor and again as a direct
    // ±5pp prop adjustment in modelProbability. Pure hitF keeps the run-environment
    // signal without compounding HR effects three ways.
    const parkRunF=rfClosed?1.0:hitF;
    // WHIP delta — league avg ~1.30. Elite 1.00 → -3% PAs, poor 1.50 → +2% PAs.
    const whip=parseFloat(S.pitcher?.st?.whip);
    const pitcherPaF=isFinite(whip)?1.0+(whip-1.30)*0.10:1.0;
    const env=parkRunF*pitcherPaF;
    // Cap the combined multiplier at ±8% to keep extreme matchups from compounding.
    pa*=Math.max(0.92,Math.min(1.08,env));
  }

  return pa;
}

// PA multiplier vs league average — used to scale hits/TB/runs/RBI projections
// whose lerp3 anchors assume a league-average ~4.2 PA game. Returns 1.0 when no
// signal is available so callers can multiply unconditionally.
function _paMultiplier(){
  return _gamePAs()/4.2;
}

// Times-Through-the-Order (TTOP) bonus for hits-based props. Hitters perform
// noticeably better the more times they see a starter (~+30 pts wOBA on 3rd TTO).
// Top-of-order batters get more TTO3 exposure when starters go 5+ innings. Bullpen
// games dilute the effect since hitters face fresh arms each turn through.
// Returns pp adjustment to add to model over-prob.
function _ttopBonus(){
  if(S.pitcher?.bullpenGame)return 0;
  const o=S.currentOrder;
  if(!o)return 0;
  if(o<=3)return 2;   // ~40% of PAs are TTO3 — biggest familiarity edge
  if(o<=6)return 1;   // some TTO3 exposure when starter goes 6+
  return 0;           // bottom of order: mostly TTO1/TTO2
}

// H+R+RBI estimate. These three events are positively correlated (a hit often produces
// a run or RBI; HRs produce all three), so summing rates and feeding to a single Poisson
// understates variance and biases OVER probability high. When we have ≥10 recent games,
// use the empirical CDF directly — it captures the real joint distribution. Otherwise
// fall back to the summed-rate Poisson with the caveat that it's biased.
function _hrrOverPct(line, ss, recentLog, gamePAs){
  const k=Math.floor(line);
  if(recentLog?.length>=10){
    const counts=recentLog.map(g=>(parseInt(g.stat?.hits)||0)+(parseInt(g.stat?.runs)||0)+(parseInt(g.stat?.rbi)||0));
    const cnt=counts.filter(c=>c>k).length;
    return (cnt/counts.length)*100;
  }
  // No recent-game log — fall back to season rate with Bayesian shrinkage.
  // League avg H+R+RBI per game ~1.55-1.7 depending on year; use 1.6 as prior.
  // Scale the per-game rate by today's expected PAs vs the league-average ~4.2.
  const paMult=gamePAs?gamePAs/4.2:1.0;
  const totalHRR=(parseInt(ss?.hits)||0)+(parseInt(ss?.runs)||0)+(parseInt(ss?.rbi)||0);
  const hrrPG=_shrunkRate(totalHRR,parseInt(ss?.gamesPlayed)||0,1.6,60)*paMult;
  return (1-_poissonCDF(hrrPG,k))*100;
}

// Median of implied probabilities (not median of American odds — odds are non-linear,
// so a numeric median of -200 / +200 / -110 doesn't represent the median fair price).
function _medianImpliedProb(prices){
  const ps=prices.map(impliedProb).filter(x=>x!=null);
  if(!ps.length)return null;
  const s=[...ps].sort((a,b)=>a-b),m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}

// Multiplicative (power) devig. Given raw implied probs o and u that sum to >1 due
// to vig, find exponent k such that o^k + u^k = 1. Preserves the *ratio of fair odds*
// rather than the ratio of probabilities, which is the more theoretically sound
// transformation since books typically apply vig multiplicatively to fair odds.
// Better than additive normalization for asymmetric overround (one side shaded).
function devig(overPrices,underPrices){
  if(!overPrices?.length||!underPrices?.length)return null;
  const rawO=_medianImpliedProb(overPrices);
  const rawU=_medianImpliedProb(underPrices);
  if(rawO==null||rawU==null)return null;
  const o=rawO/100, u=rawU/100;
  // No vig (or fair/inverted line): fall back to simple normalization to avoid
  // numerical issues with power method on near-fair markets.
  if(o+u<=1.0001){
    const tot=o+u;
    return{overProb:(o/tot)*100,underProb:(u/tot)*100};
  }
  // Binary search for k. f(k)=o^k+u^k is monotonically decreasing for 0<o,u<1,
  // so we can bracket the root. f(1)>1 by assumption; f(3) is always <1 for valid
  // probs in this range (the alt-ladder gate at sideShare>0.85 caps inputs).
  let lo=1.0, hi=3.0;
  for(let i=0;i<60;i++){
    const mid=(lo+hi)/2;
    const sum=Math.pow(o,mid)+Math.pow(u,mid);
    if(sum>1)lo=mid; else hi=mid;
  }
  const k=(lo+hi)/2;
  return{overProb:Math.pow(o,k)*100,underProb:Math.pow(u,k)*100};
}

// Shrink a player rate toward league average using Bayesian-style mixing.
// `numerator` and `denominator` are the player's totals (e.g., walks / PA).
// `priorN` is the "equivalent prior observations" — higher = more shrinkage.
// For 30-PA player with priorN=60, shrinkage weights player rate 33% vs 67% league.
// For 500-PA player with priorN=60, player rate gets 89% weight. Stable for vets,
// regression-aware for callups.
function _shrunkRate(numerator,denominator,leagueAvg,priorN){
  if(!denominator||denominator<=0)return leagueAvg;
  const n=denominator;
  return (numerator + priorN*leagueAvg) / (n + priorN);
}

// P(X ≥ k) where X ~ Binomial(n, p). Used by walks/K props to compute the
// probability of clearing a half-integer line over `gamePAs` independent
// plate appearances. The previous formula hardcoded "P(over 1.5)" for every
// line > 0.5 — a 2.5-line bet was being graded as if it were a 1.5 line.
function _binomGE(n, p, k) {
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

// Extract the full stat payload from a MLB Stats API statSplits row. Includes
// counting stats (K, BB, PA, AB, H, TB, HR) so handedness-specific rates can be
// computed for the K/BB/Hits projections — not just OPS for the score.
function _extractSplitStat(st){
  if(!st)return null;
  return{
    ops:parseFloat(st.ops)||null,
    avg:st.avg, obp:st.obp, slg:st.slg,
    gp:parseInt(st.gamesPlayed)||0,
    pa:parseInt(st.plateAppearances)||0,
    ab:parseInt(st.atBats)||0,
    h:parseInt(st.hits)||0,
    tb:parseInt(st.totalBases)||0,
    hr:parseInt(st.homeRuns)||0,
    rbi:parseInt(st.rbi)||0,
    k:parseInt(st.strikeOuts)||0,
    bb:parseInt(st.baseOnBalls)||0,
  };
}

// Return the active L/R split row for the current batter (vs the listed pitcher's
// hand). Returns null if splits aren't loaded or the row is missing.
function _handSplit(){
  const hand=S.pitcher?.hand||S.pitcherThrows;
  if(!hand||!S.splits)return null;
  return hand==='L'?S.splits.vl:S.splits.vr;
}

// Pitch-mix vs batter weakness. Loaded once per page from /pitch-arsenal (a snapshot
// of Baseball Savant pitcher arsenal + batter pitch-arsenal leaderboards, refreshed
// daily by scripts/refresh_pitch_arsenal.py). Compares the batter's per-pitch-type
// rates (whiff/K/wOBA) weighted by the pitcher's actual usage% vs the batter's
// overall baseline. Captures matchup signal the season-wide K%/wOBA stats can't.
async function _loadPitchArsenal(){
  if(S.pitchArsenal!==undefined)return S.pitchArsenal; // null or object — cached
  try{
    const r=await fetch('/pitch-arsenal');
    if(!r.ok){S.pitchArsenal=null;return null;}
    S.pitchArsenal=await r.json();
    return S.pitchArsenal;
  }catch(e){S.pitchArsenal=null;return null;}
}

const _PITCH_NAMES={FF:'4-seam',SI:'sinker',FC:'cutter',SL:'slider',ST:'sweeper',CU:'curve',CH:'change',FS:'splitter',SV:'slurve',KC:'knuckle-curve'};

// Returns the matchup factor for the current batter/pitcher pair, or null if data
// is missing or sample sizes are too small. Cached per (pitcherId, batterId) pair
// since modelProbability is called multiple times per render.
function _pitchMatchupFactor(){
  const pid=S.pitcher?.id, bid=S.playerId;
  if(S.pitchMatchupCached?.pid===pid && S.pitchMatchupCached?.bid===bid){
    return S.pitchMatchupCached.value;
  }
  const cacheMiss=v=>{S.pitchMatchupCached={pid,bid,value:v};return v;};
  const arsenal=S.pitchArsenal;
  if(!arsenal||!pid||!bid||S.pitcher?.bullpenGame)return cacheMiss(null);
  const pit=arsenal.pitchers?.[String(pid)];
  const bat=arsenal.batters?.[String(bid)];
  if(!pit||!bat)return cacheMiss(null);

  // Batter baseline — weighted by PA per pitch type, all pitches the batter has faced.
  let bWhiffSum=0,bWobaSum=0,bKSum=0,bPaTotal=0;
  for(const pt in bat.pitches){
    const r=bat.pitches[pt];
    const w=r.pa||0;
    if(!w)continue;
    bWhiffSum+=(r.whiff||0)*w;
    bWobaSum+=(r.woba||0)*w;
    bKSum+=(r.k_pct||0)*w;
    bPaTotal+=w;
  }
  if(bPaTotal<60)return cacheMiss(null); // need a meaningful baseline

  const baseWhiff=bWhiffSum/bPaTotal;
  const baseWoba=bWobaSum/bPaTotal;
  const baseK=bKSum/bPaTotal;

  // Expected matchup — re-weight batter's per-pitch rates by the pitcher's usage%.
  // Only count pitches the batter has faced ≥20 times (skip noise from rare pitches).
  let expWhiff=0,expWoba=0,expK=0,usageCovered=0;
  const detail=[];
  for(const pt in pit.pitches){
    const pu=pit.pitches[pt].usage||0;
    const br=bat.pitches[pt];
    if(!br||(br.pa||0)<20||!pu)continue;
    expWhiff+=pu*(br.whiff||0);
    expWoba+=pu*(br.woba||0);
    expK+=pu*(br.k_pct||0);
    usageCovered+=pu;
    detail.push({pt,usage:pu,whiff:br.whiff||0,k:br.k_pct||0,woba:br.woba||0});
  }
  // Require ≥60% of pitcher's mix to be covered by batter's known per-pitch rates.
  if(usageCovered<60)return cacheMiss(null);
  expWhiff/=usageCovered;
  expWoba/=usageCovered;
  expK/=usageCovered;

  const whiffDelta=expWhiff-baseWhiff;
  const kDelta=expK-baseK;
  const wobaDelta=expWoba-baseWoba;

  // Pick the single pitch type whose contribution moves K% the most — that's what
  // we'll mention in the analysis line ("heavy SL: batter Ks 28% on it vs 22% baseline").
  detail.sort((a,b)=>(b.usage*Math.abs(b.k-baseK))-(a.usage*Math.abs(a.k-baseK)));
  const top=detail[0];
  const pitchLabel=_PITCH_NAMES[top?.pt]||top?.pt||'';

  return cacheMiss({
    kDeltaPp:kDelta,
    wobaDelta:wobaDelta,
    whiffDelta:whiffDelta,
    baseWhiff,baseK,baseWoba,
    expWhiff,expK,expWoba,
    primaryPitch:top?.pt,
    primaryPitchName:pitchLabel,
    primaryUsage:top?.usage,
    primaryBatterK:top?.k,
    primaryBatterWhiff:top?.whiff,
  });
}

// Render the Pitch Mix card on the Prediction Score panel as a per-pitch matchup
// table. For each pitch the pitcher throws (sorted by usage), show:
//   - pitcher's usage % (bar)
//   - batter's BA / SLG / K% / wOBA on that pitch
// Stats are colored vs the batter's overall baseline across all pitches:
//   green = batter performs better than baseline on this pitch (or whiffs less)
//   red   = batter performs worse (or whiffs more)
// Falls back to a simple pitcher-only bar view when arsenal data isn't available.
function _renderPitchMatchup(){
  const arsenal=S.pitchArsenal;
  const pid=S.pitcher?.id;
  const bid=S.playerId;
  const pit = arsenal&&pid ? arsenal.pitchers?.[String(pid)] : null;
  const bat = arsenal&&bid ? arsenal.batters?.[String(bid)] : null;

  // Fallback: no arsenal pitcher data → original bar-only display
  if(!pit){
    return Object.entries(S.pitcherPitches||{}).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a)
      .map(([type,pct])=>`<div class="pitch-row"><span class="pitch-label">${type}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${pct}%;background:${pct>35?'#A71930':'#3a3560'}"></div></div><span class="pitch-pct">${pct}%</span></div>`).join('')
      || '<div style="color:#777;font-family:\'Chakra Petch\',monospace;font-size:11px;">No pitch mix data available.</div>';
  }

  // Compute the batter's baseline. Use MLB API season stats for BA/SLG/K% — they're
  // accurate full-season numbers. The Statcast pitch-arsenal data only covers pitch types
  // with ≥25 PA, which skews the weighted average high (harder pitches get excluded).
  // wOBA isn't in the MLB API so we still derive it from the Statcast-weighted average.
  let bWoba=0,bWhiff=0,bPA=0;
  if(bat){
    for(const pt in bat.pitches){
      const r=bat.pitches[pt];
      const w=r.pa||0;
      if(!w)continue;
      if(r.woba!=null)  bWoba+=r.woba*w;
      if(r.whiff!=null) bWhiff+=r.whiff*w;
      bPA+=w;
    }
  }
  const ss=S.seasonStat;
  const ssPA=ss?.plateAppearances||0;
  const base = bPA>0 ? {
    ba:   ss?.avg  ? parseFloat(ss.avg)  : bPA>0 ? null : null,
    slg:  ss?.slg  ? parseFloat(ss.slg)  : null,
    k:    ssPA>0   ? (ss.strikeOuts/ssPA)*100 : null,
    woba: bWoba/bPA,
    whiff:bWhiff/bPA,
  } : null;

  // Color helpers — "good" means good for the batter.
  //   higherBetter=true:  green if val > base by ≥thresh, red if val < base - thresh
  //   higherBetter=false: inverted (used for K% and whiff%)
  const colorFor=(val,baseline,thresh,higherBetter)=>{
    if(val==null||baseline==null)return '#aaa';
    const d=val-baseline;
    const good = higherBetter ? d>=thresh : d<=-thresh;
    const bad  = higherBetter ? d<=-thresh : d>=thresh;
    if(good)return '#2ecc71';
    if(bad) return '#e74c3c';
    return '#aaa';
  };
  const fmt3=v=>v==null?'—':v.toFixed(3).replace(/^0/,'');
  const fmtPct=v=>v==null?'—':v.toFixed(0)+'%';

  // Sort pitches by usage descending. Only show pitches the pitcher actually throws.
  const pitches = Object.entries(pit.pitches)
    .filter(([,d])=>(d.usage||0)>=2) // hide pitch types thrown <2% of the time
    .sort(([,a],[,b])=>(b.usage||0)-(a.usage||0));

  if(!pitches.length){
    return '<div style="color:#777;font-family:\'Chakra Petch\',monospace;font-size:11px;">No arsenal data for this pitcher.</div>';
  }

  const header = base
    ? `<div class="matchup-baseline">Batter baseline: <strong>${fmt3(base.ba)}</strong> BA · <strong>${fmt3(base.slg)}</strong> SLG · <strong>${fmtPct(base.k)}</strong> K · <strong>${fmt3(base.woba)}</strong> wOBA</div>`
    : `<div class="matchup-baseline" style="color:#888;">No per-pitch batter data — showing pitcher arsenal only.</div>`;

  const rows = pitches.map(([code,p])=>{
    const name=_PITCH_NAMES[code]||code;
    const usage=p.usage||0;
    const br=bat?.pitches?.[code];
    const usageBarColor = usage>=30 ? '#A71930' : usage>=15 ? '#7a3560' : '#3a3560';
    const usageBar = `<div class="matchup-bar-wrap"><div class="matchup-bar" style="width:${Math.min(100,usage*1.8)}%;background:${usageBarColor};"></div></div>`;

    if(!br || (br.pa||0) < 15){
      return `<div class="matchup-row">
        <div class="matchup-pitch">${name}</div>
        <div class="matchup-usage">${usageBar}<span class="matchup-usage-pct">${usage.toFixed(0)}%</span></div>
        <div class="matchup-stats" style="color:#666;">— insufficient batter sample —</div>
      </div>`;
    }

    const baCol  = colorFor(br.ba,  base?.ba,  0.025, true);
    const slgCol = colorFor(br.slg, base?.slg, 0.05,  true);
    const kCol   = colorFor(br.k_pct,base?.k,  3,     false);
    const wCol   = colorFor(br.woba,base?.woba,0.020, true);

    return `<div class="matchup-row">
      <div class="matchup-pitch">${name}</div>
      <div class="matchup-usage">${usageBar}<span class="matchup-usage-pct">${usage.toFixed(0)}%</span></div>
      <div class="matchup-stats">
        <span style="color:${baCol};">${fmt3(br.ba)}</span>
        <span class="matchup-sep">·</span>
        <span style="color:${slgCol};">${fmt3(br.slg)}</span>
        <span class="matchup-sep">·</span>
        <span style="color:${kCol};">${fmtPct(br.k_pct)} K</span>
        <span class="matchup-sep">·</span>
        <span style="color:${wCol};">${fmt3(br.woba)}</span>
        <span class="matchup-sample">${br.pa} PA</span>
      </div>
    </div>`;
  }).join('');

  const legend = base
    ? `<div class="matchup-legend">Colors compare each pitch vs batter's all-pitch baseline. <span style="color:#2ecc71;">Green</span> = better for batter, <span style="color:#e74c3c;">red</span> = worse.</div>`
    : '';

  return header + rows + legend;
}

// Short driver string for the analysis text — only emit when the matchup signal
// is meaningful (≥2pp K delta or ≥0.015 wOBA delta).
function _pitchMatchupReason(direction,propKey){
  const m=_pitchMatchupFactor();
  if(!m)return null;
  const isK = propKey==='batter_strikeouts';
  const helpsOver = isK ? (m.kDeltaPp>0) : (m.wobaDelta>0);
  const meaningful = isK ? Math.abs(m.kDeltaPp)>=2 : Math.abs(m.wobaDelta)>=0.015;
  if(!meaningful)return null;
  // Match direction — only surface when matchup supports the bet direction
  const supports = (direction==='over' && helpsOver) || (direction==='under' && !helpsOver);
  if(!supports)return null;
  if(isK){
    return `${m.primaryUsage.toFixed(0)}% ${m.primaryPitchName} (${m.primaryBatterK.toFixed(0)}% K vs ${m.baseK.toFixed(0)}% base)`;
  }
  return `${m.primaryUsage.toFixed(0)}% ${m.primaryPitchName} mix (${(m.wobaDelta>0?'+':'')}${m.wobaDelta.toFixed(3)} wOBA matchup)`;
}

function modelProbability(propKey,line,score){
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const gamePAs=_gamePAs();
  let p=null;

  // Piecewise linear interpolation between three anchor points (score 20/50/80).
  // Clamps to anchor values outside that range.
  function lerp3(sc,s1,p1,s2,p2,s3,p3){
    const c=Math.max(s1,Math.min(s3,sc));
    if(c<=s2)return p1+(p2-p1)*(c-s1)/(s2-s1);
    return p2+(p3-p2)*(c-s2)/(s3-s2);
  }

  // PA delta from league-average (4.2). Used to scale lerp3-based prop probs since
  // those anchors assume a typical-game number of plate appearances.
  const paDelta=gamePAs-4.2;

  if(propKey==='batter_hits'){
    if(line<=0.5) p=lerp3(score,20,42,50,62,80,78);
    else          p=lerp3(score,20,18,50,32,80,52);
    // WHIP is the most direct pitcher signal for hits-allowed. League avg ~1.30.
    // Elite pitcher (1.10) → -3pp, poor (1.50) → +3pp. Skip on bullpen games (the
    // listed pitcher faces only a few batters, so their WHIP isn't representative).
    if(S.pitcher?.st?.whip&&!S.pitcher.bullpenGame){
      const whip=parseFloat(S.pitcher.st.whip);
      if(isFinite(whip))p+=Math.max(-4,Math.min(4,(whip-1.30)*15));
    }
    // Pitch-mix matchup — wOBA delta scaled to pp. wOBA spreads of 0.020 are
    // common at extremes; 150× gives ±3pp at that magnitude. Cap ±3pp.
    {const mu=_pitchMatchupFactor();
     if(mu)p+=Math.max(-3,Math.min(3,mu.wobaDelta*150));}
    p+=_ttopBonus();
    // PA volume — extra PAs mean extra at-bats, which compound a hit chance.
    // ±5pp at the cap (~±0.4 PA from average).
    p+=Math.max(-5,Math.min(5,paDelta*12));
  }
  else if(propKey==='batter_total_bases'){
    if(line<=0.5)      p=lerp3(score,20,38,50,58,80,74);
    else if(line<=1.5) p=lerp3(score,20,22,50,40,80,62);
    else if(line<=2.5) p=lerp3(score,20,12,50,24,80,42);
    else               p=lerp3(score,20, 6,50,14,80,26);
    // Same WHIP signal but smaller magnitude — TB is heavily HR-skewed and HR
    // suppression is handled by the HR park factor + xFIP/HR9 score factors.
    if(S.pitcher?.st?.whip&&!S.pitcher.bullpenGame){
      const whip=parseFloat(S.pitcher.st.whip);
      if(isFinite(whip))p+=Math.max(-3,Math.min(3,(whip-1.30)*12));
    }
    // wOBA captures slug too — TB is slug-sensitive, so weight slightly higher.
    {const mu=_pitchMatchupFactor();
     if(mu)p+=Math.max(-3.5,Math.min(3.5,mu.wobaDelta*180));}
    p+=_ttopBonus();
    // Direct contact-quality signal for TB. Hard-Hit% (no longer in calcPrediction) and
    // Barrel% are the strongest batted-ball predictors of extra-base output, and they
    // can diverge from season SLG when a hitter's results lag their underlying contact.
    // League avg hhRate ~40%, barrel% ~8%. Capped ±3pp each.
    if(S.statcast?.hhRate!=null) p+=Math.max(-3,Math.min(3,(S.statcast.hhRate-40)*0.12));
    if(S.statcast?.brl!=null)    p+=Math.max(-3,Math.min(3,(S.statcast.brl-8)*0.35));
    // PA volume adjustment, capped at ±4pp.
    p+=Math.max(-4,Math.min(4,paDelta*10));
  }
  else if(propKey==='batter_home_runs'){
    p=lerp3(score,20,8,50,14,80,28);
    p+=_ttopBonus();
    // Barrel% is the single strongest predictor of HR rate — drives HR/PA. Moved
    // out of calcPrediction so it only affects power-relevant props. Cap ±4pp.
    if(S.statcast?.brl!=null) p+=Math.max(-4,Math.min(4,(S.statcast.brl-8)*0.5));
    // HR rate is per-PA, so extra PAs lift HR probability proportionally — but the
    // base prob is small (~14%), so the absolute pp swing is modest. Cap ±2pp.
    p+=Math.max(-2,Math.min(2,paDelta*5));
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
    const scoreBase=lerp3(score,20,18,50,30,80,48);
    p=scoreBase*0.6+rateBase*0.4;
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
    const scoreBase=lerp3(score,20,28,50,48,80,68);
    p=scoreBase*0.6+rateBase*0.4;
  }
  else if(propKey==='batter_rbis'){
    // League avg RBI/G ~0.43. priorN=60 games (stabilization point for per-game rates).
    // Scale the per-game rate by today's expected PAs vs league average — high-PA
    // games produce proportionally more RBI opportunities.
    const rbiPG=_shrunkRate(parseInt(ss?.rbi)||0,parseInt(ss?.gamesPlayed)||0,0.43,60)*(gamePAs/4.2);
    const rateBase=(1-_poissonCDF(rbiPG,Math.floor(line)))*100;
    const scoreBase=lerp3(score,20,15,50,28,80,45);
    p=scoreBase*0.6+rateBase*0.4;
    if(S.lineupProtection?.tier==='strong')p+=5;
    else if(S.lineupProtection?.tier==='weak')p-=5;
  }
  else if(propKey==='batter_runs_scored'){
    // League avg runs/G ~0.55. priorN=60 games. PA-scaled like RBI.
    const runPG=_shrunkRate(parseInt(ss?.runs)||0,parseInt(ss?.gamesPlayed)||0,0.55,60)*(gamePAs/4.2);
    const rateBase=(1-_poissonCDF(runPG,Math.floor(line)))*100;
    const scoreBase=lerp3(score,20,18,50,32,80,50);
    p=scoreBase*0.5+rateBase*0.5;
    // Runs depend on hitters behind you driving you in — strong protection helps,
    // weak protection hurts. Same magnitude as RBI.
    if(S.lineupProtection?.tier==='strong')p+=5;
    else if(S.lineupProtection?.tier==='weak')p-=5;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    const rateBase=_hrrOverPct(line,ss,S.recentGameLog,gamePAs);
    const scoreBase=lerp3(score,20,20,50,38,80,60);
    p=scoreBase*0.5+rateBase*0.5;
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

  // Line-specific hard clamps applied last
  if(propKey==='batter_hits'){
    if(line<=0.5) p=Math.max(38,Math.min(82,p));
    else          p=Math.max(20,Math.min(65,p));
  } else if(propKey==='batter_total_bases'){
    p=Math.max(20,Math.min(78,p));
  } else if(propKey==='batter_home_runs'){
    p=Math.max(5,Math.min(45,p));
  } else if(propKey==='batter_walks'){
    p=Math.max(15,Math.min(65,p));
  } else if(propKey==='batter_strikeouts'){
    p=Math.max(20,Math.min(75,p));
  } else if(propKey==='batter_rbis'){
    p=Math.max(12,Math.min(65,p));
  } else if(propKey==='batter_runs_scored'){
    p=Math.max(15,Math.min(70,p));
  } else if(propKey==='batter_hits_runs_rbis'){
    p=Math.max(15,Math.min(75,p));
  } else{
    p=Math.max(5,Math.min(95,p));
  }

  return p;
}

const PROP_NAMES={
  'batter_hits':'Hits','batter_total_bases':'Total Bases','batter_home_runs':'Home Runs',
  'batter_rbis':'RBI','batter_walks':'Walks','batter_strikeouts':'Strikeouts',
  'batter_runs_scored':'Runs','batter_hits_runs_rbis':'H+R+RBI',
};

function americanToDecimal(price){
  price=Number(price);
  if(!price)return null;
  return price>0?price/100+1:100/Math.abs(price)+1;
}

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
    for(const l of [...allLines]){
      const oArr=mkt.overByLine[l]||[];
      const uArr=mkt.underByLine[l]||[];
      if(!oArr.length||!uArr.length)continue;
      const rO=_medianImpliedProb(oArr),rU=_medianImpliedProb(uArr);
      if(rO==null||rU==null)continue;
      // Reject alt-ladder rungs (one side >85% raw implied) — books post these
      // as ladders for HRR/HR markets, and devig produces phantom 95% edges.
      const sideShare=rO/(rO+rU);
      if(sideShare>0.85||sideShare<0.15)continue;
      const imbalance=Math.abs(sideShare-0.5);
      if(imbalance<minImbalance){minImbalance=imbalance;effectiveLine=l;}
    }
    const line=effectiveLine!=null?effectiveLine:0.5;
    const calcOver=mkt.overByLine[line]||[];
    const calcUnder=mkt.underByLine[line]||[];
    const overBest=mkt.overBestByLine[line]||null;
    const underBest=mkt.underBestByLine[line]||null;
    if(!calcOver?.length||!calcUnder?.length){
      results.push({prop:PROP_NAMES[propKey],propKey,line,insufficient:true,
        overBest,underBest,edgeStrength:'none',absDelta:0});
      return;
    }
    const dv=devig(calcOver,calcUnder);
    if(!dv)return;
    const modelProb=modelProbability(propKey,line,score);
    if(modelProb===null)return;

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
      delta,absDelta,ev,edgeStrength,marketConfidence,
      marketOverProb:dv.overProb,marketUnderProb:dv.underProb,
      modelProb,
      overBest,underBest,
      books:mkt.books||[],
      odds:bestOdds?.price||0,
      reasoning:corbetReasoning(propKey,direction.toLowerCase(),modelProb>=50?modelProb:100-modelProb),
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
  const [r1,r2,r3,r4,r5]=await Promise.all([
    fetch('/savant/statcast?type=batter&year=2026'),
    fetch('/savant/expected?type=batter&year=2026'),
    fetch('/savant/battracking?year=2026'),
    fetch('/savant/batter-arsenal?year=2026'),
    fetch('/savant/batted-ball?year=2026'),
  ]);
  const [t1,t2,t3,t4,t5]=await Promise.all([r1.text(),r2.text(),r3.text(),r4.text(),r5.text()]);
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
    fetch(`${base}?stats=statSplits&group=hitting&season=2026&gameType=R&sitCodes=h,a,vl,vr,d,n`),
    fetch(`${base}?stats=season&group=hitting&season=2026&gameType=R`),
    fetch(`${base}?stats=statSplits&group=hitting&season=2026&gameType=R&sitCodes=risp`),
    fetch(`${base}?stats=gameLog&group=hitting&season=2026&gameType=R`),
  ]);
  const [sd,ss,rd,gd]=await Promise.all([a.json(),b.json(),c.json(),d.json()]);
  const byCode={};
  (sd?.stats?.[0]?.splits??[]).forEach(s=>{if(s.split?.code)byCode[s.split.code]=_extractSplitStat(s.stat);});
  let matchupStats=null;
  if(pitcherId){
    try{
      const mr=await fetch(`${base}?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&gameType=R&season=2026`);
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
      const r=await fetch('/odds/v4/sports/baseball_mlb/events?regions=us&oddsFormat=american');
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

      const propMarkets='batter_hits,batter_total_bases,batter_home_runs,batter_rbis,batter_walks,batter_strikeouts,batter_runs_scored,batter_hits_runs_rbis';
      // Pull from 5 books — DK and Fanatics post the deepest prop coverage on most
      // games, with MGM/CZR/365 filling in mainline + select prop markets. Diagnostic
      // testing on a Dbacks-Rockies game returned only DK + Fanatics for batter_hits
      // even with no bookmaker filter, so adding Fanatics directly addresses missing
      // line coverage.
      const propBooks='draftkings,betmgm,caesars,bet365,fanatics';
      const pr=await fetch(`/odds/v4/sports/baseball_mlb/events/${dbacksGame.id}/odds?bookmakers=${propBooks}&markets=${propMarkets}&oddsFormat=american`);
      const propsText=await pr.text();
      try{propData=JSON.parse(propsText);}catch(e){throw new Error('Props endpoint returned invalid response.');}
      if(propData.message||propData.error_code){throw new Error('Odds API: '+(propData.message||propData.error_code));}

      writeOddsCache(S.gamePk,{eventsGame:dbacksGame,propData});
    }

    // Build per-player market maps in one pass through bookmaker data.
    // The fetch only requests DK/MGM/CZR/365/FAN, so every returned book is implicitly trusted.
    // Bad-price defense is the lopsided-line gate in the line picker (generateCorbetBets).
    const playerMaps={};
    activeRoster().forEach(p=>{playerMaps[p.id]={};});
    (propData.bookmakers||[]).forEach(book=>{
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
              const d=(o.description||o.name||'').toLowerCase().trim();
              if(!d.includes(pLast))return false;
              // Strict full-name match avoids cross-player collisions
              // (e.g. "Ildemaro Vargas" vs "Kenneth Vargas").
              if(d.includes(pFullName))return true;
              // Allow abbreviated form like "I. Vargas" / "I Vargas" only.
              const abbrevRe=new RegExp('(^|\\s)'+pInitial+'\\.?\\s+'+pLast+'(\\s|$|,)','i');
              return abbrevRe.test(d);
            })
            .forEach(o=>{
              const dir=o.name.toLowerCase();
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
              }
            });
        });
      });
    });

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
        bets.forEach(b=>{if(b.propKey==='batter_total_bases'&&b.line<=0.5)b.line=1.5;});
        bets.forEach(b=>{b._playerName=player.name;b._playerScore=snap.score;});
        allPlayerBets.push({playerName:player.name,bets,lowData:(S.players[player.id]?.lowData||false)});
      }catch(e){
        console.warn(`Bet generation failed for ${player.name} (${player.id}):`,e.message);
      }finally{
        // Always restore S so a partial swap doesn't leak into subsequent iterations or UI
        if(savedCtx)Object.assign(S,savedCtx);
      }
    }

    if(allPlayerBets.reduce((s,pg)=>s+pg.bets.length,0)===0){
      hide('corbet-loading');show('corbet-no-props');
      document.getElementById('dash-best-bets').innerHTML='<div class="dash-empty">Player props not yet posted for this game — check back tonight or tomorrow morning.</div>';
      return;
    }

    S.allPlayerBets=allPlayerBets.filter(pg=>pg.bets.length>0);
    const filterEl=document.getElementById('corbet-player-filter');
    filterEl.innerHTML='<div class="cpf-label">Show players</div>'+
      S.allPlayerBets.map(pg=>`<label data-name="${pg.playerName}"><input type="checkbox" checked onchange="renderCorbetBets()"> ${pg.playerName}</label>`).join('');
    show('corbet-player-filter');
    renderCorbetBets();
    show('corbet-bets');
    renderDashboard();
    autoRegisterGradePredictions();
  }catch(e){
    hide('corbet-loading');
    setText('corbet-error','⚠ '+e.message);
    show('corbet-error');
    document.getElementById('dash-best-bets').innerHTML=`<div class="dash-empty" style="color:#e74c3c;">⚠ ${e.message}</div>`;
  }finally{hide('corbet-loading');}
}

function renderCorbetBets(){
  if(!S.allPlayerBets)return;
  const edgeLabels={strong:'🟢 Strong Edge',moderate:'🟡 Moderate Edge',small:'Small Edge',none:''};
  const fmtOdds=p=>p!=null?(p>0?'+':'')+p:'—';
  const filterEl=document.getElementById('corbet-player-filter');
  const checked=new Set(Array.from(filterEl.querySelectorAll('label')).filter(l=>l.querySelector('input').checked).map(l=>l.dataset.name));
  const visible=S.allPlayerBets.filter(pg=>checked.has(pg.playerName));
  const flatBets=[];
  const corbetBetsMap={};
  document.getElementById('corbet-bets').innerHTML=visible.map(pg=>{
    const cards=pg.bets.map(b=>{
      flatBets.push(b);
      const betKey=`${(b._playerName||'').replace(/[|]/g,'_')}|${b.propKey||''}|${b.line??''}|${b.direction||''}`;
      corbetBetsMap[betKey]=b;
      if(b.insufficient)return`<div class="bet-card" style="background:#0c0a1e;border:1px solid #1a1730;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div class="bet-card-header">
          <span style="font-size:13px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${b.prop} <span style="color:#666;font-size:10px;">· ${b.line}</span></span>
        </div>
        <div style="font-size:10px;color:#666;font-family:\'Chakra Petch\',monospace;margin:8px 0 10px;">⚠ Insufficient market data — fewer than 2 reliable bookmakers</div>
        <div style="display:flex;gap:14px;font-family:\'Chakra Petch\',monospace;font-size:11px;">
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Over</div>
            <div style="color:#ccc;">${fmtOdds(b.overBest?.price)} <span style="color:#555;font-size:9px;">${bookAbbrev(b.overBest?.book||'')}</span></div></div>
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Under</div>
            <div style="color:#ccc;">${fmtOdds(b.underBest?.price)} <span style="color:#555;font-size:9px;">${bookAbbrev(b.underBest?.book||'')}</span></div></div>
        </div>
      </div>`;
      const overW=b.marketOverProb.toFixed(0);
      const underW=b.marketUnderProb.toFixed(0);
      const markerLeft=Math.max(1,Math.min(99,b.modelProb)).toFixed(1);
      const deltaLabel=(b.delta>0?'+':'')+b.delta.toFixed(1)+'%';
      const deltaColor=b.delta>0?'#2ecc71':'#e74c3c';
      const dirColor=b.delta>0?'#2ecc71':'#e74c3c';
      const dirBg=b.delta>0?'rgba(46,204,113,0.10)':'rgba(231,76,60,0.10)';
      const dirBorder=b.delta>0?'#1a4a10':'#4a1010';
      const cardBg=b.edgeStrength==='strong'?'background:#061a06;border-color:#1a4a10':
                   b.edgeStrength==='moderate'?'background:#1a1406;border-color:#3a2a00':
                   'background:#0c0a1e;border-color:#1a1730';
      const showSave=b.edgeStrength!=='none';
      return`<div class="bet-card" style="${cardBg};border-radius:10px;padding:14px 16px;margin-bottom:10px;border:1px solid;">
        <div class="bet-card-header">
          <span style="font-size:13px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${b.prop} <span style="color:#666;font-size:10px;">· ${b.line}</span></span>
          ${showSave?`<button data-bk="${betKey.replace(/"/g,'&quot;')}" onclick="saveBet(this.dataset.bk,this)" style="background:#0e0c22;border:1px solid #1e1b3a;border-radius:4px;color:#888;font-family:\'Chakra Petch\',monospace;font-size:9px;cursor:pointer;padding:3px 8px;letter-spacing:1px;text-transform:uppercase;">+ Save</button>`:''}
        </div>
        ${b.conflict?`<div style="background:#1a0808;border:1px solid #4a1010;border-radius:6px;padding:6px 10px;margin:6px 0 8px;font-size:9px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;">⚠ CONFLICT — Direction contradicts Total Bases recommendation. No edge shown.</div>`:''}
        ${b.edgeStrength!=='none'
          ?`<div style="background:${dirBg};border:1px solid ${dirBorder};border-radius:8px;padding:10px 14px;margin:8px 0 12px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-size:9px;color:#888;font-family:\'Chakra Petch\',monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Model Recommends</div>
                <div style="font-size:22px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:${dirColor};letter-spacing:1px;">${b.delta>0?'▲':'▼'} ${b.direction.toUpperCase()}</div>
              </div>
              <span class="edge-badge ${b.edgeStrength}">${edgeLabels[b.edgeStrength]}</span>
            </div>`
          :`<div style="font-size:10px;color:#555;font-family:\'Chakra Petch\',monospace;margin:6px 0 10px;">${b.conflict?'No recommendation — resolve conflict above':'Model agrees with market — no edge'}</div>`}
        <div style="margin-bottom:22px;">
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#888;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">
            <span>Over ${overW}%</span><span>Under ${underW}%</span>
          </div>
          <div style="position:relative;">
            <div class="prob-bar-wrap">
              <div class="prob-bar-over" style="width:${overW}%">${overW}%</div>
              <div class="prob-bar-under" style="width:${underW}%">${underW}%</div>
            </div>
            <div style="position:absolute;top:0;left:${markerLeft}%;width:2px;height:22px;background:rgba(255,255,255,0.9);transform:translateX(-50%);pointer-events:none;border-radius:1px;box-shadow:0 0 4px rgba(255,255,255,0.5);"></div>
          </div>
          <div style="position:relative;height:18px;margin-top:3px;">
            <div style="position:absolute;left:${markerLeft}%;transform:translateX(-50%);font-size:8px;color:#ccc;font-family:\'Chakra Petch\',monospace;white-space:nowrap;text-align:center;">▲ Model ${b.modelProb.toFixed(0)}%</div>
          </div>
        </div>
        <div style="display:flex;gap:14px;margin:0 0 8px;flex-wrap:wrap;font-family:\'Chakra Petch\',monospace;font-size:11px;">
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Over</div>
            <div style="color:#ccc;">${fmtOdds(b.overBest?.price)} <span style="color:#555;font-size:9px;">${bookAbbrev(b.overBest?.book||'')}</span></div></div>
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Under</div>
            <div style="color:#ccc;">${fmtOdds(b.underBest?.price)} <span style="color:#555;font-size:9px;">${bookAbbrev(b.underBest?.book||'')}</span></div></div>
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Delta</div>
            <div style="color:${deltaColor};font-weight:700;">${deltaLabel}</div></div>
        </div>
        <div class="bet-reasoning">${b.reasoning}</div>
      </div>`;
    }).join('');
    return`<div style="margin-bottom:18px;">
      <div class="dash-player-header">${pg.playerName}</div>
      ${cards}
    </div>`;
  }).join('');
  S.corbetBets=flatBets;
  S.corbetBetsMap=corbetBetsMap;
}

async function loadDashboard(){
  // Render game banner with current context
  _renderGameBanner();
  _renderPitcherCard();
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

function _renderGameBanner(){
  const el=document.getElementById('dash-game-banner');
  if(!el)return;
  const opp=S.opposingTeam||'';
  const date=document.getElementById('game-date')?.value||'';
  const time=document.getElementById('game-time')?.value||'';
  const venue=document.getElementById('stadium-select')?.value||'';
  const umpName=S.umpire?.fullName||S.umpire?.name||'';
  if(!opp&&!S.pitcher){el.innerHTML='<div class="dash-banner-empty">Loading game data…</div>';return;}
  // Field-relative wind direction (uses the active stadium's CF bearing)
  const wf=_windFieldRelative();
  const wfColor=wf?(wf.kind==='out'?'#2ecc71':wf.kind==='in'?'#e74c3c':'#888'):null;
  const wfTag=wf?` <span style="color:${wfColor};">→ ${wf.label}</span>`:'';
  el.innerHTML=`
    ${opp?`<div class="dash-opp">vs ${opp}</div>`:''}
    <div class="dash-game-meta">${[date,time,venue].filter(Boolean).join(' · ')}</div>
    ${S.weather?`<div class="dash-game-weather">${S.weather.tempF}°F · ${S.weather.desc}${S.weather.windMph?' · '+S.weather.windMph+' mph '+S.weather.windDir+wfTag:''}</div>`:''}
    ${umpName?`<div class="dash-ump">HP Umpire: ${umpName}</div>`:''}
  `;
}

// Translate the current compass-direction wind into a field-relative bucket
// (Out to CF/RF/LF, In from CF/RF/LF, Cross to 1B/3B) using the active
// stadium's center-field bearing. Returns null when calm or unknown.
function _windFieldRelative(){
  const compass=S.weather?.windDir;
  const mph=S.weather?.windMph||0;
  if(!compass||compass==='calm'||mph<3)return null;
  const fromDeg=_COMPASS_DEGS[compass];
  if(fromDeg==null)return null;
  const sel=document.getElementById('stadium-select');
  const opt=sel?.options[sel?.selectedIndex];
  const cfBearing=parseInt(opt?.dataset.cf)||45;
  const toDeg=(fromDeg+180)%360;
  const rel=(toDeg-cfBearing+360)%360;
  const sectors=['Out to CF','Out to RF','Cross to 1B','In from RF','In from CF','In from LF','Cross to 3B','Out to LF'];
  const label=sectors[Math.round(rel/45)%8];
  const kind=label.startsWith('Out')?'out':label.startsWith('In')?'in':'cross';
  return {label,kind};
}

function _renderPitcherCard(){
  const el=document.getElementById('dash-pitcher-card');
  if(!el)return;
  if(!S.pitcher){
    el.innerHTML=`<div class="dash-pitcher-card" style="justify-content:space-between;">
      <div class="dash-pitcher-meta" style="color:#f39c12;">⚠ Probable pitcher not yet announced — scores exclude pitcher factors.</div>
      <button class="dash-pitcher-btn" onclick="openModal('panel-setup','Setup &amp; Overrides')" style="white-space:nowrap;">Set Pitcher</button>
    </div>`;
    return;
  }
  const era=S.pitcher.st?.era?parseFloat(S.pitcher.st.era).toFixed(2):'—';
  const hand=S.pitcher.hand||'R';
  const bpBadge=S.pitcher.bullpenGame
    ?`<span style="background:#f39c12;color:#000;font-family:\'Chakra Petch\',monospace;font-size:9px;font-weight:900;letter-spacing:2px;padding:2px 7px;border-radius:4px;margin-left:8px;">OPENER/BULLPEN</span>`
    :'';
  el.innerHTML=`<div class="dash-pitcher-card pitcher-card-grid">
    <div class="pitcher-left">
      <div class="dash-pitcher-name">${S.pitcher.name}${bpBadge}</div>
      <div class="dash-pitcher-meta">${hand}HP · ERA ${era}${S.pitcher.bullpenGame?' · Expect multiple relievers':''}</div>
      <div id="dash-pitcher-form-slot"><div class="pf-loading">Loading recent starts…</div></div>
      <div id="dash-pitcher-splits-slot"></div>
    </div>
    <div id="dash-best-matchup-slot" class="pitcher-matchup"></div>
    <button class="dash-pitcher-btn" onclick="openModal('panel-pitcher','Pitcher Analysis')">View Stats</button>
  </div>`;
  // Async-fetch last 3 starts + season splits and slot them in
  if(S.pitcher.id&&!S.pitcher.bullpenGame){
    loadPitcherForm(S.pitcher.id).then(starts=>{
      const slot=document.getElementById('dash-pitcher-form-slot');
      if(slot)slot.innerHTML=starts?_renderPitcherForm(starts):'';
    });
    loadPitcherSplits(S.pitcher.id).then(splits=>{
      const slot=document.getElementById('dash-pitcher-splits-slot');
      // S.isHome is true when the D-backs are home — meaning the opposing pitcher is AWAY.
      const opposingIsHome=!S.isHome;
      if(slot)slot.innerHTML=splits?_renderPitcherSplits(splits,opposingIsHome):'';
    });
  }else{
    const slotF=document.getElementById('dash-pitcher-form-slot');
    if(slotF)slotF.innerHTML='';
    const slotS=document.getElementById('dash-pitcher-splits-slot');
    if(slotS)slotS.innerHTML='';
  }
  // Rebuilding the card wipes the matchup slot — repopulate it so opening a
  // player's stats (which triggers a pitcher-card re-render via state changes)
  // doesn't blank the Best Matchup card.
  _renderBestMatchup();
}

function renderDashboard(){
  _renderGameBanner();
  _renderPitcherCard();
  _renderBestMatchup();
  const fmtOdds=p=>p!=null?(p>0?'+':'')+p:'—';
  const edgeOrder={strong:3,moderate:2,small:1,none:0};

  // Top 3 bets — only when props are available
  if(S.allPlayerBets&&S.allPlayerBets.length){
    const top3=_getTopBets(3);
    document.getElementById('dash-best-bets').innerHTML=top3.length
      ?top3.map(b=>`<div class="dash-best-bet-row">
        <div class="dash-best-bet-left">
          <div class="dash-best-bet-player">${b.playerName}</div>
          <div class="dash-best-bet-prop">${b.direction.toUpperCase()} ${b.line} ${b.prop}</div>
        </div>
        <div class="dash-best-bet-right">
          <span class="dash-badge">${fmtOdds(b.direction.toLowerCase()==='over'?b.overBest?.price:b.underBest?.price)}</span>
          <span class="dash-badge" title="Edge stability % — not win probability">Stab ${b.mcConfidence.toFixed(0)}%</span>
          <span class="dash-badge">${(b.delta>0?'+':'')+b.delta.toFixed(1)}%</span>
        </div>
      </div>`).join('')
      :'<div class="dash-empty">No bets meet the 85% MC threshold today.</div>';
  }

  // Player rows — collapsible, sorted by batting order
  const betsMap={};
  (S.allPlayerBets||[]).forEach(pg=>{betsMap[pg.playerName]=pg;});

  // Pre-compute top-3 set so star icons can be applied per bet row.
  // Shared helper ensures lowData filter matches the Top 3 panel and autoSaveTopBets.
  const top3Keys=new Set(_getTopBets(3).map(b=>`${b.playerName}_${b.propKey}_${b.direction}`));

  const orderedRoster=[...activeRoster()].sort((a,b)=>{
    const oa=S.players?.[a.id]?.order??99;
    const ob=S.players?.[b.id]?.order??99;
    return oa-ob;
  });

  document.getElementById('dash-player-cards').innerHTML=orderedRoster.map(player=>{
    const snap=S.players?.[player.id];
    if(!snap)return'';
    const pid=player.id;
    const scoreColor=snap.tier?.color||'#aaa';
    const pg=betsMap[player.name];
    const orderLabel=snap.order||'—';

    // Bets to show in expanded body: non-none edge, up to 5
    const visibleBets=(pg?.bets||[])
      .filter(b=>!b.insufficient&&b.edgeStrength!=='none')
      .sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100)||(b.mcConfidence||0)-(a.mcConfidence||0))
      .slice(0,5);

    let betsHtml;
    if(visibleBets.length){
      const rows=visibleBets.map(b=>{
        const key=`${player.name}_${b.propKey}_${b.direction}`;
        const icon=top3Keys.has(key)
          ?'<span class="dpb-icon-star">★</span>'
          :b.edgeStrength==='strong'
            ?'<span class="dpb-icon-strong">●</span>'
            :'<span class="dpb-icon-moderate">■</span>';
        const bestOdds=b.direction.toLowerCase()==='over'?b.overBest:b.underBest;
        const deltaColor=b.ev!=null?(b.ev>=0?'#2ecc71':'#e74c3c'):(b.delta>0?'#2ecc71':'#e74c3c');
        const deltaSign=b.delta>=0?'+':'';
        const deltaLine=`Δ ${deltaSign}${b.delta.toFixed(1)}pp`;
        const evLine=b.ev!=null?`EV ${b.ev>=0?'+':''}${(b.ev*100).toFixed(1)}%`:null;
        const deltaStr=evLine
          ?`${evLine}<br><span style="font-size:9px;opacity:0.7">${deltaLine}</span>`
          :deltaLine;
        const softMarketBadge=b.marketConfidence==='low'
          ?' <span class="dpb-soft-market" data-tip="Soft / asymmetric market — the over and under odds are unbalanced (often only one side posted, or an unusually wide spread). Devigging math assumes a balanced two-sided market, so the EV% number here is less reliable than usual. The bet may still be sharp, but treat the exact EV with extra skepticism.">⚠</span>'
          :'';
        return`<tr>
          <td>${icon}</td>
          <td class="dpb-prop">${b.prop} ${b.line} ${b.direction.toUpperCase()}${softMarketBadge}</td>
          <td class="dpb-mc">${b.mcConfidence!=null?b.mcConfidence.toFixed(0)+'%':'—'}</td>
          <td class="dpb-delta" style="color:${deltaColor}">${deltaStr}</td>
          <td class="dpb-odds">${fmtOdds(bestOdds?.price)}<span class="dpb-book">${bookAbbrev(bestOdds?.book||'')}</span></td>
        </tr>`;
      }).join('');
      betsHtml=`<table class="dpb-bets-table">${rows}</table>
        ${pg?`<button class="dpb-more-bets" onclick="openPlayerCorbet('${pid}')">View More Bets for ${player.name} ›</button>`:''}`;
    }else if(pg){
      betsHtml='<div class="dpb-no-edge">No strong edges today</div>';
    }else{
      betsHtml='<div class="dpb-no-edge">Props not yet posted</div>';
    }

    const analysisText=_lineupAnalysisText(snap);
    const analysisHtml=analysisText?`<div class="dpb-lineup-analysis">${analysisText}</div>`:'';
    const matchupHtml=_matchupCardHtml(snap);
    const recentHtml=_recentFormHtml(snap);

    const avgStr=snap.seasonStat?.avg?parseFloat(snap.seasonStat.avg).toFixed(3):'—';
    const opsStr=snap.seasonStat?.ops?parseFloat(snap.seasonStat.ops).toFixed(3):'—';

    const lowDataBadge=snap.lowData?`<span class="low-data-badge" title="Fewer than 50 PA this season — small sample">⚠ Low PA</span>`:'';
    const lowDataWarning=snap.lowData?`<div class="low-data-warning">⚠ Fewer than 50 PA this season — rate stats (BB%, K%, AVG) may not be reliable with a small sample</div>`:'';
    return`<div class="dash-prow" id="dpr-${pid}">
      <div class="dash-prow-header" onclick="togglePlayerCard('${pid}')">
        <span class="dash-prow-order">${orderLabel}</span>
        <span class="dash-prow-name">${player.name}</span>${lowDataBadge}
        <span class="dash-prow-statline">AVG ${avgStr} &nbsp; OPS ${opsStr}</span>
        <button class="dash-prow-more" onclick="event.stopPropagation();openPlayerStats('${pid}')">More Stats ›</button>
        <span class="dash-prow-arrow" id="dpa-${pid}">▼</span>
      </div>
      <div class="dash-prow-body hidden" id="dpb-${pid}">
        <div class="dpb-left">
          <div class="dpb-gauge" style="border-color:${scoreColor}">
            <div class="dpb-gauge-score" style="color:${scoreColor}">${snap.score}</div>
          </div>
          <div class="dpb-tier" style="color:${scoreColor}">${snap.tier?.label||''}</div>
          <button class="dpb-details-btn" onclick="openPlayerDetails('${pid}')">Details ›</button>
        </div>
        <div class="dpb-center">${lowDataWarning}${betsHtml}</div>
        <div class="dpb-right">${matchupHtml}${recentHtml}</div>
        ${analysisHtml}
      </div>
    </div>`;
  }).join('');
}

function togglePlayerCard(playerId){
  const body=document.getElementById('dpb-'+playerId);
  const arrow=document.getElementById('dpa-'+playerId);
  if(!body)return;
  const nowHidden=body.classList.toggle('hidden');
  if(arrow)arrow.textContent=nowHidden?'▼':'▲';
}

function _lineupAnalysisText(snap){
  const ss=snap.seasonStat;
  const order=snap.order;
  if(!ss||!order)return null;
  const pa=ss.plateAppearances||1;
  const kPct=((ss.strikeOuts/pa)*100).toFixed(0);
  const bbPct=((ss.baseOnBalls/pa)*100).toFixed(0);
  const avg=ss.avg?parseFloat(ss.avg).toFixed(3):null;
  const obp=ss.obp?parseFloat(ss.obp).toFixed(3):null;
  const ops=ss.ops?parseFloat(ss.ops).toFixed(3):null;
  const suffix=order===1?'LEADOFF':order===4?'CLEANUP':`#${order} HITTER`;
  if(order===1)return obp&&kPct?`${obp} OBP · ${kPct}% K RATE BATTING ${suffix} THIS SEASON`:null;
  if(order===2)return avg&&bbPct?`${avg} AVG · ${bbPct}% BB RATE BATTING ${suffix} THIS SEASON`:null;
  if(order<=5)return ops&&ss.homeRuns!=null?`${ops} OPS · ${ss.homeRuns} HR BATTING ${suffix} THIS SEASON`:null;
  return avg&&kPct?`${avg} AVG · ${kPct}% K RATE BATTING ${suffix} THIS SEASON`:null;
}

function _matchupCardHtml(snap){
  const m=snap.matchupStats;
  const pitcherLast=(S.pitcher?.name||'').split(' ').pop().toUpperCase();
  const header=pitcherLast?`VS ${pitcherLast}`:'VS PITCHER';
  if(!m||!m.ab||m.ab<1){
    return`<div class="dpb-mini-card">
      <div class="dpb-mini-head">${header}</div>
      <div class="dpb-mini-empty">First career matchup</div>
    </div>`;
  }
  const fmt=v=>(parseFloat(v)||0).toFixed(3).replace(/^0/,'');
  const slash=`${fmt(m.avg)}/${fmt(m.obp)}/${fmt(m.slg)}`;
  return`<div class="dpb-mini-card">
    <div class="dpb-mini-head">${header} · ${m.ab} AB</div>
    <div class="dpb-mini-row">${slash}</div>
    <div class="dpb-mini-row">${m.h} H · ${m.hr} HR · ${m.k} K · ${m.bb} BB</div>
  </div>`;
}

function _recentFormHtml(snap){
  // recentGameLog is most-recent-first (see line ~224); take the first 7
  const log=snap.recentGameLog;
  if(!log||!log.length)return'';
  const games=log.slice(0,7);
  let ab=0,h=0,hr=0,bb=0,k=0;
  games.forEach(g=>{
    const s=g.stat||g;
    ab+=parseInt(s.atBats)||0;
    h+=parseInt(s.hits)||0;
    hr+=parseInt(s.homeRuns)||0;
    bb+=parseInt(s.baseOnBalls)||0;
    k+=parseInt(s.strikeOuts)||0;
  });
  if(!ab)return'';
  const avg=(h/ab).toFixed(3).replace(/^0/,'');
  return`<div class="dpb-mini-card">
    <div class="dpb-mini-head">LAST ${games.length}G · ${ab} AB</div>
    <div class="dpb-mini-row">${avg} AVG</div>
    <div class="dpb-mini-row">${h} H · ${hr} HR · ${k} K · ${bb} BB</div>
  </div>`;
}

// ═══════════ BET RECORD ════════════════════════════════════════════════════════
function saveBet(key, btn){
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
    propKey:b.propKey??null,direction:b.direction??null,line:b.line??null,ev:b.ev??null};
  S.betLog.unshift(bet);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
  if(btn){btn.textContent='✓ Saved!';btn.style.color='#2ecc71';setTimeout(()=>{btn.textContent='+ Save';btn.style.color='';},2000);}
}

// Single source of truth for "top N bets". All three callers (dashboard panel,
// player-row star icons, auto-save to localStorage) must use this so the lowData
// filter and MC threshold stay consistent.
function _getTopBets(n=3){
  if(!S.allPlayerBets)return[];
  const edgeOrder={strong:3,moderate:2,small:1,none:0};
  const qualified=[];
  S.allPlayerBets.forEach(pg=>{
    if(pg.lowData)return;
    pg.bets.forEach(b=>{
      if(b.mcConfidence!=null&&b.mcConfidence>=85&&b.edgeStrength!=='none'&&!b.insufficient)
        qualified.push({...b,playerName:pg.playerName});
    });
  });
  qualified.sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100)||(b.mcConfidence||0)-(a.mcConfidence||0));
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

function autoRegisterGradePredictions() {
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

function setResult(id,result){
  const bet=S.betLog.find(b=>b.id===id);
  if(!bet)return;
  // Toggle off if same result clicked again
  bet.result=bet.result===result?null:result;
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
}

function deleteBet(id){
  S.betLog=S.betLog.filter(b=>b.id!==id);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
}

function clearRecord(){
  if(!confirm('Clear all bet records?'))return;
  S.betLog=[];
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
}

// Display order for per-prop record cards.
const _RECORD_PROP_ORDER=['batter_hits','batter_total_bases','batter_home_runs','batter_rbis','batter_runs_scored','batter_strikeouts','batter_walks','batter_hits_runs_rbis'];
const _RECORD_PROP_SHORT={
  batter_hits:'Hits',batter_total_bases:'TB',batter_home_runs:'HR',
  batter_rbis:'RBI',batter_runs_scored:'Runs',batter_strikeouts:'K',
  batter_walks:'BB',batter_hits_runs_rbis:'HRR',
};

// Modern bets store propKey; legacy bets only have the human-readable prop string.
function _propKeyForBet(b){
  if(b.propKey)return b.propKey;
  const t=(b.prop||'').toLowerCase();
  if(t.includes('total bases'))return'batter_total_bases';
  if(t.includes('h+r+rbi'))return'batter_hits_runs_rbis';
  if(t.includes('home run'))return'batter_home_runs';
  if(t.includes('strikeout'))return'batter_strikeouts';
  if(t.includes('walk'))return'batter_walks';
  if(t.includes('rbi'))return'batter_rbis';
  if(t.includes('runs'))return'batter_runs_scored';
  if(t.includes('hits'))return'batter_hits';
  return null;
}

// Cumulative-profit sparkline. Renders an inline SVG polyline, oldest → newest.
function _renderPLSparkline(graded){
  if(!graded.length)return'<div class="rss-sparkline-empty">No graded bets yet</div>';
  let cum=0;const points=[0];
  graded.forEach(b=>{
    if(b.result==='win'){const o=b.odds;cum+=o>0?o/100:100/Math.abs(o);}
    else if(b.result==='loss'){cum-=1;}
    points.push(cum);
  });
  const w=240,h=36,pad=3;
  const min=Math.min(0,...points),max=Math.max(0,...points);
  const range=Math.max(0.5,max-min);
  const xStep=(w-pad*2)/Math.max(1,points.length-1);
  const yFor=v=>h-pad-((v-min)/range)*(h-pad*2);
  const path=points.map((v,i)=>`${(pad+i*xStep).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
  const final=points[points.length-1];
  const stroke=final>0?'#2ecc71':final<0?'#e74c3c':'#999';
  const y0=yFor(0).toFixed(1);
  return`<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:36px;display:block;">
    <line x1="${pad}" y1="${y0}" x2="${w-pad}" y2="${y0}" stroke="#2a2540" stroke-width="0.6" stroke-dasharray="2 2"/>
    <polyline points="${path}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
}

function setRecordSort(key){
  const cur=S.recordSort||{key:'date',dir:'desc'};
  // Toggle direction if same key is re-tapped; otherwise switch key and use
  // sensible default (desc for date — newest first; asc for player/prop — A→Z).
  if(cur.key===key)cur.dir=cur.dir==='asc'?'desc':'asc';
  else{cur.key=key;cur.dir=key==='date'?'desc':'asc';}
  S.recordSort={key:cur.key,dir:cur.dir};
  localStorage.setItem('corbetRecordSort',JSON.stringify(S.recordSort));
  renderRecord();
}

function _sortBetLog(log){
  const{key,dir}=S.recordSort||{key:'date',dir:'desc'};
  const mult=dir==='asc'?1:-1;
  const getVal=b=>{
    if(key==='player')return(b.player||'').toLowerCase();
    if(key==='prop')return(b.prop||'').toLowerCase();
    return b.date||'';
  };
  return[...log].sort((a,b)=>{
    const av=getVal(a),bv=getVal(b);
    if(av<bv)return-1*mult;
    if(av>bv)return 1*mult;
    return(b.id||0)-(a.id||0);
  });
}

function renderRecord(){
  // Raw log preserves insertion order (newest-first) — used for aggregates and
  // the sparkline (which expects chronological order via .reverse()).
  const log=S.betLog;
  // Reflect the active sort key on the toolbar buttons
  const sk=S.recordSort?.key||'date';
  const sd=S.recordSort?.dir||'desc';
  document.querySelectorAll('.rec-sort-btn').forEach(btn=>{
    const k=btn.dataset.sk;
    btn.classList.toggle('active',k===sk);
    const base=k.charAt(0).toUpperCase()+k.slice(1);
    btn.textContent=k===sk?`${base} ${sd==='asc'?'↑':'↓'}`:base;
  });

  // Per-prop + overall aggregates
  const propStats={};
  _RECORD_PROP_ORDER.forEach(k=>{propStats[k]={w:0,l:0,profit:0};});
  let allW=0,allL=0,allProfit=0;
  log.forEach(b=>{
    if(!b.result||b.result==='push')return;
    const pk=_propKeyForBet(b);
    if(b.result==='win'){
      allW++;
      const payout=b.odds>0?b.odds/100:100/Math.abs(b.odds);
      allProfit+=payout;
      if(propStats[pk]){propStats[pk].w++;propStats[pk].profit+=payout;}
    }else if(b.result==='loss'){
      allL++;allProfit-=1;
      if(propStats[pk]){propStats[pk].l++;propStats[pk].profit-=1;}
    }
  });

  // Header strip
  const allTotal=allW+allL;
  const hitRate=allTotal?Math.round((allW/allTotal)*100)+'%':'—';
  const roiPct=allTotal?(allProfit/allTotal*100):null;
  const unitsEl=document.getElementById('rec-units');
  const roiEl=document.getElementById('rec-roi');
  unitsEl.textContent=allTotal?(allProfit>=0?'+':'')+allProfit.toFixed(2)+'u':'—';
  unitsEl.className='rss-val '+(allTotal?(allProfit>0?'pos':allProfit<0?'neg':''):'');
  roiEl.textContent=roiPct!=null?(roiPct>=0?'+':'')+roiPct.toFixed(1)+'%':'—';
  roiEl.className='rss-val '+(roiPct!=null?(roiPct>0?'pos':roiPct<0?'neg':''):'');
  document.getElementById('rec-hitrate').textContent=hitRate;
  document.getElementById('rec-overall').textContent=`${allW}-${allL}`;

  // Sparkline — log is stored newest-first, so reverse for chronological order
  const graded=log.filter(b=>b.result&&b.result!=='push').slice().reverse();
  document.getElementById('rec-sparkline').innerHTML=_renderPLSparkline(graded);

  // Pending
  const pending=log.filter(b=>!b.result).length;
  setText('rec-pending',pending?` · ${pending} pending result${pending>1?'s':''}  ↓`:'');

  // Per-prop grid
  document.getElementById('rec-prop-grid').innerHTML=_RECORD_PROP_ORDER.map(k=>{
    const s=propStats[k];
    const tot=s.w+s.l;
    const recordTxt=tot?`${s.w}-${s.l}`:'—';
    const roiTxt=tot?(s.profit>=0?'+':'')+s.profit.toFixed(1)+'u':'';
    const cls=!tot?'empty':s.profit>0?'pos':s.profit<0?'neg':'';
    return`<div class="prop-cell ${cls}">
      <div class="pc-label">${_RECORD_PROP_SHORT[k]}</div>
      <div class="pc-record">${recordTxt}</div>
      <div class="pc-roi">${roiTxt}</div>
    </div>`;
  }).join('');

  // Bet log (rating column retained for historical signal)
  const ratingColors={green:'#2ecc71',yellow:'#f39c12',red:'#e74c3c'};
  const ratingBg={green:'#0d3a0d',yellow:'#2a2000',red:'#2a0808'};
  const headers=document.getElementById('bet-log-headers');
  if(log.length===0){
    headers.style.display='none';
    show('bet-log-empty');
    document.getElementById('bet-log').innerHTML='';
    return;
  }
  headers.style.display='grid';
  hide('bet-log-empty');
  document.getElementById('bet-log').innerHTML=_sortBetLog(log).map(b=>`
    <div class="bet-log-item${b.result?'':' bet-pending'}">
      <span class="bli-date">${b.date}</span>
      <span class="bli-player">${b.player||'—'}</span>
      <span class="bli-opp">${b.opponent||'—'}</span>
      <span class="bli-prop">${b.prop}</span>
      <span class="bli-odds">${b.odds>0?'+':''}${b.odds??'—'}</span>
      <span class="bli-rating" style="background:${ratingBg[b.rating]||'#1a1730'};color:${ratingColors[b.rating]||'#777'}">${b.rating||'—'}</span>
      <span class="bli-result">
        <button class="result-btn win ${b.result==='win'?'active':''}" onclick="setResult(${b.id},'win')">W</button>
        <button class="result-btn loss ${b.result==='loss'?'active':''}" onclick="setResult(${b.id},'loss')">L</button>
        <button class="result-btn push ${b.result==='push'?'active':''}" onclick="setResult(${b.id},'push')">P</button>
      </span>
      <button class="del-btn" onclick="deleteBet(${b.id})" title="Remove">×</button>
    </div>`).join('');
}

// ═══════════ MODEL CALIBRATION ════════════════════════════════════════════════
// Reads bets from S.betLog that have BOTH a graded result and the modelProb/
// mcConfidence fields captured at save time. Older bets without those fields
// are excluded. Three views: predicted-probability calibration, MC threshold
// performance, per-prop-type breakdown.

// Returns the bet's win probability AS PREDICTED at save time, accounting for
// the bet direction. modelProb is stored as the OVER probability, so an UNDER
// bet's win prob is 100 - modelProb.
function _calBetWinProb(b){
  if(b.modelProb==null)return null;
  return (b.direction||'').toLowerCase()==='under'?100-b.modelProb:b.modelProb;
}

function _calBucketize(rows,bucketFn){
  const buckets=new Map();
  rows.forEach(r=>{
    const k=bucketFn(r);
    if(k==null)return;
    if(!buckets.has(k))buckets.set(k,[]);
    buckets.get(k).push(r);
  });
  return buckets;
}

function _calProfit(odds){
  if(!odds)return 0;
  return odds>0?odds/100:100/Math.abs(odds);
}

function renderCalibration(){
  // Eligible: graded (W/L/P) AND has modelProb captured at save time.
  // Pushes are excluded from hit-rate math but counted in totals.
  const all=(S.betLog||[]).filter(b=>b.result&&b.modelProb!=null);
  const settled=all.filter(b=>b.result==='win'||b.result==='loss');
  const empty=document.getElementById('cal-empty');
  const content=document.getElementById('cal-content');
  if(!all.length){
    show('cal-empty');hide('cal-content');return;
  }
  hide('cal-empty');show('cal-content');

  const summary=document.getElementById('cal-summary');
  const pendingOld=(S.betLog||[]).filter(b=>b.modelProb==null).length;
  summary.innerHTML=`${all.length} graded bet${all.length===1?'':'s'} with model data` +
    (pendingOld?` · ${pendingOld} older bet${pendingOld===1?'':'s'} excluded (no model data captured)`:'');

  // ─── 1. Predicted-probability calibration ─────────────────────────────────
  // Bucket bets by their predicted win prob (direction-adjusted). Compare avg
  // prediction vs actual hit rate. A well-calibrated model has gap ≈ 0.
  const probBucket=b=>{
    const p=_calBetWinProb(b);
    if(p==null)return null;
    if(p<50)return'<50%';
    if(p<60)return'50–59%';
    if(p<70)return'60–69%';
    if(p<80)return'70–79%';
    if(p<90)return'80–89%';
    return'90%+';
  };
  const probBuckets=_calBucketize(settled,probBucket);
  const probOrder=['<50%','50–59%','60–69%','70–79%','80–89%','90%+'];
  const probHeader=`<div class="cal-row cal-header" style="grid-template-columns:84px 56px 80px 80px 80px;"><span>Predicted</span><span>Count</span><span>Avg Pred</span><span>Hit Rate</span><span>Gap</span></div>`;
  let probRows='';
  probOrder.forEach(k=>{
    const bs=probBuckets.get(k);
    if(!bs?.length)return;
    const avgPred=bs.reduce((s,b)=>s+_calBetWinProb(b),0)/bs.length;
    const wins=bs.filter(b=>b.result==='win').length;
    const hitRate=(wins/bs.length)*100;
    const gap=hitRate-avgPred;
    const gapCls=Math.abs(gap)<=5?'cal-cell-good':Math.abs(gap)<=10?'cal-cell-neutral':'cal-cell-bad';
    probRows+=`<div class="cal-row" style="grid-template-columns:84px 56px 80px 80px 80px;"><span class="cal-cell-neutral">${k}</span><span class="cal-cell-muted">${bs.length}</span><span class="cal-cell-muted">${avgPred.toFixed(1)}%</span><span class="cal-cell-neutral">${hitRate.toFixed(1)}%</span><span class="${gapCls}">${gap>0?'+':''}${gap.toFixed(1)}%</span></div>`;
  });
  if(!probRows)probRows=`<div class="cal-row cal-empty-row">No graded bets with model probability yet.</div>`;
  document.getElementById('cal-prob-table').innerHTML=probHeader+probRows;

  // ─── 2. MC confidence threshold ───────────────────────────────────────────
  const mcBucket=b=>{
    const m=b.mcConfidence;
    if(m==null)return null;
    if(m<70)return'<70%';
    if(m<85)return'70–84%';
    return'85%+ (Top)';
  };
  const mcBuckets=_calBucketize(settled.filter(b=>b.mcConfidence!=null),mcBucket);
  const mcOrder=['<70%','70–84%','85%+ (Top)'];
  const mcHeader=`<div class="cal-row cal-header" style="grid-template-columns:1fr 56px 56px 80px 80px;"><span>Stab Range</span><span>Count</span><span>Wins</span><span>Hit Rate</span><span>ROI</span></div>`;
  let mcRows='';
  mcOrder.forEach(k=>{
    const bs=mcBuckets.get(k);
    if(!bs?.length)return;
    const wins=bs.filter(b=>b.result==='win').length;
    const losses=bs.filter(b=>b.result==='loss').length;
    const profit=bs.reduce((s,b)=>s+(b.result==='win'?_calProfit(b.odds):b.result==='loss'?-1:0),0);
    const hitRate=bs.length?(wins/bs.length)*100:0;
    const roi=bs.length?(profit/bs.length)*100:0;
    const hitCls=hitRate>=55?'cal-cell-good':hitRate>=45?'cal-cell-neutral':'cal-cell-bad';
    const roiCls=roi>=0?'cal-cell-good':'cal-cell-bad';
    mcRows+=`<div class="cal-row" style="grid-template-columns:1fr 56px 56px 80px 80px;"><span class="cal-cell-neutral">${k}</span><span class="cal-cell-muted">${bs.length}</span><span class="cal-cell-muted">${wins}-${losses}</span><span class="${hitCls}">${hitRate.toFixed(1)}%</span><span class="${roiCls}">${roi>=0?'+':''}${roi.toFixed(1)}%</span></div>`;
  });
  if(!mcRows)mcRows=`<div class="cal-row cal-empty-row">No graded bets with MC data yet.</div>`;
  document.getElementById('cal-mc-table').innerHTML=mcHeader+mcRows;

  // ─── 3. Per-prop-type breakdown ───────────────────────────────────────────
  const propLabel={
    batter_hits:'Hits',batter_total_bases:'Total Bases',batter_home_runs:'Home Runs',
    batter_rbis:'RBI',batter_walks:'Walks',batter_strikeouts:'Strikeouts',
    batter_runs_scored:'Runs',batter_hits_runs_rbis:'H+R+RBI',
  };
  const propBuckets=_calBucketize(settled,b=>b.propKey||null);
  const propHeader=`<div class="cal-row cal-header" style="grid-template-columns:1fr 56px 60px 80px 80px;"><span>Prop</span><span>Count</span><span>W-L</span><span>Hit %</span><span>Avg Model</span></div>`;
  let propRows='';
  const sortedProps=[...propBuckets.entries()].sort((a,b)=>b[1].length-a[1].length);
  sortedProps.forEach(([key,bs])=>{
    const wins=bs.filter(b=>b.result==='win').length;
    const losses=bs.filter(b=>b.result==='loss').length;
    const total=wins+losses;
    const hitRate=total?(wins/total)*100:0;
    const avgPred=bs.reduce((s,b)=>{const p=_calBetWinProb(b);return s+(p||0);},0)/bs.length;
    const gap=hitRate-avgPred;
    const hitCls=hitRate>=55?'cal-cell-good':hitRate>=45?'cal-cell-neutral':'cal-cell-bad';
    const gapCls=Math.abs(gap)<=5?'cal-cell-good':Math.abs(gap)<=10?'cal-cell-neutral':'cal-cell-bad';
    propRows+=`<div class="cal-row" style="grid-template-columns:1fr 56px 60px 80px 80px;"><span class="cal-cell-neutral">${propLabel[key]||key}</span><span class="cal-cell-muted">${bs.length}</span><span class="cal-cell-muted">${wins}-${losses}</span><span class="${hitCls}">${hitRate.toFixed(1)}%</span><span class="${gapCls}">${avgPred.toFixed(1)}% (${gap>0?'+':''}${gap.toFixed(1)})</span></div>`;
  });
  if(!propRows)propRows=`<div class="cal-row cal-empty-row">No graded bets with prop type data yet.</div>`;
  document.getElementById('cal-prop-table').innerHTML=propHeader+propRows;
}

// ═══════════ SPLITS ════════════════════════════════════════════════════════════
function opsColor(o){if(!o)return'#777';return o>0.850?'#2ecc71':o>0.720?'#fff':'#e74c3c';}
function renderSplitPills(){document.getElementById('splits-pills').innerHTML=[['vs LHP','vl'],['vs RHP','vr'],['Home','h'],['Away','a'],['Day','d'],['Night','n']].map(([l,c])=>{const s=S.splits?.[c];return`<div class="pill"><div class="pill-label">${l}</div><div class="pill-val" style="color:${opsColor(s?.ops)}">${s?.ops?s.ops.toFixed(3):'—'}</div><div class="pill-sub">OPS</div></div>`;}).join('');show('splits-pills');}
function showSplitsLoading(){show('splits-spinner');hide('splits-error');hide('splits-content');hide('splits-empty');}
function showSplitsError(m){hide('splits-spinner');setText('splits-error','⚠ '+m);show('splits-error');}
function renderSplitsTab(){
  hide('splits-spinner');hide('splits-empty');
  if(S.playerName)document.getElementById('splits-card-header').textContent=`📈 ${S.playerName} · 2026 Splits`;
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
function _renderStatTip(info){
  if(!info)return'';
  const esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines=[];
  if(typeof info==='string'){
    lines.push(`<span class="stat-tip-body">${esc(info)}</span>`);
  } else {
    if(info.title) lines.push(`<span class="stat-tip-title">${esc(info.title)}</span>`);
    if(info.body)  lines.push(`<span class="stat-tip-body">${esc(info.body)}</span>`);
    if(info.good)  lines.push(`<span class="stat-tip-line good">Good: ${esc(info.good)}</span>`);
    if(info.avg)   lines.push(`<span class="stat-tip-line">Avg: ${esc(info.avg)}</span>`);
    if(info.bad)   lines.push(`<span class="stat-tip-line bad">Bad: ${esc(info.bad)}</span>`);
    if(info.note)  lines.push(`<span class="stat-tip-note">${esc(info.note)}</span>`);
  }
  return ` <span class="stat-info">ⓘ<span class="stat-tip">${lines.join('')}</span></span>`;
}
function statBox(l,v,ctx,c,info){
  // 5th arg `info` shows on ⓘ hover (object with good/avg/bad lines, or a free-form string).
  // 3rd arg `ctx` is the small visible context line under the value.
  return`<div class="stat-box"><div class="stat-label">${l}${_renderStatTip(info)}</div><div class="stat-val${c?' '+c:''}">${v??'—'}</div>${ctx?`<div class="stat-context">${ctx}</div>`:''}</div>`;
}

// League-context tooltips for stat ⓘ icons.
// Object shape: { title, good, avg, bad, note?, body? } — body is for stats
// that don't have clean good/bad thresholds (counting stats, tradeoffs).
const STAT_INFO = {
  // ── Batter slash ──
  BA:    { title:'Batting Avg (H ÷ AB)',           good:'≥ .290',   avg:'~ .245',  bad:'≤ .220' },
  OBP:   { title:'On-Base % (H+BB+HBP ÷ PA)',      good:'≥ .360',   avg:'~ .315',  bad:'≤ .290' },
  SLG:   { title:'Slugging % (TB ÷ AB)',           good:'≥ .470',   avg:'~ .400',  bad:'≤ .350' },
  OPS:   { title:'On-base + Slugging',             good:'≥ .830',   avg:'~ .715',  bad:'≤ .640', note:'Elite ≥ .900' },
  BABIP: { title:'BA on Balls in Play',            good:'≥ .340',   avg:'~ .295',  bad:'≤ .270', note:'Above .340 may signal luck; below .270, bad luck' },
  ABHR:  { title:'At-bats per HR (lower = power)', good:'≤ 18',     avg:'30 – 40', bad:'50+',    note:'Elite power: ≤ 15' },
  // ── Batter discipline ──
  BBPCT: { title:'Walk Rate (BB ÷ PA)',            good:'≥ 10%',    avg:'~ 8.5%',  bad:'≤ 6%',   note:'Elite eye: 12%+' },
  KPCT_B:{ title:'Strikeout Rate (K ÷ PA)',        good:'≤ 16%',    avg:'~ 22%',   bad:'≥ 25%',  note:'Lower is better' },
  BBK:   { title:'BB/K Ratio — plate discipline',  good:'≥ 0.50',   avg:'~ 0.40',  bad:'≤ 0.25', note:'Elite: ≥ 0.80' },
  IBB:   { title:'Intentional Walks',              body:'Context stat — common for sluggers with weak protection behind them.' },
  HBP:   { title:'Hit By Pitch',                   body:'Context stat — league leaders typically reach 15–25/yr.' },
  SAC:   { title:'Sacrifice Bunts + Flies',        body:'Context stat — lineup-role driven.' },
  // ── Batter power ──
  HR:    { title:'Home Runs',                      good:'35+ (slugger)', avg:'15 – 25', bad:'< 10',  note:'Elite: 45+ per season' },
  D2B:   { title:'Doubles',                        good:'≥ 35',     avg:'20 – 30', bad:'< 15' },
  D3B:   { title:'Triples (rare)',                 body:'Most players: 1–3/yr. 5+ indicates speed/gap power.' },
  XBH:   { title:'Extra-Base Hits (HR+2B+3B)',     good:'≥ 75',     avg:'45 – 55', bad:'< 30',  note:'Elite: 75+' },
  RBI:   { title:'Runs Batted In',                 good:'≥ 90',     avg:'60 – 80', bad:'< 40',  note:'Lineup-spot dependent · Elite: 100+' },
  SB:    { title:'Stolen Bases',                   good:'≥ 20',     avg:'5 – 10',  bad:'< 3',   note:'Elite: 30+' },
  // ── Batter Statcast ──
  XWOBA: { title:'xwOBA — quality-of-contact offense', good:'≥ .360', avg:'~ .320', bad:'≤ .300' },
  XBA:   { title:'xBA — expected BA from EV + LA',     good:'≥ .280', avg:'~ .245', bad:'≤ .220' },
  XSLG:  { title:'xSLG — expected SLG from EV + LA',   good:'≥ .480', avg:'~ .405', bad:'≤ .360' },
  BARREL_B:{ title:'Barrel Rate (optimal EV + LA)',    good:'≥ 10%',  avg:'~ 7%',   bad:'≤ 4%' },
  HH_B:  { title:'Hard-Hit Rate (95+ mph EV)',         good:'≥ 45%',  avg:'~ 38%',  bad:'≤ 35%' },
  EV_B:  { title:'Average Exit Velocity',              good:'≥ 92 mph', avg:'~ 88.5 mph', bad:'≤ 86 mph' },
  SWEET: { title:'Sweet-Spot % (8–32° launch angle)',  good:'≥ 40%',  avg:'~ 33%',  bad:'≤ 28%' },
  WHIFF_B:{ title:'Whiff Rate (whiffs ÷ swings)',      good:'≤ 20%',  avg:'~ 25%',  bad:'≥ 30%', note:'Lower is better' },
  GB_B:  { title:'Ground-Ball Rate',                   body:'League avg: ~43%. Higher GB = more singles, fewer XBH.' },
  FB_B:  { title:'Fly-Ball Rate',                      body:'League avg: ~36%. Higher FB = more HR potential but more outs.' },
  BATSPD:{ title:'Bat Speed (Statcast 2024+)',         good:'≥ 75 mph', avg:'~ 71 mph', bad:'≤ 68 mph' },
  SQDUP: { title:'Squared-Up % per Contact',           good:'≥ 22%',  avg:'~ 17%',  bad:'≤ 12%' },
  BLAST: { title:'Blast % — squared-up + fast swing',  good:'≥ 8%',   avg:'~ 5%',   bad:'≤ 3%' },
  // ── Pitcher Statcast (vs hitters) ──
  WHIFF_P:{ title:'Whiff Rate per Pitch',          good:'≥ 30%',     avg:'~ 25%',     bad:'≤ 20%',     note:'Higher is better for pitcher' },
  KPCT_P:{ title:'Strikeout Rate (K ÷ BF)',        good:'≥ 25%',     avg:'~ 22%',     bad:'≤ 18%',     note:'Elite: ≥ 30%' },
  PUTAWAY:{ title:'Put-Away % (K per 2-strike pitch)', good:'≥ 22%', avg:'~ 18%',     bad:'≤ 15%' },
  GB_P:  { title:'Ground-Ball Rate Induced',       good:'≥ 50%',     avg:'~ 43%',     bad:'≤ 38%',     note:'Higher = fewer XBH' },
  FB_P:  { title:'Fly-Ball Rate Induced',          body:'League avg: ~36%. Lower is better for pitcher.' },
  BARREL_VS:{ title:'Barrels Allowed',             good:'≤ 4%',      avg:'~ 7%',      bad:'≥ 10%',     note:'Lower is better' },
  HH_VS: { title:'Hard Contact Allowed (95+ mph)', good:'≤ 35%',     avg:'~ 38%',     bad:'≥ 45%' },
  EV_VS: { title:'Avg Exit Velo Allowed',          good:'≤ 86 mph',  avg:'~ 88.5 mph', bad:'≥ 92 mph' },
  XWOBA_VS:{ title:'xwOBA Against',                good:'≤ .300',    avg:'~ .320',    bad:'≥ .360' },
  XERA:  { title:'xERA — Expected ERA from EV/LA', good:'≤ 3.50',    avg:'~ 4.20',    bad:'≥ 5.00' },
  // ── Pitcher season ──
  ERA:   { title:'Earned Run Average (ER × 9 ÷ IP)', good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 5.00', note:'Ace: ≤ 3.00' },
  FIP:   { title:'FIP — Fielding-Independent Pitching', good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Strips defense/luck — better than ERA' },
  XFIP:  { title:'xFIP — FIP w/ league HR/FB rate',  good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Strips out HR luck' },
  SIERA: { title:'SIERA — Skill-Interactive ERA',    good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Most predictive ERA estimator' },
  WHIP:  { title:'Walks + Hits per IP',              good:'≤ 1.10', avg:'~ 1.30', bad:'≥ 1.40', note:'Elite: ≤ 1.00' },
  KBBPCT:{ title:'K-BB % — strikeout minus walk rate', good:'≥ 15%', avg:'~ 13%', bad:'≤ 8%',  note:'Strongest single-stat K predictor · Elite: ≥ 20%' },
  HR9:   { title:'Home Runs Allowed per 9 IP',       good:'≤ 0.90', avg:'~ 1.20', bad:'≥ 1.50' },
  BBPCT_P:{ title:'Walk Rate (BB ÷ BF)',             good:'≤ 6%',   avg:'~ 8.5%', bad:'≥ 10%' },
  IP:    { title:'Innings Pitched',                  body:'Counting stat — role-dependent (starter vs reliever).' },
  K9:    { title:'Strikeouts per 9 IP',              good:'≥ 9.0',  avg:'~ 8.5',  bad:'≤ 6.5', note:'Elite: ≥ 11.0' },
  GS:    { title:'Games Started',                    body:'Counting stat.' },
};
function pct(n,d){if(!n||!d||d===0)return'—';return((n/d)*100).toFixed(1)+'%';}
function renderStatsTab(){
  hide('stats-spinner');hide('stats-empty');
  if(S.playerName)document.getElementById('stats-card-header').textContent=`📊 ${S.playerName} · Advanced Stats 2026`;
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
const DEFAULT_WEIGHTS = {
  // Batter splits — adj = (ops − 0.750) × weight
  'vs LHP': 70, 'vs RHP': 70,
  'Home':   35, 'Away':   35,

  // Career matchup vs current pitcher — adj capped ±6
  'vs Pitcher (career)': 50,

  // Opposing pitcher headline metric — adj = (era − 4.00) × weight (one fires per game)
  'Pitcher SIERA': 4, 'Pitcher xFIP': 4, 'Pitcher FIP': 4, 'Pitcher ERA': 4,

  // Pitcher regression / quality flags (flat adj)
  'Unlucky Pitcher': -2, 'Lucky Pitcher':  2,
  'Elite K-BB%':     -4, 'Poor K-BB%':     3,
  'HR-prone':         3, 'HR Suppressor': -2,

  // Pitcher rest / workload (flat)
  'Short Rest': 3, 'Extra Rest': -2,
  'High Prev PC': 2, 'Bullpen Game': 7,

  // Batter plate discipline (flat)
  'BB%': 3, 'K%': -3,

  // Batter Statcast (single label used for both directions — weight scales magnitude symmetrically)
  'Whiff%': 3, 'xwOBA': 4, 'GB%': -2, 'FB%': 2,

  // Pitcher Statcast
  'Pitcher Whiff%': 3, 'Pitcher GB%': -2, 'xwOBA vs': 3,

  // Weather (Heat/Cold flat; wind uses mph-scaled coefficient inside add — weight=1 keeps default)
  'Heat': 4, 'Cold': -4,
  'Wind Out': 1, 'Wind In': -1,
  'Crosswind': -2, 'High Humidity': -1, 'Roof Closed': -2,

  // Park
  'Altitude': 8, 'Elevation': 3,
  'Hitter Park': 1, 'Pitcher Park': 1,

  // Travel
  'Red-Eye': -6, 'Same-Day Travel': -3,

  // Umpire (weight=1 means apply UMP_DB adj as-is)
  'Umpire': 1,

  // Lineup protection
  'Protection': 3,
};

// Storage keys
const GRADE_LOG_KEY = 'gradeLog_v1';
const FACTOR_PERF_KEY = 'factorPerf_v1';
const FACTOR_WEIGHTS_KEY = 'factorWeights_v1';
const PENDING_KEY = 'pendingPredictions_v1';

function getGradeLog()     { return JSON.parse(localStorage.getItem(GRADE_LOG_KEY)||'[]'); }
function getFactorPerf()   { return JSON.parse(localStorage.getItem(FACTOR_PERF_KEY)||'{}'); }
function getFactorWeights(){ return JSON.parse(localStorage.getItem(FACTOR_WEIGHTS_KEY)||JSON.stringify(DEFAULT_WEIGHTS)); }
function getPending()      { return JSON.parse(localStorage.getItem(PENDING_KEY)||'[]'); }

function saveGradeLog(d)     { localStorage.setItem(GRADE_LOG_KEY, JSON.stringify(d)); }
function saveFactorPerf(d)   { localStorage.setItem(FACTOR_PERF_KEY, JSON.stringify(d)); }
function saveFactorWeights(d){ localStorage.setItem(FACTOR_WEIGHTS_KEY, JSON.stringify(d)); }
function savePending(d)      { localStorage.setItem(PENDING_KEY, JSON.stringify(d)); }

// Called when Run Prediction fires — saves prediction to pending
function savePredictionForGrading(prediction, overridePlayerId = null) {
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
  // One card per player — replace any existing entry for this player regardless
  // of date. Coerce both sides to String to defeat legacy entries that stored
  // playerId as a number, which would otherwise duplicate via === mismatch.
  const existingIdx = pending.findIndex(p => String(p.playerId) === entry.playerId);
  if (existingIdx >= 0) pending[existingIdx] = entry;
  else pending.unshift(entry);
  savePending(pending.slice(0, 50)); // keep last 50 (7–8 players × ~6 days)
}

// One-time cleanup: legacy pending data may contain stale entries from before
// playerId types were normalized, leaving multiple cards per player. Keep the
// most recent (lowest array index since pending is newest-first) per playerId.
function dedupePending() {
  const pending = getPending();
  const seen = new Set();
  const cleaned = [];
  for (const entry of pending) {
    const key = String(entry.playerId ?? entry.playerName ?? entry.id);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(entry);
  }
  if (cleaned.length !== pending.length) {
    console.log(`[pending] removed ${pending.length - cleaned.length} duplicate(s)`);
    savePending(cleaned);
  }
}

// Fetch actual Carroll stats for a given date from MLB API
async function fetchActualStats(playerId, date) {
  // Convert YYYY-MM-DD to MM/DD/YYYY for MLB API date filter params
  const [y, m, d] = date.split('-');
  const mlbDate = `${m}/${d}/${y}`;
  const season = y || '2026';
  const res = await fetch(`/mlb/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&season=${season}&gameType=R&startDate=${mlbDate}&endDate=${mlbDate}`);
  const data = await res.json();
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
      if (!perf[f.label]) perf[f.label] = { fires: 0, hits: 0, totalPerf: 0 };
      perf[f.label].fires++;
      perf[f.label].totalPerf += (entry.grade.perfScore || 0);
      let factorPositive;
      if (typeof f.adj === 'number') {
        if (f.adj === 0) continue;
        factorPositive = f.adj > 0;
      } else {
        factorPositive = f.impact === 'positive';
      }
      if ((factorPositive && perfGood) || (!factorPositive && !perfGood)) perf[f.label].hits++;
    }
  }
  saveFactorPerf(perf);
}

// Remove a graded entry. Used when MLB API returns wrong stats or the user
// wants to redo a prediction from scratch.
function deleteGradeEntry(id) {
  if (!confirm('Remove this graded entry from the log? This also recomputes the factor-performance stats.')) return;
  const log = getGradeLog().filter(g => g.id !== id);
  saveGradeLog(log);
  _rebuildFactorPerf();
  renderGradePanel();
}

// Edit the actual-stats payload for a graded entry. Lets the user correct
// rows where MLB API returned wrong info (DH split miscounted, doubleheader
// games swapped, etc.). Re-runs gradePerformance and rebuilds factorPerf so
// the outcome label + Model Learning stats reflect the corrected values.
function editGradeEntry(id) {
  const log = getGradeLog();
  const entry = log.find(g => g.id === id);
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
  saveGradeLog(log);
  _rebuildFactorPerf();
  renderGradePanel();
}

// Grade a performance — returns outcome category
function gradePerformance(actual, predScore) {
  // wOBA-calibrated weights. TB captures hit quality without double-counting raw hits.
  // Walk ≈ 75% of a single → 15 pts vs 20 pts (1 TB). K is unambiguously negative.
  // Capped 0–100 so the chart Y axis works without separate normalization.
  const raw = (actual.totalBases * 20) + (actual.walks * 15)
            + (actual.runs * 5) + (actual.rbi * 5)
            - (actual.strikeOuts * 4);
  const perfScore = Math.max(0, Math.min(100, raw));
  const outcome = perfScore >= 65 ? 'great' : perfScore >= 40 ? 'good' : perfScore >= 15 ? 'avg' : 'poor';
  // Model accuracy: did high score predict good performance?
  const modelExpectedGood = predScore >= 60;
  const actuallyGood = perfScore >= 40;
  const modelAccurate = modelExpectedGood === actuallyGood;
  return { perfScore, outcome, modelAccurate, modelExpectedGood, actuallyGood };
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
    if (!perf[f.label]) perf[f.label] = { fires: 0, hits: 0, totalPerf: 0 };
    perf[f.label].fires++;
    perf[f.label].totalPerf += gradeResult.perfScore;
    let factorPositive;
    if (typeof f.adj === 'number') {
      if (f.adj === 0) return; // factor fired but didn't move the score — no hit either way
      factorPositive = f.adj > 0;
    } else {
      // Legacy entry without persisted adj — fall back to impact label
      factorPositive = f.impact === 'positive';
    }
    if ((factorPositive && perfGood) || (!factorPositive && !perfGood)) perf[f.label].hits++;
  });
  saveFactorPerf(perf);
  // Auto-adjust weights after 15+ graded games
  const log = getGradeLog();
  if (log.length >= 15) autoAdjustWeights(perf, log.length);
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
//   2. Continuous adjustment: 1 + (postRate - 0.5) * 0.6, capped at [0.7, 1.3].
//      No more cliffs at threshold boundaries.
//   3. Minimum 10 fires before any adjustment — even with shrinkage, <10 is noise.
function autoAdjustWeights(perf, gameCount) {
  const weights = getFactorWeights();
  const ALPHA = 20; // Beta(10,10) prior — neutral, modest strength
  Object.entries(perf).forEach(([factor, data]) => {
    if (data.fires < 10) return;
    const defaultW = DEFAULT_WEIGHTS[factor];
    if (!defaultW) return;
    const postRate = (data.hits + ALPHA / 2) / (data.fires + ALPHA);
    let mult = 1 + (postRate - 0.5) * 0.6;
    mult = Math.max(0.7, Math.min(1.3, mult));
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
  const log = getGradeLog();
  log.unshift({
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
  saveGradeLog(log.slice(0, 100));

  // Remove from pending
  savePending(pending.filter(p => p.id !== pendingId));
  renderGradePanel();
}

function clearGrades() {
  if (!confirm('Clear all graded games and reset model weights?')) return;
  localStorage.removeItem(GRADE_LOG_KEY);
  localStorage.removeItem(FACTOR_PERF_KEY);
  localStorage.removeItem(FACTOR_WEIGHTS_KEY);
  localStorage.removeItem(PENDING_KEY);
  renderGradePanel();
}

// ── Render grade panel ────────────────────────────────────────────────────────
async function renderGradePanel() {
  const pending = getPending().filter(p => !p.graded);
  const log = getGradeLog();
  const perf = getFactorPerf();
  const weights = getFactorWeights();

  // Confidence indicator
  const confidence = log.length >= 30 ? 'High confidence' : log.length >= 15 ? 'Building confidence' : log.length >= 5 ? 'Early data' : 'Insufficient data';
  const confColor = log.length >= 30 ? '#2ecc71' : log.length >= 15 ? '#a8e063' : log.length >= 5 ? '#f39c12' : '#999';
  document.getElementById('grade-confidence').textContent = `${log.length} games graded · ${confidence}`;
  document.getElementById('grade-confidence').style.color = confColor;

  // Pending predictions
  const pendingEl = document.getElementById('grade-pending-list');
  const pendingEmpty = document.getElementById('grade-pending-empty');
  if (pending.length === 0) {
    show('grade-pending-empty'); pendingEl.innerHTML = '';
  } else {
    hide('grade-pending-empty');
    pendingEl.innerHTML = '';
    for (const pred of pending) {
      const div = document.createElement('div');
      div.className = 'grade-game-card';
      div.id = `grade-card-${pred.id}`;

      const posFactors = pred.factors.filter(f => f.impact === 'positive').slice(0, 3).map(f => f.label).join(', ');
      const negFactors = pred.factors.filter(f => f.impact === 'negative').slice(0, 2).map(f => f.label).join(', ');

      div.innerHTML = `
        <div class="gg-header">
          <div>
            <div class="gg-title">${pred.date} · Full Game · ${pred.pitcherName||'Unknown'} (SP)</div>
            <div style="font-size:10px;color:#999;font-family:\'Chakra Petch\',monospace;margin-top:3px;">${pred.playerName}</div>
          </div>
          <div class="gg-score">${pred.score}</div>
        </div>
        <div class="gg-factors">
          ${posFactors ? `✅ ${posFactors}` : ''}
          ${negFactors ? `<br>⚠️ ${negFactors}` : ''}
        </div>
        <div class="gg-stat-line" id="stats-${pred.id}">
          ${['H','TB','HR','BB','K','RBI'].map(s => `<div class="grade-stat"><div class="gs-label">${s}</div><div class="gs-val loading" id="stat-${pred.id}-${s}">...</div></div>`).join('')}
        </div>
        <div style="display:flex;gap:8px;align-items:center;" id="grade-actions-${pred.id}">
          <button class="grade-btn confirm" onclick="autoGrade(${pred.id}, '${pred.playerId}', '${pred.date}')">⟳ Fetch & Grade</button>
          <span style="font-size:10px;color:#777;font-family:\'Chakra Petch\',monospace;">Fetches actual stats from MLB API</span>
        </div>`;
      pendingEl.appendChild(div);
    }
  }

  // Factor performance
  const perfEntries = Object.entries(perf).filter(([,d]) => d.fires >= 3);
  if (perfEntries.length < 3 || log.length < 5) {
    hide('grade-learning-content'); show('grade-learning-empty');
  } else {
    hide('grade-learning-empty'); show('grade-learning-content');
    const sorted = perfEntries.sort(([,a],[,b]) => (b.hits/b.fires) - (a.hits/a.fires));
    document.getElementById('factor-performance-list').innerHTML = sorted.map(([factor, data]) => {
      const hitRate = data.hits / data.fires;
      const pct = Math.round(hitRate * 100);
      const color = pct >= 65 ? '#2ecc71' : pct >= 45 ? '#f39c12' : '#e74c3c';
      const currentW = weights[factor] || DEFAULT_WEIGHTS[factor] || 0;
      const defaultW = DEFAULT_WEIGHTS[factor] || 0;
      const wDiff = currentW !== defaultW ? ` (${currentW > defaultW ? '+' : ''}${(((currentW-defaultW)/Math.abs(defaultW||1))*100).toFixed(0)}%)` : '';
      return `<div class="factor-perf-row">
        <span class="factor-perf-name">${factor}</span>
        <span class="factor-perf-rate" style="color:${color}">${pct}% (${data.hits}/${data.fires})</span>
        <div class="factor-perf-bar-wrap"><div class="factor-perf-bar" style="width:${pct}%;background:${color}"></div></div>
        <span class="factor-perf-weight" style="color:${wDiff?color:'#999'}">w:${currentW}${wDiff}</span>
      </div>`;
    }).join('');
  }

  // Chart
  if (log.length >= 3) {
    hide('grade-chart-empty'); show('grade-chart');
    drawPerfChart(log);
  }

  // Grade log
  if (log.length === 0) {
    show('grade-log-empty');
    hide('grade-log-headers');
    document.getElementById('grade-log').innerHTML = '';
  } else {
    hide('grade-log-empty');
    document.getElementById('grade-log-headers').classList.remove('hidden');
    const outcomeLabels = { great:'🔥 Great', good:'✅ Good', avg:'😐 Average', poor:'❌ Poor' };
    document.getElementById('grade-log').innerHTML = log.map(g => {
      // Recompute on render so historical entries always reflect the current formula.
      // Stored g.grade.perfScore is frozen at grade time and may be stale after a formula tweak.
      const live = gradePerformance(g.actual, g.score);
      const modelLabel = live.modelAccurate ? 'Accurate' : 'Off';
      const modelClass = live.modelAccurate ? 'accurate' : 'off';
      const playerLast = g.playerName ? g.playerName.split(' ').pop() : '—';
      return `<div class="grade-log-row">
        <span style="color:#888;font-family:\'Chakra Petch\',monospace;font-size:11px;">${g.date}</span>
        <span style="font-family:\'Chakra Petch\',monospace;font-size:13px;font-weight:800;color:#A71930;">${g.score}</span>
        <span style="color:#aaa;font-family:\'Chakra Petch\',monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${playerLast}</span>
        <span style="color:#ccc;font-family:\'Chakra Petch\',monospace;font-size:11px;">${g.actual.summary||`${g.actual.hits}H ${g.actual.totalBases}TB`}</span>
        <span style="color:#888;font-family:\'Chakra Petch\',monospace;font-size:11px;" title="Performance score">${live.perfScore}</span>
        <span class="outcome-badge ${live.outcome}">${outcomeLabels[live.outcome]||live.outcome}</span>
        <span class="model-badge ${modelClass}">${modelLabel}</span>
        <span class="grade-row-actions">
          <button class="grade-row-edit" onclick="editGradeEntry(${g.id})" title="Edit stats (MLB API correction)">✎</button>
          <button class="grade-row-del" onclick="deleteGradeEntry(${g.id})" title="Remove from log">×</button>
        </span>
      </div>`;
    }).join('');
  }
}

async function autoGrade(predId, playerId, date) {
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
          <button class="grade-btn remove-btn" style="background:#2a1a1a;color:#e74c3c;border:1px solid #e74c3c;" onclick="removePending(${predId})">✕ Remove (didn't play)</button>
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

function removePending(predId) {
  savePending(getPending().filter(p => p.id !== predId));
  renderGradePanel();
}

function drawPerfChart(log) {
  const canvas = document.getElementById('perf-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const recent = log.slice(0, 20).reverse();
  if (recent.length < 2) return;

  const pad = { l: 40, r: 20, t: 20, b: 30 };
  const chartW = W - pad.l - pad.r;
  const chartH = H - pad.t - pad.b;

  // Grid
  ctx.strokeStyle = '#1a1730'; ctx.lineWidth = 1;
  [0, 25, 50, 75, 100].forEach(v => {
    const y = pad.t + chartH - (v / 100) * chartH;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#777'; ctx.font = "9px 'Chakra Petch', monospace"; ctx.fillText(v, 4, y + 3);
  });

  const xStep = chartW / (recent.length - 1);

  // Recompute perfScore on render so the chart always reflects the current formula
  // (stored values may be frozen from earlier formula versions).
  const points = recent.map(g => ({ ...g, livePerf: gradePerformance(g.actual, g.score).perfScore }));

  // Actual performance line — perfScore is already capped 0-100 by gradePerformance
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (g.livePerf / 100) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Prediction score line
  ctx.strokeStyle = '#A71930'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath();
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (g.score / 100) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);

  // Dots + dates
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const py = pad.t + chartH - (g.livePerf / 100) * chartH;
    ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(x, py, 3, 0, Math.PI*2); ctx.fill();
    if (i % 3 === 0) {
      ctx.fillStyle = '#777'; ctx.font = "8px 'Chakra Petch', monospace";
      ctx.fillText(g.date.slice(5), x - 10, H - 8);
    }
  });

  // Legend
  ctx.fillStyle = '#2ecc71'; ctx.fillRect(pad.l, 8, 12, 3);
  ctx.fillStyle = '#888'; ctx.font = "10px 'Chakra Petch', monospace"; ctx.fillText('Actual', pad.l + 16, 12);
  ctx.fillStyle = '#A71930'; ctx.fillRect(pad.l + 70, 8, 12, 3);
  ctx.fillStyle = '#888'; ctx.fillText('Predicted', pad.l + 86, 12);
}

// ═══════════ STATCAST ════════════════════════════════════════════════════════
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  function splitCSVLine(line) {
    const result = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  }

  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/"/g, '').trim(); });
    return obj;
  });
}

async function loadStatcast(playerId) {
  document.getElementById('stat-statcast').innerHTML = '<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Loading Statcast data...</div>';
  try {
    const [statRes, expRes, batRes, arsenalRes, battedRes] = await Promise.all([
      fetch('/savant/statcast?type=batter&year=2026'),
      fetch('/savant/expected?type=batter&year=2026'),
      fetch('/savant/battracking?year=2026'),
      fetch('/savant/batter-arsenal?year=2026'),
      fetch('/savant/batted-ball?year=2026'),
    ]);
    const [statText, expText, batText, arsenalText, battedText] = await Promise.all([
      statRes.text(), expRes.text(), batRes.text(), arsenalRes.text(), battedRes.text()
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

    const fmt=(v,d,suffix='')=>v!=null?v.toFixed(d)+suffix:'—';
    const fmtPct=(v,d=1)=>fmt(v,d,'%');

    const xwoba   = fmt(xwobaRaw,3);
    const xba     = fmt(xbaRaw,3);
    const xslg    = fmt(xslgRaw,3);
    const brl     = fmtPct(brlRaw);
    const hhRate  = fmtPct(hhRaw);
    const avgEV   = avgEVRaw!=null?avgEVRaw.toFixed(1)+' mph':'—';
    const sweetSp = fmtPct(sweetSpRaw);
    const whiff   = fmtPct(whiffRaw);
    const batSpd  = batSpdRaw!=null?batSpdRaw.toFixed(1)+' mph':'—';
    const swLen   = swLenRaw!=null?swLenRaw.toFixed(1)+' ft':'—';
    const sqdUp   = fmtPct(sqdUpRaw);
    const blast   = fmtPct(blastRaw);

    const c=(v,good,bad,invert=false)=>{
      if(v==null)return '';
      return (invert?(v<=bad?'good':v>=good?'bad':''):(v>=good?'good':v<=bad?'bad':''));
    };

    const gb    = fmtPct(gbRaw);
    const fb    = fmtPct(fbRaw);

    document.getElementById('stat-statcast').innerHTML = [
      statBox('xwOBA',   xwoba,  'Expected weighted OBA',        c(xwobaRaw,0.360,0.300), STAT_INFO.XWOBA),
      statBox('xBA',     xba,    'Expected batting average',     c(xbaRaw,0.280,0.220),   STAT_INFO.XBA),
      statBox('xSLG',    xslg,   'Expected slugging %',          c(xslgRaw,0.480,0.360),  STAT_INFO.XSLG),
      statBox('Barrel%', brl,    'Barrel rate',                  c(brlRaw,10,4),          STAT_INFO.BARREL_B),
      statBox('HH Rate', hhRate, 'Hard-hit rate (95+ mph EV)',   c(hhRaw,45,35),          STAT_INFO.HH_B),
      statBox('Avg EV',  avgEV,  'Avg exit velocity',            c(avgEVRaw,92,86),       STAT_INFO.EV_B),
      statBox('Sweet Sp%',sweetSp,'Sweet spot contact %',        c(sweetSpRaw,40,28),     STAT_INFO.SWEET),
      statBox('Whiff%',  whiff,  'Whiff rate per swing',         c(whiffRaw,30,20,true),  STAT_INFO.WHIFF_B),
      statBox('GB%',     gb,     'Ground ball rate',             '',                      STAT_INFO.GB_B),
      statBox('FB%',     fb,     'Fly ball rate',                '',                      STAT_INFO.FB_B),
      statBox('Bat Spd', batSpd, 'Avg bat speed',                c(batSpdRaw,75,68),      STAT_INFO.BATSPD),
      statBox('Sw Len',  swLen,  '',  '',  { title:'Swing Length (feet)', body:'Tradeoff stat — not categorically good or bad. <6.8: pure contact (Arraez). 6.8 – 7.5: balanced / league avg. 7.5 – 8.0: power-leaning. >8.0: elite power, high K (Judge).' }),
      statBox('Sqd Up%', sqdUp,  'Squared-up per contact',       c(sqdUpRaw,22,12),       STAT_INFO.SQDUP),
      statBox('Blast%',  blast,  'Blast per contact',            c(blastRaw,8,3),         STAT_INFO.BLAST),
    ].join('');

    S.statcast = {
      xwoba: xwobaRaw, xba: xbaRaw, xslg: xslgRaw,
      brl: brlRaw, hhRate: hhRaw, avgEV: avgEVRaw,
      sweetSpot: sweetSpRaw, gb: gbRaw, fb: fbRaw,
      whiff: whiffRaw, batSpeed: batSpdRaw,
      swingLength: swLenRaw, squaredUp: sqdUpRaw, blast: blastRaw,
    };

  } catch(e) {
    document.getElementById('stat-statcast').innerHTML = `<div style="font-size:11px;color:#777;font-family:\'Chakra Petch\',monospace;grid-column:span 3;">Statcast data unavailable: ${e.message}</div>`;
  }
}

// ═══════════ AUTO-GRADE PENDING BETS ══════════════════════════════════════════
// Walks S.betLog for entries with result===null and a past game date, fetches
// the actual MLB game log for the (player, date), and grades the bet against
// its prop line. Bets without a propKey (legacy entries from before the field
// was stored) are left untouched.

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

async function autoGradeBetLog(){
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
    renderRecord();
  }
  btns.forEach(b=>{b.textContent='⟳ Grade';b.disabled=false;});
  alert(`Auto-grade complete\n· Graded: ${graded}\n· Skipped (no game/0 PA/missing data): ${skipped}${errors?`\n· Errors: ${errors}`:''}`);
}

// ═══════════ CROSS-DEVICE SYNC ════════════════════════════════════════════════

const SYNC_KEY_STORAGE = 'corbetSyncKey';
const SYNC_LAST_TS_KEY = 'corbetLastSync';

function _getSyncKey(){ return localStorage.getItem(SYNC_KEY_STORAGE)||''; }
function _setSyncKey(k){ localStorage.setItem(SYNC_KEY_STORAGE,k); }

// Touch-primary input on a narrow viewport → treat as the phone in the user's
// hand. Desktop pushes (authoritative); mobile pulls (overwritten by server).
function _isMobileDevice(){
  return window.matchMedia('(pointer: coarse) and (max-width: 768px)').matches;
}
function _syncDirection(){ return _isMobileDevice() ? 'pull' : 'push'; }
function _syncIdleLabel(){ return _isMobileDevice() ? '↓ Pull' : '↑ Push'; }

function _setSyncBtnState(text,disabled){
  document.querySelectorAll('.sync-btn').forEach(btn=>{
    btn.textContent=text;
    btn.disabled=disabled;
  });
}

// Set button text on init so the user sees what direction tap will trigger.
function _initSyncBtnLabel(){
  _setSyncBtnState(_syncIdleLabel(), false);
}

async function syncRecord(){
  let key=_getSyncKey();
  if(!key){
    key=(prompt('Enter your sync passphrase (must match SYNC_KEY on Railway):')||'').trim();
    if(!key)return;
    _setSyncKey(key);
  }
  const direction=_syncDirection();
  _setSyncBtnState(direction==='push'?'⟳ Pushing…':'⟳ Pulling…',true);
  try{
    if(direction==='pull'){
      // MOBILE: overwrite local with server state. Anything edited on this
      // device since the last desktop push is discarded — by design.
      const res=await fetch('/api/sync',{headers:{'X-Sync-Key':key}});
      if(!res.ok){
        if(res.status===401){
          _setSyncKey('');
          _setSyncBtnState(_syncIdleLabel(),false);
          alert('Wrong passphrase — cleared. Tap Pull again to re-enter.');
          return;
        }
        const body=await res.json().catch(()=>({}));
        throw new Error(body.error||`Server ${res.status}`);
      }
      const remote=await res.json();
      S.betLog=remote.betLog||[];
      localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
      saveGradeLog(remote.gradeLog||[]);
      saveFactorPerf(remote.factorPerf||{});
      saveFactorWeights(remote.factorWeights||{});
      savePending(remote.pending||[]);
    } else {
      // DESKTOP: overwrite server with local state. Desktop is the source of
      // truth — next time mobile pulls, it'll match what's here.
      const payload={
        betLog:S.betLog,
        gradeLog:getGradeLog(),
        factorPerf:getFactorPerf(),
        factorWeights:getFactorWeights(),
        pending:getPending(),
      };
      const res=await fetch('/api/sync',{
        method:'POST',
        headers:{'Content-Type':'application/json','X-Sync-Key':key},
        body:JSON.stringify(payload),
      });
      if(!res.ok){
        if(res.status===401){
          _setSyncKey('');
          _setSyncBtnState(_syncIdleLabel(),false);
          alert('Wrong passphrase — cleared. Tap Push again to re-enter.');
          return;
        }
        throw new Error(`Server ${res.status}`);
      }
    }
    localStorage.setItem(SYNC_LAST_TS_KEY,new Date().toISOString());
    renderRecord();
    renderGradePanel();
    const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    _setSyncBtnState(`✓ ${t}`,false);
  }catch(err){
    console.error('[sync]',err);
    _setSyncBtnState(_syncIdleLabel(),false);
    alert('Sync failed: '+err.message);
  }
}

// ═══════════ WEB PUSH NOTIFICATIONS ═══════════════════════════════════════════
// iOS requires the app to be installed to the home screen first (PWA). On the
// home-screen instance, the user can grant notification permission and we
// register a push subscription with the server.

function _isStandalonePWA(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
}

function _urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}

async function registerSW(){
  if(!('serviceWorker'in navigator))return null;
  try{
    const reg=await navigator.serviceWorker.register('/sw.js');
    return reg;
  }catch(e){console.warn('[push] SW register failed:',e);return null;}
}

async function _pushSubscribe(){
  const btn=document.getElementById('push-btn');
  const setBtn=(t)=>{if(btn)btn.textContent=t;};

  if(!('serviceWorker'in navigator)||!('PushManager'in window)){
    alert('This browser doesn’t support web push. On iPhone, open in Safari, tap Share → Add to Home Screen, then open the app from the home screen.');
    return;
  }
  // iOS Safari requires the app to be running as an installed PWA before push works
  if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!_isStandalonePWA()){
    alert('To enable notifications on iPhone:\n1. Tap the Share icon\n2. Tap "Add to Home Screen"\n3. Open Snake Savant from your home screen\n4. Tap this button again');
    return;
  }

  let key=_getSyncKey();
  if(!key){
    key=(prompt('Enter your sync passphrase (must match SYNC_KEY on Railway):')||'').trim();
    if(!key)return;
    _setSyncKey(key);
  }

  setBtn('⟳ Subscribing…');
  try{
    // 1. Permission
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){
      setBtn('🔔 Enable notifications');
      alert('Notification permission denied. Enable in Settings → Safari → Notifications.');
      return;
    }

    // 2. Pull VAPID public key from server
    const pkRes=await fetch('/api/push/public-key');
    if(!pkRes.ok)throw new Error('VAPID key fetch failed');
    const {publicKey}=await pkRes.json();

    // 3. Register service worker, subscribe
    const reg=await registerSW();
    if(!reg)throw new Error('Service worker registration failed');
    await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:_urlBase64ToUint8Array(publicKey),
      });
    }

    // 4. Send subscription to server
    const postRes=await fetch('/api/push/subscribe',{
      method:'POST',
      headers:{'Content-Type':'application/json','X-Sync-Key':key},
      body:JSON.stringify(sub.toJSON()),
    });
    if(!postRes.ok){
      if(postRes.status===401){alert('Wrong sync passphrase.');_setSyncKey('');setBtn('🔔 Enable notifications');return;}
      throw new Error(`Server ${postRes.status}`);
    }
    localStorage.setItem('pushSubscribed','1');
    setBtn('✓ Notifications on');
  }catch(err){
    console.error('[push]',err);
    setBtn('🔔 Enable notifications');
    alert('Subscribe failed: '+err.message);
  }
}

async function _pushTest(){
  const key=_getSyncKey();
  if(!key){alert('Set sync passphrase first via the Sync button.');return;}
  try{
    const res=await fetch('/api/push/test',{method:'POST',headers:{'X-Sync-Key':key}});
    if(!res.ok)throw new Error(`Server ${res.status}`);
    const j=await res.json();
    alert(j.sent>0?`Sent ${j.sent} test notification${j.sent>1?'s':''}.`:'No subscriptions yet — tap Enable first.');
  }catch(err){alert('Test failed: '+err.message);}
}

function _initPushBtn(){
  const btn=document.getElementById('push-btn');
  if(!btn)return;
  if(localStorage.getItem('pushSubscribed')==='1'&&Notification.permission==='granted'){
    btn.textContent='✓ Notifications on';
  }
}

// ═══════════ UTILS ════════════════════════════════════════════════════════════
function show(id){document.getElementById(id)?.classList.remove('hidden');}
function hide(id){document.getElementById(id)?.classList.add('hidden');}
function setText(id,t){const el=document.getElementById(id);if(el)el.textContent=t;}

// ── Soft-market tooltip (fixed-position, avoids stacking-context issues on mobile) ──
(function(){
  let tip=null, activeEl=null;
  function getOrCreate(){
    if(!tip){tip=document.createElement('div');tip.id='soft-market-tip';document.body.appendChild(tip);}
    return tip;
  }
  function show(el){
    const t=getOrCreate();
    t.textContent=el.dataset.tip;
    // Position above the badge, clamped to viewport edges
    const r=el.getBoundingClientRect();
    const w=Math.min(260,window.innerWidth-24);
    t.style.width=w+'px';
    let left=r.left+r.width/2-w/2;
    left=Math.max(12,Math.min(left,window.innerWidth-w-12));
    const top=r.top-8; // will be shifted up by the element's own height via transform
    t.style.left=left+'px';
    t.style.top=(r.top+window.scrollY)+'px';
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
    const badge=e.target.closest('.dpb-soft-market[data-tip]');
    if(badge){
      e.stopPropagation();
      if(activeEl===badge&&!hoverShown){dismiss();}
      else{show(badge);hoverShown=false;}
      return;
    }
    if(activeEl)dismiss();
  },true);
  document.addEventListener('mouseover',function(e){
    const badge=e.target.closest('.dpb-soft-market[data-tip]');
    if(!badge||activeEl===badge)return;
    show(badge);
    hoverShown=true;
  });
  document.addEventListener('mouseout',function(e){
    if(!hoverShown||!activeEl)return;
    const badge=e.target.closest('.dpb-soft-market[data-tip]');
    if(badge!==activeEl)return;
    // Ignore mouseout into a child element of the badge
    if(badge.contains(e.relatedTarget))return;
    dismiss();
    hoverShown=false;
  });
  document.addEventListener('scroll',()=>{dismiss();hoverShown=false;},{passive:true,capture:true});
})();

// ═══════════ INIT ══════════════════════════════════════════════════════════════
document.getElementById('game-date').value=new Date().toISOString().split('T')[0]; // fallback until API responds
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
