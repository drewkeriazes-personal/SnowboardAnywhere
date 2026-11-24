import type * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { World } from './World';
import { loadStep } from '../core/loadSteps';
import { loadBuilt, saveBuilt, type BuiltKey } from '../core/builtData';
import type { SavedTerrain } from '../terrain/chunkSave';
import type { SavedStems } from '../world/trees/savedStems';

type StreamWorld = Pick<World, 'terrain' | 'veg' | 'rocks' | 'shrubs' | 'buildings' | 'lifts'>;

/**
 * FEAT-377: what the loading screen's terrain is built from, for core/builtData.ts: the pack build, the view it streams
 * (a chunk's detail and the tiles it gets follow the camera), the mogul field's scale and season creep (the menu shot's
 * conditions), the tree lines and the traffic layer (FEAT-380, so a layer added under the same build is not missed); null
 * for a pack without a build id. Terrain.ts's hash covers its imports (Pack.ts and the sets, the tree lines, exposure,
 * oldTracks).
 */
function terrainKey(pack: Pack, camera: THREE.Camera): BuiltKey | null {
  if (!pack.meta.build) return null;
  const p = camera.position, tl = pack.treeLines;
  return {
    what: 'terrain', slug: pack.meta.slug, build: pack.meta.build, code: ['terrain/Terrain.ts'],
    settings: { view: `${p.x},${p.y},${p.z}`, moguls: `${pack.mogulScale},${pack.mogulCreep}`, treeLines: tl ? (tl.baked ? 'baked' : 'runs') : 'off', traffic: JSON.stringify(pack.meta.traffic ?? null) },
  };
}

/** FEAT-377: a streaming pass that took longer than this (ms) did work, so the next one need not wait for a frame */
const BUSY_PASS_MS = 4;
const yieldChannel = new MessageChannel();
const yieldQueue: (() => void)[] = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
/** resolve after the tasks already queued (fetch callbacks, input, rendering), without setTimeout's 4 ms clamp */
const nextTask = (): Promise<void> => new Promise((r) => { yieldQueue.push(r); yieldChannel.port2.postMessage(0); });

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
  const saved = { tb: terrain.budgetMs, tm: terrain.maxBuilds, vb: veg.budgetMs };
  terrain.budgetMs = 12; terrain.maxBuilds = 64; veg.budgetMs = 12;
  // FEAT-377: the near trees gather once the rest has landed, not on every pass a cell arrives (nothing is drawn meanwhile)
  veg.holdNear = true;
  const tiles = () => [pack.fine, pack.coarse, pack.mid, pack.far, pack.mask, pack.ao, pack.dir, pack.moguls, pack.traffic].reduce((n, t) => n + (t?.inFlight ?? 0), 0);
  const t0 = performance.now();
  const r: StreamResult = { settled: false, ms: 0, frames: 0, terrain: 0, tiles: 0, trees: 0, rocks: 0, shrubs: 0 };
  let peak = 1, quiet = 0;
  try {
    while (performance.now() - t0 < timeoutMs) {
      const ti = performance.now();
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
      if (quiet >= 3) { r.settled = true; break; } // three quiet passes: late tile arrivals have had a chance to mark rebuilds
      veg.holdNear = left > 0;
      // FEAT-377: a pass that built something goes again straight after the browser's other tasks (decodes, input,
      // a paint of the bar), not a frame later; one that only waited on downloads waits a frame's time
      await (performance.now() - ti > BUSY_PASS_MS ? nextTask() : new Promise((res) => setTimeout(res, 16)));
    }
  } finally {
    terrain.budgetMs = saved.tb; terrain.maxBuilds = saved.tm; veg.budgetMs = saved.vb;
    veg.holdNear = false;
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
  let t = performance.now();
  // FEAT-377: the terrain this view built on the last load, when nothing it was built from has changed
  const key = terrainKey(pack, camera), stemsKey = pack.meta.build ? w.veg.stemsKey() : null;
  const [saved, stems] = await Promise.all([key && loadBuilt<SavedTerrain>(key), stemsKey && loadBuilt<SavedStems>(stemsKey)]);
  if (saved) w.terrain.restore(saved);
  w.veg.stems.begin(stems || null);
  loadStep('read the last load', t); t = performance.now();
  const streamed = await streamUntilSettled(w, pack, focus, camera, 20000, (left, peak, r) =>
    ls.set(0.85 * (1 - left / peak), `Terrain ${r.terrain + r.tiles} · trees ${r.trees} · rocks ${r.rocks}`));
  w.terrain.endRestore();
  loadStep('stream until settled', t); t = performance.now();
  const newStems = w.veg.stems.snapshot();
  if (!streamed.settled) console.info(`built data: nothing saved, the streaming did not settle (${JSON.stringify(streamed)})`);
  else {
    if (key && !saved) saveBuilt(key, w.terrain.snapshot());
    if (stemsKey && newStems) saveBuilt(stemsKey, newStems);
    loadStep('saved for the next load', t); t = performance.now();
  }
  ls.set(0.9, 'Compiling shaders...');
  await renderer.compileAsync(scene, camera).catch((e) => console.warn('compileAsync failed', e));
  loadStep('compile shaders', t);
  ls.set(0.97, 'Almost there...');
  // riding: small budgets so streaming never spikes a frame; built parent chunks cover any gaps
  w.terrain.budgetMs = 4; w.terrain.maxBuilds = 10; w.veg.budgetMs = 3;
}
