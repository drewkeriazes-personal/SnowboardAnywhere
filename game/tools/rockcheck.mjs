// Rock check (BUG-141, BUG-149), no pack, no browser.
// Colliders: builds each rock variant's geometry and places it with world/Rocks.ts's placeRock on flat snow and on
// slopes, and checks the collider covers the part drawn above the snow, tops out at its highest point and that a
// rock that barely shows has none. Before BUG-149 every collider stood 0.6 times the rock's size up round the centre.
// Riding: rides straight and slanting into one rampable rock on an exact flat plane through the rider's own
// 60 fps update loop, in each jump mode. Realistic: no rock ever lifts you above its top; with the speed and a
// gentle enough face on your line you ride up and over it (scraping), paying the climb out of your speed; too slow
// or too steep it is solid (bounces you off, fast it throws you, glanced you slide along). Arcade keeps the kicker.
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
const TYPES = ['outcrop', 'boulder', 'talus'], M = new Matrix4(), FIT = { x: 0, y: 0, radius: 0, top: 0, base: 0 };
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
/** an exact plane falling toward +y at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * Math.PI / 180), k = 1 / Math.hypot(t, 1);
  return { mask: null, coarseFallbacks: 0, groundHeight: (x, y) => -t * y, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; } };
}
const flat = { mask: null, coarseFallbacks: 0, groundHeight: () => 0, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = 0; o[2] = 1; return o; } };
const FRAME = 1 / 60;
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0 });

/** ride north at `v` m/s into a rock `h` m tall and `rad` m across, its centre `off` m to the side (0 square).
 *  Returns the peak height above the snow (m), the speed kept just after the hit, the hit kind and whether it threw you. */
function ride(mode, v, h, { off = 0, rad = 1, deg = 0 } = {}) {
  let scrapeT = 0;
  const col = new Collider(), at = 6 + rad, t = Math.tan(deg * Math.PI / 180), c = Math.cos(deg * Math.PI / 180);
  const hitAt = at - rad - 0.4; // the snow where you meet it: `h` is its height above you there
  col.add(off, at, rad, -t * at - 1, -t * hitAt + h, 1);
  const r = new Rider(deg ? plane(deg) : flat, col);
  r.jumpMode = mode; r.reset(0, 0, 0);
  for (let i = 0; i < 30; i++) r.update(FRAME, input()); // settle on the snow
  let peak = 0, hit = '', kept = 0, crashed = false;
  for (let k = 0; k < 900; k++) {
    if (!hit) { r.vx = 0; r.vy = v; } // hold the speed to the rock
    r.update(FRAME, input());
    if (!hit && r.lastHit) { hit = r.lastHit; kept = Math.hypot(r.vx, r.vy) / v; }
    peak = Math.max(peak, (r.z + t * r.y) * c); // off the snow, square to it
    if (r.rockOver > 0) scrapeT += FRAME;
    crashed ||= r.crashed > 0;
    if (hit && r.onGround && k > 120) break;
  }
  return { peak, kept, crashed, hit, scrapeT };
}
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const R = ROCK_RAMP.real, G = 9.81, BODY = 0.4;

// rocks as Rocks.ts draws them: a low hump, a mid one and the biggest on Vail (size about 9 at radius 0.55 x size)
const ROCKS = [[0.2, 1.4], [0.5, 3.3], [0.9, 5]];
for (const v of [10, 20, 30]) {
  for (const [h, rad] of ROCKS) {
    const a = ride('real', v, h, { rad });
    const want = Math.sqrt(1 - 2 * G * h / (v * v)) * (1 - R.loss);
    check(`Real ${v} m/s square into a ${h} m rock: up and over, never above its top`, a.hit === 'rock' && !a.crashed && a.peak <= h + 0.02 && Math.abs(a.kept - want) < 0.03,
      `${a.hit}, peak ${m(a.peak)}, kept ${pct(a.kept)} (climb and scrape ${pct(want)})`);
  }
}
const over = ride('real', 15, 0.5, { rad: 3.3, scrape: true });
check('Real ridden over a rock: the scrape sounds while over it', over.scrapeT > 0.1 && over.scrapeT <= R.scrapeMax + 0.02, `scrape ${over.scrapeT.toFixed(2)} s`);
const slow = ride('real', 3, 0.5, { rad: 3.3 });
check('Real 0.5 m rock square at 3 m/s: too slow to climb, stops you, no crash', slow.hit === 'wall' && !slow.crashed && slow.peak < 0.05, `${slow.hit}, peak ${m(slow.peak)}, crashed ${slow.crashed}`);
const steep = ride('real', 20, 1, { rad: 0.8 });
check('Real steep 1 m rock square at 20 m/s: too steep to climb, throws you', steep.hit === 'wall' && steep.crashed && steep.peak < 0.05, `${steep.hit}, crashed ${steep.crashed}`);
const square = ride('real', 20, 0.8, { rad: 0.8 });
check('Real 45 deg 0.8 m rock square at 20 m/s: too steep on that line, throws you', square.hit === 'wall' && square.crashed, `${square.hit}, crashed ${square.crashed}`);
const across = ride('real', 20, 0.8, { rad: 0.8, off: 0.95 * (0.8 + BODY) });
check('Real 45 deg 0.8 m rock clipped on a slanting line at 20 m/s: up and over its edge', across.hit === 'rock' && !across.crashed && across.peak <= 0.82, `${across.hit}, peak ${m(across.peak)}, kept ${pct(across.kept)}`);
const graze = ride('real', 20, 1, { rad: 0.8, off: 0.95 * (0.8 + BODY) });
check('Real steep (51 deg) 1 m rock glanced at 20 m/s: never climbed, slides along it', graze.hit === 'graze' && !graze.crashed && graze.peak < 0.05, `${graze.hit}, kept ${pct(graze.kept)}`);

for (const deg of [15, 30]) for (const v of [12, 25]) {
  const a = ride('real', v, 0.5, { rad: 3.3, deg });
  check(`Real ${v} m/s down a ${deg} deg slope into a 0.5 m rock: over it, never more than its height off the slope`, a.hit === 'rock' && !a.crashed && a.peak <= 0.5 + 0.05, `${a.hit}, peak ${m(a.peak)} off the snow`);
}

// Arcade: the old kicker, vz = v * min(0.9, 0.25 + 0.9) * 0.5 + 1.5 off a 1.5 m+ rock hit square
for (const v of [10, 20, 30]) {
  const a = ride('arcade', v, 1.6), vz = v * 0.9 * ROCK_RAMP.arcade.kick + ROCK_RAMP.arcade.base, want = 1.6 - 0.3 + vz * vz / (2 * 9.81);
  check(`Arcade ${v} m/s into a 1.6 m rock still launches you`, a.hit === 'ramp' && !a.crashed && Math.abs(a.peak - want) < 0.35, `peak ${m(a.peak)}, expected about ${m(want)}`);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
