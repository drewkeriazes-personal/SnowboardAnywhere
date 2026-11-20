import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural lift geometry. Everything is built from primitives and merged into one
 * BufferGeometry per model so each lift draws towers and carriers as a single instanced mesh.
 * Units are metres; +Y up; models face -Z (the line direction is applied by the caller).
 * Vertex colours carry the paint so one vertexColors material covers all models.
 */
const GREY: [number, number, number] = [0.45, 0.47, 0.5];
const DARK: [number, number, number] = [0.14, 0.15, 0.17];
const STEEL: [number, number, number] = [0.6, 0.62, 0.66];
const RED: [number, number, number] = [0.75, 0.12, 0.14];
const GLASS: [number, number, number] = [0.35, 0.5, 0.65];
const CREAM: [number, number, number] = [0.9, 0.88, 0.82];

function paint(g: THREE.BufferGeometry, c: [number, number, number]): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, c: [number, number, number], ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return paint(g, c);
}
function cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, c: [number, number, number], seg = 8, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return paint(g, c);
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = parts.map((p) => { const q = p.toNonIndexed(); q.deleteAttribute('uv'); return q; });
  const out = mergeGeometries(clean, false)!;
  out.computeVertexNormals();
  return out;
}

/** Tower: tapered tubular mast on a footing, crossarm with sheave trains on both sides. Unit height (scale Y). */
export function towerGeometry(): THREE.BufferGeometry {
  // mast is 1 m tall here and scaled by the tower height; the head is built separately so it does not stretch
  return merge([
    cyl(0.32, 0.5, 1, 0, 0.5, 0, GREY, 10),
  ]);
}
/** Tower head at the top of the mast: crossarm, sheave assemblies, ladder cage hint. Lateral offset of the cables is 1.6 m. */
export function towerHeadGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(4.4, 0.32, 0.38, 0, 0, 0, GREY)); // crossarm along X (line is along Z)
  parts.push(box(0.7, 0.5, 0.5, 0, -0.35, 0, GREY)); // cap
  for (const side of [-1.6, 1.6]) {
    parts.push(box(0.22, 0.2, 1.9, side, 0.1, 0, DARK)); // sheave train beam
    for (const dz of [-0.7, -0.23, 0.23, 0.7]) parts.push(cyl(0.17, 0.17, 0.1, side, 0.3, dz, STEEL, 10, 0, Math.PI / 2)); // sheave wheels
  }
  parts.push(box(1.2, 0.08, 0.9, 0, -0.9, 0, DARK)); // work platform
  return merge(parts);
}
/** Concrete footing. */
export function footingGeometry(): THREE.BufferGeometry {
  return merge([box(1.6, 0.6, 1.6, 0, 0.3, 0, CREAM)]);
}

/** Detachable chair: grip, hanger arm, bench with backrest for `seats` riders, bail bar. Origin at the cable. */
export function chairGeometry(seats: number): THREE.BufferGeometry {
  const w = Math.max(1.6, seats * 0.55 + 0.3);
  const seatY = -2.1; // SEAT_DROP
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(0.36, 0.26, 0.6, 0, -0.1, 0, DARK)); // grip
  parts.push(cyl(0.05, 0.05, 1.7, 0, -1.05, 0, DARK, 6)); // hanger
  parts.push(box(w, 0.08, 0.5, 0, seatY, 0.05, DARK)); // seat
  parts.push(box(w, 0.6, 0.08, 0, seatY + 0.35, -0.2, DARK)); // backrest
  for (const s of [-1, 1]) parts.push(box(0.08, 0.5, 0.5, s * (w / 2 - 0.04), seatY + 0.3, 0.05, DARK)); // armrests
  parts.push(box(w - 0.1, 0.06, 0.06, 0, seatY + 0.95, 0.28, STEEL)); // bail bar (up)
  parts.push(cyl(0.04, 0.04, 0.5, 0, seatY + 0.05, 0.2, DARK, 6)); // seat post
  for (let i = 1; i < seats; i++) parts.push(box(0.04, 0.5, 0.06, -w / 2 + (w / seats) * i, seatY + 0.35, -0.17, GREY)); // seat dividers
  return merge(parts);
}

/** Gondola cabin: 8-person box with a window band, roof, grip arm. Origin at the cable. */
export function gondolaGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const top = -1.2, h = 2.3, w = 2.2, d = 2.6;
  parts.push(box(0.4, 0.3, 0.7, 0, -0.1, 0, DARK)); // grip
  parts.push(cyl(0.07, 0.07, 0.9, 0, -0.65, 0, DARK, 6)); // arm
  parts.push(box(w, 0.25, d, 0, top, 0, RED)); // roof
  parts.push(box(w, h * 0.45, d, 0, top - 0.25 - h * 0.225, 0, GLASS)); // window band
  parts.push(box(w + 0.02, h * 0.55, d + 0.02, 0, top - 0.25 - h * 0.45 - h * 0.275, 0, RED)); // lower body
  for (const s of [-1, 1]) parts.push(box(0.06, h, 0.06, s * (w / 2), top - 0.25 - h / 2, d / 2, DARK)); // door pillars
  parts.push(box(w * 0.6, 0.08, d * 0.6, 0, top - 0.25 - h - 0.04, 0, DARK)); // floor skid
  return merge(parts);
}

