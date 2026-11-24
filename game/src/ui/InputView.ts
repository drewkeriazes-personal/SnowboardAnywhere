import type { Controls } from '../sim/Controls';
import { PAD, padButtonName } from '../sim/Pad';
import { hotSwap } from '../core/hot';

/**
 * FEAT-049: the on-screen input display (Settings > Controls > Input display), low in the middle of the view.
 * It shows what the hands do and what the rider gets from it, so a player can see the analog carve and tune
 * the dead zones: the two sticks (the dead zone as a ring, the raw position as a dot), the triggers' travel with
 * the trigger dead zone marked, the face buttons, bumpers and D-pad, then the rider's input: the steer
 * (-1 .. 1, the edge it asks for) and the actions held. On the keyboard the left stick shows the steer and
 * tuck / brake keys instead, so the two can be compared. One small canvas, drawn only while shown.
 */
const W = 300, H = 108;
const LS = { x: 54, y: 50 }, RS = { x: 246, y: 50 }, STICK_R = 30;
const ACTIONS: [string, (c: Controls) => boolean][] = [
  ['TUCK', (c) => c.input.tuck], ['BRAKE', (c) => c.input.brake], ['JUMP', (c) => c.input.jumpHeld], ['GRAB', (c) => c.input.grab],
];

/** what was drawn last (padcheck.mjs reads it through `__sim.inputView.last`) */
export interface InputViewState { shown: boolean; pad: boolean; lx: number; ly: number; rx: number; ry: number; lt: number; rt: number; steer: number; held: string }

