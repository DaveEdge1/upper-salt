# Upper Salt River trip planner

A static site for planning a trip on the Upper Salt River (Salt River Canyon, Highway 60 to Highway 288, Arizona): current and seasonal flows, permits, a basin map, the river forecast center's flow outlook, snowpack and weather.

Live site: https://daveedge1.github.io/upper-salt/

A GitHub Action (`.github/workflows/site-data.yml`) rebuilds the data every 6 hours from public sources (USGS, NWS and the Colorado Basin River Forecast Center, NRCS SNOTEL, NOAA NOHRSC, NOAA ACIS, NASA POWER) and deploys the site to GitHub Pages. See `site/README.md` for the build scripts.

Not an official source. Check current conditions and permit rules with the Tonto National Forest before you go.
