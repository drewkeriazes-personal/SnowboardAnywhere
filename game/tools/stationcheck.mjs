// Lift station check (FEAT-323): lift station buildings are open shelters, render-free (no browser, no pack needed).
// On a made-up resort with one lift it checks that a small building over the bottom station node becomes a
// pavilion and one touching a bigger building's wall a lean-to; that a lodge with the top station inside stays a
// building, as does a building a few metres off a station; that a big building named as a gondola station is a
// pavilion; that no shelter registers a solid footprint (only posts), no post stands on the lift's line, and a
// lean-to has no post against its wall; that the ordinary buildings keep their solid footprints; and that the
// shelter geometry is finite. With a pack folder it also reports that pack's shelters:
//   node tools/stationcheck.mjs [packDir]        (exit code 1 if a check fails)
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GAME } from './paths.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stationcheck-'));
const entry = path.join(tmp, 'entry.ts');
const src = (p) => JSON.stringify(path.join(GAME, 'src', p).replace(/\\/g, '/'));
fs.writeFileSync(entry, `export { Buildings, stationShelters, polyDist } from ${src('world/Buildings.ts')};\n`);
const out = path.join(tmp, 'station.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { Buildings, stationShelters } = await import(pathToFileURL(out).href);

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.error('FAIL', m); } else console.log('ok  ', m); };
const rect = (cx, cy, w, h) => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
const bld = (points, extra = {}) => ({ points, zBase: 100, height: 5.5, heightDefault: true, kind: 'yes', ...extra });

// one lift running north from (0, 0) to (0, 1000), a second running east from (300, 0) to (800, 0)
const lifts = [
  { name: 'North Chair', type: 'chair_lift', stations: [[0, 0, 100], [0, 1000, 400]], towers: [], cable: [] },
  { name: 'East Chair', type: 'chair_lift', stations: [[300, 0, 100], [800, 0, 200]], towers: [], cable: [] },
  { name: 'Gondola', type: 'gondola', stations: [[-500, 0, 100], [-500, 900, 500]], towers: [], cable: [] },
];
const pav = bld(rect(0, 2, 10, 16)); // over North Chair's bottom station, 10 m across the line, 16 m along it
const lodgeTop = bld(rect(0, 1010, 60, 50), { name: 'Summit Lodge', height: 12, heightDefault: false }); // 3000 m2 over its top
const leanTo = bld(rect(300, 0, 12, 8)); // over East Chair's bottom station...
const bigNext = bld(rect(300, -14, 30, 20)); // ...touching this bigger building's wall (its north wall at y = -4)
const offBy = bld(rect(812, 0, 6, 6)); // 9 m off East Chair's top station
const gondola = bld(rect(-500, 0, 30, 50), { name: 'Gondola Base Station' }); // 1500 m2, named as a station
const house = bld(rect(150, 150, 10, 10), { kind: 'house' });
const buildings = [pav, lodgeTop, leanTo, bigNext, offBy, gondola, house];
const stations = lifts.flatMap((l) => { const a = l.stations[0], z = l.stations[l.stations.length - 1], d = Math.hypot(z[0] - a[0], z[1] - a[1]); const ux = (z[0] - a[0]) / d, uy = (z[1] - a[1]) / d; return [{ x: a[0], y: a[1], ux, uy }, { x: z[0], y: z[1], ux, uy }]; });

const sh = stationShelters(buildings, stations);
ok(sh.get(pav)?.kind === 'pavilion', 'a small building over a station is a pavilion');
ok(sh.get(leanTo)?.kind === 'leanto', 'a station building against a bigger wall is a lean-to');
ok(!sh.has(lodgeTop), 'a 3000 m2 lodge over a station stays a building');
ok(!sh.has(offBy), 'a building 9 m off a station stays a building');
ok(sh.get(gondola)?.kind === 'pavilion', 'a 1500 m2 building named as a gondola station is a pavilion');
ok(!sh.has(house) && !sh.has(bigNext), 'ordinary buildings are not shelters');

// build them with a collider that records what is registered
const posts = [], footprints = [];
const collider = { add: (x, y, r, z0, z1) => posts.push({ x, y, r, z0, z1 }), addFootprint: (pts, z0, z1) => footprints.push({ pts, z0, z1 }) };
const pack = { features: { buildings, lifts }, sets: [] };
const b = new Buildings(pack, collider);
const inside = (pts, x, y) => x >= Math.min(...pts.map((p) => p[0])) - 0.01 && x <= Math.max(...pts.map((p) => p[0])) + 0.01 && y >= Math.min(...pts.map((p) => p[1])) - 0.01 && y <= Math.max(...pts.map((p) => p[1])) + 0.01;
const solid = (f) => footprints.some((q) => q.pts.length === f.points.length && q.pts.every((p, i) => p[0] === f.points[i][0] && p[1] === f.points[i][1]));
ok(!solid(pav) && !solid(leanTo) && !solid(gondola), 'no shelter registers a solid footprint');
ok(solid(lodgeTop) && solid(bigNext) && solid(offBy) && solid(house), 'ordinary buildings keep their solid footprints');
const pavPosts = posts.filter((p) => inside(pav.points, p.x, p.y));
ok(pavPosts.length === 4 && pavPosts.every((p) => Math.abs(p.x) >= 2.5), `the pavilion has its 4 corner posts, none on the lift's line (${pavPosts.length})`);
const leanPosts = posts.filter((p) => inside(leanTo.points, p.x, p.y));
ok(leanPosts.length === 2 && leanPosts.every((p) => p.y > -2.5), `the lean-to has posts only on its open side (${leanPosts.map((p) => p.y).join(', ')})`);
const hi = Math.max(...leanPosts.map((p) => p.z1));
ok(leanPosts.length > 0 && hi > 100, 'the lean-to posts reach its roof');
let finite = true, verts = 0;
for (const m of b.group.children) { const a = m.geometry.getAttribute('position').array; verts += a.length / 3; for (const v of a) if (!Number.isFinite(v)) finite = false; }
ok(finite && verts > 0, `the shelter geometry is finite (${verts} vertices)`);

const packDir = process.argv[2];
if (packDir) {
  const f = JSON.parse(fs.readFileSync(path.join(packDir, 'features.json'), 'utf8'));
  const st = f.lifts.filter((l) => l.stations.length >= 2).flatMap((l) => { const a = l.stations[0], z = l.stations[l.stations.length - 1], d = Math.hypot(z[0] - a[0], z[1] - a[1]) || 1; const ux = (z[0] - a[0]) / d, uy = (z[1] - a[1]) / d; return [{ x: a[0], y: a[1], ux, uy }, { x: z[0], y: z[1], ux, uy }]; });
  const s2 = stationShelters(f.buildings, st);
  const kinds = [...s2.values()].reduce((m, s) => (m[s.kind] = (m[s.kind] ?? 0) + 1, m), {});
  console.log(`${path.basename(packDir)}: ${st.length} end stations, ${s2.size} shelters`, kinds);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log('all station checks passed');
