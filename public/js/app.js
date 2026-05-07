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
  lastScore:null, lastPrediction:null,
  betLog: JSON.parse(localStorage.getItem('corbetRecord') || '[]'),
};

// ═══════════ TABS ════════════════════════════════════════════════════════════
function switchTab(id) {
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>{ if(t.getAttribute('onclick')===`switchTab('${id}')`) t.classList.add('active'); });
  if(id==='record') renderRecord();
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
    if(S.pitcher?.id) loadMatchupStats();
  } catch(e){setText('player-error','⚠ Could not load data.');show('player-error');showSplitsError('Could not load.');showStatsError('Could not load.');}
  finally{hide('player-spinner');}
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
    S.pitcher={id,name,hand,st,last3,daysRest,lastOuting};
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
  try{
    const r=await fetch('/savant/statcast?type=pitcher&year=2026');
    const text=await r.text();
    if(!text||text.trim().startsWith('<'))throw new Error('Statcast unavailable');
    const rows=parseCSV(text);
    const pid=String(pitcherId);
    const row=rows.find(r=>String(r.player_id||r['player_id']||'').trim()===pid);
    if(!row){el.innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;grid-column:span 3;">No Statcast data found for this pitcher.</div>';return;}
    const whiffPct=row.whiff_percent?parseFloat(row.whiff_percent).toFixed(1)+'%':'—';
    const gbPct=row.groundballs_percent?parseFloat(row.groundballs_percent).toFixed(1)+'%':'—';
    const fbPct=row.flyballs_percent?parseFloat(row.flyballs_percent).toFixed(1)+'%':'—';
    const brlAgainst=row.brl_percent?parseFloat(row.brl_percent).toFixed(1)+'%':'—';
    const hhAgainst=row.ev95percent?parseFloat(row.ev95percent).toFixed(1)+'%':'—';
    const avgEVAgainst=row.avg_hit_speed?parseFloat(row.avg_hit_speed).toFixed(1)+' mph':'—';
    const whiffC=whiffPct!=='—'?(parseFloat(whiffPct)>=30?'good':parseFloat(whiffPct)<=20?'bad':''):'';
    const gbC=gbPct!=='—'?(parseFloat(gbPct)>=50?'good':''):'';
    const brlC=brlAgainst!=='—'?(parseFloat(brlAgainst)<=5?'good':parseFloat(brlAgainst)>=12?'bad':''):'';
    const hhC=hhAgainst!=='—'?(parseFloat(hhAgainst)<=35?'good':parseFloat(hhAgainst)>=48?'bad':''):'';
    // Store for use in probability estimates
    S.pitcherStatcast={whiff:parseFloat(whiffPct)||null,gbPct:parseFloat(gbPct)||null,fbPct:parseFloat(fbPct)||null,brlAgainst:parseFloat(brlAgainst)||null,hhAgainst:parseFloat(hhAgainst)||null};
    el.innerHTML=[
      statBox('Whiff%',whiffPct,'Whiff rate allowed',whiffC),
      statBox('GB%',gbPct,'Ground ball rate',gbC),
      statBox('FB%',fbPct,'Fly ball rate',''),
      statBox('Barrel% vs',brlAgainst,'Barrels allowed',brlC),
      statBox('HH% vs',hhAgainst,'Hard contact allowed',hhC),
      statBox('Avg EV vs',avgEVAgainst,'Avg EV against',''),
    ].join('');
  }catch(e){
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
    const r=await fetch(`/mlb/api/v1/people/${S.playerId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${S.pitcher.id}&gameType=R`);
    const d=await r.json();
    const st=d?.stats?.[0]?.splits?.[0]?.stat;
    const ab=parseInt(st?.atBats)||0;
    if(!st||ab===0){
      document.getElementById('matchup-content').innerHTML='<div style="font-size:11px;color:#777;font-family:monospace;">No career matchup data — may be first-time opponents.</div>';
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
      <div style="font-size:9px;color:#777;font-family:monospace;">${sample} · ${ab} career AB vs ${S.pitcher.name}</div>`;
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
};

async function autoLoadNextGame(){
  try{
    const today=new Date().toISOString().split('T')[0];
    const end=new Date(Date.now()+7*24*60*60*1000).toISOString().split('T')[0];
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&startDate=${today}&endDate=${end}`);
    const d=await r.json();
    const game=d?.dates?.[0]?.games?.[0];
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
  }catch(e){console.log('Auto game load failed:',e.message);}
}

