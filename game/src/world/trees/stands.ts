import { SPECIES, SPECIES_COUNT, hash01 } from './species';
import { WIDTH_STEP, widthDraw, type CrownWidthsMeta } from './widths';

/**
 * FEAT-074: the stems a tree cell's stand density asks for, generated when the cell loads near the camera.
 * The pack keeps the detected crowns (trees/) and, per 1 km cell, stands/<cx>_<cy>.png
 * (MapPacker-SnowboardAnywhere/pipeline/stands.py): per 4 m cell the chance of one stem (R), the stand height (G) and species (B), and
 * in the lower half the ground height (R high byte, G low) and (FEAT-298, packs with `crownWidths`) the width factor in B. Every draw is a hash of the 4 m cell's centre,
 * so a cell generates the same stems every time, and a lower density keeps a subset of a higher one.
 *
 * FEAT-337: the stems come in clumps with gaps down the fall line between them, not an even scatter (Drew's research
 * doc "Glade line formation and generation": conifer stands are a mosaic of clumps, singles and openings under 0.4 ha;
 * gladed spacing 3 to 10 m). A stem's keep chance is the stand's chance times a clump field that averages 1, so the
 * cell's expected count, and its canopy from a distance, hold: a Thomas-style cluster process, CLUMP_PARENTS centres per
 * CLUMP_CELL m cell on average (a hash of the cell), each a Gaussian stretched down the fall line (CLUMP_ALONG m down
 * it, CLUMP_DOWN m across, from the stand image's own ground heights), so the gaps between clumps run down the fall line
 * where riders go (the research's islands pointing uphill), plus CLUMP_SINGLE of the stems scattered
 * evenly. The field's contrast fades out toward a closed stand (CLUMP_OPEN..CLUMP_CLOSED of the stand's chance: a closed
 * stand is closed either way); it depends on the stand alone, not the Forest setting, so a lower density still keeps a
 * subset of a higher one.
 */

/** one cell's decoded stand image and where it sits (pack metres, the cell's south-west corner) */
export interface StandGrid {
  /** RGBA bytes, `size` wide and 2 * `size` tall, row 0 = north */
  px: Uint8ClampedArray;
  size: number;
  res: number;
  minX: number;
  minY: number;
  zBase: number;
  zScale: number;
  hStep: number;
}

/** hash salts: keep, jitter x, jitter y, height */
const S_KEEP = 41, S_JX = 42, S_JY = 43, S_H = 44;
/** a stem stands within this share of its 4 m cell round the centre */
const JITTER = 0.9;
/** FEAT-337: the clump field (see the header) */
const CLUMP_CELL = 20, CLUMP_PARENTS = 1, CLUMP_ALONG = 7, CLUMP_DOWN = 2, CLUMP_SINGLE = 0.2;
const CLUMP_REACH_E = 9; // (3 sigma)^2, matches the 3 * CLUMP_ALONG margin the cell lists are built from
const CLUMP_OPEN = 0.3, CLUMP_CLOSED = 0.85;
/**
 * In a closed stand (no room to add stems to a clump) the stems move instead: each is pulled CLUMP_PULL of the way toward
 * the clump centre that reaches it most, at most CLUMP_PULL_MAX m, so the count holds exactly while the cores densen and
 * the gaps between them open; never onto a 4 m cell with no stand (a run). Singles (CLUMP_SINGLE of the stems) stay put.
 */
const CLUMP_PULL = 0.5, CLUMP_PULL_MAX = 1.6;
const S_SINGLE = 54;
/** hash salts for the clump centres: count, x, y */
const S_CN = 51, S_CX = 52, S_CY = 53;

/**
 * FEAT-337: the clump field over a stand grid: `at(x, y)` is about 1 on average, high in a clump and low in the gaps
 * between them. Its centres cover the grid plus a margin, each with its own contour direction.
 */
