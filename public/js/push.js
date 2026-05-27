// Web push notifications (PWA).
//
// iOS requires the app to be installed to the home screen first (PWA). On the
// home-screen instance, the user can grant notification permission and we
// register a push subscription with the server.

import * as api from './api.js';
import { _getSyncKey, _setSyncKey } from './sync.js';

function _isStandalonePWA(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
}

function _urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}

export async function registerSW(){
  if(!('serviceWorker'in navigator))return null;
  try{
    const reg=await navigator.serviceWorker.register('/sw.js');
    return reg;
  }catch(e){console.warn('[push] SW register failed:',e);return null;}
}

export async function _pushSubscribe(){
  const btn=document.getElementById('push-btn');
  const setBtn=(t)=>{if(btn)btn.textContent=t;};

  if(!('serviceWorker'in navigator)||!('PushManager'in window)){
    alert('This browser doesn’t support web push. On iPhone, open in Safari, tap Share → Add to Home Screen, then open the app from the home screen.');
    return;
  }
  // iOS Safari requires the app to be running as an installed PWA before push works
  if(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!_isStandalonePWA()){
    alert('To enable notifications on iPhone:\n1. Tap the Share icon\n2. Tap "Add to Home Screen"\n3. Open Snake Savant from your home screen\n4. Tap this button again');
    return;
  }

  let key=_getSyncKey();
  if(!key){
    key=(prompt('Enter your sync passphrase (must match SYNC_KEY on Railway):')||'').trim();
    if(!key)return;
    _setSyncKey(key);
  }

  setBtn('⟳ Subscribing…');
  try{
    // 1. Permission
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){
      setBtn('🔔 Enable notifications');
      alert('Notification permission denied. Enable in Settings → Safari → Notifications.');
      return;
    }

    // 2. Pull VAPID public key from server
    const pkRes=await api.pushPublicKey();
    if(!pkRes.ok)throw new Error('VAPID key fetch failed');
    const {publicKey}=await pkRes.json();

    // 3. Register service worker, subscribe
    const reg=await registerSW();
    if(!reg)throw new Error('Service worker registration failed');
    await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub){
      sub=await reg.pushManager.subscribe({
        userVisibleOnly:true,
        applicationServerKey:_urlBase64ToUint8Array(publicKey),
      });
    }

    // 4. Send subscription to server
    const postRes=await api.pushSubscribe(key, sub.toJSON());
    if(!postRes.ok){
      if(postRes.status===401){alert('Wrong sync passphrase.');_setSyncKey('');setBtn('🔔 Enable notifications');return;}
      throw new Error(`Server ${postRes.status}`);
    }
    localStorage.setItem('pushSubscribed','1');
    setBtn('✓ Notifications on');
  }catch(err){
    console.error('[push]',err);
    setBtn('🔔 Enable notifications');
    alert('Subscribe failed: '+err.message);
  }
}

export async function _pushTest(){
  const key=_getSyncKey();
  if(!key){alert('Set sync passphrase first via the Sync button.');return;}
  try{
    const res=await api.pushTest(key);
    if(!res.ok)throw new Error(`Server ${res.status}`);
    const j=await res.json();
    alert(j.sent>0?`Sent ${j.sent} test notification${j.sent>1?'s':''}.`:'No subscriptions yet — tap Enable first.');
  }catch(err){alert('Test failed: '+err.message);}
}

export function _initPushBtn(){
  const btn=document.getElementById('push-btn');
  if(!btn)return;
  if(localStorage.getItem('pushSubscribed')==='1'&&Notification.permission==='granted'){
    btn.textContent='✓ Notifications on';
  }
}
