// Weather data + park-orientation helpers.
//
// Owns the live weather fetch (via api.weatherAt → wttr.in proxy), the compass-
// to-degrees lookup table used to project a stadium wind direction onto the
// park's center-field bearing, and the field-relative wind bucket (_windDir)
// the prediction engine consumes.
//
// `updateWeatherForTime` stays in app.js — it depends on setDay (a small
// DOM-toggle helper that lives next to the other game-time toggles).

import { show, hide } from './utils.js';
import { S } from './state.js';
import * as api from './api.js';

// Compass point → bearing (degrees clockwise from N).
export const _COMPASS_DEGS = {
  N:0, NNE:22.5, NE:45, ENE:67.5,
  E:90, ESE:112.5, SE:135, SSE:157.5,
  S:180, SSW:202.5, SW:225, WSW:247.5,
  W:270, WNW:292.5, NW:315, NNW:337.5,
};
export function _compassDeg(pt){ return _COMPASS_DEGS[pt] ?? null; }

// Returns 'out'/'in'/'cross'/'calm' relative to this park's center field
// orientation. Accounts for live vs manual weather mode.
export function _windDir(){
  const sel=document.getElementById('stadium-select');
  const opt=sel?.options[sel?.selectedIndex];
  const cfBearing=parseInt(opt?.dataset.cf)||45;
  const wm=document.getElementById('weather-manual')&&!document.getElementById('weather-manual').classList.contains('hidden');
  const rawDir=(!wm&&S.weather?.windDir)||document.getElementById('wind-dir')?.value||'calm';
  const windMph=(!wm&&S.weather?.windMph)||parseInt(document.getElementById('wind-slider')?.value)||5;
  if(['out','in','cross'].includes(rawDir))return rawDir;
  if(!rawDir||rawDir==='calm'||windMph<3)return 'calm';
  const fromDeg=_compassDeg(rawDir);if(fromDeg===null)return 'cross';
  const toDeg=(fromDeg+180)%360;
  const comp=Math.cos((cfBearing-toDeg)*Math.PI/180);
  return comp>0.35?'out':comp<-0.35?'in':'cross';
}

export async function fetchWeather(){
  const sel=document.getElementById('stadium-select');
  const opt=sel.options[sel.selectedIndex];
  const lat=opt.dataset.lat,lon=opt.dataset.lon;
  show('weather-spinner');hide('weather-content');
  try{
    const d=await api.weatherAt(lat, lon);
    const cur=d.current_condition?.[0];
    if(!cur)throw new Error('No data');
    const tempF=parseInt(cur.temp_F);
    const windMph=parseInt(cur.windspeedMiles);
    const windDir=cur.winddir16Point;
    const humidity=parseInt(cur.humidity);
    const desc=cur.weatherDesc?.[0]?.value||'';
    const hour=parseInt((document.getElementById('game-time').value||'19:10').split(':')[0]);
    const today=d.weather?.[0];
    let fh=null;
    if(today?.hourly)fh=today.hourly.reduce((p,c)=>Math.abs(parseInt(c.time)/100-hour)<Math.abs(parseInt(p.time)/100-hour)?c:p);
    const u=fh||cur;
    const uT=parseInt(u.tempF||u.temp_F||tempF),uW=parseInt(u.windspeedMiles||windMph),uH=parseInt(u.humidity||humidity),uD=u.winddir16Point||windDir;
    S.weather={tempF:uT,windMph:uW,windDir:uD,humidity:uH,desc};
    document.getElementById('weather-grid').innerHTML=`<div class="weather-cell"><div class="wc-label">Temp</div><div class="wc-val" style="color:${uT>=90?'#e74c3c':uT<=55?'#3498db':'#fff'}">${uT}°F</div><div class="wc-sub">${desc}</div></div><div class="weather-cell"><div class="wc-label">Wind</div><div class="wc-val">${uW} mph</div><div class="wc-sub">${uD}</div></div><div class="weather-cell"><div class="wc-label">Humidity</div><div class="wc-val">${uH}%</div><div class="wc-sub">relative</div></div><div class="weather-cell"><div class="wc-label">Sky</div><div class="wc-val" style="font-size:18px;">${desc.includes('Rain')?'🌧':desc.includes('Cloud')||desc.includes('Overcast')?'☁️':'☀️'}</div></div>`;
    const hasRoof=opt.dataset.roof==='1';
    const roofRec=document.getElementById('roof-rec');
    if(hasRoof){if(uT>=90){roofRec.className='roof-recommendation likely-closed';roofRec.textContent=`⚠ ${uT}°F — Roof likely closed.`;roofRec.classList.remove('hidden');}else if(uT<80){roofRec.className='roof-recommendation likely-open';roofRec.textContent=`✓ ${uT}°F — Roof likely open.`;roofRec.classList.remove('hidden');}else roofRec.classList.add('hidden');}else roofRec.classList.add('hidden');
    show('weather-content');
  }catch(e){console.warn('Weather load failed:',e.message);hide('weather-spinner');}
  finally{hide('weather-spinner');}
}
