// Organizer dashboard. Everything here is behind VOTE_ADMIN_KEY on the server —
// this file just holds the key in localStorage and renders what comes back.

const KEY_STORE = 'tripVote.adminKey';
const $ = id => document.getElementById(id);

let data = null;

const key = () => localStorage.getItem(KEY_STORE) || '';

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Admin-Key': key() };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/vote/api/admin${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(out.error || `Request failed (${r.status})`);
    err.status = r.status;
    err.code = out.code;
    throw err;
  }
  return out;
}

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

const txt = (el, s) => { el.textContent = s; return el; };

function chip(n, name) {
  const s = document.createElement('span');
  s.className = 'chip';
  const num = document.createElement('span');
  num.className = 'chip-n';
  num.textContent = n;
  s.appendChild(num);
  s.appendChild(document.createTextNode(name));
  return s;
}

// ── render ──────────────────────────────────────────────────────────────────

function render() {
  const { poll, result, ballots, destinations, report } = data;

  $('statusPill').textContent = !poll.open ? 'Voting closed'
    : poll.phase === 'nominate' ? 'Suggestions open — voting not started'
      : 'Voting open';
  $('statusPill').classList.toggle('urgent', !poll.open);
  $('ballotPill').textContent =
    `${result.countedBallots} submitted · ${ballots.length - result.countedBallots} draft`;

  // Winner
  if (result.winner) {
    txt($('winnerName'), result.winner.name);
    txt($('winnerSub'),
      `${result.winner.votes} of ${result.winner.of} continuing ballots · decided in round ${result.rounds.length}`);
  } else {
    txt($('winnerName'), 'No winner yet');
    txt($('winnerSub'), 'No submitted ballots.');
  }

  const flags = $('winnerFlags');
  flags.innerHTML = '';
  if (result.tie) {
    const d = document.createElement('div');
    d.className = 'flag flag-warn';
    d.textContent = `Dead tie between ${result.tiedAmong.map(t => t.name).join('; ')} — broken on consensus points.`;
    flags.appendChild(d);
  }
  if (result.winner && !result.agreement && result.consensusPick) {
    const d = document.createElement('div');
    d.className = 'flag flag-split';
    d.textContent = `The consensus score prefers ${result.consensusPick.name} (${result.consensusPick.points} pts). The group is split — worth a conversation before booking.`;
    flags.appendChild(d);
  }

  // Rounds
  const rw = $('rounds');
  rw.innerHTML = '';
  if (!result.rounds.length) {
    rw.innerHTML = '<p class="muted small">Nothing to tally yet.</p>';
  }
  for (const r of result.rounds) {
    const box = document.createElement('div');
    box.className = 'round';

    const head = document.createElement('div');
    head.className = 'round-head';
    const t = document.createElement('span');
    t.className = 'round-title';
    t.textContent = `Round ${r.round}`;
    const m = document.createElement('span');
    m.className = 'round-meta';
    m.textContent = `needs ${r.majority} of ${r.continuing}` + (r.exhausted ? ` · ${r.exhausted} exhausted` : '');
    head.append(t, m);
    box.appendChild(head);

    const rows = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map(x => x[1]));
    for (const [id, n] of rows) {
      const out = r.eliminated.some(e => e.id === id);
      const win = r.winner === id;

      const row = document.createElement('div');
      row.className = 'bar-row' + (out ? ' eliminated' : '') + (win ? ' winner' : '');

      const name = document.createElement('div');
      name.className = 'bar-name';
      name.textContent = r.names[id];

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill' + (win ? ' win' : out ? ' out' : '');
      fill.style.width = `${(n / max) * 100}%`;
      track.appendChild(fill);

      const val = document.createElement('div');
      val.className = 'bar-val';
      val.textContent = `${n} · ${r.continuing ? Math.round((n / r.continuing) * 100) : 0}%`;

      row.append(name, track, val);
      box.appendChild(row);
    }
    rw.appendChild(box);
  }

  // Borda
  const tb = $('bordaTable').querySelector('tbody');
  tb.innerHTML = '';
  result.borda.forEach((row, i) => {
    const tr = document.createElement('tr');
    for (const [v, cls] of [[i + 1, ''], [row.name, ''], [row.points, 'num'],
      [row.firstPlace, 'num'], [row.timesRanked, 'num'], [row.avgRank ?? '—', 'num']]) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = v;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  });

  // Ballots
  const bw = $('ballots');
  bw.innerHTML = '';
  txt($('ballotHint'), `${ballots.length} ${ballots.length === 1 ? 'person' : 'people'}`);
  if (!ballots.length) bw.innerHTML = '<p class="muted small">Nobody has started a ballot.</p>';

  const nameById = new Map(destinations.map(d => [d.id, d.name]));
  for (const b of ballots) {
    const box = document.createElement('div');
    box.className = 'ballot';

    const head = document.createElement('div');
    head.className = 'ballot-head';
    const nm = document.createElement('span');
    nm.className = 'ballot-name';
    nm.textContent = b.voter;
    const tag = document.createElement('span');
    tag.className = 'tag ' + (b.submitted ? 'tag-in' : 'tag-draft');
    tag.textContent = b.submitted ? 'submitted' : 'draft — not counted';
    head.append(nm, tag);
    box.appendChild(head);

    const order = document.createElement('div');
    order.className = 'ballot-order';
    if (!b.rankings.length) {
      order.textContent = 'Nothing ranked yet.';
    } else {
      b.rankings.forEach((id, i) => order.appendChild(chip(i + 1, nameById.get(id) || `#${id}`)));
    }
    box.appendChild(order);

    if (b.unranked.length) {
      const u = document.createElement('div');
      u.className = 'ballot-unranked';
      u.textContent = `Left off: ${b.unranked.join('; ')}`;
      box.appendChild(u);
    }
    bw.appendChild(box);
  }

  // Settings
  $('settingsClosedWarning').classList.toggle('hidden', poll.open);
  $('setTitle').value = poll.title || '';
  $('setSubtitle').value = poll.subtitle || '';
  $('setAdds').checked = !!poll.allowAdds;
  $('setCloses').value = poll.closesAt ? toLocalInput(new Date(poll.closesAt)) : '';
  $('setOpens').value = poll.opensAt ? toLocalInput(new Date(poll.opensAt)) : '';
  $('setAddsClose').value = poll.addsCloseAt ? toLocalInput(new Date(poll.addsCloseAt)) : '';
  txt($('revealState'), poll.resultsPublic
    ? 'Voters can see the round-by-round results now.'
    : poll.open
      ? 'Nothing is visible to voters yet — the poll is still open.'
      : 'The poll is closed but the results are hidden from voters.');
  txt($('addsStateNote'), poll.addsOpen
    ? 'Voters can add destinations right now.'
    : 'Nominations are closed — voters can still change their ranking.');

  // Destinations
  const dl = $('destList');
  dl.innerHTML = '';
  for (const d of destinations) {
    const row = document.createElement('div');
    row.className = 'dest-row';
    const n = document.createElement('span');
    n.className = 'd-name';
    n.textContent = d.name;
    row.appendChild(n);
    if (d.addedBy && d.addedBy !== 'organizer') {
      const by = document.createElement('span');
      by.className = 'd-by';
      by.textContent = `added by ${d.addedBy}`;
      row.appendChild(by);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ctl';
    del.dataset.action = 'del-dest';
    del.dataset.id = d.id;
    del.title = `Remove ${d.name}`;
    del.setAttribute('aria-label', `Remove ${d.name}`);
    del.textContent = '✕';
    row.appendChild(del);
    dl.appendChild(row);
  }

  txt($('reportText'), report.text);
}

