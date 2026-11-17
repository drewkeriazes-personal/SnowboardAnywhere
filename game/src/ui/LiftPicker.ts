import { Screen, openScreen, closeScreen } from './MenuNav';
import type { LiftRuntime } from '../world/Lifts';
import type { KeyLabels } from './KeyLabels';
import { PAD } from '../sim/Pad';

/** a lift's kind in the list */
const KIND: Record<LiftRuntime['kind'], string> = { chair: 'chairlift', gondola: 'gondola', surface: 'surface lift', carpet: 'carpet' };

/**
 * FEAT-323: the lift picker. Standing in the boarding zones of two or more lifts, E opens this list in the
 * prompt's place, nearest lift first and focused. Up / down (arrows, D-pad, stick) move, E, Enter, Cross or a
 * click boards the focused lift, Esc or Circle closes it. So E twice boards the nearest, as with one lift.
 * The keys go through MenuNav, which keeps them from the riding controls while it is open.
 */
export class LiftPicker {
  readonly el: HTMLDivElement;
  private readonly list: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly screen: Screen;
  private lifts: LiftRuntime[] = [];
  /** a lift was picked */
  onPick: ((l: LiftRuntime) => void) | null = null;
  /** closed without a pick */
  onClose: (() => void) | null = null;
  open = false;

  constructor(private readonly keys: KeyLabels) {
    this.el = document.createElement('div');
    this.el.id = 'lift-pick';
    this.el.innerHTML = '<div class="name">Which lift?</div><div class="list"></div><div class="hint"></div>';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
    this.list = this.el.querySelector('.list')!;
    this.hint = this.el.querySelector('.hint')!;
    this.list.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-i]');
      if (b) this.pick(Number(b.dataset.i));
    });
    this.screen = new Screen(this.el, {
      primary: () => this.list.querySelector<HTMLElement>('button'),
      onBack: () => this.close(),
      // E (the interact key reads as the menus' next-category key) and Triangle / Y (peek) board the focused lift too
      onIntent: (i, down) => {
        if (!down || (i !== 'nextCat' && i !== 'peek')) return i === 'peek'; // Peek's release is ours as well
        this.pickFocused();
        return true;
      },
      onInputKind: () => this.hints(),
    });
  }

  /** Open with the lifts in range, nearest first; `dist` gives each one's distance as shown. */
  show(lifts: LiftRuntime[], dist: (l: LiftRuntime) => string): void {
    this.lifts = lifts;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    this.list.innerHTML = lifts.map((l, i) => `<button data-i="${i}"><span class="ln">${esc(l.feature.name ?? 'Lift')}</span><span class="lk">${KIND[l.kind]} &middot; ${dist(l)}</span></button>`).join('');
    this.el.style.display = '';
    document.body.classList.add('lift-picking');
    this.open = true;
    this.hints();
    openScreen(this.screen);
  }

  close(): void {
    if (!this.open) return;
    this.hide();
    this.onClose?.();
  }

  /** Take it down (the state is leaving). */
  hide(): void {
    if (!this.open) return;
    this.open = false;
    closeScreen(this.screen);
    this.el.style.display = 'none';
    document.body.classList.remove('lift-picking');
  }

  /** Board the focused lift (the nearest when nothing has focus). */
  pickFocused(): void {
    const f = this.screen.focused;
    this.pick(f?.dataset.i ? Number(f.dataset.i) : 0);
  }

  dispose(): void { this.hide(); this.el.remove(); }

  private pick(i: number): void {
    const l = this.lifts[i];
    if (!l || !this.open) return;
    this.hide();
    this.onPick?.(l);
  }

  private hints(): void {
    const { k, padKey, pg } = this.keys;
    const pad = padKey('lift') !== '';
    this.hint.innerHTML = pad
      ? `${k('lift')} ${pg(PAD.A)} board &nbsp; ${pg(PAD.UP)}${pg(PAD.DOWN)} choose &nbsp; ${pg(PAD.B)} close`
      : `${k('lift')} <kbd>Enter</kbd> board &nbsp; <kbd>&uarr;</kbd><kbd>&darr;</kbd> choose &nbsp; <kbd>Esc</kbd> close`;
  }
}
