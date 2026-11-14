#!/usr/bin/env python3
"""Custom basin map for a river page, in the style of the Upper Colorado River Basin map
(Colorado_River_Basin/export_web_map.py):

  data/<slug>/terrain.jpg    hillshaded USGS 3DEP elevation, faded outside the basin,
                             resampled to Web Mercator rows so it lines up in Leaflet
  data/<slug>/basemap.json   NHDPlus rivers with widths scaled by mean annual flow,
                             lakes, basin outlines, river and place labels

River widths and hover flows: NHDPlus EROM mean annual flow (QA_MA) has the right shape along
each river but not the right level. Each gauge gives a ratio, its USGS long-term mean flow divided
by QA_MA on its own segment, and every segment takes the ratio of the nearest gauge downstream
(segments below the lowest gauge use that gauge's ratio).

Needs numpy, matplotlib, pillow.   Usage: python site/build/build_basemap.py salt
"""
import io
import json
import math
import pickle
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from matplotlib.colors import LightSource, LinearSegmentedColormap, Normalize
from matplotlib.path import Path as MplPath
from PIL import Image, ImageDraw

SITE = Path(__file__).resolve().parents[1]
UA = "river-trip-planner/0.1 (data build)"
ROADS = "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/{layer}/query?"
GNIS_HYDRO = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/7/query?"
NHD_FLOW = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/4/query?"
NHD_WATER = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query?"
DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?"
NLDI = "https://api.water.usgs.gov/nldi/linked-data/"
# Same elevation ramp as the Upper Colorado map
ELEV_COLORS = ["#f4efe4", "#dcc9a8", "#ad8b66", "#6b4e37"]

# Per-river map settings. extent = (west, east, south, north)
CONFIG = {
    "salt": {
        "extent": (-112.5, -108.95, 33.0, 34.55),  # wide enough that the default view (run centred, zoom 9) is all terrain
        "named_roads": ["288"],  # SR 288 to the take-out: unnamed local road in TIGER, so use the 1:1M layer
        # rapid importance by class -> the zoom level at which a rapid appears (hazards: always)
        "rapid_minzoom": {"V+": 6, "V": 6, "IV": 6, "III": 11.5, "II": 12.5},
        "main_stem": "Salt River",      # extended past the outlet gauge to the lake
        "outer_gauge": "09498500",      # basin drawn and un-faded: Salt above Roosevelt Lake
        "elev_range": (600, 3500),      # m
        "min_qa_cfs": 4,                # smallest streams drawn (NHDPlus QA_MA)
        "lakes": ["Theodore Roosevelt Lake", "Big Lake", "Crescent Lake", "Sunrise Lake", "Hawley Lake",
                  "Reservation Lake", "Horseshoe Cienega Lake", "Christmas Tree Lake", "Cyclone Lake",
                  "Bootleg Lake", "Drift Fence Lake", "Pacheta Lake", "Earl Park Lake", "Concho Lake"],
        "label_rivers": ["Salt River", "Black River", "White River", "North Fork White River",
                         "East Fork White River", "Carrizo Creek", "Cibecue Creek", "Canyon Creek",
                         "Cherry Creek", "Corduroy Creek", "Bonito Creek"],
        "places": [
            {"text": "Mount Baldy", "lat": 33.906, "lon": -109.562, "kind": "peak"},
            {"text": "Aztec Peak", "lat": 33.812, "lon": -110.908, "kind": "peak"},
            {"text": "Whiteriver", "lat": 33.837, "lon": -109.964, "kind": "town"},
            {"text": "Show Low", "lat": 34.254, "lon": -110.030, "kind": "town"},
            {"text": "Roosevelt", "lat": 33.668, "lon": -111.152, "kind": "town"},
            {"text": "Globe", "lat": 33.394, "lon": -110.787, "kind": "town"},
            {"text": "Greer", "lat": 34.010, "lon": -109.459, "kind": "town"},
            {"text": "Payson", "lat": 34.231, "lon": -111.325, "kind": "town"},
            {"text": "Sunrise ski area", "lat": 33.955, "lon": -109.559, "kind": "ski"},  # Sunrise Peak (GNIS)
        ],
        # hand-placed river labels: {name: [lat, lon, side]}; side "w" puts the text west of the point
        "label_overrides": {"Cibecue Creek": [33.985, -110.488, "w"],         # clear of the put-in pin
                            "North Fork White River": [34.0356, -109.843, None],  # clear of Whiteriver
                            "East Fork White River": [33.8357, -109.78, None]},   # clear of Whiteriver
    }
}


