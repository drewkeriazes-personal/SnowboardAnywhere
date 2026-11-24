import * as THREE from 'three';
import type { Pack } from '../pack/Pack';
import type { Difficulty } from '../pack/types';

const COLORS: Record<string, number> = {
  novice: 0x22c55e,
  easy: 0x22c55e,
  intermediate: 0x3b82f6,
  advanced: 0x111111,
  expert: 0x111111,
  extreme: 0xf97316,
  freeride: 0xf97316,
};

/** FEAT-054: share of the view distance the lines are drawn toward the camera, so the coarse far terrain
 *  (the mountain view's whole-resort overview) doesn't swallow them; a ridge in front still hides them */
const DEPTH_PULL = 0.005;

/**
 * Piste centre lines draped just above the snow, coloured by difficulty: P toggles them while riding, and the
 * mountain view (FEAT-054) shows them. One draw call (FEAT-054: it was a line per run).
 */
export class RunsOverlay {
  readonly group = new THREE.Group();

  constructor(pack: Pack) {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    for (const run of pack.features.runs) {
      if (run.points.length < 2) continue;
      c.setHex(COLORS[(run.difficulty ?? 'intermediate') as Difficulty] ?? 0x888888);
      for (let i = 1; i < run.points.length; i++) {
        for (const [x, y, z] of [run.points[i - 1], run.points[i]]) { pos.push(x, Math.max(z, pack.groundHeight(x, y)) + 0.6, -y); col.push(c.r, c.g, c.b); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, fog: false });
    mat.onBeforeCompile = (s) => {
      s.vertexShader = s.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\n  mvPosition.xyz *= ${(1 - DEPTH_PULL).toFixed(4)}; gl_Position = projectionMatrix * mvPosition;`);
    };
    const lines = new THREE.LineSegments(geo, mat);
    lines.name = 'runs';
    this.group.add(lines);
    this.group.visible = false;
  }

  toggle(): void {
    this.group.visible = !this.group.visible;
  }
}
