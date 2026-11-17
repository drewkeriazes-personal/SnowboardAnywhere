// Rock check (BUG-141, BUG-149), no pack, no browser.
// Colliders: builds each rock variant's geometry and places it with world/Rocks.ts's placeRock on flat snow and on
// slopes, and checks the collider covers the part drawn above the snow, tops out at its highest point and that a
// rock that barely shows has none. Before BUG-149 every collider stood 0.6 times the rock's size up round the centre.
// Riding: rides straight and slanting into one rock on flat snow and down a 30 deg slope through the rider's own
// 60 fps update loop, in each jump mode. Realistic: a rock is ground, its dome: you ride up and over it, never
// through it (never below the dome while over it) and never above it (no higher than the rock off the snow), on
// rock while on it (the scrape); too slow you stall and slide back; square into a face steeper than ROCK_FACE it
// stops you like a trunk (thrown when fast). Arcade keeps the kicker.
// node tools/rockcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rockcheck-')), 'rock.mjs');
const src = path.join(GAME, 'src').replace(/\\/g, '/');
await build({
  stdin: {
    contents: `export { Rider } from '${src}/sim/Rider.ts'; export { Collider } from '${src}/sim/Collider.ts'; export { ROCK_RAMP } from '${src}/sim/rider/tuning.ts';
      export { makeRock, rockPoints, placeRock, rockCollider, rockSeed, VARIANTS, ROCK_MIN_TOP } from '${src}/world/Rocks.ts'; export { Matrix4 } from 'three';`,
    resolveDir: GAME, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { Rider, Collider, ROCK_RAMP, makeRock, rockPoints, placeRock, rockCollider, rockSeed, VARIANTS, ROCK_MIN_TOP, Matrix4 } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const m = (x) => `${x.toFixed(2)} m`;

// ---- colliders against the drawn rocks (BUG-149)
// every variant of each type, sizes 1.5, 2.5 (Vail's median) and 6, spun 8 ways, on flat snow and on 15, 30 and
// 40 deg slopes, placed by Rocks.ts's own placeRock. Points standing 0.2 m or more above the snow must sit inside the
// collider (within the rider's body radius of it), its top must be the highest point drawn, and a rock showing less
// than ROCK_MIN_TOP has none. The old collider was 0.6 x size up round the centre whatever showed.
const TYPES = ['outcrop', 'boulder', 'talus'], M = new Matrix4(), FIT = { x: 0, y: 0, radius: 0, top: 0, base: 0, ground: 0, wall: false };
const PTS = Array.from({ length: VARIANTS }, (_, v) => rockPoints(makeRock(rockSeed(v))));
for (const deg of [0, 15, 30, 40]) {
  const a = deg * Math.PI / 180, nn = [0, Math.sin(a), Math.cos(a)], t = Math.tan(a); // the snow falls toward +y: z = -t * y
  for (let ty = 0; ty < 3; ty++) {
    let rocks = 0, withCol = 0, pts = 0, outside = 0, topErr = 0, shown = 0, missing = 0;
    for (let v = 0; v < VARIANTS; v++) for (const size of [1.5, 2.5, 6]) for (let k = 0; k < 8; k++) {
      rocks++;
      placeRock(M, 0, 0, 0, size, k * Math.PI / 4, ty, nn);
      const c = rockCollider(PTS[v], M, 0, 0, 0, nn, FIT), e = M.elements, P = PTS[v];
      let most = 0, hi = -Infinity;
      for (let i = 0; i < P.length; i += 3) {
        const px = e[0] * P[i] + e[4] * P[i + 1] + e[8] * P[i + 2] + e[12], pz = e[1] * P[i] + e[5] * P[i + 1] + e[9] * P[i + 2] + e[13];
        const py = -(e[2] * P[i] + e[6] * P[i + 1] + e[10] * P[i + 2] + e[14]), above = pz + t * py;
        most = Math.max(most, above);
        if (above >= 0.05) hi = Math.max(hi, pz);
        if (above < 0.2) continue;
        pts++;
        if (!c || Math.hypot(px - c.x, py - c.y) > c.radius + 0.4) outside++;
      }
      if (most >= ROCK_MIN_TOP) shown++;
      if (most >= ROCK_MIN_TOP && !c) missing++;
      if (c) { withCol++; topErr = Math.max(topErr, Math.abs(c.top - hi)); }
    }
    check(`${TYPES[ty]} on ${deg} deg snow: the collider covers the drawn rock`, missing === 0 && outside <= 0.02 * pts && topErr < 1e-3,
      `${shown} of ${rocks} show, ${withCol} colliders, ${outside} of ${pts} points 0.2 m up outside one, top off by ${m(topErr)}`);
  }
}

// ---- riding into a rock (BUG-141)
const FRAME = 1 / 60, G = 9.81;
const input = () => ({ steer: 0, tuck: true, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0 });
/** an exact plane falling toward +y at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * Math.PI / 180), k = 1 / Math.hypot(t, 1);
  return { mask: null, coarseFallbacks: 0, groundHeight: (x, y) => -t * y, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; } };
}
const pct = (x) => `${(x * 100).toFixed(0)}%`;

/** ride straight down (+y) at `v` m/s into a rock standing `H` m above the snow at its centre, `R` m round, its
 *  centre `off` m to the side, on a `deg` slope. On flat snow the speed is held until 1 m short of it, on a slope
 *  set once at the start. Returns how far the rider ever was below the dome while over it (m), the most it stood
 *  above the snow (m), whether it crossed the rock, slid back, crashed, rode on rock, the first hit and the speed
 *  kept just past it. */
function ride(mode, v, H, R, { off = 0, deg = 0 } = {}) {
  const t = Math.tan(deg * Math.PI / 180), c = Math.cos(deg * Math.PI / 180), at = 12, g0 = -t * at;
  const col = new Collider(), rb = { b: 0, gx: 0, gy: 0 };
  col.add(off, at, R, g0 - 1, g0 + H, 1, mode === 'real' ? g0 : NaN);
  const r = new Rider(deg ? plane(deg) : flat, col);
  r.jumpMode = mode; r.reset(0, 0, 0);
  for (let i = 0; i < 20; i++) r.update(FRAME, input());
  r.vx = 0; r.vy = v * c; r.vz = -v * Math.sin(deg * Math.PI / 180);
  let under = 0, above = 0, back = false, crashed = false, onRock = false, hit = '', kept = 0, peakAir = 0;
  for (let k = 0; k < 600; k++) {
    if (!deg && r.y < at - R - 1) { r.vx = 0; r.vy = v; }
    r.update(FRAME, input());
    const b = col.rockBump(r.x, r.y, rb).b, snow = -t * r.y;
    if (b > 0.05) under = Math.max(under, snow + b - r.z);
    above = Math.max(above, (r.z - snow) * c);
    if (r.y > at + R) peakAir = Math.max(peakAir, (r.z - snow) * c);
    back ||= r.vy < -0.2; crashed ||= r.crashed > 0; onRock ||= r.surface.rock > 0.5;
    if (!hit && r.lastHit) hit = r.lastHit;
    if (!kept && r.y > at + R + 1) kept = Math.hypot(r.vx, r.vy, r.vz) / v;
  }
  return { under, above, crossed: r.y > at + R, back, crashed, onRock, hit, kept, peakAir };
}
const flat = plane(0);
const say = (a) => `under the rock ${m(a.under)}, top ${m(a.above)} off the snow, ${a.crossed ? 'crossed' : 'did not cross'}${a.back ? ', slid back' : ''}${a.crashed ? ', thrown' : ''}${a.hit ? `, hit ${a.hit}` : ''}${a.kept ? `, kept ${pct(a.kept)}` : ''}`;

// the rocks Rocks.ts draws, standing H above the snow at the centre, R round: low humps to Vail's big slabs
const GENTLE = [[0.2, 1.4], [0.5, 3], [0.9, 4], [2, 6]];
for (const v of [8, 14, 25]) for (const [H, R] of GENTLE) {
  const a = ride('real', v, H, R);
  check(`Real ${v} m/s square into a ${H} m rock (${R} m round): up and over, never through or above it`, a.crossed && !a.crashed && !a.back && a.onRock && a.under < 0.03 && a.above <= H + 0.03, say(a));
}
const slow = ride('real', 2, 0.5, 3);
check('Real 0.5 m rock at 2 m/s: too slow, stalls and slides back, never through it', !slow.crossed && slow.back && !slow.crashed && slow.under < 0.03, say(slow));
const steep = ride('real', 14, 2, 3.6); // its rim 48 deg
check('Real steep 2 m rock (48 deg rim) square at 14 m/s: stops you like a trunk, thrown', !steep.crossed && steep.crashed && steep.hit === 'wall' && steep.above < 0.05, say(steep));
const slant = ride('real', 14, 2, 3.6, { off: 0.9 * (3.6 + 0.4) });
check('Real steep 2 m rock met on a slanting line at 14 m/s: never through or above it', !slant.crashed && slant.under < 0.03 && slant.above <= 2.03, say(slant));
for (const v of [8, 14, 25]) for (const [H, R] of [[0.5, 3], [2, 3.6]]) {
  const a = ride('real', v, H, R, { deg: 30 });
  check(`Real ${v} m/s down a 30 deg slope into a ${H} m rock (${R} m round): never through or above it`, !a.crashed && a.under < 0.03 && a.above <= H + 0.05 && a.peakAir <= H + 0.05, `${say(a)}, past it ${m(a.peakAir)} off the snow`);
}

// Arcade: the old kicker, vz = v * min(0.9, 0.25 + 0.9) * 0.5 + 1.5 off a 1.5 m+ rock hit square
for (const v of [10, 20, 30]) {
  const a = ride('arcade', v, 1.6, 1), vz = v * 0.9 * ROCK_RAMP.arcade.kick + ROCK_RAMP.arcade.base, want = 1.6 - 0.3 + vz * vz / (2 * G);
  check(`Arcade ${v} m/s into a 1.6 m rock still launches you`, a.hit === 'ramp' && !a.crashed && Math.abs(a.above - want) < 0.35, `peak ${m(a.above)}, expected about ${m(want)}`);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
