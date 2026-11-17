// Rock ramp check (BUG-141): rides straight at one rampable rock on an exact flat plane (no pack, no browser)
// through the rider's own 60 fps update loop and reports the peak height above the snow, the speed kept and
// whether the hit threw you, in each jump mode. Real: no rock sends you higher than its top plus 0.3 m at
// 10, 20 or 30 m/s, a small rock just bumps you, a mid rock gives a small pop and a tall rock hit square and
// fast throws you (a tall rock taken slow or glancing still rides over). Arcade keeps the old kicker launch.
// node tools/rockcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rockcheck-')), 'rock.mjs');
const src = path.join(GAME, 'src', 'sim').replace(/\\/g, '/');
await build({
  stdin: { contents: `export { Rider } from '${src}/Rider.ts'; export { Collider } from '${src}/Collider.ts'; export { ROCK_RAMP } from '${src}/rider/tuning.ts';`, resolveDir: GAME, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { Rider, Collider, ROCK_RAMP } = await import(pathToFileURL(out).href);

const flat = { mask: null, coarseFallbacks: 0, groundHeight: () => 0, groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = 0; o[2] = 1; return o; } };
const FRAME = 1 / 60;
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0 });

/** ride north at `v` m/s into a rock `h` m tall (sized as world/Rocks.ts sizes one: radius 0.55 / 0.6 of its
 *  height), its centre `off` m to the side (0 square, near radius + body a graze). Returns the peak height
 *  above the snow (m), the speed kept just after the hit and whether it threw you. */
function ride(mode, v, h, off = 0) {
  const col = new Collider(), rad = h * 0.55 / 0.6, at = 6 + rad;
  col.add(off, at, rad, -1, h, 1);
  const r = new Rider(flat, col);
  r.jumpMode = mode; r.reset(0, 0, 0);
  for (let i = 0; i < 30; i++) r.update(FRAME, input()); // settle on the snow
  let peak = 0, hit = false, kept = 0, crashed = false;
  for (let k = 0; k < 900; k++) {
    if (!hit) { r.vx = 0; r.vy = v; } // hold the speed to the rock
    const before = r.lastHit;
    r.update(FRAME, input());
    if (!hit && (r.lastHit === 'ramp' || r.lastHit === 'wall' || r.lastHit === 'graze') && r.lastHit !== before) { hit = true; kept = Math.hypot(r.vx, r.vy) / v; }
    peak = Math.max(peak, r.z);
    crashed ||= r.crashed > 0;
    if (hit && r.onGround && k > 0 && r.y > at + rad + 2) break;
    if (hit && crashed && k > 120) break;
  }
  return { peak, kept, crashed, hit };
}

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }
const m = (x) => `${x.toFixed(2)} m`;
const R = ROCK_RAMP.real;

for (const v of [10, 20, 30]) {
  for (const h of [0.54, 0.9, 1.1, 1.6]) {
    const a = ride('real', v, h);
    check(`Real ${v} m/s into a ${h} m rock: apex under its top + ${R.lift} m`, a.hit && a.peak <= h + R.lift + 0.02, `peak ${m(a.peak)}${a.crashed ? " (thrown)" : ""}, kept ${(a.kept * 100).toFixed(0)}%`);
  }
}
const bump = ride('real', 15, 0.4);
check('Real small rock (0.4 m) at 15 m/s bumps you', bump.hit && !bump.crashed && bump.peak <= 0.4 + R.bumpLift + 0.02 && bump.kept > 0.9, `peak ${m(bump.peak)}, kept ${(bump.kept * 100).toFixed(0)}%`);
const mid = ride('real', 15, 0.9);
check('Real mid rock (0.9 m) at 15 m/s pops you a little over it', mid.hit && !mid.crashed && mid.peak > 0.9 + 0.1 && mid.kept < bump.kept, `peak ${m(mid.peak)}, kept ${(mid.kept * 100).toFixed(0)}%`);
const tall = ride('real', 20, 1.6);
check('Real tall rock (1.6 m) square at 20 m/s throws you', tall.hit && tall.crashed && tall.peak < 1, `peak ${m(tall.peak)}, crashed ${tall.crashed}`);
const slow = ride('real', 8, 1.6);
check('Real tall rock (1.6 m) square at 8 m/s rides over', slow.hit && !slow.crashed && slow.peak <= 1.6 + R.lift + 0.02, `peak ${m(slow.peak)}, crashed ${slow.crashed}`);
for (const v of [20, 30]) {
  const a = ride('real', v, 1.6, 1.6 * 0.55 / 0.6 + 0.1);
  check(`Real tall rock (1.6 m) glanced at ${v} m/s doesn't throw you or launch you`, a.hit && !a.crashed && a.peak <= 1.6 + R.lift + 0.02, `peak ${m(a.peak)}, crashed ${a.crashed}`);
}
// Arcade: the old kicker, vz = v * min(0.9, 0.25 + 0.9) * 0.5 + 1.5 off a 1.5 m+ rock hit square
for (const v of [10, 20, 30]) {
  const a = ride('arcade', v, 1.6), vz = v * 0.9 * ROCK_RAMP.arcade.kick + ROCK_RAMP.arcade.base, want = 1.6 - 0.3 + vz * vz / (2 * 9.81);
  check(`Arcade ${v} m/s into a 1.6 m rock still launches you`, a.hit && !a.crashed && Math.abs(a.peak - want) < 0.35, `peak ${m(a.peak)}, expected about ${m(want)}`);
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
