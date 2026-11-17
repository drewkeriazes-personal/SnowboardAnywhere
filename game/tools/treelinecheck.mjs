// Worn tree lines (FEAT-333) and glade trim (FEAT-303): builds the tree lines of a real pack (Vail by default) from its
// runs and its detected trees, the way the game does at load (pack/treeLines.ts, no browser), and checks:
//   - the same runs and trees give the same lines every time
//   - Steep and Deep (trees14, 1827, -3506): at least 2 corridors within 60 m of the run, the spot itself off them
//     (snowcheck's deep-powder spot)
//   - no detected trunk inside a corridor anywhere in the pack (the lines bend round them or squeeze past)
//   - the generated stems leave the corridors: a full-density stand over the trees14 cell grows no stem in one, the
//     same stand away from every line loses none
//   - the trim: full in the Steep and Deep trees, none in forest far from every run
//   - the snow on a line is tracked (chop) and shallower than the powder either side; a storm softens it
//   - the build takes under 1.5 s of CPU
// node tools/treelinecheck.mjs [pack]        (exit code 1 if a check fails; packs from SHOT_PACKS or the repo's packs/)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME, PACKS } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const slug = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'vail';
const packDir = path.join(PACKS, slug);
if (!fs.existsSync(path.join(packDir, 'features.json'))) { console.log(`no pack at ${packDir} (npm run get ${slug}, or SHOT_PACKS)`); process.exit(1); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'treelinecheck-'));
const entry = path.join(dir, 'entry.ts');
const rel = (p) => path.relative(dir, path.join(GAME, 'src', p)).replace(/\\/g, '/');
fs.writeFileSync(entry, `export { TreeLines, TrunkIndex } from '${rel('pack/treeLines')}';
export { generateStems } from '${rel('world/trees/stands')}';
export { snowAt, newSnowState, DEFAULT_SNOW_WORLD } from '${rel('sim/SnowConditions')}';\n`);
const out = path.join(dir, 'entry.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { TreeLines, TrunkIndex, generateStems, snowAt, newSnowState, DEFAULT_SNOW_WORLD } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

const features = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
const treeFiles = fs.existsSync(path.join(packDir, 'trees')) ? fs.readdirSync(path.join(packDir, 'trees')).filter((n) => n.endsWith('.bin')) : [];
const readTrees = (n) => { const b = fs.readFileSync(path.join(packDir, 'trees', n)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const cells = treeFiles.map(readTrees);

function make() {
  const t0 = performance.now();
  const tl = new TreeLines(features.runs);
  const trunks = new TrunkIndex();
  for (const c of cells) trunks.add(c, 6);
  const broken = tl.avoid(trunks);
  tl.finish();
  return { tl, broken, ms: performance.now() - t0 };
}
const a = make(), b = make(), tl = a.tl;
console.log(`${slug}: ${(tl.length / 1000).toFixed(0)} km of tree lines, ${tl.count} segments, ${a.broken} steps broken at a trunk, ${a.ms.toFixed(0)} ms`);
check('the same lines every time', a.tl.seg.length === b.tl.seg.length && a.tl.seg.every((v, i) => v === b.tl.seg[i]), `${b.tl.count} segments on the second build`);
check('the build is quick', a.ms < 1500, `${a.ms.toFixed(0)} ms for the lines and ${cells.reduce((s, c) => s + c.length / 6, 0)} trunks`);

// Steep and Deep: crossings of corridors along transects across the run, within 60 m of it
if (slug === 'vail') {
  const P = [1827, -3506];
  let best = 0;
  for (let dy = -40; dy <= 40; dy += 10) {
    let n = 0, was = false;
    for (let dx = -60; dx <= 60; dx += 0.25) { const on = tl.inCorridor(P[0] + dx, P[1] + dy); if (on && !was) n++; was = on; }
    best = Math.max(best, n);
  }
  check('Steep and Deep has tree lines beside the run', best >= 2, `${best} corridors crossed on the best transect within 60 m of trees14`);
  check('the trees14 powder spot is off the lines', tl.wornAt(P[0], P[1]) === 0, `worn ${tl.wornAt(P[0], P[1]).toFixed(2)}`);
  check('the Steep and Deep trees are trimmed', tl.trimAt(P[0], P[1]) > 0.9, `trim ${tl.trimAt(P[0], P[1]).toFixed(2)}`);
}

// no detected trunk inside a corridor
let inside = 0, total = 0;
for (const c of cells) for (let i = 0; i < c.length; i += 6) { total++; if (tl.inCorridor(c[i], c[i + 1])) inside++; }
check('no detected trunk stands in a corridor', inside === 0, `${inside} of ${total}`);

// the generated stems: a full-density 4 m stand over a 1 km cell round the lines' busiest spot
let bx = 0, by = 0, most = -1;
const counts = new Map();
for (let i = 0; i < tl.count; i++) { const k = `${Math.floor(tl.seg[i * 6] / 1000)},${Math.floor(tl.seg[i * 6 + 1] / 1000)}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
for (const [k, n] of counts) if (n > most) { most = n; [bx, by] = k.split(',').map((v) => Number(v) * 1000); }
const size = 250, res = 4, px = new Uint8ClampedArray(size * size * 2 * 4);
for (let i = 0; i < size * size; i++) { px[i * 4] = 255; px[i * 4 + 1] = 60; px[i * 4 + 3] = 255; }
const g = { px, size, res, minX: bx, minY: by, zBase: 0, zScale: 1, hStep: 0.25 };
const all = generateStems(g, 1), kept = generateStems(g, 1, null, (x, y) => tl.clears(x, y));
let inLine = 0;
for (let i = 0; i < kept.length; i += 6) if (tl.inCorridor(kept[i], kept[i + 1]) || tl.clears(kept[i], kept[i + 1])) inLine++;
check('no generated stem in a corridor', inLine === 0 && kept.length < all.length, `${(all.length - kept.length) / 6} of ${all.length / 6} stems left out in the 1 km cell at (${bx}, ${by}), ${inLine} in a line`);
const far = { ...g, minX: meta.instances ? meta.instances.minX - 50000 : -1e6, minY: -1e6 };
check('stems away from every line all stay', generateStems(far, 1, null, (x, y) => tl.clears(x, y)).length === generateStems(far, 1).length, 'a stand far outside the pack');

// trim: none in forest far from every run (the farthest of a coarse grid of points inside the pack)
const runs = features.runs.flatMap((r) => r.points);
let farPt = null, farD = 0;
const box = meta.terrain.fine ?? meta.terrain.coarse;
for (let x = box.minX + 200; x < box.maxX - 200; x += 250) for (let y = box.minY + 200; y < box.maxY - 200; y += 250) {
  let d = Infinity;
  for (const p of runs) d = Math.min(d, Math.hypot(p[0] - x, p[1] - y));
  if (d > farD) { farD = d; farPt = [x, y]; }
}
if (farPt) check('no trim far from the runs', tl.trimAt(farPt[0], farPt[1]) === 0, `trim ${tl.trimAt(farPt[0], farPt[1]).toFixed(2)} at (${farPt.join(', ')}), ${farD.toFixed(0)} m from a run point`);

// snow: on a line (worn 1) against beside it (worn 0), under the trees on a 25 degree north face at 1 pm
const n = [0, Math.sin(25 * Math.PI / 180), Math.cos(25 * Math.PI / 180)];
const surf = (worn) => ({ rock: 0, scree: 0, groomed: 0, canopy: 0.7, moguls: 0, shrub: 0, worn });
const w = { ...DEFAULT_SNOW_WORLD, zLow: 2500, zHigh: 3500 };
const on = snowAt(surf(1), n, 3200, w, newSnowState()), off = snowAt(surf(0), n, 3200, { ...w }, newSnowState());
check('the line is tracked, beside it is powder', on.kind === 'chop' && off.kind === 'powder', `on the line ${on.kind} (chop ${on.chop.toFixed(2)}), beside it ${off.kind} (powder ${off.powder.toFixed(2)})`);
check('the line is shallower than the powder', on.depth < off.depth * 0.6, `${(on.depth * 100).toFixed(0)} cm vs ${(off.depth * 100).toFixed(0)} cm`);
const storm = snowAt(surf(1), n, 3200, { ...w, storm: 1, newSnow: 0.6 }, newSnowState());
check('a storm softens the line', storm.chop < on.chop, `chop ${storm.chop.toFixed(2)} in a storm vs ${on.chop.toFixed(2)}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall tree line checks passed');
process.exit(fails ? 1 : 0);
