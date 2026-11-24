// Dev hot reload check (FEAT-376): starts its own Vite dev server, opens the game headless (?headless, stepped
// with __step), rides a little, then edits files in this checkout one at a time and puts each back:
//   - a rider tuning constant (G in sim/rider/tuning.ts): hot, the rider keeps its place and falls faster
//   - an audio gain (GameAudio.setVolumes): hot, the effects gain reads the new value
//   - a HUD string (ui/HudLine.ts): hot, the HUD line shows it
//   - a field initializer on the Rider class: reloads, the toast names why
//   - a shader module (terrain/rockShader.ts): reloads, the toast names the file
//   - every file on the hot list (tools/dev_hot.mjs) with a comment added: hot (each reaches a module that swaps)
// A hot edit must leave a window marker in place (no reload) and toast "hot update: <file>"; a reload must drop it.
// Not in CI: it needs a dev server and edits source files. Run it on Drew's PC with nothing else editing the
// files it touches, and check `git status` is clean after (it restores each file, also on a failure).
// node tools/hotcheck.mjs [pack] [--port N] [--headed]   (pack: synth by default; port 5261 by default, strict)
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from './browser.mjs';
import { GAME } from './paths.mjs';
import { HOT } from './dev_hot.mjs';

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port = portAt >= 0 ? Number(args[portAt + 1]) : 5261;
const pack = args.filter((a, i) => !a.startsWith('--') && (portAt < 0 || i !== portAt + 1))[0] ?? 'synth';
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

const server = await createServer({ root: GAME, configFile: path.join(GAME, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
let loads = 0;
page.on('load', () => loads++);

const open = async () => {
  await page.waitForFunction(() => window.__step && window.__sim?.rider, null, { timeout: 180000 });
  await page.evaluate(() => { window.__hotMarker = 1; window.__step(30); });
};
console.log(`pack ${pack}, dev server on ${port}`);
await page.goto(`http://localhost:${port}/?pack=${pack}&headless`);
await open();

/** Wait until Vite has handled an edit: a hot update (its toast) or a reload (a new page, up again). */
async function settle(before) {
  for (let t = 0; t < 100; t++) {
    if (loads > before) { await open(); return true; }
    const toast = await page.evaluate(() => document.getElementById('toast')?.textContent ?? '').catch(() => '');
    if (/^hot update/.test(toast)) return false;
    await page.waitForTimeout(200);
  }
  throw new Error('no hot update or reload within 20 s');
}
const clearToast = () => page.evaluate(() => { const t = document.getElementById('toast'); t.classList.remove('show'); t.textContent = ''; });

/** Replace `from` with `to` in a source file, run `fn` once Vite has handled it, and put the file back. */
async function withEdit(rel, from, to, fn) {
  const file = path.join(GAME, 'src', rel);
  const was = fs.readFileSync(file, 'utf8');
  if (!was.includes(from)) throw new Error(`${rel}: "${from}" not found`);
  await clearToast();
  let before = loads;
  fs.writeFileSync(file, was.replace(from, () => to));
  try {
    const reloaded = await settle(before);
    await fn({ reloaded, toast: await page.evaluate(() => document.getElementById('toast')?.textContent ?? '') });
  } finally {
    await clearToast().catch(() => {});
    before = loads;
    fs.writeFileSync(file, was);
    await settle(before);
    await clearToast();
  }
}

/** Speed after riding 30 steps straight down from a fixed spot, from standing: shows the gravity in use. */
const gain = () => page.evaluate(() => {
  const r = window.__sim.rider;
  if (!window.__hotStart) window.__hotStart = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  Object.assign(r, window.__hotStart, { vx: 0, vy: 0, vz: 0 });
  window.__step(30);
  return Math.hypot(r.vx, r.vy);
});
const place = () => page.evaluate(() => [window.__sim.rider.x, window.__sim.rider.y]);
const marker = () => page.evaluate(() => window.__hotMarker === 1);

const base = await gain();
const at = await place();
await withEdit('sim/rider/tuning.ts', 'export const G = 9.81;', 'export const G = 30;', async ({ reloaded, toast }) => {
  const moved = await place();
  check('tuning: no reload, marker kept', !reloaded && await marker(), toast);
  check('tuning: toast names the file', toast === 'hot update: sim/rider/tuning.ts', toast);
  check('tuning: rider kept its place', Math.hypot(moved[0] - at[0], moved[1] - at[1]) < 50, `${at.map((v) => v.toFixed(0))} -> ${moved.map((v) => v.toFixed(0))}`);
  const hot = await gain();
  check('tuning: new gravity in use', hot > base * 1.5, `speed after 30 steps ${base.toFixed(2)} -> ${hot.toFixed(2)} m/s`);
});

await withEdit('audio/Audio.ts', 'if (this.sfx) this.sfx.gain.value = sfx * (this.duck', 'if (this.sfx) this.sfx.gain.value = 0.25 * sfx * (this.duck', async ({ reloaded, toast }) => {
  check('audio: no reload, marker kept', !reloaded && await marker(), toast);
  const g = await page.evaluate(() => { const a = window.__sim.audio; a.start(); a.setVolumes(0.8, 0.5); return a.sfx.gain.value; });
  check('audio: new gain in use', Math.abs(g - 0.2) < 1e-3, `sfx gain ${g.toFixed(3)} (want 0.200)`);
});

await withEdit('ui/HudLine.ts', '&nbsp; slope ${rider', '&nbsp; HOTSLOPE ${rider', async ({ reloaded, toast }) => {
  check('HUD: no reload, marker kept', !reloaded && await marker(), toast);
  const hud = await page.evaluate(() => { window.__step(2); return document.getElementById('hud').textContent; });
  check('HUD: new string shown', hud.includes('HOTSLOPE'), hud.slice(0, 60));
});

await withEdit('sim/Rider.ts', 'readonly snowWorld: SnowWorld = { ...DEFAULT_SNOW_WORLD };', 'readonly snowWorld: SnowWorld = { ...DEFAULT_SNOW_WORLD, hour: 14 };', async ({ reloaded, toast }) => {
  check('Rider field: reloads', reloaded && toast.startsWith('reloaded: sim/Rider.ts'), toast);
});

await withEdit('terrain/rockShader.ts', "import * as THREE from 'three';", "import * as THREE from 'three'; // hotcheck", async ({ reloaded, toast }) => {
  check('shader: reloads', reloaded && toast.startsWith('reloaded: terrain/rockShader.ts'), toast);
});

const listed = HOT.flatMap((h) => (h.endsWith('/') ? fs.readdirSync(path.join(GAME, 'src', h)).filter((f) => f.endsWith('.ts')).map((f) => h + f) : [h]))
  .filter((rel) => /^export (?!type |interface )/m.test(fs.readFileSync(path.join(GAME, 'src', rel), 'utf8'))); // types only: nothing loads
for (const rel of listed) {
  const was = fs.readFileSync(path.join(GAME, 'src', rel), 'utf8');
  await withEdit(rel, was, `${was}// hotcheck
`, async ({ reloaded, toast }) => check(`listed ${rel}: hot`, !reloaded && await marker(), toast));
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
await server.close();
console.log(fails.length ? `\n${fails.length} failed: ${fails.join(', ')}` : '\nall ok');
process.exit(fails.length ? 1 : 0);
