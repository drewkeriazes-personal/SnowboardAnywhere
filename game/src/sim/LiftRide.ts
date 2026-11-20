import type { Rider } from './Rider';
import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { LOAD_OFFSET, type LiftLine, type LiftNetwork, type Vec3 } from './LiftLine';
import type { BuildingFeature } from '../pack/types';
import { polyDist } from '../world/Buildings';

/**
 * Riding a lift back up. In a bottom terminal's boarding zone and slow, pressing E puts the rider
 * on a chair (FEAT-323: with two or more lifts in range, on the one picked from a list); the rider then follows the cable at chair speed. Pressing the key again skips to
 * the top; lifts run at RIDE_SPEEDUP x real speed and holding the tuck key multiplies that by FAST_FORWARD. At the top the rider steps off beside the station, clear of its roof and the cable, pushing off downhill at UNLOAD_PUSH (BUG-151);
 * out of a gondola they step out on foot with the board from the cabin's rack and strap in there (BUG-058).
 */
export const PROMPT_RANGE = 60; // m: show the boarding card
/**
 * FEAT-323: the boarding zone, metres from a lift's loading point where E boards (14 m before, doubled).
 * BUG-150: the gold ring on the snow is drawn at this radius, so inside the ring always boards.
 * The tuning knob: `?boardRange=<m>` overrides it for a session (LiftRide.boardRange) to try other sizes.
 */
export const BOARD_RANGE = 28;
/** BUG-150: how far from the loading point a lift-line maze's corral can reach (the longest maze ends about 34 m back) */
const MAZE_REACH = 40;
/** FEAT-323: the gentle coast-down near the loading point stays at the old 14 m zone */
export const COAST_RANGE = 14;
export const BOARD_SPEED = 6; // m/s
export const RIDE_SPEEDUP = 4; // real lift speeds feel far too slow in a game: ride at 4x
export const FAST_FORWARD = 5; // extra multiplier while the tuck key is held (20x real)
const UNLOAD_CLEAR = 1.5; // m: unload spot keeps this far from walls, trunks and rocks
const UNLOAD_RUN = 10; // m: and has this much clear snow straight downhill
const UNLOAD_SEARCH = 60; // m: furthest the unload spot may move from the nominal point
const UNLOAD_MIN_SLOPE = 4; // degrees: preferred minimum slope at the unload spot
/** BUG-151: the unload spot keeps this far outside the station: its footprint, the terminal and under the cable (m) */
const STATION_CLEAR = 2, CABLE_CLEAR = 4;
/** BUG-151: the rider leaves the chair pushing off at this speed, away from the station (m/s) */
export const UNLOAD_PUSH = 2.5;

/**
 * BUG-151: where the rider may not be set down at the top of lift `l`: under the station's roof (an
 * OSM footprint near the top station node, open since FEAT-323 so the collider no longer keeps the rider
 * out), inside the drawn terminal (world/LiftModels terminalGeometry: 14 x 7 m chair, 20 x 9 m gondola,
 * centred on the node along the line), or under the cable coming up to it. True: keep out.
 */
export function unloadKeepOut(l: LiftLine, buildings: readonly BuildingFeature[]): (x: number, y: number) => boolean {
  const dx = l.top[0] - l.bottom[0], dy = l.top[1] - l.bottom[1], d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const nx = l.top[0] + ux * LOAD_OFFSET, ny = l.top[1] + uy * LOAD_OFFSET; // the top station node
  const [tl, tw] = l.kind === 'gondola' ? [20, 9] : l.kind === 'chair' ? [14, 7] : [4, 4];
  const roofs = buildings.filter((b) => b.points.length >= 3 && polyDist(b.points, nx, ny) < 60).map((b) => b.points as number[][]);
  return (x, y) => {
    const a = (x - nx) * ux + (y - ny) * uy, c = Math.abs((x - nx) * uy - (y - ny) * ux);
    if (Math.abs(a) < tl / 2 + STATION_CLEAR && c < tw / 2 + STATION_CLEAR) return true;
    if (a < 0 && a > -(d + 2 * LOAD_OFFSET) && c < CABLE_CLEAR) return true;
    for (const r of roofs) if (polyDist(r, x, y) < STATION_CLEAR) return true;
    return false;
  };
}

