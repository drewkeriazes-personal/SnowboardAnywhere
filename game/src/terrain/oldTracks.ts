/**
 * FEAT-380: old ski and board tracks on skied snow (FEAT-077's `uSkied`), laid where riders go.
 *
 * Each terrain vertex near the rider carries a `track` attribute: xy the travel direction in the three.js ground frame
 * (x east, then z: south) with its length the coherence (1 = everyone goes the same way, as on a cat track; short =
 * directions spread, as in an open bowl), z the density (0 = nobody rides here). It comes from the pack's traffic layer
 * (`meta.traffic`, MapPacker FEAT-379) where the pack has one, else from what the chunk already knows: the groomed run's
 * axis (the `dir` set, as the corduroy) on groomed snow and the 6 m fall line elsewhere. Sampled at chunk build, like
 * `dir`, so drawing it costs no texture read and no per-frame CPU.
 *
 * The shader (`TRACK_GLSL`) draws three families of tracks. A family's direction is the travel direction turned by up to
 * about 50 degrees where coherence is low (bowls: tracks cross) and a few where it is high (cat tracks), and the grooves
 * run along the nearest of 12 fixed world directions, blending to the next as the field turns (as the corduroy does),
 * so they stay put on the snow: a direction turned per pixel about the world origin swung the old grooves into short
 * slashes wherever the run curved. Within a family each slot across the direction may hold a track with its own place,
 * turn size, rhythm, width and phase; a 1D noise along it starts and stops it, so density sets how many hold one; low
 * frequency noise moves the families sideways by different amounts (wander, no hallway of parallel lines) and clumps the
 * density. Height and gradient come out analytically in one pass; the normal pass reuses them.
 */

/** chunks at or below this vertex spacing (m) carry the attribute; the tracks fade out by 70 m, inside the 1 and 2 m chunks */
export const TRACK_MAX_RES = 4;
/** no traffic layer: coherence along a groomed run's axis, and on the fall line once the slope reaches FALL_FULL (rise / run) */
const RUN_COHERENCE = 0.9;
const FALL_COHERENCE = 0.45;
const FALL_FLAT = 0.03, FALL_FULL = 0.15;
/** no traffic layer: density on groomed and on ungroomed snow (today's look: about half the slots hold a track) */
const GROOMED_DENSITY = 0.55;
const OFF_PISTE_DENSITY = 0.45;

/**
 * Fill vertex v's `track` attribute. traffic: the traffic layer's [R, G, B] in 0..1 here, or null (no layer, or its tile
 * is not in yet: the fallback, rebuilt when it lands). fx, fz: downhill in three.js xz (the run axis on groomed snow when
 * `runAxis`, else the fall line; any length).
 */
export function trackVertex(out: Float32Array, v: number, traffic: number[] | null, fx: number, fz: number, runAxis: boolean, groomed: boolean): void {
  if (traffic) {
    out[v * 3] = traffic[0] * 2 - 1; out[v * 3 + 1] = -(traffic[1] * 2 - 1); out[v * 3 + 2] = traffic[2]; // pack north = three.js -z
    return;
  }
  const l = Math.hypot(fx, fz);
  const t = Math.min(1, Math.max(0, (l - FALL_FLAT) / (FALL_FULL - FALL_FLAT)));
  const c = l > 1e-6 ? (runAxis ? RUN_COHERENCE : FALL_COHERENCE * t * t * (3 - 2 * t)) / l : 0;
  out[v * 3] = fx * c; out[v * 3 + 1] = fz * c; out[v * 3 + 2] = groomed ? GROOMED_DENSITY : OFF_PISTE_DENSITY;
}

/** Fragment shader functions (after NOISE_GLSL). `oldTracks` returns x = height (-1..0), yz = its gradient (per m, world x, z). */
export const TRACK_GLSL = /* glsl */ `
  #define TRK_BINS 12.0
  // one family's grooves along fixed world direction bin kb: x = height, yz = gradient
  vec3 trackSet(vec2 p, float kb, float fi, float S, float dens, float swing, float wob, float wide) {
    float a = kb * (3.14159265 / TRK_BINS);
    vec2 d = vec2(cos(a), sin(a)), acr = vec2(-d.y, d.x);
    float al = dot(p, d), ac = dot(p, acr) + wob;
    float k0 = floor(ac / S), thr = 1.0 - dens;
    vec3 r = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
      float k = k0 + float(j);
      vec3 seed = vec3(k, kb + 17.0 * fi, 5.0);
      float h1 = hash3(seed), h2 = hash3(seed + 31.7);
      // starts and stops: a value noise along the track, 15 to 45 m a step; it holds a track where it tops 1 - density
      float s = al / mix(15.0, 45.0, h2) + 9.0 * h1, sf = floor(s);
      float g = mix(hash3(seed + vec3(0.0, sf, 3.1)), hash3(seed + vec3(0.0, sf + 1.0, 3.1)), smoothstep(0.0, 1.0, s - sf));
      float on = smoothstep(thr - 0.08, thr + 0.08, g);
      if (on < 0.01) continue;
      // its own place in the slot, turn size and rhythm (12 to 40 m a turn pair), phase and width
      float A = S * mix(0.1, 0.75, fract(h1 * 7.13)) * swing, w = mix(0.16, 0.5, fract(h2 * 5.71)), ph = 6.2831853 * fract(h1 * 3.37);
      float sn = sin(al * w + ph);
      float dd = ac - (k + 0.2 + 0.6 * h1) * S - A * sn;
      float s2 = mix(0.0025, 0.007, fract(h2 * 9.31)) * wide;
      float e = on * exp(-dd * dd / s2);
      // the deepest groove here wins: crossing tracks do not add up into a dark knot
      if (e > -r.x) r = vec3(-e, e * 2.0 * dd / s2 * (acr - A * w * cos(al * w + ph) * d));
    }
    return r;
  }
  // tv: travel direction (world xz, length = coherence); dens 0..1; wide: groove width factor (spring slush)
  vec3 oldTracks(vec2 p, vec2 tv, float dens, float wide) {
    float coh = min(length(tv), 1.0);
    float th = atan(tv.y, tv.x);
    // uneven traffic: clumps and gaps; and the per-pixel noise phase that keeps the families from running in step
    float clump = vnoise(vec3(p * 0.025, 3.0));
    float n1 = vnoise(vec3(p * 0.06, 9.0)), n2 = vnoise(vec3(p * 0.06, 21.0));
    float densC = clamp(dens * (0.45 + 1.1 * clump), 0.0, 1.0);
    float spread = mix(0.85, 0.1, coh), swing = mix(1.0, 0.35, coh), wander = mix(2.5, 0.6, coh);
    vec3 r = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float nf = i == 0 ? n1 : i == 1 ? n2 : 1.0 - 0.5 * (n1 + n2);
      float ang = th + (fi - 1.0) * spread + (nf - 0.5) * spread * 0.8;
      float u = mod(ang, 3.14159265) / (3.14159265 / TRK_BINS);
      float kb = floor(u), t = smoothstep(0.35, 0.65, u - kb);
      float S = 2.2 + 1.0 * fi, wob = (nf - 0.5) * wander * (1.0 + 0.6 * fi);
      vec3 f = vec3(0.0);
      if (t < 1.0) f = trackSet(p, kb, fi, S, densC, swing, wob, wide) * (1.0 - t);
      if (t > 0.0) f += trackSet(p, mod(kb + 1.0, TRK_BINS), fi, S, densC, swing, wob, wide) * t;
      if (f.x < r.x) r = f;
    }
    return r;
  }
`;
