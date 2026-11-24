/**
 * FEAT-377: fetch and decode a height tile (Terrarium RGB to metres) or a greyscale mask tile (its first channel, BUG-090)
 * in a small pool of workers (tileDecode.worker.ts), so the loading screen's main thread builds the world instead of
 * copying pixels. The same code runs on the main thread where there is no Worker or OffscreenCanvas, or a worker
 * fails, so the bytes are the same either way. Timings feed tools/tileperf.mjs (FEAT-229): `decodeMs` is main-thread time.
 */
import { packCacheMode } from './fetch';

export type TileKind = 'height' | 'grey';
export interface DecodedTile { data: Float32Array | Uint8Array | null; status: number; bytes: number; fetchMs: number; bitmapMs: number; decodeMs: number }

/** the pixel conversion (shared with the worker) */
export function convert(kind: TileKind, px: Uint8ClampedArray): Float32Array | Uint8Array {
  if (kind === 'grey') {
    const out = new Uint8Array(px.length >> 2);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
    return out;
  }
  const out = new Float32Array(px.length >> 2);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const h = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    out[i] = h <= -32767.5 ? NaN : h;
  }
  return out;
}

/** fetch, decode and convert one n x n tile here (the worker's body, and the fallback) */
export async function decodeTile(url: string, n: number, kind: TileKind, cache: RequestCache | undefined): Promise<DecodedTile> {
  const t0 = performance.now();
  const resp = await fetch(url, cache ? { cache } : {}); // FEAT-375's Cache resort files (pack/fetch.ts)
  if (!resp.ok) return { data: null, status: resp.status, bytes: 0, fetchMs: 0, bitmapMs: 0, decodeMs: 0 };
  const blob = await resp.blob();
  const t1 = performance.now();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t2 = performance.now();
  // the tiles are opaque, so the 2D canvas's premultiplied copy is exact (BUG-087)
  const ctx = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, n, n).data;
  bmp.close();
  const data = convert(kind, px);
  return { data, status: resp.status, bytes: blob.size, fetchMs: t1 - t0, bitmapMs: t2 - t1, decodeMs: performance.now() - t2 };
}

const POOL = 3;
let workers: Worker[] | null | undefined;
let next = 0, seq = 0;
const waiting = new Map<number, { resolve: (d: DecodedTile) => void; reject: (e: unknown) => void }>();

function pool(): Worker[] | null {
  if (workers !== undefined) return workers;
  try {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no workers');
    workers = Array.from({ length: POOL }, () => {
      const w = new Worker(new URL('./tileDecode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; tile?: DecodedTile; error?: string }>) => {
        const p = waiting.get(e.data.id);
        waiting.delete(e.data.id);
        if (e.data.tile) p?.resolve(e.data.tile); else p?.reject(new Error(e.data.error));
      };
      w.onerror = () => { workers = null; for (const p of waiting.values()) p.reject(new Error('tile worker failed')); waiting.clear(); };
      return w;
    });
  } catch { workers = null; }
  return workers;
}

/** one tile, in a worker when there are any (absolute `url`, as the worker resolves it against its own) */
export function loadTile(url: string, n: number, kind: TileKind): Promise<DecodedTile> {
  const ws = pool(), cache = packCacheMode();
  if (!ws) return decodeTile(url, n, kind, cache);
  const id = ++seq;
  return new Promise<DecodedTile>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ws[next++ % ws.length].postMessage({ id, url: new URL(url, location.href).toString(), n, kind, cache });
  }).then((d) => ({ ...d, decodeMs: 0 }), () => decodeTile(url, n, kind, cache)); // the worker's decode costs this thread nothing
}
