#!/usr/bin/env python3
"""Weather tab data: typical weather by day of year, by month, and the NWS forecast.

Usage:  python site/build/build_weather.py salt      (also run by update.py every 6 hours)

Config: rivers.json -> river.weather. Sources (US government, public domain):
  NOAA daily station records via ACIS (data.rcc-acis.org): high, low, precipitation
  NASA POWER (power.larc.nasa.gov): daily cloud amount at a point (satellite based)
  NWS (api.weather.gov): 7-day point forecasts

Writes data/<slug>/weather.json:
  daily[365]  day-of-year statistics from a +/- 7 day window over climate_start_year..last full year:
              high p10/p50/p90 and low p10/p50/p90 (temperature station, F), chance of a wet day
              (>= 0.01 in) and of a soaking day (>= 0.25 in), mean precipitation, cloud shares
              (clear < 30%, partly 30-70%, cloudy > 70% daily cloud amount)
  months[12]  the same summarised by calendar month (precip totals and wet days per month)
  forecast    NWS periods for each forecast point
Temperatures are for the temperature station; the page applies put_in_offset_f for the put-in.
Precipitation statistics are computed per station and then averaged across the precip stations.
"""
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from build_river import get_json, SITE  # noqa: E402

WIN = 7  # +/- days pooled around each day of year


def doy(d):
    """0-364 on a 365-day calendar (Feb 29 -> Feb 28)."""
    return (date(2001, d.month, 28 if (d.month == 2 and d.day == 29) else d.day) - date(2001, 1, 1)).days


def acis(sids, elems, start, end):
    """{date: [values]} from the first station in `sids` with data on each date (threads split records)."""
    out = {}
    for sid in sids:
        r = get_json("https://data.rcc-acis.org/StnData",
                     {"params": json.dumps({"sid": sid, "sdate": start.isoformat(), "edate": end.isoformat(), "elems": elems})})
        for row in r.get("data", []):
            d = date.fromisoformat(row[0])
            vals = [val(v) for v in row[1:]]
            if d not in out or all(x is None for x in out[d]):
                out[d] = vals
    return out


def val(v):
    """ACIS value: 'M' missing, 'T' trace (counts as 0), 'S'/'A' flags (multi-day totals) -> missing."""
    if v in ("M", "", None) or v.endswith(("S", "A")):
        return None
    if v == "T":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return None


def window_stats(by_doy, fn):
    """Apply fn to the pooled values of each day of year +/- WIN."""
    out = []
    for k in range(365):
        pool = [x for j in range(k - WIN, k + WIN + 1) for x in by_doy[j % 365]]
        out.append(fn(np.array(pool)) if pool else None)
    return out


def pctl(a, p):
    return round(float(np.percentile(a, p)))


def precip_station(series, y0, y1):
    by = [[] for _ in range(365)]
    month_tot, month_wet = {}, {}
    for d, (p,) in series.items():
        if y0 <= d.year <= y1 and p is not None:
            by[doy(d)].append(p)
            key = (d.year, d.month)
            month_tot.setdefault(key, []).append(p)
            month_wet.setdefault(key, []).append(p >= 0.01)
    daily = window_stats(by, lambda a: ((a >= 0.01).mean(), (a >= 0.25).mean(), a.mean()))
    months = []
    for m in range(1, 13):
        n_days = (date(2001 + (m == 12), m % 12 + 1, 1) - date(2001, m, 1)).days
        keys = [k for k in month_tot if k[1] == m and len(month_tot[k]) >= n_days - 2]  # near-complete months only
        months.append((float(np.mean([sum(month_tot[k]) * n_days / len(month_tot[k]) for k in keys])),
                       float(np.mean([sum(month_wet[k]) * n_days / len(month_wet[k]) for k in keys])), len(keys)))
    return daily, months


def nws_forecast(pt):
    try:
        meta = get_json(f"https://api.weather.gov/points/{pt['lat']:.4f},{pt['lon']:.4f}")["properties"]
        fc = get_json(meta["forecast"])["properties"]
        periods = [{"name": p["name"], "start": p["startTime"], "day": p["isDaytime"], "temp": p["temperature"],
                    "pop": (p.get("probabilityOfPrecipitation") or {}).get("value"),
                    "short": p["shortForecast"], "wind": f"{p.get('windDirection', '')} {p.get('windSpeed', '')}".strip()}
                   for p in fc["periods"]]
        return {"name": pt["name"], "lat": pt["lat"], "lon": pt["lon"], "updated": fc.get("updateTime") or fc.get("updated"),
                "url": f"https://forecast.weather.gov/MapClick.php?lat={pt['lat']}&lon={pt['lon']}", "periods": periods}
    except Exception as e:
        print(f"  NWS forecast for {pt['name']} unavailable: {e}")
        return {"name": pt["name"], "error": str(e)}


