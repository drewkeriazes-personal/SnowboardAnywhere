import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Collider } from '../sim/Collider';
import type { LiftRuntime } from './Lifts';
import { LOAD_OFFSET } from '../sim/LiftLine';

/**
 * FEAT-073: lift-line mazes at the bottom of each chairlift: parallel lanes of webbing and rope on short
 * posts (2 to 4 lanes by capacity, 18 to 30 m long) that merge before a "wait here" line, then the blue
 * "load here" line where the chair swings in. From the maze mouth two funnel fences flare back up toward
 * the runs that end at the lift. A lift name board stands at the front. Ropes are colliders (the rider
 * slides along them). Boarding works anywhere inside the gold ring and, where the maze reaches past it,
 * inside the corral (`inGate`, BUG-150). Built lazily once the fine terrain under a lift's base has
 * loaded, so posts sit on the snow.
 *
 * BUG-061: the maze opens toward the runs riders arrive from. The lanes run straight back from the stop
 * line, square to the chair, until they are out from under the terminal; then they bend (one arc, up to
 * 150 deg, uphill or across the slope) toward the arrival direction, so the mouth faces the feeder runs.
 * The bent part keeps clear of the terminal, the cable, the chairs and the towers (of this lift and every
 * other), the other mazes, buildings and trees: the full bend on the feeder side first, then a gentler one, then the
 * other side, then straight back as before.
 */
const LANE_W = 2.2, POST_GAP = 2.5, ROPE_H = 0.95, STOP = 3, MERGE = 4, FUNNEL = 22, FUNNEL_FLARE = 0.5;
/** runs whose lower end is this close to the loading point feed the lift (m) */
const FEED_R = 150;
/** how far up a feeder run its arrival point is taken (m): where riders come in from */
const ARRIVE = 50;
const BUILD_R = 900;
/** how far behind the loading point the chair terminal ends (m): it is 14 m long on the station node,
 *  which is LOAD_OFFSET behind the loading point (LiftModels.terminalGeometry), plus 1 m clear */
const TERM_BACK = LOAD_OFFSET + 7 + 1;
/** straight lanes from the stop line before the bend: out from under the terminal, so loading is square to the chair */
const STRAIGHT = Math.max(8, TERM_BACK - STOP);
/** half width of the corridor along a lift line that the bent lanes keep out of (m): the terminal, the cable, the chairs, the towers */
const LINE_CLEAR = 4.5;
/** bend radius of the maze centre line beyond its half width (m), and the straight lanes after the bend */
const BEND_PAD = 2.5, MOUTH_MIN = 4;
const MAX_TURN = (150 * Math.PI) / 180, MIN_TURN = (12 * Math.PI) / 180;
/** a minority side whose flow is at least this share of the main side's gets its own funnel fence */
const MINOR_SHARE = 0.3;
const C_POST = [0.18, 0.19, 0.21], C_OUTER = [0.95, 0.45, 0.08], C_INNER = [0.12, 0.33, 0.75], C_LOAD = [0.1, 0.25, 0.7], C_WAIT = [0.8, 0.12, 0.1], C_BOARD = [0.24, 0.17, 0.11];

/**
 * BUG-061: a maze's centre line, from the stop line (s = 0) to the mouth (s = total): STRAIGHT m back
 * down the cable line, an arc of `turn` rad (counter-clockwise positive, seen from above), then straight
 * to the mouth. `at(s, o)` is the point o m to the side of the centre line (pack x, y).
 */
export class MazePath {
  readonly total: number;
  readonly R: number;
  private readonly arc: number;
  constructor(readonly bx: number, readonly by: number, readonly ux: number, readonly uy: number, readonly halfW: number, len: number, readonly turn: number) {
    this.R = halfW + BEND_PAD;
    this.arc = Math.abs(turn) * this.R;
    this.total = Math.max(len, turn ? STRAIGHT + this.arc + MOUTH_MIN : 0);
  }

  /** unit tangent at s, pointing from the stop line toward the mouth */
  dir(s: number): [number, number] {
    const phi = s <= STRAIGHT || !this.turn ? 0 : (Math.sign(this.turn) * Math.min(s - STRAIGHT, this.arc)) / this.R;
    const c = Math.cos(phi), n = Math.sin(phi), bx = -this.ux, by = -this.uy;
    return [bx * c - by * n, bx * n + by * c];
  }

