// Tree well check (FEAT-216): stamps the wells (world/TreeWells.ts) round trees on an exact 15 degree plane at 3,000 m
// (no pack, no browser) and rides the Rider physics past them:
//   - in February powder the snow by a big spruce's trunk is well below the snow 3 m away (0.5 to 1 m at the trunk)
//   - on a groomer (the mask's groomed share 1) the snow there is level, and an aspen has no well
//   - a spring day's well is shallower, July has none
//   - a board ridden past the spruce drops into its well
// node tools/wellcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wellcheck-'));
const entry = path.join(dir, 'entry.ts');
const src = (p) => JSON.stringify(path.join(GAME, 'src', p).replace(/\\/g, '/'));
fs.writeFileSync(entry, ['sim/Rider.ts', 'sim/Snowpack.ts', 'world/TreeWells.ts'].map((m) => `export * from ${src(m)};`).join('\n'));
const out = path.join(dir, 'sim.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Rider, TreeWells, snowpackState } = await import(pathToFileURL(out).href);

const T = Math.tan(15 * Math.PI / 180), Z0 = 3000;
const plane = (x, y) => Z0 - T * y;
let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

/** wells on the plane round `trees` ([x, y, h, crown radius, species]), the groomed share everywhere `groomed` */
function field(trees, st, day = 'mid', groomed = 0) {
  const pack = {
    mask: { sample: (x, y, o) => { o[0] = o[1] = o[3] = 0; o[2] = groomed; return o; } },
    fallAt: (x, y, o) => { o[0] = 0; o[1] = T; return o; },
  };
  const src = { forEachTree: (x0, y0, x1, y1, fn) => { for (const [x, y, h, cr, sp] of trees) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(x, y, plane(x, y), h, cr, sp); } };
  const w = new TreeWells(pack, src);
  w.setSnow(st, day);
  w.update(0, 20);
  return w;
}
const feb = snowpackState(2, 'mid', 0);
const spruce = [[0, 20, 22, 2.9, 0]];
const dip = (w) => w.at(0.3, 20) - w.at(3, 20);

const pow = field(spruce, feb);
check('a spruce in February powder has a well', pow.count === 1 && dip(pow) < -0.5 && dip(pow) > -1.01, `${pow.at(0.3, 20).toFixed(2)} m by the trunk, ${pow.at(3, 20).toFixed(2)} m at 3 m`);
const groom = field(spruce, feb, 'mid', 1);
check('level on a groomer', Math.abs(dip(groom)) < 1e-3, `${dip(groom).toFixed(3)} m`);
const aspen = field([[0, 20, 22, 2.9, 1]], feb);
check('an aspen has none', aspen.count === 0 && dip(aspen) === 0, `${dip(aspen).toFixed(3)} m`);
const spring = field(spruce, snowpackState(4, 'spring', 0), 'spring');
check('a spring day\'s well is shallower', dip(spring) > 0.5 * dip(pow) && dip(spring) < 0, `${dip(spring).toFixed(2)} m`);
const jul = field(spruce, snowpackState(7, 'mid', 0));
check('none in July', dip(jul) === 0, `${dip(jul).toFixed(3)} m`);

// ---- ride straight down past the spruce, the board's line 0.8 m to its side
const input = () => ({ steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false });
function ride(w) {
  const g = (x, y) => plane(x, y) + (w ? w.at(x, y) : 0);
  const pack = {
    mask: null, coarseFallbacks: 0, groundHeight: g,
    groundNormal: (x, y, o = [0, 0, 1]) => {
      const d = 0.25, nx = -(g(x + d, y) - g(x - d, y)) / (2 * d), ny = -(g(x, y + d) - g(x, y - d)) / (2 * d), l = Math.hypot(nx, ny, 1);
      o[0] = nx / l; o[1] = ny / l; o[2] = 1 / l; return o;
    },
  };
  const r = new Rider(pack, null);
  r.reset(0.8, 0, 0);
  r.vy = 8; r.vz = -T * 8;
  let low = 0, t = 0;
  while (r.y < 30 && t < 8) { r.update(1 / 120, input()); if (r.y > 18 && r.y < 22) low = Math.min(low, r.z - plane(r.x, r.y)); t += 1 / 120; }
  return low;
}
const clear = ride(null), past = ride(pow);
check('the board drops into the well', past < clear - 0.1, `lowest ${past.toFixed(2)} m against the plane (${clear.toFixed(2)} with no well)`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
