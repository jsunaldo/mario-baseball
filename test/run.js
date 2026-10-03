#!/usr/bin/env node
// Headless regression tests for the season tracker's math.
//
// Loads the app's inline script into a vm context with a permissive DOM stub,
// seeds localStorage from test/fixtures/league.json, enters a season through the
// app's own selectSeason(), and asserts the invariants that fail silently:
// schedule balance, series counting, the batting qualifier, injury/pitching
// rules, season pace. No browser, no network. Run: node test/run.js
//
// The fixture is a PINNED snapshot (cloud state as of the date in its updatedAt).
// Most checks are invariants and hold for any data; a few are snapshot-bound
// (records 16-4, clinch 66, next game 21, who qualifies). If you refresh the
// fixture from the live worker, expect those to move and update them on purpose
// — a red run after a refresh is the suite doing its job, not a bug.
// Refresh: curl -s https://msb-sync.jsunaldo.workers.dev/ -o test/fixtures/league.json
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/g).map(m => m.slice(8, -9)).sort((a, b) => b.length - a.length)[0];
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'league.json'), 'utf8'));

// ---- DOM stub --------------------------------------------------------------
// One persistent stub per id so innerHTML written by a render can be read back.
const byId = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, dataset: {}, value: '', innerHTML: '', textContent: '', children: [], options: [], files: [],
    classList: { _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); }, remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); } },
    getAttribute() { return null; }, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return makeEl('anon'); }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    closest() { return null; }, appendChild(c) { return c; }, removeChild() {}, remove() {}, focus() {}, click() {},
    insertAdjacentHTML() {}, scrollIntoView() {}, get offsetParent() { return null; },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, scrollWidth: 0, clientWidth: 0,
  };
  return el;
}
const document = {
  getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl(id)); return byId.get(id); },
  querySelector() { return makeEl('anon'); }, querySelectorAll() { return []; },
  createElement(t) { return makeEl('created-' + t); },
  addEventListener() {}, // DOMContentLoaded deliberately never fires
  body: makeEl('body'), documentElement: makeEl('html'),
};
class Storage { constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); } clear() { this.m.clear(); } key(i) { return [...this.m.keys()][i] ?? null; } get length() { return this.m.size; } }

const ctx = {
  document, localStorage: new Storage(), sessionStorage: new Storage(),
  navigator: {}, location: { href: 'http://localhost/', reload() {} }, history: { pushState() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => fixture, text: async () => '' }),
  setTimeout: (f) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, // timers inert: no debounced pushes
  requestAnimationFrame: (f) => 0, confirm: () => true, prompt: () => null, alert() {},
  Image: class { constructor() { this.onload = null; } }, FileReader: class {}, Blob: class {}, URL: { createObjectURL: () => '' },
  performance: { now: () => Date.now() }, innerWidth: 1280, innerHeight: 900, scrollY: 0, scrollTo() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  console, Math, Date, JSON, Object, Array, Number, String, Boolean, RegExp, Error, Map, Set, Promise, Infinity, NaN, isFinite, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
};
ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.dispatchEvent = () => true;
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx, { filename: 'index.html<script>' });

// ---- seed storage from the fixture ----------------------------------------
ctx.localStorage.setItem('marioBaseballSeasons', JSON.stringify(fixture.seasons));
Object.entries(fixture.data).forEach(([id, d]) => ctx.localStorage.setItem('marioBaseball_' + id, JSON.stringify(d)));
ctx.localStorage.setItem('msb_lastSyncAt', fixture.updatedAt);

const T = (expr) => vm.runInContext(expr, ctx);

// ---- tiny test runner --------------------------------------------------------
let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}
function section(t) { console.log('\n' + t); }

// =============================================================================
section('Season 2 — schedule');
T(`selectSeason('S2')`);
check('entered S2', T(`CONFIG.SEASON_ID`) === 'S2');
check('162-game season, 6 stadiums', T(`CONFIG.TOTAL_GAMES`) === 162 && T(`CONFIG.STADIUMS.length`) === 6);

const sched = T(`(() => { const out=[]; for (let n=1;n<=CONFIG.TOTAL_GAMES;n++){ const rec=State.data.games.find(g=>g.gameNumber===n);
  out.push(rec && rec.stadium && rec.home ? {n, stadium:rec.stadium, home:rec.home, played:true} : {n, ...getSchedule(n), played:false}); } return out; })()`);
