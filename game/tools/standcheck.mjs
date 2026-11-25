// Stand density stems (FEAT-074): generates a cell's stems from a synthetic stand image (no pack, no
// browser) and checks:
//   - the count matches the stand's chance per 4 m cell (the expected stems, within 3 %)
//   - the same image gives the same stems every time (seeded by position)
//   - a lower density keeps a subset of the stems a higher one draws (the Forest setting thins, never moves)
//   - every stem stays on the grid and off the open strip (FEAT-337: within its 4 m cell, or pulled up to 1.6 m toward
//     its clump in a closed stand), at the stand's height (0.75 to 1 times it) and species
//   - the ground height is the stored one, interpolated: on a 30 degree plane within 5 cm
//   - no stems where the chance is 0, none at density 0
//   - FEAT-298, a pack with crown widths: each stem's crown is the species radius times the cell's width factor
//     (lower half B / 100) times its own draw (mean 1, within the jitter); a species that does not widen keeps the
//     factor without a draw; a cell with no factor byte reads 1; the stems themselves are the same as without widths
//   - FEAT-337: a closed stand keeps its exact count and clumps by moving its stems; on a glade-density stand the stems clump (variance over mean of counts in 12 m squares), their spacing is in
//     the gladed 3 to 10 m band, and free paths down the fall line are longer than the even scatter's and than across
// node tools/standcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import { GAME } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standcheck-'));
const out = path.join(dir, 'stands.mjs');
await build({ entryPoints: [path.join(GAME, 'src', 'world', 'trees', 'stands.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { generateStems } = await import(pathToFileURL(out).href);

let fails = 0;
function check(label, ok, detail) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${detail}`); if (!ok) fails++; }

// a 1 km cell at (2000, -1000): the west half a closed stand (chance 0.9), a 40 m strip of open run down the
// middle, the east half a sparse stand (0.3); 15 m spruce in the west, 22 m fir (3) in the east; ground on a
// 30 degree plane rising to the north
const size = 250, res = 4, minX = 2000, minY = -1000, zBase = 2300, zScale = 32, hStep = 0.25;
const T = Math.tan(30 * Math.PI / 180), ground = (x, y) => 2800 + T * (y - minY);
const px = new Uint8ClampedArray(size * size * 2 * 4);
let expected = 0;
const chanceAt = (j) => (j < 115 ? 0.9 : j < 125 ? 0 : 0.3);
for (let i = 0; i < size; i++) {
  for (let j = 0; j < size; j++) {
    const o = (i * size + j) * 4, p = chanceAt(j);
    px[o] = Math.round(p * 255); px[o + 1] = Math.round((j < 125 ? 15 : 22) / hStep); px[o + 2] = j < 125 ? 0 : 3; px[o + 3] = 255;
    expected += Math.round(p * 255) / 255;
    const y = minY + size * res - (i + 0.5) * res, q = Math.round((ground(0, y) - zBase) * zScale);
    const ob = ((size + i) * size + j) * 4;
    px[ob] = q >> 8; px[ob + 1] = q & 255; px[ob + 3] = 255;
  }
}
const g = { px, size, res, minX, minY, zBase, zScale, hStep };
// FEAT-298: the stand image with width factors in the lower half's B: 1.4 in the west, none (0) in the east
const pxW = px.slice();
for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) pxW[((size + i) * size + j) * 4 + 2] = j < 125 ? 140 : 0;
const gW = { ...g, px: pxW };

const full = generateStems(g, 1);
const n = full.length / 6;
check('stem count follows the chance', Math.abs(n - expected) / expected < 0.03, `${n} stems, ${expected.toFixed(0)} expected`);
const again = generateStems(g, 1);
check('the same stems every time', again.length === full.length && again.every((v, i) => v === full[i]), `${again.length / 6} stems on the second run`);
const key = (a, i) => `${a[i * 6].toFixed(3)},${a[i * 6 + 1].toFixed(3)}`;
const fullSet = new Set(Array.from({ length: n }, (_, i) => key(full, i)));
const half = generateStems(g, 0.5), nh = half.length / 6;
let inFull = 0;
for (let i = 0; i < nh; i++) if (fullSet.has(key(half, i))) inFull++;
check('a lower density is a subset', inFull === nh && Math.abs(nh / n - 0.5) < 0.03, `${nh} stems at 0.5 (${(nh / n * 100).toFixed(1)} %), ${inFull} of them also at 1`);

let outside = 0, badH = 0, badSp = 0, onRun = 0, zErr = 0;
for (let i = 0; i < n; i++) {
  const b = i * 6, x = full[b], y = full[b + 1];
  const j = Math.floor((x - minX) / res), r = Math.floor((minY + size * res - y) / res);
  if (j < 0 || j >= size || r < 0 || r >= size) { outside++; continue; }
  if (j >= 115 && j < 125) onRun++;
  const h = j < 125 ? 15 : 22, sp = j < 125 ? 0 : 3;
  if (full[b + 3] < 0.75 * h - 0.2 || full[b + 3] > h + 0.2) badH++;
  if (full[b + 5] !== sp || full[b + 4] !== 0) badSp++;
  zErr = Math.max(zErr, Math.abs(full[b + 2] - ground(x, y)));
}
check('stems stay in their cell, off the open strip', outside === 0 && onRun === 0, `${outside} outside the cell, ${onRun} on the run`);
check('height and species from the stand', badH === 0 && badSp === 0, `${badH} heights and ${badSp} species or crowns off`);
check('ground height interpolated', zErr < 0.05, `worst ${zErr.toFixed(3)} m on a 30 degree plane`);
check('density 0 draws nothing', generateStems(g, 0).length === 0, `${generateStems(g, 0).length / 6} stems`);

// FEAT-298: crown widths
const SPR = 0.13, FIR = 0.1, cw = { open: 0.16, cover: [0.1, 0.5], jitter: 0.35, widen: [0, 3, 5, 9], k: Array(10).fill(1) };
const wide = generateStems(gW, 1, cw);
check('crown widths keep the same stems', wide.length === full.length && wide.every((v, i) => (i % 6 === 4 ? true : v === full[i])), `${wide.length / 6} stems`);
let wSum = 0, wN = 0, wLo = Infinity, wHi = 0, eastOff = 0;
const cwNo = { ...cw, widen: [3] };
const noDraw = generateStems(gW, 1, cwNo);
let noDrawOff = 0;
for (let i = 0; i < n; i++) {
  const b = i * 6, west = wide[b + 5] === 0;
  const k = wide[b + 4] / ((west ? SPR : FIR) * wide[b + 3]);
  if (west) { const d = k / 1.4; wSum += d; wN++; wLo = Math.min(wLo, d); wHi = Math.max(wHi, d); if (Math.abs(noDraw[b + 4] / (SPR * noDraw[b + 3]) - 1.4) > 1e-3) noDrawOff++; }
  else if (k < 0.65 - 1e-3 || k > 1.35 + 1e-3) eastOff++;
}
check('a stem widens by its cell factor and its own draw', wN > 0 && Math.abs(wSum / wN - 1) < 0.02 && wLo >= 0.65 - 1e-3 && wHi <= 1.35 + 1e-3,
  `west draw mean ${(wSum / wN).toFixed(3)}, ${wLo.toFixed(3)} to ${wHi.toFixed(3)} on factor 1.4`);
check('no factor byte reads 1, a non-widening species takes no draw', eastOff === 0 && noDrawOff === 0, `${eastOff} east stems off factor 1 x draw, ${noDrawOff} undrawn spruce off 1.4`);
check('without crown widths the crown stays 0', generateStems(gW, 1).every((v, i) => i % 6 !== 4 || v === 0), "the species' own");

// FEAT-337: clumps with gaps down the fall line, on the east half's glade-density stand (chance 0.3, 30 degree plane rising
// north, so the fall line runs south): clumped (the variance of counts in 12 m squares over their mean, about 1 for an even
// scatter), nearest-neighbour spacing in the gladed band (3 to 10 m), and longer free paths down the fall line than the
// even scatter gives, and than across the slope
const east = (a) => { const o = []; for (let i = 0; i < a.length; i += 6) if (a[i] > minX + 520 && a[i] < minX + size * res - 20 && a[i + 1] > minY + 20 && a[i + 1] < minY + size * res - 20) o.push(a[i], a[i + 1]); return o; };
const clumped = east(full), even = east(generateStems(g, 1, null, null, false));
function quadratVMR(pts) {
  const Q = 12, m = new Map();
  for (let i = 0; i < pts.length; i += 2) { const k = `${Math.floor(pts[i] / Q)},${Math.floor(pts[i + 1] / Q)}`; m.set(k, (m.get(k) ?? 0) + 1); }
  const nq = Math.floor(440 / Q) * Math.floor((size * res - 40) / Q), c = [...m.values()];
  const mean = pts.length / 2 / nq, varr = (c.reduce((t, v) => t + (v - mean) ** 2, 0) + (nq - c.length) * mean * mean) / nq;
  return varr / mean;
}
function grid(pts) { const m = new Map(); for (let i = 0; i < pts.length; i += 2) { const k = `${Math.floor(pts[i] / 4)},${Math.floor(pts[i + 1] / 4)}`; const l = m.get(k); if (l) l.push(i); else m.set(k, [i]); } return m; }
function nnMean(pts) {
  const m = grid(pts); let sum = 0, n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    let best = Infinity;
    for (let r = 1; r <= 4 && best === Infinity; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const l = m.get(`${Math.floor(pts[i] / 4) + dx},${Math.floor(pts[i + 1] / 4) + dy}`);
      if (l) for (const j of l) if (j !== i) best = Math.min(best, Math.hypot(pts[j] - pts[i], pts[j + 1] - pts[i + 1]));
    }
    if (best < Infinity) { sum += best; n++; }
  }
  return sum / n;
}
function freePath(pts, dx, dy) {
  const m = grid(pts); let sum = 0, n = 0;
  for (let k = 0; k < 400; k++) {
    let x = minX + 560 + ((k * 7919) % 400), y = minY + 120 + ((k * 104729) % 760);
    let d = 0;
    for (; d < 60; d += 0.5, x += dx * 0.5, y += dy * 0.5) {
      const l = m.get(`${Math.floor(x / 4)},${Math.floor(y / 4)}`);
      let hit = false;
      for (let gx = -1; gx <= 1 && !hit; gx++) for (let gy = -1; gy <= 1 && !hit; gy++) {
        const ll = m.get(`${Math.floor(x / 4) + gx},${Math.floor(y / 4) + gy}`);
        if (ll) for (const j of ll) if (Math.hypot(pts[j] - x, pts[j + 1] - y) < 0.6) { hit = true; break; }
      }
      if (hit) break;
    }
    sum += d; n++;
  }
  return sum / n;
}
const vC = quadratVMR(clumped), vE = quadratVMR(even), nnC = nnMean(clumped), fpC = freePath(clumped, 0, -1), fpE = freePath(even, 0, -1), fpX = freePath(clumped, 1, 0);
check('glade stems clump', vC > 1.3 && vC > 2 * vE, `counts in 12 m squares: variance / mean ${vC.toFixed(2)} clumped, ${vE.toFixed(2)} even`);
check('glade spacing in the gladed band', nnC >= 3 && nnC <= 10, `mean nearest neighbour ${nnC.toFixed(1)} m`);
check('longer free paths down the fall line than the even scatter, and than across', fpC > fpE * 1.05 && fpC > fpX * 1.05, `down ${fpC.toFixed(1)} m clumped vs ${fpE.toFixed(1)} m even, across ${fpX.toFixed(1)} m`);

// FEAT-337, the closed west half (chance 0.9): no room to add stems to a clump, so they move toward it instead: the same
// count as the even scatter, but clumped
const westOf = (a) => { const o = []; for (let i = 0; i < a.length; i += 6) if (a[i] > minX + 20 && a[i] < minX + 440 && a[i + 1] > minY + 20 && a[i + 1] < minY + size * res - 20) o.push(a[i], a[i + 1]); return o; };
const wC = westOf(full), wE = westOf(generateStems(g, 1, null, null, false));
const wv = quadratVMR(wC), wvE = quadratVMR(wE);
const westN = (a) => { let k = 0; for (let i = 0; i < a.length; i += 6) if (a[i] < minX + 460) k++; return k; };
const wnC = westN(full), wnE = westN(generateStems(g, 1, null, null, false));
check('a closed stand keeps its count and clumps by moving its stems', wnC === wnE && wv > wvE * 1.5, `${wnC} stems clumped, ${wnE} even; variance / mean ${wv.toFixed(2)} clumped, ${wvE.toFixed(2)} even`);

if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all stand checks passed');
