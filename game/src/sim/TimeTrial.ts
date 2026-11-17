import type { Rider } from './Rider';
import { nearestOnCourse, type Course } from './Courses';
import type { JumpMode } from './rider/tuning';

/**
 * Time-trial state machine and ghost recording.
 *   idle -> (inside a start gate) armed -> (ride through it, down the course) running
 *   running -> (all checkpoints, reach the finish) finished | (outside the boundary 5 s, R, lift) cancelled
 * Several courses can share a start gate: all of them are candidates while armed and the clock
 * starts on the one whose route the rider actually follows out of the gate.
 * The best run per course is saved to localStorage with its splits and a 10 Hz ghost track, one per jump mode
 * (BUG-055): Realistic and Arcade times and ghosts never race each other.
 */
export interface GhostSample { t: number; x: number; y: number; z: number; h: number; lg: number; e: number; f: number } // f bits: 1 onGround, 2 tuck, 4 crashed, 8 riding switch, 16 goofy (FEAT-139)
/** FEAT-139: add the stance bits (8 riding switch, 16 goofy) to a sample's flags */
export function stanceFlags(r: { switch: boolean; goofy: boolean }, f: number): number { return f | (r.switch ? 8 : 0) | (r.goofy ? 16 : 0); }
/** `jumpMode` the Jump height it was ridden on (BUG-055; missing on a best saved before, see legacyMode) */
export interface Best { time: number; splits: number[]; samples: GhostSample[]; date: string; jumpMode?: JumpMode }
/** BUG-055: FEAT-311 (PR #679) merged then, adding Realistic as the default; every run before it was ridden on the old pop, Arcade's */
const REAL_SINCE = '2026-11-14T12:48:30Z';
/** BUG-055: the jump mode of a best saved before bests were kept per mode: Arcade before FEAT-311, else Realistic (the default since) */
export function legacyMode(b: Best): JumpMode { return b.jumpMode ?? (b.date < REAL_SINCE ? 'arcade' : 'real'); }

const START_R = 14; // m around the start point that arms the gate
const CHECK_R = 35; // m to count a checkpoint
const FINISH_R = 25;
export const OFF_COURSE = 50; // m from the route: the boundary walls stand here
export const OFF_TIME = 5; // s of grace outside the boundary before DNF
const SAMPLE_DT = 0.1;

export type TrialEvent =
  | { kind: 'armed'; course: Course; best: Best | null }
  | { kind: 'start'; course: Course; best: Best | null }
  | { kind: 'split'; index: number; time: number; delta: number | null }
  | { kind: 'finish'; time: number; best: Best | null; isBest: boolean }
  | { kind: 'cancel'; reason: string };

export class TimeTrial {
  state: 'idle' | 'armed' | 'running' = 'idle';
  course: Course | null = null;
  time = 0;
  best: Best | null = null;
  private next = 0; // next checkpoint index
  private splits: number[] = [];
  private samples: GhostSample[] = [];
  private sampleAcc = 0;
  private offFor = 0;
  /** courses whose start gate the rider is in, with the rider's progress along each when armed */
  candidates: { c: Course; d0: number }[] = [];
  /** seconds spent outside the boundary (0 when inside) */
  get outside(): number { return this.offFor; }
  get graceLeft(): number { return Math.max(0, OFF_TIME - this.offFor); }
  onEvent: ((e: TrialEvent) => void) | null = null;
  /** metres along the active course of the rider's closest point (armed or running) */
  along = 0;
  /** distance along the course of the next checkpoint, or the course length when only the finish is left */
  get nextTarget(): number { const c = this.course; if (!c) return 0; return this.next < c.checkpoints.length ? c.checkpoints[this.next] : c.length; }

  /** BUG-055: the Jump height setting; bests are loaded and saved for it (setMode) */
  mode: JumpMode = 'real';

  constructor(private readonly packSlug: string, private readonly courses: Course[]) {}

  private key(c: Course, m: JumpMode): string { return `ghost:${this.packSlug}:${c.id}:${m}`; }
  /** the best on course `c` for jump mode `m` (default the current one) */
  loadBest(c: Course, m: JumpMode = this.mode): Best | null {
    this.migrate(c);
    try { return JSON.parse(localStorage.getItem(this.key(c, m)) ?? 'null'); } catch { return null; }
  }
  private saveBest(c: Course, b: Best): void {
    try { localStorage.setItem(this.key(c, b.jumpMode ?? this.mode), JSON.stringify(b)); } catch { /* storage full or private mode */ }
  }
  /** BUG-055: move a best saved before bests were per mode (`ghost:<pack>:<course>`) to its mode's key, unless that has one */
  private migrate(c: Course): void {
    try {
      const old = `ghost:${this.packSlug}:${c.id}`, raw = localStorage.getItem(old);
      if (raw === null) return;
      const b = JSON.parse(raw) as Best | null;
      if (b && typeof b.time === 'number') {
        const m = legacyMode(b), k = this.key(c, m);
        if (localStorage.getItem(k) === null) localStorage.setItem(k, JSON.stringify({ ...b, jumpMode: m }));
      }
      localStorage.removeItem(old);
    } catch { /* storage blocked: nothing to move */ }
  }

  /** BUG-055: the Jump height changed: a run in progress is cancelled (it would mix the two), and the best shown is the new mode's */
  setMode(m: JumpMode): void {
    if (m === this.mode) return;
    this.mode = m;
    if (this.state === 'running') this.cancel('Jump height changed');
    else if (this.course) this.best = this.loadBest(this.course);
  }