const homes = {}; const perStad = {};
sched.forEach(s => { homes[s.home] = (homes[s.home] || 0) + 1; perStad[s.stadium] = (perStad[s.stadium] || 0) + 1; });
check('season home/away lands exactly 81/81', homes.jason === 81 && homes.dan === 81, homes);
check('every stadium hosts exactly 27 games', Object.values(perStad).every(v => v === 27), perStad);
check('game 21 is Mario Stadium, Jason hosting (override)', sched[20].stadium === 'Mario Stadium' && sched[20].home === 'jason', sched[20]);
let seriesBad = [];
for (let si = 7; si < 54; si++) { const trio = sched.slice(si * 3, si * 3 + 3);
  if (new Set(trio.map(x => x.stadium)).size !== 1 || new Set(trio.map(x => x.home)).size !== 1) seriesBad.push(si); }
check('every future series (8-54) is one stadium with one host', seriesBad.length === 0, seriesBad);
check('makeup series 12 (games 37-39) is Dan-hosted at Mario Stadium', [37, 38, 39].every(n => sched[n - 1].stadium === 'Mario Stadium' && sched[n - 1].home === 'dan'));
check('stadiums rotate in order each lap', ['Mario Stadium', 'Peach Stadium', 'Wario Palace', 'Yoshi Park', 'DK Jungle', 'Bowser Castle'].every((s, i) => sched[i * 3].stadium === s));
check('override & makeup tables are keyed by season', T(`HOME_MAKEUP_SERIES.S2 === 12 && HOME_OVERRIDE_GAMES.S2[21] === 'jason' && !HOME_MAKEUP_SERIES.S1 && !HOME_OVERRIDE_GAMES.S1`));
check('getNextGameNumber() is 21', T(`getNextGameNumber()`) === 21);
const nextText = T(`renderHeader(); document.getElementById('headerMeta').innerHTML`).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
check('next-game strip names the next game, park and host', /Game 21 of 162/.test(nextText) && /Mario Stadium/.test(nextText) && /Jason hosts/.test(nextText), nextText);

section('Season 2 — series & records');
const sr = T(`computeSeriesResults()`);
check('6 completed series', sr.length === 6, sr.length);
check('Jason won all 6, 3 of them sweeps', sr.every(s => s.winner === 'jason') && sr.filter(s => s.sweep).length === 3);
check('series 6 (Bowser Castle) counted once with mixed hosts in the record', sr[5].stadium === 'Bowser Castle');

section('Season 2 — batting qualifier');
const bar = T(`battingQualifierBar()`);
const teamAB = T(`(() => { const t={jason:0,dan:0}; State.data.games.forEach(g=>Object.entries(g.playerStats||{}).forEach(([k,s])=>{ t[k.slice(0,k.indexOf('_'))]+=s.ab||0; })); return t; })()`);
check('qualifier = team AB / 27-man roster, per owner', Math.abs(bar.jason - teamAB.jason / 27) < 1e-9 && Math.abs(bar.dan - teamAB.dan / 27) < 1e-9, { bar, teamAB });
check('qualifier currently in the high-20s AB range', bar.jason > 20 && bar.jason < 40);
const q = T(`computeBattingStats('all',1,'all','all').filter(s => s.ab >= battingQualifierBar()[s.owner]).sort((a,b)=>(b.hits/b.ab)-(a.hits/a.ab)).map(s=>s.name)`);
check('qualified leader is Waluigi, Boo (42 AB) is in, Green Shy Guy (4 AB) is out', q[0] === 'Waluigi' && q.includes('Boo') && !q.includes('Green Shy Guy'), q.slice(0, 6));

section('AVG input normalisation');
const ra = (v) => T(`readAvgInput({ value: ${JSON.stringify(String(v))} })`);
check('".750" reads as .750', ra('.750') === 0.75);
check('"750" is taken as thousandths', ra('750') === 0.75);
check('"1" (a 1.000 average) is kept', ra('1') === 1);
check('junk above 1000 is rejected', ra('5000') === 0);
check('empty/garbage is 0', ra('') === 0 && ra('abc') === 0);

