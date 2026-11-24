import * as THREE from 'three';
import { sightClear } from './Labels';
import type { Pack } from '../pack/Pack';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { LiftRuntime } from '../world/Lifts';
import type { RunsOverlay } from '../world/RunsOverlay';
import type { DropZone } from '../world/DropZones';
import { hotSwap } from '../core/hot';

/**
 * FEAT-054: the map's 3D mode, the mountain view. The eye camera orbits the whole resort (the far terrain,
 * the impostors and the piste lines; the near detail streams only round the drop), with the lifts, peaks,
 * lodges, runs, the rider and the drop zones (world/DropZones.ts) drawn over it. Picking a zone flies the
 * camera down to it, waits there until the ground and the trees have streamed in, finds the spot on the snow
 * (LiftRide), lands behind it in the chase camera's pose and hands the drop to the session.
 * The map's state (states/MapState.ts) owns it: the keys and the controller come in through update().
 */
const FOV = 50;
/** the orbit's tilt limits (rad, down is negative) and its nearest distance (m) */
const PITCH_MIN = -1.45, PITCH_MAX = -0.2, DIST_MIN = 250;
/** m the overview camera stays above the ground */
const CAM_CLEAR = 40;
/** the fly-in stops here above the zone while the ground and the trees under it stream in (m, rad) */
const HOVER_DIST = 220, HOVER_PITCH = -0.95;
/** the chase camera's pose behind the rider (ChaseCamera.snapTo's CHASE_SLOW), so the hand-over doesn't jump */
const CHASE_BACK = 5.5, CHASE_UP = 4.2, CHASE_LOOK = 1.2;
/** s: the landing, and the longest wait for the streaming at each stop */
const LAND_S = 1.2, WAIT_MAX_S = 8;
/** px: how close the cursor (or the screen centre, on a controller) is to a zone to pick it */
const PICK_PX = 18;
/** run names show nearer than this (m of orbit distance) */
const RUN_NAMES_DIST = 3500;
/** a named building this far (m) above the lowest lift is a mountain lodge, not the base village */
const LODGE_ABOVE = 100;
/** ...and this close (m) to a run */
const LODGE_NEAR_RUN = 120;
/** px: a marker this close to a stronger one on screen is left out (zoom in to see it) */
const MARK_PX = 18;
/** px: the middle of a trial flag from the foot of its pole (where it is clicked) */
const FLAG_DX = 5, FLAG_DY = 12;
const FT = 3.28084;
/** the overview's tilt (rad) */
const HOME_PITCH = -0.7;

/** a camera pose: position (pack m), yaw (rad clockwise from north), pitch (rad, down negative) */
interface Pose { x: number; y: number; z: number; yaw: number; pitch: number }
type Phase = 'fly' | 'wait' | 'land' | 'wait2';
interface Flight { zone: DropZone<LiftRuntime>; phase: Phase; t: number; dur: number; from: Pose; to: Pose; quiet: number; spot: [number, number, number] }
interface Mark { name: string; kind: 'zone' | 'peak' | 'lodge' | 'run' | 'lift'; x: number; y: number; z: number; zone: DropZone<LiftRuntime> | null; seen: boolean; shown: boolean; sx: number; sy: number }

/** what the map's state hands in each frame from a controller: rates -1..1 (turn right, tilt toward the horizon, slide right and
 *  forward, zoom in), the zone step (LB / RB), the pick (Cross), whether the pad is in use, and the help line to show */
export interface MountainInput { yaw: number; pitch: number; panX: number; panY: number; zoom: number; cycle: number; pick: boolean; pad: boolean; help: string }

export interface MountainParts {
  pack: Pack; cam: ChaseCamera; rider: Rider; liftRide: LiftRide<LiftRuntime>; lifts: readonly LiftRuntime[]; runs: RunsOverlay; zones: DropZone<LiftRuntime>[];
  metric(): boolean;
  /** the ground, the tiles or the trees round the camera are still downloading or building */
  busy(): boolean;
  /** why a drop-in can't happen now (Outrun), or null */
  blocked(): string | null;
  /** the 2D map button */
  onToggle(): void;
  /** put the rider down at (x, y) facing h (the map closes) */
  drop(zone: DropZone<LiftRuntime>, x: number, y: number, h: number): void;
}

