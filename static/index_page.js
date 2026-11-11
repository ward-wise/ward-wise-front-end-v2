// The index of fifty: every ward (or neighborhood, or χGRID) as one line of a newspaper index —
// its number, who holds the seat, its rank at the right, and a headline sentence — re-ranked live
// as the reader weights the eleven wellbeing domains ("Not really / Somewhat / A lot") or starts
// from a curated list. A second view shows the same fifty as cards with a domain fingerprint.
//
// Movement (▲/▼) is always measured against the default equation, every measure counted once,
// so the panel can never disagree with itself.
//
// URL is state: /index?area=&e=<domain:level,…>&p=<list>&m=<mix>&y=&sort=&q=&view=cards&lens=&t=1
(function () {
  "use strict";
  const root = () => document.getElementById("index-root");
  const body = () => document.getElementById("index-body");
  if (!root()) return;

  const esc = (t) => WardWiseExplorer.escapeHtml(t == null ? "" : String(t));
  const G = window.WardWiseGeography;
  const S = window.WardWiseScoring;
  const C = window.WardWiseCharts;

  const CHUNK = 80;                      // rows rendered per scroll step (wards and neighborhoods fit in one)
  const FIRST_YEAR = 2012;
  const SPARK_YEARS = [2013, 2016, 2019, 2022];
  const MAX_SPARK_FETCHES = { ward: 5, community_area: 5, chi: 0, precinct: 0 };
  // An unknown geography must read as "no sparklines", never as slice(NaN) fetching every year.
  const sparkFetches = () => MAX_SPARK_FETCHES[state.cfg.api] ?? 0;
  const SORTS = ["number", "rank", "name", "riser", "faller"];
  const LEVELS = [["Not really", 0], ["Somewhat", 1], ["A lot", 2]];
  const NARRATIVES_LIVE = true;

  const state = {
    manifest: null,
    cfg: G.byApi("ward"),
    areas: {},
    slices: {},
    year: "latest",
    mode: "equation",       // equation | list
    catWeights: {},         // domain -> 0 | 1 | 2 (equation mode)
    weights: {},            // metric weights actually counted
    presetId: null,         // list mode: the curated list, or null for a custom mix
    view: "list",           // list | cards
    sort: "number",
    q: "",
    lens: null,
    trend: false,
    sparkStatus: "idle",
    order: [],
    nodes: new Map(),
    rendered: new Set(),
    domainCache: {},
    headlines: {},
    terms: null,
  };

  // ---- data ----

  function areaList() {
    return state.areas[state.cfg.api] || [];
  }

  function findArea(id) {
    return areaList().find((area) => String(G.areaIdOf(area, state.cfg)) === String(id));
  }

  async function loadAreas(cfg) {
    if (!state.areas[cfg.api]) state.areas[cfg.api] = await cfg.loadAreas();
    return state.areas[cfg.api];
  }

  async function loadSlice(yearKey, areaType = state.cfg.api) {
    const bucket = (state.slices[areaType] ||= {});
    if (bucket[yearKey]) return bucket[yearKey];
    const data = await WardWiseExplorer.fetchJson(
      `/api/metrics/score-matrix?area_type=${encodeURIComponent(areaType)}&year=${encodeURIComponent(yearKey)}`,
      "Unable to load scores.",
    );
    // the reader's contested-direction choices (dir=) are fixed for the page, so flip once on arrival
    bucket[yearKey] = S.orientSlice((data.matrix || {})[yearKey] || {}, S.directions.flipped(state.manifest.metrics));
    return bucket[yearKey];
  }

  function currentSlice() {
    return (state.slices[state.cfg.api] || {})[String(state.year)] || {};
  }

  function metricsForGeography() {
    const types = state.manifest.metric_area_types || {};
    return (state.manifest.metrics || []).filter((metric) => {
      const list = types[metric.metric_id];
      return !list || list.includes(state.cfg.api);
    });
  }

  function metricById(id) {
    if (!state._metricById) state._metricById = new Map((state.manifest.metrics || []).map((m) => [m.metric_id, m]));
    return state._metricById.get(id);
  }

  function availableIds() {
    return new Set(metricsForGeography().map((m) => m.metric_id));
  }

  function domains() {
    const counts = new Map();
    for (const metric of metricsForGeography()) {
      const key = metric.category || "other";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.keys()].sort().map((key) => ({ key, label: C.humanizeDomain(key), count: counts.get(key) }));
  }

  // ---- weights ----

  function defaultWeights() {
    return Object.fromEntries(metricsForGeography().map((m) => [m.metric_id, 1]));
  }

  function equationWeights(catWeights) {
    const out = {};
    for (const metric of metricsForGeography()) {
      const level = catWeights[metric.category || "other"];
      out[metric.metric_id] = level == null ? 1 : Number(level);
    }
    return out;
  }

  function isDefaultEquation() {
    return domains().every((d) => (state.catWeights[d.key] ?? 1) === 1);
  }

  function presetWeights(preset) {
    const ok = availableIds();
    return WardWisePresetTools.resolveWeights(preset, (state.manifest.metrics || []).map((m) => m.metric_id), (id) => ok.has(id));
  }

  function usablePreset(preset) {
    return preset && presetWeights(preset).used.length ? preset : null;
  }

  function weightsOf(preset) {
    return Object.fromEntries(Object.entries(presetWeights(preset).weights).filter(([, w]) => w > 0));
  }

  function basketIds() {
    return Object.entries(state.weights).filter(([id, w]) => Number(w) > 0 && metricById(id)).map(([id]) => id);
  }

  function edited() {
    return state.mode === "list" || !isDefaultEquation();
  }

  function recomputeWeights() {
    if (state.mode === "equation") state.weights = equationWeights(state.catWeights);
  }

  // ---- URL ----

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    state.dir = S.directions.apply(state.manifest.metrics, params.get("dir")); // contested readings, see scoring.js
    state.cfg = G.peerByApi(params.get("area") || "ward");
    const year = params.get("y");
    state.year = year && /^\d{4}$/.test(year) ? Number(year) : "latest";
    state.sort = SORTS.includes(params.get("sort")) ? params.get("sort") : "number";
    state.q = params.get("q") || "";
    state.lens = params.get("lens") || null;
    state.trend = params.get("t") === "1";
    state.view = params.get("view") === "cards" ? "cards" : "list";
    state._urlPreset = params.get("p");
    state._urlMix = params.get("m");
    state._urlEquation = params.get("e");
  }

  // Weights depend on the geography (a list can be empty for χGRIDs), so they resolve after the
  // manifest and geography are known.
  function resolveWeights() {
    const known = new Set((state.manifest.metrics || []).map((m) => m.metric_id));
    const parsed = G.parseMix(state._urlMix);
    const preset = usablePreset(WardWisePresetTools.byId(state._urlPreset));
    if (parsed && Object.keys(parsed).some((id) => known.has(id))) {
      state.mode = "list";
      state.weights = Object.fromEntries(Object.entries(parsed).filter(([id]) => known.has(id)));
      state.presetId = WardWisePresetTools.matchPreset?.(state.weights, (id) => availableIds().has(id))?.id || null;
    } else if (preset) {
      state.mode = "list";
      state.weights = weightsOf(preset);
      state.presetId = preset.id;
    } else {
      state.mode = "equation";
      state.catWeights = {};
      for (const token of String(state._urlEquation || "").split(",")) {
        const [key, level] = token.split(":");
        if (key && ["0", "1", "2"].includes(level)) state.catWeights[key] = Number(level);
      }
      state.presetId = null;
      recomputeWeights();
    }
    state.lens = state.lens && domains().some((d) => d.key === state.lens) ? state.lens : null;
    if (sparkFetches() === 0) state.trend = false;
  }

  function equationParam() {
    return domains().filter((d) => (state.catWeights[d.key] ?? 1) !== 1).map((d) => `${d.key}:${state.catWeights[d.key]}`).join(",");
  }

  function writeUrl() {
    const params = new URLSearchParams();
    params.set("area", state.cfg.api);
    if (state.mode === "list") {
      if (state.presetId) params.set("p", state.presetId);
      const mix = G.serializeMix(state.weights);
      if (mix && !state.presetId) params.set("m", mix);
    } else if (!isDefaultEquation()) {
      params.set("e", equationParam());
    }
    if (state.year !== "latest") params.set("y", String(state.year));
    if (state.dir) params.set("dir", state.dir);
    if (state.sort !== "number") params.set("sort", state.sort);
    if (state.q) params.set("q", state.q);
    if (state.view === "cards") params.set("view", "cards");
    if (state.lens) params.set("lens", state.lens);
    if (state.trend) params.set("t", "1");
    window.history.replaceState(null, "", `/index?${params.toString()}`);
  }

  // ---- facts ----

  function domainIndexes() {
    const key = `${state.cfg.api}|${state.year}`;
    if (!state.domainCache[key]) state.domainCache[key] = S.domainIndexes(currentSlice(), metricsForGeography());
    return state.domainCache[key];
  }

  function composite() {
    return S.computeComposite(currentSlice(), state.weights);
  }

  function baselineRanks() {
    const key = `${state.cfg.api}|${state.year}`;
    if (!state._baseline || state._baseline.key !== key) {
      state._baseline = { key, byId: S.computeComposite(currentSlice(), defaultWeights()).byId };
    }
    return state._baseline.byId;
  }

  function listName() {
    if (state.mode === "list") return WardWisePresetTools.byId(state.presetId)?.name || "your list";
    return isDefaultEquation() ? "the default equation" : "your equation";
  }

  function countWord(n) {
    return n === 50 ? "fifty" : String(n);
  }

  // who holds the seat (wards), which wards cover it (neighborhoods), the long name (χGRIDs)
  function whoFor(area) {
    if (state.cfg.api === "ward") {
      const id = String(area.ward_id);
      const terms = state.terms?.terms;
      if (!terms) return "";
      const keys = Object.keys(terms).map(Number).sort((a, b) => b - a);
      for (const key of keys) {
        const member = terms[key]?.wards?.[id]?.members?.slice(-1)[0]?.name;
        if (member) return tidyName(member);
      }
      return "";
    }
    return state.cfg.sub(area);
  }

  function tidyName(name) {
    const parts = String(name).split(",");
    return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
  }

  // the number that leads each line: ward number, neighborhood name, χGRID id
  function numFor(area, id) {
    if (state.cfg.api === "ward") return String(Number(area?.ward_number || id));
    if (state.cfg.api === "community_area") return state.cfg.name(area);
    return state.cfg.short(area) || String(id);
  }

  // a written headline when one exists, else the domain readout the ward report prints
  function headlineFor(id) {
    if (state.headlines[String(id)]) return state.headlines[String(id)];
    const rows = (domainIndexes().byArea.get(String(id)) || []).filter((d) => !d.muted);
    if (rows.length < 2) return "";
    const strongest = rows.reduce((a, b) => (b.rank < a.rank ? b : a));
    const weakest = rows.reduce((a, b) => (b.rank > a.rank ? b : a));
    if (strongest === weakest) return "";
    return `Strongest on ${C.humanizeDomain(strongest.domain)} (${S.ordinal(strongest.rank)} of ${strongest.of}), weakest on ${C.humanizeDomain(weakest.domain)} (${S.ordinal(weakest.rank)}).`;
  }

  function facts() {
    const { rows } = composite();
    const base = baselineRanks();
    return rows.map((row) => {
      const area = findArea(row.area_id);
      const before = base.get(String(row.area_id))?.rank || null;
      const delta = row.rank && before ? before - row.rank : null;
      const name = area ? state.cfg.name(area) : String(row.area_id);
      const who = area ? whoFor(area) : "";
      return {
        ...row,
        area,
        name,
        num: numFor(area, row.area_id),
        who,
        sub: area ? state.cfg.sub(area) : "",
        delta,
        key: `${name} ${area ? state.cfg.sub(area) : ""} ${row.area_id} ${who}`.toLowerCase(),
      };
    });
  }

  function orderIds(rows) {
    const list = [...rows];
    const byRank = (a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name);
    const byNumber = (a, b) => state.cfg.api === "ward"
      ? Number(a.area_id) - Number(b.area_id)
      : a.name.localeCompare(b.name, undefined, { numeric: true });
    if (state.sort === "rank") list.sort(byRank);
    else if (state.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (state.sort === "riser") list.sort((a, b) => (b.delta ?? -1e9) - (a.delta ?? -1e9) || byRank(a, b));
    else if (state.sort === "faller") list.sort((a, b) => (a.delta ?? 1e9) - (b.delta ?? 1e9) || byRank(a, b));
    else list.sort(byNumber);
    return list.map((row) => String(row.area_id));
  }

  // ---- renderers ----

  function renderControls() {
    const geoOptions = G.peerTypes()
      .map((cfg) => `<option value="${cfg.api}"${cfg.api === state.cfg.api ? " selected" : ""}>${esc(cfg.label)}</option>`)
      .join("");
    const years = (state.manifest.data_years || []).filter((y) => y >= FIRST_YEAR && y <= new Date().getFullYear()).reverse();
    const yearOptions = [`<option value="latest"${state.year === "latest" ? " selected" : ""}>Latest</option>`]
      .concat(years.map((y) => `<option value="${y}"${state.year === y ? " selected" : ""}>${y}</option>`))
      .join("");
    const numberLabel = state.cfg.api === "ward" ? "Ward number" : "Name";
    const sortOptions = [["number", numberLabel], ["rank", "Rank"], ["riser", "Biggest risers"], ["faller", "Biggest fallers"]]
      .map(([value, label]) => `<option value="${value}"${state.sort === value ? " selected" : ""}>${label}</option>`).join("");
    const lensOptions = [`<option value="">None</option>`]
      .concat(domains().map((d) => `<option value="${esc(d.key)}"${state.lens === d.key ? " selected" : ""}>${esc(d.label)}</option>`))
      .join("");
    const cards = state.view === "cards";
    const sparkOk = sparkFetches() > 0;
    const back = G.landingUrl(state.cfg.api, null, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir });
    return `
      <div class="ed-controls">
        <a class="ww-linkbtn" href="${esc(back)}">← Map view</a>
        <label class="report-select"><span>Geography</span><select id="ix-geo">${geoOptions}</select></label>
        <label class="report-select"><span>Year</span><select id="ix-year">${yearOptions}</select></label>
        <label class="report-select"><span>Order</span><select id="ix-sort">${sortOptions}</select></label>
        <label class="report-select"><span>View</span><select id="ix-view"><option value="list"${cards ? "" : " selected"}>Index</option><option value="cards"${cards ? " selected" : ""}>Fingerprints</option></select></label>
        ${cards ? `<label class="report-select"><span>Lens</span><select id="ix-lens">${lensOptions}</select></label>` : ""}
        <label class="report-select"><span>Find</span><input type="search" id="ix-q" value="${esc(state.q)}" placeholder="name, number, alderperson"></label>
        ${cards ? `<label class="ed-toggle" title="${sparkOk ? "Score at five points in time" : `Trend lines are off for ${esc(state.cfg.plural)}: each year is a large download`}"><input type="checkbox" id="ix-trend"${state.trend ? " checked" : ""}${sparkOk ? "" : " disabled"}><span>Show trend</span></label>` : ""}
      </div>`;
  }

  function countingLine() {
    const ids = basketIds().filter((id) => state.weights[id] > 0);
    if (state.mode === "list") {
      const active = WardWisePresetTools.byId(state.presetId);
      return `Counting <b>${esc(active ? active.name : "your list")}</b>, ${ids.length} measure${ids.length === 1 ? "" : "s"}.`;
    }
    return isDefaultEquation()
      ? "Counting every measure once, the site's default equation."
      : `Counting <b>your equation</b>: ${ids.length} measures, weighted by domain.`;
  }

  function renderEquation() {
    const inList = state.mode === "list";
    const fields = domains().map((d) => {
      const level = inList ? null : (state.catWeights[d.key] ?? 1);
      const options = LEVELS.map(([label, value]) =>
        `<label class="equation-choice"><input type="radio" name="cat-${esc(d.key)}" value="${value}"${level === value ? " checked" : ""}${inList ? " disabled" : ""}><span>${label}</span></label>`).join("");
      return `<fieldset class="equation-cat"><legend>${esc(d.label)} <span class="equation-count">${d.count} measure${d.count === 1 ? "" : "s"}</span></legend><div class="equation-choices">${options}</div></fieldset>`;
    }).join("");
    const ok = availableIds();
    const allIds = (state.manifest.metrics || []).map((m) => m.metric_id);
    const active = WardWisePresetTools.byId(state.presetId);
    const chips = WardWisePresets.map((preset) => {
      const { used, missing } = WardWisePresetTools.resolveWeights(preset, allIds, (id) => ok.has(id));
      const on = inList && active && active.id === preset.id;
      const count = missing.length && used.length ? ` <em>${used.length}/${preset.metric_ids.length}</em>` : "";
      return `<button type="button" class="preset-chip${on ? " is-on" : ""}" data-act="preset" data-preset-id="${esc(preset.id)}" title="${esc(preset.tagline)}"${used.length ? "" : " disabled"}>${WardWisePresetTools.iconHtml(preset, (metricById(preset.icon_metric) || {}).category)}<span class="preset-chip-name">${esc(preset.name)}</span>${count}</button>`;
    }).join("");
    const ids = basketIds();
    const pills = inList ? ids.map((id) => {
      const metric = metricById(id);
      const weight = Number(state.weights[id]);
      return `<button type="button" class="ww-pill on" data-act="remove" data-metric-id="${esc(id)}" title="Remove ${esc(metric.label)} from the list">${esc(metric.label)}${weight !== 1 ? ` <em>×${weight}</em>` : ""} <span class="x" aria-hidden="true">×</span></button>`;
    }).join("") : "";
    const byDomain = new Map();
    for (const metric of metricsForGeography()) {
      if (inList && ids.includes(metric.metric_id)) continue;
      const key = metric.category || "other";
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key).push(metric);
    }
    const addOptions = [...byDomain.keys()].sort().map((domain) =>
      `<optgroup label="${esc(domain.replaceAll("_", " "))}">${byDomain.get(domain)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((m) => `<option value="${esc(m.metric_id)}">${esc(m.label)}</option>`).join("")}</optgroup>`).join("");
    return `
      <section class="report-equation" id="ix-equation">
        <h2>Your equation</h2>
        <p class="equation-intro">Ward Wise is built on the idea that there is no single answer to what makes a neighborhood good. The order below weights every measure the way the site does by default. Set your own priorities here and the ${esc(countWord(areaList().length))} re-rank to match, using the same 0 to 100 scores the map uses. <a href="/survey">Build your own index</a> and your answers also count toward the citywide tally.</p>
        <form class="equation-form" id="ix-form" aria-label="Weight the wellbeing domains">${fields}
          <button type="button" class="equation-reset" data-act="reset">${inList ? "Back to the equation" : "Back to the default equation"}</button>
        </form>
        <p class="equation-fine" data-counting>${countingLine()} <span class="soft">Movement chips measure against the default equation.</span></p>
        <details class="report-editor equation-lists"${inList ? " open" : ""}>
          <summary>Or start from a curated list</summary>
          <div class="preset-chips">${chips}</div>
          ${inList ? `<div class="ww-pilltray">${pills || `<span class="soft">Nothing selected yet.</span>`}</div>
          <label class="report-add"><span>Add a measure</span><select id="ix-add"><option value="">Choose…</option>${addOptions}</select></label>` : ""}
        </details>
      </section>`;
  }

  function resultLine(rows) {
    if (!edited()) return "";
    const ranked = rows.filter((r) => r.rank);
    if (!ranked.length) return "With every domain at Not really, no measure counts and there is nothing to rank.";
    const leader = ranked.find((r) => r.rank === 1);
    const movers = ranked.filter((r) => r.delta != null);
    const riser = movers.reduce((best, r) => (best == null || r.delta > best.delta ? r : best), null);
    const faller = movers.reduce((best, r) => (best == null || r.delta < best.delta ? r : best), null);
    let text = `Under ${esc(listName())}, ${esc(leader.name)} leads the ${countWord(ranked.length)}.`;
    if (riser && riser.delta > 0) text += ` Biggest riser ${esc(riser.name)}, up ${riser.delta} from the default.`;
    if (faller && faller.delta < 0) text += ` Biggest faller ${esc(faller.name)}, down ${-faller.delta}.`;
    return text;
  }

  function moveChip(delta) {
    if (delta == null || !edited()) return { cls: "", text: "" };
    if (delta > 0) return { cls: "is-up", text: `▲${delta}` };
    if (delta < 0) return { cls: "is-down", text: `▼${-delta}` };
    return { cls: "", text: "" };
  }

  function lensLine(areaId) {
    if (!state.lens) return "";
    const entry = (domainIndexes().byArea.get(String(areaId)) || []).find((d) => d.domain === state.lens);
    if (!entry) return "no index";
    return `${esc(C.humanizeDomain(state.lens))} · ${S.ordinal(entry.rank)} of ${entry.of}`;
  }

  function sparkHtml(areaId) {
    if (!state.trend || state.sparkStatus !== "ready") return "";
    const points = state.sparkPoints?.get(String(areaId)) || [];
    if (points.length < 2) return "";
    return `${C.miniChart(points)}<span class="idx-spark-cap">${points[0][0]}–${points[points.length - 1][0]} · score on ${esc(listName())}</span>`;
  }

  function reportHref(id) {
    return G.reportUrl(state.cfg.api, id, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir });
  }

  function rowHtml(row) {
    const move = moveChip(row.delta);
    return `
      <li class="idx-row${S.medalClass(row.rank, " m-")}" data-id="${esc(row.area_id)}"${state.q && !row.key.includes(state.q.toLowerCase()) ? " hidden" : ""}>
        <a href="${esc(reportHref(row.area_id))}">
          <span class="idx-meta">
            <span class="idx-num">${esc(row.num)}</span>
            <span class="idx-who">${esc(row.who)}</span>
            <span class="idx-move ${move.cls}">${move.text}</span>
            <span class="idx-rank num">${row.rank ? S.ordinal(row.rank) : "—"}</span>
          </span>
          <span class="idx-headline">${esc(headlineFor(row.area_id))}</span>
        </a>
      </li>`;
  }

  function cardHtml(row) {
    const move = moveChip(row.delta);
    const rows = domainIndexes().byArea.get(String(row.area_id)) || [];
    return `
      <li class="idx-card${S.medalClass(row.rank, " m-")}${row.rank ? "" : " is-unscored"}" data-id="${esc(row.area_id)}"${state.q && !row.key.includes(state.q.toLowerCase()) ? " hidden" : ""}>
        <a href="${esc(reportHref(row.area_id))}">
          <span class="idx-bloom">${C.bloom(rows, { mini: true, lens: state.lens })}</span>
          <span class="idx-rankline"><span class="idx-rank num">${row.rank ? S.ordinal(row.rank) : "not scored"}</span><span class="idx-move ${move.cls}">${move.text}</span></span>
          <span class="idx-name">${esc(row.name)}</span>
          <span class="idx-sub">${esc(row.who || row.sub)}</span>
          <span class="idx-score">${row.score != null ? `score <b class="num">${row.score.toFixed(1)}</b>` : `none of ${esc(listName())} measured here`}</span>
          <span class="idx-lens">${lensLine(row.area_id)}</span>
          <span class="idx-head">${esc(state.headlines[String(row.area_id)] || "")}</span>
          <span class="idx-spark">${sparkHtml(row.area_id)}</span>
        </a>
      </li>`;
  }

  function render() {
    const el = body();
    if (!el) return;
    const rows = facts();
    state.rowsById = new Map(rows.map((row) => [String(row.area_id), row]));
    state.order = orderIds(rows);
    state.nodes = new Map();
    state.rendered = new Set();
    const ranked = rows.filter((r) => r.rank).length;
    const count = countWord(ranked || rows.length);
    root().querySelectorAll("[data-count]").forEach((node) => { node.textContent = count; });
    root().querySelectorAll("[data-noun]").forEach((node) => { node.textContent = state.cfg.plural; });
    root().querySelectorAll("[data-noun-cap]").forEach((node) => { node.textContent = G.capitalize(state.cfg.plural); });
    root().querySelectorAll("[data-noun-single]").forEach((node) => { node.textContent = state.cfg.noun; });
    root().querySelector("[data-kicker]").textContent = state.cfg.api === "ward" ? "Ward by ward" : `${G.capitalize(state.cfg.noun)} by ${state.cfg.noun}`;
    document.title = `Index of ${count} ${state.cfg.plural} — Ward Wise`;
    const line = resultLine(rows);
    const gridClass = state.view === "cards" ? "idx-grid" : "index-grid";
    el.innerHTML =
      renderControls() +
      renderEquation() +
      `<p class="equation-result" id="ix-result"${line ? "" : " hidden"}>${line}</p>` +
      `<section class="report-index"><h2 class="index-title">The ${esc(count)}</h2>` +
      `<ol class="${gridClass}" id="ix-grid"${state.lens && state.view === "cards" ? ` data-lens="${esc(state.lens)}"` : ""}></ol></section>` +
      `<div class="ed-share"><button type="button" class="ww-cta ghost" data-act="copy">Copy link</button><button type="button" class="ww-cta ghost" data-act="print">Print</button></div>`;
    renderChunk();
    wireControls();
    writeUrl();
  }

  // Entries render in chunks as the reader scrolls; the sentinel sits where the next chunk belongs.
  function renderChunk() {
    const grid = document.getElementById("ix-grid");
    if (!grid) return;
    let sentinel = grid.querySelector(".idx-sentinel");
    if (sentinel) sentinel.remove();
    let added = 0;
    for (const id of state.order) {
      if (state.rendered.has(id)) continue;
      if (added >= CHUNK) break;
      const row = state.rowsById.get(id);
      const template = document.createElement("template");
      template.innerHTML = (state.view === "cards" ? cardHtml(row) : rowHtml(row)).trim();
      const node = template.content.firstElementChild;
      state.nodes.set(id, node);
      state.rendered.add(id);
      grid.appendChild(node);
      added += 1;
    }
    applyOrder();
    if (state.rendered.size < state.order.length) {
      sentinel = document.createElement("li");
      sentinel.className = "idx-sentinel";
      sentinel.textContent = `${state.order.length - state.rendered.size} more ${state.cfg.plural} below…`;
      grid.appendChild(sentinel);
      watchSentinel(sentinel);
    }
  }

  function watchSentinel(sentinel) {
    const fire = () => {
      if (!sentinel.isConnected) return;
      renderChunk();
    };
    if (window.IntersectionObserver) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          fire();
        }
      }, { rootMargin: "600px 0px" });
      observer.observe(sentinel);
    }
    const check = () => {
      if (!sentinel.isConnected) {
        window.removeEventListener("scroll", check);
        return;
      }
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 600) {
        window.removeEventListener("scroll", check);
        fire();
      }
    };
    window.addEventListener("scroll", check, { passive: true });
    setTimeout(check, 300);
  }

  // Re-rank without re-rendering: walk the order, move each existing entry to its place and patch
  // the text that changed. Entries not yet rendered stay pending in order.
  function applyOrder() {
    const grid = document.getElementById("ix-grid");
    if (!grid) return;
    const sentinel = grid.querySelector(".idx-sentinel");
    const cards = state.view === "cards";
    for (const id of state.order) {
      const node = state.nodes.get(id);
      if (!node) continue;
      const row = state.rowsById.get(id);
      const move = moveChip(row.delta);
      node.className = `${cards ? "idx-card" : "idx-row"}${S.medalClass(row.rank, " m-")}${row.rank ? "" : " is-unscored"}`;
      node.hidden = Boolean(state.q) && !row.key.includes(state.q.toLowerCase());
      node.querySelector(".idx-rank").textContent = row.rank ? S.ordinal(row.rank) : (cards ? "not scored" : "—");
      const chip = node.querySelector(".idx-move");
      chip.className = `idx-move ${move.cls}`;
      chip.textContent = move.text;
      node.querySelector("a").setAttribute("href", reportHref(id));
      if (cards) {
        node.querySelector(".idx-score").innerHTML = row.score != null
          ? `score <b class="num">${row.score.toFixed(1)}</b>`
          : `none of ${esc(listName())} measured here`;
        node.querySelector(".idx-lens").innerHTML = lensLine(id);
        node.querySelector(".idx-spark").innerHTML = sparkHtml(id);
      }
      grid.insertBefore(node, sentinel);
    }
    if (sentinel) grid.appendChild(sentinel);
  }

  // After the equation or the list changes: recompute standings, reorder, refresh the prose.
  function rerank({ rebuildPanel = true } = {}) {
    recomputeWeights();
    const rows = facts();
    state.rowsById = new Map(rows.map((row) => [String(row.area_id), row]));
    state.order = orderIds(rows);
    const line = resultLine(rows);
    const result = document.getElementById("ix-result");
    if (result) {
      result.innerHTML = line;
      result.hidden = !line;
    }
    if (rebuildPanel) {
      const panel = document.getElementById("ix-equation");
      if (panel) panel.outerHTML = renderEquation();
      wireEquation();
    } else {
      const fine = document.querySelector("#ix-equation [data-counting]");
      if (fine) fine.innerHTML = `${countingLine()} <span class="soft">Movement chips measure against the default equation.</span>`;
    }
    applyOrder();
    if (state.rendered.size < state.order.length && !document.querySelector(".idx-sentinel")) renderChunk();
    writeUrl();
    if (state.trend) loadSparks();
  }

  function applyLens() {
    const grid = document.getElementById("ix-grid");
    if (!grid) return;
    if (state.lens) grid.dataset.lens = state.lens;
    else delete grid.dataset.lens;
    for (const [id, node] of state.nodes) {
      node.querySelectorAll(".bloom-petal").forEach((petal) => petal.classList.toggle("is-lens", Boolean(state.lens) && petal.dataset.domain === state.lens));
      const lens = node.querySelector(".idx-lens");
      if (lens) lens.innerHTML = lensLine(id);
    }
    writeUrl();
  }

  // ---- trend sparklines (cards view): the composite at a handful of years ----

  async function loadSparks() {
    if (!state.trend || state.view !== "cards" || sparkFetches() === 0) return;
    const latest = Math.max(...(state.manifest.data_years || []).filter((y) => y <= new Date().getFullYear()));
    const years = [...new Set(SPARK_YEARS.concat([latest]))].filter((y) => y >= FIRST_YEAR).sort().slice(-sparkFetches());
    const token = (state.sparkToken = (state.sparkToken || 0) + 1);
    state.sparkStatus = "loading";
    try {
      const slices = await Promise.all(years.map((y) => loadSlice(String(y))));
      if (token !== state.sparkToken) return;
      const points = new Map();
      slices.forEach((slice, i) => {
        const { rows } = S.computeComposite(slice, state.weights);
        for (const row of rows) {
          if (row.score == null) continue;
          if (!points.has(String(row.area_id))) points.set(String(row.area_id), []);
          points.get(String(row.area_id)).push([years[i], row.score]);
        }
      });
      state.sparkPoints = points;
      state.sparkStatus = "ready";
    } catch (_error) {
      state.sparkStatus = "failed";
    }
    if (token === state.sparkToken) applyOrder();
  }

  // ---- headlines from the narrative artifact, when one exists ----

  async function loadHeadlines() {
    if (!NARRATIVES_LIVE) return;
    const key = state.cfg.api;
    try {
      const data = await WardWiseExplorer.fetchJson(`/api/narratives?area_type=${encodeURIComponent(key)}`, "");
      if (state.cfg.api !== key) return;
      state.headlines = Object.fromEntries(Object.entries(data.areas || {}).map(([id, entry]) => [id, entry.headline || ""]));
    } catch (_error) {
      state.headlines = {};
    }
    for (const [id, node] of state.nodes) {
      const head = node.querySelector(".idx-headline, .idx-head");
      if (head) head.textContent = state.view === "cards" ? (state.headlines[id] || "") : headlineFor(id);
    }
  }

  async function loadTerms() {
    if (state.terms || state.cfg.api !== "ward") return;
    try {
      state.terms = await WardWiseExplorer.fetchJson("/api/aldermanic-terms", "");
    } catch (_error) {
      state.terms = { terms: {} };
    }
    for (const [id, node] of state.nodes) {
      const who = node.querySelector(".idx-who, .idx-sub");
      const area = findArea(id);
      if (who && area) who.textContent = whoFor(area) || state.cfg.sub(area);
    }
  }

  // ---- controls ----

  function wireEquation() {
    const form = document.getElementById("ix-form");
    form?.addEventListener("change", (event) => {
      const input = event.target;
      if (!input.name?.startsWith("cat-")) return;
      state.mode = "equation";
      state.presetId = null;
      state.catWeights[input.name.slice(4)] = Number(input.value);
      rerank({ rebuildPanel: false });
    });
    document.getElementById("ix-add")?.addEventListener("change", (event) => {
      const id = event.target.value;
      if (!id) return;
      state.mode = "list";
      state.weights = { ...state.weights, [id]: 1 };
      state.presetId = null;
      rerank();
    });
  }

  function wireControls() {
    document.getElementById("ix-geo")?.addEventListener("change", async (event) => {
      state.cfg = G.byApi(event.target.value);
      state._urlPreset = state.mode === "list" ? state.presetId : null;
      state._urlMix = state.mode === "list" && !state.presetId ? G.serializeMix(state.weights) : null;
      state._urlEquation = state.mode === "equation" ? equationParam() : null;
      state._baseline = null;
      await loadAreas(state.cfg);
      await loadSlice(String(state.year));
      resolveWeights();
      render();
      loadTerms();
      loadHeadlines();
      if (state.trend) loadSparks();
    });
    document.getElementById("ix-year")?.addEventListener("change", async (event) => {
      state.year = event.target.value === "latest" ? "latest" : Number(event.target.value);
      await loadSlice(String(state.year));
      if (state.year !== "latest" && !Object.keys(currentSlice()).length) state.year = "latest";
      state._baseline = null;
      render();
      if (state.trend) loadSparks();
    });
    document.getElementById("ix-sort")?.addEventListener("change", (event) => {
      state.sort = SORTS.includes(event.target.value) ? event.target.value : "number";
      state.order = orderIds(facts());
      applyOrder();
      writeUrl();
    });
    document.getElementById("ix-view")?.addEventListener("change", (event) => {
      state.view = event.target.value === "cards" ? "cards" : "list";
      render();
      if (state.trend) loadSparks();
    });
    document.getElementById("ix-lens")?.addEventListener("change", (event) => {
      state.lens = event.target.value || null;
      applyLens();
    });
    document.getElementById("ix-q")?.addEventListener("input", (event) => {
      state.q = event.target.value.trim();
      applyOrder();
      writeUrl();
    });
    document.getElementById("ix-trend")?.addEventListener("change", (event) => {
      state.trend = event.target.checked;
      if (state.trend) loadSparks();
      else {
        state.sparkStatus = "idle";
        applyOrder();
      }
      writeUrl();
    });
    wireEquation();
  }

  function onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "preset") {
      const preset = usablePreset(WardWisePresetTools.byId(target.dataset.presetId));
      if (!preset) return;
      state.mode = "list";
      state.weights = weightsOf(preset);
      state.presetId = preset.id;
      WardWiseExplorer.track("index_preset", { preset_id: preset.id, area_type: state.cfg.api });
      rerank();
    } else if (act === "remove") {
      const next = { ...state.weights };
      delete next[target.dataset.metricId];
      state.weights = next;
      state.presetId = null;
      rerank();
    } else if (act === "reset") {
      state.mode = "equation";
      state.catWeights = {};
      state.presetId = null;
      rerank();
    } else if (act === "copy") {
      WardWiseExplorer.track("report_shared", { how: "copy_link" });
      const url = window.location.href;
      const done = () => { target.textContent = "Link copied"; setTimeout(() => { target.textContent = "Copy link"; }, 2000); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt("Copy this link", url));
      else window.prompt("Copy this link", url);
    } else if (act === "print") {
      WardWiseExplorer.track("report_shared", { how: "print" });
      while (state.rendered.size < state.order.length) renderChunk();
      window.print();
    }
  }

  // ---- boot ----

  async function boot() {
    const el = body();
    try {
      state.manifest = await WardWiseExplorer.fetchExplorerManifest();
      readUrl();
      await loadAreas(state.cfg);
      await loadSlice(String(state.year));
      if (state.year !== "latest" && !Object.keys(currentSlice()).length) {
        state.year = "latest";
        await loadSlice("latest");
      }
      resolveWeights();
      render();
      WardWiseExplorer.track("index_open", { area_type: state.cfg.api, mode: state.mode, preset_id: state.presetId });
      loadTerms();
      loadHeadlines();
      if (state.trend) loadSparks();
    } catch (error) {
      if (el) el.innerHTML = `<p class="report-note">Couldn't load the index — ${esc(error.message || "try reloading")}.</p>`;
    }
  }

  document.addEventListener("click", onClick);
  window.addEventListener("beforeprint", () => { while (state.rendered.size < state.order.length) renderChunk(); });
  document.addEventListener("wardwise:themechange", () => { if (state.manifest) applyOrder(); });
  boot();
})();