section('Injury & pitching rules');
const durs = T(`Array.from({length:3000}, () => rollInjuryDuration(1, 30))`);
check('injury duration always within configured 1-30', durs.every(d => d >= 1 && d <= 30) && Math.min(...durs) === 1);
check('duration is weighted short (median under 12)', durs.sort((a, b) => a - b)[1500] < 12, durs[1500]);
check('Luigi (out until 31) is injured for game 21, Yoshi (back at 15) is not', T(`isInjured('Luigi','jason',21) && !isInjured('Yoshi','dan',21)`));
check('injury rule: hurt in 6, out 25 -> misses 7..31, back for 32 (existing data migrated)', T(`(() => { const l = State.data.injuries.find(i => i.player === 'Luigi'); return l.returnGame === 32 && isInjured('Luigi','jason',31) && !isInjured('Luigi','jason',32) && State.data.injuryRuleV2 === true; })()`));
check('injury rule: a 1-game injury after game 10 sits out game 11 only', T(`(() => { const r = injuryReturnGame(10, 1); State.data.injuries.push({ player: 'Mario', owner: 'jason', injuredGame: 10, gamesOut: 1, returnGame: r }); const ok = r === 12 && isInjured('Mario','jason',11) && !isInjured('Mario','jason',12); State.data.injuries.pop(); return ok; })()`));
check('injury migration is idempotent (a second load does not shift again)', T(`(() => { State.save(); State.load(); return State.data.injuries.find(i => i.player === 'Luigi').returnGame === 32; })()`));
check('game-20 starters (Petey, Waluigi) cannot pitch game 21; a rested arm can', T(`!canPitch('Petey','jason',21) && !canPitch('Waluigi','dan',21) && canPitch('Boo','jason',21)`));

section('Season pace');
T(`renderSeasonPace()`);
const pace = T(`document.getElementById('trendPace').innerHTML`).replace(/<[^>]+>/g, ' ').replace(/&ndash;/g, '-').replace(/\s+/g, ' ');
check('record now reads Jason 16 - 4 Dan (one head-to-head tile, not two mirrored ones)', /Jason 16 - 4 Dan/.test(pace), pace.slice(0, 120));
check('projects Jason 130 - 32 Dan', /Jason 130 - 32 Dan/.test(pace));
check('clinch number is 66 (head-to-head: a win is also the trailer\'s loss)', /66 more wins/.test(pace), pace.match(/\d+ more wins?/)?.[0]);
check('trailer must go 77-65 to draw level', /77-65/.test(pace));

section('Season summary guards');
T(`renderSeasonSummary()`);
let sum = T(`document.getElementById('summaryContent').innerHTML`);
check('2-owner summary includes series and biggest win', /Series by stadium/.test(sum) && /Biggest win/.test(sum));
T(`CONFIG.OWNERS.x = { name: 'X', roster: [], color: '#888' }`);
let threw = false; try { T(`renderSeasonSummary()`); } catch (e) { threw = e.message; }
sum = T(`document.getElementById('summaryContent').innerHTML`);
check('3-owner summary renders without throwing', threw === false, threw);
check('3-owner summary skips series & head-to-head sections', !/Series by stadium/.test(sum) && !/Biggest win/.test(sum));
T(`delete CONFIG.OWNERS.x`);

section('Season 1 — history');
T(`selectSeason('S1')`);
check('entered S1 with 100 regular-season games', T(`CONFIG.SEASON_ID`) === 'S1' && T(`CONFIG.TOTAL_GAMES`) === 100);
const s1 = T(`computeSeriesResults()`);
check('S1 has 33 series (lone game 100 is not a series)', s1.length === 33, s1.length);
const s1bad = T(`(() => { const bad=[]; for (let si=0; si<33; si++){ const t=[1,2,3].map(k=>State.data.games.find(g=>g.gameNumber===si*3+k));
  if (new Set(t.map(g=>g.stadium)).size!==1 || new Set(t.map(g=>g.home)).size!==1) bad.push(si); } return bad; })()`);
check('every S1 series was one stadium with one host', s1bad.length === 0, s1bad);
check('no makeup/override leaks into S1', T(`getSchedule(1).home`) === T(`State.data.games.find(g=>g.gameNumber===1).home`));

