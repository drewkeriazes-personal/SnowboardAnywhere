import type { Rider } from '../sim/Rider';
import type { Pack } from '../pack/Pack';
import type { ChaseCamera } from '../world/ChaseCamera';
import type { Lifts } from '../world/Lifts';
import type { GameState, GameStates } from './GameState';
import { loadStep, timedStep } from '../core/loadSteps';

export interface LoadingParts {
  pack: Pack; rider: Rider; lifts: Lifts; cam: ChaseCamera;
  /** where the ride starts */
  spawn(): { x: number; y: number; h: number };
  /** the first state once the rider is on the snow: the main menu, or riding (no menu, or an eye link) */
  first: 'attract' | 'riding';
  /** compile and stream the view behind the loading screen or the menu (BUG-063), or null (headless) */
  warmUp: (() => Promise<void>) | null;
  /** FEAT-377: what is built or read back from the last load in the background (core/builtData.ts), in before the first frame */
  built: Promise<unknown>;
  /** false once the session is torn down */
  alive(): boolean;
  /** everything is ready: start the frame loop */
  ready(): void;
}

/**
 * FEAT-162: loading. Waits (8 s at most) for the fine tiles under the start, puts the rider there, moves to
 * the first state (whose camera the warm-up compiles for), warms up, then starts the loop (FEAT-377: with the menu
 * first, the wait and the warm-up run together). No frame runs while loading: the loop starts at the end of it.
 */
export class LoadingState implements GameState {
  readonly name = 'loading';

  constructor(private readonly p: LoadingParts, private readonly states: GameStates) {}

  enter(): void { void this.load(); }
  exit(): void { /* nothing held */ }
  update(): void { /* the loop isn't running yet */ }
  render(): void { /* nor drawing */ }

  private async load(): Promise<void> {
    const { pack, rider, lifts, cam } = this.p;
    const t0 = performance.now();
    const ground = (async () => {
      while (Number.isNaN(pack.fine?.sample(this.p.spawn().x, this.p.spawn().y) ?? 0) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
      loadStep('fine tiles under the start', t0);
      const s = this.p.spawn();
      rider.reset(s.x, s.y, s.h);
    })();
    // FEAT-377: the menu looks from its shot, not the rider, so its warm-up streams while the start's tiles load; the
    // rider is on the snow before the loop starts either way (the menu's exit puts the chase camera behind it)
    const menuFirst = this.p.first === 'attract';
    if (!menuFirst) await ground;
    lifts.buildMarkers(pack);
    if (!menuFirst) cam.snapTo(rider);
    timedStep(`enter ${this.p.first}`, () => this.states.go(this.p.first));
    if (this.p.warmUp && this.p.alive()) { const t1 = performance.now(); await this.p.warmUp(); loadStep('warm-up', t1); }
    await ground;
    await this.p.built;
    if (!this.p.alive()) return;
    this.p.ready();
  }
}
