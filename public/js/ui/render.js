// Render helpers. Pure DOM/HTML generation — no fetches, no S mutation.
// Reads S where it needs current state. statBox + _renderStatTip form the
// shared building blocks the stat-grid renderers compose on top of.

import { S } from '../state.js';
import { PITCH_NAMES, STAT_INFO } from '../constants.js';

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