export class InputView {
  readonly root: HTMLDivElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private shown = false;
  readonly last: InputViewState = { shown: false, pad: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, steer: 0, held: '' };

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'input-view'; // hud.css
    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    this.ctx = cv.getContext('2d');
    this.ctx?.scale(dpr, dpr);
    this.root.appendChild(cv);
    document.body.appendChild(this.root);
  }

  /** Draw this frame's input, or hide the display. */
  update(show: boolean, c: Controls): void {
    if (show !== this.shown) { this.shown = show; this.last.shown = show; this.root.style.display = show ? 'block' : 'none'; }
    if (!show || !this.ctx) return;
    const g = this.ctx, p = c.pad, L = this.last;
    L.pad = !!p;
    if (p) {
      L.lx = p.axes[0] ?? 0; L.ly = p.axes[1] ?? 0; L.rx = p.axes[2] ?? 0; L.ry = p.axes[3] ?? 0;
      L.lt = p.buttons[PAD.LT]?.value ?? 0; L.rt = p.buttons[PAD.RT]?.value ?? 0;
    } else {
      // keyboard: the left stick shows what the keys ask for (steer across, tuck up, brake down)
      L.lx = c.input.steer; L.ly = (c.input.brake ? 1 : 0) - (c.input.tuck ? 1 : 0); L.rx = L.ry = 0;
      L.lt = c.input.brake ? 1 : 0; L.rt = c.input.tuck ? 1 : 0;
    }
    L.steer = c.input.steer;
    let held = '';
    for (const [name, on] of ACTIONS) if (on(c)) held += (held ? ' ' : '') + name;
    L.held = held;

    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(12, 16, 24, .55)';
    round(g, 0, 0, W, H, 12); g.fill();
    const dead = p ? c.padCfg.dead : 0;
    stick(g, LS.x, LS.y, L.lx, L.ly, dead, p ? 'L' : 'keys');
    stick(g, RS.x, RS.y, L.rx, L.ry, dead, p ? 'R' : '', !p);
    // triggers: a bar each beside its stick, the dead zone a tick across it
    trigger(g, 8, L.lt, p ? c.padCfg.trigDead : 0.5, p ? padButtonName(p.kind, PAD.LT) : 'S');
    trigger(g, W - 16, L.rt, p ? c.padCfg.trigDead : 0.5, p ? padButtonName(p.kind, PAD.RT) : 'W');
    // the middle: buttons (pad only), then the rider's steer and the actions held
    const mx = W / 2;
    if (p) {
      const b = (i: number) => !!p.buttons[i]?.pressed;
      // face buttons in a diamond, bumpers above, D-pad to the left of the steer bar's centre
      dot(g, mx + 18, 18, 5, b(PAD.Y)); dot(g, mx + 8, 28, 5, b(PAD.X)); dot(g, mx + 28, 28, 5, b(PAD.B)); dot(g, mx + 18, 38, 5, b(PAD.A));
      pill(g, mx - 52, 6, 22, 7, b(PAD.LB)); pill(g, mx + 30, 6, 22, 7, b(PAD.RB));
      pill(g, mx - 25, 14, 6, 9, b(PAD.UP)); pill(g, mx - 25, 32, 6, 9, b(PAD.DOWN)); pill(g, mx - 35, 24, 9, 6, b(PAD.LEFT)); pill(g, mx - 18, 24, 9, 6, b(PAD.RIGHT));
    }
    // steer: a bar from the centre, the share of the edge the rider is asked for
    const bw = 104, by = 56;
    g.fillStyle = 'rgba(255, 255, 255, .15)'; round(g, mx - bw / 2, by, bw, 8, 4); g.fill();
    const s = Math.max(-1, Math.min(1, L.steer));
    g.fillStyle = '#38bdf8';
    if (s > 0) g.fillRect(mx, by, s * bw / 2, 8); else g.fillRect(mx + s * bw / 2, by, -s * bw / 2, 8);
    g.fillStyle = '#fff'; g.fillRect(mx - 1, by - 2, 2, 12);
    g.font = '10px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255, 255, 255, .75)';
    g.fillText(`steer ${s >= 0 ? ' ' : ''}${s.toFixed(2)}`, mx, by + 21);
    // the actions held, lit
    const aw = 30;
    for (let i = 0; i < ACTIONS.length; i++) {
      const on = ACTIONS[i][1](c), x = mx - (ACTIONS.length * aw) / 2 + i * aw + aw / 2;
      g.fillStyle = on ? '#fbbf24' : 'rgba(255, 255, 255, .3)';
      g.font = `${on ? 700 : 400} 9px system-ui, sans-serif`;
      g.fillText(ACTIONS[i][0], x, by + 40);
    }
  }

  dispose(): void { this.root.remove(); }
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function stick(g: CanvasRenderingContext2D, cx: number, cy: number, ax: number, ay: number, dead: number, label: string, dim = false): void {
  g.lineWidth = 1.5;
  g.strokeStyle = dim ? 'rgba(255, 255, 255, .15)' : 'rgba(255, 255, 255, .45)';
  g.beginPath(); g.arc(cx, cy, STICK_R, 0, Math.PI * 2); g.stroke();
  if (dead > 0) { g.strokeStyle = 'rgba(255, 255, 255, .25)'; g.setLineDash([2, 3]); g.beginPath(); g.arc(cx, cy, STICK_R * dead, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); }
  if (dim) return;
  const m = Math.hypot(ax, ay), k = m > 1 ? 1 / m : 1;
  const live = m > dead;
  g.fillStyle = live ? '#38bdf8' : 'rgba(255, 255, 255, .6)';
  g.beginPath(); g.arc(cx + ax * k * STICK_R, cy + ay * k * STICK_R, 6, 0, Math.PI * 2); g.fill();
  if (label) { g.fillStyle = 'rgba(255, 255, 255, .55)'; g.font = '9px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(label, cx, cy + STICK_R + 13); }
}
function trigger(g: CanvasRenderingContext2D, x: number, v: number, dead: number, label: string): void {
  const top = 14, h = 72;
  g.fillStyle = 'rgba(255, 255, 255, .15)'; g.fillRect(x, top, 8, h);
  const f = Math.max(0, Math.min(1, v));
  g.fillStyle = f > dead ? '#fbbf24' : 'rgba(255, 255, 255, .55)';
  g.fillRect(x, top + h * (1 - f), 8, h * f);
  g.fillStyle = '#fff'; g.fillRect(x - 2, top + h * (1 - dead) - 0.5, 12, 1);
  g.fillStyle = 'rgba(255, 255, 255, .55)'; g.font = '9px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText(label, x + 4, top + h + 13);
}
function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number, on: boolean): void {
  g.fillStyle = on ? '#fbbf24' : 'rgba(255, 255, 255, .25)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function pill(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, on: boolean): void {
  g.fillStyle = on ? '#fbbf24' : 'rgba(255, 255, 255, .25)'; round(g, x, y, w, h, Math.min(w, h) / 2); g.fill();
}

// FEAT-376: on the dev server an edit swaps in place (core/hot.ts)
if (import.meta.hot) import.meta.hot.accept((m) => hotSwap(import.meta, m));
