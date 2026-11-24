// Snow under the trees check (FEAT-360): snowAt alone, no browser. On a low south face on a spring day a closed
// stand overhead (the canopy grid's score, 1) has less slush at 15:00 and less ice at 8:00 than the same spot in
// the open (score 0), the morning ice about halved; a score of 0 gives the same snow as no score at all.
// node tools/canopysnowcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopysnowcheck-'));
const out = path.join(dir, 'snow.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'sim', 'SnowConditions.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { snowAt, newSnowState, DEFAULT_SNOW_WORLD } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

const south = [0, -0.35, Math.sqrt(1 - 0.35 * 0.35)]; // about 20 degrees, facing south
const snow = (groomed, stand, hour, day = 'spring') => snowAt(
  { rock: 0, scree: 0, groomed, canopy: stand, moguls: 0, shrub: 0, stand },
  south, 2600, { ...DEFAULT_SNOW_WORLD, hour, day, zLow: 2500, zHigh: 3500 }, newSnowState());

for (const [where, g] of [['groomer', 1], ['off-piste', 0]]) {
  const open = snow(g, 0, 15), trees = snow(g, 1, 15);
  check(`${where} 15:00 less slush under the stand`, trees.slush < open.slush - 0.05, `open ${open.slush.toFixed(2)}, stand ${trees.slush.toFixed(2)}`);
  const openAm = snow(g, 0, 8), treesAm = snow(g, 1, 8);
  const r = treesAm.ice / openAm.ice;
  check(`${where} 8:00 refreeze about halved under the stand`, openAm.ice > 0.2 && r > 0.4 && r < 0.6, `open ${openAm.ice.toFixed(2)}, stand ${treesAm.ice.toFixed(2)} (x${r.toFixed(2)})`);
}

// a score of 0 is the snow there was before the score (the open ground rides as it did)
let worst = 0;
for (const day of ['fresh', 'mid', 'spring']) for (const hour of [7, 8, 10, 13, 15, 17]) for (const g of [0, 1]) {
  const a = snow(g, 0, hour, day);
  const b = snowAt({ rock: 0, scree: 0, groomed: g, canopy: 0, moguls: 0, shrub: 0 }, south, 2600, { ...DEFAULT_SNOW_WORLD, hour, day, zLow: 2500, zHigh: 3500 }, newSnowState());
  for (const k of ['groomed', 'powder', 'chop', 'ice', 'slush', 'grip', 'drag0', 'depth']) worst = Math.max(worst, Math.abs(a[k] - b[k]));
}
check('stand 0 matches no stand', worst === 0, `largest difference ${worst}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
