# River Trip Planner site (prototype)

A static site: one page per river, tabs for current flows, seasonal flows, permits, a basin map, the flow outlook and weather.

## Layout

| Path | What |
| --- | --- |
| `rivers.json` | River registry: gauges, NWS forecast point, SNOTEL stations, permit links, boatable range |
| `content/<slug>.json` | Hand-checked permit facts, with `last_verified` date |
| `build/build_river.py` | Pulls USGS, NWS, SNOTEL and NLDI data into `data/<slug>/{flows,outlook,map}.json` (standard library only) |
| `build/build_extended.py` | 3-week and 3-month outlooks from the NWS Colorado Basin River Forecast Center's experimental HEFS ensemble (rivers.json `cbrfc_id`, else `nws_lid`; needs numpy). Daily percentiles across the runs and monthly averages, beside typical months from the USGS record. Writes `data/<slug>/extended.json`; keeps the old file if CBRFC is down. Runs after the outlook part of `build_river.py` |
| `build/build_snow.py` | Snowpack section (`data/<slug>/snow.json`, `swe.png`; needs numpy, pillow, matplotlib). Current snow water equivalent from the NOAA NOHRSC snow analysis (SNODAS) map service, exported over the basin above the put-in on the same lat/lon grid as `terrain.jpg`; and one basin index (mean SWE of the SNOTEL sites with records back to 1990) against the 1991-2020 median and 10-90% range |
| `build/build_weather.py` | Weather tab (`data/<slug>/weather.json`, needs numpy). Typical highs and lows by date from a NOAA station via ACIS (Salt: Roosevelt 1 S, put-in shown 3°F cooler), rain chances averaged over the precip stations (Roosevelt and Globe), clear/cloudy days from NASA POWER, the NWS 7-day forecast at the put-in and take-out, and water temperature (no continuous sensor on the run: estimated from 7-day NASA POWER air temperature plus season, fitted to ~390 USGS field measurements at 09498500 from the Water Quality Portal; ~3°F typical error). Settings in `rivers.json` → `weather` |
| `build/update.py` | Data refresh, run every 6 hours by the GitHub Action: flows, outlook, CBRFC outlooks, snow and weather for every river. Log: `build/.cache/update.log` |
| `build/build_basemap.py` | Custom basin map in the Upper Colorado map's style: hillshaded 3DEP terrain (`terrain.jpg`), NHDPlus rivers sized by mean flow (main stem carried on to Roosevelt Lake), lakes, US and state highways from the USGS National Map, labels (`basemap.json`). Needs numpy, matplotlib, pillow. Downloads are cached in `build/.cache/` |
| `data/<slug>/contours_{1000,500,250}.json` | Pre-traced topo contours (written by `build_basemap.py` from the same DEM), with label points on the 1000 ft lines. The page draws these up to zoom 12; from zoom 13 it traces 100/40/20 ft contours per tile from USGS 3DEP elevation and keeps those grids in the browser cache |
| `build/build_dem_tiles.py` | Elevation tiles along the river corridor (5 km buffer, zoom 13-14, `data/<slug>/dem/`, ~24 MB for the Salt) so close-up contours load from the site; zoom 15-16 enlarge the zoom-14 tiles. Outside the corridor the page falls back to the USGS elevation service |
| `content/<slug>_rapids.json` | Named rapids and hazards (American Whitewater miles); `build_basemap.py` places them along the river line |
| `river.html`, `js/river.js`, `css/site.css` | The page (`river.html?r=salt`) |

## Update the data

```
python site/build/build_river.py salt                # all parts
python site/build/build_river.py salt outlook        # forecast, snowpack and CBRFC outlooks
python site/build/build_basemap.py salt              # terrain, rivers, roads, rapids, contour lines
python site/build/build_dem_tiles.py salt            # corridor elevation tiles for close-up contours (once)
```

## Preview

```
cd site
python -m http.server 8765
# open http://127.0.0.1:8765/river.html?r=salt
```

## Known gaps

- The default boatable range (800–6,000 cfs) is a placeholder.
- The Highway 288 take-out location is approximate.
- No dam controls this run, so reservoir status is a short explanation plus a link to SRP.
