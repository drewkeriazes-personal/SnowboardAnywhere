// Skate check (BUG-054): rides the Rider physics on exact inclined planes (no pack, no browser) holding the
// skate key, and checks:
//   - from a standstill on any slope under SKATE_SLOPE, whichever way the board points (across the hill too,
//     where the uphill-edge hold used to zero the push), the rider reaches 2 m/s within 3 s
//   - the snowboarder unclips the back foot first (no push for SKATE_UNCLIP s), then pushes only while the boot is planted
//   - letting go clips back in within half a second, from pushing or part way through the unclip
//   - pressing again while clipping in unclips again; a fast or steep rider clips in on their own and is never one-footed there
//   - one-footed, jump, tuck and the hard carve do nothing; a crash clips the foot back in
//   - standing still across the hill with nothing pressed still holds; skis skate with no unclip
// node tools/skatecheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skatecheck-'));
const out = path.join(dir, 'rider.mjs');
const tun = path.join(dir, 'tuning.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'Rider.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'rider', 'tuning.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tun, logLevel: 'error' });
const { Rider } = await import(pathToFileURL(out).href);
const { SKATE_MAX, SKATE_SLOPE, SKATE_UNCLIP } = await import(pathToFileURL(tun).href);

const D = Math.PI / 180;
/** plane falling toward +y (north) at `deg` degrees */
function plane(deg) {
  const t = Math.tan(deg * D), k = 1 / Math.hypot(t, 1);
  return {
    mask: null, coarseFallbacks: 0,
    groundHeight: (x, y) => -t * y,
    groundNormal: (x, y, o = [0, 0, 1]) => { o[0] = 0; o[1] = t * k; o[2] = k; return o; },
  };
}
const input = (skate = true) => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, lean: 0, skate });
const DT = 1 / 120;
// headings (radians from +y, clockwise): the plane falls toward +y
const DOWN = 0, ACROSS = Math.PI / 2, UP = Math.PI;

function start(deg, heading, disc = 'board') {
  const r = new Rider(plane(deg), null);
  r.discipline = disc;
  r.reset(0, 0, heading);
  for (let i = 0; i < 60; i++) r.update(DT, input(false)); // settle onto the snow
  return r;
}
/** run `t` s with `inp`, calling `each(r, t)` after every step */
function run(r, t, inp, each) {
  for (let s = 0; s < t; s += DT) { r.update(DT, inp); each?.(r, s + DT); }
}

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

console.log('hold skate 3 s from a standstill, snowboard:');
const name = { [DOWN]: 'down the hill', [ACROSS]: 'across the hill', [UP]: 'up the hill' };
for (const deg of [0, 1, 3, 6, 9, 15, 19]) {
  for (const h of [ACROSS, DOWN, UP]) {
    if (deg === 0 && h !== ACROSS) continue;
    if (h === UP && deg > 9) continue; // pointed straight up a steeper pitch the board slides back however hard you push
    const r = start(deg, h);
    const x0 = r.x, y0 = r.y;
    run(r, 3, input());
    const moved = Math.hypot(r.x - x0, r.y - y0);
    // pushing up a slope steeper than 3 degrees is slow (as it was before BUG-054): it only has to climb
    const climb = h === UP && deg > 3;
    const ok = climb ? moved > 0.3 && r.y < y0 : r.speed >= 2;
    check(`${deg} deg, ${name[h]}`, ok, `${r.speed.toFixed(2)} m/s, moved ${moved.toFixed(1)} m${climb ? ' up the hill' : ''}, ${r.skate}`);
  }
}

