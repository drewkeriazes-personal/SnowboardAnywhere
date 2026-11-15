/**
 * FEAT-318: Settings > Launcher > Browser, which browser SnowboardAnywhere.exe opens the game in. The choice lives
 * in the launcher's launcher.json, not in the game's settings, and is read and changed through the launcher's
 * /__launcher/browsers and /__launcher/browser routes (tools/launcher_browser.mjs). The dev server and
 * `npm run host` have no such routes, so `state` stays null there and the Launcher category hides.
 */
export interface LauncherBrowsers {
  available: boolean;
  /** 'default' or the chosen exe's path */
  current: string;
  /** the Windows default's name, when the launcher could tell */
  defaultName: string | null;
  browsers: { name: string; path: string }[];
}

let state: LauncherBrowsers | null = null;
let status = '';
const listeners = new Set<() => void>();
const changed = () => { for (const f of listeners) f(); };

async function call(url: string, body?: unknown): Promise<LauncherBrowsers | null> {
  try {
    const r = await fetch(url, body === undefined ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const j = await r.json() as LauncherBrowsers & { picked?: boolean };
    return j && j.available && Array.isArray(j.browsers) ? j : null;
  } catch { return null; } // the dev server answers index.html (not JSON) for an unknown path
}

export const launcherBrowser = {
  /** null when the game isn't running from the launcher exe */
  get state(): LauncherBrowsers | null { return state; },
  /** a line for the Other... row while its file picker is open, or what happened */
  get status(): string { return status; },
  onChange(f: () => void): void { listeners.add(f); },

  /** read the list again (each time Settings opens, so a change made in the console shows) */
  async load(): Promise<void> {
    const j = await call('/__launcher/browsers');
    if (j || state) { state = j; changed(); }
  },

  opts(): [string, string][] {
    if (!state) return [];
    return [['default', `Windows default${state.defaultName ? ` (${state.defaultName})` : ''}`], ...state.browsers.map((b) => [b.path, b.name] as [string, string])];
  },

  /** pick one of the listed browsers (or 'default'); shown at once, saved by the launcher */
  choose(path: string): void {
    if (!state || state.current === path) return;
    state = { ...state, current: path };
    status = '';
    changed();
    void call('/__launcher/browser', { path }).then((j) => {
      if (j) state = j; else status = 'The launcher did not take it: is SnowboardAnywhere.exe still running?';
      changed();
    });
  },

  /** Other...: the launcher opens a file picker for any .exe on this PC */
  async other(): Promise<void> {
    if (!state) return;
    status = 'Pick the browser\'s .exe in the window that opened on this PC (it may be behind the game).';
    changed();
    const j = await call('/__launcher/browser', { other: true }) as (LauncherBrowsers & { picked?: boolean }) | null;
    if (j) { state = j; status = j.picked ? '' : 'Nothing picked.'; } else status = 'The launcher could not open the file picker.';
    changed();
  },
};
