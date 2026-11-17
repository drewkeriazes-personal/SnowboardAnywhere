/**
 * BUG-065: riding a mogul field, the legs soak up the bumps. The board keeps to the snow (the physics still
 * rides every bump, FEAT-059); the body and the chase camera follow a smoothed ground instead: the bump height
 * under the board low-passed over ABSORB_TAU, so the knees flex through the field instead of the whole rider
 * being thrown up and down with each bump.
 *
 * Also where the board is drawn: the physics rides the exact bump function, the mesh draws it sampled on its
 * grid (terrain/drawnGround.ts), so on the snow the drawn board moves by that difference to sit on the bumps
 * the player sees.
 */
import type { Pack } from '../pack/Pack';
import type { Rider } from '../sim/Rider';
import { DrawnGround } from '../terrain/drawnGround';

/** low-pass time of the bump height the body follows (s): a 5 m bump at 12 m/s keeps about a fifth of its height */
export const ABSORB_TAU = 0.3;
/** knee travel (m): how far the hips drop under a crest and rise over a trough from the stance */
export const ABSORB_DOWN = 0.42;
export const ABSORB_UP = 0.15;
/** the stance on a bump field: the hips this much lower at full field strength (m), so there is travel both ways */
export const ABSORB_STANCE = 0.12;
/** mogul amplitude that counts as a full field (m) */
const FULL_FIELD = 0.4;
/** how fast the absorb comes in and goes out at a field's edge (s) */
const FIELD_TAU = 0.3;
/** how fast the drawn board's offset comes in on landing and goes out on take-off (s) */
const CONTACT_TAU = 0.08;

export class BumpAbsorb {
  /** hips offset from the stance (m, + up): the stance drop plus the knee travel */
  hips = 0;
  /** where the drawn board sits relative to the physics height (m): the mesh's bump minus the exact one */
  boardOff = 0;
  /** smoothed rider height for the camera (m, pack z) and its rate (m/s) */
  z = NaN;
  vz = 0;
  /** 0..1: riding a bump field (eased in and out over FIELD_TAU) */
  weight = 0;
  /** the low-passed height of the drawn board above the snow under the bumps (m) */
  private hs = NaN;
  private contact = 0;
  private off = 0;
  private offV = 0;
  private drawn: DrawnGround | null = null;
  private pack: Pack | null = null;
  /** where the rider was on the last update, so a reader can tell the values are this frame's */
  private atX = NaN; private atY = NaN;

  /** true if the last update was for a rider at (x, y) */
  current(x: number, y: number): boolean { return x === this.atX && y === this.atY; }

  reset(): void { this.atX = this.atY = NaN; this.hs = NaN; this.z = NaN; this.vz = 0; this.hips = 0; this.boardOff = 0; this.weight = 0; this.contact = 0; this.off = 0; this.offV = 0; }

  update(pack: Pack | null, r: Rider, dt: number): void {
    if (!pack || dt <= 0) { this.reset(); return; }
    this.atX = r.x; this.atY = r.y;
    if (pack !== this.pack) { this.pack = pack; this.drawn = new DrawnGround(pack); this.hs = NaN; }
    const alive = !r.onFoot && r.crashed <= 0;
    this.contact += ((r.onGround && alive ? 1 : 0) - this.contact) * (1 - Math.exp(-dt / CONTACT_TAU));
    const amp = pack.mogulAmp?.(r.x, r.y) ?? 0;
    const field = alive ? Math.min(1, amp / FULL_FIELD) : 0;
    this.weight += (field - this.weight) * (1 - Math.exp(-dt / FIELD_TAU));
    let b = 0, off = 0;
    if (amp > 0.005 && typeof pack.bumpAt === 'function') {
      b = pack.bumpAt(r.x, r.y);
      off = this.drawn!.bumpError(r.x, r.y);
    }
    this.boardOff = this.contact * off;
    // the drawn board's height above the snow under the bumps: the bumps on the snow, the air off them. Its
    // low-pass is where the body rides, so the knees bend over a crest, reach into a trough and soak up a
    // landing; kept within the knees' travel of the board
    const hb = r.z + this.boardOff - ((pack.terrainHeight?.(r.x, r.y) ?? r.z) - b);
    if (Number.isNaN(this.hs) || Math.abs(this.hs - hb) > 5) this.hs = hb;
    this.hs += (hb - this.hs) * (1 - Math.exp(-dt / ABSORB_TAU));
    const knees = Math.max(-ABSORB_DOWN, Math.min(ABSORB_UP, this.hs - hb));
    this.hs = hb + knees;
    const w = this.weight;
    this.hips = w * (knees - ABSORB_STANCE);
    // the camera follows the drawn board plus the knee travel (its rate: the rider's plus the offset's, so off
    // the fields it is exactly the rider's)
    const o = this.boardOff + w * knees;
    this.offV = Number.isNaN(this.z) ? 0 : this.offV + ((o - this.off) / dt - this.offV) * (1 - Math.exp(-dt / 0.05));
    this.off = o;
    this.z = r.z + o;
    this.vz = r.vz + this.offV;
  }
}
