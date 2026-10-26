// K3: the sequenced explorer. Landing -> your ward -> choose what matters -> compare.
//
// Four commitments, carried from the design review:
//   1. A named starter set replaces the random default. Every visitor sees the
//      same Chicago until they change it, and the copy never claims they chose.
//   2. Rank leads everywhere. The composite rescales whenever the mix changes,
//      so the raw score never appears as a headline number.
//   3. Every edit states its consequence in one sentence, next to the row that
//      caused it, and the URL always carries the exact view for sharing.
//   4. Time is a first-class axis. The API keeps a score matrix per year back to
//      2002, so the same rank you see today can be run against any past year and
//      plotted. Coverage grew over that span, so every historical number says how
//      many of your measures actually existed then.
//
// Scoring mirrors the server: each metric's ward value is min-max normalized to
// 0-100 across wards (direction-aware), the composite is the weighted average of
// those, and rank is position within the 50. All client math runs on the same
// score matrix the classic explorer uses.

(function () {
  "use strict";

  const api = window.WardWiseExplorer;

  const STARTER = {
    park_count: 1,
    library_count: 1,
    community_belonging_pct: 1,
    frequent_mental_distress_pct: 1,
    landmark_count: 1,
  };

  const STARTER_SENTENCE =
    "parks, libraries, landmarks, community belonging, and mental distress";

  // The API keys wards as "01".."50". Anything the map, the URL, or a click
  // hands us gets normalized to that shape before it touches the data.
  const pad = (value) => String(Number(value)).padStart(2, "0");

  // Coverage thins out fast before 2002 (two metrics in 1990), so the time
  // machine starts where a composite is worth computing.
  const EARLIEST_YEAR = 2002;
  // Each year is a separate ~200KB matrix fetch, so a wide range gets sampled
  // rather than walked year by year.
  const MAX_YEAR_FETCHES = 8;

  const state = {
    view: "landing", // landing | ward | list | compare
    wardId: null,
    vsId: null,
    weights: { ...STARTER },
    edited: false,
    lastShift: null, // { metricId, label, from, to, removed }
    openDomains: new Set(),
    detailFor: null,
    search: "",
    // A rank means nothing until you know what it is a rank of, so opening a
    // ward asks for a list before it shows one. Set by picking any list, by
    // editing the measures, or by arriving on a link that already carries one.
    mixChosen: false,
    presetName: null, // which starting point is loaded, for the highlighted pill
    peekOpen: null,
    picking: null,
    year: "latest", // "latest" or a four-digit year: what the whole page reads
    span: 10, // years back the trajectory covers; null means all of them
    sessionId: `k3-${Math.random().toString(36).slice(2, 10)}`,
  };

  const data = {
    metrics: [],
    metricById: new Map(),
    wards: [],
    wardById: new Map(),
    years: new Map(), // "latest" | year -> wardId -> metricId -> { s, v }
    yearsWanted: new Set(), // fetches in flight, so we never ask twice
    availableYears: [], // years the ward actually has records for
    geojson: null,
  };

  let map = null;
  let geoLayer = null;

  // ---------- small helpers ----------

  const esc = (value) => api.escapeHtml(value);

  function ord(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // 1st, 2nd, 3rd get the podium treatment. The number is always spelled out
  // beside it, so the color is decoration on top of the fact, never the fact.
  function medal(rank) {
    return rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
  }

  function medalClass(rank, prefix) {
    const name = medal(rank);
    return name ? ` ${prefix || ""}${name}` : "";
  }

  function el(id) {
    return document.getElementById(id);
  }

  function show(id, visible) {
    el(id).hidden = !visible;
  }

  function toast(message) {
    const node = el("k3-toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      node.hidden = true;
    }, 2600);
  }

  function wardName(wardId) {
    const ward = data.wardById.get(pad(wardId));
    return ward ? ward.display_name : `Ward ${Number(wardId)}`;
  }

  function wardHoods(wardId) {
    const ward = data.wardById.get(pad(wardId));
    const overlaps = ward?.community_area_overlaps || [];
    return overlaps
      .slice(0, 2)
      .map((area) => area.name)
      .join(" & ");
  }

  // ---------- the year the page is reading ----------

  function cells() {
    return data.years.get(state.year) || data.years.get("latest") || {};
  }

  function yearLabel(year) {
    return year === "latest" ? "today" : String(year);
  }

  // A year's matrix arrives on demand and stays cached. Callers get a promise
  // that resolves once the year is usable (or immediately if it already is).
  async function loadYear(year) {
    if (data.years.has(year)) return data.years.get(year);
    if (data.yearsWanted.has(year)) return null;
    data.yearsWanted.add(year);
    try {
      const raw = await api.fetchJson(
        `/api/metrics/score-matrix?area_type=ward&year=${encodeURIComponent(year)}`,
        "Unable to load that year.",
      );
      const matrix = raw.matrix || {};
      const grid = matrix[String(year)] || matrix.latest || null;
      if (grid && Object.keys(grid).length) {
        data.years.set(year, grid);
        return grid;
      }
    } catch (_error) {
      /* a missing year just stays missing; the chart shows the gap */
    } finally {
      data.yearsWanted.delete(year);
    }
    return null;
  }

  // ---------- scoring, the same math as the server ----------

  function computeScores(weights, grid) {
    const source = grid || cells();
    const active = Object.entries(weights).filter(([, w]) => Number(w) > 0);
    const rows = [];
    Object.entries(source).forEach(([wardId, wardCells]) => {
      let total = 0;
      let applied = 0;
      let used = 0;
      active.forEach(([metricId, weight]) => {
        if (metricId in wardCells) {
          total += wardCells[metricId].s * Number(weight);
          applied += Number(weight);
          used += 1;
        }
      });
      rows.push({
        wardId,
        score: applied ? Math.round((total / applied) * 100) / 100 : null,
        used,
        of: active.length,
      });
    });
    const ranked = rows.filter((r) => r.score !== null);
    ranked.sort((a, b) => b.score - a.score);
    ranked.forEach((row, index) => {
      row.rank = index + 1;
    });
    return ranked;
  }

  function scoreRow(wardId, weights, grid) {
    return computeScores(weights, grid).find((row) => row.wardId === pad(wardId)) || null;
  }

  function metricStanding(metricId, wardId) {
    const entries = [];
    Object.entries(cells()).forEach(([wid, wardCells]) => {
      if (metricId in wardCells) entries.push([wid, wardCells[metricId].s, wardCells[metricId].v]);
    });
    entries.sort((a, b) => b[1] - a[1]);
    const index = entries.findIndex(([wid]) => wid === pad(wardId));
    if (index === -1) return null;
    return { rank: index + 1, n: entries.length, value: entries[index][2] };
  }

  function consequenceOf(metricId, removed) {
    const before = scoreRow(state.wardId, state.weights);
    const next = { ...state.weights };
    if (removed) delete next[metricId];
    else next[metricId] = 1;
    const after = scoreRow(state.wardId, next);
    return { from: before?.rank ?? null, to: after?.rank ?? null };
  }

  // ---------- URL as the single source of state ----------

  function writeUrl() {
    const params = new URLSearchParams();
    if (state.wardId) params.set("ward", String(Number(state.wardId)));
    if (state.view !== "landing" && state.view !== "ward") params.set("view", state.view);
    if (state.vsId && state.view === "compare") params.set("vs", String(Number(state.vsId)));
    if (state.year !== "latest") params.set("y", state.year);
    if (state.edited) {
      const mix = Object.entries(state.weights)
        .map(([id, w]) => (Number(w) === 1 ? id : `${id}:${w}`))
        .join(",");
      params.set("m", mix);
    }
    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  function readUrl() {
    const params = new URLSearchParams(location.search);
    const ward = params.get("ward");
    if (ward && /^\d{1,2}$/.test(ward)) {
      state.wardId = pad(ward);
      state.view = "ward";
    }
    const view = params.get("view");
    if (state.wardId && (view === "list" || view === "compare")) state.view = view;
    const vs = params.get("vs");
    if (vs && /^\d{1,2}$/.test(vs)) state.vsId = pad(vs);
    const year = params.get("y");
    if (year && /^\d{4}$/.test(year)) state.year = Number(year);
    const mix = params.get("m");
    if (mix) {
      const weights = {};
      mix.split(",").forEach((token) => {
        const [id, w] = token.split(":");
        if (id) weights[id.trim()] = Number(w || 1) || 1;
      });
      if (Object.keys(weights).length) {
        state.weights = weights;
        state.edited = true;
        state.mixChosen = true; // a shared link already carries a choice
      }
    }
  }

  // ---------- boot ----------

  async function boot() {
    readUrl();
    try {
      const [metricsRaw, wardsRaw, geojson, matrixRaw] = await Promise.all([
        api.fetchMetrics(),
        api.fetchExplorerWards(),
        api.fetchWardGeojson(),
        api.fetchJson("/api/metrics/score-matrix?area_type=ward", "Unable to load scores."),
      ]);
      data.metrics = Array.isArray(metricsRaw)
        ? metricsRaw
        : metricsRaw.metrics || Object.values(metricsRaw).find(Array.isArray) || [];
      data.metrics.forEach((metric) => data.metricById.set(metric.metric_id, metric));
      data.wards = Array.isArray(wardsRaw)
        ? wardsRaw
        : wardsRaw.wards || Object.values(wardsRaw).find(Array.isArray) || [];
      data.wards.forEach((ward) => data.wardById.set(pad(ward.ward_id), ward));
      const matrix = matrixRaw.matrix || matrixRaw;
      data.years.set("latest", matrix.latest || matrix);
      data.geojson = geojson;
    } catch (error) {
      el("k3-landing").insertAdjacentHTML(
        "beforeend",
        `<p class="k3-quiet">${esc(error.message)} Refresh to try again.</p>`,
      );
      revealMap();
      return;
    }
    initMap();
    if (state.year !== "latest") await loadYear(state.year);
    render();
  }

  // ---------- map ----------

  function hueColor(t) {
    const from = [238, 233, 250];
    const to = [46, 16, 101];
    const mix = from.map((c, i) => Math.round(c + (to[i] - c) * t));
    return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
  }

  // The outline skeleton holds the box until real boundaries AND a first screen
  // of tiles are down. Without the tile wait the outlines vanish into a white
  // rectangle, which is the blank state we were trying to avoid.
  let mapRevealed = false;

  function revealMap() {
    if (mapRevealed) return;
    mapRevealed = true;
    const skeleton = el("k3-mapskel");
    if (skeleton) skeleton.classList.add("gone");
  }

  function initMap() {
    map = L.map("k3-map", {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: true,
    });
    // CARTO Positron: the quiet light basemap, free for public projects.
    // It matches the page instead of fighting the choropleth.
    const tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 15,
    }).addTo(map);
    tiles.on("load", revealMap);
    geoLayer = L.geoJSON(data.geojson, {
      style: wardStyle,
      onEachFeature: (feature, layer) => {
        const wardId = featureWardId(feature);
        layer.bindTooltip(labelFor(wardId), {
          permanent: true,
          direction: "center",
          className: "k3-ward-label",
        });
        layer.on("click", () => {
          selectWard(wardId, "map");
        });
      },
    }).addTo(map);
    map.fitBounds(geoLayer.getBounds(), { padding: [8, 8] });
    paintMap();
    // Tiles can stall behind a slow CDN; the boundaries alone are enough to
    // stop showing a skeleton, so cap the wait.
    setTimeout(revealMap, 2500);
  }

  function featureWardId(feature) {
    const props = feature.properties || {};
    return pad(props.ward_id ?? props.ward ?? props.WARD ?? props.ward_num);
  }

  function labelFor(wardId) {
    return `<span data-ward-label="${wardId}">${Number(wardId)}</span>`;
  }

  function wardStyle(feature) {
    const wardId = featureWardId(feature);
    const selected = wardId === state.wardId;
    const versus = wardId === state.vsId && state.view === "compare";
    return {
      fillColor: mapFill(wardId),
      fillOpacity: 0.82,
      color: selected ? "#17181c" : versus ? "#c2410c" : "#ffffff",
      weight: selected || versus ? 2.5 : 1,
    };
  }

  let paintCache = null;

  function paintMap() {
    const ranked = computeScores(state.weights);
    if (!ranked.length) return;
    const scores = ranked.map((row) => row.score);
    paintCache = {
      byWard: new Map(ranked.map((row) => [row.wardId, row])),
      min: Math.min(...scores),
      max: Math.max(...scores),
    };
    geoLayer.setStyle(wardStyle);
    document.querySelectorAll("[data-ward-label]").forEach((node) => {
      const row = paintCache.byWard.get(node.dataset.wardLabel);
      const t = row
        ? (row.score - paintCache.min) / Math.max(1e-9, paintCache.max - paintCache.min)
        : 0;
      node.classList.toggle("lite", t > 0.55);
    });
    const median = medianScore(scores);
    el("k3-maplegend").innerHTML =
      `<b>Darker is a higher rank</b> on ${state.edited ? "your list" : "the starter set"}` +
      (state.year === "latest" ? "" : `, as of <b>${state.year}</b>`) +
      `<span class="k3-legendbar" aria-hidden="true"></span>` +
      `median ward ${Math.round(median)}, top ward ${Math.round(paintCache.max)}, ` +
      `so color spans what wards actually score, not an imaginary 100.`;
  }

  function mapFill(wardId) {
    if (!paintCache) return "#eee9fa";
    const row = paintCache.byWard.get(pad(wardId));
    if (!row) return "#eee9fa";
    const t = (row.score - paintCache.min) / Math.max(1e-9, paintCache.max - paintCache.min);
    return hueColor(t);
  }

  function medianScore(scores) {
    const sorted = [...scores].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ---------- view switching ----------

  // Tapping the map while comparing swaps out the second ward, which is the
  // obvious reading of that gesture. Anywhere else it opens the ward.
  // how: "map", "list", "search" or "address", for the ward_selected count.
  function selectWard(wardId, how) {
    const id = pad(wardId);
    // ward stays the visitor's own (added by track); the ward picked here is the one on screen.
    if (how && id !== pad(state.wardId)) api.track("ward_selected", { viewed_ward: id, how });
    if (state.view === "compare" && id !== pad(state.wardId)) {
      state.vsId = id;
    } else {
      state.wardId = id;
      if (state.view !== "compare") state.view = "ward";
    }
    state.peekOpen = null;
    render();
  }

  // Views cross-fade rather than snapping. The map sits outside the swapped
  // sections, so it never re-mounts and never flashes between states.
  let lastView = null;

  function animateIn(id) {
    const node = el(id);
    node.classList.remove("k3-enter");
    void node.offsetWidth; // restart the animation on a repeat entry
    node.classList.add("k3-enter");
  }

  function render() {
    // Every view but the landing one is about a specific ward. Without one
    // there is nothing to render, so fall back rather than paint "Ward 0".
    if (!state.wardId && state.view !== "landing") state.view = "landing";
    const changed = lastView !== state.view;
    el("k3-app").dataset.view = state.view;
    show("k3-landing", state.view === "landing");
    show("k3-ward", state.view === "ward");
    show("k3-list", state.view === "list");
    show("k3-compare", state.view === "compare");
    show("k3-context", state.view !== "landing");
    if (state.view !== "landing") {
      el("k3-context-ward").textContent =
        `${wardHoods(state.wardId) || "Chicago"} · ${wardName(state.wardId)}`;
    }
    if (state.view === "landing") renderLanding();
    if (state.view === "ward") renderWard();
    if (state.view === "list") renderList();
    if (state.view === "compare") renderCompare();
    if (map) paintMap();
    if (changed) {
      animateIn(`k3-${state.view}`);
      if (lastView !== null && window.scrollY > 8) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      lastView = state.view;
    }
    writeUrl();
  }

  // ---------- state 1: landing ----------

  function renderLanding() {
    const box = el("k3-landing-presets");
    if (!PRESETS.length) return;
    const activeName = state.presetName || "";
    box.innerHTML =
      `<div class="k3-lp-head">Or start with a question people argue about</div>` +
      `<div class="k3-pilltray center">` +
      PRESETS.map(
        (preset, index) =>
          `<button type="button" class="k3-preset${preset.name === activeName ? " on" : ""}" ` +
          `data-act="preset" data-idx="${index}" title="${esc(preset.tagline)}">` +
          `${esc(preset.name)}</button>`,
      ).join("") +
      `</div>` +
      `<div class="k3-lp-note">${
        activeName
          ? `The map is showing <b>${esc(activeName)}</b>. Pick your ward to see where it lands.`
          : "Each one loads a different set of measures and recolors the map."
      }</div>`;
  }

  // ---------- state 2: their ward ----------

  // Which set of measures the page is counting right now, by name. Every view
  // that shows a rank shows this, because the rank is meaningless without it.
  function activeMix() {
    if (!state.edited) {
      return { name: "Starter set", tagline: `five everyday measures, ${STARTER_SENTENCE}` };
    }
    const preset = PRESETS.find((p) => p.name === state.presetName);
    return preset || { name: "Your list", tagline: "the measures you picked", custom: true };
  }

  // The starter set is a chip like any other, so getting back to it is one tap
  // rather than a reload.
  function mixTray(withEdit) {
    const mix = activeMix();
    const chip = (name, tagline, index) =>
      `<button type="button" class="k3-preset${name === mix.name ? " on" : ""}" ` +
      `data-act="${index === null ? "starter" : "preset"}"` +
      `${index === null ? "" : ` data-idx="${index}"`} title="${esc(tagline)}">${esc(name)}</button>`;
    return (
      `<div class="k3-mixbar">` +
      `<div class="k3-mixhead">Counting <b>${esc(mix.name)}</b>` +
      `<span>${Object.keys(state.weights).length} measures</span></div>` +
      (withEdit
        ? `<button type="button" class="k3-linkbtn" data-act="open-list">edit this list ›</button>`
        : "") +
      `</div>` +
      `<div class="k3-pilltray">` +
      (mix.custom ? chip("Your list", "the measures you picked", null) : "") +
      chip("Starter set", `five everyday measures, ${STARTER_SENTENCE}`, null) +
      PRESETS.map((preset, index) => chip(preset.name, preset.tagline, index)).join("") +
      `</div>`
    );
  }

  function applyStarter() {
    if (state.presetName === "Your list") return; // the custom chip is a label
    state.weights = { ...STARTER };
    state.edited = false;
    state.mixChosen = true;
    state.presetName = null;
    state.lastShift = null;
    state.peekOpen = null;
    render();
    const row = state.wardId ? scoreRow(state.wardId, state.weights) : null;
    if (row) toast(`Starter set · ${wardName(state.wardId)} ranks ${ord(row.rank)} of 50`);
  }

  // Before a list is picked there is no rank to show, only the question. The
  // pills are the same ones that appear afterwards, so the control a visitor
  // learns here is the one they keep using.
  function renderChooser() {
    const hoods = wardHoods(state.wardId);
    el("k3-ward-head").innerHTML =
      `<div class="k3-wardname">${esc(wardName(state.wardId))}` +
      (hoods ? `<span>${esc(hoods)}</span>` : "") +
      `</div>`;
    el("k3-ward-hero").innerHTML =
      `<div class="k3-ask"><h3>What should we measure it on?</h3>` +
      `<p>Pick one to see where ${esc(wardName(state.wardId))} stands. You can switch ` +
      `lists any time, and add or drop individual measures once you are in.</p>` +
      `<div class="k3-pilltray">` +
      `<button type="button" class="k3-preset" data-act="starter" ` +
      `title="five everyday measures, ${esc(STARTER_SENTENCE)}">Starter set</button>` +
      PRESETS.map(
        (preset, index) =>
          `<button type="button" class="k3-preset" data-act="preset" data-idx="${index}" ` +
          `title="${esc(preset.tagline)}">${esc(preset.name)}</button>`,
      ).join("") +
      `</div>` +
      `<button type="button" class="k3-seeall" data-act="open-list">` +
      `Or build your own from everything we measure ›</button></div>`;
    ["k3-field", "k3-peek", "k3-overtime"].forEach((id) => {
      el(id).innerHTML = "";
    });
    el("k3-ward-mix").innerHTML = "";
  }

  function renderWard() {
    el("k3-ward").dataset.choosing = state.mixChosen ? "no" : "yes";
    if (!state.mixChosen) {
      renderChooser();
      return;
    }
    const row = scoreRow(state.wardId, state.weights);
    const hoods = wardHoods(state.wardId);
    el("k3-ward-head").innerHTML =
      `<div class="k3-wardname">${esc(wardName(state.wardId))}` +
      (hoods ? `<span>${esc(hoods)}</span>` : "") +
      `</div>` +
      (state.year === "latest"
        ? ""
        : `<div class="k3-timenote">Viewing <b>${state.year}</b>, not today` +
          `<button type="button" data-act="year-now">back to today</button></div>`);

    const active = Object.keys(state.weights);
    const standings = active
      .map((id) => ({ id, metric: data.metricById.get(id), standing: metricStanding(id, state.wardId) }))
      .filter((item) => item.metric && item.standing);
    const ahead = standings.filter((item) => item.standing.rank <= 25).length;

    const mix = activeMix();
    const missing = active.length - standings.length;
    el("k3-ward-hero").innerHTML =
      `<div class="k3-hero-big num${medalClass(row?.rank, "m-")}">${row ? ord(row.rank) : "?"}` +
      `<small>of 50 wards</small></div>` +
      `<div class="k3-starter">on <b>${esc(mix.name)}</b>, ` +
      `${esc(mix.tagline.charAt(0).toLowerCase() + mix.tagline.slice(1))}. ` +
      `${esc(wardName(state.wardId))} is ahead of the city median on ${ahead} of the ` +
      `${standings.length}.` +
      (missing > 0
        ? ` ${missing === 1 ? "One measure has" : `${missing} measures have`} no record for ` +
          `${yearLabel(state.year)}, so ${missing === 1 ? "it is" : "they are"} left out.`
        : "") +
      `</div>`;

    el("k3-ward-mix").innerHTML = mixTray(true);
    renderField(row);
    renderPeek(standings);
    renderOverTime();
  }

  function renderField(row) {
    const ranked = computeScores(state.weights);
    if (!ranked.length) {
      el("k3-field").innerHTML = "";
      return;
    }
    const scores = ranked.map((r) => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = Math.max(1e-9, max - min);
    const pct = (s) => ((s - min) / span) * 100;
    const median = medianScore(scores);

    const bins = new Array(12).fill(0);
    ranked.forEach((r) => {
      bins[Math.min(11, Math.floor(pct(r.score) / (100 / 12)))] += 1;
    });
    const smooth = bins.map((v, i) => ((bins[i - 1] || 0) + 2 * v + (bins[i + 1] || 0)) / 4);
    const peak = Math.max(...smooth);
    let hill = "0,34 ";
    smooth.forEach((v, i) => {
      hill += `${((i + 0.5) * (100 / 12)).toFixed(1)},${(34 - (v / peak) * 26).toFixed(1)} `;
    });
    hill += "100,34";

    const warm = [194, 65, 12];
    const gray = [186, 186, 196];
    const cool = [76, 29, 149];
    const tickColor = (t) => {
      const [a, b, k] = t < 0.5 ? [warm, gray, t * 2] : [gray, cool, (t - 0.5) * 2];
      const mix = a.map((c, i) => Math.round(c + (b[i] - c) * k));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    };

    let ticks = "";
    ranked.forEach((r) => {
      const x = pct(r.score).toFixed(1);
      const me = r.wardId === state.wardId;
      // Each line is a ward, so each line says which one on hover. SVG elements
      // carry datasets and answer closest(), so the same delegated handler
      // covers this chart and the compare strips.
      ticks +=
        `<line x1="${x}" y1="${me ? 8 : 22}" x2="${x}" y2="34" ` +
        `stroke="${me ? "#4c1d95" : tickColor(pct(r.score) / 100)}" ` +
        `stroke-width="${me ? 3 : 1.6}" vector-effect="non-scaling-stroke"` +
        ` data-wardtick data-tip="${tipFor(r.wardId, r.rank, "on your list")}"` +
        `${me ? "" : ' opacity="0.85"'}/>`;
    });

    const you = ranked.find((r) => r.wardId === state.wardId);
    el("k3-field").innerHTML =
      `<div class="k3-field"><div class="k3-fieldviz" role="img" ` +
      `aria-label="All 50 wards by score, ${esc(wardName(state.wardId))} pinned">` +
      (you
        ? `<span class="k3-youpin" style="left:${pct(you.score).toFixed(1)}%">You · ${ord(you.rank)}</span>`
        : "") +
      `<span class="k3-medflag" style="left:${pct(median).toFixed(1)}%">middle of the pack</span>` +
      `<svg viewBox="0 0 100 36" preserveAspectRatio="none">` +
      `<defs><linearGradient id="k3fg" x1="0" y1="0" x2="1" y2="0">` +
      `<stop offset="0%" stop-color="#c2410c"/><stop offset="50%" stop-color="#babac4"/>` +
      `<stop offset="100%" stop-color="#4c1d95"/></linearGradient></defs>` +
      `<polygon points="${hill}" fill="url(#k3fg)" opacity="0.16"/>` +
      `<polyline points="${hill}" fill="none" stroke="url(#k3fg)" stroke-width="1.5" opacity="0.5" vector-effect="non-scaling-stroke"/>` +
      ticks +
      `<line x1="${pct(median).toFixed(1)}" y1="6" x2="${pct(median).toFixed(1)}" y2="34" ` +
      `stroke="#6f7683" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` +
      `</svg></div>` +
      `<div class="k3-fieldlabels"><span class="lo">behind</span>` +
      `<span>every line is one ward</span><span class="hi">ahead</span></div>` +
      `<div class="k3-fieldcap">The hill shows where wards bunch up. ` +
      `<b>${esc(wardName(state.wardId))} is the pinned line.</b> ` +
      `Hover any line to see which ward it is.</div></div>`;
  }

  // one measure, all 50 wards on its real value scale, so closeness is
  // visible: 2nd place one landmark behind 1st reads differently than
  // 2nd place forty behind
  function relativePanel(metricId) {
    const metric = data.metricById.get(metricId);
    const standing = metricStanding(metricId, state.wardId);
    if (!metric || !standing) return "";
    const entries = [];
    Object.entries(cells()).forEach(([wid, wardCells]) => {
      if (metricId in wardCells) entries.push([wid, wardCells[metricId].s, wardCells[metricId].v]);
    });
    const values = entries.map((e) => e[2]);
    const vmin = Math.min(...values);
    const vmax = Math.max(...values);
    const span = Math.max(1e-9, vmax - vmin);
    const X = (v) => ((v - vmin) / span) * 96 + 2;
    const top = entries.reduce((best, e) => (e[1] > best[1] ? e : best), entries[0]);
    const mine = entries.find((e) => e[0] === pad(state.wardId));
    let ticks = "";
    entries.forEach(([wid, , value]) => {
      if (wid === pad(state.wardId) || wid === top[0]) return;
      ticks += `<line x1="${X(value).toFixed(1)}" y1="14" x2="${X(value).toFixed(1)}" y2="40" stroke="#d5d8df" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`;
    });
    ticks += `<line x1="${X(top[2]).toFixed(1)}" y1="8" x2="${X(top[2]).toFixed(1)}" y2="40" stroke="#6f7683" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
    ticks += `<line x1="${X(mine[2]).toFixed(1)}" y1="8" x2="${X(mine[2]).toFixed(1)}" y2="40" stroke="#4c1d95" stroke-width="3" vector-effect="non-scaling-stroke"/>`;
    const fmt = (v) => api.formatMetricValue(v, metric);
    const gapWords =
      standing.rank === 1
        ? `${esc(wardName(state.wardId))} sets the pace on this one.`
        : `The lead ward has <b>${esc(fmt(top[2]))}</b>, ${esc(wardName(state.wardId))} has ` +
          `<b>${esc(fmt(mine[2]))}</b>, so ${ord(standing.rank)} place sits exactly that far back.`;
    return (
      `<div class="k3-relative"><h6>${esc(metric.label)} · every ward on the real scale</h6>` +
      `<div class="relviz">` +
      `<span class="youtag" style="left:${X(mine[2]).toFixed(1)}%">You · ${esc(fmt(mine[2]))}</span>` +
      (top[0] !== pad(state.wardId)
        ? `<span class="toptag" style="left:${X(top[2]).toFixed(1)}%">Top · ${esc(fmt(top[2]))}</span>`
        : "") +
      `<svg viewBox="0 0 100 40" preserveAspectRatio="none">${ticks}</svg>` +
      `</div>` +
      `<div class="relcap">${gapWords}` +
      (metric.direction === "lower" ? " Lower is better here, the ranking already accounts for it." : "") +
      `</div></div>`
    );
  }

  function renderPeek(standings) {
    const sorted = [...standings].sort((a, b) => a.standing.rank - b.standing.rank);
    const strongest = sorted.slice(0, 3);
    const weakest = sorted.slice(-2).filter((item) => !strongest.includes(item));
    // "Weakest" means weakest on your list, which is not the same as bad. The
    // warm treatment is reserved for measures actually behind the city median,
    // so a 10th-of-50 never gets painted like a problem.
    const box = (item, weak) =>
      `<button type="button" class="k3-rankbox${weak && item.standing.rank > 25 ? " weak" : ""}` +
      `${medalClass(item.standing.rank, "m-")}` +
      `${state.peekOpen === item.id ? " open" : ""}" data-act="rankbox" ` +
      `data-metricbox="${esc(item.id)}">` +
      `<span class="ord num">${ord(item.standing.rank)}</span>` +
      `<span class="lbl">${esc(item.metric.label)}</span></button>`;
    const openPanel = state.peekOpen ? relativePanel(state.peekOpen) : "";
    el("k3-peek").innerHTML =
      `<div class="k3-peekhead">Strongest, on ${state.edited ? "your list" : "the starter set"} · ` +
      `tap a box for the real gaps</div>` +
      `<div class="k3-rankboxes">${strongest.map((item) => box(item, false)).join("")}</div>` +
      (weakest.length
        ? `<div class="k3-peekhead">Weakest</div>` +
          `<div class="k3-rankboxes">${weakest.map((item) => box(item, true)).join("")}</div>`
        : "") +
      openPanel +
      `<button type="button" class="k3-seeall" data-act="open-list">` +
      `See everything we measure for ${esc(wardName(state.wardId))} ›</button>`;
  }

  // ---------- the time machine ----------

  const SPANS = [
    { label: "5 years", years: 5 },
    { label: "10 years", years: 10 },
    { label: "20 years", years: 20 },
    { label: "All", years: null },
  ];

  function latestYear() {
    const years = data.availableYears;
    return years.length ? years[years.length - 1] : new Date().getFullYear();
  }

  function rangeYears() {
    const all = data.availableYears;
    if (!all.length) return [];
    if (state.span === null) return all;
    const cutoff = latestYear() - state.span + 1;
    return all.filter((year) => year >= cutoff);
  }

  // Every year is its own request, so a wide window gets sampled evenly. The
  // endpoints always survive so the span reads honestly.
  function sampledYears(years) {
    if (years.length <= MAX_YEAR_FETCHES) return years;
    const step = (years.length - 1) / (MAX_YEAR_FETCHES - 1);
    const picked = new Set();
    for (let i = 0; i < MAX_YEAR_FETCHES; i += 1) {
      picked.add(years[Math.round(i * step)]);
    }
    return [...picked].sort((a, b) => a - b);
  }

  let trajectoryToken = 0;

  // Each year is its own matrix, so a full range is a couple of megabytes. That
  // is fine to spend on a chart somebody is looking at and wasteful otherwise,
  // so the fetches wait until the section is near the viewport. Once a visitor
  // has scrolled there, later ranges load straight away.
  let overTimeSeen = false;
  let overTimeWait = null;

  function whenOverTimeVisible() {
    if (overTimeSeen) return Promise.resolve();
    // Plain geometry rather than IntersectionObserver: an observer in a
    // backgrounded tab can go quiet, and a chart stuck on "loading" forever is
    // a worse failure than a scroll listener.
    const near = () => {
      const box = el("k3-overtime").getBoundingClientRect();
      return box.top < window.innerHeight + 400 && box.bottom > -400;
    };
    if (near()) {
      overTimeSeen = true;
      return Promise.resolve();
    }
    if (overTimeWait) return overTimeWait;
    overTimeWait = new Promise((resolve) => {
      const check = () => {
        if (!near()) return;
        overTimeSeen = true;
        overTimeWait = null;
        window.removeEventListener("scroll", check);
        window.removeEventListener("resize", check);
        resolve();
      };
      window.addEventListener("scroll", check, { passive: true });
      window.addEventListener("resize", check);
    });
    return overTimeWait;
  }

  async function renderOverTime() {
    const token = (trajectoryToken += 1);
    const wardId = state.wardId;
    const live = () => token === trajectoryToken && state.view === "ward" && state.wardId === wardId;

    // The ward's own record tells us which years to even offer, so it reloads
    // whenever the visitor moves to a different ward.
    if (data.seriesWard !== wardId) {
      el("k3-overtime").innerHTML =
        `<div class="k3-peekhead">${esc(wardName(wardId))} over time</div>` +
        `<div class="k3-rankrec loading" aria-hidden="true"></div>` +
        `<div class="k3-trendcap">Pulling this ward's record&hellip;</div>`;
      await loadAvailableYears(wardId);
      if (!live()) return;
    }
    drawTrajectory();
    await whenOverTimeVisible();
    if (!live()) return;

    // Three at a time: enough to feel quick, gentle enough on the API. Each
    // year that lands redraws, so the line fills in rather than popping.
    const queue = sampledYears(rangeYears()).filter((year) => !data.years.has(year));
    const workers = new Array(Math.min(3, queue.length)).fill(null).map(async () => {
      while (queue.length) {
        const year = queue.shift();
        await loadYear(year);
        if (!live()) return;
        drawTrajectory();
      }
    });
    await Promise.all(workers);
    if (live()) drawTrajectory();
  }

  async function loadAvailableYears(wardId) {
    try {
      const raw = await api.fetchTimeseries({ areaId: wardId });
      const years = new Set();
      (raw.timeseries || []).forEach((entry) => {
        (entry.observations || []).forEach((obs) => {
          const year = Number((obs.period_end || "").slice(0, 4));
          if (year >= EARLIEST_YEAR) years.add(year);
        });
      });
      data.availableYears = [...years].sort((a, b) => a - b);
      data.wardSeries = raw.timeseries || [];
    } catch (_error) {
      data.availableYears = [];
      data.wardSeries = [];
    }
    data.seriesWard = wardId;
  }

  function drawTrajectory() {
    const years = rangeYears();
    const wanted = sampledYears(years);
    if (!wanted.length) {
      el("k3-overtime").innerHTML =
        `<div class="k3-peekhead">${esc(wardName(state.wardId))} over time</div>` +
        `<div class="k3-trendcap">No year-by-year records for this ward yet. ` +
        `They appear here as the catalog picks up history.</div>`;
      renderMultiples();
      return;
    }

    // A "rank" built from one measure is that measure's rank, not the rank of
    // your list, so a year needs at least two of your measures before it earns
    // a point on the line.
    const MIN_MEASURES = 2;
    const points = wanted.map((year) => {
      const grid = data.years.get(year);
      if (!grid) return { year, pending: true };
      const row = scoreRow(state.wardId, state.weights, grid);
      if (!row || row.used < MIN_MEASURES) {
        return { year, empty: true, used: row ? row.used : 0, of: Object.keys(state.weights).length };
      }
      return { year, rank: row.rank, used: row.used, of: row.of };
    });
    const real = points.filter((p) => p.rank);

    const first = wanted[0];
    const last = wanted[wanted.length - 1];
    const X = (year) => 8 + ((year - first) / Math.max(1, last - first)) * 90;
    const Y = (rank) => 7 + ((rank - 1) / 49) * 25;

    let svg = `<svg viewBox="0 0 100 38" preserveAspectRatio="none">`;
    [1, 25, 50].forEach((rank) => {
      svg +=
        `<line x1="7" y1="${Y(rank).toFixed(1)}" x2="99" y2="${Y(rank).toFixed(1)}" ` +
        `stroke="#00000012" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    });
    wanted.forEach((year) => {
      svg +=
        `<line x1="${X(year).toFixed(1)}" y1="4" x2="${X(year).toFixed(1)}" y2="34" ` +
        `stroke="#00000009" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`;
    });
    if (real.length > 1) {
      const path = real.map((p) => `${X(p.year).toFixed(1)},${Y(p.rank).toFixed(1)}`).join(" ");
      svg +=
        `<polyline points="${path}" fill="none" stroke="#4c1d95" stroke-width="2.2" ` +
        `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }
    real.forEach((p) => {
      const cx = X(p.year).toFixed(1);
      const cy = Y(p.rank).toFixed(1);
      const isNow = p.year === state.year || (state.year === "latest" && p.year === last);
      // Zero-length round-capped lines, because a circle under
      // preserveAspectRatio="none" comes out an ellipse.
      svg +=
        `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}" stroke="#fff" stroke-width="${isNow ? 11 : 8}" ` +
        `stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
        `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy}" stroke="${
          medal(p.rank) ? medalInk(p.rank) : "#4c1d95"
        }" stroke-width="${isNow ? 7.5 : 5}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    });
    svg += `</svg>`;

    // A run of years with too little of your list collapses into one chip. Six
    // dead tiles in a row says nothing that "2017-2023, no records" doesn't.
    const chips = [];
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      if (p.empty) {
        let j = i;
        while (j + 1 < points.length && points[j + 1].empty) j += 1;
        const from = points[i].year;
        const to = points[j].year;
        chips.push(
          `<span class="k3-yearchip empty">` +
            `<span class="yr num">${from}${to === from ? "" : `&ndash;${to}`}</span>` +
            `<span class="rk">&mdash;</span>` +
            `<span class="cv">too few measures</span></span>`,
        );
        i = j;
        continue;
      }
      const active = p.year === state.year;
      const body = p.pending ? "&middot;&middot;&middot;" : ord(p.rank);
      const note = p.pending ? "loading" : `${p.used} of ${p.of}`;
      chips.push(
        `<button type="button" class="k3-yearchip${active ? " on" : ""}` +
          `${p.pending ? " pending" : ""}" data-act="year-pick" data-year="${p.year}"` +
          `${p.pending ? " disabled" : ""}>` +
          `<span class="yr num">${p.year}</span>` +
          `<span class="rk num${medalClass(p.rank, "m-")}">${body}</span>` +
          `<span class="cv num">${note}</span></button>`,
      );
    }

    const pending = points.some((p) => p.pending);
    const oldest = real[0];
    const newest = real[real.length - 1];
    let caption;
    if (pending && real.length < 2) {
      caption =
        `<b>Loading ${wanted.length} years&hellip;</b> Each year is scored on the same list ` +
        `you picked, so the line is your question asked over and over.`;
    } else if (real.length < 2) {
      // Thin history is a fact about the list, not a failure. Say which lists
      // do have depth so the visitor has somewhere to go.
      const deep = PRESETS.filter((p) =>
        ["Main Street", "Getting Around", "Housing Squeeze"].includes(p.name),
      ).map((p) => p.name);
      caption =
        `<b>Your list has almost no yearly history.</b> Most of these measures are ` +
        `point-in-time counts, so there is nothing to trace back. ` +
        (deep.length ? `${deep.join(", ")} go back to 2002 if you want a long line.` : "");
    } else {
      const moved = oldest.rank - newest.rank;
      const direction =
        moved > 0 ? `climbed ${moved} places` : moved < 0 ? `slipped ${-moved} places` : "held its place";
      caption =
        `<b>${esc(wardName(state.wardId))} ${direction}</b> between ${oldest.year} and ${newest.year} ` +
        `on your list. ` +
        (oldest.used === newest.used
          ? `Both ends rest on ${oldest.used} of your ${oldest.of} measures.`
          : `${oldest.year} rests on ${oldest.used} of your ${oldest.of} measures and ` +
            `${newest.year} on ${newest.used}, so the early end is built from less.`);
    }

    const today = scoreRow(state.wardId, state.weights, data.years.get("latest"));
    const todayChip =
      `<button type="button" class="k3-yearchip${state.year === "latest" ? " on" : ""}" ` +
      `data-act="year-now"><span class="yr">Today</span>` +
      `<span class="rk num${medalClass(today?.rank, "m-")}">` +
      `${today ? ord(today.rank) : "&mdash;"}</span></button>`;

    el("k3-overtime").innerHTML =
      `<div class="k3-timehead">` +
      `<div class="k3-peekhead">${esc(wardName(state.wardId))} over time</div>` +
      `<div class="k3-spans">` +
      SPANS.map(
        (span, index) =>
          `<button type="button" class="k3-span${span.years === state.span ? " on" : ""}" ` +
          `data-act="span" data-idx="${index}">${esc(span.label)}</button>`,
      ).join("") +
      `</div></div>` +
      `<div class="k3-rankrec">${svg}` +
      `<span class="k3-rr-ylab" style="top:8%">1st</span>` +
      `<span class="k3-rr-ylab" style="top:44%">25th</span>` +
      `<span class="k3-rr-ylab" style="top:80%">50th</span></div>` +
      `<div class="k3-yearchips">${todayChip}${chips.join("")}</div>` +
      `<div class="k3-trendcap">${caption} Tap a year to read the whole page as of then.</div>` +
      `<div class="k3-multis" id="k3-multis"></div>`;

    renderMultiples();
  }

  function medalInk(rank) {
    return rank === 1 ? "#a8801a" : rank === 2 ? "#7b8494" : rank === 3 ? "#a0602c" : "#4c1d95";
  }

  // Individual measures that carry their own yearly series, windowed to the
  // same range as the trajectory above so the two read together.
  function renderMultiples() {
    const holder = el("k3-multis");
    if (!holder) return;
    const series = data.wardSeries || [];
    const window = rangeYears();
    const from = window.length ? window[0] : EARLIEST_YEAR;
    const yearly = [];
    series.forEach((entry) => {
      const byYear = new Map();
      (entry.observations || []).forEach((obs) => {
        const year = Number((obs.period_end || "").slice(0, 4));
        if (year >= from) byYear.set(year, Number(obs.value));
      });
      if (byYear.size >= 4) {
        yearly.push({
          metricId: entry.metric_id,
          onList: entry.metric_id in state.weights,
          points: [...byYear.entries()].sort((a, b) => a[0] - b[0]),
        });
      }
    });
    // Measures the visitor actually chose come first; the rest fill the row.
    yearly.sort((a, b) => Number(b.onList) - Number(a.onList) || b.points.length - a.points.length);
    const chosen = yearly.slice(0, 3);
    if (!chosen.length) {
      holder.innerHTML =
        `<div class="k3-multi ghost"><h6>Measure by measure</h6>` +
        `<div class="mv">no yearly series in this window</div>` +
        `<div class="slot">widen the range, or check back<br>as records arrive</div></div>`;
      return;
    }
    holder.innerHTML = chosen
      .map((entry) => {
        const metric = data.metricById.get(entry.metricId);
        const label = metric ? metric.label : entry.metricId;
        const first = entry.points[0];
        const last = entry.points[entry.points.length - 1];
        return (
          `<div class="k3-multi${entry.onList ? " mine" : ""}"><h6>${esc(label)}` +
          (entry.onList ? `<span class="tag">on your list</span>` : "") +
          `</h6>` +
          `<div class="mv num">${esc(api.formatMetricValue(first[1], metric))} in ${first[0]} → ` +
          `${esc(api.formatMetricValue(last[1], metric))} in ${last[0]}</div>` +
          miniChart(entry.points) +
          `</div>`
        );
      })
      .join("");
  }

  function miniChart(points) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const ymax = Math.max(...ys, 1e-9);
    const X = (x) => ((x - x0) / Math.max(1, x1 - x0)) * 94 + 3;
    const Y = (y) => 26 - (y / (ymax * 1.08)) * 22;
    const pts = points.map((p) => `${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(" ");
    const last = points[points.length - 1];
    const ex = X(last[0]).toFixed(1);
    const ey = Y(last[1]).toFixed(1);
    return (
      `<svg viewBox="0 0 100 28" preserveAspectRatio="none">` +
      `<polygon points="${X(points[0][0]).toFixed(1)},26 ${pts} ${ex},26" fill="rgba(76,29,149,.08)"/>` +
      `<polyline points="${pts}" fill="none" stroke="#4c1d95" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
      `<line x1="${ex}" y1="${ey}" x2="${ex}" y2="${ey}" stroke="#fff" stroke-width="9" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
      `<line x1="${ex}" y1="${ey}" x2="${ex}" y2="${ey}" stroke="#4c1d95" stroke-width="5.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
      `</svg>`
    );
  }

  // ---------- state 3: choose what matters ----------

  // Presets: seven starting points for politically engaged residents,
  // proposed by nine single-lens drafts and organized down to seven.
  // Each is name, tagline, metric ids. Ids are validated against the
  // catalog at render time, so a missing measure degrades gracefully.
  const PRESETS = window.K3_PRESETS || [];

  // Which wards share a border, precomputed by scripts/build_map_assets.py.
  const NEIGHBORS = window.K3_NEIGHBORS || {};

  function applyPreset(preset) {
    if (!preset) return;
    const grid = data.years.get("latest") || {};
    const anywhere = (metricId) =>
      Object.values(grid).some((wardCells) => metricId in wardCells);
    const weights = {};
    preset.metric_ids.forEach((id) => {
      if (data.metricById.has(id) && anywhere(id)) weights[id] = 1;
    });
    if (!Object.keys(weights).length) return;
    state.weights = weights;
    state.edited = true;
    state.mixChosen = true;
    state.presetName = preset.name;
    state.lastShift = null;
    state.peekOpen = null;
    render();
    const row = state.wardId ? scoreRow(state.wardId, state.weights) : null;
    toast(
      row
        ? `${preset.name} · ${wardName(state.wardId)} ranks ${ord(row.rank)} of 50`
        : `${preset.name} · ${preset.tagline}`,
    );
  }

  function pill(metricId, onList) {
    const metric = data.metricById.get(metricId);
    if (!metric) return "";
    const standing = metricStanding(metricId, state.wardId);
    return (
      `<button type="button" class="k3-pill${onList ? " on" : ""}" data-act="${onList ? "remove" : "add"}" ` +
      `data-metric="${esc(metricId)}" title="${esc(metric.description || metric.label)}">` +
      `${esc(metric.label)}` +
      (standing
        ? `<span class="rk num${medalClass(standing.rank, "m-")}">${ord(standing.rank)}</span>`
        : `<span class="rk none">no record</span>`) +
      (onList ? `<span class="x">&#10005;</span>` : "") +
      `</button>`
    );
  }

  function renderList() {
    const row = scoreRow(state.wardId, state.weights);
    const count = Object.keys(state.weights).length;
    el("k3-statusline").textContent =
      `${wardName(state.wardId)} · ${row ? `${ord(row.rank)} of 50` : "no rank yet"} · ` +
      `based on your ${count}${state.year === "latest" ? "" : ` · as of ${state.year}`}`;
    el("k3-back-num").textContent = Number(state.wardId);

    let html = "";
    if (PRESETS.length) {
      html += `<div class="k3-listhead"><b>Starting points</b> · tap one to load it</div>`;
      html += mixTray(false);
    }
    html +=
      `<div class="k3-listhead"><b>On your list</b> · ${count} · tap a pill to remove it</div>` +
      `<div class="k3-pilltray">` +
      Object.keys(state.weights).map((id) => pill(id, true)).join("") +
      `</div>`;
    if (state.lastShift) {
      const shift = state.lastShift;
      const metric = data.metricById.get(shift.metricId);
      const moved =
        shift.from === shift.to
          ? "the rank held"
          : `${wardName(state.wardId)} moved from ${ord(shift.from)} to ${ord(shift.to)}`;
      html +=
        `<div class="k3-justrow" style="margin-top:10px">` +
        `${shift.removed ? "Removed" : "Added"} ${esc(metric ? metric.label : "")} · ${esc(moved)}` +
        `<button type="button" data-act="undo">Undo</button></div>`;
    }
    el("k3-onlist").innerHTML = html;

    renderAddMore();
  }

  function renderAddMore() {
    const query = state.search.trim().toLowerCase();
    const wardCells = cells()[pad(state.wardId)] || {};
    const groups = new Map();
    data.metrics.forEach((metric) => {
      if (metric.metric_id in state.weights) return;
      if (!(metric.metric_id in wardCells)) return;
      if (query && !metric.label.toLowerCase().includes(query)) return;
      const domain = api.formatCategory(metric.category);
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain).push(metric);
    });
    const sortedDomains = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    let html = `<div class="k3-listhead"><b>Add more</b> · tap a pill to count it</div>`;
    sortedDomains.forEach(([domain, metrics]) => {
      metrics.sort(
        (a, b) =>
          (metricStanding(a.metric_id, state.wardId)?.rank || 99) -
          (metricStanding(b.metric_id, state.wardId)?.rank || 99),
      );
      const open = query || state.openDomains.has(domain);
      html += `<div class="k3-domfold"><h5>${domain}</h5>`;
      html +=
        `<button type="button" class="toggle" data-act="toggle-domain" data-domain="${domain}">` +
        `${open ? "hide" : `${metrics.length} measures ›`}</button></div>`;
      if (open) {
        html +=
          `<div class="k3-pillgrid">` +
          metrics.map((metric) => pill(metric.metric_id, false)).join("") +
          `</div>`;
      }
    });
    el("k3-addmore").innerHTML = html;
  }

  function changeMix(metricId, removed) {
    const metric = data.metricById.get(metricId);
    const consequence = consequenceOf(metricId, removed);
    if (removed) delete state.weights[metricId];
    else state.weights[metricId] = 1;
    if (!removed && window.WardWiseAnalytics) {
      window.WardWiseAnalytics.measureOpened(metricId, metric ? api.formatCategory(metric.category) : null);
    }
    state.edited = true;
    state.mixChosen = true; // building a list by hand is a choice like any other
    state.presetName = null;
    state.lastShift = { metricId, from: consequence.from, to: consequence.to, removed };
    state.detailFor = null;
    try {
      api.submitMetricSelectionEvent({
        action: removed ? "k3_remove" : "k3_add",
        session_id: state.sessionId,
        changed_metric_id: metricId,
        selected_metrics: Object.entries(state.weights).map(([id, w]) => ({
          metric_id: id,
          weight: w,
        })),
        weights: { ...state.weights },
      });
    } catch (_error) {
      /* telemetry is best-effort */
    }
    render();
    if (metric && consequence.from !== consequence.to) {
      toast(`${wardName(state.wardId)} is now ${ord(consequence.to)} of 50`);
    }
  }

  // ---------- state 4: compare ----------

  // Every ward, as a native dropdown. Native because it is one tap on a phone,
  // keyboard-navigable for free, and needs no popup code of ours.
  // Option labels stay short, because a closed select shows the selected
  // option's own text and a long one truncates to nothing useful. The
  // neighborhoods go on their own line underneath.
  function wardSelect(side, selectedId) {
    const options = data.wards
      .map((ward) => {
        const id = pad(ward.ward_id);
        return `<option value="${id}"${id === selectedId ? " selected" : ""}>${esc(wardName(id))}</option>`;
      })
      .join("");
    const hoods = wardHoods(selectedId);
    return (
      `<select class="k3-wardsel" data-side="${side}" ` +
      `aria-label="Choose the ${side === "a" ? "first" : "second"} ward">${options}</select>` +
      (hoods ? `<div class="hood">${esc(hoods)}</div>` : "")
    );
  }

  // Comparisons worth one tap: who borders you, who is just ahead and just
  // behind on this list, and who leads the city.
  function quickPicks() {
    const ranked = computeScores(state.weights);
    const mine = ranked.find((r) => r.wardId === pad(state.wardId));
    const picks = [];
    const add = (wardId, label) => {
      if (!wardId || wardId === pad(state.wardId) || picks.some((p) => p.id === wardId)) return;
      picks.push({ id: wardId, label });
    };
    if (mine) {
      const above = ranked.find((r) => r.rank === mine.rank - 1);
      const below = ranked.find((r) => r.rank === mine.rank + 1);
      if (above) add(above.wardId, `just ahead · ${ord(above.rank)}`);
      if (below) add(below.wardId, `just behind · ${ord(below.rank)}`);
    }
    const leader = ranked.find((r) => r.rank === 1);
    if (leader) add(leader.wardId, "city leader · 1st");
    (NEIGHBORS[pad(state.wardId)] || []).forEach((id) => add(id, "next to you"));
    return picks;
  }

  function renderCompare() {
    // Default to the ward one place ahead of yours, which is the comparison
    // somebody actually wants, rather than a hardcoded pair.
    if (!state.vsId || state.vsId === pad(state.wardId)) {
      const ranked = computeScores(state.weights);
      const mine = ranked.find((r) => r.wardId === pad(state.wardId));
      const near = mine
        ? ranked.find((r) => r.rank === mine.rank - 1) || ranked.find((r) => r.rank === mine.rank + 1)
        : null;
      state.vsId = near ? near.wardId : (NEIGHBORS[pad(state.wardId)] || ["01"])[0];
    }
    el("k3-back-num-2").textContent = Number(state.wardId);
    const a = scoreRow(state.wardId, state.weights);
    const b = scoreRow(state.vsId, state.weights);
    el("k3-vs").innerHTML =
      mixTray(false) +
      `<div class="k3-vs">` +
      `<div class="side a">${wardSelect("a", pad(state.wardId))}` +
      `<div class="wr num">${a ? `${ord(a.rank)} of 50` : "no rank"}</div></div>` +
      `<button type="button" class="k3-swapsides" data-act="flip" ` +
      `title="Swap sides" aria-label="Swap the two wards">&#8646;</button>` +
      `<div class="side b">${wardSelect("b", pad(state.vsId))}` +
      `<div class="wr num">${b ? `${ord(b.rank)} of 50` : "no rank"}</div></div>` +
      `</div>` +
      `<div class="k3-quickpick"><span class="l">Or compare with</span>` +
      quickPicks()
        .map(
          (pick) =>
            `<button type="button" class="k3-qp${pick.id === pad(state.vsId) ? " on" : ""}" ` +
            `data-act="pick-vs" data-ward="${pick.id}">${esc(wardName(pick.id))}` +
            `<span>${esc(pick.label)}</span></button>`,
        )
        .join("") +
      `</div>`;

    const duels = Object.keys(state.weights)
      .map((id) => {
        const metric = data.metricById.get(id);
        const sa = metricStanding(id, state.wardId);
        const sb = metricStanding(id, state.vsId);
        return metric && sa && sb ? { metric, sa, sb } : null;
      })
      .filter(Boolean);
    const aWins = duels.filter((d) => d.sa.rank < d.sb.rank).length;
    const bWins = duels.filter((d) => d.sb.rank < d.sa.rank).length;
    const bBest = duels
      .filter((d) => d.sb.rank < d.sa.rank)
      .map((d) => d.metric.label.toLowerCase());
    let verdict;
    if (aWins > bWins) {
      verdict =
        `<b><span class="ca">${esc(wardName(state.wardId))}</span> is ahead on ${aWins} of the ` +
        `${duels.length}</b> things on your list.` +
        (bBest.length
          ? ` <span class="cb">${esc(wardName(state.vsId))}</span> leads on ${esc(bBest.join(", "))}.`
          : "");
    } else if (bWins > aWins) {
      verdict =
        `<b><span class="cb">${esc(wardName(state.vsId))}</span> is ahead on ${bWins} of the ` +
        `${duels.length}</b> things on your list.`;
    } else {
      verdict = `<b>Even.</b> Each ward leads on ${aWins} of the ${duels.length}.`;
    }
    el("k3-verdict").innerHTML = `<div class="k3-verdict">${verdict}</div>`;

    // The overall standing, drawn in exactly the same vocabulary as the
    // per-measure strips below it and boxed, so it reads as the headline
    // rather than as a bigger version of the same thing.
    const ranked = computeScores(state.weights);
    const scores = ranked.map((r) => r.score);
    const min = Math.min(...scores);
    const span = Math.max(1e-9, Math.max(...scores) - min);
    const pct = (score) => (((score - min) / span) * 96 + 2);
    const xa = a ? pct(a.score) : 0;
    const xb = b ? pct(b.score) : 0;
    const ticks = ranked
      .map(
        (row) =>
          `<span class="k3-stick" style="left:${pct(row.score).toFixed(2)}%" ` +
          `data-wardtick data-tip="${tipFor(row.wardId, row.rank, "on your list")}"></span>`,
      )
      .join("");
    const crowded = Math.abs(xa - xb) < 13;
    const push = crowded ? 7 : 0;
    const aFirst = xa <= xb;
    const clamp = (x) => Math.min(94, Math.max(6, x));
    el("k3-pairfield").innerHTML =
      `<div class="k3-mainchart"><div class="k3-mainhead">Overall` +
      `<span>every mark is one ward, placed by how it scores on your list</span></div>` +
      `<div class="k3-stripviz">` +
      (a
        ? `<span class="k3-stag a num" style="left:${clamp(xa + (aFirst ? -push : push)).toFixed(2)}%">${ord(a.rank)}</span>`
        : "") +
      (b
        ? `<span class="k3-stag b num" style="left:${clamp(xb + (aFirst ? push : -push)).toFixed(2)}%">${ord(b.rank)}</span>`
        : "") +
      `<span class="k3-sbase"></span>${ticks}` +
      (a
        ? `<span class="k3-spin a" style="left:${xa.toFixed(2)}%" data-wardtick ` +
          `data-tip="${tipFor(state.wardId, a.rank, "on your list")}"></span>`
        : "") +
      (b
        ? `<span class="k3-spin b" style="left:${xb.toFixed(2)}%" data-wardtick ` +
          `data-tip="${tipFor(state.vsId, b.rank, "on your list")}"></span>`
        : "") +
      `</div>` +
      `<div class="k3-stripends"><span>furthest behind</span><span>best in the city</span></div>` +
      `<div class="k3-pairkey"><span class="ka">▎ ${esc(wardName(state.wardId))}</span>` +
      `<span class="kb">▎ ${esc(wardName(state.vsId))}</span>` +
      `<span>hover any mark for that ward</span></div></div>`;

    // One strip per measure: all 50 wards spread across that measure's real
    // scale with both wards pinned. Two bars mirrored from a centreline made
    // you flip one in your head, and neither told you whether the gap was a
    // chasm or a rounding error. A real scale cannot hide that.
    el("k3-duel").innerHTML = duels
      .map((duel) => ({ ...duel, ...fieldFor(duel.metric.metric_id) }))
      .filter((duel) => duel.values)
      // biggest real difference first, so the chart leads with the finding
      .sort((p, q) => Math.abs(q.sa2 - q.sb2) - Math.abs(p.sa2 - p.sb2))
      .map(fieldStrip)
      .join("");
  }

  // Tooltip body for one mark. Stored on the element as an attribute, so the
  // hover handler is a lookup rather than a re-render.
  function tipFor(wardId, rank, detail) {
    const hoods = wardHoods(wardId);
    return esc(
      `<b>${wardName(wardId)}</b>` +
        `<span>${ord(rank)} of 50${detail ? ` · ${detail}` : ""}</span>` +
        (hoods ? `<span class="h">${hoods}</span>` : ""),
    );
  }

  // Every ward's value and score for one measure, carrying the ward id so each
  // mark can say who it is.
  function fieldFor(metricId) {
    const entries = [];
    let sa2 = null;
    let sb2 = null;
    Object.entries(cells()).forEach(([wid, wardCells]) => {
      const cell = wardCells[metricId];
      if (!cell) return;
      entries.push({ wardId: wid, v: cell.v, s: cell.s });
      if (wid === pad(state.wardId)) sa2 = cell.s;
      if (wid === pad(state.vsId)) sb2 = cell.s;
    });
    if (!entries.length || sa2 === null || sb2 === null) return {};
    entries.sort((p, q) => q.s - p.s);
    entries.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    return { entries, values: entries.map((e) => e.v), sa2, sb2 };
  }

  function fieldStrip(duel) {
    const { metric, sa, sb, values, entries } = duel;
    const vmin = Math.min(...values);
    const vmax = Math.max(...values);
    const span = Math.max(1e-9, vmax - vmin);
    const X = (value) => ((value - vmin) / span) * 96 + 2;
    const fmt = (value) => esc(api.formatMetricValue(value, metric));
    const xa = X(sa.value);
    const xb = X(sb.value);
    const tied = Math.abs(xa - xb) < 1;
    // A tie would hide one pin completely under the other, so the two merge
    // into a single split marker instead of one silently disappearing.
    const tipA = tipFor(state.wardId, sa.rank, api.formatMetricValue(sa.value, metric));
    const tipB = tipFor(state.vsId, sb.rank, api.formatMetricValue(sb.value, metric));
    const pins = tied
      ? `<span class="k3-spin tie" style="left:${((xa + xb) / 2).toFixed(2)}%" ` +
        `data-wardtick data-tip="${tipA}"></span>`
      : `<span class="k3-spin a" style="left:${xa.toFixed(2)}%" data-wardtick data-tip="${tipA}"></span>` +
        `<span class="k3-spin b" style="left:${xb.toFixed(2)}%" data-wardtick data-tip="${tipB}"></span>`;
    const ticks = entries
      .map(
        (entry) =>
          `<span class="k3-stick" style="left:${X(entry.v).toFixed(2)}%" data-wardtick ` +
          `data-tip="${tipFor(entry.wardId, entry.rank, api.formatMetricValue(entry.v, metric))}"></span>`,
      )
      .join("");
    const close = Math.abs(xa - xb) < 2.5;
    const leader = sa.rank < sb.rank ? wardName(state.wardId) : wardName(state.vsId);
    const best = Math.max(...values.map((v) => (metric.direction === "lower" ? -v : v)));
    const bestValue = metric.direction === "lower" ? -best : best;
    const caption = close
      ? `<b>Effectively tied.</b> ${esc(leader)} is ahead on paper, ` +
        `but the two sit almost on top of each other.`
      : `<b>${esc(leader)} leads</b>, and the space between the two pins is the whole of it.`;
    const bestWords =
      bestValue !== sa.value && bestValue !== sb.value
        ? ` The city&rsquo;s best is ${fmt(bestValue)}.`
        : "";
    // Labels shove apart when the two pins land close, each away from the
    // other rather than in a fixed direction, since either ward can be on the
    // left depending on the measure.
    const crowded = Math.abs(xa - xb) < 13;
    const push = crowded ? 7 : 0;
    const aFirst = xa <= xb;
    const la = Math.min(94, Math.max(6, xa + (aFirst ? -push : push)));
    const lb = Math.min(94, Math.max(6, xb + (aFirst ? push : -push)));
    return (
      `<div class="k3-strip"><div class="k3-striphead">` +
      `<span class="nm">${esc(metric.label)}</span>` +
      `<span class="dir">${metric.direction === "lower" ? "lower is better" : "higher is better"}</span>` +
      `</div><div class="k3-stripviz">` +
      `<span class="k3-stag a num" style="left:${la.toFixed(2)}%">${fmt(sa.value)}</span>` +
      `<span class="k3-stag b num" style="left:${lb.toFixed(2)}%">${fmt(sb.value)}</span>` +
      `<span class="k3-sbase"></span>${ticks}${pins}</div>` +
      `<div class="k3-stripends"><span class="num">${fmt(vmin)}</span>` +
      `<span class="num">${fmt(vmax)}</span></div>` +
      `<div class="k3-stripcap">${caption}${bestWords}</div></div>`
    );
  }

  // ---------- address lookup ----------

  // ray-casting point-in-polygon over the ward boundaries already in memory.
  // geojson coordinates are [lng, lat].
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function wardAtPoint(lat, lng) {
    for (const feature of data.geojson.features || []) {
      const geom = feature.geometry || {};
      const polys =
        geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
      for (const poly of polys) {
        if (poly.length && pointInRing(lng, lat, poly[0])) {
          return featureWardId(feature);
        }
      }
    }
    return null;
  }

  async function geocodeAndGo(query) {
    const box = el("k3-search-results");
    box.hidden = false;
    box.innerHTML = `<button type="button" disabled>Looking up that address&hellip;</button>`;
    try {
      const result = await api.fetchJson(
        `/api/geocode?q=${encodeURIComponent(query)}`,
        "Address lookup is unavailable right now.",
      );
      if (result.match) {
        const wardId = wardAtPoint(result.match.lat, result.match.lon);
        if (wardId) {
          box.hidden = true;
          selectWard(wardId, "address");
          toast(`That address is in ${wardName(wardId)}`);
          return;
        }
      }
      // Counted without the typed text: it is usually a home address.
      api.track("lookup_failed", { how: "address" });
      box.innerHTML =
        `<button type="button" disabled>No Chicago match for that. ` +
        `Try a street address, a neighborhood, or a ward number.</button>`;
    } catch (error) {
      box.innerHTML = `<button type="button" disabled>${esc(error.message)}</button>`;
    }
  }

  // ---------- landing search ----------

  function matchWards(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    data.wards.forEach((ward) => {
      const num = String(ward.ward_number || Number(ward.ward_id));
      const hoods = (ward.community_area_overlaps || []).map((a) => a.name);
      const numHit = num === q.replace(/^ward\s*/, "");
      const hoodHit = hoods.find((name) => name.toLowerCase().includes(q));
      if (numHit || hoodHit) {
        results.push({ ward, why: numHit ? "ward number" : hoodHit });
      }
    });
    results.sort((x, y) => Number(x.ward.ward_id) - Number(y.ward.ward_id));
    return results.slice(0, 6);
  }

  let suggestTimer = null;
  let suggestSeq = 0;
  let suggestPending = false;
  let addressSuggestions = [];
  const suggestCache = new Map(); // query -> suggestions, so backspacing is instant

  function renderSearchResults(query) {
    const box = el("k3-search-results");
    const locals = matchWards(query);
    const rows = [];
    locals.forEach((r) => {
      rows.push(
        `<button type="button" data-act="pick-ward" data-ward="${esc(r.ward.ward_id)}">` +
          `${esc(r.ward.display_name)}<span class="hood">${esc(r.why)}</span></button>`,
      );
    });
    addressSuggestions.forEach((s, index) => {
      rows.push(
        `<button type="button" data-act="pick-addr" data-idx="${index}">` +
          `&#9906; ${esc(s.label)}${s.extra ? `<span class="hood">${esc(s.extra)}</span>` : ""}</button>`,
      );
    });
    if (suggestPending && !addressSuggestions.length) {
      rows.push(`<button type="button" disabled>Searching addresses&hellip;</button>`);
    }
    if (!rows.length) {
      box.hidden = query.trim().length < 2;
      box.innerHTML = `<button type="button" disabled>No match yet, keep typing an address, a neighborhood, or a ward number.</button>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = rows.join("");
  }

  // google-style autofill: local matches render instantly, address
  // suggestions stream in behind them, debounced and sequence-guarded
  function scheduleSuggestions(query) {
    clearTimeout(suggestTimer);
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length < 3) {
      addressSuggestions = [];
      suggestPending = false;
      renderSearchResults(query);
      return;
    }
    if (suggestCache.has(trimmed)) {
      addressSuggestions = suggestCache.get(trimmed);
      suggestPending = false;
      renderSearchResults(query);
      return;
    }
    suggestPending = true;
    renderSearchResults(query);
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      try {
        const result = await api.fetchJson(
          `/api/geocode/suggest?q=${encodeURIComponent(query)}`,
          "Suggestions unavailable.",
        );
        if (suggestCache.size > 80) suggestCache.clear();
        suggestCache.set(trimmed, result.suggestions || []);
        if (seq !== suggestSeq) return; // a newer keystroke superseded this one
        addressSuggestions = result.suggestions || [];
        suggestPending = false;
        renderSearchResults(query);
      } catch (_error) {
        suggestPending = false;
        /* suggestions are best-effort, submit still resolves the address */
      }
    }, 160);
  }

  async function pickAddress(index) {
    const suggestion = addressSuggestions[index];
    if (!suggestion) return;
    el("k3-search-results").hidden = true;
    try {
      const result = await api.fetchJson(
        `/api/geocode/resolve?text=${encodeURIComponent(suggestion.label)}&key=${encodeURIComponent(suggestion.key || "")}`,
        "Address lookup is unavailable right now.",
      );
      const wardId = result.match ? wardAtPoint(result.match.lat, result.match.lon) : null;
      if (wardId) {
        selectWard(wardId, "address");
        toast(`${suggestion.label} is in ${wardName(wardId)}`);
      } else {
        api.track("lookup_failed", { how: "address" });
        toast("That spot is outside Chicago's 50 wards.");
      }
    } catch (error) {
      toast(error.message);
    }
  }

  // ---------- events ----------

  async function pickYear(year) {
    const target = year === "latest" ? "latest" : Number(year);
    if (target !== "latest" && !data.years.has(target)) {
      toast(`Loading ${target}…`);
      const grid = await loadYear(target);
      if (!grid) {
        toast(`No records for ${target}.`);
        return;
      }
    }
    state.year = target;
    state.peekOpen = null;
    render();
    if (target !== "latest") toast(`Reading the whole page as of ${target}.`);
  }

  function onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    const rowNode = target.closest("[data-metric]");
    const metricId = rowNode ? rowNode.dataset.metric : null;
    if (act === "pick-ward") selectWard(target.dataset.ward, "list");
    if (act === "pick-addr") pickAddress(Number(target.dataset.idx));
    if (act === "open-list") {
      state.view = "list";
      render();
    }
    if (act === "preset") applyPreset(PRESETS[Number(target.dataset.idx)]);
    if (act === "starter") applyStarter();
    if (act === "pick-vs") {
      state.vsId = pad(target.dataset.ward);
      render();
    }
    if (act === "flip") {
      const held = state.wardId;
      state.wardId = pad(state.vsId);
      state.vsId = held;
      state.peekOpen = null;
      render();
    }
    if (act === "rankbox") {
      state.peekOpen = state.peekOpen === target.dataset.metricbox ? null : target.dataset.metricbox;
      renderWard();
    }
    if (act === "span") {
      state.span = SPANS[Number(target.dataset.idx)].years;
      renderOverTime();
    }
    if (act === "year-pick") pickYear(target.dataset.year);
    if (act === "year-now") pickYear("latest");
    if (act === "add") changeMix(metricId, false);
    if (act === "remove") changeMix(metricId, true);
    if (act === "undo" && state.lastShift) {
      const shift = state.lastShift;
      state.lastShift = null;
      if (shift.removed) state.weights[shift.metricId] = 1;
      else delete state.weights[shift.metricId];
      render();
    }
    if (act === "toggle-domain") {
      const domain = target.dataset.domain;
      if (state.openDomains.has(domain)) state.openDomains.delete(domain);
      else state.openDomains.add(domain);
      renderAddMore();
    }
  }

  function onChange(event) {
    const select = event.target.closest(".k3-wardsel");
    if (!select) return;
    const picked = pad(select.value);
    // Choosing the ward that is already on the other side swaps the two rather
    // than comparing a ward with itself.
    if (select.dataset.side === "a") {
      if (picked === pad(state.vsId)) state.vsId = state.wardId;
      state.wardId = picked;
    } else {
      if (picked === pad(state.wardId)) state.wardId = state.vsId;
      state.vsId = picked;
    }
    state.peekOpen = null;
    render();
  }

  // Hover any mark on any chart and it says which ward it is. One delegated
  // handler over the whole app, because every chart marks its wards the same
  // way, and the tooltip is fixed-positioned so no chart needs its own maths.
  function wireTicks() {
    const app = el("k3-app");
    const tip = el("k3-tip");
    let held = null;

    function place(event) {
      const box = tip.getBoundingClientRect();
      const x = Math.min(window.innerWidth - box.width - 8, Math.max(8, event.clientX - box.width / 2));
      // Flip below the cursor when there is no room above it.
      const above = event.clientY - box.height - 14;
      tip.style.left = `${x}px`;
      tip.style.top = `${above > 8 ? above : event.clientY + 18}px`;
    }

    function open(mark, event) {
      if (held === mark) return;
      if (held) held.classList.remove("hot");
      held = mark;
      mark.classList.add("hot");
      tip.innerHTML = mark.dataset.tip;
      tip.hidden = false;
      place(event);
    }

    function close() {
      if (held) held.classList.remove("hot");
      held = null;
      tip.hidden = true;
    }

    app.addEventListener("pointerover", (event) => {
      const mark = event.target.closest("[data-wardtick]");
      if (mark) open(mark, event);
    });
    app.addEventListener("pointermove", (event) => {
      if (!tip.hidden) place(event);
    });
    app.addEventListener("pointerout", (event) => {
      if (event.target.closest("[data-wardtick]")) close();
    });
    // Touch has no hover, so a tap opens it and the next tap anywhere closes it.
    app.addEventListener("pointerdown", (event) => {
      const mark = event.target.closest("[data-wardtick]");
      if (mark) open(mark, event);
      else close();
    });
    window.addEventListener("scroll", close, { passive: true });
  }

  function wire() {
    el("k3-app").addEventListener("click", onClick);
    el("k3-app").addEventListener("change", onChange);
    wireTicks();
    el("k3-change-ward").addEventListener("click", () => {
      state.view = "landing";
      render();
    });
    el("k3-open-list").addEventListener("click", () => {
      state.view = "list";
      render();
    });
    el("k3-open-compare").addEventListener("click", () => {
      state.view = "compare";
      render();
    });
    el("k3-back-ward").addEventListener("click", () => {
      state.view = "ward";
      render();
    });
    el("k3-back-ward-2").addEventListener("click", () => {
      state.view = "ward";
      render();
    });
    el("k3-share").addEventListener("click", async () => {
      api.track("report_shared", { how: "copy_link" });
      try {
        await navigator.clipboard.writeText(location.href);
        toast("Link copied. It opens this exact view.");
      } catch (_error) {
        toast(location.href);
      }
    });
    const search = el("k3-search");
    search.addEventListener("input", () => scheduleSuggestions(search.value));
    // submit order: a neighborhood or ward-number match, then the top
    // address suggestion, then a one-shot geocode of whatever was typed
    const go = () => {
      const query = search.value.trim();
      if (!query) return;
      const first = matchWards(query)[0];
      if (first) selectWard(first.ward.ward_id, "search");
      else if (addressSuggestions.length) pickAddress(0);
      else geocodeAndGo(query);
    };
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") go();
    });
    el("k3-search-go").addEventListener("click", go);
    const metricSearch = el("k3-metric-search");
    metricSearch.addEventListener("input", () => {
      state.search = metricSearch.value;
      renderAddMore();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wire();
    boot();
  });
}());
