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
  'rev-skip':   () => { if (rev) revSkipToEnd(); },
  'rev-replay': () => {
    if (!rev) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    playReveal();
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
// Plays the runoff as a sequence rather than a table. Each round: the counts
// tick up one destination at a time, the rows physically re-sort into the new
// standings, last place is singled out and knocked out, and its votes visibly
// land on whoever those voters ranked next. Then the finalists, then the winner.
//
// It is choreography, so it is written as one async function with awaited
// pauses instead of a frame index — the order of events is the code. A
// generation counter makes skip and replay safe: any older playthrough still
// mid-await notices it has been superseded and returns.

let rev = null;        // { data, rows: Map<id, el>, order: [] }
let revGen = 0;        // bumped on every play; stale runs bail out

const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Everything scales off one number, so the whole sequence can be slowed down,
// sped up, or (for reduced motion) collapsed to near-instant in one place.
const T = REDUCED ? 0.06 : 1;
const ms = n => n * T;
const sleep = n => new Promise(r => setTimeout(r, ms(n)));

function revAlive(gen) { return gen === revGen; }

// ── primitives ──────────────────────────────────────────────────────────────

// Counts a number upward. The bar width rides the same clock so the two never
// disagree — a bar that has finished growing under a number still climbing
// looks broken.
function countUp(id, from, to, of_, dur) {
  const row = rev.rows.get(id);
  const val = row.querySelector('.rev-val');
  const fill = row.querySelector('.rev-fill');
  if (REDUCED || from === to) {
    val.textContent = to;
    fill.style.width = of_ ? `${(to / of_) * 100}%` : '0%';
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const t0 = performance.now();
    const step = now => {
      const p = Math.min(1, (now - t0) / ms(dur));
      const eased = 1 - Math.pow(1 - p, 3);
      const n = from + (to - from) * eased;
      val.textContent = Math.round(n);
      fill.style.width = of_ ? `${(n / of_) * 100}%` : '0%';
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// FLIP: measure where every row is, reorder the DOM, then animate each row from
// where it used to be to where it now is. Without this the list would jump and
// nobody could follow a destination climbing the standings — which is the whole
// thing worth watching.
function sortRows(order, gen) {
  const wrap = $('revBars');
  const before = new Map();
  for (const [id, el] of rev.rows) before.set(id, el.getBoundingClientRect().top);

  order.forEach(id => wrap.appendChild(rev.rows.get(id)));
  rev.order = order;

  if (REDUCED) return Promise.resolve();

  let moved = false;
  for (const [id, el] of rev.rows) {
    const dy = before.get(id) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    moved = true;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
  }
  if (!moved) return Promise.resolve();

  return new Promise(resolve => {
    requestAnimationFrame(() => {
      if (!revAlive(gen)) return resolve();
      for (const el of rev.rows.values()) {
        el.style.transition = `transform ${ms(620)}ms cubic-bezier(.22,.9,.3,1)`;
        el.style.transform = '';
      }
      setTimeout(resolve, ms(640));
    });
  });
}

function setCaption(text) {
  const el = $('revCaption');
  el.classList.remove('pop');
  void el.offsetWidth;          // restart the animation
  el.textContent = text;
  el.classList.add('pop');
}

function rankBadges() {
  rev.order.forEach((id, i) => {
    const b = rev.rows.get(id)?.querySelector('.rev-rank');
    if (b) b.textContent = rev.rows.get(id).classList.contains('gone') ? '' : i + 1;
  });
}

// ── the playthrough ─────────────────────────────────────────────────────────

async function playReveal() {
  const gen = ++revGen;
  const d = rev.data;

  $('revWinnerCard').classList.add('hidden');
  $('revSkip').classList.remove('hidden');
  // Reset the header before the opening re-sort, not after it — on a replay the
  // old round number would otherwise sit there for most of a second.
  $('revRoundLabel').textContent = 'Round 1';
  $('revMeta').textContent = '';
  setCaption('Counting the first choices…');

  // Reset every row to zero and back into the starting order.
  const startOrder = Object.keys(d.rounds[0].counts);
  for (const el of rev.rows.values()) {
    el.className = 'rev-row';
    el.style.transform = '';
    el.style.transition = '';
    el.querySelector('.rev-val').textContent = '0';
    el.querySelector('.rev-fill').style.width = '0%';
    el.querySelector('.rev-fill').className = 'rev-fill';
    el.querySelector('.rev-rank').textContent = '';
  }
  await sortRows(startOrder, gen);
  if (!revAlive(gen)) return;

  let prev = {};
  for (let i = 0; i < d.rounds.length; i++) {
    const r = d.rounds[i];
    $('revRoundLabel').textContent = `Round ${r.round}`;
    $('revMeta').textContent =
      `${r.continuing} ${r.continuing === 1 ? 'ballot' : 'ballots'} in play · ${r.majority} to win`;

    if (i === 0) {
      setCaption('First-choice votes, coming in…');
      // One at a time, so each number lands on its own instead of six moving at
      // once and nothing being readable.
      for (const id of rev.order) {
        if (!revAlive(gen)) return;
        rev.rows.get(id).classList.add('landing');
        await countUp(id, 0, r.counts[id], r.continuing, 620);
        rev.rows.get(id).classList.remove('landing');
        await sleep(160);
      }
    } else {
      // Later rounds: only the numbers that actually changed move, and they
      // move one after another so you can see where the votes went.
      const gainers = rev.order.filter(id => r.counts[id] !== undefined && r.counts[id] > (prev[id] ?? 0));
      const same = rev.order.filter(id => r.counts[id] !== undefined && !gainers.includes(id));
      for (const id of same) {
        rev.rows.get(id).querySelector('.rev-val').textContent = r.counts[id];
        rev.rows.get(id).querySelector('.rev-fill').style.width =
          r.continuing ? `${(r.counts[id] / r.continuing) * 100}%` : '0%';
      }
      for (const id of gainers) {
        if (!revAlive(gen)) return;
        const row = rev.rows.get(id);
        row.querySelector('.rev-fill').classList.add('gain');
        row.classList.add('landing');
        await countUp(id, prev[id] ?? 0, r.counts[id], r.continuing, 700);
        row.classList.remove('landing');
        await sleep(220);
        row.querySelector('.rev-fill').classList.remove('gain');
      }
    }
    if (!revAlive(gen)) return;

    // Re-rank on the new numbers.
    await sleep(240);
    const ranked = [...rev.order]
      .filter(id => r.counts[id] !== undefined)
      .sort((a, b) => r.counts[b] - r.counts[a]);
    const dead = rev.order.filter(id => r.counts[id] === undefined);
    await sortRows([...ranked, ...dead], gen);
    rankBadges();
    if (!revAlive(gen)) return;

    // Did anyone clear the bar?
    if (r.winner) {
      await revFinale(r, gen);
      return;
    }

    setCaption(i === 0
      ? `Nothing has ${r.majority} of ${r.continuing} yet, so the last place goes out.`
      : `Still nothing at ${r.majority}. Last place goes out again.`);
    await sleep(1100);
    if (!revAlive(gen)) return;

    // Single out last place, then knock it out.
    if (r.eliminated.length) {
      const outIds = r.eliminated.map(e => e.id);
      for (const id of outIds) rev.rows.get(id).classList.add('doomed');
      const names = r.eliminated.map(e => e.name);
      const votes = r.eliminated.reduce((a, e) => a + e.votes, 0);
      setCaption(names.length === 1
        ? `${names[0]} is last on ${r.eliminated[0].votes} — it's out.`
        : `${names.join(' and ')} are out — together they had ${votes}, too few to catch anyone.`);
      await sleep(1500);
      if (!revAlive(gen)) return;

      for (const id of outIds) {
        rev.rows.get(id).classList.remove('doomed');
        rev.rows.get(id).classList.add('out');
      }
      setCaption(votes
        ? `Those ${votes} ${votes === 1 ? 'ballot moves' : 'ballots move'} to whoever those voters ranked next.`
        : 'Nobody had it first, so no votes move.');
      await sleep(1400);
      if (!revAlive(gen)) return;

      for (const id of outIds) rev.rows.get(id).classList.add('gone');
      rankBadges();
      await sleep(500);
    }

    prev = { ...r.counts };
    if (!revAlive(gen)) return;
  }
}

// The last beat: dim everything but the survivors, hold, then the winner.
async function revFinale(r, gen) {
  const d = rev.data;
  const finalists = [...rev.order].filter(id => r.counts[id] !== undefined);

  for (const id of finalists) rev.rows.get(id).classList.add('finalist');
  setCaption(finalists.length > 1
    ? `Down to ${finalists.map(id => r.names[id]).join(' and ')}.`
    : 'One left standing.');
  await sleep(1500);
  if (!revAlive(gen)) return;

  for (const id of finalists) {
    rev.rows.get(id).classList.remove('finalist');
    if (id !== r.winner) rev.rows.get(id).classList.add('dim');
  }
  const wRow = rev.rows.get(r.winner);
  wRow.classList.add('win');
  wRow.querySelector('.rev-fill').classList.add('win');
  setCaption(`${r.names[r.winner]} has ${r.counts[r.winner]} of ${r.continuing} — a majority. That's the trip.`);
  await sleep(1400);
  if (!revAlive(gen)) return;

  revShowWinner(d);
}

function revShowWinner(d) {
  $('revSkip').classList.add('hidden');
  const card = $('revWinnerCard');

  if (!d.winner) {
    $('revWinnerName').textContent = 'No winner';
    $('revWinnerSub').textContent = 'No ballots were submitted.';
    card.classList.remove('hidden');
    return;
  }
  $('revWinnerName').textContent = d.winner.name;
  $('revWinnerSub').textContent =
    `${d.winner.votes} of ${d.winner.of} ballots · decided in round ${d.rounds.length}`;
  const dest = d.destinations.find(x => x.id === d.winner.id);
  $('revWinnerBlurb').textContent = dest?.blurb || '';

  const flags = $('revFlags');
  flags.innerHTML = '';
  if (d.tie) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = `It finished level between ${d.tiedAmong.map(t => t.name).join(' and ')}. ` +
      'The tie broke on overall ranking points, not a coin flip.';
    flags.appendChild(p);
  }
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
}

// Jump straight to the finished state without playing anything.
function revSkipToEnd() {
  revGen++;                       // strand any in-flight playthrough
  const d = rev.data;
  const last = d.rounds[d.rounds.length - 1];

  $('revRoundLabel').textContent = `Round ${last.round}`;
  $('revMeta').textContent =
    `${last.continuing} ${last.continuing === 1 ? 'ballot' : 'ballots'} in play · ${last.majority} to win`;

  const ranked = Object.keys(last.counts).sort((a, b) => last.counts[b] - last.counts[a]);
  const dead = [...rev.rows.keys()].filter(id => last.counts[id] === undefined);
  for (const [id, el] of rev.rows) {
    el.style.transition = 'none';
    el.style.transform = '';
    const n = last.counts[id];
    if (n === undefined) { el.className = 'rev-row gone'; continue; }
    el.className = 'rev-row' + (id === last.winner ? ' win' : ' dim');
    el.querySelector('.rev-val').textContent = n;
    const fill = el.querySelector('.rev-fill');
    fill.className = 'rev-fill' + (id === last.winner ? ' win' : '');
    fill.style.width = last.continuing ? `${(n / last.continuing) * 100}%` : '0%';
  }
  const wrap = $('revBars');
  [...ranked, ...dead].forEach(id => wrap.appendChild(rev.rows.get(id)));
  rev.order = [...ranked, ...dead];
  rankBadges();
  setCaption(last.winner
    ? `${last.names[last.winner]} has ${last.counts[last.winner]} of ${last.continuing} — a majority.`
    : 'No winner.');
  revShowWinner(d);
}

async function loadResults() {
  const data = await api('/results');
  rev = { data, rows: new Map(), order: [] };

  $('pollTitle').textContent = data.title || 'Where are we going?';
  $('pollSubtitle').textContent = 'The votes are in. This is how it played out.';
  $('deadlinePill').classList.add('hidden');
  $('addsPill').classList.add('hidden');
  $('votedPill').textContent =
    `${data.countedBallots} ${data.countedBallots === 1 ? 'ballot' : 'ballots'} counted`;

  const first = data.rounds[0];
  const wrap = $('revBars');
  wrap.innerHTML = '';
  for (const id of Object.keys(first.counts)) {
    const row = document.createElement('div');
    row.className = 'rev-row';
    row.innerHTML = `<div class="rev-rank"></div>
      <div class="rev-name"></div>
      <div class="rev-track"><div class="rev-fill"></div></div>
      <div class="rev-val">0</div>`;
    row.querySelector('.rev-name').textContent = first.names[id];
    wrap.appendChild(row);
    rev.rows.set(id, row);
  }

  $('revFoot').textContent = data.closedAt ? `Voting closed ${fmtWhen(new Date(data.closedAt))}.` : '';
  show('resultsCard');
  playReveal();
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
