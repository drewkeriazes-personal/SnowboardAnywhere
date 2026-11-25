/// <reference lib="webworker" />
// FEAT-377: tileDecode.ts's pool: one tile per message, the result's buffer transferred back
import { decodeTile, type TileKind } from './tileDecode';

self.onmessage = async (e: MessageEvent<{ id: number; url: string; n: number; kind: TileKind; cache?: RequestCache }>) => {
  const { id, url, n, kind, cache } = e.data;
  try {
    const tile = await decodeTile(url, n, kind, cache);
    (self as unknown as Worker).postMessage({ id, tile }, tile.data ? [tile.data.buffer] : []);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
