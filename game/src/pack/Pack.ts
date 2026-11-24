import { HeightSet } from './HeightSet';
import { MaskSet } from './MaskSet';
import { CoverSet } from './CoverSet';
import { CanopyGrid } from './CanopyGrid';
import type { BakedTreeLines, Features, PackMeta } from './types';
import { downhillFrom, mogulHeight, MOGUL_FALL_D } from '../terrain/Moguls';
import { TreeLines, TrunkIndex, LINE_MOGUL } from './treeLines';
import { packFetch } from './fetch';
import { loadStep } from '../core/loadSteps';

/** FEAT-333: tree cells fetched at once while the tree lines load */
const TRUNK_FETCHES = 8;
/** chunks at this resolution or finer carry the mogul bumps in their geometry */
export const MOGUL_MAX_RES = 2;
/** coarser chunks up to this resolution shade the same field in the terrain shader (seen from the lift) */
export const MOGUL_SHADE_MAX_RES = 16;

/** A straight bridge deck segment (pack metres). The surface runs from a to b at the given z. */
export interface Deck { ax: number; ay: number; az: number; bx: number; by: number; bz: number; hw: number }
const DECK_CELL = 32;

/**
 * A loaded resort pack: metadata, the height sets, the surface mask and features.
 * `height(x, y, res)` returns the best available height for a requested detail level,
 * falling back to coarser sets when the fine tiles are not loaded yet.
 */
export class Pack {
  readonly meta: PackMeta;
  readonly baseUrl: string;
  readonly fine: HeightSet | null;
  /** FEAT-229: 4 m over the fine area, for the 4 and 8 m chunks; null in older packs */
  readonly coarse: HeightSet | null;
  readonly mid: HeightSet | null;
  readonly far: HeightSet | null;
  readonly mask: MaskSet | null;
  /** sky visibility 0..1 in channel 0 (gullies and cliff feet darker); null in older packs */
  readonly ao: MaskSet | null;
  /** piste direction set (DATA-002), optional */
  readonly dir: MaskSet | null;
  /** FEAT-059: mogul amplitude 0..1 m in channel 0; null in older packs */
  readonly moguls: MaskSet | null;
  /** FEAT-153: forest cover levels for the terrain at a distance; null in older packs */
  readonly cover: CoverSet | null;
  /** FEAT-330: canopy score 0..1 overhead (the darkening in dense glades); null when the pack has none */
  readonly canopy: CanopyGrid | null;
  /** amplitude multiplier (new snow softens the bumps) and uphill creep in metres (season date) */
  mogulScale = 1;
  mogulCreep = 0;
  features: Features = { lifts: [], runs: [], buildings: [], roads: [], water: [], peaks: [], labels: [] };
  /** FEAT-333 / FEAT-303: the worn tree lines beside the black and glade runs and the glade trim, from the runs
   *  (pack/treeLines.ts); null without them (`?notreelines`) */
  treeLines: TreeLines | null = null;
  /** FEAT-216: the tree wells near the rider (world/TreeWells.ts), m <= 0; null: none */
  wells: { at(x: number, y: number): number } | null = null;

  private constructor(baseUrl: string, meta: PackMeta) {
    this.baseUrl = baseUrl;
    this.meta = meta;
    this.fine = meta.terrain.fine ? new HeightSet(`${baseUrl}/fine`, meta.terrain.fine) : null;
    this.coarse = meta.terrain.coarse ? new HeightSet(`${baseUrl}/coarse`, meta.terrain.coarse) : null;
    this.mid = meta.terrain.mid ? new HeightSet(`${baseUrl}/mid`, meta.terrain.mid) : null;
    this.far = meta.terrain.far ? new HeightSet(`${baseUrl}/far`, meta.terrain.far) : null;
    this.sets = [this.fine, this.coarse, this.mid, this.far].filter((s): s is HeightSet => !!s);
    this.mask = meta.mask ? new MaskSet(`${baseUrl}/mask`, meta.mask) : null;
    // BUG-087: the greyscale sets decode without the WebGL readback
    this.ao = meta.ao ? new MaskSet(`${baseUrl}/ao`, meta.ao, { opaque: true }) : null;
    this.dir = meta.dir ? new MaskSet(`${baseUrl}/dir`, meta.dir, { opaque: true }) : null;
    this.moguls = meta.moguls ? new MaskSet(`${baseUrl}/moguls`, meta.moguls, { opaque: true }) : null;
    this.cover = meta.cover && meta.cover.levels.length ? new CoverSet(baseUrl, meta.cover) : null;
    this.canopy = meta.canopy ? new CanopyGrid(baseUrl, meta.canopy) : null;
  }

