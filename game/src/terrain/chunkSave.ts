/**
 * FEAT-377: the terrain's built chunks packed for core/builtData.ts, and back. Only each chunk's grid vertices are kept
 * (the skirt and the index are made again by Terrain.finish, and the positions' x and z are the grid's), each attribute
 * whole or, when every vertex has the same value (no moguls, open sky), as that one number. The numbers are the very
 * Float32 values the build wrote, so a restored chunk draws exactly as a built one.
 */

/** a chunk's vertex arrays as Terrain builds them (grid vertices first, then the skirt) */
export interface ChunkArrays { pos: Float32Array; nor: Float32Array; col: Float32Array; forest: Float32Array; lift: Float32Array; ao: Float32Array; fall: Float32Array; mogul: Float32Array; mogLine: Float32Array;
  /** FEAT-380: the near chunks' old tracks; null on the far ones (they share Terrain's noTrack) */
  track: Float32Array | null }
/** what places a chunk in the quadtree, and the data resolution it was built from */
export interface ChunkMeta { level: number; x: number; y: number; minX: number; minY: number; size: number; res: number; dataRes: number }
export interface SavedTerrain { meta: Float64Array; layout: Uint8Array; data: Float32Array }

/** the kept parts: array, components per vertex, the first component kept, how many kept */
const PARTS: [keyof ChunkArrays, number, number, number][] = [
  ['pos', 3, 1, 1], ['nor', 3, 0, 3], ['col', 3, 0, 3], ['forest', 1, 0, 1], ['lift', 1, 0, 1], ['ao', 1, 0, 1], ['fall', 2, 0, 2], ['mogul', 4, 0, 4], ['mogLine', 1, 0, 1], ['track', 3, 0, 3],
];
const META = 9;

/** pack the grid vertices (n x n) of each chunk */
export function packChunks(n: number, list: { c: ChunkMeta; a: ChunkArrays }[]): SavedTerrain {
  const g = n * n;
  const meta = new Float64Array(list.length * META), layout = new Uint8Array(list.length * PARTS.length);
  const out: Float32Array[] = [];
  let len = 0;
  list.forEach(({ c, a }, k) => {
    meta.set([c.level, c.x, c.y, c.minX, c.minY, c.size, c.res, c.dataRes, a.track ? 1 : 0], k * META);
    PARTS.forEach(([name, stride, first, count], p) => {
      const src = a[name];
      if (!src) return; // no track
      for (let q = 0; q < count; q++) {
        const v0 = src[first + q];
        let same = true;
        for (let v = 1; v < g && same; v++) same = Object.is(src[v * stride + first + q], v0); // -0 and NaN kept as they are
        if (same) layout[k * PARTS.length + p] |= 1 << q;
        const part = new Float32Array(same ? 1 : g);
        if (same) part[0] = v0; else for (let v = 0; v < g; v++) part[v] = src[v * stride + first + q];
        out.push(part); len += part.length;
      }
    });
  });
  const data = new Float32Array(len);
  let o = 0;
  for (const part of out) { data.set(part, o); o += part.length; }
  return { meta, layout, data };
}

/** unpack each chunk into new full-size arrays (grid and skirt; the caller fills the positions' x and z and the skirt) */
export function unpackChunks(n: number, s: SavedTerrain, each: (meta: ChunkMeta, a: ChunkArrays) => void): void {
  const g = n * n, verts = g + 4 * n;
  let o = 0;
  for (let k = 0; k < s.meta.length / META; k++) {
    const m = s.meta.subarray(k * META, (k + 1) * META);
    const a = { pos: new Float32Array(verts * 3), nor: new Float32Array(verts * 3), col: new Float32Array(verts * 3), forest: new Float32Array(verts), lift: new Float32Array(verts), ao: new Float32Array(verts), fall: new Float32Array(verts * 2), mogul: new Float32Array(verts * 4), mogLine: new Float32Array(verts), track: m[8] ? new Float32Array(verts * 3) : null };
    PARTS.forEach(([name, stride, first, count], p) => {
      const dst = a[name], flags = s.layout[k * PARTS.length + p];
      if (!dst) return;
      for (let q = 0; q < count; q++) {
        if (flags & (1 << q)) { const v0 = s.data[o++]; for (let v = 0; v < g; v++) dst[v * stride + first + q] = v0; }
        else { for (let v = 0; v < g; v++) dst[v * stride + first + q] = s.data[o + v]; o += g; }
      }
    });
    each({ level: m[0], x: m[1], y: m[2], minX: m[3], minY: m[4], size: m[5], res: m[6], dataRes: m[7] }, a);
  }
}
