import type { BakedTreeLines, RunFeature } from './types';

/**
 * FEAT-333: worn tree lines, and FEAT-303: trimmed glade trees, from the pack's runs alone (no new data).
 *
 * Tree lines: beside every black run (advanced, expert, freeride, extreme) and every gladed run, riders, patrol
 * and animals wear narrow corridors down through the forest. Seeds sit every SEED_STEP m along the run, each on
 * one side at an offset that favours the run's edge (most within about 60 m, a few out to OFF_MAX), and walk
 * down beside it: the heading is the run's own downhill direction (from its points' heights, so the paths need
 * no terrain tiles and are the same on every load) swung by a slow meander, held near the seed's offset. Now and
 * then a line forks: the branch swings out a few metres and comes back to its parent's line (split and rejoin).
 * A line is 1.5 to 3 m wide, wider and stronger near the run, and fades out at its ends and deeper in the woods.
 *
 * What reads it: the generated stems leave the corridor (trees/stands.ts), the mogul field takes the line's
 * strength as its amplitude (Pack.mogulAmp, so the physics, the bump geometry and the shader agree: on a steep
 * pitch it is a mogul line), the snow on it is tracked (SnowConditions, `worn`), and the terrain draws ski
 * tracks along it (TerrainMaterial). All of that only under the forest (`gate`, Pack.forestGate): beside a run
 * in the open there is no tree line to wear.
 *
 * Trim (FEAT-303): how far a tree's lower branches are worn back (0 untouched .. 1 trimmed), for the tree
 * kit's shader: full in the trees of a gladed or expert run, half along a black run's edges, most of it in the strips of forest between two runs, and round the
 * tree lines; nothing in the deep forest away from the runs. Sampled on an 8 m grid per 256 m tile, made on
 * first use.
 *
 * Baked lines (FEAT-334): a pack with `treeLines.json` (MapPacker pipeline/tree_lines.py) carries lines traced from its own
 * terrain and trunks: riders walked down a cost field from the fall line, merging in gullies and funnelling at the flats.
 * Those replace the plan above (`baked`), already clear of the detected trunks, so `avoid` has nothing to do; everything
 * downstream (trench, berm, moguls, worn snow, stems, trim) is the same. `?treelines=runs` plans from the runs anyway.
 *
 * All pack metres (x east, y north). Pure: same runs, same lines.
 */

/** the runs that get tree lines beside them */
const LINE_DIFF = new Set(['advanced', 'expert', 'freeride', 'extreme']);
/** m along the run between seeds: an advanced run, and the tree runs (gladed, expert, freeride, extreme), which get more
 *  lines (3 or 4 deep ones across the trees beside Steep and Deep) */
const SEED_STEP = 45, SEED_STEP_TREES = 28;
/**
 * The entrances at the top of a tree run: ENTRY_LINES lines starting ENTRY_S0 + ENTRY_DS x i m down it, ENTRY_OFF to 2 m
 * more off its centreline (its edge), which peel off toward ENTRY_OUT + ENTRY_OUT_RANGE u m out, alternating sides
 */
const ENTRY_LINES = 3, ENTRY_S0 = 4, ENTRY_DS = 10, ENTRY_OFF = 5, ENTRY_OUT = 14, ENTRY_OUT_RANGE = 28;
/** the tree runs: their lines fork more (braids) */
const TREE_RUN = new Set(['expert', 'freeride', 'extreme']);
/** a seed's offset from the run's centreline, m: OFF_MIN + (OFF_MAX - OFF_MIN) u^2 (most near the edge) */
const OFF_MIN = 12, OFF_MAX = 140;
/** a line's length, m: LEN_MIN + LEN_RANGE u */
const LEN_MIN = 120, LEN_RANGE = 260;
/** walk step, m */
const STEP = 3;
/** the meander: the heading swings up to MEANDER rad off the run's direction, over about MEANDER_L m */
const MEANDER = 0.5, MEANDER_L = 35;
/**
 * Fan out, funnel in (research doc, Drew 2026-11-17): on the steep part riders spread across the trees; where the run
 * flattens out (a runout, like Steep and Deep into Lower Pete's Bowl) nobody wants to bog down and the lines collapse
 * toward the run's edge into one trench. A line's offset scales by FUNNEL_MIN at a pitch of FLAT_TAN and less, fully
 * itself from STEEP_TAN, the pitch read from the run's own point heights over PITCH_SPAN m.
 */
const FUNNEL_MIN = 0.3, FLAT_TAN = 0.2, STEEP_TAN = 0.36, PITCH_SPAN = 60;
/** a line's width wanders along it by +-WIDTH_VAR over about WIDTH_L m (the research doc's 30 % over 25 m) */
const WIDTH_VAR = 0.3, WIDTH_L = 25;
/** an entrance line ignores the forest gate for its first ENTRY_OPEN m, so its trench starts at the cat track */
const ENTRY_OPEN = 70;
/** pull back toward the line's own offset, rad per m of drift (and the most it turns by) */
const PULL = 0.05, PULL_MAX = 0.6, PULL_IN = 0.3;
/** never closer to the run's centreline than this, m */
const KEEP_OUT = 9;
/**
 * The braids: chance per 3 m step of a fork (beside an advanced run, beside a tree run: about 0.4 and 1 per 100 m of
 * descent), how far a branch swings out from its parent's line at its widest (m), its length (m: FORK_LEN + FORK_LEN_RANGE u),
 * the share that weave across the parent and back (two runs intertwining) rather than split and rejoin, and a branch's
 * strength against its parent's (shallower and narrower: less traffic). Values from a research pass (2026-11-17): no
 * measured glade statistics exist; these follow tree-clump sizes, trail braiding and mogul wavelengths (PR #770).
 */