{
  // the unclip: no push while the back foot comes out, then pushing; strokes push only while planted
  const r = start(0, ACROSS);
  let vUnclip = 0, onAt = NaN, accPlanted = 0, accSwing = 0, lastV = r.speed;
  run(r, 2, input(), (r, t) => {
    if (r.skate === 'unclip') vUnclip = Math.max(vUnclip, r.speed);
    if (r.skate === 'on' && Number.isNaN(onAt)) onAt = t;
    if (r.skate === 'on' && t > onAt + 0.05) { const dv = r.speed - lastV; if (r.skatePhase < 0.45) accPlanted += dv; else accSwing += dv; }
    lastV = r.speed;
  });
  check('unclips before pushing', vUnclip < 0.05 && Math.abs(onAt - SKATE_UNCLIP) < 0.03, `pushing from ${onAt.toFixed(3)} s (SKATE_UNCLIP ${SKATE_UNCLIP}), top speed while unclipping ${vUnclip.toFixed(3)} m/s`);
  check('the push comes from the planted boot', accPlanted > 1 && accSwing <= 0.01, `${accPlanted.toFixed(2)} m/s gained while planted, ${accSwing.toFixed(3)} while the boot swings forward`);
  // let go: clipped back in within half a second
  let inAt = NaN;
  run(r, 1, input(false), (r, t) => { if (r.skate === 'none' && Number.isNaN(inAt)) inAt = t; });
  check('letting go clips back in', inAt <= 0.5, `clipped in after ${inAt.toFixed(3)} s`);
}
{
  // let go part way through the unclip, then press again part way through the clip-in
  const r = start(3, ACROSS);
  run(r, 0.15, input());
  const mid = r.skateFoot;
  let inAt = NaN;
  run(r, 0.6, input(false), (r, t) => { if (r.skate === 'none' && Number.isNaN(inAt)) inAt = t; });
  check('letting go mid-unclip clips back in', inAt <= 0.5, `foot ${mid.toFixed(2)} out, back in after ${inAt.toFixed(3)} s`);
  run(r, 2, input());
  run(r, 0.2, input(false));
  const clipping = r.skate, foot = r.skateFoot;
  run(r, 0.05, input());
  check('pressing again while clipping in unclips', clipping === 'clip' && r.skate === 'unclip' && Math.abs(r.skateFoot - foot) < 0.2, `${clipping} at foot ${foot.toFixed(2)}, then ${r.skate} at ${r.skateFoot.toFixed(2)}`);
}
{
  // fast or steep: clipped in on its own, never one-footed there
  const steep = start(SKATE_SLOPE + 5, ACROSS);
  let seen = 'none';
  run(steep, 2, input(), (r) => { if (r.skate !== 'none') seen = r.skate; });
  check('no skating steeper than SKATE_SLOPE', seen === 'none', `${SKATE_SLOPE + 5} deg: ${seen}`);
  const down = start(8, DOWN);
  // the clip-in takes SKATE_CLIP s, so the speed runs on a little past SKATE_MAX before the foot is in
  let oneTop = 0, top = 0, clipped = false;
  run(down, 6, input(), (r) => { top = Math.max(top, r.speed); if (r.oneFooted) oneTop = Math.max(oneTop, r.speed); if (r.skate === 'clip') clipped = true; });
  check('picking up speed clips in', clipped && oneTop < SKATE_MAX + 0.8 && down.skate === 'none', `8 deg down the hill: top ${top.toFixed(1)} m/s, one-footed up to ${oneTop.toFixed(2)} m/s (SKATE_MAX ${SKATE_MAX}), ends ${down.skate}`);
}
{
  // one-footed: no jump, tuck or hard carve
  const r = start(0, ACROSS);
  run(r, 1.5, input());
  const inp = input(); inp.jumpHeld = true; inp.tuck = true; inp.squat = true; inp.steer = 1;
  run(r, 0.3, inp);
  inp.jumpHeld = false; inp.jumpReleased = true;
  let air = false;
  run(r, 0.5, inp, (r) => { if (!r.onGround) air = true; inp.jumpReleased = false; });
  check('one-footed: no jump, squat or hard carve', !air && r.jumpCharge === 0 && r.squat === 0 && r.hardCarve === 0 && r.skate === 'on', `air ${air}, charge ${r.jumpCharge.toFixed(2)}, squat ${r.squat.toFixed(2)}, hard carve ${r.hardCarve.toFixed(2)}, ${r.skate}`);
  r.crash(1);
  r.update(DT, input());
  check('a crash clips the foot back in', r.skate === 'none', r.skate);
}
{
  // standing still across the hill with nothing pressed holds as before: with the fall line Off it stands, and
  // Realistic (FEAT-134) an edge not held creeps (0.06 m at 3 deg, 0.23 m at 6 deg over 3 s on main before BUG-054)
  for (const [deg, fl, most] of [[3, 0, 0.01], [6, 0, 0.01], [3, 1, 0.08], [6, 1, 0.3]]) {
    const r = start(deg, ACROSS);
    r.fallLine = fl;
    const x0 = r.x, y0 = r.y;
    run(r, 3, input(false));
    const moved = Math.hypot(r.x - x0, r.y - y0);
    check(`${deg} deg across, nothing pressed, fall line ${fl ? 'Realistic' : 'Off'}, holds as before`, moved < most, `moved ${moved.toFixed(3)} m (at most ${most})`);
  }
}
{
  const r = start(3, ACROSS, 'ski');
  let unclip = false;
  run(r, 3, input(), (r) => { if (r.skate === 'unclip' || r.skate === 'clip') unclip = true; });
  check('skis skate with no unclip', r.speed >= 2 && !unclip, `${r.speed.toFixed(2)} m/s`);
}

if (fails) { console.log(`\n${fails} check(s) failed`); process.exit(1); }
console.log('\nall skate checks passed');
