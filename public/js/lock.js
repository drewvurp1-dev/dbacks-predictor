// Share-mode edit lock for the Record + Grade & Learn tabs.
//
// Goal: let the owner share Snake Savant with other people (view freely) while
// preventing viewers from messing with the bet record / grading data. The owner
// sets a PIN once; mutating actions on the Record and Grade tabs are then gated
// behind that PIN. Enforcement is centralized in app.js's _dispatchAction, which
// blocks any action listed in PROTECTED_ACTIONS while locked.
//
// Scope of protection: this is casual tamper-resistance for a shared UI, NOT
// real security — the data still lives in the browser and a determined user with
// devtools can reach it. The PIN hash is synced (sync.js) so the lock travels
// with the shared record: a device that pulls a record protected by a PIN comes
// up locked, and only someone who knows the PIN can edit.

import { LOCK_PIN_KEY } from './constants.js';

// Unlock is per-session (sessionStorage): a freshly opened tab on a shared/
// borrowed device re-locks, but the owner only re-enters their PIN once per
// session rather than on every reload.
const UNLOCK_FLAG = 'savantUnlocked';

export function hasPin() {
  return !!localStorage.getItem(LOCK_PIN_KEY);
}

// Locked = a PIN exists and this session hasn't unlocked it yet. With no PIN
// set, the app is fully open (the owner hasn't turned on protection).
export function isLocked() {
  return hasPin() && sessionStorage.getItem(UNLOCK_FLAG) !== '1';
}