const FORK_P = 0.012, FORK_P_TREES = 0.03, FORK_OUT = 4, FORK_OUT_RANGE = 6, FORK_LEN = 25, FORK_LEN_RANGE = 40;
const FORK_WEAVE = 0.25, FORK_STR = 0.6, FORK_FADE = 8;
/** lines fade in over the first FADE_IN m and out over the last FADE_OUT m */
const FADE_IN = 12, FADE_OUT = 45;
/** corridor half-width at full strength and at the faintest, m */
const HW_NEAR = 1.7, HW_FAR = 0.9;
/** the corridor's soft edge past its half-width, m */
const EDGE = 0.9;
/** a generated stem planned in a trench moves out to this far past its rim, m, plus a seeded 0 to STEM_JITTER m (`placeStem`) */
const STEM_GAP = 0.15, STEM_JITTER = 0.6;
/** a line fainter than this (its trench under 5 cm) leaves the stems where they are */
const STEM_FAINT = 0.05;
/** mogul amplitude (0..1) at a line's full strength, and the share of a full-strength line's snow that is tracked */
export const LINE_MOGUL = 0.85;
/** the trench a full-strength line wears into the snow, m deep, how far its rim is past the corridor's half-width, m, and
 *  the berm of pushed-aside snow on the rim, m high and wide (`trenchAt`) */
export const TRENCH_DEPTH = 1.0;
/** the forest (cover levels' share, or the mask's canopy) over which a line fades in: inside the trees, not on the open face
 *  beside a forest's edge */
const CANOPY_LO = 0.3, CANOPY_HI = 0.55;
const TRENCH_WALL = 1.1, BERM_H = 0.15, BERM_W = 1.2;
const LINE_SEG = 6; // floats per segment: ax, ay, bx, by, half-width, strength
const GRID = 16; // m: the segment grid
/** trim: a glade's level within GLADE_FULL m of its run's centreline, none past GLADE_NONE */
const GLADE_FULL = 45, GLADE_NONE = 75;
/** the glade level of a run that is not tagged gladed, by difficulty: the tree runs are the experts' (Steep and Deep is
 *  `expert` in OSM, not gladed); a black run's edges are half ridden */
const GLADE_LEVEL: Record<string, number> = { expert: 1, freeride: 1, extreme: 1, advanced: 0.55 };
/** trim between two runs: a strip of forest narrower than STRIP_FULL m (centreline to centreline) gets STRIP_K, none past STRIP_NONE */
const STRIP_FULL = 110, STRIP_NONE = 170, STRIP_K = 0.7;
/** trim round a tree line: LINE_TRIM within LINE_NEAR m of its centre, none past LINE_FAR */
const LINE_NEAR = 6, LINE_FAR = 22, LINE_TRIM = 1;
const TRIM_TILE = 256, TRIM_RES = 8, TRIM_N = TRIM_TILE / TRIM_RES + 1;
/**
 * FEAT-335: the near index. Each segment grid cell is split, on first use, into SUB m sub-cells, each listing only the
 * segments whose trench reach (half-width, wall and berm) comes within SUB_PAD of its centre, so it may touch it: `trenchAt`
 * and `wornAt` loop over those few (usually 0 to 3, against about 16 in the whole cell) and give the same answers.
 */
const SUB = 2, SUBS = GRID / SUB, SUB_PAD = SUB * Math.SQRT1_2;
/** cells kept in the near index (about 0.9 kB each on Vail, so up to about 14 MB), the oldest dropped first */
const SUB_CAP = 16384;

/** integer hash to 0..1 */
function h01(a: number, b: number, c: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 0x1000000;
}
/** 1D value noise in -1..1 */
function noise1(t: number, a: number, b: number): number {
  const i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f);
  return 2 * (h01(a, b, i) * (1 - s) + h01(a, b, i + 1) * s) - 1;
}
const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** squared distance from (px, py) to segment a-b */
function segD2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

/** a run's centreline, downhill first to last, with its cumulative length */
interface Line { x: Float64Array; y: Float64Array; z: Float64Array; s: Float64Array; len: number }
function runLine(r: RunFeature): Line | null {
  let p = r.points;
  if (p.length < 2) return null;
  if (p[0][2] < p[p.length - 1][2]) p = p.slice().reverse();
  const n = p.length, x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = p[i][0]; y[i] = p[i][1]; z[i] = p[i][2]; if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]); }
  return s[n - 1] > 20 ? { x, y, z, s, len: s[n - 1] } : null;
}

/** the run's pitch (rise over run, downhill positive) round arc length s, over PITCH_SPAN m of its points */
function pitchAt(l: Line, s: number): number {
  const zAt = (q: number): number => {
    q = Math.max(0, Math.min(l.len, q));
    let i = 0;
    while (i + 2 < l.s.length && l.s[i + 1] < q) i++;
    const sl = l.s[i + 1] - l.s[i] || 1, t = Math.min(1, Math.max(0, (q - l.s[i]) / sl));
    return l.z[i] + (l.z[i + 1] - l.z[i]) * t;
  };
  const a = Math.max(0, s - PITCH_SPAN / 2), b = Math.min(l.len, s + PITCH_SPAN / 2);
  return b - a > 1 ? (zAt(a) - zAt(b)) / (b - a) : 0;
}

/** where a point sits against a run line: its arc length along it, the signed offset (+ left of downhill) and the unit tangent */
const PROJ = { s: 0, lat: 0, tx: 1, ty: 0 };
function project(l: Line, px: number, py: number): typeof PROJ {
  let best = Infinity;
  for (let i = 0; i + 1 < l.x.length; i++) {
    const ax = l.x[i], ay = l.y[i], dx = l.x[i + 1] - ax, dy = l.y[i + 1] - ay, l2 = dx * dx + dy * dy;
    if (l2 <= 0) continue;
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + dx * t), ey = py - (ay + dy * t), d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      const sl = Math.sqrt(l2);
      PROJ.s = l.s[i] + t * sl; PROJ.tx = dx / sl; PROJ.ty = dy / sl;
      PROJ.lat = PROJ.tx * ey - PROJ.ty * ex;
    }
  }
  return PROJ;
}

