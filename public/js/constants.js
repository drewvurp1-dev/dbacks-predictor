// Pure data + configuration constants. No DOM, no S, no fetch — safe to import
// from anywhere. Add new shared constants here rather than re-declaring them
// in feature modules.

// ── Season ──────────────────────────────────────────────────────────────────
// All MLB Stats API + Baseball Savant queries pin the season explicitly so
// stat splits don't bleed across years mid-fetch. Bump once at year roll-over
// and every fetch URL across app.js + pitcher.js follows.
export const SEASON = 2026;

// ── Monte Carlo edge-stability gate ──────────────────────────────────────────
// Minimum monteCarloConfidence (% of sims where the edge holds) for a bet to
// qualify as recommended. Shared by _getTopBets (player stars / auto-save) and
// the dashboard best-bets strip so both agree on what qualifies.
//
// Tuned for the two-channel MC (score + rate-model uncertainty). The prior
// score-only MC saturated near 100%, so its gate sat at 85; the wider, honest
// distribution needs a lower bar to admit the same caliber of edge (~2–3pp for
// well-sampled bats, more for small samples — which is the intended behavior).
// NOTE: this is a modeled estimate — re-tune empirically once enough graded
// bets accumulate to measure hit-rate by MC bucket (see renderCalibration).
export const MC_CONFIDENCE_MIN = 75;

// ── Roster ───────────────────────────────────────────────────────────────────
export const CORBET_ROSTER = [
  { name: 'Corbin Carroll',   id: '682998' },
  { name: 'Ketel Marte',      id: '606466' },
  { name: 'Gabriel Moreno',   id: '672515' },
  { name: 'Geraldo Perdomo',  id: '672695' },
  { name: 'Ildemaro Vargas',  id: '545121' },
  { name: 'Lourdes Gurriel',  id: '666971' },
  { name: 'Nolan Arenado',    id: '571448' },
];

// ── Sportsbook config ───────────────────────────────────────────────────────
export const BOOK_ABBREVS = {
  'DraftKings':'DK',
  'BetMGM':'MGM',
  'Caesars':'CZR',
  'Hard Rock Bet':'HR',
  'Hard Rock Bet (OH)':'HR',
  'theScore Bet':'ESPN',
};
// Only these books contribute to devig calc, best-price tracking, and the
// status banner. Books outside the set are filtered out before processing.
export const ALLOWED_BOOKS = new Set(Object.keys(BOOK_ABBREVS));

// ── Pitch types ─────────────────────────────────────────────────────────────
export const PITCH_TYPES = ['4-Seam FB','Sinker','Cutter','Slider','Curveball','Changeup','Splitter'];

// Statcast pitch-code → display name. Used by pitch-matchup rendering and the
// pitch-matchup factor (predict.js) when surfacing the most-impactful pitch.
export const PITCH_NAMES = { FF:'4-seam', SI:'sinker', FC:'cutter', SL:'slider', ST:'sweeper', CU:'curve', CH:'change', FS:'splitter', SV:'slurve', KC:'knuckle-curve' };

// ── Props ───────────────────────────────────────────────────────────────────
export const PROP_NAMES = {
  'batter_hits':'Hits','batter_total_bases':'Total Bases',
  'batter_rbis':'RBI','batter_walks':'Walks','batter_strikeouts':'Strikeouts',
  'batter_runs_scored':'Runs','batter_hits_runs_rbis':'H+R+RBI',
};