// datetime-local wants local wall time, not an ISO/UTC string.
function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── load ────────────────────────────────────────────────────────────────────

async function load() {
  data = await api('/results');
  $('loadingCard').classList.add('hidden');
  $('keyCard').classList.add('hidden');
  $('dash').classList.remove('hidden');
  render();

  api('/status')
    .then(s => txt($('deliveryNote'),
      `Email: ${s.resultEmail || 'not configured'} via ${s.mailTransport || 'no transport'} · Push: ${s.pushConfigured ? 'configured' : 'not configured'}`))
    .catch(() => {});
}

function gate(msg) {
  $('loadingCard').classList.add('hidden');
  $('dash').classList.add('hidden');
  $('keyCard').classList.remove('hidden');
  if (msg) {
    $('keyError').textContent = msg;
    $('keyError').classList.remove('hidden');
  }
}

// ── actions ─────────────────────────────────────────────────────────────────

const ACTIONS = {
  close: async () => {
    if (!confirm('Close voting and send yourself the results? Voters will no longer be able to change their ballots.')) return;
    const out = await api('/close', { method: 'POST', body: { force: true } });
    toast(out.mail?.sent ? 'Closed. Results emailed.' : 'Closed. Email not configured — results are on this page.');
    await load();
  },
  send: async () => {
    const out = await api('/send-report', { method: 'POST' });
    toast(out.mail?.sent
      ? `Preview sent via ${out.mailTransport} — the poll is untouched.`
      : `Email not sent (${out.mail?.error || out.mail?.skipped || 'not configured'}).`,
    !out.mail?.sent);
  },
  reopen: async () => {
    if (!confirm('Reopen voting?')) return;
    await api('/reopen', { method: 'POST' });
    toast('Voting reopened.');
    await load();
  },
  publish: async () => {
    await api('/publish-results', { method: 'POST', body: { publish: true } });
    toast('Results are live for voters.');
    await load();
  },
  unpublish: async () => {
    await api('/publish-results', { method: 'POST', body: { publish: false } });
    toast('Results hidden from voters.');
    await load();
  },
  'del-dest': async id => {
    const d = data.destinations.find(x => x.id === id);
    if (!confirm(`Remove ${d ? d.name : 'this destination'} from the ballot? Existing rankings just skip it.`)) return;
    await api(`/destinations/${id}`, { method: 'DELETE' });
    toast('Destination removed.');
    await load();
  },
};

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const fn = ACTIONS[btn.dataset.action];
  if (!fn) return;
  e.preventDefault();
  btn.disabled = true;
  try { await fn(btn.dataset.id); }
  catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; }
});

