// FEAT-377: how long a resort takes to load, step by step. Serves the built game (dist/, or SHOT_DIST) and the packs,
// loads the page once in a fresh browser profile (cold: nothing kept) and then reloads it (warm: what the game kept
// between loads), and prints per load: sim ready (window.__sim, the frame loop starting), menu live (the menu's
// crossfade to the live view, Session.ts's `menu settle`: RIDE goes from here), the game's own `load: <step>` measures
// (src/core/loadSteps.ts), the long tasks and the "built data:" lines (src/core/builtData.ts: kept or built, and why).
// At the end: the warm median and what Keep built resort data holds on disk.
// node tools/loadperf.mjs [pack] [--at x,y,headingDeg] [--warm N] [--profile] [--held] [--stale-build] [--json out.json] [--gpu | --headed]
//   --at: the start (default Vail's 1611,-3997,37); the main menu shows over it as in play
//   --warm N: N warm reloads after the cold load (default 2)
//   --profile: sample the JavaScript of the last warm load to sim ready and print the time by task, file and function
//     (build with `npx vite build --sourcemap` so the bundle maps back to src/)
//   --held: what the menu waits on between sim ready and menu live, every 500 ms
//   --expiry: before the first warm load, plants three small entries (used 20 days ago, used now, and one with no
//     `usedAt`) and checks the game deletes the old two once it is up and keeps the fresh one; then saves over an expired
//     entry while an expiry pass runs and checks the save survives (exit 1 if not)
//   --stale-build: the warm loads get the pack's meta.json with another `build` (as after a rebuild of the pack), so
//     what the cold load kept must be thrown away; nothing on disk changes
//   SHOT_QUERY: more URL parameters, as for the other tools. A build without the load marks (main before FEAT-377)
//     reports sim ready as when __sim appeared.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const valued = new Set(['--at', '--warm', '--json']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const pack = positional[0] ?? 'vail';
const at = opt('--at', '1611,-3997,37').split(',').map(Number);
const warm = Number(opt('--warm', 2));
const profile = args.includes('--profile');
const showHeld = args.includes('--held');
const staleBuild = args.includes('--stale-build');
const expiry = args.includes('--expiry');
const jsonOut = opt('--json', null);
let label = 'cold';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u === '/' ? 'index.html' : u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  if (staleBuild && label !== 'cold' && rel === `${pack}/meta.json`) {
    const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
    res.end(JSON.stringify({ ...meta, build: `${meta.build}-rebuilt` }));
    return;
  }
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/index.html?pack=${pack}&x=${at[0]}&y=${at[1]}&h=${at[2]}${process.env.SHOT_QUERY ?? ''}`;

const browser = await launchBrowser(args);
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  window.__longTasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch { /* no long task timing */ }
});
const page = await context.newPage();
const warnings = [];
let built = [];
page.on('pageerror', (e) => warnings.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') warnings.push(`error: ${m.text()}`); else if (m.text().startsWith('built data: ')) built.push(m.text().slice(12)); });

/** one load: navigate, wait for sim ready and the menu going live, then read the timeline */
async function load(cdp) {
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__sim, null, { timeout: 120000, polling: 50 });
  const seen = await page.evaluate(() => performance.now());
  const prof = cdp ? (await cdp.send('Profiler.stop')).profile : null;
  if (showHeld) {
    const held = await page.evaluate(async () => {
      const s = window.__sim, p = s.pack, out = [];
      for (let i = 0; i < 40 && !performance.getEntriesByName('menu settle').length; i++) {
        const tiles = ['fine', 'coarse', 'mid', 'far', 'mask', 'ao', 'dir'].filter((k) => p[k]?.inFlight).map((k) => `${k} ${p[k].inFlight}`);
        out.push(`${Math.round(performance.now())}: terrain ${s.terrain.pending} trees ${s.veg.pending} rocks ${s.rocks.pending} shrubs ${s.shrubs.pending}${tiles.length ? ` tiles ${tiles.join(' ')}` : ''}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      return out;
    });
    console.log(`  menu held by:\n    ${held.join('\n    ')}`);
  }
  await page.waitForFunction(() => performance.getEntriesByName('menu settle').length > 0, null, { timeout: 30000, polling: 100 }).catch(() => {});
  const r = await page.evaluate((seen) => {
    const m = (n) => performance.getEntriesByName(n)[0];
    const settle = m('menu settle');
    return {
      simReady: Math.round(m('load: sim ready')?.startTime ?? seen),
      menuLive: Math.round(settle ? settle.startTime + settle.duration : NaN),
      steps: performance.getEntriesByType('measure').filter((e) => e.name.startsWith('load: ')).map((e) => ({ step: e.name.slice(6), start: Math.round(e.startTime), ms: Math.round(e.duration) })),
      longTasks: window.__longTasks,
    };
  }, seen);
  const lt = r.longTasks.reduce((a, [, d]) => a + d, 0);
  console.log(`\n${label}: sim ready ${r.simReady} ms, menu live ${r.menuLive} ms, long tasks ${r.longTasks.length} = ${lt} ms (over 100 ms: ${r.longTasks.filter(([, d]) => d > 100).map(([t, d]) => `${t} +${d}`).join(', ')})`);
  if (built.length) console.log(`  built data: ${built.join('; ')}`);
  built = [];
  for (const s of r.steps) console.log(`  ${String(s.start).padStart(6)} +${String(s.ms).padStart(5)}  ${s.step}`);
  return { label, ...r, prof };
}

