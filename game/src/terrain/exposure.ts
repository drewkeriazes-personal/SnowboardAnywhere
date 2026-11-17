/**
 * Exposure (FEAT-020): rock and talus where snow cannot stay, unioned with the imagery mask. The terrain
 * chunks write these weights to their vertices and the shader thresholds them against noise (rockCover.ts),
 * so 0.5 is where patches start. BUG-035: the rider's grip, the surface sounds and the snow track read the
 * same weights through `exposureAt`, so rock drawn on a steep face or a scoured ridge rides as rock.
 */
import * as THREE from 'three';
import { type Pack, MOGUL_MAX_RES } from '../pack/Pack';

export interface Exposure { rock: number; scree: number }

/**
 * Rock and scree vertex weights at a point.
 * @param h base height at (x, y) (no mogul bumps)
 * @param nxp, nyp the unnormalised normal's x and y from central differences `res` apart (z = 1)
 * @param res vertex spacing of the chunk the point is drawn on
 * @param fo forest weight (no ridge scour under trees)
 * @param rock, scree the mask's weights
 * @returns rock, and scree already cut by rock (as the vertex colour carries it)
 */
export function exposure(pack: Pack, x: number, y: number, h: number, nxp: number, nyp: number, res: number, fo: number, rock: number, scree: number, out: Exposure): Exposure {
  const resB = Math.max(res, MOGUL_MAX_RES * 2); // auxiliary samples without the mogul bumps
  const slope = Math.acos(1 / Math.hypot(nxp, nyp, 1)); // radians
  // Steep faces: weight 0.5 at about 45 deg near the rider; coarse chunks average slopes down,
  // so the threshold eases lower with vertex spacing (about 37 deg at 128 m).
  const steepLo = 0.68 - 0.022 * Math.log2(Math.max(1, res));
  const steep = THREE.MathUtils.smoothstep(slope, steepLo, steepLo + 0.2);
  // wind-scoured convex ridges above about 3,250 m: relief over the mean of four neighbours d away
  const d = Math.max(12, res);
  const relief = h - 0.25 * (pack.height(x + d, y, resB) + pack.height(x - d, y, resB) + pack.height(x, y + d, resB) + pack.height(x, y - d, resB));
  const scour = THREE.MathUtils.smoothstep(relief / d, 0.06, 0.2) * THREE.MathUtils.smoothstep(h, 3250, 3550) * (1 - fo);
  rock = Math.max(rock, steep, scour * 0.8);
  // talus apron at the foot of steep faces: the line to a point 15 m uphill is steeper than about
  // 48 deg while the ground here is gentler
  if (res <= 8 && slope > 0.2) {
    const du = 15, gl = Math.hypot(nxp, nyp);
    const up = pack.height(x - (nxp / gl) * du, y - (nyp / gl) * du, resB);
    const talus = THREE.MathUtils.smoothstep((up - h) / du, 0.95, 1.4) * (1 - steep);
    scree = Math.max(scree, talus * 0.9);
  }
  out.rock = rock; out.scree = scree * (1 - rock);
  return out;
}

/** Vertex spacing of the finest chunk the terrain draws at a point: 1 m inside the fine set, else mid, else far. */
export function finestChunkRes(pack: Pack, x: number, y: number): number {
  if (pack.fine && pack.fine.contains(x, y)) return pack.fine.meta.res;
  if (pack.mid && pack.mid.contains(x, y)) return pack.mid.meta.res / 2;
  return (pack.far?.meta.res ?? 128) / 2;
}

/**
 * The weights the terrain shows at a point near the rider, from base heights at the finest chunk's spacing
 * (as Terrain.build samples them) and the mask's rock, scree and forest.
 */
export function exposureAt(pack: Pack, x: number, y: number, rock: number, scree: number, fo: number, out: Exposure): Exposure {
  const res = finestChunkRes(pack, x, y);
  const h = pack.height(x, y, res, false);
  const nxp = -(pack.height(x + res, y, res, false) - pack.height(x - res, y, res, false)) / (2 * res);
  const nyp = -(pack.height(x, y + res, res, false) - pack.height(x, y - res, res, false)) / (2 * res);
  if (Number.isNaN(h + nxp + nyp)) { out.rock = rock; out.scree = scree * (1 - rock); return out; }
  return exposure(pack, x, y, h, nxp, nyp, res, fo, rock, scree, out);
}
