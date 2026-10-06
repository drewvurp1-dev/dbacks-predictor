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

  /* Raffles City Chongqing, at Chaotianmen where the Yangtze and Jialing meet (Dec 30 – Jan 4). Pin approximate. */
  var CQ_HOTEL = { n: 'Raffles City Chongqing', tag: 'Chaotianmen', ll: [29.5693, 106.5857], mode: 'metro',
    how: 'Your base for the Chongqing days. Chaotianmen station (Line 1) is right here, and the Yangtze–Jialing confluence is outside. The pin is approximate — confirm in Amap.' };

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
    /* Day 4 has two maps: the Hong Kong morning ('4') and the Guilin evening ('4b'). */
    4: { color: HK, home: { n: 'Airbnb check-out', tag: 'Causeway Bay · Dec 28', ll: HOME.ll, mode: 'metro',
      how: 'Check out with all bags. Aim to reach West Kowloon Station about 90 min before the train (arrive early for mainland immigration).' }, stops: [
      { n: 'Admiralty', tag: 'Change to East Rail', ll: [22.2788, 114.1655], mode: 'metro',
        how: 'Island Line from Tin Hau or Causeway Bay toward Kennedy Town. Then follow the 東鐵綫 East Rail Line signs.' },
      { n: 'Hung Hom', tag: 'Change to Tuen Ma', ll: [22.3029, 114.1820], mode: 'metro',
        how: 'East Rail Line under the harbour, 2 stops. Then follow the 屯馬綫 Tuen Ma Line signs.' },
      { n: 'West Kowloon Station', tag: 'High-speed train', ll: [22.3045, 114.1657], mode: 'metro',
        how: 'Tuen Ma Line to Austin, then follow the 高鐵 Express Rail Link signs. With nine people and luggage, two taxis from the Airbnb (~15–20 min) skip both changes.' },
      { n: 'High-speed train → Guilin West', tag: 'Off-map', ll: null, mode: 'train',
        how: '~10:00 departure, ~3–3.5 hrs, direct. You clear mainland immigration at the station, so arrive 90 min early.' }
    ] },
    '4b': { color: GL, noMetro: true, home: GL_HOTEL, stops: [
      { n: 'Guilin West Station → Sheraton', tag: 'Off-map', ll: null, mode: 'didi',
        how: 'The station is ~15 km / 25 min from downtown and Guilin has no metro. Two DiDis or taxis for the group to the Sheraton.' },
      { n: 'Binjiang Road riverside walk', tag: 'Near Elephant Trunk Hill', ll: [25.2680, 110.2990], mode: 'walk',
        how: 'Easy evening stroll along the Li River from the Sheraton; rice noodles (mǐfěn) nearby.' }
    ] },
    5: { color: GL, noMetro: true, home: GL_HOTEL, note: 'Guilin pins are approximate. This day may move to a Yangshuo base — see the calendar notes.', stops: [
      { n: 'Solitary Beauty Peak & Princes\' City', ll: [25.2810, 110.2975], mode: 'didi',
        how: 'DiDi from the Sheraton (~5–10 min). Guilin has no metro.' },
      { n: 'Elephant Trunk Hill', ll: [25.2663, 110.2985], mode: 'walk',
        how: 'Back along the Li River on Binjiang Road — a short walk from the Sheraton, or a quick DiDi.' },
      { n: 'Xianggong Hill (Xingping)', tag: '~1.5 hrs away', ll: [24.9250, 110.5100], mode: 'didi',
        how: 'Two DiDis out, two back — about 1.5 hrs each way, no metro or ferry option. Best in late-afternoon light.' },
      { n: 'Two Rivers & Four Lakes night cruise', tag: 'Sun & Moon Pagodas', ll: [25.2755, 110.2895], mode: 'didi',
        how: 'DiDi back to the lakes (~1.5 hrs). The cruise leaves from the docks near the Sun & Moon Pagodas — confirm the pier when you book for nine.' }
    ] },
    6: { color: CQ, home: [{ n: 'Sheraton Guilin check-out', tag: 'Off-map · Dec 30', ll: null, mode: 'didi',
      how: 'Check out, bags with you, and DiDi ~25 min to Guilin West. Pick a morning departure.' }, CQ_HOTEL], stops: [
      { n: 'Guilin West → Chongqing West', tag: 'Off-map', ll: null, mode: 'train',
        how: 'DiDi ~25 min from the Sheraton to Guilin West, then the ~4 hr high-speed train.' },
      { n: 'Chongqing West Station → Raffles City', tag: 'Off-map', ll: null, mode: 'didi',
        how: 'Metro Line 5 and the Loop line connect here, but with luggage two DiDis is simplest. Raffles City is at Chaotianmen, roughly 30–45 min away.' },
      { n: 'Jiefangbei', ll: [29.5580, 106.5770], mode: 'walk',
        how: 'From Raffles City it is an uphill walk of ~25 min, or a quick DiDi (~5–10 min).' },
      { n: 'Hongyadong, from across the water', ll: [29.5622, 106.5779], mode: 'walk',
        how: 'Walk ~10 min from Jiefangbei. For the full gold-lit view, use Qiansimen Bridge or the opposite bank rather than the crowd inside.' }
    ] },
    7: { color: CQ, home: CQ_HOTEL, stops: [
      { n: 'Liziba Station', tag: 'Line 2 through the building', ll: [29.5521, 106.5317], mode: 'metro',
        how: 'From Raffles City: Line 1 from Chaotianmen two stops to Jiaochangkou, then Line 2 toward Yudong (6 stops). The station is inside a 19-storey apartment block; viewing platform across the street.' },
      { n: 'Yangtze River Cableway', ll: [29.5565, 106.5825], mode: 'didi',
        how: 'DiDi ~15 min (no clean metro link). Go early or buy a timed ticket.' },
      { n: 'Shibati (Eighteen Steps)', ll: [29.5543, 106.5667], mode: 'didi',
        how: 'Short DiDi or ~25 min walk from the cableway.' },
      { n: 'Ciqikou Ancient Town', tag: 'Optional', opt: true, ll: [29.5800, 106.4495], mode: 'metro',
        how: 'Line 1 to Ciqikou Station. Go early, before it packs.' },
      { n: 'Jiangtan Park', tag: 'Drone show', ll: [29.5724, 106.5791], mode: 'metro',
        how: 'Metro or DiDi to the riverside lawns. Pin is approximate — confirm the show location and time locally. Go early; the metro will be jammed afterward.' }
    ] },
    8: { color: CQ, home: CQ_HOTEL, stops: [
      { n: 'Ciqikou Ancient Town', ll: [29.5800, 106.4495], mode: 'metro',
        how: 'Line 1 from Chaotianmen (at Raffles City) straight to Ciqikou Station (磁器口站) — no change.' },
      { n: 'Hongyadong', tag: 'On foot this time', ll: [29.5622, 106.5779], mode: 'metro',
        how: 'Line 2 to Linjiangmen (临江门站), Exit 2 — via Line 1 to Jiaochangkou from Raffles City — or just walk (~25 min). Walk it top to bottom, then stay for the lights at dusk.' }
    ] },
    9: { color: CQ, home: CQ_HOTEL, stops: [
      { n: 'Chongqing Zoo', ll: [29.5060, 106.5160], mode: 'metro',
        how: 'From Raffles City: Line 1 to Daping, change to Line 2 toward Yudong, then Zoo Station (动物园站), Exit 1 — it lets out right at the gate.' },
      { n: 'Eling Park', tag: '瞰胜楼 viewing building', ll: [29.5512, 106.5267], mode: 'metro',
        how: 'From the Zoo, Line 2 toward Jiaochangkou to Daping, then change to Line 1 for one stop to Eling Station (鹅岭站).' },
      { n: 'Erchang Creative Park', ll: [29.5462, 106.5290], mode: 'walk',
        how: 'Right next to Eling Park — a short walk.' }
    ] },
    10: { color: CQ, home: CQ_HOTEL, stops: [
      { n: 'Jiefangbei', tag: 'Suits', ll: [29.5580, 106.5770], mode: 'walk',
        how: 'From Raffles City, an uphill walk of ~25 min or a quick DiDi.' },
      { n: 'Three Gorges Museum', ll: [29.5617, 106.5467], mode: 'metro',
        how: 'From Raffles City: Line 1 three stops to Qixinggang, change to Line 10 for one stop to Grand Hall Station (大礼堂站), Exit 1.' },
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
  function SL(pairs) { return pairs.map(function (p) { return { zh: p[0], en: p[1] }; }); }
  /* Station order along each MTR line (official bilingual names). Used to draw the
     stop-by-stop strip between where you board and where you get off. */
  var ST = {
    IL: SL([['堅尼地城','Kennedy Town'],['香港大學','HKU'],['西營盤','Sai Ying Pun'],['上環','Sheung Wan'],['中環','Central'],['金鐘','Admiralty'],['灣仔','Wan Chai'],['銅鑼灣','Causeway Bay'],['天后','Tin Hau'],['炮台山','Fortress Hill'],['北角','North Point'],['鰂魚涌','Quarry Bay'],['太古','Tai Koo'],['西灣河','Sai Wan Ho'],['筲箕灣','Shau Kei Wan'],['杏花邨','Heng Fa Chuen'],['柴灣','Chai Wan']]),
    TW: SL([['中環','Central'],['金鐘','Admiralty'],['尖沙咀','Tsim Sha Tsui'],['佐敦','Jordan'],['油麻地','Yau Ma Tei'],['旺角','Mong Kok'],['太子','Prince Edward'],['深水埗','Sham Shui Po'],['長沙灣','Cheung Sha Wan'],['荔枝角','Lai Chi Kok'],['美孚','Mei Foo'],['荔景','Lai King'],['葵芳','Kwai Fong'],['葵興','Kwai Hing'],['大窩口','Tai Wo Hau'],['荃灣','Tsuen Wan']]),
    TC: SL([['香港','Hong Kong'],['九龍','Kowloon'],['奧運','Olympic'],['南昌','Nam Cheong'],['荔景','Lai King'],['青衣','Tsing Yi'],['欣澳','Sunny Bay'],['東涌','Tung Chung']]),
    DRL: SL([['欣澳','Sunny Bay'],['迪士尼','Disneyland Resort']]),
    ER: SL([['金鐘','Admiralty'],['會展','Exhibition Centre'],['紅磡','Hung Hom'],['旺角東','Mong Kok East'],['九龍塘','Kowloon Tong'],['大圍','Tai Wai'],['沙田','Sha Tin'],['火炭','Fo Tan'],['馬場','Racecourse']]),
    TM: SL([['紅磡','Hung Hom'],['尖東','East Tsim Sha Tsui'],['柯士甸','Austin']]),
    // Chongqing — station order checked against two Chongqing metro maps (the newer one also confirms Line 1 runs Chaotianmen ↔ Bishan)
    CQ1: SL([['朝天门','Chaotianmen'],['小什字','Xiaoshizi'],['较场口','Jiaochangkou'],['七星岗','Qixinggang'],['两路口','Lianglukou'],['鹅岭','Eling'],['大坪','Daping'],['石油路','Shiyou Road'],['歇台子','Xietaizi'],['石桥铺','Shiqiaopu'],['高庙村','Gaomiaocun'],['马家岩','Majiayan'],['小龙坎','Xiaolongkan'],['沙坪坝','Shapingba'],['杨公桥','Yanggongqiao'],['烈士墓','Martyrs Cemetery'],['磁器口','Ciqikou']]),
    CQ10: SL([['七星岗','Qixinggang'],['大礼堂','Chongqing People\'s Auditorium'],['曾家岩','Zengjiayan']]),
    CQ2: SL([['较场口','Jiaochangkou'],['临江门','Linjiangmen'],['黄花园','Huanghuayuan'],['大溪沟','Daxigou'],['曾家岩','Zengjiayan'],['牛角沱','Niujiaotuo'],['李子坝','Liziba'],['佛图关','Fotuguan'],['大坪','Daping'],['袁家岗','Yuanjiagang'],['谢家湾','Xiejiawan'],['杨家坪','Yangjiaping'],['动物园','Chongqing Zoo']])
  };
  /* Station wall colours differ station by station; only ones confirmed from a photo are
     listed here — everything else falls back to the line colour. */
  var TILE = { 'Central': '#b3191b' };

  var T = {
    TW:  { en: 'Tsuen Wan Line', zh: '荃灣綫', c: '#e2231a', mode: 'MTR', all: ST.TW },
    TC:  { en: 'Tung Chung Line', zh: '東涌綫', c: '#f7943e', mode: 'MTR', all: ST.TC },
    DRL: { en: 'Disneyland Resort Line', zh: '迪士尼綫', c: '#f173ac', mode: 'MTR', all: ST.DRL },
    IL:  { en: 'Island Line', zh: '港島綫', c: '#007dc5', mode: 'MTR', all: ST.IL },
    ER:  { en: 'East Rail Line', zh: '東鐵綫', c: '#5eb6e4', mode: 'MTR', all: ST.ER },
    TM:  { en: 'Tuen Ma Line', zh: '屯馬綫', c: '#923011', mode: 'MTR', all: ST.TM },
    ANY: { en: 'Any MTR line to Central', zh: '', c: '#8a8a99', mode: 'MTR' },
    SF:  { en: 'Star Ferry', zh: '天星小輪', c: '#1d6fb8', mode: 'Ferry' },
    PT:  { en: 'Peak Tram', zh: '山頂纜車', c: '#b04a2e', mode: 'Tram' },
    NP:  { en: 'Ngong Ping 360', zh: '昂坪360', c: '#2f8f5b', mode: 'Cable car' },
    TJ:  { en: 'TurboJET', zh: '噴射飛航', c: '#c8102e', mode: 'Ferry' },
    SH:  { en: 'Free casino shuttle', zh: '免費穿梭巴士', c: '#d8b24a', mode: 'Bus' },
    CQ1: { en: 'Line 1', zh: '1号线', c: '#d4001a', mode: 'Metro', all: ST.CQ1 },
    CQ2: { en: 'Line 2', zh: '2号线', c: '#0a8f45', mode: 'Metro', all: ST.CQ2 },
    CQ10:{ en: 'Line 10', zh: '10号线', c: '#6a3a8f', mode: 'Metro', all: ST.CQ10 }
  };
  var ROUTES = {
    '1:0': [
      { line: T.IL, board: { en: 'Tin Hau', zh: '天后' }, alt: { en: 'Causeway Bay', zh: '銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        seg: ['Tin Hau', 'Central'], min: '~10 min', alight: { en: 'Central', zh: '中環' },
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
        seg: ['Tsim Sha Tsui', 'Jordan'], min: '~2 min', alight: { en: 'Jordan', zh: '佐敦' },
        exit: { code: 'A', zh: '廟街', en: 'Temple Street' } }
    ],
    '1:4': [
      { line: T.ER, board: { en: 'Admiralty', zh: '金鐘' }, dir: { en: 'Lo Wu / Lok Ma Chau', zh: '羅湖 / 落馬洲' },
        seg: ['Admiralty', 'Racecourse'], min: '~30 min', alight: { en: 'Racecourse', zh: '馬場' }, note: 'Racecourse Station only runs on race days — check the fixture list.' }
    ],
    '2:0': [
      { line: T.IL, board: { en: 'Tin Hau', zh: '天后' }, alt: { en: 'Causeway Bay', zh: '銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        seg: ['Tin Hau', 'Central'], min: '~10 min', alight: { en: 'Central', zh: '中環' },
        note: 'At Central follow the 香港站 Hong Kong Station / Tung Chung Line signs (~5–10 min walk through the connection).' },
      { line: T.TC, board: { en: 'Hong Kong', zh: '香港' }, dir: { en: 'Tung Chung', zh: '東涌' },
        seg: ['Hong Kong', 'Sunny Bay'], min: '~20 min', alight: { en: 'Sunny Bay', zh: '欣澳' } },
      { line: T.DRL, board: { en: 'Sunny Bay', zh: '欣澳' }, dir: { en: 'Disneyland Resort', zh: '迪士尼' },
        seg: ['Sunny Bay', 'Disneyland Resort'], min: '~4 min', alight: { en: 'Disneyland Resort', zh: '迪士尼' }, note: 'Windows and handrails on this train are Mickey-shaped.' }
    ],
    '2:1': [
      { line: T.DRL, board: { en: 'Disneyland Resort', zh: '迪士尼' }, dir: { en: 'Sunny Bay', zh: '欣澳' },
        seg: ['Disneyland Resort', 'Sunny Bay'], alight: { en: 'Sunny Bay', zh: '欣澳' } },
      { line: T.TC, board: { en: 'Sunny Bay', zh: '欣澳' }, dir: { en: 'Tung Chung', zh: '東涌' },
        seg: ['Sunny Bay', 'Tung Chung'], alight: { en: 'Tung Chung', zh: '東涌' }, exit: { code: 'B', zh: '昂坪360', en: 'Ngong Ping 360' } },
      { line: T.NP, board: { en: 'Tung Chung Terminal', zh: '東涌纜車站' }, dir: { en: 'Ngong Ping', zh: '昂坪' },
        ride: '~25 min', alight: { en: 'Ngong Ping Village', zh: '昂坪市集' } }
    ],
    '3:0': [
      { line: T.IL, board: { en: 'Tin Hau', zh: '天后' }, alt: { en: 'Causeway Bay', zh: '銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        seg: ['Tin Hau', 'Sheung Wan'], min: '~12 min', alight: { en: 'Sheung Wan', zh: '上環' },
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
      { line: T.IL, board: { en: 'Tin Hau', zh: '天后' }, alt: { en: 'Causeway Bay', zh: '銅鑼灣' }, dir: { en: 'Kennedy Town', zh: '堅尼地城' },
        seg: ['Tin Hau', 'Admiralty'], min: '~8 min', alight: { en: 'Admiralty', zh: '金鐘' },
        note: 'Change here to the East Rail Line (follow the 東鐵綫 signs).' }
    ],
    '4:1': [
      { line: T.ER, board: { en: 'Admiralty', zh: '金鐘' }, dir: { en: 'Lo Wu / Lok Ma Chau', zh: '羅湖 / 落馬洲' },
        seg: ['Admiralty', 'Hung Hom'], min: '~6 min', alight: { en: 'Hung Hom', zh: '紅磡' },
        note: 'Change here to the Tuen Ma Line.' }
    ],
    '4:2': [
      { line: T.TM, board: { en: 'Hung Hom', zh: '紅磡' }, dir: { en: 'Tuen Mun', zh: '屯門' },
        seg: ['Hung Hom', 'Austin'], min: '~5 min', alight: { en: 'Austin', zh: '柯士甸' }, exit: { code: '→', zh: '高鐵', en: 'Express Rail Link' },
        note: 'Follow the 高鐵 Express Rail Link signs to West Kowloon Station.' }
    ],
    '7:0': [
      { line: T.CQ1, board: { en: 'Chaotianmen', zh: '朝天门' }, dir: { en: 'Bishan', zh: '璧山' },
        seg: ['Chaotianmen', 'Jiaochangkou'], min: '~5 min', alight: { en: 'Jiaochangkou', zh: '较场口' },
        note: 'Change here to Line 2. Chaotianmen station is right at Raffles City.' },
      { line: T.CQ2, board: { en: 'Jiaochangkou', zh: '较场口' }, dir: { en: 'Yudong', zh: '鱼洞' },
        seg: ['Jiaochangkou', 'Liziba'], min: '~12 min', alight: { en: 'Liziba', zh: '李子坝' },
        note: 'The train runs through the apartment block — stand on the right side for the cliff view.' }
    ],
    '7:3': [
      { line: T.CQ1, dir: { en: 'Bishan', zh: '璧山' }, ride: 'Heading away from Chaotianmen 朝天门 (the downtown end)',
        alight: { en: 'Ciqikou', zh: '磁器口' } }
    ],
    '8:0': [
      { line: T.CQ1, board: { en: 'Chaotianmen', zh: '朝天门' }, dir: { en: 'Bishan', zh: '璧山' },
        seg: ['Chaotianmen', 'Ciqikou'], min: '~35 min', alight: { en: 'Ciqikou', zh: '磁器口' },
        note: 'Direct, no change — Chaotianmen station is right at Raffles City. Older maps show Jiandingpo 尖顶坡 as the west end; either way it is the train heading away from downtown.' }
    ],
    '8:1': [
      { line: T.CQ1, board: { en: 'Chaotianmen', zh: '朝天门' }, dir: { en: 'Bishan', zh: '璧山' },
        seg: ['Chaotianmen', 'Jiaochangkou'], min: '~5 min', alight: { en: 'Jiaochangkou', zh: '较场口' },
        note: 'Change here to Line 2. (Or skip the metro and walk ~25 min from Raffles City.)' },
      { line: T.CQ2, board: { en: 'Jiaochangkou', zh: '较场口' }, dir: { en: 'Yudong', zh: '鱼洞' },
        seg: ['Jiaochangkou', 'Linjiangmen'], min: '~3 min', alight: { en: 'Linjiangmen', zh: '临江门' },
        exit: { code: '2', zh: '洪崖洞', en: 'Hongyadong' } }
    ],
    '9:0': [
      { line: T.CQ1, board: { en: 'Chaotianmen', zh: '朝天门' }, dir: { en: 'Bishan', zh: '璧山' },
        seg: ['Chaotianmen', 'Daping'], min: '~15 min', alight: { en: 'Daping', zh: '大坪' },
        note: 'Change here to Line 2 (follow the 2号线 signs).' },
      { line: T.CQ2, board: { en: 'Daping', zh: '大坪' }, dir: { en: 'Yudong', zh: '鱼洞' },
        seg: ['Daping', 'Chongqing Zoo'], min: '~10 min', alight: { en: 'Chongqing Zoo', zh: '动物园' },
        exit: { code: '1', zh: '重庆动物园', en: 'Chongqing Zoo' } }
    ],
    '9:1': [
      { line: T.CQ2, board: { en: 'Chongqing Zoo', zh: '动物园' }, dir: { en: 'Jiaochangkou', zh: '较场口' },
        seg: ['Chongqing Zoo', 'Daping'], min: '~10 min', alight: { en: 'Daping', zh: '大坪' },
        note: 'Change here to Line 1 (follow the 1号线 signs).' },
      { line: T.CQ1, board: { en: 'Daping', zh: '大坪' }, dir: { en: 'Chaotianmen', zh: '朝天门' },
        seg: ['Daping', 'Eling'], min: '~3 min', alight: { en: 'Eling', zh: '鹅岭' },
        note: 'Older maps show Xiaoshizi 小什字 as the east end — same direction, toward downtown.' }
    ],
    '10:1': [
      { line: T.CQ1, board: { en: 'Chaotianmen', zh: '朝天门' }, dir: { en: 'Bishan', zh: '璧山' },
        seg: ['Chaotianmen', 'Qixinggang'], min: '~8 min', alight: { en: 'Qixinggang', zh: '七星岗' },
        note: 'Change here to Line 10.' },
      { line: T.CQ10, board: { en: 'Qixinggang', zh: '七星岗' }, dir: { en: 'Wangjiazhuang', zh: '王家庄' },
        seg: ['Qixinggang', 'Chongqing People\'s Auditorium'], min: '~2 min', alight: { en: 'Chongqing People\'s Auditorium', zh: '大礼堂' },
        exit: { code: '1', zh: '三峡博物馆 / 人民大礼堂', en: 'Three Gorges Museum · Great Hall' },
        note: 'Take the northbound Line 10 train — it is the next stop after Qixinggang.' }
    ]
  };

  var HOUSE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg>';

  function ink(c) {
    var m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return '#fff';
    var n = parseInt(m[1], 16);
    return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) > 150 ? '#14131c' : '#fff';
  }

  /* The sign to look for at the exit — green EXIT block, exit letter/number tile,
     place name (laid out like the MTR exit signs: 出 / EXIT | A | Chinese over English). */
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

  /* Station-name wall — tiled mosaic, big white Chinese over bold English, like the
     station walls (e.g. 中環 / Central). */
  function wallSign(st, line) {
    var w = el('div', 'wall');
    var tile = TILE[st.en] || line.c;
    w.style.setProperty('--tile', tile);
    w.style.setProperty('--wt', ink(tile));
    if (st.zh) w.appendChild(el('span', 'wall-zh', st.zh));
    w.appendChild(el('span', 'wall-en', st.en));
    return w;
  }

  /* Stops between board and get-off (inclusive), in travel order. */
  function legStops(leg) {
    if (!leg.seg || !leg.line.all) return null;
    var all = leg.line.all, a = -1, b = -1;
    all.forEach(function (st, i) { if (st.en === leg.seg[0]) a = i; if (st.en === leg.seg[1]) b = i; });
    if (a < 0 || b < 0 || a === b) return null;
    return a < b ? all.slice(a, b + 1) : all.slice(b, a + 1).reverse();
  }

  /* Platform-sign panel (after the signs above the platform): terminus header + stop strip. */
  function platformSign(leg, stops) {
    var p = el('div', 'plat');
    p.style.setProperty('--lc', leg.line.c);
    if (leg.dir) {
      var head = el('div', 'plat-head');
      head.appendChild(el('span', 'plat-zh', '往 ' + leg.dir.zh));
      head.appendChild(el('span', 'plat-en', 'to ' + leg.dir.en));
      p.appendChild(head);
    }
    if (stops) {
      var body = el('div', 'plat-body');
      var top = el('div', 'plat-top');
      var nm = el('div', 'plat-line');
      if (leg.line.zh) nm.appendChild(el('span', 'plat-line-zh', leg.line.zh));
      nm.appendChild(el('span', 'plat-line-en', leg.line.en));
      top.appendChild(nm);
      top.appendChild(el('span', 'plat-meta', (stops.length - 1) + ' stop' + (stops.length === 2 ? '' : 's') + (leg.min ? ' · ' + leg.min : '')));
      body.appendChild(top);
      var ol = el('ol', 'strip');
      stops.forEach(function (st, i) {
        var role = i === 0 ? 'start' : (i === stops.length - 1 ? 'end' : 'mid');
        var isAlt = leg.alt && st.en === leg.alt.en && role === 'mid';
        var li = el('li', 'st ' + role + (isAlt ? ' alt' : ''));
        li.appendChild(el('span', 'st-dot'));
        var t = el('div', 'st-t');
        t.appendChild(el('b', 'st-zh', st.zh));
        t.appendChild(el('span', 'st-en', st.en));
        li.appendChild(t);
        if (role === 'start') li.appendChild(el('span', 'st-tag', 'Board here'));
        else if (role === 'end') li.appendChild(el('span', 'st-tag', 'Get off here'));
        else if (isAlt) li.appendChild(el('span', 'st-tag soft', 'Or board here'));
        ol.appendChild(li);
      });
      body.appendChild(ol);
      p.appendChild(body);
    }
    return p;
  }

  var TAKE = { 'MTR': 'Take this train', 'Metro': 'Take this train', 'Ferry': 'Take this ferry', 'Tram': 'Take this tram', 'Cable car': 'Take this cable car', 'Bus': 'Take this shuttle' };

  function block(label, node) {
    var b = el('div', 'rt-blk');
    b.appendChild(el('div', 'rt-lbl', label));
    b.appendChild(node);
    return b;
  }

  function routeLeg(leg) {
    var d = el('div', 'rt-leg');
    d.style.setProperty('--lc', leg.line.c);
    d.style.setProperty('--li', ink(leg.line.c));

    // the line / vehicle to look for — big
    var take = el('div', 'rt-take');
    take.appendChild(el('div', 'rt-lbl', TAKE[leg.line.mode] || 'Take'));
    var ban = el('div', 'rt-banner');
    if (leg.line.zh) ban.appendChild(el('span', 'rt-bn-zh', leg.line.zh));
    ban.appendChild(el('span', 'rt-bn-en', leg.line.en));
    take.appendChild(ban);
    d.appendChild(take);

    if (leg.board && leg.board.en) {
      var bb = el('div');
      bb.appendChild(wallSign(leg.board, leg.line));
      if (leg.alt) bb.appendChild(el('div', 'rt-alt', 'Or board at ' + leg.alt.en + (leg.alt.zh ? ' ' + leg.alt.zh : '') + ' — one stop later.'));
      d.appendChild(block('Board at', bb));
    }

    var stops = legStops(leg);
    if (leg.dir || stops) d.appendChild(block('Head toward', platformSign(leg, stops)));
    else if (leg.ride) d.appendChild(block('Ride', el('div', 'rt-ride', leg.ride)));
    if (stops === null && leg.dir && leg.ride) d.appendChild(el('div', 'rt-ride rt-ride-inline', leg.ride));

    if (leg.alight) d.appendChild(block('Get off at', wallSign(leg.alight, leg.line)));
    if (leg.exit) d.appendChild(block('Look for this exit sign', exitSign(leg.exit)));
    if (leg.note) d.appendChild(el('div', 'rt-note', leg.note));
    return d;
  }

  /* Collapsible: the summary row says which lines, from where to where; open for the steps. */
  function routeCard(legs) {
    var fold = el('details', 'rt-fold');
    var sum = el('summary', 'rt-sum');
    var pills = el('span', 'rt-sum-pills');
    legs.forEach(function (l) {
      var pl = el('span', 'rt-sum-pill', l.line.en);
      pl.style.background = l.line.c; pl.style.color = ink(l.line.c);
      pills.appendChild(pl);
    });
    sum.appendChild(pills);
    var first = legs[0], last = legs[legs.length - 1];
    var route = (first.board ? first.board.en : '') + (first.board ? ' → ' : '→ ') + (last.alight ? last.alight.en : '');
    var meta = '';
    if (legs.length === 1) {
      var st = legStops(first);
      meta = st ? (st.length - 1) + ' stop' + (st.length === 2 ? '' : 's') + (first.min ? ' · ' + first.min : '') : (first.ride || '');
    } else {
      meta = legs.length + ' legs';
    }
    var info = el('span', 'rt-sum-info');
    info.appendChild(el('span', 'rt-sum-route', route));
    if (meta) info.appendChild(el('span', 'rt-sum-meta', meta));
    sum.appendChild(info);
    var act = el('span', 'rt-sum-act');
    act.appendChild(el('span', 'act-closed', 'Show steps'));
    act.appendChild(el('span', 'act-open', 'Hide steps'));
    sum.appendChild(act);
    fold.appendChild(sum);

    var card = el('div', 'rt');
    legs.forEach(function (leg) { card.appendChild(routeLeg(leg)); });
    fold.appendChild(card);
    return fold;
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
      li.addEventListener('click', function (e) {
        // taps inside the directions card (Show/Hide steps, signs) must not jump to the map
        if (e.target.closest && e.target.closest('.rt-fold')) return;
        select(i, true);
        mapDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    addMetro(map, mapDiv, wrap, wrap.getAttribute('data-day'), day);

    // the map may be built while hidden / before layout settles
    setTimeout(function () { map.invalidateSize(); }, 250);
  }


  /* ── Metro network overlay ───────────────────────────────────────────────
     Real line geometry + stations from OpenStreetMap (Overpass), fetched by the visitor's
     browser the first time a map is opened and then kept in localStorage, so it keeps
     working offline. Nothing here is hand-drawn. The public Overpass servers are often busy,
     so: lines are fetched via *ways* (fast, indexed) with the owning relations only for
     name/colour, several mirrors are tried in turn, and a failure says why and can be retried. */
  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  var METRO_TTL = 30 * 24 * 3600 * 1000;
  var CACHE_PREFIX = 'dm-metro-v2:';

  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && Date.now() - o.t < METRO_TTL) ? o.d : null;
    } catch (e) { return null; }
  }
  function cachePut(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); } catch (e) { /* quota / private mode */ }
  }

  function hostOf(url) { return url.replace(/^https?:\/\//, '').split('/')[0]; }

  /* POST an Overpass query, trying each mirror in turn. Rejects with a readable reason. */
  function fetchOverpass(query) {
    var reasons = [];
    function attempt(i) {
      if (i >= OVERPASS.length) return Promise.reject(new Error(reasons.join(' · ')));
      var ctl = ('AbortController' in window) ? new AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, 28000) : null;
      var host = hostOf(OVERPASS[i]);
      return fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl ? ctl.signal : undefined })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json().catch(function () { throw new Error('bad response'); });
        })
        .then(function (json) {
          if (json && json.remark && /error|timed out|out of memory/i.test(json.remark) && !(json.elements && json.elements.length)) {
            throw new Error('server busy');
          }
          return json;
        })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          reasons.push(host + ': ' + (err && err.name === 'AbortError' ? 'timed out' : (err && err.message === 'Failed to fetch' ? 'network blocked' : (err && err.message) || 'failed')));
          return attempt(i + 1);
        });
    }
    return attempt(0);
  }

  function r5(n) { return Math.round(n * 1e5) / 1e5; }

  /* Ways (geometry) + their relations (name/colour) → [{name, colour, paths}], grouped by line. */
  function parseLines(json) {
    var ways = [], wayRel = {};
    (json.elements || []).forEach(function (e) {
      if (e.type === 'way' && e.geometry && e.geometry.length > 1) {
        ways.push(e);
      } else if (e.type === 'relation' && e.tags) {
        (e.members || []).forEach(function (m) {
          if (m.type === 'way') (wayRel[m.ref] = wayRel[m.ref] || []).push(e);
        });
      }
    });
    var groups = {}, order = [];
    ways.forEach(function (w) {
      var rels = wayRel[w.id] || [];
      var rel = null;
      rels.forEach(function (r) { if (!rel && (r.tags.colour || r.tags.color)) rel = r; });
      if (!rel && rels.length) rel = rels[0];
      var t = rel ? rel.tags : (w.tags || {});
      var name = (t['name:en'] || t.name || t.ref || 'Metro line').split(':')[0].replace(/\s*[(（].*$/, '').trim();
      var colour = t.colour || t.color || '';
      var key = name + '|' + colour;
      if (!groups[key]) { groups[key] = { name: name, colour: colour, paths: [] }; order.push(key); }
      groups[key].paths.push(w.geometry.map(function (g) { return [r5(g.lat), r5(g.lon)]; }));
    });
    return order.map(function (k) { return groups[k]; });
  }

  function parseStations(json) {
    var out = [], seen = {};
    (json.elements || []).forEach(function (e) {
      if (e.type !== 'node' || !e.tags || !e.tags.name) return;
      var key = e.tags.name + '|' + e.lat.toFixed(4) + '|' + e.lon.toFixed(4);
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ ll: [r5(e.lat), r5(e.lon)], name: e.tags['name:en'] ? e.tags.name + ' · ' + e.tags['name:en'] : e.tags.name });
    });
    return out;
  }

  function cssColour(c) {
    return (/^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]{3,20}$/i.test(c)) ? c : '#8f8fa3';
  }

  function addMetro(map, mapDiv, wrap, dayNum, day) {
    var legend = el('div', 'dm-legend');
    wrap.insertBefore(legend, mapDiv.nextSibling);
    if (day.noMetro) {
      legend.appendChild(el('span', 'dm-leg-note', 'Guilin has no metro — this day is on foot, DiDi and taxis.'));
      return;
    }
    if (!map.getPane('metro')) { map.createPane('metro'); map.getPane('metro').style.zIndex = 380; }
    var group = L.layerGroup().addTo(map);
    var stationGroup = L.layerGroup();
    var on = true;
    var btn = el('button', 'dm-toggle on', 'Metro lines');
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'true');
    btn.addEventListener('click', function () {
      on = !on;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      legend.classList.toggle('off', !on);
      if (on) { group.addTo(map); syncStations(); } else { map.removeLayer(group); map.removeLayer(stationGroup); }
    });
    legend.appendChild(btn);
    var list = el('span', 'dm-leg-list');
    legend.appendChild(list);

    function syncStations() {
      if (!on) return;
      if (map.getZoom() >= 14) stationGroup.addTo(map); else map.removeLayer(stationGroup);
    }
    map.on('zoomend', syncStations);

    function draw(data) {
      group.clearLayers(); stationGroup.clearLayers();
      var uniq = {};
      data.lines.forEach(function (ln) {
        var col = cssColour(ln.colour);
        ln.paths.forEach(function (p) {
          L.polyline(p, { color: col, weight: 4, opacity: .85, pane: 'metro', interactive: false }).addTo(group);
        });
        if (!uniq[ln.name]) uniq[ln.name] = col;
      });
      (data.stations || []).forEach(function (st) {
        L.circleMarker(st.ll, { radius: 4, color: '#222', weight: 1.5, fillColor: '#fff', fillOpacity: 1, pane: 'metro' })
          .bindTooltip(st.name, { direction: 'top' }).addTo(stationGroup);
      });
      list.textContent = '';
      var names = Object.keys(uniq).sort();
      if (!names.length) { list.textContent = 'No metro data for this area.'; return; }
      names.forEach(function (n) {
        var chip = el('span', 'dm-leg-chip');
        var sw = el('i'); sw.style.background = uniq[n];
        chip.appendChild(sw); chip.appendChild(document.createTextNode(n));
        list.appendChild(chip);
      });
      syncStations();
    }

    // bbox of what the map is showing, padded a little
    var b = map.getBounds().pad(0.1);
    var bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(function (n) { return n.toFixed(4); }).join(',');
    var key = CACHE_PREFIX + dayNum + ':' + bbox;

    function load() {
      var cached = cacheGet(key);
      if (cached) { draw(cached); return; }
      list.textContent = 'Loading metro lines…';

      // 1) track: ways in view, plus the relations they belong to (for name + colour only)
      var qLines = '[out:json][timeout:40];' +
        'way["railway"~"^(subway|light_rail|monorail)$"](' + bbox + ')->.w;' +
        'rel(bw.w)["route"~"^(subway|light_rail|monorail)$"]->.r;' +
        '.w out geom(' + bbox + ');.r out body;';
      // 2) stations (small, optional)
      var qStations = '[out:json][timeout:25];' +
        'node["railway"="station"]["station"~"^(subway|light_rail|monorail)$"](' + bbox + ');out;';

      fetchOverpass(qLines).then(function (json) {
        var data = { lines: parseLines(json), stations: [] };
        draw(data);
        if (data.lines.length) cachePut(key, data);
        return fetchOverpass(qStations).then(function (sj) {
          data.stations = parseStations(sj);
          draw(data);
          if (data.lines.length) cachePut(key, data);
        }).catch(function () { /* stations are optional */ });
      }).catch(function (err) {
        list.textContent = '';
        list.appendChild(el('span', 'dm-leg-err', 'Couldn’t load metro lines (' + ((err && err.message) || 'no connection') + ').'));
        var retry = el('button', 'dm-retry', 'Retry');
        retry.type = 'button';
        retry.addEventListener('click', load);
        list.appendChild(retry);
      });
    }
    load();
  }

  function init() {
    var wraps = document.querySelectorAll('.daymap-wrap');
    for (var i = 0; i < wraps.length; i++) build(wraps[i]);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
