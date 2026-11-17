// Lift boarding check (FEAT-323): on the synthetic mountain's lift, render-free (the lift logic is stepped with
// liftRide.update inside page.evaluate; a few real frames run the riding state for the key presses).
//   1. the boarding zone is BOARD_RANGE (28 m, twice the old 14 m): boardable at 20 m from the loading point,
//      not at 35 m (the prompt still shows there);
//   2. the strap key (B) unstraps inside the zone and does not board; E then straps in and boards;
//   3. E inside the zone boards a strapped-in rider (one lift: no picker);
//   4. with two lifts in range (a second one faked beside the real one) E opens the lift picker instead of
//      boarding, listing both nearest first; Down then E boards the second; Esc closes it without boarding;
//   5. ?boardRange=40 widens the zone; no console errors.
// node tools/liftboardcheck.mjs [pack] [--headed]   (run after `npx vite build`; exit 1 on a failed check)
import { launchBrowser } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, PACKS } from './paths.mjs';

const args = process.argv.slice(2);
const pack = args.filter((a) => !a.startsWith('--'))[0] ?? 'synth';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.bin': 'application/octet-stream', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const [root, rel] = u.startsWith('/packs/') ? [PACKS, u.slice('/packs/'.length)] : [DIST, u];
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await launchBrowser();
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) fails.push(name); };

const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const load = async (extra = '') => {
  await page.goto(`http://localhost:${server.address().port}/index.html?pack=${pack}&headless&lowgfx${extra}${process.env.SHOT_QUERY ?? ''}`);
  await page.waitForFunction(() => window.__step, null, { timeout: 90000 });
  page.setDefaultTimeout(240000);
};

/** Put the rider `d` m beside the first lift's loading point (across the line, clear of the terminal and
 *  the maze), stopped and strapped in, with the maze gate off; wait for the 1 m tiles there. */
const place = async (d) => {
  const at = await page.evaluate((d) => {
    const s = window.__sim, l = s.lifts.lifts[0];
    s.liftRide.cancel(); s.liftRide.gate = null;
    const x = l.bottom[0] + l.lateral[0] * d, y = l.bottom[1] + l.lateral[1] * d;
    s.pack.fine?.request(x - 300, y - 300, x + 300, y + 300); s.pack.mask?.request(x - 300, y - 300, x + 300, y + 300);
    return { x, y };
  }, d);
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(([x, y]) => { const p = window.__sim.pack; return !p.fine || !Number.isNaN(p.fine.sample(x, y)); }, [at.x, at.y])) break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(([x, y]) => { const s = window.__sim; s.rider.reset(x, y, 0); s.liftRide.gate = null; }, [at.x, at.y]);
  return at;
};
/** hold the rider still and run the lift logic for a frame (no render) */
const zone = () => page.evaluate(() => {
  const s = window.__sim, r = s.rider, lr = s.liftRide;
  r.vx = r.vy = r.vz = 0; r.speed = 0; r.onGround = true;
  lr.update(r, 1 / 60, false);
  return { canBoard: lr.canBoard, nearby: lr.nearby?.feature.name ?? null, dist: lr.nearbyDist, choices: lr.choices.map((l) => l.feature.name), range: lr.boardRange };
});
/** a key press, then `n` real frames (the riding state reads the keys) with the rider held still */
const press = async (code, n = 2) => {
  await page.keyboard.down(code);
  await page.evaluate((n) => { const r = window.__sim.rider; for (let i = 0; i < n; i++) { if (!window.__sim.liftRide.riding) { r.vx = r.vy = 0; r.speed = 0; } window.__step(1, 1 / 60); } }, n);
  await page.keyboard.up(code);
  await page.evaluate(() => window.__step(1, 1 / 60));
};
const state = () => page.evaluate(() => { const s = window.__sim, r = s.rider; return { state: s.state, riding: s.liftRide.riding, lift: s.liftRide.lift?.feature.name ?? null, onFoot: r.onFoot, strap: r.strapState, unstrapped: r.unstrapped, pick: document.getElementById('lift-pick')?.style.display !== 'none' && !!document.getElementById('lift-pick'), items: [...document.querySelectorAll('#lift-pick button')].map((b) => b.querySelector('.ln').textContent), prompt: document.getElementById('prompt').textContent }; });
/** step the rider (no render) until the strap transition ends */
const settle = () => page.evaluate(() => {
  const r = window.__sim.rider, inp = { steer: 0, tuck: false, brake: false, jumpHeld: false, jumpReleased: false, grab: false, squat: false, skate: false, lean: 0, balance: 0 };
  for (let i = 0; i < 300 && r.strapState !== 'none'; i++) { r.update(1 / 60, inp); r.vx = r.vy = 0; r.speed = 0; }
});

