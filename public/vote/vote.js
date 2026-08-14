// Voter-facing ballot.
//
// State lives in three places: `poll` (server truth about the poll), `ranked`
// (this voter's working order — every destination, always) and localStorage
// (the ballot token, which is what actually proves the ballot is theirs).
//
// Every reorder autosaves as a draft. "Submit" only flips the submitted flag —
// so a half-finished ballot is never counted, but nobody loses work either.

const TOKEN_KEY = 'tripVote.token';
const NAME_KEY  = 'tripVote.name';

const $ = id => document.getElementById(id);

let poll = null;
let dests = new Map();        // id -> destination
let ranked = [];              // ordered ids — every destination, always
let submitted = false;
let hasPin = false;
let saveTimer = null;
let lastSavedJSON = null;

// ── plumbing ────────────────────────────────────────────────────────────────

const token = () => localStorage.getItem(TOKEN_KEY);

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const t = token();
  if (t) headers['X-Ballot-Token'] = t;

  const r = await fetch(`/vote/api${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || `Request failed (${r.status})`);
    err.code = data.code;
    err.status = r.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function showError(id, msg) {
  const el = $(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(id) { $(id).classList.add('hidden'); }

function show(...ids) {
  for (const id of ['loadingCard', 'nameCard', 'closedCard', 'nominateCard', 'ballotCard', 'resultsCard']) {
    $(id).classList.toggle('hidden', !ids.includes(id));
  }
}

// Fisher-Yates. New ballots start in a random order so the list's own ordering
// doesn't nudge everyone toward whatever happens to sit at the top.
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── loading ─────────────────────────────────────────────────────────────────

async function loadPoll() {
  poll = await api('/poll');
  dests = new Map(poll.destinations.map(d => [d.id, d]));

  $('pollTitle').textContent = poll.title || 'Where are we going?';
  document.title = `${poll.title || 'Where are we going?'} — rank your destinations`;
  $('pollSubtitle').textContent = poll.subtitle || (poll.phase !== 'nominate'
    ? 'Drag the destinations into the order you want them. First place at the top.'
    : poll.allowAdds
      ? 'First we build the list. Add anywhere you\'d want to go — ranking comes later.'
      : 'Suggestions are in and the list is being tidied up. Ranking opens shortly.');

  renderDeadline();
  renderVotedPill();

  // In the nomination phase the ballot's own add-a-destination card is
  // redundant — the whole page is that form.
  $('addCard').classList.toggle('hidden', !poll.allowAdds || !poll.open || poll.phase !== 'vote');
  if (poll.allowAdds && poll.addsCloseAt) {
    $('addDeadlineNote').textContent =
      `Add it and everyone — including people who already voted — will see it on their ballot. ` +
      `New destinations close ${fmtWhen(new Date(poll.addsCloseAt))}.`;
  }
}

function fmtWhen(d) {
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function renderDeadline() {
  const pill = $('deadlinePill');

  // Before voting opens the useful countdown is to the opening, not the close —
  // that is the moment everyone has to come back for.
  if (poll.phase === 'nominate' && poll.opensAt) {
    const opens = new Date(poll.opensAt);
    const h = Math.round((opens - Date.now()) / 3600000);
    pill.textContent = `Voting opens ${fmtWhen(opens)}`;
    pill.classList.toggle('urgent', h <= 12);
    pill.classList.remove('hidden');
    $('addsPill').classList.add('hidden');
    return;
  }

  if (!poll.closesAt) { pill.classList.add('hidden'); return; }

  const closes = new Date(poll.closesAt);
  const msLeft = closes - Date.now();
  pill.classList.remove('hidden');

  if (msLeft <= 0) {
    pill.textContent = 'Voting closed';
    pill.classList.add('urgent');
  } else {
    const hours = Math.round(msLeft / 3600000);
    pill.textContent = hours <= 48
      ? `Voting closes ${fmtWhen(closes)} · ${hours}h left`
      : `Voting closes ${fmtWhen(closes)}`;
    pill.classList.toggle('urgent', hours <= 24);
  }

  // Second pill for the nomination deadline, but only while it is still ahead —
  // once it passes it is noise, and the add card is gone anyway.
  const ap = $('addsPill');
  const addsLeft = poll.addsCloseAt ? new Date(poll.addsCloseAt) - Date.now() : -1;
  if (addsLeft > 0) {
    const h = Math.round(addsLeft / 3600000);
    ap.textContent = `Add destinations until ${fmtWhen(new Date(poll.addsCloseAt))}`;
    ap.classList.toggle('urgent', h <= 12);
    ap.classList.remove('hidden');
  } else {
    ap.classList.add('hidden');
    // On a page left open across the nomination deadline, retire the add form
    // too — the server would reject the submission anyway.
    if (poll.addsCloseAt) $('addCard').classList.add('hidden');
  }
}

function renderVotedPill() {
  const pill = $('votedPill');
  if (poll.phase === 'nominate') {
    const n = poll.destinationCount ?? 0;
    pill.textContent = `${n} ${n === 1 ? 'destination' : 'destinations'} in the running`;
    return;
  }
  const n = poll.voted.length;
  pill.textContent = n === 0
    ? 'No ballots in yet'
    : `${n} ${n === 1 ? 'ballot' : 'ballots'} in · ${poll.voted.join(', ')}`;
}

// ── ballot state ────────────────────────────────────────────────────────────

// Reconciles a stored ballot against the current destination list: keeps the
// voter's order, discards anything the organizer removed, and surfaces anything
// added since they last looked.
function seatBallot(savedRankings) {
  const all = poll.destinations.map(d => d.id);
  const saved = (savedRankings || []).map(String).filter(id => dests.has(id));

  if (!saved.length) {
    ranked = shuffled(all);
    return [];
  }

  const known = new Set(saved);
  const fresh = all.filter(id => !known.has(id));

  // Every destination sits on every ballot, so anything added since this voter
  // last looked joins at the bottom — keeping their existing order intact — and
  // they're told about it. This also heals a ballot submitted before a
  // destination existed, which is why partial rankings still arrive here.
  ranked = [...saved, ...fresh];
  return fresh;
}

function renderNewDestNote(fresh) {
  const el = $('newDestNote');
  if (!fresh.length) { el.classList.add('hidden'); return; }
  const names = fresh.map(id => dests.get(id).name).join(', ');
  el.textContent = fresh.length === 1
    ? `${names} was added since you last voted — it's at the bottom of your list. Move it if you'd rank it higher.`
    : `${fresh.length} destinations were added since you last voted (${names}). They're at the bottom of your list.`;
  el.classList.remove('hidden');
}