  /** FEAT-330: canopy score 0..1 at pack (x, y); 0 without a grid, outside it, or before it loads */
  canopyAt(x: number, y: number): number { return this.canopy ? this.canopy.sample(x, y) : 0; }

  /** `treeLines` false: no FEAT-333 tree lines or FEAT-303 trim (`?notreelines`); `bakedTreeLines` false: plan them from
   *  the runs even when the pack has its own (FEAT-334, `?treelines=runs`) */
  static async load(baseUrl: string, opts: { treeLines?: boolean; bakedTreeLines?: boolean } = {}): Promise<Pack> {
    let t = performance.now();
    const resp = await packFetch(`${baseUrl}/meta.json`);
    if (!resp.ok) throw new Error(`Pack not found at ${baseUrl}/ (HTTP ${resp.status}). Run the Vite dev server (cd game && npm run dev) and open http://localhost:5173/?pack=<slug>; the pack folder must exist at packs/<slug>/ next to game/.`);
    const meta = (await resp.json()) as PackMeta;
    const pack = new Pack(baseUrl, meta);
    loadStep('pack meta', t); t = performance.now();
    try {
      pack.features = (await (await packFetch(`${baseUrl}/features.json`)).json()) as Features;
    } catch (e) {
      console.warn('no features.json', e);
    }
    loadStep('pack features', t); t = performance.now();
    if (opts.treeLines !== false) await pack.setTreeLines(true, opts.bakedTreeLines !== false);
    loadStep('tree lines', t);
    return pack;
  }

  /** Sets ordered finest first (FEAT-339: made once; every height read walks it) */
  readonly sets: HeightSet[];

  /**
   * FEAT-229: a chunk at `res` m or coarser leaves the fine set to the coarse one where that has data (the 4 and 8 m
   * chunks), so the ring looks the same whether or not fine tiles happen to be loaded under it.
   */
  private skipFine(s: HeightSet, x: number, y: number, res: number): boolean {
    const c = this.coarse;
    return s === this.fine && !!c && res >= c.meta.res && c.contains(x, y) && !Number.isNaN(c.sampleNearest(x, y));
  }

