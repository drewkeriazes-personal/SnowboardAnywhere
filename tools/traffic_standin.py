"""FEAT-380 dev tool: a STAND-IN traffic layer for a downloaded pack, to see the game's old tracks follow `meta.traffic`
before MapPacker FEAT-379 bakes the real one. Not pipeline output and never published: it guesses from the pack's own
runs (features.json), nothing more.

    python tools/traffic_standin.py packs/vail            # writes packs/vail/traffic/*.png and meta.traffic
    python tools/traffic_standin.py packs/vail --remove   # takes them out again

Format (agreed on issue #860): RGB tiles on the mask's tile grid at 4 m (256 px tiles), R, G the mean travel direction
(x east, y north, byte = (v * 0.5 + 0.5) * 255, length = coherence), B the density 0..255.
The guess: along each run line, downhill (from its points' heights), over a width by difficulty; density by difficulty
(busy greens and blues, quiet expert lines), less toward the edges; groomed runs coherent, ungroomed ones spread, a
flat narrow groomed run (a cat track) the most coherent of all; overlapping runs add their vectors (groomed ones count
more, as the snow there is the groomer's), so where lines meet the direction averages and the coherence drops; a light blur; off the runs nobody (density 0).
"""
import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

RES, TILE = 4.0, 256
HALF_WIDTH = {"novice": 25.0, "easy": 25.0, "intermediate": 20.0, "advanced": 15.0, "expert": 12.0, "freeride": 12.0}
DENSITY = {"novice": 0.85, "easy": 0.85, "intermediate": 0.75, "advanced": 0.5, "expert": 0.3, "freeride": 0.25}
CAT_SLOPE = 0.12  # a groomed run flatter than this (rise / run) is a cat track


def paint(vec, dens, wsum, minx, miny, a, b, hw, d0, coh, wt):
    """one run segment a -> b (pack m, downhill) into the grids, its vector weighted by wt"""
    (x0, y0), (x1, y1) = a, b
    seg = np.array([x1 - x0, y1 - y0])
    ln = float(np.hypot(*seg))
    if ln < 1e-3:
        return
    u = seg / ln
    i0 = max(0, int((min(x0, x1) - hw - minx) / RES)); i1 = min(vec.shape[1] - 1, int((max(x0, x1) + hw - minx) / RES))
    j0 = max(0, int((min(y0, y1) - hw - miny) / RES)); j1 = min(vec.shape[0] - 1, int((max(y0, y1) + hw - miny) / RES))
    if i1 < i0 or j1 < j0:
        return
    xs = minx + (np.arange(i0, i1 + 1) + 0.5) * RES
    ys = miny + (np.arange(j0, j1 + 1) + 0.5) * RES
    X, Y = np.meshgrid(xs, ys)
    t = np.clip((X - x0) * u[0] + (Y - y0) * u[1], 0, ln)
    d = np.hypot(X - (x0 + t * u[0]), Y - (y0 + t * u[1]))
    w = np.clip(1 - (d / hw) ** 2, 0, 1)
    dw = w
    w = w * wt
    sl = (slice(j0, j1 + 1), slice(i0, i1 + 1))
    vec[sl + (0,)] += w * coh * u[0]
    vec[sl + (1,)] += w * coh * u[1]
    wsum[sl] += w
    dens[sl] = np.maximum(dens[sl], dw * d0 * (1 - 0.5 * (d / hw) ** 2))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pack", type=Path)
    ap.add_argument("--remove", action="store_true")
    args = ap.parse_args()
    meta_p = args.pack / "meta.json"
    meta = json.loads(meta_p.read_text())
    out = args.pack / "traffic"
    if args.remove:
        meta.pop("traffic", None)
        meta_p.write_text(json.dumps(meta, indent=1))
        shutil.rmtree(out, ignore_errors=True)
        print(f"removed the stand-in traffic layer from {args.pack}")
        return
    m = meta["mask"]
    span = m["res"] * m["tileSize"]
    tiles_x, tiles_y = m["tilesX"], m["tilesY"]
    n = int(span / RES)
    assert n == TILE, "the mask's tiles must span 1024 m (4 m x 256 px)"
    minx, miny = m["minX"], m["minY"]
    vec = np.zeros((tiles_y * n, tiles_x * n, 2), np.float32)
    wsum = np.zeros(vec.shape[:2], np.float32)
    dens = np.zeros(vec.shape[:2], np.float32)
    runs = json.loads((args.pack / "features.json").read_text())["runs"]
    for r in runs:
        pts = r["points"]
        diff = r.get("difficulty") or "intermediate"
        groomed = bool(r.get("groomed"))
        hw, d0 = HALF_WIDTH.get(diff, 18.0), DENSITY.get(diff, 0.6)
        if not groomed:
            hw, d0 = hw * 1.5, d0 * 0.6
        for p, q in zip(pts, pts[1:]):
            if p[2] < q[2]:
                p, q = q, p
            ln = math.hypot(q[0] - p[0], q[1] - p[1])
            cat = groomed and ln > 0 and (p[2] - q[2]) / ln < CAT_SLOPE
            coh = 0.95 if cat else 0.8 if groomed else 0.35
            paint(vec, dens, wsum, minx, miny, p[:2], q[:2], 12.0 if cat else hw, 0.9 if cat else d0, coh, 1.0 if groomed else 0.3)
    v = vec / np.maximum(wsum, 1e-6)[..., None]
    v[..., 0] = gaussian_filter(v[..., 0], 2)
    v[..., 1] = gaussian_filter(v[..., 1], 2)
    dens = gaussian_filter(dens, 1.5)
    rgb = np.stack([(np.clip(v[..., 0], -1, 1) * 0.5 + 0.5) * 255, (np.clip(v[..., 1], -1, 1) * 0.5 + 0.5) * 255,
                    np.clip(dens, 0, 1) * 255], -1).round().astype(np.uint8)
    out.mkdir(exist_ok=True)
    for ty in range(tiles_y):
        for tx in range(tiles_x):
            # array rows run south to north; image row 0 is the tile's north edge
            Image.fromarray(np.flipud(rgb[ty * n:(ty + 1) * n, tx * n:(tx + 1) * n])).save(out / f"{tx}_{ty}.png")
    meta["traffic"] = {"res": RES, "tileSize": TILE, "minX": minx, "minY": miny, "tilesX": tiles_x, "tilesY": tiles_y}
    meta_p.write_text(json.dumps(meta, indent=1))
    print(f"stand-in traffic layer: {tiles_x * tiles_y} tiles in {out}, meta.traffic set")


if __name__ == "__main__":
    main()