section('Player page');
T(`selectSeason('S2')`);
let ppThrew = false; try { T(`showPlayerPage('Mario')`); } catch (e) { ppThrew = e.message; }
const pp = T(`document.getElementById('modalBody').innerHTML`) + T(`document.getElementById('modalTitle').innerHTML`);
check('player page renders for Mario without throwing', ppThrew === false, ppThrew);
check('player page shows the season line, splits and ratings', /Average/.test(pp) && /Splits/.test(pp) && /BAT/.test(pp), pp.slice(0, 80));
let ppThrew2 = false; try { T(`showPlayerPage('Yellow Pianta', 'dan')`); } catch (e) { ppThrew2 = e.message; }
check('player page renders for a pitcher with starts', ppThrew2 === false && /As starter/.test(T(`document.getElementById('modalBody').innerHTML`)), ppThrew2);
T(`closeGameDetail()`);

section('Matchup intelligence');
const elo = T(`(() => { const e = computeElo(State.data.games, getOwnerKeys()); return { j: Math.round(e.ratings.jason), d: Math.round(e.ratings.dan), n: e.hist.jason.length }; })()`);
check('Elo is zero-sum around 1500 and tracks every game', Math.abs(elo.j + elo.d - 3000) <= 1 && elo.n === 21, elo);
check('the 16-4 side is rated higher', elo.j > elo.d, elo);
const wp = T(`winProbability('jason', 'dan')`);
check('win probability is a sane favourite for the leader (55-95%)', wp > 0.55 && wp < 0.95, wp);
check('probabilities sum to one across home/away', Math.abs(T(`winProbability('jason','dan') + winProbability('dan','jason')`) - 1) < 0.2);
const mu = T(`matchupCard(getSchedule(21))`);
check('matchup card renders rating, form, park and win probability', /Rating/.test(mu) && /Last 10/.test(mu) && /Mario Stadium/.test(mu) && /win probability/.test(mu));

section('Awards, records, merge, undo');
T(`selectSeason('S2')`);
const aw = T(`seasonAwards()`);
check('season awards include a batting title and MVP leader', aw.some(a => a.award === 'Batting title') && aw.some(a => a.award === 'MVP leader'), aw.map(a => a.award));
const rec = T(`seasonRecords()`);
check('season records include most runs, biggest win and a single-game hits record', ['Most runs, one game', 'Biggest win', 'Most hits, one game'].every(l => rec.some(r => r.label === l)), rec.map(r => r.label));
const mergeRes = T(`(() => {
  const g = (n, savedAt, extra) => Object.assign({ gameNumber: n, home: 'jason', away: 'dan', scores: { jason: 3, dan: 1 }, winner: 'jason', mvp: 'Mario', savedAt }, extra || {});
  const local = { updatedAt: 'a', seasons: [{ id: 'S9', leagueId: 'L1', owners: { jason: {}, dan: {} } }], leagues: [{ id: 'L1' }], tombstones: {},
    data: { S9: { games: [g(1, '2026-01-01T00:00:00Z'), g(2, '2026-01-03T00:00:00Z', { notes: 'local edit' })], lineups: {}, injuries: [{ owner: 'jason', player: 'Mario', injuredGame: 1, gamesOut: 2, returnGame: 3 }], injuryRolls: { 1: true }, deletedGames: { 4: '2026-01-05T00:00:00Z' } } } };
  const cloud = { updatedAt: 'b', seasons: [{ id: 'S9', leagueId: 'L1', owners: { jason: {}, dan: {} } }], leagues: [{ id: 'L1' }], tombstones: {},
    data: { S9: { games: [g(1, '2026-01-01T00:00:00Z'), g(2, '2026-01-02T00:00:00Z', { notes: 'cloud edit' }), g(3, '2026-01-04T00:00:00Z'), g(4, '2026-01-04T00:00:00Z')], lineups: {}, injuries: [{ owner: 'jason', player: 'Mario', injuredGame: 1, gamesOut: 2, returnGame: 3 }, { owner: 'dan', player: 'Bowser', injuredGame: 2, gamesOut: 5, returnGame: 7 }], injuryRolls: { 2: true } } } };
  const m = mergeSnapshots(local, cloud).data.S9;
  return { nums: m.games.map(x => x.gameNumber), g2: m.games.find(x => x.gameNumber === 2).notes, inj: m.injuries.length, rolls: Object.keys(m.injuryRolls).length };
})()`);
check('merge keeps games from both devices and drops the deleted one', mergeRes.nums.join() === '1,2,3', mergeRes);
check('merge: newer save of the same game wins', mergeRes.g2 === 'local edit', mergeRes);
check('merge: injuries dedupe by key, rolls union', mergeRes.inj === 2 && mergeRes.rolls === 2, mergeRes);
const undoRes = T(`(() => { sessionStorage.removeItem(undoKey()); const n = State.data.games.length; pushUndo('test'); State.data.games.push({ gameNumber: 999, home: 'jason', away: 'dan', scores: { jason: 1, dan: 0 }, winner: 'jason', mvp: 'Mario' }); const st = undoStack(); const last = st.pop(); State.data = JSON.parse(last.data); undoWrite(st); return { before: n, after: State.data.games.length, label: last.label }; })()`);
check('undo snapshot restores the season exactly', undoRes.before === undoRes.after && undoRes.label === 'test', undoRes);

