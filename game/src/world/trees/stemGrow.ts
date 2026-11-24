import { SPECIES, SPECIES_COUNT } from './species';
import { WIDTH_STEP, drawArea, type CrownWidthsMeta } from './widths';
import type { StandGrid } from './stands';

/**
 * BUG-123: past the generated stems' reach the detected crowns stand in for the stems, so a crown's area grows by
 * 1 + S / D of its GROW_BLOCK m block: the stems' crown area there (S, in expectation from the stand image) over the
 * detected crowns' (D, at the radii drawn). A sparse stand, where the detected crowns are most of the canopy, grows less
 * than a closed one, and a block with no stems not at all. Before, every crown grew by one factor (Vail's whole-pack
 * ratio), so on Vail sparse stands drew 2 to 2.7 times their canopy past the edge and closed ones 1.07.
 */
const GROW_BLOCK = 100;
/**
 * BUG-081: the far tree ring has no stands, so its crowns grow by one factor: about the square root of Vail's whole-pack
 * 5.2 (stems 4.2 times the crowns' canopy under FEAT-074's rule). FEAT-298: with crown widths the pack holds the same
 * canopy with wider crowns and fewer stems, so the ring grows by STEM_GROW / sqrt(crownWidths.crownArea).
 */
const STEM_GROW = 2.2;
/** the crowns grow at most this much (linear), so a lone detected crown among stems does not draw as a blob */
const GROW_MAX = 3;
/** E[(0.75 + 0.25 u)^2]: a stem is drawn 0.75 to 1 times the stand height (stands.ts generateStems) */
const H2 = 0.75 * 0.75 + 0.75 * 0.25 + 0.25 * 0.25 / 3;

/** the stems' crown area (m2, in expectation at full density) per GROW_BLOCK m block of a stand image, row 0 = south */
export function stemArea(g: StandGrid, widths: CrownWidthsMeta | null): Float32Array {
  const n = g.size, nb = Math.ceil(n * g.res / GROW_BLOCK), out = new Float32Array(nb * nb), px = g.px;
  for (let i = 0, o = 0; i < n * n; i++, o += 4) {
    const s = px[o + 2];
    if (px[o] === 0 || s >= SPECIES_COUNT) continue;
    const wb = widths ? px[(n * n + i) * 4 + 2] : 0;
    const r = SPECIES[s].radius * px[o + 1] * g.hStep * (wb ? wb / WIDTH_STEP : 1);
    const bx = Math.floor((i % n) * g.res / GROW_BLOCK), by = Math.floor((n - 1 - Math.floor(i / n)) * g.res / GROW_BLOCK);
    out[by * nb + bx] += px[o] / 255 * Math.PI * r * r * H2 * (widths?.widen.includes(s) ? drawArea(widths) : 1);
  }
  return out;
}

/**
 * Per record of a cell (`d` pack records, `cr` their drawn crown radii, the cell's south-west corner at minX, minY):
 * S / D of its block, the crown's squared growth less one at full Forest density (`stems` the cell's stemArea, empty
 * for none; null: the pack has no stands, nothing grows). The generated stems (records from `from` on) get 0, and the
 * crowns outside `bounds` (the far tree ring) STEM_GROW's.
 */
export function growRatio(d: Float32Array, cr: Float32Array, from: number, minX: number, minY: number, stems: Float32Array | null,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }, crownArea: number): Float32Array {
  if (!stems) return new Float32Array(d.length / 6);
  const ring = STEM_GROW * STEM_GROW / crownArea - 1;
  const n = d.length / 6, out = new Float32Array(n), nb = Math.round(Math.sqrt(stems.length)), crowns = new Float32Array(stems.length);
  const blockOf = (i: number): number => Math.min(nb - 1, Math.max(0, Math.floor((d[i * 6 + 1] - minY) / GROW_BLOCK))) * nb + Math.min(nb - 1, Math.max(0, Math.floor((d[i * 6] - minX) / GROW_BLOCK)));
  const inside = (i: number): boolean => d[i * 6] >= bounds.minX && d[i * 6] <= bounds.maxX && d[i * 6 + 1] >= bounds.minY && d[i * 6 + 1] <= bounds.maxY;
  if (nb) for (let i = 0; i < from; i++) if (inside(i)) crowns[blockOf(i)] += Math.PI * cr[i] * cr[i];
  for (let i = 0; i < from; i++) {
    if (!inside(i)) out[i] = ring;
    else if (nb) { const b = blockOf(i); out[i] = Math.min(GROW_MAX * GROW_MAX - 1, stems[b] / crowns[b]); }
  }
  return out;
}
