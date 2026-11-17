/**
 * BUG-065: the mogul bumps as the terrain mesh draws them. The finest chunks bake `Pack.bumpAt` into their
 * vertices (Terrain.ts) and the triangles between them cut across the bumps, whose troughs are only 2.5 to
 * 5.6 m apart across the slope: on a 1 m grid the drawn snow sits up to 13 cm (16 deg) to 32 cm (32 deg) off
 * the exact function the physics rides. The snow tracks laid on the exact function poked out of the drawn
 * snow as tilted plates and walls, or sank into it, so they (and the board as drawn) take this height.
 *
 * Only the bumps are corrected: the base DEM, bridge decks and everything off a mogul field read exactly as
 * `Pack.groundHeight`. Points beyond the bump geometry (chunks coarser than MOGUL_MAX_RES, shaded only) draw
 * no bumps at all. Each cell splits along its (i, j) to (i + 1, j + 1) diagonal like the chunk index.
 */
import { type Pack, MOGUL_MAX_RES } from '../pack/Pack';
import { finestChunkRes, gridOrigin } from './exposure';

/** recently used grid vertices' bump heights (key -> metres), so a track section's profile reuses its cells */
const CACHE_MAX = 64;

export class DrawnGround {
  private readonly cache = new Map<number, Map<number, number>>(); // res -> (cell key -> bump)
  private cacheSize = 0;
  private cacheScale = NaN;
  private cacheCreep = NaN;
  constructor(private readonly pack: Pack) {}

  /** Drawn bump minus exact bump at a point (m): 0 off the mogul fields. */
  bumpError(x: number, y: number): number {
    const pack = this.pack;
    if (!pack.moguls || pack.mogulScale <= 0 || !pack.meta?.terrain) return 0;
    const exact = pack.bumpAt(x, y);
    const res = finestChunkRes(pack, x, y);
    if (res > MOGUL_MAX_RES) return -exact; // drawn without bump geometry
    if (pack.mogulScale !== this.cacheScale || pack.mogulCreep !== this.cacheCreep) {
      this.cache.clear(); this.cacheSize = 0; this.cacheScale = pack.mogulScale; this.cacheCreep = pack.mogulCreep;
    }
    const [ox, oy] = gridOrigin(pack);
    const fi = (x - ox) / res, fj = (y - oy) / res, i = Math.floor(fi), j = Math.floor(fj), tx = fi - i, ty = fj - j;
    const v = (di: number, dj: number) => this.vertex(i + di, j + dj, ox, oy, res);
    const a = v(0, 0), d = v(1, 1);
    if (exact === 0 && a === 0 && d === 0 && v(1, 0) === 0 && v(0, 1) === 0) return 0;
    const drawn = tx >= ty ? a * (1 - tx) + v(1, 0) * (tx - ty) + d * ty : a * (1 - ty) + v(0, 1) * (ty - tx) + d * tx;
    return drawn - exact;
  }

  /** `Pack.groundHeight` with the bumps as drawn (a bridge deck above the snow is left as it is). */
  height(x: number, y: number, z?: number): number {
    const pack = this.pack, g = pack.groundHeight(x, y, z);
    if (pack.decks?.length && g !== pack.terrainHeight(x, y)) return g; // on a deck
    return g + this.bumpError(x, y);
  }

  /** Bump height at grid vertex (gi, gj); numeric keys so a lookup allocates nothing. */
  private vertex(gi: number, gj: number, ox: number, oy: number, res: number): number {
    let m = this.cache.get(res);
    if (!m) { m = new Map(); this.cache.set(res, m); }
    const key = (gi + 1048576) * 2097152 + (gj + 1048576);
    let h = m.get(key);
    if (h !== undefined) return h;
    h = this.pack.bumpAt(ox + gi * res, oy + gj * res);
    if (this.cacheSize >= CACHE_MAX) {
      for (const mm of this.cache.values()) {
        const k = mm.keys().next();
        if (!k.done) { mm.delete(k.value); this.cacheSize--; break; }
      }
    }
    m.set(key, h);
    this.cacheSize++;
    return h;
  }
}