def water_temp(cfg, y0, y1):
    """Water temperature (F): USGS field measurements at the gauge, and a fitted estimate from the
    7-day mean NASA POWER air temperature plus season (sin/cos of day of year). Gives typical values
    by day of year (model applied to y0..y1 air temperatures) and an estimate for the latest day."""
    import csv
    import io
    import urllib.parse
    import urllib.request
    url = ("https://www.waterqualitydata.us/data/Result/search?" +
           urllib.parse.urlencode({"siteid": f"USGS-{cfg['site']}", "characteristicName": "Temperature, water",
                                   "mimeType": "csv", "zip": "no"}))
    req = urllib.request.Request(url, headers={"User-Agent": "river-trip-planner/0.1 (data build)"})
    with urllib.request.urlopen(req, timeout=180) as r:
        rows = list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))
    samples = []
    for r in rows:
        try:
            v = float(r["ResultMeasureValue"])
        except (ValueError, TypeError):
            continue
        unit = r.get("ResultMeasure/MeasureUnitCode") or ""
        f = v if "F" in unit else v * 1.8 + 32
        samples.append((date.fromisoformat(r["ActivityStartDate"]), f))
    samples.sort()

    lat, lon = cfg["air_point"]
    pw = get_json("https://power.larc.nasa.gov/api/temporal/daily/point",
                  {"parameters": "T2M", "community": "RE", "latitude": lat, "longitude": lon,
                   "start": "19810101", "end": date.today().strftime("%Y%m%d"), "format": "JSON"})
    air = {date(int(k[:4]), int(k[4:6]), int(k[6:])): v * 1.8 + 32
           for k, v in pw["properties"]["parameter"]["T2M"].items() if v is not None and v > -900}

    def feats(d):
        a7 = [air.get(d - timedelta(days=k)) for k in range(7)]
        if None in a7:
            return None
        w = 2 * np.pi * d.timetuple().tm_yday / 365.25
        return [1.0, float(np.mean(a7)), np.sin(w), np.cos(w)]

    X, Y = [], []
    for d, f in samples:
        x = feats(d)
        if x:
            X.append(x)
            Y.append(f)
    X, Y = np.array(X), np.array(Y)
    coef, *_ = np.linalg.lstsq(X, Y, rcond=None)
    loo = []
    for i in range(len(Y)):  # leave-one-out error, reported on the page
        k = np.arange(len(Y)) != i
        b, *_ = np.linalg.lstsq(X[k], Y[k], rcond=None)
        loo.append(X[i] @ b - Y[i])
    loo = np.abs(np.array(loo))

    by = [[] for _ in range(365)]
    d = date(y0, 1, 1)
    while d <= date(y1, 12, 31):
        x = feats(d)
        if x:
            by[doy(d)].append(float(np.array(x) @ coef))
        d += timedelta(days=1)
    daily = window_stats(by, lambda a: (pctl(a, 10), pctl(a, 50), pctl(a, 90)))

    last = max(air)
    recent = []
    for k in range(29, -1, -1):
        dk = last - timedelta(days=k)
        x = feats(dk)
        if x:
            recent.append([dk.isoformat(), round(float(np.array(x) @ coef), 1)])
    return {
        "site": cfg["site"], "name": cfg["name"],
        "samples": [[s.isoformat(), round(f, 1)] for s, f in samples],
        "sample_years": [samples[0][0].year, samples[-1][0].year] if samples else None,
        "fit_n": int(len(Y)), "err_typical_f": round(float(np.sqrt((loo ** 2).mean())), 1),
        "err_p90_f": round(float(np.percentile(loo, 90)), 1),
        "daily": [list(x) for x in daily],  # [p10, p50, p90] by day of year
        "now": recent[-1] if recent else None, "recent": recent,
        "air_source": f"NASA POWER daily air temperature at {lat}, {lon}",
    }


