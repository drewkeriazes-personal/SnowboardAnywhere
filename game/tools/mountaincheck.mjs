// Mountain view check (FEAT-054): the map's 3D mode and its drop zones, with real key presses and a real click on the
// headless build. M opens the 2D map, V switches it to the 3D mountain view (the eye camera over the resort, the 2D map
// hidden) and back; the arrow keys turn the orbit; a click on a drop zone (a lift top unless --zone names one) flies the
// camera down, waits for the ground there and lands the rider at the zone on the snow, clear of trees, facing downhill,
// in the camera it rode with, riding again. Esc during the flight leaves the rider where it was. No console errors.
// node tools/mountaincheck.mjs [pack] [--zone <part of a zone's name>] [--shots <dir>] [--gpu | --headed | --cpu]
//   (after `npx vite build`; exit 1 on a failed check). --shots saves stills of the view, the picked zone, the fly-in
//   and the landing (1280x720); on the GPU it also prints the frame time while orbiting.
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const valued = new Set(['--zone', '--shots']);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const pack = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))[0] ?? 'synth';
const zoneName = opt('--zone'), shots = opt('--shots');
if (shots) fs.mkdirSync(shots, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css', '.woff2': 'font/woff2' };
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

const [W, H] = shots ? [1280, 720] : [640, 480];
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step && window.__sim, null, { timeout: 180000 });
page.setDefaultTimeout(240000);

const step = (n) => page.evaluate((n) => window.__step(n), n);
const press = async (code) => { await page.keyboard.press(code); await step(1); };
const st = () => page.evaluate(() => {
  const s = window.__sim, r = s.rider, m = s.mountain;
  return { state: s.state, x: r.x, y: r.y, z: r.z, heading: r.heading, speed: r.speed, map: s.map.fullOpen, in3d: s.map.in3d, on: m.on, flying: !!m.flight, cam: s.cam.mode, yaw: m.yaw,
    view: getComputedStyle(document.querySelector('#mountain-view')).display };
});
const shot = async (name) => { if (shots) { await page.screenshot({ path: path.join(shots, `${name}.png`) }); console.log(`     saved ${name}.png`); } };
const f = (v) => v.toFixed(1);

for (let i = 0; i < 10; i++) { await step(5); await page.waitForTimeout(200); }
const start = await st();
check('starts riding', start.state === 'riding', start.state);
const camBefore = start.cam;

// ---- the zones from the pack's data
const zones = await page.evaluate(() => window.__sim.mountain.p.zones.map((z) => ({ name: z.name, kind: z.kind, x: z.x, y: z.y, z: z.z, also: z.also })));
const kinds = [...new Set(zones.map((z) => z.kind))];
console.log(`     ${zones.length} drop zones: ${kinds.map((k) => `${zones.filter((z) => z.kind === k).length} ${k}`).join(', ')}`);
check('drop zones from the pack: a lift top at least', zones.some((z) => z.kind === 'lift'), kinds.join(', '));
const far = zones.flatMap((a, i) => zones.slice(i + 1).filter((b) => a.kind !== 'trial' && b.kind !== 'trial' && Math.hypot(a.x - b.x, a.y - b.y) < 250).map((b) => `${a.name} / ${b.name}`));
check('no two place zones within the cluster distance', far.length === 0, far.slice(0, 3).join('; '));

// ---- M opens the 2D map as before; V switches to 3D and back
await press('KeyM');
let s = await st();
check('M opens the 2D map', s.state === 'map' && s.map && !s.in3d && !s.on, JSON.stringify({ state: s.state, map: s.map, in3d: s.in3d }));
await press('KeyV'); await step(2);
s = await st();
check('V switches the map to the 3D mountain view', s.state === 'map' && s.in3d && s.on && s.cam === 'eye' && s.view === 'block', JSON.stringify({ in3d: s.in3d, on: s.on, cam: s.cam }));
// the 2D map's overlay is the div with the crosshair cursor (ui/ResortMap.ts)
const hidden2d = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => d.style.cursor === 'crosshair').every((d) => d.style.display === 'none'));
check('the 2D map is hidden under it', hidden2d);
await press('KeyV');
s = await st();
check('V again: back to the 2D map, the camera as it was', s.state === 'map' && !s.in3d && !s.on && s.cam === camBefore, JSON.stringify({ in3d: s.in3d, on: s.on, cam: s.cam }));
await page.click('.map-view-toggle >> visible=true'); await step(2);
s = await st();
check('the 3D view button switches too', s.on && s.in3d, JSON.stringify({ on: s.on }));

// settle the overview (the far terrain and the impostors) before the stills and the timing
for (let i = 0; i < 20; i++) { await step(3); await page.waitForTimeout(150); }
await shot('01_overview');
const pose = await page.evaluate(() => window.__sim.cam.eyePose());
console.log(`     overview pose: x ${f(pose.x)} y ${f(pose.y)} h ${f(pose.h)} pitch ${f(pose.pitch)} eye ${f(pose.eye)} m`);

// the arrow keys turn the orbit
const yaw0 = (await st()).yaw;
await page.keyboard.down('ArrowRight'); await step(30); await page.keyboard.up('ArrowRight'); await step(1);
check('the arrow keys turn round the resort', (await st()).yaw - yaw0 > 0.3, `${f(((await st()).yaw - yaw0) * 180 / Math.PI)} deg`);