// ── rendering ───────────────────────────────────────────────────────────────

function render() {
  const list = $('rankList');
  list.innerHTML = '';

  ranked.forEach((id, i) => {
    const d = dests.get(id);
    if (!d) return;
    const li = document.createElement('li');
    li.className = 'rank-item';
    li.dataset.id = id;
    li.draggable = true;
    li.innerHTML = `
      <div class="rank-num">${i + 1}</div>
      <div class="rank-body">
        <div class="rank-name"></div>
        ${d.blurb ? '<div class="rank-blurb"></div>' : ''}
        ${d.addedBy && d.addedBy !== 'organizer' ? '<div class="rank-added"></div>' : ''}
      </div>
      <div class="rank-ctl">
        <button type="button" class="ctl" data-action="up" data-id="${id}"
                aria-label="Move ${escapeAttr(d.name)} up" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button type="button" class="ctl" data-action="down" data-id="${id}"
                aria-label="Move ${escapeAttr(d.name)} down" ${i === ranked.length - 1 ? 'disabled' : ''}>▼</button>
      </div>`;
    // textContent, not innerHTML — destination names are user-supplied.
    li.querySelector('.rank-name').textContent = d.name;
    if (d.blurb) li.querySelector('.rank-blurb').textContent = d.blurb;
    const added = li.querySelector('.rank-added');
    if (added) added.textContent = `added by ${d.addedBy}`;
    list.appendChild(li);
  });

  $('pinStatus').textContent = hasPin
    ? 'PIN set — you can open this ballot on another device with your name and PIN.'
    : 'Without a PIN this ballot only opens on this device.';
  $('pinToggleBtn').textContent = hasPin ? 'Change PIN' : 'Add a PIN';

  const btn = $('submitBtn');
  btn.textContent = submitted ? 'Ballot submitted ✓' : 'Submit my ballot';
  btn.classList.toggle('btn-done', submitted);
  btn.disabled = ranked.length === 0;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── saving ──────────────────────────────────────────────────────────────────

function queueSave(immediate = false) {
  clearTimeout(saveTimer);
  if (immediate) return saveNow();
  $('saveState').textContent = 'Saving…';
  saveTimer = setTimeout(saveNow, 700);
  return Promise.resolve();
}

async function saveNow() {
  const payload = { rankings: ranked, submitted };
  const json = JSON.stringify(payload);
  if (json === lastSavedJSON) { $('saveState').textContent = savedLabel(); return; }
  try {
    await api('/ballot', { method: 'PUT', body: payload });
    lastSavedJSON = json;
    $('saveState').textContent = savedLabel();
  } catch (err) {
    $('saveState').textContent = '';
    if (err.code === 'POLL_CLOSED') { toast('Voting just closed — your last saved ballot stands.', true); return refresh(); }
    if (err.status === 401) {
      // This ballot was reopened on another device, which retires this token.
      localStorage.removeItem(TOKEN_KEY);
      toast('This ballot was opened on another device. Sign back in to keep editing.', true);
      setTimeout(() => location.reload(), 2200);
      return;
    }
    toast(err.message, true);
  }
}

function savedLabel() {
  return submitted ? 'Submitted — you can still change it' : 'Draft saved';
}

// ── actions ─────────────────────────────────────────────────────────────────

function move(id, delta) {
  const i = ranked.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ranked.length) return;
  [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
  render();
  queueSave();
}

const ACTIONS = {
  up:     id => move(id, -1),
  down:   id => move(id, +1),
  'rev-next': () => { if (rev && rev.i < rev.frames.length - 1) { rev.i++; revRender(); } },
  'rev-skip': () => {
    if (!rev) return;
    // Jump straight to the final counts, keeping prev empty so nothing flashes
    // as a "gain" it didn't earn on screen.
    rev.i = rev.frames.length - 1;
    rev.prev = {};
    revRender();
  },
  'rev-replay': () => {
    if (!rev) return;
    rev.i = 0;
    rev.prev = {};
    $('revWinnerCard').classList.add('hidden');
    revRender();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  'pin-toggle': () => {
    const f = $('pinSetForm');
    f.classList.toggle('hidden');
    if (!f.classList.contains('hidden')) $('pinSetInput').focus();
  },
  submit: async () => {
    if (!ranked.length) return toast('Rank at least one destination first.', true);
    submitted = true;
    await queueSave(true);
    render();
    toast('Ballot submitted. Thanks!');
    await refresh();
  },
  switch: () => {
    if (!confirm('This clears the ballot from this device. Your vote stays saved — you just need the organizer to release your name to start over. Continue?')) return;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(NAME_KEY);
    location.reload();
  },
};

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const fn = ACTIONS[btn.dataset.action];
  if (fn) { e.preventDefault(); fn(btn.dataset.id); }
});

