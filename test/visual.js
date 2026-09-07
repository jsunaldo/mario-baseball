#!/usr/bin/env node
// Layout regression checks in a real browser (CI). Serves the repo, opens the
// app at iPad-landscape and phone sizes with the pinned fixture as its data
// (no network: the sync fetch is stubbed), and on every tab asserts:
//   - no horizontal page overflow,
//   - no fixed-count grid ends in a lone orphan tile (the 5+1 rule),
//   - no console errors other than the expected sync 401.
// Screenshots of every tab are written to test/screenshots/ for eyeballing.
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
// Pixel diffs against committed baselines (test/baselines/*.png). Missing
// baseline = no comparison (the screenshot is still uploaded). Run with
// UPDATE_BASELINES=1 to rewrite them.
let PNG, pixelmatch;
try { PNG = require('pngjs').PNG; pixelmatch = require('pixelmatch'); pixelmatch = pixelmatch.default || pixelmatch; } catch { /* optional */ }
const BASE = path.join(__dirname, 'baselines');
const UPDATE = process.env.UPDATE_BASELINES === '1';
const DIFF_TOLERANCE = 0.006; // 0.6% of pixels may differ (fonts, antialiasing)
function compareToBaseline(name, file) {
  if (!PNG || !pixelmatch) return;
  const basePath = path.join(BASE, name + '.png');
  if (UPDATE || !fs.existsSync(basePath)) { fs.mkdirSync(BASE, { recursive: true }); fs.copyFileSync(file, basePath); ok(`${name}: baseline ${UPDATE ? 'updated' : 'created'}`); return; }
  const a = PNG.sync.read(fs.readFileSync(basePath)), b = PNG.sync.read(fs.readFileSync(file));
  if (a.width !== b.width || a.height !== b.height) {
    // Height changes are legitimate when content grows; only flag width changes and note the rest.
    if (a.width !== b.width) fail(`${name}: screenshot width changed ${a.width} -> ${b.width}`); else ok(`${name}: height changed ${a.height} -> ${b.height} (content grew; not compared)`);
    return;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.2 });
  const pct = n / (a.width * a.height);
  if (pct > DIFF_TOLERANCE) { fs.writeFileSync(path.join(OUT, name + '.diff.png'), PNG.sync.write(diff)); fail(`${name}: ${(pct * 100).toFixed(2)}% of pixels differ from baseline (see ${name}.diff.png)`); }
  else ok(`${name}: matches baseline (${(pct * 100).toFixed(2)}% diff)`);
}

const ROOT = path.join(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'league.json'), 'utf8');
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

const TABS = ['gamelog', 'trends', 'teamstats', 'stats', 'injuries', 'players', 'draft', 'rules'];
const GRIDS = '.park-grid, .pace-grid, .summary-row, .mvp-tiles, .award-grid, .draft-picks';
let failures = [];
const fail = (m) => { failures.push(m); console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  for (const vp of [{ name: 'ipad', width: 1194, height: 834 }, { name: 'phone', width: 375, height: 812 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    // No network: the cloud pull returns the pinned fixture, pushes are refused.
    await ctx.route('https://msb-sync.jsunaldo.workers.dev/**', route => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: fixture });
      return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"locked"}' });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(m.text()); });
    await page.goto(base + '/index.html');
    await page.waitForTimeout(2500); // sync pull + reload
    await page.waitForSelector('#leaguesArea .league-block', { timeout: 15000 });
    await page.screenshot({ path: path.join(OUT, `${vp.name}-landing.png`), fullPage: true });
    await page.evaluate(() => selectSeason('S2'));
    await page.waitForTimeout(800);
    for (const tab of TABS) {
      await page.evaluate(t => document.querySelector(`.tab-btn[data-tab="${t}"]`).click(), tab);
      await page.waitForTimeout(400);
      const r = await page.evaluate((gridSel) => {
        const out = { overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, orphans: [] };
        document.querySelectorAll(gridSel).forEach(g => {
          if (!g.offsetParent || getComputedStyle(g).display !== 'grid') return;
          const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length;
          const n = [...g.children].filter(c => c.offsetParent !== null).length;
          if (cols >= 3 && n > cols && n % cols === 1) out.orphans.push(`${g.id || g.className.split(' ')[0]} ${n} items in ${cols} cols`);
        });
        return out;
      }, GRIDS);
      const label = `${vp.name}/${tab}`;
      r.overflow ? fail(`${label}: page scrolls horizontally`) : ok(`${label}: no horizontal overflow`);
      r.orphans.length ? fail(`${label}: orphan grid row — ${r.orphans.join('; ')}`) : ok(`${label}: no orphan grid rows`);
      await page.screenshot({ path: path.join(OUT, `${vp.name}-${tab}.png`), fullPage: true });
      const shot = path.join(OUT, `${vp.name}-${tab}.view.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: shot });
      compareToBaseline(`${vp.name}-${tab}`, shot);
    }
    // Game detail + player page open without errors
    await page.evaluate(() => { showGameDetail(3); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-game-detail.png`) });
    await page.evaluate(() => { closeGameDetail(); showPlayerPage('Boo'); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-player-page.png`) });
    await page.evaluate(() => closeGameDetail());
    errors.length ? fail(`${vp.name}: console/page errors: ${errors.slice(0, 3).join(' | ')}`) : ok(`${vp.name}: no console errors`);
    await ctx.close();
  }
  await browser.close();
  server.close();
  console.log(`\n${failures.length ? failures.length + ' layout check(s) failed' : 'all layout checks passed'}`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