export class LiftRide<L extends LiftLine = LiftLine> {
  lift: L | null = null;
  up = 0; // metres travelled from the bottom terminal
  /** nearest boardable lift within PROMPT_RANGE (for the prompt card), and its distance */
  nearby: L | null = null;
  nearbyDist = Infinity;
  /** cable height at the rider's position along the line (for the rider's own chair hanger) */
  cableY = 0;
  /** true on the frame the chair passes a tower (for the clunk sound) */
  passedTower = false;
  /** true when the current lift carries the rider above the snow (chair, gondola) */
  get airborneRide(): boolean { return !!this.lift && (this.lift.kind === 'chair' || this.lift.kind === 'gondola'); }
  /** true when `nearby` is close and slow enough to board */
  canBoard = false;
  /** FEAT-323: the boarding zone radius in metres (BOARD_RANGE, or ?boardRange=) */
  boardRange = BOARD_RANGE;
  /** FEAT-323: every lift whose boarding zone the rider is in, nearest first; two or more open the lift picker on E */
  choices: L[] = [];
  /** reason shown when in range but not boardable: 'fast' | 'air' | '' */
  blocker: 'fast' | 'air' | '' = '';
  private readonly seat: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly seat2: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(private readonly pack: Pack, private readonly lifts: LiftNetwork<L>, private readonly collider: Collider | null = null) {}

  get riding(): boolean { return this.lift !== null; }
  /**
   * FEAT-073 / BUG-150: a lift-line maze's corral, which also boards where a long maze reaches past the
   * zone. Anywhere inside the zone (the gold ring) boards regardless; null: no corrals.
   */
  gate: ((l: L, x: number, y: number) => boolean) | null = null;

  /** Call every frame before the physics step. Returns true when the rider is on a lift (physics skipped). */
  /** true while fast-forwarding (for the prompt) */
  fast = false;

  update(rider: Rider, dt: number, boardPressed: boolean, fastHeld = false): boolean {
    if (!this.lift) {
      // FEAT-323: every lift whose zone (the gold ring, BUG-150) the rider is in, nearest first, plus any
      // whose maze corral reaches past the ring and holds the rider (FEAT-073); else the nearest within the prompt range
      const gate = this.gate, r = this.boardRange;
      this.choices = this.lifts.boardableNear(rider.x, rider.y, gate ? Math.max(r, MAZE_REACH) : r)
        .filter((l) => Math.hypot(l.bottom[0] - rider.x, l.bottom[1] - rider.y) < r || (gate !== null && gate(l, rider.x, rider.y)));
      this.nearby = this.choices[0] ?? this.lifts.nearestBoardable(rider.x, rider.y, PROMPT_RANGE);
      this.nearbyDist = this.nearby ? Math.hypot(this.nearby.bottom[0] - rider.x, this.nearby.bottom[1] - rider.y) : Infinity;
      const inZone = this.choices.length > 0;
      this.blocker = !inZone ? '' : !rider.onGround ? 'air' : rider.speed > BOARD_SPEED ? 'fast' : '';
      this.canBoard = inZone && this.blocker === '';
      // loading maze: coast to a stop inside the zone (within COAST_RANGE: the wider zone does not brake a rider passing by)
      if (inZone && this.nearbyDist < COAST_RANGE && rider.onGround && rider.speed > 0.5) { const f = Math.exp(-dt * 1.2); rider.vx *= f; rider.vy *= f; }
      // two or more lifts in range: E opens the lift picker (states/LiftPickState.ts), which boards with boardLift
      if (boardPressed && this.canBoard && this.nearby && this.choices.length === 1) this.board(rider, this.nearby);
      return this.lift !== null;
    }
    const len = this.lifts.rideLength(this.lift);
    if (boardPressed) this.up = len; // skip to the top
    const before = this.up;
    this.fast = fastHeld;
    this.up += this.lift.speed * dt * RIDE_SPEEDUP * (fastHeld ? FAST_FORWARD : 1);
    this.passedTower = this.lift.towerUp.some((t) => t > before + LOAD_OFFSET && t <= this.up + LOAD_OFFSET);
    if (this.up >= len) { this.unload(rider); return false; }
    this.place(rider);
    return true;
  }

