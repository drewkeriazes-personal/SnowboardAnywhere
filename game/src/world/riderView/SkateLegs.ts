/** BUG-054: the back foot out of its binding to skate: the unclip, the push strokes on the snow and the clip-in */
import * as THREE from 'three';
import type { RiderView } from '../RiderView';
import { SKATE_PUSH, type Rider } from '../../sim/Rider';
import { solveLegs, twoBone, ANKLE_H, SOLE_FWD } from '../RiderRig';
import { smooth } from './math';

const _a = [new THREE.Vector3(), new THREE.Vector3()], _q = [new THREE.Quaternion(), new THREE.Quaternion()];
const _lp = new THREE.Vector3(), _rp = new THREE.Vector3(), _front = new THREE.Vector3(), _back = new THREE.Vector3();
const _spot = new THREE.Vector3(), _dir = new THREE.Vector3(), _snowA = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _snowQ = new THREE.Quaternion(), _tilt = new THREE.Quaternion(), _t = new THREE.Vector3(), _sh = new THREE.Vector3(), _pole = new THREE.Vector3();
const _n = new THREE.Vector3(), _cq = new THREE.Quaternion(), _cq2 = new THREE.Quaternion();

/** the boot beside the board: out from the board's centre line on the toe side (m), and how far a stroke reaches back at most */
const OUT = 0.3, OUT_PUSH = 0.07, STROKE_MIN = 0.2, STROKE_MAX = 0.55, STROKE_PER_MS = 0.09;
/** the back hand reaches the ratchet and the boot comes out (shares of the unclip, r.skateFoot) */
const HAND_UNTIL = 0.7, FOOT_FROM = 0.35, FOOT_TO = 0.9;

/**
 * After the feet are pinned to the bindings: the back boot leaves its binding (FOOT_FROM..FOOT_TO of
 * r.skateFoot, with a lift) for a spot on the snow beside the board on the toe side, just behind the front
 * binding. Pushing, the stroke runs it back along the board while planted (r.skatePhase < SKATE_PUSH) and
 * swings it forward through the air for the next plant, a bootprint where it comes down. The front foot
 * stays in its binding. `lp` / `rp` are the knee directions settleBody solved with. While the foot comes
 * out or goes in, the back hand reaches down to the binding's ratchet.
 */
export function skateLegs(v: RiderView, r: Rider, lp: THREE.Vector3, rp: THREE.Vector3): void {
  const u = r.skateFoot, rig = v.rig, pack = v.pack;
  if (u <= 0 || !pack) { v.skatePh = -1; return; }
  _lp.copy(lp); _rp.copy(rp);
  // the leading end of the board is rig -Z drawn the normal way round (fl 1), +Z drawn turned round;
  // the back foot is the other one: the right foot's binding (+Z) or the left's
  const b = v.fl > 0 ? 1 : 0, f = 1 - b;
  const anchors = [rig.anchors.l, rig.anchors.r];
  rig.board.updateMatrixWorld(true);
  for (let i = 0; i < 2; i++) { anchors[i].getWorldPosition(_a[i]); anchors[i].getWorldQuaternion(_q[i]); }
  const front = rig.board.worldToLocal(_front.copy(_a[f])), back = rig.board.worldToLocal(_back.copy(_a[b]));
  const aft = Math.sign(back.z - front.z) || 1;
  // the stroke: 0 at the plant (by the front binding), 1 at the end of the push (behind it)
  let along = 0, lift = 0;
  const pushing = r.skating;
  if (pushing) {
    const ph = r.skatePhase;
    if (ph < SKATE_PUSH) along = ph / SKATE_PUSH;
    else { const k = (ph - SKATE_PUSH) / (1 - SKATE_PUSH); along = 1 - smooth(0, 1, k); lift = Math.sin(Math.PI * k); }
  }
  const len = Math.min(STROKE_MAX, STROKE_MIN + STROKE_PER_MS * r.speed);
  _spot.set(OUT + OUT_PUSH * along, 0, front.z + aft * (0.14 + len * along));
  rig.board.localToWorld(_spot);
  const px = _spot.x, py = -_spot.z;
  let gz = pack.groundHeight(px, py);
  if (Number.isNaN(gz)) gz = _spot.y;
  // the boot points along the board toward the leading end, toes turned out a little to the toe side
  _dir.set(0.35, 0, -aft).transformDirection(rig.board.matrixWorld);
  const yaw = Math.atan2(_dir.x, -_dir.z);
  const nrm = pack.groundNormal(px, py) as number[];
  _tilt.setFromUnitVectors(_up, _n.set(nrm[0], nrm[2], -nrm[1]).normalize());
  _snowQ.setFromAxisAngle(_up, -yaw).premultiply(_tilt);
  _snowA.set(0, ANKLE_H, SOLE_FWD).applyQuaternion(_snowQ).add(_t.set(px, gz + 0.1 * lift, -py));
  // out of the binding with a lift, onto the snow; the clip-in plays it backward
  const k = smooth(FOOT_FROM, FOOT_TO, u);
  if (k < 1) {
    _snowA.lerpVectors(_a[b], _snowA, k).addScaledVector(_up, 0.14 * Math.sin(Math.PI * k));
    _snowQ.copy(_cq2.copy(_q[b]).slerp(_snowQ, k));
  }
  _a[b].copy(_snowA); _q[b].copy(_snowQ);
  v.footGap = solveLegs(rig, _a[0], _a[1], _q[0], _q[1], _lp, _rp);
  // a print each time the boot comes down
  const ph = pushing ? r.skatePhase : -1;
  if (pushing && (v.skatePh < 0 || ph < v.skatePh)) v.onPlant?.({ side: b as 0 | 1, x: px, y: py, yaw, speed: 0, kick: 0, smearX: 0, smearY: 0 });
  v.skatePh = ph;

  // the back hand down to the ratchet on the way out and in
  const reach = r.skate === 'unclip' || r.skate === 'clip' ? Math.sin(Math.PI * Math.min(1, u / HAND_UNTIL)) : 0;
  if (reach > 0.01) {
    const B = rig.bones, side = b === 1 ? 'Right' : 'Left';
    const up = B[`${side}Arm`], lo = B[`${side}ForeArm`], end = B[`${side}Hand`];
    const keepUp = _cq.copy(up.quaternion), keepLo = _cq2.copy(lo.quaternion);
    // the ankle strap's ratchet, on the toe side of the binding a hand's width up
    _t.copy(back).add(_dir.set(0.06, 0.12, 0));
    rig.board.localToWorld(_t);
    _sh.copy(up.getWorldPosition(_sh));
    _t.addScaledVector(_sh.sub(_t).normalize(), 0.07);
    _pole.set(b === 1 ? 0.7 : -0.7, -1, 0.4).applyQuaternion(B.Spine2.getWorldQuaternion(_tilt));
    twoBone(up, lo, end, _t, _pole);
    up.quaternion.copy(keepUp.slerp(up.quaternion, reach));
    lo.quaternion.copy(keepLo.slerp(lo.quaternion, reach));
    up.updateMatrixWorld(true);
  }
}