/**
 * BUG-058: the rider's own gondola cabin, which must read from inside as well as out. The carriers on the
 * line (gondolaGeometry) are single boxes seen from outside; from inside every face pointed away and was
 * culled. This one is built from thin panels (a box has faces on both sides), with the same outside
 * look: red lower body, a tinted window band, a red roof. Inside: a floor, two benches facing each other
 * across the line, light grey lower walls, window frames and mullions, a ceiling with a grab rail, and
 * the doors on the +X side with the board rack outside them. Origin at the grip, the line along Z.
 */
export const CABIN = {
  w: 2.2, d: 2.6,
  /** top of the floor */
  floorY: -3.7,
  /** bench seat top above the floor: the seated pose's feet rest on the floor (RiderChair) */
  benchH: 0.48,
  /** bench seat depth, out from the end wall */
  benchD: 0.45,
  /** window band bottom and top, and the roof's underside */
  sillY: -2.485, headY: -1.45,
  /** the board rack, outside the doors on the +X side: board centre (x, y) */
  rackX: 2.2 / 2 + 0.09, rackY: -2.85, rackZ: 0.5,
} as const;
/** m above the rider origin where the seated pose's backside rests (RiderChair puts the seat there) */
export const SEAT_TOP = 0.32;
/** BUG-058: the rider origin below the cable in a gondola, with the cabin's grip on the cable and the rider on its bench */
export const GONDOLA_RIDER_DROP = -(CABIN.floorY + CABIN.benchH) + SEAT_TOP;
const INSIDE: [number, number, number] = [0.72, 0.74, 0.76];
const SEAT: [number, number, number] = [0.2, 0.24, 0.32];

export function gondolaCabinGeometry(): { shell: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const { w, d, floorY, benchH, benchD, sillY, headY } = CABIN;
  const t = 0.04, bottom = floorY - 0.05, lowH = sillY - bottom, winH = headY - sillY;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(0.4, 0.3, 0.7, 0, -0.1, 0, DARK)); // grip
  parts.push(cyl(0.07, 0.07, 0.9, 0, -0.65, 0, DARK, 6)); // arm
  parts.push(box(w + 0.02, 0.25, d + 0.02, 0, headY + 0.125, 0, RED)); // roof
  parts.push(box(w - 0.1, 0.03, d - 0.1, 0, headY - 0.03, 0, INSIDE)); // ceiling lining
  parts.push(box(w * 0.6, 0.08, d * 0.6, 0, bottom - 0.04, 0, DARK)); // floor skid
  parts.push(box(w, 0.05, d, 0, floorY - 0.025, 0, GREY)); // floor
  // lower walls: red outside, light grey lining inside
  const lowY = bottom + lowH / 2;
  for (const s of [-1, 1]) {
    parts.push(box(t, lowH, d + 0.02, s * (w / 2 + 0.01 - t / 2), lowY, 0, RED));
    parts.push(box(w + 0.02, lowH, t, 0, lowY, s * (d / 2 + 0.01 - t / 2), RED));
    parts.push(box(0.02, lowH - 0.06, d - 0.1, s * (w / 2 - t - 0.01), lowY + 0.02, 0, INSIDE));
    parts.push(box(w - 0.1, lowH - 0.06, 0.02, 0, lowY + 0.02, s * (d / 2 - t - 0.01), INSIDE));
  }
  // window frames: sill and head rails all round, corner posts, two mullions a side
  const winY = sillY + winH / 2;
  for (const y of [sillY + 0.03, headY - 0.03]) {
    for (const s of [-1, 1]) {
      parts.push(box(0.07, 0.06, d + 0.04, s * (w / 2), y, 0, DARK));
      parts.push(box(w + 0.04, 0.06, 0.07, 0, y, s * (d / 2), DARK));
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(box(0.08, winH, 0.08, sx * (w / 2), winY, sz * (d / 2), DARK)); // corner posts
  for (const s of [-1, 1]) for (const k of [-1, 1]) {
    parts.push(box(0.04, winH, 0.04, s * (w / 2), winY, k * d / 6, DARK)); // side mullions
    parts.push(box(0.04, winH, 0.04, k * w / 6, winY, s * (d / 2), DARK)); // end mullions
  }
  // benches against both end walls, facing each other across the cabin
  for (const s of [-1, 1]) {
    const zc = s * (d / 2 - t - benchD / 2);
    parts.push(box(w - 0.2, 0.07, benchD, 0, floorY + benchH - 0.035, zc, SEAT)); // seat
    parts.push(box(w - 0.2, benchH - 0.07, 0.03, 0, floorY + (benchH - 0.07) / 2, zc - s * (benchD / 2 - 0.05), GREY)); // skirt
    parts.push(box(w - 0.2, 0.5, 0.06, 0, floorY + benchH + 0.3, s * (d / 2 - t - 0.04), SEAT)); // back cushion
  }
  // grab rail along the ceiling, on two drop rods
  parts.push(cyl(0.02, 0.02, d - 0.6, 0, headY - 0.2, 0, STEEL, 6, Math.PI / 2));
  for (const s of [-1, 1]) parts.push(cyl(0.015, 0.015, 0.17, 0, headY - 0.115, s * (d / 2 - 0.4), STEEL, 6));
  // doors on the +X side: the seam and the handles
  for (const z of [-0.5, 0, 0.5]) parts.push(box(0.012, lowH - 0.1, 0.02, w / 2 + 0.012, lowY, z, DARK));
  for (const z of [-0.12, 0.12]) parts.push(box(0.04, 0.03, 0.2, w / 2 + 0.03, sillY - 0.2, z, STEEL));
  // board rack outside the doors: two hooks the board stands in (the board is the rider's, RiderChair)
  for (const y of [CABIN.rackY - 0.55, CABIN.rackY + 0.35]) {
    parts.push(box(0.12, 0.04, 0.34, w / 2 + 0.06, y, CABIN.rackZ, DARK));
    parts.push(box(0.03, 0.08, 0.34, CABIN.rackX + 0.04, y + 0.02, CABIN.rackZ, DARK));
  }
  // tinted glass in the window band, one pane a wall (drawn with its own see-through material)
  const glass = merge([
    ...[-1, 1].map((s) => box(0.01, winH - 0.06, d - 0.04, s * (w / 2), winY, 0, GLASS)),
    ...[-1, 1].map((s) => box(w - 0.04, winH - 0.06, 0.01, 0, winY, s * (d / 2), GLASS)),
  ]);
  return { shell: merge(parts), glass };
}

/** Platter / T-bar hanger: pole from the low cable down to a disc or bar. Origin at the cable. */
export function surfaceHangerGeometry(tbar: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(0.2, 0.2, 0.3, 0, -0.05, 0, DARK)); // grip
  parts.push(cyl(0.025, 0.025, 2.4, 0, -1.3, 0, STEEL, 6)); // pole
  if (tbar) parts.push(box(1.2, 0.06, 0.08, 0, -2.5, 0, DARK));
  else parts.push(cyl(0.2, 0.2, 0.05, 0, -2.5, 0, DARK, 12));
  return merge(parts);
}