export class MountainView {
  on = false;
  /** the orbit: the point looked at (pack m), the distance to it (m), yaw and pitch (rad) */
  tx = 0; ty = 0; dist = 4000; yaw = 0; pitch = HOME_PITCH;
  flight: Flight | null = null;
  private readonly marks: Mark[] = [];
  private readonly wrap: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly info: HTMLDivElement;
  private readonly home: { tx: number; ty: number; dist: number; yaw: number };
  private readonly maxDist: number;
  private readonly v = new THREE.Vector3();
  /** the lifts drawn (not the carpets) */
  private readonly lifts: readonly LiftRuntime[];
  private hover: DropZone<LiftRuntime> | null = null;
  private focus = -1;
  private frame = 0;
  private saved: { mode: ChaseCamera['mode']; eye: ReturnType<ChaseCamera['eyePose']>; pos: THREE.Vector3; quat: THREE.Quaternion; runs: boolean } | null = null;
  private readonly keys = new Set<string>();
  private readonly listeners: [EventTarget, string, EventListener][] = [];
  private msg = '';

  constructor(private readonly p: MountainParts) {
    const { pack } = p;
    // the orbit's home: over the lifts, from the base side looking up the mountain, all of them in view
    const lifts = this.lifts = p.lifts.filter((l) => l.kind !== 'carpet');
    const pts = lifts.length ? lifts.flatMap((l) => [l.bottom, l.top]) : [[pack.meta.start.x, pack.meta.start.y, 0]];
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const up = lifts.reduce((a, l) => [a[0] + l.top[0] - l.bottom[0], a[1] + l.top[1] - l.bottom[1]], [0, 0]);
    const r = Math.max(800, Math.hypot(x1 - x0, y1 - y0) / 2);
    this.home = { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, dist: r / Math.tan(FOV * Math.PI / 360) * 0.8, yaw: lifts.length ? Math.atan2(up[0], up[1]) : 0 };
    this.maxDist = this.home.dist * 2.5;
    this.reset();
    // what is labelled: the zones, the peaks inside the resort, the mountain lodges, the named runs (near), the lifts
    for (const z of p.zones) this.marks.push(this.mark(z.name, 'zone', z.x, z.y, z.z, z));
    const b = pack.meta.bounds;
    for (const k of pack.features.peaks) if (k.name && k.x > b.minX && k.x < b.maxX && k.y > b.minY && k.y < b.maxY && !p.zones.some((z) => z.name === k.name)) this.marks.push(this.mark(k.name, 'peak', k.x, k.y, k.z));
    const base = lifts.length ? Math.min(...lifts.map((l) => l.bottom[2])) : -Infinity;
    for (const bld of pack.features.buildings) {
      if (!bld.name || bld.zBase < base + LODGE_ABOVE) continue;
      const cx = bld.points.reduce((a, q) => a + q[0], 0) / bld.points.length, cy = bld.points.reduce((a, q) => a + q[1], 0) / bld.points.length;
      if (!pack.features.runs.some((run) => run.points.some((q) => Math.hypot(q[0] - cx, q[1] - cy) < LODGE_NEAR_RUN))) continue;
      this.marks.push(this.mark(bld.name, 'lodge', cx, cy, bld.zBase + bld.height));
    }
    const runNames = new Set<string>();
    for (const run of pack.features.runs) {
      if (!run.name || run.area || runNames.has(run.name) || run.points.length < 2) continue;
      runNames.add(run.name);
      const m = run.points[Math.floor(run.points.length / 2)];
      this.marks.push(this.mark(run.name, 'run', m[0], m[1], m[2]));
    }
    // a lift's name is on its top's zone; one folded into another zone's is named halfway up its line
    for (const l of lifts) if (l.feature.name && !p.zones.some((z) => z.name === l.feature.name)) this.marks.push(this.mark(l.feature.name, 'lift', (l.bottom[0] + l.top[0]) / 2, (l.bottom[1] + l.top[1]) / 2, (l.bottom[2] + l.top[2]) / 2 + 15));

    this.wrap = document.createElement('div');
    this.wrap.id = 'mountain-view';
    Object.assign(this.wrap.style, { position: 'fixed', inset: '0', display: 'none', zIndex: '10', cursor: 'grab' });
    this.canvas = document.createElement('canvas');
    this.wrap.appendChild(this.canvas);
    this.info = document.createElement('div');
    Object.assign(this.info.style, { position: 'absolute', left: '16px', top: '12px', right: '140px', color: '#fff', font: '14px system-ui, sans-serif', textShadow: '0 1px 3px #000', pointerEvents: 'none' });
    this.wrap.appendChild(this.info);
    const btn = document.createElement('button');
    btn.textContent = '2D map';
    btn.className = 'map-view-toggle';
    btn.addEventListener('click', () => p.onToggle());
    this.wrap.appendChild(btn);
    document.body.appendChild(this.wrap);
    this.listen();
  }

