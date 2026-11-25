import * as THREE from 'three';
import type { Pack } from '../../pack/Pack';

/** crown cover (0..COVER_MAX) from a cover level's forest share R (0..1), shader and CPU alike */
export const COVER_LO = 0.02, COVER_HI = 0.75, COVER_MAX = 0.5;
export function shareOf(r: number): number { const t = Math.max(0, Math.min(1, (r - COVER_LO) / (COVER_HI - COVER_LO))); return t * t * (3 - 2 * t) * COVER_MAX; }
/**
 * Inside the pack the cover's R is a forest mask (nearly 0 or 1 at 4 m), so the density comes from the pack level's B
 * (FEAT-168: where the drawn trees stand, graded per 4 m cell): crown cover = B * COVER_B, at most COVER_MAX.
 */
export const COVER_B = 0.6;
export function shareOfB(b: number): number { return Math.min(COVER_MAX, b * COVER_B); }

const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1); blank.needsUpdate = true;
const offRect = (v: THREE.Vector4): THREE.Vector4 => v.set(-1e7, -1e7, -1e7 + 1000, -1e7 + 1000);
/** the finest three cover levels, coarsest first, for the shaders that read the crown cover (the clumps, BUG-142 the impostors) */
export const coverUniforms = {
  uCov0: { value: blank as THREE.Texture }, uCov1: { value: blank as THREE.Texture }, uCov2: { value: blank as THREE.Texture },
  uCovRect: { value: [0, 1, 2].map(() => offRect(new THREE.Vector4())) },
  uCovLod: { value: new THREE.Vector3() },
  /** 1 where the level's B holds the drawn trees (the pack level), read as the density there */
  uCovB: { value: new THREE.Vector3() },
  uCovBlend: { value: 500 },
};
let seenPack: Pack | null = null, seen = -1;
/** hand the loaded cover levels to the uniforms when they change; true once all are in */
export function syncCover(pack: Pack): boolean {
  const cover = pack.cover;
  if (!cover) return true;
  const loaded = cover.levels.filter((l) => l.loaded && l.texture);
  if (pack !== seenPack || loaded.length !== seen) {
    seenPack = pack; seen = loaded.length;
    const use = loaded.slice(-3), u = coverUniforms;
    const keys = ['uCov0', 'uCov1', 'uCov2'] as const;
    for (let i = 0; i < 3; i++) {
      const l = use[i];
      u[keys[i]].value = l ? l.texture! : blank;
      if (l) u.uCovRect.value[i].set(...l.rect); else offRect(u.uCovRect.value[i]);
      // read the share over about 12 m round the crown
      u.uCovLod.value.setComponent(i, l ? Math.max(0, Math.log2(12 / l.meta.res)) : 0);
      u.uCovB.value.setComponent(i, l?.hasTrees ? 1 : 0);
    }
    u.uCovBlend.value = cover.meta.blend;
  }
  return loaded.length === cover.levels.length;
}

/** coverShare(p): the crown cover (0..COVER_MAX) round pack point p, finest level first (well inside a level nothing coarser is read) */
export const COVER_SHARE_GLSL = /* glsl */ `
  uniform sampler2D uCov0, uCov1, uCov2; uniform vec4 uCovRect[3]; uniform vec3 uCovLod; uniform vec3 uCovB; uniform float uCovBlend;
  float covW(vec2 p, vec4 r) { vec2 d = min(p - r.xy, r.zw - p); return smoothstep(0.0, uCovBlend, min(d.x, d.y)); }
  vec2 covUV(vec2 p, vec4 r) { return vec2((p.x - r.x) / (r.z - r.x), (r.w - p.y) / (r.w - r.y)); }
  // a level's crown cover: its B (the drawn trees) where it has them, else its forest share R through shareOf
  float levelShare(vec4 t, float hasB) {
    float tt = clamp((t.r - ${COVER_LO.toFixed(3)}) / ${(COVER_HI - COVER_LO).toFixed(3)}, 0.0, 1.0);
    return hasB > 0.5 ? min(t.b * ${COVER_B.toFixed(3)}, ${COVER_MAX.toFixed(3)}) : tt * tt * (3.0 - 2.0 * tt) * ${COVER_MAX.toFixed(3)};
  }
  float coverShare(vec2 p) {
    float w2 = covW(p, uCovRect[2]);
    float f2 = w2 > 0.0 ? levelShare(textureLod(uCov2, covUV(p, uCovRect[2]), uCovLod.z), uCovB.z) : 0.0;
    if (w2 >= 1.0) return f2;
    float w1 = covW(p, uCovRect[1]);
    float f1 = w1 > 0.0 ? levelShare(textureLod(uCov1, covUV(p, uCovRect[1]), uCovLod.y), uCovB.y) : 0.0;
    if (w1 >= 1.0) return mix(f1, f2, w2);
    float w0 = covW(p, uCovRect[0]);
    float f0 = w0 > 0.0 ? levelShare(textureLod(uCov0, covUV(p, uCovRect[0]), uCovLod.x), uCovB.x) : 0.0;
    float f = f0 * w0, c = w0;
    f = mix(f, f1, w1); c = mix(c, 1.0, w1);
    f = mix(f, f2, w2); c = mix(c, 1.0, w2);
    return c > 1e-4 ? f / c : 0.0;
  }
`;
