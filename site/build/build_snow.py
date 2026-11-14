#!/usr/bin/env python3
"""Snowpack section data: a map of current snow water equivalent over the basin and one basin
snowpack index compared with normal.

Usage:  python site/build/build_snow.py salt      (run by update.py every 6 hours, after build_river)

Writes data/<slug>/swe.png and data/<slug>/snow.json:
  map     NOHRSC snow analysis (SNODAS, ~1 km, updated 4x a day) snow water equivalent, exported from
          the NWS map service for the box around the basin that drains to the put-in gauge
          (basemap.json inner_basin). The PNG is a plain lat/lon grid over map.bbox, the same grid as
          terrain.jpg, so the page lays one over the other. Also: the share of that basin with snow.
  index   mean SWE (inches) across the SNOTEL sites with records back to 1990, by day of the water
          year: this winter, and the 1991-2020 median and 10th/90th percentiles ("normal", the NRCS
          normals period).
"""
import base64
import io
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from build_river import SITE, UA, get_json  # noqa: E402

CACHE = SITE / "build" / ".cache"

SVC = "https://mapservices.weather.noaa.gov/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer"
SWE_LAYER = 7          # "Image" raster under Snow Water Equivalent (inches)
PAD = 0.08             # degrees around the basin
PX_PER_DEG = 420       # export resolution (~1 km cells are ~0.0083 deg)
NORMAL_YEARS = (1991, 2020)
WY_DAYS = 304          # Oct 1 - Jul 31
SNOW_LINE_FT = 8000    # elevation that typically holds a winter snowpack here
USE_BANDED = False     # banded elevation image instead of the Basin map terrain (see terrain_image)
CONTOURS_FT = [7000, 8000, 9000]  # contour lines drawn on the snow map


def snotel_history(slug, triplets):
    """{triplet: {date: swe_in}} for the full SNOTEL record, cached for a week."""
    import pickle
    path = CACHE / f"{slug}_snotel_history.pkl"
    if path.exists() and (datetime.now().timestamp() - path.stat().st_mtime) < 7 * 86400:
        return pickle.loads(path.read_bytes())
    out = {}
    for trip in triplets:
        print(f"  SNOTEL history {trip} ...")
        r = get_json("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data",
                     {"stationTriplets": trip, "elements": "WTEQ", "duration": "DAILY",
                      "beginDate": "1978-10-01", "endDate": date.today().isoformat()})
        vals = r[0]["data"][0]["values"] if r and r[0].get("data") else []
        out[trip] = {date.fromisoformat(v["date"][:10]): v["value"] for v in vals if v.get("value") is not None}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(out))
    return out