  private mark(name: string, kind: Mark['kind'], x: number, y: number, z: number, zone: DropZone<LiftRuntime> | null = null): Mark {
    return { name, kind, x, y, z, zone, seen: true, shown: false, sx: 0, sy: 0 };
  }

  /** the overview over the whole resort (Home) */
  reset(): void { const h = this.home; this.tx = h.tx; this.ty = h.ty; this.dist = h.dist; this.yaw = h.yaw; this.pitch = HOME_PITCH; this.focus = -1; }

  /** Open over the map: the eye camera takes over (its old pose is kept for the way out), the piste lines show. */
  enter(): void {
    if (this.on) return;
    const { cam, runs } = this.p;
    this.saved = { mode: cam.mode, eye: cam.eyePose(), pos: cam.camera.position.clone(), quat: cam.camera.quaternion.clone(), runs: runs.group.visible };
    this.on = true; this.msg = ''; this.focus = -1; this.hover = null;
    runs.group.visible = true;
    this.wrap.style.display = 'block';
    this.place(this.orbitPose());
  }

  /** Back to the 2D map or to riding: the camera as it was (the drop sets its own), the flight dropped. */
  leave(): void {
    if (!this.on) return;
    const { cam, runs, rider } = this.p, s = this.saved!;
    this.on = false; this.flight = null;
    this.wrap.style.display = 'none';
    runs.group.visible = s.runs;
    if (s.mode === 'eye') cam.setEye(s.eye.x, s.eye.y, s.eye.h, s.eye.pitch, s.eye.fov, s.eye.eye);
    else if (s.mode === 'free') { cam.camera.position.copy(s.pos); cam.camera.quaternion.copy(s.quat); cam.enterFree(); }
    else { cam.mode = s.mode; cam.snapTo(rider); }
  }

  /** One frame before the world's: the orbit (or the flight) moves the eye camera. */
  update(dt: number, k: MountainInput): void {
    if (!this.on) return;
    if (this.flight) { this.fly(dt); if (this.on) this.helpLine(k.help); return; }
    // the keys: WASD slide the map, the arrows turn and tilt, Q / E or - / + zoom
    const ks = this.keys;
    const held = (...c: string[]) => c.some((x) => ks.has(x)) ? 1 : 0;
    const yaw = k.yaw + held('ArrowRight') - held('ArrowLeft');
    const pitch = k.pitch + held('ArrowUp') - held('ArrowDown');
    const zoom = k.zoom + held('KeyE', 'Equal', 'NumpadAdd') - held('KeyQ', 'Minus', 'NumpadSubtract');
    const panX = k.panX + held('KeyD') - held('KeyA'), panY = k.panY + held('KeyW') - held('KeyS');
    this.yaw += yaw * dt * 1.2;
    this.pitch = THREE.MathUtils.clamp(this.pitch + pitch * dt * 0.8, PITCH_MIN, PITCH_MAX);
    this.zoomBy(Math.exp(-zoom * dt * 1.5));
    if (panX || panY) this.pan(panX * dt * 0.8 * this.dist, panY * dt * 0.8 * this.dist);
    if (k.cycle) this.cycle(k.cycle);
    // a controller picks the zone nearest the middle of the screen (the crosshair)
    if (k.pad) this.hover = this.nearest(window.innerWidth / 2, window.innerHeight / 2, PICK_PX * 3);
    const at = this.focus >= 0 ? this.p.zones[this.focus] : this.hover;
    if (k.pick && at) this.pick(at);
    if (!this.flight) this.place(this.orbitPose());
    this.helpLine(k.help);
  }

