// FEAT-086: frame cost in real play. The game runs its own requestAnimationFrame loop (no ?headless), from the
// main menu's Ride button to riding, in a browser with vsync and the frame-rate cap off, so the frame interval is
// what the CPU and GPU allow, not the display. Nothing is read back from the canvas. Off screen (headless by
// default), so a window in front of it cannot throttle it.
// node tools/playperf.mjs [pack] [--at x,y,headingDeg] [--seconds 10] [--ablate] [--variants <file.json>] [--vsync] [--profile <out.json>] [--heap <out.json>] [--gpu | --headed]
//   (after `npx vite build`; for readable names in --profile build with `npx vite build --minify false --outDir dist-prof`
//    and run with SHOT_DIST=dist-prof)
// Two windows, each after a restart at the spot once nothing is loading: "stand" (no input; the rider may slide)
// and "tuck" (ArrowUp held). Per window: frame interval median / p95 / p99 / max and frames over 33 ms; main-thread
// time per frame (the game's requestAnimationFrame callbacks) and its share per system (terrain, trees, render
// submit, ...: their methods on window.__sim timed in place); draw calls, triangles, chunks, tree instances, JS heap.
// The frame cap is turned off for the run (High: tools/browser.mjs seeds it on the GPU, FEAT-374), so the interval is what the GPU allows.
// Slow frames (over 33 ms) are matched against what changed in them: new shader programs, geometries, textures, tree
// repacks and cells, decoded tiles, terrain builds. --ablate then poses the eye camera at the spot and times the frame
// with each scene group hidden in turn, and without the shadow map pass (the cost of each, GPU included).
// --profile also samples the JavaScript during the tuck and writes the top functions by self time.
// --heap <out.json> (BUG-090) runs V8's sampling heap profiler from page load and, after a forced garbage collection
// at the end, prints what is still held by the function that allocated it and by the game file and line under it
// (build with --minify false, as for --profile, for names). The heap is always read after a forced collection too.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const valued = new Set(['--at', '--seconds', '--profile', '--heap', '--variants']);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const pack = positional[0] ?? 'vail';
const seconds = Number(opt('--seconds', 10));
const at = opt('--at', null)?.split(',').map(Number) ?? null;
const profileOut = opt('--profile', null);
const heapOut = opt('--heap', null);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u === '/' ? 'index.html' : u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const vsync = args.includes('--vsync');
// vsync off: the frame interval is what the CPU and GPU allow (medians, --ablate); --vsync: frames paced by the display
// as in play, for the stutter (with vsync off the page can queue frames faster than the GPU presents them, which adds stalls)
const browser = await launchBrowser(args, [...(vsync ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']), '--enable-precise-memory-info']);
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const warnings = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => warnings.push(`pageerror: ${e.message}`));
// main-thread time per frame: every requestAnimationFrame callback, summed per frame
await page.addInitScript(() => {
  const w = window, raf = w.requestAnimationFrame.bind(w);
  w.__rafMs = 0;
  w.requestAnimationFrame = (cb) => raf((t) => { const a = performance.now(); try { cb(t); } finally { w.__rafMs += performance.now() - a; } });
});
// a CDP session from the start: the forced collection before the heap read, and --heap's sampling from page load
const cdpHeap = await page.context().newCDPSession(page);
await cdpHeap.send('HeapProfiler.enable');
if (heapOut) await cdpHeap.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
const q = at ? `&x=${at[0]}&y=${at[1]}${at[2] === undefined ? '' : `&h=${at[2]}`}` : '';
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}${q}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__sim && window.__sim.state === 'attract', null, { timeout: 180000 });
page.setDefaultTimeout(300000);
const gpu = await page.evaluate(() => { const gl = window.__sim.renderer.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''; });
await page.evaluate(() => { window.__sim.settings.targetFps = 0; });
// the menu's focused Ride button
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__sim.state === 'riding', null, { timeout: 120000 });

// per-system time: wrap the per-frame methods in place
await page.evaluate(() => {
  const w = window, s = w.__sim;
  w.__sys = {};
  const wrap = (label, obj, name) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const f = obj[name].bind(obj);
    w.__sys[label] = 0;
    obj[name] = (...a) => { const t = performance.now(); try { return f(...a); } finally { w.__sys[label] += performance.now() - t; } };
  };
  wrap('terrain.update', s.terrain, 'update');
  wrap('trees.update', s.veg, 'update');
  wrap('trees.cull', s.veg, 'cull');
  wrap('shrubs.update', s.shrubs, 'update');
  wrap('rider.update', s.rider, 'update');
  wrap('riderView.update', s.riderView, 'update');
  wrap('cam.update', s.cam, 'update');
  wrap('lifts.update', s.lifts, 'update');
  wrap('tracks.update', s.tracks, 'update');
  wrap('deform.update', s.deform, 'update');
  wrap('renderer.render', s.renderer, 'render');
});

