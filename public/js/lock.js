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
  const entry = prompt('🔒 These tabs are locked. Enter PIN to edit:');
  if (entry === null) return false;             // cancelled
  _verify(entry.trim()).then(ok => {
    if (ok) { _unlockSession(); alert('Unlocked for this session — repeat your action.'); }
    else alert('Wrong PIN.');
  });
  return false;                                  // never run the action on the click that prompts
}

// The lock-button handler (data-action="toggle-lock").
export async function toggleLock() {
  if (!hasPin()) {
    const a = prompt('Set a PIN to protect the Record + Grade tabs:');
    if (a === null) return;
    const pin = a.trim();
    if (!pin) { alert('PIN cannot be empty.'); return; }
    const b = prompt('Re-enter the PIN to confirm:');
    if (b === null) return;
    if (b.trim() !== pin) { alert('PINs did not match.'); return; }
    await setPin(pin);
    _unlockSession();      // owner who just set it stays unlocked this session
    alert('Protected. Editing is now PIN-gated for anyone you share this with.');
    return;
  }
  if (isLocked()) {
    const entry = prompt('Enter PIN to unlock editing:');
    if (entry === null) return;
    if (await _verify(entry.trim())) _unlockSession();
    else alert('Wrong PIN.');
    return;
  }
  // Unlocked + PIN set: offer lock now, or change/remove the PIN.
  const choice = prompt('Type LOCK to lock now, CHANGE to set a new PIN, or REMOVE to delete the PIN:', 'LOCK');
  if (choice === null) return;
  const c = choice.trim().toUpperCase();
  if (c === 'LOCK') { lock(); }
  else if (c === 'REMOVE') { localStorage.removeItem(LOCK_PIN_KEY); _reflect(); alert('PIN removed — tabs are open.'); }
  else if (c === 'CHANGE') {
    const a = prompt('New PIN:');
    if (a === null) return;
    const pin = a.trim();
    if (!pin) { alert('PIN cannot be empty.'); return; }
    const b = prompt('Re-enter the new PIN:');
    if (b === null) return;
    if (b.trim() !== pin) { alert('PINs did not match.'); return; }
    await setPin(pin);
    _unlockSession();
    alert('PIN changed.');
  }
}

export function _initLockBtn() { _reflect(); }
