/* River page: loads one river's data files and draws the four tabs.
   URL: river.html?r=<slug>  (default: salt)
   Data: data/<slug>/{flows,outlook,map,model}.json, content/<slug>.json, rivers.json */
(() => {
  "use strict";
  const SLUG = new URLSearchParams(location.search).get("r") || "salt";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // 365-day year
  const fmt = d3.format(",");
  const fmtCfs = v => (v == null || isNaN(v) ? "–" : `${fmt(Math.round(v))} cfs`);
  const pct = v => `${Math.round(v * 100)}%`;
  const $ = id => document.getElementById(id);
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const doyOf = (m, d) => MONTH_START[m - 1] + d - 1; // m 1-12
  const doyLabel = d => {
    let m = 11;
    while (m > 0 && MONTH_START[m] > d) m--;
    return `${MONTHS[m]} ${d - MONTH_START[m] + 1}`;
  };
  const mmddToDoy = s => doyOf(+s.slice(0, 2), +s.slice(3, 5));

  // ---------- tooltip ----------
  const tip = $("tooltip");
  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14, r = tip.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (ev.pointerType && ev.pointerType !== "mouse") {
      // finger: centre the readout above the touch point so the finger does not cover it
      x = Math.min(ev.clientX - r.width / 2, innerWidth - r.width - 8);
      y = ev.clientY - r.height - 36;
      if (y < 8) y = ev.clientY + 36;
    } else {
      if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
      if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    }
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // Chart hover that also works on touch screens. Mouse: hover as usual. Finger or pen: tap a point,
  // or drag sideways to scrub along the chart (vertical swipes still scroll the page); the readout
  // stays until you tap somewhere else or scroll.
  let clearTouch = null;
  const endTouch = () => { if (clearTouch) { clearTouch(); clearTouch = null; } };
  document.addEventListener("pointerdown", ev => { if (!ev.target.closest?.(".scrub")) endTouch(); }, true);
  addEventListener("scroll", endTouch, { passive: true });
  function scrub(sel, move, leave) {
    // pan-y on the outer <svg> too: some mobile browsers ignore touch-action on shapes inside an SVG
    const svgEl = sel.node().ownerSVGElement;
    [sel.node(), svgEl].forEach(n => { if (n) { n.style.touchAction = "pan-y"; n.style.touchAction = "pan-y pinch-zoom"; } });
    if (svgEl) svgEl.classList.add("scrub");
    sel.classed("scrub", true)
      .on("pointerdown pointermove", ev => {
        if (ev.pointerType !== "mouse") {
          if (clearTouch && clearTouch !== leave) clearTouch();
          clearTouch = leave;
        }
        move(ev);
      })
      .on("pointerleave", ev => { if (ev.pointerType === "mouse") leave(); });
  }
  const row = (k, v) => `<div class="r"><span>${k}</span><b>${v}</b></div>`;

  function legend(el, items) {
    el.innerHTML = items.map(i => i.line
      ? `<span class="key"><span class="ln${i.dash ? " dash" : ""}${i.bold ? " bold" : ""}" style="border-color:${i.color}"></span>${i.label}</span>`
      : `<span class="key"><span class="sw" style="background:${i.color};opacity:${i.opacity ?? 1}"></span>${i.label}</span>`).join("");
  }

  async function getJSON(path) {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  // ---------- tabs ----------
  const TABS = ["current", "seasonal", "permitting", "map", "outlook", "weather"];
  const onShow = {};
  function selectTab(name, focus) {
    TABS.forEach(t => {
      const on = t === name;
      const b = $(`tab-${t}`);
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
      if (on && focus) b.focus();
    });
    history.replaceState(null, "", `${location.search}#${name}`);
    if (onShow[name]) onShow[name]();
  }
  // arrow keys move between tabs in a tab row
  const arrowKeys = (names, idOf, select) => names.forEach((t, i) => {
    const b = $(idOf(t));
    b.addEventListener("click", () => select(t));
    b.addEventListener("keydown", e => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const j = (i + (e.key === "ArrowRight" ? 1 : names.length - 1)) % names.length;
        select(names[j], true);
        e.preventDefault();
      }
    });
  });
  arrowKeys(TABS, t => `tab-${t}`, selectTab);

  // Flow outlook sub-tabs; the hash is #outlook/season etc. (#outlook alone = Next 7 days).
  // Each sub-tab's charts draw the first time it is shown, so they measure their real width.
  const SUBS = ["season", "model", "reservoirs"];
  const onSub = {};
  let sub = "season";
  function selectSub(name, focus) {
    sub = name;
    SUBS.forEach(t => {
      const on = t === name;
      const b = $(`subtab-${t}`);
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      $(`outlook-${t}`).hidden = !on;
      if (on && focus) b.focus();
    });
    history.replaceState(null, "", `${location.search}#outlook${name === "season" ? "" : `/${name}`}`);
    if (onSub[name]) onSub[name]();
  }
  arrowKeys(SUBS, t => `subtab-${t}`, selectSub);

  // ---------- load ----------
  Promise.allSettled([
    getJSON("rivers.json"),
    getJSON(`content/${SLUG}.json`),
    getJSON(`data/${SLUG}/flows.json`),
    getJSON(`data/${SLUG}/outlook.json`),
    getJSON(`data/${SLUG}/map.json`),
    getJSON(`data/${SLUG}/model.json`),
    getJSON(`data/${SLUG}/basemap.json`),
    getJSON(`data/${SLUG}/extended.json`),
    getJSON(`data/${SLUG}/weather.json`),
    getJSON(`data/${SLUG}/snow.json`),
  ]).then(([reg, content, flows, outlook, map, model, basemap, ext, wx, sn]) => {
    const v = p => (p.status === "fulfilled" ? p.value : null);
    [reg, content, flows, outlook, map, model, basemap, ext, wx, sn].forEach(p => p.status === "rejected" && console.warn(p.reason));
    const river = v(reg)?.rivers.find(r => r.slug === SLUG);
    if (!river) { $("river-name").textContent = "River not found"; return; }
    init(river, v(content), v(flows), v(outlook), v(map), v(model), v(basemap), v(ext), v(wx), v(sn));
  });

  function init(river, content, flows, outlook, map, model, basemap, ext, wx, sn) {
    document.title = `${river.name} | River Trip Planner`;
    $("river-name").textContent = river.name;
    $("river-section").textContent = river.section;
    $("river-state").textContent = river.state;
    const built = [flows?.generated, outlook?.generated].filter(Boolean).sort().pop();
    if (built) $("build-time").textContent = `Data updated ${new Date(built).toLocaleString()}.`;

    GUIDE = content?.flow_guide || null;
    if (GUIDE) {
      let saved = null;
      try { saved = localStorage.getItem(CRAFT_KEY); } catch (e) { /* no storage */ }
      craft = GUIDE.crafts[saved] ? saved : GUIDE.default;
      GUIDE.gauge = GUIDE.gauge || (flows ? `USGS ${flows.site} gauge (${flows.site_name})` : null);
    }
    if (flows) headerNow(flows, outlook);
    if (flows) seasonal(river, content, flows, outlook);
    if (content) permitting(content);
    if (map) onShow.map = once(() => drawMap(river, map, flows, outlook, basemap));
    onSub.season = once(() => { extended(ext, outlook, flows); snow(outlook, sn, basemap); });
    if (outlook) onShow.current = once(() => week(outlook));
    if (model) onSub.model = once(() => modelTrack(model));
    onShow.outlook = () => selectSub(sub);
    if (wx) onShow.weather = once(() => weather(wx));
    else $("tab-weather").hidden = true;

    // no (valid) hash: land on Flow outlook > Long range and snowpack.
    // #outlook/week (old links, before Next 7 days moved) opens Current flows.
    const [start, startSub] = location.hash.slice(1).split("/");
    if (SUBS.includes(startSub)) sub = startSub;
    const first = start === "outlook" && startSub === "week" ? "current" : TABS.includes(start) ? start : "outlook";
    selectTab(first);
  }
  const once = fn => { let done = false; return () => { if (!done) { done = true; requestAnimationFrame(fn); } }; };

  // ---------- boat type: flow bands per craft (content/<slug>.json flow_guide) ----------
  let GUIDE = null, craft = null, nowQ = null;
  const CRAFT_KEY = "rtp-craft";
  const bandFor = (c, q) => c.bands.find(b => b.max == null || q < b.max);
  const bandRange = (c, i) => {
    const lo = i ? c.bands[i - 1].max : null, hi = c.bands[i].max;
    return lo == null ? `under ${fmt(hi)} cfs` : hi == null ? `over ${fmt(lo)} cfs` : `${fmt(lo)}–${fmt(hi)} cfs`;
  };
  function setCraft(k) {
    craft = k;
    try { localStorage.setItem(CRAFT_KEY, k); } catch (e) { /* storage blocked: keep for this visit only */ }
  }
  // header badges (one per craft) and the flow guide cards on Current flows (one per craft)
  function renderCraft() {
    if (!GUIDE || nowQ == null) return;
    const hc = $("now-craft");
    if (hc) hc.innerHTML = Object.values(GUIDE.crafts).map(k => {
      const kb = bandFor(k, nowQ);
      return `<span class="chip t-${kb.tone}" title="${esc(k.label)} at ${fmt(Math.round(nowQ))} cfs: ${esc(kb.note || kb.label)}">${esc(k.label)}: ${esc(kb.label)}</span>`;
    }).join("");
    $("flow-guides").innerHTML = Object.values(GUIDE.crafts).map(guideCard).join("") +
      `<p class="note">Flows at Chrysotile/put-in</p>`;
  }
  function guideCard(c) {
    const b = bandFor(c, nowQ);
    const lo = 100, hi = 10000, X = v => Math.max(0, Math.min(100, (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * 100));
    let prev = lo;
    const segs = c.bands.map((bd, i) => {
      const a = X(prev), z = X(bd.max ?? hi);
      prev = bd.max ?? hi;
      return `<i class="fg-seg t-${bd.tone}" style="left:${a}%;width:${z - a}%" title="${esc(bd.label)}: ${bandRange(c, i)}"></i>`;
    }).join("");
    const ticks = [200, 500, 1000, 2000, 5000].map(v => `<span class="fg-tick" style="left:${X(v)}%">${fmt(v)}</span>`).join("");
    const cur = c.bands.indexOf(b);
    return `<div class="flow-guide"><div class="fg-head"><strong>Flow guide: ${esc(c.label)}</strong></div>` +
      `<div class="fg-bar" role="img" aria-label="Flow bands for ${esc(c.label)}; now ${fmt(Math.round(nowQ))} cfs, ${esc(b.label)}">${segs}` +
      `<span class="fg-now" style="left:${X(nowQ)}%"><b>Now ${fmt(Math.round(nowQ))}</b></span></div><div class="fg-ticks">${ticks}</div>` +
      `<ol class="fg-list">${c.bands.map((bd, i) => `<li${i === cur ? ' class="cur"' : ""}><span class="sw t-${bd.tone}"></span>` +
        `<b>${esc(bd.label)}</b> <span class="rng">${bandRange(c, i)}</span></li>`).join("")}</ol></div>`;
  }

  // ---------- header: flow right now ----------
  function headerNow(flows, outlook) {
    const obs = outlook?.observed;
    let q, when;
    if (obs?.length) {
      const last = obs[obs.length - 1];
      q = last[1];
      when = new Date(last[0]).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } else {
      q = flows.latest.cfs;
      when = `${flows.latest.date} daily mean`;
    }
    const today = new Date();
    const d = doyOf(today.getMonth() + 1, Math.min(today.getDate(), today.getMonth() === 1 ? 28 : 31));
    const past = Object.entries(flows.years).filter(([y]) => +y < today.getFullYear()).map(([, a]) => a[d]).filter(x => x != null);
    const below = past.filter(x => x < q).length;
    const share = past.length ? below / past.length : null;
    const rank = share != null ? `higher than ${pct(share)} of past years on this date` : "";
    const chip = share == null ? "" : share >= 2 / 3 ? '<span class="chip wet">Wetter than usual</span>'
      : share <= 1 / 3 ? '<span class="chip dry">Drier than usual</span>' : '<span class="chip normal">About normal</span>';
    $("now").innerHTML = `<span class="val">${fmtCfs(q)}</span>${chip}<span id="now-craft"></span>
      <span class="sub">${flows.site_name} · ${when}${rank ? ` · ${rank}` : ""}</span>`;
    nowQ = q;
    renderCraft();
  }

  // ---------- 1. seasonal flows ----------
  function seasonal(river, content, flows, outlook) {
    const thisYear = new Date().getFullYear();
    // highest hourly reading in the recent USGS record (daily averages hide short flood peaks)
    let ivPeak = null;
    (outlook?.observed || []).forEach(([t, v]) => {
      if (v == null || (ivPeak && v <= ivPeak.v)) return;
      const dt = new Date(t);
      ivPeak = { v, t: dt, year: dt.getFullYear(), d: doyOf(dt.getMonth() + 1, Math.min(dt.getDate(), dt.getMonth() === 1 ? 28 : 31)) };
    });
    const allYears = Object.keys(flows.years).map(Number).sort((a, b) => a - b);
    const complete = allYears.filter(y => y < thisYear);
    const season = content?.season ? [mmddToDoy(content.season.start), mmddToDoy(content.season.end)] : null;
    const craftDef = () => GUIDE ? { min: GUIDE.crafts[craft].range[0], max: GUIDE.crafts[craft].range[1] } : null;
    const def = craftDef() || flows.boatable_default || { min: 800, max: 6000 };
    if (GUIDE) {
      $("ctl-craft-wrap").hidden = false;
      $("ctl-craft").innerHTML = Object.entries(GUIDE.crafts).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join("");
      $("ctl-craft").value = craft;
      $("ctl-craft").addEventListener("change", () => {
        setCraft($("ctl-craft").value);
        const d = craftDef();
        $("ctl-min").value = d.min;
        $("ctl-max").value = d.max;
        draw();
        planner(state());
        renderCraft();
      });
    }

    const sel = $("ctl-compare");
    sel.innerHTML = `<option value="">None</option>` + allYears.slice().reverse()
      .map(y => `<option value="${y}">${y}${y === thisYear ? " (this year)" : ""}</option>`).join("");
    sel.value = String(allYears[allYears.length - 1]);
    $("ctl-min").value = def.min;
    $("ctl-max").value = def.max;
    const nextSeason = new Date().getMonth() >= 5 ? thisYear + 1 : thisYear;
    $("ctl-launch").value = `${nextSeason}-04-01`;

    const state = () => {
      const p = $("ctl-years").value;
      const ys = p === "all" ? complete : complete.slice(-Number(p));
      let min = Number($("ctl-min").value) || 0, max = Number($("ctl-max").value) || Infinity;
      if (max < min) [min, max] = [max, min];
      return { years: ys, compare: sel.value ? Number(sel.value) : null, min, max };
    };

    function stats(st) {
      const out = [];
      for (let d = 0; d < 365; d++) {
        // pool a 7-day window around each date so the bands are not jagged
        const v = [];
        st.years.forEach(y => { for (let k = -3; k <= 3; k++) { const x = flows.years[y][(d + k + 365) % 365]; if (x != null) v.push(x); } });
        v.sort((a, b) => a - b);
        const inR = v.filter(x => x >= st.min && x <= st.max).length;
        out.push({
          d, n: v.length,
          p10: d3.quantileSorted(v, 0.1), p25: d3.quantileSorted(v, 0.25), p50: d3.quantileSorted(v, 0.5),
          p75: d3.quantileSorted(v, 0.75), p90: d3.quantileSorted(v, 0.9),
          chance: v.length ? inR / v.length : null,
        });
      }
      return out;
    }

    const elMain = $("chart-seasonal"), elStrip = $("chart-chance");
    let hoverLine = [];

    function draw() {
      const st = state();
      const S = stats(st);
      const cmp = st.compare ? flows.years[st.compare] : null;
      const W = Math.max(320, elMain.clientWidth);
      const small = W < 560;
      const m = { t: 28, r: small ? 12 : 92, b: 26, l: 52 };
      const H = small ? 260 : 330;
      const x = d3.scaleLinear([0, 364], [m.l, W - m.r]);
      // show the hourly peak only when it is well above that day's average
      const pk = cmp && ivPeak && ivPeak.year === st.compare && cmp[ivPeak.d] != null && ivPeak.v > 1.2 * cmp[ivPeak.d] ? ivPeak : null;
      const hi = d3.max([d3.max(S, s => s.p90), cmp ? d3.max(cmp) : 0, pk ? pk.v : 0, st.max === Infinity ? 0 : st.max]);
      const lo = d3.min([d3.min(S, s => s.p10), cmp ? d3.min(cmp.filter(v => v != null)) : Infinity, st.min || Infinity]);
      const y = d3.scaleLog([Math.max(20, lo * 0.8), hi * 1.25], [H - m.b, m.t]).clamp(true);
      const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000]
        .filter(t => t >= y.domain()[0] && t <= y.domain()[1]);
      const band = css("--band"), med = css("--median"), wet = css("--wet"), dry = css("--dry"),
        ink = css("--ink"), ink2 = css("--ink-2"), ink3 = css("--ink-3");

      const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
        .attr("aria-label", `Daily flow by date, ${st.years[0]}–${st.years[st.years.length - 1]}`);
      // grid + axes
      svg.append("g").attr("class", "grid").selectAll("line").data(ticks).join("line")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
      svg.append("g").selectAll("text").data(ticks).join("text")
        .attr("x", m.l - 8).attr("y", t => y(t) + 4).attr("text-anchor", "end").text(t => d3.format(t >= 10000 ? "~s" : ",")(t).replace("k", "K"));
      svg.append("text").attr("x", m.l - 8).attr("y", m.t - 6).attr("text-anchor", "end").text("cfs");
      svg.append("g").selectAll("text").data(MONTH_START).join("text")
        .attr("x", d => x(d + 14)).attr("y", H - 6).attr("text-anchor", "middle").text((d, i) => MONTHS[i]);
      svg.append("g").attr("class", "grid").selectAll("line").data(MONTH_START.slice(1)).join("line")
        .attr("x1", x).attr("x2", x).attr("y1", m.t).attr("y2", H - m.b).attr("opacity", 0.6);
      // permit season
      if (season) {
        svg.append("rect").attr("x", x(season[0])).attr("width", x(season[1]) - x(season[0]))
          .attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", css("--season"));
        svg.append("text").attr("class", "label-strong").attr("x", x(season[0]) + 6).attr("y", m.t + 14)
          .text(content.season.label || "Season");
      }
      // your range
      if (st.max !== Infinity) {
        const yTop = y(st.max), yBot = y(Math.max(st.min, y.domain()[0]));
        svg.append("rect").attr("x", m.l).attr("width", W - m.r - m.l).attr("y", yTop).attr("height", Math.max(0, yBot - yTop))
          .attr("fill", ink).attr("opacity", 0.035);
        [yTop, yBot].forEach(yy => svg.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", yy).attr("y2", yy)
          .attr("stroke", ink2).attr("stroke-width", 1).attr("opacity", 0.6));
      }
      // history bands (neutral) and median
      const area = (a, b) => d3.area().defined(s => s.n > 0).x(s => x(s.d)).y0(s => y(s[a])).y1(s => y(s[b])).curve(d3.curveMonotoneX);
      svg.append("path").attr("d", area("p10", "p90")(S)).attr("fill", band).attr("opacity", 0.16);
      svg.append("path").attr("d", area("p25", "p75")(S)).attr("fill", band).attr("opacity", 0.28);
      const medLine = d3.line().defined(s => s.n > 0).x(s => x(s.d)).y(s => y(s.p50)).curve(d3.curveMonotoneX);
      if (cmp) {
        // wet/dry fill between the compare year and the median: blue-green above, brown below
        const uid = Math.random().toString(36).slice(2, 8);
        const defs = svg.append("defs");
        const aboveArea = d3.area().x(s => x(s.d)).y0(m.t).y1(s => y(s.p50)).curve(d3.curveMonotoneX)(S);
        const belowArea = d3.area().x(s => x(s.d)).y0(H - m.b).y1(s => y(s.p50)).curve(d3.curveMonotoneX)(S);
        defs.append("clipPath").attr("id", `wet-${uid}`).append("path").attr("d", aboveArea);
        defs.append("clipPath").attr("id", `dry-${uid}`).append("path").attr("d", belowArea);
        const between = d3.area().defined((v, i) => v != null && S[i].n > 0)
          .x((v, i) => x(i)).y0((v, i) => y(S[i].p50)).y1(v => y(v)).curve(d3.curveMonotoneX)(cmp);
        svg.append("path").attr("d", between).attr("fill", wet).attr("opacity", 0.45).attr("clip-path", `url(#wet-${uid})`);
        svg.append("path").attr("d", between).attr("fill", dry).attr("opacity", 0.45).attr("clip-path", `url(#dry-${uid})`);
      }
      svg.append("path").attr("d", medLine(S))
        .attr("fill", "none").attr("stroke", med).attr("stroke-width", 2).attr("stroke-dasharray", "6 4").attr("stroke-linejoin", "round");
      if (cmp) {
        svg.append("path").attr("d", d3.line().defined(v => v != null).x((v, i) => x(i)).y(v => y(v)).curve(d3.curveMonotoneX)(cmp))
          .attr("fill", "none").attr("stroke", ink).attr("stroke-width", 2.25).attr("stroke-linejoin", "round");
        const lastI = cmp.reduce((a, v, i) => (v != null ? i : a), -1);
        if (lastI >= 0) {
          svg.append("circle").attr("cx", x(lastI)).attr("cy", y(cmp[lastI])).attr("r", 4).attr("fill", ink)
            .attr("stroke", css("--surface")).attr("stroke-width", 2);
        }
        if (pk) {
          const px = x(pk.d), py = y(pk.v);
          svg.append("line").attr("x1", px).attr("x2", px).attr("y1", py).attr("y2", y(cmp[pk.d]))
            .attr("stroke", ink).attr("stroke-width", 1).attr("stroke-dasharray", "2 3");
          svg.append("circle").attr("cx", px).attr("cy", py).attr("r", 4.5).attr("fill", css("--surface"))
            .attr("stroke", ink).attr("stroke-width", 2);
          const right = px < W - m.r - 150;
          svg.append("text").attr("class", "label-strong").attr("x", px + (right ? 9 : -9)).attr("y", py + 4)
            .attr("text-anchor", right ? "start" : "end").text(`${fmtCfs(pk.v)} hourly peak`);
        }
      }
      // direct labels at right edge (wide screens)
      if (!small) {
        const end = S[364];
        const lab = (yy, t, cls) => svg.append("text").attr("x", W - m.r + 8).attr("y", yy + 4).attr("class", cls || "").text(t);
        const medY = y(end.p50);
        lab(medY, "Median");
        if (cmp) {
          const lastI = cmp.reduce((a, v, i) => (v != null ? i : a), -1);
          if (lastI === 364) {
            let cy = y(cmp[364]);
            if (Math.abs(cy - medY) < 14) cy = medY + (cy < medY ? -14 : 14);
            lab(cy, String(st.compare), "label-strong");
          } else if (lastI >= 0) {
            svg.append("text").attr("class", "label-strong").attr("x", x(lastI) + 8).attr("y", y(cmp[lastI]) - 8).text(String(st.compare));
          }
        }
        if (st.max !== Infinity) lab(y(st.max), "Your range");
      }
      // hover
      const cross = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", ink3).attr("stroke-width", 1).attr("opacity", 0);
      hoverLine = [cross];
      svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b)
        .attr("fill", "transparent")
        .call(scrub, ev => hover(ev, Math.round(x.invert(d3.pointer(ev)[0]))), () => unhover());
      elMain.replaceChildren(svg.node());

      // chance strip
      const Hs = 110, ms = { t: 22, b: 22 };
      const ys = d3.scaleLinear([0, 1], [Hs - ms.b, ms.t]);
      const sv = d3.create("svg").attr("viewBox", `0 0 ${W} ${Hs}`).attr("role", "img").attr("aria-label", "Chance flow is in your range, by date");
      sv.append("g").attr("class", "grid").selectAll("line").data([0, 0.5, 1]).join("line")
        .attr("x1", m.l).attr("x2", W - m.r).attr("y1", ys).attr("y2", ys);
      sv.append("g").selectAll("text").data([0, 0.5, 1]).join("text")
        .attr("x", m.l - 8).attr("y", t => ys(t) + 4).attr("text-anchor", "end").text(pct);
      sv.append("text").attr("class", "label-strong").attr("x", m.l).attr("y", 12).text(`Chance flow is in your range (${fmt(st.min)}–${st.max === Infinity ? "any" : fmt(st.max)} cfs)`);
      if (season) sv.append("rect").attr("x", x(season[0])).attr("width", x(season[1]) - x(season[0]))
        .attr("y", ms.t).attr("height", Hs - ms.b - ms.t).attr("fill", css("--season"));
      sv.append("path").attr("d", d3.area().defined(s => s.chance != null).x(s => x(s.d)).y0(ys(0)).y1(s => ys(s.chance)).curve(d3.curveMonotoneX)(S))
        .attr("fill", wet).attr("opacity", 0.18);
      sv.append("path").attr("d", d3.line().defined(s => s.chance != null).x(s => x(s.d)).y(s => ys(s.chance)).curve(d3.curveMonotoneX)(S))
        .attr("fill", "none").attr("stroke", wet).attr("stroke-width", 2);
      sv.append("g").selectAll("text").data(MONTH_START).join("text")
        .attr("x", d => x(d + 14)).attr("y", Hs - 6).attr("text-anchor", "middle").text((d, i) => MONTHS[i]);
      const cross2 = sv.append("line").attr("y1", ms.t).attr("y2", Hs - ms.b).attr("stroke", ink3).attr("stroke-width", 1).attr("opacity", 0);
      hoverLine.push(cross2);
      sv.append("rect").attr("x", m.l).attr("y", ms.t).attr("width", W - m.l - m.r).attr("height", Hs - ms.t - ms.b)
        .attr("fill", "transparent")
        .call(scrub, ev => hover(ev, Math.round(x.invert(d3.pointer(ev)[0]))), () => unhover());
      elStrip.replaceChildren(sv.node());

      function hover(ev, d) {
        d = Math.max(0, Math.min(364, d));
        const s = S[d];
        hoverLine.forEach(l => l.attr("x1", x(d)).attr("x2", x(d)).attr("opacity", 0.8));
        showTip(`<div class="t">${doyLabel(d)}</div>` +
          row("Median", fmtCfs(s.p50)) +
          row("Middle half of years", `${fmt(Math.round(s.p25))}–${fmt(Math.round(s.p75))}`) +
          row("8 of 10 years", `${fmt(Math.round(s.p10))}–${fmt(Math.round(s.p90))}`) +
          (cmp ? row(`${st.compare} daily average`, fmtCfs(cmp[d])) : "") +
          (pk && d === pk.d ? row("Hourly peak", fmtCfs(pk.v)) : "") +
          row("Chance in your range", s.chance == null ? "–" : pct(s.chance)), ev);
      }
      function unhover() { hoverLine.forEach(l => l.attr("opacity", 0)); hideTip(); }

      legend($("seasonal-legend"), [
        { label: "Median", color: med, line: true, dash: true },
        { label: "Middle half of years", color: band, opacity: 0.45 },
        { label: "8 of 10 years", color: band, opacity: 0.22 },
        ...(cmp ? [{ label: `${st.compare} (daily average)`, color: ink, line: true, bold: true },
                   { label: "Wetter than median", color: wet, opacity: 0.6 },
                   { label: "Drier than median", color: dry, opacity: 0.6 }] : []),
        { label: "Your range (between the lines)", color: ink2, line: true },
      ]);

      // lede + note
      const peak = S.reduce((a, s) => (s.p50 > a.p50 ? s : a), S[0]);
      let lede = `Over ${st.years.length} years (${st.years[0]}–${st.years[st.years.length - 1]}), the median flow peaks around ${doyLabel(peak.d)} at ${fmtCfs(peak.p50)}.`;
      if (season) {
        const inSeason = S.slice(season[0], season[1] + 1).filter(s => s.chance != null);
        lede += ` During the ${content.season.label.toLowerCase()}, flow was in your range on ${pct(d3.mean(inSeason, s => s.chance))} of days.`;
      }
      $("seasonal-lede").textContent = lede;
      $("seasonal-note").textContent = `Daily average flow at USGS ${flows.site} (${flows.site_name}), ${flows.first_year}–${flows.last_year}. ` +
        (river.regulated ? "Only years after the upstream dam was built are used." : "Only small lakes upstream, no large dam, so the full record is comparable.") +
        " Daily averages smooth out flash floods, so short peaks read lower here than on the hourly 7-day chart under Flow outlook." +
        (GUIDE ? ` Default range for ${GUIDE.crafts[craft].label.toLowerCase()}: ${fmt(craftDef().min)}–${fmt(craftDef().max)} cfs, from the flow guide above.`
               : def.note ? ` Default range: ${def.note}` : "");
      planner(st);
      table(S, st);
    }

    function planner(st) {
      const v = $("ctl-launch").value;
      const days = Math.max(1, Math.min(14, Number($("ctl-days").value) || 1));
      if (!v) return;
      const [, mm, dd] = v.split("-").map(Number);
      const d0 = doyOf(mm, Math.min(dd, 28 + (mm !== 2) * 3));
      let ok = 0, n = 0;
      const launch = [];
      st.years.forEach(y => {
        const a = flows.years[y];
        const span = Array.from({ length: days }, (_, i) => a[(d0 + i) % 365]);
        if (span.some(x => x == null)) return;
        n++;
        if (span.every(x => x >= st.min && x <= st.max)) ok++;
        launch.push(span[0]);
      });
      launch.sort((a, b) => a - b);
      const tile = (k, val, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${val}</div><div class="d">${d}</div></div>`;
      $("planner-tiles").innerHTML =
        tile(`Whole ${days}-day trip in range`, n ? pct(ok / n) : "–", `${ok} of ${n} years`) +
        tile("Typical launch-day flow", fmtCfs(d3.quantileSorted(launch, 0.5)), `median, ${doyLabel(d0)}`) +
        tile("Launch-day flow, 8 of 10 years", launch.length ? `${fmt(Math.round(d3.quantileSorted(launch, 0.1)))}–${fmt(Math.round(d3.quantileSorted(launch, 0.9)))}` : "–", "cfs");
    }

    function table(S, st) {
      let det = $("seasonal-table");
      if (!det) {
        det = document.createElement("details");
        det.id = "seasonal-table";
        det.innerHTML = `<summary class="note" style="cursor:pointer">Show as a table</summary><div class="tbl"></div>`;
        elStrip.parentElement.appendChild(det);
      }
      const rows = [];
      MONTH_START.forEach(ms => [0, 14].forEach(off => rows.push(S[ms + off])));
      det.querySelector(".tbl").innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.85rem;margin-top:8px">
        <thead><tr><th align="left">Date</th><th align="right">Median</th><th align="right">8 of 10 years</th><th align="right">Chance in range</th></tr></thead>
        <tbody>${rows.map(s => `<tr style="border-top:1px solid var(--rule)"><td>${doyLabel(s.d)}</td><td align="right">${fmt(Math.round(s.p50))}</td>
        <td align="right">${fmt(Math.round(s.p10))}–${fmt(Math.round(s.p90))}</td><td align="right">${s.chance == null ? "–" : pct(s.chance)}</td></tr>`).join("")}</tbody></table>`;
    }

    ["ctl-years", "ctl-compare", "ctl-min", "ctl-max"].forEach(id => $(id).addEventListener("change", draw));
    ["ctl-launch", "ctl-days"].forEach(id => $(id).addEventListener("change", () => planner(state())));
    new ResizeObserver(debounce(draw, 120)).observe(elMain);
    onShow.seasonal = draw;
  }
  function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // ---------- 2. permitting ----------
  function permitting(c) {
    $("permit-summary").textContent = c.summary;
    const today = new Date().toISOString().slice(0, 10);
    const nextIdx = c.key_dates.findIndex(k => k.date >= today);
    $("permit-dates").innerHTML = c.key_dates.map((k, i) => {
      const d = new Date(`${k.date}T12:00:00`);
      const cls = i < nextIdx || nextIdx === -1 ? "past" : i === nextIdx ? "next" : "";
      return `<li class="${cls}"><span class="when">${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>${k.label}</li>`;
    }).join("");
    $("permit-cards").innerHTML = c.permits.map(p => `<div class="card"><h4>${p.name}</h4><dl>
      <dt>Issued by</dt><dd>${p.issuer}</dd><dt>When</dt><dd>${p.when}</dd><dt>How</dt><dd>${p.how}</dd>
      <dt>Cost</dt><dd>${p.cost}</dd>${p.phone ? `<dt>Phone</dt><dd>${p.phone}</dd>` : ""}</dl>
      <div class="links">${p.links.map(l => `<a href="${l.url}" target="_blank" rel="noopener">${l.text}</a>`).join("")}</div></div>`).join("");
    $("permit-rules").innerHTML = c.rules.map(r => `<li>${r}</li>`).join("");
    $("permit-contacts").innerHTML = c.contacts.map(k => `<li>${k.name}: <a href="tel:${k.phone.replace(/[^0-9]/g, "")}">${k.phone}</a></li>`).join("");
    $("permit-open").innerHTML = c.open_questions.map(q => `<li>${q}</li>`).join("");
    $("permit-verified").innerHTML = `Last checked against agency pages on ${c.last_verified}. Rules change; confirm with the agency before you go. Sources: ` +
      c.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.text}</a>`).join(", ") + ".";
  }

  // ---------- 3. basin map ----------
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Custom basemap in the style of the Upper Colorado map: hillshaded terrain image,
  // NHDPlus rivers drawn by mean flow, lakes, basin outlines, then gauges and stations on top.
  // 7-day sparkline for the map hover cards (returns an SVG string)
  function spark(pts, { color, unit, log = false, zero = false }) {
    const W = 220, H = 74, m = { t: 6, r: 8, b: 16, l: 38 };
    const lo = d3.min(pts, p => p.v), hi = d3.max(pts, p => p.v);
    const x = d3.scaleTime(d3.extent(pts, p => p.t), [m.l, W - m.r]);
    const y = log ? d3.scaleLog([Math.max(1, lo * 0.9), hi * 1.1], [H - m.b, m.t])
      : d3.scaleLinear([zero ? 0 : Math.max(0, lo - (hi - lo) * 0.1), hi === lo ? hi + (unit === "in" ? 1 : Math.max(1, hi * 0.1)) : hi + (hi - lo) * 0.1], [H - m.b, m.t]);
    const yy = v => y(Math.max(v, y.domain()[0]));
    const line = d3.line().x(p => x(p.t)).y(p => yy(p.v)).curve(d3.curveMonotoneX)(pts);
    const f = v => (unit === "in" ? (+v).toFixed(1) : d3.format(v >= 10000 ? ".3~s" : ",")(Math.round(v)).replace("k", "K"));
    const dl = d => d.toLocaleDateString([], { month: "short", day: "numeric" });
    const [t0, t1] = x.domain(), last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Last 7 days, ${f(lo)} to ${f(hi)} ${unit}">
      <line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}" stroke="#d8d2c2"/>
      <text x="${m.l - 4}" y="${yy(hi) + 3.5}" text-anchor="end">${f(hi)}</text>
      ${hi !== lo ? `<text x="${m.l - 4}" y="${Math.min(H - m.b, yy(lo) + 3.5)}" text-anchor="end">${f(lo)}</text>` : ""}
      <text x="${m.l}" y="${H - 3}">${dl(t0)}</text><text x="${W - m.r}" y="${H - 3}" text-anchor="end">${dl(t1)}</text>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${x(last.t)}" cy="${yy(last.v)}" r="3" fill="${color}"/>
    </svg>`;
  }

  // split a route's segments into connected stretches; return each stretch's length and a middle point
  function roadRuns(lines) {
    const key = p => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    const km = (a, b) => Math.hypot((a[0] - b[0]) * 92.6, (a[1] - b[1]) * 111.1);
    const parent = lines.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const ends = new Map();
    lines.forEach((l, i) => [l[0], l[l.length - 1]].forEach(p => {
      const k = key(p);
      if (ends.has(k)) parent[find(i)] = find(ends.get(k)); else ends.set(k, i);
    }));
    const runs = new Map();
    lines.forEach((l, i) => {
      const r = find(i);
      if (!runs.has(r)) runs.set(r, { km: 0, lines: [] });
      const run = runs.get(r);
      for (let j = 1; j < l.length; j++) run.km += km(l[j - 1], l[j]);
      run.lines.push(l);
    });
    return [...runs.values()].map(run => {
      const pts = run.lines.flat();
      const cx = d3.mean(pts, p => p[0]), cy = d3.mean(pts, p => p[1]);
      return { km: run.km, mid: d3.least(pts, p => Math.hypot(p[0] - cx, p[1] - cy)) };
    });
  }

  // Topo contours drawn in the browser from USGS 3DEP elevation, so the interval follows the zoom:
  // 1000 ft zoomed out down to 20 ft at full zoom. Each tile fetches a 258 x 258 float elevation grid
  // (one pixel of overlap on every side so lines meet across tile edges) and traces it with d3.contours.
  // zoom -> contour interval. Up to zoom 12 the lines are pre-traced (data/<river>/contours_*.json);
  // from zoom 13 they are drawn per tile from elevation fetched for that tile.
  const CONTOUR_FT = z => (z < 9.5 ? 1000 : z < 10.5 ? 500 : z < 12.75 ? 250 : z < 13.5 ? 100 : z < 14.5 ? 40 : 20);
  const DEM_CACHE = "dem-tiles-v1";
  const DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?";
  // Elevation along the river corridor ships with the site (build/build_dem_tiles.py): 258 x 258 PNGs
  // for zoom 13 and 14, feet = R*256 + G - 1000, blue 0 = no data. Zoom 15-16 enlarge part of the
  // zoom-14 tile. Anywhere else the tile falls back to the USGS elevation service.
  let demIndex = null;
  const demTiles = () => demIndex || (demIndex = fetch(`data/${SLUG}/dem/manifest.json`)
    .then(r => (r.ok ? r.json() : { tiles: {} }))
    .then(m => ({ 13: new Set(m.tiles[13] || []), 14: new Set(m.tiles[14] || []) }))
    .catch(() => ({ 13: new Set(), 14: new Set() })));
  const demGrids = new Map();  // "z/x/y" -> Promise<Float64Array(258*258)> of feet
  const localDem = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (!demGrids.has(key)) {
      if (demGrids.size > 96) demGrids.delete(demGrids.keys().next().value);
      demGrids.set(key, fetch(`data/${SLUG}/dem/${key}.png`).then(r => r.blob()).then(createImageBitmap).then(img => {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 258;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const d = cx.getImageData(0, 0, 258, 258).data, ft = new Float64Array(258 * 258);
        for (let i = 0; i < ft.length; i++) ft[i] = d[i * 4 + 2] ? d[i * 4] * 256 + d[i * 4 + 1] - 1000 : NaN;
        return ft;
      }));
    }
    return demGrids.get(key);
  };
  // the 258 x 258 grid for tile c from the shipped tiles, or null if the corridor doesn't cover it
  const corridorGrid = c => demTiles().then(idx => {
    if (c.z === 13 && idx[13].has(`${c.x}/${c.y}`)) return localDem(13, c.x, c.y);
    if (c.z < 14) return null;
    const k = 2 ** (c.z - 14), px = c.x >> (c.z - 14), py = c.y >> (c.z - 14);
    if (!idx[14].has(`${px}/${py}`)) return null;
    return localDem(14, px, py).then(src => {
      if (k === 1) return src;
      // enlarge the k x k sub-square of the parent with bilinear sampling
      const ox = (c.x - px * k) * 256 / k, oy = (c.y - py * k) * 256 / k, out = new Float64Array(258 * 258);
      for (let j = 0; j < 258; j++) {
        const v = Math.min(256.999, Math.max(0, oy + (j - 0.5) / k + 0.5));
        const j0 = Math.floor(v), fy = v - j0;
        for (let i = 0; i < 258; i++) {
          const u = Math.min(256.999, Math.max(0, ox + (i - 0.5) / k + 0.5));
          const i0 = Math.floor(u), fx = u - i0, a = j0 * 258 + i0;
          out[j * 258 + i] = (src[a] * (1 - fx) + src[a + 1] * fx) * (1 - fy) + (src[a + 258] * (1 - fx) + src[a + 259] * fx) * fy;
        }
      }
      return out;
    });
  });

  const ContourLayer = L.GridLayer.extend({
    createTile(c, done) {
      const tile = document.createElement("canvas");
      tile.width = tile.height = 256;
      const N = 258, world = 20037508.342789244, size = world * 2 / 2 ** c.z, px = size / 256;
      const x0 = -world + c.x * size - px, y1 = world - c.y * size + px;
      const url = DEM_URL + new URLSearchParams({
        bbox: [x0, y1 - size - 2 * px, x0 + size + 2 * px, y1].map(v => v.toFixed(2)).join(","),
        bboxSR: 3857, imageSR: 3857, size: `${N},${N}`, format: "bsq", pixelType: "F32",
        interpolation: "RSP_BilinearInterpolation", f: "image" });
      // the elevation service is sometimes slow or drops a request: retry twice before giving up on a tile
      const get = (n) => fetch(url).then(r => (r.ok ? r : Promise.reject(r.status)))
        .catch(e => (n > 0 ? new Promise(res => setTimeout(res, 800)).then(() => get(n - 1)) : Promise.reject(e)));
      // keep elevation grids in the browser's cache so a revisit (or zooming back) is instant
      const cached = () => (window.caches
        ? caches.open(DEM_CACHE).then(cache => cache.match(url).then(hit => hit ||
            get(2).then(r => { cache.put(url, r.clone()).catch(() => {}); return r; })))
        : get(2));
      const remote = () => cached().then(r => r.arrayBuffer()).then(buf => {
        const m = new Float32Array(buf, 0, N * N), ft = new Float64Array(N * N);
        for (let i = 0; i < m.length; i++) ft[i] = m[i] > -1000 ? m[i] * 3.28084 : NaN;  // nodata is a large negative number
        return ft;
      });
      corridorGrid(c).then(g => g || remote()).then(ft => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < ft.length; i++) { const v = ft[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!(hi > lo)) return done(null, tile);
        const step = CONTOUR_FT(c.z), index = step * 5;  // tiles exist from zoom 13 (100 ft) to 16 (20 ft)
        const levels = d3.range(Math.ceil(lo / step) * step, hi, step);
        const ctx = tile.getContext("2d");
        ctx.translate(-1, -1);  // drop the overlap pixel
        const path = d3.geoPath(null, ctx);
        const geoms = d3.contours().size([N, N]).thresholds(levels)(ft);
        geoms.forEach(g => {
          const isIndex = g.value % index === 0;
          ctx.beginPath();
          path(g);
          ctx.strokeStyle = isIndex ? "rgba(92, 52, 20, 0.85)" : "rgba(120, 72, 32, 0.55)";
          ctx.lineWidth = isIndex ? 1.3 : 0.7;
          ctx.stroke();
        });
        // elevation labels on the bold lines: one per long-enough piece, upright, away from the tile
        // edges (so they aren't cut off) and not overlapping each other
        ctx.font = "600 10.5px 'Source Sans 3', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const boxes = [];
        geoms.filter(g => g.value % index === 0).forEach(g => g.coordinates.forEach(poly => poly.forEach(ring => {
          if (ring.length < 8) return;
          const cum = [0];
          for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
          const len = cum[cum.length - 1];
          if (len < 90) return;
          const text = fmt(g.value);
          const w = ctx.measureText(text).width + 6;
          for (const f of [0.5, 0.25, 0.75]) {
            const i = Math.max(1, Math.min(ring.length - 2, d3.bisectLeft(cum, len * f)));
            const x = ring[i][0] - 1, y = ring[i][1] - 1;
            if (x < w / 2 + 4 || x > 252 - w / 2 || y < 12 || y > 244) continue;
            if (boxes.some(b => Math.abs(b[0] - x) < (b[2] + w) / 2 + 8 && Math.abs(b[1] - y) < 18)) continue;
            let ang = Math.atan2(ring[i + 1][1] - ring[i - 1][1], ring[i + 1][0] - ring[i - 1][0]);
            if (ang > Math.PI / 2) ang -= Math.PI;
            if (ang < -Math.PI / 2) ang += Math.PI;
            boxes.push([x, y, w]);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.translate(x, y);
            ctx.rotate(ang);
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = "rgba(247, 244, 236, 0.95)";
            ctx.strokeText(text, 0, 0);
            ctx.fillStyle = "#6b3f1d";
            ctx.fillText(text, 0, 0);
            ctx.restore();
            break;
          }
        })));
        done(null, tile);
      }).catch(() => done(null, tile));
      return tile;
    },
  });

  // ski area marker: skier silhouette (img/skier.png), with a white halo from CSS so it reads on terrain and photos
  const SKIER = `<img class="ski-icon" src="img/skier.png" width="24" height="25" alt="">`;

  // Map text labels. Leaflet positions a marker with an inline transform on the icon element, which
  // would override any CSS offset there, so the offset (.map-label.*) goes on an inner element.
  const labelIcon = (cls, html, style = "") => L.divIcon({ className: "map-anchor", iconSize: [0, 0],
    html: `<div class="map-label ${cls}"${style ? ` style="${style}"` : ""}>${html}</div>` });

  // "Topo contours": pre-traced lines (with elevation labels on the 1000 ft lines) up to zoom 12,
  // per-tile contours from zoom 13. Returns one layer for the layer switcher.
  function topoLayer(map, intervalAt) {
    map.createPane("contours").style.zIndex = 405;
    map.getPane("contours").style.pointerEvents = "none";
    const group = L.layerGroup([], { attribution: "Contours: USGS 3DEP" });
    const renderer = L.canvas({ pane: "contours" });
    const tiles = new ContourLayer({ pane: "contours", minZoom: 12.75, maxNativeZoom: 16, maxZoom: 19 });  // enlarged past 16 (Esri goes to 19)
    const sets = {};      // interval -> L.layerGroup of polylines (loaded on first use)
    const loading = {};
    const labelLayer = L.layerGroup();
    let labels = [];
    const load = k => loading[k] || (loading[k] = fetch(`data/${SLUG}/contours_${k}.json`).then(r => r.json()).then(d => {
      const lg = L.layerGroup();
      d.lines.forEach(([v, pts]) => { const pl = L.polyline(pts.map(([x, y]) => [y, x]), { renderer, interactive: false }); pl.elev = v; pl.addTo(lg); });
      sets[k] = lg;
      if (d.labels) labels = d.labels;
    }));
    const needed = k => (k >= 1000 ? [1000] : k >= 500 ? [1000, 500] : k >= 250 ? [1000, 500, 250] : []);
    const placeLabels = () => {
      labelLayer.clearLayers();
      const z = map.getZoom();
      if (intervalAt(z) < 250 || !labels.length) return;
      const view = map.getBounds().pad(0.05), placed = [], gap = 70;
      const pxPerMile = 1609.34 / (156543.03 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** z);
      labels.forEach(([v, lon, lat, dlon, dlat, miles]) => {
        if (!view.contains([lat, lon]) || miles * pxPerMile < 150) return;  // skip lines too short on screen to carry labels
        const p = map.latLngToLayerPoint([lat, lon]);
        if (placed.some(q => Math.abs(q.x - p.x) < gap && Math.abs(q.y - p.y) < gap / 2)) return;
        placed.push(p);
        let ang = Math.atan2(-dlat, dlon * Math.cos(lat * Math.PI / 180)) * 180 / Math.PI;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        L.marker([lat, lon], { pane: "labels", interactive: false,
          icon: labelIcon("contour", `<span style="transform:translate(-50%,-50%) rotate(${ang.toFixed(1)}deg)">${fmt(v)}</span>`) }).addTo(labelLayer);
      });
    };
    const update = () => {
      if (!map.hasLayer(group)) return;
      const k = intervalAt(map.getZoom());
      const want = needed(k);
      Object.entries(sets).forEach(([kk, lg]) => { if (!want.includes(+kk) && group.hasLayer(lg)) group.removeLayer(lg); });
      if (k < 250) { if (!group.hasLayer(tiles)) group.addLayer(tiles); }
      else if (group.hasLayer(tiles)) group.removeLayer(tiles);
      if (!group.hasLayer(labelLayer)) group.addLayer(labelLayer);
      Promise.all(want.map(load)).then(() => {
        if (!map.hasLayer(group) || intervalAt(map.getZoom()) !== k) return;
        // bold: every 5,000 ft at the 1,000 ft interval, every 1,000 ft at finer intervals
        const boldEvery = k >= 1000 ? 5000 : 1000;
        want.forEach(kk => {
          sets[kk].eachLayer(pl => { const b = pl.elev % boldEvery === 0;
            pl.setStyle({ color: b ? "rgba(92, 52, 20, 0.85)" : "rgba(120, 72, 32, 0.55)", weight: b ? 1.3 : 0.7 }); });
          if (!group.hasLayer(sets[kk])) group.addLayer(sets[kk]);
        });
        placeLabels();
      });
      placeLabels();
    };
    group.on("add", update);
    map.on("zoomend", update);
    map.on("moveend", () => { if (map.hasLayer(group)) placeLabels(); });
    return group;
  }

  function drawMap(river, data, flows, outlook, base) {
    // scroll-wheel zoom on computers (mouse or trackpad); off on touch devices, where a swipe should scroll the page
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
    const map = L.map("basin-map", { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, minZoom: 7.5, maxZoom: 16,
      scrollWheelZoom: finePointer });
    [["terrain", 200], ["basins", 410], ["lakes", 420], ["rivers", 430], ["labels", 450], ["gauges", 600], ["points", 620]]
      .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
    map.getPane("labels").style.pointerEvents = "none";
    const ll = r => r.map(([lon, lat]) => [lat, lon]);
    const RIVER = "#2f7bbf", RIVER_HI = "#0f4f8a", ROAD = "#8c3b2b";
    let fit, terrainLayer = null, riverLayer = null, lakeLayer = null, roadLayer = null;
    const avoidSpots = [];
    if (base) {
      terrainLayer = L.imageOverlay(`data/${SLUG}/terrain.jpg`, base.bounds, { pane: "terrain", interactive: false,
        attribution: "Terrain: USGS 3DEP · Rivers and lakes: NHDPlus · Roads: USGS National Map · Rapids: American Whitewater" }).addTo(map);
      map.setMaxBounds(L.latLngBounds(base.bounds).pad(0.6));
      L.polyline(ll(base.outer_basin), { pane: "basins", color: "#1d211f", weight: 1.8, interactive: false }).addTo(map);
      L.polyline(ll(base.inner_basin), { pane: "basins", color: "#3a3f3c", weight: 1.2, dashArray: "5 3" })
        .bindTooltip(base.inner_label, { sticky: true }).addTo(map);
      lakeLayer = L.layerGroup().addTo(map);  // hidden over photos, which show the real shoreline
      base.lakes.forEach(l => {
        const pg = L.polygon(ll(l.ring), { pane: "lakes", color: "#0b5d73", weight: 0.8, fillColor: "#7fc8d8", fillOpacity: 0.9 });
        if (l.name) pg.bindTooltip(esc(l.name), { sticky: true });
        pg.addTo(lakeLayer);
      });
      const renderer = L.canvas({ pane: "rivers", tolerance: 6 });
      // highways (same canvas as rivers, drawn first so rivers sit on top and both keep hover): white casing under a dark red-brown line, with a route shield on each long stretch
      roadLayer = L.layerGroup().addTo(map);  // highways, shields and dirt access roads; toggled from the layer switcher
      (base.roads || []).forEach(rd => {
        const us = rd.kind === "us", label = `${us ? "US" : "State Route"} ${rd.ref}`;
        const lines = rd.lines.map(ll);
        L.polyline(lines, { renderer, color: "#fff", weight: us ? 4.5 : 3.5, opacity: 0.85, interactive: false }).addTo(roadLayer);
        L.polyline(lines, { renderer, color: ROAD, weight: us ? 2.2 : 1.4, opacity: 0.95 })
          .bindTooltip(label, { sticky: true }).addTo(roadLayer);
        // shields: the middle of each connected stretch longer than ~25 km
        roadRuns(rd.lines).filter(r => r.km > 25).forEach(r =>
          L.marker([r.mid[1], r.mid[0]], { pane: "labels", interactive: false,
            icon: L.divIcon({ className: "", html: `<span class="shield ${us ? "us" : "state"}">${esc(rd.ref)}</span>`, iconSize: null }) }).addTo(roadLayer));
      });
      // each river is split into stretches (between named-tributary junctions) that share one rounded
      // long-term mean; hovering anywhere on a stretch highlights the whole stretch and shows its value
      const stretches = new Map();
      riverLayer = L.layerGroup().addTo(map);  // toggled from the layer switcher
      base.rivers.forEach(rv => rv.lines.forEach((line, i) => {
        const q = rv.qs ? rv.qs[i] : rv.q;
        const key = rv.rid ? rv.rid[i] : `${rv.name}|${q}`;
        const pl = L.polyline(ll(line), { renderer, color: RIVER, weight: rv.w, opacity: 0.95, lineCap: "round", lineJoin: "round" });
        if (!stretches.has(key)) stretches.set(key, []);
        stretches.get(key).push(pl);
        pl.bindTooltip(`<strong>${esc(rv.name || "Unnamed stream")}</strong><br>about ${fmt(q)} cfs on average`, { sticky: true });
        pl.on("mouseover", () => stretches.get(key).forEach(x => x.setStyle({ color: RIVER_HI })))
          .on("mouseout", () => stretches.get(key).forEach(x => x.setStyle({ color: RIVER })));
        pl.addTo(riverLayer);
      }));
      // named rapids by importance, thinned by river-mile spacing that shrinks as you zoom in (see rapidGap). Names try right, left, above, below and take the first free spot;
      // a name with no free spot is left off (hovering its marker still shows it).
      const rapidLayer = L.layerGroup().addTo(map), rapidNames = L.layerGroup().addTo(map);
      // gauges and put-in/take-out pins that rapid names must not cover: {lat, lon, dx, dy, r}
      avoidSpots.length = 0;
      // markers show the class as a Roman numeral; name, mile and any note are on click/tap
      const CLASS_RANK = c => ["I", "II", "III", "IV", "V", "V+", "VI"].indexOf(String(c).replace(/[-]$/, ""));
      const rapids = (base.rapids || []).map(r => {
        const hw = Math.round((10 + 6.5 * r.cls.length) / 2);  // half-width of the numeral badge
        return { ...r, hw, short: r.name.replace(/ Rapid$/, ""),
          marker: L.marker([r.lat, r.lon], { pane: "gauges", title: `${r.name} (Class ${r.cls})`,
            icon: L.divIcon({ className: "", html: `<div class="rapid-mark${r.kind === "hazard" ? " hazard" : ""}">${esc(r.cls)}</div>`,
              iconSize: [hw * 2, 16] }) })
            .bindPopup(`<strong>${esc(r.name)}</strong><br>${r.kind === "hazard" ? "Hazard · " : ""}Class ${esc(r.cls)}` +
              (r.mile != null ? ` · mile ${r.mile.toFixed(1)}` : "") + (r.note ? `<br>${esc(r.note)}` : ""), { maxWidth: 240 }) };
      })
        // most important first: hazards, key rapids, then by class, then an optional rank (1 = the famous one), then upstream first
        .sort((a, b) => (b.kind === "hazard") - (a.kind === "hazard") || !!b.key - !!a.key ||
          CLASS_RANK(b.cls) - CLASS_RANK(a.cls) || (a.rank ?? 9) - (b.rank ?? 9) || (a.mile ?? 0) - (b.mile ?? 0));
      // Up to the default zoom (10) only hazards and the key rapids (base.rapids[].key) show. From zoom 11
      // the rest fill in, spaced at least `gap` river miles apart (2 mi, halving per zoom level), and all
      // of them show from zoom 13.5. Each pick is the most important rapid not within `gap` of one shown.
      const rapidGap = z => z >= 13.5 ? 0 : z < 11 ? Infinity : 2 * 2 ** (11 - z);
      const showRapids = () => {
        const z = map.getZoom(), gap = rapidGap(z);
        rapidLayer.clearLayers();
        rapidNames.clearLayers();
        const vis = [];
        rapids.forEach(r => {
          if (r.kind === "hazard" || r.key || r.mile == null || !vis.some(v => v.mile != null && Math.abs(v.mile - r.mile) < gap)) vis.push(r);
        });
        vis.forEach(r => r.marker.addTo(rapidLayer));
        const boxes = vis.map(r => { const p = map.latLngToLayerPoint([r.lat, r.lon]); return [p.x - r.hw, p.y - 8, p.x + r.hw, p.y + 8]; })
          .concat(avoidSpots.map(a => { const p = map.latLngToLayerPoint([a.lat, a.lon]); const x = p.x + a.dx, y = p.y + a.dy;
            return [x - a.r, y - a.r, x + a.r, y + a.r]; }));
        const hit = b => boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
        vis.forEach(r => {
          const p = map.latLngToLayerPoint([r.lat, r.lon]);
          const w = r.short.length * 6.6 + 4, h = 15;
          const g = r.hw + 3;
          const spots = { r: [p.x + g, p.y - h / 2], l: [p.x - g - w, p.y - h / 2], t: [p.x - w / 2, p.y - 11 - h], b: [p.x - w / 2, p.y + 11] };
          const side = Object.keys(spots).find(k => !hit([spots[k][0], spots[k][1], spots[k][0] + w, spots[k][1] + h]));
          if (!side) return;
          const [x, y] = spots[side];
          boxes.push([x, y, x + w, y + h]);
          // offset by this badge's width, matching the spot tested above
          const tf = { r: `translate(${g}px, -50%)`, l: `translate(calc(-100% - ${g}px), -50%)`,
            t: "translate(-50%, calc(-100% - 11px))", b: "translate(-50%, 11px)" }[side];
          L.marker([r.lat, r.lon], { pane: "labels", interactive: false, icon: labelIcon("rapid", esc(r.short), `transform:${tf}`) }).addTo(rapidNames);
        });
      };
      map.on("zoomend", showRapids);
      map.whenReady(() => setTimeout(showRapids, 0));
      // dirt access roads to the river: dashed, with name and condition on hover
      (base.access_roads || []).forEach(rd => {
        const lines = rd.lines.map(ll);
        L.polyline(lines, { renderer, color: "#fff", weight: 4, opacity: 0.8, interactive: false }).addTo(roadLayer);
        const maint = rd.maint ? rd.maint.replace(/^\d - /, "").toLowerCase() : "";
        L.polyline(lines, { renderer, color: ROAD, weight: 2, dashArray: "5 4", opacity: 0.95 })
          .bindTooltip(`<strong>${esc(rd.name)}</strong>${rd.aka ? `<br>Also called ${esc(rd.aka)}` : ""}` +
            `${maint ? `<br>Dirt road: ${esc(maint)}` : ""}${rd.note ? `<br>${esc(rd.note)}` : ""}`, { sticky: true }).addTo(roadLayer);
      });
      base.river_labels.forEach(lb => L.marker([lb.lat, lb.lon], { pane: "labels", interactive: false,
        icon: labelIcon(`river${lb.side ? ` side-${lb.side}` : ""}`, esc(lb.text)) }).addTo(riverLayer || map));
      base.places.forEach(p => L.marker([p.lat, p.lon], { pane: "labels", interactive: false,
        icon: labelIcon(p.kind, ({ peak: "&#9650; ", ski: SKIER }[p.kind] || "&#9679; ") + `<span>${esc(p.text)}</span>`) }).addTo(map));
      fit = L.latLngBounds(ll(base.outer_basin));
    } else {
      L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 16, attribution: "Basemap: USGS The National Map" }).addTo(map);
      data.rivers.forEach(r => r.lines.forEach(line => L.polyline(ll(line), { color: RIVER, weight: r.main ? 3.5 : 2 }).addTo(map)));
      fit = data.basin ? L.latLngBounds(ll(data.basin[0])) : null;
    }

    const latest = outlook?.observed?.length ? outlook.observed[outlook.observed.length - 1][1] : flows?.latest?.cfs;
    const roleText = { primary: "Put-in gauge (forecast point)", downstream: "Downstream gauge, at the take-out", upstream: "Upstream gauge", nearby: "Nearby tributary gauge" };
    const week = outlook?.gauges_7d || {};
    const tipOpts = { direction: "top", offset: [0, -8], className: "spark-tip", opacity: 1 };
    data.gauges.forEach(g => {
      const primary = g.role === "primary";
      const pts = (week[g.id] || (primary && outlook?.observed) || []).map(([t, v]) => ({ t: new Date(t), v }))
        .filter(p => p.t >= Date.now() - 7.2 * 864e5);
      const now = pts.length ? pts[pts.length - 1] : null;
      const head = `<strong>${esc(g.name)}</strong><br><span class="muted">USGS ${g.id} · ${roleText[g.role] || ""}</span>`;
      const body = pts.length > 2
        ? `<div class="spark-now">${fmtCfs(now.v)} <span class="muted">${now.t.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}</span></div>` +
          spark(pts, { color: RIVER, unit: "cfs", log: d3.max(pts, p => p.v) / Math.max(1, d3.min(pts, p => p.v)) > 20 })
        : `<div class="muted">No readings in the last 7 days</div>`;
      avoidSpots.push({ lat: g.lat, lon: g.lon, dx: 0, dy: 0, r: 9 });
      L.marker([g.lat, g.lon], { pane: "gauges", title: g.name, riseOnHover: true,
        icon: L.divIcon({ className: "", html: `<div class="gauge-icon${primary ? " primary" : ""}"></div>`, iconSize: primary ? [16, 16] : [12, 12] }) })
        .bindTooltip(head + body, tipOpts)
        .bindPopup(head + body + (g.area_mi2 ? `<div class="muted">Drainage area ${fmt(g.area_mi2)} mi²</div>` : "") +
          `<a href="https://waterdata.usgs.gov/monitoring-location/USGS-${g.id}/" target="_blank" rel="noopener">USGS gauge page</a>`)
        .on("popupopen", e => e.target.closeTooltip()).addTo(map);
    });
    const snowIcon = L.divIcon({ className: "", html: '<div class="snow-mark"></div>', iconSize: [14, 12], iconAnchor: [7, 6] });
    (outlook?.snotel || []).forEach(s => {
      if (s.lat == null) return;
      const pts = s.current.filter(([, v]) => v != null).slice(-8).map(([d, v]) => ({ t: new Date(`${d}T12:00`), v }));
      const now = pts.length ? pts[pts.length - 1] : null;
      const head = `<strong>${esc(s.name)} SNOTEL</strong><br><span class="muted">${fmt(s.elev_ft)} ft · snow water equivalent</span>`;
      const body = pts.length > 2
        ? `<div class="spark-now">${now.v} in <span class="muted">${now.t.toLocaleDateString([], { month: "short", day: "numeric" })}</span></div>` +
          spark(pts, { color: "#3b6f8f", unit: "in", zero: true })
        : `<div class="muted">No readings in the last 7 days</div>`;
      L.marker([s.lat, s.lon], { pane: "gauges", icon: snowIcon, title: `${s.name} SNOTEL`, riseOnHover: true })
        .bindTooltip(head + body, tipOpts).bindPopup(head + body)
        .on("popupopen", e => e.target.closeTooltip()).addTo(map);
    });
    // put-in / take-out pins sit on top of gauges, so draw them off to one side on a leader line
    (data.points || []).forEach(p => {
      // offset on a leader line only when the pin would sit on a gauge or a rapid (within ~300-400 m)
      const near = data.gauges.some(g => Math.hypot(g.lat - p.lat, g.lon - p.lon) < 0.004) ||
        (base?.rapids || []).some(r => Math.hypot(r.lat - p.lat, r.lon - p.lon) < 0.003);
      // leader direction: the preferred one unless its pin head would land on another rapid, gauge or pin
      // at the default zoom (10, ~730 px per degree of longitude, ~870 per degree of latitude here)
      const others = [...(base?.rapids || []), ...data.gauges, ...(data.points || []).filter(o => o !== p)]
        .map(o => [(o.lon - p.lon) * 730, (p.lat - o.lat) * 870]);
      const clearance = ([x, y]) => Math.min(Infinity, ...others.map(([ox, oy]) => Math.hypot(ox - x, oy - (y - 11))));
      const dirs = p.kind === "take-out" ? [[-30, 30], [30, 30], [-30, -34], [30, -34]] : [[30, -34], [-30, -34], [30, 30], [-30, 30]];
      const [dx, dy] = !near ? [0, 0] : (dirs.find(d => clearance(d) > 24) || dirs.reduce((a, b) => clearance(b) > clearance(a) ? b : a));
      const html = `<svg class="leader" width="1" height="1"><line x1="0" y1="0" x2="${dx}" y2="${dy}"/><circle cx="0" cy="0" r="2.5"/></svg>` +
        `<div class="pin ${p.kind}" style="position:absolute;left:${dx - 11}px;top:${dy - 22}px"></div>`;
      const txt = `<strong>${esc(p.name)}</strong>${p.kind === "access" && p.note ? `<br>${esc(p.note.replace(/\s*Located by user.*$/, ""))}` : ""}` +
        `${p.approx ? "<br>Location approximate" : ""}`;
      avoidSpots.push({ lat: p.lat, lon: p.lon, dx: dx, dy: dy - 11, r: 14 });  // the pin head
      avoidSpots.push({ lat: p.lat, lon: p.lon, dx: dx / 2, dy: dy / 2, r: 6 });  // the leader line
      L.marker([p.lat, p.lon], { pane: "points", title: p.name,
        icon: L.divIcon({ className: "pin-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] }) })
        .bindTooltip(txt, { direction: "top", offset: [dx, dy - 24] })
        .bindPopup(txt, { offset: [dx, dy - 20] })
        .addTo(map);
    });

    // legend: a key card under the map (outside it, so it never covers the river)
    {
      const d = $("map-legend");
      // four columns side by side: a wide, short legend along the bottom of the map
      const col = (title, body) => `<div class="lg-col"><div class="lg-title">${title}</div>${body}</div>`;
      let html = "";
      if (base) {
        const mean = base.flow_scale.obs_mean_cfs;
        const w = q => 0.6 + 5.4 * Math.sqrt(q / mean);
        html += col("Mean flow", base.flow_scale.examples.map(q =>
          `<div class="row"><span style="width:26px;height:0;border-top:${w(q).toFixed(1)}px solid ${RIVER}"></span>${fmt(q)} cfs</div>`).join(""));
        const ft = m => fmt(Math.round(m * 3.281 / 100) * 100);
        html += col("Elevation", `<div class="ramp" style="background:linear-gradient(90deg,${base.elevation.colors.join(",")})"></div>
          <div class="ramp-labels"><span>${ft(base.elevation.vmin)} ft</span><span>${ft(base.elevation.vmax)} ft</span></div>`);
      }
      html += col("Gauges", `
        <div class="row"><span class="gauge-icon primary"></span>Put-in gauge</div>
        <div class="row"><span class="gauge-icon"></span>Other USGS gauges</div>
        <div class="row"><span class="snow-mark"></span>SNOTEL snow station</div>`);
      html += col("Places", `
        <div class="row"><span class="dot put-in"></span>Put-in <span class="dot take-out" style="margin-left:6px"></span>Take-out</div>
        <div class="row"><span class="dot access"></span>Other access</div>
        <div class="row"><span class="lg-sym">&#9679;</span>Town <span class="lg-sym" style="margin-left:6px">&#9650;</span>Peak</div>
        <div class="row">${SKIER}Ski area</div>
        <div class="row"><span class="rapid-mark">III</span>Rapid, by class</div>
        <div class="row"><span class="rapid-mark hazard">V</span>Hazard</div>`);
      html += col("Lines", `
        <div class="row"><span class="shield us">60</span><span class="shield state">288</span>US / state highway</div>
        <div class="row"><span style="width:22px;border-top:2px dashed #8c3b2b"></span>Dirt access road</div>
        <div class="row"><span style="width:22px;border-top:1.2px dashed #3a3f3c"></span>Drains to put-in gauge</div>
        <div class="row"><span style="width:22px;border-top:1.8px solid #1d211f"></span>Salt basin above Roosevelt</div>`);
      html = `<div class="lg-cols">${html}</div>`;
      // collapsed by default on phones so it doesn't cover the river
      d.innerHTML = `<details open><summary>Legend</summary>${html}</details>`;
    }

    // ---- layer switcher: shaded terrain (ours), USGS aerial imagery, optional USGS contours ----
    // photo options: canyon shadows fall differently in each, so offer more than one
    const photos = {
      "Aerial: USGS (NAIP)": L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", {
        pane: "terrain", maxNativeZoom: 16, maxZoom: 19, topZoom: 16, attribution: "Imagery: USGS The National Map" }),
      "Aerial: Esri World Imagery": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        pane: "terrain", maxNativeZoom: 19, maxZoom: 19, topZoom: 19, attribution: "Imagery: Esri, Maxar, Earthstar Geographics" }),
    };
    const photoLayers = Object.values(photos);
    // USGS Topo: the national topographic basemap (contours, names, land cover), public domain
    const usgsTopo = L.tileLayer("https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", {
      pane: "terrain", maxNativeZoom: 16, maxZoom: 19, topZoom: 16, attribution: "Topo: USGS The National Map" });
    const contours = topoLayer(map, CONTOUR_FT);
    const bases = terrainLayer ? { "Shaded terrain": terrainLayer, "USGS Topo": usgsTopo, ...photos } : { "USGS Topo": usgsTopo, ...photos };
    const ctl = L.control.layers(bases, { ...(riverLayer ? { "Rivers and streams": riverLayer } : {}), ...(roadLayer ? { "Roads": roadLayer } : {}), "Topo contours": contours }, { position: "topright", collapsed: true }).addTo(map);
    // the contour interval tightens as you zoom in; say which one is showing
    const ctNote = L.DomUtil.create("div", "ct-note");
    ctl.getContainer().appendChild(ctNote);
    const updateCt = () => {
      if (!map.hasLayer(contours)) { ctNote.textContent = ""; return; }
      const ft = CONTOUR_FT(map.getZoom());
      ctNote.textContent = `Contour interval: ${fmt(ft)} ft (bold every ${fmt(ft >= 1000 ? 5000 : ft >= 250 ? 1000 : ft * 5)} ft)`;
    };
    map.on("zoomend overlayadd overlayremove", updateCt);

    // When a photo layer is on: the date of the photo under the map centre, and the nearest gauge's
    // daily flow that day (USGS daily values), so you can tell how much water you're looking at.
    const photoNote = L.DomUtil.create("div", "ct-note photo-note");
    ctl.getContainer().appendChild(photoNote);
    const memo = new Map();
    const once = (key, fn) => { if (!memo.has(key)) memo.set(key, fn().catch(() => null)); return memo.get(key); };
    const ymd = d => d.toISOString().slice(0, 10);
    const photoDate = (layer, c, z) => {
      const pt = `${c.lng.toFixed(4)},${c.lat.toFixed(4)}`;
      if (layer === photos["Aerial: USGS (NAIP)"]) {
        return once(`naip|${pt}`, () => fetch("https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/query?" +
          new URLSearchParams({ where: "Category=1", geometry: pt, geometryType: "esriGeometryPoint", inSR: 4326,
            spatialRel: "esriSpatialRelIntersects", outFields: "acquisition_date", returnGeometry: false, f: "json" }))
          .then(r => r.json()).then(d => {
            const t = d3.max(d.features || [], f => f.attributes.acquisition_date);
            return t ? new Date(t) : null;
          }));
      }
      if (layer === photos["Aerial: Esri World Imagery"]) {
        const lvl = Math.min(19, Math.round(z));
        return once(`esri|${pt}|${lvl}`, () => fetch("https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/identify?" +
          new URLSearchParams({ geometry: pt, geometryType: "esriGeometryPoint", sr: 4326, layers: "all", tolerance: 2,
            mapExtent: `${c.lng - 0.01},${c.lat - 0.01},${c.lng + 0.01},${c.lat + 0.01}`, imageDisplay: "800,600,96",
            returnGeometry: false, f: "json" }))
          .then(r => r.json()).then(d => {
            const hit = (d.results || []).map(x => x.attributes)
              .find(a => +a.MinMapLevel <= lvl && lvl <= +a.MaxMapLevel && a["DATE (YYYYMMDD)"]);
            const v = hit && String(hit["DATE (YYYYMMDD)"]);
            return v ? new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T12:00:00Z`) : null;
          }));
      }
      return Promise.resolve(null);
    };
    const dailyFlow = (site, day) => once(`dv|${site}|${day}`, () => fetch("https://waterservices.usgs.gov/nwis/dv/?" +
      new URLSearchParams({ format: "json", sites: site, startDT: day, endDT: day, parameterCd: "00060" }))
      .then(r => r.json()).then(d => {
        const v = d.value?.timeSeries?.[0]?.values?.[0]?.value?.[0]?.value;
        return v != null && +v >= 0 ? +v : null;
      }));
    let photoSeq = 0;
    const updatePhoto = () => {
      const layer = photoLayers.find(l => map.hasLayer(l));
      if (!layer) { photoNote.textContent = ""; return; }
      const seq = ++photoSeq, c = map.getCenter();
      photoNote.textContent = "Photo date: looking up…";
      photoDate(layer, c, map.getZoom()).then(date => {
        if (seq !== photoSeq) return;
        if (!date) { photoNote.textContent = "Photo date not available here."; return; }
        // the gauge on the river nearest the map centre (so the Salt shows a Salt gauge, not a creek's)
        const kx = Math.cos(c.lat * Math.PI / 180), dist = (lat, lon) => Math.hypot(lat - c.lat, (lon - c.lng) * kx);
        let near = null, best = Infinity;
        (base?.rivers || []).forEach(rv => { if (rv.name && rv.w > 1.5) rv.lines.forEach(l => l.forEach(([x, y]) => {
          const d = dist(y, x); if (d < best) { best = d; near = rv.name; } })); });
        const onRiver = near ? data.gauges.filter(g => g.name.startsWith(near)) : [];
        const g = d3.least(onRiver.length ? onRiver : data.gauges, g => dist(g.lat, g.lon));
        const when = date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
        photoNote.innerHTML = `Photo taken ${when}`;
        if (!g) return;
        dailyFlow(g.id, ymd(date)).then(q => {
          if (seq !== photoSeq) return;
          photoNote.innerHTML = `Photo taken ${when}<br>${esc(g.name)}: ` +
            (q == null ? "no flow record that day" : `<strong>${fmtCfs(q)}</strong> that day`);
        });
      });
    };
    map.on("baselayerchange moveend", debounce(updatePhoto, 400));
    // keep our light map styling readable over photos
    // the deepest zoom depends on the base layer's real detail: shaded terrain and USGS 16 (the
    // 20 ft contours end there), USGS Topo 16, Esri 19
    map.on("baselayerchange", e => {
      // (tile layers keep maxZoom 19 so the menu never greys them out; topZoom is the real limit)
      const top = e.layer.options.topZoom || 16;
      map.setMaxZoom(top);
      if (map.getZoom() > top) map.setZoom(top, { animate: false });
      const photo = photoLayers.includes(e.layer);
      $("basin-map").classList.toggle("on-imagery", photo);
      // photos and USGS Topo show the real lakes, so our lake overlay steps aside
      const ownLakes = photo || e.layer === usgsTopo;
      if (lakeLayer) { if (ownLakes) map.removeLayer(lakeLayer); else lakeLayer.addTo(map); }
    });
    // open on the run itself: put-in to take-out, with room around it; the whole basin is a zoom-out away
    const run = (data.points || []).map(p => [p.lat, p.lon]);
    // keep the ends of the run clear of the layer switcher (top right) and the legend (bottom right)
    const wide = innerWidth >= 720;
    if (run.length >= 2) map.fitBounds(L.latLngBounds(run).pad(0.12),
      { paddingTopLeft: [30, wide ? 40 : 20], paddingBottomRight: [wide ? 170 : 40, 20] });
    // then step two zoom levels out around the same centre, so the run sits in its wider setting
    // then two zoom clicks out (2 x zoomDelta), keeping the centre of that framing
    if (run.length >= 2) map.setView(map.getCenter(), Math.max(map.getMinZoom(), map.getZoom() - 2 * map.options.zoomDelta), { animate: false });
    else if (fit) map.fitBounds(fit, { padding: [12, 12] });
    else map.setView([33.8, -110.3], 9);
  }

  // ---------- 4. outlook (drawn per sub-tab; see selectSub) ----------

  function timeChart(el, { series, bands = [], yLog = false, H = 280, nowT = null, yLabel = "cfs", aria, fmtValue }) {
    // hover values in the chart's units: cfs (default), °F or %
    const unit = yLabel === "cfs" ? " cfs" : yLabel === "%" ? "%" : yLabel;
    const fmtV = fmtValue || (v => (v == null || isNaN(v) ? "–" : `${fmt(Math.round(v))}${unit}`));
    const W = Math.max(320, el.clientWidth);
    const m = { t: 24, r: 16, b: 26, l: 56 };
    const all = series.flatMap(s => s.data).concat(bands.flatMap(b => b.data.flatMap(d => [{ t: d.t, v: d.lo }, { t: d.t, v: d.hi }])));
    const x = d3.scaleTime(d3.extent(all, d => d.t), [m.l, W - m.r]);
    const vmax = d3.max(all, d => d.v) * 1.12;
    const y = yLog
      ? d3.scaleLog([Math.max(50, d3.min(all, d => d.v) * 0.8), vmax], [H - m.b, m.t]).clamp(true)
      : d3.scaleLinear([0, vmax], [H - m.b, m.t]).nice();
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", aria || "");
    const yt = yLog ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].filter(t => t >= y.domain()[0] && t <= y.domain()[1]) : y.ticks(5);
    svg.append("g").attr("class", "grid").selectAll("line").data(yt).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y).attr("y2", y);
    svg.append("g").selectAll("text").data(yt).join("text").attr("x", m.l - 8).attr("y", t => y(t) + 4).attr("text-anchor", "end")
      .text(t => d3.format(t >= 10000 ? "~s" : ",")(t).replace("k", "K"));
    svg.append("text").attr("x", m.l - 8).attr("y", 10).attr("text-anchor", "end").text(yLabel);
    const xt = x.ticks(W < 560 ? 4 : 8);
    svg.append("g").selectAll("text").data(xt).join("text").attr("x", x).attr("y", H - 6).attr("text-anchor", "middle")
      .text(d => d.toLocaleDateString([], { month: "short", day: "numeric" }));
    bands.forEach(b => svg.append("path").attr("fill", b.color).attr("opacity", b.opacity)
      .attr("d", d3.area().x(d => x(d.t)).y0(d => y(d.lo)).y1(d => y(d.hi)).curve(d3.curveMonotoneX)(b.data)));
    if (nowT) {
      svg.append("line").attr("x1", x(nowT)).attr("x2", x(nowT)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--ink-3"));
      svg.append("text").attr("class", "label-strong").attr("x", x(nowT) + 6).attr("y", m.t + 12).text("Now");
    }
    series.forEach(s => {
      if (s.dots) {  // scatter: measured points, drawn small and translucent under the lines
        svg.append("g").selectAll("circle").data(s.data.filter(d => d.v != null)).join("circle")
          .attr("cx", d => x(d.t)).attr("cy", d => y(d.v)).attr("r", 2.5).attr("fill", s.color).attr("opacity", 0.45);
        return;
      }
      svg.append("path").attr("fill", "none").attr("stroke", s.color).attr("stroke-width", 2).attr("stroke-linejoin", "round")
        .attr("stroke-dasharray", s.dash || null)
        .attr("d", d3.line().defined(d => d.v != null).x(d => x(d.t)).y(d => y(d.v)).curve(d3.curveMonotoneX)(s.data));
    });
    // hover: nearest time across series
    const cross = svg.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("stroke", css("--ink-3")).attr("opacity", 0);
    const bis = d3.bisector(d => d.t).center;
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .call(scrub, ev => {
        const t = x.invert(d3.pointer(ev)[0]);
        cross.attr("x1", x(t)).attr("x2", x(t)).attr("opacity", 0.8);
        let html = `<div class="t">${t.toLocaleString([], { month: "short", day: "numeric", hour: series[0].hourly ? "numeric" : undefined })}</div>`;
        series.forEach(s => {
          if (!s.data.length) return;
          const d = s.data[bis(s.data, t)];
          if (Math.abs(d.t - t) < (s.hourly ? 3 : 36) * 3600e3) html += row(s.label, fmtV(d.v));
        });
        bands.forEach(b => {
          if (!b.data.length) return;
          const d = b.data[bis(b.data, t)];
          if (Math.abs(d.t - t) < 36 * 3600e3) html += row(b.label, `${fmtValue ? fmtV(d.lo) : fmt(Math.round(d.lo))}–${fmtV(d.hi)}`);
        });
        showTip(html, ev);
      }, () => { cross.attr("opacity", 0); hideTip(); });
    el.replaceChildren(svg.node());
  }

  function week(o) {
    const obs = o.observed.map(([t, v]) => ({ t: new Date(t), v }));
    const fc = (o.nws.forecast || []).map(([t, v]) => ({ t: new Date(t), v }));
    const c1 = css("--wet"), ink = css("--ink-2");
    const draw = () => timeChart($("chart-week"), {
      series: [{ label: "Observed", data: obs, color: ink, hourly: true }, { label: "NWS forecast", data: fc, color: c1, hourly: true }],
      yLog: true, nowT: obs.length ? obs[obs.length - 1].t : null, aria: "Observed flow for the past two weeks and the NWS forecast",
    });
    draw();
    new ResizeObserver(debounce(draw, 120)).observe($("chart-week"));
    legend($("week-legend"), [{ label: "Observed (USGS)", color: ink, line: true }, { label: "NWS forecast", color: c1, line: true }]);
    const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const now = obs[obs.length - 1];
    const peak = fc.length ? fc.reduce((a, d) => (d.v > a.v ? d : a), fc[0]) : null;
    const last = fc[fc.length - 1];
    const dfmt = t => t.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    $("week-tiles").innerHTML =
      (now ? tile("Flow now", fmtCfs(now.v), now.t.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })) : "") +
      (peak ? tile("Forecast high, next 7 days", fmtCfs(peak.v), dfmt(peak.t)) : "") +
      (last ? tile("Forecast at end of week", fmtCfs(last.v), dfmt(last.t)) : "");
    $("week-note").innerHTML = o.nws.issued
      ? `Hourly readings, log scale. NWS ${o.nws.rfc || ""} forecast issued ${new Date(o.nws.issued).toLocaleString()}. <a href="${o.nws.url}" target="_blank" rel="noopener">Official forecast and flood information</a>.`
      : `NWS forecast unavailable. <a href="${o.nws.url}" target="_blank" rel="noopener">Check the NWS gauge page</a>.`;
  }

  function modelTrack(model) {
    const host = document.querySelector("#outlook-model .callout");
    host.outerHTML = `<div class="chart-card" id="model-card">
      <h4 style="margin:0 0 4px;font:600 1.1rem var(--display)">Our model (experimental): recent track record</h4>
      <p class="note" style="margin:0 0 10px">${model.model}. Not yet run daily, so it has no forecast for this week. Below: what it forecast for each day vs. what happened. ${model.skill_note}</p>
      <div class="controls" style="margin-bottom:8px"><label>Forecast made
        <select id="ctl-lead">${Object.keys(model.leads).map(h => `<option value="${h}"${h === "3" ? " selected" : ""}>${h} day${h === "1" ? "" : "s"} ahead</option>`).join("")}</select></label></div>
      <div class="tiles" id="model-tiles"></div>
      <div class="legend" id="model-legend"></div>
      <div class="chart" id="chart-model"></div>
      <p class="note">Last forecast day with an observation: ${model.last_valid_date}. Log scale.</p></div>`;
    const c1 = css("--wet"), ink = css("--ink-2");
    const draw = () => {
      const h = $("ctl-lead").value;
      const rows = model.leads[h].map(r => ({ t: new Date(`${r[0]}T12:00:00`), obs: r[1], med: r[2], p10: r[3], p90: r[4], p05: r[5], p95: r[6] }));
      timeChart($("chart-model"), {
        series: [{ label: "Observed", data: rows.map(r => ({ t: r.t, v: r.obs })), color: ink },
                 { label: "Model median", data: rows.map(r => ({ t: r.t, v: r.med })), color: c1 }],
        bands: [{ label: "90% range", data: rows.map(r => ({ t: r.t, lo: r.p05, hi: r.p95 })), color: c1, opacity: 0.1 },
                { label: "80% range", data: rows.map(r => ({ t: r.t, lo: r.p10, hi: r.p90 })), color: c1, opacity: 0.2 }],
        yLog: true, aria: `Model forecasts made ${h} days ahead compared with observed flow`,
      });
      const ok = rows.filter(r => r.obs != null);
      const in80 = ok.filter(r => r.obs >= r.p10 && r.obs <= r.p90).length;
      const err = d3.median(ok, r => Math.abs(r.med - r.obs) / r.obs);
      const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
      $("model-tiles").innerHTML = tile("Observed flow inside the 80% range", pct(in80 / ok.length), `${in80} of ${ok.length} days`) +
        tile("Typical miss of the median", pct(err), "median absolute error");
    };
    legend($("model-legend"), [{ label: "Observed", color: ink, line: true }, { label: "Model median", color: c1, line: true },
      { label: "80% range", color: c1, opacity: 0.3 }, { label: "90% range", color: c1, opacity: 0.15 }]);
    $("ctl-lead").addEventListener("change", draw);
    draw();
    new ResizeObserver(debounce(draw, 120)).observe($("chart-model"));
  }

  // ---------- next 3 weeks and next 3 months: CBRFC's HEFS ensemble, summarised by build_extended.py ----------
  function extended(ext, o, flows) {
    const lr = ext?.long_range, se = ext?.seasonal, src = ext?.source;
    $("lr-block").hidden = !lr;
    $("se-block").hidden = !se;
    if (!src) return;
    const c1 = css("--wet"), ink = css("--ink-2");
    const noon = d => new Date(`${d}T12:00:00`);
    const short = d => noon(d).toLocaleDateString([], { month: "short", day: "numeric" });
    // daily means in Arizona time (UTC-7, no daylight saving) so the lines match the daily bands
    const dailyMean = rows => d3.rollups(rows, v => d3.mean(v, r => r[1]), r => r[0]).sort((a, b) => d3.ascending(a[0], b[0]))
      .map(([d, v]) => ({ t: noon(d), v }));
    const azDay = t => new Date(new Date(t) - 7 * 3600e3).toISOString().slice(0, 10);
    const parse = (cols, r) => Object.fromEntries(cols.map((k, i) => [i ? k : "t", i ? r[i] : noon(r[0])]));
    const issued = new Date(src.issued).toLocaleDateString([], { month: "short", day: "numeric" });
    const credit = `Source: NWS Colorado Basin River Forecast Center, experimental HEFS ensemble issued ${issued} (${src.runs} model runs).`;
    $("cbrfc-link").href = src.url;

    if (lr) {
      const days = lr.days.map(r => parse(lr.columns, r));
      const t0 = days[0].t - 10 * 864e5;
      const obs = dailyMean((o?.observed || []).map(([t, v]) => [azDay(t), v])).filter(d => d.t >= t0);
      const fc = dailyMean((o?.nws?.forecast || []).map(([t, v]) => [azDay(t), v])).filter(d => d.t <= days[0].t);
      const last = days[days.length - 1];
      $("lr-lede").textContent = "After the 7-day forecast, the river forecast center runs its model many times with different possible weather. " +
        `By ${short(lr.days[lr.days.length - 1][0])}, half of those runs put the flow between ${fmt(last.p25)} and ${fmt(last.p75)} cfs, ` +
        `and 80% put it between ${fmt(last.p10)} and ${fmt(last.p90)} cfs.`;
      const draw = () => timeChart($("chart-lr"), {
        series: [{ label: "Observed", data: obs, color: ink }, { label: "NWS forecast", data: fc, color: c1 },
                 { label: "Median", data: days.map(d => ({ t: d.t, v: d.p50 })), color: c1, dash: "5 4" }],
        bands: [{ label: "80% range", data: days.map(d => ({ t: d.t, lo: d.p10, hi: d.p90 })), color: c1, opacity: 0.14 },
                { label: "50% range", data: days.map(d => ({ t: d.t, lo: d.p25, hi: d.p75 })), color: c1, opacity: 0.28 }],
        yLog: true, nowT: obs.length ? obs[obs.length - 1].t : null, H: 260,
        aria: "Flow over the next three weeks: observed, the NWS 7-day forecast, then the CBRFC ensemble's 50% and 80% ranges",
      });
      legend($("lr-legend"), [{ label: "Observed (daily)", color: ink, line: true }, { label: "NWS forecast", color: c1, line: true },
        { label: "Ensemble median", color: c1, line: true, dash: true }, { label: "50% range", color: c1, opacity: 0.4 }, { label: "80% range", color: c1, opacity: 0.2 }]);
      $("lr-note").textContent = `Daily average flow, log scale. The ranges cover the middle 50% and 80% of the ensemble runs. ${credit}`;
      draw();
      new ResizeObserver(debounce(draw, 120)).observe($("chart-lr"));
    }

    if (se) {
      const rows = se.daily.map(r => parse(se.daily_columns, r));
      const mName = m => new Date(`${m}-15T12:00:00`).toLocaleDateString([], { month: "long" });
      const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
      $("se-tiles").innerHTML = se.months.map(m => tile(`${mName(m.month)} average flow`, `${fmt(m.p25)}–${fmt(m.p75)} cfs`,
        `Middle half of the runs. A typical ${mName(m.month)}: ${fmt(m.clim_p25)}–${fmt(m.clim_p75)}`)).join("");
      $("se-lede").textContent = `From ${short(se.daily[0][0])} to ${short(src.end)}. Further out, the runs use the weather of past years, ` +
        "so the ranges show what today's snowpack and soil moisture could become under typical weather, not a forecast of particular storms.";
      const draw = () => timeChart($("chart-se"), {
        series: [{ label: "Median", data: rows.map(r => ({ t: r.t, v: r.p50 })), color: c1 }],
        bands: [{ label: "80% range", data: rows.map(r => ({ t: r.t, lo: r.p10, hi: r.p90 })), color: c1, opacity: 0.14 },
                { label: "50% range", data: rows.map(r => ({ t: r.t, lo: r.p25, hi: r.p75 })), color: c1, opacity: 0.28 }],
        yLog: true, H: 260,
        aria: "Flow over the next three months: CBRFC ensemble median with 50% and 80% ranges",
      });
      legend($("se-legend"), [{ label: "Ensemble median", color: c1, line: true },
        { label: "50% range", color: c1, opacity: 0.4 }, { label: "80% range", color: c1, opacity: 0.2 }]);
      $("se-note").textContent = `Daily average flow, log scale. Typical months are the middle half of past years in the USGS record. ${credit}`;
      draw();
      new ResizeObserver(debounce(draw, 120)).observe($("chart-se"));
    }
  }

  // ---------- 5. weather (data/<slug>/weather.json from build_weather.py) ----------
  function weather(w) {
    const off = w.put_in_offset_f || 0;
    const D = w.daily.map(r => Object.fromEntries(w.daily_columns.map((k, i) => [k, r[i]])));
    D.forEach(d => { d.t = new Date(`2001-${d.mmdd}T12:00:00`); });
    const hot = css("--dry"), cold = css("--river"), ink = css("--ink-2");
    const deg = v => `${Math.round(v)}°F`;
    const doyOfDate = dt => d3.timeDay.count(new Date(2001, 0, 1), new Date(2001, dt.getMonth(), Math.min(dt.getDate(), dt.getMonth() === 1 ? 28 : 31)));
    const sta = w.temp_station;
    const [y0, y1] = w.climate_years;
    const W = w.water;  // water temperature (null when not configured or unavailable)

    $("wx-lede").textContent = `Typical weather from ${y0}–${y1} records near the canyon, and the National Weather Service forecast for the put-in and take-out. ` +
      `Temperatures come from the ${sta.name} station (${fmt(sta.elev_ft)} ft); the put-in is higher and deeper in the canyon, so it is estimated ${Math.abs(off)}°F cooler.`;

    // --- Next 7 days: NWS periods grouped by date, both points in each card
    const pts = (w.forecast || []).filter(f => f.periods);
    if (pts.length) {
      const byDate = pts.map(f => {
        const m = new Map();
        f.periods.forEach(p => {
          const d = p.start.slice(0, 10);
          const e = m.get(d) || {};
          if (p.day) { e.hi = p.temp; e.short = p.short; e.wind = p.wind; } else { e.lo = p.temp; e.nshort = e.nshort || p.short; }
          e.pop = Math.max(e.pop ?? 0, p.pop ?? 0);
          m.set(d, e);
        });
        return m;
      });
      const dates = [...byDate[0].keys()].slice(0, 7);
      $("wx-forecast").innerHTML = dates.map(d => {
        const lab = new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        const first = byDate[0].get(d) || {};
        const pop = d3.max(byDate, m => m.get(d)?.pop ?? 0);
        return `<div class="wx-day"><div class="dt">${lab}</div>` +
          pts.map((f, i) => { const e = byDate[i].get(d) || {};
            return `<div class="pt"><span class="k">${esc(f.name)}</span><span class="v">${e.hi != null ? `${e.hi}°` : "–"} / ${e.lo != null ? `${e.lo}°` : "–"}</span></div>`; }).join("") +
          `<div class="pop">${pop ? `Rain ${pop}%` : "Dry"}</div><div class="s">${esc(first.short || first.nshort || "")}</div>` +
          (first.wind ? `<div class="w">Wind ${esc(first.wind)}</div>` : "") + `</div>`;
      }).join("");
      const upd = pts[0].updated ? new Date(pts[0].updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      $("wx-forecast-note").innerHTML = `High / low and the highest chance of rain that day or night. NWS forecast${upd ? `, updated ${upd}` : ""}: ` +
        pts.map(f => `<a href="${f.url}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join(" · ") + ".";
    } else {
      $("wx-forecast").innerHTML = `<p class="note">The NWS forecast is not available right now.</p>`;
    }

    // --- Your trip: synced with the launch date on Seasonal flows
    const tile = (k, v, d) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const trip = () => {
      const v = $("wx-launch").value;
      const n = Math.max(1, Math.min(14, Number($("wx-days").value) || 1));
      if (!v) return;
      const d0 = doyOfDate(new Date(`${v}T12:00:00`));
      const S = Array.from({ length: n }, (_, i) => D[(d0 + i) % 365]);
      const hiPut = d3.mean(S, s => s.hi_p50) + off, hiSta = d3.mean(S, s => s.hi_p50);
      const loPut = d3.mean(S, s => s.lo_p50) + off, loSta = d3.mean(S, s => s.lo_p50);
      const hot90 = d3.max(S, s => s.hi_p90), cold10 = d3.min(S, s => s.lo_p10) + off;
      // independent days overstate this a little (rainy days cluster), so it is rounded and called "about"
      const pNone = S.reduce((p, s) => p * (1 - s.p_wet), 1);
      const clear = d3.mean(S, s => s.clear), cloudy = d3.mean(S, s => s.cloudy);
      $("wx-trip").innerHTML =
        tile("Daytime highs", `${deg(hiPut)} – ${deg(hiSta)}`, `put-in to take-out; 1 day in 10 tops ${deg(hot90)} near the take-out`) +
        tile("Night lows", `${deg(loPut)} – ${deg(loSta)}`, `put-in to take-out; 1 night in 10 drops below ${deg(cold10)} at the put-in`) +
        tile(`Rain on at least one of ${n} day${n > 1 ? "s" : ""}`, `about ${pct(1 - pNone)}`, `a soaking rain (0.25 in or more) is ${pct(d3.mean(S, s => s.p_soak))} likely on a given day`) +
        tile("Sky", `${pct(clear)} clear`, `of days: ${pct(1 - clear - cloudy)} partly cloudy, ${pct(cloudy)} cloudy`) +
        (W ? (() => {
          const ws = Array.from({ length: n }, (_, i) => W.daily[(d0 + i) % 365]);
          const mid = d3.mean(ws, r => r[1]);
          return tile("Water", deg(mid), `typically ${deg(d3.min(ws, r => r[0]))}–${deg(d3.max(ws, r => r[2]))} near the take-out` +
            (mid < 60 ? "; cold enough for a wetsuit or drysuit" : ""));
        })() : "");
      const end = new Date(new Date(`${v}T12:00:00`).getTime() + (n - 1) * 864e5);
      $("wx-trip-note").textContent = `Typical conditions for ${new Date(`${v}T12:00:00`).toLocaleDateString([], { month: "long", day: "numeric" })}` +
        `${n > 1 ? ` – ${end.toLocaleDateString([], { month: "long", day: "numeric" })}` : ""}, from ${y0}–${y1}. Not a forecast; check the 7-day forecast above as your trip gets close.`;
    };
    const syncFrom = (a, b) => { $(b[0]).value = $(a[0]).value; $(b[1]).value = $(a[1]).value; };
    syncFrom(["ctl-launch", "ctl-days"], ["wx-launch", "wx-days"]);
    ["wx-launch", "wx-days"].forEach(id => $(id).addEventListener("change", () => {
      syncFrom(["wx-launch", "wx-days"], ["ctl-launch", "ctl-days"]);
      $("ctl-launch").dispatchEvent(new Event("change"));  // keeps the Seasonal flows planner in step
      trip();
    }));
    ["ctl-launch", "ctl-days"].forEach(id => $(id).addEventListener("change", () => { syncFrom(["ctl-launch", "ctl-days"], ["wx-launch", "wx-days"]); trip(); }));
    trip();

    // --- Through the year: temperatures (put-in or station) and rain / sky
    const today = new Date();
    const nowT = new Date(2001, today.getMonth(), Math.min(today.getDate(), today.getMonth() === 1 ? 28 : 31), 12);
    const on2001 = s => { const t = new Date(`${s}T12:00:00`); return new Date(2001, t.getMonth(), Math.min(t.getDate(), t.getMonth() === 1 ? 28 : 31), 12); };

    // --- Water temperature: estimate now, typical by date, and the USGS measurements
    if (W) {
      const water = $("chart-wt");
      const nowD = W.now ? new Date(`${W.now[0]}T12:00:00`) : null;
      const typ = nowD ? W.daily[doyOfDate(nowD)] : null;
      const wk = W.recent.length >= 8 ? W.recent[W.recent.length - 1][1] - W.recent[W.recent.length - 8][1] : null;
      $("wt-lede").textContent = `No gauge on this run measures water temperature continuously, so it is estimated from the last week's air temperature and the time of year, ` +
        `fitted to ${fmt(W.samples.length)} measurements USGS hydrographers took at the ${W.name} gauge (${W.sample_years.join("–")}). Typical error: about ${W.err_typical_f}°F.`;
      $("wt-tiles").innerHTML = W.now
        ? tile("Estimated water temperature", deg(W.now[1]), `near the take-out, ${nowD.toLocaleDateString([], { month: "short", day: "numeric" })}; ` +
            `9 in 10 estimates are within ${Math.round(W.err_p90_f)}°F`) +
          tile("Typical for this date", deg(typ[1]), `8 of 10 years ${deg(typ[0])}–${deg(typ[2])}`) +
          (wk != null ? tile("Past week", `${wk >= 0 ? "+" : "−"}${Math.abs(wk).toFixed(0)}°F`, wk <= -1 ? "cooling" : wk >= 1 ? "warming" : "steady") : "")
        : "";
      const yrNow = (W.recent || []).filter(r => on2001(r[0]) <= nowT);  // keep to this calendar year so the line does not wrap
      const drawWater = () => timeChart(water, {
        series: [{ label: "Measured", data: W.samples.map(([d, v]) => ({ t: on2001(d), v })).sort((a, b) => a.t - b.t), color: ink, dots: true },
                 { label: "Typical", data: D.map((d, k) => ({ t: d.t, v: W.daily[k][1] })), color: css("--wet") },
                 { label: "This year (estimated)", data: yrNow.map(([d, v]) => ({ t: on2001(d), v })), color: hot }],
        bands: [{ label: "8 of 10 years", data: D.map((d, k) => ({ t: d.t, lo: W.daily[k][0], hi: W.daily[k][2] })), color: css("--wet"), opacity: 0.2 }],
        nowT, H: 240, yLabel: "°F", aria: "Water temperature through the year: typical range, USGS measurements and this year's estimate",
      });
      legend($("wt-legend"), [{ label: "Typical (estimated)", color: css("--wet"), line: true }, { label: "8 of 10 years", color: css("--wet"), opacity: 0.3 },
        { label: "Last 30 days (estimated)", color: hot, line: true }, { label: "USGS measurement", color: ink, opacity: 0.6 }]);
      $("wt-note").textContent = `Estimated from ${W.air_source} (7-day average) and the time of year, fitted to ${W.fit_n} measurements; ` +
        `typical days are the estimate over ${y0}–${y1}. Dots are the measurements by date, any year. The put-in runs a little cooler. ` +
        "Below about 60°F, cold-water shock is a risk if you swim.";
      drawWater();
      new ResizeObserver(debounce(drawWater, 120)).observe(water);
    } else {
      $("wt-lede").textContent = "No water temperature data for this river yet.";
    }
    const drawTemp = () => {
      const o = $("wx-where").value === "put" ? off : 0;
      timeChart($("chart-wx-temp"), {
        series: [{ label: "Typical high", data: D.map(d => ({ t: d.t, v: d.hi_p50 + o })), color: hot },
                 { label: "Typical low", data: D.map(d => ({ t: d.t, v: d.lo_p50 + o })), color: cold }],
        bands: [{ label: "Highs, 8 of 10 days", data: D.map(d => ({ t: d.t, lo: d.hi_p10 + o, hi: d.hi_p90 + o })), color: hot, opacity: 0.18 },
                { label: "Lows, 8 of 10 nights", data: D.map(d => ({ t: d.t, lo: d.lo_p10 + o, hi: d.lo_p90 + o })), color: cold, opacity: 0.18 }],
        nowT, H: 260, yLabel: "°F", aria: "Typical daily high and low temperatures through the year",
      });
    };
    legend($("wx-temp-legend"), [{ label: "Typical high", color: hot, line: true }, { label: "Typical low", color: cold, line: true },
      { label: "8 of 10 days fall in the band", color: ink, opacity: 0.25 }]);
    $("wx-temp-note").textContent = `Daily high and low by date, ${y0}–${y1}, at ${sta.name}` +
      ` (pooled over two weeks around each date). Put-in values are ${Math.abs(off)}°F cooler. "Now" marks today's date.`;
    $("wx-where").addEventListener("change", drawTemp);
    const drawSky = () => timeChart($("chart-wx-sky"), {
      series: [{ label: "Chance of rain", data: D.map(d => ({ t: d.t, v: 100 * d.p_wet })), color: cold },
               { label: "Chance of soaking rain", data: D.map(d => ({ t: d.t, v: 100 * d.p_soak })), color: cold, dash: "5 4" },
               { label: "Clear days", data: D.map(d => ({ t: d.t, v: 100 * d.clear })), color: hot }],
      nowT, H: 220, yLabel: "%", aria: "Chance of rain and share of clear days through the year",
    });
    legend($("wx-sky-legend"), [{ label: "Chance of rain on a given day (0.01 in or more)", color: cold, line: true },
      { label: "Soaking rain (0.25 in or more)", color: cold, line: true, dash: true }, { label: "Clear days", color: hot, line: true }]);
    $("wx-sky-note").textContent = `Rain: average of the ${w.precip_stations.join(" and ")} stations, ${y0}–${y1}. ` +
      `Clear days: less than 30% of the sky cloudy on the day, from ${w.cloud.source}, ${w.cloud.years?.join("–") || ""}. The summer peak is the monsoon.`;
    const both = () => { drawTemp(); drawSky(); };
    both();
    new ResizeObserver(debounce(both, 120)).observe($("chart-wx-temp"));

    // --- By month table, with a clear / partly / cloudy bar
    const thisMonth = today.getMonth() + 1;
    const skyBar = c => c ? `<span class="sky" title="${pct(c[0])} clear, ${pct(c[1])} partly cloudy, ${pct(c[2])} cloudy">` +
      `<i class="c" style="width:${c[0] * 100}%"></i><i class="p" style="width:${c[1] * 100}%"></i><i class="o" style="width:${c[2] * 100}%"></i></span>` +
      `<span class="sky-n">${pct(c[0])}</span>` : "–";
    $("wx-months").innerHTML = `<thead><tr><th align="left">Month</th><th>Put-in high / low</th><th>${esc(sta.name.replace(/ \d.*$/, ""))} high / low</th>` +
      `<th>Rain days</th><th>Rain</th>${W ? "<th>Water</th>" : ""}<th align="left">Sky: clear · partly · cloudy</th></tr></thead><tbody>` +
      w.months.map(m => `<tr${m.month === thisMonth ? ' class="cur"' : ""}><td>${MONTHS[m.month - 1]}</td>` +
        `<td>${m.high + off}° / ${m.low + off}°</td><td>${m.high}° / ${m.low}°</td><td>${m.wet_days.toFixed(0)}</td><td>${m.precip_in.toFixed(1)} in</td>${W ? `<td>${m.water ?? "–"}°</td>` : ""}` +
        `<td class="sky-cell">${skyBar(m.cloud)}</td></tr>`).join("") + "</tbody>";
    $("wx-sources").textContent = `Temperatures: NOAA station ${sta.name} via ACIS, ${y0}–${y1} (record through ${new Date(`${sta.through}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}); ` +
      `put-in estimated ${Math.abs(off)}°F cooler. Rain: average of ${w.precip_stations.join(" and ")}; rain days are days with 0.01 in or more. ` +
      `Sky: ${w.cloud.source} at the canyon midpoint (clear under 30% cloud, cloudy over 70%). Forecast: National Weather Service.`;
  }

  // ---------- snowpack: NOHRSC SWE map + one basin index vs normal (data/<slug>/snow.json, build_snow.py) ----------
  function snow(o, sn, base) {
    const lede = $("snow-lede");
    if (!sn) { lede.textContent = "Snowpack data is not available right now."; return; }
    const ix = sn.index, M = sn.map;
    const wy0 = new Date(`${ix.wy_start}T12:00:00`);
    const dayT = k => new Date(wy0.getTime() + k * 864e5);
    const inch = v => (v == null ? "–" : `${v.toFixed(1)} in`);
    const longDay = k => dayT(k).toLocaleDateString([], { month: "long", day: "numeric" });

    // --- the one chart: basin index this winter vs the 1991-2020 normal
    const med = css("--median"), band = css("--band"), c1 = css("--wet");
    const N = ix.normal.map((r, k) => ({ t: dayT(k), p10: r[0], p50: r[1], p90: r[2] })).filter(r => r.p50 != null);
    const cur = ix.this.map(([k, v]) => ({ t: dayT(k), v, k }));
    const last = cur[cur.length - 1];
    const draw = () => timeChart($("chart-snow"), {
      series: [{ label: "Median", data: N.map(r => ({ t: r.t, v: r.p50 })), color: med, dash: "5 4" },
               { label: `This winter (WY${ix.water_year})`, data: cur, color: c1 }],
      bands: [{ label: "8 of 10 winters", data: N.map(r => ({ t: r.t, lo: r.p10, hi: r.p90 })), color: band, opacity: 0.25 }],
      nowT: last ? last.t : null, H: 260, yLabel: "in", fmtValue: inch,
      aria: "Basin snow water equivalent this winter compared with the 1991 to 2020 median and range",
    });
    legend($("snow-legend"), [{ label: `This winter (WY${ix.water_year})`, color: c1, line: true }, { label: "Median", color: med, line: true, dash: true },
      { label: "8 of 10 winters, 1991–2020", color: band, opacity: 0.35 }]);
    $("snow-note").textContent = `Snow water equivalent, averaged over the ${ix.sites.join(", ")} SNOTEL sites (records back to 1990). ` +
      `Normal is water years ${ix.normal_years.join("–")}.`;
    draw();
    new ResizeObserver(debounce(draw, 120)).observe($("chart-snow"));

    // --- lede: % of median when there is snow to compare, otherwise where the season stands
    // the typical cycle, from the median curve: when snow starts building, peaks and melts out
    const medNow = last ? ix.normal[last.k]?.[1] : null;
    const pk = ix.median_peak;
    const part = t => `${["early", "mid", "late"][Math.min(2, Math.floor((t.getDate() - 1) / 10))]} ${t.toLocaleDateString([], { month: "long" })}`;
    const startR = N.find(r => r.p50 >= 0.1);
    const outR = N.slice(pk.day).find(r => r.p50 < 0.1);
    const cycle = `In a typical winter, snow starts building in the basin in ${startR ? part(startR.t) : "late fall"}, ` +
      `peaks in ${part(dayT(pk.day))} at about ${inch(pk.in)} of water at the SNOTEL sites, and melts out by ${outR ? part(outR.t) : "late spring"}, ` +
      "feeding the spring runoff that the permit season is built around." +
      (M.above_snow_line ? ` About ${pct(M.above_snow_line.share)} of the basin above the put-in (${fmt(M.above_snow_line.area_mi2)} of ${fmt(M.above_snow_line.basin_mi2)} sq mi) ` +
        `lies above ${fmt(M.above_snow_line.feet)} ft, the high country that typically holds snowpack through the winter.` : "");
    lede.textContent = (last && medNow >= 0.5
      ? `Basin snowpack is ${pct(last.v / medNow)} of median for the date (${inch(last.v)} against ${inch(medNow)}). ` : "") + cycle;

    // --- the map: terrain (same lat/lon grid as the Basin map) + NOHRSC SWE + basin outline, rivers, SNOTEL
    const host = $("snow-map");
    const [w, s, e, n] = M.bbox;
    const [[ts, tw], [tn, te]] = M.terrain_bounds;
    const k = Math.cos(((s + n) / 2) * Math.PI / 180);
    const VW = 1000, VH = Math.round(VW * (n - s) / ((e - w) * k));
    const X = lon => ((lon - w) / (e - w)) * VW, Y = lat => ((n - lat) / (n - s)) * VH;
    // crop terrain.jpg to the same box with CSS background size/position
    const bgW = (te - tw) / (e - w) * 100, bgH = (tn - ts) / (n - s) * 100;
    const bgX = (te - tw) === (e - w) ? 0 : (w - tw) / ((te - tw) - (e - w)) * 100;
    const bgY = (tn - ts) === (n - s) ? 0 : (tn - n) / ((tn - ts) - (n - s)) * 100;
    const path = pts => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("");
    const rivers = (base?.rivers || []).filter(r => r.w >= 1.6).flatMap(r => r.lines.map(l => `<path d="${path(l)}" stroke-width="${(r.w * 0.9).toFixed(1)}"/>`)).join("");
    // labels go right of the dot unless that would cover an earlier label or run off the map
    const placed = [];
    const sites = (o?.snotel || []).slice().sort((a, b) => b.lat - a.lat).map(st => {
      const x = X(st.lon), y = Y(st.lat), lw = st.name.length * 13 + 12;
      const box = r => (r ? [x, y - 16, x + lw, y + 12] : [x - lw, y - 16, x, y + 12]);
      const hits = b => placed.some(p => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
      let right = x + lw < VW - 8;
      if (right && hits(box(true))) right = false;
      else if (!right && hits(box(false))) right = true;
      placed.push(box(right));
      return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"/><text x="${(x + (right ? 12 : -12)).toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${right ? "start" : "end"}">${esc(st.name)}</text></g>`;
    }).join("");
    host.style.aspectRatio = `${VW} / ${VH}`;
    if (M.terrain) {  // banded elevation made for this map, on exactly the same box
      host.style.backgroundImage = `url(data/${SLUG}/${M.terrain}?v=${encodeURIComponent(sn.generated)})`;
      host.style.backgroundSize = "100% 100%";
      host.style.backgroundPosition = "0 0";
    } else {  // fall back to the Basin map's terrain, cropped to the box
      host.style.backgroundImage = `url(data/${SLUG}/terrain.jpg)`;
      host.style.backgroundSize = `${bgW}% ${bgH}%`;
      host.style.backgroundPosition = `${bgX}% ${bgY}%`;
    }
    // layers: flat elevation bands (background) < relief (multiply) < solid snow < lines and labels
    host.innerHTML = (M.relief ? `<img class="sm-relief" src="data/${SLUG}/${M.relief}?v=${encodeURIComponent(sn.generated)}" alt="">` : "") +
      `<img class="sm-swe" src="data/${SLUG}/${M.image}?v=${encodeURIComponent(sn.generated)}" alt="">` +
      `<svg viewBox="0 0 ${VW} ${VH}" aria-hidden="true"><g class="sm-rivers">${rivers}</g>` +
      `<defs><clipPath id="sm-basin-clip"><path d="${path(base?.inner_basin || [])}Z"/></clipPath></defs>` +
      `<g class="sm-contours" clip-path="url(#sm-basin-clip)"></g><path class="sm-basin" d="${path(base?.inner_basin || [])}Z"/><g class="sm-clabels"></g><g class="sm-sites">${sites}</g></svg>`;
    // contours (e.g. 7,000 / 8,000 / 9,000 ft) from the Basin map's pre-traced 1,000 ft file, drawn
    // in black over the snow, each labelled a few times along its longest stretches
    const levels = M.contours_ft || [];
    if (levels.length) fetch(`data/${SLUG}/contours_1000.json`).then(r => r.json()).then(c => {
      const inBox = ([lon, lat]) => lon >= w && lon <= e && lat >= s && lat <= n;
      const lines = c.lines.filter(([v, pts]) => levels.includes(v) && pts.some(inBox));
      host.querySelector(".sm-contours").innerHTML = lines.map(([v, pts]) => `<path d="${path(pts)}"/>`).join("");
      // contours are clipped to the basin outline; one label per level, on its longest line inside the
      // basin, upright, well away from the other contour labels and the SNOTEL names (islands go unlabelled)
      const kept = [];
      const inBasin = (lon, lat) => d3.polygonContains(base?.inner_basin || [], [lon, lat]);
      const CL = M.contour_labels || {}, labelFt = CL.label_ft || levels, area = CL.label_area;  // which levels get a label, and where
      const inArea = (lon, lat) => !area || (lon >= area[0] && lat >= area[1] && lon <= area[2] && lat <= area[3]);
      // label_west levels: horizontal, at the westernmost point of the line in the area, set just west of it (outside the line)
      const west = CL.label_west || [];
      c.labels.filter(([v, lon, lat]) => labelFt.includes(v) && inBasin(lon, lat) && inArea(lon, lat))  // contours stop at the basin edge
        .sort((a, b) => (west.includes(a[0]) && a[0] === b[0] ? a[1] - b[1] : b[5] - a[5]))  // westernmost / longest lines first
        .forEach(([v, lon, lat, dx, dy]) => {
          const x = X(lon), y = Y(lat);
          if (x < 60 || x > VW - 60 || y < 30 || y > VH - 30) return;
          if (kept.some(q => q.v === v || Math.hypot(q.x - x, q.y - y) < 90)) return;
          if (placed.some(b => x > b[0] - 60 && x < b[2] + 60 && y > b[1] - 30 && y < b[3] + 30)) return;  // clear of SNOTEL dots and names
          let ang = Math.atan2(-dy / (n - s) * VH, dx / (e - w) * VW) * 180 / Math.PI;
          if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
          if (west.includes(v)) kept.push({ v, x: x - 10, y, ang: 0, anchor: "end" });
          else kept.push({ v, x, y, ang });
        });
      host.querySelector(".sm-clabels").innerHTML = kept.map(q =>
        `<text transform="translate(${q.x.toFixed(1)} ${q.y.toFixed(1)}) rotate(${q.ang.toFixed(0)})" text-anchor="${q.anchor || "middle"}" dy="7">${fmt(q.v)}</text>`).join("");
    }).catch(() => {});
    const leg = M.legend || [];
    const elev = M.elev_legend || [];
    $("snow-map-legend").innerHTML =
      (elev.length ? `<div class="snow-key-row"><span class="key k-title">Elevation, ft</span>` +
        elev.map(l => `<span class="key${l.above_snow_line ? " above" : ""}"><span class="sw" style="background:${l.color}"></span>${esc(l.label)}</span>`).join("") +
        `</div>` : "") +
      (levels.length ? `<div class="snow-key-row"><span class="key k-title">Contours</span><span class="key"><span class="ln contour"></span>` +
        `${levels.map(v => fmt(v)).join(", ")} ft</span></div>` : "") +
      `<div class="snow-key-row"><span class="key k-title">Snow water, in</span>` +
      leg.map(l => `<span class="key"><span class="sw" style="background:${l.color}"></span>${esc(l.label)}</span>`).join("") + `</div>`;
    const when = new Date(sn.generated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    $("snow-map-note").textContent = (M.basin_snow_cover > 0
      ? `Snow covers about ${pct(M.basin_snow_cover)} of the basin above the put-in (outlined). `
      : "No snow mapped in the basin above the put-in (outlined) yet. ") +
      `${M.source}, about 1 km cells, retrieved ${when}. Dots are the SNOTEL sites.`;
  }
})();
