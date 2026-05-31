// Bet Record, Grade panel, Calibration, and CorBET bets renderers.
// Pure DOM rendering — reads S, listens for the 'bets:changed' /
// 'grades:changed' events that bets.js dispatches when stores mutate.
// app.js wires the event listeners during bootstrap.

import { S } from '../state.js';
import { DEFAULT_WEIGHTS } from '../constants.js';
import { show, hide, setText } from '../utils.js';
import { bookAbbrev, devig } from '../betting.js';
import { modelProbability } from '../predict.js';
import {
  getCalibrationParams, getGlobalCalibration, getBlendWeight, isBlendTuned,
} from '../calibrate.js';
import { DEFAULT_BLEND_W, MIN_CAL_SAMPLE } from '../constants.js';
import {
  gradePerformance,
  getPending, getGradeLog, getFactorPerf, getFactorWeights,
} from '../bets.js';

// ═══════════ CORBET BETS ════════════════════════════════════════════════════

// Convert a model win probability (percent, 0-100) to fair American odds.
function probToAmerican(pct){
  const p=Math.min(99.5,Math.max(0.5,pct))/100;
  return p>=0.5?Math.round(-p/(1-p)*100):Math.round((1-p)/p*100);
}

export function renderCorbetBets(){
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
      const _softBadge=(b.marketConfidence==='low'||b.marketConfidence==='medium')
        ?` <span class="dpb-soft-market" data-tip="Thinly traded / soft market — fewer books have posted this line, so the over/under prices are more asymmetric than usual. The EV estimate is less precise, but soft lines are often early-market opportunities before the price moves to consensus. Treat the exact EV% with extra skepticism.">⚠</span>`
        :'';
      const _modelDirPct=b.direction==='Over'?b.modelProb:100-b.modelProb;
      const _modelOdds=fmtOdds(probToAmerican(_modelDirPct));
      const _evPct=b.ev!=null?b.ev*100:null;
      const _evColor=_evPct!=null?(_evPct>=0?'#2ecc71':'#e74c3c'):'#ccc';
      const _evStr=_evPct!=null?(_evPct>=0?'+':'')+_evPct.toFixed(1)+'%':'—';
      const _evInfo=` <span class="corbet-info" data-tip="Expected Value — the model's average profit per $1 staked at the best available price, if this bet were repeated many times. A positive EV% means the price beats the model's fair odds; negative means it doesn't.">ⓘ</span>`;
      return`<div class="bet-card" style="${cardBg};border-radius:10px;padding:14px 16px;margin-bottom:10px;border:1px solid;">
        <div class="bet-card-header">
          <span style="font-size:13px;font-weight:900;font-family:\'Chakra Petch\',monospace;color:#ccc;">${b.prop} <span style="color:#666;font-size:10px;">· ${b.line}</span>${_softBadge}</span>
          ${showSave?`<button data-action="save-bet" data-bk="${betKey.replace(/"/g,'&quot;')}" style="background:#0e0c22;border:1px solid #1e1b3a;border-radius:4px;color:#888;font-family:\'Chakra Petch\',monospace;font-size:9px;cursor:pointer;padding:3px 8px;letter-spacing:1px;text-transform:uppercase;">+ Save</button>`:''}
        </div>
        ${b.conflict?`<div style="background:#1a0808;border:1px solid #4a1010;border-radius:6px;padding:6px 10px;margin:6px 0 8px;font-size:9px;color:#e74c3c;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;">⚠ CONFLICT — Direction contradicts Total Bases recommendation. No edge shown.</div>`:''}
        ${b.channelConflict&&!b.conflict?`<div style="background:#1a1408;border:1px solid #4a3a10;border-radius:6px;padding:6px 10px;margin:6px 0 8px;font-size:9px;color:#e6a23c;font-family:\'Chakra Petch\',monospace;letter-spacing:1px;" data-tip="The recommendation is carried by the score channel, but the bottom-up rate model lands on the opposite side of the market — often a strong-pitcher spot. Edge downgraded one notch.">⚠ SOFT EDGE — Rate model disagrees with the score channel. Confidence downgraded.</div>`:''}
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
          <div style="position:relative;" data-phantom-bar-host="${betKey.replace(/"/g,'&quot;')}">
            <div class="prob-bar-wrap">
              <div class="prob-bar-over" style="width:${overW}%">${overW}%</div>
              <div class="prob-bar-under" style="width:${underW}%">${underW}%</div>
            </div>
            <div class="prob-bar-model-marker" style="position:absolute;top:0;left:${markerLeft}%;width:2px;height:22px;background:rgba(255,255,255,0.9);transform:translateX(-50%);pointer-events:none;border-radius:1px;box-shadow:0 0 4px rgba(255,255,255,0.5);z-index:2;"></div>
          </div>
          <div data-phantom-marker-host="${betKey.replace(/"/g,'&quot;')}">
            <div style="position:relative;height:18px;margin-top:3px;">
              <div style="position:absolute;left:${markerLeft}%;transform:translateX(-50%);font-size:8px;color:#ccc;font-family:\'Chakra Petch\',monospace;white-space:nowrap;text-align:center;">▲ Model ${b.modelProb.toFixed(0)}%</div>
            </div>
          </div>
        </div>
        <div class="bet-stats-row">
          <div class="bet-stat-col">
            <div class="bet-stat-label">Best Over</div>
            <div class="bet-stat-val" style="color:#ccc;">${fmtOdds(b.overBest?.price)} <span class="bet-stat-book">${bookAbbrev(b.overBest?.book||'')}</span></div>
          </div>
          <div class="bet-stat-col">
            <div class="bet-stat-label">Best Under</div>
            <div class="bet-stat-val" style="color:#ccc;">${fmtOdds(b.underBest?.price)} <span class="bet-stat-book">${bookAbbrev(b.underBest?.book||'')}</span></div>
          </div>
          <div class="bet-stat-col">
            <div class="bet-stat-label bet-stat-label-model">Model\'s ${b.direction}</div>
            <div class="bet-stat-val" style="color:#E8DFC8;font-weight:900;">${_modelOdds}</div>
          </div>
          <div class="bet-stat-col">
            <div class="bet-stat-label">Delta</div>
            <div class="bet-stat-val" style="color:${deltaColor};font-weight:700;">${deltaLabel}</div>
          </div>
          <div class="bet-stat-col">
            <div class="bet-stat-label">EV %${_evInfo}</div>
            <div class="bet-stat-val" style="color:${_evColor};font-weight:700;">${_evStr}</div>
          </div>
        </div>
        ${(b.altLines&&b.altLines.length)?`
        <div class="phantom-lines-strip">
          <div class="phantom-lines-label" data-tip="Alternate lines posted by the books for this prop. Check one to overlay the model & market for that teased threshold onto the bar above.">PHANTOM LINES</div>
          ${b.altLines.map(al=>`<label class="phantom-chk"><input type="checkbox" data-action="toggle-phantom" data-bk="${betKey.replace(/"/g,'&quot;')}" data-line="${al.line}"> <span>${al.line}</span></label>`).join('')}
        </div>`:''}
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

// Render a phantom-line overlay on top of the main probability bar.
// Dark-blue translucent overlay = model Over% for the alt line. Light-blue
// label below = market Over% position for the alt line (mirroring the
// existing white "▲ Model X%" marker convention for the main line).
export function togglePhantom(betKey,line,on){
  const b=S.corbetBetsMap?.[betKey];
  if(!b)return;
  const barHost=document.querySelector(`[data-phantom-bar-host="${CSS.escape(betKey)}"]`);
  const markerHost=document.querySelector(`[data-phantom-marker-host="${CSS.escape(betKey)}"]`);
  if(!barHost||!markerHost)return;
  // The global dispatcher listens on click+input+change, so a single checkbox
  // interaction fires this 3x. Remove any prior overlay+model-line+marker for
  // this line first so the handler is idempotent regardless of how many events
  // route through.
  barHost.querySelectorAll(`.phantom-overlay[data-phantom-line="${line}"]`).forEach(el=>el.remove());
  barHost.querySelectorAll(`.phantom-model-marker[data-phantom-line="${line}"]`).forEach(el=>el.remove());
  markerHost.querySelectorAll(`.phantom-marker-slot[data-phantom-line="${line}"]`).forEach(el=>el.remove());
  if(!on)return;
  const al=(b.altLines||[]).find(x=>x.line===line);
  if(!al)return;

  b._phantomCache=b._phantomCache||{};
  let cached=b._phantomCache[line];
  if(!cached){
    // modelProbability reads S.seasonStat / S.splits / S.statcast / S.recentGameLog /
    // S.currentOrder — these were swapped per-player during bet generation but have
    // since been restored. Swap in this player's snapshot for the call, then restore.
    const snap=S.players?.[b._playerId];
    let modelProb=null;
    if(snap){
      const savedCtx={seasonStat:S.seasonStat,splits:S.splits,matchupStats:S.matchupStats,statcast:S.statcast,recentGameLog:S.recentGameLog,currentOrder:S.currentOrder};
      try{
        S.seasonStat=snap.seasonStat;S.splits=snap.splits;S.matchupStats=snap.matchupStats;S.statcast=snap.statcast;S.recentGameLog=snap.recentGameLog;S.currentOrder=snap.order;
        modelProb=modelProbability(b.propKey,line,b._playerScore);
      }finally{
        Object.assign(S,savedCtx);
      }
    }
    if(modelProb==null)return;
    const dv=devig(al.overPrices,al.underPrices);
    if(!dv)return;
    cached=b._phantomCache[line]={modelProb,marketOverProb:dv.overProb,marketUnderProb:dv.underProb,overBest:al.overBest,underBest:al.underBest};
  }

  // Mirror the main bar's convention: the BAR is the market and the ARROW is
  // the model. The overlay is sized to the alt line's market Over%; the model
  // arrow points at the model's Over% position (both referenced to the Over
  // side, like the main bar's green Over segment + white model marker).
  const marketOverW=Math.max(0,Math.min(100,cached.marketOverProb)).toFixed(1);
  const modelLeft=Math.max(1,Math.min(99,cached.modelProb)).toFixed(1);
  const fmtOdds=p=>p!=null?(p>0?'+':'')+p:'—';
  const overBest=cached.overBest;
  const underBest=cached.underBest;
  const tipParts=[
    `Line ${line}`,
    `Model ${cached.modelProb.toFixed(0)}% Over`,
    `Market ${cached.marketOverProb.toFixed(0)}% Over`,
  ];
  if(overBest?.price!=null)tipParts.push(`Best Over: ${fmtOdds(overBest.price)} ${bookAbbrev(overBest.book||'')}`);
  if(underBest?.price!=null)tipParts.push(`Best Under: ${fmtOdds(underBest.price)} ${bookAbbrev(underBest.book||'')}`);
  const tip=tipParts.join(' · ');

  // Dark-blue translucent, dark-blue-bordered overlay on the bar at market
  // Over% width.
  const overlay=document.createElement('div');
  overlay.className='phantom-overlay';
  overlay.dataset.phantomLine=String(line);
  overlay.style.width=marketOverW+'%';
  overlay.title=tip;
  overlay.textContent=`Market ${cached.marketOverProb.toFixed(0)}% (${line})`;
  barHost.appendChild(overlay);

  // Light-blue vertical MODEL marker on the bar at the model Over% position —
  // the phantom counterpart to the main line's white prob-bar-model-marker.
  const modelMarker=document.createElement('div');
  modelMarker.className='phantom-model-marker';
  modelMarker.dataset.phantomLine=String(line);
  modelMarker.style.left=modelLeft+'%';
  modelMarker.title=tip;
  barHost.appendChild(modelMarker);

  // Light-blue MODEL arrow below the bar at the model Over% position. The ▲
  // sits on its own centred line so its tip marks the exact position; the
  // value label sits beneath it (mirrors the main-line "▲ Model X%" marker).
  const slot=document.createElement('div');
  slot.className='phantom-marker-slot';
  slot.dataset.phantomLine=String(line);
  slot.innerHTML=`<div class="phantom-marker-label" style="left:${modelLeft}%;" title="${tip.replace(/"/g,'&quot;')}"><span class="phantom-marker-tip">▲</span><span>Model ${cached.modelProb.toFixed(0)}% (${line})</span></div>`;

  // Insert in ascending line order so the stacked marker rows stay sorted.
  const existing=Array.from(markerHost.querySelectorAll('.phantom-marker-slot'));
  const next=existing.find(el=>parseFloat(el.dataset.phantomLine)>line);
  if(next)markerHost.insertBefore(slot,next);else markerHost.appendChild(slot);
}

