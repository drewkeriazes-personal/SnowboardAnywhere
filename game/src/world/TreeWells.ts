import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Vegetation } from './Vegetation';
import { aspectOf, snowpackDepth, snowpackState, type SnowpackState } from '../sim/Snowpack';

/**
 * FEAT-216: tree wells. In deep snow the lower boughs of a spruce or fir keep the snow off round its trunk, so the
 * surface dips into a soft well there, deepest at the trunk: WELL_K of the snowpack (sim/Snowpack.ts), at most WELL_MAX,
 * out to REACH_K of the crown radius. None on a groomer (the mask's groomed share), SPRING_K of it on a spring day.
 *
 * The wells near the rider are stamped on the CPU into a SIZE m square of RES texels (its origin snapped to SNAP m),
 * from the trees Vegetation has loaded. The same bytes are the physics (`at`, bilinear, which Pack.terrainHeight adds,
 * so the board, the tracks and everything on the ground drop in) and the terrain shader's (`WELL_GLSL`: the vertex
 * sinks by it and the normal tilts by its slope, the GPU's linear filter matching `at`). A tree within EDGE m of the
 * window's edge gets none, so the edge texels are 0 and nothing shows past them.
 */
const SIZE = 128, RES = 512, SNAP = 16, EDGE = 8;
const TEXEL = SIZE / RES;
/** the deepest well (m): 1.0 in the texture */
const WELL_MAX = 1;
/** a well's depth at the trunk as a share of the snowpack there */
const WELL_K = 0.5;
/** how far a well reaches from the trunk (m): this share of the crown radius, clamped */
const REACH_K = 0.5, REACH_MIN = 1, REACH_MAX = 2;
/** trees shorter than this (m) are young or half buried: no well */
const MIN_H = 4;
/** a spring day's wells: the snow round the trunks has settled and melted in */
const SPRING_K = 0.35;
/** the species with low, dense boughs (trees/species.ts): Engelmann spruce, subalpine fir, Douglas-fir, eastern hemlock */
const WELL_SPECIES = [true, false, false, true, false, true, false, false, false, true];
/** frames between looks for trees that loaded or changed while the window stood still */
const RECHECK = 20;

export const wellUniforms = {
  uWell: { value: null as THREE.Texture | null },
  /** the window's origin (pack x, y), 1 / size, 1 = on */
  uWellWin: { value: new THREE.Vector4(0, 0, 1 / SIZE, 0) },
};

export const WELL_GLSL = /* glsl */ `
  uniform sampler2D uWell;
  uniform vec4 uWellWin;
  // FEAT-216: the tree wells' depth (m, <= 0) at a three.js world xz (pack y = -z)
  float treeWell(vec2 xz) { return -textureLod(uWell, vec2(xz.x - uWellWin.x, -xz.y - uWellWin.y) * uWellWin.z, 0.0).r * ${WELL_MAX.toFixed(1)}; }
  // its slope (d/dx, d/dz in three.js axes)
  vec2 treeWellSlope(vec2 xz) {
    const float o = ${(TEXEL * 2).toFixed(2)};
    return vec2(treeWell(xz + vec2(o, 0.0)) - treeWell(xz - vec2(o, 0.0)), treeWell(xz + vec2(0.0, o)) - treeWell(xz - vec2(0.0, o))) / (2.0 * o);
  }
`;

export class TreeWells {
  readonly data = new Uint8Array(RES * RES);
  readonly texture = new THREE.DataTexture(this.data, RES, RES, THREE.RedFormat, THREE.UnsignedByteType);
  /** the window's origin (pack x, y); NaN until the first fill */
  x0 = NaN; y0 = NaN;
  /** wells stamped in the last fill (for checks) */
  count = 0;
  private snow: SnowpackState = snowpackState(2, 'mid', 0);
  private spring = false;
  private sig = NaN;
  private wait = 0;
  private readonly stamps: number[] = [];
  private readonly tmp = [0, 0, 0, 0];
  private readonly asp: [number, number] = [0, 0];

  constructor(private readonly pack: Pack, private readonly trees: Pick<Vegetation, 'forEachTree'>) {
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.name = 'tree wells';
    wellUniforms.uWell.value = this.texture;
  }