section('Story, predictions, audit, time machine');
T(`selectSeason('S2')`);
const story = T(`seasonStory()`).replace(/<[^>]+>/g, ' ');
check('season story names both owners, the record and the pace', /Jason/.test(story) && /Dan/.test(story) && /16–4/.test(story) && /remain/.test(story), story.slice(0, 160));
const pred = T(`(() => { State.data.predictions = {}; setPrediction(99, 'dan', 'jason'); setPredictionScore(99, 'dan', 'jason', 5); setPredictionScore(99, 'dan', 'dan', 2);
  const m = gradePredictions({ gameNumber: 99, winner: 'jason', scores: { jason: 5, dan: 2 } }); const r = predictionRecord('dan'); delete State.data.predictions[99]; return { m: m.map(x => x.kind), r }; })()`);
check('a correct exact-score call grades as exact and records 1/1', pred.m.join() === 'award' && pred.r.n === 1 && pred.r.c === 1 && pred.r.e === 1, pred);
const audit = T(`dataAudit()`);
check('data audit runs and only reports info/warn on the pinned snapshot (no errors)', Array.isArray(audit) && !audit.some(i => i.level === 'error'), audit.filter(i => i.level === 'error'));
T(`trendsAsOf = 10; renderTrends(); trendsAsOf = null;`);
const asOf = T(`document.getElementById('trendPace').innerHTML`).replace(/<[^>]+>/g, ' ').replace(/&ndash;/g, '-').replace(/\s+/g, ' ');
check('time machine renders the season as of game 10 (10 of 162 played)', /10 of 162/.test(asOf), asOf.slice(0, 120));
T(`renderTrends()`);
check('READONLY is off without ?view=readonly', T(`READONLY`) === false);

