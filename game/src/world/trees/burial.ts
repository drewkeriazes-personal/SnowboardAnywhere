import { aspectOf, snowpackChanged, snowpackDepth, snowpackState, type SnowpackState } from '../../sim/Snowpack';
import { hash01 } from './species';

/**
 * FEAT-336: the day's snowpack (sim/Snowpack.ts, the depth FEAT-159 buries the shrubs by) buries the small trees, so
 * glades open up through the season. The terrain is the snow surface and a tree's height is from the bare ground, so a
 * tree shorter than the snowpack plus BURY_SHOW is gone (not drawn, not in the collider), and one up to BURY_HALF taller
 * than the snowpack is sunk by it, half buried as the young conifers in the shrub layer are. Past that the sink eases off
 * over BURY_EASE m, so a taller tree stands at its full height as before. The depth carries the shrubs' +-10 % drift per
 * spot unless `?snowdepth=` sets one depth everywhere. Applies to the pack's records and the generated stems alike, so
 * the far LODs lose exactly the trees that are gone and nothing else changes.
 */

/** a tree shorter than the snowpack plus this (m) is under the snow */
const BURY_SHOW = 0.5;
/** a tree up to this much (m) taller than the snowpack is sunk by it */
const BURY_HALF = 1.5;
/** then the sink eases off over this many metres more */
const BURY_EASE = 1.5;
/** the shrubs' drift jitter on the depth (Shrubs.ts), and its hash salt */
const JIT = 0.1, S_JIT = 23;
/** the trees bury again when the snowpack moves this many times the shrubs' step (about 5 cm) */
const REBURY_K = 2.5;

/** the snowpack depth (m) for a tree at (x, y, z) */
export type DepthAt = (x: number, y: number, z: number) => number;

/** how far a tree h m tall sinks into a snowpack `depth` m deep: NaN when it is under the snow */
function treeSink(h: number, depth: number): number {
  if (depth <= 0) return 0;
  if (h < depth + BURY_SHOW) return NaN;
  const e = h - depth - BURY_HALF;
  return e <= 0 ? depth : depth * Math.max(0, 1 - e / BURY_EASE);
}

/** the tallest tree (m) a snowpack state can still touch: the deepest it gets (high up, north face, drift) plus the eases */
export function buryReach(st: SnowpackState): number {
  const deep = st.override !== null ? Math.max(0, st.override) : snowpackDepth(st, 1e5, 0, 1) * (1 + JIT);
  return deep > 0 ? deep + BURY_HALF + BURY_EASE : 0;
}

/**
 * Records (6 floats: x, y, z, h, ...) with the trees under the snow left out and the half-buried ones sunk; `recs`
 * itself when the snow touches none of them. Trees `reach` m or taller (buryReach) are not looked at.
 */
export function buryTrees(recs: Float32Array, depthAt: DepthAt, reach: number): Float32Array {
  let out: Float32Array | null = null, n = 0;
  for (let i = 0; i < recs.length; i += 6) {
    const h = recs[i + 3];
    const s = h < reach ? treeSink(h, depthAt(recs[i], recs[i + 1], recs[i + 2])) : 0;
    if (s !== 0 && !out) { out = new Float32Array(recs.length); out.set(recs.subarray(0, i)); n = i; }
    if (!out || Number.isNaN(s)) continue;
    out.set(recs.subarray(i, i + 6), n);
    out[n + 2] -= s;
    n += 6;
  }
  return out ? out.slice(0, n) : recs;
}

/** the lowest tree in records (m) */
function lowestTree(recs: Float32Array | null): number {
  let lo = Infinity;
  if (recs) for (let i = 3; i < recs.length; i += 6) lo = Math.min(lo, recs[i]);
  return lo;
}

/** a cell's records as the pack has them, before the snow (its own crowns and the far ring's), and the snow they were buried in */
export interface UnburiedTrees {
  own: Float32Array | null;
  far: Float32Array | null;
  /** the lowest of them and of the stems generated in the cell so far (m) */
  low: number;
  epoch: number;
  reach: number;
}

/** the day's snowpack for the trees: a new epoch when it changes by about 5 cm, so the cells it touches bury again */
export class TreeBurial {
  snow: SnowpackState = snowpackState(2, 'mid', 0);
  epoch = 0;
  reach = buryReach(this.snow);
  private readonly n = [0, 0, 1];
  private readonly a: [number, number] = [0, 0];

  constructor(private readonly normal: (x: number, y: number, out: number[]) => ArrayLike<number>) {}

  set(st: SnowpackState): void {
    if (!snowpackChanged(this.snow, st, REBURY_K)) return;
    this.snow = st; this.reach = buryReach(st); this.epoch++;
  }

  readonly depthAt: DepthAt = (x, y, z) => {
    const st = this.snow;
    if (st.override !== null) return Math.max(0, st.override);
    const n = this.normal(x, y, this.n), a = aspectOf(n[0], n[1], this.a);
    return snowpackDepth(st, z, a[0], a[1]) * (1 - JIT + 2 * JIT * hash01(x, y, S_JIT));
  };

  /** a cell's generated stems buried in today's snowpack, noting the lowest in `u` */
  buryStems(u: UnburiedTrees | null, stems: Float32Array): Float32Array {
    if (u) u.low = Math.min(u.low, lowestTree(stems));
    return buryTrees(stems, this.depthAt, this.reach);
  }

  /** the records as loaded, not yet buried */
  unburied(own: Float32Array | null, far: Float32Array | null): UnburiedTrees {
    return { own, far, low: Math.min(lowestTree(own), lowestTree(far)), epoch: -1, reach: 0 };
  }

  /** whether a cell buried in an older snowpack has trees it touched then or touches now (a cell it touches neither time is brought up to date) */
  stale(u: UnburiedTrees): boolean {
    if (u.epoch === this.epoch) return false;
    if (u.low < Math.max(u.reach, this.reach)) return true;
    u.epoch = this.epoch; u.reach = this.reach;
    return false;
  }

  /** a cell's records buried in today's snowpack (`data`: own then far), its own crowns among them, and the epoch noted */
  buryCell(u: UnburiedTrees): { data: Float32Array; own: Float32Array | null } {
    u.epoch = this.epoch; u.reach = this.reach;
    const own = u.own && buryTrees(u.own, this.depthAt, this.reach), far = u.far && buryTrees(u.far, this.depthAt, this.reach);
    if (!own || !far) return { data: own ?? far ?? new Float32Array(0), own };
    const data = new Float32Array(own.length + far.length);
    data.set(own); data.set(far, own.length);
    return { data, own };
  }
}
