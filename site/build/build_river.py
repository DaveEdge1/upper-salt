#!/usr/bin/env python3
"""Build the data files for one river page from public federal data.

Usage:  python site/build/build_river.py salt

Writes site/data/<slug>/flows.json, outlook.json and map.json (and extended.json, via build_extended.py, with outlook).
Sources (all US government, public domain):
  USGS Water Services (daily and 15-minute flow, site metadata)
  NOAA National Water Prediction Service (NWS river forecast)
  NRCS AWDB (SNOTEL snow water equivalent and daily medians)
  USGS NLDI (river lines)
"""
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parents[1]
UA = "river-trip-planner/0.1 (data build)"


def get_json(url, params=None, tries=4):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # network hiccups: back off and retry
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} after error: {e}")
            time.sleep(3 * (i + 1))


def usgs_values(service, sites, **params):
    """Return {site: [(datetime_str, value), ...]} for discharge (00060)."""
    data = get_json(f"https://waterservices.usgs.gov/nwis/{service}/",
                    {"format": "json", "sites": ",".join(sites), "parameterCd": "00060", **params})
    out = {}
    for ts in data["value"]["timeSeries"]:
        site = ts["sourceInfo"]["siteCode"][0]["value"]
        vals = []
        for block in ts["values"]:
            for v in block["value"]:
                x = float(v["value"])
                if x >= 0:  # USGS uses -999999 for missing
                    vals.append((v["dateTime"], x))
        if vals:
            out.setdefault(site, []).extend(vals)
    return out


def usgs_sites(sites):
    # The site service has no JSON output; RDB (tab-separated) is the simplest to parse.
    url = "https://waterservices.usgs.gov/nwis/site/?" + urllib.parse.urlencode(
        {"format": "rdb", "sites": ",".join(sites), "siteOutput": "expanded"})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        lines = [l for l in r.read().decode().splitlines() if l and not l.startswith("#")]
    head = lines[0].split("\t")
    rows = [dict(zip(head, l.split("\t"))) for l in lines[2:]]
    return {r["site_no"]: {"id": r["site_no"], "name": tidy_name(r["station_nm"]),
                           "lat": round(float(r["dec_lat_va"]), 5), "lon": round(float(r["dec_long_va"]), 5),
                           "area_mi2": float(r["drain_area_va"]) if r.get("drain_area_va") else None}
            for r in rows}


def tidy_name(n):
    n = n.rstrip(". ").title()
    for a, b in ((" Az", ", AZ"), ("Rvr", "River"), ("Blw", "below"), ("Nr ", "near "), (" Near ", " near "),
                 (" At ", " at "), (" Below ", " below "), ("Ck", "Creek"), (",,", ",")):
        n = n.replace(a, b)
    return n


def build_flows(river, gauges_meta):
    site = river["gauges"]["primary"]
    print(f"USGS daily record for {site} ...")
    vals = usgs_values("dv", [site], startDT="1900-01-01", statCd="00003")[site]
    by_year = {}
    for d, q in vals:
        dt = date.fromisoformat(d[:10])
        if dt.month == 2 and dt.day == 29:
            continue  # 365-day calendar so every year lines up
        doy = (date(2001, dt.month, dt.day) - date(2001, 1, 1)).days
        by_year.setdefault(dt.year, [None] * 365)[doy] = round(q)
    # keep years with at least 90% of days present; always keep the current year
    this_year = date.today().year
    years = {y: v for y, v in by_year.items()
             if y == this_year or sum(x is not None for x in v) >= 0.9 * 365}
    last = vals[-1]
    return {
        "site": site,
        "site_name": gauges_meta[site]["name"],
        "units": "cfs",
        "calendar": "365-day, Feb 29 dropped",
        "first_year": min(years),
        "last_year": max(years),
        "latest": {"date": last[0][:10], "cfs": round(last[1])},
        "boatable_default": river.get("boatable_cfs_default"),
        "years": {str(y): v for y, v in sorted(years.items())},
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }


def build_outlook(river, gauges_meta):
    site = river["gauges"]["primary"]
    lid = river["nws_lid"]
    print("USGS 15-minute flow, last 14 days ...")
    iv = usgs_values("iv", [site], period="P14D").get(site, [])
    # thin to hourly to keep the file small
    hourly, seen = [], set()
    for t, q in iv:
        key = t[:13]
        if key not in seen:
            seen.add(key)
            hourly.append([t, round(q)])

    print("USGS flow, last 7 days, all map gauges ...")
    g = river["gauges"]
    ids = [x for k in ("primary", "downstream", "upstream", "nearby")
           for x in ([g[k]] if isinstance(g.get(k), str) else g.get(k) or [])]
    week = {}
    try:
        for sid, vals in usgs_values("iv", ids, period="P7D").items():
            rows, seen = [], set()
            for t, q in vals:
                if t[:13] not in seen:
                    seen.add(t[:13])
                    rows.append([t[:16], round(q, 1) if q < 10 else round(q)])
            week[sid] = rows
    except Exception as e:
        print(f"  7-day gauge data unavailable: {e}")

    print(f"NWS forecast for {lid} ...")
    nws = {"lid": lid, "url": f"https://water.noaa.gov/gauges/{lid.lower()}"}
    try:
        g = get_json(f"https://api.water.noaa.gov/nwps/v1/gauges/{lid}")
        fc = get_json(f"https://api.water.noaa.gov/nwps/v1/gauges/{lid}/stageflow/forecast")
        nws.update({
            "name": g.get("name"),
            "rfc": (g.get("rfc") or {}).get("abbreviation"),
            "issued": fc.get("issuedTime"),
            "flow_units": fc.get("secondaryUnits"),
            "forecast": [[p["validTime"], round(p["secondary"] * (1000 if fc.get("secondaryUnits") == "kcfs" else 1))]
                         for p in fc.get("data", []) if p.get("secondary") is not None and p["secondary"] >= 0],
            "flood_categories": (g.get("flood") or {}).get("categories"),
        })
    except Exception as e:
        print(f"  NWS forecast unavailable: {e}")
        nws["error"] = str(e)

    print("SNOTEL snow water equivalent ...")
    today = date.today()
    wy = today.year + 1 if today.month >= 10 else today.year
    wy_start = date(wy - 1, 10, 1)
    snow = []
    meta = {m["stationTriplet"]: m for m in get_json(
        "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations",
        {"stationTriplets": ",".join(river["snotel"]), "returnForecastPointMetadata": "false"})}
    for trip in river["snotel"]:
        cur = get_json("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data",
                       {"stationTriplets": trip, "elements": "WTEQ", "duration": "DAILY",
                        "beginDate": wy_start.isoformat(), "endDate": today.isoformat(),
                        "centralTendencyType": "MEDIAN"})
        # medians are by calendar day; take them from last water year's dates for a full curve
        prev = get_json("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data",
                        {"stationTriplets": trip, "elements": "WTEQ", "duration": "DAILY",
                         "beginDate": date(wy - 2, 10, 1).isoformat(), "endDate": date(wy - 1, 9, 30).isoformat(),
                         "centralTendencyType": "MEDIAN"})
        el = cur[0]["data"][0] if cur and cur[0].get("data") else {}
        cur_vals = [[v["date"][:10], v.get("value")] for v in el.get("values", [])]
        med = [[v["date"][5:10], v.get("median")] for v in prev[0]["data"][0]["values"]] if prev and prev[0].get("data") else []
        m = meta.get(trip, {})
        tc = el.get("timingCentralTendencies") or {}
        snow.append({
            "triplet": trip, "name": m.get("name", trip), "elev_ft": m.get("elevation"),
            "lat": m.get("latitude"), "lon": m.get("longitude"),
            "current": cur_vals, "median": med,
            "median_peak": tc.get("medianPeak"),
            "median_meltout": tc.get("medianMeltout"),
        })

    return {
        "site": site,
        "observed": hourly,
        "gauges_7d": week,
        "nws": nws,
        "water_year": wy,
        "snotel": snow,
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
    }