await load();
const s0 = await page.evaluate(() => ({ state: window.__sim.state, lifts: window.__sim.lifts.lifts.length }));
check('the pack has a lift and the session is riding', s0.lifts > 0 && s0.state === 'riding', JSON.stringify(s0));

// 1. the zone
await place(20);
let z = await zone();
check('the boarding zone is 28 m', z.range === 28, `${z.range}`);
check('boardable 20 m from the loading point', z.canBoard && z.choices.length === 1, JSON.stringify(z));
await place(35);
z = await zone();
check('not boardable 35 m out, the prompt still names the lift', !z.canBoard && z.nearby !== null && z.choices.length === 0, JSON.stringify(z));

// 2. the strap key unstraps in the zone and never boards
await place(10);
await zone();
await press('KeyB');
let st = await state();
check('B in the zone unstraps', st.unstrapped && !st.riding, JSON.stringify(st));
await settle();
st = await state();
check('B in the zone did not board', st.onFoot && !st.riding, JSON.stringify(st));
await zone();
await press('KeyE');
st = await state();
check('E on foot in the zone straps in and boards', st.riding && !st.onFoot, JSON.stringify(st));

// 3. E boards a strapped-in rider (one lift)
await place(10);
await zone();
await press('KeyE');
st = await state();
check('E in the zone boards (one lift, no picker)', st.riding && !st.pick && st.state === 'riding', JSON.stringify(st));

// 4. two lifts in range: the picker
await place(10);
await page.evaluate(() => {
  const s = window.__sim, real = s.lifts.lifts[0];
  const fake = Object.assign(Object.create(Object.getPrototypeOf(real)), real, { feature: { ...real.feature, name: 'Second Chair' }, bottom: [real.bottom[0] + real.lateral[0] * 20, real.bottom[1] + real.lateral[1] * 20, real.bottom[2]] });
  window.__fakeLift = fake;
  const near = s.lifts.boardableNear.bind(s.lifts);
  s.lifts.boardableNear = (x, y, d) => [...near(x, y, d), ...(Math.hypot(fake.bottom[0] - x, fake.bottom[1] - y) < d ? [fake] : [])].sort((a, b) => Math.hypot(a.bottom[0] - x, a.bottom[1] - y) - Math.hypot(b.bottom[0] - x, b.bottom[1] - y));
});
// stand between them, nearer the real one
await place(8);
z = await zone();
check('two lifts in range, nearest first', z.canBoard && z.choices.length === 2 && z.choices[1] === 'Second Chair', JSON.stringify(z));
await page.evaluate(() => window.__step(1, 1 / 60));
st = await state();
check('the prompt offers the picker', /2 lifts here/.test(st.prompt) && /pick a lift/.test(st.prompt), st.prompt);
await press('KeyE');
st = await state();
check('E opens the picker instead of boarding', st.state === 'liftpick' && st.pick && !st.riding && st.items.length === 2 && st.items[1] === 'Second Chair', JSON.stringify(st));
await press('Escape');
st = await state();
check('Esc closes the picker without boarding', st.state === 'riding' && !st.pick && !st.riding, JSON.stringify(st));
await zone();
await press('KeyE');
await press('ArrowDown', 1);
await press('KeyE');
st = await state();
check('Down then E boards the second lift', st.riding && st.lift === 'Second Chair' && st.state === 'riding' && !st.pick, JSON.stringify(st));

// 5. ?boardRange=
await load('&boardRange=40');
await place(35);
z = await zone();
check('?boardRange=40 boards 35 m out', z.range === 40 && z.canBoard, JSON.stringify(z));

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
if (fails.length) { console.log(`\n${fails.length} failed: ${fails.join(', ')}`); process.exit(1); }
console.log('\nall lift boarding checks passed');