  at(s: number, o: number): [number, number] {
    const bx = -this.ux, by = -this.uy;
    let x = this.bx - this.ux * STOP, y = this.by - this.uy * STOP;
    const [tx, ty] = this.dir(s);
    if (s <= STRAIGHT || !this.turn) { x += bx * s; y += by * s; } else {
      const g = Math.sign(this.turn), R = this.R;
      // the arc's centre is R to the inside of the bend from where it starts
      const cx = x + bx * STRAIGHT - g * R * by, cy = y + by * STRAIGHT + g * R * bx;
      x = cx + g * R * ty; y = cy - g * R * tx;
      const past = s - STRAIGHT - this.arc;
      if (past > 0) { x += tx * past; y += ty * past; }
    }
    return [x + ty * o, y - tx * o];
  }

  /** points every ~`gap` m from s0 to s1 at offset o, both ends included */
  line(s0: number, s1: number, o: number, gap: number): number[][] {
    const n = Math.max(1, Math.ceil((s1 - s0) / gap)), out: number[][] = [];
    for (let i = 0; i <= n; i++) out.push(this.at(s0 + ((s1 - s0) * i) / n, o));
    return out;
  }

  /** the centre line from the gate's front (LOAD_OFFSET / 2 ahead of the loading point) to 1 m past the mouth */
  gateLine(): number[][] {
    const pts = [[this.bx + this.ux * LOAD_OFFSET * 0.5, this.by + this.uy * LOAD_OFFSET * 0.5], ...this.line(0, this.total, 0, 1)];
    const [tx, ty] = this.dir(this.total), e = pts[pts.length - 1];
    pts.push([e[0] + tx, e[1] + ty]);
    return pts;
  }
}

/** Distance from (x, y) to a polyline with flat ends (a point whose nearest piece is past either end is out) and round joins. */
function lineDist(pts: number[][], x: number, y: number): number {
  let best = Infinity, out = false;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-9;
    const t = ((x - ax) * ex + (y - ay) * ey) / l2, c = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - ax - ex * c, y - ay - ey * c);
    if (d < best) { best = d; out = (i === 0 && t < 0) || (i + 2 === pts.length && t > 1); }
  }
  return out ? Infinity : best;
}

/** BUG-061: where riders come to a lift from, as unit directions (pack x, y) from its loading point. */
export interface Arrivals {
  /** the side of the line (looking up it) with the bigger flow; null when no run ends at the lift */
  main: [number, number] | null;
  /** the other side, when its flow is at least MINOR_SHARE of the main side's */
  minor: [number, number] | null;
}

interface Maze {
  lift: LiftRuntime; built: boolean; ux: number; uy: number; halfW: number; len: number; bx: number; by: number;
  /** BUG-061: the planned shape (once the loading point's ground is in), its gate line, the arrivals it faces and its funnel fences */
  path: MazePath | null; gate: number[][] | null; arrive: Arrivals | null; fences: number[][][];
}

/** a lift line's corridor: bottom (loading point), unit up the line, rideable length */
interface Corridor { bx: number; by: number; ux: number; uy: number; len: number }

