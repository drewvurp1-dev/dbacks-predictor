// Render helpers. Pure DOM/HTML generation — no fetches, no S mutation.
// Reads S where it needs current state. statBox + _renderStatTip form the
// shared building blocks the stat-grid renderers compose on top of.

import { S, activeRoster } from '../state.js';
import { PITCH_NAMES, STAT_INFO } from '../constants.js';
import { loadPitcherForm, loadPitcherSplits } from '../pitcher.js';

// ── Stat tooltip ────────────────────────────────────────────────────────────
// Renders the ⓘ hover tooltip used inside statBox. `info` is either a free-form
// string OR an object { title, body, good, avg, bad, note } — body is for
// stats that don't have clean good/bad thresholds (counting stats, tradeoffs).
export function _renderStatTip(info) {
  if (!info) return '';
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [];
  if (typeof info === 'string') {
    lines.push(`<span class="stat-tip-body">${esc(info)}</span>`);
  } else {
    if (info.title) lines.push(`<span class="stat-tip-title">${esc(info.title)}</span>`);
    if (info.body)  lines.push(`<span class="stat-tip-body">${esc(info.body)}</span>`);
    if (info.good)  lines.push(`<span class="stat-tip-line good">Good: ${esc(info.good)}</span>`);
    if (info.avg)   lines.push(`<span class="stat-tip-line">Avg: ${esc(info.avg)}</span>`);
    if (info.bad)   lines.push(`<span class="stat-tip-line bad">Bad: ${esc(info.bad)}</span>`);
    if (info.note)  lines.push(`<span class="stat-tip-note">${esc(info.note)}</span>`);
  }
  return ` <span class="stat-info">ⓘ<span class="stat-tip">${lines.join('')}</span></span>`;
}

// ── Stat box ────────────────────────────────────────────────────────────────
// Single grid cell with a label, value, context subtitle, color class, and an
// optional info tooltip. Used 30+ times across the stat grids.
//
//   l    — label (e.g. 'xwOBA')
//   v    — formatted value string ('.345', '92.4 mph', '—')
//   ctx  — small context line under the value
//   c    — color class ('good' | 'bad' | '')
//   info — tooltip object/string passed to _renderStatTip
export function statBox(l, v, ctx, c, info) {
  return `<div class="stat-box"><div class="stat-label">${l}${_renderStatTip(info)}</div><div class="stat-val${c ? ' ' + c : ''}">${v ?? '—'}</div>${ctx ? `<div class="stat-context">${ctx}</div>` : ''}</div>`;
}

// ── Statcast grid ───────────────────────────────────────────────────────────
// Renders the Statcast/Advanced grid from a raw-value statcast object
// (S.statcast shape). Shared by loadStatcast (Setup panel) and
// openPlayerStats (dashboard "More Stats" button) so the grid always
// reflects the player being viewed.
export function _renderStatcastGrid(sc) {
  const el = document.getElementById('stat-statcast');
  if (!el) return;
  if (!sc) { el.innerHTML = ''; return; }
  const fmt = (v, d, suffix = '') => v != null ? v.toFixed(d) + suffix : '—';
  const fmtPct = (v, d = 1) => fmt(v, d, '%');
  const c = (v, good, bad, invert = false) => {
    if (v == null) return '';
    return (invert ? (v <= bad ? 'good' : v >= good ? 'bad' : '') : (v >= good ? 'good' : v <= bad ? 'bad' : ''));
  };
  el.innerHTML = [
    statBox('xwOBA',   fmt(sc.xwoba, 3),  'Expected weighted OBA',        c(sc.xwoba,    0.360, 0.300),       STAT_INFO.XWOBA),
    statBox('xBA',     fmt(sc.xba, 3),    'Expected batting average',     c(sc.xba,      0.280, 0.220),       STAT_INFO.XBA),
    statBox('xSLG',    fmt(sc.xslg, 3),   'Expected slugging %',          c(sc.xslg,     0.480, 0.360),       STAT_INFO.XSLG),
    statBox('Barrel%', fmtPct(sc.brl),    'Barrel rate',                  c(sc.brl,      10,    4),           STAT_INFO.BARREL_B),
    statBox('HH Rate', fmtPct(sc.hhRate), 'Hard-hit rate (95+ mph EV)',   c(sc.hhRate,   45,    35),          STAT_INFO.HH_B),
    statBox('Avg EV',  sc.avgEV != null ? sc.avgEV.toFixed(1) + ' mph' : '—', 'Avg exit velocity', c(sc.avgEV, 92, 86), STAT_INFO.EV_B),
    statBox('Sweet Sp%', fmtPct(sc.sweetSpot), 'Sweet spot contact %',    c(sc.sweetSpot, 40,   28),          STAT_INFO.SWEET),
    statBox('Whiff%',  fmtPct(sc.whiff),  'Whiff rate per swing',         c(sc.whiff,    30,    20, true),    STAT_INFO.WHIFF_B),
    statBox('GB%',     fmtPct(sc.gb),     'Ground ball rate',             '',                                 STAT_INFO.GB_B),
    statBox('FB%',     fmtPct(sc.fb),     'Fly ball rate',                '',                                 STAT_INFO.FB_B),
    statBox('Bat Spd', sc.batSpeed != null ? sc.batSpeed.toFixed(1) + ' mph' : '—', 'Avg bat speed', c(sc.batSpeed, 75, 68), STAT_INFO.BATSPD),
    statBox('Sw Len',  sc.swingLength != null ? sc.swingLength.toFixed(1) + ' ft' : '—', '', '', { title: 'Swing Length (feet)', body: 'Tradeoff stat — not categorically good or bad. <6.8: pure contact (Arraez). 6.8 – 7.5: balanced / league avg. 7.5 – 8.0: power-leaning. >8.0: elite power, high K (Judge).' }),
    statBox('Sqd Up%', fmtPct(sc.squaredUp), 'Squared-up per contact',    c(sc.squaredUp, 22,   12),          STAT_INFO.SQDUP),
    statBox('Blast%',  fmtPct(sc.blast),  'Blast per contact',            c(sc.blast,    8,     3),           STAT_INFO.BLAST),
  ].join('');
}

