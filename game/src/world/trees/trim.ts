import { hash01 } from './species';

/**
 * FEAT-303: the glade trim, one profile for the tree shader (materials.ts, TRIM_GLSL) and the CPU (the snow puffs off the
 * boughs, TreeBrush via Vegetation.crownContact), so a rider never brushes a branch the shader took away.
 *
 * Per tree, three numbers (Vegetation.prepare, the near LODs' `aTrim`):
 *  - t: how far its lower branches are worn back, 0..1: the glade level here (pack/treeLines.ts `trimAt`) times how closed
 *    the stand round it is (`standGate`: lone trees on an open bowl keep their skirts, as in deep untouched forest) times
 *    a draw of its own
 *  - bare: 1 for TRIM_BARE of the trimmed trees (a hash of the base): no needles at all below the line, the limbs pulled to
 *    stubs, as in Drew's Snowstorm glades clips; their trim is full
 *  - hs: the trim line's height scale, its own draw (TRIM_HS_LO..HI), and TRIM_BARE_H times that on a bare tree, so the
 *    line is not one height through the glade
 *
 * Over height y above the base: `low` is full up to H0 x hs (at most F0 of a small tree's height) and gone by H1 x hs (at
 * most F1 of it); a fully trimmed bough reaches PULL less far out and drops its needles under the noise level THIN. Just
 * over the line, `up` makes the boughs reach up to BUSH further out over BUSH_H m (they have the light the trimmed ones left).
 */
export const TRIM = {
  H0: 2.8, H1: 4.2, PULL: 0.92, THIN: 0.9, BUSH: 0.5, BUSH_H: 5.0,
  BARE: 0.6, BARE_H: 1.5, BARE_T: 1.4,
  HS_LO: 0.7, HS_HI: 1.35,
  /** the share of a small tree's height the line can reach: normal tree, bare tree */
  F0: [0.45, 0.55], F1: [0.65, 0.75],
} as const;

/** the stand's crown cover (0..1) over which the trim fades in: closed stands only */
export const STAND_OPEN = 0.12, STAND_CLOSED = 0.3;

const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** how closed the stand is for a crown cover 0..1 (0 open, 1 closed) */
export function standGate(cover: number): number { return smooth(STAND_OPEN, STAND_CLOSED, cover); }

/** a tree's [t, bare, hs] from the glade level `level` (0..1) and the stand's closedness `gate`, into `out` at `o` */
export function treeTrim(level: number, gate: number, x: number, y: number, out: Float32Array, o: number): void {
  const t0 = level * gate * (0.75 + 0.25 * hash01(x, y, 29));
  const bare = t0 > 0.05 && hash01(x, y, 31) < TRIM.BARE ? 1 : 0;
  const hs = (TRIM.HS_LO + (TRIM.HS_HI - TRIM.HS_LO) * hash01(x, y, 37)) * (bare ? TRIM.BARE_H : 1);
  out[o] = bare ? Math.min(1, t0 * TRIM.BARE_T) : t0; out[o + 1] = bare; out[o + 2] = hs;
}

/** the trim at height y (m above the base) of a tree h m tall: [low, up] into `out` */
export function trimAt(t: number, bare: number, hs: number, h: number, y: number, out: number[]): number[] {
  const h1 = Math.min(TRIM.H1 * hs, TRIM.F1[bare] * h);
  out[0] = t * (1 - smooth(Math.min(TRIM.H0 * hs, TRIM.F0[bare] * h), h1, y));
  out[1] = t * smooth(h1 - 0.6, h1 + 0.4, y) * (1 - smooth(h1 + TRIM.BUSH_H * 0.4, h1 + TRIM.BUSH_H, y));
  return out;
}

/**
 * How far the needled crown reaches at that height as a share of its untrimmed radius (CPU, for the puffs): none where a
 * bare tree is trimmed (only the trunk), pulled in and thinned on the rest, wider in the bushy band over the line.
 */
export function trimReach(t: number, bare: number, hs: number, h: number, y: number, tmp: number[]): number {
  if (t <= 0) return 1;
  const [low, up] = trimAt(t, bare, hs, h, y, tmp);
  if (bare && low > 0.5) return 0;
  // the needles left: the thinning drops all but (1 - THIN x low) of them; below a third the bough does not hold snow to shed
  if (1 - TRIM.THIN * low < 0.33) return 0;
  return (1 - TRIM.PULL * low) * (1 + TRIM.BUSH * up);
}

const f = (v: number): string => v.toFixed(3);
/**
 * The same profile in GLSL for KIT_BEGIN: `trimLowUp(aTrim, kH, kY)` returns vec2(low, up) for the instance's
 * aTrim = (t, bare, hs), tree height kH and height kY above its base. Keep in step with `trimAt`.
 */
export const TRIM_GLSL = /* glsl */ `
  vec2 trimLowUp(vec3 tr, float kH, float kY) {
    float h1 = min(${f(TRIM.H1)} * tr.z, mix(${f(TRIM.F1[0])}, ${f(TRIM.F1[1])}, tr.y) * kH);
    float h0 = min(${f(TRIM.H0)} * tr.z, mix(${f(TRIM.F0[0])}, ${f(TRIM.F0[1])}, tr.y) * kH);
    return tr.x * vec2(1.0 - smoothstep(h0, h1, kY), smoothstep(h1 - 0.6, h1 + 0.4, kY) * (1.0 - smoothstep(h1 + ${f(TRIM.BUSH_H * 0.4)}, h1 + ${f(TRIM.BUSH_H)}, kY)));
  }
`;
