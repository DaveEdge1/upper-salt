"""Elevation tiles along the river corridor, so close-up contours load from the site instead of
waiting on the USGS elevation service for every tile.

Writes data/<slug>/dem/{z}/{x}/{y}.png for zoom 13 and 14 (Web Mercator tiles) within a buffer of
the main stem, plus data/<slug>/dem/manifest.json listing them. Each PNG is a 258 x 258 grid (the
256 x 256 tile plus a one-pixel border, so contours meet across tile edges) with elevation packed
into red and green: feet = R * 256 + G - 1000 (1 ft steps). Blue 0 marks no data.
The page draws zoom 13-16 contours from these (zoom 15-16 enlarge a part of the zoom 14 tile).

Elevation is requested in large blocks (up to 8 x 8 tiles per request) and cut into tiles here.
Source: USGS 3DEP Elevation ImageServer. Needs numpy and pillow.

Usage: python site/build/build_dem_tiles.py salt [buffer_km, default 5]
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

SITE = Path(__file__).resolve().parents[1]
DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?"
UA = "river-trip-planner-build/0.1"
WORLD = 20037508.342789244
ZOOMS = (13, 14)
BLOCK = 8  # tiles per block side


def tile_xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def fetch_block(x0, y0, nx, ny, z):
    """Float elevation (m) for tiles x0..x0+nx-1, y0..y0+ny-1 plus a one-pixel border."""
    size = WORLD * 2 / 2 ** z
    px = size / 256
    minx = -WORLD + x0 * size - px
    maxx = -WORLD + (x0 + nx) * size + px
    maxy = WORLD - y0 * size + px
    miny = WORLD - (y0 + ny) * size - px
    w, h = nx * 256 + 2, ny * 256 + 2
    url = DEM_URL + urllib.parse.urlencode(dict(
        bbox=f"{minx:.2f},{miny:.2f},{maxx:.2f},{maxy:.2f}", bboxSR=3857, imageSR=3857, size=f"{w},{h}",
        format="bsq", pixelType="F32", interpolation="RSP_BilinearInterpolation", f="image"))
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                buf = r.read()
            a = np.frombuffer(buf[: w * h * 4], dtype="<f4").reshape(h, w)
            return np.where(a < -1000, np.nan, a)
        except Exception as e:  # the service is busy at times
            print(f"    retry {attempt + 1}: {e}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("elevation block failed")


def encode(grid_m):
    ft = grid_m * 3.28084
    ok = np.isfinite(ft)
    v = np.clip(np.round(np.where(ok, ft, 0) + 1000), 0, 65535).astype(np.uint32)
    rgb = np.zeros(grid_m.shape + (3,), np.uint8)
    rgb[..., 0] = v >> 8
    rgb[..., 1] = v & 255
    rgb[..., 2] = np.where(ok, 255, 0)
    return Image.fromarray(rgb, "RGB")


def main(slug, buffer_km=5.0):
    data = SITE / "data" / slug
    base = json.loads((data / "basemap.json").read_text())
    rivers = json.loads((SITE / "rivers.json").read_text())["rivers"]
    river = next(r for r in rivers if r["slug"] == slug)
    main_stem = river.get("main_stem", "Salt River")
    pts = [p for rv in base["rivers"] if rv["name"] == main_stem for line in rv["lines"] for p in line]
    # densify so the buffer has no gaps between distant vertices
    print(f"{len(pts)} main-stem vertices; buffer {buffer_km} km")
    out = data / "dem"
    manifest = {}
    for z in ZOOMS:
        tiles = set()
        n = 2 ** z
        for lon, lat in pts:
            x, y = tile_xy(lon, lat, z)
            tile_km = 40075 * math.cos(math.radians(lat)) / n
            r = math.ceil(buffer_km / tile_km)
            for dx in range(-r, r + 1):
                for dy in range(-r, r + 1):
                    tiles.add((int(x) + dx, int(y) + dy))
        blocks = {}
        for x, y in tiles:
            blocks.setdefault((x // BLOCK, y // BLOCK), []).append((x, y))
        print(f"zoom {z}: {len(tiles)} tiles in {len(blocks)} requests")
        done = 0
        for (bx, by), ts in sorted(blocks.items()):
            todo = [(x, y) for x, y in ts if not (out / str(z) / str(x) / f"{y}.png").exists()]
            if todo:
                x0, x1 = min(t[0] for t in ts), max(t[0] for t in ts)
                y0, y1 = min(t[1] for t in ts), max(t[1] for t in ts)
                grid = fetch_block(x0, y0, x1 - x0 + 1, y1 - y0 + 1, z)
                for x, y in todo:
                    i, j = (y - y0) * 256, (x - x0) * 256
                    path = out / str(z) / str(x) / f"{y}.png"
                    path.parent.mkdir(parents=True, exist_ok=True)
                    encode(grid[i:i + 258, j:j + 258]).save(path, optimize=True)
            done += 1
            if done % 5 == 0:
                print(f"  {done}/{len(blocks)} blocks")
        manifest[z] = sorted(f"{x}/{y}" for x, y in tiles)
    (out / "manifest.json").write_text(json.dumps({"format": "ft = R*256+G - 1000; B=0 no data; 258x258 with 1px border",
                                                    "tiles": manifest}, separators=(",", ":")))
    size = sum(p.stat().st_size for p in out.rglob("*.png"))
    print(f"wrote {sum(len(v) for v in manifest.values())} tiles, {size / 1e6:.1f} MB, to data/{slug}/dem/")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt", float(sys.argv[2]) if len(sys.argv) > 2 else 5.0)