if (shots && !/swiftshader/i.test(await page.evaluate(() => window.__sim.renderer.getContext().getParameter(0x1F01)))) {
  // wall-clock frame time while orbiting (__step renders each frame; the GPU work is waited on with a pixel read)
  const ms = await page.evaluate(() => {
    const s = window.__sim, gl = s.renderer.getContext(), px = new Uint8Array(4), t = [];
    const m = s.mountain;
    for (let i = 0; i < 120; i++) { m.yaw += 0.01; const t0 = performance.now(); window.__step(1); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b);
    return { p50: t[60], p90: t[108], max: t[119] };
  });
  console.log(`     orbiting frame time (wall clock, ${W}x${H}): median ${f(ms.p50)} ms, p90 ${f(ms.p90)} ms, max ${f(ms.max)} ms`);
}

// ---- pick a zone with a real click on its marker
const want = zoneName ? zones.find((z) => z.name.includes(zoneName) || z.also.some((a) => a.includes(zoneName))) : zones.find((z) => z.kind === 'lift');
check('the zone to drop at', !!want, zoneName ?? 'a lift top');
if (!want) { await browser.close(); server.close(); process.exit(1); }
// turn to it and come closer so its marker is in view and clear of the others
await page.evaluate((w) => { const m = window.__sim.mountain; m.tx = w.x; m.ty = w.y; m.dist = Math.min(m.dist, 3000); }, want);
for (let i = 0; i < 8; i++) { await step(4); await page.waitForTimeout(100); }
const at = await page.evaluate((name) => { const m = window.__sim.mountain.marks.find((k) => k.zone && k.zone.name === name); return m && !Number.isNaN(m.sx) ? { x: m.sx, y: m.sy, seen: m.seen } : null; }, want.name);
check('the zone marker is on screen', !!at && at.seen, JSON.stringify(at));
if (at) {
  await page.mouse.move(at.x, at.y); await step(2);
  check('hovering the marker picks it out', await page.evaluate((name) => window.__sim.mountain.hover?.name === name, want.name));
  await shot('02_zone');
  await page.mouse.down(); await page.mouse.up(); await step(1);
}
s = await st();
check('a click on the zone flies down to it', s.flying && s.state === 'map', JSON.stringify({ flying: s.flying, state: s.state }));

// ---- the flight: fly, wait for the ground and the trees, land, wait, drop
const t0 = Date.now();
let frames = 0, n = 0, phases = [];
while (Date.now() - t0 < 90000) {
  const ph = await page.evaluate(() => window.__sim.mountain.flight?.phase ?? null);
  if (ph !== phases[phases.length - 1]) phases.push(ph);
  if (!ph) break;
  if (shots && frames % 24 === 0 && n < 8) await shot(`03_flight_${String(n++).padStart(2, '0')}_${ph}`);
  await step(4); frames += 4;
  await page.waitForTimeout(ph === 'fly' || ph === 'land' ? 0 : 60);
}
console.log(`     flight: ${phases.filter(Boolean).join(' > ')} in ${frames} frames (${f(frames / 60)} s at 60 fps) and ${f((Date.now() - t0) / 1000)} s wall clock`);
const landed = await st();
const ground = await page.evaluate(() => {
  const s = window.__sim, r = s.rider, p = s.pack;
  // downhill as the game reads it (the ground's normal, as the map's drop-in and the lift unload do)
  const g = p.groundHeight(r.x, r.y), n = p.groundNormal(r.x, r.y), slope = Math.hypot(n[0], n[1]);
  return { g, slope, down: slope > 0.02 ? (Math.sin(r.heading) * n[0] + Math.cos(r.heading) * n[1]) / slope : 1, blocked: s.collider.blocked(r.x, r.y, g, 1.0) };
});
check('the drop hands back to riding with the map closed', landed.state === 'riding' && !landed.map && !landed.on, JSON.stringify({ state: landed.state, map: landed.map, on: landed.on }));
check('the rider is at the zone', Math.hypot(landed.x - want.x, landed.y - want.y) < 80, `${f(Math.hypot(landed.x - want.x, landed.y - want.y))} m from ${want.name}`);
check('on the snow', Math.abs(landed.z - ground.g) < 0.5, `z ${f(landed.z)}, ground ${f(ground.g)}`);
check('clear of trees and buildings', !ground.blocked);
check('facing downhill', ground.down > 0.7, `heading against the fall line ${f(Math.acos(Math.min(1, ground.down)) * 180 / Math.PI)} deg, slope ${f(Math.atan(ground.slope) * 180 / Math.PI)} deg, heading ${f(landed.heading * 180 / Math.PI)} deg`);
check('in the camera it rode with', landed.cam === camBefore, `${landed.cam} (was ${camBefore})`);
await shot('04_landed');
await step(90);
const rolled = await st();
check('riding on from the drop', Math.hypot(rolled.x - landed.x, rolled.y - landed.y) > 0.3 || rolled.speed > 0.3, `${f(Math.hypot(rolled.x - landed.x, rolled.y - landed.y))} m in 1.5 s`);
await shot('05_riding');

// ---- Esc during a flight: back to riding where the rider was
await press('KeyM'); await press('KeyV'); await step(5);
const before = await st();
await page.evaluate(() => { const m = window.__sim.mountain; m.pick(m.p.zones[m.p.zones.length - 1]); });
await step(10);
await press('Escape'); await step(2);
const esc = await st();
check('Esc during the flight closes the map, the rider where it was', esc.state === 'riding' && !esc.on && !esc.flying && Math.hypot(esc.x - before.x, esc.y - before.y) < 1 && esc.cam === camBefore,
  JSON.stringify({ state: esc.state, on: esc.on, moved: f(Math.hypot(esc.x - before.x, esc.y - before.y)), cam: esc.cam }));

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 300));
await browser.close();
server.close();
if (fails.length) { console.log(`${fails.length} check(s) failed`); process.exit(1); }
console.log('all checks passed');