export class LiftLines {
  readonly group = new THREE.Group();
  private readonly mazes: Maze[] = [];
  private readonly lines: Corridor[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  /** rope colliders, so turning the setting off removes the walls along with the mesh */
  private readonly walls: Float32Array[] = [];
  enabled = true;

  constructor(private readonly pack: Pack, lifts: readonly LiftRuntime[], private readonly collider: Collider | null) {
    this.group.name = 'lift lines';
    for (const l of lifts) {
      const [bx, by] = l.bottom, [tx, ty] = l.top;
      const d = Math.hypot(tx - bx, ty - by);
      if (d > 1) this.lines.push({ bx, by, ux: (tx - bx) / d, uy: (ty - by) / d, len: d });
      if (l.kind !== 'chair') continue; // gondolas load inside their station; surface lifts and carpets have no maze
      if (d < 50) continue;
      const cap = l.feature.capacity ?? 2000;
      const lanes = cap > 2800 ? 4 : cap > 1800 ? 3 : 2;
      this.mazes.push({ lift: l, built: false, ux: (tx - bx) / d, uy: (ty - by) / d, halfW: (lanes * LANE_W) / 2, len: 14 + lanes * 4, bx, by, path: null, gate: null, arrive: null, fences: [] });
    }
  }

  /** Build the mazes within BUILD_R of (x, y) whose ground has loaded. */
  maintain(x: number, y: number): void {
    if (!this.enabled) return;
    for (const m of this.mazes) {
      if (m.built || Math.hypot(m.bx - x, m.by - y) > BUILD_R) continue;
      if (Number.isNaN(this.ground(m.bx, m.by))) continue;
      // planned once the loading point's ground is in (the trees around it come with it), built once the mouth's is
      if (!m.path) this.plan(m);
      const [mx, my] = m.path!.at(m.path!.total, 0);
      if (Number.isNaN(this.ground(mx, my))) continue;
      this.build(m);
      m.built = true;
    }
  }

  private ground(x: number, y: number): number {
    const f = this.pack.fine;
    return f && f.contains(x, y) ? f.sample(x, y) : NaN;
  }

  /**
   * True when (x, y) is inside the corral or at the loading line of lift `l`. BUG-150: the boarding
   * zone (the gold ring) boards anywhere already; this only adds the corral where a long maze reaches
   * past the ring. BUG-061: tested against the bent maze (within its half width plus 1.5 m of the
   * centre line, from LOAD_OFFSET / 2 ahead of the loading point to 1 m past the mouth). False without
   * a built maze (or with the setting off).
   */
  inGate(l: LiftRuntime, x: number, y: number): boolean {
    if (!this.enabled) return false;
    const m = this.mazes.find((q) => q.lift === l);
    if (!m || !m.built || !m.gate) return false;
    return lineDist(m.gate, x, y) < m.halfW + 1.5;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (this.collider) for (const w of this.walls) this.collider.setWallActive(w, on);
  }

  /**
   * BUG-061: where riders come to the lift from. For each run whose lower end is within FEED_R of the
   * loading point, the direction from the loading point to the point ARRIVE m up the run, weighted by the
   * run's length (longer runs carry more riders). Summed per side of the line; the bigger side is `main`.
   */
  private arrivals(m: Maze): Arrivals {
    const acc = [[0, 0, 0], [0, 0, 0]];
    for (const r of this.pack.features.runs) {
      if (r.area || r.points.length < 2) continue;
      const p = r.points, lowEnd = p[0][2] < p[p.length - 1][2] ? 0 : p.length - 1, step = lowEnd === 0 ? 1 : -1, lo = p[lowEnd];
      if (Math.hypot(lo[0] - m.bx, lo[1] - m.by) > FEED_R) continue;
      let d = 0, i = lowEnd, q = lo;
      while (i + step >= 0 && i + step < p.length && d < ARRIVE) { const n = p[i + step]; d += Math.hypot(n[0] - q[0], n[1] - q[1]); q = n; i += step; }
      if (q[2] <= lo[2]) continue;
      let len = 0;
      for (let k = 1; k < p.length; k++) len += Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]);
      const vx = q[0] - m.bx, vy = q[1] - m.by, l = Math.hypot(vx, vy);
      if (l < 1) continue;
      const w = Math.min(len, 2000), side = vx * m.uy - vy * m.ux >= 0 ? 0 : 1;
      acc[side][0] += (vx / l) * w; acc[side][1] += (vy / l) * w; acc[side][2] += w;
    }
    const [a, b] = acc[0][2] >= acc[1][2] ? [acc[0], acc[1]] : [acc[1], acc[0]];
    const unit = (v: number[]): [number, number] | null => { const l = Math.hypot(v[0], v[1]); return v[2] > 0 && l > 1e-3 * v[2] ? [v[0] / l, v[1] / l] : null; };
    return { main: unit(a), minor: b[2] >= MINOR_SHARE * a[2] ? unit(b) : null };
  }

  /** BUG-061: pick the maze's shape (the first clear bend toward the arrivals, else straight back) and its funnel fences. */
  private plan(m: Maze): void {
    m.arrive = this.arrivals(m);
    const turns: number[] = [];
    if (m.arrive.main) {
      const bx = -m.ux, by = -m.uy, [ax, ay] = m.arrive.main;
      let t = Math.atan2(bx * ay - by * ax, bx * ax + by * ay);
      if (Math.abs(t) >= MIN_TURN) {
        t = Math.sign(t) * Math.min(Math.abs(t), MAX_TURN);
        turns.push(t, t * 0.6);
        if (Math.abs(t) >= Math.PI / 2) turns.push(-t); // the other side still opens uphill
      }
    }
    const make = (t: number) => new MazePath(m.bx, m.by, m.ux, m.uy, m.halfW, m.len, t);
    m.path = turns.map(make).find((p) => this.clear(m, p)) ?? make(0);
    m.gate = m.path.gateLine();
    m.fences = this.fences(m, m.path);
  }

  /** the bent part of the lanes (past STRAIGHT) touches nothing: no lift line, no other maze, no building, trunk, rock or wall */
  private clear(m: Maze, p: MazePath): boolean {
    const n = Math.max(1, Math.ceil(p.total - STRAIGHT)), k = Math.ceil(2 * m.halfW + 1);
    for (let i = 1; i <= n; i++) {
      const s = STRAIGHT + ((p.total - STRAIGHT) * i) / n;
      for (let j = 0; j <= k; j++) {
        const [x, y] = p.at(s, -m.halfW - 0.5 + ((2 * m.halfW + 1) * j) / k);
        if (this.blocked(m, x, y)) return false;
      }
    }
    return true;
  }

  /** (x, y) is in a lift line's corridor (from behind its bottom terminal to past its top), in another planned maze, in a
   *  building or within 0.5 m of a trunk, a rock or a wall (railings, other mazes' ropes) */
  private blocked(m: Maze, x: number, y: number): boolean {
    for (const c of this.lines) {
      const dx = x - c.bx, dy = y - c.by, along = dx * c.ux + dy * c.uy;
      if (along > -TERM_BACK + 0.01 && along < c.len + TERM_BACK && Math.abs(dx * c.uy - dy * c.ux) < LINE_CLEAR) return true;
    }
    for (const o of this.mazes) if (o !== m && o.gate && lineDist(o.gate, x, y) < o.halfW + 1) return true;
    return !!this.collider && this.collider.blocked(x, y, this.pack.groundHeight(x, y), 0.5);
  }

  /**
   * Funnel fences from the two mouth corners, flaring toward the arrivals with no limit on the angle (the
   * fence on the minority side, if there is one, aims at it instead); each never turns back past square to
   * the mouth, and stops short where it would meet a lift line, another maze or a tree.
   */
  private fences(m: Maze, p: MazePath): number[][][] {
    const [tx, ty] = p.dir(p.total), nx = ty, ny = -tx, out: number[][][] = [];
    for (const so of [-1, 1]) {
      const a = p.at(p.total, so * m.halfW), minor = m.arrive?.minor;
      let F = m.arrive?.main ?? [tx, ty];
      if (minor && (nx * minor[0] + ny * minor[1]) * so > 0) F = minor;
      const fa = F[0] * tx + F[1] * ty, fo = (F[0] * nx + F[1] * ny) * so;
      const la = Math.max(fa, -fo, 0.15), lo = Math.max(fo, 0) + FUNNEL_FLARE, l = Math.hypot(la, lo);
      const dx = (tx * la + nx * so * lo) / l, dy = (ty * la + ny * so * lo) / l;
      let len = 0;
      while (len < FUNNEL && !this.blocked(m, a[0] + dx * (len + 1), a[1] + dy * (len + 1))) len++;
      if (len >= 3) out.push([a, [a[0] + dx * len, a[1] + dy * len]]);
    }
    return out;
  }

  private build(m: Maze): void {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
    const G = (x: number, y: number) => { const h = this.ground(x, y); return Number.isNaN(h) ? this.pack.groundHeight(x, y) : h; };
    // an axis-aligned box stretched from p to q (pack coords), w wide and h tall, on its base
    const beam = (p: number[], q: number[], w: number, h: number, c: number[]) => {
      const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
      const l = Math.hypot(dx, dy) || 1e-6, sx = (-dy / l) * w / 2, sy = (dx / l) * w / 2;
      const v = [[p[0] - sx, p[1] - sy, p[2]], [p[0] + sx, p[1] + sy, p[2]], [q[0] + sx, q[1] + sy, q[2]], [q[0] - sx, q[1] - sy, q[2]]];
      const top = v.map((a) => [a[0], a[1], a[2] + h]);
      const faces: [number[][], number[]][] = [
        [[top[0], top[1], top[2], top[3]], [0, 0, 1]],
        [[v[1], v[2], top[2], top[1]], [-dy / l, dx / l, 0]],
        [[v[3], v[0], top[0], top[3]], [dy / l, -dx / l, 0]],
        [[v[0], v[1], top[1], top[0]], [-dx / l, -dy / l, -dz / l]],
        [[v[2], v[3], top[3], top[2]], [dx / l, dy / l, dz / l]],
      ];
      for (const [q4, n] of faces) {
        const i0 = pos.length / 3;
        for (const a of q4) { pos.push(a[0], a[2], -a[1]); nor.push(n[0], n[2], -n[1]); col.push(c[0], c[1], c[2]); }
        idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
      }
    };
    const post = (x: number, y: number) => { const z = G(x, y); beam([x - 0.04, y, z - 0.3], [x + 0.04, y, z - 0.3], 0.08, ROPE_H + 0.35, C_POST); };
    // a rope along the points (pack x, y) on a post at each, sagging between them; a collider wall along each span
    const rope = (pts: number[][], c: number[], wide: boolean) => {
      let px = pts[0][0], py = pts[0][1], pz = G(px, py) + ROPE_H;
      post(px, py);
      for (let i = 1; i < pts.length; i++) {
        const x = pts[i][0], y = pts[i][1], z = G(x, y) + ROPE_H;
        post(x, y);
        // three pieces per span, the middle 0.12 m lower
        const mx = (px + x) / 2, my = (py + y) / 2, mz = (pz + z) / 2 - 0.12;
        const q1 = [px + (mx - px) * 0.5, py + (my - py) * 0.5, (pz + mz) / 2 - 0.04], q2 = [mx + (x - mx) * 0.5, my + (y - my) * 0.5, (mz + z) / 2 - 0.04];
        for (const [s, e] of [[[px, py, pz], q1], [q1, q2], [q2, [x, y, z]]]) beam(s, e, wide ? 0.04 : 0.025, wide ? 0.08 : 0.025, c);
        if (this.collider) this.walls.push(this.collider.addWall(px, py, x, y, Math.min(pz, z) - ROPE_H - 0.3, Math.max(pz, z) + 0.2));
        px = x; py = y; pz = z;
      }
    };
    const p = m.path!, { halfW } = m;
    const lanes = Math.round((2 * halfW) / LANE_W);
    // outer webbing the full length; the lane ropes stop short of the stop line so the lanes merge
    for (const s of [-1, 1]) rope(p.line(0, p.total, s * halfW, POST_GAP), C_OUTER, true);
    for (let i = 1; i < lanes; i++) rope(p.line(MERGE, p.total, -halfW + i * LANE_W, POST_GAP), C_INNER, false);
    // funnel: two fences from the mouth flaring toward the runs that end at this lift
    for (const [a, b] of m.fences) {
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / POST_GAP)), pts: number[][] = [];
      for (let i = 0; i <= n; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
      rope(pts, C_OUTER, true);
    }
    // painted lines on the snow: red "wait here" at the stop line, blue "load here" where the chair comes
    const paint = (s: number, c: number[]) => {
      const a = p.at(s, -halfW - 0.5), b = p.at(s, halfW + 0.5);
      const za = G(a[0], a[1]) + 0.03, zb = G(b[0], b[1]) + 0.03;
      beam([a[0], a[1], za], [b[0], b[1], zb], 0.35, 0.01, c);
    };
    paint(0, C_WAIT);
    paint(-STOP, C_LOAD);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.name = `lift line ${m.lift.feature.name ?? ''}`;
    mesh.castShadow = true; mesh.receiveShadow = true;
    this.group.add(mesh);
    this.sign(m, p.at(0, halfW + 1.2), G);
  }

  /** Lift name board on two posts at the front corner of the maze. */
  private sign(m: Maze, p: number[], G: (x: number, y: number) => number): void {
    const name = m.lift.feature.name ?? 'Chairlift';
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#2b1d12'; ctx.fillRect(0, 0, 512, 128);
    ctx.strokeStyle = '#e8dcc0'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 112);
    ctx.fillStyle = '#f4ead2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let size = 64; ctx.font = `bold ${size}px system-ui, sans-serif`;
    while (ctx.measureText(name).width > 470 && size > 24) { size -= 4; ctx.font = `bold ${size}px system-ui, sans-serif`; }
    ctx.fillText(name, 256, 66);
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, side: THREE.DoubleSide }));
    const z = G(p[0], p[1]);
    board.position.set(p[0], z + 1.9, -p[1]);
    board.rotation.y = Math.atan2(m.ux, m.uy) + Math.PI; // faces back down the line, toward riders arriving
    board.name = `lift sign ${name}`;
    this.group.add(board);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.9, 0.08), this.mat);
      leg.position.set(p[0] + m.uy * s * 1.0, z + 0.95, -(p[1] - m.ux * s * 1.0));
      this.group.add(leg);
    }
  }
}