// ═══════════ BET RECORD ════════════════════════════════════════════════════════
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
  // Caller passes any order (a sync-pull populates S.betLog from the server,
  // which may not be newest-first). Sort chronologically here so the curve is
  // always left-to-right oldest→newest. YYYY-MM-DD lex-sorts correctly;
  // tiebreak by id so same-day grades stay stable.
  const sorted=[...graded].sort((a,b)=>{
    const ad=a.date||'',bd=b.date||'';
    if(ad<bd)return-1;
    if(ad>bd)return 1;
    return(a.id||0)-(b.id||0);
  });
  let cum=0;const points=[0];
  sorted.forEach(b=>{
    if(b.result==='win'){const o=b.odds||(-110);cum+=o>0?o/100:100/Math.abs(o);}
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

export function setRecordSort(key){
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

export function renderRecord(){
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
      const o=b.odds||(-110);
      const payout=o>0?o/100:100/Math.abs(o);
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

  // Sparkline — helper sorts chronologically internally
  const graded=log.filter(b=>b.result&&b.result!=='push');
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
      <span class="bli-opp">${b.opponent||''}</span>
      <span class="bli-prop">${b.prop}</span>
      <span class="bli-odds">${b.odds>0?'+':''}${b.odds??'—'}</span>
      <span class="bli-rating" style="background:${ratingBg[b.rating]||'#1a1730'};color:${ratingColors[b.rating]||'#777'}">${b.rating||'—'}</span>
      <span class="bli-result">
        <button class="result-btn win ${b.result==='win'?'active':''}" data-action="set-result" data-bet-id="${b.id}" data-value="win">W</button>
        <button class="result-btn loss ${b.result==='loss'?'active':''}" data-action="set-result" data-bet-id="${b.id}" data-value="loss">L</button>
        <button class="result-btn push ${b.result==='push'?'active':''}" data-action="set-result" data-bet-id="${b.id}" data-value="push">P</button>
      </span>
      <button class="del-btn" data-action="delete-bet" data-bet-id="${b.id}" title="Remove">×</button>
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

const _CAL_PROP_LABEL={
  batter_hits:'Hits',batter_total_bases:'Total Bases',batter_home_runs:'Home Runs',
  batter_rbis:'RBI',batter_walks:'Walks',batter_strikeouts:'Strikeouts',
  batter_runs_scored:'Runs',batter_hits_runs_rbis:'H+R+RBI',
};
const _sig=z=>1/(1+Math.exp(-z));
const _logit=p=>Math.log(p/(1-p));

// "Live Model Corrections" table — reflects exactly what calibrate.js applies to
// new predictions. Per prop: settled count, Platt status (+ the shift it puts on
// a representative 60% Over read), and the learned blend weight vs the default.
function renderCalibrationCorrections(settled){
  const el=document.getElementById('cal-corrections');
  if(!el)return;
  const counts={};
  settled.forEach(b=>{if(b.propKey)counts[b.propKey]=(counts[b.propKey]||0)+1;});
  const global=getGlobalCalibration();
  const props=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
  const header=`<div class="cal-row cal-header" style="grid-template-columns:1fr 56px 110px 1fr;"><span>Prop</span><span>Graded</span><span>Calibration</span><span>Blend (score wt)</span></div>`;
  let rows='';
  props.forEach(k=>{
    const n=counts[k];
    const params=getCalibrationParams(k);
    let calCell;
    if(params){
      const shift=_sig(params.a*_logit(0.6)+params.b)*100-60;
      const cls=Math.abs(shift)<=2?'cal-cell-neutral':shift>0?'cal-cell-good':'cal-cell-bad';
      calCell=`<span class="${cls}">Active · ${shift>0?'+':''}${shift.toFixed(1)}% @60</span>`;
    }else if(global){
      calCell=`<span class="cal-cell-muted">Pooled · ${n}/${MIN_CAL_SAMPLE}</span>`;
    }else{
      calCell=`<span class="cal-cell-muted">Building · ${n}/${MIN_CAL_SAMPLE}</span>`;
    }
    const w=getBlendWeight(k);
    const tuned=isBlendTuned(k);
    const wCls=tuned?(Math.abs(w-DEFAULT_BLEND_W)>=0.02?'cal-cell-neutral':'cal-cell-muted'):'cal-cell-muted';
    const wTxt=tuned?`${(w*100).toFixed(0)}% (tuned)`:`${(DEFAULT_BLEND_W*100).toFixed(0)}% (default)`;
    rows+=`<div class="cal-row" style="grid-template-columns:1fr 56px 110px 1fr;"><span class="cal-cell-neutral">${_CAL_PROP_LABEL[k]||k}</span><span class="cal-cell-muted">${n}</span>${calCell}<span class="${wCls}">${wTxt}</span></div>`;
  });
  if(!rows)rows=`<div class="cal-row cal-empty-row">No graded bets yet — corrections stay off until data accumulates.</div>`;
  const globalNote=global?`<div class="cal-section-note" style="margin-top:6px;">Pooled fallback active (${global.n} bets) — used for props below their own ${MIN_CAL_SAMPLE}-bet threshold.</div>`:'';
  el.innerHTML=header+rows+globalNote;
}

export function renderCalibration(){
  // Eligible: graded (W/L/P) AND has modelProb captured at save time.
  // Pushes are excluded from hit-rate math but counted in totals.
  const all=(S.betLog||[]).filter(b=>b.result&&b.modelProb!=null);
  const settled=all.filter(b=>b.result==='win'||b.result==='loss');
  if(!all.length){
    show('cal-empty');hide('cal-content');return;
  }
  hide('cal-empty');show('cal-content');

  const summary=document.getElementById('cal-summary');
  const pendingOld=(S.betLog||[]).filter(b=>b.modelProb==null).length;
  summary.innerHTML=`${all.length} graded bet${all.length===1?'':'s'} with model data` +
    (pendingOld?` · ${pendingOld} older bet${pendingOld===1?'':'s'} excluded (no model data captured)`:'');

  // ─── 0. Live corrections — what calibrate.js is currently applying ────────
  // Shows, per prop, the settled-bet count, whether the Platt correction is
  // live (and how much it shifts a typical 60% read), and the score↔rate blend
  // weight vs the 25% default. Mirrors what modelProbability applies to new bets.
  renderCalibrationCorrections(settled);

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

// ═══════════ GRADE PANEL ══════════════════════════════════════════════════════

export async function renderGradePanel() {
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
          <button class="grade-btn confirm" data-action="auto-grade" data-pred-id="${pred.id}" data-player-id="${pred.playerId}" data-date="${pred.date}">⟳ Fetch & Grade</button>
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
    // Mirror the .outcome-badge colors so the PERF value is tinted to match its
    // badge — makes it obvious the Poor/Average/Great sticker grades PERF (the
    // actual line), not the SCORE (the model's prediction).
    const outcomeColors = { great:'#2ecc71', good:'#a8e063', avg:'#f39c12', poor:'#e74c3c' };
    document.getElementById('grade-log').innerHTML = log.map(g => {
      // Recompute on render so historical entries always reflect the current formula.
      // Stored g.grade.perfScore is frozen at grade time and may be stale after a formula tweak.
      const live = gradePerformance(g.actual, g.score);
      const perfColor = outcomeColors[live.outcome] || '#888';
      const modelLabels = { accurate: 'Accurate', close: 'Close', off: 'Off' };
      const modelLabel = modelLabels[live.accuracy] || 'Off';
      const modelClass = live.accuracy || 'off';
      const residualText = live.residual > 0 ? `+${Math.round(live.residual)}` : `${Math.round(live.residual)}`;
      const playerLast = g.playerName ? g.playerName.split(' ').pop() : '—';
      return `<div class="grade-log-row">
        <span style="color:#888;font-family:\'Chakra Petch\',monospace;font-size:11px;">${g.date}</span>
        <span style="font-family:\'Chakra Petch\',monospace;font-size:13px;font-weight:800;color:#A71930;">${g.score}</span>
        <span style="color:#aaa;font-family:\'Chakra Petch\',monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${playerLast}</span>
        <span style="color:#ccc;font-family:\'Chakra Petch\',monospace;font-size:11px;">${g.actual.summary||`${g.actual.hits}H ${g.actual.totalBases}TB`}</span>
        <span style="color:${perfColor};font-family:\'Chakra Petch\',monospace;font-size:11px;font-weight:700;" title="Performance score (0–150) — grades the actual line. This, not SCORE, drives the outcome badge.">${live.perfScore}</span>
        <span class="outcome-badge ${live.outcome}" title="Performance grade — based on PERF (${live.perfScore}), the actual line. Not the model SCORE (${g.score}).">${outcomeLabels[live.outcome]||live.outcome}</span>
        <span class="model-badge ${modelClass}" title="Actual ${Math.round(live.perfScore)} vs Expected ${Math.round(live.expectedPerf)} (residual ${residualText})">${modelLabel}</span>
        <span class="grade-row-actions">
          <button class="grade-row-edit" data-action="edit-grade" data-grade-id="${g.id}" title="Edit stats (MLB API correction)">✎</button>
          <button class="grade-row-del" data-action="delete-grade" data-grade-id="${g.id}" title="Remove from log">×</button>
        </span>
      </div>`;
    }).join('');
  }
}

export function drawPerfChart(log) {
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

  // Y axis range extended 0-100 → 0-150 to accommodate the raised perfScore cap
  // (monster days that previously saturated at 100 now reach up to 150).
  const Y_MAX = 150;

  // Grid
  ctx.strokeStyle = '#1a1730'; ctx.lineWidth = 1;
  [0, 50, 100, 150].forEach(v => {
    const y = pad.t + chartH - (v / Y_MAX) * chartH;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#777'; ctx.font = "9px 'Chakra Petch', monospace"; ctx.fillText(v, 4, y + 3);
  });

  const xStep = chartW / (recent.length - 1);

  // Recompute perfScore on render so the chart always reflects the current formula
  // (stored values may be frozen from earlier formula versions).
  const points = recent.map(g => ({ ...g, livePerf: gradePerformance(g.actual, g.score).perfScore }));

  // Rescale predScore (0-100 composite) → expected perfScore (0-Y_MAX outcome).
  // Without this the dashed line shared a y-axis with the green outcome line
  // but used different units — a 70 predScore visually appeared to predict a
  // ~70 perfScore, when in reality 70 maps to ~50 perfScore. Linear anchor:
  // predScore 60 (Favorable threshold) ↔ perfScore 40 (actuallyGood threshold).
  const _predToPerf = s => Math.max(0, Math.min(Y_MAX, s - 20));

  // Actual performance line — perfScore is capped 0-150 by gradePerformance
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (g.livePerf / Y_MAX) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Prediction score line (rescaled to expected perfScore so both lines share units)
  ctx.strokeStyle = '#A71930'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath();
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const y = pad.t + chartH - (_predToPerf(g.score) / Y_MAX) * chartH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.setLineDash([]);

  // Dots + dates
  points.forEach((g, i) => {
    const x = pad.l + i * xStep;
    const py = pad.t + chartH - (g.livePerf / Y_MAX) * chartH;
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
  ctx.fillStyle = '#888'; ctx.fillText('Expected', pad.l + 86, 12);
}