// ── drag and drop (desktop; the ▲▼ buttons cover touch and keyboard) ────────

let dragId = null;

document.addEventListener('dragstart', e => {
  const item = e.target.closest('.rank-item');
  if (!item) return;
  dragId = item.dataset.id;
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});

document.addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.rank-item').forEach(el =>
    el.classList.remove('dragging', 'drop-target'));
});

document.addEventListener('dragover', e => {
  const item = e.target.closest('.rank-item');
  if (!item || !dragId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.rank-item').forEach(el => el.classList.remove('drop-target'));
  if (item.dataset.id !== dragId) item.classList.add('drop-target');
});

document.addEventListener('drop', e => {
  const item = e.target.closest('.rank-item');
  if (!item || !dragId) return;
  e.preventDefault();
  const targetId = item.dataset.id;
  if (targetId === dragId) return;
  const from = ranked.indexOf(dragId);
  const to   = ranked.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ranked.splice(from, 1);
  ranked.splice(to, 0, dragId);
  dragId = null;
  render();
  queueSave();
});

// ── forms ───────────────────────────────────────────────────────────────────

// The one PIN field does double duty: on a new name it sets the PIN, on a name
// that already has one it unlocks the existing ballot. That keeps the screen
// every voter has to get through down to two fields.
function askForPin(msg) {
  $('pinLabel').innerHTML = '4-digit PIN';
  $('pinHelp').textContent = 'The PIN you chose when you started your ballot.';
  $('nameSubmit').textContent = 'Open my ballot';
  $('pinInput').focus();
  if (msg) showError('nameError', msg);
}

$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('nameError');
  const name = $('nameInput').value.trim();
  const pin  = $('pinInput').value.trim();
  if (name.length < 2) return showError('nameError', 'Enter your name.');
  if (pin && !/^\d{4}$/.test(pin)) return showError('nameError', 'A PIN must be exactly 4 digits.');

  const btn = $('nameSubmit');
  btn.disabled = true;
  try {
    const res = await api('/claim', { method: 'POST', body: { name, pin } });
    if (res.token) localStorage.setItem(TOKEN_KEY, res.token);
    localStorage.setItem(NAME_KEY, res.voter);
    await startBallot(res);
    if (res.recovered) toast('Welcome back — your ranking is exactly as you left it.');
  } catch (err) {
    // A ballot exists and is PIN-protected: switch the form into unlock mode
    // rather than showing a dead end.
    if (err.code === 'PIN_REQUIRED') askForPin(err.message);
    else if (err.code === 'PIN_WRONG' || err.code === 'PIN_LOCKED') showError('nameError', err.message);
    else showError('nameError', err.message);
  } finally {
    btn.disabled = false;
  }
});

