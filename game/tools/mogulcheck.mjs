// Mogul check (FEAT-059, FEAT-147): the bump function (size from the slope, spread, spacing, pattern
// changes down the run, clamp, creep, fall direction) and the
// Rider physics over a mogul field on exact planes (no pack, no browser). BUG-065: the snow tracks lie on the
// bumps as the 1 m mesh draws them, and the legs and the chase camera soak the bumps up. Riding a 25 degree bump run
// straight must throw the rider off the snow and bleed speed against the flat plane beside it; a
// field that appears under the rider (its tile loading late) must not drop or fling them. FEAT-268: tree line bumps
// break the open field's even wave, keep their size on the steep and nearly flatten (a few isolated bumps) on gentle
// pitches; on Vail (when packs/vail is there, else skipped) the same at the top and the runout of Steep and Deep.
// node tools/mogulcheck.mjs        (exit code 1 if a check fails)
import { build } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { GAME, PACKS } from './paths.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mogulcheck-'));
const bundle = async (entry, name) => {
  const out = path.join(dir, name);
  await build({ entryPoints: [path.join(GAME, 'src', ...entry)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  return import(pathToFileURL(out).href);
};
const { mogulHeight, mogulHeightGrad, mogulSize, fallFrom, downhillFrom, MOGUL_MAX_AMP, MOGUL_CELL } = await bundle(['terrain', 'Moguls.ts'], 'moguls.mjs');
const { Rider } = await bundle(['sim', 'Rider.ts'], 'rider.mjs');
const { BumpAbsorb } = await bundle(['world', 'BumpAbsorb.ts'], 'absorb.mjs');
const { ChaseCamera } = await bundle(['world', 'ChaseCamera.ts'], 'camera.mjs');
const { DrawnGround } = await bundle(['terrain', 'drawnGround.ts'], 'drawn.mjs');
const { TreeLines, LINE_MOGUL } = await bundle(['pack', 'treeLines.ts'], 'lines.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); if (!ok) fails++; };

// ---------------------------------------------------------------- shape
const D2R = Math.PI / 180;
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const corrOf = (p, q) => { const mp = mean(p), mq = mean(q); let n = 0, dp = 0, dq = 0; for (let i = 0; i < p.length; i++) { n += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2; } return n / Math.sqrt(dp * dq); };
const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
/** bump crests (local maxima over +-1 m, above 0.15 of the size) in a square patch on a plane falling
 *  to -y at `deg`, field strength `amp`, tree line pattern `line` (FEAT-268); 0.25 m grid, a 1 m border left out */
function crests(cx, cy, side, deg, amp, line = 0) {
  const t = Math.tan(deg * D2R), px = 0.25, n = Math.round(side / px), H = new Float64Array(n * n), out = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = mogulHeight(cx - side / 2 + i * px, cy - side / 2 + j * px, amp, 0, -t, 0, line);
  const floor = 0.15 * amp * mogulSize(t);
  for (let j = 4; j < n - 4; j++) for (let i = 4; i < n - 4; i++) {
    const h = H[j * n + i];
    if (h < floor) continue;
    let pk = true;
    for (let q = -4; q <= 4 && pk; q++) for (let r = -4; r <= 4; r++) if ((q || r) && H[(j + q) * n + i + r] > h) { pk = false; break; }
    if (pk) out.push(h);
  }
  return out;
}
{
  let zero = 0;
  for (let y = 0; y <= 60; y += 0.5) for (let x = 0; x <= 60; x += 0.5) zero += Math.abs(mogulHeight(x, y, 0, 0, -0.5, 0));
  check('amp 0 is flat', zero === 0);
  // FEAT-147: size from the slope. Crests over ten 40 m squares down each slope (several pattern regions)
  const field = (deg) => { const c = []; for (let k = 0; k < 10; k++) c.push(...crests(1234 + (k % 4) * 40, -600 - k * 40, 40, deg, 1)); return c; };
  const steep = field(33), mid = field(22), gentle = field(17);
  check('steep run (33 deg): the biggest bumps reach chest to head height (p95 1.3 to 1.8 m)', pct(steep, 0.95) >= 1.3 && Math.max(...steep) <= MOGUL_MAX_AMP + 1e-9,
    `p95 ${pct(steep, 0.95).toFixed(2)}, max ${Math.max(...steep).toFixed(2)} m`);
  check('moderate run (22 deg): bumps knee to thigh high (median 0.45 to 0.9 m)', pct(mid, 0.5) >= 0.45 && pct(mid, 0.5) <= 0.9, `median ${pct(mid, 0.5).toFixed(2)} m`);
  check('gentle run (17 deg): small bumps (p95 under 0.8 m)', pct(gentle, 0.95) < 0.8, `p95 ${pct(gentle, 0.95).toFixed(2)} m`);
  check('steeper is bigger', pct(gentle, 0.5) < pct(mid, 0.5) && pct(mid, 0.5) < pct(steep, 0.5),
    `medians ${pct(gentle, 0.5).toFixed(2)}, ${pct(mid, 0.5).toFixed(2)}, ${pct(steep, 0.5).toFixed(2)} m`);
  check('mogulSize grows with the slope', mogulSize(Math.tan(15 * D2R)) < 0.6 && mogulSize(Math.tan(40 * D2R)) * 1.3 <= MOGUL_MAX_AMP + 1e-9,
    `${mogulSize(Math.tan(15 * D2R)).toFixed(2)} .. ${mogulSize(Math.tan(40 * D2R)).toFixed(2)} m`);
  // less uniform: crest heights on one slope spread out (the old egg-crate's were all equal)
  const cv = Math.sqrt(mean(steep.map((h) => (h - mean(steep)) ** 2))) / mean(steep);
  check('crest heights vary (coefficient of variation over 0.12)', cv > 0.12, cv.toFixed(2));
  // spacing: 4 to 7 m along a line, staggered, so 3 to 9 crests per 100 m2
  const dens = steep.length / (10 * 38 * 38) * 100;
  check('3 to 9 bumps per 100 m2', dens >= 3 && dens <= 9, dens.toFixed(1));
  // pattern changes down the run: crest count over 80 m sections (one pattern region each) differs
  const counts = [];
  for (let k = 0; k < 8; k++) counts.push(crests(1250, -580 - k * 80, 36, 30, 1).length);
  check('the pattern changes down the run (crests per 80 m section vary by 30% or more)', Math.max(...counts) >= 1.3 * Math.min(...counts), counts.join(' '));
  // troughs reach the base; the cell blend can take them a little below it
  let lo = Infinity;
  for (let y = -700; y <= -560; y += 0.25) for (let x = 1200; x <= 1300; x += 0.5) lo = Math.min(lo, mogulHeight(x, y, 1, 0, -Math.tan(33 * D2R), 0));
  check('troughs reach the base, at most 0.4 m below it', lo < 0.02 && lo > -0.4, lo.toFixed(3));
  let big = 0;
  for (let y = 0; y <= 80; y += 0.5) for (let x = 0; x <= 80; x += 0.5) big = Math.max(big, mogulHeight(x, y, 5, 0, -2, 0));
  check(`amp 5 on a 63 deg face stays under ${MOGUL_MAX_AMP} m`, big <= MOGUL_MAX_AMP + 1e-9, big.toFixed(3));
  // creep moves the field uphill by its distance (the slow warp stays put, so not exactly)
  const prof = (creep, dy) => { const p = []; for (let y = -600; y >= -657; y -= 0.1) p.push(mogulHeight(1251.4, y + dy, 0.8, 0, -0.5, creep)); return p; };
  const c0 = corrOf(prof(0, 0), prof(2, 2));
  check('2 m of creep moves the field 2 m uphill', c0 > 0.9, c0.toFixed(2));
  // BUG-064: the pattern is anchored to local cells, so a small change in the fall direction moves the
  // bumps by the same small amount anywhere on the map (it used to scale with the distance from the
  // pack origin and scramble the field). Same 57 m path down the fall line, only the direction changes,
  // at every 7.5 degrees of heading and at 0 m, 700 m and 3 km from the origin.
  const SL = Math.tan(28 * D2R);
  const path = (ox, oy, deg, wob) => { const r = deg * D2R, r2 = (deg + wob) * D2R, p = []; for (let s = 0; s < 57; s += 0.1) p.push(mogulHeight(ox + Math.cos(r) * s, oy + Math.sin(r) * s, 0.8, SL * Math.cos(r2), SL * Math.sin(r2), 0)); return p; };
  // contrast over a 12 m square patch (a line down the fall line can sit on a flat row of the pattern)
  const patchSd = (cx, cy, deg) => { const r = deg * D2R, v = []; for (let i = -12; i <= 12; i++) for (let j = -12; j <= 12; j++) v.push(mogulHeight(cx + i * 0.5, cy + j * 0.5, 0.8, SL * Math.cos(r), SL * Math.sin(r), 0)); const m = mean(v); return Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / v.length); };
  for (const [ox, oy] of [[3, 7], [700, -700], [-2900, 1100]]) {
    let worst = 1, ratio = Infinity;
    // a cell corner (four cells blend equally) against the four cell centres around it (each cell
    // alone; FEAT-147: cells in different pattern regions have their own relief)
    const kx = Math.round(ox / MOGUL_CELL) * MOGUL_CELL, ky = Math.round(oy / MOGUL_CELL) * MOGUL_CELL, hc = MOGUL_CELL / 2;
    for (let deg = 0; deg < 360; deg += 7.5) {
      worst = Math.min(worst, corrOf(path(ox, oy, deg, 0), path(ox, oy, deg, 0.3)));
      const lone = (patchSd(kx - hc, ky - hc, deg) + patchSd(kx + hc, ky - hc, deg) + patchSd(kx - hc, ky + hc, deg) + patchSd(kx + hc, ky + hc, deg)) / 4;
      ratio = Math.min(ratio, patchSd(kx, ky, deg) / lone);
    }
    const d = Math.round(Math.hypot(ox, oy));
    check(`${d} m from the origin: a 0.3 deg turn of the fall line keeps the same bumps at every heading`, worst > 0.95, worst.toFixed(3));
    // FEAT-147's variance-preserving blend keeps a little less than BUG-062's smooth maximum did (about
    // 80%) but has no creases or steps at the band edges
    check(`${d} m from the origin: bumps where four cells blend keep at least 70% of the lone cells' relief at every heading`, ratio > 0.7, ratio.toFixed(2));
  }
  // no steps: the cell blend and the pattern regions join without a jump (the first FEAT-147 blend, a
  // weighted smooth maximum, snapped tall bumps in at the band edges); 1 cm steps down 400 m of cells
  {
    let worst = 0;
    const t = Math.tan(30 * D2R);
    for (let x = 1230; x < 1300; x += 0.5) for (let y = -560; y > -960; y -= 0.01) {
      worst = Math.max(worst, Math.abs(mogulHeight(x, y, 1, 0, -t, 0) - mogulHeight(x, y - 0.01, 1, 0, -t, 0)));
    }
    check('no steps: under 2 cm of change per 1 cm along the fall line', worst < 0.02, `${(worst * 100).toFixed(2)} cm`);
  }
  // the analytic slope the shader shades with matches the height's own slope (central differences),
  // including inside the cell blend bands; the slow warp is left out of it, so allow a little
  {
    const o = [0, 0, 0];
    let worst = 0, scale = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -900 + (i * 7.31) % 1800, y = -900 + (i * 13.7) % 1800, r = i * 0.37, e = 1e-3, fx = SL * Math.cos(r), fy = SL * Math.sin(r);
      const h = mogulHeightGrad(x, y, 0.8, fx, fy, 0.4, o);
      const gx = (mogulHeight(x + e, y, 0.8, fx, fy, 0.4) - mogulHeight(x - e, y, 0.8, fx, fy, 0.4)) / (2 * e);
      const gy = (mogulHeight(x, y + e, 0.8, fx, fy, 0.4) - mogulHeight(x, y - e, 0.8, fx, fy, 0.4)) / (2 * e);
      if (Math.abs(h - mogulHeight(x, y, 0.8, fx, fy, 0.4)) > 1e-12) worst = Infinity;
      worst = Math.max(worst, Math.hypot(o[1] - gx, o[2] - gy));
      scale = Math.max(scale, Math.hypot(gx, gy));
    }
    check('analytic slope matches the height within 6% of the steepest bump face', worst < 0.06 * scale, `${worst.toFixed(3)} of ${scale.toFixed(2)}`);
  }
  const f = [0, 0];
  fallFrom((x, y) => 0.4 * y, 10, 10, f);
  check('fallFrom on a plane falling to -y', Math.abs(f[0]) < 1e-3 && Math.abs(f[1] + 1) < 1e-3, `${f[0].toFixed(3)}, ${f[1].toFixed(3)}`);
  fallFrom(() => 100, 10, 10, f);
  check('fallFrom on flat ground is east', f[0] === 1 && f[1] === 0);
  downhillFrom((x, y) => 0.4 * y + 0.1 * x, 10, 10, f);
  check('downhillFrom carries the slope as its length', Math.abs(f[0] + 0.1) < 1e-9 && Math.abs(f[1] + 0.4) < 1e-9, `${f[0].toFixed(3)}, ${f[1].toFixed(3)}`);
}

// ---------------------------------------------------------------- FEAT-268: tree lines
{
  // crest heights over six 40 m squares down a plane
  const field = (deg, amp, line) => { const c = []; for (let k = 0; k < 6; k++) c.push(...crests(1234 + k * 40, -600 - k * 40, 40, deg, amp, line)); return c; };
  // a full-strength line against the same amplitude without the tree line pattern (main's line bumps), on the steep and
  // on a runout: crest height (p95) and how many crests stand over 0.1 m
  const vsMain = (deg) => {
    const line = field(deg, LINE_MOGUL, 1), main = field(deg, LINE_MOGUL, 0), n = (c) => c.filter((h) => h > 0.1).length;
    return { p95: pct(line, 0.95), main: pct(main, 0.95), share: n(line) / n(main) };
  };
  const steep = vsMain(27), flat = vsMain(11);
  check('tree lines (27 deg): the steep keeps main\'s bumps (p95 crest 0.85 to 1.15 of it)', steep.p95 >= 0.85 * steep.main && steep.p95 <= 1.15 * steep.main,
    `p95 ${steep.p95.toFixed(2)} vs ${steep.main.toFixed(2)} m`);
  check('tree lines (11 deg): a runout is nearly flat, a few isolated bumps (p95 under 0.35 of main\'s, under a third of its crests over 0.1 m)',
    flat.p95 < 0.35 * flat.main && flat.share < 1 / 3, `p95 ${flat.p95.toFixed(2)} vs ${flat.main.toFixed(2)} m, ${(flat.share * 100).toFixed(0)} % of the crests`);
  // the pattern along a line: 40 profiles 160 m down the fall line; crests (maxima over +-1 m, above 0.15 of the
  // profile's tallest, placed between samples by a parabola) and their spacings
  const along = (line) => {
    const t = Math.tan(27 * D2R), change = [], peaks = [];
    let repeats = 0;
    for (let k = 0; k < 40; k++) {
      const h = [];
      for (let s = 0; s < 160; s += 0.1) h.push(mogulHeight(1000 + k * 7.3, -500 - k * 37 - s, LINE_MOGUL, 0, -t, 0, line));
      const top = Math.max(...h), at = [];
      for (let i = 10; i < h.length - 10; i++) {
        if (h[i] < 0.15 * top) continue;
        let pk = true;
        for (let q = -10; q <= 10 && pk; q++) if (q && h[i + q] > h[i]) pk = false;
        if (pk) { const d = h[i - 1] - 2 * h[i] + h[i + 1]; at.push((i + (d < 0 ? 0.5 * (h[i - 1] - h[i + 1]) / d : 0)) * 0.1); }
      }
      const sp = at.slice(1).map((s, i) => s - at[i]);
      let run = 0;
      for (let i = 1; i < sp.length; i++) {
        change.push(Math.abs(sp[i] - sp[i - 1]) / ((sp[i] + sp[i - 1]) / 2));
        run = Math.abs(sp[i] - sp[i - 1]) <= 0.05 * sp[i - 1] ? run + 1 : 0;
        repeats = Math.max(repeats, run);
      }
      // autocorrelation of the height along the line: its peak over lags of 3 to 15 m (an even wave repeats near 1)
      const m = mean(h), v = h.map((x) => x - m), v0 = v.reduce((a, x) => a + x * x, 0);
      let best = -1;
      for (let lag = 30; lag <= 150; lag++) { let c = 0; for (let i = 0; i + lag < v.length; i++) c += v[i] * v[i + lag]; best = Math.max(best, c / v0 * v.length / (v.length - lag)); }
      peaks.push(best);
    }
    return { change: pct(change, 0.5), repeats, ac: pct(peaks, 0.5) };
  };
  const lineP = along(1), openP = along(0);
  check('tree line pattern: each bump spacing at least 15 % off the last (median)', lineP.change >= 0.15, `${(lineP.change * 100).toFixed(0)} %, the open field ${(openP.change * 100).toFixed(0)} %`);
  check('tree line pattern: no spacing repeats (within 5 %) more than 3 times in a row', lineP.repeats <= 3, `${lineP.repeats}, the open field ${openP.repeats}`);
  check('tree line pattern: the height along a line does not repeat (autocorrelation peak under 0.45, median)', lineP.ac < 0.45 && lineP.ac < openP.ac, `${lineP.ac.toFixed(2)}, the open field ${openP.ac.toFixed(2)}`);
  // the shader's analytic slope still matches the height, and no steps, with the pattern on (20 deg: part faded)
  {
    const o = [0, 0, 0], SLx = Math.tan(20 * D2R);
    let worst = 0, scale = 0, step = 0;
    for (let i = 0; i < 4000; i++) {
      const x = -900 + (i * 7.31) % 1800, y = -900 + (i * 13.7) % 1800, r = i * 0.37, e = 1e-3, fx = SLx * Math.cos(r), fy = SLx * Math.sin(r);
      mogulHeightGrad(x, y, 0.57, fx, fy, 0.4, o, 1);
      const gx = (mogulHeight(x + e, y, 0.57, fx, fy, 0.4, 1) - mogulHeight(x - e, y, 0.57, fx, fy, 0.4, 1)) / (2 * e);
      const gy = (mogulHeight(x, y + e, 0.57, fx, fy, 0.4, 1) - mogulHeight(x, y - e, 0.57, fx, fy, 0.4, 1)) / (2 * e);
      worst = Math.max(worst, Math.hypot(o[1] - gx, o[2] - gy));
      scale = Math.max(scale, Math.hypot(gx, gy));
    }
    for (let x = 1230; x < 1300; x += 0.5) for (let y = -560; y > -760; y -= 0.01) step = Math.max(step, Math.abs(mogulHeight(x, y, 0.57, 0, -SLx, 0, 1) - mogulHeight(x, y - 0.01, 0.57, 0, -SLx, 0, 1)));
    check('tree line pattern: analytic slope matches the height within 6% of the steepest bump face', worst < 0.06 * scale, `${worst.toFixed(3)} of ${scale.toFixed(2)}`);
    check('tree line pattern: no steps (under 2 cm per 1 cm along the fall line)', step < 0.02, `${(step * 100).toFixed(2)} cm`);
  }

  // Vail's baked lines round Steep and Deep (FEAT-334), the forest gate left open
  const vail = path.join(PACKS, 'vail');
  if (!fs.existsSync(path.join(vail, 'treeLines.json'))) console.log('skip Vail tree line checks: no packs/vail/treeLines.json (npm run get vail)');
  else {
    const runs = JSON.parse(fs.readFileSync(path.join(vail, 'features.json'), 'utf8')).runs;
    const baked = JSON.parse(fs.readFileSync(path.join(vail, 'treeLines.json'), 'utf8'));
    const tl = new TreeLines(runs, baked);
    tl.finish();
    const run = runs.find((r) => r.name === 'Steep And Deep').points, cum = [0];
    for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
    const len = cum[cum.length - 1];
    /** [distance from the run, distance along it, its pitch there (deg, from the run's point heights)] */
    const onRun = (x, y) => {
      let best = Infinity, s = 0, deg = 0;
      for (let i = 1; i < run.length; i++) {
        const ax = run[i - 1][0], ay = run[i - 1][1], dx = run[i][0] - ax, dy = run[i][1] - ay, l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)), d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
        if (d < best) { best = d; s = cum[i - 1] + t * Math.sqrt(l2); deg = Math.atan((run[i - 1][2] - run[i][2]) / Math.sqrt(l2)) / D2R; }
      }
      return [best, s, deg];
    };
    // the lines' amplitude (the busiest tenth) and the run's pitch (median) over its first and last 250 m
    const part = (inPart) => {
      const amp = [], deg = [];
      for (const l of baked.lines) for (let k = 0; k < l.p.length; k += 4) {
        const x = l.p[k], y = l.p[k + 1], [d, s, g] = onRun(x, y);
        if (d <= 150 && inPart(s)) { amp.push(tl.wornAt(x, y) * LINE_MOGUL); deg.push(g); }
      }
      const a = pct(amp, 0.9), g = pct(deg, 0.5), line = field(g, a, 1), main = field(g, a, 0);
      return { g, p95: pct(line, 0.95), main: pct(main, 0.95) };
    };
    const top = part((s) => s < 250), out = part((s) => s > len - 250);
    check(`Vail Steep and Deep top (${top.g.toFixed(0)} deg): the lines keep main's bumps (p95 crest 0.85 to 1.15 of it)`, top.p95 >= 0.85 * top.main && top.p95 <= 1.15 * top.main,
      `p95 ${top.p95.toFixed(2)} vs ${top.main.toFixed(2)} m`);
    check(`Vail Steep and Deep runout (${out.g.toFixed(0)} deg): the lines nearly flatten (p95 crest under 0.35 of main's)`, out.p95 < 0.35 * out.main,
      `p95 ${out.p95.toFixed(2)} vs ${out.main.toFixed(2)} m`);
  }
}