  /**
   * Height for rendering at a target resolution: use the finest loaded set whose resolution
   * is not much finer than needed (coarser sets are smoother and cheaper), fall back outward.
   * `bumps = false` leaves the mogul bumps out (BUG-062: the chunk builder wants the base surface for
   * its normals and adds the bumps to the positions itself).
   */
  height(x: number, y: number, res: number, bumps = true): number {
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      // skip sets that are far finer than needed (except when nothing else covers the point)
      if (s.meta.res * 16 < res && s !== this.sets[this.sets.length - 1]) continue;
      if (this.skipFine(s, x, y, res)) continue;
      const h = s.sample(x, y);
      if (Number.isNaN(h)) continue;
      // FEAT-333: the tree lines' trench is part of the ground the near chunks build (and take their normals from)
      const t = res <= MOGUL_MAX_RES ? this.trenchAt(x, y) : 0;
      this.lastTrench = t;
      const g = h + t;
      return bumps && res <= MOGUL_MAX_RES ? g + this.bumpAt(x, y) : g;
    }
    // the shading still reads the trench here (as it did before the cache), though the returned height leaves it out
    this.lastTrench = res <= MOGUL_MAX_RES ? this.trenchAt(x, y) : 0;
    // last resort: any set that has data
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) return h;
    }
    if (this.sets.some((s) => s.waiting(x, y))) this.waitingSamples++;
    return this.meta.zRange[0];
  }

  /** FEAT-339: the tree lines' trench the last height() call added, m (0 when it added none), so the chunk builder need
   *  not look it up again */
  lastTrench = 0;

  /**
   * BUG-088: count of height() calls that found no data yet because the tiles there are still to load (the
   * floor of the range stands in). The terrain diffs it per chunk build to know a chunk is not the real ground.
   */
  waitingSamples = 0;

  /**
   * Count of height reads during the rider's physics step that wanted a finer set (the point is inside it)
   * but had to use a coarser one because the tile was not loaded yet. Physics diffs it per step to warn.
   * BUG-100: only reads while `physicsSampling` is set count here; every other caller (the particle
   * light's shadow march, cameras, tracks, labels) goes to `otherFallbacks`, so this stays a clean
   * "physics rode a coarser set" count.
   */
  coarseFallbacks = 0;
  /** BUG-100: the same count for height reads outside the rider's physics step */
  otherFallbacks = 0;
  /** BUG-100: true while Rider.update runs its physics steps, so fallbacks count to `coarseFallbacks` */
  physicsSampling = false;

  /** Terrain height from the finest loaded set plus the tree lines' trench (FEAT-333), the mogul bumps and the tree wells
   *  (FEAT-216), ignoring bridges. Independent of render LOD. */
  terrainHeight(x: number, y: number): number {
    return this.baseHeight(x, y) + this.trenchAt(x, y) + this.bumpAt(x, y) + (this.wells ? this.wells.at(x, y) : 0);
  }

  setMoguls(scale: number, creepM: number): void {
    this.mogulScale = Math.max(0, Math.min(1, scale)); this.mogulCreep = creepM;
  }

  private readonly mogTmp = [0, 0, 0, 0];
  private readonly fallTmp = [1, 0];
  private readonly lineTmp = [0];

  /**
   * FEAT-059: mogul amplitude (m) at a point from the pack's moguls set; 0 without the set or its tile. FEAT-333: a
   * worn tree line is a mogul line too, as strong as it is worn (LINE_MOGUL at full), wherever the set is weaker.
   * FEAT-268: `line[0]` gets how much of the line's irregular pattern applies here (1 where the set has none, 0 off the
   * lines), for `bumpWith` and the terrain shader; pass it with the amplitude, never read it from a later call.
   */
  mogulAmp(x: number, y: number, raw = false, line: number[] = this.lineTmp): number {
    line[0] = 0;
    if (!raw && this.mogulScale <= 0) return 0;
    let a = this.moguls ? this.moguls.sampleBilinear(x, y, this.mogTmp)[0] : 0;
    if (this.treeLines) { const l = this.treeLines.wornAt(x, y) * LINE_MOGUL; if (l > a) { line[0] = 1 - a / l; a = l; } }
    return a * (raw ? 1 : this.mogulScale);
  }

  /** the shader and bump geometry carry moguls: the pack has a moguls set, or tree lines (FEAT-333) */
  get hasMoguls(): boolean { return !!this.moguls || !!this.treeLines; }

  /** FEAT-333: how far a tree line has dug the snow down here, m (negative; a little positive on its berm), 0 off them */
  trenchAt(x: number, y: number): number { return this.treeLines ? this.treeLines.trenchAt(x, y) : 0; }

  /** FEAT-333: 0..1 how worn the snow is by a tree line here (0 off them, and under no forest) */
  wornAt(x: number, y: number): number { return this.treeLines ? this.treeLines.wornAt(x, y) : 0; }

  /**
   * FEAT-333: build the tree lines from the runs (on), or drop them. The
   * lines bend round the pack's detected trunks, so this fetches the tree cells they cross first (the same files the
   * trees stream later, so the browser has them); the generated stems just leave the corridors. FEAT-334: a pack with
   * baked lines (`meta.treeLines`, traced from its terrain and already clear of its trunks) loads those instead and
   * fetches no tree cells, unless `baked` is false; a file that will not load falls back to the plan from the runs.
   */
  async setTreeLines(on: boolean, baked = true): Promise<void> {
    if (!on) { this.treeLines = null; return; }
    const t0 = performance.now();
    let file: BakedTreeLines | null = null;
    if (baked && this.meta.treeLines) {
      try {
        const r = await packFetch(`${this.baseUrl}/${this.meta.treeLines.file}`);
        if (r.ok) {
          const j = (await r.json()) as BakedTreeLines;
          if (j.version === 1 && Array.isArray(j.lines)) file = j;
          else console.warn(`tree lines: ${this.meta.treeLines.file} has an unknown shape or version, planning from the runs`);
        } else console.warn(`tree lines: ${this.meta.treeLines.file} HTTP ${r.status}, planning from the runs`);
      } catch (e) { console.warn(`tree lines: ${this.meta.treeLines.file} did not load, planning from the runs`, e); }
    }
    const tl = new TreeLines(this.features.runs, file);
    const inst = tl.baked ? undefined : this.meta.instances;
    let left = 0, trunkCount = 0, failed = 0, cells = 0;
    // the forest gate's cover levels load alongside the trunks (review on #770: a gate that changes after load moves the
    // ground under the rider)
    const coverReady = this.cover ? this.cover.ready : Promise.resolve();
    if (inst) {
      const listed = new Set(inst.treeCells ?? []), want = new Set<string>();
      for (const b of tl.planBoxes()) {
        for (let cy = Math.floor((b[1] - inst.minY) / inst.cellSize); cy <= Math.floor((b[3] - inst.minY) / inst.cellSize); cy++) {
          for (let cx = Math.floor((b[0] - inst.minX) / inst.cellSize); cx <= Math.floor((b[2] - inst.minX) / inst.cellSize); cx++) {
            const k = `${cx}_${cy}`;
            if (listed.has(k)) want.add(k);
          }
        }
      }
      // a bounded pool: TRUNK_FETCHES cells at a time, not every cell the lines cross at once
      const trunks = new TrunkIndex(), queue = [...want];
      cells = queue.length;
      const worker = async (): Promise<void> => {
        for (let k = queue.shift(); k !== undefined; k = queue.shift()) {
          try {
            const r = await packFetch(`${this.baseUrl}/trees/${k}.bin`);
            if (r.ok) trunks.add(new Float32Array(await r.arrayBuffer()), 6); else failed++;
          } catch { failed++; } // a cell that will not load: its trunks stay where the lines plan them (counted in the log)
        }
      };
      await Promise.all(Array.from({ length: Math.min(TRUNK_FETCHES, queue.length) }, worker));
      trunkCount = trunks.count;
      left = tl.avoid(trunks);
    }
    tl.finish();
    await coverReady;
    const gate = this.forestGate();
    if (!gate) {
      // BUG-159: no cover level to gate them by (a pack from before FEAT-153, or its levels failed to load). The 1 m mask's
      // canopy reads 0 until its tile loads, so a trench gated by it dropped in under the rider (BUG-158): no lines instead
      this.treeLines = null;
      console.warn('tree lines: off, the pack has no cover levels loaded to gate them by (the forest share)');
      return;
    }
    tl.setCanopy(gate);
    this.treeLines = tl;
    const fails = failed ? `, ${failed} of ${cells} tree cells failed to load (their trunks were not avoided)` : '';
    if (tl.baked) console.info(`tree lines: ${(tl.length / 1000).toFixed(0)} km baked in the pack (${tl.count} segments), ${(performance.now() - t0).toFixed(0)} ms`);
    else console.info(`tree lines: ${(tl.length / 1000).toFixed(0)} km, bent round ${trunkCount} trunks (${left} steps broken at a trunk${fails}), ${(performance.now() - t0).toFixed(0)} ms`);
    if (failed) console.warn(`tree lines: ${failed} of ${cells} tree cells failed to load`);
  }

  /**
   * FEAT-333: the forest the tree lines dig in, 0..1. From the pack's cover levels (forest share), which are loaded before
   * the lines count and never change, so the trench, its moguls and the physics are the same from the first frame (BUG-158:
   * the 1 m mask's canopy reads 0 until its tile loads, then the ground dropped a metre under a rider in a line). Null when
   * no cover level loaded: there is no gate that is fixed from load, so `setTreeLines` leaves the lines off (BUG-159).
   */
  private forestGate(): ((x: number, y: number) => number) | null {
    const cover = this.cover, tmp = [0, 0, 0, 0];
    return cover && cover.levels.some((l) => l.loaded) ? (x, y) => (cover.sample(x, y, tmp) > 0 ? tmp[0] : 0) : null;
  }

  /** FEAT-059: the bump height at a point: the field's amplitude here, aligned to the local fall line and
   *  sized by its slope (FEAT-147). */
  bumpAt(x: number, y: number): number {
    const a = this.mogulAmp(x, y, true, this.lineTmp);
    return this.bumpWith(x, y, a, null, this.lineTmp[0]);
  }

  /**
   * FEAT-339: `bumpAt` from the raw amplitude (`mogulAmp(x, y, true)`) the caller already has, and the fall line from
   * `fallAt` when it has that too (else null), so the chunk builder reads each once per vertex and gets the very numbers
   * the physics does. `line`: the `line[0]` that came with the amplitude (FEAT-268).
   */
  bumpWith(x: number, y: number, rawAmp: number, fall: number[] | null, line: number): number {
    if (this.mogulScale <= 0) return 0;
    const amp = rawAmp * this.mogulScale;
    if (amp < 0.005) return 0;
    const f = fall ?? this.fallAt(x, y, this.fallTmp);
    return mogulHeight(x, y, amp, f[0], f[1], this.mogulCreep, line);
  }

  /** FEAT-339: the mogul field's downhill vector here (pack east, north; its length the slope, FEAT-147), BUG-064's wide
   *  difference of the DEM MOGUL_FALL_D either side: what `bumpAt` aligns the bumps to, and the shader's fall line too */
  fallAt(x: number, y: number, out: number[]): number[] {
    return downhillFrom(this.baseFn, x, y, out, MOGUL_FALL_D);
  }

  private readonly baseFn = (x: number, y: number) => this.baseHeight(x, y);

  /** FEAT-171: DEM height from the finest loaded set, without the mogul bumps (slopes at a distance). */
  demHeight(x: number, y: number): number { return this.baseHeight(x, y); }

  /** DEM height from the finest loaded set, without bumps. */
  private baseHeight(x: number, y: number): number {
    let skipped = false;
    for (const s of this.sets) {
      if (!s.contains(x, y)) continue;
      const h = s.sample(x, y);
      if (!Number.isNaN(h)) {
        if (skipped) { if (this.physicsSampling) this.coarseFallbacks++; else this.otherFallbacks++; }
        return h;
      }
      skipped = true;
    }
    return this.meta.zRange[0];
  }

  /**
   * Best available height for physics: terrain, or a bridge deck above it. Pass the rider's z
   * so something well below a deck (in the gully under it) keeps the terrain.
   */
  groundHeight(x: number, y: number, z?: number): number {
    const t = this.terrainHeight(x, y);
    if (this.deckGrid.size === 0) return t;
    const d = this.deckHeight(x, y);
    if (d > t && (z === undefined || z > d - 2.5)) return d;
    return t;
  }

  private readonly deckGrid = new Map<string, Deck[]>();
  readonly decks: Deck[] = [];
  private deckHit: Deck | null = null;

  addDeck(d: Deck): void {
    this.decks.push(d);
    const pad = d.hw + 1;
    const x0 = Math.floor((Math.min(d.ax, d.bx) - pad) / DECK_CELL), x1 = Math.floor((Math.max(d.ax, d.bx) + pad) / DECK_CELL);
    const y0 = Math.floor((Math.min(d.ay, d.by) - pad) / DECK_CELL), y1 = Math.floor((Math.max(d.ay, d.by) + pad) / DECK_CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = `${cx},${cy}`;
      let a = this.deckGrid.get(k);
      if (!a) { a = []; this.deckGrid.set(k, a); }
      a.push(d);
    }
  }

  /** Highest deck surface over (x, y), or -Infinity. */
  deckHeight(x: number, y: number): number {
    const a = this.deckGrid.get(`${Math.floor(x / DECK_CELL)},${Math.floor(y / DECK_CELL)}`);
    this.deckHit = null;
    if (!a) return -Infinity;
    let best = -Infinity;
    for (const d of a) {
      const ex = d.bx - d.ax, ey = d.by - d.ay, l2 = ex * ex + ey * ey;
      const t = ((x - d.ax) * ex + (y - d.ay) * ey) / l2;
      if (t < 0 || t > 1) continue;
      const lat = Math.abs((x - d.ax) * ey - (y - d.ay) * ex) / Math.sqrt(l2);
      if (lat > d.hw) continue;
      const z = d.az + (d.bz - d.az) * t;
      if (z > best) { best = z; this.deckHit = d; }
    }
    return best;
  }

  /**
   * Finest resolution with data at this point (for normal estimation). With `res`, the one height() reads for a
   * chunk at that spacing (FEAT-229: the coarse set over fine for 4 and 8 m chunks).
   */
  finestRes(x: number, y: number, res = 0): number {
    for (const s of this.sets) {
      if (res > 0 && this.skipFine(s, x, y, res)) continue;
      if (s.contains(x, y) && !Number.isNaN(s.sampleNearest(x, y))) return s.meta.res;
    }
    return this.far?.meta.res ?? 128;
  }

  /** Ground normal from central differences at the finest loaded resolution. Returns [nx, ny, nz]. */
  groundNormal(x: number, y: number, out: Float32Array | number[] = [0, 0, 1], z?: number): typeof out {
    if (this.deckGrid.size) {
      // on a deck: its own plane, so the gully beside it does not tilt the rider
      const dz = this.deckHeight(x, y), k = this.deckHit;
      if (k && dz > this.terrainHeight(x, y) && (z === undefined || z > dz - 2.5)) {
        const ex = k.bx - k.ax, ey = k.by - k.ay, l2 = ex * ex + ey * ey, g = (k.bz - k.az) / l2;
        const nx = -g * ex, ny = -g * ey, len = Math.hypot(nx, ny, 1);
        out[0] = nx / len; out[1] = ny / len; out[2] = 1 / len;
        return out;
      }
    }
    const d = Math.max(0.5, this.finestRes(x, y));
    const hl = this.terrainHeight(x - d, y), hr = this.terrainHeight(x + d, y);
    const hd = this.terrainHeight(x, y - d), hu = this.terrainHeight(x, y + d);
    let nx = -(hr - hl) / (2 * d), ny = -(hu - hd) / (2 * d), nz = 1;
    const len = Math.hypot(nx, ny, nz);
    out[0] = nx / len; out[1] = ny / len; out[2] = nz / len;
    return out;
  }
}