const settle = () => page.evaluate(async () => {
  const s = window.__sim, p = s.pack, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const busy = () => [p.fine, p.mid, p.far, p.mask, p.ao, p.dir, p.moguls].reduce((a, t) => a + (t?.inFlight ?? 0), 0) + s.terrain.pending + s.veg.pending;
  for (let i = 0, q = 0; i < 300 && q < 10; i++) { await sleep(100); q = busy() === 0 ? q + 1 : 0; }
});
const restart = () => page.evaluate(() => {
  const s = window.__sim, [x, y] = s.map.spawnPos, n = s.pack.groundNormal(x, y);
  const h = new URL(location.href).searchParams.has('h') ? Number(new URL(location.href).searchParams.get('h')) * Math.PI / 180 : Math.atan2(n[0], n[1]);
  s.rider.reset(x, y, h);
});
const measure = (ms) => page.evaluate((ms) => new Promise((resolve) => {
  const w = window, s = w.__sim, dts = [], cpu = [], ev = [];
  const sys0 = { ...w.__sys };
  // what changed in each frame, to see what the slow ones have in common
  const sets = ['fine', 'mid', 'far', 'mask', 'ao', 'dir', 'moguls'].map((k) => s.pack[k]).filter(Boolean);
  const state = () => { const i = s.renderer.info, v = s.veg.stats; return [i.programs?.length ?? 0, i.memory.geometries, i.memory.textures, v.nearPacks + v.farPacks, v.cells, sets.reduce((a, t) => a + (t.stats?.loads ?? 0), 0), performance.memory.usedJSHeapSize]; };
  let st0 = state();
  let last = performance.now(), cpu0 = w.__rafMs; const t0 = last;
  const tick = () => {
    const now = performance.now(); dts.push(now - last); last = now;
    cpu.push(w.__rafMs - cpu0); cpu0 = w.__rafMs;
    const st1 = state(); ev.push({ dt: dts[dts.length - 1], programs: st1[0] - st0[0], geometries: st1[1] - st0[1], textures: st1[2] - st0[2], repacks: st1[3] - st0[3], cells: st1[4] - st0[4], tiles: st1[5] - st0[5], builds: s.terrain.stats.builds, gc: st1[6] < st0[6] - 8 * 1048576 ? Math.round((st0[6] - st1[6]) / 1048576) : 0 }); st0 = st1;
    if (now - t0 < ms) { requestAnimationFrame(tick); return; }
    const sorted = (v) => v.slice(1).sort((a, b) => a - b), qq = (v, p) => +v[Math.min(v.length - 1, Math.floor(v.length * p))].toFixed(1);
    const d = sorted(dts), c = sorted(cpu), n = d.length;
    const sys = Object.fromEntries(Object.entries(w.__sys).map(([k, v]) => [k, +((v - sys0[k]) / n).toFixed(2)]));
    const info = s.renderer.info;
    // per event: share of slow frames (over 33 ms) and of the rest that had it
    const slow = ev.slice(1).filter((e) => e.dt > 33.4), fast = ev.slice(1).filter((e) => e.dt <= 33.4);
    const share = (v, k) => v.length ? Math.round(100 * v.filter((e) => e[k] > 0).length / v.length) : 0;
    const events = Object.fromEntries(['gc', 'programs', 'geometries', 'textures', 'repacks', 'cells', 'tiles', 'builds'].map((k) => [k, [share(slow, k), share(fast, k)]]));
    resolve({ events, slowest: ev.slice(1).sort((a, b) => b.dt - a.dt).slice(0, 5).map((e) => ({ ...e, dt: +e.dt.toFixed(0) })),
      frames: n, frame: { median: qq(d, 0.5), p95: qq(d, 0.95), p99: qq(d, 0.99), max: qq(d, 1) }, over33: d.filter((x) => x > 33.4).length,
      cpu: { median: qq(c, 0.5), p95: qq(c, 0.95), max: qq(c, 1) }, sysPerFrame: sys,
      calls: info.render.calls, tris: info.render.triangles, chunks: s.terrain.stats.chunks, veg: s.veg.stats,
      heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), rider: [Math.round(s.rider.x), Math.round(s.rider.y), +(s.rider.speed * 3.6).toFixed(0)],
    });
  };
  requestAnimationFrame(tick);
}), ms);

