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

  /* The Hong Kong Airbnb (Causeway Bay, Electric Rd area; check in Dec 24, out Dec 28).
     Street-level only — this site is public, so no unit number. Pin is approximate. */
  var HOME = { n: 'Airbnb — Causeway Bay', tag: 'Electric Rd', ll: [22.2820, 114.1900], mode: 'metro',
    how: 'Your base Dec 24–28. Nearest MTR is Tin Hau or Causeway Bay (both Island Line, same direction). Pin is approximate.' };

  /* Sheraton Guilin Hotel, on the Li River downtown (check in Dec 28, out Dec 30). Pin approximate. */
  var GL_HOTEL = { n: 'Sheraton Guilin Hotel', tag: 'Downtown · Li River', ll: [25.2695, 110.2985], mode: 'didi',
    how: 'Your base Dec 28–30, on Binjiang Road by the river. Guilin has no metro — walk the riverfront or use DiDi. Pin is approximate; confirm in Amap.' };

  var DAYS = {
    1: { color: HK, home: HOME, stops: [
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
    2: { color: HK, home: HOME, stops: [
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
    4: { color: GL, home: [{ n: 'Airbnb check-out', tag: 'Off-map · Dec 28', ll: null, mode: 'metro',
      how: 'Check out of the Causeway Bay Airbnb, bags with you. Plan to reach West Kowloon about 90 min before the train.' }, GL_HOTEL], stops: [
      { n: 'Hong Kong West Kowloon → Guilin West', tag: 'Off-map', ll: null, mode: 'train',
        how: 'MTR to Austin (Tuen Ma Line) or Kowloon Station — both connect on foot to West Kowloon Station. Arrive 90 min early for mainland immigration. ~10:00 train, ~3–3.5 hrs.' },
      { n: 'Guilin West Station → Sheraton', tag: 'Off-map', ll: null, mode: 'didi',
        how: 'The station is ~15 km / 25 min from downtown and Guilin has no metro. Two DiDis or taxis for the group to the Sheraton.' },
      { n: 'Binjiang Road riverside walk', tag: 'Near Elephant Trunk Hill', ll: [25.2680, 110.2990], mode: 'walk',
        how: 'Easy evening stroll along the Li River from the Sheraton; rice noodles (mǐfěn) nearby.' }
    ] },
    5: { color: GL, home: GL_HOTEL, note: 'Guilin pins are approximate. This day may move to a Yangshuo base — see the calendar notes.', stops: [
      { n: 'Solitary Beauty Peak & Princes\' City', ll: [25.2810, 110.2975], mode: 'didi',
        how: 'DiDi from the Sheraton (~5–10 min). Guilin has no metro.' },
      { n: 'Elephant Trunk Hill', ll: [25.2663, 110.2985], mode: 'walk',
        how: 'Back along the Li River on Binjiang Road — a short walk from the Sheraton, or a quick DiDi.' },
      { n: 'Xianggong Hill (Xingping)', tag: '~1.5 hrs away', ll: [24.9250, 110.5100], mode: 'didi',
        how: 'Two DiDis out, two back — about 1.5 hrs each way, no metro or ferry option. Best in late-afternoon light.' },
      { n: 'Two Rivers & Four Lakes night cruise', tag: 'Sun & Moon Pagodas', ll: [25.2755, 110.2895], mode: 'didi',
        how: 'DiDi back to the lakes (~1.5 hrs). The cruise leaves from the docks near the Sun & Moon Pagodas — confirm the pier when you book for nine.' }
    ] },
    6: { color: CQ, home: { n: 'Sheraton Guilin check-out', tag: 'Off-map · Dec 30', ll: null, mode: 'didi',
      how: 'Check out, bags with you, and DiDi ~25 min to Guilin West. Pick a morning departure.' }, stops: [
      { n: 'Guilin West → Chongqing West', tag: 'Off-map', ll: null, mode: 'train',
        how: 'DiDi ~25 min from the Sheraton to Guilin West, then the ~4 hr high-speed train.' },
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


  /* ── Route cards ─────────────────────────────────────────────────────────
     Keyed 'day:stopIndex'. Each is a list of legs; a leg is one ride:
       line  { en, zh, c, mode }  colour + name shown on the rail
       board { en, zh }           where to get on (omit = depends where you start)
       dir   { en, zh }           terminus printed on the platform sign / ferry destination
       ride  text                 stops + rough time
       alight{ en, zh }           where to get off
       exit  { code, zh, en }     exit sign to look for (renders the sign replica)
       note  text                 caveat
     Station / terminus names are the official bilingual ones. The signs list
     nearby streets and buildings — wording on the real sign can differ; the
     exit letter/number and the terminus name are what to match. */
  var T = {
    TW:  { en: 'Tsuen Wan Line', zh: '荃灣綫', c: '#e2231a', mode: 'MTR' },
    TC:  { en: 'Tung Chung Line', zh: '東涌綫', c: '#f7943e', mode: 'MTR' },
    DRL: { en: 'Disneyland Resort Line', zh: '迪士尼綫', c: '#f173ac', mode: 'MTR' },
    IL:  { en: 'Island Line', zh: '港島綫', c: '#007dc5', mode: 'MTR' },
    ER:  { en: 'East Rail Line', zh: '東鐵綫', c: '#5eb6e4', mode: 'MTR' },
    TM:  { en: 'Tuen Ma Line', zh: '屯馬綫', c: '#923011', mode: 'MTR' },
    ANY: { en: 'Any MTR line to Central', zh: '', c: '#8a8a99', mode: 'MTR' },
    SF:  { en: 'Star Ferry', zh: '天星小輪', c: '#1d6fb8', mode: 'Ferry' },
    PT:  { en: 'Peak Tram', zh: '山頂纜車', c: '#b04a2e', mode: 'Tram' },
    NP:  { en: 'Ngong Ping 360', zh: '昂坪360', c: '#2f8f5b', mode: 'Cable car' },
    TJ:  { en: 'TurboJET', zh: '噴射飛航', c: '#c8102e', mode: 'Ferry' },
    SH:  { en: 'Free casino shuttle', zh: '免費穿梭巴士', c: '#d8b24a', mode: 'Bus' },
    CQ1: { en: 'Line 1', zh: '1号线', c: '#e4002b', mode: 'Metro' },
    CQ2: { en: 'Line 2', zh: '2号线', c: '#00a651', mode: 'Metro' },
    CQ10:{ en: 'Line 10', zh: '10号线', c: '#8a6fb0', mode: 'Metro' }
  };
  var ROUTES = {
    '1:0': [
      { line: T.IL, board: { en: 'Tin Hau (or Causeway Bay)', zh: '天后 / 銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        ride: '4 stops from Tin Hau (3 from Causeway Bay) · ~10 min', alight: { en: 'Central', zh: '中環' },
        exit: { code: 'J2', zh: '堅尼地道 / 花園道', en: 'Peak Tram · Garden Road' }, note: 'Then ~10–15 min on foot to the tram terminus.' },
      { line: T.PT, board: { en: 'Garden Road Terminus', zh: '花園道總站' }, dir: { en: 'The Peak', zh: '山頂' },
        ride: '~8 min', alight: { en: 'Peak Tower', zh: '凌霄閣' } }
    ],
    '1:2': [
      { line: T.SF, board: { en: 'Central Pier No. 7', zh: '中環7號碼頭' }, dir: { en: 'Tsim Sha Tsui', zh: '尖沙咀' },
        ride: '~10 min · sit on the open lower deck', alight: { en: 'Tsim Sha Tsui Pier', zh: '尖沙咀碼頭' } }
    ],
    '1:3': [
      { line: T.TW, board: { en: 'Tsim Sha Tsui', zh: '尖沙咀' }, dir: { en: 'Tsuen Wan', zh: '荃灣' },
        ride: '1 stop · ~2 min', alight: { en: 'Jordan', zh: '佐敦' },
        exit: { code: 'A', zh: '廟街', en: 'Temple Street' } }
    ],
    '1:4': [
      { line: T.ER, board: { en: 'Admiralty', zh: '金鐘' }, dir: { en: 'Lo Wu / Lok Ma Chau', zh: '羅湖 / 落馬洲' },
        ride: '~30 min', alight: { en: 'Racecourse', zh: '馬場' }, note: 'Racecourse Station only runs on race days — check the fixture list.' }
    ],
    '2:0': [
      { line: T.IL, board: { en: 'Tin Hau (or Causeway Bay)', zh: '天后 / 銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        ride: '4 stops from Tin Hau (3 from Causeway Bay) · ~10 min', alight: { en: 'Central', zh: '中環' },
        note: 'At Central follow the 香港站 Hong Kong Station / Tung Chung Line signs (~5–10 min walk through the connection).' },
      { line: T.TC, board: { en: 'Hong Kong (linked to Central)', zh: '香港' }, dir: { en: 'Tung Chung', zh: '東涌' },
        ride: '~20 min', alight: { en: 'Sunny Bay', zh: '欣澳' } },
      { line: T.DRL, board: { en: 'Sunny Bay', zh: '欣澳' }, dir: { en: 'Disneyland Resort', zh: '迪士尼' },
        ride: '1 stop · ~4 min', alight: { en: 'Disneyland Resort', zh: '迪士尼' }, note: 'Windows and handrails on this train are Mickey-shaped.' }
    ],
    '2:1': [
      { line: T.DRL, board: { en: 'Disneyland Resort', zh: '迪士尼' }, dir: { en: 'Sunny Bay', zh: '欣澳' },
        ride: '1 stop', alight: { en: 'Sunny Bay', zh: '欣澳' } },
      { line: T.TC, board: { en: 'Sunny Bay', zh: '欣澳' }, dir: { en: 'Tung Chung', zh: '東涌' },
        ride: '1 stop', alight: { en: 'Tung Chung', zh: '東涌' }, exit: { code: 'B', zh: '昂坪360', en: 'Ngong Ping 360' } },
      { line: T.NP, board: { en: 'Tung Chung Terminal', zh: '東涌纜車站' }, dir: { en: 'Ngong Ping', zh: '昂坪' },
        ride: '~25 min', alight: { en: 'Ngong Ping Village', zh: '昂坪市集' } }
    ],
    '3:0': [
      { line: T.IL, board: { en: 'Tin Hau (or Causeway Bay)', zh: '天后 / 銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        ride: '5 stops from Tin Hau (4 from Causeway Bay) · ~12 min', alight: { en: 'Sheung Wan', zh: '上環' },
        exit: { code: 'D', zh: '信德中心 / 港澳碼頭', en: 'Shun Tak Centre · Macau Ferry' } },
      { line: T.TJ, board: { en: 'HK–Macau Ferry Terminal', zh: '港澳碼頭' }, dir: { en: 'Macau', zh: '澳門' },
        ride: '~60–70 min', alight: { en: 'Macau Outer Harbour', zh: '外港客運碼頭' },
        note: 'Cotai Water Jet is the alternative and lands at Taipa, closer to the casinos.' }
    ],
    '3:1': [
      { line: T.SH, board: { en: 'Ferry terminal shuttle stop', zh: '碼頭穿梭巴士站' }, dir: { en: 'The Venetian Macao', zh: '澳門威尼斯人' },
        alight: { en: 'The Venetian', zh: '威尼斯人' }, note: 'Look for the shuttle with the Venetian name. Free, no ticket.' }
    ],
    '4:0': [
      { line: T.IL, board: { en: 'Tin Hau (or Causeway Bay)', zh: '天后 / 銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        ride: '3 stops from Tin Hau (2 from Causeway Bay)', alight: { en: 'Admiralty', zh: '金鐘' },
        note: 'Change here to the East Rail Line (follow the 東鐵綫 signs).' },
      { line: T.ER, board: { en: 'Admiralty', zh: '金鐘' }, dir: { en: 'Lo Wu / Lok Ma Chau', zh: '羅湖 / 落馬洲' },
        ride: '2 stops · ~6 min', alight: { en: 'Hung Hom', zh: '紅磡' },
        note: 'Change here to the Tuen Ma Line.' },
      { line: T.TM, board: { en: 'Hung Hom', zh: '紅磡' }, dir: { en: 'Tuen Mun', zh: '屯門' },
        ride: '2 stops · ~5 min', alight: { en: 'Austin', zh: '柯士甸' }, exit: { code: '→', zh: '高鐵', en: 'Express Rail Link' },
        note: 'Follow the 高鐵 Express Rail Link signs to West Kowloon Station. With nine people and luggage, two taxis from the Airbnb (~15–20 min) skip both changes.' }
    ],
    '6:2': [
      { line: T.CQ2, alight: { en: 'Linjiangmen', zh: '临江门' }, ride: 'Direction depends on where you board',
        exit: { code: '2', zh: '洪崖洞', en: 'Hongyadong' }, note: 'Jiefangbei is then ~10 min on foot.' }
    ],
    '7:0': [
      { line: T.CQ2, dir: { en: 'Yudong', zh: '鱼洞' }, ride: 'Heading away from Jiaochangkou 较场口 (the downtown end)',
        alight: { en: 'Liziba', zh: '李子坝' }, note: 'The train runs through the apartment block — stand on the right side for the cliff view.' }
    ],
    '7:3': [
      { line: T.CQ1, dir: { en: 'Bishan', zh: '璧山' }, ride: 'Heading away from Chaotianmen 朝天门 (the downtown end)',
        alight: { en: 'Ciqikou', zh: '磁器口' } }
    ],
    '8:0': [
      { line: T.CQ1, dir: { en: 'Bishan', zh: '璧山' }, ride: 'Heading away from Chaotianmen 朝天门 (the downtown end)',
        alight: { en: 'Ciqikou', zh: '磁器口' } }
    ],
    '8:1': [
      { line: T.CQ2, alight: { en: 'Linjiangmen', zh: '临江门' }, ride: 'Direction depends on where you board',
        exit: { code: '2', zh: '洪崖洞', en: 'Hongyadong' } }
    ],
    '9:0': [
      { line: T.CQ2, dir: { en: 'Yudong', zh: '鱼洞' }, ride: 'Heading away from Jiaochangkou 较场口 (the downtown end)',
        alight: { en: 'Chongqing Zoo', zh: '动物园' }, exit: { code: '1', zh: '重庆动物园', en: 'Chongqing Zoo' } }
    ],
    '9:1': [
      { line: T.CQ1, board: { en: 'Lianglukou (change here)', zh: '两路口' }, dir: { en: 'Bishan', zh: '璧山' },
        alight: { en: 'Eling', zh: '鹅岭' } }
    ],
    '10:1': [
      { line: T.CQ10, alight: { en: 'Grand Hall', zh: '大礼堂' }, exit: { code: '1', zh: '三峡博物馆 / 人民大礼堂', en: 'Three Gorges Museum · Great Hall' },
        ride: 'Direction depends on where you board' }
    ]
  };

  var HOUSE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg>';

  function bi(en, zh, cls) {
    var d = el('div', cls || 'rt-st');
    if (zh) d.appendChild(el('span', 'rt-zh', zh));
    d.appendChild(el('span', 'rt-en', en));
    return d;
  }

  /* The sign to look for — green EXIT block, exit letter/number tile, place name
     (laid out like the MTR exit signs: 出 / EXIT | A | Chinese over English). */
  function exitSign(x) {
    var sign = el('div', 'sign');
    var ex = el('div', 'sign-exit');
    ex.appendChild(el('span', 'sign-chu', '出'));
    ex.appendChild(el('span', 'sign-exit-en', 'EXIT'));
    var code = el('div', 'sign-code', x.code);
    var txt = el('div', 'sign-text');
    txt.appendChild(el('span', 'sign-zh', x.zh));
    txt.appendChild(el('span', 'sign-en', x.en));
    sign.appendChild(ex); sign.appendChild(code); sign.appendChild(txt);
    return sign;
  }

  /* Platform / ferry destination board: line-colour tab + 往 terminus */
  function dirBoard(leg) {
    var b = el('div', 'dirboard');
    b.style.setProperty('--lc', leg.line.c);
    var tab = el('div', 'dirboard-tab', leg.line.zh || leg.line.en);
    var t = el('div', 'dirboard-text');
    t.appendChild(el('span', 'sign-zh', '往 ' + leg.dir.zh));
    t.appendChild(el('span', 'sign-en', 'To ' + leg.dir.en));
    b.appendChild(tab); b.appendChild(t);
    return b;
  }

  function routeCard(legs) {
    var card = el('div', 'rt');
    legs.forEach(function (leg) {
      var d = el('div', 'rt-leg');
      d.style.setProperty('--lc', leg.line.c);
      var head = el('div', 'rt-head');
      head.appendChild(el('span', 'rt-chip', leg.line.mode));
      head.appendChild(el('span', 'rt-line', leg.line.en + (leg.line.zh ? '  ' + leg.line.zh : '')));
      d.appendChild(head);

      if (leg.board && leg.board.en) {
        var r1 = el('div', 'rt-row');
        r1.appendChild(el('span', 'rt-lbl', 'Board'));
        r1.appendChild(bi(leg.board.en, leg.board.zh));
        d.appendChild(r1);
      }
      if (leg.dir) {
        var r2 = el('div', 'rt-row rt-rowfull');
        r2.appendChild(el('span', 'rt-lbl', 'Toward'));
        r2.appendChild(dirBoard(leg));
        d.appendChild(r2);
      }
      if (leg.ride) {
        var r3 = el('div', 'rt-row');
        r3.appendChild(el('span', 'rt-lbl', 'Ride'));
        r3.appendChild(el('div', 'rt-ride', leg.ride));
        d.appendChild(r3);
      }
      if (leg.alight) {
        var r4 = el('div', 'rt-row');
        r4.appendChild(el('span', 'rt-lbl', 'Get off'));
        r4.appendChild(bi(leg.alight.en, leg.alight.zh));
        d.appendChild(r4);
      }
      if (leg.exit) {
        var r5 = el('div', 'rt-row rt-rowfull');
        r5.appendChild(el('span', 'rt-lbl', 'Look for'));
        r5.appendChild(exitSign(leg.exit));
        d.appendChild(r5);
      }
      if (leg.note) d.appendChild(el('div', 'rt-note', leg.note));
      card.appendChild(d);
    });
    return card;
  }

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
    wrap.appendChild(el('p', 'dm-hint', 'Tap a stop to find it on the map. Pins are approximate — confirm the entrance in Amap or Apple Maps. In the stations, match the exit letter and the end-of-line name on the platform sign; wording on real signs can differ slightly.'));
    wrap.appendChild(el('p', 'dm-hint', 'Colored lines show each hop (solid = metro / ferry / tram, dashed = walk or taxi). They are straight-line sketches between pins, not the exact track.'));
    if (day.note) wrap.appendChild(el('p', 'dm-hint dm-warn', day.note));

    var list = el('ol', 'dm-list');
    var items = [];
    var markers = [];
    var pinned = 0;

    var homes = day.home ? [].concat(day.home) : [];
    homes.forEach(function (h, k) {
      h.li = el('li', 'dm-stop home' + (h.ll ? '' : ' nomap'));
      var hn = el('div', 'dm-n');
      hn.innerHTML = HOUSE_SVG;
      h.li.appendChild(hn);
      var hb = el('div');
      var hname = el('div', 'dm-name', h.n);
      if (h.tag) hname.appendChild(el('small', null, h.tag));
      hb.appendChild(hname);
      hb.appendChild(el('div', 'dm-how', h.how));
      h.li.appendChild(hb);
      list.appendChild(h.li);
    });

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
      var legs = ROUTES[wrap.getAttribute('data-day') + ':' + i];
      if (legs) body.appendChild(routeCard(legs));
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
      homes.forEach(function (h, k) {
        h.li.classList.toggle('on', i === 'home' + k);
        if (h.marker) h.marker.getElement().firstChild.classList.toggle('on', i === 'home' + k);
      });
      markers.forEach(function (m, j) {
        if (m) m.getElement() && m.getElement().firstChild.classList.toggle('on', j === i);
      });
      var m = (typeof i === 'string') ? homes[+i.slice(4)].marker : markers[i];
      if (fly && m) map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 15), { duration: .6 });
    }

    homes.forEach(function (h, k) {
      if (!h.ll) return;
      h.marker = L.marker(h.ll, {
        icon: L.divIcon({ className: '', html: '<div class="dm-pin dm-home">' + HOUSE_SVG + '</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
        title: h.n, keyboard: true, zIndexOffset: 500
      }).addTo(map);
      h.marker.on('click', function () {
        select('home' + k, false);
        h.li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      pts.push(h.ll);
    });

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

    // travel lines: one segment per hop (home → stop 1 → stop 2 …), coloured by line/mode.
    // Straight-line sketches between pins, not the exact track. Solid = metro/ferry/tram/cable,
    // dashed = walk / taxi / bus.
    var mappedHomes = homes.filter(function (h) { return h.ll; });
    var prev = mappedHomes.length ? mappedHomes[0].ll : null;
    var SEG = { metro: '#8f8fa3', ferry: '#1d6fb8', train: '#8f8fa3', tram: '#b04a2e', cable: '#2f8f5b', walk: '#b8b4c4', didi: '#e0a030', bus: '#d8b24a' };
    day.stops.forEach(function (s, i) {
      if (!s.ll) return;
      if (prev) {
        var legs = ROUTES[wrap.getAttribute('data-day') + ':' + i];
        var solid = s.mode === 'metro' || s.mode === 'ferry' || s.mode === 'train' || s.mode === 'tram' || s.mode === 'cable';
        var color = (legs && legs[0].line.c) || SEG[s.mode] || day.color;
        var label = (legs ? legs.map(function (l) { return l.line.en; }).join(' → ') : (MODE_LABEL[s.mode] || s.mode));
        L.polyline([prev, s.ll], {
          color: color, weight: solid ? 5 : 3, opacity: s.opt ? .55 : .9,
          dashArray: solid ? null : '3 8', lineCap: 'round'
        }).bindTooltip((i + 1) + '. ' + label, { sticky: true }).addTo(map);
      }
      if (!s.opt) prev = s.ll;
    });

    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [34, 34], maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], 15);

    homes.forEach(function (h, k) {
      if (!h.ll) return;
      h.li.addEventListener('click', function () {
        select('home' + k, true);
        mapDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
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
