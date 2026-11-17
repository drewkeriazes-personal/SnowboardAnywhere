// Shader rock grip check (BUG-035): the terrain draws rock on faces steeper than about 45 deg, on wind-scoured
// ridges and talus aprons even where the pack's mask has none (FEAT-020, terrain/exposure.ts). This scans the
// ground round the pack's start (or a given point) for a steep face with no mask rock and an open, gentle spot
// with none either, drops the rider on each without rendering and checks the face reads as rock (surface rock,
// snow kind, less edge grip) while the gentle spot reads as snow with the rock weights at 0.
// node tools/rockgripcheck.mjs [pack] [x y] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const pack = pos[0] ?? 'synth';
const at = pos.length >= 3 ? { x: +pos[1], y: +pos[2] } : null;
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
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(300000);

const R = 700; // scan radius (m)
const centre = at ?? await page.evaluate(() => ({ x: window.__sim.rider.x, y: window.__sim.rider.y }));
// the frame loop requests tiles; it does not run between steps here
await page.evaluate(([c, R]) => { const p = window.__sim.pack; p.fine?.request(c.x - R, c.y - R, c.x + R, c.y + R); p.mask?.request(c.x - R, c.y - R, c.x + R, c.y + R); }, [centre, R]);
for (let i = 0; i < 120; i++) {
  const ready = await page.evaluate(([c, R]) => {
    const p = window.__sim.pack;
    const pts = [[0, 0], [R, R], [-R, R], [R, -R], [-R, -R]].map(([dx, dy]) => [c.x + dx * 0.9, c.y + dy * 0.9]);
    return !!p.mask && pts.every(([x, y]) => (!p.fine || !p.fine.contains(x, y) || !Number.isNaN(p.fine.sample(x, y))) && (!p.mask.contains || !p.mask.contains(x, y) || p.mask.has(x, y)));
  }, [centre, R]);
  if (ready) break;
  await page.waitForTimeout(500);
}

/** a steep face with no mask rock, and an open gentle spot, from a 6 m grid scan */
const spots = await page.evaluate(([c, R]) => {
  const p = window.__sim.pack, m = [0, 0, 0, 0], n = [0, 0, 1];
  let face = null, flat = null, maxDeg = 0;
  for (let y = c.y - R; y <= c.y + R; y += 6) {
    for (let x = c.x - R; x <= c.x + R; x += 6) {
      if (!p.mask.has(x, y)) continue;
      p.mask.sample(x, y, m);
      if (m[0] > 0.02 || m[1] > 0.02 || m[3] > 0.1) continue;
      p.groundNormal(x, y, n);
      const deg = Math.acos(Math.min(1, n[2])) * 57.2958;
      // a face with some of the same steepness all round, so the exact point is not a single spike
      if (deg > maxDeg) maxDeg = deg;
      if (deg > 52 && (!face || deg > face.deg)) {
        let ok = true;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) { p.groundNormal(x + dx, y + dy, n); if (Math.acos(Math.min(1, n[2])) * 57.2958 < 48) ok = false; }
        if (ok) face = { x, y, deg, h: Math.atan2(-n[0], -n[1]) };
      }
      if (deg > 12 && deg < 25 && p.height(x, y, 1) < 3200 && (!flat || Math.abs(deg - 18) < Math.abs(flat.deg - 18))) flat = { x, y, deg, h: Math.atan2(-n[0], -n[1]) };
    }
  }
  return { face, flat, maxDeg };
}, [centre, R]);
console.log(`pack ${pack}, scan round (${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}) +-${R} m, steepest open ground without mask rock ${spots.maxDeg.toFixed(0)} deg`);

/** drop the rider facing downhill, step once, report the surface and snow it read */
const probe = (sp) => page.evaluate((sp) => {
  const r = window.__sim.rider;
  r.reset(sp.x, sp.y, sp.h);
  r.update(1 / 60, { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
  const s = r.surface;
  return { rock: s.rock, scree: s.scree, groomed: s.groomed, kind: r.snow.kind, snowRock: r.snow.rock, grip: (1 - 0.5 * s.rock) * r.snow.grip, slope: r.slopeDeg }; // the edge grip before the groomer bonus (Ride.ts gripBase)
}, sp);
const fmt = (o) => `rock ${o.rock.toFixed(2)} scree ${o.scree.toFixed(2)} snow ${o.kind} (rock ${o.snowRock.toFixed(2)}) grip x${o.grip.toFixed(2)} at ${o.slope.toFixed(0)} deg`;

if (!spots.face) check('found a steep face with no mask rock', false, 'none in the scan; pass a point near a cliff');
else {
  const f = await probe(spots.face);
  console.log(`face (${spots.face.x.toFixed(0)}, ${spots.face.y.toFixed(0)}) ${spots.face.deg.toFixed(0)} deg: ${fmt(f)}`);
  check('steep face with no mask rock rides as rock', f.rock + f.scree > 0.5 && f.snowRock > 0.5 && f.kind === 'rock', fmt(f));
  if (spots.flat) {
    const g = await probe(spots.flat);
    console.log(`gentle (${spots.flat.x.toFixed(0)}, ${spots.flat.y.toFixed(0)}) ${spots.flat.deg.toFixed(0)} deg: ${fmt(g)}`);
    check('gentle open slope with no mask rock rides as snow', g.rock === 0 && g.scree === 0 && g.snowRock === 0, fmt(g));
    check('the rock face grips less than the snow', f.grip < g.grip, `${f.grip.toFixed(2)} < ${g.grip.toFixed(2)}`);
  } else check('found a gentle open slope', false, 'none in the scan');
}
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} failed`); process.exit(1); }
console.log('all passed');
