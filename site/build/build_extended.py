#!/usr/bin/env python3
"""Flow outlooks beyond the NWS 7-day forecast, from the Colorado Basin River Forecast Center.

Usage:  python site/build/build_extended.py salt      (after build_river.py)

Downloads CBRFC's ensemble forecast for the river's forecast point (rivers.json "cbrfc_id", else
"nws_lid") and writes data/<slug>/extended.json. The ensemble is CBRFC's experimental HEFS product
(https://www.cbrfc.noaa.gov/dbdata/station/ensgraph/map/ensmap.html): about 36 runs of their river
model, all starting from today's modelled snow and soil moisture, driven by GEFS weather forecasts
for the first weeks and by the weather of past years after that. It runs about 120 days ahead.

We only summarise it: daily averages (Arizona time) of each run, then percentiles across runs.

  long_range  from the last full day of the NWS forecast to day 21: 10/25/50/75/90th percentiles.
  seasonal    from day 22 to the end of the ensemble, the same percentiles, plus the average flow of
              each calendar month the ensemble fully covers (25/50/75th percentiles across runs),
              with that month's typical range from the USGS record for comparison.

If the download fails, the previous extended.json is kept.
"""
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from build_river import get_json, SITE  # noqa: E402

ENS_URL = "https://www.cbrfc.noaa.gov/dbdata/station/ensgraph/ensgraph_data.py"
PAGE_URL = "https://www.cbrfc.noaa.gov/dbdata/station/ensgraph/ensgraph.html?id={id}"
LR_DAYS = 21          # long range runs to this many days after the latest observed day
SE_START = 22         # seasonal starts here
AZ = timedelta(hours=-7)  # Arizona: UTC-7 all year
PCT = [10, 25, 50, 75, 90]


def ensemble_daily(ens):
    """(days, Q): Arizona-time days with at least 18 hourly values in every run; Q is runs x days."""
    runs = []
    for key, tr in ens["traces"].items():
        by = {}
        for t, v in tr:
            if v is None or v < 0:
                continue
            d = (datetime.fromtimestamp(t / 1000, timezone.utc) + AZ).date()
            by.setdefault(d, []).append(v)
        runs.append({d: (np.mean(v), len(v)) for d, v in by.items()})
    days = sorted(set.intersection(*(set(r) for r in runs)))
    days = [d for d in days if all(r[d][1] >= 18 for r in runs)]
    return days, np.array([[r[d][0] for d in days] for r in runs])


def rows(days, Q, i0, i1):
    p = np.percentile(Q[:, i0:i1], PCT, axis=0)
    return [[days[i0 + k].isoformat()] + [round(float(v)) for v in p[:, k]] for k in range(i1 - i0)]


def nws_last_full_day(outlook):
    by = {}
    for t, v in (outlook.get("nws") or {}).get("forecast") or []:
        d = (datetime.fromisoformat(t.replace("Z", "+00:00")) + AZ).date()
        by[d] = by.get(d, 0) + 1
    full = [d for d, n in by.items() if n >= 18]
    return max(full) if full else None


def typical_month(flows, month):
    """25/50/75th percentiles of that calendar month's average flow over the USGS record."""
    a = (date(2001, month, 1) - date(2001, 1, 1)).days
    b = (date(2001 + (month == 12), month % 12 + 1, 1) - date(2001, 1, 1)).days
    means = [np.mean(v[a:b]) for v in flows["years"].values() if all(x is not None for x in v[a:b])]
    return [round(float(x)) for x in np.percentile(means, [25, 50, 75])]


def main(slug):
    reg = json.loads((SITE / "rivers.json").read_text(encoding="utf-8"))
    river = next(r for r in reg["rivers"] if r["slug"] == slug)
    cid = river.get("cbrfc_id") or river.get("nws_lid")
    data = SITE / "data" / slug
    out_path = data / "extended.json"
    if not cid:
        print("no CBRFC forecast point configured; skipping")
        return
    flows = json.loads((data / "flows.json").read_text(encoding="utf-8"))
    outlook = json.loads((data / "outlook.json").read_text(encoding="utf-8"))

    print(f"CBRFC HEFS ensemble for {cid} ...")
    try:
        ens = get_json(ENS_URL, {"id": cid, "ndays": 30, "linear_flow": 1})
        days, Q = ensemble_daily(ens)
        if len(days) < SE_START + 14 or len(Q) < 10:
            raise ValueError(f"only {len(Q)} runs x {len(days)} days")
    except Exception as e:  # experimental product: keep the last good file
        print(f"  CBRFC ensemble unavailable ({e}); keeping {out_path.name}")
        return
    info = ens.get("ensinfo") or {}
    issued = f"{info.get('fcstdate', '')}T{info.get('fcsttime', '')[:5]}Z"
    print(f"  issued {issued}, {len(Q)} runs, {days[0]} to {days[-1]}")

    today = date.fromisoformat(flows["latest"]["date"])
    ix = {d: i for i, d in enumerate(days)}
    lr_end = today + timedelta(days=LR_DAYS)
    start = nws_last_full_day(outlook) or today
    start = max(start, days[0])
    lr = None
    if start in ix and lr_end in ix:
        lr = {"start": start.isoformat(), "columns": ["date"] + [f"p{p}" for p in PCT],
              "days": rows(days, Q, ix[start], ix[lr_end] + 1)}

    se_start = today + timedelta(days=SE_START)
    se = None
    if se_start in ix:
        i0 = ix[se_start]
        months, m = [], date(se_start.year, se_start.month, 1)
        if se_start.day > 7:  # month mostly before the seasonal window: start with the next one
            m = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
        while True:
            nxt = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
            last = nxt - timedelta(days=1)
            if m not in ix or last not in ix or len(months) == 3:
                break
            mm = Q[:, ix[m]:ix[last] + 1].mean(1)
            p25, p50, p75 = np.percentile(mm, [25, 50, 75])
            c25, c50, c75 = typical_month(flows, m.month)
            months.append({"month": m.strftime("%Y-%m"), "p25": round(p25), "p50": round(p50), "p75": round(p75),
                           "clim_p25": c25, "clim_p50": c50, "clim_p75": c75})
            m = nxt
        se = {"daily_columns": ["date"] + [f"p{p}" for p in PCT], "daily": rows(days, Q, i0, len(days)),
              "months": months}

    out = {"site": flows["site"], "generated": datetime.now(timezone.utc).isoformat(timespec="minutes"),
           "source": {"name": "NWS Colorado Basin River Forecast Center", "product": "HEFS ensemble (experimental)",
                      "id": cid, "issued": issued, "runs": int(len(Q)), "end": days[-1].isoformat(),
                      "url": PAGE_URL.format(id=cid)},
           "long_range": lr, "seasonal": se}
    out_path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    for mo in (se or {}).get("months", []):
        print(f"  {mo}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "salt")