await settle(); await restart(); await settle(); await restart();
await page.waitForTimeout(500);
const stand = await measure(6000);
await settle(); await restart(); await page.waitForTimeout(500);
let cdp = null;
if (profileOut) { cdp = await page.context().newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
await page.keyboard.down('ArrowUp');
const tuck = await measure(seconds * 1000);
await page.keyboard.up('ArrowUp');
// --ablate: the eye camera at the spot, looking down the fall line; the frame with each scene group hidden in turn
let ablation = null;
if (args.includes('--ablate')) {
  await page.evaluate(() => { const s = window.__sim, [x, y] = s.map.spawnPos, n = s.pack.groundNormal(x, y); s.eyeAt(x, y, Math.atan2(n[0], n[1]) * 180 / Math.PI, -8, 75, 1.7); });
  await settle(); await page.waitForTimeout(1500);
  const quick = async () => { const r = await measure(3000); return { median: r.frame.median, cpu: r.cpu.median, calls: r.calls, tris: r.tris }; };
  const base = await quick();
  const groups = await page.evaluate(() => window.__sim.scene.children.map((c, i) => ({ i, name: c.name || c.type, visible: c.visible })).filter((g) => g.visible));
  ablation = { base, rows: [] };
  for (const g of groups) {
    await page.evaluate((i) => { window.__sim.scene.children[i].visible = false; }, g.i);
    await page.waitForTimeout(300);
    const r = await quick();
    await page.evaluate((i) => { window.__sim.scene.children[i].visible = true; }, g.i);
    if (base.calls - r.calls > 0 || base.median - r.median > 0.3) ablation.rows.push({ group: g.name, ms: +(base.median - r.median).toFixed(1), calls: base.calls - r.calls, tris: base.tris - r.tris });
  }
  await page.evaluate(() => { window.__sim.renderer.shadowMap.autoUpdate = false; });
  await page.waitForTimeout(300);
  const ns = await quick();
  await page.evaluate(() => { window.__sim.renderer.shadowMap.autoUpdate = true; });
  ablation.rows.push({ group: '(shadow map pass)', ms: +(base.median - ns.median).toFixed(1), calls: base.calls - ns.calls, tris: base.tris - ns.tris });
  ablation.rows.sort((a, b) => b.ms - a.ms);
}
// FEAT-236 --variants <file.json>: at the same eye pose, the frame with the terrain's fragment shader patched, one
// variant at a time: [{ "label": "nobump", "frag": [["from", "to"], ...] }, ...] (every "from" must be in the shader).
// Each variant is timed between two runs of the unpatched shader, and its cost is the difference from their mean.
let termRows = null;
const variantsFile = opt('--variants', null);
if (variantsFile) {
  const variants = JSON.parse(fs.readFileSync(variantsFile, 'utf8'));
  if (!ablation) {
    await page.evaluate(() => { const s = window.__sim, [x, y] = s.map.spawnPos, n = s.pack.groundNormal(x, y); s.eyeAt(x, y, Math.atan2(n[0], n[1]) * 180 / Math.PI, -8, 75, 1.7); });
    await settle(); await page.waitForTimeout(1500);
  }
  const patch = (v) => page.evaluate((v) => {
    const m = window.__sim.terrain.material;
    m.userData.obc0 ??= m.onBeforeCompile;
    window.__patchMissing = [];
    m.onBeforeCompile = (sh, r) => {
      m.userData.obc0(sh, r);
      for (const [a, b] of v?.frag ?? []) { if (!sh.fragmentShader.includes(a)) window.__patchMissing.push(a); sh.fragmentShader = sh.fragmentShader.split(a).join(b); }
    };
    m.customProgramCacheKey = () => (v ? `termperf ${v.label}` : '');
    m.needsUpdate = true;
  }, v);
  const quickT = async () => (await measure(3000)).frame.median;
  termRows = [];
  await patch(null); await page.waitForTimeout(1000);
  let before = await quickT();
  for (const v of variants) {
    await patch(v); await page.waitForTimeout(1500);
    const ms = await quickT();
    const missing = await page.evaluate(() => window.__patchMissing);
    await patch(null); await page.waitForTimeout(1000);
    const after = await quickT();
    termRows.push({ label: v.label, ms, base: (before + after) / 2, missing });
    before = after;
  }
}
// garbage does not count: collect it before the heap read
const heapBeforeGC = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
await cdpHeap.send('HeapProfiler.collectGarbage');
await page.waitForTimeout(200);
// where the JS heap goes: typed arrays held by the tile sets, scene geometry and the trees' records
const heap = await page.evaluate(() => {
  const s = window.__sim, seen = new Set(), mb = (b) => Math.round(b / 1048576);
  const add = (a) => { if (!a || !a.buffer || seen.has(a.buffer)) return 0; seen.add(a.buffer); return a.buffer.byteLength; };
  const out = {};
  for (const k of ['fine', 'mid', 'far', 'mask', 'ao', 'dir', 'moguls']) { const t = s.pack[k]; if (!t) continue; let b = 0; for (const v of t.tiles.values()) b += add(v); out[`tiles ${k}`] = mb(b); }
  const geo = {};
  s.scene.traverse((o) => {
    const g = o.geometry; if (!g) return;
    let top = o; while (top.parent && top.parent !== s.scene) top = top.parent;
    const k = `scene ${top.name || top.type}`;
    let b = 0; for (const a of Object.values(g.attributes)) b += add(a.array); if (g.index) b += add(g.index.array);
    if (o.isInstancedMesh) { b += add(o.instanceMatrix.array); if (o.instanceColor) b += add(o.instanceColor.array); }
    geo[k] = (geo[k] ?? 0) + b;
  });
  for (const [k, b] of Object.entries(geo)) out[k] = mb(b);
  // per field, so the biggest record shows (BUG-090)
  let cellBytes = 0; const byField = {};
  for (const c of s.veg.cells.values()) for (const [f, v] of Object.entries(c)) {
    let b = 0;
    if (ArrayBuffer.isView(v)) b = add(v); else if (v && typeof v === 'object') for (const w of Object.values(v)) if (ArrayBuffer.isView(w)) b += add(w);
    cellBytes += b; byField[f] = (byField[f] ?? 0) + b;
  }
  out['tree cell records'] = mb(cellBytes);
  const fields = Object.entries(byField).map(([k, b]) => [k, mb(b)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  return { cells: s.veg.cells.size, cylinders: s.collider?.cylinderCount ?? null, fields, usedMB: mb(performance.memory.usedJSHeapSize), totalMB: mb(performance.memory.totalJSHeapSize), counted: Object.entries(out).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) };
});
let held = null;
if (heapOut) {
  // live sampled bytes per allocating function (self), and per first frame in the game's own code (src)
  const { profile } = await cdpHeap.send('HeapProfiler.stopSampling');
  const self = new Map(), game = new Map();
  const site = (f) => `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  const walk = (n, stack) => {
    const st = [...stack, n.callFrame];
    const bytes = n.selfSize;
    if (bytes > 0) {
      self.set(site(n.callFrame), (self.get(site(n.callFrame)) ?? 0) + bytes);
      // the deepest frame in a game module (not three, not the runtime): who asked for it
      const g = [...st].reverse().find((f) => f.url && !/three|node_modules|vendor/.test(f.url) && f.functionName !== '');
      const k = g ? site(g) : '(no game frame)';
      game.set(k, (game.get(k) ?? 0) + bytes);
    }
    for (const c of n.children) walk(c, st);
  };
  walk(profile.head, []);
  const rows = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, b]) => ({ site: k, MB: +(b / 1048576).toFixed(1) }));
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  held = { totalMB: +(total / 1048576).toFixed(0), self: rows(self), game: rows(game) };
  fs.writeFileSync(heapOut, JSON.stringify({ pack, at, held, profile }));
}
let top = null;
if (cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  // self time per function from the samples
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  const self = new Map();
  for (const [id, us] of dt) {
    const f = byId.get(id).callFrame, key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, us]) => ({ fn: k, ms: +(us / 1000).toFixed(0), pct: +(100 * us / total).toFixed(1) }));
  fs.writeFileSync(profileOut, JSON.stringify({ pack, at, seconds, top, profile }));
}

const f = (v) => v.toFixed(1);
console.log(`GPU: ${gpu}, 1920 x 1080, ${vsync ? 'vsync on' : 'vsync and frame cap off'}, game frame cap off`);
for (const [label, r] of [['stand', stand], ['tuck', tuck]]) {
  console.log(`${label}: ${r.frames} frames, frame ms median ${f(r.frame.median)}, p95 ${f(r.frame.p95)}, p99 ${f(r.frame.p99)}, max ${f(r.frame.max)}, over 33 ms ${r.over33}; main thread median ${f(r.cpu.median)}, p95 ${f(r.cpu.p95)}, max ${f(r.cpu.max)}`);
  console.log(`  per frame (mean ms): ${Object.entries(r.sysPerFrame).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const e = r.events; console.log(`  slow frames (over 33 ms) / the rest, share with: a heap drop over 8 MB (GC) ${e.gc[0]}% / ${e.gc[1]}%, new shader programs ${e.programs[0]}% / ${e.programs[1]}%, new geometries ${e.geometries[0]}% / ${e.geometries[1]}%, new textures ${e.textures[0]}% / ${e.textures[1]}%, tree repacks ${e.repacks[0]}% / ${e.repacks[1]}%, tree cells ${e.cells[0]}% / ${e.cells[1]}%, tiles decoded ${e.tiles[0]}% / ${e.tiles[1]}%, terrain builds ${e.builds[0]}% / ${e.builds[1]}%`);
  console.log(`  slowest: ${r.slowest.map((x) => `${x.dt} ms (GC ${x.gc} MB, programs ${x.programs}, geometries ${x.geometries}, textures ${x.textures}, repacks ${x.repacks}, tiles ${x.tiles}, builds ${x.builds})`).join('; ')}`);
  console.log(`  calls ${r.calls}, triangles ${(r.tris / 1e6).toFixed(2)} M, chunks ${r.chunks}, tree instances ${r.veg.instances} (lod0 ${r.veg.lod0}, lod1 ${r.veg.lod1}, far ${r.veg.far}), JS heap ${r.heapMB} MB, rider ${r.rider.slice(0, 2).join(', ')} at ${r.rider[2]} km/h`);
}
console.log(`JS heap ${heapBeforeGC} MB used before a forced garbage collection`);
console.log(`tree cells ${heap.cells}, by field: ${heap.fields.map(([k, v]) => `${k} ${v}`).join(', ')} MB; collider cylinders ${heap.cylinders}`);
console.log(`JS heap ${heap.usedMB} MB used (${heap.totalMB} MB allocated); typed arrays found: ${heap.counted.map(([k, v]) => `${k} ${v}`).join(', ')} MB`);
if (ablation) {
  console.log(`ablation (eye camera at the spot, 3 s each): all drawn ${f(ablation.base.median)} ms, ${ablation.base.calls} calls, ${(ablation.base.tris / 1e6).toFixed(2)} M triangles; hiding each group saves:`);
  for (const r of ablation.rows) console.log(`  ${String(r.ms).padStart(5)} ms  ${String(r.calls).padStart(4)} calls  ${(r.tris / 1e6).toFixed(2).padStart(5)} M tris  ${r.group}`);
}
if (held) {
  console.log(`held after collection (sampled, ${held.totalMB} MB), by allocating function (top 20):`);
  for (const r of held.self.slice(0, 20)) console.log(`  ${String(r.MB).padStart(6)} MB  ${r.site}`);
  console.log('by the game code under it (top 25):');
  for (const r of held.game.slice(0, 25)) console.log(`  ${String(r.MB).padStart(6)} MB  ${r.site}`);
}
if (termRows) {
  console.log('terrain shader variants (eye camera at the spot, 3 s each, against the unpatched shader just before and after):');
  for (const r of termRows) console.log(`  ${String((r.base - r.ms).toFixed(1)).padStart(5)} ms saved  (${f(r.ms)} against ${f(r.base)})  ${r.label}${r.missing.length ? `  NOT APPLIED: ${r.missing.map((m) => m.slice(0, 50)).join(' | ')}` : ''}`);
}
if (top) { console.log('tuck, JavaScript self time (top 15):'); for (const t of top.slice(0, 15)) console.log(`  ${String(t.ms).padStart(6)} ms ${String(t.pct).padStart(5)}%  ${t.fn}`); }
console.log('console issues:', warnings.length);
for (const w of warnings.slice(0, 8)) console.log('  ', w.slice(0, 300));
await browser.close();
server.close();