// ---------------------------------------------------------------- riding
/** a plane falling to -y at `deg` with a mogul field of `amp` (settable), ungroomed */
function plane(deg, amp) {
  const SL = Math.tan(deg * Math.PI / 180);
  const st = { amp };
  const base = (_x, y) => SL * y;
  // FEAT-147: bumps sized by the slope; the field starts 10 to 15 m below the start, so the rider rolls
  // into it (standing still in front of a big bump's near-level uphill face, they would not move)
  const runIn = (y) => { const t = Math.min(1, Math.max(0, (-10 - y) / 5)); return t * t * (3 - 2 * t); };
  const h = (x, y) => base(x, y) + mogulHeight(x, y, st.amp * runIn(y), 0, -SL, 0);
  return {
    st,
    coarseFallbacks: 0,
    mask: { sample: (_x, _y, o) => { const m = o ?? [0, 0, 0, 0]; m[0] = 0; m[1] = 0; m[2] = 0; m[3] = 0; return m; } },
    mogulAmp: () => st.amp,
    groundHeight: h,
    groundNormal: (x, y, o) => {
      const e = 0.25, dx = (h(x + e, y) - h(x - e, y)) / (2 * e), dy = (h(x, y + e) - h(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1);
      const n = o ?? [0, 0, 0]; n[0] = -dx / l; n[1] = -dy / l; n[2] = 1 / l; return n;
    },
  };
}
const inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, lean: 0, balance: 0 };
/** ride straight down for `secs`; `onStep(t, rider)` may change the world */
function ride(deg, amp, secs, onStep = null) {
  const p = plane(deg, amp);
  const r = new Rider(p, null);
  r.reset(0, 0, Math.PI, 1);
  const dt = 1 / 120;
  let airEdges = 0, wasOn = true, maxAcc = 0, lastVz = 0, airT = 0, maxAir = 0, maxDrop = 0;
  const speeds = [];
  for (let t = 0; t < secs; t += dt) {
    if (onStep) onStep(t, p);
    r.update(dt, inp);
    if (r.onFoot || r.crashed > 0) break;
    if (wasOn && !r.onGround) airEdges++;
    if (!r.onGround) { airT += dt; maxAir = Math.max(maxAir, airT); } else airT = 0;
    wasOn = r.onGround;
    maxAcc = Math.max(maxAcc, Math.abs(r.vz - lastVz) / dt); lastVz = r.vz;
    maxDrop = Math.max(maxDrop, p.groundHeight(r.x, r.y) - r.z); // how far below the snow the rider sinks
    if (t > secs - 6) speeds.push(r.speed);
  }
  const mean = speeds.reduce((s, x) => s + x, 0) / Math.max(1, speeds.length);
  return { airEdges, maxAcc, meanSpeed: mean, maxAir, maxDrop, crashed: r.crashed > 0, dist: r.distance };
}
{
  const flat = ride(25, 0, 12);
  const bumps = ride(25, 0.7, 12);
  check('flat plane: never airborne', flat.airEdges === 0, `${flat.airEdges} air edges`);
  check('bump run: thrown off the snow at least 3 times', bumps.airEdges >= 3, `${bumps.airEdges} air edges`);
  check('bump run: vertical jolts over 2 g', bumps.maxAcc > 2 * 9.81, `${(bumps.maxAcc / 9.81).toFixed(1)} g`);
  check('bump run is at least 10% slower than the groomer beside it', bumps.meanSpeed < flat.meanSpeed * 0.9,
    `${bumps.meanSpeed.toFixed(1)} vs ${flat.meanSpeed.toFixed(1)} m/s`);
  // the field appears under the rider at t = 3 s (its tile loaded late)
  const late = ride(25, 0, 12, (t, p) => { if (t >= 3) p.st.amp = 0.7; });
  check('late tile: rider never sinks more than 0.1 m into the snow', late.maxDrop <= 0.1, `${late.maxDrop.toFixed(2)} m`);
  // BUG-072: the longest air comes from an ordinary bump well after the tile lands (FEAT-147's bumps throw
  // over 1 s on their own), so compare with the same field loaded on time instead of a fixed limit
  check('late tile: no more air than the same field loaded on time', late.maxAir <= bumps.maxAir + 0.05,
    `${late.maxAir.toFixed(2)} vs ${bumps.maxAir.toFixed(2)} s`);
  check('late tile: no crash', !late.crashed);
  // FEAT-147: a steep run's chest-high bumps, straight down with no input: rough and slow, but ridable
  const steep = ride(33, 1, 12);
  check('steep big-bump run (33 deg): no crash in 12 s straight down', !steep.crashed, `${steep.airEdges} air edges`);
  const steepFlat = ride(33, 0, 12);
  check('steep big-bump run is at least 10% slower than a smooth 33 deg plane', steep.meanSpeed < steepFlat.meanSpeed * 0.9,
    `${steep.meanSpeed.toFixed(1)} vs ${steepFlat.meanSpeed.toFixed(1)} m/s`);
}


