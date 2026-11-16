import type { Controls } from '../sim/Controls';
import type { Rider } from '../sim/Rider';
import type { LiftRide } from '../sim/LiftRide';
import type { LiftRuntime } from '../world/Lifts';
import type { TouchControls } from '../ui/TouchControls';
import type { LiftPicker } from '../ui/LiftPicker';
import type { FramePlan, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

export interface LiftPickParts {
  controls: Controls; touch: TouchControls | null; rider: Rider; liftRide: LiftRide<LiftRuntime>; picker: LiftPicker; frame: RideFrame;
  /** a distance as shown (feet or metres) */
  dist(m: number): string;
}

/**
 * FEAT-323: the lift picker over the world, opened by E in the boarding zones of two or more lifts. The rider
 * holds still under it (as under the map); the picker has the keys. A pick boards that lift and riding takes
 * over; Esc, Circle or the touch pause button closes it.
 */
export class LiftPickState implements GameState {
  readonly name = 'liftpick';
  private readonly plan: FramePlan = { drive: 'hold', touch: false, fullMap: false, interact: false, replay: null };

  constructor(private readonly p: LiftPickParts, private readonly states: GameStates) {
    p.picker.onPick = (l) => { p.liftRide.boardLift(p.rider, l); if (this.states.is('liftpick')) this.states.go('riding'); };
    p.picker.onClose = () => { if (this.states.is('liftpick')) this.states.go('riding'); };
  }

  enter(): void {
    const { liftRide, rider, picker } = this.p;
    picker.show(liftRide.choices, (l) => this.p.dist(Math.hypot(l.bottom[0] - rider.x, l.bottom[1] - rider.y)));
  }

  exit(): void {
    this.p.picker.hide();
    this.p.controls.padMute(); // the button that picked is not a riding press (it would skip to the top)
  }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, picker, frame } = this.p;
    if (backPressed(controls, touch)) { this.states.go('riding'); return; }
    // the interact key when it is rebound off E (MenuNav reads E itself)
    if (controls.action('lift') || touch?.once('lift')) { picker.pickFocused(); if (!this.states.is('liftpick')) return; }
    frame.update(dt, stepped, this.plan);
  }

  render(): void { this.p.frame.draw(); }
}
