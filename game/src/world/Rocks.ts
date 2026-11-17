import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import { ROCK_STEEPEST } from '../sim/rider/tuning';
import { NOISE_GLSL, ROCK_GLSL, rockUniforms } from '../terrain/rockShader';
import type { Ground } from '../terrain/Terrain';

const RADIUS = 2500;
export const VARIANTS = 4;
/** Per type (0 outcrop, 1 boulder, 2 talus): how far the rock is sunk below the snow and its height scale, both times its size */
export const SINK = [0.55, 0.35, 0.5], HEIGHT = [1.4, 1.0, 0.6];
/** BUG-149: a rock showing less than this above the snow (m) is ridden over as snow, no collider */
export const ROCK_MIN_TOP = 0.15;
/** BUG-149: a rock standing more than this above the snow (m) is a wall in either mode, never ridden over (was any boulder over size 2.2, most of them a hump under 0.3 m as drawn) */
export const ROCK_WALL_TOP = 1.5;
/** the noise seed of rock variant `v` */
export const rockSeed = (v: number): number => v * 7.31 + 1.7;

const PU = new THREE.Vector3(0, 1, 0), PN = new THREE.Vector3(), PP = new THREE.Vector3(), PS = new THREE.Vector3();
const PQ = new THREE.Quaternion(), PQ2 = new THREE.Quaternion();
/**
 * A rock's instance matrix (three.js space): its up axis halfway between the ground normal `nn` (pack x, y, z) and
 * upright, spun by `yaw`, sunk and scaled by type. Outcrops and talus sit deep, boulders a bit less; outcrops are
 * taller blocks now that they are only half tilted, so the uphill side is buried and the downhill side stands.
 */
export function placeRock(m: THREE.Matrix4, x: number, y: number, z: number, size: number, yaw: number, type: number, nn: ArrayLike<number>): THREE.Matrix4 {
  PN.set(nn[0], nn[2], -nn[1]).add(PU).normalize();
  PQ.setFromUnitVectors(PU, PN);
  PQ2.setFromAxisAngle(PU, yaw);
  PQ.multiply(PQ2);
  const t = type === 0 || type === 1 ? type : 2;
  PP.set(x, z - size * SINK[t], -y);
  if (t === 0) PS.set(size * 2.0, size * HEIGHT[0], size * 1.6);
  else if (t === 1) PS.set(size * 1.1, size * HEIGHT[1], size * 1.0);
  else PS.set(size * 1.6, size * HEIGHT[2], size * 1.3);
  return m.compose(PP, PQ, PS);
}

/** A variant's distinct vertex positions (unit size, three.js space), for fitting its collider */
export function rockPoints(g: THREE.BufferGeometry): Float32Array {
  const p = g.getAttribute('position'), seen = new Set<string>(), out: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!seen.has(k)) { seen.add(k); out.push(p.getX(i), p.getY(i), p.getZ(i)); }
  }
  return new Float32Array(out);
}

/** BUG-149: the share of the farthest visible point a collider's radius reaches: a circle round an oblong rock
 *  overhangs its narrow sides, so it stops a little short of the long tips instead */
const FIT_REACH = 0.9;
export interface RockFit { x: number; y: number; radius: number; top: number; base: number; ground: number; wall: boolean }
/**
 * BUG-149: the collider for a rock placed by `m` (placeRock) on ground at (`gx`, `gy`, `gz`) with normal `nn` (pack
 * space): a vertical cylinder round the part of the rock standing above the snow (the ground taken as the plane
 * through the rock's centre), its top the highest point drawn (absolute z, m) and its base the lowest snow under it
 * less 1 m; null when the rock shows less than ROCK_MIN_TOP. Rocks are sunk deep and tilted halfway to the slope, so
 * on flat snow most barely show and on a slope the downhill side stands; the old collider, always 0.6 times the size
 * up round the centre, stood far above most of them and buried talus collided at all.
 */
