import type { Pack } from '../pack/Pack';
import type { Course } from '../sim/Courses';
import type { LiftLine } from '../sim/LiftLine';
import type { LiftFeature } from '../pack/types';

/**
 * FEAT-054: the mountain view's drop zones, from the pack's own data at load: every lift top, the named peaks
 * inside the resort, the top of every named run and the time trial starts. Places within CLUSTER_M of a
 * stronger one fold into it (its `also` names them), so the labels don't pile up at a summit with three lift
 * tops and a dozen run tops. Trial starts are their own layer: a drop there rides that course.
 * The spot on the snow (clear of trees, facing downhill) is found at the drop, once the trees there have
 * streamed in (LiftRide.unloadSpot / dropSpot); these are the nominal points.
 */
export type DropKind = 'lift' | 'peak' | 'run' | 'trial';

export interface DropZone<L extends LiftLine = LiftLine> {
  name: string;
  kind: DropKind;
  /** pack metres */
  x: number; y: number; z: number;
  /** the names folded into this zone */
  also: string[];
  /** a lift top: the lift (the drop steps off it as the chair would) */
  lift: L | null;
  /** a trial start: the course */
  course: Course | null;
}

/** places closer than this (m) are one zone */
const CLUSTER_M = 250;
/** a run's top counts when the run drops at least this much (m): skips the flats between pistes */
const RUN_MIN_DROP = 40;

export function dropZones<L extends LiftLine & { feature: LiftFeature }>(pack: Pack, lifts: readonly L[], courses: readonly Course[]): DropZone<L>[] {
  type Cand = DropZone<L> & { prio: number };
  const cands: Cand[] = [];
  const zone = (name: string, kind: DropKind, x: number, y: number, z: number, prio: number, lift: L | null = null): Cand =>
    ({ name, kind, x, y, z, also: [], lift, course: null, prio });
  // a lift top outranks a peak, a peak a run top; inside each, the bigger one first
  for (const l of lifts) {
    if (l.kind === 'carpet') continue;
    cands.push(zone(l.feature.name ?? 'Lift top', 'lift', l.top[0], l.top[1], l.top[2], 3e6 + l.top[2] - l.bottom[2], l));
  }
  const b = pack.meta.bounds;
  for (const p of pack.features.peaks) {
    if (p.name && p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY) cands.push(zone(p.name, 'peak', p.x, p.y, p.z, 2e6 + p.z));
  }
  const runs = new Map<string, { top: number[]; drop: number }>();
  for (const r of pack.features.runs) {
    if (!r.name || r.area || r.points.length < 2) continue;
    const a = r.points[0], e = r.points[r.points.length - 1];
    const [top, low] = a[2] >= e[2] ? [a, e] : [e, a];
    const prev = runs.get(r.name);
    const drop = Math.max(prev?.drop ?? 0, top[2] - low[2]);
    runs.set(r.name, { top: !prev || top[2] > prev.top[2] ? top : prev.top, drop });
  }
  for (const [name, r] of runs) if (r.drop >= RUN_MIN_DROP) cands.push(zone(name, 'run', r.top[0], r.top[1], r.top[2], 1e6 + r.drop));
  cands.sort((p, q) => q.prio - p.prio);
  const places = cluster(cands);
  const starts = cluster(courses.map((c) => ({ ...zone(c.name, 'trial', c.start[0], c.start[1], c.start[2], c.drop), course: c })));
  return [...places, ...starts].map(({ prio: _, ...z }) => z);
}

/** Greedy: each place (strongest first) starts a zone, or folds into the first zone within CLUSTER_M. */
function cluster<Z extends { name: string; x: number; y: number; also: string[] }>(cands: Z[]): Z[] {
  const out: Z[] = [];
  for (const c of cands) {
    const near = out.find((z) => Math.hypot(z.x - c.x, z.y - c.y) < CLUSTER_M);
    if (!near) out.push(c);
    else if (near.name !== c.name && !near.also.includes(c.name)) near.also.push(c.name);
  }
  return out;
}
