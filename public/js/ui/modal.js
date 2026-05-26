// Modal lifecycle: moves panels into and out of #modal-slot, toggles the
// overlay, and coordinates with the player-context transaction in state.js.
//
// Communication with the rest of app.js (notably _renderPitcherCard, which
// re-renders the pitcher card after DOM-move operations) happens via a
// 'modal:closed' CustomEvent. This keeps ui/modal.js free of upward imports
// — app.js subscribes to the event during bootstrap.

import { exitPlayerContext } from '../state.js';

let _modalPanels = [];

function _clearModalSlot() {
  const content = document.querySelector('.content');
  _modalPanels.forEach(id => {
    const p = document.getElementById(id);
    if (p) content.appendChild(p);
  });
  _modalPanels = [];
  document.getElementById('modal-slot').innerHTML = '';
}

function _moveToModal(panelId) {
  const p = document.getElementById(panelId);
  if (!p) return;
  document.getElementById('modal-slot').appendChild(p);
  _modalPanels.push(panelId);
}

export function openModal(panelIds, title) {
  if (typeof panelIds === 'string') panelIds = [panelIds];
  _clearModalSlot();
  document.getElementById('modal-player-name').textContent = title || '';
  panelIds.forEach(id => _moveToModal(id));
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // Scroll the modal back to the top so users see the panel header, not the
  // bottom of the previous scroll position (matters most for long panels).
  overlay.scrollTo?.(0, 0);
  overlay.querySelector('.modal-frame')?.scrollTo?.(0, 0);
}

export function closeModal() {
  _clearModalSlot();
  document.getElementById('modal-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  exitPlayerContext();
  // Signal that the DOM-move operations are done. app.js listens for this and
  // re-asserts the pitcher card (still owned by render code in app.js until
  // PR4h extracts ui/render.js).
  document.dispatchEvent(new CustomEvent('modal:closed'));
}