// ── Umpire database (zone tendency + run-impact estimate) ───────────────────
export const UMP_DB = {
  'Doug Eddings':    {tendency:'pitcher',adj:-2,note:'Pitcher-friendly zone — calls extra strikes'},
  'CB Bucknor':      {tendency:'hitter', adj: 3,note:'Tight zone — more walks, hitter-friendly'},
  'Laz Diaz':        {tendency:'hitter', adj: 2,note:'Below-average called strike rate'},
  'Bill Miller':     {tendency:'pitcher',adj:-2,note:'Expanded zone — pitcher advantage'},
  'Angel Hernandez': {tendency:'neutral',adj: 0,note:'Inconsistent zone, high variance'},
  'Jeff Nelson':     {tendency:'pitcher',adj:-3,note:'Consistently expanded zone, pitcher-friendly CSW'},
  'Joe West':        {tendency:'pitcher',adj:-2,note:'Large strike zone, extra called strikes'},
  'Mark Wegner':     {tendency:'pitcher',adj:-1,note:'Slight pitcher lean, below-average walk rate'},
  'Alan Porter':     {tendency:'hitter', adj: 2,note:'Tight zone — above-average walk environment'},
  'Gabe Morales':    {tendency:'neutral',adj:-1,note:'Slightly expanded zone on the corners'},
  'Brian Gorman':    {tendency:'neutral',adj: 0,note:'Neutral, consistent zone'},
  'Jerry Meals':     {tendency:'hitter', adj: 2,note:'Tight zone, above-average walk totals'},
  'Alfonso Marquez': {tendency:'neutral',adj: 0,note:'Average zone consistency'},
  'Mike Winters':    {tendency:'pitcher',adj:-2,note:'Expanded zone, extra called strikes'},
  'Todd Tichenor':   {tendency:'neutral',adj: 0,note:'League-average called strike rate'},
  'Chris Guccione':  {tendency:'hitter', adj: 1,note:'Slightly tight zone, mild hitter lean'},
  'Dan Iassogna':    {tendency:'neutral',adj: 0,note:'Consistent, neutral zone'},
  'Larry Vanover':   {tendency:'hitter', adj: 2,note:'Tight strike zone — more ball calls'},
  'Sam Holbrook':    {tendency:'pitcher',adj:-1,note:'Slightly expanded zone'},
  'Adrian Johnson':  {tendency:'neutral',adj: 0,note:'Average zone, high strike call rate'},
  'Rob Drake':       {tendency:'pitcher',adj:-2,note:'Below-average walk rate — wide zone'},
  'Quinn Wolcott':   {tendency:'neutral',adj: 0,note:'No significant zone bias on record'},
  'Chad Fairchild':  {tendency:'hitter', adj: 2,note:'Below-average called strike rate, high walk environment'},
  'Marvin Hudson':   {tendency:'pitcher',adj:-1,note:'Slight zone expansion, pitcher lean'},
  'Ted Barrett':     {tendency:'neutral',adj: 0,note:'Neutral zone, league-average consistency'},
  'Stu Scheurwater': {tendency:'hitter', adj: 1,note:'Slightly tight zone on the edges'},
  'Jim Reynolds':    {tendency:'neutral',adj: 0,note:'Neutral zone, no significant lean'},
  'Lance Barrett':   {tendency:'neutral',adj: 0,note:'Average zone, consistent calls'},
  'Jansen Visconti': {tendency:'neutral',adj: 0,note:'No significant zone bias on record'},
  'Roberto Ortiz':   {tendency:'neutral',adj: 0,note:'Average zone, no meaningful tendency'},
  'Ryan Additon':    {tendency:'pitcher',adj:-1,note:'Slight zone expansion, below-average walk rate'},
};

// ── MLB venue display-name map ──────────────────────────────────────────────
export const VENUE_MAP = {
  'Chase Field':'Chase Field (PHX)','Dodger Stadium':'Dodger Stadium (LAD)',
  'Coors Field':'Coors Field (COL)','Oracle Park':'Oracle Park (SF)',
  'Petco Park':'Petco Park (SD)','Wrigley Field':'Wrigley Field (CHC)',
  'Oriole Park at Camden Yards':'Camden Yards (BAL)','Busch Stadium':'Busch Stadium (STL)',
  'T-Mobile Park':'T-Mobile Park (SEA)','Fenway Park':'Fenway Park (BOS)',
  'Yankee Stadium':'Yankee Stadium (NYY)','Citi Field':'Citi Field (NYM)',
  'Great American Ball Park':'Great American (CIN)','PNC Park':'PNC Park (PIT)',
  'Globe Life Field':'Globe Life Field (TEX)',
  'Minute Maid Park':'Minute Maid Park (HOU)',
  'loanDepot park':'loanDepot Park (MIA)','loanDepot Park':'loanDepot Park (MIA)',
  'American Family Field':'American Family Field (MIL)',
  'Rogers Centre':'Rogers Centre (TOR)',
  'Tropicana Field':'Tropicana Field (TB)',
  'Truist Park':'Truist Park (ATL)',
  'Nationals Park':'Nationals Park (WSH)',
  'Citizens Bank Park':'Citizens Bank Park (PHI)',
  'Kauffman Stadium':'Kauffman Stadium (KC)',
  'Target Field':'Target Field (MIN)',
  'Angel Stadium':'Angel Stadium (LAA)',
  'Progressive Field':'Progressive Field (CLE)',
  'Comerica Park':'Comerica Park (DET)',
  'Guaranteed Rate Field':'Guaranteed Rate Field (CWS)',
  'Sutter Health Park':'Sutter Health Park (OAK)',
};

