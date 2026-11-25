import { PAD } from '../sim/Pad';
import { stickGlyph } from '../ui/PadGlyphs';
import type { Settings } from '../ui/Settings';
import type { Controls } from '../sim/Controls';
import type { ResortMap } from '../ui/ResortMap';
import type { MountainView } from '../ui/MountainView';
import type { KeyLabels } from '../ui/KeyLabels';
import type { TouchControls } from '../ui/TouchControls';
import type { GameAudio } from '../audio/Audio';
import type { FramePlan, RideFrame } from './RideFrame';
import { backPressed, type GameState, type GameStates } from './GameState';

export interface MapParts {
  controls: Controls; touch: TouchControls | null; map: ResortMap; mountain: MountainView; settings: Settings; keyLabels: KeyLabels; audio: GameAudio; frame: RideFrame;
  /** the map has closed (Outrun picked with "or drop in from the map" starts now) */
  onClosed(): void;
}

/**
 * FEAT-162: the full resort map (M) over the world. The state follows the map (ResortMap.onOpenChange), so a
 * drop-in click, Esc, M or Circle all end it. The rider holds still under it, though a lift carries on; the
 * map has the keys (its own mouse, touch and + / - keys, the stick on a controller), the riding keys do nothing.
 * FEAT-054: V, Triangle or the button on the map switch it to its 3D mode (ui/MountainView.ts) and back; M
 * always opens the 2D map.
 */
export class MapState implements GameState {
  readonly name = 'map';
  private readonly plan: FramePlan = { drive: 'hold', touch: false, fullMap: true, interact: false, replay: null };

  constructor(private readonly p: MapParts, private readonly states: GameStates) {
    p.map.onToggle3d = () => this.toggle3d();
  }

  enter(): void { /* opened by whoever called map.open() */ }

  exit(): void {
    this.p.mountain.leave();
    this.p.controls.padMute(); // FEAT-137: the button that closed it (or the Cross that dropped in) is not a riding press
    this.p.onClosed();
  }

  /** FEAT-054: the 2D map or the 3D mountain view (not while the 3D view is flying down to a drop) */
  toggle3d(): void {
    const { map, mountain } = this.p;
    if (!this.states.is('map') || mountain.flight) return;
    if (mountain.on) { mountain.leave(); map.set3d(false); } else { map.set3d(true); mountain.enter(); }
  }

  update(dt: number, stepped: boolean): void {
    const { controls, touch, map, mountain, settings, keyLabels, audio, frame } = this.p;
    if (backPressed(controls, touch) || controls.action('map') || touch?.once('map')) { map.close(); return; }
    if (controls.once('KeyV') || controls.padOnce(PAD.Y)) this.toggle3d();
    const pad = controls.pad, pg = keyLabels.pg;
    const dz = (v: number) => (Math.abs(v) > settings.padDead ? v : 0);
    const trig = () => { const z = pad ? (pad.buttons[PAD.RT]?.value ?? 0) - (pad.buttons[PAD.LT]?.value ?? 0) : 0; return Math.abs(z) > 0.1 ? z : 0; };
    if (pad && controls.padOnce(PAD.B)) { map.close(); return; }
    if (mountain.on) {
      // FEAT-054 on a controller: the left stick slides the map, the right stick turns and tilts, R2 / L2 zoom, LB / RB step through the drop zones
      const help = controls.usingPad
        ? `${stickGlyph('L')} move &middot; ${stickGlyph('R')} turn &middot; ${pg(PAD.RT)} ${pg(PAD.LT)} zoom &middot; ${pg(PAD.LB)} ${pg(PAD.RB)} drop zones &middot; ${pg(PAD.A)} drop in &middot; ${pg(PAD.Y)} 2D map &middot; ${pg(PAD.B)} close`
        : 'click a drop zone to drop in &middot; drag to turn &middot; right drag or WASD to move &middot; scroll or Q / E to zoom &middot; Tab, Enter: drop zones &middot; Home resets &middot; V 2D map &middot; M or Esc to close';
      const ax = (i: number) => (pad ? dz(pad.axes[i] ?? 0) : 0);
      mountain.update(dt, {
        yaw: ax(2), pitch: -ax(3), panX: ax(0), panY: -ax(1), zoom: trig(),
        cycle: controls.padOnce(PAD.RB) ? 1 : controls.padOnce(PAD.LB) ? -1 : 0, pick: controls.padOnce(PAD.A), pad: controls.usingPad, help,
      });
      if (!this.states.is('map')) return; // the flight has landed: the drop closed the map and riding has the frame
    } else if (pad) {
      // FEAT-137: the full map on a controller: the stick pans under a crosshair, R2 / L2 zoom, Cross drops in, Circle closes
      const help = `${stickGlyph('L')} move &middot; ${pg(PAD.RT)} ${pg(PAD.LT)} zoom (${map.zoom.toFixed(1)}x) &middot; ${pg(PAD.A)} drop in &middot; ${pg(PAD.Y)} 3D view &middot; ${pg(PAD.B)} close`;
      if (map.padDrive(dt, dz(pad.axes[0] ?? 0), dz(pad.axes[1] ?? 0), trig(), controls.padOnce(PAD.A), help)) map.drawFull();
      if (!this.states.is('map')) return; // Cross dropped in: the pick closed the map and riding has the frame
    }
    if (controls.action('track')) audio.nextTrack();
    frame.update(dt, stepped, this.plan);
    mountain.draw();
  }

  render(): void { this.p.frame.draw(); }
}
