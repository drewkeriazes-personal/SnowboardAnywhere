// Lift unload check (BUG-151): every chairlift and gondola on the pack, unloaded at the top, render-free (the
// lift logic is stepped with liftRide.update inside page.evaluate). For each lift the rider must be set down
//   1. outside every building footprint near the top station (the open station roofs of FEAT-323 included),
//   2. outside the drawn terminal (world/LiftModels: 14 x 7 m chair, 20 x 9 m gondola, on the station node),
//   3. not under the cable coming up to the station (3 m or more to its side),
//   4. moving 2 to 3 m/s, away from the station node;
// and no console errors. The geometry here is worked out again from the pack, not from LiftRide's own keep-out.
// node tools/liftunloadcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
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

const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(240000);

const lifts = await page.evaluate(() => window.__sim.lifts.lifts.map((l, i) => ({ i, name: l.feature.name ?? '(unnamed)', kind: l.kind })).filter((l) => l.kind === 'chair' || l.kind === 'gondola'));
check('the pack has chairlifts or gondolas', lifts.length > 0, `${lifts.length}`);

for (const lift of lifts) {
  // the 1 m tiles round the top first, so the spot search reads the real ground
  const node = await page.evaluate((i) => {
    const s = window.__sim, l = s.lifts.lifts[i];
    const dx = l.top[0] - l.bottom[0], dy = l.top[1] - l.bottom[1], d = Math.hypot(dx, dy) || 1;
    const x = l.top[0] + (dx / d) * 8, y = l.top[1] + (dy / d) * 8;
    s.pack.fine?.request(x - 150, y - 150, x + 150, y + 150);
    return { x, y };
  }, lift.i);
  for (let k = 0; k < 60; k++) {
    if (await page.evaluate(([x, y]) => { const p = window.__sim.pack; return !p.fine || !Number.isNaN(p.fine.sample(x, y)); }, [node.x, node.y])) break;
    await page.waitForTimeout(500);
  }
  const r = await page.evaluate((i) => {
    const s = window.__sim, r = s.rider, lr = s.liftRide, l = s.lifts.lifts[i];
    lr.cancel();
    lr.lift = l; lr.up = s.lifts.rideLength(l);
    lr.update(r, 1 / 60, false); // past the top: unloads
    const dx = l.top[0] - l.bottom[0], dy = l.top[1] - l.bottom[1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const nx = l.top[0] + ux * 8, ny = l.top[1] + uy * 8;
    const inPoly = (pts, x, y) => { let c = false; for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) { const [xi, yi] = pts[a], [xj, yj] = pts[b]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const segD = (x, y, p, q) => { const ex = q[0] - p[0], ey = q[1] - p[1], t = Math.max(0, Math.min(1, ((x - p[0]) * ex + (y - p[1]) * ey) / (ex * ex + ey * ey || 1))); return Math.hypot(p[0] + ex * t - x, p[1] + ey * t - y); };
    const polyD = (pts, x, y) => inPoly(pts, x, y) ? 0 : Math.min(...pts.map((p, k) => segD(x, y, p, pts[(k + 1) % pts.length])));
    const roofs = (s.pack.features.buildings ?? []).filter((b) => b.points.length >= 3 && polyD(b.points, nx, ny) < 60);
    const roofD = roofs.length ? Math.min(...roofs.map((b) => polyD(b.points, r.x, r.y))) : Infinity;
    const a = (r.x - nx) * ux + (r.y - ny) * uy, c = Math.abs((r.x - nx) * uy - (r.y - ny) * ux);
    const [tl, tw] = l.kind === 'gondola' ? [20, 9] : [14, 7];
    const inTerminal = Math.abs(a) < tl / 2 && c < tw / 2;
    const underCable = a < 0 && a > -(d + 16) && c < 3;
    const sp = Math.hypot(r.vx, r.vy), away = r.vx * (r.x - nx) + r.vy * (r.y - ny);
    return { riding: lr.riding, x: r.x, y: r.y, a: +a.toFixed(1), c: +c.toFixed(1), roofs: roofs.length, roofD: Number.isFinite(roofD) ? +roofD.toFixed(1) : null, inTerminal, underCable, speed: +sp.toFixed(2), away: away > 0, fromNode: +Math.hypot(r.x - nx, r.y - ny).toFixed(1) };
  }, lift.i);
  const ok = !r.riding && (r.roofD === null || r.roofD > 0.5) && !r.inTerminal && !r.underCable && r.speed >= 2 && r.speed <= 3 && r.away;
  check(`${lift.name} (${lift.kind}) unloads clear of the station and the cable, pushing off`, ok,
    `${r.fromNode} m from the station node (along ${r.a}, across ${r.c}), roof ${r.roofD === null ? 'none near' : `${r.roofD} m`} (${r.roofs} near), ${r.speed} m/s ${r.away ? 'away' : 'TOWARD the station'}${r.inTerminal ? ', IN THE TERMINAL' : ''}${r.underCable ? ', UNDER THE CABLE' : ''}`);
}

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (fails.length) { console.log(`\n${fails.length} failed: ${fails.join(', ')}`); process.exit(1); }
console.log('\nall lift unload checks passed');