/** Terminal: station building with a pitched roof, bull wheel and loading carpet. Length along -Z. */
export function terminalGeometry(kind: 'chair' | 'gondola' | 'surface'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'surface') {
    parts.push(cyl(0.3, 0.3, 4.5, 0, 2.25, 0, GREY, 8)); // post
    parts.push(cyl(1.2, 1.2, 0.3, 0, 3.6, 0, DARK, 16)); // drive wheel (horizontal)
    parts.push(box(1.4, 0.9, 1.2, 0, 0.45, 1.2, GREY)); // motor box
    return merge(parts);
  }
  const L = kind === 'gondola' ? 20 : 14, W = kind === 'gondola' ? 9 : 7, H = 6.5;
  for (const s of [-1, 1]) parts.push(box(0.5, H, 0.5, s * (W / 2 - 0.3), H / 2, 0, GREY)); // legs
  for (const s of [-1, 1]) parts.push(box(0.5, H, 0.5, s * (W / 2 - 0.3), H / 2, L * 0.4, GREY));
  for (const s of [-1, 1]) parts.push(box(0.5, H, 0.5, s * (W / 2 - 0.3), H / 2, -L * 0.4, GREY));
  parts.push(box(W, 1.2, L, 0, H + 0.6, 0, DARK)); // machinery housing
  // pitched roof: two slabs
  const slab = new THREE.BoxGeometry(W / 2 + 0.6, 0.18, L + 1);
  for (const s of [-1, 1]) {
    const g = slab.clone(); g.rotateZ(s * 0.42); g.translate(s * (W / 4 + 0.1), H + 1.2 + 0.9, 0);
    parts.push(paint(g, RED));
  }
  parts.push(cyl(2.2, 2.2, 0.3, 0, H + 1.2, -L / 2 + 2.5, STEEL, 24)); // bull wheel (horizontal) at the line end
  parts.push(box(W - 1.5, 0.12, 6, 0, 0.06, L / 2 - 3, DARK)); // loading carpet / platform
  parts.push(box(3, 2.4, 2.4, -W / 2 + 1.6, 1.2, L / 2 - 1.5, CREAM)); // operator hut
  return merge(parts);
}

/** Magic carpet belt: a long low box with side rails. Length 1 (scale Z). */
export function carpetGeometry(): THREE.BufferGeometry {
  return merge([box(1.6, 0.12, 1, 0, 0.06, 0, DARK), box(0.08, 0.5, 1, -0.84, 0.25, 0, STEEL), box(0.08, 0.5, 1, 0.84, 0.25, 0, STEEL)]);
}