def build(river):
    cfg = river["weather"]
    today = date.today()
    y0, y1 = cfg.get("climate_start_year", 1991), today.year - 1
    start, end = date(y0, 1, 1), today

    print(f"ACIS temperatures {cfg['temp_station']['name']} ...")
    temps = acis(cfg["temp_station"]["sids"], ["maxt", "mint"], start, end)
    hi = [[] for _ in range(365)]
    lo = [[] for _ in range(365)]
    for d, (mx, mn) in temps.items():
        if d.year <= y1:
            if mx is not None:
                hi[doy(d)].append(mx)
            if mn is not None:
                lo[doy(d)].append(mn)
    hi_s = window_stats(hi, lambda a: (pctl(a, 10), pctl(a, 50), pctl(a, 90)))
    lo_s = window_stats(lo, lambda a: (pctl(a, 10), pctl(a, 50), pctl(a, 90)))
    temp_through = max(d for d, v in temps.items() if v[0] is not None)

    pdaily, pmonths, pnames = [], [], []
    for st in cfg["precip_stations"]:
        print(f"ACIS precipitation {st['name']} ...")
        ser = acis(st["sids"], ["pcpn"], start, end)
        dly, mon = precip_station(ser, y0, y1)
        pdaily.append(dly)
        pmonths.append(mon)
        pnames.append(st["name"])
    p_wet = np.mean([[x[0] for x in s] for s in pdaily], axis=0)
    p_soak = np.mean([[x[1] for x in s] for s in pdaily], axis=0)
    p_mean = np.mean([[x[2] for x in s] for s in pdaily], axis=0)

    print("NASA POWER cloud amount ...")
    lat, lon = cfg["cloud_point"]
    pw = get_json("https://power.larc.nasa.gov/api/temporal/daily/point",
                  {"parameters": "CLOUD_AMT", "community": "RE", "latitude": lat, "longitude": lon,
                   "start": f"{y0}0101", "end": f"{y1}1231", "format": "JSON"})
    cl = [[] for _ in range(365)]
    cl_month = [[] for _ in range(12)]
    for k, v in pw["properties"]["parameter"]["CLOUD_AMT"].items():
        if v is None or v < 0:
            continue
        d = date(int(k[:4]), int(k[4:6]), int(k[6:]))
        cl[doy(d)].append(v)
        cl_month[d.month - 1].append(v)
    share = lambda a: (round(float((a < 30).mean()), 2), round(float(((a >= 30) & (a <= 70)).mean()), 2), round(float((a > 70).mean()), 2))
    cl_s = window_stats(cl, share)
    cloud_years = sorted({int(k[:4]) for k, v in pw["properties"]["parameter"]["CLOUD_AMT"].items() if v is not None and v >= 0})

    daily = []
    for k in range(365):
        md = date(2001, 1, 1) + timedelta(days=k)
        daily.append([md.strftime("%m-%d"), *hi_s[k], *lo_s[k], round(float(p_wet[k]), 3), round(float(p_soak[k]), 3),
                      round(float(p_mean[k]), 3), *(cl_s[k] or (None, None, None))])
    months = []
    for m in range(12):
        ks = [k for k in range(365) if (date(2001, 1, 1) + timedelta(days=k)).month == m + 1]
        months.append({
            "month": m + 1,
            "high": round(float(np.mean([hi_s[k][1] for k in ks]))), "low": round(float(np.mean([lo_s[k][1] for k in ks]))),
            "precip_in": round(float(np.mean([pm[m][0] for pm in pmonths])), 2),
            "wet_days": round(float(np.mean([pm[m][1] for pm in pmonths])), 1),
            "cloud": share(np.array(cl_month[m])) if cl_month[m] else None,
        })

    print("NWS forecasts ...")
    forecast = [nws_forecast(p) for p in cfg["forecast_points"]]

    water = None
    if cfg.get("water_temp"):
        print("Water temperature: USGS measurements + NASA POWER air temperature ...")
        try:
            water = water_temp(cfg["water_temp"], y0, y1)
            for m in months:
                ks = [k for k in range(365) if (date(2001, 1, 1) + timedelta(days=k)).month == m["month"]]
                m["water"] = round(float(np.mean([water["daily"][k][1] for k in ks])))
            print(f"  {len(water['samples'])} measurements, fit n={water['fit_n']}, typical error "
                  f"{water['err_typical_f']} F, now {water['now']}")
        except Exception as e:
            print(f"  water temperature unavailable: {e}")

    return {
        "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "climate_years": [y0, y1],
        "temp_station": {**cfg["temp_station"], "through": temp_through.isoformat()},
        "put_in_offset_f": cfg.get("put_in_offset_f", 0),
        "precip_stations": pnames,
        "cloud": {"source": "NASA POWER (CERES SYN1deg satellite cloud amount)", "lat": lat, "lon": lon,
                  "years": [cloud_years[0], cloud_years[-1]] if cloud_years else None},
        "daily_columns": ["mmdd", "hi_p10", "hi_p50", "hi_p90", "lo_p10", "lo_p50", "lo_p90",
                          "p_wet", "p_soak", "precip_in", "clear", "partly", "cloudy"],
        "daily": daily,
        "months": months,
        "forecast": forecast,
        "water": water,
    }


def main(slug):
    reg = json.loads((SITE / "rivers.json").read_text(encoding="utf-8"))
    river = next(r for r in reg["rivers"] if r["slug"] == slug)
    if not river.get("weather"):
        print(f"no weather config for {slug}")
        return
    out = build(river)
    path = SITE / "data" / slug / "weather.json"
    path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB)")
    for m in out["months"]:
        print(f"  {m}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt")