section('Data safety (2026-10-03)');
T(`selectSeason('S2')`);
check('undo lives in sessionStorage, not the localStorage the season needs', T(`(() => { sessionStorage.removeItem(undoKey()); pushUndo('x'); const ok = !!sessionStorage.getItem(undoKey()) && !localStorage.getItem(undoKey()); sessionStorage.removeItem(undoKey()); return ok; })()`));
check('undo keeps at most 3 steps', T(`(() => { sessionStorage.removeItem(undoKey()); for (let i = 0; i < 6; i++) pushUndo('s' + i); const n = undoStack().length; sessionStorage.removeItem(undoKey()); return n; })()`) === 3);
check('applying cloud data clears every undo stack (an undo can never erase the other device\'s games)', T(`(() => { pushUndo('before pull'); const snap = Sync.snapshot(); Sync.apply(snap); return undoStack().length === 0; })()`));
const und = T(`(() => {
  const cur = JSON.parse(JSON.stringify(State.data));
  const restored = JSON.parse(JSON.stringify(State.data));
  const g5 = restored.games.find(g => g.gameNumber === 5);
  cur.games = cur.games.filter(g => g.gameNumber !== 5); cur.deletedGames = { 5: '2026-01-01T00:00:00.000Z' };   // game 5 was deleted, then undone
  const out = stampUndo(cur, restored);
  const cloud = { games: cur.games, deletedGames: { 5: '2026-01-01T00:00:00.000Z' } };   // the other device already has the delete
  const m = mergeSeasonData(out, cloud);
  return { stamped: !!out.games.find(g => g.gameNumber === 5).savedAt, survives: m.games.some(g => g.gameNumber === 5) };
})()`);
check('undoing a delete survives a merge with a device that saw the delete', und.stamped && und.survives, und);
const delInj = T(`(() => {
  const L = { games: [], deletedGames: { 7: '2026-02-01T00:00:00Z' }, deletedInjuries: { 'jason|Mario|7': '2026-02-01T00:00:00Z' }, injuries: [], injuryRolls: {} };
  const C = { games: [{ gameNumber: 7, home: 'jason', away: 'dan', savedAt: '2026-01-01T00:00:00Z' }], injuries: [{ owner: 'jason', player: 'Mario', injuredGame: 7, gamesOut: 3, returnGame: 11 }], injuryRolls: { 7: true } };
  const m = mergeSeasonData(L, C); return { games: m.games.length, inj: m.injuries.length, rolled: !!m.injuryRolls[7] };
})()`);
check('a deleted game\'s injury and injury roll stay deleted after a merge', delInj.games === 0 && delInj.inj === 0 && !delInj.rolled, delInj);
const delSeason = T(`(() => {
  const local = { updatedAt: 'a', seasons: [], leagues: [], tombstones: { S9: true, league_L9: true }, data: {} };
  const cloud = { updatedAt: 'b', seasons: [{ id: 'S9', leagueId: 'L9', owners: {} }], leagues: [{ id: 'L9' }], tombstones: {}, data: { S9: { games: [] } } };
  const m = mergeSnapshots(local, cloud); return { seasons: m.seasons.length, leagues: m.leagues.length };
})()`);
check('a deleted custom season and league stay deleted after a merge', delSeason.seasons === 0 && delSeason.leagues === 0, delSeason);
const predMerge = T(`(() => {
  const L = { games: [], predictions: { 30: { jason: { winner: 'jason', at: '2026-03-01T00:00:00Z' } } } };
  const C = { games: [], predictions: { 30: { dan: { winner: 'dan', at: '2026-03-01T00:00:05Z' } } } };
  return mergeSeasonData(L, C).predictions[30];
})()`);
check('predictions merge per owner: both calls survive', predMerge && predMerge.jason && predMerge.dan, predMerge);
check('view-only never pushes', T(`Sync.push.toString().includes('if (READONLY) return')`));

section('Leagues');
T(`LeagueManager.migrate()`);
const lgs = T(`LeagueManager.list()`);
check('migration files the Jason/Dan seasons under exactly one league, L1', lgs.length === 1 && lgs[0].id === 'L1', lgs);
check('L1 is a 2-owner league (jason, dan)', T(`Object.keys(LeagueManager.get('L1').owners).join()`) === 'jason,dan');
check('every season carries leagueId L1', T(`SeasonManager.list().every(s => s.leagueId === 'L1')`));
check('migration is idempotent', T(`LeagueManager.migrate(); LeagueManager.list().length`) === 1);
check('cloud snapshot carries the leagues list', T(`Sync.snapshot().leagues.length`) === 1);
check('a league with seasons cannot be deleted', T(`LeagueManager.remove('L1')`) === false);
T(`renderSeasonGrid()`);
const landing = T(`document.getElementById('leaguesArea').innerHTML`);
check('landing renders the league block with both seasons', /Jason &amp; Dan/.test(landing) && (landing.match(/class="season-card"/g) || []).length === 2);

// ---- async: a push must record the revision it sent, not one made mid-flight
(async () => {
  section('Sync push revision');
  const r = await T(`(async () => {
    localStorage.setItem('msb_localRev', 'A');
    const realFetch = fetch;
    fetch = async () => { localStorage.setItem('msb_localRev', 'B'); return { ok: true, status: 200, json: async () => ({}) }; };
    try { await Sync.push(); } finally { fetch = realFetch; }
    return { sent: localStorage.getItem('msb_lastSyncRev'), now: localStorage.getItem('msb_localRev') };
  })()`);
  check('an edit made while a push is in flight is not marked as synced (device stays dirty)', r.sent === 'A' && r.now !== r.sent, r);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
})();
