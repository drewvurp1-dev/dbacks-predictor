/* Daily snapshot maps.
   Each day page has <div class="daymap-wrap" data-day="N"></div>; this file draws that day's
   stops on a Leaflet/OpenStreetMap map and lists how to get between them.

   Stop shape: { n: name, ll: [lat, lng] | null, mode: 'metro'|'ferry'|'train'|'walk'|'didi'|'bus'|'tram'|'cable',
                 how: text (from the previous stop), opt: true if optional, tag: small label }
   ll: null = real stop that is off this map (e.g. the other city) — listed, not pinned.

   Coordinates are hand-entered and approximate (roughly +/- a few hundred metres, more for
   Guilin/Xingping). Confirm the exact entrance in Amap / Apple Maps before relying on a pin.
   Order: how = the leg from the PREVIOUS stop (first stop = from the usual starting hub). */
(function () {
  'use strict';

  var HK = '#59d6d0', MO = '#d8b24a', GL = '#6fbf94', CQ = '#ff5fb0';

  var DAYS = {
    1: { color: HK, stops: [
      { n: 'Victoria Peak', ll: [22.2759, 114.1505], mode: 'tram',
        how: 'MTR to Central (Exit J2), then walk ~10–15 min to the Peak Tram terminus on Garden Road. Tram ~8 min to the top.' },
      { n: 'Star Ferry — Central Pier', ll: [22.2866, 114.1600], mode: 'walk',
        how: 'Peak Tram back down, then walk ~15–20 min north to the pier (or one short MTR hop to Central and walk).' },
      { n: 'Tsim Sha Tsui promenade', tag: 'Symphony of Lights', ll: [22.2931, 114.1738], mode: 'ferry',
        how: 'Star Ferry to Tsim Sha Tsui (~10 min). Then walk east along the waterfront ~10–15 min toward the Avenue of Stars.' },
      { n: 'Temple Street Night Market', ll: [22.3104, 114.1708], mode: 'metro',
        how: 'Walk to Tsim Sha Tsui MTR (~10 min), Tsuen Wan Line to Jordan (1 stop), Exit A, then ~5 min on foot.' },
      { n: 'Sha Tin Racecourse', tag: 'Optional', opt: true, ll: [22.4009, 114.2037], mode: 'metro',
        how: 'East Rail Line direct to Racecourse Station (20–30 min from Central). Only open on race days.' }
    ] },
    2: { color: HK, stops: [
      { n: 'Hong Kong Disneyland', ll: [22.3131, 114.0413], mode: 'metro',
        how: 'MTR Tung Chung Line to Sunny Bay, change to the Disneyland Resort Line (one stop). ~35–45 min from Central.' },
      { n: 'Tian Tan Buddha / Ngong Ping', tag: 'Optional', opt: true, ll: [22.2540, 113.9043], mode: 'cable',
        how: 'Resort Line back to Sunny Bay, Tung Chung Line to Tung Chung (Exit B), then the Ngong Ping 360 cable car (~25 min up). A half-day of its own.' }
    ] },
    3: { color: MO, stops: [
      { n: 'Macau Outer Harbour Ferry Terminal', ll: [22.1957, 113.5535], mode: 'ferry',
        how: 'From Hong Kong: MTR to Sheung Wan (Exit D) → Shun Tak Centre → HK–Macau Ferry Terminal. TurboJET ~60–70 min lands at Outer Harbour; Cotai Water Jet lands at Taipa, closer to the casinos. Book the night before for nine.' },
      { n: 'The Venetian Macao', ll: [22.1475, 113.5611], mode: 'bus',
        how: 'Free casino shuttle buses run from the ferry terminals — look for the Venetian shuttle. Taxi as backup.' },
      { n: 'The Parisian', ll: [22.1432, 113.5603], mode: 'walk',
        how: 'Across the Cotai Strip from the Venetian — a few minutes\' walk.' },
      { n: 'Wynn Palace', ll: [22.1463, 113.5516], mode: 'didi',
        how: 'Short taxi (~5 min) or ~20 min on foot from the Parisian.' },
      { n: 'Grand Lisboa', tag: 'Downtown', ll: [22.1911, 113.5414], mode: 'bus',
        how: 'City bus or taxi from Cotai to the old town on the peninsula (~15–20 min).' },
      { n: 'Senado Square', ll: [22.1939, 113.5394], mode: 'walk',
        how: 'Walk ~10 min from the Grand Lisboa.' },
      { n: 'Ruins of St. Paul\'s', ll: [22.1977, 113.5409], mode: 'walk',
        how: 'Walk ~5 min up from Senado Square.' },
      { n: 'Macau Tower', ll: [22.1798, 113.5362], mode: 'didi',
        how: 'Taxi ~10 min from the old town.' },
      { n: 'Taipa Village', tag: 'Dinner + drinks', ll: [22.1537, 113.5568], mode: 'didi',
        how: 'Taxi or bus across the bridge to Taipa (~15 min). Plan to be back at the ferry by ~21:00; last sailings ~22:00–23:00.' }
    ] },
    4: { color: GL, stops: [
      { n: 'Hong Kong West Kowloon → Guilin West', tag: 'Off-map', ll: null, mode: 'train',
        how: 'MTR to Austin (Tuen Ma Line) or Kowloon Station — both connect on foot to West Kowloon Station. Arrive 90 min early for mainland immigration. ~10:00 train, ~3–3.5 hrs.' },
      { n: 'Guilin West Station → hotel', tag: 'Off-map', ll: null, mode: 'didi',
        how: 'The station is ~15 km / 25 min from the centre and Guilin has no metro. Two DiDis or taxis for the group.' },
      { n: 'Binjiang Road riverside walk', tag: 'Near Elephant Trunk Hill', ll: [25.2680, 110.2990], mode: 'walk',
        how: 'Easy evening stroll along the Li River from the hotel; rice noodles (mǐfěn) nearby.' }
    ] },
    5: { color: GL, note: 'Guilin pins are approximate. This day may move to a Yangshuo base — see the calendar notes.', stops: [
      { n: 'Solitary Beauty Peak & Princes\' City', ll: [25.2810, 110.2975], mode: 'didi',
        how: 'DiDi from the hotel (~10 min). Guilin has no metro.' },
      { n: 'Elephant Trunk Hill', ll: [25.2663, 110.2985], mode: 'walk',
        how: 'Walk ~25 min south along the Li River (Binjiang Road), or a short DiDi.' },
      { n: 'Xianggong Hill (Xingping)', tag: '~1.5 hrs away', ll: [24.9250, 110.5100], mode: 'didi',
        how: 'Two DiDis out, two back — about 1.5 hrs each way, no metro or ferry option. Best in late-afternoon light.' },
      { n: 'Two Rivers & Four Lakes night cruise', tag: 'Sun & Moon Pagodas', ll: [25.2755, 110.2895], mode: 'didi',
        how: 'DiDi back to the lakes (~1.5 hrs). The cruise leaves from the docks near the Sun & Moon Pagodas — confirm the pier when you book for nine.' }
    ] },
    6: { color: CQ, stops: [
      { n: 'Guilin West → Chongqing West', tag: 'Off-map', ll: null, mode: 'train',
        how: 'DiDi ~25 min from the centre to Guilin West, then the ~4 hr high-speed train.' },
      { n: 'Chongqing West Station → hotel', tag: 'Off-map', ll: null, mode: 'metro',
        how: 'Metro Line 5 and the Loop line connect here; the hotel is likely 30–45 min out. Two DiDis with luggage is simplest.' },
      { n: 'Jiefangbei', ll: [29.5580, 106.5770], mode: 'metro',
        how: 'Metro to Linjiangmen (Line 2) and walk ~10 min, or walk from the hotel if it is near.' },
      { n: 'Hongyadong, from across the water', ll: [29.5622, 106.5779], mode: 'walk',
        how: 'Walk ~10 min from Jiefangbei. For the full gold-lit view, use Qiansimen Bridge or the opposite bank rather than the crowd inside.' }
    ] },
    7: { color: CQ, stops: [
      { n: 'Liziba Station', tag: 'Line 2 through the building', ll: [29.5521, 106.5317], mode: 'metro',
        how: 'Metro Line 2 — the station is inside a 19-storey apartment block. Viewing platform across the street.' },
      { n: 'Yangtze River Cableway', ll: [29.5565, 106.5825], mode: 'didi',
        how: 'DiDi ~15 min (no clean metro link). Go early or buy a timed ticket.' },
      { n: 'Shibati (Eighteen Steps)', ll: [29.5543, 106.5667], mode: 'didi',
        how: 'Short DiDi or ~25 min walk from the cableway.' },
      { n: 'Ciqikou Ancient Town', tag: 'Optional', opt: true, ll: [29.5800, 106.4495], mode: 'metro',
        how: 'Line 1 to Ciqikou Station. Go early, before it packs.' },
      { n: 'Jiangtan Park', tag: 'Drone show', ll: [29.5724, 106.5791], mode: 'metro',
        how: 'Metro or DiDi to the riverside lawns. Pin is approximate — confirm the show location and time locally. Go early; the metro will be jammed afterward.' }
    ] },
    8: { color: CQ, stops: [
      { n: 'Ciqikou Ancient Town', ll: [29.5800, 106.4495], mode: 'metro',
        how: 'Line 1 to Ciqikou Station (磁器口站).' },
      { n: 'Hongyadong', tag: 'On foot this time', ll: [29.5622, 106.5779], mode: 'metro',
        how: 'Line 2 to Linjiangmen (临江门站), Exit 2. Walk it top to bottom, then stay for the lights at dusk.' }
    ] },
    9: { color: CQ, stops: [
      { n: 'Chongqing Zoo', ll: [29.5060, 106.5160], mode: 'metro',
        how: 'Line 2 to Zoo Station (动物园站), Exit 1 — it lets out right at the gate.' },
      { n: 'Eling Park', tag: '瞰胜楼 viewing building', ll: [29.5512, 106.5267], mode: 'metro',
        how: 'From the Zoo, change at Lianglukou (Lines 1/2/3) onto Line 1 to Eling Station (鹅岭站).' },
      { n: 'Erchang Creative Park', ll: [29.5462, 106.5290], mode: 'walk',
        how: 'Right next to Eling Park — a short walk.' }
    ] },
    10: { color: CQ, stops: [
      { n: 'Jiefangbei', tag: 'Suits', ll: [29.5580, 106.5770], mode: 'walk',
        how: 'Walk from the hotel if it is near Chaotianmen; otherwise metro to Linjiangmen (Line 2) and walk.' },
      { n: 'Three Gorges Museum', ll: [29.5617, 106.5467], mode: 'metro',
        how: 'Line 10 to Grand Hall Station (大礼堂站), Exit 1.' },
      { n: 'Great Hall of the People', ll: [29.5637, 106.5455], mode: 'walk',
        how: 'Across the plaza from the museum — a couple of minutes on foot.' }
    ] }
  };

  var MODE_LABEL = { metro: 'Metro', ferry: 'Ferry', train: 'Train', walk: 'Walk', didi: 'DiDi / taxi',
                     bus: 'Bus', tram: 'Tram', cable: 'Cable car' };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function build(wrap) {
    var day = DAYS[wrap.getAttribute('data-day')];
    if (!day) return;
    wrap.style.setProperty('--dm', day.color);

    var mapDiv = el('div', 'daymap');
    mapDiv.setAttribute('role', 'application');
    mapDiv.setAttribute('aria-label', 'Map of today\'s stops');
    wrap.appendChild(mapDiv);
    wrap.appendChild(el('p', 'dm-hint', 'Tap a stop to find it on the map. Pins are approximate — confirm the entrance in Amap or Apple Maps.'));
    if (day.note) wrap.appendChild(el('p', 'dm-hint dm-warn', day.note));

    var list = el('ol', 'dm-list');
    var items = [];
    var markers = [];
    var pinned = 0;

    day.stops.forEach(function (s, i) {
      var li = el('li', 'dm-stop' + (s.opt ? ' opt' : '') + (s.ll ? '' : ' nomap'));
      li.appendChild(el('div', 'dm-n', String(i + 1)));
      var body = el('div');
      var name = el('div', 'dm-name', s.n);
      if (s.tag) name.appendChild(el('small', null, s.tag));
      body.appendChild(name);
      var how = el('div', 'dm-how');
      how.appendChild(el('span', 'dm-mode ' + s.mode, MODE_LABEL[s.mode] || s.mode));
      how.appendChild(document.createTextNode(s.how));
      body.appendChild(how);
      li.appendChild(body);
      list.appendChild(li);
      items.push(li);
      if (s.ll) pinned++;
    });
    wrap.appendChild(list);

    if (!window.L) {
      mapDiv.appendChild(el('div', 'dm-offline', 'Map unavailable offline — the stop list below still works.'));
      return;
    }

    var map = L.map(mapDiv, { scrollWheelZoom: false, tap: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      crossOrigin: true, // CORS request so the service worker can cache tiles for offline use
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);

    var pts = [];
    function select(i, fly) {
      items.forEach(function (li, j) { li.classList.toggle('on', j === i); });
      markers.forEach(function (m, j) {
        if (m) m.getElement() && m.getElement().firstChild.classList.toggle('on', j === i);
      });
      if (fly && markers[i]) map.flyTo(markers[i].getLatLng(), Math.max(map.getZoom(), 15), { duration: .6 });
    }

    day.stops.forEach(function (s, i) {
      if (!s.ll) { markers.push(null); return; }
      var icon = L.divIcon({
        className: '',
        html: '<div class="dm-pin' + (s.opt ? ' opt' : '') + '">' + (i + 1) + '</div>',
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      var m = L.marker(s.ll, { icon: icon, title: s.n, keyboard: true }).addTo(map);
      m.on('click', function () {
        select(i, false);
        items[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      markers.push(m);
      pts.push(s.ll);
    });

    // dotted line shows visiting order
    var order = day.stops.filter(function (s) { return s.ll && !s.opt; }).map(function (s) { return s.ll; });
    if (order.length > 1) L.polyline(order, { color: day.color, weight: 3, opacity: .8, dashArray: '2 8', lineCap: 'round' }).addTo(map);

    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [34, 34], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 15);

    items.forEach(function (li, i) {
      if (!day.stops[i].ll) return;
      li.addEventListener('click', function () {
        select(i, true);
        mapDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    // the map may be built while hidden / before layout settles
    setTimeout(function () { map.invalidateSize(); }, 250);
  }

  function init() {
    var wraps = document.querySelectorAll('.daymap-wrap');
    for (var i = 0; i < wraps.length; i++) build(wraps[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
