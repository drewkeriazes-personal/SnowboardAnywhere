import * as THREE from 'three';
import { CABIN, SEAT_TOP, chairGeometry, gondolaCabinGeometry } from './LiftModels';
import type { LiftRuntime } from './Lifts';
import { BODY_LAYER } from './RiderView';

/**
 * The chair (or gondola cabin) that carries the rider. It follows the rider for the whole ride
 * with the seat under them and faces up the line; during the boarding and unloading dip, when
 * the rider is lowered toward the snow, the hanger stretches up to the cable.
 * BUG-058: a gondola is the cabin built to be seen from inside (LiftModels gondolaCabinGeometry), the
 * rider on the back bench facing up the line, and their board standing in the rack outside the doors.
 * Surface lifts and carpets have nothing to show (the rider stays on the snow).
 */
const CHAIR_SEAT_TOP = -2.1 + 0.04; // seat top relative to the chair geometry origin (the grip)
/** BUG-058: where the rider's hips sit in the cabin along the line: on the back bench, a little forward of its middle */
export const CABIN_RIDER_Z = -(CABIN.d / 2 - 0.04 - CABIN.benchD * 0.6);

export class RiderChair {
  readonly group = new THREE.Group();
  private chair: THREE.Object3D | null = null;
  private kind = '';
  private readonly hanger: THREE.Mesh;
  /** BUG-058: the cabin windows: tinted, see-through, a little glossy */
  readonly glassMaterial = new THREE.MeshStandardMaterial({ color: 0x6f8fa8, transparent: true, opacity: 0.22, roughness: 0.06, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false });
  /** BUG-058: the rider's board in the rack, drawn in their board's material (setBoardMaterial) */
  private boardMaterial: THREE.Material;
  private glass: THREE.Mesh | null = null;
  private fp = false;

  constructor(private readonly material: THREE.Material) {
    this.hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), new THREE.MeshStandardMaterial({ color: 0x22252b, roughness: 0.5, metalness: 0.5 }));
    this.hanger.castShadow = true;
    this.group.add(this.hanger);
    this.group.visible = false;
    this.boardMaterial = material;
  }

  /** BUG-058: the rider's board material, for the board in the gondola's rack */
  setBoardMaterial(m: THREE.Material): void {
    this.boardMaterial = m;
    this.chair?.traverse((o) => { if (o.name === 'racked board') (o as THREE.Mesh).material = m; });
  }

  /** the gondola cabin: shell, glass, and the board in the rack, shifted so the back bench is under the rider */
  private buildCabin(): THREE.Object3D {
    const cabin = new THREE.Group();
    cabin.name = 'rider cabin';
    const { shell, glass } = gondolaCabinGeometry();
    const s = new THREE.Mesh(shell, this.material); s.castShadow = true; s.name = 'cabin shell'; // no receiveShadow: its own walls streaked the floor with shadow acne
    const g = new THREE.Mesh(glass, this.glassMaterial); g.name = 'cabin glass'; g.renderOrder = 1;
    // a snowboard standing on its tail: rounded nose and tail, thin across, along the wall
    const boardGeo = new THREE.CapsuleGeometry(0.135, 1.25, 4, 12);
    boardGeo.scale(0.12, 1, 1);
    const b = new THREE.Mesh(boardGeo, this.boardMaterial); b.castShadow = true; b.name = 'racked board';
    b.position.set(CABIN.rackX, CABIN.rackY, CABIN.rackZ);
    // the main camera's near plane is 0.5 m, which would cut open the wall behind the rider's head:
    // in first person the cabin is drawn again with the body (near 0.05 m, SceneRender), the glass only there
    s.layers.enable(BODY_LAYER);
    this.glass = g; this.setFirstPerson(this.fp);
    cabin.add(s, g, b);
    cabin.position.z = -CABIN_RIDER_Z;
    return cabin;
  }

  /** BUG-058: first person: the glass is drawn in the body pass only (once, not tinted twice) */
  setFirstPerson(fp: boolean): void {
    this.fp = fp;
    if (this.glass) { if (fp) this.glass.layers.set(BODY_LAYER); else this.glass.layers.set(0); }
  }

  /** Per frame. `lift` null hides it. `cableY` is the cable height above the rider. */
  update(lift: LiftRuntime | null, riderX: number, riderY: number, riderZ: number, heading: number, cableY: number): void {
    if (!lift || (lift.kind !== 'chair' && lift.kind !== 'gondola')) { this.group.visible = false; return; }
    const want = lift.kind === 'gondola' ? 'gondola' : `chair${(lift.feature.capacity ?? 2400) >= 3000 ? 6 : (lift.feature.capacity ?? 2400) >= 1800 ? 4 : 2}`;
    if (want !== this.kind) {
      if (this.chair) this.group.remove(this.chair);
      this.glass = null;
      if (want === 'gondola') this.chair = this.buildCabin();
      else { const m = new THREE.Mesh(chairGeometry(Number(want.slice(5))), this.material); m.castShadow = true; this.chair = m; }
      this.group.add(this.chair);
      this.kind = want;
    }
    this.group.visible = true;
    // origin (grip) placed so the seat top (the chair's, or the cabin's bench) is under the rider
    const seatTop = lift.kind === 'gondola' ? CABIN.floorY + CABIN.benchH : CHAIR_SEAT_TOP;
    const originY = riderZ + SEAT_TOP - seatTop;
    this.group.position.set(riderX, originY, -riderY);
    // the chair geometry faces +Z (backrest at -Z); the rider faces along the heading
    this.group.rotation.set(0, -heading + Math.PI, 0);
    // extra hanger from the grip up to the cable during the dip (over the cabin's grip, ahead of the rider)
    const gap = cableY - originY;
    this.hanger.visible = gap > 0.1;
    if (gap > 0.1) { this.hanger.scale.set(1, gap, 1); this.hanger.position.set(0, gap / 2, lift.kind === 'gondola' ? -CABIN_RIDER_Z : 0); }
  }
}
