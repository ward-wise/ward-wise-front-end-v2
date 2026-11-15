// Menu money · Costs: what wards actually paid for each kind of project — how many there are, how
// much the cost varies, how it moved over time and across wards, and the cheapest and most expensive
// examples (each linked to the city PDF). ?type=<id> opens one type.
(function () {
  "use strict";
  const M = window.WardWiseMenu;
  const root = document.getElementById("mh-costs");
  if (!root) return;
  const esc = M.esc;
  let release = null;

  const explainer = `
    <details class="mc-explain" open>
      <summary>How these numbers are made</summary>
      <ul>
        <li><strong>Each cost is one project line</strong> in the city's menu postings: the amount charged against a ward's allotment, usually CDOT's estimate when the project was approved, not an audited final bill.</li>
        <li><strong>The menu price is an average.</strong> CDOT lists a typical price per block or per item, then estimates each project on its own length, condition and add-ons (ADA ramps, speed-hump replacement, concrete under asphalt). That's why one kind of project spans a wide range.</li>
        <li><strong>Per block</strong> (resurfacing, sidewalks, curb, lighting): when a location gives address numbers ("1600 N to 1900 N"), the block count is the span ÷ 100, since Chicago's grid runs about 8 blocks to the mile. It's an estimate: blocks vary.</li>
        <li><strong>The smallest amounts</strong> are often partial charges or adjustments to an earlier project, not whole projects. The middle half (25th–75th percentile) is the honest "typical" range.</li>
      </ul>
    </details>`;

  function sparkline(series) {
    if (!series || series.length < 2) return "";
    const w = 110, h = 26, pad = 2;
    const xs = series.map((p) => p[0]), ys = series.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys);
    const sx = (x) => pad + ((w - 2 * pad) * (x - x0)) / Math.max(1, x1 - x0);
    const sy = (y) => h - pad - ((h - 2 * pad) * (y - lo)) / Math.max(1, hi - lo);
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="mc-spark" aria-hidden="true"><path d="${series.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("")}" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }

  function list(payload) {
    const rows = payload.types.slice().sort((a, b) => b.n - a.n);
    root.innerHTML = `${explainer}
      <div class="mh-table-wrap mh-swipe"><table class="mh-table mc-list">
        <thead><tr><th>Kind of project</th><th class="num">Projects</th><th class="num">Typical (median)</th><th class="num">Middle half</th><th class="num">Cheapest – priciest</th><th class="num">Per block</th><th class="mh-opt">Median over time</th></tr></thead>
        <tbody>${rows.map((t) => {
          const l = t.latest || {};
          return `<tr>
            <th><a href="/menu/costs?type=${encodeURIComponent(t.type)}">${esc(t.label)}</a><br><span class="mp-meta">${t.years[0]}–${t.years[1]}${l.year ? ` · figures for ${l.year}` : ""}</span></th>
            <td class="num">${t.n.toLocaleString()}</td>
            <td class="num">${M.money(l.median)}</td>
            <td class="num">${l.p25 != null ? `${M.money(l.p25)}–${M.money(l.p75)}` : "—"}</td>
            <td class="num">${l.min != null ? `${M.money(l.min)} – ${M.money(l.max)}` : "—"}</td>
            <td class="num">${l.block_median != null ? M.money(l.block_median) : "—"}</td>
            <td class="mh-opt">${sparkline(t.median_series)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      <p class="mh-note">${Math.round(100 * (payload.method.classified_share || 0))}% of all project lines fall into one of these kinds. How item names were grouped is in the
        <a href="${M.DATA_REPO}/blob/main/data/menu_item_types.csv">data repository</a>.</p>
      <div id="mh-cite"></div>`;
    M.renderCite(root.querySelector("#mh-cite"), release, "what wards paid, by kind of project");
  }

  // Range chart: per year, p10–p90 (thin), p25–p75 (thick), median (dot); optional menu-price line.
  function rangeChart(rows, keys, priceRows) {
    const pts = rows.filter((r) => r[keys.median] != null);
    if (pts.length < 2) return `<p class="mh-note">Too few projects per year to chart a range.</p>`;
    const w = 720, h = 260, left = 64, right = 12, top = 12, bottom = 28;
    const years = pts.map((r) => r.year);
    const prices = (priceRows || []).filter((p) => p.unit_cost != null && p.menu_year >= years[0] - 1 && p.menu_year <= years[years.length - 1] + 1);
    const hi = Math.max(...pts.map((r) => r[keys.p90] ?? r[keys.p75]), ...prices.map((p) => p.unit_cost));
    const sx = (y) => left + ((w - left - right) * (y - years[0])) / Math.max(1, years[years.length - 1] - years[0]);
    const sy = (v) => top + (h - top - bottom) * (1 - v / (hi * 1.05));
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => hi * f);
    const band = (r) => `
      <line x1="${sx(r.year)}" x2="${sx(r.year)}" y1="${sy(r[keys.p10] ?? r[keys.p25])}" y2="${sy(r[keys.p90] ?? r[keys.p75])}" class="mc-whisker"/>
      <line x1="${sx(r.year)}" x2="${sx(r.year)}" y1="${sy(r[keys.p25])}" y2="${sy(r[keys.p75])}" class="mc-box"/>
      <circle cx="${sx(r.year)}" cy="${sy(r[keys.median])}" r="3.2" class="mc-median"><title>${r.year}: median ${M.moneyExact(r[keys.median])}, middle half ${M.moneyExact(r[keys.p25])}–${M.moneyExact(r[keys.p75])}, n=${r[keys.n]}</title></circle>`;
    const priceDots = prices.map((p) => `<rect x="${sx(p.menu_year) - 4}" y="${sy(p.unit_cost) - 4}" width="8" height="8" class="mc-price mp-${esc(p.verification)}"><title>Menu price ${p.menu_year}: ${M.moneyExact(p.unit_cost)} per ${esc(p.unit)} (${esc(p.verification)})</title></rect>`).join("");
    return `<figure class="mc-chart">
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Cost range by year">
        ${ticks.map((v) => `<line x1="${left}" x2="${w - right}" y1="${sy(v)}" y2="${sy(v)}" class="mc-grid"/><text x="${left - 6}" y="${sy(v) + 4}" text-anchor="end" class="mc-axis">${M.money(v)}</text>`).join("")}
        ${years.filter((y, i) => i % Math.ceil(years.length / 11) === 0 || i === years.length - 1).map((y) => `<text x="${sx(y)}" y="${h - 8}" text-anchor="middle" class="mc-axis">${y}</text>`).join("")}
        ${pts.map(band).join("")}
        ${priceDots}
      </svg>
      <figcaption><span class="mc-key mc-key-box"></span> middle half of projects · <span class="mc-key mc-key-whisker"></span> 10th–90th percentile · <span class="mc-key mc-key-median"></span> median${prices.length ? ' · <span class="mc-key mc-key-price"></span> menu price (from the Price list)' : ""}</figcaption>
    </figure>`;
  }

  function wardStrip(rows, key) {
    const pts = rows.filter((r) => r[key] != null && (key === "median" ? r.n : r.n_per_block) >= 1)
      .sort((a, b) => a[key] - b[key]);
    if (pts.length < 5) return `<p class="mh-note">Too few wards with this kind of project in the window to compare.</p>`;
    const max = Math.max(...pts.map((r) => r[key]));
    return `<ol class="mc-wards">${pts.map((r) => {
      const n = key === "median" ? r.n : r.n_per_block;
      return `<li title="Ward ${r.ward}: ${M.moneyExact(r[key])} median over ${n} project${n === 1 ? "" : "s"}">
        <span class="mc-ward-bar" style="height:${Math.max(2, (100 * r[key]) / max)}%"></span><span class="mc-ward-label">${r.ward}</span></li>`;
    }).join("")}</ol>`;
  }

  function exampleCards(title, list, perBlock) {
    if (!list || !list.length) return "";
    return `<div class="mc-examples"><p class="ed-section-label">${esc(title)}</p><ol>${list.map((e) => `
      <li>
        <span class="mc-ex-cost">${M.moneyExact(perBlock ? e.per_block : e.cost)}${perBlock ? " per block" : ""}</span>
        <span class="mc-ex-meta">Ward ${e.ward} · ${e.year}${perBlock ? ` · ${M.moneyExact(e.cost)} for ~${e.blocks} blocks` : e.blocks ? ` · ~${e.blocks} blocks` : ""}</span>
        <span class="mc-ex-loc">${esc(e.item)} — ${esc(e.location)}</span>
        <span class="mc-ex-links"><a href="/menu/ward?ward=${e.ward}&year=${e.year}">ward's year</a>${e.source_url ? ` · <a href="${esc(e.source_url)}" rel="noopener">source PDF</a>` : ""}</span>
      </li>`).join("")}</ol></div>`;
  }

  function detail(payload, priceRows) {
    const t = payload.type;
    const method = payload.method || {};
    const perBlock = t.unit === "block" && t.n_per_block > 0;
    let mode = new URLSearchParams(window.location.search).get("per") === "project" || !perBlock ? "project" : "block";
    const keysFor = (m) => (m === "block"
      ? { n: "n_per_block", median: "block_median", p10: "block_p10", p25: "block_p25", p75: "block_p75", p90: "block_p90" }
      : { n: "n", median: "median", p10: "p10", p25: "p25", p75: "p75", p90: "p90" });
    // Only overlay menu prices whose unit matches what's plotted.
    const pricesFor = (m) => priceRows.filter((p) => (m === "block" ? /^block/.test(p.unit) : !/^(block|half-mile|alley)/.test(p.unit)));

    function render() {
      const complete = t.by_year.filter((r) => !r.partial_year);
      const first = complete.find((r) => r[keysFor(mode).median] != null);
      const last = complete.slice().reverse().find((r) => r[keysFor(mode).median] != null);
      const k = keysFor(mode);
      const change = first && last && first !== last ? ((last[k.median] / first[k.median]) - 1) * 100 : null;
      const names = Object.entries(t.names || {}).map(([n, c]) => `${esc(n)} (${c.toLocaleString()})`).join(" · ");
      root.innerHTML = `
        <p><a href="/menu/costs">← All kinds of project</a></p>
        <h2 class="mp-title">${esc(t.label)}</h2>
        <div class="mh-kpis">
          <div><span class="mh-kpi-value">${t.n.toLocaleString()}</span><span class="mh-kpi-label">project lines, ${t.years[0]}–${t.years[1]}</span></div>
          <div><span class="mh-kpi-value">${M.money(t.total)}</span><span class="mh-kpi-label">spent in all</span></div>
          ${last ? `<div><span class="mh-kpi-value">${M.money(last[k.median])}</span><span class="mh-kpi-label">median ${mode === "block" ? "per block" : "per project"}, ${last.year}</span></div>` : ""}
          ${change != null ? `<div><span class="mh-kpi-value">${change >= 0 ? "+" : ""}${change.toFixed(0)}%</span><span class="mh-kpi-label">median, ${first.year}→${last.year} (not inflation-adjusted)</span></div>` : ""}
        </div>
        ${perBlock ? `<div class="mh-toggle" role="group" aria-label="Measure">
          <button type="button" data-per="block" aria-pressed="${mode === "block"}">Per block</button>
          <button type="button" data-per="project" aria-pressed="${mode === "project"}">Per project</button></div>
          <p class="mh-note">${mode === "block" ? `Per block uses the ${t.n_per_block.toLocaleString()} projects whose location gives an address range.` : "Per project mixes one-block jobs with ten-block jobs, so it spreads wider."}</p>` : ""}
        <p class="ed-section-label">How the cost has moved</p>
        ${rangeChart(t.by_year, k, pricesFor(mode))}
        <p class="ed-section-label">Across wards, ${method.ward_window ? `${method.ward_window[0]}–${method.ward_window[1]}` : "recent years"} (median ${mode === "block" ? "per block" : "per project"}, lowest to highest)</p>
        ${wardStrip(t.by_ward, mode === "block" ? "block_median" : "median")}
        <div class="mc-example-grid">
          ${mode === "block" ? exampleCards("Low end per block (around the 5th percentile)", t.low_per_block, true) + exampleCards("High end per block (around the 95th percentile)", t.high_per_block, true)
            : exampleCards("Smallest charges", t.cheapest, false) + exampleCards("Largest projects", t.priciest, false)}
        </div>
        <p class="mh-note">Examples are from ${esc(t.examples_window || "")}.${mode === "project" ? " The smallest charges are often adjustments, not whole projects." : " Per-block examples are near the 5th and 95th percentile rather than the absolute extremes, which are mostly errors in the posted address ranges."}</p>
        <details class="mc-names"><summary>Which item names count as "${esc(t.label)}"</summary><p>${names}</p></details>
        ${explainer.replace(" open>", ">")}
        <div id="mh-cite"></div>`;
      root.querySelectorAll("[data-per]").forEach((b) => b.addEventListener("click", () => {
        mode = b.dataset.per;
        M.setUrl("/menu/costs", { type: t.type, per: mode === "project" && perBlock ? "project" : null });
        render();
      }));
      M.renderCite(root.querySelector("#mh-cite"), release, `what wards paid: ${t.label}${mode === "block" ? ", per block" : ""}`);
    }
    render();
  }

  const type = new URLSearchParams(window.location.search).get("type");
  const costsUrl = type ? `/api/menu/costs?type=${encodeURIComponent(type)}` : "/api/menu/costs";
  Promise.all([WardWiseExplorer.fetchJson(costsUrl, "Unable to load cost tables."), type ? M.prices().catch(() => ({ price_list: [] })) : null])
    .then(([payload, prices]) => {
      release = payload.release;
      if (type) detail(payload, ((prices && prices.price_list) || []).filter((p) => p.item_slug === payload.type.type));
      else list(payload);
    })
    .catch((error) => M.unavailable(root, error));
})();
