// Cross-device sync over /api/sync.
//
// Push uploads the local bet record + grading stores to PostgreSQL keyed on
// the sync passphrase; pull overwrites local stores with the server copy.
// UI re-renders are decoupled via the 'bets:changed' / 'grades:changed'
// CustomEvents that bets.js + ui/record.js already wire up.

import { SYNC_KEY_STORAGE, SYNC_LAST_TS_KEY } from './constants.js';
import { S } from './state.js';
import * as api from './api.js';
import {
  getGradeLog, getFactorPerf, getFactorWeights, getPending,
  saveGradeLog, saveFactorPerf, saveFactorWeights, savePending,
} from './bets.js';

export function _getSyncKey(){ return localStorage.getItem(SYNC_KEY_STORAGE)||''; }
export function _setSyncKey(k){ localStorage.setItem(SYNC_KEY_STORAGE,k); }

// Touch-primary input on a narrow viewport → treat as the phone in the user's
// hand. Desktop pushes (authoritative); mobile pulls (overwritten by server).
export function _isMobileDevice(){
  return window.matchMedia('(pointer: coarse) and (max-width: 768px)').matches;
}
function _setSyncBtnState(cls,text,disabled){
  document.querySelectorAll('.'+cls).forEach(btn=>{btn.textContent=text;btn.disabled=disabled;});
}
export function _initSyncBtnLabel(){}

export async function _getSyncKeyPrompted(){
  let key=_getSyncKey();
  if(!key){
    key=(prompt('Enter your sync passphrase (must match SYNC_KEY on Railway):')||'').trim();
    if(!key)return null;
    _setSyncKey(key);
  }
  return key;
}

export async function pushRecord(){
  const key=await _getSyncKeyPrompted();
  if(!key)return;
  _setSyncBtnState('sync-btn-push','⟳ Pushing…',true);
  try{
    const payload={betLog:S.betLog,gradeLog:getGradeLog(),factorPerf:getFactorPerf(),factorWeights:getFactorWeights(),pending:getPending()};
    const res=await api.syncPost(key, payload);
    if(!res.ok){
      if(res.status===401){_setSyncKey('');_setSyncBtnState('sync-btn-push','↑ Push',false);alert('Wrong passphrase — cleared.');return;}
      throw new Error(`Server ${res.status}`);
    }
    localStorage.setItem(SYNC_LAST_TS_KEY,new Date().toISOString());
    const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    _setSyncBtnState('sync-btn-push',`✓ ${t}`,false);
    setTimeout(()=>_setSyncBtnState('sync-btn-push','↑ Push',false),3000);
  }catch(err){
    console.error('[sync push]',err);
    _setSyncBtnState('sync-btn-push','↑ Push',false);
    alert('Push failed: '+err.message);
  }
}

export async function pullRecord(){
  const key=await _getSyncKeyPrompted();
  if(!key)return;
  _setSyncBtnState('sync-btn-pull','⟳ Pulling…',true);
  try{
    const res=await api.syncGet(key);
    if(!res.ok){
      if(res.status===401){_setSyncKey('');_setSyncBtnState('sync-btn-pull','↓ Pull',false);alert('Wrong passphrase — cleared.');return;}
      const body=await res.json().catch(()=>({}));
      throw new Error(body.error||`Server ${res.status}`);
    }
    const remote=await res.json();
    S.betLog=remote.betLog||[];
    localStorage.setItem('corbetRecord',JSON.stringify(S.betLog));
    saveGradeLog(remote.gradeLog||[]);
    saveFactorPerf(remote.factorPerf||{});
    saveFactorWeights(remote.factorWeights||{});
    savePending(remote.pending||[]);
    localStorage.setItem(SYNC_LAST_TS_KEY,new Date().toISOString());
    document.dispatchEvent(new CustomEvent('bets:changed'));
    document.dispatchEvent(new CustomEvent('grades:changed'));
    const t=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    _setSyncBtnState('sync-btn-pull',`✓ ${t}`,false);
    setTimeout(()=>_setSyncBtnState('sync-btn-pull','↓ Pull',false),3000);
  }catch(err){
    console.error('[sync pull]',err);
    _setSyncBtnState('sync-btn-pull','↓ Pull',false);
    alert('Pull failed: '+err.message);
  }
}