class ClumpField {
  /** per centre: x, y, fall-line unit x, y */
  private readonly c: number[] = [];
  private readonly cells = new Map<number, number[]>();
  private readonly norm: number;
  constructor(g: StandGrid) {
    const margin = 3 * CLUMP_ALONG, size = g.size * g.res;
    const i0 = Math.floor((g.minX - margin) / CLUMP_CELL), i1 = Math.floor((g.minX + size + margin) / CLUMP_CELL);
    const j0 = Math.floor((g.minY - margin) / CLUMP_CELL), j1 = Math.floor((g.minY + size + margin) / CLUMP_CELL);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      // 0 to 2 x CLUMP_PARENTS centres per cell, mean CLUMP_PARENTS
      const ox = i * CLUMP_CELL, oy = j * CLUMP_CELL, k = Math.floor(hash01(ox, oy, S_CN) * (2 * CLUMP_PARENTS + 1));
      for (let q = 0; q < k; q++) {
        const x = ox + hash01(ox + q, oy, S_CX) * CLUMP_CELL, y = oy + hash01(ox, oy + q, S_CY) * CLUMP_CELL;
        // the fall line (from the stand image's heights 6 m either side): a clump is long down it, so the gaps between
        // clumps run down it too (glade islands are teardrops pointing uphill)
        const gx = groundAt(g, x + 6, y) - groundAt(g, x - 6, y), gy = groundAt(g, x, y + 6) - groundAt(g, x, y - 6);
        const l = Math.hypot(gx, gy);
        const ux = Number.isFinite(l) && l > 1e-3 ? gx / l : 1, uy = Number.isFinite(l) && l > 1e-3 ? gy / l : 0;
        const id = this.c.length / 4;
        this.c.push(x, y, ux, uy);
        // listed in every cell its 3 sigma reach touches
        for (let b = Math.floor((y - margin) / CLUMP_CELL); b <= Math.floor((y + margin) / CLUMP_CELL); b++) {
          for (let a = Math.floor((x - margin) / CLUMP_CELL); a <= Math.floor((x + margin) / CLUMP_CELL); a++) {
            const key = b * 100003 + a, list = this.cells.get(key);
            if (list) list.push(id); else this.cells.set(key, [id]);
          }
        }
      }
    }
    // a centre's Gaussian integrates to 1 / norm over the plane; the centres' density is CLUMP_PARENTS per cell
    this.norm = (CLUMP_CELL * CLUMP_CELL / CLUMP_PARENTS) / (2 * Math.PI * CLUMP_ALONG * CLUMP_DOWN);
  }
  at(x: number, y: number): number {
    const list = this.cells.get(Math.floor(y / CLUMP_CELL) * 100003 + Math.floor(x / CLUMP_CELL));
    let d = 0;
    if (list) for (const id of list) {
      const o = id * 4, dx = x - this.c[o], dy = y - this.c[o + 1];
      const u = dx * this.c[o + 2] + dy * this.c[o + 3], v = -dx * this.c[o + 3] + dy * this.c[o + 2];
      const e = (u * u) / (CLUMP_ALONG * CLUMP_ALONG) + (v * v) / (CLUMP_DOWN * CLUMP_DOWN);
      if (e < CLUMP_REACH_E) d += Math.exp(-0.5 * e);
    }
    return CLUMP_SINGLE + (1 - CLUMP_SINGLE) * d * this.norm;
  }
  /** the centre of the clump that reaches (x, y) most, into `out` [x, y]; false when none reaches it */
  nearest(x: number, y: number, out: number[]): boolean {
    const list = this.cells.get(Math.floor(y / CLUMP_CELL) * 100003 + Math.floor(x / CLUMP_CELL));
    let best = CLUMP_REACH_E;
    if (list) for (const id of list) {
      const o = id * 4, dx = x - this.c[o], dy = y - this.c[o + 1];
      const u = dx * this.c[o + 2] + dy * this.c[o + 3], v = -dx * this.c[o + 3] + dy * this.c[o + 2];
      const e = (u * u) / (CLUMP_ALONG * CLUMP_ALONG) + (v * v) / (CLUMP_DOWN * CLUMP_DOWN);
      if (e < best) { best = e; out[0] = this.c[o]; out[1] = this.c[o + 1]; }
    }
    return best < CLUMP_REACH_E;
  }
}

/** the stored ground height (m) of 4 m cell (i, j), or NaN where the image holds none */
function sampleZ(g: StandGrid, i: number, j: number): number {
  const o = (g.size * g.size + i * g.size + j) * 4, q = g.px[o] * 256 + g.px[o + 1];
  return q === 0 ? NaN : q / g.zScale + g.zBase;
}

/**
 * The ground height (m) at (x, y) from the grid's 4 m samples: bilinear between the four round it (linear
 * extrapolation in the outer half cell at the image's edges), or the nearest sample when one is missing.
 */
function groundAt(g: StandGrid, x: number, y: number): number {
  const n = g.size, top = g.minY + n * g.res;
  const fj = (x - g.minX) / g.res - 0.5, fi = (top - y) / g.res - 0.5;
  const j0 = Math.max(0, Math.min(n - 2, Math.floor(fj))), i0 = Math.max(0, Math.min(n - 2, Math.floor(fi)));
  const tx = fj - j0, ty = fi - i0;
  const a = sampleZ(g, i0, j0), b = sampleZ(g, i0, j0 + 1), c = sampleZ(g, i0 + 1, j0), d = sampleZ(g, i0 + 1, j0 + 1);
  if (!Number.isNaN(a + b + c + d)) return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  const own = sampleZ(g, Math.max(0, Math.min(n - 1, Math.round(fi))), Math.max(0, Math.min(n - 1, Math.round(fj))));
  if (!Number.isNaN(own)) return own;
  for (const z of [a, b, c, d]) if (!Number.isNaN(z)) return z;
  return NaN;
}

