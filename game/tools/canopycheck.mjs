// FEAT-330: canopy darkening check. Shoots eye-camera stills at fixed spots and prints, per still, the canopy score
// the light is at (__sim.env.canopy), the sun and sky-fill intensity against their open-air base, and the still's
// mean luma; then walks the eye camera along a run (or a polyline) at riding speed and prints how the smoothed canopy
// follows the grid: the largest change in one frame, the total up and down of the grid under the eye against that of
// the light (flicker at glade and trail edges shows as the second close to the first), and the frames to settle.
// node tools/canopycheck.mjs [pack] [outDir] [--views "x,y,h,pitch;..."] [--walk-run "<run name>" | --walk "x,y;x,y;..." | --walk none]
//   [--walk-speed 15] [--headed | --gpu]
//   (after `npx vite build`; SHOT_DIST=<dist> serves another build, so the same spots can be shot on main for an A/B;
//    SHOT_QUERY="&weather=clear" adds URL parameters). Defaults: Vail's Steep and Deep (canopy about 1), Lodgepole
//    and Inner Mongolia Bowl (0); the walk down Steep And Deep (its longest piece in features.json).
//   The still is <outDir>/<label>.png; the run fails (exit 1) on a page error.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--views', '--walk', '--walk-run', '--walk-speed']);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]));
const [pack = 'vail', outDir = 'shots-canopy-check'] = positional;
const views = opt('--views', '1730,-3500,0,-4;-2785,1881,0,-4;3100,-600,180,-4').split(';').map((v, i) => {
  const [x, y, h = 0, pitch = 0] = v.split(',').map(Number);
  return { label: `${String(i + 1).padStart(2, '0')}_${Math.round(x)}_${Math.round(y)}`, x, y, h, pitch };
});
const walkSpeed = Number(opt('--walk-speed', 15));
const walkArg = opt('--walk', null);
const walkRun = opt('--walk-run', walkArg ? null : 'Steep And Deep');
let walk = walkArg && walkArg !== 'none' ? walkArg.split(';').map((p) => { const [x, y] = p.split(',').map(Number); return { x, y }; }) : null;
if (walkRun) {
  // the run's longest piece in the pack's features.json
  try {
    const runs = JSON.parse(fs.readFileSync(path.join(PACKS, pack, 'features.json'), 'utf8')).runs.filter((r) => r.name === walkRun);
    const len = (r) => r.points.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - r.points[k - 1][0], p[1] - r.points[k - 1][1]) : 0), 0);
    const best = runs.sort((a, b) => len(b) - len(a))[0];
    if (best) walk = best.points.map((p) => ({ x: p[0], y: p[1] }));
    else console.log(`no run named ${walkRun}: no walk`);
  } catch (e) { console.log(`no features.json for ${pack}: no walk`); }
}
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const v0 = views[0];
await page.goto(`http://localhost:${port}/index.html?pack=${pack}&headless&cam=eye&x=${v0.x}&y=${v0.y}${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 120000 });
page.setDefaultTimeout(300000);

const light = () => page.evaluate(() => {
  const s = window.__sim, e = s.env;
  return { canopy: e ? +e.canopy.toFixed(3) : null, grid: !!s.pack.canopy, gridLoaded: !!s.pack.canopy?.loaded,
    sun: e ? +e.sun.intensity.toFixed(3) : null, baseSun: e ? +e.baseSun.toFixed(3) : null,
    hemi: e ? +e.hemi.intensity.toFixed(3) : null, baseHemi: e ? +e.baseHemi.toFixed(3) : null };
});

for (const v of views) {
  await page.evaluate((p) => window.__sim.eyeAt(p.x, p.y, p.h, p.pitch, 60, 1.7), v);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.__step(10, 1 / 60)); await page.waitForTimeout(300); }
  await page.evaluate((ms) => window.__sim.settleStreaming?.(ms), 60000);
  await page.evaluate(() => window.__step(4, 1 / 60));
  const url = await page.evaluate(() => window.__shot());
  fs.writeFileSync(path.join(outDir, `${v.label}.png`), Buffer.from(url.split(',')[1], 'base64'));
  const luma = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }, url);
  console.log(v.label, JSON.stringify({ ...v, ...(await light()), luma: +luma.toFixed(1) }));
}

// the walk along the polyline at walkSpeed m/s, 60 fps, the eye looking along it
if (walk && walk.length > 1) {
  const r = await page.evaluate(({ pts, speed }) => {
    const s = window.__sim, e = s.env;
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
    const L = cum[cum.length - 1], n = Math.ceil(L / (speed / 60));
    const at = (d) => {
      let k = 1; while (k < pts.length - 1 && cum[k] < d) k++;
      const a = pts[k - 1], b = pts[k], t = cum[k] > cum[k - 1] ? Math.min(1, Math.max(0, (d - cum[k - 1]) / (cum[k] - cum[k - 1]))) : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, h: Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI };
    };
    let maxStep = 0, prev = null, prevT = null, varC = 0, varT = 0, settledAt = -1, target = 0, minC = 1, maxC = 0;
    for (let i = 0; i <= n + 240; i++) {
      const p = at(Math.min(L, i / n * L));
      s.eyeAt(p.x, p.y, p.h, -4, 60, 1.7);
      window.__step(1, 1 / 60);
      const c = e.canopy;
      target = s.pack.canopyAt(p.x, p.y);
      if (prev !== null) { maxStep = Math.max(maxStep, Math.abs(c - prev)); varC += Math.abs(c - prev); varT += Math.abs(target - prevT); }
      prev = c; prevT = target; minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      if (i >= n && settledAt < 0 && Math.abs(c - target) < 0.02) settledAt = i - n;
    }
    // varGrid / varLight: the total up and down of the grid under the eye and of the smoothed light over the walk
    return { metres: +L.toFixed(0), frames: n, maxStepPerFrame: +maxStep.toFixed(4), canopyRange: [+minC.toFixed(3), +maxC.toFixed(3)], varGrid: +varT.toFixed(2), varLight: +varC.toFixed(2), endTarget: +target.toFixed(3), endCanopy: +e.canopy.toFixed(3), settleFramesAfterEnd: settledAt };
  }, { pts: walk, speed: walkSpeed });
  console.log('walk', JSON.stringify(r));
}
console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 10)) console.log('  ', e.slice(0, 300));
await browser.close();
server.close();
process.exit(errors.some((e) => e.startsWith('pageerror')) ? 1 : 0);
