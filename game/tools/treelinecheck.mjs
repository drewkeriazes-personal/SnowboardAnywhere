// Worn tree lines (FEAT-333) and glade trim (FEAT-303): builds the tree lines of a real pack (Vail by default) from its
// runs and its detected trees, the way the game does at load (pack/treeLines.ts, no browser), and checks:
//   - the same runs and trees give the same lines every time
//   - Steep and Deep: at least 2 lines dropping in from the cat track at its top; (trees14, 1827, -3506) 3 or 4 bobsled runs (dug over 0.5 m) within 60 m of the run, the spot itself off them
//     (snowcheck's deep-powder spot)
//   - no detected trunk inside a corridor anywhere in the pack (the lines bend round them or squeeze past)
//   - the generated stems leave the trenches for their banks: a full-density stand round the busiest lines grows no stem
//     in a trench and keeps over 98 % of its stems, the same stand away from every line is unchanged
//   - the trim: full in the Steep and Deep trees, none in forest far from every run
//   - a full line is dug about a metre into the snow like a bobsled run, with a berm on its rim; no trunk in its walls
//   - the snow on a line is tracked (chop) and shallower than the powder either side; a storm softens it
//   - the build takes under 1.5 s of CPU
// FEAT-334: a pack with baked lines (treeLines.json, MapPacker pipeline/tree_lines.py) is checked on those, as the game loads
// them; --runs checks the plan from the runs instead.
// node tools/treelinecheck.mjs [pack] [--runs]        (exit code 1 if a check fails; packs from SHOT_PACKS or the repo's packs/)
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
export { snowAt, newSnowState, DEFAULT_SNOW_WORLD } from '${rel('sim/SnowConditions')}';
export { trimReach, standGate } from '${rel('world/trees/trim')}';\n`);
const out = path.join(dir, 'entry.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { TreeLines, TrunkIndex, generateStems, snowAt, newSnowState, DEFAULT_SNOW_WORLD, trimReach, standGate } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

const features = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(packDir, 'meta.json'), 'utf8'));
const treeFiles = fs.existsSync(path.join(packDir, 'trees')) ? fs.readdirSync(path.join(packDir, 'trees')).filter((n) => n.endsWith('.bin')) : [];
const readTrees = (n) => { const b = fs.readFileSync(path.join(packDir, 'trees', n)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const cells = treeFiles.map(readTrees);
const bakedFile = !process.argv.includes('--runs') && meta.treeLines ? path.join(packDir, meta.treeLines.file) : null;
const baked = bakedFile && fs.existsSync(bakedFile) ? JSON.parse(fs.readFileSync(bakedFile, 'utf8')) : null;

function make() {
  const t0 = performance.now();
  const tl = new TreeLines(features.runs, baked);
  let broken = 0;
  if (!baked) {
    const trunks = new TrunkIndex();
    for (const c of cells) trunks.add(c, 6);
    broken = tl.avoid(trunks);
  }
  tl.finish();
  return { tl, broken, ms: performance.now() - t0 };
}
const a = make(), b = make(), tl = a.tl;
console.log(`${slug}: ${(tl.length / 1000).toFixed(0)} km of tree lines ${baked ? `baked in the pack (${baked.lines.length} lines)` : `from the runs, ${a.broken} steps broken at a trunk`}, ${tl.count} segments, ${a.ms.toFixed(0)} ms`);
check('the same lines every time', a.tl.seg.length === b.tl.seg.length && a.tl.seg.every((v, i) => v === b.tl.seg[i]), `${b.tl.count} segments on the second build`);
check('the build is quick', a.ms < 1500, `${a.ms.toFixed(0)} ms for the lines and ${cells.reduce((s, c) => s + c.length / 6, 0)} trunks`);

// Steep and Deep: crossings of corridors along transects across the run, within 60 m of it
if (slug === 'vail') {
  const P = [1827, -3506];
  // deep runs (dug over half a metre) crossed on transects across the run every 10 m along it, 60 m either side
  const counts = [];
  for (let dy = -120; dy <= 120; dy += 10) {
    let n = 0, was = false;
    for (let dx = -60; dx <= 60; dx += 0.25) { const on = tl.trenchAt(P[0] + dx, P[1] + dy) < -0.5; if (on && !was) n++; was = on; }
    counts.push(n);
  }
  counts.sort((a, b) => a - b);
  const med = counts[counts.length >> 1];
  check('Steep and Deep has 3 or 4 bobsled runs beside it', med >= 3 && med <= 4, `median ${med} deep runs crossed within 60 m of the run (transects ${counts.join(' ')})`);
  // the entrances: lines leaving the cat track at the run's top (1611, -3997), down it toward (1635, -3922)
  const T0 = [1611, -3997], T1 = [1635, -3922], tl0 = Math.hypot(T1[0] - T0[0], T1[1] - T0[1]);
  const ux = (T1[0] - T0[0]) / tl0, uy = (T1[1] - T0[1]) / tl0;
  let entries = 0;
  for (const along of [20, 28, 36]) {
    let n = 0, was = false;
    for (let a = -30; a <= 30; a += 0.25) { const on = tl.trenchAt(T0[0] + ux * along - uy * a, T0[1] + uy * along + ux * a) < -0.3; if (on && !was) n++; was = on; }
    entries = Math.max(entries, n);
  }
  check('lines drop in from the cat track at the top of Steep and Deep', entries >= 2, `${entries} dug lines crossed 20 to 36 m below the top`);
  check('the trees14 powder spot is off the lines', tl.wornAt(P[0], P[1]) === 0, `worn ${tl.wornAt(P[0], P[1]).toFixed(2)}`);
  check('the Steep and Deep trees are trimmed', tl.trimAt(P[0], P[1]) > 0.9, `trim ${tl.trimAt(P[0], P[1]).toFixed(2)}`);
  check('the trees14 snow lies as it fell (no trench)', tl.trenchAt(P[0], P[1]) === 0, `${tl.trenchAt(P[0], P[1]).toFixed(2)} m`);
}

// the trench: the deepest point across each strong segment's middle, the berm just past its rim, nothing far off
let deep = 0, deepN = 0, bermN = 0, segs = 0, shallow = 0;
for (let i = 0; i < tl.count && segs < 2000; i += 37) {
  const o = i * 6, s = tl.seg;
  if (s[o + 5] < 0.95 || s[o + 4] < 1.2) continue;
  segs++;
  const mx = (s[o] + s[o + 2]) / 2, my = (s[o + 1] + s[o + 3]) / 2, l = Math.hypot(s[o + 2] - s[o], s[o + 3] - s[o + 1]) || 1;
  const nx = -(s[o + 3] - s[o + 1]) / l, ny = (s[o + 2] - s[o]) / l;
  const t = tl.trenchAt(mx, my);
  deep += t; deepN++;
  if (t > -0.5) shallow++;
  let bermUp = false;
  for (let d = 2.5; d <= 5; d += 0.25) for (const sg of [-1, 1]) if (tl.trenchAt(mx + nx * d * sg, my + ny * d * sg) > 0.05) bermUp = true;
  if (bermUp) bermN++;
}
check('a full line is dug into the snow', deepN > 100 && deep / deepN < -0.5 && shallow / deepN < 0.1, `mean ${(deep / deepN).toFixed(2)} m at the centre of ${deepN} full-strength segments, ${shallow} shallower than 0.5 m (lines crossing at an angle)`);
check('the pushed-aside snow banks up on the rim', bermN / deepN > 0.8, `${bermN} of ${deepN} with a berm over 5 cm 2.5 to 5 m out`);

// FEAT-335: the near index (2 m sub-cells of the segment grid) gives the same answers as every segment in the grid cell
{
  let seed = 7, diffT = 0, diffW = 0, n = 0;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const t0 = performance.now();
  for (let k = 0; k < 40000; k++) {
    const i = Math.floor(rnd() * tl.count), o = i * 6, u = rnd(), s = tl.seg;
    const x = s[o] + (s[o + 2] - s[o]) * u + (rnd() - 0.5) * 14, y = s[o + 1] + (s[o + 3] - s[o + 1]) * u + (rnd() - 0.5) * 14;
    diffT = Math.max(diffT, Math.abs(tl.trenchAt(x, y) - tl.withoutIndex(() => tl.trenchAt(x, y))));
    diffW = Math.max(diffW, Math.abs(tl.wornAt(x, y) - tl.withoutIndex(() => tl.wornAt(x, y))));
    n++;
  }
  check('the near index gives the same answers as the lines themselves', diffT === 0 && diffW === 0, `largest difference over ${n} points within 7 m of a line: trench ${diffT} m, wear ${diffW} (${(performance.now() - t0).toFixed(0)} ms)`);
}

// no detected trunk inside a corridor
let inside = 0, inWall = 0, total = 0;
for (const c of cells) for (let i = 0; i < c.length; i += 6) { total++; if (tl.inCorridor(c[i], c[i + 1])) inside++; if (tl.trenchAt(c[i], c[i + 1]) < -0.1) inWall++; }
check('no detected trunk stands in a corridor', inside === 0, `${inside} of ${total}`);
check('no detected trunk stands in a trench wall (it would float over the dug snow)', inWall === 0, `${inWall} of ${total} where the snow is dug over 10 cm`);

// the generated stems: a full-density 4 m stand over a 1 km cell round the lines' busiest spot
let bx = 0, by = 0, most = -1;
const counts = new Map();
for (let i = 0; i < tl.count; i++) { const k = `${Math.floor(tl.seg[i * 6] / 1000)},${Math.floor(tl.seg[i * 6 + 1] / 1000)}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
for (const [k, n] of counts) if (n > most) { most = n; [bx, by] = k.split(',').map((v) => Number(v) * 1000); }
const size = 250, res = 4, px = new Uint8ClampedArray(size * size * 2 * 4);
for (let i = 0; i < size * size; i++) { px[i * 4] = 255; px[i * 4 + 1] = 60; px[i * 4 + 3] = 255; }
const g = { px, size, res, minX: bx, minY: by, zBase: 0, zScale: 1, hStep: 0.25 };
const place = (x, y, out) => tl.placeStem(x, y, out);
const all = generateStems(g, 1), kept = generateStems(g, 1, null, place);
const keptFull = tl.withoutIndex(() => generateStems(g, 1, null, place));
check('the stems stand where they did without the near index (FEAT-335)', keptFull.length === kept.length && keptFull.every((v, i) => v === kept[i]), `${keptFull.length / 6} and ${kept.length / 6} stems`);
let inTrench = 0, nearBank = 0, banked = 0;
for (let i = 0; i < kept.length; i += 6) {
  const t = tl.trenchAt(kept[i], kept[i + 1]);
  if (tl.inCorridor(kept[i], kept[i + 1]) || t < -0.05) inTrench++;
  if (t > 0.02) banked++; // on a berm: right at the bank
}
for (let i = 0; i < all.length; i += 6) if (tl.trenchAt(all[i], all[i + 1]) < -0.05) nearBank++;
check('no generated stem in a trench', inTrench === 0, `${inTrench} of ${kept.length / 6} stems in the 1 km cell at (${bx}, ${by})`);
check('the stems a trench would take stand on its bank instead (the forest keeps its count)', kept.length / all.length > 0.98 && banked >= nearBank * 0.5, `${kept.length / 6} of ${all.length / 6} kept (${((1 - kept.length / all.length) * 100).toFixed(2)} % left out where lines cross); ${nearBank} planned in a trench, ${banked} now on a berm`);
const far = { ...g, minX: meta.instances ? meta.instances.minX - 50000 : -1e6, minY: -1e6 };
check('stems away from every line all stay', generateStems(far, 1, null, place).length === generateStems(far, 1).length, 'a stand far outside the pack');

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

// FEAT-303: the puffs see the crown the shader draws: a bare trunk sheds nothing at body height, an untrimmed tree all of it
const tt = [0, 0];
const bareBody = Math.max(...[0.3, 0.9, 1.6, 2.4].map((yy) => trimReach(1, 1, 1, 18, yy, tt)));
const fullBody = Math.min(...[0.3, 0.9, 1.6].map((yy) => trimReach(0, 0, 1, 18, yy, tt)));
const bush = trimReach(1, 0, 1, 18, 4.8, tt);
check('a bare-trimmed trunk has no needled crown at body height (no puffs from boughs that are not drawn)', bareBody === 0, `reach ${bareBody.toFixed(2)} of the crown from 0.3 to 2.4 m`);
check('an untrimmed tree keeps its whole crown, a trimmed one grows out over its trim line', fullBody === 1 && bush > 1.2, `untrimmed ${fullBody.toFixed(2)}, 0.6 m over the line ${bush.toFixed(2)}`);
check('only closed stands are trimmed', standGate(0.05) === 0 && standGate(0.5) === 1, `gate ${standGate(0.05)} at 5 % crown cover, ${standGate(0.5)} at 50 %`);

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : '\nall tree line checks passed');
process.exit(fails ? 1 : 0);