def legend():
    """[(label, low_in, high_in, (r,g,b))] for the SWE layer, from the service's own legend."""
    lg = get_json(f"{SVC}/legend", {"f": "json"})
    out = []
    for e in next(l for l in lg["layers"] if l["layerId"] == SWE_LAYER)["legend"]:
        lo, hi = [float(x) for x in e["label"].replace(" ", "").split("-")]
        im = Image.open(io.BytesIO(base64.b64decode(e["imageData"]))).convert("RGBA")
        r, g, b, a = im.getpixel((im.width // 2, im.height // 2))
        out.append({"label": f"{lo:g}–{hi:g}", "lo": lo, "hi": hi,
                    "color": "#%02x%02x%02x" % (r, g, b), "alpha": a})
    return out


def export_png(bbox, w, h):
    url = f"{SVC}/export?" + "&".join([
        f"bbox={bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}", "bboxSR=4326", "imageSR=4326", f"size={w},{h}",
        f"layers=show:{SWE_LAYER}", "transparent=true", "format=png32", "f=image"])
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGBA")


def basin_mask(poly, bbox, w, h):
    """Boolean grid (h, w): pixel centre inside the basin polygon ([[lon, lat], ...])."""
    from matplotlib.path import Path as MPath
    xs = bbox[0] + (np.arange(w) + 0.5) / w * (bbox[2] - bbox[0])
    ys = bbox[3] - (np.arange(h) + 0.5) / h * (bbox[3] - bbox[1])
    gx, gy = np.meshgrid(xs, ys)
    return MPath(np.array(poly)).contains_points(np.c_[gx.ravel(), gy.ravel()]).reshape(h, w)


def load_dem(slug):
    """The basemap's 3DEP elevation grid (metres, lat/lon grid over basemap bounds), or None."""
    import pickle
    dems = sorted((SITE / "build" / ".cache").glob(f"{slug}_dem_*.pkl"), key=lambda p: p.stat().st_size)
    return np.asarray(pickle.loads(dems[-1].read_bytes()), dtype=float) if dems else None


# Elevation bands for the snowpack map (feet): desert tans below the snow line, forest greens above,
# stepped so each 1,000 ft reads as its own band. Colours avoid the SWE purples and blues.
BANDS = [(None, 4000, "#f3ead8"), (4000, 5000, "#e6d2a8"), (5000, 6000, "#d4b47c"), (6000, 7000, "#bf9658"),
         (7000, 8000, "#a2733f"), (8000, 9000, "#9fb07a"), (9000, 10000, "#6f9460"), (10000, None, "#4a7550")]


def terrain_image(z, base, poly, bbox, out_path):
    """Banded elevation image and a relief (hillshade) layer for bbox (snapped to the grid), with the
    outside of the basin faded. Returns (snapped bbox, legend)."""
    (s0, w0), (n0, e0) = base["bounds"]
    zh, zw = z.shape
    dx, dy = (e0 - w0) / zw, (n0 - s0) / zh
    c0, c1 = int(np.floor((bbox[0] - w0) / dx)), int(np.ceil((bbox[2] - w0) / dx))
    r0, r1 = int(np.floor((n0 - bbox[3]) / dy)), int(np.ceil((n0 - bbox[1]) / dy))
    c0, r0, c1, r1 = max(c0, 0), max(r0, 0), min(c1, zw), min(r1, zh)
    snapped = [round(w0 + c0 * dx, 5), round(n0 - r1 * dy, 5), round(w0 + c1 * dx, 5), round(n0 - r0 * dy, 5)]
    zz = z[r0:r1, c0:c1] / 0.3048  # feet
    h, w = zz.shape
    # bands
    rgb = np.zeros((h, w, 3))
    for lo, hi, col in BANDS:
        m = np.ones_like(zz, bool)
        if lo is not None:
            m &= zz >= lo
        if hi is not None:
            m &= zz < hi
        rgb[m] = [int(col[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    # hillshade (sun from the northwest, 45 degrees up), cell sizes in feet
    lat_mid = np.radians((snapped[1] + snapped[3]) / 2)
    cx, cy = dx * 364000 * np.cos(lat_mid), dy * 364000
    gy, gx = np.gradient(zz, cy, cx)
    slope = np.arctan(np.hypot(gx, gy) * 1.6)
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315), np.radians(45)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    shade = np.clip(shade, 0, 1)
    relief = np.clip(0.55 + 0.45 * shade / max(shade.mean(), 1e-6) * 0.75, 0, 1)  # 1 = no darkening
    # fade outside the basin (bands lighter, relief weaker)
    inside = basin_mask(poly, snapped, w, h)
    rgb[~inside] = rgb[~inside] * 0.45 + 0.55
    relief[~inside] = 1 - (1 - relief[~inside]) * 0.4
    # Two layers under the snow: flat bands, and a grey relief layer the page multiplies over them.
    # The snow layer sits on top, solid, in NOHRSC's own colours.
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(out_path, quality=88)
    Image.fromarray((relief * 255).astype(np.uint8), "L").save(out_path.with_name("snow_relief.jpg"), quality=85)
    legend = [{"label": (f"under {hi:,}" if lo is None else f"over {lo:,}" if hi is None else f"{lo:,}–{hi:,}"),
               "color": col, "above_snow_line": lo is not None and lo >= SNOW_LINE_FT} for lo, hi, col in BANDS]
    return snapped, legend


def wy_day(d):
    """Day of the water year (Oct 1 = 0) on a 365-day calendar; None after Jul 31."""
    if d.month == 2 and d.day == 29:
        return None
    start = date(d.year if d.month >= 10 else d.year - 1, 10, 1)
    k = (d - start).days
    if d.month < 10 and d > date(d.year, 2, 28) and (date(d.year, 3, 1) - date(d.year, 2, 28)).days == 2:
        k -= 1  # leap year: Feb 29 dropped
    return k if k < WY_DAYS else None


def main(slug):
    reg = json.loads((SITE / "rivers.json").read_text(encoding="utf-8"))
    river = next(r for r in reg["rivers"] if r["slug"] == slug)
    data = SITE / "data" / slug
    base = json.loads((data / "basemap.json").read_text(encoding="utf-8"))
    outlook = json.loads((data / "outlook.json").read_text(encoding="utf-8"))
    today = date.today()

    # ---- map: SWE over the basin that drains to the put-in
    poly = base["inner_basin"]
    lons, lats = [p[0] for p in poly], [p[1] for p in poly]
    bbox = [round(min(lons) - PAD, 4), round(min(lats) - PAD, 4), round(max(lons) + PAD, 4), round(max(lats) + PAD, 4)]
    # The page shows the Basin map's terrain (terrain.jpg, cropped to bbox) under the snow, with the
    # 7,000 / 8,000 / 9,000 ft contours from contours_1000.json on top. terrain_image() below makes a
    # banded alternative; set USE_BANDED = True to use it.
    elev_legend = None
    if USE_BANDED and (dem_grid := load_dem(slug)) is not None:
        bbox, elev_legend = terrain_image(dem_grid, base, poly, bbox, data / "snow_terrain.jpg")
    w = int((bbox[2] - bbox[0]) * PX_PER_DEG)
    h = int((bbox[3] - bbox[1]) * PX_PER_DEG)  # pixel per degree in both axes, so the service keeps the box
    print(f"NOHRSC SWE export {bbox} at {w}x{h} ...")
    img = export_png(bbox, w, h)
    img.save(data / "swe.png", optimize=True)
    a = np.array(img)
    snow = a[..., 3] > 0
    mask = basin_mask(poly, bbox, w, h)
    cover = float(snow[mask].mean()) if mask.any() else 0.0
    leg = legend()
    print(f"  snow covers {cover:.1%} of the basin; legend {len(leg)} classes")

    # share of the basin above the snow line (8,000 ft), from the basemap's 3DEP grid (metres, a
    # plain lat/lon grid over basemap bounds); each cell weighted by its true area (cos latitude)
    high = None
    dems = sorted((SITE / "build" / ".cache").glob(f"{slug}_dem_*.pkl"), key=lambda p: p.stat().st_size)
    if dems:
        import pickle
        z = np.asarray(pickle.loads(dems[-1].read_bytes()), dtype=float)
        (s0, w0), (n0, e0) = base["bounds"]
        zh, zw = z.shape
        inside = basin_mask(poly, [w0, s0, e0, n0], zw, zh)
        lat = n0 - (np.arange(zh) + 0.5) / zh * (n0 - s0)
        cell_km2 = (111.32 * (e0 - w0) / zw) * (111.32 * (n0 - s0) / zh) * np.cos(np.radians(lat))[:, None] * np.ones((1, zw))
        area = cell_km2[inside].sum()
        hi = inside & (z >= SNOW_LINE_FT * 0.3048)
        high = {"feet": SNOW_LINE_FT, "share": round(float(cell_km2[hi].sum() / area), 3),
                "area_mi2": round(float(cell_km2[hi].sum() / 2.58999)), "basin_mi2": round(float(area / 2.58999))}
        print(f"  above {SNOW_LINE_FT} ft: {high}")
    if high is None and (data / "snow.json").exists():
        # no elevation grid here (e.g. on GitHub Actions, where build/.cache starts empty): terrain does
        # not change, so keep the share computed by the last build that had the grid
        high = (json.loads((data / "snow.json").read_text(encoding="utf-8")).get("map") or {}).get("above_snow_line")
        print(f"  above {SNOW_LINE_FT} ft: kept from the last build ({high})")

    # ---- index: mean SWE across long-record SNOTEL sites, this winter vs 1991-2020
    trips = river["snotel"]
    hist = snotel_history(slug, trips)
    use = [t for t in trips if hist[t] and min(hist[t]) <= date(1990, 10, 1)]
    names = {s["triplet"]: s["name"] for s in outlook["snotel"]}
    by_year = {}
    for t in use:
        for d, v in hist[t].items():
            k = wy_day(d)
            if k is None:
                continue
            wy = d.year + 1 if d.month >= 10 else d.year
            by_year.setdefault(wy, {}).setdefault(k, []).append(v)
    def curve(wy):
        days = by_year.get(wy, {})
        return [float(np.mean(days[k])) if k in days and len(days[k]) == len(use) else None for k in range(WY_DAYS)]
    normal = [curve(y) for y in range(NORMAL_YEARS[0], NORMAL_YEARS[1] + 1)]  # water years 1991-2020 (Oct 1990 - Sep 2020)
    normal = [c for c in normal if sum(v is not None for v in c) > 0.9 * WY_DAYS]
    stats = []
    for k in range(WY_DAYS):
        v = np.array([c[k] for c in normal if c[k] is not None])
        stats.append([round(float(np.percentile(v, p)), 1) for p in (10, 50, 90)] if len(v) >= 10 else [None] * 3)

    # this winter from outlook.json (fresher than the weekly history cache)
    wy_now = today.year + 1 if today.month >= 10 else today.year
    cur = {}
    for s in outlook["snotel"]:
        if s["triplet"] not in use:
            continue
        for d, v in s["current"]:
            if v is None:
                continue
            k = wy_day(date.fromisoformat(d))
            if k is not None:
                cur.setdefault(k, []).append(v)
    this = [[k, round(float(np.mean(v)), 1)] for k, v in sorted(cur.items()) if len(v) == len(use)]
    peak_k = int(np.argmax([s[1] or 0 for s in stats]))
    out = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "map": {"image": "swe.png", "bbox": bbox, "terrain_bounds": base["bounds"], "terrain": "snow_terrain.jpg" if elev_legend else None, "relief": "snow_relief.jpg" if elev_legend else None, "elev_legend": elev_legend, "contours_ft": (river.get("snow_map") or {}).get("contours_ft", CONTOURS_FT), "contour_labels": {k: v for k, v in (river.get("snow_map") or {}).items() if k in ("label_ft", "label_area", "label_west")}, "source": "NOAA NOHRSC snow analysis (SNODAS)",
                "basin_snow_cover": round(cover, 3), "above_snow_line": high, "legend": [l for l in leg if l["alpha"] > 0 and l["hi"] > 0.05]},
        "index": {"sites": [names.get(t, t) for t in use], "water_year": wy_now, "normal_years": list(NORMAL_YEARS),
                  "wy_start": f"{wy_now - 1}-10-01", "columns": ["p10", "p50", "p90"], "normal": stats, "this": this,
                  "median_peak": {"day": peak_k, "in": stats[peak_k][1]}},
    }
    (data / "snow.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    last = this[-1] if this else None
    print(f"wrote snow.json: sites {out['index']['sites']}, today {last}, median then "
          f"{stats[last[0]][1] if last else None}, median peak {out['index']['median_peak']}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt")