  /** FEAT-323: board a lift picked from `choices` (the lift picker). False when it is no longer in reach. */
  boardLift(rider: Rider, l: L): boolean {
    if (this.lift || !this.canBoard || !this.choices.includes(l)) return false;
    this.board(rider, l);
    return true;
  }

  private board(rider: Rider, l: L): void {
    rider.strapInNow(); // walked up on foot: strap in as you load
    this.lift = l;
    this.up = 0;
    this.choices = []; this.canBoard = false;
    rider.vx = rider.vy = rider.vz = 0; rider.speed = 0; rider.skid = 0; rider.crashed = 0;
    this.place(rider);
  }

  private place(rider: Rider): void {
    const l = this.lift!;
    this.lifts.seatAt(l, this.up, this.seat);
    this.cableY = this.seat.z + l.riderDrop;
    this.lifts.seatAt(l, Math.min(this.lifts.rideLength(l), this.up + 2), this.seat2);
    rider.x = this.seat.x; rider.y = this.seat.y;
    const len = this.lifts.rideLength(l);
    const ground = this.pack.groundHeight(rider.x, rider.y);
    if (l.kind === 'surface' || l.kind === 'carpet') {
      // towed or carried on the snow
      rider.z = ground;
    } else {
      // the chair dips to the snow at the loading and unloading points
      const edge = Math.min(this.up, len - this.up);
      rider.z = edge < 12 ? ground + 0.7 + (this.seat.z - ground - 0.7) * Math.max(0, edge / 12) : this.seat.z;
    }
    rider.onGround = true;
    rider.normal[0] = 0; rider.normal[1] = 0; rider.normal[2] = 1;
    // face the direction of travel
    const dx = this.seat2.x - this.seat.x, dy = this.seat2.y - this.seat.y;
    if (Math.hypot(dx, dy) > 0.01) rider.heading = rider.boardYaw = Math.atan2(dx, dy);
    // velocity for the chase camera (it follows the velocity direction above 2.5 m/s)
    const dl = Math.hypot(dx, dy) || 1;
    rider.vx = (dx / dl) * l.speed; rider.vy = (dy / dl) * l.speed;
    rider.speed = l.speed;
    if (l.kind === 'surface' || l.kind === 'carpet') { const n = this.pack.groundNormal(rider.x, rider.y) as number[]; rider.normal[0] = n[0]; rider.normal[1] = n[1]; rider.normal[2] = n[2]; }
  }

  private unload(rider: Rider): void {
    const l = this.lift!;
    this.lift = null;
    const spot = this.unloadSpot(l);
    rider.reset(spot[0], spot[1], spot[2]);
    if (l.kind === 'gondola') {
      // BUG-058: out of the cabin on foot with the board from the rack, and strapping in where you stand
      rider.onFoot = true; rider.strapState = 'on'; rider.strapT = 0;
      rider.vx = rider.vy = rider.vz = 0; rider.speed = 0;
      return;
    }
    // BUG-151: push off the chair, moving away from the station
    rider.vx = Math.sin(spot[2]) * UNLOAD_PUSH; rider.vy = Math.cos(spot[2]) * UNLOAD_PUSH; rider.speed = UNLOAD_PUSH;
  }