/** the point and tangent at arc length s along a run line */
function along(l: Line, s: number, out: number[]): void {
  let i = 0;
  while (i + 2 < l.s.length && l.s[i + 1] < s) i++;
  const sl = l.s[i + 1] - l.s[i] || 1, t = Math.min(1, Math.max(0, (s - l.s[i]) / sl));
  const tx = (l.x[i + 1] - l.x[i]) / sl, ty = (l.y[i + 1] - l.y[i]) / sl;
  out[0] = l.x[i] + (l.x[i + 1] - l.x[i]) * t; out[1] = l.y[i] + (l.y[i + 1] - l.y[i]) * t; out[2] = tx; out[3] = ty;
}

/** a spatial grid of segments (GRID m cells), each segment in every cell its padded box touches */
class SegGrid {
  readonly cells = new Map<number, number[]>();
  add(id: number, ax: number, ay: number, bx: number, by: number, pad: number): void {
    const x0 = Math.floor((Math.min(ax, bx) - pad) / GRID), x1 = Math.floor((Math.max(ax, bx) + pad) / GRID);
    const y0 = Math.floor((Math.min(ay, by) - pad) / GRID), y1 = Math.floor((Math.max(ay, by) + pad) / GRID);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const k = cy * 100003 + cx;
      const a = this.cells.get(k);
      if (a) a.push(id); else this.cells.set(k, [id]);
    }
  }
  at(x: number, y: number): number[] | undefined { return this.cells.get(Math.floor(y / GRID) * 100003 + Math.floor(x / GRID)); }
}

/** the forest under a point, 0..1 (the pack's cover levels, or the mask's canopy), for `gate` */
export type CanopyAt = (x: number, y: number) => number;

/** one planned line: its points every STEP m, its strength at each (fades included) and its half-width */
interface Plan {
  x: number[]; y: number[]; str: number[]; hw: number;
  /** per point: the half-width (wandering along the line, narrowed by `avoid` where it squeezes past a trunk) */
  w: number[];
  /** per point: 1 where the forest gate does not apply (an entrance line's first ENTRY_OPEN m) */
  open: number[];
}

/** detected trunks (the pack's own trees), for the lines to bend round: x, y pairs in a 4 m grid */
export class TrunkIndex {
  private readonly cells = new Map<number, number[]>();
  count = 0;
  /** adds every record of `xy` (x, y first, `stride` floats each) */
  add(xy: ArrayLike<number>, stride: number): void {
    for (let i = 0; i + 1 < xy.length; i += stride) {
      const x = xy[i], y = xy[i + 1], k = Math.floor(y / 4) * 100003 + Math.floor(x / 4);
      const a = this.cells.get(k);
      if (a) a.push(x, y); else this.cells.set(k, [x, y]);
      this.count++;
    }
  }
  /** calls `f` with every trunk within r m of (x, y) */
  near(x: number, y: number, r: number, f: (tx: number, ty: number) => void): void {
    for (let cy = Math.floor((y - r) / 4); cy <= Math.floor((y + r) / 4); cy++) for (let cx = Math.floor((x - r) / 4); cx <= Math.floor((x + r) / 4); cx++) {
      const a = this.cells.get(cy * 100003 + cx);
      if (!a) continue;
      for (let i = 0; i < a.length; i += 2) if ((a[i] - x) ** 2 + (a[i + 1] - y) ** 2 < r * r) f(a[i], a[i + 1]);
    }
  }
}

/** how far a line may bend off its plan to pass a trunk, m, and over how many points either side a bend eases in */
const BEND_MAX = 5, BEND_EASE = 5;
/** a detected trunk keeps this far out of a corridor (past its half-width, m: outside the trench's rim, so no trunk stands
 *  in a wall); where no bend gets it there the corridor narrows to pass, down to SQUEEZE_HW */
const TRUNK_CLEAR = TRENCH_WALL, SQUEEZE_HW = 0.5;
/** steps (3 m each) either side of a break over which the line fades to nothing, so its trench ramps out */
const RAMP_STEPS = 3;

export class TreeLines {
  /** the corridors' segments, LINE_SEG floats each (empty until `finish`) */
  seg = new Float32Array(0);
  /** per segment: 1 where the forest gate does not apply (an entrance line leaving the cat track) */
  open = new Uint8Array(0);
  count = 0;
  /** total length of the lines, m (for the log and the checks) */
  length = 0;
  /** the planned lines, until `finish` */
  private plans: Plan[] = [];
  /** the fork chance per step for the run being planned */
  private forkP = FORK_P;
  private readonly grid = new SegGrid();
  /** every run's centreline segments, for the trim: ax, ay, bx, by, run index, glade level (GLADE_LEVEL) */
  private readonly runSeg: Float32Array;
  private readonly runGrid = new Map<number, number[]>();
  private readonly trimTiles = new Map<number, Float32Array>();
  private canopy: CanopyAt | null = null;
  /** FEAT-335: the near index per segment grid cell: sub-cell t lists ids[start[t] .. start[t + 1]) */
  private readonly subs = new Map<number, { start: Uint16Array; ids: Int32Array }>();
  /** FEAT-335: grid cells indexed so far (the checks) */
  subsMade = 0;

  /** true when the lines came from the pack (FEAT-334), already clear of its trunks */
  readonly baked: boolean;

