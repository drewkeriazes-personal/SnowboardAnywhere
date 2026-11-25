/**
 * FEAT-377: the stems the loading screen generates for each tree cell (stands.ts generateStems, at the Forest density)
 * and each cell's stem area (stemGrow.ts), kept between loads through core/builtData.ts, so a reload neither fetches and
 * decodes the cells' stand images nor generates their stems again. Both depend only on the pack, the density, the stem
 * clumps and the tree lines (Vegetation's key), not on where the camera is. Held only while the loading screen streams:
 * `snapshot` empties it.
 */
import type { Pack } from '../../pack/Pack';
import type { BuiltKey } from '../../core/builtData';

/** what the kept stems depend on besides the pack: the Forest density, the stem clumps (FEAT-337), the tree lines */
export function stemsKey(pack: Pack, density: number, clumps: boolean): BuiltKey {
  const tl = pack.treeLines;
  return { what: 'tree stems', slug: pack.meta.slug, build: pack.meta.build, code: ['world/Vegetation.ts'],
    settings: { forest: density, clumps, treeLines: tl ? (tl.baked ? 'baked' : 'runs') : 'off' } };
}

export interface SavedStems { keys: string[]; areas: Float32Array[]; ks: Float64Array; stems: Float32Array[] }

interface Kept { area: Float32Array | null; k: number; stems: Float32Array | null }

export class StemStore {
  private readonly cells = new Map<string, Kept>();
  /** what this load added (nothing new: no need to save) */
  private added = 0;
  /** recording: between `begin` and `snapshot` (the loading screen's streaming) */
  private on = false;

  begin(saved: SavedStems | null): void {
    this.on = true;
    if (!saved) return;
    saved.keys.forEach((key, i) => this.cells.set(key, { area: saved.areas[i], k: saved.ks[i], stems: saved.ks[i] > 0 ? saved.stems[i] : null }));
  }

  /** the cell's stem area, or null */
  area(key: string): Float32Array | null { return this.cells.get(key)?.area ?? null; }
  /** the cell's stems at density k, or null when none were kept at k */
  stems(key: string, k: number): Float32Array | null { const c = this.cells.get(key); return c && c.k === k ? c.stems : null; }

  addArea(key: string, area: Float32Array): void {
    if (!this.on || this.cells.get(key)?.area) return;
    const c = this.cells.get(key);
    if (c) c.area = area; else this.cells.set(key, { area, k: 0, stems: null });
    this.added++;
  }
  addStems(key: string, k: number, stems: Float32Array): void {
    if (!this.on) return;
    const c = this.cells.get(key);
    if (c) { c.k = k; c.stems = stems; } else this.cells.set(key, { area: null, k, stems });
    this.added++;
  }

  /** what to save (null: nothing new this load), and stop recording; the store empties either way */
  snapshot(): SavedStems | null {
    const out: SavedStems | null = this.added ? { keys: [], areas: [], ks: new Float64Array(this.cells.size), stems: [] } : null;
    if (out) {
      let i = 0;
      for (const [key, c] of this.cells) {
        if (!c.area) continue; // a stem area is always made before the stems
        out.keys.push(key); out.areas.push(c.area); out.ks[i++] = c.k; out.stems.push(c.stems ?? new Float32Array(0));
      }
      out.ks = out.ks.slice(0, i);
    }
    this.cells.clear(); this.added = 0; this.on = false;
    return out;
  }
}
