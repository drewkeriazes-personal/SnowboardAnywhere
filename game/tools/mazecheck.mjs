// Lift-line maze facing check (BUG-061), render-free, on the synthetic mountain's chair. The synth pack has no
// run ending at its lift, so the check builds extra mazes for that lift with fake feeder runs (a fresh
// LiftLines over the real pack, its rope walls kept out of the live collider):
//   1. no feeder: the maze runs straight back down the line as before, and its gate is the old rectangle;
//   2. a feeder 60 deg off straight back, one 100 deg off on the other side, one from uphill beside the line
//      (170 deg, past the 150 deg limit): the mouth faces it (within 5 deg, or 25 deg for the clamped one);
//   3. every bent maze: the first STRAIGHT m run square to the chair from the stop line, no lane point past
//      them is in the lift's corridor (the terminal, the cable, the chairs, the towers), and the gate boards
//      along the bend and at the mouth but not beside the bend nor where a straight maze's back end would be;
//   4. two feeders uphill on opposite sides: the mouth faces the bigger flow and one funnel fence aims at the smaller;
//   5. a tree in the way of the full bend: the plan takes another shape that keeps clear of it;
//   6. no console errors.
// node tools/mazecheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
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

// the 1 m tiles around the first chair's loading point
const base = await page.evaluate(() => {
  const s = window.__sim, l = s.lifts.lifts.find((q) => q.kind === 'chair');
  if (!l) return null;
  const [x, y] = l.bottom;
  s.pack.fine?.request(x - 300, y - 300, x + 300, y + 300);
  return { x, y, name: l.feature.name };
});
check('the pack has a chairlift', !!base, JSON.stringify(base));
if (!base) process.exit(1);
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(([x, y]) => { const f = window.__sim.pack.fine; return !f || [[0, 0], [40, 40], [-40, 40], [40, -40], [-40, -40]].every(([dx, dy]) => !Number.isNaN(f.sample(x + dx, y + dy))); }, [base.x, base.y])) break;
  await page.waitForTimeout(500);
}

/**
 * Build a maze for the chair with these fake feeder runs: each { deg, len } is a run whose lower end is 20 m from
 * the loading point, deg off straight back down the line (counter-clockwise from above), climbing away; `trees`
 * are fake trunks (pack x, y) the plan must avoid. Returns the maze's shape and gate answers.
 */
const maze = (feeders, trees = []) => page.evaluate(([feeders, trees]) => {
  const s = window.__sim, l = s.lifts.lifts.find((q) => q.kind === 'chair'), pack = s.pack;
  const [lx, ly, lz] = l.bottom, d = Math.hypot(l.top[0] - lx, l.top[1] - ly), ux = (l.top[0] - lx) / d, uy = (l.top[1] - ly) / d;
  const rot = (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), n = Math.sin(a); return [-ux * c + uy * n, -ux * n - uy * c]; };
  const runs = feeders.map(({ deg, len }) => {
    const [dx, dy] = rot(deg), pts = [];
    for (let r = 20; r <= 20 + len; r += 10) pts.push([lx + dx * r, ly + dy * r, lz + (r - 20) * 0.4]);
    return { name: `fake ${deg}`, difficulty: 'intermediate', groomed: true, gladed: false, points: pts };
  });
  const real = pack.features.runs;
  pack.features.runs = [...real, ...runs];
  const blocked = (x, y, z, clear) => trees.some(([tx, ty]) => Math.hypot(x - tx, y - ty) < 0.3 + clear);
  const collider = { blocked, addWall: () => new Float32Array(7), setWallActive: () => {} };
  const ll = new s.liftLines.constructor(pack, s.lifts.lifts, collider);
  ll.maintain(lx, ly);
  pack.features.runs = real;
  const m = ll.mazes.find((q) => q.lift === l);
  const p = m.path, T = p.dir(p.total);
  const gate = (x, y) => ll.inGate(l, x, y);
  // straight part: square to the chair
  let square = true;
  for (let si = 0; si <= 12; si++) { const t = p.dir(si), q = p.at(si, 0), want = [lx - ux * (3 + si), ly - uy * (3 + si)]; if (t[0] * -ux + t[1] * -uy < 0.9999 || Math.hypot(q[0] - want[0], q[1] - want[1]) > 1e-6) square = false; }
  // bent part: out of the lift's corridor and clear of the trees
  let inLine = 0, onTree = 0;
  for (let si = 13.5; si <= p.total; si += 0.5) for (let o = -m.halfW - 0.5; o <= m.halfW + 0.5; o += 0.5) {
    const [x, y] = p.at(si, o), along = (x - lx) * ux + (y - ly) * uy, across = Math.abs((x - lx) * uy - (y - ly) * ux);
    if (along > -16 + 0.01 && across < 4.5) inLine++;
    if (trees.some(([tx, ty]) => Math.hypot(x - tx, y - ty) < 0.5)) onTree++;
  }
  const mid = p.at(13 + (p.total - 13) / 2, 0), mid2 = p.at(13 + (p.total - 13) / 2, m.halfW + 3), mouth = p.at(p.total - 1, 0), tip = p.at(p.total, 0);
  const oldBack = [lx - ux * (3 + m.len - 1), ly - uy * (3 + m.len - 1)];
  const nx = T[1], ny = -T[0];
  return {
    built: m.built, turn: (p.turn * 180) / Math.PI, total: p.total, len: m.len, halfW: m.halfW, square, inLine, onTree,
    mouthDir: T, want: feeders.length ? rot(feeders[0].deg) : null, main: m.arrive?.main ?? null, minor: m.arrive?.minor ?? null,
    fences: m.fences.map(([a, b]) => { const h = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / h, (b[1] - a[1]) / h, h]; }),
    gateMid: gate(mid[0], mid[1]), gateBeside: gate(mid2[0], mid2[1]), gateMouth: gate(mouth[0], mouth[1]),
    gatePast: gate(tip[0] + T[0] * 3, tip[1] + T[1] * 3), gateOldBack: gate(oldBack[0], oldBack[1]),
    gateSide: gate(tip[0] + nx * (m.halfW + 2), tip[1] + ny * (m.halfW + 2)),
    rot: { a: rot(150), b: rot(-150) },
  };
}, [feeders, trees]);
const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;