$('pinSetForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('pinSetError');
  const pin = $('pinSetInput').value.trim();
  if (!/^\d{4}$/.test(pin)) return showError('pinSetError', 'A PIN must be exactly 4 digits.');
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('/pin', { method: 'PUT', body: { pin } });
    hasPin = true;
    $('pinSetInput').value = '';
    $('pinSetForm').classList.add('hidden');
    render();
    toast('PIN saved. Your name plus that PIN reopens this ballot anywhere.');
  } catch (err) {
    showError('pinSetError', err.message);
  } finally {
    btn.disabled = false;
  }
});

$('nomForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('nomError');
  const name = $('nomName').value.trim();
  const blurb = $('nomBlurb').value.trim();
  if (name.length < 3) return showError('nomError', 'Give the city and country.');

  const btn = $('nomSubmit');
  btn.disabled = true;
  try {
    const res = await api('/destinations', { method: 'POST', body: { name, blurb } });
    $('nomName').value = '';
    $('nomBlurb').value = '';
    await loadPoll();
    renderNominate(localStorage.getItem(NAME_KEY) || '', res.myDestinations || []);
    toast(res.remaining > 0
      ? `${res.destination.name} added. ${res.remaining} suggestion${res.remaining === 1 ? '' : 's'} left.`
      : `${res.destination.name} added — that's both of yours in.`);
  } catch (err) {
    showError('nomError', err.message);
    // The phase can flip while the page sits open; re-route rather than
    // leaving them typing into a form the server will keep refusing.
    if (err.code === 'VOTING_NOT_OPEN' || err.code === 'ADDS_LOCKED' || err.code === 'POLL_CLOSED') {
      setTimeout(() => location.reload(), 2000);
    }
  } finally {
    btn.disabled = false;
  }
});