// ── Pitch Mix matchup ───────────────────────────────────────────────────────
// Renders the Pitch Mix card on the Prediction Score panel as a per-pitch
// matchup table. For each pitch the pitcher throws (sorted by usage), show:
//   - pitcher's usage % (bar)
//   - batter's BA / SLG / K% / wOBA on that pitch
// Stats are colored vs the batter's overall baseline across all pitches:
//   green = batter performs better than baseline on this pitch (or whiffs less)
//   red   = batter performs worse (or whiffs more)
// Falls back to a simple pitcher-only bar view when arsenal data isn't available.
export function _renderPitchMatchup() {
  const arsenal = S.pitchArsenal;
  const pid = S.pitcher?.id;
  const bid = S.playerId;
  const pit = arsenal && pid ? arsenal.pitchers?.[String(pid)] : null;
  const bat = arsenal && bid ? arsenal.batters?.[String(bid)] : null;

  // Fallback: no arsenal pitcher data → original bar-only display
  if (!pit) {
    return Object.entries(S.pitcherPitches || {}).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a)
      .map(([type, pct]) => `<div class="pitch-row"><span class="pitch-label">${type}</span><div class="pitch-bar-wrap"><div class="pitch-bar" style="width:${pct}%;background:${pct > 35 ? '#A71930' : '#3a3560'}"></div></div><span class="pitch-pct">${pct}%</span></div>`).join('')
      || '<div style="color:#777;font-family:\'Chakra Petch\',monospace;font-size:11px;">No pitch mix data available.</div>';
  }

  // Compute the batter's baseline. Use MLB API season stats for BA/SLG/K% — they're
  // accurate full-season numbers. The Statcast pitch-arsenal data only covers pitch types
  // with ≥25 PA, which skews the weighted average high (harder pitches get excluded).
  // wOBA isn't in the MLB API so we still derive it from the Statcast-weighted average.
  let bWoba = 0, bWhiff = 0, bPA = 0;
  if (bat) {
    for (const pt in bat.pitches) {
      const r = bat.pitches[pt];
      const w = r.pa || 0;
      if (!w) continue;
      if (r.woba != null)  bWoba  += r.woba  * w;
      if (r.whiff != null) bWhiff += r.whiff * w;
      bPA += w;
    }
  }
  const ss = S.seasonStat;
  const ssPA = ss?.plateAppearances || 0;
  const base = bPA > 0 ? {
    ba:    ss?.avg ? parseFloat(ss.avg) : bPA > 0 ? null : null,
    slg:   ss?.slg ? parseFloat(ss.slg) : null,
    k:     ssPA > 0 ? (ss.strikeOuts / ssPA) * 100 : null,
    woba:  bWoba / bPA,
    whiff: bWhiff / bPA,
  } : null;

  // Color helpers — "good" means good for the batter.
  //   higherBetter=true:  green if val > base by ≥thresh, red if val < base - thresh
  //   higherBetter=false: inverted (used for K% and whiff%)
  const colorFor = (val, baseline, thresh, higherBetter) => {
    if (val == null || baseline == null) return '#aaa';
    const d = val - baseline;
    const good = higherBetter ? d >= thresh : d <= -thresh;
    const bad  = higherBetter ? d <= -thresh : d >= thresh;
    if (good) return '#2ecc71';
    if (bad)  return '#e74c3c';
    return '#aaa';
  };
  const fmt3 = v => v == null ? '—' : v.toFixed(3).replace(/^0/, '');
  const fmtPct = v => v == null ? '—' : v.toFixed(0) + '%';

  // Sort pitches by usage descending. Only show pitches the pitcher actually throws.
  const pitches = Object.entries(pit.pitches)
    .filter(([, d]) => (d.usage || 0) >= 2) // hide pitch types thrown <2% of the time
    .sort(([, a], [, b]) => (b.usage || 0) - (a.usage || 0));

  if (!pitches.length) {
    return '<div style="color:#777;font-family:\'Chakra Petch\',monospace;font-size:11px;">No arsenal data for this pitcher.</div>';
  }

  const header = base
    ? `<div class="matchup-baseline">Batter baseline: <strong>${fmt3(base.ba)}</strong> BA · <strong>${fmt3(base.slg)}</strong> SLG · <strong>${fmtPct(base.k)}</strong> K · <strong>${fmt3(base.woba)}</strong> wOBA</div>`
    : `<div class="matchup-baseline" style="color:#888;">No per-pitch batter data — showing pitcher arsenal only.</div>`;

  const rows = pitches.map(([code, p]) => {
    const name = PITCH_NAMES[code] || code;
    const usage = p.usage || 0;
    const br = bat?.pitches?.[code];
    const usageBarColor = usage >= 30 ? '#A71930' : usage >= 15 ? '#7a3560' : '#3a3560';
    const usageBar = `<div class="matchup-bar-wrap"><div class="matchup-bar" style="width:${Math.min(100, usage * 1.8)}%;background:${usageBarColor};"></div></div>`;

    if (!br || (br.pa || 0) < 15) {
      return `<div class="matchup-row">
        <div class="matchup-pitch">${name}</div>
        <div class="matchup-usage">${usageBar}<span class="matchup-usage-pct">${usage.toFixed(0)}%</span></div>
        <div class="matchup-stats" style="color:#666;">— insufficient batter sample —</div>
      </div>`;
    }

    const baCol  = colorFor(br.ba,    base?.ba,   0.025, true);
    const slgCol = colorFor(br.slg,   base?.slg,  0.05,  true);
    const kCol   = colorFor(br.k_pct, base?.k,    3,     false);
    const wCol   = colorFor(br.woba,  base?.woba, 0.020, true);

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

// ── Prediction narrative summary ────────────────────────────────────────────
// Builds the multi-section narrative shown on the Prediction Score panel:
//   1. Verdict (1 sentence, tone driven by score band)
//   2. Key Drivers (top 4 positive factors)
//   3. Key Headwinds (top 4 negative factors)
//   4. Pitcher Read (ERA vs xERA, whiff/K profile, GB tendency, rest/PC)
//   5. Career vs Pitcher (matchup line + narrative when sample ≥ 3 AB)
//   6. Last 10 Games (sparkline + form narrative)
export function buildPredictionSummary(factors) {
  const el = document.getElementById('prediction-summary');
  if (!el) return;

  const lastName = S.playerName.split(' ').pop();
  const score = S.lastScore || 50;
  const pn = S.pitcher?.name || document.getElementById('m-pitcher-name')?.value || 'Unknown Pitcher';
  const pitcherLast = pn.split(' ').pop();
  const hand = S.pitcher?.hand || S.pitcherThrows;
  const era = S.pitcher?.st?.era ? parseFloat(S.pitcher.st.era).toFixed(2) : null;
  const xera = S.pitcherStatcast?.xera;
  const daysRest = S.pitcher?.daysRest;
  const lastPC = S.pitcher?.lastOuting?.numberOfPitches;

  const sorted = [...factors].sort((a, b) => Math.abs(b.adj || 0) - Math.abs(a.adj || 0));
  const drivers = sorted.filter(f => f.impact === 'positive').slice(0, 4);
  const headwinds = sorted.filter(f => f.impact === 'negative').slice(0, 4);

  // ── VERDICT ────────────────────────────────────────────────────────────
  let verdict = '';
  if (score >= 75) verdict = `The model sees a strong setup for ${lastName} today — multiple high-confidence signals are stacking up against ${pitcherLast}.`;
  else if (score >= 62) verdict = `More factors lean in ${lastName}'s favor than against him today, with ${pitcherLast} presenting a realistic opportunity for production.`;
  else if (score >= 50) verdict = `This is a coin-flip setup for ${lastName}. The model finds modest positives but meaningful resistance from ${pitcherLast}.`;
  else if (score >= 38) verdict = `${lastName} is facing a tough setup — the factors lean toward a below-average day against ${pitcherLast}.`;
  else verdict = `Difficult day projected for ${lastName}. Multiple headwinds — including the pitcher profile and conditions — significantly suppress the model's outlook.`;

  // ── DRIVERS ─────────────────────────────────────────────────────────────
  const driversHTML = drivers.length ? `
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#2ecc71;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Key Drivers</div>
      ${drivers.map(f => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#2ecc71;font-weight:700;font-size:12px;font-family:'Chakra Petch',monospace;">${f.label}</span>
            <span style="color:#888;font-size:11px;margin-left:5px;">${f.value}</span>
          </div>
          <div style="color:#aaa;font-size:11px;text-align:right;">${f.note}</div>
        </div>`).join('')}
    </div>` : '';

  // ── HEADWINDS ────────────────────────────────────────────────────────────
  const headwindsHTML = headwinds.length ? `
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#e74c3c;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Key Headwinds</div>
      ${headwinds.map(f => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:7px 0;border-bottom:1px solid #0e0c22;">
          <div style="flex-shrink:0;margin-right:8px;">
            <span style="color:#e74c3c;font-weight:700;font-size:12px;font-family:'Chakra Petch',monospace;">${f.label}</span>
            <span style="color:#888;font-size:11px;margin-left:5px;">${f.value}</span>
          </div>
          <div style="color:#aaa;font-size:11px;text-align:right;">${f.note}</div>
        </div>`).join('')}
    </div>` : '';

  // ── PITCHER READ ─────────────────────────────────────────────────────────
  const pitcherLines = [];
  if (era) {
    if (xera) {
      const diff = parseFloat(era) - xera;
      if (diff > 0.75) pitcherLines.push(`${pitcherLast}'s ERA (${era}) is inflated vs. xERA (${xera.toFixed(2)}) — likely pitching better than results show. Expect strong performance.`);
      else if (diff < -0.75) pitcherLines.push(`${pitcherLast}'s ERA (${era}) sits well below xERA (${xera.toFixed(2)}) — regression risk, has outperformed underlying metrics.`);
      else pitcherLines.push(`${pitcherLast}'s ERA (${era}) aligns with xERA (${xera.toFixed(2)}) — results match underlying performance.`);
    } else {
      pitcherLines.push(`${pitcherLast} carries a ${era} ERA on the season.`);
    }
  }
  const pWhiff = S.pitcherStatcast?.whiff;
  const pKPct = S.pitcherStatcast?.kPct;
  const pPutAway = S.pitcherStatcast?.putAway;
  const pGB = S.pitcherStatcast?.gbPct;
  if (pWhiff != null && pKPct != null) {
    if (pWhiff >= 28 && pKPct >= 26) pitcherLines.push(`Dominant swing-and-miss arsenal — ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K rate. Premium strikeout threat.`);
    else if (pWhiff >= 24) pitcherLines.push(`Above-average movement: ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K%. Will generate weak contact.`);
    else if (pWhiff <= 18) pitcherLines.push(`Below-average swing-and-miss (${pWhiff.toFixed(1)}% Whiff) — ${lastName} can expect to put the ball in play regularly.`);
    else pitcherLines.push(`Moderate arsenal: ${pWhiff.toFixed(1)}% Whiff, ${pKPct.toFixed(1)}% K%.`);
  }
  if (pPutAway != null && pPutAway >= 32) pitcherLines.push(`Elite 2-strike put-away rate (${pPutAway.toFixed(1)}%) — difficult to battle back once behind in the count.`);
  if (pGB != null && pGB >= 50) pitcherLines.push(`Pronounced ground ball tendency (${pGB.toFixed(1)}% GB) — power is suppressed, extra-base opportunities limited.`);
  if (daysRest !== '—' && daysRest != null) {
    if (daysRest < 4) pitcherLines.push(`⚠ On short rest (${daysRest} days) — command may waver, pitch count could be managed early.`);
    else if (daysRest >= 6) pitcherLines.push(`Well-rested on ${daysRest} days — expect sharp command and a full arsenal.`);
  }
  if (lastPC && lastPC >= 100) pitcherLines.push(`Threw ${lastPC} pitches last outing — possible accumulated fatigue this start.`);

  const pitcherHTML = pitcherLines.length ? `
    <div style="margin-bottom:16px;">
      <div style="font-size:10px;color:#a855f7;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Pitcher Read — ${pn} (${hand}HP)</div>
      ${pitcherLines.map(l => `<div style="font-size:12px;color:#bbb;padding:5px 0;border-bottom:1px solid #0e0c22;line-height:1.5;">${l}</div>`).join('')}
    </div>` : '';

  // ── CAREER MATCHUP ───────────────────────────────────────────────────────
  let matchupHTML = '';
  const mu = S.matchupStats;
  if (!mu || mu.ab === 0) {
    matchupHTML = `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Career vs. ${pitcherLast}</div>
        <div style="font-size:12px;color:#777;font-family:'Chakra Petch',monospace;">${lastName} has no recorded plate appearances vs. ${pitcherLast} — first-time matchup. Prediction relies on season-level and Statcast metrics.</div>
      </div>`;
  } else if (mu && mu.ab >= 3) {
    const opsColor = mu.ops >= 0.850 ? '#2ecc71' : mu.ops <= 0.620 ? '#e74c3c' : '#f39c12';
    let muNarr = '';
    if (mu.ab >= 20) {
      if (mu.ops >= 0.950) muNarr = `${lastName} owns this matchup historically — consistently damages ${pitcherLast} in a substantial sample.`;
      else if (mu.ops >= 0.800) muNarr = `Solid career track record vs. ${pitcherLast} — ${lastName} has handled this arm well over time.`;
      else if (mu.ops <= 0.600) muNarr = `${pitcherLast} has historically dominated ${lastName} — clear historical edge for the pitcher.`;
      else if (mu.ops <= 0.700) muNarr = `${lastName} has below-average career numbers vs. ${pitcherLast} — the pitcher holds a mild edge.`;
      else muNarr = `Career matchup is relatively neutral — neither player holds a clear historical edge.`;
    } else if (mu.ab >= 10) {
      muNarr = `Moderate sample (${mu.ab} AB): ${lastName} is batting ${mu.avg} with a ${mu.ops.toFixed(3)} OPS vs. ${pitcherLast}.`;
    } else {
      muNarr = `Small sample (${mu.ab} AB) — directional signal only. ${lastName} is ${mu.ops.toFixed(3)} OPS in limited career matchups.`;
    }
    if (mu.hr >= 2) muNarr += ` Has gone deep ${mu.hr}× against ${pitcherLast}.`;
    if (mu.k && mu.ab >= 8) { const kr = ((mu.k / mu.ab) * 100).toFixed(0); if (parseInt(kr) >= 30) muNarr += ` High K rate (${kr}%) — ${pitcherLast} generates swing-and-miss from ${lastName} career-wide.`; }
    if (mu.bb && mu.ab >= 8) { const bbr = ((mu.bb / mu.ab) * 100).toFixed(0); if (parseInt(bbr) >= 15) muNarr += ` ${lastName} draws walks at a high rate vs. ${pitcherLast} (${bbr}% BB).`; }
    matchupHTML = `
      <div style="margin-bottom:16px;">
        <div style="font-size:10px;color:#f39c12;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Career vs. ${pitcherLast} · ${mu.ab} AB</div>
        <div style="display:flex;gap:14px;margin-bottom:8px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:'Chakra Petch',monospace;color:${opsColor};">${mu.ops.toFixed(3)}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">OPS</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${mu.avg}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:'Chakra Petch',monospace;color:${(mu.hr || 0) > 0 ? '#A71930' : '#ccc'};">${mu.hr || 0}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${mu.k || 0}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:20px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${mu.bb || 0}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">BB</div></div>
        </div>
        <div style="font-size:12px;color:#bbb;line-height:1.5;">${muNarr}</div>
      </div>`;
  }

  // ── LAST 10 GAMES ────────────────────────────────────────────────────────
  let recentHTML = '';
  if (S.recentGameLog?.length > 0) {
    const recent = S.recentGameLog.slice(0, 10);
    const n = recent.length;
    const totalH = recent.reduce((s, g) => s + (parseInt(g.stat.hits) || 0), 0);
    const totalAB = recent.reduce((s, g) => s + (parseInt(g.stat.atBats) || 0), 0);
    const totalHR = recent.reduce((s, g) => s + (parseInt(g.stat.homeRuns) || 0), 0);
    const totalRBI = recent.reduce((s, g) => s + (parseInt(g.stat.rbi) || 0), 0);
    const totalBB = recent.reduce((s, g) => s + (parseInt(g.stat.baseOnBalls) || 0), 0);
    const totalK = recent.reduce((s, g) => s + (parseInt(g.stat.strikeOuts) || 0), 0);
    const multiHit = recent.filter(g => (parseInt(g.stat.hits) || 0) >= 2).length;
    const hitless = recent.filter(g => (parseInt(g.stat.hits) || 0) === 0).length;
    const avg10 = totalAB > 0 ? (totalH / totalAB).toFixed(3) : '—';
    const last3H = recent.slice(0, 3).reduce((s, g) => s + (parseInt(g.stat.hits) || 0), 0);
    const last3AB = recent.slice(0, 3).reduce((s, g) => s + (parseInt(g.stat.atBats) || 0), 0);
    const last5H = recent.slice(0, 5).reduce((s, g) => s + (parseInt(g.stat.hits) || 0), 0);
    const last5AB = recent.slice(0, 5).reduce((s, g) => s + (parseInt(g.stat.atBats) || 0), 0);
    const avg3 = last3AB > 0 ? last3H / last3AB : 0;
    const avg5 = last5AB > 0 ? last5H / last5AB : 0;
    const avg10N = totalAB > 0 ? totalH / totalAB : 0;

    let formNarr = '';
    if (avg3 >= 0.450) formNarr = `🔥 ${lastName} is scorching — batting ${avg3.toFixed(3)} over his last 3 games.`;
    else if (avg3 >= 0.350 && multiHit >= 3) formNarr = `${lastName} is on a tear with ${multiHit} multi-hit games in his last ${n}.`;
    else if (avg3 === 0 && hitless >= 3) formNarr = `❄️ ${lastName} is in a cold stretch — hitless in ${hitless} of his last ${n} games.`;
    else if (avg5 >= 0.360) formNarr = `${lastName} is trending up, batting ${avg5.toFixed(3)} over his last 5 games.`;
    else if (avg10N >= 0.300) formNarr = `${lastName} has been productive over his last ${n}, batting ${avg10} with ${multiHit} multi-hit outings.`;
    else if (avg10N <= 0.185) formNarr = `${lastName} has been in a slump over his last ${n} games, batting ${avg10} with ${hitless} hitless outings.`;
    else formNarr = `${lastName} has been average over his last ${n} — batting ${avg10} with ${multiHit} multi-hit games.`;
    if (totalHR > 0) formNarr += ` ${totalHR} HR over this stretch.`;
    if (totalBB >= Math.ceil(n * 0.5)) formNarr += ` Drawing walks at a high clip (${totalBB} BB in ${n} G).`;
    if (totalK >= Math.ceil(n * 1.3)) formNarr += ` Elevated K rate this stretch (${totalK} K in ${n} G).`;

    const spark = recent.map(g => {
      const h = parseInt(g.stat.hits) || 0;
      const hr = parseInt(g.stat.homeRuns) || 0;
      const rbi = parseInt(g.stat.rbi) || 0;
      const bg = hr > 0 ? '#1e3a5f' : h >= 3 ? '#14532d' : h >= 2 ? '#1a3a1a' : h === 1 ? '#3a2800' : '#18171f';
      const fg = hr > 0 ? '#60a5fa' : h >= 3 ? '#4ade80' : h >= 2 ? '#86efac' : h === 1 ? '#fbbf24' : '#555';
      const lbl = hr > 0 ? `${h}/${hr}HR` : h > 0 ? `${h}H` : '0';
      const dateShort = g.date ? g.date.slice(5) : '';
      return `<div title="${g.date || ''}: ${h}H ${hr}HR ${rbi}RBI" style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:2px;background:${bg};border-radius:4px;padding:4px 2px;">
        <div style="font-size:10px;font-weight:700;font-family:'Chakra Petch',monospace;color:${fg};white-space:nowrap;">${lbl}</div>
        <div style="font-size:8px;color:#555;font-family:'Chakra Petch',monospace;white-space:nowrap;">${dateShort}</div>
      </div>`;
    }).join('');

    recentHTML = `
      <div style="margin-bottom:4px;">
        <div style="font-size:10px;color:#38bdf8;letter-spacing:1.5px;text-transform:uppercase;font-family:'Chakra Petch',monospace;margin-bottom:8px;">Last ${n} Games</div>
        <div style="display:flex;gap:12px;margin-bottom:10px;flex-wrap:wrap;">
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${avg10}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">AVG</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${totalH}/${totalAB}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">H/AB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:${totalHR > 0 ? '#60a5fa' : '#ccc'};">${totalHR}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">HR</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${totalRBI}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">RBI</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${totalBB}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">BB</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${totalK}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">K</div></div>
          <div style="text-align:center;"><div style="font-size:18px;font-weight:900;font-family:'Chakra Petch',monospace;color:#ccc;">${multiHit}</div><div style="font-size:9px;color:#666;font-family:'Chakra Petch',monospace;margin-top:2px;">2H+</div></div>
        </div>
        <div style="display:flex;gap:3px;margin-bottom:10px;">${spark}</div>
        <div style="font-size:12px;color:#bbb;line-height:1.5;">${formNarr}</div>
      </div>`;
  }

  el.innerHTML = `
    <div>
      <div style="font-size:13px;color:#ddd;line-height:1.7;font-family:Georgia,serif;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #1a1730;">${verdict}</div>
      ${driversHTML}
      ${headwindsHTML}
      ${pitcherHTML}
      ${matchupHTML}
      ${recentHTML}
    </div>`;
}

// ── Factor cards (Batter / Pitcher / Conditions) ────────────────────────────
// Renders the three category panels on the Prediction Score view + the two
// mini summary bars at the top of the page. Pure DOM — `factors` and
// `catTotals` are produced by calcPrediction in app.js.
export function renderFactorCards(factors, catTotals) {
  const colors = { positive: '#2ecc71', negative: '#e74c3c', neutral: '#f39c12' };
  const icons = { positive: '▲', negative: '▼', neutral: '●' };
  const fmtRows = fs => fs.length
    ? fs.map(f => `<div class="factor-row"><span class="factor-icon" style="color:${colors[f.impact]}">${icons[f.impact]}</span><span class="factor-label">${f.label}</span><span class="factor-value">${f.value}</span><span class="factor-note">${f.note}</span></div>`).join('')
    : '<div style="font-size:11px;color:#555;font-family:\'Chakra Petch\',monospace;padding:4px 0;">No significant factors.</div>';
  const fmtNet = n => {
    const s = n > 0 ? '+' : '';
    const c = n > 0 ? '#2ecc71' : n < 0 ? '#e74c3c' : '#888';
    return `<span style="color:${c};font-weight:900;font-family:'Chakra Petch',monospace;font-size:12px;letter-spacing:0;text-transform:none;">${s}${n}</span>`;
  };
  ['batter', 'pitcher', 'conditions'].forEach(cat => {
    const fs = factors.filter(f => f.cat === cat);
    const net = catTotals?.[cat] || 0;
    const bodyEl = document.getElementById(`factors-${cat}-body`);
    const netEl = document.getElementById(`factors-${cat}-net`);
    if (bodyEl) bodyEl.innerHTML = fmtRows(fs);
    if (netEl) netEl.innerHTML = fmtNet(net);
  });
  const setMini = (id, net) => {
    const c = net > 0 ? '#2ecc71' : net < 0 ? '#e74c3c' : '#888';
    const w = Math.min(100, Math.abs(net) / 20 * 100);
    const valEl = document.getElementById(`mini-${id}-val`);
    const barEl = document.getElementById(`mini-${id}-bar`);
    if (valEl) { valEl.textContent = (net > 0 ? '+' : '') + net; valEl.style.color = c; }
    if (barEl) { barEl.style.width = w + '%'; barEl.style.background = c; }
  };
  setMini('batter', catTotals?.batter || 0);
  setMini('pitcher', catTotals?.pitcher || 0);
}

// ── Pitcher form (last 3 starts) ────────────────────────────────────────────
// Renders the colored quality rows produced by pitcher.js:loadPitcherForm.
export function _renderPitcherForm(starts) {
  if (!starts || !starts.length) return '';
  return `<div class="dash-pitcher-form">${starts.map(s =>
    `<div class="pf-row ${s.cls}">
      <span class="pf-row-date">${s.date}</span>
      <span class="pf-row-opp">${s.opp}</span>
      <span class="pf-row-stats">${s.ip} IP &middot; ${s.er} ER &middot; ${s.k} K &middot; ${s.bb} BB</span>
    </div>`
  ).join('')}</div>`;
}

// ── Pitcher splits row (Home/Away · vs L/R · SIERA/xFIP chip) ───────────────
// Reads S.pitcher.advanced for the SIERA/xFIP chip. `isHomeGame` highlights
// the active side. Data shape: { h, a, vl, vr } from pitcher.js:loadPitcherSplits.
export function _renderPitcherSplits(splits, isHomeGame) {
  if (!splits) return '';
  const sieraVal = S.pitcher?.advanced?.siera;
  const xfipVal = S.pitcher?.advanced?.xfip;
  const advChip = sieraVal != null
    ? `<span class="ps-adv">SIERA <b>${sieraVal.toFixed(2)}</b></span>`
    : (xfipVal != null ? `<span class="ps-adv">xFIP <b>${xfipVal.toFixed(2)}</b></span>` : '');
  const homeEra = splits.h?.era;
  const awayEra = splits.a?.era;
  const homeCls = isHomeGame ? 'ps-active' : '';
  const awayCls = !isHomeGame ? 'ps-active' : '';
  const homeStr = homeEra != null ? `Home <b>${homeEra.toFixed(2)}</b>` : 'Home <b>—</b>';
  const awayStr = awayEra != null ? `Away <b>${awayEra.toFixed(2)}</b>` : 'Away <b>—</b>';
  const vL = splits.vl;
  const vR = splits.vr;
  const vLStr = vL ? `vs L <b>${vL.avg || '—'}</b>/${vL.obp || '—'}/${vL.slg || '—'}` : 'vs L <b>—</b>';
  const vRStr = vR ? `vs R <b>${vR.avg || '—'}</b>/${vR.obp || '—'}/${vR.slg || '—'}` : 'vs R <b>—</b>';
  return `<div class="dash-pitcher-splits">
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

// ── Best Matchup card ───────────────────────────────────────────────────────
// Picks the D-backs hitter with the strongest combined edge against tonight's
// pitcher: 70% vs-handedness OPS this season + 30% career line vs this exact
// pitcher (when sample ≥ 5 AB, otherwise hand-split fully). Renders inside the
// pitcher card's matchup slot.
export function _renderBestMatchup() {
  const el = document.getElementById('dash-best-matchup-slot');
  if (!el) return;
  if (!S.pitcher || !S.players) { el.innerHTML = ''; return; }
  const hand = S.pitcher.hand || 'R';
  const candidates = activeRoster()
    .map(p => {
      const snap = S.players?.[p.id];
      if (!snap || snap.lowData) return null;
      const handSplit = hand === 'L' ? snap.splits?.vl : snap.splits?.vr;
      const handOps = handSplit?.ops ? (typeof handSplit.ops === 'number' ? handSplit.ops : parseFloat(handSplit.ops)) : null;
      const mu = snap.matchupStats;
      const muOps = mu?.ops || null;
      const muAb = mu?.ab || 0;
      let mScore = null;
      if (handOps != null) {
        if (muOps != null && muAb >= 5) {
          mScore = handOps * 0.7 + muOps * 0.3;
        } else {
          mScore = handOps;
        }
      }
      return { player: p, snap, handSplit, handOps, mu, muAb, mScore };
    })
    .filter(c => c && c.mScore != null)
    .sort((a, b) => b.mScore - a.mScore);

  if (!candidates.length) {
    el.innerHTML = `<div class="bm-empty">Loading matchup…</div>`;
    return;
  }
  const top = candidates[0];
  const score = top.snap?.score != null ? Math.round(top.snap.score) : null;
  const scoreColor = top.snap?.tier?.color || '#aaa';
  const oppHand = hand;
  const handLine = top.handSplit
    ? `<span class="bm-stat-lbl">vs ${oppHand}HP</span> <b>${top.handSplit.avg || '—'}</b>/${top.handSplit.obp || '—'}/${top.handSplit.slg || '—'}`
    : `<span class="bm-stat-lbl">vs ${oppHand}HP</span> <b>—</b>`;
  let careerLine = '';
  if (top.mu && top.muAb >= 3) {
    const sample = `${top.mu.h}-for-${top.muAb}`;
    const extras = [];
    if (top.mu.hr) extras.push(`${top.mu.hr} HR`);
    if (top.mu.bb) extras.push(`${top.mu.bb} BB`);
    if (top.mu.k) extras.push(`${top.mu.k} K`);
    careerLine = `<div class="bm-line bm-career"><span class="bm-stat-lbl">Career vs ${S.pitcher.name.split(' ').pop()}</span> <b>${sample}</b>${extras.length ? ' · ' + extras.join(', ') : ''}</div>`;
  }
  let recentLine = '';
  const log = top.snap?.recentGameLog || [];
  if (log.length) {
    const last7 = log.slice(0, 7);
    let h = 0, ab = 0, hr = 0, bb = 0, k = 0;
    last7.forEach(g => {
      h  += parseInt(g.stat?.hits || 0);
      ab += parseInt(g.stat?.atBats || 0);
      hr += parseInt(g.stat?.homeRuns || 0);
      bb += parseInt(g.stat?.baseOnBalls || 0);
      k  += parseInt(g.stat?.strikeOuts || 0);
    });
    if (ab > 0) {
      const avg = (h / ab).toFixed(3).replace(/^0\./, '.');
      const extras = [];
      if (hr) extras.push(`${hr} HR`);
      if (bb) extras.push(`${bb} BB`);
      if (k)  extras.push(`${k} K`);
      recentLine = `<div class="bm-line"><span class="bm-stat-lbl">Last ${last7.length}G</span> <b>${h}-for-${ab}</b> (${avg})${extras.length ? ' · ' + extras.join(', ') : ''}</div>`;
    }
  }
  let betLine = '';
  const pgBets = (S.allPlayerBets || []).find(pg => pg.playerName === top.player.name);
  const bestBet = pgBets?.bets
    ?.filter(b => !b.insufficient && b.edgeStrength !== 'none')
    ?.sort((a, b) => (b.ev ?? b.absDelta / 100) - (a.ev ?? a.absDelta / 100))?.[0];
  if (bestBet) {
    const evStr = bestBet.ev != null ? `${bestBet.ev >= 0 ? '+' : ''}${(bestBet.ev * 100).toFixed(1)}%` : '—';
    const evCls = bestBet.ev != null ? (bestBet.ev >= 0 ? 'pos' : 'neg') : 'pos';
    betLine = `<div class="bm-bet">
      <div class="bm-bet-prop">${bestBet.direction.toUpperCase()} ${bestBet.line} ${bestBet.prop}</div>
      <div class="bm-bet-stat ${evCls}">EV ${evStr}</div>
    </div>`;
  }

  const summary = _buildMatchupSummary(top, oppHand);

  el.innerHTML = `<div class="bm-card">
    <div class="bm-header">
      <span class="bm-tag">★ Best Matchup</span>
    </div>
    <div class="bm-name-row">
      <div class="bm-name">${top.player.name}</div>
      ${score != null ? `<div class="bm-score-circle" style="border-color:${scoreColor}"><span class="bm-score-num" style="color:${scoreColor}">${score}</span></div>` : ''}
    </div>
    <div class="bm-line">${handLine}</div>
    ${recentLine}
    ${careerLine}
    ${betLine}
    ${summary ? `<div class="bm-summary">${summary}</div>` : ''}
  </div>`;
}

// One-line italic reason explaining why this player is the best matchup pick.
function _buildMatchupSummary(top, oppHand) {
  const reasons = [];
  const handOps = top.handOps;
  if (handOps != null) {
    if (handOps >= 0.900) reasons.push(`elite vs ${oppHand}HP`);
    else if (handOps >= 0.800) reasons.push(`strong vs ${oppHand}HP`);
    else if (handOps >= 0.750) reasons.push(`above-average vs ${oppHand}HP`);
  }
  const log = top.snap?.recentGameLog || [];
  if (log.length) {
    const last7 = log.slice(0, 7);
    let h = 0, ab = 0;
    last7.forEach(g => { h += parseInt(g.stat?.hits || 0); ab += parseInt(g.stat?.atBats || 0); });
    if (ab >= 10) {
      const avg = h / ab;
      if (avg >= 0.350) reasons.push('hot streak');
      else if (avg <= 0.150) reasons.push('cold of late');
    }
  }
  if (top.mu && top.muAb >= 5) {
    if (top.mu.hr && top.mu.hr >= 1) reasons.push(`HR history off ${S.pitcher.name.split(' ').pop()}`);
    else if (top.muOps && top.muOps >= 0.800) reasons.push(`hits ${S.pitcher.name.split(' ').pop()} well`);
  }
  if (!reasons.length) return '';
  reasons[0] = reasons[0].charAt(0).toUpperCase() + reasons[0].slice(1);
  return reasons.join(' · ');
}

// ── Pitcher card (dashboard) ────────────────────────────────────────────────
// Top of the dashboard, above the player cards. Shows pitcher name + meta,
// then async-fetches last 3 starts and season splits and slots them in.
// Re-fires Best Matchup at the end since rebuilding the card wipes that slot.
export function _renderPitcherCard() {
  const el = document.getElementById('dash-pitcher-card');
  if (!el) return;
  if (!S.pitcher) {
    el.innerHTML = `<div class="dash-pitcher-card" style="justify-content:space-between;">
      <div class="dash-pitcher-meta" style="color:#f39c12;">⚠ Probable pitcher not yet announced — scores exclude pitcher factors.</div>
      <button class="dash-pitcher-btn" data-action="open-setup" style="white-space:nowrap;">Set Pitcher</button>
    </div>`;
    return;
  }
  const era = S.pitcher.st?.era ? parseFloat(S.pitcher.st.era).toFixed(2) : '—';
  const hand = S.pitcher.hand || 'R';
  const bpBadge = S.pitcher.bullpenGame
    ? `<span style="background:#f39c12;color:#000;font-family:'Chakra Petch',monospace;font-size:9px;font-weight:900;letter-spacing:2px;padding:2px 7px;border-radius:4px;margin-left:8px;">OPENER/BULLPEN</span>`
    : '';
  el.innerHTML = `<div class="dash-pitcher-card pitcher-card-grid">
    <div class="pitcher-left">
      <div class="dash-pitcher-name">${S.pitcher.name}${bpBadge}</div>
      <div class="dash-pitcher-meta">${hand}HP · ERA ${era}${S.pitcher.bullpenGame ? ' · Expect multiple relievers' : ''}</div>
      <div id="dash-pitcher-form-slot"><div class="pf-loading">Loading recent starts…</div></div>
      <div id="dash-pitcher-splits-slot"></div>
    </div>
    <div id="dash-best-matchup-slot" class="pitcher-matchup"></div>
    <button class="dash-pitcher-btn" data-action="open-pitcher">View Stats</button>
  </div>`;
  if (S.pitcher.id && !S.pitcher.bullpenGame) {
    loadPitcherForm(S.pitcher.id).then(starts => {
      const slot = document.getElementById('dash-pitcher-form-slot');
      if (slot) slot.innerHTML = starts ? _renderPitcherForm(starts) : '';
    });
    loadPitcherSplits(S.pitcher.id).then(splits => {
      const slot = document.getElementById('dash-pitcher-splits-slot');
      // S.isHome is true when the D-backs are home — meaning the opposing pitcher is AWAY.
      const opposingIsHome = !S.isHome;
      if (slot) slot.innerHTML = splits ? _renderPitcherSplits(splits, opposingIsHome) : '';
    });
  } else {
    const slotF = document.getElementById('dash-pitcher-form-slot');
    if (slotF) slotF.innerHTML = '';
    const slotS = document.getElementById('dash-pitcher-splits-slot');
    if (slotS) slotS.innerHTML = '';
  }
  // Rebuilding the card wipes the matchup slot — repopulate it so opening a
  // player's stats (which triggers a pitcher-card re-render via state changes)
  // doesn't blank the Best Matchup card.
  _renderBestMatchup();
}