  /** After the world's frame (the camera has moved): the labels and markers over it. */
  draw(): void {
    if (!this.on) return;
    const c = this.canvas, W = window.innerWidth, H = window.innerHeight;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const camera = this.p.cam.camera, cp = camera.position;
    // sight lines at 15 Hz (as the horizon labels)
    const recheck = this.frame++ % 4 === 0;
    for (const m of this.marks) {
      const s = this.project(m.x, m.y, m.z + 3);
      if (!s) { m.sx = NaN; continue; }
      m.sx = s[0]; m.sy = s[1];
      if (recheck) m.seen = sightClear(this.p.pack, cp.x, -cp.z, cp.y, m.x, m.y, m.z + 3);
    }
    // lifts: red lines station to station
    ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(215,38,61,.95)'; ctx.lineWidth = 2.5;
    for (const l of this.lifts) {
      const a = this.project(l.bottom[0], l.bottom[1], l.bottom[2] + 10), b = this.project(l.top[0], l.top[1], l.top[2] + 10);
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    const placed: number[][] = [];
    const free = (b: number[]) => !placed.some((q) => b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1]);
    const label = (text: string, x: number, y: number, color: string, font: string, force = false): void => {
      ctx.font = font;
      const w = ctx.measureText(text).width, box = [x - w / 2 - 2, y - 16, x + w / 2 + 2, y + 2];
      if (!force && !free(box)) return;
      placed.push(box);
      ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,14,24,.85)'; ctx.strokeText(text, x, y - 4);
      ctx.fillStyle = color; ctx.fillText(text, x, y - 4);
    };
    const target = this.flight?.zone ?? (this.focus >= 0 ? this.p.zones[this.focus] : this.hover);
    // the rider first, then the picked zone, then the rest by rank (zones, peaks, lifts, lodges, runs near)
    const r = this.p.rider, rs = this.project(r.x, r.y, r.z + 2);
    if (rs) {
      ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(rs[0], rs[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      label('You', rs[0], rs[1] - 8, '#ffd0cc', '600 13px system-ui, sans-serif', true);
    }
    const order: Mark['kind'][] = ['zone', 'peak', 'lift', 'lodge', 'run'];
    const zoneOrder: DropZone['kind'][] = ['lift', 'peak', 'run', 'trial'];
    const rank = (m: Mark) => order.indexOf(m.kind) * 10 + (m.zone ? zoneOrder.indexOf(m.zone.kind) : 0);
    // inside a rank the nearer one wins (a far lift top lands on screen next to a near one in an oblique view)
    const near = (m: Mark) => Math.hypot(m.x - cp.x, m.y + cp.z);
    const isHot = (m: Mark) => !!m.zone && m.zone === target;
    const ranked = this.marks.filter((m) => !Number.isNaN(m.sx) && m.seen && (m.kind !== 'run' || this.dist < RUN_NAMES_DIST))
      .sort((a, b) => Number(isHot(b)) - Number(isHot(a)) || rank(a) - rank(b) || near(a) - near(b));
    // markers: a weaker one too close on screen to one already drawn waits for the zoom (and can't be clicked). The trial
    // flags stand above their pole, clear of the dots (a course starts at its run's top), so they only make room for each other
    const dots: number[][] = [], flags: number[][] = [];
    for (const m of this.marks) m.shown = false;
    for (const m of ranked) {
      const hot = isHot(m);
      if (m.kind === 'zone' || m.kind === 'peak' || m.kind === 'lodge') {
        const mine = m.zone?.kind === 'trial' ? flags : dots;
        if (!hot && mine.some((d) => Math.hypot(d[0] - m.sx, d[1] - m.sy) < MARK_PX)) continue;
        mine.push([m.sx, m.sy]); m.shown = true;
      }
      if (m.zone) this.zoneMarker(ctx, m.zone, m.sx, m.sy, hot);
      else if (m.kind === 'peak') { ctx.fillStyle = '#e8b931'; ctx.beginPath(); ctx.moveTo(m.sx, m.sy - 7); ctx.lineTo(m.sx + 6, m.sy + 3); ctx.lineTo(m.sx - 6, m.sy + 3); ctx.closePath(); ctx.fill(); }
      else if (m.kind === 'lodge') { ctx.fillStyle = '#c08a4b'; ctx.fillRect(m.sx - 4, m.sy - 4, 8, 8); }
      const alt = m.kind === 'zone' || m.kind === 'peak' ? ` ${this.height(m.z)}` : '';
      const color = m.kind === 'zone' ? (hot ? '#ffe08a' : '#fff') : m.kind === 'peak' ? '#f5dd8c' : m.kind === 'lift' ? '#ffb3bd' : m.kind === 'lodge' ? '#f1d2ab' : '#cfe0ff';
      label(m.name + alt, m.sx, m.sy - 8, color, hot ? '700 15px system-ui, sans-serif' : m.kind === 'run' ? '11px system-ui, sans-serif' : '600 12px system-ui, sans-serif', hot);
    }
  }

  private zoneMarker(ctx: CanvasRenderingContext2D, z: DropZone<LiftRuntime>, x: number, y: number, hot: boolean): void {
    if (z.kind === 'trial') {
      // a flag on a pole: the time trial starts
      ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 16); ctx.stroke();
      ctx.fillStyle = '#facc15'; ctx.beginPath(); ctx.moveTo(x, y - 16); ctx.lineTo(x + 11, y - 12); ctx.lineTo(x, y - 8); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = z.kind === 'lift' ? '#38bdf8' : z.kind === 'peak' ? '#e8b931' : '#a78bfa';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, hot ? 8 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (hot) { ctx.strokeStyle = '#ffe08a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 14 + 2 * Math.sin(performance.now() / 160), 0, Math.PI * 2); ctx.stroke(); }
  }

  /** Fly down to a zone (a click on it, Enter or Cross on the picked one). */
  pick(zone: DropZone<LiftRuntime>): void {
    const why = this.p.blocked();
    if (why) { this.msg = `No drop-ins ${why}`; return; }
    this.request(zone.x, zone.y);
    const from = this.poseNow(), gz = this.ground(zone.x, zone.y);
    const to = this.orbitPose(zone.x, zone.y, Math.max(gz, zone.z), HOVER_DIST, this.yaw, HOVER_PITCH);
    const far = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    this.flight = { zone, phase: 'fly', t: 0, dur: THREE.MathUtils.clamp(1.4 + far / 5000, 1.6, 3.5), from, to, quiet: 0, spot: [zone.x, zone.y, 0] };
    this.wrap.style.cursor = 'progress';
  }

  /** the flight: fly to the stop over the zone, wait for the streaming, land behind the spot, wait again, drop */
  private fly(dt: number): void {
    const f = this.flight!;
    f.t += dt;
    if (f.phase === 'fly' || f.phase === 'land') {
      const k = Math.min(1, f.t / f.dur), e = k * k * (3 - 2 * k);
      const arc = f.phase === 'fly' ? Math.sin(Math.PI * k) * 0.12 * Math.hypot(f.to.x - f.from.x, f.to.y - f.from.y) : 0;
      const dyaw = Math.atan2(Math.sin(f.to.yaw - f.from.yaw), Math.cos(f.to.yaw - f.from.yaw));
      this.place({ x: f.from.x + (f.to.x - f.from.x) * e, y: f.from.y + (f.to.y - f.from.y) * e, z: f.from.z + (f.to.z - f.from.z) * e + arc, yaw: f.from.yaw + dyaw * e, pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * e });
      if (k >= 1) { f.phase = f.phase === 'fly' ? 'wait' : 'wait2'; f.t = 0; f.quiet = 0; }
      return;
    }
    // waiting: three quiet frames (nothing downloading or building), or WAIT_MAX_S (never stuck in the air). The ground round
    // the zone is asked for again each frame: the tiles the overview's far camera evicted (RideFrame keeps 3 km of them round
    // the camera) are in flight, so busy, until they are back
    const z = f.zone;
    this.request(z.x, z.y);
    f.quiet = this.p.busy() ? 0 : f.quiet + 1;
    this.msg = `Dropping in at ${z.name}...`;
    if (f.quiet < 3 && f.t < WAIT_MAX_S) return;
    if (f.phase === 'wait') {
      // the trees are in: the spot on the snow, then down to the chase camera's pose behind it
      const s = f.spot = this.spot(z);
      const gz = this.ground(s[0], s[1]);
      f.from = this.poseNow();
      f.to = { x: s[0] - Math.sin(s[2]) * CHASE_BACK, y: s[1] - Math.cos(s[2]) * CHASE_BACK, z: gz + CHASE_UP, yaw: s[2], pitch: Math.atan2(CHASE_LOOK - CHASE_UP, CHASE_BACK) };
      f.phase = 'land'; f.t = 0; f.dur = LAND_S;
      return;
    }
    const [x, y, h] = f.spot;
    this.leave();
    this.p.drop(z, x, y, h);
  }

  /** where the rider goes down facing downhill: a few metres above a course's start; else clear snow near the zone (a lift
   *  top: near where its chair puts you off, out of the station) */
  private spot(z: DropZone<LiftRuntime>): [number, number, number] {
    if (z.course) { const c = z.course; return [c.start[0] - c.dir[0] * 6, c.start[1] - c.dir[1] * 6, Math.atan2(c.dir[0], c.dir[1])]; }
    const [x, y] = z.lift ? this.p.liftRide.unloadSpot(z.lift) : [z.x, z.y];
    return this.p.liftRide.dropSpot(x, y);
  }

  /** the fine ground and the mask round the drop (as the 2D map's drop-in asks) */
  private request(x: number, y: number): void {
    this.p.pack.fine?.request(x - 600, y - 600, x + 600, y + 600);
    this.p.pack.mask?.request(x - 600, y - 600, x + 600, y + 600);
  }

  // ---------------------------------------------------------------- the camera
  private ground(x: number, y: number): number { const g = this.p.pack.groundHeight(x, y); return Number.isFinite(g) ? g : 0; }

  /** the camera pose orbiting (tx, ty, tz) */
  private orbitPose(tx = this.tx, ty = this.ty, tz = this.ground(this.tx, this.ty), dist = this.dist, yaw = this.yaw, pitch = this.pitch): Pose {
    const c = Math.cos(pitch);
    const x = tx - Math.sin(yaw) * c * dist, y = ty - Math.cos(yaw) * c * dist;
    return { x, y, z: Math.max(tz - Math.sin(pitch) * dist, this.ground(x, y) + CAM_CLEAR), yaw, pitch };
  }

  /** the eye camera's pose now (the flight starts from it) */
  private poseNow(): Pose {
    const e = this.p.cam.eyePose();
    return { x: e.x, y: e.y, z: this.ground(e.x, e.y) + e.eye, yaw: e.h * Math.PI / 180, pitch: e.pitch * Math.PI / 180 };
  }

  private place(p: Pose): void {
    this.p.cam.setEye(p.x, p.y, p.yaw * 180 / Math.PI, p.pitch * 180 / Math.PI, FOV, p.z - this.ground(p.x, p.y));
  }

  private zoomBy(f: number): void { this.dist = THREE.MathUtils.clamp(this.dist * f, DIST_MIN, this.maxDist); }

  /** move the point looked at by (right, forward) metres of the view, kept inside the pack */
  private pan(right: number, fwd: number): void {
    const b = this.p.pack.meta.bounds, s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.tx = THREE.MathUtils.clamp(this.tx + c * right + s * fwd, b.minX, b.maxX);
    this.ty = THREE.MathUtils.clamp(this.ty - s * right + c * fwd, b.minY, b.maxY);
    this.focus = -1;
  }

  /** Tab / LB / RB: the next (or previous) zone, the orbit turned to look at it */
  private cycle(step: number): void {
    const n = this.p.zones.length;
    if (!n) return;
    this.focus = ((this.focus < 0 ? (step > 0 ? -1 : 0) : this.focus) + step + n) % n;
    const z = this.p.zones[this.focus];
    this.tx = z.x; this.ty = z.y; this.dist = Math.min(this.dist, 2500);
  }

  private project(x: number, y: number, z: number): [number, number] | null {
    const v = this.v.set(x, z, -y).project(this.p.cam.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [(v.x + 1) / 2 * window.innerWidth, (1 - v.y) / 2 * window.innerHeight];
  }

  /** the drop zone drawn nearest a screen point, within `px` */
  private nearest(sx: number, sy: number, px = PICK_PX): DropZone<LiftRuntime> | null {
    let best = px, out: DropZone<LiftRuntime> | null = null;
    for (const m of this.marks) {
      if (!m.zone || !m.shown) continue;
      const d = m.zone.kind === 'trial' ? Math.hypot(m.sx + FLAG_DX - sx, m.sy - FLAG_DY - sy) : Math.hypot(m.sx - sx, m.sy - sy);
      if (d < best) { best = d; out = m.zone; }
    }
    return out;
  }

  private height(z: number): string { return this.p.metric() ? `${z.toFixed(0)} m` : `${(z * FT).toFixed(0)} ft`; }

  private helpLine(help: string): void {
    const z = this.focus >= 0 ? this.p.zones[this.focus] : this.hover;
    const kind = z ? { lift: 'top of the lift', peak: 'peak', run: 'top of the run', trial: 'time trial start' }[z.kind] : '';
    const what = z ? `<br><b>${z.name}</b> &middot; ${kind} &middot; ${this.height(z.z)}${z.also.length ? ` &middot; also ${z.also.slice(0, 4).join(', ')}${z.also.length > 4 ? ` +${z.also.length - 4}` : ''}` : ''}` : '';
    this.info.innerHTML = `<b>${this.p.pack.meta.name}</b> &middot; ${help}${what}${this.msg ? `<br>${this.msg}` : ''}`;
  }

  // ---------------------------------------------------------------- the mouse, the keys, touch
  private listen(): void {
    // one typed helper keeps the listeners for dispose(); the DOM's overloads don't take a union of targets, hence the one cast
    const on = <K extends keyof HTMLElementEventMap & keyof WindowEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts); this.listeners.push([t, type, fn as EventListener]);
    };
    const c = this.canvas;
    let down: { x: number; y: number; btn: number; moved: boolean } | null = null;
    on(c, 'contextmenu', (e) => e.preventDefault());
    on(c, 'mousedown', (e) => { down = { x: e.clientX, y: e.clientY, btn: e.button === 2 || e.shiftKey ? 2 : 0, moved: false }; });
    on(window, 'mousemove', (e) => {
      if (!this.on || this.flight) return;
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (!down.moved && Math.hypot(dx, dy) < 4) return;
        down.moved = true; down.x = e.clientX; down.y = e.clientY;
        this.wrap.style.cursor = 'grabbing';
        // left drag turns round the point (and tilts), right or Shift drag slides the map under the cursor
        if (down.btn === 2) this.pan(-dx / window.innerHeight * this.dist, dy / window.innerHeight * this.dist);
        else { this.yaw -= dx * 0.005; this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, PITCH_MIN, PITCH_MAX); }
        return;
      }
      if (e.target === c) { this.hover = this.nearest(e.clientX, e.clientY); if (this.hover) this.focus = -1; this.wrap.style.cursor = this.hover ? 'pointer' : 'grab'; }
    });
    on(window, 'mouseup', (e) => {
      const was = down; down = null;
      if (!this.on || this.flight) return;
      this.wrap.style.cursor = 'grab';
      if (was && !was.moved && was.btn === 0) { const z = this.nearest(e.clientX, e.clientY); if (z) this.pick(z); }
    });
    on(c, 'wheel', (e) => { e.preventDefault(); if (!this.flight) this.zoomBy(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    on(window, 'keydown', (e) => {
      if (!this.on) return;
      this.keys.add(e.code);
      if (this.flight || e.repeat) return;
      if (e.code === 'Tab') { e.preventDefault(); this.cycle(e.shiftKey ? -1 : 1); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { const z = this.focus >= 0 ? this.p.zones[this.focus] : this.hover; if (z) this.pick(z); }
      else if (e.code === 'Home' || e.code === 'Digit0') this.reset();
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
    // touch: one finger turns, two pinch to zoom, a tap picks
    let t0: { x: number; y: number; d: number; moved: boolean } | null = null;
    const tp = (e: TouchEvent) => { const a = e.touches[0], b = e.touches[1]; return { x: a.clientX, y: a.clientY, d: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0 }; };
    on(c, 'touchstart', (e) => { e.preventDefault(); t0 = { ...tp(e), moved: false }; }, { passive: false });
    on(c, 'touchmove', (e) => {
      e.preventDefault(); if (!t0 || this.flight) return;
      const q = tp(e);
      if (Math.hypot(q.x - t0.x, q.y - t0.y) > 6 || (t0.d && Math.abs(q.d - t0.d) > 6)) t0.moved = true;
      if (q.d && t0.d) this.zoomBy(t0.d / q.d);
      else { this.yaw -= (q.x - t0.x) * 0.005; this.pitch = THREE.MathUtils.clamp(this.pitch + (q.y - t0.y) * 0.004, PITCH_MIN, PITCH_MAX); }
      t0 = { ...q, moved: t0.moved };
    }, { passive: false });
    on(c, 'touchend', (e) => {
      if (t0 && !t0.moved && e.touches.length === 0 && !this.flight) { const z = this.nearest(t0.x, t0.y, PICK_PX * 1.5); if (z) this.pick(z); }
      if (e.touches.length === 0) t0 = null;
    });
  }

  dispose(): void {
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.wrap.remove();
  }
}

// FEAT-376: on the dev server an edit swaps in place (core/hot.ts)
if (import.meta.hot) import.meta.hot.accept((m) => hotSwap(import.meta, m));
