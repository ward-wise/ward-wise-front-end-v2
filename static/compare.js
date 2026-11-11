// Area versus area: two wards, neighborhoods or χGRIDs on the same list of measures.
//
// The verdict counts measures won; the overall strip places both among everyone; then one strip
// per measure on its REAL scale, biggest gap first, so "effectively tied" is visible rather than
// argued. Quick picks answer the questions people actually ask: the one just ahead, just behind,
// the city leader, a neighbor.
//
// URL is state: /compare?area_type=&a=&b=&m=&p=&y=
(function () {
  "use strict";
  const root = () => document.getElementById("compare-root");
  if (!root()) return;

  const esc = (t) => WardWiseExplorer.escapeHtml(t == null ? "" : String(t));
  const G = window.WardWiseGeography;
  const S = window.WardWiseScoring;
  const C = window.WardWiseCharts;

  const state = {
    manifest: null,
    cfg: G.byApi("ward"),
    areas: {},
    slices: {},
    neighbors: {},   // areaType -> Map(id -> [ids])
    weights: {},
    presetId: null,
    year: "latest",
    a: null,
    b: null,
  };

  // ---- data ----

  function areaList() {
    return state.areas[state.cfg.api] || [];
  }

  function findArea(id) {
    return areaList().find((area) => String(G.areaIdOf(area, state.cfg)) === String(id));
  }

  function nameFor(id) {
    const area = findArea(id);
    return area ? state.cfg.name(area) : String(id);
  }

  async function loadAreas(cfg) {
    if (!state.areas[cfg.api]) state.areas[cfg.api] = await cfg.loadAreas();
    return state.areas[cfg.api];
  }

  async function loadSlice(yearKey) {
    const bucket = (state.slices[state.cfg.api] ||= {});
    if (bucket[yearKey]) return bucket[yearKey];
    const data = await WardWiseExplorer.fetchJson(
      `/api/metrics/score-matrix?area_type=${encodeURIComponent(state.cfg.api)}&year=${encodeURIComponent(yearKey)}`,
      "Unable to load scores.",
    );
    // the reader's contested-direction choices (dir=) are fixed for the page, so flip once on arrival
    bucket[yearKey] = S.orientSlice((data.matrix || {})[yearKey] || {}, S.directions.flipped(state.manifest.metrics));
    return bucket[yearKey];
  }

  function currentSlice() {
    return (state.slices[state.cfg.api] || {})[String(state.year)] || {};
  }

  function metricById(id) {
    if (!state._byId) state._byId = new Map((state.manifest.metrics || []).map((m) => [m.metric_id, m]));
    return state._byId.get(id);
  }

  function availableIds() {
    const types = state.manifest.metric_area_types || {};
    return new Set((state.manifest.metrics || [])
      .filter((m) => !types[m.metric_id] || types[m.metric_id].includes(state.cfg.api))
      .map((m) => m.metric_id));
  }

  function basketIds() {
    return Object.entries(state.weights).filter(([id, w]) => Number(w) > 0 && metricById(id)).map(([id]) => id);
  }

  // ---- URL ----

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    state.dir = S.directions.apply(state.manifest.metrics, params.get("dir")); // contested readings, see scoring.js
    state.cfg = G.peerByApi(params.get("area_type") || "ward");
    const known = new Set((state.manifest.metrics || []).map((m) => m.metric_id));
    const parsed = G.parseMix(params.get("m"));
    const presetId = params.get("p");
    if (parsed) {
      state.weights = Object.fromEntries(Object.entries(parsed).filter(([id]) => known.has(id)));
      state.presetId = WardWisePresetTools.byId(presetId) ? presetId : null;
    } else {
      applyPreset(WardWisePresetTools.byId(presetId) || WardWisePresetTools.random());
    }
    const year = params.get("y");
    state.year = year && /^\d{4}$/.test(year) ? Number(year) : "latest";
    state.a = params.get("a") ? state.cfg.normalizeId(params.get("a")) : null;
    state.b = params.get("b") ? state.cfg.normalizeId(params.get("b")) : null;
  }

  function writeUrl() {
    const params = new URLSearchParams();
    params.set("area_type", state.cfg.api);
    params.set("a", state.a);
    params.set("b", state.b);
    const mix = G.serializeMix(state.weights);
    if (mix) params.set("m", mix);
    if (state.presetId) params.set("p", state.presetId);
    if (state.year !== "latest") params.set("y", String(state.year));
    if (state.dir) params.set("dir", state.dir);
    window.history.replaceState(null, "", `/compare?${params.toString()}`);
  }

  function applyPreset(preset) {
    if (!preset) return;
    const ok = availableIds();
    const { weights, used } = WardWisePresetTools.resolveWeights(
      preset, (state.manifest.metrics || []).map((m) => m.metric_id), (id) => ok.has(id));
    if (!used.length) return;
    state.weights = Object.fromEntries(Object.entries(weights).filter(([, w]) => w > 0));
    state.presetId = preset.id;
  }

  // ---- neighbors ----

  function chiNeighbors(id) {
    const match = /^(\d+)([NS])(\d+)([EW])$/i.exec(String(id));
    if (!match) return [];
    const row = Number(match[1]) * (match[2].toUpperCase() === "N" ? 1 : -1);
    const col = Number(match[3]) * (match[4].toUpperCase() === "E" ? 1 : -1);
    const ids = new Set(areaList().map((area) => String(G.areaIdOf(area, state.cfg))));
    const name = (r, c) => `${Math.abs(r)}${r >= 0 ? "N" : "S"}${Math.abs(c)}${c >= 0 ? "E" : "W"}`;
    const out = [];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const candidate = name(row + dr, col + dc);
      if (ids.has(candidate)) out.push(candidate);
    }
    return out;
  }

  async function neighborsOf(id) {
    if (state.cfg.api === "chi") return chiNeighbors(id);
    if (!state.neighbors[state.cfg.api]) {
      const geojson = await state.cfg.loadGeojson();
      const key = (pt) => `${pt[0].toFixed(5)},${pt[1].toFixed(5)}`;
      const vertices = new Map(); // vertex -> Set(area ids)
      const idProp = state.cfg.idProp;
      const walk = (coords, areaId) => {
        if (typeof coords[0] === "number") {
          const k = key(coords);
          if (!vertices.has(k)) vertices.set(k, new Set());
          vertices.get(k).add(areaId);
          return;
        }
        coords.forEach((child) => walk(child, areaId));
      };
      for (const feature of geojson.features || []) {
        const areaId = String(feature.properties?.[idProp] ?? feature.properties?.area_id ?? "");
        if (areaId && feature.geometry?.coordinates) walk(feature.geometry.coordinates, areaId);
      }
      const counts = new Map(); // "a|b" -> shared vertices
      for (const owners of vertices.values()) {
        if (owners.size < 2) continue;
        const ids = [...owners];
        for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
          const k = `${ids[i]}|${ids[j]}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
      const adjacency = new Map();
      for (const [k, n] of counts) {
        if (n < 2) continue;
        const [x, y] = k.split("|");
        if (!adjacency.has(x)) adjacency.set(x, []);
        if (!adjacency.has(y)) adjacency.set(y, []);
        adjacency.get(x).push(y);
        adjacency.get(y).push(x);
      }
      state.neighbors[state.cfg.api] = adjacency;
    }
    return state.neighbors[state.cfg.api].get(String(id)) || [];
  }

  // ---- facts ----

  function composite() {
    return S.computeComposite(currentSlice(), state.weights);
  }

  function duelFor(metricId) {
    const slice = currentSlice();
    const metric = metricById(metricId);
    const entries = Object.entries(slice)
      .filter(([, cells]) => cells && metricId in cells && Number.isFinite(Number(cells[metricId].v)))
      .map(([areaId, cells]) => ({ area_id: areaId, s: Number(cells[metricId].s), v: cells[metricId].v }))
      .sort((x, y) => y.s - x.s || String(x.area_id).localeCompare(String(y.area_id)))
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const ea = entries.find((e) => e.area_id === String(state.a));
    const eb = entries.find((e) => e.area_id === String(state.b));
    if (!metric || !ea || !eb) return null;
    const values = entries.map((e) => Number(e.v));
    const span = Math.max(1e-9, Math.max(...values) - Math.min(...values));
    return {
      metric, entries, aId: state.a, bId: state.b,
      sa: { value: ea.v, rank: ea.rank },
      sb: { value: eb.v, rank: eb.rank },
      gap: Math.abs(Number(ea.v) - Number(eb.v)) / span,
    };
  }

  // ---- renderers ----

  function listName() {
    return WardWisePresetTools.byId(state.presetId)?.name || "your list";
  }

  function renderHead() {
    const geoOptions = G.peerTypes()
      .map((cfg) => `<option value="${cfg.api}"${cfg.api === state.cfg.api ? " selected" : ""}>${esc(cfg.label)}</option>`).join("");
    const areaOptions = (selected) => areaList().map((area) => {
      const id = String(G.areaIdOf(area, state.cfg));
      return `<option value="${esc(id)}"${id === String(selected) ? " selected" : ""}>${esc(state.cfg.name(area))}</option>`;
    }).join("");
    const years = (state.manifest.data_years || []).filter((y) => y >= 2012 && y <= new Date().getFullYear()).reverse();
    const yearOptions = [`<option value="latest"${state.year === "latest" ? " selected" : ""}>Latest</option>`]
      .concat(years.map((y) => `<option value="${y}"${state.year === y ? " selected" : ""}>${y}</option>`)).join("");
    return `
      <div class="report-controls">
        <a class="ww-linkbtn" href="${esc(G.landingUrl(state.cfg.api, state.a, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}">← Map view</a>
        <label class="report-select"><span>Geography</span><select id="cp-geo">${geoOptions}</select></label>
        <label class="report-select"><span>Year</span><select id="cp-year">${yearOptions}</select></label>
      </div>
      <div class="compare-pickers">
        <label class="report-select side-a"><span>A</span><select id="cp-a">${areaOptions(state.a)}</select></label>
        <button type="button" class="compare-swap" data-act="swap" title="Swap A and B" aria-label="Swap A and B">⇄</button>
        <label class="report-select side-b"><span>B</span><select id="cp-b">${areaOptions(state.b)}</select></label>
      </div>
      <div class="compare-quick">
        <span class="soft">For B, pick:</span>
        <button type="button" class="ww-pill" data-act="quick" data-pick="ahead">just ahead of A</button>
        <button type="button" class="ww-pill" data-act="quick" data-pick="behind">just behind A</button>
        <button type="button" class="ww-pill" data-act="quick" data-pick="leader">the city leader</button>
        <button type="button" class="ww-pill" data-act="quick" data-pick="neighbor">a neighbor of A</button>
      </div>`;
  }

  function renderVerdict(duels) {
    const { byId, ranked } = composite();
    const ra = byId.get(String(state.a));
    const rb = byId.get(String(state.b));
    let winsA = 0;
    let winsB = 0;
    let ties = 0;
    for (const duel of duels) {
      if (duel.gap < 0.025) ties += 1;
      else if (duel.sa.rank < duel.sb.rank) winsA += 1;
      else winsB += 1;
    }
    const nameA = nameFor(state.a);
    const nameB = nameFor(state.b);
    const ord = (row) => (row?.rank ? `${S.ordinal(row.rank)} of ${ranked}` : "not scored");
    let line;
    if (!ra?.rank || !rb?.rank) {
      line = `One side has no score on ${esc(listName())} for this year.`;
    } else if (ra.rank === rb.rank) {
      line = `<b>Dead heat</b> on ${esc(listName())}: both ${S.ordinal(ra.rank)} of ${ranked}.`;
    } else {
      const lead = ra.rank < rb.rank ? nameA : nameB;
      const trail = ra.rank < rb.rank ? nameB : nameA;
      line = `<b>${esc(lead)} leads ${esc(trail)}</b> on ${esc(listName())}, by ${Math.abs(ra.rank - rb.rank)} place${Math.abs(ra.rank - rb.rank) === 1 ? "" : "s"}.`;
    }
    const tally = duels.length
      ? `${esc(nameA)} wins <b>${winsA}</b>, ${esc(nameB)} wins <b>${winsB}</b>${ties ? `, <b>${ties}</b> effectively tied` : ""} of ${duels.length} measures with data for both.`
      : "No measure on this list has data for both.";
    return `
      <section class="report-card compare-verdict">
        <div class="compare-sides">
          <div class="side a">
            <span class="side-tag">A</span>
            <h2 class="ww-areaname">${esc(nameA)}</h2>
            <p class="compare-ord num${S.medalClass(ra?.rank, " m-")}">${ord(ra)}</p>
            <a class="ww-linkbtn" href="${esc(G.reportUrl(state.cfg.api, state.a, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}">Full report →</a>
          </div>
          <div class="side b">
            <span class="side-tag">B</span>
            <h2 class="ww-areaname">${esc(nameB)}</h2>
            <p class="compare-ord num${S.medalClass(rb?.rank, " m-")}">${ord(rb)}</p>
            <a class="ww-linkbtn" href="${esc(G.reportUrl(state.cfg.api, state.b, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}">Full report →</a>
          </div>
        </div>
        <p class="ww-lede">${line} ${tally}</p>
        ${C.overallStrip({ rows: composite().rows, aId: state.a, bId: state.b, nameFor, noun: state.cfg.noun, listName: listName() })}
      </section>`;
  }

  function renderMix() {
    const ok = availableIds();
    const allIds = (state.manifest.metrics || []).map((m) => m.metric_id);
    const active = WardWisePresetTools.byId(state.presetId);
    const chips = WardWisePresets.map((preset) => {
      const { used, missing } = WardWisePresetTools.resolveWeights(preset, allIds, (id) => ok.has(id));
      const on = active && active.id === preset.id;
      const count = missing.length && used.length ? ` <em>${used.length}/${preset.metric_ids.length}</em>` : "";
      return `<button type="button" class="preset-chip${on ? " is-on" : ""}" data-act="preset" data-preset-id="${esc(preset.id)}" title="${esc(preset.tagline)}"${used.length ? "" : " disabled"}>${WardWisePresetTools.iconHtml(preset, (metricById(preset.icon_metric) || {}).category)}<span class="preset-chip-name">${esc(preset.name)}</span>${count}</button>`;
    }).join("");
    const ids = basketIds();
    return `
      <section class="report-card report-mix">
        <div class="preset-mixhead">Comparing on <b>${esc(active ? active.name : "Your list")}</b><span>${ids.length} measures</span></div>
        <p class="preset-note">${esc(active ? active.tagline : "the measures you picked")} · <a class="ww-linkbtn" href="${esc(G.reportUrl(state.cfg.api, state.a, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}">edit the list on A's report</a></p>
        <div class="preset-chips">${chips}</div>
      </section>`;
  }

  function renderDuels(duels) {
    const ok = availableIds();
    const missing = basketIds().filter((id) => !duels.some((d) => d.metric.metric_id === id));
    const strips = duels.map((duel) => C.fieldStrip(duel, { nameFor })).join("");
    const note = missing.length
      ? `<p class="soft compare-missing">Not compared (no data for one side${missing.some((id) => !ok.has(id)) ? ` or no ${esc(state.cfg.noun)} version` : ""}): ${esc(missing.map((id) => metricById(id)?.label || id).join(", "))}.</p>`
      : "";
    return `
      <section class="report-card compare-duels">
        <div class="ww-mainhead">Measure by measure<span>biggest gap first · every mark is one ${esc(state.cfg.noun)} on the real scale</span></div>
        <div class="ww-pairkey"><span class="ka">▎ ${esc(nameFor(state.a))}</span><span class="kb">▎ ${esc(nameFor(state.b))}</span></div>
        ${strips || `<p class="soft">Nothing to compare yet.</p>`}
        ${note}
      </section>`;
  }

  function render() {
    const el = root();
    if (!el) return;
    document.title = `${nameFor(state.a)} vs ${nameFor(state.b)} — Ward Wise`;
    const duels = basketIds().map(duelFor).filter(Boolean).sort((x, y) => y.gap - x.gap);
    el.innerHTML = renderHead() + renderVerdict(duels) + renderMix() + renderDuels(duels);
    C.attachTips(el);
    wireControls();
    writeUrl();
  }

  function wireControls() {
    document.getElementById("cp-geo")?.addEventListener("change", async (event) => {
      state.cfg = G.byApi(event.target.value);
      await loadAreas(state.cfg);
      await loadSlice(String(state.year));
      const ranked = composite().rows.filter((r) => r.rank);
      state.a = String(ranked[0]?.area_id ?? G.areaIdOf(areaList()[0], state.cfg));
      state.b = String(ranked[1]?.area_id ?? state.a);
      render();
    });
    document.getElementById("cp-year")?.addEventListener("change", async (event) => {
      state.year = event.target.value === "latest" ? "latest" : Number(event.target.value);
      await loadSlice(String(state.year));
      render();
    });
    document.getElementById("cp-a")?.addEventListener("change", (event) => pick("a", event.target.value));
    document.getElementById("cp-b")?.addEventListener("change", (event) => pick("b", event.target.value));
  }

  // Choosing the same area on both sides swaps them instead of comparing a place to itself.
  function pick(side, id) {
    const other = side === "a" ? "b" : "a";
    if (String(id) === String(state[other])) state[other] = state[side];
    state[side] = String(id);
    WardWiseExplorer.track("compare_pick", { area_type: state.cfg.api, side });
    render();
  }

  async function quickPick(kind) {
    const { rows, byId } = composite();
    const ranked = rows.filter((r) => r.rank);
    const ra = byId.get(String(state.a));
    let target = null;
    if (kind === "ahead" && ra?.rank) target = ranked.find((r) => r.rank === ra.rank - 1) || ranked.find((r) => r.rank === ra.rank + 1);
    if (kind === "behind" && ra?.rank) target = ranked.find((r) => r.rank === ra.rank + 1) || ranked.find((r) => r.rank === ra.rank - 1);
    if (kind === "leader") target = ranked[0]?.area_id === String(state.a) ? ranked[1] : ranked[0];
    if (kind === "neighbor") {
      const ids = (await neighborsOf(state.a)).filter((id) => id !== String(state.b));
      if (ids.length) {
        // the neighbor closest in standing, so the comparison is the interesting one
        ids.sort((x, y) => Math.abs((byId.get(x)?.rank ?? 999) - (ra?.rank ?? 0)) - Math.abs((byId.get(y)?.rank ?? 999) - (ra?.rank ?? 0)));
        target = { area_id: ids[0] };
      }
    }
    if (target) pick("b", target.area_id);
  }

  function onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "swap") {
      [state.a, state.b] = [state.b, state.a];
      render();
    } else if (act === "quick") {
      quickPick(target.dataset.pick);
    } else if (act === "preset") {
      applyPreset(WardWisePresetTools.byId(target.dataset.presetId));
      render();
    }
  }

  async function boot() {
    const el = root();
    try {
      state.manifest = await WardWiseExplorer.fetchExplorerManifest();
      readUrl();
      await loadAreas(state.cfg);
      await loadSlice(String(state.year));
      if (state.year !== "latest" && !Object.keys(currentSlice()).length) {
        state.year = "latest";
        await loadSlice("latest");
      }
      const ranked = composite().rows.filter((r) => r.rank);
      if (!state.a || !findArea(state.a)) state.a = String(ranked[0]?.area_id ?? G.areaIdOf(areaList()[0], state.cfg));
      if (!state.b || !findArea(state.b) || state.b === state.a) {
        const ra = composite().byId.get(String(state.a));
        const next = ranked.find((r) => r.rank === (ra?.rank || 1) - 1) || ranked.find((r) => r.rank === (ra?.rank || 0) + 1) || ranked[1];
        state.b = String(next?.area_id ?? state.a);
      }
      render();
      WardWiseExplorer.track("compare_open", { area_type: state.cfg.api });
    } catch (error) {
      if (el) el.innerHTML = `<p class="report-note">Couldn't load the comparison — ${esc(error.message || "try reloading")}.</p>`;
    }
  }

  document.addEventListener("click", onClick);
  document.addEventListener("wardwise:themechange", () => { if (state.manifest && state.a) render(); });
  boot();
})();
