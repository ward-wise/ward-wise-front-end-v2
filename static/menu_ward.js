// Menu money · Ward spending: one ward, one year — where the money went by category, and every
// project line behind each bar (location, cost, the city PDF it came from).
// URL is state: /menu/ward?ward=&year=&category=
(function () {
  "use strict";
  const M = window.WardWiseMenu;
  const root = document.getElementById("mh-ward");
  if (!root) return;
  const esc = M.esc;
  const state = { data: null, ward: 1, year: null, category: null, items: null };

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const ward = Number(params.get("ward"));
    let remembered = 1;
    try { remembered = Number(localStorage.getItem("ww:menu-ward")) || 1; } catch (_error) { /* optional */ }
    state.ward = ward >= 1 && ward <= 50 ? ward : remembered;
    state.year = Number(params.get("year")) || null;
    state.category = params.get("category") || null;
  }

  function writeUrl() {
    M.setUrl("/menu/ward", { ward: state.ward, year: state.year, category: state.category });
    try { localStorage.setItem("ww:menu-ward", String(state.ward)); } catch (_error) { /* optional */ }
  }

  async function loadItems() {
    state.items = null;
    try {
      state.items = (await M.items({ ward: state.ward, year: state.year })).items || [];
    } catch (_error) {
      state.items = [];
    }
    render();
  }

  function render() {
    const data = state.data;
    const total = M.wardTotal(data, state.ward, state.year);
    const cells = M.wardCells(data, state.ward, state.year);
    const average = M.averageShares(data, state.year);
    const partial = M.isPartial(data, state.year);
    const wardMap = state.year >= 2023 ? 2023 : state.year >= 2015 ? 2015 : 2003;

    const controls = `
      <div class="ed-controls">
        <label class="report-select">Ward <select id="mh-ward-select">${M.wardOptions(state.ward)}</select></label>
        <label class="report-select">Year <select id="mh-year-select">${M.yearOptions(data, state.year)}</select></label>
        <a class="ww-linkbtn" href="/menu/compare?wards=${state.ward}&year=${state.year}">Compare with other wards →</a>
      </div>`;

    const head = total ? `
      <div class="mh-kpis">
        <div><span class="mh-kpi-value">${M.money(total.total)}</span><span class="mh-kpi-label">spent in ${state.year}${partial ? " so far" : ""}</span></div>
        <div><span class="mh-kpi-value">${total.projects.toLocaleString()}</span><span class="mh-kpi-label">project lines</span></div>
        <div><span class="mh-kpi-value">${M.pct(total.pctOfAllotment, 0)}</span><span class="mh-kpi-label">of the ~${M.money(state.year >= 2021 ? 1.5e6 : 1.32e6)} allotment</span></div>
      </div>` : `<p class="report-empty">No menu spending recorded for Ward ${state.ward} in ${state.year}.</p>`;

    const notes = [
      partial ? `${state.year} is a partial year (year-to-date quarterly report). Don't compare its totals with full years.` : null,
      wardMap !== 2023 ? `Ward ${state.ward} had different boundaries in ${state.year} (the ${wardMap} map). It isn't the same ground as today's Ward ${state.ward}.` : null,
    ].filter(Boolean).map((n) => `<p class="mh-note">${esc(n)}</p>`).join("");

    const rows = cells.map((c) => ({
      category: c.category, value: c.share, marker: average[c.category],
      label: c.category, valueLabel: `${M.pct(c.share)} · ${M.money(c.cost)}`,
      sub: `${c.projects} project${c.projects === 1 ? "" : "s"}`,
    }));

    root.innerHTML = `${controls}${head}${notes}
      <section aria-label="Spending by category">
        <p class="ed-section-label">By category <span class="mh-legend"><span class="mh-bar-marker-key"></span> average ward</span></p>
        ${M.bars(rows, { onClickAttr: "data-category", active: state.category })}
        <div id="mh-items">${itemsHtml()}</div>
      </section>
      <div id="mh-cite"></div>`;

    root.querySelector("#mh-ward-select").addEventListener("change", (e) => { state.ward = Number(e.target.value); state.category = null; writeUrl(); loadItems(); });
    root.querySelector("#mh-year-select").addEventListener("change", (e) => { state.year = Number(e.target.value); state.category = null; writeUrl(); loadItems(); });
    root.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => {
      state.category = state.category === button.dataset.category ? null : button.dataset.category;
      writeUrl();
      render();
    }));
    M.renderCite(root.querySelector("#mh-cite"), data.release, `Ward ${state.ward}, ${state.year}${state.category ? `, ${state.category}` : ""}`);
  }

  function itemsHtml() {
    if (state.items == null) return `<p class="report-loading">Loading project lines…</p>`;
    const list = state.category ? state.items.filter((r) => r.category === state.category) : state.items;
    if (!list.length) return "";
    const heading = state.category ? `${esc(state.category)}: ${list.length} project lines` : `All ${list.length} project lines, largest first`;
    return `
      <p class="ed-section-label">${heading}${state.category ? ' <button type="button" class="ww-linkbtn" data-clear>show all</button>' : ""}</p>
      <div class="mh-table-wrap"><table class="mh-table mh-items">
        <thead><tr><th>Item</th><th>Location</th><th class="mh-opt">Category</th><th class="num">Cost</th><th class="mh-opt">Source</th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td>${esc(r.item)}</td>
          <td>${esc(r.location)}${r.lat != null ? ` <a class="mh-maplink" href="/menu/map?year=${state.year}&ward=${state.ward}&focus=${esc(r.id)}" title="Show on map">map</a>` : ""}</td>
          <td class="mh-opt"><span class="mh-chip tone-${M.tone(r.category)}">${esc(M.shortName(r.category))}</span></td>
          <td class="num">${M.moneyExact(r.cost)}</td>
          <td class="mh-opt">${r.source_url ? `<a href="${esc(r.source_url)}" rel="noopener">PDF</a>` : "—"}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  }

  root.addEventListener("click", (event) => {
    if (event.target.matches("[data-clear]")) { state.category = null; writeUrl(); render(); }
  });

  readUrl();
  M.summary().then((data) => {
    state.data = data;
    const years = M.years(data);
    if (!years.includes(state.year)) state.year = M.defaultYear(data);
    writeUrl();
    render();
    loadItems();
  }).catch((error) => M.unavailable(root, error));
})();