  /** the day's snowpack and whether it is a spring day */
  setSnow(st: SnowpackState, day: string): void { this.snow = st; this.spring = day === 'spring'; }

  /** the well's depth at a point (m, <= 0; 0 outside the window), bilinear over the texels as the GPU filters them */
  at(x: number, y: number): number {
    const fx = (x - this.x0) / TEXEL - 0.5, fy = (y - this.y0) / TEXEL - 0.5;
    if (!(fx >= 0 && fy >= 0 && fx < RES - 1 && fy < RES - 1)) return 0;
    const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, d = this.data, k = j * RES + i;
    const a = d[k] + (d[k + 1] - d[k]) * tx, b = d[k + RES] + (d[k + RES + 1] - d[k + RES]) * tx;
    return -(a + (b - a) * ty) / 255 * WELL_MAX;
  }

  /** a conifer's well depth at its trunk (m): the snowpack's share, none on a groomer, less in spring */
  private depthAt(x: number, y: number, z: number): number {
    const f = this.pack.fallAt(x, y, this.tmp), l = Math.hypot(f[0], f[1], 1);
    const a = aspectOf(f[0] / l, f[1] / l, this.asp); // the normal leans downhill
    const groomed = this.pack.mask ? this.pack.mask.sample(x, y, this.tmp)[2] : 0;
    return Math.min(WELL_MAX, WELL_K * snowpackDepth(this.snow, z, a[0], a[1])) * (1 - groomed) * (this.spring ? SPRING_K : 1);
  }

  /** follow the rider (pack x, y): restamp when the window moves, or when the trees or the snow in it changed */
  update(x: number, y: number): void {
    const ox = Math.floor((x - SIZE / 2) / SNAP) * SNAP, oy = Math.floor((y - SIZE / 2) / SNAP) * SNAP;
    const moved = ox !== this.x0 || oy !== this.y0;
    if (!moved && --this.wait > 0) return;
    this.wait = RECHECK;
    const s = this.stamps;
    s.length = 0;
    let sig = ox * 7 + oy * 13;
    this.trees.forEachTree(ox + EDGE, oy + EDGE, ox + SIZE - EDGE, oy + SIZE - EDGE, (tx, ty, tz, h, cr, sp) => {
      if (!WELL_SPECIES[sp] || h < MIN_H) return;
      const dep = this.depthAt(tx, ty, tz);
      if (dep < 0.02) return;
      const r = Math.min(REACH_MAX, Math.max(REACH_MIN, REACH_K * cr));
      s.push(tx, ty, r, dep);
      sig += tx * 0.37 + ty * 0.73 + dep * 101 + r;
    });
    if (!moved && sig === this.sig) return;
    this.sig = sig; this.x0 = ox; this.y0 = oy;
    this.data.fill(0);
    for (let k = 0; k < s.length; k += 4) this.stamp(s[k] - ox, s[k + 1] - oy, s[k + 2], s[k + 3]);
    this.count = s.length / 4;
    this.texture.needsUpdate = true;
    wellUniforms.uWellWin.value.set(ox, oy, 1 / SIZE, 1);
  }

  /** one well at window-local (lx, ly): (1 - (d / r)^2)^2 of `dep`, the deepest one kept where two overlap */
  private stamp(lx: number, ly: number, r: number, dep: number): void {
    const d = this.data, v = dep / WELL_MAX * 255;
    const i0 = Math.max(0, Math.floor((lx - r) / TEXEL)), i1 = Math.min(RES - 1, Math.floor((lx + r) / TEXEL));
    const j0 = Math.max(0, Math.floor((ly - r) / TEXEL)), j1 = Math.min(RES - 1, Math.floor((ly + r) / TEXEL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * TEXEL - lx, dy = (j + 0.5) * TEXEL - ly, q = 1 - (dx * dx + dy * dy) / (r * r);
      if (q <= 0) continue;
      const w = Math.round(v * q * q), k = j * RES + i;
      if (w > d[k]) d[k] = w;
    }
  }

  dispose(): void { this.texture.dispose(); wellUniforms.uWell.value = null; wellUniforms.uWellWin.value.w = 0; }
}
