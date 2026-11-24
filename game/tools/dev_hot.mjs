import path from 'node:path';

/**
 * FEAT-376, dev server only: the source files (under game/src) whose edits may hot-update in place. Each either swaps
 * itself (`hotSwap` in src/core/hot.ts) or is imported only by modules that do. Any other source edit reloads the
 * page, so a shader, material or scene-setup change never runs beside the scene the old code built. A listed file
 * can still reload: when one of its importers can't take it (Vite's own rule) or the swap finds a change it can't
 * carry (hot.ts). CSS keeps Vite's own hot update.
 */
export const HOT = [
  // the rider: tuning and the steps reach the live rider through sim/Rider.ts (world/Rocks.ts reloads for a rock constant)
  'sim/Rider.ts', 'sim/rider/', 'sim/SnowConditions.ts',
  'audio/Audio.ts', 'audio/Jukebox.ts', 'audio/ChaseAudio.ts',
  'world/ChaseCamera.ts',
  // the HUD line, prompts and key hints reach the live frame through states/RideFrame.ts
  'ui/HudLine.ts', 'ui/Conditions.ts', 'ui/ContextPrompt.ts', 'ui/KeyHints.ts',
  'ui/MainMenu.ts', 'ui/PauseMenu.ts', 'ui/RunCard.ts', 'ui/TrialHud.ts', 'ui/GoggleView.ts', 'ui/InputView.ts',
  'ui/PressMeter.ts', 'ui/RestartRing.ts', 'ui/SpeedLines.ts', 'ui/OutrunUI.ts', 'ui/ReplayBar.ts', 'ui/LiftPicker.ts',
  'ui/Labels.ts', 'ui/ResortMap.ts',
];

/** The Vite plugin: tells the page which file changed (its toast) and reloads for a source file not on the list. */
export function devHot(srcDir) {
  return {
    name: 'dev-hot',
    apply: 'serve',
    handleHotUpdate({ file, modules, server }) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (rel.startsWith('..') || !modules.length) return; // not the game's source, or not loaded: Vite's own handling
      const hot = !/\.[jt]s$/.test(rel) || HOT.some((h) => (h.endsWith('/') ? rel.startsWith(h) : rel === h));
      server.ws.send('sba:change', { file: rel, hot });
      if (hot) return;
      server.config.logger.info(`reload: ${rel} is not hot-swappable (tools/dev_hot.mjs)`, { timestamp: true });
      server.ws.send({ type: 'full-reload', path: '*' });
      return [];
    },
  };
}
