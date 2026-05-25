// Charter Tracker — looks up MLB charter aircraft arrivals via the /flights
// proxy (AeroDataBox). Two surfaces:
//   1. Setup panel "Charter" row    — manual track button, user-driven
//   2. Dashboard "#dash-charter-strip" — auto-fires on series-opener days,
//      flags late/red-eye arrivals by body-clock (origin time zone).
//
// Honors the page's Home/Away toggle: Home games track the opponent into PHX,
// Away games track the D-backs into the opponent's home airport.

(function () {
  // Opponent → home airport map (mirrors data/team_charters.json server-side).
  const OPP_AIRPORTS = {
    ATL:'ATL', BAL:'BWI', BOS:'BOS', CHC:'ORD', CWS:'MDW', CIN:'CVG',
    CLE:'CLE', COL:'DEN', DET:'DTW', HOU:'IAH', KC:'MCI', LAA:'SNA',
    LAD:'LAX', MIA:'MIA', MIL:'MKE', MIN:'MSP', NYM:'JFK', NYY:'EWR',
    ATH:'SMF', PHI:'PHL', PIT:'PIT', SD:'SAN', SF:'SFO', SEA:'SEA',
    STL:'STL', TB:'TPA', TEX:'DFW', TOR:'YYZ', WSH:'IAD',
  };
  const OPPONENTS = Object.keys(OPP_AIRPORTS);

  function populateTeams() {
    const sel = document.getElementById('charter-team');
    if (!sel || sel.options.length) return;
    sel.innerHTML = '<option value="">— select opponent —</option>' +
      OPPONENTS.map(t => `<option value="${t}">${t}</option>`).join('');
  }

  function setCharterCredits(remaining, limit) {
    const el = document.getElementById('adsbx-credits');
    if (!el) return;
    if (remaining == null) { el.classList.add('hidden'); return; }
    const n = parseInt(remaining);
    if (Number.isNaN(n)) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = limit != null ? `${n}/${limit} charter` : `${n} charter`;
    el.className = 'api-credits' + (n < 10 ? ' critical' : n < 50 ? ' low' : '');
  }

  function fmtLocal(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    } catch { return iso; }
  }

  // Extract the timezone offset (in minutes) from an ISO string with offset
  // suffix like "2025-04-15T19:30+02:00" or "2025-04-15T19:30-07:00".
  // Returns null if no offset present.
  function extractOffsetMinutes(localIso) {
    if (!localIso || typeof localIso !== 'string') return null;
    const m = localIso.match(/([+\-])(\d{2}):?(\d{2})$/);
    if (!m) return null;
    const sign = m[1] === '+' ? 1 : -1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }

  // Body-clock arrival = arrival UTC adjusted into the ORIGIN time zone, because
  // that's the time zone the team's circadian system is still anchored to.
  // Returns a Date whose UTC fields read as the body-clock wall-clock time.
  function bodyClockArrival(arrUtcStr, depLocalStr) {
    if (!arrUtcStr) return null;
    const arrUtc = new Date(arrUtcStr);
    const offMin = extractOffsetMinutes(depLocalStr);
    if (offMin == null) return arrUtc; // fall back to UTC if we can't determine origin TZ
    return new Date(arrUtc.getTime() + offMin * 60 * 1000);
  }

  // Format a body-clock Date (constructed via bodyClockArrival above) into a
  // "9:42 PM" style string using its UTC fields.
  function fmtBodyHM(d) {
    if (!d) return '—';
    let h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return `${h}:${m.toString().padStart(2,'0')} ${ampm}`;
  }

  // Flag tiers (user-configured thresholds):
  //   yellow   = body-clock arrival 22:00–24:00
  //   red      = body-clock arrival 00:00–06:00 (red-eye window)
  //   critical = arrival on the same calendar day as the game (regardless of hour)
  function classifyArrival(bodyDate, gameDateYmd) {
    if (!bodyDate) return { tier: 'unknown' };
    const h = bodyDate.getUTCHours();
    // Same-day arrival check uses destination-local arrival date, approximated
    // by the body-clock date (close enough — we only need to compare YMD).
    const arrYmd = bodyDate.toISOString().slice(0, 10);
    if (gameDateYmd && arrYmd === gameDateYmd) {
      return { tier: 'critical', label: 'same-day arrival' };
    }
    if (h >= 0 && h < 6)  return { tier: 'red',    label: 'red-eye' };
    if (h >= 22)          return { tier: 'yellow', label: 'late arrival' };
    return { tier: 'normal', label: '' };
  }

  function isHomeGame() {
    if (typeof window.S === 'object' && window.S && typeof window.S.isHome === 'boolean') {
      return window.S.isHome;
    }
    return document.getElementById('loc-home')?.classList.contains('active') ?? true;
  }

  function suggestTravel(arrival) {
    if (!arrival || !arrival.arrUtc) return null;
    const body = bodyClockArrival(arrival.arrUtc, arrival.depLocal);
    const h = body ? body.getUTCHours() : new Date(arrival.arrUtc).getHours();
    if (h >= 0 && h < 6) return 'redeye';
    const sameDay = new Date(arrival.arrUtc).toDateString() === new Date().toDateString();
    if (sameDay && h >= 12) return 'same';
    return null;
  }

  window.checkCharter = async function () {
    const sel = document.getElementById('charter-team');
    const out = document.getElementById('charter-result');
    const btn = document.getElementById('charter-check-btn');
    if (!sel || !out) return;
    const opp = sel.value;
    if (!opp) { out.textContent = 'Pick the opponent first.'; return; }

    const homeGame = isHomeGame();
    const trackedTeam  = homeGame ? opp   : 'ARI';
    const destAirport  = homeGame ? 'PHX' : (OPP_AIRPORTS[opp] || 'PHX');
    const context = homeGame
      ? `Tracking ${opp} into PHX`
      : `Tracking ARI into ${destAirport} (${opp})`;

    btn.disabled = true;
    out.innerHTML = `<span style="color:#999;">${context}…</span>`;

    try {
      const r = await fetch(`/flights/team/${encodeURIComponent(trackedTeam)}?destAirport=${destAirport}`);
      const d = await r.json();
      const headerRem = r.headers.get('X-Aerodatabox-Remaining');
      const headerLim = r.headers.get('X-Aerodatabox-Limit');
      if (headerRem != null) setCharterCredits(headerRem, headerLim);
      else if (d?.quota?.remaining != null) setCharterCredits(d.quota.remaining, d.quota.limit);

      if (r.status === 503) {
        out.innerHTML = `<span style="color:#c84;">Charter tracker not configured.</span> Set <code>AERODATABOX_API_KEY</code> on Railway (or in <code>.env</code> locally) and redeploy.`;
        return;
      }
      const hasIds = (d.tails && d.tails.length) || (d.callsigns && d.callsigns.length);
      if (d.note && !hasIds) {
        out.innerHTML = `<span style="color:#c84;">No tails or callsigns registered for ${trackedTeam}.</span> Add them to <code>data/team_charters.json</code>.`;
        return;
      }
      if (!d.arrival) {
        const idParts = [];
        if (d.tails && d.tails.length)         idParts.push('tails <code>' + d.tails.join(', ') + '</code>');
        if (d.callsigns && d.callsigns.length) idParts.push('callsigns <code>' + d.callsigns.join(', ') + '</code>');
        out.innerHTML = `${context}<br>Tracked ${idParts.join(', ')}<br>No recent flights found in the last 48 h.`;
        return;
      }
      const a = d.arrival;
      const intoTarget = a.to === destAirport;
      const suggestion = suggestTravel(a);
      const idLine = a.callsign && (a.source || '').startsWith('callsign:')
        ? `Flight <code>${a.callsign}</code>${a.tail ? ` &middot; tail <code>${a.tail}</code>` : ''}`
        : `Tail <code>${a.tail || a.callsign || '—'}</code>`;
      let html = `
        <div style="color:#999;">${context}</div>
        <div>${idLine} &middot; ${a.from || '???'} → <strong style="color:${intoTarget?'#5d8':'#aaa'};">${a.to || '???'}</strong></div>
        <div>Arrived ${fmtLocal(a.arrUtc)}${a.status ? ` <span style="color:#666;">(${a.status})</span>`:''}</div>
      `;
      if (intoTarget && suggestion) {
        html += `<div style="margin-top:4px;color:#c84;">Late landing — suggest setting Travel to <strong>${suggestion === 'redeye' ? 'Red-eye / Cross-timezone' : 'Same-day travel'}</strong>.</div>`;
        html += `<div><button type="button" onclick="applyCharterSuggestion('${suggestion}')" style="margin-top:4px;padding:2px 8px;background:#222;color:#5d8;border:1px solid #5d8;font-family:'Chakra Petch',monospace;font-size:10px;cursor:pointer;letter-spacing:1px;text-transform:uppercase;">Apply suggestion</button></div>`;
      } else if (!intoTarget) {
        html += `<div style="color:#999;margin-top:4px;">Most recent arrival is not into ${destAirport}.</div>`;
      }
      out.innerHTML = html;
    } catch (e) {
      out.innerHTML = `<span style="color:#c66;">Lookup failed: ${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  };

  window.applyCharterSuggestion = function (val) {
    const sel = document.getElementById('travel-select');
    if (!sel) return;
    sel.value = val;
    sel.dispatchEvent(new Event('change'));
  };

  // ── Dashboard strip ─────────────────────────────────────────────────────────
  // Auto-fires the charter lookup on series-opener days, displays a colored
  // flag based on body-clock arrival, hides itself otherwise.

  // In-page cache so re-renders within a session don't re-fire the lookup.
  const _dashCache = { key: null, html: null, cls: null, ts: 0 };
  const DASH_TTL = 15 * 60 * 1000;

  // Check if today's game is a series opener by comparing today's opponent to
  // the opponent of the most recent prior D-backs game (within last 3 days).
  async function isSeriesOpener(todayYmd, todayOpp) {
    if (!todayYmd || !todayOpp) return false;
    try {
      const start = new Date(new Date(todayYmd).getTime() - 3 * 86400000).toISOString().slice(0, 10);
      const end   = new Date(new Date(todayYmd).getTime() - 1 * 86400000).toISOString().slice(0, 10);
      const r = await fetch(`/mlb/api/v1/schedule?sportId=1&teamId=109&season=2026&gameType=R&startDate=${start}&endDate=${end}`);
      const d = await r.json();
      const games = (d?.dates || []).flatMap(dt => dt.games || []).filter(g => g.status?.abstractGameState === 'Final');
      const prev = games[games.length - 1];
      if (!prev) return true; // no game in last 3 days = traveled here from home stand or off
      const prevHome = prev.teams?.home?.team?.id === 109;
      const prevOpp = prevHome ? prev.teams?.away?.team?.abbreviation : prev.teams?.home?.team?.abbreviation;
      return prevOpp !== todayOpp;
    } catch (e) {
      return false; // if we can't tell, don't auto-fire
    }
  }

  window.renderDashboardCharter = async function () {
    const el = document.getElementById('dash-charter-strip');
    if (!el) return;

    const opp = window.S?.opposingTeamAbbr || null;
    const gameDate = document.getElementById('game-date')?.value || '';
    if (!opp || !gameDate) { el.classList.add('hidden'); return; }

    const homeGame = isHomeGame();
    const trackedTeam = homeGame ? opp   : 'ARI';
    const destAirport = homeGame ? 'PHX' : (OPP_AIRPORTS[opp] || null);
    if (!destAirport) { el.classList.add('hidden'); return; }

    const cacheKey = `${gameDate}|${trackedTeam}|${destAirport}`;
    if (_dashCache.key === cacheKey && Date.now() - _dashCache.ts < DASH_TTL) {
      el.className = `dash-charter ${_dashCache.cls || ''}`.trim();
      el.innerHTML = _dashCache.html;
      return;
    }

    const seriesOpener = await isSeriesOpener(gameDate, opp);
    if (!seriesOpener) { el.classList.add('hidden'); return; }

    // Show a "loading" state while we hit AeroDataBox.
    el.classList.remove('hidden');
    el.className = 'dash-charter';
    el.innerHTML = `<span class="dch-plane">✈</span><span class="dch-spinner">Looking up ${trackedTeam} charter into ${destAirport}…</span>`;

    try {
      const r = await fetch(`/flights/team/${encodeURIComponent(trackedTeam)}?destAirport=${destAirport}`);
      const d = await r.json();
      const headerRem = r.headers.get('X-Aerodatabox-Remaining');
      const headerLim = r.headers.get('X-Aerodatabox-Limit');
      if (headerRem != null) setCharterCredits(headerRem, headerLim);
      else if (d?.quota?.remaining != null) setCharterCredits(d.quota.remaining, d.quota.limit);

      // Render an informative one-line strip even on null arrivals — useful
      // signal that "we tried, nothing landed yet".
      const hasIds = (d.tails && d.tails.length) || (d.callsigns && d.callsigns.length);
      if (r.status === 503 || (d.note && !hasIds)) {
        el.classList.add('hidden');
        return;
      }
      if (!d.arrival) {
        const cls = '';
        const html = `<span class="dch-plane">✈</span><span>${trackedTeam} → ${destAirport}</span><span class="dch-spinner">no charter movement found yet</span>`;
        el.className = `dash-charter ${cls}`.trim();
        el.innerHTML = html;
        _dashCache.key = cacheKey; _dashCache.ts = Date.now(); _dashCache.html = html; _dashCache.cls = cls;
        return;
      }
      const a = d.arrival;
      const idTxt = a.callsign && (a.source || '').startsWith('callsign:')
        ? a.callsign
        : (a.tail || a.callsign || '—');
      const route = `${trackedTeam} ${a.from || '???'} → <strong>${a.to || '???'}</strong>`;

      // Phase detection — actual arrival wins over actual departure wins over scheduled.
      const landed   = !!a.arrActualUtc;
      const departed = !landed && !!a.depActualUtc;
      const scheduled = !landed && !departed;

      let html, tierClass = '';

      if (landed) {
        const body = bodyClockArrival(a.arrActualUtc, a.depLocal);
        const cls_ = classifyArrival(body, gameDate);
        tierClass = cls_.tier === 'yellow'   ? 'dch-yellow'
                  : cls_.tier === 'red'      ? 'dch-red'
                  : cls_.tier === 'critical' ? 'dch-critical'
                  : '';
        const flagBadge = cls_.label
          ? `<span class="dch-flag">⚑ ${cls_.label.toUpperCase()}</span>`
          : `<span class="dch-flag" style="color:#2ecc71;">✓ on time</span>`;
        html = `
          <span class="dch-plane">✈</span>
          <span class="dch-route">${route}</span>
          <span class="dch-time">landed ${fmtLocal(a.arrActualUtc)}</span>
          <span class="dch-body">(body ${fmtBodyHM(body)})</span>
          ${flagBadge}
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      } else if (departed) {
        // In the air — show departure delta vs scheduled, plus best-guess arrival.
        const etaUtc = a.arrEstimatedUtc || a.arrScheduledUtc;
        const depDelayMin = (a.depScheduledUtc && a.depActualUtc)
          ? Math.round((new Date(a.depActualUtc) - new Date(a.depScheduledUtc)) / 60000)
          : null;
        const delayTxt = depDelayMin == null ? ''
          : depDelayMin > 0 ? ` <span style="color:#f1c40f;">(${depDelayMin} min late)</span>`
          : depDelayMin < 0 ? ` <span style="color:#2ecc71;">(${-depDelayMin} min early)</span>`
          : '';
        html = `
          <span class="dch-plane">✈</span>
          <span class="dch-route">${route}</span>
          <span class="dch-time">departed ${fmtLocal(a.depActualUtc)}${delayTxt}</span>
          ${etaUtc ? `<span class="dch-body">ETA ${fmtLocal(etaUtc)}</span>` : ''}
          <span class="dch-flag" style="color:#5dade2;">⏳ EN ROUTE</span>
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      } else {
        // Scheduled — show planned departure and arrival.
        html = `
          <span class="dch-plane">✈</span>
          <span class="dch-route">${route}</span>
          <span class="dch-time">scheduled ${fmtLocal(a.depScheduledUtc)}${a.arrScheduledUtc ? ' → ' + fmtLocal(a.arrScheduledUtc) : ''}</span>
          <span class="dch-flag" style="color:#888;">◷ SCHEDULED</span>
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      }
      el.className = `dash-charter ${tierClass}`.trim();
      el.innerHTML = html;
      _dashCache.key = cacheKey; _dashCache.ts = Date.now(); _dashCache.html = html; _dashCache.cls = tierClass;
    } catch (e) {
      el.classList.add('hidden');
    }
  };

  // ── Setup panel: auto-detect opponent + home/away from app's loaded game ────
  let _lastAuto = { opp: null, home: null };
  function syncFromGame() {
    const sel = document.getElementById('charter-team');
    const out = document.getElementById('charter-result');
    if (!sel || !out) return;
    const opp = window.S?.opposingTeamAbbr || null;
    const homeGame = isHomeGame();
    if (!opp) return;
    if (opp === _lastAuto.opp && homeGame === _lastAuto.home) return;
    _lastAuto = { opp, home: homeGame };

    const userPicked = sel.value && sel.value !== _lastAuto.opp && sel.dataset.userSet === '1';
    if (!userPicked && [...sel.options].some(o => o.value === opp)) {
      sel.value = opp;
    }
    const destAirport = homeGame ? 'PHX' : (OPP_AIRPORTS[opp] || '?');
    const summary = homeGame
      ? `Auto-detected: ${opp} → PHX`
      : `Auto-detected: ARI → ${destAirport} (${opp})`;
    out.innerHTML = `<span style="color:#5d8;">${summary}</span><br>Click <strong>Track</strong> to look up the charter.`;
  }

  function wireManualOverride() {
    const sel = document.getElementById('charter-team');
    if (!sel) return;
    sel.addEventListener('change', () => { sel.dataset.userSet = '1'; });
  }

  async function primeCredits() {
    try {
      const r = await fetch('/flights/status');
      const d = await r.json();
      if (d?.quota?.remaining != null) setCharterCredits(d.quota.remaining, d.quota.limit);
    } catch (e) { /* status endpoint is optional cosmetic */ }
  }

  function init() {
    populateTeams();
    wireManualOverride();
    setInterval(syncFromGame, 1500);
    syncFromGame();
    primeCredits();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
