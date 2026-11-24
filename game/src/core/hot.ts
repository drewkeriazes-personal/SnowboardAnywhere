import { Toast } from '../ui/Toast';

/**
 * FEAT-376, dev server only: hot module reload for the modules that can be swapped in place. Every call site sits
 * under `if (import.meta.hot)`, which the build drops, so nothing here reaches the built game.
 *
 * A hot module ends with `if (import.meta.hot) import.meta.hot.accept((m) => hotSwap(import.meta, m));` (Vite only
 * sees an accept written out as `import.meta.hot.accept(`). On an edit the new copy of the module is loaded and
 * `hotSwap` copies its classes' methods onto the prototypes the live objects were made from, so the rider, the
 * camera, the audio and the menus keep their state (and the pack, terrain and trees stay as they are) and run the
 * new code from the next call. Modules it imports that changed come with it: a tuning edit reaches the rider
 * through `sim/Rider.ts`. What a swap can't carry reloads the page: an export the importers hold (a constant, a
 * plain function, an object) that changed, or a class whose fields, constructor or statics changed (the live
 * objects were built by the old ones). Which files may try at all is the list in `tools/dev_hot.mjs`; any other
 * source edit reloads. Not caught: a plain exported function whose source is unchanged but reads a module constant
 * that changed keeps the old constant in its importers.
 */

type Ns = Record<string, unknown>;
const src = (f: unknown): string => Function.prototype.toString.call(f);
const isClass = (v: unknown): v is new (...a: never[]) => object => typeof v === 'function' && /^class\b/.test(src(v));

/** A class's source with its prototype methods cut out: the fields, constructor and statics live objects were built from. */
function skeleton(c: new (...a: never[]) => object): string {
  let s = src(c);
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(c.prototype))) {
    if (k !== 'constructor') for (const f of [d.value, d.get, d.set]) if (typeof f === 'function') s = s.replace(src(f), '');
  }
  return s;
}

/** What an importer holding this export depends on; two copies that differ here can't be swapped. */
function shape(v: unknown): string {
  if (isClass(v)) return skeleton(v);
  if (typeof v === 'function') return src(v);
  try { return JSON.stringify(v, (_k, x) => (typeof x === 'function' ? src(x) : x)) ?? String(v); } catch { return `uncomparable ${Math.random()}`; }
}

const NOTE = 'sba-hot-reload';
/** Keep why the page is about to reload for the toast after it (the first reason wins). */
function note(why: string): void {
  try { if (!sessionStorage.getItem(NOTE)) sessionStorage.setItem(NOTE, why); } catch { /* the toast is a nicety */ }
}

/** Give up on a hot update: Vite carries it to the importers, and with none that can take it, reloads the page. */
export function hotReload(meta: ImportMeta, why: string): void {
  note(why);
  meta.hot?.invalidate(why);
}

/** Keep each class export's prototype, so later updates patch every copy live objects were made from. */
function keep(protos: Map<string, object[]>, ns: Ns): void {
  for (const [k, v] of Object.entries(ns)) if (isClass(v)) protos.set(k, [...(protos.get(k) ?? []), v.prototype]);
}

/** Swap a module's new copy (`next`) in place, or reload if it can't be (see the top of this file). */
export async function hotSwap(meta: ImportMeta, next: Ns | undefined): Promise<void> {
  const hot = meta.hot;
  if (!hot) return;
  const file = new URL(meta.url).pathname.replace(/^\/src\//, '');
  if (!next) return hotReload(meta, `${file} did not load`);
  // the first update runs in the first copy's callback, so meta.url is the copy the page started with
  if (!hot.data.prev) { hot.data.prev = await import(/* @vite-ignore */ meta.url); hot.data.protos = new Map(); keep(hot.data.protos, hot.data.prev); }
  const prev: Ns = hot.data.prev;
  const changed = Object.keys({ ...prev, ...next }).find((k) => shape(prev[k]) !== shape(next[k]));
  if (changed) return hotReload(meta, `${file}: ${changed} changed (more than its methods)`);
  const protos: Map<string, object[]> = hot.data.protos;
  for (const [k, v] of Object.entries(next)) {
    if (!isClass(v)) continue;
    const methods = Object.entries(Object.getOwnPropertyDescriptors(v.prototype)).filter(([m]) => m !== 'constructor');
    for (const p of protos.get(k) ?? []) for (const [m, d] of methods) Object.defineProperty(p, m, d);
  }
  keep(protos, next);
  hot.data.prev = next;
}

/** The dev toast for what each edit did: "hot update: <file>", or after a reload "reloaded: <why>" (main.ts). */
export function watchHot(hot: NonNullable<ImportMeta['hot']>): void {
  const toast = new Toast();
  const el = document.getElementById('toast');
  let lower = 0;
  // raised to the release toasts' layer (over the main menu) while it shows; game toasts keep their own
  const show = (text: string, ms = 4000): void => {
    toast.show(text, ms);
    el?.style.setProperty('z-index', '25');
    clearTimeout(lower);
    lower = window.setTimeout(() => el?.style.removeProperty('z-index'), ms + 300);
  };
  try {
    const why = sessionStorage.getItem(NOTE);
    if (why) { sessionStorage.removeItem(NOTE); show(`reloaded: ${why}`, 6000); }
  } catch { /* no storage, no toast */ }
  // tools/dev_hot.mjs names each changed source file before Vite sends its update
  let last = '';
  hot.on('sba:change', (c: { file: string; hot: boolean }) => {
    last = c.file;
    if (!c.hot) note(`${c.file} changed (not hot-swappable)`);
  });
  hot.on('vite:afterUpdate', () => show(`hot update: ${last}`));
  hot.on('vite:beforeFullReload', () => note(`${last || 'a file'} changed (nothing could take it in place)`));
}
