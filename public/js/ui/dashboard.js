// Dashboard renderers. Heavy DOM, reads from S. No S mutation.
// Owns: schedule strip, team momentum bar, game banner, best-bets list,
// player rows (with matchup/splits/recent-form mini-cards), and the legacy
// MVP banner (kept for potential re-enable).

import { S, activeRoster } from '../state.js';
import * as api from '../api.js';
import { _renderPitcherCard, _renderBestMatchup } from './render.js';
import { _getTopBets, getActiveInflators } from '../bets.js';
import { bookAbbrev } from '../betting.js';
import { MC_CONFIDENCE_MIN } from '../constants.js';
import { _COMPASS_DEGS } from '../weather.js';

// ── Team momentum bar (dashboard top strip) ─────────────────────────────────
// Pulls D-backs standings: streak, last 10, run differential, NL West rank.
export async function loadTeamMomentum(){
  const el=document.getElementById('dash-momentum-bar');
  if(!el)return;
  try{
    const d=await api.mlbStandings(104);
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


// ── (LEGACY) Projected MVP banner — replaced by Best Matchup card above ─────
// Kept around in case we want to re-enable it. Currently not called.
export function _renderMvpBanner(){
  const el=document.getElementById('dash-mvp-banner');
  if(!el)return;

  // Primary path: pick player whose top bet has the highest EV
  const candidates=[];
  (S.allPlayerBets||[]).forEach(pg=>{
    if(pg.lowData)return;
    const bestBet=pg.bets
      .filter(b=>!b.insufficient&&b.edgeStrength!=='none'&&b.mcConfidence>=MC_CONFIDENCE_MIN)
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
export async function loadTwoWeekSchedule(){
  const el=document.getElementById('dash-schedule');
  if(!el)return;
  try{
    // Anchor the 14-day grid on the Sunday-of-this-week using Arizona time
    // (UTC-7 year-round, no DST) so the calendar day is correct for MST users
    // near UTC midnight. Same offset technique used in autoLoadNextGame.
    const nowMST=new Date(Date.now()-7*60*60*1000);
    const dow=nowMST.getUTCDay(); // 0=Sun … 6=Sat in MST
    const todayKey=nowMST.toISOString().split('T')[0];
    const startD=new Date(Date.UTC(nowMST.getUTCFullYear(),nowMST.getUTCMonth(),nowMST.getUTCDate()-dow));
    const endD=new Date(startD.getTime()+13*24*60*60*1000);
    const start=startD.toISOString().split('T')[0];
    const end=endD.toISOString().split('T')[0];
    const d=await api.mlbScheduleRange(start, end, 'probablePitcher,team');

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

// ── Game banner (top of dashboard) ──────────────────────────────────────────
export function _renderGameBanner(){
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

// Toggle the "Top 5 Bets" panel between EV% and Δ% ranking. Persisted so the
// choice sticks across reloads. Re-renders the dashboard to re-sort the panel
// (and the matching star icons on the player rows).
export function setTopBetsSort(mode){
  const m=mode==='delta'?'delta':'ev';
  if(S.topBetsSort===m)return;
  S.topBetsSort=m;
  localStorage.setItem('corbetTopBetsSort',m);
  renderDashboard();
}

// ── Main dashboard render: best-bets list + collapsible player rows ─────────
export function renderDashboard(){
  _renderGameBanner();
  _renderPitcherCard();
  _renderBestMatchup();
  const fmtOdds=p=>p!=null?(p>0?'+':'')+p:'—';
  const edgeOrder={strong:3,moderate:2,small:1,none:0};

  // Reflect the active Top-5 sort mode on the toggle buttons
  const tbSort=S.topBetsSort==='delta'?'delta':'ev';
  document.querySelectorAll('.tb-sort-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.value===tbSort);
  });

  // Top 5 bets — only when props are available
  if(S.allPlayerBets&&S.allPlayerBets.length){
    const topBets=_getTopBets(5,tbSort);
    const _tbIdByName={};
    activeRoster().forEach(p=>{_tbIdByName[p.name]=p.id;});
    document.getElementById('dash-best-bets').innerHTML=topBets.length
      ?topBets.map(b=>{
        const _tb_softBadge=(b.marketConfidence==='low'||b.marketConfidence==='medium')
          ?` <span class="dpb-soft-market" data-tip="Thinly traded / soft market — fewer books have posted this line, so the over/under prices are more asymmetric than usual. The EV estimate is less precise, but soft lines are often early-market opportunities before the price moves to consensus. Treat the exact EV% with extra skepticism.">⚠</span>`
          :'';
        const _tbBest=b.direction.toLowerCase()==='over'?b.overBest:b.underBest;
        const _tbBookBadge=_tbBest?.book?`<span class="dpb-book">${bookAbbrev(_tbBest.book)}</span>`:'';
        const _tbPid=_tbIdByName[b.playerName];
        const _tbAttrs=_tbPid?` class="dash-best-bet-row dash-best-bet-row--link" data-action="open-player-corbet" data-player-id="${_tbPid}" title="View CorBET bets for ${b.playerName}"`:' class="dash-best-bet-row"';
        // Market% → Model% sticker for the picked side (Under flips both to the under side)
        const _tbUnder=b.direction.toLowerCase()==='under';
        const _tbMktP=_tbUnder?b.marketUnderProb:b.marketOverProb;
        const _tbModP=_tbUnder?(b.modelProb!=null?100-b.modelProb:null):b.modelProb;
        const _tbProbBadge=(_tbMktP!=null&&_tbModP!=null)
          ?`<span class="dash-badge dash-badge--prob" title="Market-implied probability → model probability for this side">(${Math.round(_tbMktP)}% → ${Math.round(_tbModP)}%)</span>`
          :'';
        return`<div${_tbAttrs}>
        <div class="dash-best-bet-left">
          <div class="dash-best-bet-player">${b.playerName}</div>
          <div class="dash-best-bet-prop">${b.direction.toUpperCase()} ${b.line} ${b.prop}${_tb_softBadge}</div>
        </div>
        <div class="dash-best-bet-right">
          <span class="dash-badge">${fmtOdds(_tbBest?.price)}${_tbBookBadge}</span>
          <span class="dash-badge" title="Edge stability % — not win probability">Stab ${b.mcConfidence.toFixed(0)}%</span>
          ${b.ev!=null?`<span class="dash-badge" title="Expected value — average return per $1 wagered at the best posted price">EV ${b.ev>=0?'+':''}${(b.ev*100).toFixed(1)}%</span>`:''}
          <span class="dash-badge" title="Model probability minus market-implied probability (percentage points)">Δ ${(b.delta>0?'+':'')+b.delta.toFixed(1)}%</span>
          ${_tbProbBadge}
        </div>
      </div>`;}).join('')
      :'<div class="dash-empty">No bets meet the 85% MC threshold today.</div>';
  }

  // Player rows — collapsible, sorted by batting order
  const betsMap={};
  (S.allPlayerBets||[]).forEach(pg=>{betsMap[pg.playerName]=pg;});

  // Pre-compute top-5 set so star icons can be applied per bet row.
  // Shared helper ensures lowData filter matches the Top 5 panel.
  const topBetsKeys=new Set(_getTopBets(5,tbSort).map(b=>`${b.playerName}_${b.propKey}_${b.direction}`));

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
        const icon=topBetsKeys.has(key)
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
        ${pg?`<button class="dpb-more-bets" data-action="open-player-corbet" data-player-id="${pid}">View More Bets for ${player.name} ›</button>`:''}`;
    }else if(pg){
      betsHtml='<div class="dpb-no-edge">No strong edges today</div>';
    }else{
      betsHtml='<div class="dpb-no-edge">Props not yet posted</div>';
    }

    const analysisText=_lineupAnalysisText(snap);
    const analysisHtml=analysisText?`<div class="dpb-lineup-analysis">${analysisText}</div>`:'';
    const matchupHtml=_matchupCardHtml(snap);
    const splitsHtml=_splitsCardHtml(snap);
    const recentHtml=_recentFormHtml(snap);

    const avgStr=snap.seasonStat?.avg?parseFloat(snap.seasonStat.avg).toFixed(3):'—';
    const opsStr=snap.seasonStat?.ops?parseFloat(snap.seasonStat.ops).toFixed(3):'—';

    // ⚑ if a known pure-inflator factor is actively lifting tonight's score —
    // warns at the top-level glance that this player's bullishness may be hollow.
    const activeInf=getActiveInflators(player.name,snap.factors);
    const inflatorBadge=activeInf.length
      ?`<span class="inflator-badge" data-tip="Score may be inflated — ${activeInf.map(i=>i.label).join(', ')} ${activeInf.length>1?'have':'has'} historically fired positive on ${player.name}'s bad games and never on a good one. Treat the model's bullishness here with skepticism.">⚑</span>`
      :'';
    const lowDataBadge=snap.lowData?`<span class="low-data-badge" title="Fewer than 50 PA this season — small sample">⚠ Low PA</span>`:'';
    const lowDataWarning=snap.lowData?`<div class="low-data-warning">⚠ Fewer than 50 PA this season — rate stats (BB%, K%, AVG) may not be reliable with a small sample</div>`:'';
    return`<div class="dash-prow" id="dpr-${pid}">
      <div class="dash-prow-header" data-action="toggle-player-card" data-player-id="${pid}">
        <span class="dash-prow-order">${orderLabel}</span>
        ${snap.pos?`<span class="dash-prow-pos">${snap.pos}</span>`:''}
        <span class="dash-prow-name">${player.name}</span>${inflatorBadge}${lowDataBadge}
        <span class="dash-prow-statline">AVG ${avgStr} &nbsp; OPS ${opsStr}</span>
        <button class="dash-prow-more" data-action="open-player-stats" data-player-id="${pid}">More Stats ›</button>
        <span class="dash-prow-arrow" id="dpa-${pid}">▼</span>
      </div>
      <div class="dash-prow-body hidden" id="dpb-${pid}">
        <div class="dpb-left">
          <div class="dpb-gauge" style="border-color:${scoreColor}">
            <div class="dpb-gauge-score" style="color:${scoreColor}">${snap.score}</div>
          </div>
          <div class="dpb-tier" style="color:${scoreColor}">${snap.tier?.label||''}</div>
          <button class="dpb-details-btn" data-action="open-player-details" data-player-id="${pid}">Details ›</button>
        </div>
        <div class="dpb-center">${lowDataWarning}${betsHtml}</div>
        <div class="dpb-right">${matchupHtml}${splitsHtml}${recentHtml}</div>
        ${analysisHtml}
      </div>
    </div>`;
  }).join('');
}

export function togglePlayerCard(playerId){
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

function _splitsCardHtml(snap){
  const hand=S.pitcher?.hand||S.pitcherThrows||'R';
  const s=hand==='L'?snap.splits?.vl:snap.splits?.vr;
  const label=`SPLITS VS ${hand}HP`;
  if(!s||!s.pa){
    return`<div class="dpb-mini-card">
      <div class="dpb-mini-head">${label}</div>
      <div class="dpb-mini-empty">No splits data</div>
    </div>`;
  }
  const fmt=v=>(parseFloat(v)||0).toFixed(3).replace(/^0/,'');
  const slash=`${fmt(s.avg)}/${fmt(s.obp)}/${fmt(s.slg)}`;
  return`<div class="dpb-mini-card">
    <div class="dpb-mini-head">${label} · ${s.pa} PA</div>
    <div class="dpb-mini-row">${slash}</div>
    <div class="dpb-mini-row">${s.h} H · ${s.hr} HR · ${s.k} K · ${s.bb} BB</div>
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