  /** All course starts within `maxDist` m. */
  startsNear(x: number, y: number, maxDist: number): Course[] {
    return this.courses.filter((c) => Math.hypot(c.start[0] - x, c.start[1] - y) < maxDist);
  }

  /** Nearest course start within `maxDist` m. */
  nearestStart(x: number, y: number, maxDist = Infinity): Course | null {
    let best: Course | null = null, bd = maxDist;
    for (const c of this.courses) { const d = Math.hypot(c.start[0] - x, c.start[1] - y); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  cancel(reason: string): void {
    if (this.state === 'idle') return;
    const was = this.state;
    this.state = 'idle'; this.course = null; this.candidates = []; this.offFor = 0;
    if (was === 'running') this.onEvent?.({ kind: 'cancel', reason });
  }

  update(r: Rider, dt: number, tuck: boolean): void {
    if (this.state === 'idle') {
      const cs = this.startsNear(r.x, r.y, START_R);
      if (cs.length) {
        this.state = 'armed';
        this.candidates = cs.map((c) => ({ c, d0: nearestOnCourse(c, r.x, r.y).along }));
        // until the rider commits, show the nearest one
        cs.sort((a, b) => Math.hypot(a.start[0] - r.x, a.start[1] - r.y) - Math.hypot(b.start[0] - r.x, b.start[1] - r.y));
        this.course = cs[0]; this.best = this.loadBest(cs[0]);
        this.next = 0; this.along = this.candidates.find((e) => e.c === cs[0])!.d0;
        this.onEvent?.({ kind: 'armed', course: cs[0], best: this.best });
      }
      return;
    }
    if (this.state === 'armed') {
      // still inside any candidate's gate: wait
      if (this.candidates.some((e) => Math.hypot(e.c.start[0] - r.x, e.c.start[1] - r.y) <= START_R)) return;
      // left the gate: start on the candidate route the rider is following, else disarm
      let pick: Course | null = null, pd = 25;
      for (const e of this.candidates) {
        const n = nearestOnCourse(e.c, r.x, r.y);
        if (n.along > e.d0 + 5 && n.dist < pd) { pd = n.dist; pick = e.c; }
      }
      if (pick && r.onGround) {
        this.course = pick; this.best = this.loadBest(pick);
        this.state = 'running'; this.time = 0; this.next = 0; this.splits = []; this.samples = []; this.sampleAcc = SAMPLE_DT; this.offFor = 0;
        this.candidates = [];
        this.onEvent?.({ kind: 'start', course: pick, best: this.best });
      } else { this.state = 'idle'; this.course = null; this.candidates = []; }
      return;
    }
    // running
    const c = this.course!;
    this.time += dt;
    this.sampleAcc += dt;
    if (this.sampleAcc >= SAMPLE_DT) {
      this.sampleAcc = 0;
      const f = stanceFlags(r, (r.onGround ? 1 : 0) | (tuck ? 2 : 0) | (r.crashed > 0 ? 4 : 0));
      this.samples.push({ t: +this.time.toFixed(2), x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), h: +r.boardYaw.toFixed(3), lg: +r.lateralG.toFixed(2), e: +r.edgeAngle.toFixed(2), f });
    }
    const n = nearestOnCourse(c, r.x, r.y);
    this.along = n.along;
    this.offFor = n.dist > OFF_COURSE ? this.offFor + dt : 0;
    if (this.offFor > OFF_TIME) { this.cancel('Off course'); return; }
    // checkpoints in order
    while (this.next < c.checkpoints.length) {
      const cp = c.checkpoints[this.next];
      if (n.along >= cp - 5 && n.dist < CHECK_R) {
        this.splits.push(this.time);
        const ref = this.best?.splits[this.next];
        this.onEvent?.({ kind: 'split', index: this.next, time: this.time, delta: ref !== undefined ? this.time - ref : null });
        this.next++;
      } else break;
    }
    if (this.next >= c.checkpoints.length && Math.hypot(c.finish[0] - r.x, c.finish[1] - r.y) < FINISH_R) {
      const isBest = !this.best || this.time < this.best.time;
      const rec: Best = { time: this.time, splits: this.splits, samples: this.samples, date: new Date().toISOString(), jumpMode: this.mode };
      if (isBest) { this.saveBest(c, rec); }
      const prev = this.best;
      this.state = 'idle'; this.course = null;
      this.onEvent?.({ kind: 'finish', time: rec.time, best: isBest ? rec : prev, isBest });
    }
  }

  /** Ghost pose at the current run time (interpolated), or null. */
  ghostAt(t: number): GhostSample | null {
    const s = this.best?.samples;
    if (!s || s.length < 2 || this.state !== 'running') return null;
    if (t >= s[s.length - 1].t) return s[s.length - 1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t <= t) lo = m; else hi = m; }
    const a = s[lo], b = s[hi], k = (t - a.t) / Math.max(1e-6, b.t - a.t);
    let dh = b.h - a.h; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
    // FEAT-139: the heading turning round with the stance (riding switch) is a jump, not a spin: hold it with the flags
    const h = Math.abs(dh) < 1 ? a.h + dh * k : k < 0.5 ? a.h : b.h;
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, h, lg: a.lg + (b.lg - a.lg) * k, e: a.e + (b.e - a.e) * k, f: k < 0.5 ? a.f : b.f };
  }
}