def get_json(base, params, tries=6, timeout=300):
    url = base + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            if i == tries - 1:
                raise
            print(f"  {e}; retrying")
            time.sleep(4 * 2 ** i)


def cached(path, fn):
    if path.exists():
        return pickle.loads(path.read_bytes())
    v = fn()
    path.write_bytes(pickle.dumps(v))
    return v


def nhd_flowlines(extent, min_qa):
    w, e, s, n = extent
    feats, offset = [], 0
    while True:
        d = get_json(NHD_FLOW, dict(
            where=f"QA_MA >= {min_qa}", geometry=f"{w},{s},{e},{n}", geometryType="esriGeometryEnvelope",
            inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects",
            outFields="GNIS_NAME,COMID,Hydroseq,DnHydroseq,QA_MA,FTYPE", f="geojson",
            orderByFields="COMID", resultOffset=offset, resultRecordCount=1000))
        feats += d["features"]
        print(f"  flowlines: {len(feats)}")
        if len(d["features"]) < 1000:
            return feats
        offset += 1000


def nhd_lakes(extent, names):
    """Named lakes only: a query by name is fast, an open area query on this service times out."""
    w, e, s, n = extent
    quoted = ",".join("'%s'" % x for x in names)
    try:
        d = get_json(NHD_WATER, dict(
            where=f"GNIS_NAME IN ({quoted})", geometry=f"{w},{s},{e},{n}",
            geometryType="esriGeometryEnvelope", inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects",
            outFields="GNIS_NAME,AREASQKM", maxAllowableOffset=0.0005, f="geojson"), tries=3, timeout=120)
        return d["features"]
    except Exception as err:
        print(f"  lakes skipped: {err}")
        return []


def highways(extent, named):
    """US and state routes from the USGS National Map (Census TIGER), simplified to about 20 m.
    Layer 30 = secondary highways, 31 = local connecting roads (SR 73, 273, ...).
    `named` lists state routes that TIGER files as unnamed local roads; those come from the
    1:1M national roads layer (9) instead, which is coarser but names every route."""
    w, e, s, n = extent
    feats = []
    queries = [(30, "us_route IS NOT NULL OR state_route IS NOT NULL", None),
               (31, "us_route IS NOT NULL OR state_route IS NOT NULL", None)]
    queries += [(9, f"ST_ROUTE = '{ref}' AND STATE = 'AZ'", ref) for ref in named]
    for layer, where, ref in queries:
        offset = 0
        while True:
            d = get_json(ROADS.format(layer=layer), dict(
                where=where, geometry=f"{w},{s},{e},{n}",
                geometryType="esriGeometryEnvelope", inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects",
                outFields="ST_ROUTE" if layer == 9 else "us_route,state_route,interstate", maxAllowableOffset=0.0002, f="geojson",
                orderByFields="OBJECTID", resultOffset=offset, resultRecordCount=1000))
            for f in d["features"]:
                if ref:
                    f["properties"]["state_route"] = ref
            feats += d["features"]
            print(f"  layer {layer}: {len(feats)} road segments")
            if len(d["features"]) < 1000:
                break
            offset += 1000
    return feats


def dem(extent, size):
    w, e, s, n = extent
    url = DEM_URL + urllib.parse.urlencode(dict(
        bbox=f"{w},{s},{e},{n}", bboxSR=4326, imageSR=4326, size=f"{size[0]},{size[1]}",
        format="tiff", pixelType="F32", interpolation="RSP_BilinearInterpolation", f="image"))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r:
        return np.array(Image.open(io.BytesIO(r.read())), dtype=np.float32)