/** --expiry: the game's IndexedDB (src/core/builtData.ts), as test entries or their ids */
const plant = () => page.evaluate(() => new Promise((resolve, reject) => {
  const r = indexedDB.open('built-resort-data');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => {
    const tx = r.result.transaction(['entries', 'used'], 'readwrite'), day = 86400000;
    for (const id of ['test/old', 'test/fresh', 'test/legacy']) tx.objectStore('entries').put({ id, format: 0, key: '', bytes: 8, data: null });
    tx.objectStore('used').put({ id: 'test/old', usedAt: Date.now() - 20 * day });
    tx.objectStore('used').put({ id: 'test/fresh', usedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  };
}));
const testIds = () => page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open('built-resort-data');
  r.onsuccess = () => { const g = r.result.transaction('entries').objectStore('entries').getAllKeys(); g.onsuccess = () => resolve(g.result.filter((k) => k.startsWith('test/'))); };
}));

const runs = [await load(null)];
for (let i = 1; i <= warm; i++) {
  await page.waitForTimeout(3000); // the last load's saves land
  if (expiry && i === 1) await plant();
  label = `warm ${i}`;
  runs.push(await load(i === warm && profile ? await context.newCDPSession(page) : null));
  if (expiry && i === 1) {
    await page.waitForTimeout(6000); // expireBuilt runs 5 s after sim ready
    const left = (await testIds()).sort().join(', ');
    const ok = left === 'test/fresh';
    console.log(`${ok ? 'ok  ' : 'FAIL'} expiry: entries unused ${'>'}= 14 days (and one with no usedAt) deleted, a fresh one kept: left ${left || 'none'}`);
    if (!ok) process.exitCode = 1;
    // a save landing while the expiry pass runs, over an entry that pass would delete
    const raced = await page.evaluate(async () => {
      await new Promise((resolve) => {
        const r = indexedDB.open('built-resort-data');
        r.onsuccess = () => { const tx = r.result.transaction(['entries', 'used'], 'readwrite'); tx.objectStore('entries').put({ id: 'test/racing', format: 0, key: '', bytes: 8, data: null }); tx.objectStore('used').put({ id: 'test/racing', usedAt: Date.now() - 20 * 86400000 }); tx.oncomplete = resolve; };
      });
      const s = window.__sim, pass = s.expireBuilt();
      s.saveBuilt({ what: 'racing', slug: 'test', code: [] }, { saved: 1 });
      await pass;
      return new Promise((resolve) => { const r = indexedDB.open('built-resort-data'); r.onsuccess = () => { const g = r.result.transaction('entries').objectStore('entries').get('test/racing'); g.onsuccess = () => resolve(g.result?.data?.saved === 1); }; });
    });
    console.log(`${raced ? 'ok  ' : 'FAIL'} expiry: a save made while the expiry pass runs is kept`);
    if (!raced) process.exitCode = 1;
  }
}
if (warm > 1) {
  const med = (k) => { const v = runs.slice(1).map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor((v.length - 1) / 2)]; };
  console.log(`\nwarm median of ${warm}: sim ready ${med('simReady')} ms, menu live ${med('menuLive')} ms`);
}
// what Keep built resort data holds now, per entry, and the origin's storage as the browser counts it
const disk = await page.evaluate(() => new Promise((resolve) => {
  const r = indexedDB.open('built-resort-data');
  r.onerror = () => resolve(null);
  r.onsuccess = () => {
    if (!r.result.objectStoreNames.contains('entries')) { resolve(null); return; }
    const g = r.result.transaction('entries').objectStore('entries').getAll();
    g.onsuccess = async () => resolve({ entries: g.result.map((e) => [e.id, e.bytes]), usage: (await navigator.storage.estimate()).usage });
    g.onerror = () => resolve(null);
  };
})).catch(() => null);
if (disk) console.log(`\nbuilt data kept: ${disk.entries.map(([id, b]) => `${id} ${(b / 1048576).toFixed(1)} MB`).join(', ')}; origin storage ${(disk.usage / 1048576).toFixed(1)} MB`);
if (profile) await report(runs[runs.length - 1].prof);
if (warnings.length) console.log(`\n${warnings.length} page errors:\n  ${warnings.slice(0, 10).join('\n  ')}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(runs.map(({ prof, ...r }) => r), null, 1));
await browser.close();
server.close();

/** --profile: sampled time by task (its entry point), by source file and by function with its callers, through dist's source maps */
async function report(p) {
  const { SourceMapConsumer } = await import('source-map-js');
  const maps = new Map();
  const mapFor = (u) => {
    if (!maps.has(u)) {
      let c = null;
      try { const f = path.join(DIST, new URL(u).pathname + '.map'); if (fs.existsSync(f)) c = new SourceMapConsumer(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* not ours */ }
      maps.set(u, c);
    }
    return maps.get(u);
  };
  const ms = new Map(); // node id -> sampled ms
  for (let i = 0; i < p.samples.length; i++) ms.set(p.samples[i], (ms.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
  const byId = new Map(p.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const where = (n) => {
    const cf = n.callFrame;
    let file = cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '') : `(${cf.functionName || 'program'})`, fn = cf.functionName || '(anonymous)';
    const c = cf.url && cf.lineNumber >= 0 && mapFor(cf.url);
    if (c) { const o = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber }); if (o.source) { file = o.source.replace(/^.*?(src\/|node_modules\/)/, '$1'); fn = `${fn} ${path.basename(o.source)}:${o.line}`; } }
    return { file, fn };
  };
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const byTask = new Map(), byFile = new Map(), byFn = new Map(), callers = new Map();
  for (const n of p.nodes) {
    const t = ms.get(n.id); if (!t) continue;
    const up = [];
    for (let id = n.id; id !== undefined; id = parent.get(id)) up.push(byId.get(id));
    const { file, fn } = where(n);
    add(byTask, up.slice(-3, -1).reverse().map((x) => where(x).fn).join(' > ') || fn, t);
    add(byFile, file, t); add(byFn, fn, t);
    if (!callers.has(fn)) callers.set(fn, new Map());
    add(callers.get(fn), up.slice(1, 4).map((x) => where(x).fn).join(' < '), t);
  }
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
  const rows = (m, n) => top(m, n).map(([k, v]) => `  ${v.toFixed(0).padStart(6)} ms  ${k}`).join('\n');
  console.log(`\ntime by task (its entry point, to sim ready):\n${rows(byTask, 25)}\n\nself time by file:\n${rows(byFile, 30)}\n\nby function, with its main callers:`);
  for (const [fn, t] of top(byFn, 30)) console.log(`  ${t.toFixed(0).padStart(6)} ms  ${fn}\n${top(callers.get(fn), 3).map(([k, v]) => `           ${v.toFixed(0).padStart(5)}  < ${k}`).join('\n')}`);
}