// ---------------------------------------------------------------- BUG-065: drawn bumps, legs and camera
/** a plane falling to -y at `deg` with a mogul field of `amp`, as a pack: what DrawnGround and BumpAbsorb read */
function bumpPack(deg, amp) {
  const SL = Math.tan(deg * Math.PI / 180);
  const runIn = (y) => { const t = Math.min(1, Math.max(0, (-10 - y) / 5)); return t * t * (3 - 2 * t); };
  const A = (_x, y) => amp * runIn(y);
  const bump = (x, y) => mogulHeight(x, y, A(x, y), 0, -SL, 0);
  const h = (x, y) => SL * y + bump(x, y);
  return {
    SL, coarseFallbacks: 0, moguls: {}, mogulScale: 1, mogulCreep: 0, decks: [],
    mask: { sample: (_x, _y, o) => { const m = o ?? [0, 0, 0, 0]; m.fill(0); return m; } },
    meta: { terrain: { fine: { res: 1, minX: -5000, minY: -5000 } }, zRange: [-5000, 5000] }, fine: { meta: { res: 1 }, contains: () => true },
    mogulAmp: A, bumpAt: bump, terrainHeight: h, groundHeight: h,
    groundNormal: (x, y, o) => {
      const e = 0.25, dx = (h(x + e, y) - h(x - e, y)) / (2 * e), dy = (h(x, y + e) - h(x, y - e)) / (2 * e), l = Math.hypot(dx, dy, 1);
      const n = o ?? [0, 0, 0]; n[0] = -dx / l; n[1] = -dy / l; n[2] = 1 / l; return n;
    },
  };
}
{
  // the snow tracks' height is the mesh's: the 1 m vertices carry the exact bump, the triangles (split along
  // (i, j) to (i + 1, j + 1) like Terrain.ts) interpolate it; the exact function is up to 13 cm off at 16 deg
  const p = bumpPack(16, 0.61), dg = new DrawnGround(p);
  let atVert = 0, vsMesh = 0, vsExact = 0;
  for (let k = 0; k < 4000; k++) {
    const x = 7.3 + (k % 63) * 0.71, y = -30 - Math.floor(k / 63) * 0.83;
    const i = Math.floor(x + 5000), j = Math.floor(y + 5000), tx = x + 5000 - i, ty = y + 5000 - j;
    const v = (di, dj) => p.terrainHeight(i - 5000 + di, j - 5000 + dj);
    const mesh = tx >= ty ? v(0, 0) * (1 - tx) + v(1, 0) * (tx - ty) + v(1, 1) * ty : v(0, 0) * (1 - ty) + v(0, 1) * (ty - tx) + v(1, 1) * tx;
    // the plane itself is linear, so the mesh of the base is exact and only the bumps differ
    vsMesh = Math.max(vsMesh, Math.abs(dg.height(x, y) - mesh));
    vsExact = Math.max(vsExact, Math.abs(p.groundHeight(x, y) - mesh));
    atVert = Math.max(atVert, Math.abs(dg.height(Math.round(x), Math.round(y)) - p.groundHeight(Math.round(x), Math.round(y))));
  }
  check('drawn snow: the tracks sit on the bumps the mesh draws (within 1 mm)', vsMesh < 1e-3, `${(vsMesh * 100).toFixed(2)} cm off, the exact bumps ${(vsExact * 100).toFixed(1)} cm`);
  check('drawn snow: the same as the exact bumps at the vertices', atVert < 1e-6, `${atVert.toExponential(1)} m`);
  const flat = bumpPack(16, 0), dgf = new DrawnGround(flat);
  check('drawn snow: off the fields it is the ground height', Math.abs(dgf.height(3.3, -40.6) - flat.groundHeight(3.3, -40.6)) < 1e-9);
}
/** ride straight (or weaving) down a bump plane for 12 s at 60 Hz, the rider view's absorb and the chase camera
 *  following (or the camera without the absorb); vertical acceleration of the board and of the body (mean
 *  |d2z/dt2| after 3 s), and the camera's peak yaw rate */
