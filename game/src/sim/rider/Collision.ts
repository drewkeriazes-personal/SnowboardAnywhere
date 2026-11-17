/** Ground height and collisions (split from sim/Rider.ts, FEAT-165) */
import type { Rider } from '../Rider';
import { BODY_R, ROCK_FACE, ROCK_RAMP, STEP_UP } from './tuning';

const RB = { b: 0, gx: 0, gy: 0 };
/** BUG-141: on Realistic a rock is ground you ride up and over (Collider.rockBump); null on Arcade, off the
 *  board (on foot, crashed: the body still stops against the rock) and with no collider */
export function rockBumpAt(r: Rider, x: number, y: number): typeof RB | null {
  if (r.jumpMode !== 'real' || !r.collider || r.onFoot || r.crashed > 0) return null;
  return r.collider.rockBump(x, y, RB);
}

/** BUG-045: terrain or a bridge deck (BUG-141: or a rock on Realistic), or the top of a building the rider is standing on */
export function groundAt(r: Rider, x: number, y: number, z: number): number {
  let g = r.pack.groundHeight(x, y, z);
  if (!r.collider) return g;
  const rb = rockBumpAt(r, x, y);
  if (rb) g += rb.b;
  const f = r.collider.floorAt(x, y, z, 0.05);
  return f > g ? f : g;
}

/** BUG-141: the ground's normal (pack x, y, z) with a rock's dome on Realistic, as groundAt's height */
export function groundNormalAt(r: Rider, x: number, y: number, z: number, out?: number[] | Float32Array): number[] {
  const n = r.pack.groundNormal(x, y, out, z) as number[];
  const rb = rockBumpAt(r, x, y);
  if (rb && rb.b > 0) {
    const nz = Math.max(0.2, n[2]), hx = -n[0] / nz + rb.gx, hy = -n[1] / nz + rb.gy, l = Math.hypot(hx, hy, 1);
    n[0] = -hx / l; n[1] = -hy / l; n[2] = 1 / l;
  }
  return n;
}

/** Riding into trees, rocks and walls: ride up a rampable rock, slide along a glancing hit, bounce off (or crash on) a square one. */
export function rideCollide(r: Rider): void {
  // collisions with trees and rocks
  if (r.collider) {
    const hit = r.collider.resolve(r.x, r.y, r.z, BODY_R);
    if (hit) {
      // started inside a building: always take the pushed-out position, even when already moving out
      if (hit.inside) { r.x = hit.x; r.y = hit.y; }
      const vn = r.vx * hit.nx + r.vy * hit.ny; // negative = moving into the obstacle
      const spdNow = Math.hypot(r.vx, r.vy) || 1;
      const headOn = -vn / spdNow; // 1 = straight into it, 0 = grazing
      if (vn < 0) {
        // BUG-141: on Realistic a rideable rock is ground (its dome, groundAt): you ride up and over it, never
        // through it, so no push, once on it or meeting it where its face along your line is no steeper than
        // ROCK_FACE. Steeper (square into a steep rock) it is a trunk below: slide along it, or bounce or be thrown.
        // Arcade keeps the kicker.
        const real = r.jumpMode === 'real';
        if (real && hit.kind === 1 && hit.ground === hit.ground) {
          if ((rockBumpAt(r, r.x, r.y)?.b ?? 0) > 0) return; // on its dome already
          if (2 * (hit.top - hit.ground) / hit.radius * headOn <= ROCK_FACE) return; // the dome's rim slope along your line
        }
        if (hit.kind === 1 && !real) {
          r.lastHit = 'ramp';
          const A = ROCK_RAMP.arcade, h = Math.max(0.3, hit.top - r.z);
          const launch = Math.min(0.9, 0.25 + 0.9 * headOn) * Math.min(1, h / 1.5);
          r.vz = Math.max(r.vz, spdNow * launch * A.kick + A.base);
          r.vx *= 1 - A.loss * headOn; r.vy *= 1 - A.loss * headOn;
          r.z = Math.max(r.z, hit.top - 0.3);
          r.onGround = false; r.airTime = 0; r.spin = 0; r.flip = 0; r.flipRate = 0;
          r.landingShock = 0.3;
        } else if (headOn < 0.5) {
          // glancing hit on a tree or wall: slide along it, lose a little speed
          r.lastHit = 'graze'; r.hitSpeed = -vn;
          r.x = hit.x; r.y = hit.y;
          r.vx -= vn * hit.nx; r.vy -= vn * hit.ny;
          r.vx *= 0.85; r.vy *= 0.85;
          r.landingShock = 0.25;
        } else {
          // square hit: bounce off; fast square hits crash
          r.lastHit = 'wall'; r.hitSpeed = -vn;
          r.x = hit.x; r.y = hit.y;
          if (-vn > 7) r.crash(1.2, 0); // FEAT-288: the bounce below is the speed loss
          r.vx -= 1.4 * vn * hit.nx; r.vy -= 1.4 * vn * hit.ny;
          r.vx *= 0.6; r.vy *= 0.6;
        }
      }
    }
  }
}

/** On-foot collisions: push out of trunks, rocks, walls and railings and stop going into them. */
export function collide(r: Rider, rad: number, walking = false): void {
  if (!r.collider) return;
  const hit = r.collider.resolve(r.x, r.y, r.z, rad);
  if (!hit) return;
  // BUG-045: walking into a low ledge (a curb, a step, a low deck): step up onto it. Only a
  // building edge counts, so a post, trunk or railing is never stepped over.
  if (walking && hit.ledge && !hit.inside) {
    const px = hit.x - hit.nx * (rad + 0.15), py = hit.y - hit.ny * (rad + 0.15);
    const top = r.collider.floorAt(px, py, r.z, STEP_UP);
    if (top > r.z && Number.isFinite(top) && (r.walkVx * hit.nx + r.walkVy * hit.ny) < 0) {
      r.mantleFrom[0] = hit.x; r.mantleFrom[1] = hit.y; r.mantleFrom[2] = r.z;
      r.mantleTo[0] = px; r.mantleTo[1] = py; r.mantleTo[2] = top;
      r.x = hit.x; r.y = hit.y; r.stepT = 1e-3;
      return;
    }
  }
  r.x = hit.x; r.y = hit.y;
  const into = (vx: number, vy: number) => Math.min(0, vx * hit.nx + vy * hit.ny);
  let d = into(r.vx, r.vy); r.vx -= d * hit.nx; r.vy -= d * hit.ny;
  d = into(r.walkVx, r.walkVy); r.walkVx -= d * hit.nx; r.walkVy -= d * hit.ny;
  d = into(r.slideVx, r.slideVy); r.slideVx -= d * hit.nx; r.slideVy -= d * hit.ny;
}
