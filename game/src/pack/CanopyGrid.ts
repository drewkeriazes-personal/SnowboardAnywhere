import type { CanopyMeta } from './types';
import { decodeOpaque } from './MaskSet';

/**
 * FEAT-330: the pack's canopy score, `canopy.png` at the pack root (MapPacker FEAT-331): an 8-bit greyscale image,
 * byte / 255 = how closed and tall the canopy is overhead (0 open, 1 a dense glade), on `res` m cells over the pack.
 * Laid out like a cover level (CoverSet.ts): `minX` / `minY` the lower-left corner in pack metres, row 0 the north
 * edge, sampled at the pixel centres. Optional: with no `canopy` key, or a file that does not load, every sample is 0.
 */
export class CanopyGrid {
  readonly meta: CanopyMeta;
  /** pack-frame rectangle: minX, minY, maxX, maxY */
  readonly rect: [number, number, number, number];
  /** one byte per cell, row 0 = north; null until loaded (or when the file failed) */
  private px: Uint8Array | null = null;

  constructor(baseUrl: string, meta: CanopyMeta) {
    this.meta = meta;
    this.rect = [meta.minX, meta.minY, meta.minX + meta.w * meta.res, meta.minY + meta.h * meta.res];
    this.load(baseUrl).catch((e) => console.warn(`canopy ${meta.file} not loaded`, e));
  }

  get loaded(): boolean { return !!this.px; }

  private async load(baseUrl: string): Promise<void> {
    const { w, h, file } = this.meta;
    if (!(w > 0 && h > 0)) throw new Error(`bad size ${w} x ${h}`);
    const resp = await fetch(`${baseUrl}/${file}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (bmp.width !== w || bmp.height !== h) { bmp.close(); throw new Error(`image is ${bmp.width} x ${bmp.height}, meta says ${w} x ${h}`); }
    // greyscale, no alpha: the 2D canvas path is exact (BUG-087)
    const rgba = decodeOpaque(bmp, w, h);
    bmp.close();
    const px = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < px.length; i++, j += 4) px[i] = rgba[j];
    this.px = px;
  }

  /** bilinear canopy score 0..1 at pack (x, y); 0 outside the grid or before it loads */
  sample(x: number, y: number): number {
    const p = this.px, r = this.rect;
    if (!p || x < r[0] || x > r[2] || y < r[1] || y > r[3]) return 0;
    const w = this.meta.w, h = this.meta.h, res = this.meta.res;
    const fx = Math.min(w - 1, Math.max(0, (x - r[0]) / res - 0.5));
    const fy = Math.min(h - 1, Math.max(0, (r[3] - y) / res - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = p[y0 * w + x0], b = p[y0 * w + x1], c = p[y1 * w + x0], d = p[y1 * w + x1];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) / 255;
  }
}