def nldi_basin(site):
    d = get_json(NLDI + f"nwissite/USGS-{site}/basin?", {"simplified": "true", "splitCatchment": "false"})
    g = d["features"][0]["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    return max((p[0] for p in polys), key=len)


def nldi_comid(site):
    d = get_json(NLDI + f"nwissite/USGS-{site}?", {})
    return int(d["features"][0]["properties"]["comid"])


def usgs_mean_flows(sites):
    """{site: mean of annual mean flows, cfs} from the USGS statistics service (RDB only)."""
    url = "https://waterservices.usgs.gov/nwis/stat/?" + urllib.parse.urlencode(
        {"format": "rdb", "sites": ",".join(sites), "statReportType": "annual", "statYearType": "water",
         "parameterCd": "00060"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode()
    vals = {}
    rows = [ln.split("\t") for ln in text.splitlines() if ln and not ln.startswith("#")]
    head = rows[0]
    i_site, i_val = head.index("site_no"), head.index("mean_va")
    for f in rows[2:]:
        if len(f) > i_val and f[i_val]:
            vals.setdefault(f[i_site], []).append(float(f[i_val]))
    return {k: sum(v) / len(v) for k, v in vals.items()}


def gnis_rapids(extent):
    """Named rapids from the USGS Geographic Names (GNIS) gazetteer."""
    w, e, s, n = extent
    d = get_json(GNIS_HYDRO, dict(
        where="gaz_featureclass = 'Rapids'", geometry=f"{w},{s},{e},{n}", geometryType="esriGeometryEnvelope",
        inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects", outFields="gaz_name,gaz_id", f="json"))
    out = []
    for f in d.get("features", []):
        g = f["geometry"]
        x, y = (g["points"][0] if "points" in g else (g["x"], g["y"]))
        out.append({"name": f["attributes"]["gaz_name"], "gnis_id": f["attributes"]["gaz_id"], "lon": x, "lat": y})
    return out


def place_rapids(cfg, feats, gnis, aw, river):
    """Put each rapid on the main-stem line from its American Whitewater river mile.

    AW gives miles, not coordinates. Distance along the NHDPlus line differs a little from AW's
    mileage, so the line is pinned to features that can be located on both: tributary mouths, the
    GNIS-located rapids and the take-out bridge. Miles between pins are interpolated; miles beyond
    the first or last pin are extrapolated at the neighbouring rate."""
    def parts(f):
        g = f["geometry"]
        return [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]

    name_of = lambda f: f["properties"].get("GNIS_NAME") or ""
    by_hs = {f["properties"]["Hydroseq"]: f for f in feats if f["geometry"]}
    main = [f for f in feats if f["geometry"] and name_of(f) == cfg["main_stem"]]
    f = max(main, key=lambda f: f["properties"]["Hydroseq"])  # most upstream main-stem segment
    pts = []
    while f is not None and name_of(f) == cfg["main_stem"]:
        for c in parts(f):
            for q in c:
                if not pts or (q[0], q[1]) != pts[-1]:
                    pts.append((q[0], q[1]))
        f = by_hs.get(f["properties"]["DnHydroseq"])
    pts = np.array(pts)
    kx = math.cos(math.radians(float(pts[:, 1].mean())))
    cum = np.concatenate([[0], np.cumsum(np.hypot(np.diff(pts[:, 0]) * kx, np.diff(pts[:, 1])) * 69.05)])

    def along(lon, lat):
        d = np.hypot((pts[:, 0] - lon) * kx, pts[:, 1] - lat) * 69.05
        i = int(np.argmin(d))
        return float(cum[i]), float(d[i])

    pins = []
    for name, mile in aw["anchors"]["tributaries"].items():
        trib = [f for f in feats if f["geometry"] and name_of(f) == name]
        if trib:
            end = parts(min(trib, key=lambda f: f["properties"]["Hydroseq"]))[-1][-1]
            a, d = along(end[0], end[1])
            if d < 0.3:
                pins.append((mile, a))
    for r in gnis:
        if r["name"] in aw["anchors"]["gnis_rapids"]:
            a, d = along(r["lon"], r["lat"])
            if d < 0.3:
                pins.append((aw["anchors"]["gnis_rapids"][r["name"]], a))
    for r in aw["rapids"]:  # rapids with a known location pin the mileage too
        if r.get("lat") is not None:
            a, d = along(r["lon"], r["lat"])
            if d < 0.3:
                pins.append((r["mile"], a))
    for p in river.get("points", []):  # access points with a known AW mile (Camp 1, Camp 2) pin it too
        if p.get("aw_mile") is not None:
            a, d = along(p["lon"], p["lat"])
            if d < 0.3:
                pins.append((p["aw_mile"], a))
    take_out = next((p for p in river.get("points", []) if p["kind"] == "take-out"), None)
    if take_out:
        pins.append((aw["anchors"]["take_out_bridge"], along(take_out["lon"], take_out["lat"])[0]))
    pins.sort()
    pm, pa = np.array([x[0] for x in pins]), np.array([x[1] for x in pins])
    lo_rate = (pa[1] - pa[0]) / (pm[1] - pm[0])
    hi_rate = (pa[-1] - pa[-2]) / (pm[-1] - pm[-2])
    print(f"  {len(pins)} pins; line distance per AW mile {lo_rate:.3f} at the top, {hi_rate:.3f} at the bottom")

    def to_line(m):
        if m < pm[0]:
            return pa[0] - (pm[0] - m) * lo_rate
        if m > pm[-1]:
            return pa[-1] + (m - pm[-1]) * hi_rate
        return float(np.interp(m, pm, pa))

    out = []
    for r in aw["rapids"]:
        if r.get("lat") is not None:  # a known location wins: snap it onto the drawn line
            a = along(r["lon"], r["lat"])[0]
        else:
            a = to_line(r["mile"])
        i = int(np.clip(np.searchsorted(cum, a), 1, len(cum) - 1))
        t = (a - cum[i - 1]) / max(cum[i] - cum[i - 1], 1e-9)
        lon, lat = pts[i - 1] + t * (pts[i] - pts[i - 1])
        out.append({"name": r["name"], "cls": r["class"], "mile": r["mile"], "kind": r.get("kind", "rapid"),
                    "note": r.get("note", ""), "minzoom": cfg["rapid_minzoom"].get(r["class"], 12),
                    "lon": round(float(lon), 5), "lat": round(float(lat), 5),
                    **({"rank": r["rank"]} if r.get("rank") else {}),  # rank 1 = shown first within its class
                    **({"key": True} if r.get("key") else {})})  # key = the ones shown at the default zoom
    print(f"  placed {len(out)}: " + ", ".join(r["name"] for r in out))
    return out


def rdp(pts, tol):
    """Douglas-Peucker simplification of an (n, 2) array; tol in the same units."""
    keep = np.zeros(len(pts), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        ab = b - a
        L = math.hypot(ab[0], ab[1])
        mid = pts[i + 1:j]
        d = (np.abs(ab[0] * (mid[:, 1] - a[1]) - ab[1] * (mid[:, 0] - a[0])) / L) if L > 0 else np.hypot(*(mid - a).T)
        k = int(np.argmax(d))
        if d[k] > tol:
            keep[i + 1 + k] = True
            stack += [(i, i + 1 + k), (i + 1 + k, j)]
    return pts[keep]


def contour_files(elev_m, extent, out):
    """Trace the coarse contours (1000, 500 and 250 ft) once from the ~125 m DEM and save them
    as line files the page draws directly. Each elevation is stored once, in the file for the
    coarsest interval it belongs to, so a zoom level loads that file plus the coarser ones.
    Lines at multiples of 1000 ft get label points: two per line, plus one per 10 miles."""
    import contourpy
    w, e, s, n = extent
    rows, cols = elev_m.shape
    ft = elev_m * 3.28084
    # light 3x3 smoothing so lines don't zig-zag along the DEM cells
    pad = np.pad(ft, 1, mode="edge")
    ft = sum(pad[i:i + rows, j:j + cols] for i in range(3) for j in range(3)) / 9.0
    gen = contourpy.contour_generator(z=ft, line_type="Separate")
    kx = math.cos(math.radians((s + n) / 2))
    to_lon = lambda c: w + (c + 0.5) * (e - w) / cols
    to_lat = lambda r: n - (r + 0.5) * (n - s) / rows
    sets = {1000: [], 500: [], 250: []}
    labels = []
    lo, hi = float(np.nanmin(ft)), float(np.nanmax(ft))
    levels = list(range(int(math.ceil(lo / 250) * 250), int(hi) + 1, 250))
    for v in levels:
        home = next(k for k in (1000, 500, 250) if v % k == 0)
        for line in gen.lines(v):
            if len(line) < 4:
                continue
            lon, lat = to_lon(line[:, 0]), to_lat(line[:, 1])
            seg = np.hypot(np.diff(lon) * kx, np.diff(lat)) * 69.05
            length = float(seg.sum())
            if length < {1000: 0.6, 500: 0.4, 250: 0.25}[home]:  # specks too small to see at that set's zoom
                continue
            # simplify to about half a screen pixel at the zoom this set is first shown
            tol = {1000: 0.0012, 500: 0.0007, 250: 0.0004}[home]
            simple = rdp(np.column_stack([lon * kx, lat]), tol)
            sets[home].append([v, [[round(float(x / kx), 4), round(float(y), 4)] for x, y in simple]])
            if v % 1000 == 0 and length >= 1.0:
                cum = np.concatenate([[0], np.cumsum(seg)])
                k = max(2, math.ceil(length / 10))
                for j in range(k):
                    i = int(np.searchsorted(cum, length * (j + 0.5) / k))
                    i = min(max(i, 1), len(lon) - 2)
                    labels.append([v, round(float(lon[i]), 4), round(float(lat[i]), 4),
                                   round(float(lon[i + 1] - lon[i - 1]), 5), round(float(lat[i + 1] - lat[i - 1]), 5),
                                   round(length, 1)])  # line length (miles), so the page can skip lines too short on screen
    for k, lines in sets.items():
        body = {"interval": k, "lines": lines}
        if k == 1000:
            body["labels"] = labels  # [elevation ft, lon, lat, dlon, dlat (text direction), line length in miles]
        (out / f"contours_{k}.json").write_text(json.dumps(body, separators=(",", ":")))
        print(f"  contours_{k}.json: {len(lines)} lines, {(out / f'contours_{k}.json').stat().st_size / 1024:.0f} KB")
    print(f"  {len(labels)} labels on 1000 ft lines")


FS_ROADS = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RoadBasic_01/MapServer/0/query?"


def access_roads(river, extent, us_roads, cache, slug):
    """Dirt access roads to the river (rivers.json "access_roads"):
    - "fs_id": a Forest Service road, from the USFS National Forest System Roads layer;
    - "to_points": traced along the National Map's (mostly unnamed) local and 4WD roads by shortest
      path from the given US highway to each named access point."""
    import heapq
    out = []
    kx = math.cos(math.radians(33.8))
    dist = lambda a, b: math.hypot((a[0] - b[0]) * kx, a[1] - b[1]) * 111.2
    for spec in river.get("access_roads", []):
        lines, info = [], {}
        if spec.get("fs_id"):
            w, e, s, n = extent
            d = cached(cache / f"{slug}_fsroad_{spec['fs_id']}.pkl", lambda: get_json(FS_ROADS, dict(
                where=f"id = '{spec['fs_id']}'", geometry=f"{w},{s},{e},{n}", geometryType="esriGeometryEnvelope",
                inSR=4326, outSR=4326, outFields="id,name,oper_maint_level,surface_type", f="geojson")))
            for f in d["features"]:
                g = f["geometry"]
                for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
                    lines.append(r4(c))
                info = {"maint": f["properties"].get("oper_maint_level"), "surface": f["properties"].get("surface_type")}
        elif spec.get("to_points"):
            targets = [p for p in river["points"] if p["name"] in spec["to_points"]]
            lats = [p["lat"] for p in targets]
            lons = [p["lon"] for p in targets]
            box = f"{min(lons) - 0.04},{min(lats) - 0.03},{max(lons) + 0.04},{max(lats) + 0.03}"
            pieces = []
            for layer in (31, 32, 35):  # local connecting, local, 4WD
                d = cached(cache / f"{slug}_localroads_{layer}_{box}.pkl", lambda: get_json(ROADS.format(layer=layer), dict(
                    where="1=1", geometry=box, geometryType="esriGeometryEnvelope", inSR=4326, outSR=4326,
                    outFields="name", f="geojson")))
                for f in d["features"]:
                    g = f["geometry"]
                    for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
                        pieces.append([(x, y) for x, y, *_ in c])
            key = lambda p: (round(p[0] / 0.0001), round(p[1] / 0.0001))  # ~10 m: touching pieces connect
            adj, pos = {}, {}
            for l in pieces:
                for a2, b2 in zip(l, l[1:]):
                    ka, kb = key(a2), key(b2)
                    pos[ka], pos[kb] = a2, b2
                    adj.setdefault(ka, []).append((kb, dist(a2, b2)))
                    adj.setdefault(kb, []).append((ka, dist(a2, b2)))
            hwy = [tuple(q) for r in us_roads if r["kind"] == "us" and r["ref"] == spec["from_us"] for l in r["lines"] for q in l]
            start = min(pos, key=lambda k: min(dist(pos[k], q) for q in hwy))
            # one shortest-path tree from the highway, then the path to each access point
            D, prev, q = {start: 0}, {}, [(0, start)]
            while q:
                d0, u = heapq.heappop(q)
                if d0 > D[u]:
                    continue
                for v, w in adj.get(u, []):
                    if d0 + w < D.get(v, 1e9):
                        D[v], prev[v] = d0 + w, u
                        heapq.heappush(q, (d0 + w, v))
            for t in targets:
                k = min(D, key=lambda k: dist(pos[k], (t["lon"], t["lat"])))
                path = [k]
                while path[-1] != start:
                    path.append(prev[path[-1]])
                lines.append(r4([pos[k] for k in reversed(path)]))
                print(f"  {t['name']}: {D[k]:.1f} km from US {spec['from_us']} (road ends {dist(pos[k], (t['lon'], t['lat'])) * 1000:.0f} m away)")
        if lines:
            out.append({"name": spec["name"], "aka": spec.get("aka", ""), "note": spec.get("note", ""), **info, "lines": lines})
    print(f"  {len(out)} access roads: " + ", ".join(r["name"] for r in out))
    return out


def r4(coords, step=1):
    pts = coords[::step]
    if pts[-1] != coords[-1]:
        pts = pts + [coords[-1]]
    return [[round(x, 4), round(y, 4)] for x, y, *_ in pts]


def main(slug):
    cfg = CONFIG[slug]
    river = next(r for r in json.loads((SITE / "rivers.json").read_text())["rivers"] if r["slug"] == slug)
    out = SITE / "data" / slug
    cache = SITE / "build" / ".cache"
    cache.mkdir(exist_ok=True)
    w, e, s, n = cfg["extent"]

    print("basins (NLDI) ...")
    outer = cached(cache / f"{slug}_outer_basin.pkl", lambda: nldi_basin(cfg["outer_gauge"]))
    inner = json.loads((out / "map.json").read_text())["basin"][0]  # above the put-in gauge
    outer_path = MplPath(np.array(outer)[:, :2])

    print("NHDPlus flowlines ...")
    feats = cached(cache / f"{slug}_flowlines.pkl", lambda: nhd_flowlines(cfg["extent"], cfg["min_qa_cfs"]))
    segs = []
    for f in feats:
        p, g = f["properties"], f["geometry"]
        if not g:
            continue
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        for c in parts:
            mid = c[len(c) // 2][:2]
            if outer_path.contains_point(mid):
                segs.append({"name": p.get("GNIS_NAME") or "", "comid": p["COMID"], "qa": p["QA_MA"] or 0,
                             "hs": p["Hydroseq"], "coords": c})
    # carry the main stem on below the basin outlet gauge until it enters the lake (NHD ArtificialPath)
    by_hs = {f["properties"]["Hydroseq"]: f for f in feats if f["geometry"]}
    inside_ids = {sg["comid"] for sg in segs}
    main = [f for f in feats if f["geometry"] and f["properties"]["COMID"] in inside_ids
            and (f["properties"].get("GNIS_NAME") or "") == cfg["main_stem"]]
    f = by_hs.get(min(m["properties"]["Hydroseq"] for m in main)) if main else None
    added = 0
    while f is not None:
        f = by_hs.get(f["properties"]["DnHydroseq"])
        if f is None or f["properties"]["FTYPE"] == "ArtificialPath":
            break
        p, g = f["properties"], f["geometry"]
        for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
            segs.append({"name": p.get("GNIS_NAME") or "", "comid": p["COMID"], "qa": p["QA_MA"] or 0,
                         "hs": p["Hydroseq"], "coords": c})
            added += 1
    print(f"  {len(segs)} segments inside the basin ({added} added to reach the lake)")

    # rescale QA_MA to the observed long-term mean at the put-in gauge
    flows = json.loads((out / "flows.json").read_text())
    vals = [v for arr in flows["years"].values() for v in arr if v is not None]
    obs_mean = sum(vals) / len(vals)
    gauge_comid = cached(cache / f"{slug}_gauge_comid.pkl", lambda: nldi_comid(river["gauges"]["primary"]))
    qa_gauge = next((sg["qa"] for sg in segs if sg["comid"] == gauge_comid), None)
    ratio = obs_mean / qa_gauge if qa_gauge else 1.0
    print(f"  put-in gauge: observed mean {obs_mean:.0f} cfs, NHDPlus QA_MA {qa_gauge}, ratio {ratio:.2f}")

    # per-gauge ratios from USGS long-term means (all water years on record)
    g = river["gauges"]
    gids = [x for k in ("primary", "downstream", "upstream", "nearby")
            for x in ([g[k]] if isinstance(g.get(k), str) else g.get(k) or [])]
    means = cached(cache / f"{slug}_gauge_means.pkl", lambda: usgs_mean_flows(gids))
    by_hs_all = {f["properties"]["Hydroseq"]: f["properties"] for f in feats}
    qa_by_comid = {f["properties"]["COMID"]: f["properties"]["QA_MA"] or 0 for f in feats}
    gauge_ratio = {}  # Hydroseq of the gauge's segment -> ratio
    for gid in gids:
        try:
            comid = cached(cache / f"comid_{gid}.pkl", lambda: nldi_comid(gid))
        except Exception as err:
            print(f"  {gid}: no NLDI match ({err})")
            continue
        qa = qa_by_comid.get(comid)
        hs = next((h for h, pr in by_hs_all.items() if pr["COMID"] == comid), None)
        if not qa or hs is None or gid not in means:
            print(f"  {gid}: skipped (segment not on the map or no USGS mean)")
            continue
        gauge_ratio[hs] = means[gid] / qa
        print(f"  {gid}: USGS mean {means[gid]:.0f} cfs, QA_MA {qa:.0f}, ratio {gauge_ratio[hs]:.2f}")
    outlet_ratio = gauge_ratio.get(min(gauge_ratio), ratio) if gauge_ratio else ratio  # lowest Hydroseq = farthest down
    memo = {}

    def seg_ratio(hs):
        path, h = [], hs
        while h in by_hs_all and h not in gauge_ratio and h not in memo and len(path) < 5000:
            path.append(h)
            h = by_hs_all[h]["DnHydroseq"]
        r = gauge_ratio.get(h) or memo.get(h) or outlet_ratio
        for x in path:
            memo[x] = r
        return r

    # group into runs by name and flow class to keep the file and layer count small
    # hover flows by stretch, the way boaters quote them: one value per stretch of river between
    # named-tributary junctions (and gauges), taken at the stretch's downstream end, two significant figures
    seg_q = {sg["hs"]: sg["qa"] * seg_ratio(sg["hs"]) for sg in segs}
    nm = lambda h: by_hs_all[h].get("GNIS_NAME") or ""
    joins = {by_hs_all[h]["DnHydroseq"] for h in seg_q
             if nm(h) and seg_q[h] >= 10 and by_hs_all[h]["DnHydroseq"] in seg_q and nm(by_hs_all[h]["DnHydroseq"]) != nm(h)}
    reach_end = {}

    def reach_q(h):
        path = []
        while h not in reach_end:
            path.append(h)
            nxt = by_hs_all[h]["DnHydroseq"]
            if h in gauge_ratio or nxt not in seg_q or nm(nxt) != nm(h) or nxt in joins:
                reach_end[h] = h
                break
            h = nxt
        for x in path:
            reach_end[x] = reach_end[h]
        return seg_q[reach_end[h]]

    def sig2(x):
        return round(x) if x < 10 else int(round(x, 1 - int(math.floor(math.log10(x)))))

    edges = [0, 10, 25, 50, 100, 200, 400, 800, 1e9]
    groups = {}
    for sg in segs:
        q = sg["qa"] * seg_ratio(sg["hs"])
        k = next(i for i in range(len(edges) - 1) if q < edges[i + 1])
        key = (sg["name"], k)
        gdict = groups.setdefault(key, {"name": sg["name"], "cls": k, "q": [], "lines": [], "qs": [], "rid": []})
        gdict["qs"].append(sig2(reach_q(sg["hs"])))
        gdict["rid"].append(int(reach_end[sg["hs"]]))  # stretch id: Hydroseq of its last segment
        gdict["q"].append(q)
        gdict["lines"].append(r4(sg["coords"], step=2 if len(sg["coords"]) > 6 else 1))
    rivers = []
    for gdict in groups.values():
        qm = float(np.median(gdict["q"]))
        rivers.append({"name": gdict["name"], "q": round(qm), "w": round(0.6 + 5.4 * math.sqrt(qm / max(obs_mean, 1)), 2),
                       "lines": gdict["lines"], "qs": gdict["qs"], "rid": gdict["rid"]})
    rivers.sort(key=lambda r: r["w"])  # draw small streams first

    # river labels: a point near the middle of each named river's largest flow class
    labels = []
    for name in cfg["label_rivers"]:
        cand = [r for r in rivers if r["name"] == name]
        if not cand:
            continue
        best = max(cand, key=lambda r: sum(len(l) for l in r["lines"]))  # the river's longest flow class
        line = max(best["lines"], key=len)
        lon, lat = line[len(line) // 2]
        lb = {"text": name.replace(" River", " R.").replace(" Creek", " Cr."), "lon": lon, "lat": lat}
        if name in cfg.get("label_overrides", {}):
            lb["lat"], lb["lon"], lb["side"] = cfg["label_overrides"][name]
        labels.append(lb)

    print("rapids (American Whitewater miles, placed along the river line) ...")
    rapids = place_rapids(cfg, feats, cached(cache / f"{slug}_rapids.pkl", lambda: gnis_rapids(cfg["extent"])),
                          json.loads((SITE / "content" / f"{slug}_rapids.json").read_text()), river)

    print("lakes ...")
    lake_feats = cached(cache / f"{slug}_lakes.pkl", lambda: nhd_lakes(cfg["extent"], cfg["lakes"]))
    lakes = []
    for f in lake_feats:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            ring = poly[0]
            if outer_path.contains_point(np.mean(np.array(ring)[:, :2], axis=0)) or (f["properties"].get("GNIS_NAME") or "").startswith("Theodore Roosevelt"):
                lakes.append({"name": f["properties"].get("GNIS_NAME") or "", "ring": r4(ring)})
    print(f"  {len(lakes)} lakes")

    print("highways (USGS National Map) ...")
    road_feats = cached(cache / f"{slug}_roads.pkl", lambda: highways(cfg["extent"], cfg["named_roads"]))
    routes = {}
    for f in road_feats:
        p, g = f["properties"], f["geometry"]
        if not g:
            continue
        if p.get("us_route"):
            kind, ref = "us", p["us_route"].split(",")[0].strip()
        else:
            kind, ref = "state", p["state_route"].split(",")[0].strip()
        if not ref.isdigit():  # business loops etc.
            continue
        rt = routes.setdefault((kind, ref), {"kind": kind, "ref": ref, "lines": []})
        for c in ([g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]):
            rt["lines"].append(r4(c))
    roads = sorted(routes.values(), key=lambda r: (r["kind"] == "us", r["ref"]))  # US routes drawn on top
    print(f"  {len(roads)} routes: " + ", ".join(("US " if r["kind"] == "us" else "SR ") + r["ref"] for r in roads))

    print("access roads ...")
    access = access_roads(river, cfg["extent"], roads, cache, slug)

    print("terrain (3DEP) ...")
    lat_mid = (s + n) / 2
    ncols = 2700  # ~125 m pixels across the extent
    nrows = int(ncols * (n - s) / ((e - w) * math.cos(math.radians(lat_mid))))
    elev = cached(cache / f"{slug}_dem_{ncols}x{nrows}.pkl", lambda: dem(cfg["extent"], (ncols, nrows)))
    elev = np.where(elev < -1000, np.nan, elev)
    elev = np.nan_to_num(elev, nan=float(np.nanmin(elev)))
    print("contours (1000/500/250 ft) ...")
    contour_files(elev, cfg["extent"], out)
    cmap = LinearSegmentedColormap.from_list("elev", ELEV_COLORS)
    dx = (e - w) / ncols * 111320 * math.cos(math.radians(lat_mid))
    dy = (n - s) / nrows * 110570
    lo, hi = cfg["elev_range"]
    rgb = LightSource(azdeg=315, altdeg=45).shade(elev, cmap=cmap, norm=Normalize(lo, hi),
                                                  blend_mode="soft", dx=dx, dy=dy)[..., :3]
    mask = Image.new("1", (ncols, nrows), 0)
    ImageDraw.Draw(mask).polygon([((x - w) / (e - w) * ncols, (n - y) / (n - s) * nrows) for x, y, *_ in outer], fill=1)
    inside = np.array(mask, dtype=bool)
    rgb[~inside] = 0.6 * rgb[~inside] + 0.4  # outside the basin: lighter but still readable

    def merc(lat):
        return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    target_lat = np.degrees(2 * np.arctan(np.exp(np.linspace(merc(n), merc(s), nrows))) - np.pi / 2)
    src_row = np.clip(((n - target_lat) / (n - s) * nrows).astype(int), 0, nrows - 1)
    Image.fromarray((rgb[src_row] * 255).astype(np.uint8)).save(out / "terrain.jpg", quality=84)

    data = {
        "bounds": [[s, w], [n, e]],
        "outer_basin": r4(outer, step=2), "inner_basin": inner,
        "outer_label": "Salt River above Roosevelt Lake", "inner_label": "Drains to the put-in gauge",
        "rivers": rivers, "river_labels": labels, "lakes": lakes, "roads": roads, "access_roads": access, "rapids": rapids, "rapids_source": "American Whitewater", "places": cfg["places"],
        "flow_scale": {"obs_mean_cfs": round(obs_mean), "ratio": round(ratio, 3),
                       "examples": [50, 200, int(round(obs_mean, -2))]},  # mean rounded to the nearest 100 cfs for the legend
        "elevation": {"vmin": lo, "vmax": hi, "colors": ELEV_COLORS},
    }
    (out / "basemap.json").write_text(json.dumps(data, separators=(",", ":")))
    for f in ("basemap.json", "terrain.jpg"):
        print(f"wrote data/{slug}/{f} ({(out / f).stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt")