  /**
   * Where the rider steps off at the top of `l`, and the heading they push off on: beside the station on
   * the chair's side, out from under its roof and the cable (BUG-151), moved to clear snow by clearSpot.
   * Returns [x, y, heading]; public for liftunloadcheck.mjs.
   */
  unloadSpot(l: L): [number, number, number] {
    const dirX = l.top[0] - l.bottom[0], dirY = l.top[1] - l.bottom[1];
    const dl = Math.hypot(dirX, dirY) || 1;
    const ux = dirX / dl, uy = dirY / dl;
    const side = l.upFromA ? 1 : -1;
    const nx = l.top[0] + ux * LOAD_OFFSET, ny = l.top[1] + uy * LOAD_OFFSET; // the top station node
    const halfW = l.kind === 'gondola' ? 4.5 : 3.5;
    const x = nx + l.lateral[0] * (halfW + 6) * side, y = ny + l.lateral[1] * (halfW + 6) * side;
    return this.clearSpot(x, y, Math.atan2(l.lateral[0] * side, l.lateral[1] * side), unloadKeepOut(l, this.pack.features.buildings ?? []), nx, ny);
  }

  /** Downhill heading at (x, y), or `fallback` on flat ground. */
  private downhill(x: number, y: number, fallback: number): number {
    const n = this.pack.groundNormal(x, y) as number[];
    return Math.hypot(n[0], n[1]) > 0.02 ? Math.atan2(n[0], n[1]) : fallback;
  }

  /**
   * The unloading point is often inside the OSM footprint of the top terminal or a summit lodge.
   * Search rings outward from the nominal point (2 m steps, out to UNLOAD_SEARCH) for the nearest
   * spot clear of buildings and trees, outside `keepOut` (the station and the cable, BUG-151), with a
   * clear run downhill (or straight away from the station) and at least UNLOAD_MIN_SLOPE; on
   * each ring take the lowest one, which puts the rider on the downhill side. Returns [x, y, heading].
   */
  private clearSpot(x0: number, y0: number, fallback: number, keepOut: (x: number, y: number) => boolean, sx: number, sy: number): [number, number, number] {
    const col = this.collider;
    const free = (x: number, y: number, clear: number): boolean => {
      if (keepOut(x, y)) return false;
      const z = this.pack.groundHeight(x, y);
      return !Number.isNaN(z) && (!col || !col.blocked(x, y, z, clear));
    };
    // BUG-151: a clear run that leads away from the station (sx, sy), never back under it
    const runClear = (x: number, y: number, h: number): boolean => {
      const dx = Math.sin(h), dy = Math.cos(h);
      if (dx * (x - sx) + dy * (y - sy) < 0) return false;
      for (let t = 1; t <= UNLOAD_RUN; t++) if (!free(x + dx * t, y + dy * t, 0.5)) return false;
      return true;
    };
    /** downhill, or straight away from the station when downhill leads back toward it */
    const heading = (x: number, y: number): number => {
      const h = this.downhill(x, y, fallback);
      return Math.sin(h) * (x - sx) + Math.cos(h) * (y - sy) >= 0 ? h : Math.atan2(x - sx, y - sy);
    };
    // prefer a spot steep enough to glide away from; the nearest clear spot on flatter ground is the
    // fallback, and from there the rider can skate off (X, FEAT-085)
    const minNz = Math.cos(UNLOAD_MIN_SLOPE * (Math.PI / 180));
    let flat: [number, number, number] | null = null;
    for (let r = 0; r <= UNLOAD_SEARCH; r += 2) {
      const steps = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 2);
      let best: [number, number, number] | null = null, bestZ = Infinity;
      let bestFlat: [number, number, number] | null = null, bestFlatZ = Infinity;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const x = x0 + Math.cos(a) * r, y = y0 + Math.sin(a) * r;
        if (!free(x, y, UNLOAD_CLEAR)) continue;
        const h = heading(x, y);
        if (!runClear(x, y, h)) continue;
        const z = this.pack.groundHeight(x, y);
        const steep = (this.pack.groundNormal(x, y) as number[])[2] <= minNz;
        if (steep && z < bestZ) { bestZ = z; best = [x, y, h]; }
        if (!steep && z < bestFlatZ) { bestFlatZ = z; bestFlat = [x, y, h]; }
      }
      if (best) return best;
      if (!flat && bestFlat) flat = bestFlat;
    }
    return flat ?? [x0, y0, heading(x0, y0)];
  }

  /** Leave the lift at the current spot (used on R while riding). */
  cancel(): void { this.lift = null; }
}
