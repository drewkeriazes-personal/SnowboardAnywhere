import type { TreeLines } from '../../pack/treeLines';
import { TRIM, trimReach } from './trim';

/**
 * FEAT-373: the crowns close over a narrow tree line. Riding one used to read as a hallway: a straight strip of sky the
 * line's whole length, between two even walls of trunks bare to well over head height. Now the trees on its rim reach in
 * over it, so the line is a gap under the trees, sky showing only between crowns.
 *
 * Per tree on a line's rim (`lineCanopy`, when its sub-tile is trimmed: Vegetation.trimTile), from the nearest line
 * (TreeLines.nearestLine) and how much it closes (`w`: full on a narrow line, WIDE_OPEN less on the wide, strong ones near
 * the run so riders can find them, none on a faint line's end or past the first row of trunks):
 *  - the trim line comes down toward H1 m (the glade trim's height scale hs, so the shader and the puffs both see it), so
 *    the boughs are back from about shoulder height instead of 3 to 8 m up
 *  - its lean: the direction to the line and the reach L (m). The shader (LEAN_GLSL) stretches the half of the crown facing
 *    the line toward it: a bough f m out along that direction moves min(f k, L) further, k = L / (CROWN x cr), so the
 *    crown's edge reaches L further at the widest and proportionally less up its narrowing top. It rises in from the tree's
 *    trim line (`leanFrom`, never lower than Y0) over RISE m, so nothing new overhangs the rider in the bare-trunk zone; the
 *    trunk itself (the core) stays put, and the collider only ever held trunks.
 *
 * The near LODs carry trim and lean in one per-instance vec4 (`stageTrim`), so the lean costs the vertex shader no attribute
 * of its own. The puffs (`drawnRadius`, through Vegetation.crownContact) invert the same stretch, so a rider brushes exactly
 * the boughs drawn. The lean fades out before the far LODs take over (uLeanFar, the last mesh LOD's band), which draw
 * neither it nor the trim.
 */
export const LEAN = {
  /** a line counts as wide and strong (near the run) over these half-widths (m) and strengths; it keeps WIDE_OPEN of its gap */
  HW_WIDE: [1.4, 1.9], STR_WIDE: [0.75, 0.95], WIDE_OPEN: 0.6,
  /** a faint line (its ends) closes nothing up to STR_LO, fully from STR_HI */
  STR_LO: 0.1, STR_HI: 0.35,
  /** the trees from D0 to D1 m past the line's half-width fade out of it (the first row stands 1.25 to 1.85 m past it) */
  D0: 2.0, D1: 3.2,
  /** the crown's edge, CROWN of its radius out, reaches OVER m past the line's centreline, by at most MAX m */
  OVER: 0, CROWN: 0.8, MAX: 2.0,
  /** the reach rises in from the tree's trim line (at least Y0 m above its base) over RISE m */
  Y0: 2.2, RISE: 2.2,
  /** the trim line over a narrow line, m (where its boughs are full again; TRIM.H1 elsewhere) */
  H1: 2.4,
} as const;

const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hit = [0, 0, 0, 0, 0];

/**
 * Tree i at (x, y) with crown radius cr, if trimmed, against the nearest line: lowers its trim line in `trim` (t, bare, hs
 * per tree) and writes its lean into `lean` (per tree the direction to the line as a three.js xz angle, and L; made for the
 * cell's n trees on the first tree that leans), returned.
 */
export function lineCanopy(tl: TreeLines, x: number, y: number, cr: number, trim: Float32Array, i: number, lean: Float32Array | null, n: number): Float32Array | null {
  if (!tl.nearestLine(x, y, hit)) return lean;
  const [d, hw, str, ux, uy] = hit;
  const w = smooth(LEAN.STR_LO, LEAN.STR_HI, str) * (1 - LEAN.WIDE_OPEN * smooth(LEAN.HW_WIDE[0], LEAN.HW_WIDE[1], hw) * smooth(LEAN.STR_WIDE[0], LEAN.STR_WIDE[1], str)) * (1 - smooth(LEAN.D0, LEAN.D1, d - hw));
  const o = i * 3;
  if (w <= 0 || trim[o] <= 0) return lean; // only a trimmed tree (a closed stand) leans
  trim[o + 2] += (Math.min(trim[o + 2], LEAN.H1 / TRIM.H1) - trim[o + 2]) * w;
  const L = w * Math.min(LEAN.MAX, Math.max(0, d + LEAN.OVER - LEAN.CROWN * cr));
  if (L < 0.05) return lean;
  lean ??= new Float32Array(n * 2);
  lean[i * 2] = Math.atan2(-uy, ux); lean[i * 2 + 1] = L;
  return lean;
}