export function rockCollider(pts: Float32Array, m: THREE.Matrix4, gx: number, gy: number, gz: number, nn: ArrayLike<number>, out: RockFit): RockFit | null {
  const e = m.elements, nz = Math.max(0.2, nn[2]);
  let n = 0, sx = 0, sy = 0, top = -Infinity, low = Infinity, most = 0;
  const vis: number[] = [];
  for (let i = 0; i < pts.length; i += 3) {
    const a = pts[i], b = pts[i + 1], c = pts[i + 2];
    const px = e[0] * a + e[4] * b + e[8] * c + e[12];
    const pz = e[1] * a + e[5] * b + e[9] * c + e[13];
    const py = -(e[2] * a + e[6] * b + e[10] * c + e[14]);
    const zg = gz - (nn[0] * (px - gx) + nn[1] * (py - gy)) / nz;
    const above = pz - zg;
    if (above < 0.05) continue;
    vis.push(px, py); n++; sx += px; sy += py;
    if (pz > top) top = pz;
    if (zg < low) low = zg;
    if (above > most) most = above;
  }
  if (n === 0 || most < ROCK_MIN_TOP) return null;
  const cx = sx / n, cy = sy / n;
  let r = 0;
  for (let i = 0; i < vis.length; i += 2) r = Math.max(r, Math.hypot(vis[i] - cx, vis[i + 1] - cy));
  out.x = cx; out.y = cy; out.radius = Math.max(0.2, r * FIT_REACH); out.top = top; out.base = low - 1;
  // BUG-141: the snow at the collider's centre, the foot of the dome a Realistic rider rides over; a rock whose
  // dome would be too steep at its rim, or that stands over ROCK_WALL_TOP, is a wall in either mode
  out.ground = gz - (nn[0] * (cx - gx) + nn[1] * (cy - gy)) / nz;
  const H = top - out.ground;
  out.wall = H > ROCK_WALL_TOP || 2 * H / out.radius > ROCK_STEEPEST;
  return out;
}

/** `col`: the rocks' collider entries, removed when the cell drops (BUG-082); `dropped`: left before its load finished, so the load adds nothing;
 *  `shown`: the cell's meshes are drawn (BUG-088: they wait until the ground under the cell is real) */
interface Cell { cx: number; cy: number; meshes: THREE.InstancedMesh[]; col: Float32Array[]; loading: boolean; missing: boolean; dropped: boolean; shown: boolean }

/**
 * Instanced rocks streamed per cell. Each rock picks one of four noise-displaced low-poly
 * variants, is sunk into the ground and tilted halfway between the slope and upright, so on a
 * steep face it is buried uphill and stands out downhill like a step in the outcrop. Types:
 * 0 outcrop, 1 boulder, 2 talus clump (flat spread).
 *
 * Material (FEAT-020): the same CC0 rock surface as the terrain's rock patches (rockShader.ts,
 * triplanar in world space on the faceted normal), a per-instance tint near 1, crevice shade
 * from the vertex colour, and snow on faces flat enough to hold it, by the same rule as the
 * terrain's rock ledges.
 */
export class Rocks {
  readonly group = new THREE.Group();
  private readonly pack: Pack;
  private readonly collider: Collider | null;
  private readonly cells = new Map<string, Cell>();
  /** BUG-088: the terrain; a loaded cell is drawn once the ground under it has its real heights (null: at once) */
  ground: Ground | null = null;
  private readonly geos: THREE.BufferGeometry[] = [];
  /** BUG-149: each variant's distinct points, for fitting the colliders */
  private readonly geoPts: Float32Array[] = [];
  private readonly fit: RockFit = { x: 0, y: 0, radius: 0, top: 0, base: 0, ground: 0, wall: false };
  private readonly mat: THREE.MeshStandardMaterial;
  get material(): THREE.MeshStandardMaterial { return this.mat; }
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly normalTmp = [0, 0, 1];
  /** FEAT-106: how much new snow is on the boulders (0 = today's caps) and the downwind direction (three.js x, z) */
  private readonly capUniforms = { uSnowAmt: { value: 0 }, uLee: { value: new THREE.Vector2(1, 0) } };

