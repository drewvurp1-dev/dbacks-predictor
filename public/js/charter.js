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

  // MLB team ID -> our internal abbreviation. The /mlb/* schedule endpoint
  // doesn't include team.abbreviation in its default response (just id + name),
  // and special hydration is unreliable — so we lookup by stable team ID.
  const TEAM_ID_TO_ABBR = {
    108:'LAA', 109:'ARI', 110:'BAL', 111:'BOS', 112:'CHC', 113:'CIN',
    114:'CLE', 115:'COL', 116:'DET', 117:'HOU', 118:'KC',  119:'LAD',
    120:'WSH', 121:'NYM', 133:'ATH', 134:'PIT', 135:'SD',  136:'SEA',
    137:'SF',  138:'STL', 139:'TB',  140:'TEX', 141:'TOR', 142:'MIN',
    143:'PHI', 144:'ATL', 145:'CWS', 146:'MIA', 147:'NYY', 158:'MIL',
  };

  function populateTeams() {
    const sel = document.getElementById('charter-team');
    if (!sel || sel.options.length) return;
    sel.innerHTML = '<option value="">— select opponent —</option>' +
      OPPONENTS.map(t => `<option value="${t}">${t}</option>`).join('');
  }

  function setCharterCredits(remaining, limit) {
    const el = document.getElementById('adsbx-credits');
    if (!el) return;
    el.classList.remove('hidden');
    if (remaining == null) {
      el.textContent = '— charter';
      el.className = 'api-credits';
      return;
    }
    const n = parseInt(remaining);
    if (Number.isNaN(n)) {
      el.textContent = '— charter';
      el.className = 'api-credits';
      return;
    }
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

  // Resolve the app's state object from either window.S (if app.js exposed it
  // explicitly) or the bare `S` global from app.js's classic-script scope.
  // Top-level `const` in classic scripts is accessible from other classic
  // scripts as a bare identifier but is NOT attached to window — hence the
  // dual-path lookup.
  function getAppState() {
    if (typeof window.S === 'object' && window.S) return window.S;
    try { if (typeof S !== 'undefined' && S) return S; } catch (e) {}
    return null;
  }

  function isHomeGame() {
    const s = getAppState();
    if (s && typeof s.isHome === 'boolean') return s.isHome;
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
        out.innerHTML = `${context}<br>Tracked ${idParts.join(', ')}<br>No recent flights found in the last 3 days.`;
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

  // Per-flight in-page cache keyed by "gameDate|team|dest" so re-renders
  // within a session don't re-fire AeroDataBox lookups.
  const _dashCacheMap = new Map();
  const DASH_TTL = 15 * 60 * 1000;

  // Check if today's game is a series opener by comparing today's opponent to
  // the opponent of the most recent prior D-backs game (within last 3 days).
  // Self-sufficient schedule fetch — gets today's game + previous game in one
  // call so we don't depend on app.js state. Cached per dashboard render cycle.
  let _scheduleCache = { ts: 0, data: null, err: null };
  const SCHEDULE_TTL = 5 * 60 * 1000;

  async function fetchSchedule(start, end, includeSeason) {
    const seasonParam = includeSeason ? '&season=2026' : '';
    const url = `/mlb/api/v1/schedule?sportId=1&teamId=109&gameType=R${seasonParam}&startDate=${start}&endDate=${end}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`MLB ${r.status}`);
    const d = await r.json();
    return (d?.dates || []).flatMap(dt => dt.games || []);
  }

  async function loadGameContext() {
    if (_scheduleCache.data && Date.now() - _scheduleCache.ts < SCHEDULE_TTL) {
      return _scheduleCache.data;
    }
    const start = new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10);
    const end   = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    let games = [];
    let err = null;
    // Try with season=2026 first (matches the rest of the app). If that returns
    // an empty list, retry without season so we don't break across year boundaries.
    try {
      games = await fetchSchedule(start, end, true);
    } catch (e) { err = e.message; }
    if (!games.length) {
      try { games = await fetchSchedule(start, end, false); }
      catch (e) { err = err || e.message; }
    }
    if (!games.length) {
      _scheduleCache = { ts: Date.now(), data: null, err: err || `no games ${start}..${end}` };
      return null;
    }
    const today = games.find(g => g.status?.abstractGameState === 'Live')
               || games.find(g => g.status?.abstractGameState === 'Preview')
               || games[games.length - 1];
    if (!today) {
      _scheduleCache = { ts: Date.now(), data: null, err: 'no usable game' };
      return null;
    }
    const isHome = today.teams?.home?.team?.id === 109;
    const oppSide = isHome ? today.teams?.away : today.teams?.home;
    const oppId = oppSide?.team?.id;
    const opp = TEAM_ID_TO_ABBR[oppId]
             || oppSide?.team?.abbreviation
             || oppSide?.team?.teamCode?.toUpperCase()
             || null;
    if (!opp) {
      _scheduleCache = { ts: Date.now(), data: null, err: `unknown opp team id ${oppId} on ${today.officialDate}` };
      return null;
    }
    const finals = games.filter(g => g.status?.abstractGameState === 'Final');
    const prev = finals[finals.length - 1] || null;
    const prevHome = prev?.teams?.home?.team?.id === 109;
    const prevOppId = prev ? (prevHome ? prev.teams?.away?.team?.id : prev.teams?.home?.team?.id) : null;
    const prevOpp = prevOppId ? (TEAM_ID_TO_ABBR[prevOppId] || null) : null;
    const result = { opp, homeGame: isHome, gameDate: today.officialDate, prevOpp, prevWasAway: prev ? !prevHome : false };
    _scheduleCache = { ts: Date.now(), data: result, err: null };
    return result;
  }

  // Fetch and render one flight; returns { html, tierClass, hidden }.
  // Checks _dashCacheMap first; populates it on a live fetch.
  // Pass forceRefresh=true to bypass both the client page cache and the server's
  // in-process /cached endpoint, forcing a fresh AeroDataBox query.
  async function fetchOneFlight(team, dest, gameDate, forceRefresh = false) {
    const key = `${gameDate}|${team}|${dest}`;
    const cached = _dashCacheMap.get(key);
    if (!forceRefresh && cached && Date.now() - cached.ts < DASH_TTL) {
      return { html: cached.html, tierClass: cached.cls };
    }

    try {
      // On a forced refresh skip the /cached shortcut so we always hit AeroDataBox
      // directly. Otherwise try the server's in-process cache first (no credit burned)
      // and fall back to a live lookup only when the server has nothing cached yet.
      let r;
      if (forceRefresh) {
        r = await fetch(`/flights/team/${encodeURIComponent(team)}?destAirport=${dest}`);
      } else {
        r = await fetch(`/flights/team/${encodeURIComponent(team)}/cached?destAirport=${dest}`);
        if (r.status === 204) {
          r = await fetch(`/flights/team/${encodeURIComponent(team)}?destAirport=${dest}`);
        }
      }
      const d = await r.json();
      if (d?.quota?.remaining != null) setCharterCredits(d.quota.remaining, d.quota.limit);

      const hasIds = (d.tails && d.tails.length) || (d.callsigns && d.callsigns.length);
      if (r.status === 503 || (d.note && !hasIds)) {
        return { html: '', tierClass: '', hidden: true };
      }
      if (!d.arrival) {
        const ids = [...(d.tails || []), ...(d.callsigns || [])].join(', ') || '—';
        const flightCount = d.raw_flight_count || 0;
        const detail = flightCount > 0
          ? `${flightCount} flights found, none into ${dest}`
          : `no ${ids} flights in last 3 days`;
        const html = `<span class="dch-plane">✈</span><span class="dch-route">${team} → ${dest}</span><span class="dch-spinner">${detail}</span><span style="color:#444;font-size:9px;">${ids}</span>`;
        _dashCacheMap.set(key, { html, cls: '', ts: Date.now() });
        return { html, tierClass: '' };
      }

      const a = d.arrival;
      const idTxt = a.callsign && (a.source || '').startsWith('callsign:')
        ? a.callsign
        : (a.tail || a.callsign || '—');
      const route = `${team} ${a.from || '???'} → <strong>${a.to || '???'}</strong>`;

      // Phase detection — trust actualTime fields when present, fall back to
      // AeroDataBox's status field since that's the authoritative phase marker
      // and actualTime is often null even on flights AeroDataBox knows landed.
      const statusLc = (a.status || '').toLowerCase();
      const arrivedByStatus = /(arrived|landed|on block|canceled|cancelled|diverted)/.test(statusLc);
      const enRouteByStatus = /(en[-\s]?route|departed|airborne|approaching)/.test(statusLc);
      // AeroDataBox frequently never flips a charter to "Arrived" nor fills an
      // actual arrival time, which left flights stuck on EN ROUTE forever. As a
      // fallback, infer a landing once the best-known ETA is comfortably (45 min)
      // in the past.
      const arrRefUtc = a.arrActualUtc || a.arrEstimatedUtc || a.arrScheduledUtc;
      const minPastEta = arrRefUtc ? (Date.now() - new Date(arrRefUtc).getTime()) / 60000 : -Infinity;
      const landedByTime = minPastEta >= 45;
      const landed   = !!a.arrActualUtc || arrivedByStatus || landedByTime;
      const departed = !landed && (!!a.depActualUtc || enRouteByStatus);
      const displayArrUtc = a.arrActualUtc || a.arrEstimatedUtc || a.arrScheduledUtc;
      const displayDepUtc = a.depActualUtc || a.depScheduledUtc;
      const arrIsActual = !!a.arrActualUtc;

      let html, tierClass = '';

      if (landed) {
        const body = bodyClockArrival(displayArrUtc, a.depLocal);
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
          <span class="dch-time">landed ${fmtLocal(displayArrUtc)}${arrIsActual ? '' : ' (est)'}</span>
          <span class="dch-body">(body ${fmtBodyHM(body)})</span>
          ${flagBadge}
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      } else if (departed) {
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
          <span class="dch-time">departed ${fmtLocal(displayDepUtc)}${delayTxt}</span>
          ${etaUtc ? `<span class="dch-body">ETA ${fmtLocal(etaUtc)}</span>` : ''}
          <span class="dch-flag" style="color:#5dade2;">⏳ EN ROUTE</span>
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      } else {
        html = `
          <span class="dch-plane">✈</span>
          <span class="dch-route">${route}</span>
          <span class="dch-time">scheduled ${fmtLocal(a.depScheduledUtc)}${a.arrScheduledUtc ? ' → ' + fmtLocal(a.arrScheduledUtc) : ''}</span>
          <span class="dch-flag" style="color:#888;">◷ SCHEDULED</span>
          <span style="color:#444;font-size:9px;">${idTxt}</span>
        `;
      }
      _dashCacheMap.set(key, { html, cls: tierClass, ts: Date.now() });
      return { html, tierClass };
    } catch (e) {
      return { html: '', tierClass: '', hidden: true };
    }
  }

  window.renderDashboardCharter = async function (forceRefresh = false) {
    const el = document.getElementById('dash-charter-strip');
    if (!el) return;
    el.classList.remove('hidden');

    // Fetch game context directly from MLB schedule — self-sufficient,
    // doesn't depend on app.js state being populated correctly. The
    // /mlb/* proxy is free, no AeroDataBox credits burned here.
    const ctx = await loadGameContext();
    if (!ctx || !ctx.opp) {
      const detail = _scheduleCache.err || 'no upcoming game found';
      el.className = 'dash-charter';
      el.innerHTML = `<span class="dch-plane">✈</span><span class="dch-route">Charter tracker</span><span class="dch-spinner">${detail}</span>`;
      return;
    }

    const { opp, homeGame, gameDate } = ctx;

    // Series-opener detection uses the prevOpp we already pulled, no extra call.
    const seriesOpener = !ctx.prevOpp || ctx.prevOpp !== opp;

    // Mid-series days: passive line, no AeroDataBox call.
    if (!seriesOpener) {
      el.className = 'dash-charter';
      el.innerHTML = `<span class="dch-plane">✈</span><span class="dch-route">Charter tracker</span><span class="dch-spinner">mid-series · no new travel today</span>`;
      return;
    }

    // Build the list of flights to track for this series opener.
    // Dual-track when D-backs host AND they're returning from a road trip
    // (prevWasAway = their last game was also away from PHX).
    const flights = [];
    if (homeGame) {
      flights.push({ team: opp, dest: 'PHX' });
      if (ctx.prevWasAway) flights.push({ team: 'ARI', dest: 'PHX' });
    } else {
      const dest = OPP_AIRPORTS[opp] || null;
      if (!dest) {
        el.className = 'dash-charter';
        el.innerHTML = `<span class="dch-plane">✈</span><span class="dch-route">Charter tracker</span><span class="dch-spinner">unknown destination for ${opp}</span>`;
        return;
      }
      flights.push({ team: 'ARI', dest });
    }

    el.className = 'dash-charter';
    el.innerHTML = flights.map(f =>
      `<span class="dch-plane">✈</span><span class="dch-spinner">${f.team} → ${f.dest}…</span>`
    ).join('');

    // Fetch all tracked flights in parallel — caching inside fetchOneFlight
    // bounds AeroDataBox quota to one call per flight per 15-min window.
    const results = await Promise.all(flights.map(f => fetchOneFlight(f.team, f.dest, gameDate, forceRefresh)));
    const visible = results.filter(r => !r.hidden);

    if (!visible.length) {
      el.classList.add('hidden');
      return;
    }

    const refreshBtn = '<button class="dch-refresh" data-action="refresh-charter" title="Refresh charter status">↻</button>';

    if (visible.length === 1) {
      el.className = `dash-charter ${visible[0].tierClass}`.trim();
      el.innerHTML = visible[0].html + refreshBtn;
    } else {
      // Dual-track: stack two rows; apply the worst tier to the container
      // so the border colour reflects the most-concerning flight.
      const tierRank = { 'dch-critical': 3, 'dch-red': 2, 'dch-yellow': 1, '': 0 };
      const worstTier = visible.reduce((best, r) =>
        (tierRank[r.tierClass] || 0) > (tierRank[best] || 0) ? r.tierClass : best, '');
      el.className = `dash-charter dch-dual ${worstTier}`.trim();
      el.innerHTML = visible.map(r => `<div class="dch-row">${r.html}</div>`).join('') + refreshBtn;
    }
  };

  // Bust both the client page cache and the server's in-process cache, then
  // re-render immediately with a fresh AeroDataBox call.
  // Exposed so app.js's 'refresh-charter' ACTIONS entry can call it.
  window.refreshDashboardCharter = function () {
    _dashCacheMap.clear();
    window.renderDashboardCharter(true); // forceRefresh → bypasses server /cached endpoint
  };

  // ── Setup panel: auto-detect opponent + home/away from app's loaded game ────
  let _lastAuto = { opp: null, home: null };
  function syncFromGame() {
    const sel = document.getElementById('charter-team');
    const out = document.getElementById('charter-result');
    if (!sel || !out) return;
    const opp = getAppState()?.opposingTeamAbbr || null;
    const homeGame = isHomeGame();
    // Always nudge the dashboard renderer — its internal cache prevents
    // re-firing API calls within the 15-min TTL, and this lets it recover
    // from any earlier "waiting for game data…" stub render.
    if (typeof window.renderDashboardCharter === 'function') {
      window.renderDashboardCharter();
    }
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
      // Always show the chip if the API is configured, even before any actual
      // lookup has fired (so the user can confirm the integration is alive).
      if (d?.configured) {
        setCharterCredits(d?.quota?.remaining ?? null, d?.quota?.limit ?? null);
      }
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