/** the height (m above the base) tree i (h m tall) starts to lean at: just under its trim line, at least Y0 (as in LEAN_GLSL) */
export function leanFrom(trim: Float32Array, i: number, h: number): number {
  const o = i * 3;
  return Math.max(LEAN.Y0, Math.min(TRIM.H1 * trim[o + 2], TRIM.F1[trim[o + 1]] * h) - 0.2);
}

/**
 * Tree i's near-LOD `aTrim` into `out` at 4 x e: (t + 2 bare, hs, the lean as a vector in the frame of the instance with
 * yaw `yaw`: L m toward the line, at its world angle plus the yaw). Bare is 0 or 1 and t 0..1, so they share a float and
 * the lean needs no attribute of its own.
 */
export function stageTrim(trim: Float32Array, lean: Float32Array | null, i: number, yaw: number, out: Float32Array, e: number): void {
  const o = i * 3, q = e * 4, a = lean ? lean[i * 2] + yaw : 0, L = lean ? lean[i * 2 + 1] : 0;
  out[q] = trim[o] + 2 * trim[o + 1]; out[q + 1] = trim[o + 2]; out[q + 2] = L * Math.cos(a); out[q + 3] = L * Math.sin(a);
}

/** how far tree i's drawn crown can reach past its radius (m): the trim's fuller boughs and the lean */
export function crownGrow(trim: Float32Array, lean: Float32Array | null, i: number, cr: number): number {
  return (trim[i * 3] > 0 ? cr * TRIM.BUSH : 0) + (lean ? lean[i * 2 + 1] : 0);
}

/**
 * The drawn crown's radius (m) of tree i (h m tall, crown radius cr) at y m above its base toward a rider dx, dy m (pack)
 * from its trunk, from r, its radius there before the trim and the lean: the trim (trimReach), then the inverse of the
 * shader's stretch along the ray to the rider (an ellipse while the bough is inside CROWN x cr, a shift past it).
 */
export function drawnRadius(trim: Float32Array, lean: Float32Array | null, i: number, h: number, cr: number, y: number, r: number, dx: number, dy: number, tmp: number[]): number {
  const o = i * 3;
  if (trim[o] > 0) r *= trimReach(trim[o], trim[o + 1], trim[o + 2], h, y, tmp);
  const L = lean ? lean[i * 2 + 1] : 0, dl = Math.hypot(dx, dy);
  if (!lean || L <= 0 || r <= 0 || dl < 1e-6) return r;
  const y0 = leanFrom(trim, i, h), g = smooth(y0, y0 + LEAN.RISE, y);
  // the lean's world angle is in three.js x, z (z = -north)
  const c = (dx * Math.cos(lean[i * 2]) - dy * Math.sin(lean[i * 2])) / dl;
  if (g <= 0 || c <= 0) return r;
  const s2 = 1 - c * c, a = LEAN.CROWN * cr, q = 1 + g * L / a;
  const t1 = r / Math.sqrt(c * c / (q * q) + s2);
  if (t1 * c <= a * q) return t1;
  const gL = g * L;
  return c * gL + Math.sqrt(Math.max(0, r * r - gL * gL * s2));
}

const f = (v: number): string => v.toFixed(3);
/**
 * The stretch in GLSL for KIT_BEGIN (needs uLeanFar and kCamD, the camera's distance from lodVis): `leanCrown(xz, ax, ta,
 * y, tr, ln, kH, s)` moves the vertex `xz` (the instance's frame, round the axis point `ax`, core radius ta) y m above the
 * base, for the instance's trim tr = (t, bare, hs), lean vector `ln` (m, stageTrim), height kH and crown radius s. Keep in
 * step with `drawnRadius`.
 */
export const LEAN_GLSL = /* glsl */ `
  vec2 leanCrown(vec2 xz, vec2 ax, float ta, float y, vec3 tr, vec2 ln, float kH, float s) {
    float y0 = max(${f(LEAN.Y0)}, min(${f(TRIM.H1)} * tr.z, mix(${f(TRIM.F1[0])}, ${f(TRIM.F1[1])}, tr.y) * kH) - 0.2);
    if (y <= y0 || kCamD >= uLeanFar.y) return xz;
    float L = length(ln);
    vec2 u = ln / L, dd = xz - ax;
    float fu = dot(dd, u);
    if (fu <= 0.0) return xz;
    float g = smoothstep(y0, y0 + ${f(LEAN.RISE)}, y) * (1.0 - smoothstep(uLeanFar.x, uLeanFar.y, kCamD));
    L /= s;
    return xz + u * (min(fu * L / ${f(LEAN.CROWN)}, L) * g * smoothstep(ta, 2.0 * ta + 0.05, length(dd)));
  }
`;