$('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  clearError('addError');
  const name = $('addName').value.trim();
  const blurb = $('addBlurb').value.trim();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await api('/destinations', { method: 'POST', body: { name, blurb } });
    $('addName').value = '';
    $('addBlurb').value = '';
    $('addDetails').open = false;

    await loadPoll();
    ranked.push(res.destination.id);
    render();
    await queueSave(true);
    toast(`${res.destination.name} added — it's at the bottom of your list.`);
  } catch (err) {
    showError('addError', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ── results reveal ──────────────────────────────────────────────────────────
//
// Walks the runoff one beat at a time so the mechanism is visible: show the
// round's counts, mark who came last, then let their votes visibly slide into
// the bars of everyone still standing. Counts only — no ballots, ever.

let rev = null;      // { data, frames, i, rows: Map, prev: {} }

function revBuildFrames(rounds) {
  const frames = [];
  for (const r of rounds) {
    frames.push({ kind: 'counts', r });
    if (r.eliminated.length) frames.push({ kind: 'out', r });
  }
  return frames;
}

async function loadResults() {
  const data = await api('/results');
  rev = {
    data,
    frames: revBuildFrames(data.rounds),
    i: 0,
    rows: new Map(),
    prev: {},
  };

  $('pollTitle').textContent = data.title || 'Where are we going?';
  $('pollSubtitle').textContent = 'The votes are in. This is how it played out.';
  $('deadlinePill').classList.add('hidden');
  $('addsPill').classList.add('hidden');
  $('votedPill').textContent =
    `${data.countedBallots} ${data.countedBallots === 1 ? 'ballot' : 'ballots'} counted`;

  // One row per destination that started the runoff, in a fixed order so a bar
  // the eye is following never jumps position between rounds.
  const first = data.rounds[0];
  const order = Object.entries(first.counts).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const wrap = $('revBars');
  wrap.innerHTML = '';
  for (const id of order) {
    const row = document.createElement('div');
    row.className = 'rev-row';
    row.innerHTML = `<div class="rev-name"></div>
      <div class="rev-track"><div class="rev-fill"></div></div>
      <div class="rev-val">0</div>`;
    row.querySelector('.rev-name').textContent = first.names[id];
    wrap.appendChild(row);
    rev.rows.set(id, row);
  }

  $('revFoot').textContent = data.closedAt
    ? `Voting closed ${fmtWhen(new Date(data.closedAt))}.`
    : '';
  $('revWinnerCard').classList.add('hidden');
  revRender();
  show('resultsCard');
}

function revRender() {
  const f = rev.frames[rev.i];
  const r = f.r;
  const outIds = f.kind === 'out' ? r.eliminated.map(e => e.id) : [];
  const live = new Set(Object.keys(r.counts));

  $('revRoundLabel').textContent = `Round ${r.round}`;
  $('revMeta').textContent =
    `${r.continuing} ${r.continuing === 1 ? 'ballot' : 'ballots'} in play · ` +
    `${r.majority} needed to win` + (r.exhausted ? ` · ${r.exhausted} exhausted` : '');

  for (const [id, row] of rev.rows) {
    const n = r.counts[id];
    const fill = row.querySelector('.rev-fill');
    const val = row.querySelector('.rev-val');

    if (!live.has(id)) { row.className = 'rev-row gone'; continue; }

    const isOut = outIds.includes(id);
    const isWin = r.winner === id && f.kind === 'counts';
    // Only flash gold for a bar that actually grew this beat — that's the
    // transfer landing, and it's the thing people don't believe until they see.
    const gained = f.kind === 'counts' && rev.prev[id] !== undefined && n > rev.prev[id];

    row.className = 'rev-row' + (isOut ? ' out' : '') + (isWin ? ' win' : '');
    fill.className = 'rev-fill' + (isWin ? ' win' : isOut ? ' out' : gained ? ' gain' : '');
    fill.style.width = r.continuing ? `${(n / r.continuing) * 100}%` : '0%';
    val.textContent = n;
  }
  if (f.kind === 'counts') rev.prev = { ...r.counts };

  // Caption
  const cap = $('revCaption');
  if (f.kind === 'out') {
    const names = r.eliminated.map(e => e.name);
    const votes = r.eliminated.reduce((a, e) => a + e.votes, 0);
    cap.textContent = names.length === 1
      ? `${names[0]} finished last on ${r.eliminated[0].votes} ${r.eliminated[0].votes === 1 ? 'vote' : 'votes'} and is out. ` +
        (votes ? 'Those ballots now move to each of those voters\' next choice.' : 'Nobody had it first, so no votes move.')
      : `${names.join(', ')} are all out — together they had ${votes}, fewer than the next place up, so none of them could catch it. ` +
        (votes ? 'Their ballots move to each voter\'s next choice.' : 'No votes move.');
  } else if (r.winner) {
    const w = r.counts[r.winner];
    cap.textContent = `${r.names[r.winner]} has ${w} of ${r.continuing} — past ${r.majority}, so it's a majority. That's the trip.`;
  } else if (r.round === 1) {
    cap.textContent = `First choices only. ${r.majority} of ${r.continuing} would be a majority — nothing is there yet, so the runoff starts.`;
  } else {
    cap.textContent = `Votes redistributed. Still nothing at ${r.majority}, so the last place goes out next.`;
  }

  const last = rev.i >= rev.frames.length - 1;
  $('revNext').classList.toggle('hidden', last);
  $('revSkip').classList.toggle('hidden', last);
  $('revNext').textContent = rev.frames[rev.i + 1]?.kind === 'out' ? 'Who\'s out?' : 'Next round';

  if (last) revShowWinner();
}

function revShowWinner() {
  const d = rev.data;
  const card = $('revWinnerCard');
  if (!d.winner) {
    $('revWinnerName').textContent = 'No winner';
    $('revWinnerSub').textContent = 'No ballots were submitted.';
    card.classList.remove('hidden');
    return;
  }
  $('revWinnerName').textContent = d.winner.name;
  $('revWinnerSub').textContent =
    `${d.winner.votes} of ${d.winner.of} ballots in round ${d.rounds.length}`;
  const dest = d.destinations.find(x => x.id === d.winner.id);
  $('revWinnerBlurb').textContent = dest?.blurb || '';

  const flags = $('revFlags');
  flags.innerHTML = '';
  if (d.tie) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = `It ended level between ${d.tiedAmong.map(t => t.name).join('; ')}. ` +
      `The tie was broken on overall ranking points, not a coin flip.`;
    flags.appendChild(p);
  }
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── boot ────────────────────────────────────────────────────────────────────

async function startBallot(ballot) {
  // Nomination phase: no ranking UI at all, just the suggestion form.
  if (poll.phase === 'nominate') {
    localStorage.setItem(NAME_KEY, ballot.voter);
    hasPin = !!ballot.hasPin;
    renderNominate(ballot.voter, ballot.myDestinations || []);
    show('nominateCard');
    return;
  }

  $('voterName').textContent = ballot.voter;
  submitted = !!ballot.submitted;
  hasPin = !!ballot.hasPin;
  const fresh = seatBallot(ballot.rankings);
  lastSavedJSON = JSON.stringify({ rankings: ballot.rankings || [], submitted });
  render();
  renderNewDestNote(fresh);
  $('saveState').textContent = submitted ? savedLabel() : '';
  show('ballotCard');

  // A brand-new ballot starts shuffled; persist that order so a refresh doesn't
  // reshuffle underneath them.
  if (!(ballot.rankings || []).length) queueSave();
}

async function refresh() {
  await loadPoll();
  if (!poll.open) return showClosed();
}

// A closed poll either reveals the runoff or just says it's over, depending on
// whether the organizer has let the results out.
async function showClosed() {
  if (poll.resultsPublic) {
    try { await loadResults(); return; }
    catch { /* fall through to the plain closed card */ }
  }
  show('closedCard');
}

// ── nomination phase ────────────────────────────────────────────────────────

function renderNominate(voter, mine) {
  $('nomVoterName').textContent = voter;

  const max = poll.maxAddsPerVoter || 2;
  const left = Math.max(0, max - mine.length);

  // Three states here, and the middle one is easy to miss: suggestions can shut
  // before voting opens, leaving a grace window for the organizer to prune
  // duplicates. Showing the form then would invite a submission the server is
  // certain to reject.
  const suggestionsShut = !poll.allowAdds;
  const showForm = !suggestionsShut && left > 0;

  $('nomRemaining').textContent = suggestionsShut ? 'Suggestions closed' : `${left} of ${max} left`;
  $('nomForm').classList.toggle('hidden', !showForm);
  $('nomDone').classList.toggle('hidden', showForm);

  if (suggestionsShut) {
    $('nomDone').textContent = poll.opensAt
      ? `Suggestions are closed. The list is being tidied up — voting opens ${fmtWhen(new Date(poll.opensAt))}, and you'll rank the finished list then.`
      : 'Suggestions are closed. Voting opens shortly.';
    $('nomIntro').textContent =
      "That's everyone's ideas in. Nothing to do right now — come back when voting opens.";
  } else if (left === 0) {
    $('nomDone').textContent =
      `You've added your ${max}: ${mine.map(d => d.name).join(' and ')}. ` +
      `That's the limit — come back when voting opens to rank the full list.`;
  }

  // Only ever this voter's own — the rest of the field stays hidden until
  // voting opens.
  $('mineCard').classList.toggle('hidden', mine.length === 0);
  $('nomCount').textContent = `${mine.length} of ${max}`;
  const list = $('nomList');
  list.innerHTML = '';
  for (const d of mine) {
    const li = document.createElement('li');
    li.className = 'sugg-item mine';
    li.innerHTML = `<div class="sugg-name"></div>${d.blurb ? '<div class="sugg-blurb"></div>' : ''}`;
    li.querySelector('.sugg-name').textContent = d.name;
    if (d.blurb) li.querySelector('.sugg-blurb').textContent = d.blurb;
    list.appendChild(li);
  }

  $('nomHeading').textContent = suggestionsShut ? 'Suggestions are in' : 'Where should we go?';
  $('nomFoot').textContent = poll.opensAt
    ? `Voting opens ${fmtWhen(new Date(poll.opensAt))}. That's when you'll see the full list and rank it.`
    : 'Voting opens once the organizer closes suggestions.';
}

async function boot() {
  try {
    await loadPoll();
  } catch (err) {
    show('loadingCard');
    $('loadingCard').innerHTML = `<h2>Can't load the ballot</h2>
      <p class="muted small" style="margin-top:8px"></p>`;
    $('loadingCard').querySelector('p').textContent = err.message;
    return;
  }

  if (token()) {
    try {
      const ballot = await api('/ballot');
      if (!poll.open) return showClosed();
      await startBallot(ballot);
      return;
    } catch {
      // Token no longer resolves (poll reset, name released) — fall through to
      // the name gate rather than stranding them on a broken ballot.
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  if (!poll.open) return showClosed();

  if (poll.phase === 'nominate') {
    $('nameCardTitle').textContent = "Who's suggesting?";
    $('nameCardIntro').textContent =
      'Your name goes next to anything you add, so everyone can see who suggested what.';
  }

  const remembered = localStorage.getItem(NAME_KEY);
  if (remembered) $('nameInput').value = remembered;
  show('nameCard');
  $('nameInput').focus();
}

// Deadline text goes stale on a page left open — refresh the countdown.
setInterval(() => { if (poll) renderDeadline(); }, 60_000);

boot();