// ── Stat tooltip definitions (title + good/avg/bad bands + note) ────────────
export const STAT_INFO = {
  // ── Batter slash ──
  BA:    { title:'Batting Avg (H ÷ AB)',           good:'≥ .290',   avg:'~ .245',  bad:'≤ .220' },
  OBP:   { title:'On-Base % (H+BB+HBP ÷ PA)',      good:'≥ .360',   avg:'~ .315',  bad:'≤ .290' },
  SLG:   { title:'Slugging % (TB ÷ AB)',           good:'≥ .470',   avg:'~ .400',  bad:'≤ .350' },
  OPS:   { title:'On-base + Slugging',             good:'≥ .830',   avg:'~ .715',  bad:'≤ .640', note:'Elite ≥ .900' },
  WOBA:  { title:'wOBA — weighted On-Base Average', good:'≥ .370',  avg:'~ .320',  bad:'≤ .290', note:'Reconstructed from season counting stats with standard linear weights' },
  BABIP: { title:'BA on Balls in Play',            good:'≥ .340',   avg:'~ .295',  bad:'≤ .270', note:'Above .340 may signal luck; below .270, bad luck' },
  ABHR:  { title:'At-bats per HR (lower = power)', good:'≤ 18',     avg:'30 – 40', bad:'50+',    note:'Elite power: ≤ 15' },
  // ── Batter discipline ──
  BBPCT: { title:'Walk Rate (BB ÷ PA)',            good:'≥ 10%',    avg:'~ 8.5%',  bad:'≤ 6%',   note:'Elite eye: 12%+' },
  KPCT_B:{ title:'Strikeout Rate (K ÷ PA)',        good:'≤ 16%',    avg:'~ 22%',   bad:'≥ 25%',  note:'Lower is better' },
  BBK:   { title:'BB/K Ratio — plate discipline',  good:'≥ 0.50',   avg:'~ 0.40',  bad:'≤ 0.25', note:'Elite: ≥ 0.80' },
  IBB:   { title:'Intentional Walks',              body:'Context stat — common for sluggers with weak protection behind them.' },
  HBP:   { title:'Hit By Pitch',                   body:'Context stat — league leaders typically reach 15–25/yr.' },
  SAC:   { title:'Sacrifice Bunts + Flies',        body:'Context stat — lineup-role driven.' },
  // ── Batter power ──
  HR:    { title:'Home Runs',                      good:'35+ (slugger)', avg:'15 – 25', bad:'< 10',  note:'Elite: 45+ per season' },
  D2B:   { title:'Doubles',                        good:'≥ 35',     avg:'20 – 30', bad:'< 15' },
  D3B:   { title:'Triples (rare)',                 body:'Most players: 1–3/yr. 5+ indicates speed/gap power.' },
  XBH:   { title:'Extra-Base Hits (HR+2B+3B)',     good:'≥ 75',     avg:'45 – 55', bad:'< 30',  note:'Elite: 75+' },
  RBI:   { title:'Runs Batted In',                 good:'≥ 90',     avg:'60 – 80', bad:'< 40',  note:'Lineup-spot dependent · Elite: 100+' },
  SB:    { title:'Stolen Bases',                   good:'≥ 20',     avg:'5 – 10',  bad:'< 3',   note:'Elite: 30+' },
  // ── Batter Statcast ──
  XWOBA: { title:'xwOBA — quality-of-contact offense', good:'≥ .360', avg:'~ .320', bad:'≤ .300' },
  XBA:   { title:'xBA — expected BA from EV + LA',     good:'≥ .280', avg:'~ .245', bad:'≤ .220' },
  XSLG:  { title:'xSLG — expected SLG from EV + LA',   good:'≥ .480', avg:'~ .405', bad:'≤ .360' },
  BARREL_B:{ title:'Barrel Rate (optimal EV + LA)',    good:'≥ 10%',  avg:'~ 7%',   bad:'≤ 4%' },
  HH_B:  { title:'Hard-Hit Rate (95+ mph EV)',         good:'≥ 45%',  avg:'~ 38%',  bad:'≤ 35%' },
  EV_B:  { title:'Average Exit Velocity',              good:'≥ 92 mph', avg:'~ 88.5 mph', bad:'≤ 86 mph' },
  SWEET: { title:'Sweet-Spot % (8–32° launch angle)',  good:'≥ 40%',  avg:'~ 33%',  bad:'≤ 28%' },
  WHIFF_B:{ title:'Whiff Rate (whiffs ÷ swings)',      good:'≤ 20%',  avg:'~ 25%',  bad:'≥ 30%', note:'Lower is better' },
  GB_B:  { title:'Ground-Ball Rate',                   body:'League avg: ~43%. Higher GB = more singles, fewer XBH.' },
  FB_B:  { title:'Fly-Ball Rate',                      body:'League avg: ~36%. Higher FB = more HR potential but more outs.' },
  BATSPD:{ title:'Bat Speed (Statcast 2024+)',         good:'≥ 75 mph', avg:'~ 71 mph', bad:'≤ 68 mph' },
  SQDUP: { title:'Squared-Up % per Contact',           good:'≥ 22%',  avg:'~ 17%',  bad:'≤ 12%' },
  BLAST: { title:'Blast % — squared-up + fast swing',  good:'≥ 8%',   avg:'~ 5%',   bad:'≤ 3%' },
  // ── Pitcher Statcast (vs hitters) ──
  WHIFF_P:{ title:'Whiff Rate per Pitch',          good:'≥ 30%',     avg:'~ 25%',     bad:'≤ 20%',     note:'Higher is better for pitcher' },
  KPCT_P:{ title:'Strikeout Rate (K ÷ BF)',        good:'≥ 25%',     avg:'~ 22%',     bad:'≤ 18%',     note:'Elite: ≥ 30%' },
  PUTAWAY:{ title:'Put-Away % (K per 2-strike pitch)', good:'≥ 22%', avg:'~ 18%',     bad:'≤ 15%' },
  GB_P:  { title:'Ground-Ball Rate Induced',       good:'≥ 50%',     avg:'~ 43%',     bad:'≤ 38%',     note:'Higher = fewer XBH' },
  FB_P:  { title:'Fly-Ball Rate Induced',          body:'League avg: ~36%. Lower is better for pitcher.' },
  BARREL_VS:{ title:'Barrels Allowed',             good:'≤ 4%',      avg:'~ 7%',      bad:'≥ 10%',     note:'Lower is better' },
  HH_VS: { title:'Hard Contact Allowed (95+ mph)', good:'≤ 35%',     avg:'~ 38%',     bad:'≥ 45%' },
  EV_VS: { title:'Avg Exit Velo Allowed',          good:'≤ 86 mph',  avg:'~ 88.5 mph', bad:'≥ 92 mph' },
  XWOBA_VS:{ title:'xwOBA Against',                good:'≤ .300',    avg:'~ .320',    bad:'≥ .360' },
  XERA:  { title:'xERA — Expected ERA from EV/LA', good:'≤ 3.50',    avg:'~ 4.20',    bad:'≥ 5.00' },
  // ── Pitcher season ──
  ERA:   { title:'Earned Run Average (ER × 9 ÷ IP)', good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 5.00', note:'Ace: ≤ 3.00' },
  FIP:   { title:'FIP — Fielding-Independent Pitching', good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Strips defense/luck — better than ERA' },
  XFIP:  { title:'xFIP — FIP w/ league HR/FB rate',  good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Strips out HR luck' },
  SIERA: { title:'SIERA — Skill-Interactive ERA',    good:'≤ 3.50', avg:'~ 4.20', bad:'≥ 4.50', note:'Most predictive ERA estimator' },
  WHIP:  { title:'Walks + Hits per IP',              good:'≤ 1.10', avg:'~ 1.30', bad:'≥ 1.40', note:'Elite: ≤ 1.00' },
  KBBPCT:{ title:'K-BB % — strikeout minus walk rate', good:'≥ 15%', avg:'~ 13%', bad:'≤ 8%',  note:'Strongest single-stat K predictor · Elite: ≥ 20%' },
  HR9:   { title:'Home Runs Allowed per 9 IP',       good:'≤ 0.90', avg:'~ 1.20', bad:'≥ 1.50' },
  BBPCT_P:{ title:'Walk Rate (BB ÷ BF)',             good:'≤ 6%',   avg:'~ 8.5%', bad:'≥ 10%' },
  IP:    { title:'Innings Pitched',                  body:'Counting stat — role-dependent (starter vs reliever).' },
  K9:    { title:'Strikeouts per 9 IP',              good:'≥ 9.0',  avg:'~ 8.5',  bad:'≤ 6.5', note:'Elite: ≥ 11.0' },
  GS:    { title:'Games Started',                    body:'Counting stat.' },
};

// ── Default factor weights ──────────────────────────────────────────────────
export const DEFAULT_WEIGHTS = {
  // Batter splits — adj = (ops − 0.720) × weight (0.720 ≈ league avg OPS)
  'vs LHP': 70, 'vs RHP': 70,
  'Home':   35, 'Away':   35,

  // Career matchup vs current pitcher — adj capped ±6
  'vs Pitcher (career)': 50,

  // Opposing pitcher headline metric — adj = (trueERA − 4.00) × weight.
  // Unified label so learning isn't split across SIERA/xFIP/FIP/ERA depending on
  // which advanced metric was available for that pitcher. The specific metric
  // used appears in the factor's `value` field instead.
  'Pitcher Quality': 4,

  // Pitcher regression / quality flags (flat adj)
  'Unlucky Pitcher': -2, 'Lucky Pitcher':  2,
  'Elite K-BB%':     -4, 'Poor K-BB%':     3,
  'HR-prone':         3, 'HR Suppressor': -2,

  // Pitcher rest / workload (flat)
  'Short Rest': 3, 'Extra Rest': -2,
  'High Prev PC': 2, 'Bullpen Game': 7,

  // Batter plate discipline (flat)
  'BB%': 3, 'K%': -3,

  // Batter recent form — last-5 hot/cold streak, raw adj capped ±6
  'Recent Form': 5,

  // Batter Statcast (single label used for both directions — weight scales magnitude symmetrically)
  'Whiff%': 3, 'xwOBA': 4, 'GB%': -2, 'FB%': 2,

  // Pitcher Statcast — Pitcher Whiff% weight bumped from 3 → 4 so it matches
  // the typical |adj| magnitude (elite case fires at -4, poor case at +3).
  'Pitcher Whiff%': 4, 'Pitcher GB%': -2, 'xwOBA vs': 3,

  // Weather (Heat/Cold flat; wind uses mph-scaled coefficient inside add — weight=1 keeps default)
  'Heat': 4, 'Cold': -4,
  'Wind Out': 1, 'Wind In': -1,
  'Crosswind': -2, 'High Humidity': -1, 'Roof Closed': -2,

  // Park
  'Altitude': 8, 'Elevation': 3,
  'Hitter Park': 1, 'Pitcher Park': 1,

  // Travel
  'Red-Eye': -6, 'Same-Day Travel': -3,

  // Umpire (weight=1 means apply UMP_DB adj as-is)
  'Umpire': 1,

  // Lineup protection
  'Protection': 3,
};

// ── localStorage keys (versioned suffix lets us migrate schemas) ────────────
export const ODDS_CACHE_KEY      = 'corbetOddsCache';
export const GRADE_LOG_KEY       = 'gradeLog_v1';
export const FACTOR_PERF_KEY     = 'factorPerf_v1';
export const FACTOR_WEIGHTS_KEY  = 'factorWeights_v1';
export const PENDING_KEY         = 'pendingPredictions_v1';
export const SYNC_KEY_STORAGE    = 'corbetSyncKey';
export const SYNC_LAST_TS_KEY    = 'corbetLastSync';

// ── Model self-calibration (learns from graded bets in S.betLog) ─────────────
// calibrate.js fits a per-prop Platt correction on the model's Over probability
// and re-tunes the score↔rate blend weight, both from graded bet outcomes. The
// fitted params persist here and auto-apply to live predictions once enough
// graded samples accumulate (shrunk toward identity / default below threshold).
export const CALIBRATION_KEY      = 'calibration_v1';   // { propKey:{a,b,n}, _global:{a,b,n} }
export const BLEND_WEIGHTS_KEY    = 'blendWeights_v1';  // { propKey: w }
export const DEFAULT_BLEND_W       = 0.25;  // score-component weight; rate model gets (1 − W)
export const MIN_CAL_SAMPLE        = 25;    // settled bets for a prop before its own Platt fit
export const MIN_GLOBAL_CAL_SAMPLE = 40;    // pooled settled bets before the global Platt fallback
export const MIN_BLEND_SAMPLE      = 40;    // instrumented+settled bets before re-tuning the blend
export const CAL_PRIOR_LAMBDA      = 8;     // L2 pull of Platt (a,b) toward identity (1,0)
export const BLEND_PRIOR_N         = 60;    // pseudo-count pulling a fitted blend toward DEFAULT_BLEND_W
