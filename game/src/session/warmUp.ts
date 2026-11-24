import type * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { World } from './World';

type StreamWorld = Pick<World, 'terrain' | 'veg' | 'rocks' | 'shrubs' | 'buildings' | 'lifts'>;

/** What streamUntilSettled reports: whether the scene went quiet, how long it took, what was still loading at the end. */
export interface StreamResult { settled: boolean; ms: number; frames: number; terrain: number; tiles: number; trees: number; rocks: number; shrubs: number }

/**
 * BUG-063 / FEAT-087: stream terrain, trees and rocks round the camera and `focus` with a large per-frame budget,
 * without drawing and without stepping the sim, until nothing is still downloading or building (three quiet
 * frames in a row) or `timeoutMs` runs out. The budgets are put back as they were at the end. The loading
 * screen's warm-up runs it, and the headless shot tools through `__sim.settleStreaming` (tools/shoot.mjs), so a
 * still is taken of the built scene rather than after a fixed number of frames.
 */
export async function streamUntilSettled(
  w: StreamWorld, pack: Pack, focus: () => { x: number; y: number }, camera: THREE.Camera,
  timeoutMs: number, progress?: (left: number, peak: number, r: StreamResult) => void,
): Promise<StreamResult> {
  const { terrain, veg, rocks, shrubs, buildings, lifts } = w;
  // a timer as well as the animation frame: a headed window in the background gets no animation frames
  const nextFrame = () => new Promise<void>((r) => { const t = setTimeout(r, 50); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  const saved = { tb: terrain.budgetMs, tm: terrain.maxBuilds, vb: veg.budgetMs };
  terrain.budgetMs = 12; terrain.maxBuilds = 64; veg.budgetMs = 12;
  const tiles = () => [pack.fine, pack.mid, pack.far, pack.mask, pack.ao, pack.dir, pack.moguls, pack.traffic].reduce((n, t) => n + (t?.inFlight ?? 0), 0);
  const t0 = performance.now();
  const r: StreamResult = { settled: false, ms: 0, frames: 0, terrain: 0, tiles: 0, trees: 0, rocks: 0, shrubs: 0 };
  let peak = 1, quiet = 0;
  try {
    while (performance.now() - t0 < timeoutMs) {
      camera.updateMatrixWorld();
      const cp = camera.position;
      terrain.update(cp.x, -cp.z, cp.y);
      const f = focus();
      veg.update(f.x, f.y, f.x, f.y, cp);
      rocks.update(f.x, f.y);
      buildings.update(); lifts.reveal(); // BUG-088: shown once the ground under them is real
      shrubs.update(f.x, f.y, f.x, f.y, cp);
      Object.assign(r, { frames: r.frames + 1, terrain: terrain.pending, tiles: tiles(), trees: veg.pending, rocks: rocks.pending, shrubs: shrubs.pending });
      const left = r.terrain + r.tiles + r.trees + r.rocks + r.shrubs;
      peak = Math.max(peak, left);
      progress?.(left, peak, r);
      quiet = left === 0 ? quiet + 1 : 0;
      if (quiet >= 3) { r.settled = true; break; } // three quiet frames: late tile arrivals have had a chance to mark rebuilds
      await nextFrame();
    }
  } finally {
    terrain.budgetMs = saved.tb; terrain.maxBuilds = saved.tm; veg.budgetMs = saved.vb;
  }
  r.ms = Math.round(performance.now() - t0);
  return r;
}

/**
 * BUG-063: build the world around the start behind the loading screen, without drawing (streamUntilSettled,
 * 20 s at most), then compile every shader in the background. The screen then stays up for the first few real
 * frames (HIDE_AFTER_FRAMES in the session), so whatever only the full frame draws (clouds, the body pass, GPU
 * uploads) is paid behind it. The trees and rocks stream round `focus` (the rider, or the camera when it is off
 * the rider: the menu shot, FEAT-177).
 */
export async function warmUp(
  ls: { set(f: number, label: string): void },
  w: StreamWorld, pack: Pack, focus: () => { x: number; y: number },
  renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
): Promise<void> {
  await streamUntilSettled(w, pack, focus, camera, 20000, (left, peak, r) =>
    ls.set(0.85 * (1 - left / peak), `Terrain ${r.terrain + r.tiles} · trees ${r.trees} · rocks ${r.rocks}`));
  ls.set(0.9, 'Compiling shaders...');
  await renderer.compileAsync(scene, camera).catch((e) => console.warn('compileAsync failed', e));
  ls.set(0.97, 'Almost there...');
  // riding: small budgets so streaming never spikes a frame; built parent chunks cover any gaps
  w.terrain.budgetMs = 4; w.terrain.maxBuilds = 10; w.veg.budgetMs = 3;
}