/**
 * The generated stems of a cell at `density` (0..1 of the stand's full density), as pack tree records
 * (x, y, z, height, crown, species id). The crown is 0 (the species' own) unless the pack has `crownWidths`
 * (FEAT-298), when it is the radius to draw: the species' times the cell's width factor times the stem's own draw.
 * FEAT-333: `place` moves a stem off a worn tree line to the line's bank (written into its `out`), or returns false to
 * leave it out.
 */
export function generateStems(g: StandGrid, density: number, widths: CrownWidthsMeta | null = null, place: ((x: number, y: number, out: number[]) => boolean) | null = null, clumps = true): Float32Array {
  const n = g.size, res = g.res, top = g.minY + n * res, px = g.px;
  if (density <= 0) return new Float32Array(0);
  const field = clumps ? new ClumpField(g) : null;
  // the cells that keep a stem, and where it stands
  const keep: number[] = [], at: number[] = [], moved = [0, 0], centre = [0, 0];
  for (let i = 0, o = 0; i < n * n; i++, o += 4) {
    const p = px[o];
    if (p === 0) continue;
    const cx = g.minX + ((i % n) + 0.5) * res, cy = top - (Math.floor(i / n) + 0.5) * res;
    // FEAT-337: the stand's chance times the clump field, its contrast fading out toward a closed stand
    let chance = p / 255;
    if (field) {
      const a = Math.min(1, Math.max(0, (CLUMP_CLOSED - chance) / (CLUMP_CLOSED - CLUMP_OPEN)));
      chance = Math.min(1, chance * (1 + a * (field.at(cx, cy) - 1)));
    }
    if (hash01(cx, cy, S_KEEP) >= chance * density) continue;
    let x = cx + (hash01(cx, cy, S_JX) - 0.5) * res * JITTER, y = cy + (hash01(cx, cy, S_JY) - 0.5) * res * JITTER;
    // FEAT-337: in a closing stand, the stem moves toward its clump (as far as the stand is closed)
    const closed = 1 - Math.min(1, Math.max(0, (CLUMP_CLOSED - p / 255) / (CLUMP_CLOSED - CLUMP_OPEN)));
    if (field && closed > 0 && hash01(cx, cy, S_SINGLE) >= CLUMP_SINGLE && field.nearest(x, y, centre)) {
      const dx = centre[0] - x, dy = centre[1] - y, l = Math.hypot(dx, dy), m = Math.min(CLUMP_PULL_MAX, l * CLUMP_PULL) * closed;
      if (l > 1e-3) {
        const nx = x + dx / l * m, ny = y + dy / l * m;
        const jj = Math.floor((nx - g.minX) / res), ii = Math.floor((top - ny) / res);
        // not onto a run (a 4 m cell with no stand) or off the grid
        if (jj >= 0 && jj < n && ii >= 0 && ii < n && px[(ii * n + jj) * 4] > 0) { x = nx; y = ny; }
      }
    }
    if (place) { if (!place(x, y, moved)) continue; x = moved[0]; y = moved[1]; }
    keep.push(i); at.push(x, y);
  }
  const count = keep.length;
  const out = new Float32Array(count * 6);
  for (let k = 0; k < count; k++) {
    const i = keep[k], o = i * 4, x = at[k * 2], y = at[k * 2 + 1];
    const cx = g.minX + ((i % n) + 0.5) * res, cy = top - (Math.floor(i / n) + 0.5) * res;
    const z = groundAt(g, x, y);
    const b = k * 6;
    out[b] = x; out[b + 1] = y; out[b + 2] = Number.isNaN(z) ? g.zBase : z;
    const h = px[o + 1] * g.hStep * (0.75 + 0.25 * hash01(cx, cy, S_H)), s = px[o + 2];
    out[b + 3] = h; out[b + 5] = s;
    // FEAT-298: the cell's width factor (lower half B) times the stem's own draw, as the radius to draw
    const wb = widths ? px[(n * n + i) * 4 + 2] : 0;
    out[b + 4] = widths && s < SPECIES_COUNT ? SPECIES[s].radius * h * (wb ? wb / WIDTH_STEP : 1) * widthDraw(widths, s, x, y) : 0;
  }
  return out;
}