function rideView(deg, amp, steer, absorb) {
  const p = bumpPack(deg, amp), r = new Rider(p, null), ab = new BumpAbsorb(), cam = new ChaseCamera(p, 16 / 9);
  cam.absorb = absorb ? ab : null;
  r.reset(0, 0, Math.PI, 1);
  const dt = 1 / 60, board = [], body = [], yaws = [], dir = cam.camera.position.clone();
  const input = { ...inp };
  for (let t = 0; t < 12; t += dt) {
    input.steer = steer * Math.sign(Math.sin(t * 1.5));
    r.update(dt, input);
    if (r.crashed > 0) break;
    ab.update(p, r, dt); cam.update(r, dt, false);
    if (t < 3) continue;
    board.push(r.z); body.push(r.z + (absorb ? ab.boardOff + ab.hips : 0));
    cam.camera.getWorldDirection(dir); yaws.push(Math.atan2(dir.x, -dir.z));
  }
  const acc = (a) => { let s = 0; for (let i = 2; i < a.length; i++) s += Math.abs(a[i] - 2 * a[i - 1] + a[i - 2]) / (dt * dt); return s / Math.max(1, a.length - 2); };
  let peak = 0;
  for (let i = 1; i < yaws.length; i++) peak = Math.max(peak, Math.abs(Math.atan2(Math.sin(yaws[i] - yaws[i - 1]), Math.cos(yaws[i] - yaws[i - 1]))) / dt);
  return { board: acc(board), body: acc(body), yawPeak: peak * 180 / Math.PI };
}
for (const [deg, amp, steer, bodyShare] of [[16, 0.61, 0, 0.3], [16, 0.61, 0.25, 0.3], [25, 0.7, 0, 0.6]]) {
  const on = rideView(deg, amp, steer, true), off = rideView(deg, amp, steer, false);
  const name = `${deg} deg bump run${steer ? ', weaving' : ''}`;
  check(`${name}: the legs soak up the bumps (body jolts under ${bodyShare * 100}% of the board's)`, on.body < on.board * bodyShare,
    `${on.body.toFixed(1)} vs ${on.board.toFixed(1)} m/s2`);
  // weaving, the turns themselves swing the camera: there the bumps may add a quarter to the smooth plane's swing
  const smooth = steer ? rideView(deg, 0, steer, true).yawPeak : 0;
  check(`${name}: the chase camera turns ${steer ? 'about as hard as on a smooth plane' : 'at most half as hard as without the absorb'}`,
    steer ? on.yawPeak <= 1.25 * smooth + 1 : on.yawPeak <= 0.5 * off.yawPeak + 1,
    `peak ${on.yawPeak.toFixed(0)} vs ${off.yawPeak.toFixed(0)} deg/s without the absorb${steer ? `, ${smooth.toFixed(0)} on a smooth plane` : ''}`);
}

fs.rmSync(dir, { recursive: true, force: true });
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
console.log('all ok');
