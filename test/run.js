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
check('header names the next game, park and host', /Game 21 of 162/.test(T(`renderHeader(); document.getElementById('headerMeta').innerHTML`)) && /Mario Stadium/.test(T(`document.getElementById('headerMeta').innerHTML`)) && /Jason hosts/.test(T(`document.getElementById('headerMeta').innerHTML`)));

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
check('game-20 starters (Petey, Waluigi) cannot pitch game 21; a rested arm can', T(`!canPitch('Petey','jason',21) && !canPitch('Waluigi','dan',21) && canPitch('Boo','jason',21)`));

section('Season pace');
T(`renderSeasonPace()`);
const pace = T(`document.getElementById('trendPace').innerHTML`).replace(/<[^>]+>/g, ' ').replace(/&ndash;/g, '-').replace(/\s+/g, ' ');
check('records 16-4 and 4-16', /16-4/.test(pace) && /4-16/.test(pace), pace.slice(0, 120));
check('projects 130-32', /130-32/.test(pace));
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

// =============================================================================
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join(' | ')); process.exit(1); }