async function _hash(plain) {
  const data = new TextEncoder().encode(String(plain));
  if (window.crypto?.subtle) {
    const buf = await window.crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback for non-secure contexts (the real app is HTTPS, so this is a
  // belt-and-suspenders djb2 hash, not relied upon in production).
  let h = 5381;
  for (const c of String(plain)) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return 'djb2:' + h.toString(16);
}

export async function setPin(plain) {
  localStorage.setItem(LOCK_PIN_KEY, await _hash(plain));
}

// Used by sync.js to propagate the owner's PIN hash to other devices.
export function getPinHash() { return localStorage.getItem(LOCK_PIN_KEY) || ''; }
export function setPinHash(hash) {
  if (hash) localStorage.setItem(LOCK_PIN_KEY, hash);
}

async function _verify(plain) {
  return hasPin() && (await _hash(plain)) === localStorage.getItem(LOCK_PIN_KEY);
}

export function lock() {
  sessionStorage.removeItem(UNLOCK_FLAG);
  _reflect();
}

// ─────────────────────────────────────────────────────────────────────────
// Digit-only PIN entry — a self-contained on-screen keypad modal.
//
// Native prompt() pops the OS QWERTY keyboard, which is the wrong affordance
// for a 4-digit numeric PIN. This keypad renders its own 0–9 grid so the input
// is digit-only on every device (mobile + desktop) with no OS keyboard at all.
// Physical-keyboard digits, Backspace, and Escape are also honored.

const PIN_LEN = 4;
let _pinValue = '';
let _pinResolve = null;
let _pinVerify = null;
let _pinKeyHandler = null;

function _buildPinModal() {
  if (document.getElementById('pin-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'pin-overlay';
  ov.className = 'pin-overlay hidden';
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map(n => `<button type="button" class="pin-key" data-d="${n}">${n}</button>`).join('');
  ov.innerHTML = `
    <div class="pin-modal" role="dialog" aria-modal="true" aria-labelledby="pin-title">
      <div class="pin-title" id="pin-title">Enter PIN</div>
      <div class="pin-sub" id="pin-sub"></div>
      <div class="pin-dots" id="pin-dots"></div>
      <div class="pin-error" id="pin-error" role="alert"></div>
      <div class="pin-keypad">
        ${keys}
        <button type="button" class="pin-key pin-key-soft" data-k="cancel">Cancel</button>
        <button type="button" class="pin-key" data-d="0">0</button>
        <button type="button" class="pin-key pin-key-soft" data-k="del" aria-label="Delete">⌫</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  // Scoped to the keypad so these buttons never reach app.js's global
  // data-action dispatcher.
  ov.querySelector('.pin-keypad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.d !== undefined) _pinPress(b.dataset.d);
    else if (b.dataset.k === 'del') _pinDel();
    else if (b.dataset.k === 'cancel') _pinFinish(null);
  });
  // Tapping the backdrop cancels.
  ov.addEventListener('click', (e) => { if (e.target === ov) _pinFinish(null); });
}

function _renderDots() {
  const dots = document.getElementById('pin-dots');
  if (!dots) return;
  let html = '';
  for (let i = 0; i < PIN_LEN; i++) {
    html += `<span class="pin-dot${i < _pinValue.length ? ' filled' : ''}"></span>`;
  }
  dots.innerHTML = html;
}

function _pinPress(d) {
  if (_pinValue.length >= PIN_LEN) return;
  const err = document.getElementById('pin-error');
  if (err) err.textContent = '';
  _pinValue += d;
  _renderDots();
  if (_pinValue.length === PIN_LEN) {
    // Brief pause so the final dot registers visually before we resolve/verify.
    setTimeout(_pinComplete, 130);
  }
}

function _pinDel() {
  _pinValue = _pinValue.slice(0, -1);
  _renderDots();
}

async function _pinComplete() {
  const val = _pinValue;
  if (_pinVerify) {
    const ok = await _pinVerify(val);
    if (!ok) {
      _pinValue = '';
      _renderDots();
      const err = document.getElementById('pin-error');
      const modal = document.querySelector('#pin-overlay .pin-modal');
      if (err) err.textContent = 'Wrong PIN — try again.';
      if (modal) { modal.classList.remove('pin-shake'); void modal.offsetWidth; modal.classList.add('pin-shake'); }
      return;
    }
  }
  _pinFinish(val);
}

function _pinFinish(val) {
  const ov = document.getElementById('pin-overlay');
  if (ov) ov.classList.add('hidden');
  if (_pinKeyHandler) { document.removeEventListener('keydown', _pinKeyHandler); _pinKeyHandler = null; }
  const resolve = _pinResolve;
  _pinResolve = null;
  _pinVerify = null;
  _pinValue = '';
  if (resolve) resolve(val);
}

// Prompt for a 4-digit PIN. Resolves to the entered digits, or null if cancelled.
// Pass `verify(value) => bool|Promise<bool>` to keep the modal open and show an
// inline error on a wrong entry (used for unlock); resolves only on a match.
function askPin({ title = 'Enter PIN', sub = '', verify = null } = {}) {
  _buildPinModal();
  // Resolve any in-flight prompt before starting a new one.
  if (_pinResolve) _pinFinish(null);
  return new Promise((resolve) => {
    _pinValue = '';
    _pinResolve = resolve;
    _pinVerify = verify;
    document.getElementById('pin-title').textContent = title;
    const subEl = document.getElementById('pin-sub');
    subEl.textContent = sub;
    subEl.style.display = sub ? '' : 'none';
    document.getElementById('pin-error').textContent = '';
    _renderDots();
    document.getElementById('pin-overlay').classList.remove('hidden');
    _pinKeyHandler = (e) => {
      if (e.key >= '0' && e.key <= '9') { _pinPress(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { _pinDel(); e.preventDefault(); }
      else if (e.key === 'Escape') { _pinFinish(null); e.preventDefault(); }
    };
    document.addEventListener('keydown', _pinKeyHandler);
  });
}

// A tiny button-menu modal, reusing the PIN overlay shell. Resolves to the
// chosen key, or null if dismissed. Used for the owner's manage path so we no
// longer fall back to a text prompt().
function askChoice({ title = '', sub = '', options = [] } = {}) {
  _buildPinModal();
  if (_pinResolve) _pinFinish(null);
  return new Promise((resolve) => {
    const ov = document.getElementById('pin-overlay');
    const modal = ov.querySelector('.pin-modal');
    modal.querySelector('#pin-dots').innerHTML = '';
    modal.querySelector('#pin-error').textContent = '';
    modal.querySelector('#pin-title').textContent = title;
    const subEl = modal.querySelector('#pin-sub');
    subEl.textContent = sub;
    subEl.style.display = sub ? '' : 'none';
    const pad = modal.querySelector('.pin-keypad');
    pad.style.display = 'none';
    let menu = modal.querySelector('.pin-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'pin-menu';
      pad.insertAdjacentElement('afterend', menu);
    }
    menu.innerHTML = options
      .map(o => `<button type="button" class="pin-menu-btn${o.danger ? ' danger' : ''}${o.soft ? ' soft' : ''}" data-key="${o.key}">${o.label}</button>`)
      .join('');
    menu.style.display = '';
    const done = (key) => {
      menu.style.display = 'none';
      pad.style.display = '';
      ov.classList.add('hidden');
      ov.removeEventListener('click', backdrop);
      menu.removeEventListener('click', onClick);
      resolve(key);
    };
    const onClick = (e) => { const b = e.target.closest('button'); if (b) done(b.dataset.key); };
    const backdrop = (e) => { if (e.target === ov) done(null); };
    menu.addEventListener('click', onClick);
    ov.addEventListener('click', backdrop);
    ov.classList.remove('hidden');
  });
}

function _unlockSession() {
  sessionStorage.setItem(UNLOCK_FLAG, '1');
  _reflect();
}

// Reflect lock state onto <body> so CSS can hide the edit affordances.
function _reflect() {
  document.body.classList.toggle('savant-locked', isLocked());
  const btn = document.getElementById('lock-btn');
  if (btn) {
    if (!hasPin())        { btn.textContent = '🔓 PROTECT'; btn.title = 'Set a PIN to lock the Record + Grade tabs before sharing'; }
    else if (isLocked())  { btn.textContent = '🔒 LOCKED';  btn.title = 'Record + Grade editing is locked — tap to enter PIN'; }
    else                  { btn.textContent = '🔓 UNLOCKED'; btn.title = 'Editing unlocked — tap to lock'; }
  }
}

// Called from _dispatchAction before running a PROTECTED action. Returns true if
// the action may proceed (not locked). When locked, prompts for the PIN and, on
// success, unlocks the session — the user re-clicks to perform the action.
export function guardAction() {
  if (!isLocked()) return true;
  // Async keypad prompt; verify inline so a wrong PIN stays on the modal. On
  // success we unlock for the session — the user re-clicks to perform the action
  // (the same re-tap pattern the blocking prompt() had).
  askPin({
    title: 'Enter PIN',
    sub: 'Record + Grade editing is locked',
    verify: (v) => _verify(v),
  }).then((val) => {
    if (val !== null) { _unlockSession(); _reflect(); }
  });
  return false;                                  // never run the action on the click that prompts
}

// Collect a fresh 4-digit PIN (enter + confirm). Returns the PIN, or null if the
// user cancelled or the two entries didn't match.
async function _newPin(setTitle = 'Set a 4-digit PIN') {
  const a = await askPin({ title: setTitle, sub: 'Protect the Record + Grade tabs' });
  if (a === null) return null;
  const b = await askPin({ title: 'Confirm PIN', sub: 'Re-enter the same 4 digits' });
  if (b === null) return null;
  if (b !== a) {
    await askChoice({ title: 'PINs didn’t match', options: [{ key: 'ok', label: 'OK', soft: true }] });
    return null;
  }
  return a;
}

// The lock-button handler (data-action="toggle-lock").
export async function toggleLock() {
  if (!hasPin()) {
    const pin = await _newPin();
    if (pin === null) return;
    await setPin(pin);
    _unlockSession();      // owner who just set it stays unlocked this session
    await askChoice({
      title: 'Protected 🔒',
      sub: 'Editing is now PIN-gated for anyone you share this with.',
      options: [{ key: 'ok', label: 'Got it', soft: true }],
    });
    return;
  }
  if (isLocked()) {
    const v = await askPin({ title: 'Enter PIN', sub: 'Unlock editing', verify: (x) => _verify(x) });
    if (v !== null) _unlockSession();
    return;
  }
  // Unlocked + PIN set: offer lock now, or change/remove the PIN.
  const choice = await askChoice({
    title: 'Editing unlocked',
    sub: 'Record + Grade tabs are editable on this device.',
    options: [
      { key: 'lock',   label: '🔒 Lock now' },
      { key: 'change', label: 'Change PIN' },
      { key: 'remove', label: 'Remove PIN', danger: true },
      { key: 'cancel', label: 'Cancel', soft: true },
    ],
  });
  if (choice === 'lock') { lock(); }
  else if (choice === 'remove') { localStorage.removeItem(LOCK_PIN_KEY); _reflect(); }
  else if (choice === 'change') {
    const pin = await _newPin('New 4-digit PIN');
    if (pin === null) return;
    await setPin(pin);
    _unlockSession();
  }
}

export function _initLockBtn() { _reflect(); }