def simplify(coords, step=3):
    pts = [[round(x, 4), round(y, 4)] for x, y in coords[::step]]
    if coords and pts[-1] != [round(coords[-1][0], 4), round(coords[-1][1], 4)]:
        pts.append([round(coords[-1][0], 4), round(coords[-1][1], 4)])
    return pts


def nldi_lines(site, mode, distance):
    fc = get_json(f"https://api.water.usgs.gov/nldi/linked-data/nwissite/USGS-{site}/navigation/{mode}/flowlines",
                  {"distance": distance})
    lines = []
    for f in fc.get("features", []):
        g = f["geometry"]
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        lines.extend(simplify(p) for p in parts)
    return lines


def build_map(river, gauges_meta):
    g = river["gauges"]
    rivers = []
    nav = [
        ("Salt River and Black River", g["primary"], "UM", 400),
        ("White River", "09494000", "UM", 200),
        ("East Fork White River", "09492400", "UM", 100),
        ("Carrizo Creek", "09496500", "UM", 150),
        ("Cibecue Creek", "09497800", "UM", 150),
        ("Salt River (canyon)", g["primary"], "DM", 85),
    ]
    for name, site, mode, dist in nav:
        print(f"NLDI {mode} from {site} ({name}) ...")
        try:
            rivers.append({"name": name, "main": name.startswith("Salt River"), "lines": nldi_lines(site, mode, dist)})
        except Exception as e:
            print(f"  skipped: {e}")

    basin = None
    bpath = (SITE / river["basin_geojson"]).resolve() if not Path(river["basin_geojson"]).is_absolute() else Path(river["basin_geojson"])
    if not bpath.exists():
        bpath = (SITE.parent / river["basin_geojson"]).resolve()
    if bpath.exists():
        gj = json.loads(bpath.read_text())
        geom = gj["features"][0]["geometry"] if gj.get("type") == "FeatureCollection" else gj.get("geometry", gj)
        rings = geom["coordinates"] if geom["type"] == "Polygon" else max(geom["coordinates"], key=lambda p: len(p[0]))
        basin = [simplify(r, step=2) for r in rings]
    else:
        print(f"  basin outline not found at {bpath}")

    roles = {g["primary"]: "primary", g.get("downstream"): "downstream"}
    for s in g.get("upstream", []):
        roles[s] = "upstream"
    for s in g.get("nearby", []):
        roles[s] = "nearby"
    # hand-checked gauge positions (rivers.json "gauge_locations") override the USGS site record
    fix = river.get("gauge_locations", {})
    gauges = [{**gauges_meta[s], "role": roles.get(s, "upstream"), **({k: fix[s][k] for k in ("lat", "lon")} if s in fix else {})}
              for s in gauges_meta]
    return {"basin": basin, "rivers": rivers, "gauges": gauges, "points": river.get("points", []),
            "generated": datetime.now(timezone.utc).isoformat(timespec="minutes")}


def main(slug):
    registry = json.loads((SITE / "rivers.json").read_text())
    river = next(r for r in registry["rivers"] if r["slug"] == slug)
    g = river["gauges"]
    all_sites = [g["primary"]] + ([g["downstream"]] if g.get("downstream") else []) + g.get("upstream", []) + g.get("nearby", [])
    gauges_meta = usgs_sites(all_sites)

    out = SITE / "data" / slug
    out.mkdir(parents=True, exist_ok=True)
    parts = sys.argv[2:] or ["flows", "outlook", "map"]
    builders = {"flows": build_flows, "outlook": build_outlook, "map": build_map}
    for p in parts:
        data = builders[p](river, gauges_meta)
        path = out / f"{p}.json"
        path.write_text(json.dumps(data, separators=(",", ":")))
        print(f"wrote {path.relative_to(SITE.parent)} ({path.stat().st_size / 1024:.0f} KB)")
    if "outlook" in parts:  # the 8-21 day and seasonal outlooks start from the fresh NWS forecast
        import build_extended
        build_extended.main(slug)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt")