// ═══════════ LINEUP PROTECTION ════════════════════════════════════════════════
async function loadLineupContext(dv){
  show('lineup-spinner');hide('lineup-content');setText('lineup-empty','');
  try{
    const r=await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&hydrate=lineups&date=${dv}`);
    const d=await r.json();
    const game=d?.dates?.[0]?.games?.[0];
    if(!game){setText('lineup-empty','No D-backs game on this date.');hide('lineup-spinner');show('lineup-empty');return;}
    const isHome=game.teams?.home?.team?.id===109;
    const players=isHome?game.lineups?.homePlayers:game.lineups?.awayPlayers;
    if(!players||players.length===0){setText('lineup-empty','Lineup not yet announced — use manual override below.');hide('lineup-spinner');show('lineup-empty');return;}
    // battingOrder is "100","200","300"... spot 3=300, 4=400, 5=500
    const spots345=players
      .filter(p=>{const o=parseInt(p.battingOrder);return o>=300&&o<=500;})
      .sort((a,b)=>parseInt(a.battingOrder)-parseInt(b.battingOrder))
      .slice(0,3);
    if(spots345.length===0){setText('lineup-empty','Lineup order not yet available.');hide('lineup-spinner');show('lineup-empty');return;}
    const stats=await Promise.all(spots345.map(p=>
      fetch(`/mlb/api/v1/people/${p.id}/stats?stats=season&group=hitting&season=2026&gameType=R`)
        .then(r=>r.json())
        .then(d=>{const st=d?.stats?.[0]?.splits?.[0]?.stat;return{id:p.id,name:p.fullName,ops:parseFloat(st?.ops)||null,order:Math.round(parseInt(p.battingOrder)/100)};})
        .catch(()=>({id:p.id,name:p.fullName,ops:null,order:Math.round(parseInt(p.battingOrder)/100)}))
    ));
    const validOps=stats.filter(p=>p.ops!=null).map(p=>p.ops);
    const avgOps=validOps.length?validOps.reduce((a,b)=>a+b,0)/validOps.length:null;
    const tier=!avgOps?'average':avgOps>=0.780?'strong':avgOps>=0.690?'average':'weak';
    S.lineupProtection={tier,avgOps,spots:stats,manual:false};
    const fmtOps=o=>o!=null?o.toFixed(3):'—';
    const opsColor=o=>!o?'#999':o>=0.780?'#2ecc71':o>=0.690?'#ccc':'#e74c3c';
    const tierLabel={strong:'Strong Protection',average:'Average Protection',weak:'Weak Protection'};
    document.getElementById('lineup-content').innerHTML=
      stats.map(p=>`<div class="lineup-spot"><span class="ls-order">${p.order}.</span><span class="ls-name">${p.name}</span><span class="ls-ops" style="color:${opsColor(p.ops)}">${fmtOps(p.ops)} OPS</span></div>`).join('')+
      `<div><span class="prot-badge ${tier}">${tierLabel[tier]}</span>${avgOps?`<span style="font-size:9px;color:#888;font-family:monospace;margin-left:8px;">${avgOps.toFixed(3)} avg OPS</span>`:''}</div>`;
    show('lineup-content');
    setProtectionButtons(tier);
  }catch(e){setText('lineup-empty','Could not load lineup data.');show('lineup-empty');}
  finally{hide('lineup-spinner');}
}

function setProtection(tier){
  S.lineupProtection={tier,avgOps:null,spots:[],manual:true};
  setProtectionButtons(tier);
}

function setProtectionButtons(tier){
  ['strong','average','weak'].forEach(t=>document.getElementById('prot-'+t).classList.toggle('active',t===tier));
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
  const add=(l,v,adj,n)=>{score+=adj;factors.push({label:l,value:v,impact:adj>2?'positive':adj<-2?'negative':'neutral',note:n});};
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
    if(!isNaN(era)){const a=(era-4.00)*4;add('Pitcher ERA',era.toFixed(2),a,era<3.25?'Elite arm':era<4.00?'Above-average':era<5.00?'League-average':'Hittable pitcher');}
    const pa=S.pitcher.st.battersFaced||1;
    const kp=S.pitcher.st.strikeOuts?(S.pitcher.st.strikeOuts/pa)*100:null;
    if(kp&&kp>=28)add('High K%',kp.toFixed(1)+'%',-4,'Elite swing-and-miss stuff');
    if(kp&&kp<=15)add('Low K%',kp.toFixed(1)+'%',3,'Below-average K rate — more contact opportunities');
    if(S.pitcher.daysRest!=='—'){if(S.pitcher.daysRest<4)add('Short Rest',S.pitcher.daysRest+'d',3,'Pitcher on short rest — fatigue advantage');else if(S.pitcher.daysRest>=6)add('Extra Rest',S.pitcher.daysRest+'d',-2,'Well-rested pitcher — sharper command');}
    const lpc=S.pitcher.lastOuting?.numberOfPitches;
    if(lpc&&lpc>=100)add('High Prev PC',lpc+' pitches',2,`${lpc} pitches last outing — possible fatigue`);
  } else {
    const mEra=parseFloat(document.getElementById('m-pitcher-era')?.value);
    if(!isNaN(mEra)){const a=(mEra-4.00)*4;add('Pitcher ERA',mEra.toFixed(2),a,mEra<3.25?'Elite arm':mEra<4.00?'Above-average':mEra<5.00?'League-average':'Hittable pitcher');}
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
  // Statcast factors
  if(S.statcast){
    const {brl,hhRate,whiff,xwoba}=S.statcast;
    if(brl!=null&&!isNaN(brl)){
      if(brl>=12)add('Barrel%',brl.toFixed(1)+'%',4,'Elite barrel rate — hard contact tendency');
      else if(brl<=4)add('Barrel%',brl.toFixed(1)+'%',-2,'Below-average barrel rate');
    }
    if(hhRate!=null&&!isNaN(hhRate)&&hhRate>=50)add('Hard-Hit%',hhRate.toFixed(1)+'%',3,'Elite hard-hit rate — consistent solid contact');
    if(whiff!=null&&!isNaN(whiff)){
      if(whiff<=18)add('Whiff%',whiff.toFixed(1)+'%',3,'Low whiff rate — difficult to strike out');
      else if(whiff>=30)add('Whiff%',whiff.toFixed(1)+'%',-3,'High whiff rate — vulnerable to swing-and-miss stuff');
    }
    if(xwoba!=null&&!isNaN(xwoba)){
      if(xwoba>=0.380)add('xwOBA',xwoba.toFixed(3),4,'Elite expected production — hitting the ball well');
      else if(xwoba<=0.290)add('xwOBA',xwoba.toFixed(3),-3,'Below-average expected production');
    }
  }
  const w=S.weather;const wm=document.getElementById('weather-manual')&&!document.getElementById('weather-manual').classList.contains('hidden');
  let tempF,windMph,windDir,humidity;
  if(w&&!wm){tempF=w.tempF;windMph=w.windMph;windDir=w.windDir;humidity=w.humidity;}
  else{tempF=parseInt(document.getElementById('temp-slider')?.value)||75;windMph=parseInt(document.getElementById('wind-slider')?.value)||0;windDir=document.getElementById('wind-dir')?.value||'calm';humidity=parseInt(document.getElementById('humid-slider')?.value)||40;}
  if(tempF>=90)add('Heat',tempF+'°F',4,'Hot thin air — more carry on contact');
  else if(tempF<=55)add('Cold',tempF+'°F',-4,'Dense cold air suppresses ball flight');
  const outDirs=['S','SSE','SE','SSW','SW'],inDirs=['N','NNE','NNW','NE','NW'];
  const isOut=outDirs.some(d=>windDir?.startsWith(d)),isIn=inDirs.some(d=>windDir?.startsWith(d));
  const wd=isOut?'out':isIn?'in':windDir==='out'?'out':windDir==='in'?'in':'cross';
  if(wd==='out'&&windMph>=8)add('Wind Out',windMph+' mph',windMph*0.35,'Blowing out — HR potential elevated');
  else if(wd==='in'&&windMph>=8)add('Wind In',windMph+' mph',-windMph*0.28,'Blowing in — suppresses power');
  else if(windMph>=15)add('Crosswind',windMph+' mph',-2,'Strong crosswind affects pitch movement');
  if(humidity>70)add('High Humidity',humidity+'%',-1,'Heavy air slightly suppresses carry');
  const stadOpt=document.getElementById('stadium-select').options[document.getElementById('stadium-select').selectedIndex];
  const hasRoof=stadOpt.dataset.roof==='1',elev=parseInt(stadOpt.dataset.elev);
  if(hasRoof&&S.roofClosed)add('Roof Closed','Indoor',-2,'Controlled environment neutralizes weather edge');
  if(elev>4000)add('Altitude',elev.toLocaleString()+'ft',8,'Thin mile-high air — significant carry boost');
  else if(elev>2000)add('Elevation',elev.toLocaleString()+'ft',3,'Moderate elevation adds mild carry');
  const travel=document.getElementById('travel-select').value;
  if(travel==='redeye')add('Red-Eye','Fatigue risk',-6,'Cross-timezone red-eye suppresses performance');
  else if(travel==='same')add('Same-Day Travel','Mild fatigue',-3,'Same-day travel, minor rest concern');
  if(S.umpire){const ut=UMP_DB[S.umpire.fullName];if(ut&&ut.adj!==0)add('Umpire',S.umpire.fullName,ut.adj,ut.note);}
  if(S.lineupProtection&&S.lineupProtection.tier!=='average'){
    const{tier,avgOps,manual}=S.lineupProtection;
    const val=avgOps?avgOps.toFixed(3)+' avg OPS':(tier==='strong'?'Manual: Strong':'Manual: Weak');
    if(tier==='strong'){
      const adj=avgOps?Math.min(5,Math.round((avgOps-0.730)*35)):3;
      add('Protection',val,adj,'Elite lineup behind Carroll — pitchers must attack him to avoid a big inning');
    } else {
      const adj=avgOps?Math.max(-5,Math.round((avgOps-0.730)*35)):-3;
      add('Protection',val,adj,'Thin lineup behind Carroll — pitchers can work around him freely');
    }
  }
  score=Math.max(4,Math.min(96,Math.round(score)));
  const tiers=[{min:75,label:'Strong Game',color:'#2ecc71',desc:'Conditions strongly favor a productive day'},{min:60,label:'Favorable',color:'#a8e063',desc:'More factors lean positive than negative'},{min:42,label:'Neutral',color:'#f39c12',desc:'Mixed bag — could go either way'},{min:28,label:'Tough Spot',color:'#e67e22',desc:'Multiple headwinds against production'},{min:0,label:'Difficult',color:'#e74c3c',desc:'Significant factors stacked against a big day'}];
  return{score,tier:tiers.find(t=>score>=t.min),factors,tempF,windMph,windDir:wd,humidity};
}

function runPrediction(){
  const{score,tier,factors,tempF,windMph,windDir,humidity}=calcPrediction();
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
  const colors={positive:'#2ecc71',negative:'#e74c3c',neutral:'#f39c12'};
  const icons={positive:'▲',negative:'▼',neutral:'●'};
  document.getElementById('factors-body').innerHTML=factors.length===0?'<div style="font-size:12px;color:#777;font-family:monospace;">Add more conditions for a richer breakdown.</div>':factors.map(f=>`<div class="factor-row"><span class="factor-icon" style="color:${colors[f.impact]}">${icons[f.impact]}</span><span class="factor-label">${f.label}</span><span class="factor-value">${f.value}</span><span class="factor-note">${f.note}</span></div>`).join('');
  document.getElementById('pitch-display').innerHTML=Object.entries(S.pitcherPitches).filter(([,v])=>v>0).sort(([,a],[,b])=>b-a).map(([type,pct])=>`<div class="pitch-row"><span class="pitch-label">${type}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${pct}%;background:${pct>35?'#A71930':'#3a3560'}"></div></div><span class="pitch-pct">${pct}%</span></div>`).join('');
  S.lastScore=score;S.lastPrediction={score,tier,factors,tempF,windMph,windDir,humidity,playerName:S.playerName,pitcherName:pn,hand,era,date:document.getElementById('game-date').value||new Date().toISOString().split('T')[0]};
  savePredictionForGrading(S.lastPrediction);
  hide('no-prediction');show('prediction-output');
  // Reset corbet
  hide('corbet-bets');hide('corbet-no-props');hide('corbet-error');
  show('corbet-no-prediction');
  switchTab('result');
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

  if(prob===null)return null;
  if(direction==='under')prob=100-prob;
  return Math.max(1,Math.min(99,prob));
}

function generateCorbetBets(score,factors,props){
  const propNames={
    'batter_hits':'Hits','batter_total_bases':'Total Bases','batter_home_runs':'Home Runs',
    'batter_rbis':'RBI','batter_walks':'Walks','batter_strikeouts':'Strikeouts',
  };
  const lineMax={'batter_hits':1.5,'batter_total_bases':2.5,'batter_home_runs':0.5,'batter_rbis':1.5,'batter_walks':1.5,'batter_strikeouts':2.5};

  // Score every prop individually, pick the best outcome per prop key
  const scored=[];
  const seenKeys=new Set();
  props.forEach(prop=>{
    const name=propNames[prop.key];
    if(!name||seenKeys.has(prop.key))return;
    const maxLine=lineMax[prop.key]||99;
    const propScore=scoreIndividualProp(prop.key);
    const wantOver=propScore>=50;
    const wantDir=wantOver?'over':'under';
    prop.outcomes?.forEach(outcome=>{
      const dir=outcome.name.toLowerCase();
      const line=outcome.point||0;
      if(line>maxLine)return;
      if(prop.key==='batter_home_runs'&&line>0.5)return;
      if(dir!==wantDir)return;
      // Keep only one outcome per prop key (closest line to 0.5 for HRs, first otherwise)
      if(!seenKeys.has(prop.key)){
        seenKeys.add(prop.key);
        scored.push({prop:name,propKey:prop.key,direction:wantOver?'Over':'Under',line,odds:outcome.price,propScore,books:prop.books||[]});
      }
    });
  });

  if(scored.length===0)return[];

  // Sort by signal strength (distance from 50), strongest first
  scored.sort((a,b)=>Math.abs(b.propScore-50)-Math.abs(a.propScore-50));

  // Pick top 3 and hard-assign Green / Yellow / Red by rank
  return scored.slice(0,3).map((b,i)=>{
    const rating=['green','yellow','red'][i];
    return{...b,rating,reasoning:corbetReasoning(b.propKey,b.direction.toLowerCase(),b.propScore)};
  });
}

async function loadCorbet(){
  if(!S.lastPrediction){show('corbet-no-prediction');return;}
  hide('corbet-no-prediction');hide('corbet-bets');hide('corbet-no-props');hide('corbet-error');
  show('corbet-loading');
  try{
    // Step 1: Get MLB events list (no markets param)
    const r=await fetch('/odds/v4/sports/baseball_mlb/events?regions=us&oddsFormat=american');
    const eventsText=await r.text();
    let events;
    try{events=JSON.parse(eventsText);}catch(e){throw new Error('Could not parse Odds API response. Try again in a moment.');}
    if(!Array.isArray(events)){throw new Error(events?.message||'Unexpected response from Odds API');}

    // Find D-backs game (today or upcoming)
    const dbacksGame=events.find(e=>e.home_team?.includes('Arizona')||e.away_team?.includes('Arizona'));
    if(!dbacksGame){
      hide('corbet-loading');
      document.getElementById('corbet-no-props').textContent='No D-backs game found in upcoming schedule. Props are typically available 1-2 days before game time. Check back closer to the next game.';
      show('corbet-no-props');return;
    }

    // Step 2: Get player props for this specific event
    const propMarkets='batter_hits,batter_total_bases,batter_home_runs,batter_rbis,batter_walks,batter_strikeouts';
    const pr=await fetch(`/odds/v4/sports/baseball_mlb/events/${dbacksGame.id}/odds?regions=us&markets=${propMarkets}&oddsFormat=american`);
    const propsText=await pr.text();
    let propData;
    try{propData=JSON.parse(propsText);}catch(e){throw new Error('Props endpoint returned invalid response.');}

    // Extract player props, searching by last name
    const playerSearch=S.playerName.toLowerCase().split(' ').pop();
    const marketMap={};
    (propData.bookmakers||[]).forEach(book=>{
      (book.markets||[]).forEach(market=>{
        if(!marketMap[market.key])marketMap[market.key]={key:market.key,outcomes:[],books:[]};
        market.outcomes
          .filter(o=>(o.description||o.name||'').toLowerCase().includes(playerSearch))
          .forEach(o=>{
            const existing=marketMap[market.key].outcomes.find(e=>e.name===o.name&&Math.abs((e.point||0)-(o.point||0))<0.1);
            if(!existing)marketMap[market.key].outcomes.push({name:o.name,point:o.point,price:o.price,description:o.description});
            if(!marketMap[market.key].books.includes(book.title))marketMap[market.key].books.push(book.title);
          });
      });
    });

    const props=Object.values(marketMap).filter(m=>m.outcomes.length>0);
    if(props.length===0){hide('corbet-loading');show('corbet-no-props');return;}

    const bets=generateCorbetBets(S.lastScore,S.lastPrediction.factors,props);
    if(bets.length===0){hide('corbet-loading');show('corbet-no-props');return;}

    const ratingLabel={green:'🟢 Best Bet',yellow:'🟡 Moderate',red:'🔴 Long Shot'};
    const ratingColor={green:'#2ecc71',yellow:'#f39c12',red:'#e74c3c'};
    document.getElementById('corbet-bets').innerHTML=bets.map((b,i)=>{
      const impl=impliedProb(b.odds);
      const est=estimateProbability(b.propKey,b.direction.toLowerCase(),b.line);
      const edge=(impl!==null&&est!==null)?(est-impl):null;
      const edgeColor=edge===null?'#888':edge>2?'#2ecc71':edge<-2?'#e74c3c':'#f39c12';
      const edgeLabel=edge===null?'—':(edge>0?'+':'')+edge.toFixed(1)+'%';
      return`<div class="bet-card ${b.rating}">
        <div class="bet-card-header">
          <span class="bet-rating ${b.rating}">${ratingLabel[b.rating]}</span>
          <button onclick="saveBet(${i},this)" style="background:#0e0c22;border:1px solid #1e1b3a;border-radius:4px;color:#888;font-family:monospace;font-size:9px;cursor:pointer;padding:3px 8px;letter-spacing:1px;text-transform:uppercase;">+ Save to Record</button>
        </div>
        <div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px;">
          <span style="font-size:32px;font-weight:900;font-family:monospace;line-height:1;color:${ratingColor[b.rating]}">${b.propScore}</span>
          <span style="font-size:11px;color:#888;font-family:monospace;">/100 prop score</span>
        </div>
        <div class="bet-prop ${b.rating}">${S.playerName} ${b.direction} ${b.line} ${b.prop}</div>
        <div style="display:flex;gap:14px;margin:8px 0 4px;flex-wrap:wrap;">
          <div style="font-family:monospace;font-size:11px;"><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">American</div><div style="color:#ccc;">${b.odds>0?'+':''}${b.odds}</div></div>
          <div style="font-family:monospace;font-size:11px;"><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Implied</div><div style="color:#ccc;">${impl!==null?impl.toFixed(1)+'%':'—'}</div></div>
          <div style="font-family:monospace;font-size:11px;"><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Est. Prob</div><div style="color:#ccc;">${est!==null?est.toFixed(1)+'%':'—'}</div></div>
          <div style="font-family:monospace;font-size:11px;"><div style="font-size:9px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;">Edge</div><div style="color:${edgeColor};font-weight:700;">${edgeLabel}</div></div>
        </div>
        <div style="font-size:10px;color:#666;font-family:monospace;margin-bottom:6px;">${b.books.slice(0,3).join(' · ')}</div>
        <div class="bet-reasoning">${b.reasoning}</div>
      </div>`;
    }).join('');
    S.corbetBets=bets;
    show('corbet-bets');
  }catch(e){
    hide('corbet-loading');
    setText('corbet-error','⚠ '+e.message);
    show('corbet-error');
  }finally{hide('corbet-loading');}
}

// Override tab switch for corbet to auto-load
const origSwitch=switchTab;
function switchTab(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>{if(t.getAttribute('onclick')===`switchTab('${id}')`)t.classList.add('active');});
  if(id==='corbet')loadCorbet();
  if(id==='record')renderRecord();
  if(id==='grade')renderGradePanel();
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
  const bet={id:Date.now(),date,player:S.playerName,prop,odds:b.odds,rating:b.rating,score:S.lastScore,result:null};
  S.betLog.unshift(bet);
  localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
  renderRecord();
  if(btn){btn.textContent='✓ Saved!';btn.style.color='#2ecc71';setTimeout(()=>{btn.textContent='+ Save to Record';btn.style.color='';},2000);}
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
      <span class="bli-prop">${b.prop}</span>
      <span class="bli-odds">${b.odds>0?'+':''}${b.odds}</span>
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
  'Short Rest': 3, 'Extra Rest': -2, 'High Prev PC': 2,
  'BB%': 3, 'K%': -3, 'Heat': 4, 'Cold': -4,
  'Wind Out': 1, 'Wind In': -1, 'Roof Closed': -2,
  'Altitude': 8, 'Elevation': 3, 'Red-Eye': -6, 'Same-Day Travel': -3,
  'Umpire': 1, 'Barrel%': 4, 'Hard-Hit%': 3, 'Whiff%': 3, 'xwOBA': 4,
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
function savePredictionForGrading(prediction) {
  const pending = getPending();
  const entry = {
    id: Date.now(),
    date: prediction.date || new Date().toISOString().split('T')[0],
    score: prediction.score,
    tier: prediction.tier.label,
    playerName: prediction.playerName,
    playerId: S.playerId,
    pitcherName: prediction.pitcherName,
    factors: prediction.factors.map(f => ({ label: f.label, impact: f.impact, value: f.value })),
    graded: false,
  };
  // Don't duplicate same-day predictions — replace if exists
  const existingIdx = pending.findIndex(p => p.date === entry.date && p.playerId === entry.playerId);
  if (existingIdx >= 0) pending[existingIdx] = entry;
  else pending.unshift(entry);
  savePending(pending.slice(0, 30)); // keep last 30
}

// Fetch actual Carroll stats for a given date from MLB API
async function fetchActualStats(playerId, date) {
  const res = await fetch(`/mlb/api/v1/people/${playerId}/stats?stats=gameLog&group=hitting&season=2026&gameType=R`);
  const data = await res.json();
  const splits = data?.stats?.[0]?.splits ?? [];
  const game = splits.find(s => s.date === date);
  if (!game) return null;
  return {
    hits:         game.stat.hits ?? 0,
    totalBases:   game.stat.totalBases ?? 0,
    homeRuns:     game.stat.homeRuns ?? 0,
    walks:        game.stat.baseOnBalls ?? 0,
    strikeOuts:   game.stat.strikeOuts ?? 0,
    rbi:          game.stat.rbi ?? 0,
    runs:         game.stat.runs ?? 0,
    atBats:       game.stat.atBats ?? 0,
    pa:           game.stat.plateAppearances ?? 0,
    summary:      game.stat.summary ?? '',
    opponent:     game.opponent?.name ?? '',
    isHome:       game.isHome ?? false,
    isWin:        game.isWin ?? false,
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
          <span style="font-size:10px;color:#777;font-family:monospace;">Fetches Carroll's actual stats from MLB API</span>
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
      return `<div class="grade-log-row">
        <span style="color:#888;font-family:monospace;font-size:11px;">${g.date}</span>
        <span style="font-family:monospace;font-size:13px;font-weight:800;color:#A71930;">${g.score}</span>
        <span style="color:#ccc;font-family:monospace;font-size:11px;">${g.actual.summary||`${g.actual.hits}H ${g.actual.totalBases}TB`}</span>
        <span style="color:#888;font-family:monospace;font-size:11px;">${g.actual.totalBases}TB</span>
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
      alert(`No stats found for ${date}. The game may not have finished yet, or Carroll didn't play.`);
      return;
    }
    // Show actual stats
    const statMap = { H: actual.hits, TB: actual.totalBases, HR: actual.homeRuns, BB: actual.walks, K: actual.strikeOuts, RBI: actual.rbi };
    Object.entries(statMap).forEach(([key, val]) => {
      const el = document.getElementById(`stat-${predId}-${key}`);
      if (el) { el.textContent = val; el.classList.remove('loading'); el.style.color = val > 0 ? '#2ecc71' : '#fff'; }
    });
    if (btn) { btn.textContent = '✓ Confirm Grade'; btn.disabled = false; btn.onclick = () => confirmGrade(predId, actual); }
  } catch(e) {
    if (btn) { btn.textContent = '⟳ Fetch & Grade'; btn.disabled = false; }
    alert('Could not fetch stats: ' + e.message);
  }
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
    const [statRes, expRes, batRes] = await Promise.all([
      fetch('/savant/statcast?type=batter&year=2026'),
      fetch('/savant/expected?type=batter&year=2026'),
      fetch('/savant/battracking?year=2026'),
    ]);
    const [statText, expText, batText] = await Promise.all([statRes.text(), expRes.text(), batRes.text()]);

    const statRows = parseCSV(statText);
    const expRows  = parseCSV(expText);
    const batRows  = parseCSV(batText);

    // Find player row by ID
    const sid = String(playerId);
    // Try multiple possible ID column names and strip any whitespace
    const statRow = statRows.find(r => String(r.player_id||r['player_id']||'').trim() === sid);
    const expRow  = expRows.find(r  => String(r.player_id||r['player_id']||'').trim() === sid);
    const batRow  = batRows.find(r  => String(r.id||r['id']||r.player_id||'').trim() === sid);

    // Debug log to console
    console.log('Statcast rows found:', statRows.length, 'stat match:', !!statRow, 'exp match:', !!expRow, 'bat match:', !!batRow);

    const xwoba   = expRow  ? parseFloat(expRow.est_woba).toFixed(3)       : '—';
    const brl     = statRow ? parseFloat(statRow.brl_percent).toFixed(1)+'%': '—';
    const hhRate  = statRow ? parseFloat(statRow.ev95percent).toFixed(1)+'%': '—';
    const avgEV   = statRow ? parseFloat(statRow.avg_hit_speed).toFixed(1)  : '—';
    const whiff   = batRow  ? (parseFloat(batRow.whiff_per_swing)*100).toFixed(1)+'%': '—';
    const batSpd  = batRow  ? parseFloat(batRow.avg_bat_speed).toFixed(1)+' mph': '—';

    const xwobaColor = xwoba!=='—'?(parseFloat(xwoba)>=0.360?'good':parseFloat(xwoba)<=0.300?'bad':''):'';
    const brlColor   = brl!=='—'?(parseFloat(brl)>=10?'good':parseFloat(brl)<=4?'bad':''):'';
    const hhColor    = hhRate!=='—'?(parseFloat(hhRate)>=45?'good':parseFloat(hhRate)<=35?'bad':''):'';
    const whiffColor = whiff!=='—'?(parseFloat(whiff)<=20?'good':parseFloat(whiff)>=30?'bad':''):'';

    document.getElementById('stat-statcast').innerHTML = [
      statBox('xwOBA',  xwoba,  'Expected weighted OBA', xwobaColor),
      statBox('Barrel%', brl,   'Barrel rate', brlColor),
      statBox('HH Rate', hhRate,'Hard-hit rate (95+ mph EV)', hhColor),
      statBox('Avg EV',  avgEV+'mph', 'Avg exit velocity', ''),
      statBox('Whiff%',  whiff, 'Whiff rate per swing', whiffColor),
      statBox('Bat Spd', batSpd,'Avg bat speed', ''),
    ].join('');

    // Store for prediction use
    S.statcast = { xwoba: parseFloat(xwoba)||null, brl: parseFloat(brl)||null, hhRate: parseFloat(hhRate)||null, whiff: parseFloat(whiff)||null };

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
