// Gondola ride check (BUG-058): the synthetic mountain's lift rebuilt as a gondola, ridden render-free (the
// lift, the rider view, the rider's cabin and the cameras are stepped inside page.evaluate). Mid-ride:
//   1. the rider's cabin is the one built to be seen from inside (shell, glass, the board in the rack), its
//      grip on the cable, and no cabin on the line overlapping it;
//   2. the rider sits on the back bench: the backside on the seat, both feet on the floor (no bone below it),
//      and the board off the feet (the rig's board hidden, the racked one shown);
//   3. the first person and helmet cam eyes are inside the cabin, at seated head height above the floor,
//      also looking round as far as free look goes; the cabin is drawn in the body pass (near 0.05 m);
//   4. the chase camera is outside the cabin; no snow spray comes off the seated rider;
//   5. at the top the rider steps out on foot and straps in where they stand, the board back on the feet;
// and no console errors. The cabin sizes are LiftModels CABIN's.
// node tools/gondolacheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
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

const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${process.env.SHOT_QUERY ?? ''}`);
await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
page.setDefaultTimeout(240000);

// the lift, as a gondola: rebuilt from its feature so the runtime (kind, rider drop, carriers) is a gondola's
const lift = await page.evaluate(() => {
  const s = window.__sim, i = s.lifts.all.findIndex((l) => l.kind === 'chair' || l.kind === 'gondola');
  if (i < 0) return null;
  const l = s.lifts.all[i];
  l.feature.type = 'gondola';
  s.lifts.rebuild(i, 0);
  const t = l.top, b = l.bottom;
  s.pack.fine?.request(Math.min(t[0], b[0]) - 150, Math.min(t[1], b[1]) - 150, Math.max(t[0], b[0]) + 150, Math.max(t[1], b[1]) + 150);
  return { i, name: l.feature.name ?? '(unnamed)', kind: l.kind, len: s.lifts.rideLength(l) };
});
check('the pack has a lift to ride as a gondola', !!lift && lift.kind === 'gondola', lift ? `${lift.name}, ${lift.len.toFixed(0)} m` : 'none');
if (!lift) { await browser.close(); server.close(); process.exit(1); }
for (let k = 0; k < 60; k++) {
  if (await page.evaluate((i) => { const s = window.__sim, l = s.lifts.all[i], p = s.pack; return !p.fine || !Number.isNaN(p.fine.sample(l.top[0], l.top[1])); }, lift.i)) break;
  await page.waitForTimeout(500);
}

const mid = await page.evaluate((i) => {
  const s = window.__sim, r = s.rider, lr = s.liftRide, v = s.riderView, cam = s.cam, chair = s.riderChair, l = s.lifts.all[i];
  lr.cancel(); lr.lift = l; lr.up = s.lifts.rideLength(l) * 0.5;
  r.strapInNow();
  const frame = (fp) => {
    lr.update(r, 1 / 60, false);
    v.setFirstPerson(fp); chair.setFirstPerson(fp);
    v.boardStowed = lr.lift?.kind === 'gondola';
    v.update(r, 1 / 60, false, false, lr.airborneRide);
    chair.update(lr.lift, r.x, r.y, r.z, r.heading, lr.cableY);
    s.lifts.update(10, { x: r.x, y: r.z, z: -r.y });
  };
  const spawned0 = v.spray.spawned;
  for (let k = 0; k < 90; k++) frame(false);
  const sprayed = v.spray.spawned - spawned0;
  const cabin = chair.group.children.find((o) => o.name === 'rider cabin');
  if (!cabin) return { cabin: false };
  // positions in the rider's cabin frame (origin at its grip), from this frame's matrices: the ride moves it every frame
  const local = (p) => { chair.group.updateMatrixWorld(true); return p.clone().applyMatrix4(cabin.matrixWorld.clone().invert()); };
  const bones = v.rig.bones, P = (n) => { v.group.updateMatrixWorld(true); return local(bones[n].getWorldPosition(cabin.position.clone())).toArray().map((x) => +x.toFixed(2)); };
  const hips = P('Hips'), lFoot = P('LeftFoot'), rFoot = P('RightFoot');
  let lowest = Infinity, lowestName = '';
  for (const n of Object.keys(bones)) { const y = P(n)[1]; if (y < lowest) { lowest = y; lowestName = n; } }
  const shell = cabin.children.find((o) => o.name === 'cabin shell'), glass = cabin.children.find((o) => o.name === 'cabin glass'), racked = cabin.children.find((o) => o.name === 'racked board');
  // carriers on the line: the one nearest the rider is scaled to nothing
  const m = new cabin.matrixWorld.constructor(), q = cabin.position.clone();
  let hidden = 0, nearest = Infinity;
  for (let k = 0; k < l.carriers.count; k++) { l.carriers.getMatrixAt(k, m); const e = m.elements; if (Math.abs(e[0]) + Math.abs(e[5]) + Math.abs(e[10]) < 1e-6) hidden++; else { q.setFromMatrixPosition(m); nearest = Math.min(nearest, Math.hypot(q.x - r.x, q.z + r.y)); } }
  // eyes: first person and helmet cam, straight ahead and looking round
  const eyes = {};
  for (const mode of ['fp', 'helmet']) {
    cam.mode = mode;
    const out = [];
    for (const [dx, dy] of [[0, 0], [2000, 0], [-2000, 0], [0, -2000], [0, 2000]]) {
      cam.lookYaw = 0; cam.lookPitch = 0;
      frame(true);
      const e = v.eye(cabin.position.clone());
      cam.updateFirstPerson(r, 1 / 60, false, true, dx, dy, e);
      out.push(local(cam.camera.position).toArray().map((x) => +x.toFixed(2)));
    }
    eyes[mode] = out;
  }
  const shellBody = shell ? shell.layers.isEnabled(1) && shell.layers.isEnabled(0) : false, glassFp = glass ? glass.layers.isEnabled(1) && !glass.layers.isEnabled(0) : false;
  // chase: let it settle behind the cabin
  cam.mode = 'chase';
  for (let k = 0; k < 240; k++) { frame(false); cam.update(r, 1 / 60, false, true); }
  const chase = local(cam.camera.position).toArray().map((x) => +x.toFixed(2));
  return {
    cabin: true, grip: +(chair.group.position.y - lr.cableY).toFixed(3),
    hips, lFoot, rFoot,
    lowest: +lowest.toFixed(2), lowestName, rigBoard: v.rig.board.visible, racked: !!racked?.visible,
    shellBody, glassFp, sprayed,
    hidden, nearest: +nearest.toFixed(1), eyes, chase,
  };
}, lift.i);

// LiftModels CABIN: floor top -3.7, bench seat top 0.48 above it (RiderRig ANKLE_H: boot soles 0.1 m under the ankles) on the end walls 1.3 m from the middle, walls at x +-1.1,
// the window head (ceiling) at -1.45; the cabin's local frame here is the rider's cabin (origin at its grip)
const FLOOR = -3.7, SEAT = FLOOR + 0.48, ANKLE_H = 0.1, HALF_W = 1.1, HALF_D = 1.3, CEIL = -1.48;
check('the rider rides in the cabin built to be seen from inside', mid.cabin);
if (mid.cabin) {
  check('its grip is on the cable', Math.abs(mid.grip) < 0.05, `${mid.grip} m`);
  check('no cabin on the line overlaps the rider cabin', mid.nearest > 3, `${mid.hidden} hidden, nearest shown ${mid.nearest} m`);
  check('the rider sits on the back bench', mid.hips[2] < -HALF_D + 0.5 && Math.abs(mid.hips[1] - SEAT - 0.1) < 0.2, `hips at ${mid.hips} (seat top ${SEAT})`);
  const feetOk = [mid.lFoot, mid.rFoot].every((f) => f[1] - ANKLE_H > FLOOR - 0.02 && f[1] - ANKLE_H < FLOOR + 0.06);
  check('both boots rest on the floor', feetOk, `soles at ${(mid.lFoot[1] - ANKLE_H).toFixed(2)} / ${(mid.rFoot[1] - ANKLE_H).toFixed(2)}, floor ${FLOOR}`);
  check('no part of the rider is below the floor', mid.lowest - ANKLE_H > FLOOR - 0.02, `lowest ${mid.lowestName} at ${mid.lowest}`);
  check('the board is off the feet, in the rack outside the doors', !mid.rigBoard && mid.racked, `rig board ${mid.rigBoard ? 'shown' : 'hidden'}, racked ${mid.racked ? 'shown' : 'hidden'}`);
  check('no snow spray off the rider while riding', mid.sprayed === 0, `${mid.sprayed} particles in 1.5 s`);
  check('first person draws the cabin with the body (glass once)', mid.shellBody && mid.glassFp);
  for (const [mode, list] of Object.entries(mid.eyes)) {
    const inside = list.every(([x, y, z]) => Math.abs(x) < HALF_W - 0.05 && Math.abs(z) < HALF_D - 0.05 && y > FLOOR + 0.9 && y < CEIL - 0.05);
    const ahead = list[0];
    check(`${mode} eye stays inside the cabin, looking round too`, inside, list.map((p) => `(${p})`).join(' '));
    check(`${mode} eye is at seated head height`, ahead[1] - FLOOR > 1.0 && ahead[1] - FLOOR < 1.5, `${(ahead[1] - FLOOR).toFixed(2)} m above the floor`);
  }
  const [cx, cy, cz] = mid.chase;
  check('the chase camera is outside the cabin', Math.abs(cx) > HALF_W || Math.abs(cz) > HALF_D || cy > -1.2 || cy < FLOOR - 0.1, `(${mid.chase})`);
}

// the top: out on foot, strapping in, then strapped in with the board back on the feet
const top = await page.evaluate((i) => {
  const s = window.__sim, r = s.rider, lr = s.liftRide, v = s.riderView, l = s.lifts.all[i];
  lr.lift = l; lr.up = s.lifts.rideLength(l) - 0.01;
  lr.update(r, 1 / 60, false);
  const out = { riding: lr.riding, state: r.strapState, onFoot: r.onFoot, speed: +Math.hypot(r.vx, r.vy).toFixed(2) };
  const input = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false };
  for (let k = 0; k < 240; k++) {
    r.update(1 / 60, input);
    v.boardStowed = lr.riding && lr.lift?.kind === 'gondola';
    v.update(r, 1 / 60, false, false, false);
  }
  return { ...out, after: r.strapState, afterFoot: r.onFoot, board: v.rig.board.visible };
}, lift.i);
check('at the top the rider steps out on foot and straps in', !top.riding && top.state === 'on' && top.onFoot && top.speed < 0.1, `${top.state}, ${top.onFoot ? 'on foot' : 'on the board'}, ${top.speed} m/s`);
check('then rides away strapped in with the board on the feet', top.after === 'none' && !top.afterFoot && top.board, `${top.after}, ${top.afterFoot ? 'on foot' : 'on the board'}, board ${top.board ? 'shown' : 'hidden'}`);

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (fails.length) { console.log(`\n${fails.length} failed: ${fails.join(', ')}`); process.exit(1); }
console.log('\nall gondola checks passed');
