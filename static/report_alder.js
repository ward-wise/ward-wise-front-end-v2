// Term report v1: the current aldermanic term (May 2023 → now), which is also the current
// ward-boundary era — the only window where change is cleanly attributable to a sitting
// alderperson. A faces biplot positions all 50 alderpeople by their ward's change RELATIVE to the
// average ward's change (delta_vs_city from /api/metrics/delta) on two chosen metrics, plus
// "theirs" cards for the directly aldermanic measures. Architecture is keyed by (ward, term
// window) so historical terms slot in once a ward × term roster exists.
(function () {
  "use strict";

  if (!document.getElementById("alder-view")) return;

  const CURRENT_TERM = "2023";
  // The selected term's window. Historical terms are the point of the roster: five terms x 50
  // wards is ~250 records to judge performance against, instead of 50.
  let term = { id: CURRENT_TERM, from: 2023, to: null, wardMap: "2023", wards: {} };

  // Which measures may carry an alderperson's face, and how each can be read fairly.
  //
  // The mode isn't a display preference — it follows from what kind of measure it is:
  //
  //   LEVEL, for what they DECIDE. Menu money, attendance, sponsoring legislation, running a
  //   participatory budget: the value IS the choice. Asking how their menu spending "changed"
  //   is a second derivative of a decision, and tells you less than the decision itself.
  //
  //   CHANGE, for what they INFLUENCE. Crime, businesses opening and closing: nobody should be
  //   judged on the ward they inherited — a ward with high crime in 2015 had high crime in 2011,
  //   and that is not the sitting alderperson's doing. The direction of travel during their term,
  //   measured against the average ward's, is the question that can fairly be asked.
  //
  // The list stays hand-picked: a face plotted against a number nobody could move is unfair to
  // the person and misleading to the reader. But excluding a measure people legitimately care
  // about isn't fairness either — it's the mode that makes it fair.
  const TERM_METRICS = [
    // --- their own decisions (level) ---------------------------------------------------------
    { id: "council_attendance_pct", mode: "level",
      note: "Their own attendance at City Council meetings." },
    { id: "nonroutine_bills_sponsored_current_session", mode: "level",
      note: "Non-routine legislation they sponsored this session." },
    { id: "participatory_budgeting", mode: "level",
      note: "Whether they hand the ward's menu money to a resident vote — an aldermanic choice." },
    { id: "menu_budget_utilization", mode: "level",
      note: "How much of their ~$1.5M menu allocation they spent — a decision, not a trend." },
    { id: "menu_active_transport_share", mode: "level",
      note: "Share of their menu money directed to walking, biking and street redesign." },
    { id: "menu_project_diversity", mode: "level",
      note: "How widely they spread menu spending across project types." },
    // per-category menu shares: descriptive spending choices, each ~level per data year
    { id: "menu_streets_share", mode: "level",
      note: "Share of their menu money on street resurfacing — a priority choice, not a score." },
    { id: "menu_lighting_share", mode: "level",
      note: "Share of their menu money on lighting." },
    { id: "menu_sidewalks_share", mode: "level",
      note: "Share of their menu money on sidewalk repair." },
    { id: "menu_alleys_share", mode: "level",
      note: "Share of their menu money on alleys." },
    { id: "menu_parks_share", mode: "level",
      note: "Share of their menu money on park improvements." },
    { id: "menu_cameras_share", mode: "level",
      note: "Share of their menu money on surveillance cameras." },
    { id: "menu_schools_share", mode: "level",
      note: "Share of their menu money on school improvements." },
    // --- city services in their ward (level) -------------------------------------------------
    { id: "c311_response_days", mode: "level",
      note: "How fast city services close requests in their ward — influenced by, not owned by, the ward office." },
    { id: "c311_pothole_days", mode: "level", note: "How fast potholes get filled in their ward." },
    { id: "c311_graffiti_days", mode: "level", note: "How fast graffiti gets removed in their ward." },
    { id: "c311_street_light_days", mode: "level", note: "How fast street lights get repaired in their ward." },
    { id: "c311_rodent_days", mode: "level", note: "How fast rodent baiting requests are answered in their ward." },
    { id: "c311_tree_debris_days", mode: "level", note: "How fast tree debris gets cleared in their ward." },
    { id: "c311_garbage_cart_days", mode: "level", note: "How fast garbage carts get repaired or replaced in their ward." },
    // --- the map they were handed (level, context) --------------------------------------------
    // Drawn by the council in the remap, not by the ward office alone — but a ward's shape is a
    // fair question to put beside its service times, and each term is scored on its own map.
    { id: "boundary_compactness_score", mode: "level",
      note: "How compact the ward's boundary is on the map this term used — 100 is a circle." },
    { id: "boundary_miles_per_sq_mi", mode: "level",
      note: "Miles of boundary per square mile on the map this term used — the raw perimeter-to-area ratio." },
    // --- conditions their policies may move (change across the term) -------------------------
    { id: "violent_crime_rate_per_10000", mode: "change",
      note: "Which way violent crime moved during the term, against the average ward's move." },
    { id: "full_service_restaurants_per_10000_residents", mode: "change",
      note: "Restaurants opening or closing — zoning, licensing and street investment all bear on this." },
    { id: "bars_taverns_per_10000_residents", mode: "change",
      note: "Bars opening or closing; liquor licensing runs through the ward office." },
    { id: "coffee_snack_shops_per_10000_residents", mode: "change",
      note: "Coffee and snack shops opening or closing." },
    { id: "grocery_stores_per_10000_residents", mode: "change",
      note: "Grocery stores opening or closing — a long-standing target of ward development policy." },
    { id: "child_care_centers_per_10000_residents", mode: "change",
      note: "Child care centers opening or closing." },
    { id: "gyms_fitness_centers_per_10000_residents", mode: "change",
      note: "Gyms and fitness centers opening or closing." },
    // Licensed-business series (city licences, 2002->today, daily-updated): a different universe
    // from the CBP counts above — a licence is permission to operate — but far longer, current,
    // and re-allocatable onto historical ward maps.
    { id: "licensed_bars_per_10000_residents", mode: "change",
      note: "Licensed taverns opening or closing; liquor licensing runs through the ward office." },
    { id: "licensed_restaurants_liquor_per_10000_residents", mode: "change",
      note: "Licensed restaurants-with-liquor opening or closing." },
    { id: "licensed_food_businesses_per_10000_residents", mode: "change",
      note: "Licensed food businesses of every kind opening or closing." },
    { id: "licensed_packaged_liquor_per_10000_residents", mode: "change",
      note: "Licensed packaged-liquor sellers opening or closing." },
    { id: "licensed_child_care_per_10000_residents", mode: "change",
      note: "Licensed child care centers opening or closing." },
    { id: "licensed_outdoor_patios_per_10000_residents", mode: "change",
      note: "Licensed patios opening — ward offices weigh in on these directly." },
    { id: "licensed_amusement_venues_per_10000_residents", mode: "change",
      note: "Licensed entertainment venues opening or closing." },
    { id: "licensed_tobacco_retail_per_10000_residents", mode: "change",
      note: "Licensed tobacco retailers — fewer is treated as better for health." },
    { id: "licensed_chain_restaurant_share_pct", mode: "change",
      note: "Chain share of licensed restaurants — a falling share means independents gaining ground." },
    { id: "licensed_major_chain_restaurant_share_pct", mode: "change",
      note: "Major-chain (top 100 nationally) share of licensed restaurants — separates national chains from local ones." },
    { id: "licensed_grocery_stores_per_10000_residents", mode: "change",
      note: "Licensed grocery stores opening or closing — a food-access measure." },
    { id: "licensed_coffee_shops_per_10000_residents", mode: "change",
      note: "Licensed coffee and tea shops opening or closing." },
    { id: "air_pm25_annual", mode: "change",
      note: "Fine-particle pollution moving during the term — shaped by traffic, industry and regional air, which ward policy touches at the margin." },
  ];

  // Still absent: health, demographics, and the rest of the catalog — measures that move with
  // forces no ward office reaches, where even a change reading would invent responsibility.
  const state = {
    manifest: null,
    wards: [],          // full /api/wards records (alderperson incl. photo_url)
    deltas: {},         // `${metricId}` -> {byWard: {ward_id: delta_vs_city}, cityDelta, toYear}
    changeCapable: null, // metric ids remeasured during the term (change mode available)
    latest: null,       // latest score-matrix slice for attribution cards
    slices: {},         // yearKey -> score-matrix slice (level readings per term)
    roster: null,       // ward x term alderperson roster
    eraMetrics: null,   // {era: {metric: {year: {ward: value}}}} — historical ward maps
    loading: false,
  };

  // URL is state: /reports/term?term=2019&x=<id>&y=<id>. Read once at boot; rewritten on render.
  const entryHash = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

  const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const content = () => document.getElementById("alder-content");

  function ctx() {
    const m = state.manifest;
    return {
      metricDataYears: m.metric_data_years || {},
      forwardCarryYears: m.forward_carry_years ?? 3,
      timeInvariantMetrics: new Set(m.time_invariant_metrics || []),
      metricValidFrom: m.metric_valid_from || {},
    };
  }

  function lastMeasuredYear(metricId) {
    const years = (ctx().metricDataYears[metricId] || []).map(Number);
    return years.length ? Math.max(...years) : null;
  }

  // A metric's usable end year INSIDE the selected term — the last year it was measured without
  // running past the term's end. A term is judged on its own window, never on today's numbers.
  function termEndYear(metricId) {
    const years = (ctx().metricDataYears[metricId] || []).map(Number)
      .filter((year) => year > term.from && (!term.to || year <= term.to));
    return years.length ? Math.max(...years) : null;
  }

  // The year whose values represent this term — its final measured year for a level reading.
  function termLevelYear(metricId) {
    const years = (ctx().metricDataYears[metricId] || []).map(Number)
      .filter((year) => (!term.to || year <= term.to));
    return years.length ? Math.max(...years) : null;
  }

  // Metrics whose change across THIS term is honest: measured at both ends of the term's window.
  function eligibleMetrics() {
    return (state.manifest.metrics || []).filter((m) => {
      const to = termEndYear(m.metric_id);
      return to != null
        && WardWiseExplorer.yearMath.deltaExclusionReason(ctx(), m.metric_id, term.from, to) == null;
    });
  }

  async function fetchTermDelta(metricId) {
    const cacheKey = `${term.id}:${metricId}`;
    if (state.deltas[cacheKey]) return state.deltas[cacheKey];
    const to = termEndYear(metricId);
    const payload = await WardWiseExplorer.fetchDelta(metricId, String(term.from), String(to));
    const byWard = {};
    for (const row of payload.deltas || []) byWard[row.area_id] = row;
    state.deltas[cacheKey] = { byWard, cityDelta: payload.city_delta, toYear: to };
    return state.deltas[cacheKey];
  }

  // Level readings come from the term's own year slice; using "latest" would judge a 2015
  // alderperson by today's numbers.
  async function levelSlice(year) {
    const key = String(year);
    if (!state.slices[key]) {
      const payload = await WardWiseExplorer.fetchJson(
        `/api/metrics/score-matrix?area_type=ward&year=${encodeURIComponent(key)}`,
        "Unable to load scores.",
      );
      state.slices[key] = (payload.matrix || {})[key] || (payload.matrix || {}).latest || {};
    }
    return state.slices[key];
  }

  // What a term can honestly show differs by window: attendance and bills exist only for the
  // current session, while menu money and 311 reach back years. Options are rebuilt per term
  // rather than offering a metric the term can't support.
  function rebuildMetricOptions() {
    const changeCapable = new Set(eligibleMetrics().map((m) => m.metric_id));
    const byCatalogId = Object.fromEntries((state.manifest.metrics || []).map((m) => [m.metric_id, m]));
    state.termMetrics = TERM_METRICS
      .filter((entry) => byCatalogId[entry.id])
      .filter((entry) => entry.mode !== "change"
        // a level can also come from the era layer (e.g. boundary shape on the 2015 map), which
        // the current-boundaries data years never mention
        ? termLevelYear(entry.id) != null || term.id === CURRENT_TERM || eraLevel(entry.id) != null
        // era data can make a change honest even when the delta endpoint (current boundaries,
        // manifest years) can't see it
        : changeCapable.has(entry.id) || eraChange(entry.id) != null)
      .map((entry) => ({ ...entry, metric: byCatalogId[entry.id] }));
    state.termModes = Object.fromEntries(state.termMetrics.map((entry) => [entry.id, entry.mode]));
    // Dropdown labels stay one line: change metrics get a leading delta instead of a "(change)"
    // suffix, and family source variants compress to their short forms.
    const shortLabel = (label) => label
      .replace("(business licences)", "(licences)")
      .replace("(Google Maps sweep)", "(sweep)")
      .replace("(County Business Patterns)", "(CBP)");
    const options = state.termMetrics
      .map((entry) => `<option value="${esc(entry.id)}">${entry.mode === "change" ? "Δ " : ""}${esc(shortLabel(entry.metric.label))}</option>`)
      .join("");
    for (const id of ["alder-metric-x", "alder-metric-y"]) {
      const select = document.getElementById(id);
      const previous = select.value;
      select.innerHTML = options;
      if (state.termModes[previous]) select.value = previous;
    }
    const xSel = document.getElementById("alder-metric-x");
    const ySel = document.getElementById("alder-metric-y");
    if (xSel.value && xSel.value === ySel.value && state.termMetrics.length > 1) {
      ySel.value = state.termMetrics.find((e) => e.id !== xSel.value).id;
    }
  }

  function applyTerm(termId) {
    const info = (state.roster?.terms || {})[termId] || {};
    term = {
      id: termId,
      from: Number(termId),
      to: termId === CURRENT_TERM ? null : Number(termId) + 4,
      wardMap: info.ward_map || termId,
      wards: info.wards || {},
      wardsCovered: info.wards_covered,
    };
  }

  async function ensureLoaded() {
    if (state.loading || state.manifest) return;
    state.loading = true;
    try {
      const [manifest, wardsPayload, matrixPayload, roster, eraPayload] = await Promise.all([
        WardWiseExplorer.fetchExplorerManifest(),
        WardWiseExplorer.fetchWards(),
        WardWiseExplorer.fetchJson("/api/metrics/score-matrix?area_type=ward&year=latest", "Unable to load scores."),
        WardWiseExplorer.fetchJson("/api/aldermanic-terms", "Unable to load the term roster.")
          .catch(() => ({ terms: {} })),
        WardWiseExplorer.fetchJson("/api/era-ward-metrics", "")
          .catch(() => ({ eras: {} })),
      ]);
      state.roster = roster;
      state.eraMetrics = eraPayload.eras || {};
      state.manifest = manifest;
      state.wards = (wardsPayload.wards || []).sort(
        (a, b) => Number(a.ward_number || a.ward_id) - Number(b.ward_number || b.ward_id),
      );
      state.latest = (matrixPayload.matrix || {}).latest || {};
      state.slices.latest = state.latest;
      // Every term the roster knows about, newest first — ~250 ward-terms of record.
      const termSelect = document.getElementById("alder-term");
      const rosterTerms = Object.entries(roster.terms || {}).sort((a, b) => b[0].localeCompare(a[0]));
      if (rosterTerms.length) {
        termSelect.innerHTML = rosterTerms.map(([id, info]) => {
          const years = `${id}\u2013${String(Number(id) + 4)}`;
          const current = id === CURRENT_TERM ? " (current)" : "";
          return `<option value="${esc(id)}">${years}${current}</option>`;
        }).join("");
        const wanted = entryHash.get("term");
        termSelect.value = roster.terms?.[wanted] ? wanted : CURRENT_TERM;
        applyTerm(termSelect.value);
        termSelect.addEventListener("change", async () => {
          applyTerm(termSelect.value);
          rebuildMetricOptions();
          await render();
        });
      }
      rebuildMetricOptions();
      const plottable = state.termMetrics.map((entry) => entry.metric);
      const xSelect = document.getElementById("alder-metric-x");
      const ySelect = document.getElementById("alder-metric-y");
      const hashParams = entryHash;
      const byId = Object.fromEntries(plottable.map((m) => [m.metric_id, m]));
      const defaultX = byId[hashParams.get("x")] ? hashParams.get("x")
        : byId.menu_active_transport_share ? "menu_active_transport_share" : plottable[0]?.metric_id;
      const defaultY = byId[hashParams.get("y")] ? hashParams.get("y")
        : byId.council_attendance_pct ? "council_attendance_pct"
          : plottable.find((m) => m.metric_id !== defaultX)?.metric_id;
      if (defaultX) xSelect.value = defaultX;
      if (defaultY) ySelect.value = defaultY;
      xSelect.addEventListener("change", render);
      ySelect.addEventListener("change", render);
      // Standards re-render on commit, not on every keystroke.
      for (const id of ["alder-threshold-x", "alder-threshold-y"]) {
        document.getElementById(id).addEventListener("change", render);
      }
      await render();
    } catch (error) {
      const el = content();
      // Surface the cause: a silent "try reloading" hides which dependency actually failed.
      console.error("term report failed to load", error);
      if (el) el.innerHTML = `<p>Couldn't load the term report — ${esc(error?.message || "unknown error")}.</p>`;
    } finally {
      state.loading = false;
    }
  }

  // Era data for the selected term's ward map, when the pipeline could re-allocate this metric
  // onto it. null = fall back to current boundaries (with the anachronism caveat).
  function eraSeries(metricId) {
    if (term.id === CURRENT_TERM) return null;
    const era = state.eraMetrics?.[term.wardMap]?.[metricId];
    if (!era) return null;
    const years = Object.keys(era).map(Number).sort((a, b) => a - b);
    if (!years.length) return null;
    return { byYear: era, years };
  }

  function eraLevel(metricId) {
    const series = eraSeries(metricId);
    if (!series) return null;
    const usable = series.years.filter((y) => !term.to || y <= term.to);
    if (!usable.length) return null;
    const year = Math.max(...usable);
    return { values: series.byYear[String(year)] || {}, year };
  }

  function eraChange(metricId) {
    const series = eraSeries(metricId);
    if (!series) return null;
    // endpoints inside the term's window, mirroring the delta endpoint's forward-carry tolerance
    const fromCandidates = series.years.filter((y) => y <= term.from && term.from - y <= 3);
    const toCandidates = series.years.filter((y) => y > term.from && (!term.to || y <= term.to));
    if (!fromCandidates.length || !toCandidates.length) return null;
    const fromYear = Math.max(...fromCandidates);
    const toYear = Math.max(...toCandidates);
    if (fromYear === toYear) return null;
    const a = series.byYear[String(fromYear)] || {};
    const b = series.byYear[String(toYear)] || {};
    const deltas = {};
    for (const ward of Object.keys(b)) {
      if (Number.isFinite(a[ward]) && Number.isFinite(b[ward])) deltas[ward] = b[ward] - a[ward];
    }
    const list = Object.values(deltas);
    if (list.length < 5) return null;
    const average = list.reduce((x, y) => x + y, 0) / list.length;
    const values = {};
    for (const [ward, delta] of Object.entries(deltas)) values[ward] = delta - average;
    return { values, fromYear, toYear };
  }

  // An axis value plus its orientation. Penlight metrics carry a direction, so a
  // lower-is-better measure is negated for plotting: better is ALWAYS up and to the right, while
  // the tooltip and axis label keep the real, unflipped number.
  async function axisSeries(metricId, mode) {
    const metric = metricById(metricId);
    const note = (state.termMetrics || []).find((entry) => entry.id === metricId)?.note || "";
    const flip = metric.direction === "lower" ? -1 : 1;
    if (mode === "change") {
      const era = eraChange(metricId);
      if (era) {
        return { metric, mode, note, values: era.values, flip, toYear: era.toYear, eraMap: term.wardMap,
                 label: `${metric.label} — change vs the average ward (${era.fromYear}→${era.toYear}, ${term.wardMap} ward map)` };
      }
      const delta = await fetchTermDelta(metricId);
      const values = {};
      for (const [wardId, row] of Object.entries(delta.byWard)) {
        if (Number.isFinite(row.delta_vs_city)) values[wardId] = row.delta_vs_city;
      }
      return { metric, mode, note, values, flip, toYear: delta.toYear,
               label: `${metric.label} — change vs the average ward (${term.from}→${delta.toYear})` };
    }
    // A level must come from the TERM's own year, not today's: scoring a 2015 alderperson on 2026
    // numbers would judge them by their successor's ward.
    const eraLevelValues = eraLevel(metricId);
    if (eraLevelValues && term.id !== CURRENT_TERM) {
      return { metric, mode, note, values: eraLevelValues.values, flip,
               levelYear: eraLevelValues.year, eraMap: term.wardMap,
               label: `${metric.label} — value in ${eraLevelValues.year} (${term.wardMap} ward map)` };
    }
    const year = termLevelYear(metricId);
    const historical = term.id !== CURRENT_TERM && year != null;
    const slice = historical ? await levelSlice(year) : state.latest;
    const values = {};
    for (const wardId of Object.keys(slice)) {
      const cell = slice[wardId]?.[metricId];
      if (cell && Number.isFinite(cell.v)) values[wardId] = cell.v;
    }
    const when = historical ? `value in ${year}` : "current value";
    return { metric, mode, note, values, flip, levelYear: historical ? year : null,
             label: `${metric.label} — ${when}` };
  }

  function metricById(metricId) {
    return (state.manifest.metrics || []).find((m) => m.metric_id === metricId);
  }

  // Who served this ward in the selected term. Photos exist only for sitting alderpeople, so a
  // historical term shows initials and names the person in the tooltip instead of a face.
  function servedBy(ward) {
    const entry = term.wards[ward.ward_id];
    if (!entry) return { label: "", names: [] };
    const names = entry.members.map((m) => m.name);
    return { names, mixed: entry.mixed };
  }

  function initialsFor(name) {
    // roster names are "Last, First" — take the surname initial plus the given initial
    const [last, first] = String(name || "").split(",");
    return ((last || "").trim()[0] || "?").toUpperCase() + ((first || "").trim()[0] || "").toUpperCase();
  }

  function facePoint(ward, x, y, valueText) {
    const served = servedBy(ward);
    if (term.id !== CURRENT_TERM) {
      const label = served.names.length ? initialsFor(served.names[0]) : String(ward.ward_number || ward.ward_id);
      const who = served.names.length
        ? served.names.join(" then ") + (served.mixed ? " (mixed term)" : "")
        : "no alderperson on record";
      return `<g class="alder-marker" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <title>${esc(who)} — Ward ${esc(ward.ward_number || ward.ward_id)}${valueText ? `\n${esc(valueText)}` : ""}</title>
        <circle r="13" class="alder-fallback"/><text dy="4">${esc(label)}</text></g>`;
    }
    const alder = ward.alderperson || {};
    const number = ward.ward_number || ward.ward_id;
    const id = `alderclip-${ward.ward_id}`;
    const title = `<title>${esc(alder.name || "vacant")} — Ward ${esc(number)}${valueText ? `\n${esc(valueText)}` : ""}</title>`;
    const r = 13;
    if (alder.photo_url) {
      return `<g class="alder-marker" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${title}
        <clipPath id="${id}"><circle r="${r}"/></clipPath>
        <circle r="${r + 1.2}" class="alder-ring"/>
        <image href="${esc(alder.photo_url)}" x="${-r}" y="${-r}" width="${r * 2}" height="${r * 2}"
               clip-path="url(#${id})" preserveAspectRatio="xMidYMid slice"/>
      </g>`;
    }
    return `<g class="alder-marker" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">${title}
      <circle r="${r}" class="alder-fallback"/><text dy="4">${esc(number)}</text></g>`;
  }

  // The line each ward is judged against: the average across wards, or a standard the reader
  // typed (a policy target — "311 under 7 days", "crime change at or below zero").
  function standardFor(axis, override) {
    if (Number.isFinite(override)) return { value: override, custom: true };
    const values = Object.values(axis.values).filter(Number.isFinite);
    if (!values.length) return { value: 0, custom: false };
    return { value: values.reduce((a, b) => a + b, 0) / values.length, custom: false };
  }

  function meets(axis, raw, standard) {
    // "Better" respects the metric's direction: below the line is good for a lower-is-better one.
    return axis.metric.direction === "lower" ? raw <= standard : raw >= standard;
  }

  function biplotHtml(xAxis, yAxis, xStd, yStd) {
    const fmtAxis = (axis, v) => axis.mode === "change"
      ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${WardWiseExplorer.formatMetricValue(Math.abs(v), axis.metric)}`
      : WardWiseExplorer.formatMetricValue(v, axis.metric);
    const points = [];
    for (const ward of state.wards) {
      const xv = xAxis.values[ward.ward_id];
      const yv = yAxis.values[ward.ward_id];
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
      points.push({
        ward, xRaw: xv, yRaw: yv, x: xv * xAxis.flip, y: yv * yAxis.flip,
        xOk: meets(xAxis, xv, xStd.value), yOk: meets(yAxis, yv, yStd.value),
      });
    }
    if (points.length < 5) return "<p>Not enough wards have both measures for this term.</p>";
    // On a phone, draw the chart on a narrow canvas (about the screen's own width) instead of
    // shrinking a 900-wide picture to a third, which made every label about 4px tall.
    const narrow = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
    const W = narrow ? 400 : 900, H = narrow ? 540 : 620;
    const m = narrow ? { l: 40, r: 12, t: 28, b: 52 } : { l: 70, r: 28, t: 30, b: 62 };
    const pad = (lo, hi) => { const span = hi - lo || 1; return [lo - span * 0.09, hi + span * 0.09]; };
    const [xMin, xMax] = pad(Math.min(...points.map((p) => p.x), xStd.value * xAxis.flip),
                             Math.max(...points.map((p) => p.x), xStd.value * xAxis.flip));
    const [yMin, yMax] = pad(Math.min(...points.map((p) => p.y), yStd.value * yAxis.flip),
                             Math.max(...points.map((p) => p.y), yStd.value * yAxis.flip));
    const px = (x) => m.l + ((x - xMin) / (xMax - xMin)) * (W - m.l - m.r);
    const py = (y) => H - m.b - ((y - yMin) / (yMax - yMin)) * (H - m.t - m.b);
    const markers = points
      .map((p) => facePoint(p.ward, px(p.x), py(p.y),
        `${fmtAxis(xAxis, p.xRaw)} · ${fmtAxis(yAxis, p.yRaw)}`))
      .join("");
    const xLine = px(xStd.value * xAxis.flip);
    const yLine = py(yStd.value * yAxis.flip);
    const both = points.filter((p) => p.xOk && p.yOk).length;
    const one = points.filter((p) => (p.xOk ? 1 : 0) + (p.yOk ? 1 : 0) === 1).length;
    const neither = points.length - both - one;
    const stdNote = (axis, std) => `${std.custom ? "standard" : "average"} ${fmtAxis(axis, std.value)}`;
    // Better is up-and-right by construction, so the top-right block is the good quadrant: shade it
    // instead of floating an arrow that pointed at nothing.
    const goodQuadrant = `<rect x="${xLine}" y="${m.t}" width="${Math.max(0, W - m.r - xLine)}"
      height="${Math.max(0, yLine - m.t)}" class="alder-good-quadrant"/>`;
    return `
      <svg viewBox="0 0 ${W} ${H}" class="alder-biplot" role="img"
           aria-label="Alderpeople positioned by ${esc(xAxis.label)} and ${esc(yAxis.label)}">
        ${goodQuadrant}
        <text x="${W - m.r - 6}" y="${m.t + 14}" text-anchor="end" class="alder-quad-label">above both standards</text>
        <line x1="${xLine}" y1="${m.t}" x2="${xLine}" y2="${H - m.b}" class="alder-zero"/>
        <line x1="${m.l}" y1="${yLine}" x2="${W - m.r}" y2="${yLine}" class="alder-zero"/>
        <text x="${xLine + 5}" y="${H - m.b - 6}" class="alder-quad">x ${esc(stdNote(xAxis, xStd))}</text>
        <text x="${m.l + 4}" y="${yLine - 5}" class="alder-quad">y ${esc(stdNote(yAxis, yStd))}</text>
        ${markers}
        <text x="${(m.l + W - m.r) / 2}" y="${H - 14}" text-anchor="middle" class="alder-axis">${esc(xAxis.label)}${xAxis.metric.direction === "lower" ? " (better →)" : " →"}</text>
        <text x="18" y="${(m.t + H - m.b) / 2}" text-anchor="middle" class="alder-axis" transform="rotate(-90 18 ${(m.t + H - m.b) / 2})">${esc(yAxis.label)}${yAxis.metric.direction === "lower" ? " (better ↑)" : " ↑"}</text>
      </svg>
      <div class="alder-tally">
        <span><strong>${both}</strong> beat both</span>
        <span><strong>${one}</strong> beat one</span>
        <span><strong>${neither}</strong> beat neither</span>
        <span class="alder-tally-note">of ${points.length} wards, against the ${xStd.custom || yStd.custom ? "standards set in Advanced" : "average ward"}</span>
      </div>
      <div class="alder-why">
        ${[xAxis, yAxis].map((axis) => `<p><strong>${esc(axis.metric.label)}</strong>
          <span>${esc(axis.note || "")}</span>
          <em>${axis.mode === "change" ? `change across the term (${term.from}\u2013${axis.toYear})`
            : axis.levelYear ? `value in ${axis.levelYear}` : "current value"}</em></p>`).join("")}
      </div>`;
  }

  function termNoteHtml(xAxis, yAxis) {
    if (term.id === CURRENT_TERM) return "";
    const remapped = term.wardMap !== "2023";
    const eraAxes = [xAxis, yAxis].filter((a) => a.eraMap);
    let boundaries = "";
    if (remapped && eraAxes.length === 2) {
      boundaries = `Both measures are computed on the <strong>${esc(term.wardMap)} ward map</strong> —
        the territory this council actually represented.`;
    } else if (remapped && eraAxes.length === 1) {
      boundaries = `${esc(eraAxes[0].metric.label)} is computed on the <strong>${esc(term.wardMap)} ward
        map</strong> (the territory this council represented); the other axis uses today's boundaries,
        an anachronism to keep in mind.`;
    } else if (remapped) {
      boundaries = `Ward boundaries were redrawn since this term — these measures use today's
        boundaries, so a ward number covers somewhat different ground than it governed.`;
    }
    return `<p class="alder-term-note">
      Showing the ${esc(term.id)}\u2013${esc(String(Number(term.id) + 4))} term${term.wardsCovered ? ` (${term.wardsCovered}/50 wards on record)` : ""}.
      ${boundaries}
    </p>`;
  }

  function attributionCardsHtml() {
    if (term.id !== CURRENT_TERM) return "";  // these measures exist only for the sitting council
    const own = [
      { id: "council_attendance_pct", note: "their own attendance" },
      { id: "nonroutine_bills_sponsored_current_session", note: "their own legislation" },
      { id: "c311_response_days", note: "city services in their ward", delta: true },
    ];
    const cards = [];
    for (const spec of own) {
      const metric = metricById(spec.id);
      if (!metric) continue;
      const values = [];
      for (const ward of state.wards) {
        const cell = state.latest[ward.ward_id]?.[spec.id];
        if (cell && Number.isFinite(cell.v)) values.push({ ward, v: cell.v });
      }
      if (!values.length) continue;
      values.sort((a, b) => (metric.direction === "lower" ? a.v - b.v : b.v - a.v));
      const fmt = (v) => WardWiseExplorer.formatMetricValue(v, metric);
      const rows = values.slice(0, 5).map(({ ward, v }, i) => {
        const alder = ward.alderperson || {};
        const face = alder.photo_url
          ? `<img src="${esc(alder.photo_url)}" alt="" loading="lazy">`
          : `<span class="attribution-num">${esc(ward.ward_number || ward.ward_id)}</span>`;
        return `<li>${face}<span>#${i + 1} ${esc(alder.name || `Ward ${ward.ward_number || ward.ward_id}`)}
          <em>Ward ${esc(ward.ward_number || ward.ward_id)} · ${fmt(v)}</em></span></li>`;
      }).join("");
      cards.push(`
        <div class="attribution-card">
          <h4>${esc(metric.label)}</h4>
          <p class="attribution-note">${esc(spec.note)} — best five of ${values.length}</p>
          <ol>${rows}</ol>
        </div>`);
    }
    return cards.length
      ? `<h3 class="wardreport-domain">Standouts</h3>
         <p class="attribution-lead">A highlight reel on measures recorded per alderperson —
           attendance, sponsorship, menu choices. Worth celebrating, with the usual caveat: these
           reflect each office's circumstances too, not effort alone.</p>
         <div class="attribution-cards">${cards.join("")}</div>`
      : "";
  }

  async function render() {
    const el = content();
    if (!el || !state.manifest) return;
    const xId = document.getElementById("alder-metric-x").value;
    const yId = document.getElementById("alder-metric-y").value;
    const xMode = state.termModes[xId] || "level";
    const yMode = state.termModes[yId] || "level";
    if (!metricById(xId) || !metricById(yId)) { el.innerHTML = "<p>Pick two metrics.</p>"; return; }
    el.innerHTML = "<p>Loading…</p>";
    const [xAxis, yAxis] = await Promise.all([axisSeries(xId, xMode), axisSeries(yId, yMode)]);
    const typed = (id) => {
      const raw = (document.getElementById(id).value || "").trim();
      return raw === "" ? NaN : Number(raw);
    };
    const xStd = standardFor(xAxis, typed("alder-threshold-x"));
    const yStd = standardFor(yAxis, typed("alder-threshold-y"));
    el.innerHTML = termNoteHtml(xAxis, yAxis) + biplotHtml(xAxis, yAxis, xStd, yStd) + attributionCardsHtml();
    const params = new URLSearchParams({ term: term.id, x: xId, y: yId });
    history.replaceState(null, "", `${location.pathname}?${params}`);
    WardWiseExplorer.track("report_alder",
      { metric_x: xId, metric_y: yId, mode_x: xMode, mode_y: yMode, term: term.id });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensureLoaded);
  else ensureLoaded();
})();