  /** FEAT-106: grow the boulder caps (amount 0..1) toward the lee of the wind (three.js x, z). */
  setSnow(amount: number, windX: number, windZ: number): void {
    this.capUniforms.uSnowAmt.value = Math.max(0, Math.min(1, amount));
    const l = Math.hypot(windX, windZ);
    if (l > 1e-6) this.capUniforms.uLee.value.set(windX / l, windZ / l);
  }

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
    for (let v = 0; v < VARIANTS; v++) { const g = makeRock(rockSeed(v)); this.geos.push(g); this.geoPts.push(rockPoints(g)); }
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0.0, flatShading: true });
    const uniforms = rockUniforms();
    this.mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, this.capUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vRockWP;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          {
            vec4 rp = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              rp = instanceMatrix * rp;
            #endif
            vRockWP = (modelMatrix * rp).xyz;
          }`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vRockWP;
          uniform float uSnowAmt;
          uniform vec2 uLee;
          ${NOISE_GLSL}
          ${ROCK_GLSL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // faceted world normal, as flat shading computes it
          vec3 rng = normalize(cross(dFdx(vRockWP), dFdy(vRockWP)));
          float rdist = length(cameraPosition - vRockWP);
          vec3 rN; float rR;
          vec3 ralb = rockSurface(vRockWP, rng, rdist, rN, rR);
          // snow holds on faces flat enough, like the terrain's rock ledges. FEAT-106: while it snows
          // (uSnowAmt 0..1) the cap creeps down the sides and favours the lee (faces looking downwind);
          // near-vertical faces stay bare, and a fresh cap is brighter and smoother
          float lee = dot(rN.xz, uLee) * 0.18 * uSnowAmt;
          float cap = smoothstep(mix(0.74, 0.5, uSnowAmt), mix(0.9, 0.72, uSnowAmt), rN.y + lee + (vnoise(vRockWP * 1.7) - 0.5) * 0.14);
          cap *= smoothstep(0.25, 0.4, rN.y);
          diffuseColor.rgb = mix(ralb * diffuseColor.rgb, mix(vec3(0.93, 0.95, 1.0), vec3(0.97, 0.98, 1.0), uSnowAmt), cap);`)
        .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(rR, mix(0.55, 0.45, uSnowAmt), cap);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          normal = normalize((viewMatrix * vec4(normalize(mix(rN, rng, cap * 0.7)), 0.0)).xyz);`);
    };
  }

  /** Stream cells in the box around the rider (x, y) and the look-ahead point (ax, ay). */
  /** BUG-063: rock cells in range still downloading */
  get pending(): number {
    let n = 0;
    for (const c of this.cells.values()) if (c.loading) n++;
    return n;
  }

  update(x: number, y: number, ax = x, ay = y): void {
    const inst = this.pack.meta.instances;
    if (!inst) return;
    const cs = inst.cellSize;
    const keep = new Set<string>();
    const cx0 = Math.max(0, Math.floor((Math.min(x, ax) - RADIUS - inst.minX) / cs)), cx1 = Math.min(inst.cellsX - 1, Math.floor((Math.max(x, ax) + RADIUS - inst.minX) / cs));
    const cy0 = Math.max(0, Math.floor((Math.min(y, ay) - RADIUS - inst.minY) / cs)), cy1 = Math.min(inst.cellsY - 1, Math.floor((Math.max(y, ay) + RADIUS - inst.minY) / cs));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx}_${cy}`;
        keep.add(key);
        let cell = this.cells.get(key);
        if (!cell) {
          cell = { cx, cy, meshes: [], col: [], loading: true, missing: false, dropped: false, shown: false };
          this.cells.set(key, cell);
          this.load(cell);
        }
        // BUG-088: rocks sit at their real heights, so before the terrain under them has loaded they would hang
        // over the flat sheet that stands in for it: show the cell once the ground there is real
        if (!cell.shown && !cell.loading && cell.meshes.length) {
          const x0 = inst.minX + cx * cs, y0 = inst.minY + cy * cs;
          if (!this.ground || this.ground.groundReady(x0, y0, x0 + cs, y0 + cs)) {
            cell.shown = true;
            for (const m of cell.meshes) m.visible = true;
          }
        }
      }
    }
    for (const [key, cell] of this.cells) {
      if (keep.has(key)) continue;
      for (const m of cell.meshes) { this.group.remove(m); m.dispose(); }
      // BUG-082: the cylinders go with the meshes, or each return would add them again
      if (this.collider && cell.col.length) this.collider.removeAll(cell.col);
      cell.col.length = 0; cell.meshes.length = 0;
      cell.dropped = true;
      this.cells.delete(key);
    }
  }

  private async load(cell: Cell): Promise<void> {
    const listed = this.pack.meta.instances?.rockCells;
    if (listed && !listed.includes(`${cell.cx}_${cell.cy}`)) { cell.missing = true; cell.loading = false; return; } // empty cell, no request
    try {
      const resp = await fetch(`${this.pack.baseUrl}/rocks/${cell.cx}_${cell.cy}.bin`);
      if (!resp.ok) { cell.missing = true; return; }
      const d = new Float32Array(await resp.arrayBuffer());
      if (cell.dropped) return; // BUG-082: the rider left before it arrived; a later visit loads a new cell
      const n = d.length / 6;
      if (n === 0) return;
      // bucket by variant
      const buckets: number[][] = Array.from({ length: VARIANTS }, () => []);
      for (let i = 0; i < n; i++) buckets[hashIndex(d[i * 6], d[i * 6 + 1]) % VARIANTS].push(i);
      for (let v = 0; v < VARIANTS; v++) {
        const list = buckets[v];
        if (list.length === 0) continue;
        const mesh = new THREE.InstancedMesh(this.geos[v], this.mat, list.length);
        mesh.name = `rocks ${cell.cx}_${cell.cy} v${v}`;
        mesh.castShadow = true; mesh.receiveShadow = true;
        list.forEach((i, k) => {
          const o = i * 6;
          const x = d[o], y = d[o + 1], size = Math.max(0.6, d[o + 3]), yaw = d[o + 4], type = d[o + 5];
          // snap to loaded terrain when we have it; the pack's z is the fallback before tiles arrive
          let z = d[o + 2];
          for (const set of this.pack.sets) { if (set.contains(x, y)) { const h = set.sample(x, y); if (!Number.isNaN(h)) { z = h; break; } } }
          const nn = this.pack.groundNormal(x, y, this.normalTmp) as number[];
          placeRock(this.m, x, y, z, size, yaw, type, nn);
          mesh.setMatrixAt(k, this.m);
          // tint near 1 (the shader supplies the rock tone): a little lighter or darker, warmer or cooler
          const t = hash01(x * 0.37 + y * 0.11);
          const u = hash01(x * 0.07 - y * 0.23);
          const tk = 0.85 + 0.3 * t;
          this.c.setRGB(tk * (0.98 + 0.05 * u), tk, tk * (1.0 + 0.05 * (1 - u)));
          mesh.setColorAt(k, this.c);
          // rocks can be ridden over on Realistic and launched off on Arcade; a steep or tall one is a wall
          // BUG-149: the collider fits the part of the rock drawn above the snow; one that barely shows has none
          const rc = this.collider && size > 0.9 ? rockCollider(this.geoPts[v], this.m, x, y, z, nn, this.fit) : null;
          if (rc) cell.col.push(this.collider!.add(rc.x, rc.y, rc.radius, rc.base, rc.top, rc.wall ? 0 : 1, rc.ground));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.visible = false; // BUG-088: update() shows it once the ground under the cell is real
        cell.meshes.push(mesh);
        this.group.add(mesh);
      }
    } catch {
      cell.missing = true;
    } finally {
      cell.loading = false;
    }
  }
}

function hash01(v: number): number { const s = Math.sin(v) * 43758.5453; return s - Math.floor(s); }
function hashIndex(x: number, y: number): number { return Math.floor(hash01(x * 12.9898 + y * 78.233) * 1e4); }

/**
 * A rock: icosphere with two octaves of value noise pushed along the normals, flattened a
 * little, with per-vertex shade that is darker low down and in crevices (the snow cap is done
 * in the shader). Unit size (about 1 m across).
 */
export function makeRock(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(0.5, 2); // already non-indexed (three's polyhedra are), so no toNonIndexed (BUG-128)
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const noise = (x: number, y: number, z: number, f: number) => {
    // cheap smooth-ish hash noise: sum of sines at irrational offsets
    return 0.5 + 0.5 * Math.sin(x * f * 1.7 + seed) * Math.sin(y * f * 2.3 + seed * 0.7) * Math.sin(z * f * 1.9 + seed * 1.3);
  };
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const d = v.length();
    const n1 = noise(v.x, v.y, v.z, 3.0), n2 = noise(v.x, v.y, v.z, 7.5);
    const r = d * (0.78 + 0.32 * n1 + 0.12 * n2);
    v.normalize().multiplyScalar(r);
    // chisel: squash a couple of random planes to get facets
    const k = 0.5 + 0.5 * Math.sin(seed * 3.1);
    v.y *= 0.75 + 0.2 * k;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  // vertex colour: crevice and underside shade, multiplied into the rock albedo
  const col = new Float32Array(pos.count * 3);
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const shade = 0.72 + 0.28 * Math.max(0, nor.getY(i)) - 0.12 * Math.max(0, -pos.getY(i) * 2);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