  /** plans the lines from the runs, or takes the pack's `baked` ones (FEAT-334); `finish` (after `avoid`, when the pack
   *  has its trees) makes them count. The trim reads the runs either way. */
  constructor(runs: RunFeature[], baked?: BakedTreeLines | null) {
    this.baked = !!baked;
    if (baked) this.takeBaked(baked); else this.planRuns(runs);
    // the runs for the trim (all of them: a strip between any two runs is ridden)
    const rs: number[] = [];
    runs.forEach((r, ri) => {
      const p = r.points;
      const g = r.gladed ? 1 : GLADE_LEVEL[r.difficulty ?? ''] ?? 0;
      for (let i = 0; i + 1 < p.length; i++) rs.push(p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], ri, g);
    });
    this.runSeg = new Float32Array(rs);
    const T = TRIM_TILE;
    for (let i = 0; i < rs.length / 6; i++) {
      const o = i * 6, pad = STRIP_NONE;
      const x0 = Math.floor((Math.min(rs[o], rs[o + 2]) - pad) / T), x1 = Math.floor((Math.max(rs[o], rs[o + 2]) + pad) / T);
      const y0 = Math.floor((Math.min(rs[o + 1], rs[o + 3]) - pad) / T), y1 = Math.floor((Math.max(rs[o + 1], rs[o + 3]) + pad) / T);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const key = cy * 100003 + cx, a = this.runGrid.get(key);
        if (a) a.push(i); else this.runGrid.set(key, [i]);
      }
    }
  }

  /** FEAT-334: the pack's lines as plans: x, y, half-width, strength per point; `open` m from the start ungated */
  private takeBaked(b: BakedTreeLines): void {
    for (const ln of b.lines) {
      const p = ln.p, n = Math.floor(p.length / 4);
      if (n < 2) continue;
      const plan: Plan = { x: [], y: [], str: [], hw: 0, w: [], open: [] };
      let s = 0;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (i) s += Math.hypot(p[o] - p[o - 4], p[o + 1] - p[o - 3]);
        plan.x.push(p[o]); plan.y.push(p[o + 1]); plan.w.push(p[o + 2]); plan.str.push(p[o + 3]);
        plan.open.push(ln.open && s < ln.open ? 1 : 0);
        plan.hw = Math.max(plan.hw, p[o + 2]);
      }
      this.plans.push(plan);
    }
  }

  /** FEAT-333: the lines planned from the runs alone */
  private planRuns(runs: RunFeature[]): void {
    const pt = [0, 0, 0, 0];
    runs.forEach((r, ri) => {
      if (!(r.gladed || (r.difficulty && LINE_DIFF.has(r.difficulty)))) return;
      const l = runLine(r);
      if (!l) return;
      const trees = r.gladed || TREE_RUN.has(r.difficulty ?? ''), step = trees ? SEED_STEP_TREES : SEED_STEP;
      this.forkP = trees ? FORK_P_TREES : FORK_P;
      for (let k = 0, s0 = step * 0.5; s0 < l.len - 30; k++, s0 += step) {
        const side = h01(ri, k, 1) < 0.5 ? -1 : 1;
        const u = h01(ri, k, 2), off = OFF_MIN + (OFF_MAX - OFF_MIN) * u * u;
        const str = 1 - 0.6 * smooth(40, OFF_MAX, off);
        along(l, s0, pt);
        // left of downhill is (-ty, tx)
        const sx = pt[0] - pt[3] * off * side, sy = pt[1] + pt[2] * off * side;
        this.walk(l, ri, k, sx, sy, side * off, str, LEN_MIN + LEN_RANGE * h01(ri, k, 3), 0);
      }
      // the entrances: beside a tree run, lines that start at its top, right at its edge where it leaves the cat track or
      // the run above, and peel off into the trees (each fades in from the surface, so the rider drops in naturally)
      if (trees) for (let e = 0; e < ENTRY_LINES; e++) {
        const k = 1000 + e, side = (e + (h01(ri, k, 1) < 0.5 ? 0 : 1)) % 2 ? 1 : -1;
        along(l, ENTRY_S0 + ENTRY_DS * e, pt);
        const off0 = ENTRY_OFF + 2 * h01(ri, k, 2), target = ENTRY_OUT + ENTRY_OUT_RANGE * h01(ri, k, 12);
        const sx = pt[0] - pt[3] * off0 * side, sy = pt[1] + pt[2] * off0 * side;
        this.walk(l, ri, k, sx, sy, side * target, 1, LEN_MIN + LEN_RANGE * h01(ri, k, 3), 0, ENTRY_OPEN);
      }
    });
  }

  /** the planned lines' points as [minX, minY, maxX, maxY] boxes, one per line, for fetching the trees they cross */
  planBoxes(): number[][] {
    return this.plans.map((p) => {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.x.length; i++) { b[0] = Math.min(b[0], p.x[i]); b[1] = Math.min(b[1], p.y[i]); b[2] = Math.max(b[2], p.x[i]); b[3] = Math.max(b[3], p.y[i]); }
      return b;
    });
  }

  /**
   * Bends each planned line round the detected trunks in its way: a point with a trunk closer than the corridor's
   * clearance moves sideways off it (away from the side the trunk is on, the least move), easing in over BEND_EASE
   * points either side, at most BEND_MAX m; a few passes, since a bend can meet the next trunk. Where a trunk is still
   * too close the corridor narrows to squeeze past it (down to SQUEEZE_HW), and where even that hits one the line breaks
   * for that step. Returns how many steps broke.
   */
  avoid(trunks: TrunkIndex): number {
    let left = 0;
    for (const p of this.plans) {
      const n = p.x.length;
      if (n < 2) continue;
      // the plan's own normal at each point (left of its direction)
      const nx = new Float64Array(n), ny = new Float64Array(n), off = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dx = p.x[b] - p.x[a], dy = p.y[b] - p.y[a], l = Math.hypot(dx, dy) || 1;
        nx[i] = -dy / l; ny[i] = dx / l;
      }
      const need = new Float64Array(n), add = new Float64Array(n);
      for (let pass = 0; pass < 10; pass++) {
        need.fill(0);
        let any = false;
        for (let i = 0; i < n; i++) {
          if (p.str[i] < 0.15) continue; // a faint end: the woods close in anyway
          const px = p.x[i] + nx[i] * off[i], py = p.y[i] + ny[i] * off[i], R = p.w[i] + TRUNK_CLEAR;
          let lo = 0, hi = 0; // the moves the trunks on each side ask for (lo toward -normal, hi toward +normal)
          trunks.near(px, py, R + STEP, (tx, ty) => {
            const lat = (tx - px) * nx[i] + (ty - py) * ny[i];
            const alongD = (tx - px) * ny[i] - (ty - py) * nx[i];
            if (Math.abs(alongD) > STEP * 0.6 || Math.abs(lat) >= R) return;
            if (lat >= 0) lo = Math.min(lo, lat - R); else hi = Math.max(hi, lat + R);
          });
          if (lo === 0 && hi === 0) continue;
          // trunks on one side: move away; on both: the smaller move (a gap too narrow stays in the count)
          need[i] = lo === 0 ? hi : hi === 0 ? lo : (-lo < hi ? lo : hi);
          any = true;
        }
        if (!any) break;
        // ease each move in over the points round it, keeping the biggest asked of each point
        add.fill(0);
        for (let i = 0; i < n; i++) {
          if (need[i] === 0) continue;
          for (let j = Math.max(0, i - BEND_EASE); j <= Math.min(n - 1, i + BEND_EASE); j++) {
            const w = 1 - Math.abs(i - j) / (BEND_EASE + 1), c = need[i] * w * w * (3 - 2 * w);
            if (Math.abs(c) > Math.abs(add[j])) add[j] = c;
          }
        }
        for (let i = 0; i < n; i++) off[i] = Math.max(-BEND_MAX, Math.min(BEND_MAX, off[i] + add[i] * 1.05));
      }
      for (let i = 0; i < n; i++) { p.x[i] += nx[i] * off[i]; p.y[i] += ny[i] * off[i]; }
      // squeeze past what is still too close: the segment narrows so the trunk keeps TRUNK_CLEAR out of it
      const w = p.w;
      // (the faint ends too: they are dug a little)
      const broke: number[] = [];
      for (let i = 0; i + 1 < n; i++) {
        if (p.str[i] <= 0.02) continue;
        const ax = p.x[i], ay = p.y[i], bx = p.x[i + 1], by = p.y[i + 1];
        // round the segment's middle, as far as its own half length (a bend can stretch a step well past STEP)
        const mx = (ax + bx) / 2, my = (ay + by) / 2, half = Math.hypot(bx - ax, by - ay) / 2, R = w[i] + TRUNK_CLEAR;
        trunks.near(mx, my, R + half, (tx, ty) => {
          const d = Math.sqrt(segD2(tx, ty, ax, ay, bx, by));
          if (d < R) w[i] = Math.min(w[i], Math.max(SQUEEZE_HW, d - TRUNK_CLEAR));
        });
        // a gap narrower than a squeezed trench, rim to rim: the line breaks there for a step (the rider picks round the trunk)
        const rim = w[i] + TRUNK_CLEAR;
        let blocked = false;
        trunks.near(mx, my, rim + half, (tx, ty) => { if (segD2(tx, ty, ax, ay, bx, by) < rim * rim) blocked = true; });
        if (blocked) { p.str[i] = 0; broke.push(i); left++; }
      }
      // the trench climbs out to the snow's surface over the steps either side of a break, not a wall across it
      for (const i of broke) for (let k = 1; k <= RAMP_STEPS; k++) {
        const f = k / (RAMP_STEPS + 1);
        if (i - k >= 0) p.str[i - k] = Math.min(p.str[i - k], f);
        if (i + k < n - 1) p.str[i + k] = Math.min(p.str[i + k], f);
      }
    }
    return left;
  }

  /** makes the planned lines count: their segments and the grid the queries use */
  finish(): void {
    const out: number[] = [], open: number[] = [];
    for (const p of this.plans) {
      for (let i = 0; i + 1 < p.x.length; i++) if (p.str[i] > 0.02) { out.push(p.x[i], p.y[i], p.x[i + 1], p.y[i + 1], p.w[i], p.str[i]); open.push(p.open[i]); }
    }
    this.plans = [];
    this.seg = new Float32Array(out);
    this.open = Uint8Array.from(open);
    this.count = out.length / LINE_SEG;
    let len = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * LINE_SEG;
      len += Math.hypot(this.seg[o + 2] - this.seg[o], this.seg[o + 3] - this.seg[o + 1]);
      this.grid.add(i, this.seg[o], this.seg[o + 1], this.seg[o + 2], this.seg[o + 3], this.seg[o + 4] + EDGE + TRENCH_WALL + BERM_W);
    }
    this.length = len;
    this.trimTiles.clear(); this.subs.clear(); this.lastKey = NaN;
  }

  /** the forest the lines are gated by (`Pack.forestGate`); without one they count everywhere */
  setCanopy(c: CanopyAt | null): void { this.canopy = c; }

  /** FEAT-335: the segments that may reach (x, y), as `ids[qA .. qB)` in `qIds` (empty when none) */
  private nearIds(x: number, y: number): void {
    const gx = Math.floor(x / GRID), gy = Math.floor(y / GRID), key = gy * 100003 + gx;
    // the terrain walks its vertices along rows, so the last cell is usually the one asked again
    let e = key === this.lastKey ? this.lastSub : this.subs.get(key);
    if (e === undefined) {
      const ids = this.grid.cells.get(key);
      if (ids) {
        if (this.subs.size >= SUB_CAP) this.subs.delete(this.subs.keys().next().value!);
        e = this.indexCell(gx, gy, ids); this.subs.set(key, e);
      } else e = null;
    }
    this.lastKey = key; this.lastSub = e;
    if (e === null) { this.qA = this.qB = 0; return; }
    const sx = Math.min(SUBS - 1, Math.floor((x - gx * GRID) / SUB)), sy = Math.min(SUBS - 1, Math.floor((y - gy * GRID) / SUB)), t = sy * SUBS + sx;
    this.qIds = e.ids; this.qA = e.start[t]; this.qB = e.start[t + 1];
  }
  private qIds: Int32Array = new Int32Array(0);
  private lastKey = NaN;
  private lastSub: { start: Uint16Array; ids: Int32Array } | null | undefined = undefined;
  /** the segments near (x, y) into `qIds[qA .. qB)`: the near index, or every one in the grid cell inside `withoutIndex` */
  private near(x: number, y: number): void {
    if (!this.full) { this.nearIds(x, y); return; }
    const ids = this.grid.at(x, y);
    this.qIds = ids ? Int32Array.from(ids) : new Int32Array(0); this.qA = 0; this.qB = this.qIds.length;
  }
  private qA = 0;
  private qB = 0;

  /** FEAT-335: grid cell (gx, gy)'s near index from its segments (`ids`) */
  private indexCell(gx: number, gy: number, ids: number[]): { start: Uint16Array; ids: Int32Array } {
    const s = this.seg, n = SUBS * SUBS, start = new Uint16Array(n + 1);
    // (sub-cell, segment) pairs into the scratch, counted per sub-cell, then laid out by sub-cell
    let pairs = this.pairBuf, np = 0;
    for (const i of ids) {
      const o = i * LINE_SEG, r = s[o + 4] + TRENCH_WALL + BERM_W + SUB_PAD;
      const i0 = Math.max(0, Math.floor((Math.min(s[o], s[o + 2]) - r - gx * GRID) / SUB)), i1 = Math.min(SUBS - 1, Math.floor((Math.max(s[o], s[o + 2]) + r - gx * GRID) / SUB));
      const j0 = Math.max(0, Math.floor((Math.min(s[o + 1], s[o + 3]) - r - gy * GRID) / SUB)), j1 = Math.min(SUBS - 1, Math.floor((Math.max(s[o + 1], s[o + 3]) + r - gy * GRID) / SUB));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
        if (segD2(gx * GRID + (k + 0.5) * SUB, gy * GRID + (j + 0.5) * SUB, s[o], s[o + 1], s[o + 2], s[o + 3]) >= r * r) continue;
        if (np + 2 > pairs.length) { const g = new Int32Array(pairs.length * 2); g.set(pairs); pairs = this.pairBuf = g; }
        const t = j * SUBS + k;
        pairs[np++] = t; pairs[np++] = i; start[t + 1]++;
      }
    }
    for (let t = 0; t < n; t++) start[t + 1] += start[t];
    const flat = new Int32Array(np >> 1), fill = this.fillBuf;
    fill.set(start.subarray(0, n));
    for (let q = 0; q < np; q += 2) flat[fill[pairs[q]]++] = pairs[q + 1];
    this.subsMade++;
    return { start, ids: flat };
  }
  private pairBuf = new Int32Array(1024);
  private readonly fillBuf = new Uint16Array(SUBS * SUBS);

  /** plans one line from (x, y): `latT` is the offset (signed, m) it keeps near, `depth` 1 for a fork's branch */
  private walk(l: Line, ri: number, k: number, x: number, y: number, latT: number, str: number, len: number, depth: number, openM = 0): void {
    const salt = ri * 7919 + k * 31 + depth * 7;
    const plan: Plan = { x: [], y: [], str: [], hw: HW_FAR + (HW_NEAR - HW_FAR) * str * (0.7 + 0.3 * h01(ri, k, 4 + depth)), w: [], open: [] };
    this.plans.push(plan);
    // a branch keeps near its parent's offset plus a swing: half a sine (out and back: a split) or a whole one (across the
    // parent's line and back: two runs intertwining), so both ends meet the parent
    const base = latT, swing = depth ? (h01(ri, k, 9) < 0.5 ? -1 : 1) * (FORK_OUT + FORK_OUT_RANGE * h01(ri, k, 10)) : 0;
    const waves = h01(ri, k, 11) < FORK_WEAVE ? 2 : 1;
    // a branch meets its parent at both ends, so it only fades over a few metres (a line fades in and out of the woods)
    const fadeIn = depth ? FORK_FADE : FADE_IN, fadeOut = depth ? FORK_FADE : FADE_OUT;
    for (let t = 0; t < len; t += STEP) {
      const p = project(l, x, y);
      if (p.s >= l.len - 2) break; // past the run's foot
      if (depth) latT = base + swing * Math.sin(Math.PI * waves * t / len);
      const sideSign = p.lat >= 0 ? 1 : -1;
      // fan out on the steep, funnel toward the run's edge where it flattens
      const funnel = FUNNEL_MIN + (1 - FUNNEL_MIN) * smooth(FLAT_TAN, STEEP_TAN, pitchAt(l, p.s));
      const lt = latT * funnel;
      const want = Math.abs(lt) < KEEP_OUT + 3 ? sideSign * (KEEP_OUT + 3) : lt;
      // inside the keep-out the pull is firm: the run itself stays the run's
      const pull = Math.max(-PULL_MAX, Math.min(PULL_MAX, (Math.abs(p.lat) < KEEP_OUT ? PULL_IN : PULL) * (want - p.lat)));
      const a = Math.atan2(p.ty, p.tx) + MEANDER * noise1(t / MEANDER_L, salt, 1) + pull;
      const nx = x + Math.cos(a) * STEP, ny = y + Math.sin(a) * STEP;
      plan.x.push(x); plan.y.push(y); plan.str.push(str * smooth(0, fadeIn, t) * (1 - smooth(len - fadeOut, len, t)));
      plan.w.push(plan.hw * (1 + WIDTH_VAR * noise1(t / WIDTH_L, salt, 2))); plan.open.push(t < openM ? 1 : 0);
      if (!depth && t > 20 && t < len - 60 && h01(salt, Math.round(t), 5) < this.forkP) {
        const lat = p.lat;
        this.walk(l, ri, k * 64 + Math.round(t), nx, ny, lat, str * FORK_STR, Math.min(len - t, FORK_LEN + FORK_LEN_RANGE * h01(salt, Math.round(t), 6)), 1);
      }
      x = nx; y = ny;
    }
    plan.x.push(x); plan.y.push(y); plan.str.push(0); plan.w.push(plan.hw); plan.open.push(0);
  }

  /** the line's raw weight here, 0..1 (the corridor's profile times its strength), before the canopy gate; the open
   *  segments' share (an entrance leaving the cat track) goes to `rawOpen` */
  private rawAt(x: number, y: number): number {
    this.rawOpen = 0;
    this.near(x, y);
    const ids = this.qIds, a = this.qA, e = this.qB;
    if (a === e) return 0;
    const s = this.seg;
    let w = 0;
    for (let q = a; q < e; q++) {
      const i = ids[q];
      const o = i * LINE_SEG, hw = s[o + 4], str = s[o + 5];
      if (str <= w && (!this.open[i] || str <= this.rawOpen)) continue;
      const r = hw + EDGE, d2 = segD2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]);
      if (d2 >= r * r) continue;
      const v = str * (1 - smooth(hw * 0.5, r, Math.sqrt(d2)));
      if (v > w) w = v;
      if (this.open[i] && v > this.rawOpen) this.rawOpen = v;
    }
    return w;
  }
  private rawOpen = 0;

  /**
   * The line dug into the snow here, m (negative in the trench, a little positive on its berm), before the canopy gate.
   * Off the lines the snow lies as it fell; on one it is ridden down like a bobsled run: TRENCH_DEPTH at full strength,
   * a flat floor over the middle 0.3 of the way to the rim (TRENCH_WALL m past the corridor's half-width), then walls
   * that curve up steeply (about 45 degrees at their steepest on a full-width line) and round over at the rim, and just
   * past the rim the snow the riders pushed aside, a berm BERM_H high and BERM_W wide. A line squeezed narrow past a trunk
   * is shallower, so its walls stay rideable. Where lines meet, the deepest trench wins and a berm never fills another
   * line's trench. The canopy gate scales the forest's part; an open segment's trench (`open`) counts as it is.
   */
  private trenchRaw(x: number, y: number, gate: (x: number, y: number) => number): number {
    this.near(x, y);
    const ids = this.qIds, a = this.qA, e = this.qB;
    if (a === e) return 0;
    const s = this.seg;
    let dig = 0, digOpen = 0, berm = 0, bermOpen = 0;
    for (let q = a; q < e; q++) {
      const i = ids[q];
      const o = i * LINE_SEG, hw = s[o + 4], str = s[o + 5];
      const rim = hw + TRENCH_WALL, r = rim + BERM_W;
      const d2 = segD2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]);
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      const t = -TRENCH_DEPTH * str * Math.min(1, (hw + 0.2) / 1.2) * (1 - smooth(0.3 * rim, rim, d));
      const u = (d - rim + 0.3) / (BERM_W + 0.3), b = u > 0 && u < 1 ? BERM_H * str * Math.sin(Math.PI * u) ** 2 : 0;
      if (this.open[i]) { if (t < digOpen) digOpen = t; if (b > bermOpen) bermOpen = b; } else { if (t < dig) dig = t; if (b > berm) berm = b; }
    }
    if (dig === 0 && berm === 0 && digOpen === 0 && bermOpen === 0) return 0;
    const g = dig !== 0 || berm !== 0 ? gate(x, y) : 0;
    const dd = Math.min(dig * g, digOpen), bb = Math.max(berm * g, bermOpen);
    return dd + bb * Math.max(0, 1 + dd / 0.15);
  }

  /** FEAT-333: the height the snow is dug down (or banked up) by a tree line here, m, under the forest only (and on an
   *  entrance's open stretch from the cat track) */
  trenchAt(x: number, y: number): number {
    return this.trenchRaw(x, y, this.gateFn);
  }
  private readonly gateFn = (x: number, y: number): number => this.gate(x, y);

  /** the canopy gate: no line where there is no forest round it */
  private gate(x: number, y: number): number {
    return this.canopy ? smooth(CANOPY_LO, CANOPY_HI, this.canopy(x, y)) : 1;
  }

  /** 0..1 how worn the snow is here by a tree line (0 off them and outside the forest) */
  wornAt(x: number, y: number): number {
    const w = this.rawAt(x, y);
    return w > 0 ? Math.max(w * this.gate(x, y), this.rawOpen) : 0;
  }

  /** FEAT-335: `f` run with every query looping over all the segments in the grid cell instead of the near index (the
   *  checks hold the index to the same answers) */
  withoutIndex<T>(f: () => T): T { this.full = true; try { return f(); } finally { this.full = false; } }
  private full = false;

  /**
   * Where a generated stem planned at (x, y) stands, written into `out`; false when it has nowhere to go. The forest keeps
   * its count (so it looks the same from a distance): a stem whose spot is in a trench, or within STEM_GAP of its rim, moves
   * straight out to just past the rim (STEM_GAP plus a seeded 0 to STEM_JITTER m), so the trees stand right up to the
   * bank. It is left out only when both ways out land in another line's trench (where lines cross).
   */
  placeStem(x: number, y: number, out: number[]): boolean {
    // FEAT-335: most stems are nowhere near a trench; the near index says so with no segment loop
    this.near(x, y);
    if (this.qA === this.qB) { out[0] = x; out[1] = y; return true; }
    // out to the nearer bank first; where that lands in another line's trench (lines crossing or braided), the other bank
    return this.pushOut(x, y, out, false) || this.pushOut(x, y, out, true);
  }

  /** `placeStem`'s moves from (x, y), the first one to the far bank when `flip`; true when it ends clear of every trench */
  private pushOut(x: number, y: number, out: number[], flip: boolean): boolean {
    out[0] = x; out[1] = y;
    const s = this.seg, jit = STEM_JITTER * h01(Math.round(x * 16), Math.round(y * 16), 77);
    for (let pass = 0; pass < 4; pass++) {
      const px = out[0], py = out[1];
      this.near(px, py);
      const ids = this.qIds, qe = this.qB;
      let worst = 0, cx = 0, cy = 0, need = 0, seg = -1;
      for (let q = this.qA; q < qe; q++) {
        const o = ids[q] * LINE_SEG;
        if (s[o + 5] < STEM_FAINT) continue; // dug under 5 cm: the woods close in
        const r = s[o + 4] + TRENCH_WALL + STEM_GAP;
        const ax = s[o], ay = s[o + 1], dx = s[o + 2] - ax, dy = s[o + 3] - ay, l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(px - qx, py - qy);
        if (r - d > worst) { worst = r - d; cx = qx; cy = qy; need = r; seg = o; }
      }
      if (seg < 0) return true;
      let ux = out[0] - cx, uy = out[1] - cy;
      const l = Math.hypot(ux, uy);
      if (l > 1e-3) { ux /= l; uy /= l; } else {
        // on the centreline: out to the side the hash picks
        const dx = s[seg + 2] - s[seg], dy = s[seg + 3] - s[seg + 1], dl = Math.hypot(dx, dy) || 1, side = jit < STEM_JITTER / 2 ? 1 : -1;
        ux = -dy / dl * side; uy = dx / dl * side;
      }
      if (flip && pass === 0) { ux = -ux; uy = -uy; }
      out[0] = cx + ux * (need + jit); out[1] = cy + uy * (need + jit);
    }
    // still in a trench after the moves: crossing lines with no room between
    this.near(out[0], out[1]);
    for (let q = this.qA; q < this.qB; q++) {
      const o = this.qIds[q] * LINE_SEG, r = s[o + 4] + TRENCH_WALL;
      if (s[o + 5] >= STEM_FAINT && segD2(out[0], out[1], s[o], s[o + 1], s[o + 2], s[o + 3]) < r * r) return false;
    }
    return true;
  }

  /** (x, y) is inside a corridor's half-width, not counting the faint ends (the checks: no detected trunk in one) */
  inCorridor(x: number, y: number): boolean {
    this.near(x, y);
    const s = this.seg;
    for (let q = this.qA; q < this.qB; q++) {
      const o = this.qIds[q] * LINE_SEG, r = s[o + 4];
      if (s[o + 5] >= 0.15 && segD2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]) < r * r) return true;
    }
    return false;
  }

  /** FEAT-303: how far a tree's lower branches are trimmed here, 0..1 */
  trimAt(x: number, y: number): number {
    const tx = Math.floor(x / TRIM_TILE), ty = Math.floor(y / TRIM_TILE), key = ty * 100003 + tx;
    let t = this.trimTiles.get(key);
    if (!t) { t = this.trimTile(tx, ty); this.trimTiles.set(key, t); }
    const fx = (x - tx * TRIM_TILE) / TRIM_RES, fy = (y - ty * TRIM_TILE) / TRIM_RES;
    const ix = Math.min(TRIM_N - 2, Math.floor(fx)), iy = Math.min(TRIM_N - 2, Math.floor(fy)), ax = fx - ix, ay = fy - iy;
    const o = iy * TRIM_N + ix;
    return (t[o] * (1 - ax) + t[o + 1] * ax) * (1 - ay) + (t[o + TRIM_N] * (1 - ax) + t[o + TRIM_N + 1] * ax) * ay;
  }

  /** one trim tile: TRIM_N x TRIM_N samples, row-major from its south-west corner */
  private trimTile(tx: number, ty: number): Float32Array {
    const out = new Float32Array(TRIM_N * TRIM_N);
    const x0 = tx * TRIM_TILE, y0 = ty * TRIM_TILE;
    const ids = this.runGrid.get(ty * 100003 + tx) ?? [];
    const rs = this.runSeg;
    for (let j = 0; j < TRIM_N; j++) for (let i = 0; i < TRIM_N; i++) {
      const x = x0 + i * TRIM_RES, y = y0 + j * TRIM_RES;
      // nearest and second-nearest run (distinct runs), and the glade round the runs near
      let d1 = Infinity, r1 = -1, d2 = Infinity, glade = 0;
      for (const q of ids) {
        const o = q * 6, d = Math.sqrt(segD2(x, y, rs[o], rs[o + 1], rs[o + 2], rs[o + 3])), r = rs[o + 4];
        glade = Math.max(glade, rs[o + 5] * (1 - smooth(GLADE_FULL, GLADE_NONE, d)));
        if (r === r1) { if (d < d1) d1 = d; continue; }
        if (d < d1) { d2 = d1; d1 = d; r1 = r; } else if (d < d2) d2 = d;
      }
      out[j * TRIM_N + i] = Math.max(glade, STRIP_K * (1 - smooth(STRIP_FULL, STRIP_NONE, d1 + d2)));
    }
    // round the tree lines: splat each segment near the tile into the samples within LINE_FAR of it (a faint line counts as farther)
    const seen = new Set<number>(), s = this.seg;
    for (let gy = Math.floor((y0 - LINE_FAR) / GRID); gy <= Math.floor((y0 + TRIM_TILE + LINE_FAR) / GRID); gy++) {
      for (let gx = Math.floor((x0 - LINE_FAR) / GRID); gx <= Math.floor((x0 + TRIM_TILE + LINE_FAR) / GRID); gx++) {
        const a = this.grid.cells.get(gy * 100003 + gx);
        if (!a) continue;
        for (const q of a) {
          if (seen.has(q)) continue;
          seen.add(q);
          const o = q * LINE_SEG, ax = s[o], ay = s[o + 1], bx = s[o + 2], by = s[o + 3], k = 1 / Math.max(0.2, s[o + 5]);
          const reach = LINE_FAR / k;
          const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / TRIM_RES)), i1 = Math.min(TRIM_N - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / TRIM_RES));
          const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - y0) / TRIM_RES)), j1 = Math.min(TRIM_N - 1, Math.ceil((Math.max(ay, by) + reach - y0) / TRIM_RES));
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const d = Math.sqrt(segD2(x0 + i * TRIM_RES, y0 + j * TRIM_RES, ax, ay, bx, by)) * k;
            if (d >= LINE_FAR) continue;
            const v = LINE_TRIM * (1 - smooth(LINE_NEAR, LINE_FAR, d)), w = j * TRIM_N + i;
            if (v > out[w]) out[w] = v;
          }
        }
      }
    }
    return out;
  }
}
