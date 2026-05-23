// Charter Tracker — looks up MLB charter aircraft arrivals via the /flights
// proxy (AeroDataBox). Honors the page's Home/Away toggle:
//   Home game  → tracks the opponent arriving at PHX
//   Away game  → tracks the D-backs (ARI) arriving at the opponent's home airport
// Requires AERODATABOX_API_KEY on the server and tail numbers populated in
// data/team_charters.json. When a late landing is detected, suggests bumping
// the Travel dropdown.

(function () {
  // Opponent → home airport map (mirrors data/team_charters.json server-side).
  const OPP_AIRPORTS = {
    ATL:'ATL', BAL:'BWI', BOS:'BOS', CHC:'ORD', CWS:'MDW', CIN:'CVG',
    CLE:'CLE', COL:'DEN', DET:'DTW', HOU:'IAH', KC:'MCI', LAA:'SNA',
    LAD:'LAX', MIA:'MIA', MIL:'MKE', MIN:'MSP', NYM:'JFK', NYY:'EWR',
    ATH:'SMF', PHI:'PHL', PIT:'PIT', SD:'SAN', SF:'SFO', SEA:'SEA',
    STL:'STL', TB:'TPA', TEX:'DFW', TOR:'YYZ', WSH:'IAD',
  };
  const OPPONENTS = Object.keys(OPP_AIRPORTS); // 29 non-ARI teams

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

  function suggestTravel(arrival) {
    if (!arrival || !arrival.arrUtc) return null;
    const arrivalLocal = new Date(arrival.arrUtc);
    const hour = arrivalLocal.getHours();
    if (hour >= 0 && hour < 5) return 'redeye';
    const sameDay = arrivalLocal.toDateString() === new Date().toDateString();
    if (sameDay && hour >= 12) return 'same';
    return null;
  }

  // Read the page-level Home/Away toggle. Falls back to "home" if S is not
  // exposed yet on first paint.
  function isHomeGame() {
    if (typeof window.S === 'object' && window.S && typeof window.S.isHome === 'boolean') {
      return window.S.isHome;
    }
    return document.getElementById('loc-home')?.classList.contains('active') ?? true;
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
        out.innerHTML = `<span style="color:#c84;">Charter tracker not configured.</span> Set <code>AERODATABOX_API_KEY</code> in <code>.env</code> and restart the server.`;
        return;
      }
      if (d.note && (!d.tails || !d.tails.length)) {
        out.innerHTML = `<span style="color:#c84;">No tail numbers registered for ${trackedTeam}.</span> Add them to <code>data/team_charters.json</code> (sources: r/MLBcharterflights, JetPhotos spotter logs).`;
        return;
      }
      if (!d.arrival) {
        out.innerHTML = `${context}<br>Tracked tails: <code>${(d.tails || []).join(', ')}</code><br>No recent flights found in the last 48 h.`;
        return;
      }
      const a = d.arrival;
      const intoTarget = a.to === destAirport;
      const suggestion = suggestTravel(a);
      let html = `
        <div style="color:#999;">${context}</div>
        <div>Tail <code>${a.tail || '—'}</code> &middot; ${a.from || '???'} → <strong style="color:${intoTarget?'#5d8':'#aaa'};">${a.to || '???'}</strong></div>
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

  // Auto-detect the opponent + home/away from the app's loaded game state.
  // The main app sets S.opposingTeamAbbr and S.isHome asynchronously when the
  // game-date schedule resolves; we poll until both appear, then pre-fill the
  // dropdown and refresh the hint. The actual /flights call still waits on the
  // user clicking Track so credits aren't burned on every page load.
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

    // Only auto-fill if the user hasn't manually picked something different.
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

  // Mark manual selections so syncFromGame doesn't clobber them on re-render.
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
    // Poll every 1.5s — game data resolves within a few seconds of page load,
    // and S.isHome can flip if the user toggles Location manually.
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