// 1. no feeder: straight back, the old gate
let m = await maze([]);
check('no feeder: the maze is built straight back down the line', m.built && m.turn === 0 && m.total === m.len && m.square, JSON.stringify({ built: m.built, turn: m.turn, total: m.total, len: m.len }));
check('no feeder: the gate boards at the back end and not past it nor beside it', m.gateOldBack && m.gateMouth && !m.gatePast && !m.gateSide, JSON.stringify({ back: m.gateOldBack, mouth: m.gateMouth, past: m.gatePast, side: m.gateSide }));

// 2 and 3. one feeder at a time
for (const [deg, tol] of [[60, 5], [-100, 5], [170, 25]]) {
  m = await maze([{ deg, len: 400 }]);
  const off = angle(m.mouthDir, m.want);
  check(`feeder ${deg} deg off straight back: the mouth faces it`, m.built && Math.abs(m.turn) > 10 && off <= tol, `turn ${m.turn.toFixed(0)} deg, mouth ${off.toFixed(1)} deg off the feeder`);
  check(`feeder ${deg} deg: loading stays square to the chair (13 m straight from the stop line)`, m.square, '');
  check(`feeder ${deg} deg: the bend stays out of the terminal, cable and towers`, m.inLine === 0, `${m.inLine} lane points in the corridor`);
  check(`feeder ${deg} deg: the gate boards along the bend and at the mouth, not beside the bend or past the mouth`, m.gateMid && m.gateMouth && !m.gateBeside && !m.gatePast, JSON.stringify({ mid: m.gateMid, mouth: m.gateMouth, beside: m.gateBeside, past: m.gatePast }));
  check(`feeder ${deg} deg: the old straight-back end is no longer corral`, !m.gateOldBack, '');
  check(`feeder ${deg} deg: two funnel fences flare toward the feeder`, m.fences.length === 2 && m.fences.every((f) => angle(f, m.want) < 75), JSON.stringify(m.fences.map((f) => `${angle(f, m.want).toFixed(0)} deg, ${f[2]} m`)));
}

// 4. two sides: the bigger flow wins, the smaller one gets a fence
m = await maze([{ deg: 150, len: 900 }, { deg: -150, len: 400 }]);
check('two feeders: the mouth faces the bigger flow', m.built && angle(m.mouthDir, m.rot.a) <= 5, `turn ${m.turn.toFixed(0)}, ${angle(m.mouthDir, m.rot.a).toFixed(1)} deg off`);
check('two feeders: the smaller side is a minority flow', !!m.minor && angle(m.minor, m.rot.b) < 5, JSON.stringify(m.minor));
const toMinor = m.fences.map((f) => angle(f, m.rot.b));
check('two feeders: one funnel fence aims at the smaller flow', m.fences.length === 2 && Math.min(...toMinor) < 30, toMinor.map((a) => a.toFixed(0)).join(', '));

// 5. a tree where the full bend would go
const full = await maze([{ deg: 90, len: 400 }]);
const treeAt = await page.evaluate(([deg]) => {
  const s = window.__sim, l = s.lifts.lifts.find((q) => q.kind === 'chair');
  const [lx, ly] = l.bottom, d = Math.hypot(l.top[0] - lx, l.top[1] - ly), ux = (l.top[0] - lx) / d, uy = (l.top[1] - ly) / d;
  // the full 90 deg bend's mouth is about 9 to 13 m to its side and 21 to 23 m back: a trunk there
  const a = (deg * Math.PI) / 180, bx = -ux * Math.cos(a) + uy * Math.sin(a), by = -ux * Math.sin(a) - uy * Math.cos(a);
  return [lx - ux * 20 + bx * 8, ly - uy * 20 + by * 8];
}, [90]);
m = await maze([{ deg: 90, len: 400 }], [treeAt]);
check('a tree in the full bend: the plan takes another shape clear of it', m.built && m.onTree === 0 && m.turn !== full.turn, `full bend ${full.turn.toFixed(0)} deg, with the tree ${m.turn.toFixed(0)} deg, ${m.onTree} lane points on the trunk`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (fails.length) { console.log(`\n${fails.length} failed: ${fails.join(', ')}`); process.exit(1); }
console.log('\nall lift-line maze checks passed');
