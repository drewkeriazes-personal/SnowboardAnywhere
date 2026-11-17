// Rock check (BUG-141, BUG-149), no pack, no browser.
// Colliders: builds each rock variant's geometry as world/Rocks.ts does, places it the way Rocks.ts does (sunk and
// scaled by type, on flat snow) and checks the collider stands no higher than the drawn rock and that a rock
// that barely shows (all talus) has none. Before BUG-149 every collider stood 0.6 times the rock's size up.
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
      export { makeRock, rockCollider, rockSeed, VARIANTS, SINK, HEIGHT, ROCK_MIN_TOP } from '${src}/world/Rocks.ts';`,
    resolveDir: GAME, loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { Rider, Collider, ROCK_RAMP, makeRock, rockCollider, rockSeed, VARIANTS, SINK, HEIGHT, ROCK_MIN_TOP } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const m = (x) => `${x.toFixed(2)} m`;

// ---- colliders against the drawn rocks (BUG-149)
const TYPES = ['outcrop', 'boulder', 'talus'];
for (let t = 0; t < 3; t++) {
  let worst = -Infinity, buriedWithCollider = 0, count = 0, drawnMax = 0;
  for (let v = 0; v < VARIANTS; v++) {
    const g = makeRock(rockSeed(v)), pos = g.getAttribute('position');
    let gy = -Infinity;
    for (let i = 0; i < pos.count; i++) gy = Math.max(gy, pos.getY(i));
    g.computeBoundingBox();
    for (const size of [1, 1.5, 2.5, 4, 6, 8, 12]) {
      const drawn = size * (gy * HEIGHT[t] - SINK[t]); // the highest vertex above the snow, upright on flat snow
      drawnMax = Math.max(drawnMax, drawn);
      const c = rockCollider(size, t, g.boundingBox.max.y);
      if (c) { worst = Math.max(worst, c.top - drawn); count++; }
      if (c && drawn < ROCK_MIN_TOP) buriedWithCollider++;
    }
  }
  check(`${TYPES[t]} colliders no higher than the drawn rock`, worst <= 0.01 && buriedWithCollider === 0, `${count} with a collider, worst ${count ? m(worst) : '-'} above, tallest drawn ${m(drawnMax)} (the old collider stood 0.6 x size: ${m(0.6 * 2.5)} on a median 2.5 m rock)`);
}
{
  let talus = 0;
  for (let v = 0; v < VARIANTS; v++) { const g = makeRock(rockSeed(v)); g.computeBoundingBox(); for (const size of [1, 2.5, 6, 12]) if (rockCollider(size, 2, g.boundingBox.max.y)) talus++; }
  check('buried talus has no collider', talus === 0, `${talus} talus colliders`);
}

// ---- riding into a rock (BUG-141)
const flat = { mask: null, coarseFallbacks: 0, groundHeight: () => 0, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = 0; o[2] = 1; return o; } };
const FRAME = 1 / 60;
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0 });

/** ride north at `v` m/s into a rock `h` m tall and `rad` m across, its centre `off` m to the side (0 square).
 *  Returns the peak height above the snow (m), the speed kept just after the hit, the hit kind and whether it threw you. */
function ride(mode, v, h, { off = 0, rad = 1 } = {}) {
  let scrapeT = 0;
  const col = new Collider(), at = 6 + rad;
  col.add(off, at, rad, -1, h, 1);
  const r = new Rider(flat, col);
  r.jumpMode = mode; r.reset(0, 0, 0);
  for (let i = 0; i < 30; i++) r.update(FRAME, input()); // settle on the snow
  let peak = 0, hit = '', kept = 0, crashed = false;
  for (let k = 0; k < 900; k++) {
    if (!hit) { r.vx = 0; r.vy = v; } // hold the speed to the rock
    r.update(FRAME, input());
    if (!hit && r.lastHit) { hit = r.lastHit; kept = Math.hypot(r.vx, r.vy) / v; }
    peak = Math.max(peak, r.z);
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

// Arcade: the old kicker, vz = v * min(0.9, 0.25 + 0.9) * 0.5 + 1.5 off a 1.5 m+ rock hit square
for (const v of [10, 20, 30]) {
  const a = ride('arcade', v, 1.6), vz = v * 0.9 * ROCK_RAMP.arcade.kick + ROCK_RAMP.arcade.base, want = 1.6 - 0.3 + vz * vz / (2 * 9.81);
  check(`Arcade ${v} m/s into a 1.6 m rock still launches you`, a.hit === 'ramp' && !a.crashed && Math.abs(a.peak - want) < 0.35, `peak ${m(a.peak)}, expected about ${m(want)}`);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
