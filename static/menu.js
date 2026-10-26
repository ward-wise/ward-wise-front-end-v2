// Menu money: how each ward office spends its ~$1.5M a year, 2005–2025.
//
// Three views on one payload (the eleven menu metrics for all fifty wards, one timeline call):
//   a. the citywide picture for a year — median share per category, as bars;
//   b. all fifty wards — a sortable table, any row opening into detail bars with the citywide
//      median ticked on each;
//   c. one ward over time — a stacked share chart 2005–2025 with term bands, and small
//      multiples of each category against the citywide median.
// Shares are descriptive: a choice made in the ward office, never scored.
//
// URL is state: /menu?y=&ward=&sort=&dir=
(function () {
  "use strict";
  const root = () => document.getElementById("menu-root");
  const body = () => document.getElementById("menu-body");
  if (!root()) return;

  const esc = (t) => WardWiseExplorer.escapeHtml(t == null ? "" : String(t));
  const S = window.WardWiseScoring;
  const C = window.WardWiseCharts;

  // The eight categories, with the short labels the page uses and a tone index into the
  // --menu-cat-N tokens. Validated against the catalog by the route tests.
  window.WardWiseMenuCategories = [
    { id: "menu_streets_share", short: "Streets", tone: 1 },
    { id: "menu_lighting_share", short: "Lighting", tone: 2 },
    { id: "menu_sidewalks_share", short: "Sidewalks", tone: 3 },
    { id: "menu_alleys_share", short: "Alleys", tone: 4 },
    { id: "menu_parks_share", short: "Parks", tone: 5 },
    { id: "menu_cameras_share", short: "Cameras", tone: 6 },
    { id: "menu_schools_share", short: "Schools", tone: 7 },
    { id: "menu_active_transport_share", short: "Walking & biking", tone: 8 },
  ];
  const CATEGORIES = window.WardWiseMenuCategories;
  const EXTRAS = [
    { id: "menu_budget_utilization", short: "Budget used" },
    { id: "menu_project_diversity", short: "Project diversity" },
    { id: "menu_spending_spread", short: "Spending spread" },
  ];
  const OTHER = { id: "__other", short: "Uncategorized", tone: "other" };
  const ALL_IDS = CATEGORIES.concat(EXTRAS).map((c) => c.id);
  const FIRST_YEAR = 2005;

  const state = {
    manifest: null,
    wards: [],
    years: [],
    year: null,
    wardId: null,
    byWard: {},     // wardId -> year -> metric -> value
    city: {},       // year -> metric -> {min, median, max, mean, n}
    catOrder: [],   // categories sorted by mean citywide median, descending (the stack order)
    terms: null,
    notes: null,
    sort: { key: "ward", dir: "asc" },
    open: null,
  };

  // ---- data ----

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const y = Number(params.get("y"));
    state._urlYear = Number.isFinite(y) && y ? y : null;
    const ward = params.get("ward");
    state._urlWard = ward ? String(Number(ward)).padStart(2, "0") : null;
    const sort = params.get("sort");
    state.sort = { key: sort && (sort === "ward" || sort === "top" || ALL_IDS.includes(sort)) ? sort : "ward", dir: params.get("dir") === "desc" ? "desc" : "asc" };
  }

  function writeUrl() {
    const params = new URLSearchParams();
    if (state.year && state.year !== state.years[state.years.length - 1]) params.set("y", String(state.year));
    if (state.wardId) params.set("ward", state.wardId);
    if (state.sort.key !== "ward") params.set("sort", state.sort.key);
    if (state.sort.dir !== "asc") params.set("dir", state.sort.dir);
    const text = params.toString();
    window.history.replaceState(null, "", `/menu${text ? `?${text}` : ""}`);
  }

  function reshape(data) {
    const years = (data.snapshots || []).map((s) => Number(String(s.period_end || s.snapshot_id).slice(0, 4)));
    const byWard = {};
    for (const series of data.series || []) {
      const ward = String(series.area_id);
      byWard[ward] ||= {};
      (series.values || []).forEach((value, i) => {
        if (!Number.isFinite(value)) return;
        const year = years[i];
        byWard[ward][year] ||= {};
        byWard[ward][year][series.metric_id] = value;
      });
    }
    const yearSet = [...new Set(years)].filter((y) => y >= FIRST_YEAR).sort((a, b) => a - b);
    const city = {};
    for (const year of yearSet) {
      city[year] = {};
      for (const id of ALL_IDS.concat([OTHER.id])) {
        const values = [];
        for (const ward of Object.keys(byWard)) {
          const v = id === OTHER.id ? other(byWard[ward][year]) : byWard[ward][year]?.[id];
          if (Number.isFinite(v)) values.push(v);
        }
        if (values.length) {
          city[year][id] = { min: Math.min(...values), max: Math.max(...values), median: S.median(values), mean: values.reduce((a, b) => a + b, 0) / values.length, n: values.length };
        }
      }
    }
    const catOrder = [...CATEGORIES].sort((a, b) => {
      const meanOf = (c) => yearSet.map((y) => city[y][c.id]?.median).filter(Number.isFinite).reduce((s, v, _, arr) => s + v / arr.length, 0);
      return meanOf(b) - meanOf(a);
    });
    return { years: yearSet, byWard, city, catOrder };
  }

  // the eight categories rarely sum to 100: the remainder is spending the books file elsewhere
  function other(record) {
    if (!record) return null;
    let sum = 0;
    let any = false;
    for (const c of CATEGORIES) {
      if (Number.isFinite(record[c.id])) {
        sum += record[c.id];
        any = true;
      }
    }
    return any ? Math.max(0, 100 - sum) : null;
  }

  function wardName(id) {
    const ward = state.wards.find((w) => w.ward_id === id);
    return `Ward ${ward?.ward_number || Number(id)}`;
  }

  function wardSub(id) {
    const ward = state.wards.find((w) => w.ward_id === id);
    return (ward?.community_area_overlaps || []).slice(0, 2).map((o) => o.name).filter(Boolean).join(" & ");
  }

  function metricLabel(id) {
    return state.manifest?.metrics?.find((m) => m.metric_id === id)?.label || id;
  }

  function metricNote(id) {
    const m = state.manifest?.metrics?.find((x) => x.metric_id === id);
    return m?.methodology_short || m?.description || "";
  }

  function pct(v) {
    return Number.isFinite(v) ? `${v.toFixed(v >= 10 ? 0 : 1)}%` : "—";
  }

  function topCategory(record) {
    let best = null;
    for (const c of CATEGORIES) {
      const v = record?.[c.id];
      if (Number.isFinite(v) && (best == null || v > best.value)) best = { ...c, value: v };
    }
    return best;
  }

  // ---- (a) citywide picture ----

  function citywideHtml() {
    const year = state.year;
    const cityYear = state.city[year] || {};
    const rows = [...CATEGORIES]
      .map((c) => ({ ...c, median: cityYear[c.id]?.median }))
      .filter((c) => Number.isFinite(c.median))
      .sort((a, b) => b.median - a.median);
    if (!rows.length) return "";
    const max = Math.max(...rows.map((r) => r.median), 1e-9);
    const bars = rows.map((r) => `
      <div class="menu-bar-row">
        <span class="menu-bar-label">${esc(r.short)}</span>
        <span class="menu-bar-track"><span class="menu-bar-fill tone-${r.tone}" style="width:${((r.median / max) * 100).toFixed(1)}%"></span></span>
        <span class="menu-bar-value num">${pct(r.median)}</span>
      </div>`).join("");
    const [first, second] = rows;
    const sentence = second
      ? `<b>${esc(first.short)}</b> takes the biggest median share citywide in ${year}, ${pct(first.median)} of a ward's menu spending. Next comes ${esc(second.short)} at ${pct(second.median)}.`
      : "";
    const outside = cityYear[OTHER.id]?.mean;
    const note = Number.isFinite(outside) && outside >= 5
      ? `<p class="soft menu-note">In ${year} an average ${pct(outside)} of menu dollars fell outside these eight categories (line items the books file under other headings).</p>`
      : "";
    return `
      <section class="report-card menu-citywide">
        <div class="ww-mainhead">The citywide picture, ${year}<span>median share of menu spending per category across the fifty wards</span></div>
        <p class="ed-result">${sentence}</p>
        <div class="menu-bars">${bars}</div>
        ${note}
      </section>`;
  }

  // ---- (b) all fifty wards ----

  function records() {
    return state.wards.map((w) => {
      const rec = state.byWard[w.ward_id]?.[state.year] || null;
      return { wardId: w.ward_id, rec, top: topCategory(rec) };
    });
  }

  function sortedRecords() {
    const list = records();
    const { key, dir } = state.sort;
    const sign = dir === "desc" ? -1 : 1;
    const value = (r) => key === "ward" ? Number(r.wardId) : key === "top" ? (r.top ? r.top.value : null) : r.rec?.[key];
    list.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const ma = Number.isFinite(va);
      const mb = Number.isFinite(vb);
      if (ma && mb) return (va - vb) * sign || Number(a.wardId) - Number(b.wardId);
      if (ma) return -1;   // missing sinks regardless of direction
      if (mb) return 1;
      return Number(a.wardId) - Number(b.wardId);
    });
    return list;
  }

  function tableHtml() {
    const { key, dir } = state.sort;
    const th = (k, label, cls = "") => {
      const on = key === k;
      const arrow = on ? (dir === "asc" ? "▲" : "▼") : "";
      return `<th scope="col" class="${cls}"${on ? ` aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""}><button type="button" class="sort-btn" data-act="sort" data-key="${esc(k)}">${esc(label)} <span class="sort-arrow">${arrow}</span></button></th>`;
    };
    const head = [th("ward", "Ward", "menu-col-ward"), th("top", "Top category", "menu-col-top")]
      .concat(CATEGORIES.map((c) => th(c.id, c.short, "num")))
      .concat([th("menu_budget_utilization", "Budget used", "num"), th("menu_spending_spread", "Spread", "num")])
      .join("");
    const rows = sortedRecords().map((r) => {
      const open = state.open === r.wardId;
      const cells = CATEGORIES.map((c) => `<td class="num">${pct(r.rec?.[c.id])}</td>`).join("");
      const detail = open ? `<tr class="menu-detail-row"><td colspan="${4 + CATEGORIES.length}">${detailHtml(r.wardId)}</td></tr>` : "";
      return `
        <tr class="menu-row${open ? " is-open" : ""}${r.wardId === state.wardId ? " is-focus" : ""}" data-ward="${esc(r.wardId)}">
          <th scope="row"><button type="button" class="ward-toggle" data-act="row" data-ward="${esc(r.wardId)}" aria-expanded="${open}">${esc(wardName(r.wardId))}<small>${esc(wardSub(r.wardId))}</small></button></th>
          <td class="menu-col-top">${r.top ? `<span class="menu-swatch tone-${r.top.tone}"></span>${esc(r.top.short)} <span class="num soft">${pct(r.top.value)}</span>` : "—"}</td>
          ${cells}
          <td class="num">${pct(r.rec?.menu_budget_utilization)}</td>
          <td class="num">${Number.isFinite(r.rec?.menu_spending_spread) ? r.rec.menu_spending_spread.toFixed(0) : "—"}</td>
        </tr>${detail}`;
    }).join("");
    return `
      <section class="report-card menu-wards">
        <div class="ww-mainhead">All fifty wards, ${state.year}<span>share of each ward's menu spending by category · click a column to sort, a ward to open it</span></div>
        <div class="menu-table-wrap"><table class="menu-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      </section>`;
  }

  function detailHtml(wardId) {
    const rec = state.byWard[wardId]?.[state.year] || {};
    const cityYear = state.city[state.year] || {};
    const bars = state.catOrder.map((c) => {
      const value = rec[c.id];
      const median = cityYear[c.id]?.median;
      const scaleMax = cityYear[c.id]?.max || 1;
      const fill = Number.isFinite(value) ? Math.max(0, Math.min(100, (value / scaleMax) * 100)) : 0;
      const tick = Number.isFinite(median) ? Math.max(0, Math.min(100, (median / scaleMax) * 100)) : null;
      return `
        <div class="detail-metric">
          <div class="detail-metric-head"><span class="detail-metric-label"><span class="menu-swatch tone-${c.tone}"></span>${esc(c.short)}</span>
            <span class="detail-metric-value num">${pct(value)}<span class="detail-metric-median">citywide median ${pct(median)}</span></span></div>
          <span class="detail-bar-track" aria-hidden="true"><span class="detail-bar-fill tone-${c.tone}" style="width:${fill.toFixed(1)}%"></span>${tick != null ? `<span class="detail-bar-tick" style="left:${tick.toFixed(1)}%"></span>` : ""}</span>
        </div>`;
    }).join("");
    const stats = EXTRAS.map((e) => {
      const v = rec[e.id];
      const text = e.id === "menu_spending_spread" ? (Number.isFinite(v) ? v.toFixed(0) : "—") : pct(v);
      const median = cityYear[e.id]?.median;
      const medianText = e.id === "menu_spending_spread" ? (Number.isFinite(median) ? median.toFixed(0) : "—") : pct(median);
      return `<div class="menu-stat"><span class="menu-stat-label">${esc(e.short)}</span><span class="menu-stat-value num">${text}</span><span class="menu-stat-median">median ${medianText}</span><span class="menu-stat-note">${esc(metricNote(e.id))}</span></div>`;
    }).join("");
    const coverage = (state.notes?.menu_money?.by_ward || []).find((row) => Number(row.ward) === Number(wardId));
    const caveat = coverage
      ? `<p class="menu-caveat">Placement, 2005–2018: ${(coverage.coverage_2005_2018 * 100).toFixed(0)}% of this ward's menu dollars could be placed on the map ($${Math.round(coverage.missing_usd_2005_2018 / 1e5) / 10}M unplaced). Spending spread rests on placed dollars; the shares do not.</p>`
      : "";
    return `<div class="menu-detail"><div class="menu-detail-bars">${bars}</div><div class="menu-stats">${stats}</div>${caveat}
      <p class="menu-detail-links"><a class="ww-linkbtn" href="#menu-focus" data-act="focus" data-ward="${esc(wardId)}">See ${esc(wardName(wardId))} over time ↓</a> · <a class="ww-linkbtn" href="${esc(WardWiseGeography.reportUrl("ward", wardId))}">Full report →</a></p></div>`;
  }

  // ---- (c) one ward over time ----

  function termBands() {
    const terms = state.terms?.terms;
    const last = state.years[state.years.length - 1];
    const keys = terms ? Object.keys(terms).map(Number).sort((a, b) => a - b) : [];
    const bands = [];
    if (!keys.length) return bands;
    if (keys[0] > FIRST_YEAR) bands.push({ from: FIRST_YEAR, to: keys[0], label: "" });
    keys.forEach((key, i) => {
      const to = i + 1 < keys.length ? keys[i + 1] : Math.max(last + 1, key + 4);
      const member = terms[key]?.wards?.[state.wardId]?.members?.[0]?.name;
      const label = member ? tidyName(member) : String(key);
      bands.push({ from: key, to, label });
    });
    return bands;
  }

  function tidyName(name) {
    const parts = String(name).split(",");
    return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
  }

  function stackedHtml(wardId) {
    const years = state.years;
    const W = 460, H = 220, L = 40, R = 14, T = 16, B = 26;
    const X = (year) => L + ((year - years[0]) / Math.max(1, years[years.length - 1] - years[0])) * (W - L - R);
    const Y = (v) => T + (1 - v / 100) * (H - T - B);
    const order = state.catOrder.concat([OTHER]);
    const stacks = years.map((year) => {
      const rec = state.byWard[wardId]?.[year];
      let acc = 0;
      const edges = [0];
      for (const c of order) {
        const v = c.id === OTHER.id ? other(rec) : rec?.[c.id];
        acc += Number.isFinite(v) ? v : 0;
        edges.push(Math.min(100, acc));
      }
      return { year, edges, has: Boolean(rec) };
    });
    let svg = `<svg class="menu-stack" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of ${esc(wardName(wardId))}'s menu spending by category, ${years[0]}–${years[years.length - 1]}">`;
    termBands().forEach((band, i) => {
      const x0 = X(Math.max(years[0], band.from));
      const x1 = X(Math.min(years[years.length - 1] + 1, band.to));
      if (x1 <= x0) return;
      svg += `<rect class="menu-band${i % 2 ? " alt" : ""}" x="${x0.toFixed(1)}" y="${T}" width="${(x1 - x0).toFixed(1)}" height="${H - T - B}"><title>${esc(band.label)} · ${band.from}–${band.to}</title></rect>`;
      if (band.label && x1 - x0 > 40) svg += `<text class="menu-band-label" x="${(x0 + 3).toFixed(1)}" y="${T + 10}">${esc(band.label.split(" ").slice(-1)[0])}</text>`;
    });
    for (const y of [0, 50, 100]) {
      svg += `<line class="menu-grid" x1="${L}" y1="${Y(y).toFixed(1)}" x2="${W - R}" y2="${Y(y).toFixed(1)}"/><text class="menu-axis" x="${L - 4}" y="${(Y(y) + 3).toFixed(1)}" text-anchor="end">${y}%</text>`;
    }
    order.forEach((c, k) => {
      const top = stacks.map((s) => `${X(s.year).toFixed(1)},${Y(s.edges[k + 1]).toFixed(1)}`);
      const bottom = [...stacks].reverse().map((s) => `${X(s.year).toFixed(1)},${Y(s.edges[k]).toFixed(1)}`);
      svg += `<path class="menu-area tone-${c.tone}" d="M${top.join(" L")} L${bottom.join(" L")} Z"><title>${esc(c.short)}</title></path>`;
    });
    for (const year of [2015, 2023]) {
      if (year > years[0] && year < years[years.length - 1]) svg += `<line class="menu-remap" x1="${X(year).toFixed(1)}" y1="${T}" x2="${X(year).toFixed(1)}" y2="${H - B}"><title>Ward boundaries redrawn in ${year}</title></line>`;
    }
    // an invisible hit grid: one cell per year per band, so the shared tooltip can name the share
    const cellW = (X(years[1] || years[0] + 1) - X(years[0]));
    stacks.forEach((s) => {
      order.forEach((c, k) => {
        const rec = state.byWard[wardId]?.[s.year];
        const v = c.id === OTHER.id ? other(rec) : rec?.[c.id];
        const y0 = Y(s.edges[k + 1]);
        const y1 = Y(s.edges[k]);
        if (y1 - y0 < 0.5) return;
        svg += `<rect class="menu-hit" x="${(X(s.year) - cellW / 2).toFixed(1)}" y="${y0.toFixed(1)}" width="${cellW.toFixed(1)}" height="${(y1 - y0).toFixed(1)}" data-wardtick data-tip="${C.tip({ name: `${s.year} · ${c.short}`, detail: pct(v) })}"/>`;
      });
    });
    years.forEach((year, i) => {
      if (i % 5 === 0 || i === years.length - 1) svg += `<text class="menu-axis" x="${X(year).toFixed(1)}" y="${H - 8}" text-anchor="middle">${year}</text>`;
    });
    svg += `</svg>`;
    const legend = order.map((c) => `<span class="menu-legend-item"><span class="menu-swatch tone-${c.tone}"></span>${esc(c.short)}</span>`).join("");
    return `${svg}<div class="menu-legend">${legend}</div>`;
  }

  function multiplesHtml(wardId) {
    return `<div class="ww-multis menu-multis">${state.catOrder.map((c) => {
      const points = state.years.map((y) => [y, state.byWard[wardId]?.[y]?.[c.id]]).filter((p) => Number.isFinite(p[1]));
      const reference = state.years.map((y) => [y, state.city[y]?.[c.id]?.median]).filter((p) => Number.isFinite(p[1]));
      const now = state.byWard[wardId]?.[state.year]?.[c.id];
      const median = state.city[state.year]?.[c.id]?.median;
      return `<div class="ww-multi"><h6><span class="menu-swatch tone-${c.tone}"></span>${esc(c.short)}</h6><div class="mv num">${state.year}: ${pct(now)} · city median ${pct(median)}</div>${C.miniChart(points, { reference, ymax: 100 })}</div>`;
    }).join("")}</div><p class="soft menu-multis-cap">Solid line is this ward; dashed is the citywide median that year. All on the same 0–100% scale.</p>`;
  }

  function focusProse(wardId) {
    const years = state.years;
    const avg = (id) => {
      const vals = years.map((y) => state.byWard[wardId]?.[y]?.[id]).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const cityAvg = (id) => {
      const vals = years.map((y) => state.city[y]?.[id]?.mean).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const best = [...CATEGORIES].map((c) => ({ ...c, avg: avg(c.id), city: cityAvg(c.id) })).filter((c) => Number.isFinite(c.avg)).sort((a, b) => b.avg - a.avg)[0];
    if (!best) return "";
    const diff = best.avg - best.city;
    let biggest = null;
    for (let i = 1; i < years.length; i += 1) {
      const a = state.byWard[wardId]?.[years[i - 1]];
      const b = state.byWard[wardId]?.[years[i]];
      if (!a || !b) continue;
      const l1 = CATEGORIES.reduce((s, c) => s + Math.abs((b[c.id] || 0) - (a[c.id] || 0)), 0) / 2;
      if (!biggest || l1 > biggest.l1) biggest = { from: years[i - 1], to: years[i], l1 };
    }
    return `<p class="ed-result">Over ${years[0]}–${years[years.length - 1]} ${esc(wardName(wardId))} put the most into <b>${esc(best.short)}</b> (an average ${pct(best.avg)}), ${Math.abs(diff).toFixed(0)} points ${diff >= 0 ? "above" : "below"} the average ward.${biggest ? ` Its mix changed most between ${biggest.from} and ${biggest.to}.` : ""}</p>`;
  }

  function focusHtml() {
    if (!state.wardId) return `<section class="report-card menu-focus" id="menu-focus"><div class="ww-mainhead">One ward over time<span>pick a ward above, or open a row in the table</span></div></section>`;
    return `
      <section class="report-card menu-focus" id="menu-focus">
        <div class="ww-mainhead">${esc(wardName(state.wardId))} over time<span>share of menu spending by category, ${state.years[0]}–${state.years[state.years.length - 1]} · bands mark who held the seat</span></div>
        ${focusProse(state.wardId)}
        ${stackedHtml(state.wardId)}
        ${multiplesHtml(state.wardId)}
        <p class="menu-detail-links"><a class="ww-linkbtn" href="${esc(WardWiseGeography.reportUrl("ward", state.wardId))}">Full report for ${esc(wardName(state.wardId))} →</a></p>
      </section>`;
  }

  // ---- controls ----

  function controlsHtml() {
    const yearOptions = [...state.years].reverse().map((y) => `<option value="${y}"${y === state.year ? " selected" : ""}>${y}</option>`).join("");
    const wardOptions = [`<option value="">— pick a ward —</option>`].concat(state.wards.map((w) => `<option value="${esc(w.ward_id)}"${w.ward_id === state.wardId ? " selected" : ""}>${esc(wardName(w.ward_id))}${wardSub(w.ward_id) ? ` — ${esc(wardSub(w.ward_id))}` : ""}</option>`)).join("");
    return `
      <div class="ed-controls">
        <a class="ww-linkbtn" href="/">← Map view</a>
        <label class="report-select"><span>Year</span><select id="mn-year">${yearOptions}</select></label>
        <label class="report-select report-select-area"><span>Ward</span><select id="mn-ward">${wardOptions}</select></label>
        <button type="button" class="ww-cta ghost" data-act="copy">Copy link</button>
        <button type="button" class="ww-cta ghost" data-act="print">Print</button>
      </div>`;
  }

  function render() {
    const el = body();
    if (!el) return;
    el.innerHTML = controlsHtml() + citywideHtml() + tableHtml() + focusHtml();
    C.attachTips(el);
    document.getElementById("mn-year")?.addEventListener("change", (event) => {
      state.year = Number(event.target.value);
      render();
      writeUrl();
    });
    document.getElementById("mn-ward")?.addEventListener("change", (event) => {
      state.wardId = event.target.value || null;
      state.open = state.wardId;
      render();
      writeUrl();
    });
    writeUrl();
  }

  function onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "sort") {
      const key = target.dataset.key;
      state.sort = state.sort.key === key
        ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "ward" ? "asc" : "desc" };
      render();
    } else if (act === "row") {
      const ward = target.dataset.ward;
      state.open = state.open === ward ? null : ward;
      state.wardId = state.open || state.wardId;
      render();
    } else if (act === "focus") {
      state.wardId = target.dataset.ward;
      render();
      document.getElementById("menu-focus")?.scrollIntoView({ behavior: "smooth" });
      event.preventDefault();
    } else if (act === "copy") {
      WardWiseExplorer.track("report_shared", { how: "copy_link" });
      const url = window.location.href;
      const done = () => { target.textContent = "Link copied"; setTimeout(() => { target.textContent = "Copy link"; }, 2000); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt("Copy this link", url));
      else window.prompt("Copy this link", url);
    } else if (act === "print") {
      WardWiseExplorer.track("report_shared", { how: "print" });
      window.print();
    }
  }

  async function boot() {
    const el = body();
    try {
      readUrl();
      const [manifest, wardsPayload, timeline, terms, notes] = await Promise.all([
        WardWiseExplorer.fetchExplorerManifest(),
        WardWiseExplorer.fetchExplorerWards(),
        WardWiseExplorer.fetchTimeline({ metricIds: ALL_IDS, areaType: "ward" }),
        WardWiseExplorer.fetchJson("/api/aldermanic-terms", "").catch(() => null),
        WardWiseExplorer.fetchJson("/api/data-notes", "").catch(() => null),
      ]);
      state.manifest = manifest;
      state.wards = (wardsPayload.wards || []).sort((a, b) => Number(a.ward_number || a.ward_id) - Number(b.ward_number || b.ward_id));
      state.terms = terms;
      state.notes = notes;
      Object.assign(state, reshape(timeline));
      if (!state.years.length) throw new Error("no menu years");
      state.year = state.years.includes(state._urlYear) ? state._urlYear : state.years[state.years.length - 1];
      state.wardId = state.wards.some((w) => w.ward_id === state._urlWard) ? state._urlWard : null;
      state.open = state.wardId;
      render();
      WardWiseExplorer.track("menu_open", { year: state.year });
    } catch (error) {
      if (el) el.innerHTML = `<p class="report-note">Couldn't load the menu books — ${esc(error.message || "try reloading")}.</p>`;
    }
  }

  document.addEventListener("click", onClick);
  document.addEventListener("wardwise:themechange", () => { if (state.years.length) render(); });
  boot();
})();
