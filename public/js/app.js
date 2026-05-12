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
  betLog: (()=>{
    const log=JSON.parse(localStorage.getItem('corbetRecord')||'[]');
    // Repair any duplicate IDs from a prior bug where autoSaveTopBets used the same Date.now() timestamp
    const seen=new Set();
    let repaired=false;
    log.forEach((b,i)=>{
      if(seen.has(b.id)){b.id=Date.now()+i;repaired=true;}
      seen.add(b.id);
    });
    if(repaired)localStorage.setItem('corbetRecord',JSON.stringify(log));
    return log;
  })(),
};

const CORBET_ROSTER = [
  { name: 'Corbin Carroll',   id: '682998' },
  { name: 'Ketel Marte',      id: '660162' },
  { name: 'Gabriel Moreno',   id: '668804' },
  { name: 'Geraldo Perdomo',  id: '669701' },
  { name: 'Ildemaro Vargas',  id: '545121' },
  { name: 'Lourdes Gurriel',  id: '666971' },
  { name: 'Nolan Arenado',    id: '680776' },
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
function gaussianRandom(mean, std) {
  const u1 = Math.random() || 1e-10, u2 = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Half-Kelly fraction (0–1 range; 0 means no bet)
function kellyFraction(modelProb, odds) {
  if (!odds) return 0;
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const p = modelProb / 100, q = 1 - p;
  return Math.max(0, (b * p - q) / b) * 0.125;
}

// Monte Carlo confidence: % of noisy-score simulations where the edge holds
// Requires S player fields to be swapped in before calling (same window as generateCorbetBets)
function monteCarloConfidence(propKey, line, score, marketOverProb, direction = 'Over', N = 2000) {
  let edgeCount = 0;
  const isUnder = String(direction).toLowerCase() === 'under';
  for (let i = 0; i < N; i++) {
    const ns = Math.max(4, Math.min(96, gaussianRandom(score, 6)));
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
  const saved = {
    playerName: S.playerName, splits: S.splits, seasonStat: S.seasonStat,
    rispStat: S.rispStat, statcast: S.statcast, recentGameLog: S.recentGameLog,
    matchupStats: S.matchupStats, lastScore: S.lastScore
  };
  S.playerName = p.name; S.splits = p.splits; S.seasonStat = p.seasonStat;
  S.rispStat = p.rispStat; S.statcast = p.statcast;
  S.recentGameLog = p.recentGameLog; S.matchupStats = p.matchupStats;
  S.lastScore = p.score;
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
    const savedAll = S.allPlayerBets;
    S.allPlayerBets = playerBets;
    hide('corbet-no-prediction'); hide('corbet-loading'); hide('corbet-player-filter');
    renderCorbetBets();
    show('corbet-bets');
    S.allPlayerBets = savedAll;
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
function buildPitchMixGrid(cid,pitches){document.getElementById(cid).innerHTML=PITCH_TYPES.map(pt=>`<div class="pitch-mix-item"><span class="pitch-mix-label">${pt}</span><input type="range" min="0" max="60" value="${pitches[pt]||0}" oninput="S.pitcherPitches['${pt}']=parseInt(this.value);this.nextElementSibling.textContent=this.value+'%'" style="flex:1;accent-color:#A71930"><span style="font-size:11px;color:#ccc;font-family:monospace;min-width:28px;text-align:right">${pitches[pt]||0}%</span></div>`).join('');}
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
    (sd?.stats?.[0]?.splits??[]).forEach(s=>{if(s.split?.code)byCode[s.split.code]={ops:parseFloat(s.stat.ops)||null,avg:s.stat.avg,obp:s.stat.obp,slg:s.stat.slg,gp:s.stat.gamesPlayed,hr:s.stat.homeRuns,rbi:s.stat.rbi};});
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
      <div style="font-size:10px;color:#2ecc71;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Key Drivers</div>
      ${drivers.map(f=>`
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#2ecc71;font-weight:700;font-size:12px;font-family:monospace;">${f.label}</span>
            <span style="color:#888;font-size:11px;margin-left:5px;">${f.value}</span>
          </div>
          <div style="color:#aaa;font-size:11px;text-align:right;">${f.note}</div>
        </div>`).join('')}
    </div>`:''

  // ── HEADWINDS ────────────────────────────────────────────────────────────
  const headwindsHTML=headwinds.length?`
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#e74c3c;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Key Headwinds</div>
      ${headwinds.map(f=>`
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#e74c3c;font-weight:700;font-size:12px;font-family:monospace;">${f.label}</span>
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
      <div style="font-size:10px;color:#a855f7;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Pitcher Read — ${pn} (${hand}HP)</div>
      ${pitcherLines.map(l=>`<div style="font-size:12px;color:#bbb;padding:5px 0;border-bottom:1px solid #0e0c22;line-height:1.5;">${l}</div>`).join('')}
    </div>`:''

  // ── CAREER MATCHUP ───────────────────────────────────────────────────────
  let matchupHTML='';
  const mu=S.matchupStats;
  if(!mu||mu.ab===0){
    matchupHTML=`
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Career vs. ${pitcherLast}</div>
        <div style="font-size:12px;color:#777;font-family:monospace;">${lastName} has no recorded plate appearances vs. ${pitcherLast} — first-time matchup. Prediction relies on season-level and Statcast metrics.</div>
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
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Career vs. ${pitcherLast} · ${mu.ab} AB</div>
        <div style="display:flex;gap:14px;margin-bottom:8px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:monospace;color:${opsColor};">${mu.ops.toFixed(3)}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">OPS</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:monospace;color:#ccc;">${mu.avg}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:monospace;color:${(mu.hr||0)>0?'#A71930':'#ccc'};">${mu.hr||0}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:monospace;color:#ccc;">${mu.k||0}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:monospace;color:#ccc;">${mu.bb||0}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">BB</div></div>
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
        <div style="font-size:10px;font-weight:700;font-family:monospace;color:${fg};white-space:nowrap;">${lbl}</div>
        <div style="font-size:8px;color:#555;font-family:monospace;white-space:nowrap;">${dateShort}</div>
      </div>`;
    }).join('');

    recentHTML=`
      <div style="margin-bottom:4px;">
        <div style="font-size:10px;color:#38bdf8;letter-spacing:1.5px;text-transform:uppercase;font-family:monospace;margin-bottom:8px;">Last ${n} Games</div>
        <div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${avg10}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${totalH}/${totalAB}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">H/AB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:${totalHR>0?'#60a5fa':'#ccc'};">${totalHR}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${totalRBI}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">RBI</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${totalBB}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">BB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${totalK}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:monospace;color:#ccc;">${multiHit}</div><div style="font-size:9px;color:#666;font-family:monospace;margin-top:2px;">2H+</div></div>
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
    }catch{hide('pitcher-search-results');}
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
    S.pitcher={id,name,hand,st,last3,daysRest,lastOuting,bullpenGame};
    const era=parseFloat(st.era)||null;
    const whip=parseFloat(st.whip)||null;
    const ip=st.inningsPitched||'—';
    const pa=st.battersFaced||1;
    const kPct=st.strikeOuts?((st.strikeOuts/pa)*100).toFixed(1)+'%':'—';
    const bbPct=st.baseOnBalls?((st.baseOnBalls/pa)*100).toFixed(1)+'%':'—';
    const k9=st.strikeOuts&&st.inningsPitched?((st.strikeOuts/parseFloat(st.inningsPitched))*9).toFixed(1):'—';
    const fip=era?(era*0.92).toFixed(2):'—';
    document.getElementById('pitcher-hand-badge').textContent=`${hand}HP · ${name}`;
    document.getElementById('pitcher-loaded').innerHTML=`<div class="pitcher-loaded"><div class="pl-hand">Throws ${hand==='L'?'Left':'Right'}</div><div class="pl-name">${name}</div><div class="pl-stats"><span>ERA <strong>${era?era.toFixed(2):'—'}</strong></span><span>FIP <strong>${fip}</strong></span><span>WHIP <strong>${whip?whip.toFixed(2):'—'}</strong></span><span>K% <strong>${kPct}</strong></span><span>BB% <strong>${bbPct}</strong></span><span>K/9 <strong>${k9}</strong></span><span>Days Rest <strong>${daysRest}</strong></span>${lastOuting?`<span>Last PC <strong>${lastOuting.numberOfPitches||'—'}</strong></span>`:''}</div></div>`;
    show('pitcher-loaded');
    const mix=hand==='L'?{'4-Seam FB':35,'Sinker':5,'Cutter':10,'Slider':20,'Curveball':10,'Changeup':15,'Splitter':5}:{'4-Seam FB':35,'Sinker':10,'Cutter':8,'Slider':22,'Curveball':10,'Changeup':12,'Splitter':3};
    Object.assign(S.pitcherPitches,mix);
    buildPitchMixGrid('pitch-mix-grid',S.pitcherPitches);
    show('pitcher-pitch-mix');
    renderPitcherTab(st,last3,daysRest,lastOuting,hand,name,fip,k9,kPct,bbPct,era,whip,ip);
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

function renderPitcherTab(st,last3,daysRest,lastOuting,hand,name,fip,k9,kPct,bbPct,era,whip,ip){
  hide('pitcher-tab-empty');show('pitcher-tab-content');
  document.getElementById('pitcher-tab-header').textContent=`📋 ${name} · Pitcher Analysis`;
  const eraC=era<3.25?'good':era>5.0?'bad':'';
  const whipC=whip<1.1?'good':whip>1.4?'bad':'';
  document.getElementById('pt-season').innerHTML=[['ERA',era?parseFloat(era).toFixed(2):'—',eraC,'Earned run average'],['FIP',fip,'','Fielding independent pitching'],['WHIP',whip?parseFloat(whip).toFixed(2):'—',whipC,'Walks + hits per IP'],['K%',kPct,parseFloat(kPct)>=25?'good':'','Strikeout rate'],['BB%',bbPct,parseFloat(bbPct)<=6?'good':parseFloat(bbPct)>=10?'bad':'','Walk rate'],['IP',ip,'','Innings pitched'],['K/9',k9,'','Strikeouts per 9'],['GS',st.gamesStarted||'—','','Games started']].map(([l,v,c,ctx])=>`<div class="stat-box"><div class="stat-label">${l}</div><div class="stat-val${c?' '+c:''}">${v}</div><div class="stat-context">${ctx}</div></div>`).join('');
  document.getElementById('pt-pitchmix').innerHTML=PITCH_TYPES.map(pt=>{const p=S.pitcherPitches[pt]||0;if(!p)return'';return`<div class="pitch-row"><span class="pitch-label">${pt}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${p}%;background:${p>35?'#A71930':'#3a3560'}"></div></div><span class="pitch-pct">${p}%</span></div>`;}).join('');
  document.getElementById('pt-recent').innerHTML=last3.length?last3.map(g=>`<div style="padding:4px 0;border-bottom:1px solid #0e0c22;">${g.date} — ${g.stat.inningsPitched}IP, ${g.stat.hits}H, ${g.stat.earnedRuns}ER, ${g.stat.strikeOuts}K <span style="color:#999;margin-left:8px;">${g.stat.numberOfPitches||'—'} pitches</span></div>`).join(''):'<span style="color:#777;">No recent game log available.</span>';
  document.getElementById('pt-workload').innerHTML=`<div>Days since last outing: <strong style="color:#ccc;">${daysRest}</strong></div>${lastOuting?`<div>Last outing pitch count: <strong style="color:#ccc;">${lastOuting.numberOfPitches||'—'}</strong></div>`:''}${daysRest!=='—'&&daysRest<4?'<div style="color:#e74c3c;margin-top:4px;">⚠ Short rest — possible fatigue factor</div>':''}${daysRest!=='—'&&daysRest>=5?'<div style="color:#2ecc71;margin-top:4px;">✓ Well-rested</div>':''}`;
}

async function loadPitcherStatcast(pitcherId){
  const el=document.getElementById('pt-statcast');
  if(!el)return;
  el.innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">Loading pitcher Statcast...</div>';
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
    const [scRes,expRes,cswRes]=await Promise.allSettled([
      fetch('/savant/statcast?type=pitcher&year=2026').then(r=>r.text()),
      fetch('/savant/expected?type=pitcher&year=2026').then(r=>r.text()),
      fetch('/savant/csw?year=2026').then(r=>r.text()),
    ]);

    const scRows  = safeRows(scRes.status==='fulfilled'?scRes.value:'',  'statcast');
    const expRows = safeRows(expRes.status==='fulfilled'?expRes.value:'', 'expected');
    const cswRows = safeRows(cswRes.status==='fulfilled'?cswRes.value:'', 'arsenal');

    const scRow  = findRow(scRows,  'statcast');
    const expRow = findRow(expRows, 'expected');

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

    // Statcast pitcher: GB%, FB%, Barrel%, HH%, Avg EV
    const gbRaw        = col(scRow,'gb','groundballs_percent','gb_percent');
    const fbRaw        = col(scRow,'fbld','flyballs_percent','fb_percent');
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

    const whiffC  = whiffPct!=='—'?(parseFloat(whiffPct)>=28?'good':parseFloat(whiffPct)<=18?'bad':''):'';
    const kC      = kPct!=='—'?(parseFloat(kPct)>=28?'good':parseFloat(kPct)<=18?'bad':''):'';
    const putAwayC= putAway!=='—'?(parseFloat(putAway)>=33?'good':parseFloat(putAway)<=20?'bad':''):'';
    const gbC     = gbPct!=='—'?(parseFloat(gbPct)>=50?'good':''):'';
    const brlC    = brlAgainst!=='—'?(parseFloat(brlAgainst)<=5?'good':parseFloat(brlAgainst)>=12?'bad':''):'';
    const hhC     = hhAgainst!=='—'?(parseFloat(hhAgainst)<=35?'good':parseFloat(hhAgainst)>=48?'bad':''):'';
    const xeraC   = xERAVal!=='—'?(parseFloat(xERAVal)<=3.25?'good':parseFloat(xERAVal)>=4.50?'bad':''):'';

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

    const boxes=[
      statBox('Whiff%',    whiffPct,     'Whiff rate per pitch',       whiffC),
      statBox('K%',        kPct,         'Strikeout rate',             kC),
      statBox('Put Away%', putAway,      '2-strike put-away rate',     putAwayC),
      statBox('GB%',       gbPct,        'Ground ball rate',           gbC),
      statBox('FB%',       fbPct,        'Fly ball rate',              ''),
      statBox('Barrel% vs',brlAgainst,   'Barrels allowed',            brlC),
      statBox('HH% vs',   hhAgainst,    'Hard contact allowed',       hhC),
      statBox('Avg EV vs',avgEVAgainst, 'Avg exit velo against',      ''),
      statBox('xwOBA vs', xwobaPct,     'Expected wOBA against',      ''),
      statBox('xERA',     xERAVal,      'Expected ERA',               xeraC),
    ].join('');

    if(!scRow&&!expRow&&arsenalRows.length===0){
      el.innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">No Statcast data found for this pitcher.</div>';
    }else{
      el.innerHTML=boxes;
    }
  }catch(e){
    console.error('[PitcherStatcast] Error:',e);
    el.innerHTML=`<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">Pitcher Statcast unavailable.</div>`;
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
    document.getElementById('ump-content').innerHTML=`<div class="ump-box"><div class="ump-sub">Home Plate Umpire</div><div class="ump-name">${hp.official.fullName}</div><div class="ump-tendency ${ut.tendency}">${ut.tendency==='pitcher'?'Pitcher-Friendly':ut.tendency==='hitter'?'Hitter-Friendly':'Neutral Zone'}</div><div style="font-size:11px;color:#999;font-family:monospace;margin-top:8px;">${ut.note}</div>${ut.adj!==0?`<div style="font-size:10px;color:#999;font-family:monospace;margin-top:4px;">Est. run impact: <strong style="color:${ut.adj>0?'#2ecc71':'#e74c3c'}">${ut.adj>0?'+':''}${ut.adj} R/G</strong></div>`:''}`;
    show('ump-content');
  }catch{setText('ump-empty','Could not load umpire data.');show('ump-empty');}
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
      document.getElementById('matchup-content').innerHTML=`<div style="font-size:11px;color:#777;font-family:monospace;">${pLast} has no recorded plate appearances vs. ${pitLast} — first-time matchup.</div>`;
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
        <div><div style="font-size:9px;color:#888;font-family:monospace;letter-spacing:1px;text-transform:uppercase;">OPS</div><div style="font-size:26px;font-weight:900;font-family:monospace;color:${opsColor}">${st.ops}</div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${[['AVG',st.avg],['OBP',st.obp],['SLG',st.slg],['AB',ab],['H',h],['HR',hr],['K',k],['BB',bb]].map(([l,v])=>`<div><div style="font-size:9px;color:#888;font-family:monospace;letter-spacing:1px;text-transform:uppercase;">${l}</div><div style="font-size:13px;font-weight:700;font-family:monospace;color:#ccc;">${v}</div></div>`).join('')}
        </div>
      </div>
      <div style="font-size:9px;color:#777;font-family:monospace;">${sample} · ${ab} AB vs ${S.pitcher.name}</div>`;
    show('matchup-content');
  }catch(e){
    document.getElementById('matchup-content').innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;">Could not load matchup data.</div>';
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
        ${avgOps?`<span style="font-size:9px;color:#888;font-family:monospace;margin-left:8px;">${avgOps.toFixed(3)} OPS (3-4-5)</span>`:''}
        ${selectedRow?`<span style="font-size:9px;color:#999;font-family:monospace;margin-left:12px;">${S.playerName} bats ${selectedRow.order}${ordSuffix(selectedRow.order)}</span>`:`<span style="font-size:9px;color:#e74c3c;font-family:monospace;margin-left:12px;">${S.playerName} is not in today's starting lineup</span>`}
        ${weakProtection&&nextBatter?`<div style="font-size:10px;color:#e74c3c;font-family:monospace;margin-top:6px;">⚠ ${nextBatter.name} bats behind ${playerLastName} (.${Math.round((nextBatter.avg||0)*1000)}) — pitchers may work around him</div>`:''}
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
  }catch{hide('weather-spinner');}
  finally{hide('weather-spinner');}
}

function updateWeatherForTime(){if(S.weather)fetchWeather();const h=parseInt((document.getElementById('game-time').value||'19:10').split(':')[0]);setDay(h<17);}

// ═══════════ PREDICTION ENGINE ════════════════════════════════════════════════
function calcPrediction(){
  let score=50;const factors=[];
  let batScore=0,pitScore=0,conScore=0;
  const add=(l,v,adj,n,cat='batter')=>{score+=adj;if(cat==='batter')batScore+=adj;else if(cat==='pitcher')pitScore+=adj;else conScore+=adj;factors.push({label:l,value:v,adj,impact:adj>2?'positive':adj<-2?'negative':'neutral',note:n,cat});};
  if(S.splits){
    const hand=S.pitcher?.hand||S.pitcherThrows;
    const hs=hand==='L'?S.splits.vl:S.splits.vr;
    if(hs?.ops){const a=(hs.ops-0.750)*70;add(`vs ${hand}HP`,hs.ops.toFixed(3)+' OPS',a,`${a>0?'Hits well':'Struggles'} vs ${hand==='L'?'lefties':'righties'} this season`);}
    const ls=S.isHome?S.splits.h:S.splits.a;
    if(ls?.ops){const a=(ls.ops-0.750)*35;add(S.isHome?'Home':'Away',ls.ops.toFixed(3)+' OPS',a,`OPS ${ls.ops.toFixed(3)} ${S.isHome?'at home':'on the road'}`);}
    const ts=S.dayGame?S.splits.d:S.splits.n;
    if(ts?.ops){const a=(ts.ops-0.750)*25;add(S.dayGame?'Day Game':'Night Game',ts.ops.toFixed(3)+' OPS',a,`OPS ${ts.ops.toFixed(3)} in ${S.dayGame?'day':'night'} games`);}
    if(S.rispStat?.avg){const ra=parseFloat(S.rispStat.avg);const a=(ra-0.260)*20;add('RISP',S.rispStat.avg+' BA',a,ra>=0.300?'Clutch hitter':ra<=0.200?'Struggles with RISP':'Average RISP production');}
  }
  if(S.pitcher?.st){
    const era=parseFloat(S.pitcher.st.era);
    if(!isNaN(era)){const a=(era-4.00)*4;add('Pitcher ERA',era.toFixed(2),a,era<3.25?'Elite arm':era<4.00?'Above-average':era<5.00?'League-average':'Hittable pitcher','pitcher');}
    const pa=S.pitcher.st.battersFaced||1;
    const kp=S.pitcher.st.strikeOuts?(S.pitcher.st.strikeOuts/pa)*100:null;
    if(kp&&kp>=28)add('High K%',kp.toFixed(1)+'%',-4,'Elite swing-and-miss stuff','pitcher');
    if(kp&&kp<=15)add('Low K%',kp.toFixed(1)+'%',3,'Below-average K rate — more contact opportunities','pitcher');
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
    const adj=Math.max(-6,Math.min(6,Math.round((ops-0.750)*50*weight)));
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
  // Batter Statcast factors
  if(S.statcast){
    const {brl,hhRate,whiff,xwoba,xba,xslg,sweetSpot,batSpeed,swingLength,squaredUp,blast,avgEV}=S.statcast;
    if(brl!=null){
      if(brl>=12)add('Barrel%',brl.toFixed(1)+'%',4,'Elite barrel rate — hard contact tendency');
      else if(brl<=4)add('Barrel%',brl.toFixed(1)+'%',-2,'Below-average barrel rate');
    }
    if(hhRate!=null){
      if(hhRate>=48)add('Hard-Hit%',hhRate.toFixed(1)+'%',3,'Elite hard-hit rate — consistent solid contact');
      else if(hhRate<=33)add('Hard-Hit%',hhRate.toFixed(1)+'%',-2,'Low hard-hit rate — soft contact tendency');
    }
    if(avgEV!=null){
      if(avgEV>=93)add('Avg EV',avgEV.toFixed(1)+' mph',2,'Elite average exit velocity');
      else if(avgEV<=84)add('Avg EV',avgEV.toFixed(1)+' mph',-2,'Below-average exit velocity');
    }
    if(whiff!=null){
      if(whiff<=18)add('Whiff%',whiff.toFixed(1)+'%',3,'Low whiff rate — difficult to strike out');
      else if(whiff>=30)add('Whiff%',whiff.toFixed(1)+'%',-3,'High whiff rate — vulnerable to swing-and-miss stuff');
    }
    if(xwoba!=null){
      if(xwoba>=0.380)add('xwOBA',xwoba.toFixed(3),4,'Elite expected production — hitting the ball well');
      else if(xwoba<=0.290)add('xwOBA',xwoba.toFixed(3),-3,'Below-average expected production');
    }
    if(xba!=null){
      if(xba>=0.290)add('xBA',xba.toFixed(3),2,'High expected batting average — quality contact');
      else if(xba<=0.210)add('xBA',xba.toFixed(3),-2,'Low expected BA — weak contact quality');
    }
    if(xslg!=null){
      if(xslg>=0.500)add('xSLG',xslg.toFixed(3),3,'Elite expected slugging — extra-base power');
      else if(xslg<=0.350)add('xSLG',xslg.toFixed(3),-2,'Low expected slugging — limited power output');
    }
    if(sweetSpot!=null){
      if(sweetSpot>=40)add('Sweet Spot%',sweetSpot.toFixed(1)+'%',2,'High sweet spot contact — consistent quality hits');
      else if(sweetSpot<=25)add('Sweet Spot%',sweetSpot.toFixed(1)+'%',-2,'Low sweet spot % — poor launch angle profile');
    }
    if(batSpeed!=null){
      if(batSpeed>=76)add('Bat Speed',batSpeed.toFixed(1)+' mph',2,'Elite bat speed — generates more power');
      else if(batSpeed<=67)add('Bat Speed',batSpeed.toFixed(1)+' mph',-2,'Slow bat speed — timing vulnerability');
    }
    if(squaredUp!=null&&squaredUp>=22)add('Sqd Up%',squaredUp.toFixed(1)+'%',2,'Elite squared-up contact rate');
    if(blast!=null&&blast>=8)add('Blast%',blast.toFixed(1)+'%',2,'Elite blast rate — authoritative contact');
    const{gb,fb}=S.statcast;
    if(gb!=null&&gb>=55)add('GB%',gb.toFixed(1)+'%',-2,'Heavy ground ball hitter — limits extra-base upside');
    if(fb!=null&&fb>=45)add('FB%',fb.toFixed(1)+'%',2,'High fly ball rate — elevated HR and total bases ceiling');
  }
  // Pitcher Statcast factors
  if(S.pitcherStatcast){
    const{whiff:pWhiff,kPct,putAway,gbPct,brlAgainst,hhAgainst,xwoba:pXwoba,xera}=S.pitcherStatcast;
    if(pWhiff!=null){
      if(pWhiff>=28)add('Pitcher Whiff%',pWhiff.toFixed(1)+'%',-4,'Elite whiff rate — dominant swing-and-miss stuff','pitcher');
      else if(pWhiff<=16)add('Pitcher Whiff%',pWhiff.toFixed(1)+'%',3,'Low pitcher whiff rate — hitter-friendly contact','pitcher');
    }
    if(kPct!=null){
      if(kPct>=28)add('Pitcher K%',kPct.toFixed(1)+'%',-3,'Elite strikeout rate pitcher','pitcher');
      else if(kPct<=18)add('Pitcher K%',kPct.toFixed(1)+'%',3,'Low K rate — contact-heavy opportunity','pitcher');
    }
    if(putAway!=null&&putAway>=33)add('Put Away%',putAway.toFixed(1)+'%',-2,'Elite 2-strike put-away — finishes hitters','pitcher');
    if(gbPct!=null&&gbPct>=50)add('GB%',gbPct.toFixed(1)+'%',-2,'Ground ball pitcher — limits extra-base power','pitcher');
    if(brlAgainst!=null){
      if(brlAgainst<=5)add('Barrel% vs',brlAgainst.toFixed(1)+'%',-2,'Suppresses barrels — elite contact quality control','pitcher');
      else if(brlAgainst>=12)add('Barrel% vs',brlAgainst.toFixed(1)+'%',3,'High barrel rate allowed — hitter-friendly contact','pitcher');
    }
    if(hhAgainst!=null){
      if(hhAgainst<=33)add('HH% vs',hhAgainst.toFixed(1)+'%',-2,'Allows very little hard contact','pitcher');
      else if(hhAgainst>=48)add('HH% vs',hhAgainst.toFixed(1)+'%',3,'Allows heavy hard contact — hitter-friendly','pitcher');
    }
    if(pXwoba!=null){
      if(pXwoba<=0.280)add('xwOBA vs',pXwoba.toFixed(3),-3,'Elite expected wOBA suppression','pitcher');
      else if(pXwoba>=0.370)add('xwOBA vs',pXwoba.toFixed(3),3,'High xwOBA allowed — hitter-friendly profile','pitcher');
    }
    if(xera!=null){
      if(xera<=3.00)add('xERA',xera.toFixed(2),-4,'Elite expected ERA — dominant pitcher','pitcher');
      else if(xera<=3.75)add('xERA',xera.toFixed(2),-2,'Above-average expected ERA','pitcher');
      else if(xera>=4.75)add('xERA',xera.toFixed(2),3,'High xERA — hittable pitcher profile','pitcher');
    }
  }
  const w=S.weather;const wm=document.getElementById('weather-manual')&&!document.getElementById('weather-manual').classList.contains('hidden');
  let tempF,windMph,windDir,humidity;
  if(w&&!wm){tempF=w.tempF;windMph=w.windMph;windDir=w.windDir;humidity=w.humidity;}
  else{tempF=parseInt(document.getElementById('temp-slider')?.value)||75;windMph=parseInt(document.getElementById('wind-slider')?.value)||0;windDir=document.getElementById('wind-dir')?.value||'calm';humidity=parseInt(document.getElementById('humid-slider')?.value)||40;}
  const stadOpt=document.getElementById('stadium-select').options[document.getElementById('stadium-select').selectedIndex];
  const hasRoof=stadOpt.dataset.roof==='1',elev=parseInt(stadOpt.dataset.elev);
  const roofClosed=hasRoof&&S.roofClosed;
  const outDirs=['S','SSE','SE','SSW','SW'],inDirs=['N','NNE','NNW','NE','NW'];
  const isOut=outDirs.some(d=>windDir?.startsWith(d)),isIn=inDirs.some(d=>windDir?.startsWith(d));
  const wd=isOut?'out':isIn?'in':windDir==='out'?'out':windDir==='in'?'in':'cross';
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
  document.getElementById('pitch-display').innerHTML=Object.entries(S.pitcherPitches).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a).map(([type,pct])=>`<div class="pitch-row"><span class="pitch-label">${type}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${pct}%;background:${pct>35?'#A71930':'#3a3560'}"></div></div><span class="pitch-pct">${pct}%</span></div>`).join('');
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
    :'<div style="font-size:11px;color:#555;font-family:monospace;padding:4px 0;">No significant factors.</div>';
  const fmtNet=n=>{
    const s=n>0?'+':'',c=n>0?'#2ecc71':n<0?'#e74c3c':'#888';
    return`<span style="color:${c};font-weight:900;font-family:monospace;font-size:12px;letter-spacing:0;text-transform:none;">${s}${n}</span>`;
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
  const tempF=S.weather?.tempF||75;
  const windMph=S.weather?.windMph||5;
  const windDir=S.weather?.windDir||'calm';
  const umpAdj=S.umpire?(UMP_DB[S.umpire.fullName]?.adj||0):0;
  const protTier=S.lineupProtection?.tier;
  const rispAvg=parseFloat(S.rispStat?.avg)||null;

  if(propKey==='batter_hits'){
    if(avg!=null)        score+=(avg-0.265)*150;
    if(babip!=null)      score+=(babip-0.300)*80;
    if(kPct!=null)       score-=(kPct-20)*0.5;
    if(handOps)          score+=(handOps-0.750)*35;
    if(pWhip!=null)      score-=(pWhip-1.25)*20;
    if(pKPct!=null)      score-=(pKPct-22)*0.4;
    if(whiff!=null)      score-=(whiff-22)*0.35;
    if(hhRate!=null)     score+=(hhRate-40)*0.15;
    if(mu&&muW>0)        score+=(parseFloat(mu.avg||0)-0.265)*80*muW;
  }
  else if(propKey==='batter_total_bases'){
    if(slg!=null)        score+=(slg-0.420)*100;
    if(xwoba!=null)      score+=(xwoba-0.340)*80;
    if(brl!=null)        score+=(brl-8)*0.7;
    if(hhRate!=null)     score+=(hhRate-40)*0.2;
    if(pEra!=null)       score-=(pEra-4.00)*3;
    if(handOps)          score+=(handOps-0.750)*30;
    if(mu&&muW>0)        score+=(parseFloat(mu.slg||0)-0.420)*60*muW;
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
    if(xwoba!=null)      score+=(xwoba-0.340)*70;
    if(abPerHR!=null)    score-=(abPerHR-28)*0.5;
    if(hhRate!=null)     score+=(hhRate-40)*0.3;
    if(pEra!=null)       score-=(pEra-4.00)*5;
    if(handOps)          score+=(handOps-0.750)*25;
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
    if(rispAvg!=null)    score+=(rispAvg-0.255)*120;
    if(slg!=null)        score+=(slg-0.420)*60;
    if(protTier==='strong') score+=5;
    else if(protTier==='weak') score-=5;
    if(pEra!=null)       score-=(pEra-4.00)*3.5;
    if(mu&&muW>0)        score+=(mu.ops-0.750)*35*muW;
    if(tempF>=90||elev>4000) score+=3;
  }
  else if(propKey==='batter_walks'){
    if(bbPct!=null)      score+=(bbPct-9)*3;
    if(obp!=null)        score+=(obp-0.340)*70;
    if(pBBPct!=null)     score+=(pBBPct-7)*2.5;
    if(umpAdj>0)         score+=umpAdj*2.5;
    else if(umpAdj<0)    score+=umpAdj*2;
    const dr=parseInt(S.pitcher?.daysRest);
    if(!isNaN(dr)&&dr<4) score+=4;
    const lpc=S.pitcher?.lastOuting?.numberOfPitches;
    if(lpc&&lpc>=100)    score+=3;
    if(mu&&muW>0&&mu.bb!=null) score+=(mu.bb/Math.max(mu.ab,1))*200*muW;
  }
  else if(propKey==='batter_strikeouts'){
    if(kPct!=null)       score+=(kPct-18)*1.8;
    if(pKPct!=null)      score+=(pKPct-20)*1.5;
    if(whiff!=null)      score+=(whiff-22)*1.0;
    const breakingBall=(S.pitcherPitches?.['Slider']||0)+(S.pitcherPitches?.['Curveball']||0);
    if(breakingBall>30)  score+=4;
    if(umpAdj<0)         score+=Math.abs(umpAdj)*2;
    else if(umpAdj>0)    score-=umpAdj*1.5;
    if(mu&&muW>0&&mu.k!=null) score+=(mu.k/Math.max(mu.ab,1))*250*muW;
    if(pEra!=null)       score-=(pEra-4.00)*2;
  }
  else if(propKey==='batter_runs_scored'){
    if(obp!=null)        score+=(obp-0.330)*80;
    if(pWhip!=null)      score-=(pWhip-1.25)*15;
    if(pBBPct!=null)     score+=(pBBPct-7)*1.5;
    if(handOps)          score+=(handOps-0.750)*25;
    if(mu&&muW>0)        score+=(parseFloat(mu.obp||0)-0.330)*40*muW;
    if(tempF>=90)        score+=2;
    if(elev>4000)        score+=4;
    else if(elev>2000)   score+=2;
    if(windDir==='out'&&windMph>=8) score+=windMph*0.15;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    if(avg!=null)        score+=(avg-0.265)*120;
    if(obp!=null)        score+=(obp-0.330)*60;
    if(slg!=null)        score+=(slg-0.420)*60;
    if(rispAvg!=null)    score+=(rispAvg-0.255)*50;
    if(pEra!=null)       score-=(pEra-4.00)*3;
    if(handOps)          score+=(handOps-0.750)*30;
    if(mu&&muW>0)        score+=(mu.ops-0.750)*50*muW;
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
    const kp=ss?((ss.strikeOuts/pa)*100).toFixed(0):null;
    if(kp)         drivers.push(`${kp}% K rate`);
    if(handSplit?.ops) drivers.push(`${handSplit.ops} OPS vs ${hand}HP`);
    if(S.pitcher?.st?.whip) drivers.push(`${parseFloat(S.pitcher.st.whip).toFixed(2)} WHIP`);
    if(mu?.ab>=5)  drivers.push(`${mu.avg} AVG in ${mu.ab}AB career`);
  } else if(propKey==='batter_total_bases'){
    if(ss?.slg)    drivers.push(`${ss.slg} SLG`);
    if(S.statcast?.xwoba!=null) drivers.push(`${S.statcast.xwoba.toFixed(3)} xwOBA`);
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
    if(ss?.obp)    drivers.push(`${ss.obp} OBP`);
    const pBBPct=S.pitcher?.st?.baseOnBalls?((S.pitcher.st.baseOnBalls/pitcherPA)*100).toFixed(1):null;
    if(pBBPct)     drivers.push(`pitcher ${pBBPct}% BB rate`);
    if(S.umpire)   drivers.push(`${S.umpire.fullName} umpire`);
    if(mu?.ab>=5&&mu.bb) drivers.push(`${mu.bb}BB in ${mu.ab}AB career`);
  } else if(propKey==='batter_strikeouts'){
    const kp=ss?((ss.strikeOuts/pa)*100).toFixed(1):null;
    if(kp)         drivers.push(`${kp}% K rate`);
    const pKPct=S.pitcher?.st?.strikeOuts?((S.pitcher.st.strikeOuts/pitcherPA)*100).toFixed(1):null;
    if(pKPct)      drivers.push(`pitcher ${pKPct}% K rate`);
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

function devig(overPrices,underPrices){
  if(!overPrices?.length||!underPrices?.length)return null;
  const median=arr=>{const s=[...arr].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  const rawO=impliedProb(median(overPrices));
  const rawU=impliedProb(median(underPrices));
  const tot=rawO+rawU;
  return{overProb:rawO/tot*100,underProb:rawU/tot*100};
}

function modelProbability(propKey,line,score){
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const gamePAs=4.0;
  let p=null;

  // Piecewise linear interpolation between three anchor points (score 20/50/80).
  // Clamps to anchor values outside that range.
  function lerp3(sc,s1,p1,s2,p2,s3,p3){
    const c=Math.max(s1,Math.min(s3,sc));
    if(c<=s2)return p1+(p2-p1)*(c-s1)/(s2-s1);
    return p2+(p3-p2)*(c-s2)/(s3-s2);
  }

  if(propKey==='batter_hits'){
    if(line<=0.5) p=lerp3(score,20,42,50,62,80,78);
    else          p=lerp3(score,20,18,50,32,80,52);
  }
  else if(propKey==='batter_total_bases'){
    if(line<=0.5)      p=lerp3(score,20,38,50,58,80,74);
    else if(line<=1.5) p=lerp3(score,20,22,50,40,80,62);
    else if(line<=2.5) p=lerp3(score,20,12,50,24,80,42);
    else               p=lerp3(score,20, 6,50,14,80,26);
  }
  else if(propKey==='batter_home_runs'){
    p=lerp3(score,20,8,50,14,80,28);
  }
  else if(propKey==='batter_walks'){
    const bbF=ss?.baseOnBalls?(ss.baseOnBalls/pa):0.09;
    const pitcherPA=S.pitcher?.st?.battersFaced||1;
    const pBBF=S.pitcher?.st?.baseOnBalls?(S.pitcher.st.baseOnBalls/pitcherPA):0.08;
    const blended=bbF*0.6+pBBF*0.4;
    const rateBase=line<=0.5
      ?(1-Math.pow(1-blended,gamePAs))*100
      :(()=>{const p0=Math.pow(1-blended,gamePAs),p1=gamePAs*blended*Math.pow(1-blended,gamePAs-1);return(1-p0-p1)*100;})();
    const scoreBase=lerp3(score,20,18,50,30,80,48);
    p=scoreBase*0.6+rateBase*0.4;
  }
  else if(propKey==='batter_strikeouts'){
    const kF=ss?.strikeOuts?(ss.strikeOuts/pa):0.18;
    const pitcherPA=S.pitcher?.st?.battersFaced||1;
    const pKF=S.pitcher?.st?.strikeOuts?(S.pitcher.st.strikeOuts/pitcherPA):0.22;
    const whiffAdj=S.statcast?.whiff?(S.statcast.whiff-22)*0.01:0;
    const blended=Math.min(0.45,kF*0.55+pKF*0.45+whiffAdj);
    const rateBase=line<=0.5
      ?(1-Math.pow(1-blended,gamePAs))*100
      :(()=>{const p0=Math.pow(1-blended,gamePAs),p1=gamePAs*blended*Math.pow(1-blended,gamePAs-1);return(1-p0-p1)*100;})();
    const scoreBase=lerp3(score,20,28,50,48,80,68);
    p=scoreBase*0.6+rateBase*0.4;
  }
  else if(propKey==='batter_rbis'){
    const rbiPG=(ss?.rbi&&ss?.gamesPlayed)?(ss.rbi/ss.gamesPlayed):0.4;
    const rateBase=(1-_poissonCDF(rbiPG,Math.floor(line)))*100;
    const scoreBase=lerp3(score,20,15,50,28,80,45);
    p=scoreBase*0.6+rateBase*0.4;
    if(S.lineupProtection?.tier==='strong')p+=5;
    else if(S.lineupProtection?.tier==='weak')p-=5;
  }
  else if(propKey==='batter_runs_scored'){
    const runPG=(ss?.runs&&ss?.gamesPlayed)?(ss.runs/ss.gamesPlayed):0.55;
    const rateBase=(1-_poissonCDF(runPG,Math.floor(line)))*100;
    const scoreBase=lerp3(score,20,18,50,32,80,50);
    p=scoreBase*0.5+rateBase*0.5;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    const hitPG=(ss?.hits&&ss?.gamesPlayed)?(ss.hits/ss.gamesPlayed):0.85;
    const runPG=(ss?.runs&&ss?.gamesPlayed)?(ss.runs/ss.gamesPlayed):0.55;
    const rbiPG=(ss?.rbi&&ss?.gamesPlayed)?(ss.rbi/ss.gamesPlayed):0.40;
    const hrrPG=hitPG+runPG+rbiPG;
    const rateBase=(1-_poissonCDF(hrrPG,Math.floor(line)))*100;
    const scoreBase=lerp3(score,20,20,50,38,80,60);
    p=scoreBase*0.5+rateBase*0.5;
  }

  if(p===null)return null;

  // Trend adjustments — accumulated then capped at ±6pts total
  let trendAdj=0;
  const last4=S.recentGameLog?.slice(0,4)||[];
  const last3=S.recentGameLog?.slice(0,3)||[];
  if(last4.length>=3){
    if(propKey==='batter_hits'){
      const hot=last4.filter(g=>(parseInt(g.stat.hits)||0)>=2).length;
      const cold=last3.filter(g=>(parseInt(g.stat.hits)||0)===0).length;
      if(hot>=3)trendAdj+=5; else if(hot>=2)trendAdj+=2;
      if(cold>=2)trendAdj-=5; else if(cold>=1)trendAdj-=2;
    } else if(propKey==='batter_total_bases'){
      const avgTB=last4.reduce((s,g)=>s+(parseInt(g.stat.totalBases)||0),0)/4;
      if(avgTB>=2.5)trendAdj+=5; else if(avgTB<=0.5)trendAdj-=4;
    } else if(propKey==='batter_home_runs'){
      const recentHR=last4.reduce((s,g)=>s+(parseInt(g.stat.homeRuns)||0),0);
      if(recentHR>=2)trendAdj+=4;
    } else if(propKey==='batter_strikeouts'){
      const avgK=last4.reduce((s,g)=>s+(parseInt(g.stat.strikeOuts)||0),0)/4;
      if(avgK>1.5)trendAdj+=4; else if(avgK<0.5)trendAdj-=3;
    } else if(propKey==='batter_walks'){
      const wkGames=last4.filter(g=>(parseInt(g.stat.baseOnBalls)||0)>=1).length;
      if(wkGames>=3)trendAdj+=4; else if(wkGames===0)trendAdj-=3;
    } else if(propKey==='batter_runs_scored'){
      const scoringGames=last4.filter(g=>(parseInt(g.stat.runs)||0)>=1).length;
      if(scoringGames>=3)trendAdj+=4; else if(scoringGames===0)trendAdj-=3;
    } else if(propKey==='batter_hits_runs_rbis'){
      const avgHRR=last4.reduce((s,g)=>{
        return s+(parseInt(g.stat.hits)||0)+(parseInt(g.stat.runs)||0)+(parseInt(g.stat.rbi)||0);
      },0)/4;
      if(avgHRR>=3)trendAdj+=5; else if(avgHRR<=0.5)trendAdj-=4;
    }
  }

  // Pitcher recent form
  const p3=S.pitcher?.last3;
  if(p3?.length>=1){
    if(propKey==='batter_hits'){
      const avgH=p3.reduce((s,g)=>s+(parseInt(g.stat.hits)||0),0)/p3.length;
      if(avgH>=8)trendAdj+=4; else if(avgH<=4)trendAdj-=3;
    } else if(propKey==='batter_strikeouts'){
      const avgK=p3.reduce((s,g)=>s+(parseInt(g.stat.strikeOuts)||0),0)/p3.length;
      if(avgK>=9)trendAdj+=4; else if(avgK<=4)trendAdj-=3;
    } else if(propKey==='batter_total_bases'){
      const avgER=p3.reduce((s,g)=>s+(parseInt(g.stat.earnedRuns)||0),0)/p3.length;
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

function estimateProbability(propKey,direction,line){
  const ss=S.seasonStat;
  const pa=ss?.plateAppearances||1;
  const gamePAs=4.0;
  let prob=null;

  if(propKey==='batter_strikeouts'){
    const carrollK=ss?.strikeOuts?(ss.strikeOuts/pa):0.18;
    const pitcherPA=S.pitcher?.st?.battersFaced||1;
    const pitcherK=S.pitcher?.st?.strikeOuts?(S.pitcher.st.strikeOuts/pitcherPA):0.22;
    const blended=carrollK*0.55+pitcherK*0.45;
    if(line<=0.5){
      prob=(1-Math.pow(1-blended,gamePAs))*100;
    }else{
      const p0=Math.pow(1-blended,gamePAs);
      const p1=gamePAs*blended*Math.pow(1-blended,gamePAs-1);
      prob=(1-p0-p1)*100;
    }
  }
  else if(propKey==='batter_hits'){
    const avg=parseFloat(ss?.avg)||0.265;
    const ab=gamePAs-0.5;
    if(line<=0.5){
      prob=(1-Math.pow(1-avg,ab))*100;
    }else{
      const p0=Math.pow(1-avg,ab);
      const p1=ab*avg*Math.pow(1-avg,ab-1);
      prob=(1-p0-p1)*100;
    }
  }
  else if(propKey==='batter_home_runs'){
    const abPerHR=parseFloat(ss?.atBatsPerHomeRun)||35;
    const hrRate=Math.min(1/abPerHR,0.15);
    prob=(1-Math.pow(1-hrRate,gamePAs))*100;
  }
  else if(propKey==='batter_walks'){
    const bbFrac=ss?.baseOnBalls?(ss.baseOnBalls/pa):0.09;
    if(line<=0.5){
      prob=(1-Math.pow(1-bbFrac,gamePAs))*100;
    }else{
      const p0=Math.pow(1-bbFrac,gamePAs);
      const p1=gamePAs*bbFrac*Math.pow(1-bbFrac,gamePAs-1);
      prob=(1-p0-p1)*100;
    }
  }
  else if(propKey==='batter_total_bases'){
    const slg=parseFloat(ss?.slg)||0.420;
    const bbFrac=ss?.baseOnBalls?(ss.baseOnBalls/pa):0.09;
    const lambda=slg*(gamePAs*(1-bbFrac));
    prob=(1-_poissonCDF(lambda,Math.floor(line)))*100;
  }
  else if(propKey==='batter_rbis'){
    const rbiPerGame=(ss?.rbi&&ss?.gamesPlayed)?(ss.rbi/ss.gamesPlayed):0.4;
    prob=(1-_poissonCDF(rbiPerGame,Math.floor(line)))*100;
  }
  else if(propKey==='batter_runs_scored'){
    const runPG=(ss?.runs&&ss?.gamesPlayed)?(ss.runs/ss.gamesPlayed):0.55;
    prob=(1-_poissonCDF(runPG,Math.floor(line)))*100;
  }
  else if(propKey==='batter_hits_runs_rbis'){
    const hitPG=(ss?.hits&&ss?.gamesPlayed)?(ss.hits/ss.gamesPlayed):0.85;
    const runPG=(ss?.runs&&ss?.gamesPlayed)?(ss.runs/ss.gamesPlayed):0.55;
    const rbiPG=(ss?.rbi&&ss?.gamesPlayed)?(ss.rbi/ss.gamesPlayed):0.40;
    prob=(1-_poissonCDF(hitPG+runPG+rbiPG,Math.floor(line)))*100;
  }

  if(prob===null)return null;
  if(direction==='under')prob=100-prob;
  return Math.max(1,Math.min(99,prob));
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
    // Only consider lines where at least one trusted book (DK/FD/MGM) has data.
    const allLines=new Set([
      ...Object.keys(mkt.trustedOverByLine||{}),...Object.keys(mkt.trustedUnderByLine||{}),
      ...Object.keys(mkt.overByLine||{}),...Object.keys(mkt.underByLine||{})
    ].map(Number));
    const _med=arr=>{const s=[...arr].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
    let effectiveLine=null;
    let minImbalance=Infinity;
    for(const l of [...allLines]){
      if(!mkt.trustedOverByLine[l]?.length&&!mkt.trustedUnderByLine[l]?.length)continue;
      const oArr=mkt.trustedOverByLine[l]?.length?mkt.trustedOverByLine[l]:(mkt.overByLine[l]||[]);
      const uArr=mkt.trustedUnderByLine[l]?.length?mkt.trustedUnderByLine[l]:(mkt.underByLine[l]||[]);
      if(!oArr.length||!uArr.length)continue;
      const rO=impliedProb(_med(oArr)),rU=impliedProb(_med(uArr));
      if(!rO||!rU)continue;
      // Reject alt-ladder rungs (one side >85% raw implied) — books post these
      // as ladders for HRR/HR markets, and devig produces phantom 95% edges.
      const sideShare=rO/(rO+rU);
      if(sideShare>0.85||sideShare<0.15)continue;
      const imbalance=Math.abs(sideShare-0.5);
      if(imbalance<minImbalance){minImbalance=imbalance;effectiveLine=l;}
    }
    const line=effectiveLine!=null?effectiveLine:0.5;
    const calcOver=(mkt.trustedOverByLine[line]?.length?mkt.trustedOverByLine[line]:mkt.overByLine[line])||[];
    const calcUnder=(mkt.trustedUnderByLine[line]?.length?mkt.trustedUnderByLine[line]:mkt.underByLine[line])||[];
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

    results.push({
      prop:PROP_NAMES[propKey],propKey,line,direction,
      delta,absDelta,ev,edgeStrength,
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
  (sd?.stats?.[0]?.splits??[]).forEach(s=>{if(s.split?.code)byCode[s.split.code]={ops:parseFloat(s.stat.ops)||null,avg:s.stat.avg,obp:s.stat.obp,slg:s.stat.slg,gp:s.stat.gamesPlayed,hr:s.stat.homeRuns,rbi:s.stat.rbi};});
  let matchupStats=null;
  if(pitcherId){
    try{
      const mr=await fetch(`${base}?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&gameType=R&season=2026`);
      const md=await mr.json();
      const st=md?.stats?.[0]?.splits?.[0]?.stat;
      const ab=parseInt(st?.atBats)||0;
      if(st&&ab>0){const ops=parseFloat(st.ops)||0;matchupStats={ab,h:parseInt(st.hits)||0,hr:parseInt(st.homeRuns)||0,k:parseInt(st.strikeOuts)||0,bb:parseInt(st.baseOnBalls)||0,ops,avg:st.avg,obp:st.obp,slg:st.slg};}
    }catch(e){}
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
      try{
        const mlbStats=await _corbetFetchMLBStats(player.id,S.pitcher?.id);
        const statcast=_corbetExtractStatcast(player.id,csvRows);
        const saved={splits:S.splits,seasonStat:S.seasonStat,rispStat:S.rispStat,
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
        Object.assign(S,saved);
      }catch(e){}
    }
    // Render score-only player cards immediately — modals work now
    renderDashboard();

    // ── Phase 2: Odds + bets (optional — cards already visible above) ─────────
    const r=await fetch('/odds/v4/sports/baseball_mlb/events?regions=us&oddsFormat=american');
    {const rem=r.headers.get('X-Requests-Remaining');if(rem!=null)setApiCredits(rem);}
    const eventsText=await r.text();
    let events;
    try{events=JSON.parse(eventsText);}catch(e){throw new Error('Could not parse Odds API response.');}
    if(!Array.isArray(events)){throw new Error(events?.message||'Unexpected Odds API response');}

    const dbacksGame=events.find(e=>e.home_team?.includes('Arizona')||e.away_team?.includes('Arizona'));
    if(!dbacksGame){
      hide('corbet-loading');
      const msg='No D-backs game on the board yet — props usually post the evening before or morning of game day.';
      document.getElementById('corbet-no-props').textContent=msg;
      show('corbet-no-props');
      document.getElementById('dash-best-bets').innerHTML=`<div class="dash-empty">${msg}</div>`;
      return;
    }

    const propMarkets='batter_hits,batter_total_bases,batter_home_runs,batter_rbis,batter_walks,batter_strikeouts,batter_runs_scored,batter_hits_runs_rbis';
    const propBooks='draftkings,fanduel,betmgm';
    const pr=await fetch(`/odds/v4/sports/baseball_mlb/events/${dbacksGame.id}/odds?bookmakers=${propBooks}&markets=${propMarkets}&oddsFormat=american`);
    const propsText=await pr.text();
    let propData;
    try{propData=JSON.parse(propsText);}catch(e){throw new Error('Props endpoint returned invalid response.');}
    if(propData.message||propData.error_code){throw new Error('Odds API: '+(propData.message||propData.error_code));}

    // Build per-player market maps in one pass through bookmaker data.
    // Trusted books (DK/FD) are preferred for devig when available on both sides.
    // BetOnline.ag excluded from calc (posts erroneous novelty odds) but kept for display.
    // Outlier positive odds filtered to avoid data errors skewing probabilities.
    const EXCLUDED_CALC_BOOKS=new Set(['BetOnline.ag']);
    const TRUSTED_BOOKS=new Set(['DraftKings','FanDuel','BetMGM']);
    const isOutlierPrice=(price,line)=>price>0&&(line<=0.5?price>300:price>400);
    const playerMaps={};
    activeRoster().forEach(p=>{playerMaps[p.id]={};});
    (propData.bookmakers||[]).forEach(book=>{
      const skipCalc=EXCLUDED_CALC_BOOKS.has(book.title);
      const isTrusted=TRUSTED_BOOKS.has(book.title);
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
            trustedOverByLine:{},trustedUnderByLine:{},
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
              }else if(dir==='under'){
                if(!m.underBestByLine[line]||price>m.underBestByLine[line].price)
                  m.underBestByLine[line]={price,book:book.title};
              }
              if(skipCalc)return;
              if(!isTrusted&&isOutlierPrice(price,line))return;
              if(dir==='over'){
                (m.overByLine[line]=m.overByLine[line]||[]).push(price);
                m.calcBooks.add(book.title);
                if(isTrusted)(m.trustedOverByLine[line]=m.trustedOverByLine[line]||[]).push(price);
              }else if(dir==='under'){
                (m.underByLine[line]=m.underByLine[line]||[]).push(price);
                m.calcBooks.add(book.title);
                if(isTrusted)(m.trustedUnderByLine[line]=m.trustedUnderByLine[line]||[]).push(price);
              }
            });
        });
      });
    });

    // Generate bets for each roster player — game context (pitcher, weather, etc.) stays in S
    const allPlayerBets=[];
    for(const player of activeRoster()){
      try{
        // Reuse the snapshot already computed in Phase 1 — no re-fetching needed
        const snap=S.players[player.id];
        if(!snap)continue;
        const rawMarketMap=playerMaps[player.id];
        // Temporarily restore this player's stats so corbetReasoning() reads the right data
        const savedCtx={seasonStat:S.seasonStat,splits:S.splits,matchupStats:S.matchupStats,statcast:S.statcast};
        S.seasonStat=snap.seasonStat;S.splits=snap.splits;S.matchupStats=snap.matchupStats;S.statcast=snap.statcast;
        const bets=generateCorbetBets(snap.score,snap.factors,rawMarketMap);
        Object.assign(S,savedCtx);
        bets.forEach(b=>{
          if(!b.insufficient&&b.edgeStrength!=='none'&&b.marketOverProb!=null){
            b.mcConfidence=monteCarloConfidence(b.propKey,b.line,snap.score,b.marketOverProb,b.direction);
          }
        });
        bets.forEach(b=>{if(b.propKey==='batter_total_bases'&&b.line<=0.5)b.line=1.5;});
        bets.forEach(b=>{b._playerName=player.name;b._playerScore=snap.score;});
        allPlayerBets.push({playerName:player.name,bets,lowData:(S.players[player.id]?.lowData||false)});
      }catch(e){
        // Skip player silently on error — continue to next
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
    autoSaveTopBets();
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
  document.getElementById('corbet-bets').innerHTML=visible.map(pg=>{
    const cards=pg.bets.map(b=>{
      const i=flatBets.length;flatBets.push(b);
      if(b.insufficient)return`<div class="bet-card" style="background:#0c0a1e;border:1px solid #1a1730;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div class="bet-card-header">
          <span style="font-size:13px;font-weight:900;font-family:monospace;color:#ccc;">${b.prop} <span style="color:#666;font-size:10px;">· ${b.line}</span></span>
        </div>
        <div style="font-size:10px;color:#666;font-family:monospace;margin:8px 0 10px;">⚠ Insufficient market data — fewer than 2 reliable bookmakers</div>
        <div style="display:flex;gap:14px;font-family:monospace;font-size:11px;">
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Over</div>
            <div style="color:#ccc;">${fmtOdds(b.overBest?.price)} <span style="color:#555;font-size:9px;">${b.overBest?.book||''}</span></div></div>
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Under</div>
            <div style="color:#ccc;">${fmtOdds(b.underBest?.price)} <span style="color:#555;font-size:9px;">${b.underBest?.book||''}</span></div></div>
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
          <span style="font-size:13px;font-weight:900;font-family:monospace;color:#ccc;">${b.prop} <span style="color:#666;font-size:10px;">· ${b.line}</span></span>
          ${showSave?`<button onclick="saveBet(${i},this)" style="background:#0e0c22;border:1px solid #1e1b3a;border-radius:4px;color:#888;font-family:monospace;font-size:9px;cursor:pointer;padding:3px 8px;letter-spacing:1px;text-transform:uppercase;">+ Save</button>`:''}
        </div>
        ${b.conflict?`<div style="background:#1a0808;border:1px solid #4a1010;border-radius:6px;padding:6px 10px;margin:6px 0 8px;font-size:9px;color:#e74c3c;font-family:monospace;letter-spacing:1px;">⚠ CONFLICT — Direction contradicts Total Bases recommendation. No edge shown.</div>`:''}
        ${b.edgeStrength!=='none'
          ?`<div style="background:${dirBg};border:1px solid ${dirBorder};border-radius:8px;padding:10px 14px;margin:8px 0 12px;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <div style="font-size:9px;color:#888;font-family:monospace;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;">Model Recommends</div>
                <div style="font-size:22px;font-weight:900;font-family:monospace;color:${dirColor};letter-spacing:1px;">${b.delta>0?'▲':'▼'} ${b.direction.toUpperCase()}</div>
              </div>
              <span class="edge-badge ${b.edgeStrength}">${edgeLabels[b.edgeStrength]}</span>
            </div>`
          :`<div style="font-size:10px;color:#555;font-family:monospace;margin:6px 0 10px;">${b.conflict?'No recommendation — resolve conflict above':'Model agrees with market — no edge'}</div>`}
        <div style="margin-bottom:22px;">
          <div style="display:flex;justify-content:space-between;font-size:9px;color:#888;font-family:monospace;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">
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
            <div style="position:absolute;left:${markerLeft}%;transform:translateX(-50%);font-size:8px;color:#ccc;font-family:monospace;white-space:nowrap;text-align:center;">▲ Model ${b.modelProb.toFixed(0)}%</div>
          </div>
        </div>
        <div style="display:flex;gap:14px;margin:0 0 8px;flex-wrap:wrap;font-family:monospace;font-size:11px;">
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Over</div>
            <div style="color:#ccc;">${fmtOdds(b.overBest?.price)} <span style="color:#555;font-size:9px;">${b.overBest?.book||''}</span></div></div>
          <div><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Best Under</div>
            <div style="color:#ccc;">${fmtOdds(b.underBest?.price)} <span style="color:#555;font-size:9px;">${b.underBest?.book||''}</span></div></div>
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
}

async function loadDashboard(){
  // Render game banner with current context
  _renderGameBanner();
  _renderPitcherCard();
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
  el.innerHTML=`
    ${opp?`<div class="dash-opp">vs ${opp}</div>`:''}
    <div class="dash-game-meta">${[date,time,venue].filter(Boolean).join(' · ')}</div>
    ${S.weather?`<div class="dash-game-weather">${S.weather.tempF}°F · ${S.weather.desc}${S.weather.windMph?' · '+S.weather.windMph+' mph '+S.weather.windDir:''}</div>`:''}
    ${umpName?`<div class="dash-ump">HP Umpire: ${umpName}</div>`:''}
  `;
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
    ?`<span style="background:#f39c12;color:#000;font-family:monospace;font-size:9px;font-weight:900;letter-spacing:2px;padding:2px 7px;border-radius:4px;margin-left:8px;">OPENER/BULLPEN</span>`
    :'';
  el.innerHTML=`<div class="dash-pitcher-card">
    <div>
      <div class="dash-pitcher-name">${S.pitcher.name}${bpBadge}</div>
      <div class="dash-pitcher-meta">${hand}HP · ERA ${era}${S.pitcher.bullpenGame?' · Expect multiple relievers':''}</div>
    </div>
    <button class="dash-pitcher-btn" onclick="openModal('panel-pitcher','Pitcher Analysis')">View Stats</button>
  </div>`;
}

function renderDashboard(){
  _renderGameBanner();
  _renderPitcherCard();
  const fmtOdds=p=>p!=null?(p>0?'+':'')+p:'—';
  const edgeOrder={strong:3,moderate:2,small:1,none:0};

  // Top 3 bets — only when props are available
  if(S.allPlayerBets&&S.allPlayerBets.length){
    const qualified=[];
    S.allPlayerBets.forEach(pg=>{
      if(pg.lowData)return;
      pg.bets.forEach(b=>{
        if(b.mcConfidence!=null&&b.mcConfidence>=85&&b.edgeStrength!=='none'&&!b.insufficient)
          qualified.push({...b,playerName:pg.playerName});
      });
    });
    qualified.sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100)||(b.mcConfidence||0)-(a.mcConfidence||0));
    const top3=qualified.slice(0,3);
    document.getElementById('dash-best-bets').innerHTML=top3.length
      ?top3.map(b=>`<div class="dash-best-bet-row">
        <div class="dash-best-bet-left">
          <div class="dash-best-bet-player">${b.playerName}</div>
          <div class="dash-best-bet-prop">${b.direction.toUpperCase()} ${b.line} ${b.prop}</div>
        </div>
        <div class="dash-best-bet-right">
          <span class="dash-badge">${fmtOdds(b.direction.toLowerCase()==='over'?b.overBest?.price:b.underBest?.price)}</span>
          <span class="dash-badge">MC ${b.mcConfidence.toFixed(0)}%</span>
          <span class="dash-badge">${(b.delta>0?'+':'')+b.delta.toFixed(1)}%</span>
        </div>
      </div>`).join('')
      :'<div class="dash-empty">No bets meet the 85% MC threshold today.</div>';
  }

  // Player rows — collapsible, sorted by batting order
  const betsMap={};
  (S.allPlayerBets||[]).forEach(pg=>{betsMap[pg.playerName]=pg;});

  // Pre-compute top-3 set so star icons can be applied per bet row
  const top3Keys=new Set();
  if(S.allPlayerBets){
    const qualified=[];
    S.allPlayerBets.forEach(pg=>pg.bets.forEach(b=>{
      if(b.mcConfidence>=85&&b.edgeStrength!=='none'&&!b.insufficient)
        qualified.push({...b,playerName:pg.playerName});
    }));
    qualified.sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100)||(b.mcConfidence||0)-(a.mcConfidence||0));
    qualified.slice(0,3).forEach(b=>top3Keys.add(`${b.playerName}_${b.propKey}_${b.direction}`));
  }

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
        const deltaStr=b.ev!=null?`EV ${b.ev>=0?'+':''}${(b.ev*100).toFixed(1)}%`:(b.delta>0?'+':'')+b.delta.toFixed(1)+'pp';
        return`<tr>
          <td>${icon}</td>
          <td class="dpb-prop">${b.prop} ${b.line} ${b.direction.toUpperCase()}</td>
          <td class="dpb-mc">${b.mcConfidence!=null?b.mcConfidence.toFixed(0)+'%':'—'}</td>
          <td class="dpb-delta" style="color:${deltaColor}">${deltaStr}</td>
          <td class="dpb-odds">${fmtOdds(bestOdds?.price)}<span class="dpb-book">${bestOdds?.book||''}</span></td>
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
function saveBet(idx, btn){
  if(!S.corbetBets||!S.corbetBets[idx])return;
  const b=S.corbetBets[idx];
  const p=S.lastPrediction;
  const date=p?.date||new Date().toISOString().split('T')[0];
  const prop=`${b.direction} ${b.line} ${b.prop}`;
  // Prevent duplicate saves for same date + prop
  if(S.betLog.some(x=>x.date===date&&x.prop===prop)){
    if(btn){btn.textContent='Already saved';setTimeout(()=>{btn.textContent='+ Save to Record';},1800);}
    return;
  }
  const bet={id:Date.now(),date,player:b._playerName||S.playerName,opponent:S.opposingTeamAbbr||'',prop,odds:b.odds,rating:b.rating,score:b._playerScore||S.lastScore,result:null};
  S.betLog.unshift(bet);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
  if(btn){btn.textContent='✓ Saved!';btn.style.color='#2ecc71';setTimeout(()=>{btn.textContent='+ Save to Record';btn.style.color='';},2000);}
}

function autoSaveTopBets(){
  if(!S.allPlayerBets)return;
  // Don't modify the pre-game picks once first pitch has passed
  if(S.gameStatus==='Live'||S.gameStatus==='Final')return;
  // Use loaded game's officialDate; fall back to Arizona local date (UTC-7) to avoid UTC midnight rollover.
  const date=document.getElementById('game-date').value||new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  const edgeOrder={strong:3,moderate:2,small:1,none:0};
  const qualified=[];
  S.allPlayerBets.forEach(pg=>{
    pg.bets.forEach(b=>{
      if(b.mcConfidence>=85&&b.edgeStrength!=='none'&&!b.insufficient)
        qualified.push({...b,playerName:pg.playerName});
    });
  });
  qualified.sort((a,b)=>(edgeOrder[b.edgeStrength]||0)-(edgeOrder[a.edgeStrength]||0)||(b.ev??b.absDelta/100)-(a.ev??a.absDelta/100)||(b.mcConfidence||0)-(a.mcConfidence||0));
  qualified.slice(0,3).forEach((b,i)=>{
    const prop=`${b.direction} ${b.line} ${b.prop}`;
    if(S.betLog.some(x=>x.date===date&&x.prop===prop))return;
    const rating=b.edgeStrength==='strong'?'green':b.edgeStrength==='moderate'?'yellow':'red';
    const betOdds=b.direction?.toLowerCase()==='over'?b.overBest?.price:b.underBest?.price;
    S.betLog.unshift({id:Date.now()+i,date,player:b.playerName,opponent:S.opposingTeamAbbr||'',prop,odds:betOdds,rating,score:b._playerScore,result:null});
  });
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
}

function autoRegisterGradePredictions() {
  if (!S.players) return;
  const date = document.getElementById('game-date').value
    || new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0];
  const pitcherName = S.pitcher?.name || '';
  Object.entries(S.players).forEach(([playerId, snap]) => {
    if (!snap.score || !snap.factors) return;
    savePredictionForGrading({
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

function renderRecord(){
  const log=S.betLog;
  const stats={green:{w:0,l:0,profit:0},yellow:{w:0,l:0,profit:0},red:{w:0,l:0,profit:0}};
  log.forEach(b=>{
    if(!b.result||b.result==='push'||!stats[b.rating])return;
    if(b.result==='win'){
      stats[b.rating].w++;
      const o=b.odds;
      stats[b.rating].profit+=o>0?o/100:100/Math.abs(o);
    } else if(b.result==='loss'){
      stats[b.rating].l++;
      stats[b.rating].profit-=1;
    }
  });
  ['green','yellow','red'].forEach(c=>{
    const{w,l,profit}=stats[c];
    const total=w+l;
    const pct=total?Math.round((w/total)*100)+'%':'—%';
    const roi=total?(profit/total*100).toFixed(1):'—';
    document.getElementById(`rec-${c}`).textContent=`${w}-${l}`;
    document.getElementById(`rec-${c}-pct`).textContent=pct+' hit rate';
    document.getElementById(`rec-${c}-roi`).textContent=total?`ROI: ${profit>=0?'+':''}${roi}u`:'';
  });
  const allW=stats.green.w+stats.yellow.w+stats.red.w;
  const allL=stats.green.l+stats.yellow.l+stats.red.l;
  const allProfit=stats.green.profit+stats.yellow.profit+stats.red.profit;
  const allTotal=allW+allL;
  document.getElementById('rec-overall').textContent=`${allW}-${allL}`;
  document.getElementById('rec-roi-total').textContent=allTotal?(allProfit>=0?'+':'')+allProfit.toFixed(1)+'u':'—';
  const pending=log.filter(b=>!b.result).length;
  setText('rec-pending',pending?` · ${pending} pending result${pending>1?'s':''}  ↓`:'');
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
  document.getElementById('bet-log').innerHTML=log.map(b=>`
    <div class="bet-log-item${b.result?'':' bet-pending'}">
      <span class="bli-date">${b.date}</span>
      <span class="bli-player">${b.player||'—'}</span>
      <span class="bli-opp">${b.opponent||'—'}</span>
      <span class="bli-prop">${b.prop}</span>
      <span class="bli-odds">${b.odds>0?'+':''}${b.odds??'—'}</span>
      <span class="bli-rating" style="background:${ratingBg[b.rating]};color:${ratingColors[b.rating]}">${b.rating}</span>
      <span class="bli-result">
        <button class="result-btn win ${b.result==='win'?'active':''}" onclick="setResult(${b.id},'win')">W</button>
        <button class="result-btn loss ${b.result==='loss'?'active':''}" onclick="setResult(${b.id},'loss')">L</button>
        <button class="result-btn push ${b.result==='push'?'active':''}" onclick="setResult(${b.id},'push')">P</button>
      </span>
      <button class="del-btn" onclick="deleteBet(${b.id})" title="Remove">×</button>
    </div>`).join('');
}

// ═══════════ SPLITS ════════════════════════════════════════════════════════════
function opsColor(o){if(!o)return'#777';return o>0.850?'#2ecc71':o>0.720?'#fff':'#e74c3c';}
function renderSplitPills(){document.getElementById('splits-pills').innerHTML=[['vs LHP','vl'],['vs RHP','vr'],['Home','h'],['Away','a'],['Day','d'],['Night','n']].map(([l,c])=>{const s=S.splits?.[c];return`<div class="pill"><div class="pill-label">${l}</div><div class="pill-val" style="color:${opsColor(s?.ops)}">${s?.ops?s.ops.toFixed(3):'—'}</div><div class="pill-sub">OPS</div></div>`;}).join('');show('splits-pills');}
function showSplitsLoading(){show('splits-spinner');hide('splits-error');hide('splits-content');hide('splits-empty');}
function showSplitsError(m){hide('splits-spinner');setText('splits-error','⚠ '+m);show('splits-error');}
function renderSplitsTab(){
  hide('splits-spinner');hide('splits-empty');
  const ss=S.seasonStat;
  if(ss)document.getElementById('season-bar').innerHTML=[['AVG',ss.avg],['OBP',ss.obp],['SLG',ss.slg],['OPS',ss.ops],['HR',ss.homeRuns],['RBI',ss.rbi],['GP',ss.gamesPlayed]].map(([l,v])=>`<div><div class="s-label">${l}</div><div class="s-val${l==='OPS'?' green':''}">${v??'—'}</div></div>`).join('');
  document.getElementById('split-grid').innerHTML=[['vs Left-Handed','vl'],['vs Right-Handed','vr'],['Home Games','h'],['Away Games','a'],['Day Games','d'],['Night Games','n']].map(([l,c])=>{const s=S.splits?.[c];return`<div class="split-box"><div class="split-label">${l}</div><div class="split-ops" style="color:${opsColor(s?.ops)}">${s?.ops?s.ops.toFixed(3):'—'}</div><div class="split-sub">OPS</div>${s?.avg?`<div class="split-avg">AVG <span style="color:#666">${s.avg}</span></div>`:''}</div>`;}).join('');
  show('splits-content');
}

// ═══════════ ADVANCED STATS ════════════════════════════════════════════════════
function showStatsLoading(){show('stats-spinner');hide('stats-error');hide('stats-content');hide('stats-empty');}
function showStatsError(m){hide('stats-spinner');setText('stats-error','⚠ '+m);show('stats-error');}
function statBox(l,v,ctx,c){return`<div class="stat-box"><div class="stat-label">${l}</div><div class="stat-val${c?' '+c:''}">${v??'—'}</div>${ctx?`<div class="stat-context">${ctx}</div>`:''}</div>`;}
function pct(n,d){if(!n||!d||d===0)return'—';return((n/d)*100).toFixed(1)+'%';}
function renderStatsTab(){
  hide('stats-spinner');hide('stats-empty');
  const ss=S.seasonStat,risp=S.rispStat;
  if(!ss){showStatsError('No season stats.');return;}
  const pa=ss.plateAppearances||1;
  const bbPct=pct(ss.baseOnBalls,pa),kPct=pct(ss.strikeOuts,pa);
  document.getElementById('stat-slash').innerHTML=statBox('BA',ss.avg,`${ss.hits}H / ${ss.atBats}AB`,'')+statBox('OBP',ss.obp,`${ss.baseOnBalls}BB`,'')+statBox('SLG',ss.slg,`${ss.totalBases}TB`,'')+statBox('OPS',ss.ops,'OBP + SLG',parseFloat(ss.ops)>=0.850?'good':parseFloat(ss.ops)<=0.680?'bad':'')+statBox('BABIP',ss.babip,'Balls in play avg',parseFloat(ss.babip)>=0.340?'good':parseFloat(ss.babip)<=0.270?'bad':'')+statBox('AB/HR',ss.atBatsPerHomeRun?parseFloat(ss.atBatsPerHomeRun).toFixed(1):'—','At-bats per HR','');
  document.getElementById('stat-discipline').innerHTML=statBox('BB%',bbPct,`${ss.baseOnBalls} walks / ${pa} PA`,parseFloat(bbPct)>=10?'good':parseFloat(bbPct)<=5?'bad':'')+statBox('K%',kPct,`${ss.strikeOuts} Ks / ${pa} PA`,parseFloat(kPct)<=16?'good':parseFloat(kPct)>=25?'bad':'')+statBox('BB/K',ss.baseOnBalls&&ss.strikeOuts?(ss.baseOnBalls/ss.strikeOuts).toFixed(2):'—','Walk to K ratio','')+statBox('IBB',ss.intentionalWalks??'0','Intentional walks','')+statBox('HBP',ss.hitByPitch??'0','Hit by pitch','')+statBox('SAC',(ss.sacBunts??0)+(ss.sacFlies??0),'Sac bunts + flies','');
  document.getElementById('stat-power').innerHTML=statBox('HR',ss.homeRuns,`${ss.atBatsPerHomeRun?parseFloat(ss.atBatsPerHomeRun).toFixed(1):'—'} AB/HR`,'')+statBox('2B',ss.doubles,'Doubles','')+statBox('3B',ss.triples,'Triples','')+statBox('XBH',(ss.homeRuns||0)+(ss.doubles||0)+(ss.triples||0),'Extra base hits','')+statBox('RBI',ss.rbi,`${ss.leftOnBase} LOB`,'')+statBox('SB',`${ss.stolenBases}/${(ss.stolenBases||0)+(ss.caughtStealing||0)}`,'SB success','');
  if(risp){const ro=((parseFloat(risp.obp)||0)+(parseFloat(risp.slg)||0)).toFixed(3);const rc=parseFloat(risp.avg)>=0.280?'#2ecc71':parseFloat(risp.avg)<=0.200?'#e74c3c':'#fff';document.getElementById('stat-risp').innerHTML=`<div class="risp-box"><div><div class="stat-label" style="margin-bottom:4px">BA w/ RISP</div><div class="risp-main" style="color:${rc}">${risp.avg??'—'}</div></div><div class="risp-detail">OBP <strong style="color:#fff">${risp.obp??'—'}</strong><br>SLG <strong style="color:#fff">${risp.slg??'—'}</strong><br>OPS <strong style="color:#fff">${ro}</strong>${risp.rbi?`<br>RBI <strong style="color:#fff">${risp.rbi}</strong>`:''}</div><div class="risp-detail">H <strong style="color:#fff">${risp.hits??'—'}</strong><br>AB <strong style="color:#fff">${risp.atBats??'—'}</strong><br>PA <strong style="color:#fff">${risp.plateAppearances??'—'}</strong><br>K <strong style="color:#fff">${risp.strikeOuts??'—'}</strong></div></div>`;}
  else document.getElementById('stat-risp').innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;">RISP data not available.</div>';
  show('stats-content');
}

// ═══════════ GRADING & LEARNING SYSTEM ══════════════════════════════════════

// Default factor weights — these get adjusted by the learning system
const DEFAULT_WEIGHTS = {
  'vs LHP': 70, 'vs RHP': 70, 'Home': 35, 'Away': 35,
  'Day Game': 25, 'Night Game': 25, 'RISP': 20,
  'Pitcher ERA': 4, 'High K%': -4, 'Low K%': 3,
  'Short Rest': 3, 'Extra Rest': -2, 'High Prev PC': 2, 'Bullpen Game': 7,
  'BB%': 3, 'K%': -3, 'Heat': 4, 'Cold': -4,
  'Wind Out': 1, 'Wind In': -1, 'Roof Closed': -2,
  'Altitude': 8, 'Elevation': 3, 'Red-Eye': -6, 'Same-Day Travel': -3,
  'Umpire': 1, 'Barrel%': 4, 'Hard-Hit%': 3, 'Whiff%': 3, 'xwOBA': 4,
  'xBA': 3, 'xSLG': 3,
  'Sweet Spot%': 2, 'Bat Speed': 2, 'Squared-Up%': 2, 'Blast%': 2,
  'GB%': -2, 'FB%': 2,
  'vs Pitcher Career': 6,
  'Crosswind': -2, 'Humidity': -1,
  'Pitcher xwOBA Against': 3, 'Pitcher xERA': 4, 'Pitcher Whiff%': 3,
  'Lineup Protection': 3,
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
    id: Date.now(),
    date: prediction.date || new Date(Date.now()-7*60*60*1000).toISOString().split('T')[0],
    score: prediction.score,
    tier: prediction.tier?.label || prediction.tier || '',
    playerName: prediction.playerName,
    playerId: overridePlayerId ?? S.playerId,
    pitcherName: prediction.pitcherName,
    factors: prediction.factors.map(f => ({ label: f.label, impact: f.impact, value: f.value })),
    graded: false,
  };
  // Don't duplicate same-day predictions — replace if exists
  const existingIdx = pending.findIndex(p => p.date === entry.date && p.playerId === entry.playerId);
  if (existingIdx >= 0) pending[existingIdx] = entry;
  else pending.unshift(entry);
  savePending(pending.slice(0, 50)); // keep last 50 (7–8 players × ~6 days)
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
  // Use first split (covers doubleheader game 1; acceptable for grading)
  const game = splits[0];
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

// Grade a performance — returns outcome category
function gradePerformance(actual, predScore) {
  // Composite performance score based on total bases + hits
  const perfScore = (actual.totalBases * 15) + (actual.hits * 10) + (actual.walks * 8) + (actual.runs * 5) + (actual.rbi * 5);
  const outcome = perfScore >= 55 ? 'great' : perfScore >= 35 ? 'good' : perfScore >= 15 ? 'avg' : 'poor';
  // Model accuracy: did high score predict good performance?
  const modelExpectedGood = predScore >= 60;
  const actuallyGood = perfScore >= 35;
  const modelAccurate = modelExpectedGood === actuallyGood;
  return { perfScore, outcome, modelAccurate, modelExpectedGood, actuallyGood };
}

// Update factor performance stats after grading
function updateFactorPerf(factors, actual, gradeResult) {
  const perf = getFactorPerf();
  factors.forEach(f => {
    if (!perf[f.label]) perf[f.label] = { fires: 0, hits: 0, totalPerf: 0 };
    perf[f.label].fires++;
    perf[f.label].totalPerf += gradeResult.perfScore;
    // A "hit" = when positive factor fired AND performance was good, OR negative factor fired AND performance was poor
    const factorPositive = f.impact === 'positive';
    const perfGood = gradeResult.actuallyGood;
    if ((factorPositive && perfGood) || (!factorPositive && !perfGood)) perf[f.label].hits++;
  });
  saveFactorPerf(perf);
  // Auto-adjust weights after 15+ graded games
  const log = getGradeLog();
  if (log.length >= 15) autoAdjustWeights(perf, log.length);
}

// Auto-adjust factor weights based on hit rates
function autoAdjustWeights(perf, gameCount) {
  const weights = getFactorWeights();
  Object.entries(perf).forEach(([factor, data]) => {
    if (data.fires < 5) return; // need at least 5 samples
    const hitRate = data.hits / data.fires;
    const defaultW = DEFAULT_WEIGHTS[factor];
    if (!defaultW) return;
    // Adjust toward hit rate signal — max ±30% from default
    let adjusted = defaultW;
    if (hitRate >= 0.70)      adjusted = defaultW * 1.30;
    else if (hitRate >= 0.60) adjusted = defaultW * 1.15;
    else if (hitRate <= 0.30) adjusted = defaultW * 0.70;
    else if (hitRate <= 0.40) adjusted = defaultW * 0.85;
    weights[factor] = Math.round(adjusted * 10) / 10;
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
            <div class="gg-title">${pred.date} · vs ${pred.pitcherName||'Unknown'}</div>
            <div style="font-size:10px;color:#999;font-family:monospace;margin-top:3px;">${pred.playerName}</div>
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
          <span style="font-size:10px;color:#777;font-family:monospace;">Fetches actual stats from MLB API</span>
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
      const modelLabel = g.grade.modelAccurate ? 'Accurate' : 'Off';
      const modelClass = g.grade.modelAccurate ? 'accurate' : 'off';
      const playerLast = g.playerName ? g.playerName.split(' ').pop() : '—';
      return `<div class="grade-log-row">
        <span style="color:#888;font-family:monospace;font-size:11px;">${g.date}</span>
        <span style="font-family:monospace;font-size:13px;font-weight:800;color:#A71930;">${g.score}</span>
        <span style="color:#aaa;font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${playerLast}</span>
        <span style="color:#ccc;font-family:monospace;font-size:11px;">${g.actual.summary||`${g.actual.hits}H ${g.actual.totalBases}TB`}</span>
        <span style="color:#888;font-family:monospace;font-size:11px;">${g.actual.totalBases}</span>
        <span class="outcome-badge ${g.grade.outcome}">${outcomeLabels[g.grade.outcome]||g.grade.outcome}</span>
        <span class="model-badge ${modelClass}">${modelLabel}</span>
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
        note.style.cssText = 'font-size:10px;color:#e74c3c;font-family:monospace;';
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
          <span style="font-size:10px;color:#e74c3c;font-family:monospace;">Player had 0 PA — no at-bats recorded</span>`;
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
      det.style.cssText = 'grid-column:1/-1;font-size:9px;font-family:monospace;color:#555;margin-top:4px;';
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
    ctx.fillStyle = '#777'; ctx.font = '9px monospace'; ctx.fillText(v, 4, y + 3);
  });

  const xStep = chartW / (recent.length - 1);

  // Actual performance line (normalized 0-100)
  const maxPerf = Math.max(...recent.map(g => g.grade.perfScore), 1);
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2; ctx.beginPath();
  recent.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (g.grade.perfScore / 100) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Prediction score line
  ctx.strokeStyle = '#A71930'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath();
  recent.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (g.score / 100) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);

  // Dots + dates
  recent.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const py = pad.t + chartH - (g.grade.perfScore / 100) * chartH;
    ctx.fillStyle = '#2ecc71'; ctx.beginPath(); ctx.arc(x, py, 3, 0, Math.PI*2); ctx.fill();
    if (i % 3 === 0) {
      ctx.fillStyle = '#777'; ctx.font = '8px monospace';
      ctx.fillText(g.date.slice(5), x - 10, H - 8);
    }
  });

  // Legend
  ctx.fillStyle = '#2ecc71'; ctx.fillRect(pad.l, 8, 12, 3);
  ctx.fillStyle = '#888'; ctx.font = '9px monospace'; ctx.fillText('Actual', pad.l + 16, 12);
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
  document.getElementById('stat-statcast').innerHTML = '<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">Loading Statcast data...</div>';
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
      statBox('xwOBA',   xwoba,  'Expected weighted OBA',        c(xwobaRaw,0.360,0.300)),
      statBox('xBA',     xba,    'Expected batting average',     c(xbaRaw,0.280,0.220)),
      statBox('xSLG',    xslg,   'Expected slugging %',          c(xslgRaw,0.480,0.360)),
      statBox('Barrel%', brl,    'Barrel rate',                  c(brlRaw,10,4)),
      statBox('HH Rate', hhRate, 'Hard-hit rate (95+ mph EV)',   c(hhRaw,45,35)),
      statBox('Avg EV',  avgEV,  'Avg exit velocity',            c(avgEVRaw,92,86)),
      statBox('Sweet Sp%',sweetSp,'Sweet spot contact %',        c(sweetSpRaw,40,28)),
      statBox('Whiff%',  whiff,  'Whiff rate per swing',         c(whiffRaw,30,20,true)),
      statBox('GB%',     gb,     'Ground ball rate',             ''),
      statBox('FB%',     fb,     'Fly ball rate',                ''),
      statBox('Bat Spd', batSpd, 'Avg bat speed',                c(batSpdRaw,75,68)),
      statBox('Sw Len',  swLen,  'Swing length (shorter=better)',c(swLenRaw,7.4,6.8,true)),
      statBox('Sqd Up%', sqdUp,  'Squared-up per contact',       c(sqdUpRaw,22,12)),
      statBox('Blast%',  blast,  'Blast per contact',            c(blastRaw,8,3)),
    ].join('');

    S.statcast = {
      xwoba: xwobaRaw, xba: xbaRaw, xslg: xslgRaw,
      brl: brlRaw, hhRate: hhRaw, avgEV: avgEVRaw,
      sweetSpot: sweetSpRaw, gb: gbRaw, fb: fbRaw,
      whiff: whiffRaw, batSpeed: batSpdRaw,
      swingLength: swLenRaw, squaredUp: sqdUpRaw, blast: blastRaw,
    };

  } catch(e) {
    document.getElementById('stat-statcast').innerHTML = `<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">Statcast data unavailable: ${e.message}</div>`;
  }
}

// ═══════════ UTILS ════════════════════════════════════════════════════════════
function show(id){document.getElementById(id)?.classList.remove('hidden');}
function hide(id){document.getElementById(id)?.classList.add('hidden');}
function setText(id,t){const el=document.getElementById(id);if(el)el.textContent=t;}

// ═══════════ INIT ══════════════════════════════════════════════════════════════
document.getElementById('game-date').value=new Date().toISOString().split('T')[0]; // fallback until API responds
onStadiumChange();
loadPlayer();
renderRecord();
renderGradePanel();
autoLoadNextGame(); // overwrites date/time and pulls umpire, weather, lineup
