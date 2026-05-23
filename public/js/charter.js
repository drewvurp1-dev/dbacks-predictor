// Charter Tracker — looks up an MLB team's chartered aircraft arrival via the
// /flights proxy (AeroDataBox). Requires AERODATABOX_API_KEY on the server and
// tail numbers populated in data/team_charters.json. When the result indicates
// a late arrival into PHX, auto-suggests bumping the Travel dropdown.

(function () {
  const TEAMS = [
    'ARI','ATL','BAL','BOS','CHC','CWS','CIN','CLE','COL','DET',
    'HOU','KC','LAA','LAD','MIA','MIL','MIN','NYM','NYY','ATH',
    'PHI','PIT','SD','SF','SEA','STL','TB','TEX','TOR','WSH',
  ];

  function populateTeams() {
    const sel = document.getElementById('charter-team');
    if (!sel || sel.options.length) return;
    sel.innerHTML = '<option value="">— select away team —</option>' +
      TEAMS.map(t => `<option value="${t}">${t}</option>`).join('');
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
    const hour = arrivalLocal.getHours(); // browser local; close enough for D-backs (MST)
    // Heuristic: landed after midnight or before 5 AM local = red-eye candidate.
    if (hour >= 0 && hour < 5) return 'redeye';
    // Landed same day as game (rough: less than ~10 hours before a 7pm first pitch) = same-day.
    const sameDay = arrivalLocal.toDateString() === new Date().toDateString();
    if (sameDay && hour >= 12) return 'same';
    return null;
  }

  window.checkCharter = async function () {
    const sel = document.getElementById('charter-team');
    const out = document.getElementById('charter-result');
    const btn = document.getElementById('charter-check-btn');
    if (!sel || !out) return;
    const abbr = sel.value;
    if (!abbr) { out.textContent = 'Pick a team first.'; return; }

    btn.disabled = true;
    out.textContent = 'Looking up charter…';

    // Default destination: PHX (assume D-backs home game). Could be wired to the
    // current game's stadium airport later.
    const destAirport = 'PHX';
    try {
      const r = await fetch(`/flights/team/${encodeURIComponent(abbr)}?destAirport=${destAirport}`);
      const d = await r.json();

      if (r.status === 503) {
        out.innerHTML = `<span style="color:#c84;">Charter tracker not configured.</span> Set <code>AERODATABOX_API_KEY</code> in <code>.env</code> and restart the server.`;
        return;
      }
      if (d.note && (!d.tails || !d.tails.length)) {
        out.innerHTML = `<span style="color:#c84;">No tail numbers registered for ${abbr}.</span> Add them to <code>data/team_charters.json</code> (sources: r/MLBcharterflights, JetPhotos spotter logs).`;
        return;
      }
      if (!d.arrival) {
        out.innerHTML = `Tracked tails: <code>${(d.tails || []).join(', ')}</code><br>No recent flights found in the last 48 h.`;
        return;
      }
      const a = d.arrival;
      const intoTarget = a.to === destAirport;
      const suggestion = suggestTravel(a);
      let html = `
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', populateTeams);
  } else {
    populateTeams();
  }
})();
