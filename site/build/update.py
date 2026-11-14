#!/usr/bin/env python3
"""Scheduled data refresh for every river in rivers.json. Run by Windows Task Scheduler every 6 hours
("River Trip Planner data update"); safe to run by hand any time.

For each river:
  build_river.py <slug> flows outlook   USGS daily record, last 14 days, all map gauges' last 7 days,
                                        NWS forecast, SNOTEL; then build_extended.py (3-week and
                                        3-month outlooks from the CBRFC HEFS ensemble)
  build_snow.py <slug>                  NOHRSC snow water map over the basin + SNOTEL basin index vs
                                        the 1991-2020 normal (Snowpack section)
  build_weather.py <slug>               typical weather (NOAA stations via ACIS, NASA POWER cloud) and
                                        the NWS 7-day forecast at the put-in and take-out
  export_salt_model.py                  Salt only, when the Streamflow model output is present

Everything the page shows that changes over time comes from these files; the page text that depends
on the date (season wording, "closest years", test periods) is computed from them in js/river.js.
Static parts (basemap, contours, elevation tiles, rapids) only change when their build scripts are
rerun by hand. A failed step keeps the previous files and is logged to build/.cache/update.log.
"""
import json
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

BUILD = Path(__file__).resolve().parent
SITE = BUILD.parent
LOG = BUILD / ".cache" / "update.log"
PY = sys.executable.replace("pythonw.exe", "python.exe")  # child scripts print; pythonw has no console


def log(msg):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"{datetime.now().isoformat(timespec='seconds')}  {msg}"
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    try:
        print(line)
    except Exception:
        pass


def run(args):
    r = subprocess.run([PY, *args], cwd=SITE.parent, capture_output=True, text=True, timeout=1800,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-6:])
    log(f"{'ok ' if r.returncode == 0 else 'FAILED'} {' '.join(Path(a).name if i == 0 else a for i, a in enumerate(args))}\n    " +
        tail.replace("\n", "\n    "))
    return r.returncode == 0


def main():
    # keep the log short: last ~2000 lines
    if LOG.exists():
        lines = LOG.read_text(encoding="utf-8").splitlines()
        if len(lines) > 2000:
            LOG.write_text("\n".join(lines[-1500:]) + "\n", encoding="utf-8")
    rivers = json.loads((SITE / "rivers.json").read_text(encoding="utf-8"))["rivers"]
    ok = True
    for r in rivers:
        ok &= run([str(BUILD / "build_river.py"), r["slug"], "flows", "outlook"])
        if r.get("snotel"):
            ok &= run([str(BUILD / "build_snow.py"), r["slug"]])
        if r.get("weather"):
            ok &= run([str(BUILD / "build_weather.py"), r["slug"]])
        if (r["slug"] == "salt" and (BUILD / "export_salt_model.py").exists()
                and (SITE.parents[1] / "Streamflow" / "data" / "processed").exists()):
            ok &= run([str(BUILD / "export_salt_model.py")])
    log("update finished" + ("" if ok else " with failures"))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log("update crashed:\n" + traceback.format_exc())
        sys.exit(1)