$('keyForm').addEventListener('submit', async e => {
  e.preventDefault();
  localStorage.setItem(KEY_STORE, $('keyInput').value);
  $('keyError').classList.add('hidden');
  try { await load(); }
  catch (err) { gate(err.message); }
});

$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  // datetime-local has no timezone; new Date() reads it as local, which is what
  // the organizer meant when they typed it.
  const iso = v => (v ? new Date(v).toISOString() : null);
  try {
    await api('/settings', {
      method: 'POST',
      body: {
        title: $('setTitle').value,
        subtitle: $('setSubtitle').value,
        opensAt: iso($('setOpens').value),
        closesAt: iso($('setCloses').value),
        addsCloseAt: iso($('setAddsClose').value),
        allowAdds: $('setAdds').checked,
      },
    });
    toast('Settings saved.');
    await load();
  } catch (err) { toast(err.message, true); }
});

$('destForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/destinations', {
      method: 'POST',
      body: { name: $('destName').value, blurb: $('destBlurb').value },
    });
    $('destName').value = '';
    $('destBlurb').value = '';
    toast('Destination added.');
    await load();
  } catch (err) { toast(err.message, true); }
});

$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('resetName').value.trim();
  if (!confirm(`Delete ${name}'s ballot so they can start again? This cannot be undone.`)) return;
  try {
    await api('/reset-voter', { method: 'POST', body: { name } });
    $('resetName').value = '';
    toast('Name released.');
    await load();
  } catch (err) { toast(err.message, true); }
});

// ── boot ────────────────────────────────────────────────────────────────────

(async () => {
  if (!key()) return gate();
  try { await load(); }
  catch (err) { gate(err.status === 401 ? 'That key was rejected.' : err.message); }
})();
