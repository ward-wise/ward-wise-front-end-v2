// The map/ranker/score views work over any geography (area_type). Each score and geojson feature
// carries a uniform area_id (ward_id for wards); the shared registry in geography.js says how to
// load + label each — this page is the one place the explorer-only precinct lens is visible.
const AREA_TYPES = window.WardWiseGeography.AREA_TYPES;

// Singular geography noun for the active area type ("ward" / "neighborhood" / "χGRID").
function areaNoun() {
  return areaConfig().noun;
}

function capitalize(text) {
  if (!text) return text;
  // Leave intentionally-cased brand nouns (e.g. "χGRID") as-is; only title-case plain words.
  if (text !== text.toLowerCase()) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Plural geography label, lowercased for mid-sentence use but preserving brand casing (χGRIDs).
function labelLower() {
  const label = areaConfig().label;
  return label.slice(1) === label.slice(1).toLowerCase() ? label.toLowerCase() : label;
}

const explorerState = {
  areaType: "ward",
  lensWardId: null, // set only while areaType is "precinct": the ward whose precincts are shown
  cityScores: [],   // every scored area before the lens narrows to one ward (for "rank citywide")
  scaleScope: "ward", // lens colour range: "ward" (this ward's precincts) or "city" (all precincts)
  wards: [], // areas for the current area_type (named "wards" for history)
  areaById: new Map(),
  geojsonCache: new Map(),
  metrics: [],
  metricTimeline: null,
  timelineMetricKey: "",
  timelineLoading: false,
  metricCoverage: {},
  snapshots: [],
  weights: {},
  scores: [],
  scoreDetailsCache: new Map(),
  scoreDetailsLoading: new Set(),
  mapLayers: new Map(),
  mapAreaLayer: null,
  profileCache: new Map(),
  currentWardId: null,
  hoveredWardId: null,
  miniOpenMetric: null,   // mini report: the rank box whose real-scale strip is open
  currentVisualizer: "visualizer-map",
  fullCityBounds: null,
  scoreRefreshId: 0,
  scoreMatrices: {},      // area_type -> precomputed component matrix; the client scores against this
  dataYears: [],          // distinct data years available (from period_end)
  metricDataYears: {},     // metric_id -> [years] it was measured (from period_end)
  timeInvariantMetrics: new Set(), // metrics valid for any year (e.g. Bean distance) — the rest are latest-only
  metricValidFrom: {},     // metric_id -> earliest valid year (e.g. Bean from 2006)
  forwardCarryYears: 0,    // a vintage measurement stays usable this many years forward
  metricMethodology: {},   // area_type -> {metric_id: [caveat keys]} for the Methodology notes panel
  selectedYear: null,     // null = latest; otherwise repoint scores to this data year
  deltaMode: false,       // when true, map shows change between deltaFromYear and deltaToYear
  pickerLayout: "curated", // curated | domains | flat — how the input panel offers metrics
  activePresetId: null,   // the curated list the weights currently equal, or null for a custom mix
  customizing: false,     // curated mode: the per-metric picker is open ("Advanced options")
  urlDirty: false,        // once the reader changes anything, the URL carries the basket
  rankerQuery: "",        // leaderboard filter text (lowercased)
  metricQuery: "",        // metric picker filter text (lowercased)
  areaLoadId: 0,          // token: a stale geography load never paints over a newer one
  areaLoading: false,     // the geography toggle is disabled while a load is in flight
};

function areaConfig() {
  return AREA_TYPES[explorerState.areaType] || AREA_TYPES.ward;
}

function areaIdOf(area) {
  return area?.[areaConfig().idProp] ?? area?.area_id ?? area?.ward_id;
}

function findArea(areaId) {
  return explorerState.areaById.get(String(areaId));
}

const METRIC_SELECTION_SESSION_KEY = "wardWiseMetricSelectionSessionId";
const MAP_DETAILS_STORAGE_KEY = "wardWiseMapDetailsVisible";

// Static main-page map: user pan/zoom is disabled so the city stays framed (deliberate view
// changes still happen programmatically via setView/fitBounds below). Interaction handlers left
// on made the choropleth easy to lose; keeping it fixed reads clearer for most visitors.
const map = L.map("map", {
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  touchZoom: false,
  keyboard: false,
  zoomControl: false,
  zoomSnap: 0, // fractional zoom: fitBounds frames the city exactly (integer snap wastes ~half the pane at narrow widths); safe because the map is non-interactive
}).setView([41.8781, -87.6298], 10);
// Street-detail tiles follow the theme: CARTO light on classic, CARTO dark on the dark theme.
// CARTO's basemaps need a (public, client-side) key since 2026-09; shared with happiness-walk.
const MAP_TILES = {
  classic: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a",
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a",
};
let mapTilesTheme = "classic";
let mapDetailsLayer = makeMapDetailsLayer("classic");

function makeMapDetailsLayer(theme) {
  return L.tileLayer(MAP_TILES[theme] || MAP_TILES.classic, {
    maxZoom: 18,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  });
}

function currentThemeName() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "classic";
}

function syncMapTilesToTheme() {
  const theme = currentThemeName();
  if (theme === mapTilesTheme) return;
  const visible = map.hasLayer(mapDetailsLayer);
  if (visible) map.removeLayer(mapDetailsLayer);
  mapDetailsLayer = makeMapDetailsLayer(theme);
  mapTilesTheme = theme;
  if (visible) mapDetailsLayer.addTo(map);
}
syncMapTilesToTheme();

document.addEventListener("wardwise:themechange", () => {
  syncMapTilesToTheme();
  updateMapStyles();
  renderWeightedRanker();
});

function cssVariable(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// The /survey page stashes a finished equation here; the map picks it up once and clears it, so a
// survey leads straight to "here is your Chicago" instead of a random starting five.
function surveyEquationWeights() {
  let stashed = null;
  try {
    stashed = window.localStorage.getItem("penlightSurveyEquation");
    if (stashed) window.localStorage.removeItem("penlightSurveyEquation");
  } catch (error) {
    return null;  // private browsing / storage disabled
  }
  if (!stashed) return null;
  try {
    const parsed = JSON.parse(stashed);
    const weights = parsed && parsed.weights;
    if (!weights || typeof weights !== "object") return null;
    explorerState.pendingSurvey = parsed;
    // Direction overrides are the reader's own call on contested metrics.
    for (const [metricId, direction] of Object.entries(parsed.directions || {})) {
      const metric = explorerState.metrics.find((m) => m.metric_id === metricId);
      if (metric) metric.direction = direction;
    }
    const known = Object.fromEntries(explorerState.metrics.map((m) => [m.metric_id, 0]));
    let any = false;
    for (const [metricId, weight] of Object.entries(weights)) {
      if (metricId in known && Number.isFinite(Number(weight))) {
        known[metricId] = Number(weight);
        if (Number(weight) > 0) any = true;
      }
    }
    return any ? known : null;
  } catch (error) {
    return null;
  }
}

// The wizard (/survey) keeps the reader's index in localStorage; it renders as a "My index" chip
// in the curated tray and applies like any list, keeping its own 1× / 10× weights.
const MY_INDEX_ID = "mine";
const MY_INDEX_KEY = "penlightMyIndex";

function loadMyIndex() {
  try {
    const raw = window.localStorage.getItem(MY_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.weights !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

function myIndexPreset() {
  const stored = loadMyIndex();
  if (!stored) return null;
  const metricIds = Object.keys(stored.weights).filter((id) => Number(stored.weights[id]) > 0);
  if (!metricIds.length) return null;
  return {
    id: MY_INDEX_ID,
    name: stored.name || "My index",
    short: "Mine",
    tagline: "Built from your answers in the index wizard",
    metric_ids: metricIds,
    weights: stored.weights,
  };
}

// A curated list by id, or the reader's own index.
function activePreset(presetId = explorerState.activePresetId) {
  return WardWisePresetTools.byId(presetId) || (presetId === MY_INDEX_ID ? myIndexPreset() : null);
}

function randomInitialWeights(metrics, count) {
  const ids = metrics.map((m) => m.metric_id);
  const picked = new Set();
  while (picked.size < Math.min(count, ids.length)) {
    picked.add(ids[Math.floor(Math.random() * ids.length)]);
  }
  return Object.fromEntries(ids.map((id) => [id, picked.has(id) ? 1 : 0]));
}

function shuffledMetrics(metrics) {
  const shuffled = [...metrics];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

// Optional focused view: ?viewtype=ejmetrics narrows the whole tool to just the Chicago EJ Index metrics
// (the 18 ej_* indicators + component scores), so a single link can drop someone into an
// environmental-justice-only version of the explorer — picker, "surprise me", and scoring all see only
// these. Falls back to the full set if the requested view has no matching metrics.
const METRIC_VIEWS = {
  ejmetrics: (metric) => String(metric.metric_id).startsWith("ej_"),
};

function applyMetricView(metrics) {
  const view = new URLSearchParams(window.location.search).get("viewtype");
  const predicate = view && METRIC_VIEWS[view];
  if (!predicate) return metrics;
  const filtered = metrics.filter(predicate);
  return filtered.length ? filtered : metrics;
}

async function initExplorer() {
  initVisualizerTabs();
  window.addEventListener("resize", () => {
    const grid = document.querySelector("#metric-weights");
    if (grid) markOverflowingDomains(grid);
  });
  initSettingsModal();
  initMobileControls();
  initMapDetailToggle();
  initAreaTypeToggle();
  await loadManifestAndStart();
}

// Everything that depends on the manifest. Separate from initExplorer so an error state's
// "Try again" can rerun it without registering the page's listeners a second time.
async function loadManifestAndStart() {
  setMetricControlsLoading(true);
  try {
    const metricData = await WardWiseExplorer.fetchExplorerManifest();
    explorerState.metrics = shuffledMetrics(applyMetricView(metricData.metrics));
    const countEl = document.getElementById("metric-count-total");
    if (countEl) countEl.textContent = `these ${explorerState.metrics.length}`;
    explorerState.metricCoverage = metricData.coverage || {};
    explorerState.metricAreaTypes = metricData.metric_area_types || {};
    explorerState.snapshots = metricData.snapshots || [];
    explorerState.dataYears = metricData.data_years || [];
    explorerState.metricDataYears = metricData.metric_data_years || {};
    explorerState.timeInvariantMetrics = new Set(metricData.time_invariant_metrics || []);
    explorerState.metricValidFrom = metricData.metric_valid_from || {};
    explorerState.forwardCarryYears = metricData.forward_carry_years || 0;
    explorerState.metricMethodology = metricData.metric_methodology || {};
    // Basket precedence: a survey equation the reader just built, then a basket carried in the
    // URL, then one of the curated lists at random — never five random metrics, so the first map
    // anyone sees has a name and an explanation.
    const params = new URLSearchParams(window.location.search);
    // The geography is resolved BEFORE the basket: a preset picked while "ward" was still assumed
    // can have zero precinct metrics, which would paint the lens grey. ?area=precinct needs its
    // ?ward=; without one it falls back to wards (a citywide precinct map is not offered).
    const requestedArea = AREA_TYPES[params.get("area")] ? params.get("area") : "ward";
    const requestedWard = params.get("ward");
    explorerState.lensWardId = requestedArea === "precinct" && requestedWard
      ? AREA_TYPES.ward.normalizeId(requestedWard) : null;
    explorerState.areaType = requestedArea === "precinct" && !explorerState.lensWardId ? "ward" : requestedArea;
    explorerState.scaleScope = params.get("scale") === "city" ? "city" : "ward";
    const survey = surveyEquationWeights();
    const fromUrl = basketFromUrl(params);
    if (survey) {
      explorerState.weights = survey;
      explorerState.activePresetId = myIndexPreset() ? MY_INDEX_ID : null;
      explorerState.urlDirty = true;
    } else if (fromUrl) {
      explorerState.weights = fromUrl.weights;
      explorerState.activePresetId = fromUrl.presetId;
      explorerState.urlDirty = true;
    } else {
      applyRandomPreset();
    }

    renderMetricControls();
    initMetricSelectionActions();
    initMiniReportActions();
    initRankerSearch();
    initFormulaChips();
    initMetricSearch();
    window.matchMedia?.("(max-width: 640px)").addEventListener?.("change", () => renderMetricControls());
    initTimeControls();
    initMethodology();
    // A shared link's year (?y=2024) applies on load, exactly as if chosen in Change time: the
    // selector, the button label, the basket (metrics with no data that year drop out) and the
    // scores all follow it. Unknown years are ignored and the page opens on Latest.
    const requestedYear = params.get("y");
    if (requestedYear && /^\d{4}$/.test(requestedYear) && (explorerState.dataYears || []).map(Number).includes(Number(requestedYear))) {
      explorerState.selectedYear = requestedYear;
      const yearSelect = document.getElementById("year-selector");
      if (yearSelect) yearSelect.value = requestedYear;
      updateTimeButtonLabel();
      pruneUnavailableSelections();
      explorerState.urlDirty = true;
    }
    syncAreaTypeToggle();
    await loadAreaType(explorerState.areaType);
    applyPendingSurveyWindow();
    const selected = params.get("sel");
    if (selected && findArea(selected)) selectWard(selected);
  } catch (error) {
    renderMetricLoadError(error, loadManifestAndStart);
    renderMetricError(error, loadManifestAndStart);
  }
}

// A wizard reader who said change matters most lands in the change view, on the window the
// wizard fitted to their measures (the toggle's own handler prunes and re-renders).
function applyPendingSurveyWindow() {
  const pending = explorerState.pendingSurvey;
  explorerState.pendingSurvey = null;
  if (!pending || !pending.delta_mode) return;
  const toggle = document.getElementById("delta-mode-toggle");
  if (!toggle || toggle.checked) return;
  const setIfPresent = (select, value) => {
    if (select && value != null && [...select.options].some((o) => o.value === String(value))) select.value = String(value);
  };
  setIfPresent(document.getElementById("delta-from-year"), pending.delta_from);
  setIfPresent(document.getElementById("delta-to-year"), pending.delta_to);
  toggle.checked = true;
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
}

function initTimeControls() {
  const yearSelect = document.getElementById("year-selector");
  const deltaToggle = document.getElementById("delta-mode-toggle");
  const deltaControls = document.getElementById("delta-year-controls");
  const fromSelect = document.getElementById("delta-from-year");
  const toSelect = document.getElementById("delta-to-year");
  const years = explorerState.dataYears || [];

  if (yearSelect) {
    while (yearSelect.options.length > 1) yearSelect.remove(1); // keep the "Latest" default
    years.slice().reverse().forEach((y) => yearSelect.add(new Option(String(y), String(y))));
    yearSelect.addEventListener("change", (event) => {
      explorerState.selectedYear = event.target.value || null;
      pruneUnavailableSelections(); // drop weighted metrics with no data for this year
      renderMetricControls(); // re-offer only the metrics with data for this year
      refreshMetricViews();
    });
  }
  [fromSelect, toSelect].forEach((select) => {
    if (!select) return;
    select.innerHTML = "";
    years.forEach((y) => select.add(new Option(String(y), String(y))));
  });
  if (fromSelect && toSelect && years.length >= 2) {
    // Default to a recent ~10-year window rather than the full menu range (2005→2025), so the ACS metrics
    // (2009–2023) fall inside both endpoints and show up in change-over-time out of the box.
    fromSelect.value = String(years[Math.max(0, years.length - 11)]);
    toSelect.value = String(years.at(-1));
  }
  if (yearSelect) {
    yearSelect.addEventListener("change", updateTimeButtonLabel);
  }
  if (deltaToggle) {
    deltaToggle.addEventListener("change", (event) => {
      explorerState.deltaMode = event.target.checked;
      if (deltaControls) deltaControls.hidden = !event.target.checked;
      if (yearSelect) yearSelect.disabled = event.target.checked; // year-pick is the non-delta view
      updateTimeButtonLabel();
      pruneUnavailableSelections(); // delta needs both endpoints — drop metrics that can't span them
      renderMetricControls(); // delta needs both endpoints — re-offer only metrics that span them
      refreshMetricViews();
    });
  }
  [fromSelect, toSelect].forEach((select) =>
    select?.addEventListener("change", () => {
      if (explorerState.deltaMode) {
        updateTimeButtonLabel();
        pruneUnavailableSelections(); // a narrower window can strip a metric's second endpoint
        renderMetricControls();
        refreshMetricViews();
      }
    }),
  );

  const openBtn = document.getElementById("open-time-modal");
  const modal = document.getElementById("time-modal");
  if (openBtn && modal) {
    openBtn.addEventListener("click", () => { modal.hidden = false; });
    modal.querySelectorAll("[data-close-time-modal]").forEach((el) =>
      el.addEventListener("click", () => { modal.hidden = true; }));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
    });
  }
  updateTimeButtonLabel();
}

// Reflect the active time view on the "Change time" button so it's visible without opening the modal.
function updateTimeButtonLabel() {
  const btn = document.getElementById("open-time-modal");
  if (!btn) return;
  if (explorerState.deltaMode) {
    const from = document.getElementById("delta-from-year")?.value;
    const to = document.getElementById("delta-to-year")?.value;
    btn.textContent = from && to ? `Δ ${from}→${to}` : "Change time";
  } else if (explorerState.selectedYear) {
    btn.textContent = `Year ${explorerState.selectedYear}`;
  } else {
    btn.textContent = "Change time";
  }
  btn.classList.toggle("is-active", explorerState.deltaMode || Boolean(explorerState.selectedYear));
}

// Composite-score change between the two chosen years: score(to) - score(from) per area, reusing the
// year-filtered scores endpoint. Drives the diverging delta choropleth.
// The precomputed component matrix the dashboard scores against. Shape per geography:
// { yearKey: { area_id: { metric_id: {s,v} } } }. Served one year-slice per request (the whole history
// at once blew past Lambda's 6 MB response cap on χGRIDs), so we fill this store lazily and cache each
// slice; weight changes never refetch. No observation-level data ever reaches the client.
async function ensureYears(areaType, yearKeys) {
  const store = (explorerState.scoreMatrices[areaType] ||= {});
  const inflight = (explorerState.matrixInflight ||= {});
  await Promise.all(
    [...new Set(yearKeys)].filter(Boolean).map((yearKey) => {
      if (yearKey in store) return null; // slice already loaded
      const cacheKey = `${areaType}:${yearKey}`;
      if (!inflight[cacheKey]) {
        inflight[cacheKey] = WardWiseExplorer.fetchJson(
          `/api/metrics/score-matrix?area_type=${encodeURIComponent(areaType)}&year=${encodeURIComponent(yearKey)}`,
          "Unable to load score matrix.",
        )
          .then((data) => {
            Object.assign(store, data.matrix || {});
            Object.assign(((explorerState.matrixPeriods ||= {})[areaType] ||= {}), data.periods || {});
          })
          .finally(() => {
            delete inflight[cacheKey];
          });
      }
      return inflight[cacheKey];
    }),
  );
  return store;
}

// Year-slices the current view needs before it can score: always "latest" (delta's fixed domain comes
// from it and it's the score fallback), plus the chosen year or the two change-window endpoints.
function neededYearKeys() {
  const keys = ["latest"];
  if (explorerState.deltaMode) {
    const from = document.getElementById("delta-from-year")?.value;
    const to = document.getElementById("delta-to-year")?.value;
    if (from) keys.push(from);
    if (to) keys.push(to);
  } else if (explorerState.selectedYear) {
    keys.push(String(explorerState.selectedYear));
  }
  return keys;
}

// The only weight-dependent step, run client-side: weighted average of each area's precomputed
// components. Delegates to WardWiseScoring so the leaderboard, the mini report, the full report and
// the comparison page can never disagree on a rank (the module mirrors the server's
// compute_weighted_scores to the displayed digit).
function computeScores(weights, yearKey) {
  const matrix = explorerState.scoreMatrices[explorerState.areaType] || {};
  const slice = matrix[yearKey] || matrix.latest || {};
  return WardWiseScoring.computeComposite(slice, weights).rows;
}

function currentSlice() {
  const matrix = explorerState.scoreMatrices[explorerState.areaType] || {};
  return matrix[explorerState.selectedYear || "latest"] || matrix.latest || {};
}

// ---- curated lists ----

function presetWeights(preset) {
  const ok = new Set(availableMetricIds());
  const allIds = explorerState.metrics.map((metric) => metric.metric_id);
  if (preset.weights) {
    // the reader's own index carries 1× / 10× weights of its own
    const known = new Set(allIds);
    const weights = Object.fromEntries(allIds.map((id) => [id, 0]));
    const used = [];
    const missing = [];
    for (const id of preset.metric_ids) {
      if (known.has(id) && ok.has(id)) {
        weights[id] = Number(preset.weights[id]) || 1;
        used.push(id);
      } else {
        missing.push(id);
      }
    }
    return { weights, used, missing };
  }
  return WardWisePresetTools.resolveWeights(preset, allIds, (id) => ok.has(id));
}

function applyRandomPreset() {
  const tried = new Set();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const preset = WardWisePresetTools.random();
    if (tried.has(preset.id)) continue;
    tried.add(preset.id);
    const { weights, used } = presetWeights(preset);
    if (used.length) {
      explorerState.weights = weights;
      explorerState.activePresetId = preset.id;
      return true;
    }
  }
  explorerState.weights = randomInitialWeights(explorerState.metrics, 5);
  explorerState.activePresetId = null;
  return false;
}

function applyPreset(presetId) {
  const preset = activePreset(presetId);
  if (!preset) return;
  const { weights, used } = presetWeights(preset);
  if (!used.length) return;
  explorerState.weights = weights;
  explorerState.activePresetId = preset.id;
  explorerState.customizing = false;
  explorerState.urlDirty = true;
  renderMetricControls();
  // The first-party selection log only accepts toggle/surprise/all/none, so a list applies through
  // GA alone until the backend allowlist learns "preset".
  WardWiseExplorer.track("explore_preset", { preset_id: preset.id, selected_count: used.length });
  refreshMetricViews();
}

// Any hand edit turns the basket into "Your list": the chip stays honest about what is counted.
function markCustom() {
  explorerState.activePresetId = null;
  explorerState.urlDirty = true;
}

function basketFromUrl(params) {
  const presetId = params.get("p");
  const parsed = WardWiseGeography.parseMix(params.get("m"));
  if (!parsed) {
    // `p=` on its own names a curated list; the basket is that list resolved for the geography.
    const preset = activePreset(presetId);
    if (!preset) return null;
    const { weights, used } = presetWeights(preset);
    return used.length ? { weights, presetId: preset.id } : null;
  }
  const known = new Set(explorerState.metrics.map((metric) => metric.metric_id));
  const weights = weightsForAllMetrics(0);
  let any = false;
  for (const [id, weight] of Object.entries(parsed)) {
    if (known.has(id)) {
      weights[id] = weight;
      any = true;
    }
  }
  if (!any) return null;
  return { weights, presetId: activePreset(presetId) ? presetId : null };
}

// The URL carries the basket once the reader has changed anything, so a link reproduces this view.
function writeLandingUrl() {
  if (!explorerState.urlDirty || !window.history?.replaceState) return;
  const params = new URLSearchParams();
  if (explorerState.areaType !== "ward") params.set("area", explorerState.areaType);
  if (lensActive()) params.set("ward", explorerState.lensWardId);
  if (lensActive() && explorerState.scaleScope === "city") params.set("scale", "city");
  const mix = WardWiseGeography.serializeMix(explorerState.weights);
  if (mix) params.set("m", mix);
  if (explorerState.activePresetId) params.set("p", explorerState.activePresetId);
  if (explorerState.selectedYear) params.set("y", String(explorerState.selectedYear));
  if (explorerState.currentWardId) params.set("sel", String(explorerState.currentWardId));
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}

function computeDeltaScores() {
  const fromYear = document.getElementById("delta-from-year")?.value;
  const toYear = document.getElementById("delta-to-year")?.value;
  if (!fromYear || !toYear) return [];
  const matrix = explorerState.scoreMatrices[explorerState.areaType] || {};
  const active = Object.entries(explorerState.weights).filter(([, weight]) => Number(weight) > 0);
  // FIXED per-metric domain so both years score on the SAME scale (not each year's own distribution, which
  // would make the "delta" a within-year rank shift instead of the metric's actual movement).
  const { domain, normalize } = deltaNormalizer();
  // Per-metric change FIRST, then weight-average the changes — over only the metrics measurable in BOTH
  // years. Computing each metric's own movement (nₜₒ − nfᵣₒₘ) and averaging avoids the score-then-delta
  // trap where the two years average over different metric baskets (ACS/PLACES vintages don't all span the
  // same years), letting composition changes masquerade as real movement. Identical to score-then-delta
  // when the basket matches; correct when it doesn't.
  const areaIds = new Set([...Object.keys(matrix[toYear] || {}), ...Object.keys(matrix[fromYear] || {})]);
  const rows = [...areaIds].map((areaId) => {
    const fromCells = (matrix[fromYear] || {})[areaId] || {};
    const toCells = (matrix[toYear] || {})[areaId] || {};
    let total = 0;
    let applied = 0;
    for (const [metricId, weight] of active) {
      const a = fromCells[metricId];
      const b = toCells[metricId];
      if (a && b && domain[metricId]) {
        total += (normalize(b.v, metricId) - normalize(a.v, metricId)) * Number(weight);
        applied += Number(weight);
      }
    }
    const delta = applied ? Math.round((total / applied) * 100) / 100 : null;
    return { area_id: areaId, score: delta };
  });
  // Rank by signed change (biggest improvement = rank 1), mirroring computeScores so the leaderboard's
  // top-10 are the most-improved areas — not the first 10 by id, which the old rank:0 left it showing.
  rows.sort(
    (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || String(a.area_id).localeCompare(String(b.area_id)),
  );
  let rank = 1;
  for (const row of rows) if (row.score != null) row.rank = rank++;
  return rows;
}

async function loadAreaType(areaType) {
  explorerState.areaType = AREA_TYPES[areaType] ? areaType : "ward";
  const loadId = ++explorerState.areaLoadId;
  setMapShadeLoading(true); // spinner while the (slow) geojson loads + first scores render
  const config = areaConfig();
  if (explorerState.areaType !== "precinct") explorerState.lensWardId = null;
  const loadOptions = { wardId: explorerState.lensWardId };
  const cacheKey = geojsonCacheKey(explorerState.areaType, explorerState.lensWardId);
  const [areas, geojson] = await Promise.all([
    config.loadAreas(loadOptions),
    explorerState.geojsonCache.get(cacheKey) || config.loadGeojson(loadOptions),
  ]);
  if (loadId !== explorerState.areaLoadId) return; // a newer geography load overtook this one
  explorerState.geojsonCache.set(cacheKey, geojson);
  explorerState.wards = areas;
  explorerState.areaById = new Map(areas.map((area) => [String(areaIdOf(area)), area]));
  explorerState.currentWardId = null;
  explorerState.hoveredWardId = null;
  explorerState.metricTimeline = null;
  explorerState.timelineMetricKey = "";
  updateSelectedWardLabel(null);
  explorerState.rankerQuery = "";
  const search = document.getElementById("ranker-search");
  if (search) {
    search.value = "";
    search.placeholder = `Filter ${labelLower()}…`;
  }
  renderMap(geojson);
  renderLensOutline();
  renderMapHint();
  renderMetricControls(); // re-filter the metric picker to what's available for this geography
  // A basket carried over from wards can be empty on precincts (few families ship there);
  // fall back to a curated list that has something to show rather than a grey map.
  if (!selectedMetricWeights().length && availableMetricIds().length) applyRandomPreset();
  await refreshMetricViews();
}

// The geography switch, guarded: one load at a time, the buttons disabled while it runs, and a
// failed load leaves the page on the geography it actually has (with a retry) instead of a stuck
// spinner and a highlighted button that lies. options.wardId enters the precinct lens.
async function switchAreaType(areaType, options = {}) {
  if (!AREA_TYPES[areaType] || explorerState.areaLoading) return;
  const wardId = areaType === "precinct" ? (options.wardId || null) : null;
  if (areaType === "precinct" && !wardId) return; // the lens always needs its ward
  if (areaType === explorerState.areaType && wardId === explorerState.lensWardId) return;
  const group = document.getElementById("area-type-toggle");
  const buttons = group ? [...group.querySelectorAll("button[data-area-type]")] : [];
  const previous = { areaType: explorerState.areaType, lensWardId: explorerState.lensWardId };
  const exitingLensTo = previous.areaType === "precinct" && areaType === "ward" ? previous.lensWardId : null;
  explorerState.areaLoading = true;
  explorerState.lensWardId = wardId;
  explorerState.areaType = areaType;
  syncAreaTypeToggle();
  buttons.forEach((b) => { b.disabled = true; });
  group?.setAttribute("aria-busy", "true");
  WardWiseExplorer.track("explore_area_type", { area_type: areaType, ward_id: wardId || undefined });
  explorerState.urlDirty = true;
  try {
    await loadAreaType(areaType);
    // Leaving the lens lands on the ward it was showing, so the reader keeps their place.
    if (exitingLensTo && explorerState.areaType === "ward" && findArea(exitingLensTo)) selectWard(exitingLensTo);
  } catch (error) {
    explorerState.areaType = previous.areaType;
    explorerState.lensWardId = previous.lensWardId;
    setMapShadeLoading(false);
    renderMetricError(error, () => switchAreaType(areaType, options));
  } finally {
    explorerState.areaLoading = false;
    group?.removeAttribute("aria-busy");
    buttons.forEach((b) => { b.disabled = false; });
    syncAreaTypeToggle();
  }
}

function initAreaTypeToggle() {
  const group = document.getElementById("area-type-toggle");
  if (group) {
    group.querySelectorAll("button[data-area-type]").forEach((button) => {
      button.addEventListener("click", () => switchAreaType(button.dataset.areaType));
    });
  }
  // The lens's colour-range switch lives in the legend: recolour in place, no reload.
  document.querySelectorAll("#map-legend .map-legend-scope button[data-scope]").forEach((button) => {
    button.addEventListener("click", () => {
      const scope = button.dataset.scope === "city" ? "city" : "ward";
      if (scope === explorerState.scaleScope) return;
      explorerState.scaleScope = scope;
      explorerState.urlDirty = true;
      WardWiseExplorer.track("explore_precinct_scale", { scope });
      updateMapStyles();
      renderMapLegend();
      writeLandingUrl();
    });
  });
}

// ---- the precinct lens: one ward's precincts, entered from that ward ----------------------
// Precincts are not a fourth peer geography. The toggle keeps its three segments; while the lens
// is open they give way to a single exit ("‹ Ward 4 · Precincts") in the same slot, scores and
// colours are re-ranked within the ward, and the ward's outline is drawn heavy underneath.

function lensActive() {
  return explorerState.areaType === "precinct" && Boolean(explorerState.lensWardId);
}

function lensWardLabel() {
  return lensActive() ? `Ward ${Number(explorerState.lensWardId)}` : "";
}

// Height of the hint + legend group that sits in the map's bottom-right corner while the lens
// is open (a sane default before the legend has rendered).
function lensOverlayHeight() {
  const group = document.querySelector("#visualizer-map .map-overlays-tr");
  const height = group ? group.offsetHeight : 0;
  return height > 0 ? height : 150;
}

function geojsonCacheKey(areaType, wardId) {
  return `${areaType}:${areaType === "precinct" && wardId ? wardId : ""}`;
}

function syncAreaTypeToggle() {
  const group = document.getElementById("area-type-toggle");
  if (!group) return;
  const lens = lensActive();
  document.getElementById("visualizer-map")?.classList.toggle("is-lens", lens);
  if (!lens) explorerState.lensLegendHeight = null;
  group.querySelectorAll("button[data-area-type]").forEach((button) => {
    const isExit = button.hasAttribute("data-lens-exit");
    button.hidden = lens ? !isExit : isExit;
    button.classList.toggle("is-active", lens ? isExit : (!isExit && button.dataset.areaType === explorerState.areaType));
    if (isExit) button.textContent = lens ? `‹ ${lensWardLabel()} · Precincts` : "‹ Precincts";
  });
}

async function enterPrecinctLens(wardId) {
  const normalized = AREA_TYPES.ward.normalizeId(wardId);
  if (!normalized) return;
  WardWiseExplorer.track("explore_precinct_lens", { ward_id: normalized });
  await switchAreaType("precinct", { wardId: normalized });
  // On the phone the lens is the map: bring it forward so the zoomed ward is what the reader sees.
  if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) setMobileView("map");
}

// Within-ward scoring: keep the ward's precincts, re-rank 1..N among them, and remember each
// row's citywide rank. Everything downstream (colour ramp, legend, leaderboard, mini report)
// reads explorerState.scores, so this one filter makes the whole lens within-ward.
function applyLens(scores) {
  if (!lensActive()) return scores;
  const inWard = scores.filter((row) => String(findArea(row.area_id)?.ward_id || "") === explorerState.lensWardId);
  inWard
    .filter((row) => row.score !== null && row.score !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .forEach((row, index) => { row.city_rank = row.rank; row.rank = index + 1; });
  return inWard;
}

async function renderLensOutline() {
  if (explorerState.lensOutlineLayer) {
    map.removeLayer(explorerState.lensOutlineLayer);
    explorerState.lensOutlineLayer = null;
  }
  if (!lensActive()) return;
  const wardId = explorerState.lensWardId;
  let wards = explorerState.geojsonCache.get(geojsonCacheKey("ward"));
  if (!wards) {
    wards = await WardWiseExplorer.fetchWardGeojson();
    explorerState.geojsonCache.set(geojsonCacheKey("ward"), wards);
  }
  if (!lensActive() || explorerState.lensWardId !== wardId) return; // the lens moved on meanwhile
  const feature = (wards.features || []).find((f) => AREA_TYPES.ward.normalizeId(f.properties?.ward_id) === wardId);
  if (!feature) return;
  explorerState.lensOutlineLayer = L.geoJSON(feature, {
    interactive: false,
    style: { fill: false, weight: 3, opacity: 0.9, color: cssVariable("--selected-ward", "#0f766e") },
  }).addTo(map);
}

// "● Click a ward to inspect": the map's one affordance, said in the geography's own noun, hidden
// once something is selected.
function renderMapHint() {
  const hint = document.getElementById("map-hint");
  if (!hint) return;
  const noun = areaConfig().noun || "ward";
  hint.textContent = `Click a ${noun} to inspect`;
  hint.hidden = Boolean(explorerState.currentWardId);
}

// The legend says what the colours mean on THIS list: the ramp is relative (min → median → max,
// with log-compressed tails), so it prints the real endpoints rather than an imaginary 0–100.
function renderMapLegend() {
  const legend = document.getElementById("map-legend");
  if (!legend) return;
  const scored = explorerState.scores.filter((s) => Number.isFinite(Number(s.score)));
  legend.hidden = !scored.length;
  if (!scored.length) return;
  const preset = activePreset();
  const title = legend.querySelector(".map-legend-title");
  const lo = legend.querySelector("[data-lo]");
  const mid = legend.querySelector("[data-mid]");
  const hi = legend.querySelector("[data-hi]");
  const fmt = (v) => WardWiseExplorer.formatNumber(v, { maximumFractionDigits: 0 });
  if (explorerState.deltaMode) {
    legend.classList.add("is-delta");
    const scope = legend.querySelector(".map-legend-scope");
    if (scope) scope.hidden = true; // change colours are absolute, not a range
    title.textContent = `Change on ${preset ? preset.name : "your list"}`;
    lo.textContent = "Declined";
    mid.textContent = "No change";
    hi.textContent = "Improved";
    return;
  }
  legend.classList.remove("is-delta");
  const scale = mapColorScale();
  // In the lens the ramp spans one ward's precincts (or every precinct), so the legend says whose range this is.
  const rangeLabel = !lensActive() ? "" : explorerState.scaleScope === "city" ? " · all precincts" : ` · ${lensWardLabel()}`;
  title.textContent = `${preset ? preset.name : "Wellbeing"}${rangeLabel}`;
  const scope = legend.querySelector(".map-legend-scope");
  if (scope) {
    scope.hidden = !lensActive();
    scope.querySelectorAll("button[data-scope]").forEach((button) =>
      button.classList.toggle("is-active", button.dataset.scope === explorerState.scaleScope));
  }
  // The lens fit reserves room for the overlay group; refit once its rendered height is known or changes.
  const overlayHeight = lensOverlayHeight();
  if (lensActive() && overlayHeight !== explorerState.lensLegendHeight) {
    explorerState.lensLegendHeight = overlayHeight;
    fitFullCity();
  }
  lo.textContent = `${fmt(scale.min)} (Low)`;
  mid.textContent = `${fmt(scale.median)} (Med)`;
  hi.textContent = `${fmt(scale.max)} (High)`;
}

// Phone layout (≤640px): a Map/Leaderboard segmented toggle shows one card at a time, and the input
// panel collapses into a bottom metric strip with an "All metrics" sheet expander. The controls are
// display:none on desktop, so this wiring is inert there.
// Display settings (gear in the input panel): picker layout choice, remembered per browser.
function initSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const openBtn = document.getElementById("open-settings-modal");
  if (!modal || !openBtn) return;
  // New storage key: readers who had stored "domains"/"flat" before curated lists existed see the
  // curated default once; their next choice is remembered under the new key.
  const storedLayout = localStorage.getItem("penlightPickerLayout2");
  explorerState.pickerLayout = PICKER_LAYOUTS.includes(storedLayout) ? storedLayout : "curated";
  const radio = modal.querySelector(`input[name="picker-layout"][value="${explorerState.pickerLayout}"]`);
  if (radio) radio.checked = true;
  const themeRadio = modal.querySelector(`input[name="theme-pref"][value="${window.WardWiseTheme?.preference() || "system"}"]`);
  if (themeRadio) themeRadio.checked = true;
  modal.querySelectorAll('input[name="theme-pref"]').forEach((input) =>
    input.addEventListener("change", () => window.WardWiseTheme?.set(input.value)));
  openBtn.addEventListener("click", () => { modal.hidden = false; });
  modal.querySelectorAll("[data-close-settings-modal]").forEach((el) =>
    el.addEventListener("click", () => { modal.hidden = true; }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
  modal.querySelectorAll('input[name="picker-layout"]').forEach((input) =>
    input.addEventListener("change", () => {
      explorerState.pickerLayout = PICKER_LAYOUTS.includes(input.value) ? input.value : "curated";
      localStorage.setItem("penlightPickerLayout2", explorerState.pickerLayout);
      explorerState.customizing = false;
      renderMetricControls();
    }));
}

function setMobileView(view) {
  const cards = document.querySelector(".visualizer-cards");
  cards?.setAttribute("data-mobile-view", view);
  document.querySelectorAll(".mobile-view-toggle button").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.mobileView === view);
  });
  // The map tile/overlay sizes were computed while hidden; recompute once it's visible again.
  if (view === "map") requestAnimationFrame(() => map.invalidateSize());
}

function initMobileControls() {
  document.querySelectorAll(".mobile-view-toggle button").forEach((button) => {
    button.addEventListener("click", () => setMobileView(button.dataset.mobileView));
  });
  const expander = document.getElementById("input-panel-expander");
  const panel = document.querySelector(".input-panel");
  expander?.addEventListener("click", () => {
    const expanded = panel.classList.toggle("is-expanded");
    expander.setAttribute("aria-expanded", String(expanded));
    if (!expanded && explorerState.customizing) {
      explorerState.customizing = false;
      renderMetricControls();
    }
  });
  // "Advanced options" on the phone strip opens the sheet straight into the per-metric picker.
  document.getElementById("mobile-customize")?.addEventListener("click", () => {
    explorerState.customizing = true;
    panel.classList.add("is-expanded");
    expander?.setAttribute("aria-expanded", "true");
    renderMetricControls();
  });
  // The strip pills are shorthands for the full panel's own actions.
  const delegate = [
    ["mobile-random-metrics", "surprise-me"],
    ["mobile-all-metrics", "select-all-metrics"],
    ["mobile-no-metrics", "deselect-all-metrics"],
  ];
  for (const [pillId, targetId] of delegate) {
    document.getElementById(pillId)?.addEventListener("click", () => {
      document.getElementById(targetId)?.click();
    });
  }
}

function initVisualizerTabs() {
  const tabs = [...document.querySelectorAll(".visualizer-tabs [role='tab']")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setActiveVisualizer(tab.dataset.visualizerTarget));
    tab.addEventListener("keydown", (event) => handleVisualizerTabKeydown(event, index, tabs));
  });
  setActiveVisualizer(explorerState.currentVisualizer);
}

function handleVisualizerTabKeydown(event, index, tabs) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  event.preventDefault();
  let nextIndex = index;
  if (event.key === "ArrowLeft") {
    nextIndex = (index - 1 + tabs.length) % tabs.length;
  } else if (event.key === "ArrowRight") {
    nextIndex = (index + 1) % tabs.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = tabs.length - 1;
  }

  tabs[nextIndex].focus();
  setActiveVisualizer(tabs[nextIndex].dataset.visualizerTarget);
}

function setActiveVisualizer(panelId) {
  explorerState.currentVisualizer = panelId;
  document.querySelectorAll(".visualizer-tabs [role='tab']").forEach((tab) => {
    const isActive = tab.dataset.visualizerTarget === panelId;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive.toString());
    tab.tabIndex = isActive ? 0 : -1;
  });
  document.querySelectorAll(".visualizer-card[role='tabpanel']").forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
  if (panelId === "visualizer-map") {
    requestAnimationFrame(() => map.invalidateSize());
  } else if (panelId === "visualizer-timeline") {
    refreshTimelineForSelectedMetrics();
  }
}

const WEIGHT_CYCLE = [0, 1, 10];
const PICKER_LAYOUTS = ["curated", "list", "domains", "flat"];
const PRIORITY_WEIGHT = 10;

// The phone strip flattens the metric grid into one scrolling row of tiles, so the list layout
// (a row per metric) is a desktop affordance: on a phone the customizing view falls back to tiles.
function effectivePickerLayout() {
  const layout = explorerState.pickerLayout;
  const phone = window.matchMedia && window.matchMedia("(max-width: 640px)").matches;
  if (layout === "curated") return phone ? "domains" : "list";
  if (layout === "list" && phone) return "domains";
  return layout;
}

function isHighWeight(weight) {
  return isPriorityWeight(weight);
}

// One place for everything a weight change touches: the tray ("Your list"), the formula chips,
// the domain counters, the selection log, and the scores.
function setMetricWeight(metricId, weight, { refresh = true } = {}) {
  const added = !Number(explorerState.weights[metricId]) && Number(weight) > 0;
  explorerState.weights[metricId] = weight;
  if (added && window.WardWiseAnalytics) {
    const metric = explorerState.metrics.find((m) => m.metric_id === metricId);
    window.WardWiseAnalytics.measureOpened(metricId, metric ? domainLabel(metric.category) : null);
  }
  markCustom();
  renderPresetTray();
  syncMetricControl(metricId);
  renderWellbeingEquation();
  renderDomainCounters();
  recordMetricSelection("toggle", { changedMetricId: metricId });
  if (refresh) refreshMetricViews();
}

// Update the one control for a metric (tile or list row) in place, without re-rendering the grid.
function syncMetricControl(metricId) {
  const weight = explorerState.weights[metricId] ?? 0;
  const label = explorerState.metrics.find((m) => m.metric_id === metricId)?.label || metricId;
  document.querySelectorAll(`.metric-toggle[data-metric-id="${CSS.escape(metricId)}"]`).forEach((button) => {
    button.classList.remove("is-off", "is-on", "is-high");
    button.classList.add(weightStateClass(weight));
    button.setAttribute("aria-label", `${label}: ${weightLabel(weight)}`);
    button.setAttribute("aria-pressed", weight > 0);
  });
  document.querySelectorAll(`.metric-row[data-metric-id="${CSS.escape(metricId)}"]`).forEach((row) => {
    row.classList.toggle("is-off", !(weight > 0));
    row.querySelectorAll(".metric-weight-choice").forEach((choice) => {
      const on = Number(choice.dataset.weight) === (weight > 0 ? (isHighWeight(weight) ? PRIORITY_WEIGHT : 1) : 0);
      choice.classList.toggle("is-active", on);
      choice.setAttribute("aria-pressed", on);
    });
  });
}

function weightStateClass(weight, weights) {
  // Proportional, not exact-match: hand-tuning still yields exactly off/on/high from WEIGHT_CYCLE
  // [0, 1, 10], but survey-derived weights are fractional (normalized by domain size) and used to
  // read as "high priority" across the board.
  if (!(weight > 0)) return "is-off";
  const values = Object.values(weights || explorerState.weights || {}).filter((w) => w > 0);
  const max = values.length ? Math.max(...values) : weight;
  return weight >= max * 0.6 ? "is-high" : "is-on";
}

// "Priority" means heavier than the rest of the basket, not merely on: a flat basket of 1× has no
// priorities, while the proportional class above still styles a survey basket's top weights.
function isPriorityWeight(weight, weights) {
  if (!(weight > 0)) return false;
  const values = Object.values(weights || explorerState.weights || {}).map(Number).filter((w) => w > 0);
  const max = values.length ? Math.max(...values) : weight;
  const min = values.length ? Math.min(...values) : weight;
  return max > min && weight >= max * 0.6;
}

function weightLabel(weight) {
  if (weight === 0) return "Off";
  if (weight === 1) return "On";
  return "High";
}

function metricIcon(metric) {
  return window.WardWiseIcons.svg(metric);
}

const DOMAIN_LABELS = {
  psychological_wellbeing: "Psychological wellbeing",
  social_connectedness: "Social connectedness",
  material_wellbeing: "Material wellbeing",
  health: "Health",
  time_balance: "Time balance",
  lifelong_learning: "Lifelong learning",
  good_governance: "Good governance",
  community_vitality: "Community vitality",
  physical_environment: "Physical environment",
  culture: "Culture",
  religion_spiritual: "Religion & spirituality",
};

function domainLabel(category) {
  return DOMAIN_LABELS[category] || String(category || "other").replace(/_/g, " ");
}

// One visible tile-row per domain by default; the count button accordions the rest out. The
// button only shows when a domain actually overflows its first row (responsive, so measured).
function attachDomainAccordion(container) {
  container.querySelectorAll(".metric-domain-expand").forEach((button) => {
    button.addEventListener("click", () => {
      const section = button.closest(".metric-domain-row");
      const domain = section?.dataset.domain;
      if (!domain) return;
      if (explorerState.expandedDomains.has(domain)) explorerState.expandedDomains.delete(domain);
      else explorerState.expandedDomains.add(domain);
      renderMetricControls();
    });
  });
  markOverflowingDomains(container);
}

function markOverflowingDomains(container) {
  container.querySelectorAll(".metric-domain-row").forEach((section) => {
    const tiles = section.querySelector(".metric-domain-tiles");
    if (!tiles || !tiles.firstElementChild) return;
    // Zero-height clipped rows don't grow scrollHeight, so detect overflow by position: any tile
    // sitting below the first row means the domain has more than one row's worth.
    const firstTop = tiles.firstElementChild.offsetTop;
    const overflows =
      section.classList.contains("is-expanded") ||
      [...tiles.children].some((child) => child.offsetTop > firstTop + 4);
    section.classList.toggle("has-overflow", overflows);
  });
}

function renderMetricControls() {
  const container = document.querySelector("#metric-weights");
  setMetricControlsLoading(false);
  const available = explorerState.metrics.filter(
    (metric) => metricAvailableForArea(metric.metric_id) && metricAvailableForYear(metric.metric_id),
  );
  const inputPanel = document.querySelector(".input-panel");
  const curated = explorerState.pickerLayout === "curated";
  if (inputPanel) {
    inputPanel.dataset.picker = explorerState.pickerLayout;
    inputPanel.classList.toggle("is-customizing", curated && explorerState.customizing);
  }
  renderPresetTray();
  // Curated mode shows the per-metric grid only while the reader is building their own list.
  container.hidden = curated && !explorerState.customizing;
  // One row per wellbeing domain. Domain order is shuffled once per load (explorerState.domainOrder);
  // metric order within a domain inherits the load-time shuffle. Domains with nothing available for
  // the current view simply don't render.
  if (!explorerState.domainOrder) {
    explorerState.domainOrder = shuffledMetrics([...new Set(explorerState.metrics.map((m) => m.category))]);
  }
  const byDomain = new Map();
  for (const metric of available) {
    for (const category of metricCategories(metric)) {
      if (!byDomain.has(category)) byDomain.set(category, []);
      byDomain.get(category).push(metric);
    }
  }
  const esc = WardWiseExplorer.escapeHtml;
  const tile = (metric) => {
    const weight = explorerState.weights[metric.metric_id] ?? 0;
    return `
      <button
        type="button"
        class="metric-toggle ${weightStateClass(weight)}"
        data-metric-id="${esc(metric.metric_id)}"
        data-metric-label="${esc(metric.label)}"
        aria-label="${esc(metric.label)}: ${weightLabel(weight)}"
        aria-pressed="${weight > 0}"
        title="${esc(metric.label)}"
      >
        ${metricIcon(metric)}
      </button>
    `;
  };
  // The list layout: a row per metric with its description and an explicit Off / 1× / 10× control.
  const row = (metric, category) => {
    const weight = explorerState.weights[metric.metric_id] ?? 0;
    const also = category && category !== metric.category ? ` <span class="metric-row-also" title="Primary domain: ${esc(domainLabel(metric.category))}">also</span>` : "";
    const level = weight > 0 ? (isHighWeight(weight) ? PRIORITY_WEIGHT : 1) : 0;
    const source = WardWiseMetricDetails.metricSource(metric, metricCoverage(metric.metric_id)) || "";
    const choices = [[0, "Off", "Off"], [1, "1×", "Standard"], [PRIORITY_WEIGHT, "★10×", "Priority"]]
      .map(([w, text, word]) => `<button type="button" class="metric-weight-choice${level === w ? " is-active" : ""}${w === PRIORITY_WEIGHT ? " is-priority" : ""}" data-weight="${w}" aria-pressed="${level === w}" aria-label="${esc(metric.label)}: ${word}">${text}</button>`)
      .join("");
    return `
      <div class="metric-row${weight > 0 ? "" : " is-off"}" data-metric-id="${esc(metric.metric_id)}">
        <span class="metric-row-icon" aria-hidden="true">${metricIcon(metric)}</span>
        <span class="metric-row-copy">
          <span class="metric-row-title">${esc(metric.label)}${metric.direction === "lower" ? ` <span class="metric-row-inverse" title="Lower raw values earn higher wellbeing scores">Inverse</span>` : ""}${also}</span>
          <span class="metric-row-desc" title="${esc(source)}">${esc(metric.description || source)}</span>
        </span>
        <span class="metric-weight-control" role="group" aria-label="${esc(metric.label)} weight">${choices}</span>
      </div>`;
  };
  const query = explorerState.metricQuery;
  const matches = query ? available.filter((m) => metricMatchesQuery(m, query)) : available;
  const byDomainShown = new Map();
  for (const metric of matches) {
    for (const category of metricCategories(metric)) {
      if (!byDomainShown.has(category)) byDomainShown.set(category, []);
      byDomainShown.get(category).push(metric);
    }
  }
  if (!explorerState.domainOrder.includes("other")) {
    for (const category of byDomainShown.keys()) {
      if (!explorerState.domainOrder.includes(category)) explorerState.domainOrder.push(category);
    }
  }
  const layout = effectivePickerLayout();
  container.dataset.layout = layout;
  container.classList.toggle("is-searching", Boolean(query));
  const status = document.getElementById("metric-search-status");
  if (status) status.textContent = query ? `${matches.length} of ${available.length} metrics match` : "";
  explorerState.expandedDomains = explorerState.expandedDomains || new Set();
  const counter = (category) => `<span class="metric-domain-active" data-domain-active="${esc(category)}" hidden>0 active</span>`;
  if (query && !matches.length) {
    container.innerHTML = `<p class="metric-search-empty">No metrics match “${esc(query)}”.</p>`;
  } else if (layout === "flat") {
    container.innerHTML = `<div class="metric-domain-tiles">${matches.map(tile).join("")}</div>`;
  } else if (layout === "list") {
    container.innerHTML = explorerState.domainOrder
      .filter((category) => (byDomainShown.get(category) || []).length)
      .map((category) => `
          <section class="metric-domain-row is-expanded is-list" data-domain="${esc(category)}">
            <div class="metric-domain-head">
              <p class="metric-domain-label">${esc(domainLabel(category))}</p>
              ${counter(category)}
            </div>
            <div class="metric-rows">${byDomainShown.get(category).map((m) => row(m, category)).join("")}</div>
          </section>`)
      .join("");
  } else {
    container.innerHTML = explorerState.domainOrder
        .filter((category) => (byDomainShown.get(category) || []).length)
        .map((category) => {
          const metrics = byDomainShown.get(category);
          const expanded = explorerState.expandedDomains.has(category) || Boolean(query);
          return `
          <section class="metric-domain-row${expanded ? " is-expanded" : ""}" data-domain="${esc(category)}">
            <div class="metric-domain-head">
              <p class="metric-domain-label">${esc(domainLabel(category))}</p>
              ${counter(category)}
              <button type="button" class="metric-domain-expand" aria-expanded="${expanded}"
                aria-label="${expanded ? "Collapse" : "Expand"} ${esc(domainLabel(category))} (${metrics.length} metrics)">
                ${metrics.length} <span class="metric-domain-chevron">${expanded ? "▴" : "▾"}</span>
              </button>
            </div>
            <div class="metric-domain-tiles">${metrics.map(tile).join("")}</div>
          </section>
        `;
        })
        .join("");
  }
  attachDomainAccordion(container);

  attachMetricToggleHandlers();
  attachMetricRowHandlers();
  initMetricButtonTooltip();
  renderDomainCounters();
  renderWellbeingEquation();
}

// "N active" in every domain head: how many of that domain's measures currently count. Counts the
// available set, not the search matches, so the number holds still while the reader types.
// Every domain a metric lives in: its catalog category plus the extras in metric_tags.js (hand-kept + the source's own).
function metricCategories(metric) {
  const extras = window.WardWiseMetricTags?.extraCategoriesFor(metric) || [];
  return [metric.category || "other", ...extras.filter((c) => c !== metric.category)];
}

// The search haystack: label, description, every domain it sits in, the source, the id's words,
// and the plain-language keywords. Built once per metric.
function metricSearchText(metric) {
  if (!explorerState._searchText) explorerState._searchText = new Map();
  const cached = explorerState._searchText.get(metric.metric_id);
  if (cached) return cached;
  const parts = [
    metric.label,
    metric.description,
    ...metricCategories(metric).map((c) => domainLabel(c)),
    metric.source,
    metric.metric_id.replace(/_/g, " "),
    window.WardWiseMetricTags?.keywordsFor(metric),
  ];
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  explorerState._searchText.set(metric.metric_id, text);
  return text;
}

// Every query word must match a haystack word by prefix, or by one typo when the word is long
// enough for a typo to be the likelier explanation ("grocry" finds groceries).
function metricMatchesQuery(metric, query) {
  const text = metricSearchText(metric);
  const words = text.split(/[^a-z0-9%$]+/).filter(Boolean);
  return query.split(/\s+/).filter(Boolean).every((term) => {
    if (text.includes(term)) return true;
    if (term.length < 5) return false;
    return words.some((word) => word.length >= 5 && withinOneEdit(term, word.slice(0, Math.max(term.length, Math.min(word.length, term.length + 1)))));
  });
}

function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (edits) return false;
    edits = 1;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function renderDomainCounters() {
  const counters = document.querySelectorAll("[data-domain-active]");
  if (!counters.length) return;
  const active = new Map();
  for (const metric of explorerState.metrics) {
    if (!metricAvailableForArea(metric.metric_id) || !metricAvailableForYear(metric.metric_id)) continue;
    if ((explorerState.weights[metric.metric_id] ?? 0) > 0) {
      for (const category of metricCategories(metric)) active.set(category, (active.get(category) || 0) + 1);
    }
  }
  counters.forEach((el) => {
    const n = active.get(el.dataset.domainActive) || 0;
    el.textContent = `${n} active`;
    el.hidden = n === 0;
  });
}

function attachMetricRowHandlers() {
  document.querySelectorAll(".metric-weight-choice").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest(".metric-row");
      const metricId = row?.dataset.metricId;
      if (!metricId) return;
      const weight = Number(button.dataset.weight);
      if ((explorerState.weights[metricId] ?? 0) === weight) return;
      setMetricWeight(metricId, weight);
      button.focus({ preventScroll: true });
    });
  });
}

// The curated tray: which list is being counted, every list as a chip (with "n/m" when a
// geography lacks some of its measures), and "Advanced options" into the per-metric picker.
function renderPresetTray() {
  const tray = document.getElementById("preset-tray");
  if (!tray) return;
  if (explorerState.pickerLayout !== "curated") {
    tray.hidden = true;
    tray.innerHTML = "";
    return;
  }
  tray.hidden = false;
  const esc = WardWiseExplorer.escapeHtml;
  const ok = new Set(availableMetricIds());
  const allIds = explorerState.metrics.map((metric) => metric.metric_id);
  const active = activePreset();
  const selectedCount = selectedMetricWeights().length;
  const chips = WardWisePresets.map((preset) => {
    const { used, missing } = WardWisePresetTools.resolveWeights(preset, allIds, (id) => ok.has(id));
    const on = active && active.id === preset.id;
    const disabled = !used.length;
    const count = missing.length && used.length ? ` <em>${used.length}/${preset.metric_ids.length}</em>` : "";
    const title = disabled
      ? `${preset.name}: none of these measures exist for ${labelLower()}`
      : preset.tagline;
    return `<button type="button" class="preset-chip${on ? " is-on" : ""}" data-preset-id="${esc(preset.id)}"` +
      ` title="${esc(title)}"${disabled ? " disabled" : ""}>` +
      WardWisePresetTools.iconHtml(preset, (explorerState.metrics.find((m) => m.metric_id === preset.icon_metric) || {}).category) +
      `<span class="preset-chip-name">${esc(preset.name)}</span>` +
      `<span class="preset-chip-short">${esc(preset.short)}</span>${count}</button>`;
  }).join("");
  const TILE_ICONS = {
    list: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="6" y1="5" x2="17" y2="5"/><line x1="6" y1="10" x2="17" y2="10"/><line x1="6" y1="15" x2="17" y2="15"/><circle cx="3" cy="5" r="0.8"/><circle cx="3" cy="10" r="0.8"/><circle cx="3" cy="15" r="0.8"/></svg>',
    build: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><line x1="10" y1="6.5" x2="10" y2="13.5"/><line x1="6.5" y1="10" x2="13.5" y2="10"/></svg>',
    mine: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 2.5 L12.3 7.3 L17.5 8 L13.7 11.6 L14.7 16.8 L10 14.3 L5.3 16.8 L6.3 11.6 L2.5 8 L7.7 7.3 Z"/></svg>',
    advanced: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="3" y1="6" x2="17" y2="6"/><line x1="3" y1="14" x2="17" y2="14"/><circle cx="7" cy="6" r="2" fill="var(--surface)"/><circle cx="13" cy="14" r="2" fill="var(--surface)"/></svg>',
  };
  const tileIcon = (key) => `<span class="preset-chip-icon" aria-hidden="true">${TILE_ICONS[key]}</span>`;
  const mine = myIndexPreset();
  let mineChip;
  if (mine) {
    const { used, missing } = presetWeights(mine);
    const on = active && active.id === MY_INDEX_ID;
    const count = missing.length && used.length ? ` <em>${used.length}/${mine.metric_ids.length}</em>` : "";
    mineChip = `<button type="button" class="preset-chip preset-chip-mine${on ? " is-on" : ""}" data-preset-id="${MY_INDEX_ID}"` +
      ` title="${esc(mine.tagline)}"${used.length ? "" : " disabled"}>${tileIcon("mine")}` +
      `<span class="preset-chip-name">${esc(mine.name)}</span><span class="preset-chip-short">Mine</span>${count}</button>`;
  } else {
    mineChip = `<a class="preset-chip preset-chip-mine" href="/survey" title="Five questions, then a list of your own">${tileIcon("build")}` +
      `<span class="preset-chip-name">Build your own index</span><span class="preset-chip-short">Build</span></a>`;
  }
  const customChip = active
    ? ""
    : `<span class="preset-chip is-on is-custom" title="the measures you picked">${tileIcon("list")}` +
      `<span class="preset-chip-name">Your list</span><span class="preset-chip-short">Yours</span></span>`;
  const createChip = `<button type="button" class="preset-chip preset-chip-create" data-preset-create="1"` +
    ` aria-expanded="${explorerState.customizing}">${tileIcon("advanced")}<span class="preset-chip-name">${explorerState.customizing ? "Done" : "Advanced options"}</span></button>`;
  const heading = `Counting <b>${esc(active ? active.name : "Your list")}</b><span>${selectedCount} measures</span>`;
  const note = active ? esc(active.tagline) : "the measures you picked — the map scores on exactly these";
  tray.innerHTML =
    `<div class="preset-mixbar"><div class="preset-mixhead">${heading}</div>` +
    `<p class="preset-note">${note}</p></div>` +
    `<div class="preset-chips">${customChip}${mineChip}${chips}${createChip}</div>`;
  // On the phone strip the chips scroll sideways: bring the active list into view so the reader
  // sees which list the map is scored on without hunting for it.
  const row = tray.querySelector(".preset-chips");
  const onChip = row?.querySelector(".preset-chip.is-on");
  if (row && onChip && row.scrollWidth > row.clientWidth) {
    row.scrollLeft = Math.max(0, onChip.offsetLeft - row.offsetLeft - 12);
  }
}

function setMetricControlsLoading(isLoading) {
  const container = document.querySelector("#metric-weights");
  if (!container) return;
  container.setAttribute("aria-busy", isLoading.toString());
  container.classList.toggle("metric-button-grid-loading", isLoading);
}

function renderMetricLoadError(error, retry) {
  const container = document.querySelector("#metric-weights");
  if (!container) return;
  setMetricControlsLoading(false);
  container.hidden = false;
  const message = WardWiseExplorer.escapeHtml(error.message || "Unable to load metrics.");
  container.innerHTML = `
    <div class="metric-loading-error" role="alert">
      <span>${message}</span>
      ${retry ? `<button type="button" class="ww-cta ghost" data-act="retry">Try again</button>` : ""}
    </div>
  `;
  container.querySelector('[data-act="retry"]')?.addEventListener("click", () => retry(), { once: true });
}

// Caveat compiler: surface, for the metrics the user has weighted on the current geography, only the
// methodology notes that actually apply. Tags are precomputed per (area_type, metric) in the pipeline.
const METHODOLOGY_CAVEATS = [
  { key: "modeled", title: "Modeled estimate", note: "A statistical small-area model estimate, not a direct measurement." },
  { key: "areal_allocation", title: "Area-weighted estimate", note: "Estimated by overlaying the source's geography onto this one (area-weighted), not measured within its exact boundary." },
  { key: "acs_5yr", title: "ACS 5-year estimate", note: "U.S. Census American Community Survey 5-year rolling estimate, dated to its final year." },
  { key: "current_boundaries", title: "Current boundaries", note: "Historical values use today's ward boundaries for comparability." },
  { key: "forward_carried", title: "Point-in-time, carried forward", note: "Measured for a specific period and shown for up to 3 years after, until newer data exists." },
  { key: "small_base", title: "Small base", note: "Some values on this geography rest on fewer than 20 underlying records (a precinct's handful of 311 requests, say). Shown rather than hidden, because even a small count is real." },
];

function compileMethodologyNotes() {
  const byMetric = explorerState.metricMethodology[explorerState.areaType] || {};
  const labelOf = (id) => (explorerState.metrics.find((m) => m.metric_id === id) || {}).label || id;
  const byCaveat = {};
  for (const [metricId, weight] of Object.entries(explorerState.weights)) {
    if (Number(weight) <= 0) continue;
    for (const caveat of byMetric[metricId] || []) {
      (byCaveat[caveat] = byCaveat[caveat] || []).push(labelOf(metricId));
    }
  }
  return METHODOLOGY_CAVEATS.filter((c) => byCaveat[c.key]).map((c) => ({ ...c, metrics: byCaveat[c.key] }));
}

function updateMethodologyLink() {
  const link = document.getElementById("open-methodology");
  if (!link) return;
  // Always reachable: it now also holds the full equation when the bar has truncated it.
  link.hidden = compileMethodologyNotes().length === 0 && !equationText();
}

function renderMethodologyPanel() {
  const body = document.getElementById("methodology-body");
  if (!body) return;
  const full = equationText();
  // The bar clamps to one line so it never eats the map; the untruncated equation belongs here.
  const equationHtml = full
    ? `<div class="methodology-equation"><p class="eyebrow">Your equation</p>
         <p><strong>wellbeing</strong> = ${WardWiseExplorer.escapeHtml(full)}</p></div>`
    : "";
  const measuresHtml = renderMethodologyMeasures();
  const notes = compileMethodologyNotes();
  if (!notes.length) {
    body.innerHTML = equationHtml + measuresHtml +
      '<p class="methodology-empty">Your weighted metrics are all directly measured for this geography — no caveats to flag.</p>';
    return;
  }
  body.innerHTML = equationHtml + measuresHtml + notes
    .map(
      (note) => `
      <div class="methodology-caveat">
        <h4>${WardWiseExplorer.escapeHtml(note.title)}</h4>
        <p>${WardWiseExplorer.escapeHtml(note.note)}</p>
        <span class="methodology-metrics">${note.metrics.map((m) => WardWiseExplorer.escapeHtml(m)).join(" · ")}</span>
      </div>`,
    )
    .join("");
}

// One block per weighted measure: what it is in a sentence, where it comes from, which years it
// was measured, and — the honest part — whether the year on screen is a real measurement or the
// latest value carried forward.
function renderMethodologyMeasures() {
  const esc = WardWiseExplorer.escapeHtml;
  const terms = equationTerms();
  if (!terms.length) return "";
  const selectedYear = explorerState.selectedYear ? Number(explorerState.selectedYear) : null;
  const blocks = terms.map(({ metric }) => {
    const id = metric.metric_id;
    const years = [...(explorerState.metricDataYears[id] || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const fixed = explorerState.timeInvariantMetrics.has(id);
    let time;
    if (fixed) {
      time = "A fixed fact of the geography, not a dated series.";
    } else if (!years.length) {
      time = "Measured once, at the latest data collection.";
    } else {
      const first = years[0];
      const last = years.at(-1);
      const span = first === last ? `${first}` : `${first}–${last}`;
      const count = years.length === 1 ? "one year of data" : `${years.length} years of data`;
      if (selectedYear == null) {
        time = `${span} (${count}); showing ${last}, the latest year measured.`;
      } else if (years.includes(selectedYear)) {
        time = `${span} (${count}); ${selectedYear} is a measured year.`;
      } else {
        const carried = years.filter((y) => y < selectedYear).at(-1);
        time = carried != null
          ? `${span} (${count}); no ${selectedYear} value yet, so ${carried} is carried forward.`
          : `${span} (${count}); nothing measured on or before ${selectedYear}.`;
      }
    }
    const how = metric.methodology_short || metric.methodology || metric.description || "";
    const source = metric.source_label || metric.source || "";
    return `
      <div class="methodology-measure">
        <h4>${esc(metric.label || id)}</h4>
        ${how ? `<p>${esc(how)}</p>` : ""}
        ${source ? `<p class="methodology-source">Source: ${esc(source)}</p>` : ""}
        <p class="methodology-time">${esc(time)}</p>
      </div>`;
  });
  return `<div class="methodology-measures"><p class="eyebrow">Your measures</p>${blocks.join("")}</div>`;
}

function initMethodology() {
  const openBtn = document.getElementById("open-methodology");
  const modal = document.getElementById("methodology-modal");
  if (!openBtn || !modal) return;
  openBtn.addEventListener("click", () => {
    renderMethodologyPanel();
    modal.hidden = false;
  });
  modal.querySelectorAll("[data-close-methodology]").forEach((el) =>
    el.addEventListener("click", () => { modal.hidden = true; }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) modal.hidden = true;
  });
}

function equationTerms() {
  return explorerState.metrics
    .map((metric) => ({ metric, weight: Number(explorerState.weights[metric.metric_id] ?? 0) }))
    .filter(({ metric, weight }) => Number.isFinite(weight) && weight > 0 && metricAvailableForArea(metric.metric_id));
}

// The equation as one line of text (the methodology panel prints it in full).
function equationText() {
  const selected = equationTerms();
  if (!selected.length) return "";
  return selected.map(({ metric, weight }, index) => {
    const sign = metric.direction === "lower" ? "-" : "+";
    const variable = metricEquationVariable(metric);
    const weighted = weight === 1 ? variable : `${WardWiseExplorer.formatNumber(weight, { maximumFractionDigits: 1 })} x ${variable}`;
    return sign === "+" && index === 0 ? weighted : `${sign} ${weighted}`;
  }).join(" ");
}

// The formula bar: one chip per counted measure — weight badge (click: Standard ↔ Priority), the
// label, and × to drop it. Editing here is the same edit as in the picker.
function renderWellbeingEquation() {
  updateMethodologyLink();
  const formula = document.getElementById("wellbeing-equation-formula");
  if (!formula) return;
  const esc = WardWiseExplorer.escapeHtml;
  const selected = equationTerms();

  if (!selected.length) {
    if (explorerState.deltaMode) {
      const from = document.getElementById("delta-from-year")?.value;
      const to = document.getElementById("delta-to-year")?.value;
      formula.textContent = `no selected metrics were remeasured between ${from} and ${to} — widen the window`;
    } else {
      formula.textContent = "choose metrics in the panel";
    }
  } else {
    formula.innerHTML = selected.map(({ metric, weight }) => {
      const high = isHighWeight(weight);
      const sign = metric.direction === "lower" ? "−" : "";
      const badge = `${sign}${high ? "★" : ""}${WardWiseExplorer.formatNumber(weight, { maximumFractionDigits: 1 })}×`;
      return `<span class="eq-chip${high ? " is-high" : ""}" role="listitem" data-metric-id="${esc(metric.metric_id)}">` +
        `<button type="button" class="eq-chip-w num" data-act="weight" aria-pressed="${high}" aria-label="${esc(metric.label)}: ${high ? "Priority weight, set to Standard" : "Standard weight, set to Priority"}">${badge}</button>` +
        `<span class="eq-chip-label">${esc(metric.label)}</span>` +
        `<button type="button" class="eq-chip-x" data-act="remove" aria-label="Remove ${esc(metric.label)}">×</button></span>`;
    }).join("");
  }
  // The left-hand side names the curated list being counted, so "Housing Squeeze = rent + …" reads
  // as the definition it is; a custom mix keeps the generic "wellbeing".
  const lhs = document.getElementById("wellbeing-equation-lhs") || formula.closest("p")?.querySelector("strong");
  if (lhs) {
    const active = activePreset();
    lhs.textContent = active ? active.name : "wellbeing";
  }
}

function initFormulaChips() {
  const formula = document.getElementById("wellbeing-equation-formula");
  if (!formula) return;
  formula.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    const chip = button?.closest(".eq-chip");
    if (!button || !chip) return;
    const metricId = chip.dataset.metricId;
    if (button.dataset.act === "remove") {
      // the bar re-renders, so remember the neighbour by id and find it again afterwards
      const neighbour = (chip.nextElementSibling || chip.previousElementSibling)?.dataset.metricId;
      setMetricWeight(metricId, 0);
      const target = neighbour ? formula.querySelector(`.eq-chip[data-metric-id="${CSS.escape(neighbour)}"] .eq-chip-x`) : null;
      (target || document.getElementById("open-methodology"))?.focus({ preventScroll: true });
    } else if (button.dataset.act === "weight") {
      const weight = explorerState.weights[metricId] ?? 0;
      setMetricWeight(metricId, isHighWeight(weight) ? 1 : PRIORITY_WEIGHT);
      formula.querySelector(`.eq-chip[data-metric-id="${CSS.escape(metricId)}"] .eq-chip-w`)?.focus({ preventScroll: true });
    }
  });
}

function metricEquationVariable(metric) {
  if (metric.metric_id === "bean_distance_miles") {
    return "bean_distance";
  }
  return String(metric.label || metric.metric_id)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_") || metric.metric_id;
}

function renderMetricTooltipContent(tooltip, metric, metricId) {
  const coverage = metricCoverage(metricId);
  const status = WardWiseMetricDetails.metricStatus(coverage, metric);
  const currentWeight = explorerState.weights[metricId] ?? 0;
  const methodology = WardWiseMetricDetails.metricMethodologySummary(metric);
  const source = WardWiseMetricDetails.metricSource(metric, coverage);
  const notableStatus = status.id !== "populated" && status.id !== "disabled_from_scoring"
    ? WardWiseMetricDetails.renderMetricStatusBadge(status)
    : "";
  tooltip.innerHTML = `
    <strong>${WardWiseExplorer.escapeHtml(metric.label)}</strong>
    <span>${WardWiseExplorer.escapeHtml(metric.description)}</span>
    ${notableStatus ? `<div class="metric-tooltip-row">${notableStatus}</div>` : ""}
    ${methodology ? `<small>Methodology: ${WardWiseExplorer.escapeHtml(methodology)}</small>` : ""}
    ${source ? `<small>Source: ${WardWiseExplorer.escapeHtml(source)}</small>` : ""}
    <small>Weight: ${WardWiseExplorer.escapeHtml(weightLabel(currentWeight))} (${currentWeight})${isHighWeight(currentWeight) ? "" : " — set Priority (10×) on the formula chip"}</small>
  `;
}

function attachMetricToggleHandlers() {
  const tooltip = document.getElementById("metric-button-tooltip");
  document.querySelectorAll(".metric-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      // Tiles are a plain Off ↔ On toggle; Priority (10×) lives on the formula chip and the list rows.
      const metricId = button.dataset.metricId;
      const nextWeight = (explorerState.weights[metricId] ?? 0) > 0 ? 0 : 1;
      setMetricWeight(metricId, nextWeight);
      if (tooltip && !tooltip.hidden) {
        const metric = explorerState.metrics.find((m) => m.metric_id === metricId);
        if (metric) renderMetricTooltipContent(tooltip, metric, metricId);
      }
    });
  });
}

function initMetricButtonTooltip() {
  const tooltip = document.getElementById("metric-button-tooltip");
  if (!tooltip) return;

  document.querySelectorAll(".metric-toggle").forEach((button) => {
    button.addEventListener("mouseenter", () => {
      const metricId = button.dataset.metricId;
      const metric = explorerState.metrics.find((m) => m.metric_id === metricId);
      if (!metric) return;
      tooltip.hidden = false;
      renderMetricTooltipContent(tooltip, metric, metricId);
      positionMetricTooltip(button, tooltip);
    });
    button.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
    });
  });
}

function positionMetricTooltip(button, tooltip) {
  const buttonRect = button.getBoundingClientRect();
  const tooltipWidth = 220;
  const gap = 8;
  const left = Math.max(gap, Math.min(buttonRect.left, window.innerWidth - tooltipWidth - gap));
  const top = buttonRect.bottom + gap;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function initMetricSelectionActions() {
  document.getElementById("surprise-me")?.addEventListener("click", () => {
    // Only roll among metrics the current time view can honor (e.g. both endpoints in change-over-time).
    const ok = new Set(availableMetricIds());
    const pool = explorerState.metrics.filter((m) => ok.has(m.metric_id));
    explorerState.weights = randomInitialWeights(pool.length ? pool : explorerState.metrics, 5);
    markCustom();
    renderMetricControls();
    recordMetricSelection("surprise_me");
    refreshMetricViews();
  });
  document.getElementById("select-all-metrics")?.addEventListener("click", () => {
    const ok = new Set(availableMetricIds()); // only weight metrics valid for the current time view
    explorerState.weights = Object.fromEntries(
      explorerState.metrics.map((m) => [m.metric_id, ok.has(m.metric_id) ? 1 : 0]),
    );
    markCustom();
    renderMetricControls();
    recordMetricSelection("select_all");
    refreshMetricViews();
  });
  document.getElementById("deselect-all-metrics")?.addEventListener("click", () => {
    explorerState.weights = weightsForAllMetrics(0);
    markCustom();
    renderMetricControls();
    recordMetricSelection("deselect_all");
    refreshMetricViews();
  });
  // One delegated listener for the curated tray: chips apply a list, "Advanced options" opens the
  // per-metric picker (and, on the phone, the sheet).
  document.getElementById("preset-tray")?.addEventListener("click", (event) => {
    const create = event.target.closest("[data-preset-create]");
    if (create) {
      explorerState.customizing = !explorerState.customizing;
      if (explorerState.customizing) {
        document.querySelector(".input-panel")?.classList.add("is-expanded");
        document.getElementById("input-panel-expander")?.setAttribute("aria-expanded", "true");
      }
      renderMetricControls();
      return;
    }
    const chip = event.target.closest("[data-preset-id]");
    if (chip && !chip.disabled) applyPreset(chip.dataset.presetId);
  });
}

function weightsForAllMetrics(weight) {
  return Object.fromEntries(explorerState.metrics.map((metric) => [metric.metric_id, weight]));
}

function recordMetricSelection(action, { changedMetricId = null } = {}) {
  const payload = {
    action,
    session_id: metricSelectionSessionId(),
    changed_metric_id: changedMetricId,
    metric_order: explorerState.metrics.map((metric) => metric.metric_id),
    selected_metrics: selectedMetricWeights().map(([metricId, weight]) => ({
      metric_id: metricId,
      weight,
    })),
    weights: Object.fromEntries(
      explorerState.metrics.map((metric) => [
        metric.metric_id,
        Number(explorerState.weights[metric.metric_id] ?? 0),
      ]),
    ),
  };
  WardWiseExplorer.submitMetricSelectionEvent(payload).catch(() => {});
  // Mirror to GA so metric experimentation shows up alongside the first-party event log.
  WardWiseExplorer.track("explore_metric_weight", {
    weight_action: action,
    changed_metric_id: changedMetricId || undefined,
    selected_count: selectedMetricWeights().length,
  });
}

function metricSelectionSessionId() {
  try {
    const existing = window.localStorage.getItem(METRIC_SELECTION_SESSION_KEY);
    if (existing) return existing;
    const generated = window.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(METRIC_SELECTION_SESSION_KEY, generated);
    return generated;
  } catch (_error) {
    return "";
  }
}

function metricCoverage(metricId) {
  return explorerState.metricCoverage?.[metricId] || null;
}
// A metric shows in the picker only if it has data for the selected geography (e.g. a ward-only
// metric is hidden on χGRID). If the manifest carries no availability info, show everything.
function metricAvailableForArea(metricId) {
  const map = explorerState.metricAreaTypes;
  if (!map || !Object.keys(map).length) return true;
  return (map[metricId] || []).includes(explorerState.areaType);
}

// Year-honesty math lives in common.js (WardWiseExplorer.yearMath) so the Reports views share the
// exact same semantics; these wrappers just bind the explorer's state as the context.
function yearMathCtx() {
  return {
    metricDataYears: explorerState.metricDataYears,
    forwardCarryYears: explorerState.forwardCarryYears,
    timeInvariantMetrics: explorerState.timeInvariantMetrics,
    metricValidFrom: explorerState.metricValidFrom,
  };
}

function metricHasValueForYear(metricId, target) {
  return WardWiseExplorer.yearMath.hasValueForYear(yearMathCtx(), metricId, target);
}

function latestMeasurementFor(metricId, target) {
  return WardWiseExplorer.yearMath.latestMeasurementFor(yearMathCtx(), metricId, target);
}

function deltaExclusionReason(metricId, from, to) {
  return WardWiseExplorer.yearMath.deltaExclusionReason(yearMathCtx(), metricId, from, to);
}

function metricAvailableForYear(metricId) {
  // Which metrics the picker offers for the chosen time. Snapshot metrics aren't carried back; a year
  // shows only what we can honestly attribute to it.
  if (explorerState.deltaMode) {
    // Change-over-time requires the metric to have been REMEASURED between the endpoints. Merely having
    // a value at both (via forward-carry) isn't enough: a 2023 vintage carried to both 2024 and 2025
    // would "change" by exactly zero — a fake comparison the map would present as measured stability.
    const from = Number(document.getElementById("delta-from-year")?.value);
    const to = Number(document.getElementById("delta-to-year")?.value);
    return deltaExclusionReason(metricId, from, to) == null;
  }
  if (!explorerState.selectedYear) return true; // "Latest" — everything
  return metricHasValueForYear(metricId, Number(explorerState.selectedYear));
}

// The metrics the current time view (latest / a year / a change window) can honestly offer.
function availableMetricIds() {
  return explorerState.metrics
    .filter((m) => metricAvailableForArea(m.metric_id) && metricAvailableForYear(m.metric_id))
    .map((m) => m.metric_id);
}

// Turn OFF any weighted metric the current time view can't honor, so a metric hidden from the grid
// (e.g. a live snapshot in change-over-time, which has no second endpoint) can't silently keep
// contributing to the score or the change. Call before re-rendering whenever the time view changes.
function pruneUnavailableSelections() {
  const ok = new Set(availableMetricIds());
  explorerState.deltaSetAside = explorerState.deltaSetAside || {};
  let changed = false;
  if (!explorerState.deltaMode) {
    // Leaving the change view: give back everything it set aside.
    for (const [id, weight] of Object.entries(explorerState.deltaSetAside)) {
      if (!Number(explorerState.weights[id])) {
        explorerState.weights[id] = weight;
        changed = true;
      }
    }
    explorerState.deltaSetAside = {};
  } else {
    // A wider window can make a set-aside metric comparable again — give its weight back.
    for (const [id, weight] of Object.entries(explorerState.deltaSetAside)) {
      if (ok.has(id)) {
        explorerState.weights[id] = weight;
        delete explorerState.deltaSetAside[id];
        changed = true;
      }
    }
  }
  for (const id of Object.keys(explorerState.weights)) {
    if (Number(explorerState.weights[id]) > 0 && !ok.has(id)) {
      if (explorerState.deltaMode) {
        // Remember the weight so the metric returns when the window widens or delta mode ends.
        explorerState.deltaSetAside[id] = Number(explorerState.weights[id]);
      }
      explorerState.weights[id] = 0;
      changed = true;
    }
  }
  return changed;
}

// Fixed per-metric domain (min/max raw value across the latest distribution) + a direction-aware
// normalizer, shared by the delta score and the per-metric change breakdown so they always agree.
function deltaNormalizer() {
  const matrix = explorerState.scoreMatrices[explorerState.areaType] || {};
  const directionById = new Map(explorerState.metrics.map((m) => [m.metric_id, m.direction || "higher"]));
  const domain = {};
  for (const cells of Object.values(matrix.latest || {})) {
    for (const [metricId, cell] of Object.entries(cells)) {
      const value = cell.v;
      if (!(metricId in domain)) domain[metricId] = [value, value];
      else {
        if (value < domain[metricId][0]) domain[metricId][0] = value;
        if (value > domain[metricId][1]) domain[metricId][1] = value;
      }
    }
  }
  const normalize = (value, metricId) => {
    const span = domain[metricId];
    if (!span || span[1] === span[0]) return 50;
    let n = ((value - span[0]) / (span[1] - span[0])) * 100;
    if (directionById.get(metricId) === "lower") n = 100 - n; // higher score is always "better"
    return Math.max(0, Math.min(100, n));
  };
  return { domain, normalize };
}

function renderMap(geojson) {
  if (explorerState.mapAreaLayer) {
    map.removeLayer(explorerState.mapAreaLayer);
  }
  explorerState.mapLayers.clear();
  const idProp = areaConfig().idProp;
  const layer = L.geoJSON(geojson, {
    style: (feature) => wardStyle(String(feature.properties[idProp])),
    onEachFeature: (feature, mapLayer) => {
      const areaId = String(feature.properties[idProp]);
      explorerState.mapLayers.set(areaId, mapLayer);
      mapLayer.on({
        click: () => selectWard(areaId),
        mouseover: () => previewWard(areaId, mapLayer),
        mouseout: () => clearWardPreview(areaId),
      });
    },
  }).addTo(map);
  explorerState.mapAreaLayer = layer;
  explorerState.fullCityBounds = layer.getBounds();
  fitFullCity();
  // The whole visualizer reveals with the map's first render — showing pieces earlier means
  // half-built cards flash and jump while data loads.
  const equation = document.getElementById("wellbeing-equation");
  if (equation) equation.hidden = false;
  document.querySelector(".visualizer-cards")?.classList.remove("is-loading");
  // The container can reach its final size after this runs (font load / panel reflow), leaving a
  // fit computed for a smaller box — the city then huddles tiny in a corner. The map is
  // non-interactive, so refitting on every container resize never clobbers user view state.
  if (!explorerState.mapResizeObserver && window.ResizeObserver) {
    explorerState.mapResizeObserver = new ResizeObserver(() => fitFullCity());
    explorerState.mapResizeObserver.observe(document.getElementById("map"));
    // The lens fit reserves the hint + legend group's height; when that group grows (legend
    // appears, title wraps, range switch shows) the ward must move up out from under it.
    const overlays = document.querySelector("#visualizer-map .map-overlays-tr");
    if (overlays) explorerState.mapResizeObserver.observe(overlays);
  }
}

function fitFullCity() {
  if (!explorerState.fullCityBounds) return;
  const mapEl = document.getElementById("map");
  // Never fit a container smaller than the fit padding — the effective size goes negative and
  // Leaflet's zoom math lands on NaN, permanently poisoning the projection (every path renders
  // "M0 0"). The resize observer re-invokes this once the container has a usable size.
  if (!mapEl || mapEl.clientWidth < 120 || mapEl.clientHeight < 180) return;
  // Self-heal: if a poisoned fit already slipped through, reset to a sane view first.
  if (!Number.isFinite(map.getZoom())) map.setView([41.8781, -87.6298], 10, { animate: false });
  // animate: false — an animated fit needs requestAnimationFrame to finish, and browsers starve
  // rAF in background/occluded tabs, stranding the map mid-zoom (tiny city in a corner). The
  // instant fit has no frame dependency, so a tab opened in the background lands framed correctly.
  map.invalidateSize({ animate: false });
  // Asymmetric padding clears the overlays that float on the map: the geography toggle across the
  // top and the "Map details" control at the bottom — a symmetric 16px let the city run into both.
  // In the precinct lens the ward fills the frame and the hint + legend group drops to the
  // bottom-right corner (styles: .map-card.is-lens), so the fit clears that corner by the whole
  // group's rendered height (on a phone the hint stacks above a two-line legend title).
  map.fitBounds(explorerState.fullCityBounds, {
    paddingTopLeft: [20, 60],
    paddingBottomRight: [20, lensActive() ? Math.max(52, lensOverlayHeight() + 44) : 52],
    animate: false,
  });
}

function wardStyle(wardId) {
  const score = scoreForWard(wardId)?.score;
  const isSelected = wardId === explorerState.currentWardId;
  const isHovered = !isSelected && wardId === explorerState.hoveredWardId;
  return {
    color: isSelected || isHovered
      ? cssVariable("--selected-ward", "#0f766e")
      : cssVariable("--map-stroke", "") || cssVariable("--action", "#155e75"),
    fillColor: fillColorForScore(score),
    fillOpacity: isSelected
      ? Number(cssVariable("--map-fill-opacity-selected", "0.72"))
      : Number(cssVariable("--map-fill-opacity", "0.44")),
    weight: isSelected ? 3 : isHovered ? 2.5 : 1,
  };
}

function fillColorForDelta(delta) {
  // Diverging scale around 0: gains lean teal (--score-high), declines lean orange (--score-low),
  // little change stays slate (--score-mid). Reuses the existing palette, scaled by the largest |Δ|.
  if (delta === null || delta === undefined) {
    return cssVariable("--map-fill", "#94a3b8");
  }
  const magnitudes = explorerState.scores
    .map((entry) => Math.abs(Number(entry.score)))
    .filter(Number.isFinite);
  const maxAbs = Math.max(1, ...magnitudes);
  // Centered at ZERO change (neutral grey, NOT the median): a wellbeing-score improvement is green, a
  // decline is red. Magnitude is scaled to the biggest mover on the map so the strongest changes saturate.
  const t = Math.max(-1, Math.min(1, delta / maxAbs));
  const neutral = cssVariable("--score-mid", "#94a3b8");
  return t >= 0
    ? interpolateHexColor(neutral, cssVariable("--delta-up", "#15803d"), t) // improvement
    : interpolateHexColor(neutral, cssVariable("--delta-down", "#b91c1c"), -t); // decline
}

function fillColorForScore(score) {
  if (explorerState.deltaMode) {
    return fillColorForDelta(score);
  }
  if (score === null || score === undefined) {
    return cssVariable("--map-fill", "#38bdf8");
  }
  const scale = mapColorScale();
  const normalized = normalizeScoreForMapColor(score, scale);
  if (normalized >= 0.5) {
    return interpolateHexColor(
      cssVariable("--score-mid", "#94a3b8"),
      cssVariable("--score-high", "#0f766e"),
      (normalized - 0.5) * 2,
    );
  }
  return interpolateHexColor(
    cssVariable("--score-low", "#f97316"),
    cssVariable("--score-mid", "#94a3b8"),
    normalized * 2,
  );
}

function mapColorScale() {
  // In the lens the ramp spans the ward's precincts by default; "All precincts" widens it to
  // every precinct in the city so a uniformly high or low ward reads against the whole.
  const source = lensActive() && explorerState.scaleScope === "city" ? explorerState.cityScores : explorerState.scores;
  const scores = source
    .map((score) => Number(score.score))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!scores.length) {
    return { min: 0, max: 100, useLog: false };
  }
  const min = scores[0];
  const max = scores.at(-1);
  const median = percentile(scores, 0.5);
  const p90 = percentile(scores, 0.9);
  const p10 = percentile(scores, 0.1);
  return {
    min,
    median,
    max,
    useLogLow: median > min && (median - p10) / Math.max(1, median - min) <= 0.35,
    useLogHigh: max > median && p90 / Math.max(1, median) >= 3,
  };
}

function normalizeScoreForMapColor(score, scale) {
  if (scale.max === scale.min) return 0.5;
  const value = Math.max(scale.min, Math.min(scale.max, Number(score)));
  if (value === scale.median) return 0.5;
  if (value < scale.median) {
    const distance = scale.median - value;
    const span = scale.median - scale.min;
    const scaled = scale.useLogLow
      ? Math.log1p(distance) / Math.log1p(span)
      : distance / span;
    return 0.5 - scaled * 0.5;
  }
  const distance = value - scale.median;
  const span = scale.max - scale.median;
  const scaled = scale.useLogHigh
    ? Math.log1p(distance) / Math.log1p(span)
    : distance / span;
  return 0.5 + scaled * 0.5;
}

function percentile(sortedValues, pct) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function interpolateHexColor(startHex, endHex, amount) {
  const start = hexToRgb(startHex);
  const end = hexToRgb(endHex);
  const clamped = Math.max(0, Math.min(1, amount));
  if (!start || !end) return startHex;
  const rgb = start.map((channel, index) => Math.round(channel + (end[index] - channel) * clamped));
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

function hexToRgb(hex) {
  const normalized = String(hex).trim().replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16));
}

// Change-over-time coverage lives in a small info icon beside the equation (the equation itself
// already shows what's being compared). The icon's tooltip carries the set-aside detail — which
// selected metrics the window can't honestly compare, and why — without covering the map.
function renderDeltaCoverageNote() {
  const info = document.getElementById("delta-info");
  if (!info) return;
  if (!explorerState.deltaMode) {
    info.hidden = true;
    return;
  }
  const from = document.getElementById("delta-from-year")?.value;
  const to = document.getElementById("delta-to-year")?.value;
  // Reasons computed fresh against the CURRENT window, so year changes keep the tooltip truthful.
  const pruned = Object.keys(explorerState.deltaSetAside || {}).map((id) => ({
    label: explorerState.metrics.find((m) => m.metric_id === id)?.label || id,
    reason: deltaExclusionReason(id, Number(from), Number(to)) || "unavailable for this view",
  }));
  const comparedCount = Object.values(explorerState.weights).filter((w) => Number(w) > 0).length;
  let text = `Change ${from}→${to} compares only metrics remeasured in that window.`;
  if (pruned.length) {
    text += ` Set aside: ${pruned.map((p) => `${p.label} (${p.reason})`).join("; ")}.`;
  }
  if (!comparedCount) {
    text += " None of the selected metrics qualify — try a wider window.";
  }
  info.title = text;
  info.setAttribute("aria-label", text);
  info.hidden = false;
}

async function refreshMetricViews() {
  const refreshId = explorerState.scoreRefreshId + 1;
  explorerState.scoreRefreshId = refreshId;
  setMapShadeLoading(true);
  try {
    explorerState.scoreDetailsCache.clear();
    explorerState.scoreDetailsLoading.clear();
    await ensureYears(explorerState.areaType, neededYearKeys()); // lazy per-year; weight changes never refetch
    if (refreshId !== explorerState.scoreRefreshId) return;
    const scores = explorerState.deltaMode
      ? computeDeltaScores()
      : computeScores(explorerState.weights, explorerState.selectedYear || "latest");
    explorerState.cityScores = scores;
    explorerState.scores = applyLens(scores);
    updateMapStyles();
    renderDeltaCoverageNote();
    renderWeightedRanker();
    if (explorerState.currentVisualizer === "visualizer-timeline") {
      await refreshTimelineForSelectedMetrics();
    }
    writeLandingUrl();
  } catch (error) {
    if (refreshId !== explorerState.scoreRefreshId) return;
    renderMetricError(error, () => refreshMetricViews());
  } finally {
    if (refreshId === explorerState.scoreRefreshId) {
      setMapShadeLoading(false);
    }
  }
}

function setMapShadeLoading(isLoading) {
  const mapCard = document.getElementById("visualizer-map");
  const loading = document.getElementById("map-shade-loading");
  mapCard?.classList.toggle("is-shading-loading", isLoading);
  mapCard?.setAttribute("aria-busy", isLoading.toString());
  if (loading) {
    loading.hidden = !isLoading;
  }
}

function initMapDetailToggle() {
  const toggle = document.getElementById("map-detail-toggle");
  if (!toggle) return;

  const showDetails = storedMapDetailsPreference();
  toggle.checked = showDetails;
  setMapDetailsVisible(showDetails);
  toggle.addEventListener("change", () => {
    setMapDetailsVisible(toggle.checked);
    storeMapDetailsPreference(toggle.checked);
  });
}

function storedMapDetailsPreference() {
  try {
    return window.localStorage.getItem(MAP_DETAILS_STORAGE_KEY) === "true";
  } catch (_error) {
    return false;
  }
}

function storeMapDetailsPreference(isVisible) {
  try {
    window.localStorage.setItem(MAP_DETAILS_STORAGE_KEY, isVisible.toString());
  } catch (_error) {
    // Map details are optional, so storage failures can be ignored.
  }
}

function setMapDetailsVisible(isVisible) {
  if (isVisible && !map.hasLayer(mapDetailsLayer)) {
    mapDetailsLayer.addTo(map);
  } else if (!isVisible && map.hasLayer(mapDetailsLayer)) {
    map.removeLayer(mapDetailsLayer);
  }
}

function updateMapStyles() {
  for (const [wardId, layer] of explorerState.mapLayers.entries()) {
    layer.setStyle(wardStyle(wardId));
  }
  renderMapLegend();
}

function selectWard(wardId) {
  explorerState.currentWardId = String(wardId);
  renderMapHint();
  const ward = findArea(wardId);
  if (!ward) return;

  WardWiseExplorer.track("explore_area_select", { area_type: explorerState.areaType, area_id: wardId });
  explorerState.miniOpenMetric = null;
  explorerState.urlDirty = true;
  updateMapStyles();
  updateSelectedWardLabel(wardId);
  renderWeightedRanker();
  renderCompositeTimeline();
  writeLandingUrl();
  // On the phone the report lives in the leaderboard pane: bring it forward.
  if (window.matchMedia && window.matchMedia("(max-width: 640px)").matches) setMobileView("ranker");
  syncMobileViewLabel();
}

function clearSelectedWard() {
  explorerState.currentWardId = null;
  renderMapHint();
  explorerState.hoveredWardId = null;
  explorerState.miniOpenMetric = null;
  updateMapStyles();
  updateSelectedWardLabel(null);
  renderWeightedRanker();
  renderCompositeTimeline();
  writeLandingUrl();
  syncMobileViewLabel();
}

// The phone toggle's second pane is the leaderboard until an area is selected, then its report.
function syncMobileViewLabel() {
  const button = document.querySelector('.mobile-view-toggle button[data-mobile-view="ranker"]');
  if (button) button.textContent = explorerState.currentWardId ? "Report" : "Leaderboard";
}

// Hover: outline the area on the map, lift its leaderboard row, and (from the map) show a sticky
// "Name · 14th of 50" tip. The old detail popover is gone; the mini report is the click.
function previewWard(wardId, layer) {
  const previous = explorerState.hoveredWardId;
  explorerState.hoveredWardId = wardId;
  if (previous) restyleArea(previous);
  restyleArea(wardId);
  highlightRankerRow(wardId);
  if (layer && String(wardId) !== explorerState.currentWardId) {
    const area = findArea(wardId);
    const standing = scoreForWard(wardId);
    const n = rankedScoreCount();
    const where = standing?.rank
      ? ` · ${explorerState.deltaMode ? rankerScoreText(standing.score) : `${WardWiseScoring.ordinal(standing.rank)} of ${n}`}`
      : "";
    layer.bindTooltip(`${WardWiseExplorer.escapeHtml(area?.display_name || wardId)}${where}`, {
      sticky: true,
      direction: "top",
      className: "ward-hover-tip",
      opacity: 1,
    }).openTooltip();
  }
}

function clearWardPreview(wardId) {
  if (explorerState.hoveredWardId !== wardId) return;
  explorerState.hoveredWardId = null;
  restyleArea(wardId);
  highlightRankerRow(null);
  const layer = explorerState.mapLayers.get(String(wardId));
  if (layer && String(wardId) !== explorerState.currentWardId) layer.unbindTooltip();
}

function restyleArea(wardId) {
  const layer = explorerState.mapLayers.get(String(wardId));
  if (layer) layer.setStyle(wardStyle(String(wardId)));
}

// Emphasize the hovered area's row in the leaderboard (and scroll it into view) without a full re-render.
function highlightRankerRow(wardId) {
  const table = document.querySelector("#comparison-table");
  if (!table) return;
  table.querySelectorAll(".comparison-row.is-hovered").forEach((row) => row.classList.remove("is-hovered"));
  if (wardId == null) return;
  const row = table.querySelector(`.comparison-row[data-ward-id="${CSS.escape(String(wardId))}"]`);
  if (row) {
    row.classList.add("is-hovered");
    row.scrollIntoView({ block: "nearest" });
  }
}

// Per-metric components of an area's score, computed client-side from the already-loaded matrix —
// the score AND the raw value are both in each cell — so there is no per-selection fetch.
function wardScoreComponents(wardId) {
  const matrix = explorerState.scoreMatrices[explorerState.areaType] || {};
  if (explorerState.deltaMode) {
    // In change-over-time, a component's contribution is its normalized CHANGE between endpoints, and the
    // "raw value" people want is the difference (with pre→post), not a single year's snapshot.
    const fromYear = document.getElementById("delta-from-year")?.value;
    const toYear = document.getElementById("delta-to-year")?.value;
    const fromCells = (matrix[fromYear] || {})[String(wardId)] || {};
    const toCells = (matrix[toYear] || {})[String(wardId)] || {};
    const { domain, normalize } = deltaNormalizer();
    const components = [];
    for (const [metricId, weight] of Object.entries(explorerState.weights)) {
      const a = fromCells[metricId];
      const b = toCells[metricId];
      if (Number(weight) > 0 && a && b && domain[metricId]) {
        components.push({
          metric_id: metricId,
          normalized_score: normalize(b.v, metricId) - normalize(a.v, metricId), // per-metric change
          value: b.v - a.v,        // raw difference
          value_from: a.v,         // pre
          value_to: b.v,           // post
          weight: Number(weight),
          isDelta: true,
        });
      }
    }
    return components;
  }
  const slice = matrix[explorerState.selectedYear || "latest"] || matrix.latest || {};
  const cells = slice[String(wardId)] || {};
  const components = [];
  for (const [metricId, weight] of Object.entries(explorerState.weights)) {
    if (Number(weight) > 0 && cells[metricId]) {
      components.push({
        metric_id: metricId,
        normalized_score: cells[metricId].s,
        value: cells[metricId].v,
        weight: Number(weight),
      });
    }
  }
  return components;
}

function renderWardTopCommunityAreasMarkup(ward) {
  const overlaps = [...(ward?.community_area_overlaps || [])]
    .filter((area) => area.name && (area.ward_area_pct ?? 0) > 0)
    .sort((left, right) => (right.ward_area_pct ?? 0) - (left.ward_area_pct ?? 0))
    .slice(0, 3);
  if (!overlaps.length) {
    return "";
  }
  const label = overlaps
    .map((area) => {
      const pct = WardWiseExplorer.formatNumber(area.ward_area_pct ?? 0, {
        maximumFractionDigits: 1,
      });
      return `${pct}% ${area.name}`;
    })
    .map((text) => WardWiseExplorer.escapeHtml(text))
    .join(" / ");
  return `<small class="comparison-row-community-areas">${label}</small>`;
}

function renderWardVisualSignifierMarkup(ward) {
  const signifier = ward?.visual_signifier;
  if (!signifier?.image_url) {
    let badge;
    if (explorerState.areaType === "community_area") {
      // Neighborhood: the initial of its name (like the biplot) — community-area numbers aren't familiar.
      badge = String(ward?.name || ward?.display_name || "?").trim().charAt(0).toUpperCase() || "?";
    } else if (explorerState.areaType === "chi") {
      // χGRID: the bare coordinate (chi_id), dropping the "χ:" prefix to save space.
      badge = ward?.chi_id ?? "";
    } else if (explorerState.areaType === "precinct") {
      badge = ward?.precinct_number ?? "";
    } else {
      badge = ward?.ward_number ?? areaIdOf(ward) ?? "";
    }
    const cls = explorerState.areaType === "chi"
      ? "ward-signifier-fallback ward-signifier-fallback--code"  // smaller font for the 6-char coordinate
      : "ward-signifier-fallback";
    return `<span class="${cls}" aria-hidden="true">${WardWiseExplorer.escapeHtml(badge)}</span>`;
  }
  return `
    <img
      class="ward-signifier-thumb"
      src="${WardWiseExplorer.escapeHtml(signifier.image_url)}"
      alt="${WardWiseExplorer.escapeHtml(signifier.alt || signifier.name)}"
      loading="lazy"
      decoding="async"
    >
  `;
}

// In change-over-time, show the value as a SIGNED change (+ for improvement) so a number like 27.6 reads
// unambiguously as "+27.6 wellbeing points gained," not a raw score. Negatives already carry "-".
function rankerScoreText(score) {
  const text = WardWiseExplorer.formatNumber(score, { maximumFractionDigits: explorerState.deltaMode ? 1 : 2 });
  return explorerState.deltaMode && Number(score) > 0 ? `+${text}` : text;
}

// "Why it ranks": every scored area badged with the measures where it lands top-3 among the whole
// geography (competition ranking, so ties share a rank and the next one skips). Computed over
// everyone before any leaderboard filter, so the tags never change as the reader types; memoised
// per score refresh because it re-ranks every active metric.
function leaderboardMetricRanks() {
  const key = `${explorerState.scoreRefreshId}|${explorerState.areaType}|${explorerState.deltaMode}`;
  if (explorerState._metricRanks?.key === key) return explorerState._metricRanks.byArea;
  const byMetric = new Map();
  for (const row of explorerState.scores) {
    if (row.score == null) continue;
    for (const c of wardScoreComponents(row.area_id)) {
      if (!Number.isFinite(Number(c.normalized_score))) continue;
      if (!byMetric.has(c.metric_id)) byMetric.set(c.metric_id, []);
      byMetric.get(c.metric_id).push({ areaId: String(row.area_id), score: Number(c.normalized_score) });
    }
  }
  const byArea = new Map();
  for (const [metricId, entries] of byMetric) {
    entries.sort((a, b) => b.score - a.score);
    let rank = 0;
    let previous = null;
    entries.forEach((entry, index) => {
      if (previous === null || entry.score < previous) rank = index + 1;
      previous = entry.score;
      if (rank > 3) return;
      if (!byArea.has(entry.areaId)) byArea.set(entry.areaId, []);
      byArea.get(entry.areaId).push({ metricId, rank });
    });
  }
  const labelOf = (id) => metricLabelById(id);
  for (const tags of byArea.values()) tags.sort((a, b) => a.rank - b.rank || labelOf(a.metricId).localeCompare(labelOf(b.metricId)));
  explorerState._metricRanks = { key, byArea };
  return byArea;
}

function metricLabelById(metricId) {
  return explorerState.metrics.find((m) => m.metric_id === metricId)?.label || metricId;
}

// The number behind a score: the raw value in the metric's own unit and, where the pipeline
// recorded them, the count of underlying records and the residents it was divided by
// ("12.4 per 10k · 8 requests among 6,470 residents"). Reads the score-matrix cell (v / n / p).
function countNouns(metricId) {
  if (/^voter_turnout/.test(metricId)) return { count: ["ballot", "ballots"], base: "registered voters" };
  if (/vote_share|winner_share/.test(metricId)) return { count: ["vote", "votes"], base: null };
  if (/^c311_|flooding|sewer/.test(metricId)) return { count: ["request", "requests"], base: "residents" };
  if (/^licensed_/.test(metricId)) return { count: ["business", "businesses"], base: "residents" };
  return { count: ["record", "records"], base: "residents" };
}

// How recent a figure is, in a few words: "in 2025", "2026 so far, through Sep 28",
// "as of Apr 2023", "collected Sep 2026". The slice carries one period per metric; a cell
// carried forward from another year carries its own.
function currentPeriods() {
  const periods = (explorerState.matrixPeriods || {})[explorerState.areaType] || {};
  return periods[explorerState.selectedYear || "latest"] || periods.latest || {};
}

function periodOf(metricId, cell) {
  if (cell?.e) return { e: cell.e, partial: Boolean(cell.ip) };
  return currentPeriods()[metricId] || null;
}

function recencyLabel(period) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(period?.e || "");
  if (!match) return "";
  const [, year, month, day] = match;
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  if (period.partial) return `${year} so far, through ${monthName} ${Number(day)}`;
  if (period.collected) return `collected ${monthName} ${year}`;
  if (month === "12" && day === "31") return `in ${year}`;
  return `as of ${monthName} ${year}`;
}

// One quiet line for the leaderboard: only when a weighted measure is a year in progress.
function partialYearNote() {
  const periods = currentPeriods();
  const partial = selectedMetricWeights()
    .map(([metricId]) => periods[metricId])
    .filter((period) => period?.partial);
  if (!partial.length) return "";
  const newest = partial.map((period) => period.e).sort().pop();
  const label = recencyLabel({ e: newest, partial: true });
  const all = partial.length === selectedMetricWeights().length;
  return all ? `Figures are ${label}.` : `Some figures are ${label}.`;
}

function rawValueLine(metricId, areaId) {
  const cell = (currentSlice()[String(areaId)] || {})[metricId];
  const metric = explorerState.metrics.find((m) => m.metric_id === metricId);
  if (!cell || !metric || cell.v == null) return "";
  const parts = [`Measured: ${WardWiseExplorer.formatMetricValueWithUnit(cell.v, metric)}`];
  const nouns = countNouns(metricId);
  const fmt = (x) => WardWiseExplorer.formatNumber(x, { maximumFractionDigits: 0 });
  const counted = (x) => `${fmt(x)} ${Number(x) === 1 ? nouns.count[0] : nouns.count[1]}`;
  const hasN = Number.isFinite(Number(cell.n));
  const hasP = Number.isFinite(Number(cell.p)) && nouns.base;
  if (hasN && hasP) parts.push(`${counted(cell.n)} among ${fmt(cell.p)} ${nouns.base}`);
  else if (hasN) parts.push(counted(cell.n));
  else if (hasP) parts.push(`${fmt(cell.p)} ${nouns.base}`);
  const recency = recencyLabel(periodOf(metricId, cell));
  if (recency) parts.push(recency);
  return parts.join(" · ");
}

// What the leaderboard filter matches on: the name, plus the places people actually know — a
// ward's neighborhoods, a neighborhood's wards, a χGRID's long name.
function rankerSearchText(area) {
  const parts = [area?.display_name, area?.name, area?.long_name];
  // precincts have no names: match their number, their five-digit key and their neighborhood
  if (area?.ward_precinct) parts.push(area.ward_precinct, String(area.precinct_number ?? ""), area.primary_community_area);
  for (const o of area?.community_area_overlaps || []) parts.push(o.name);
  for (const w of area?.ward_overlaps || []) parts.push(w.display_name, w.ward_id ? `ward ${Number(w.ward_id)}` : "");
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function renderRankTags(areaId) {
  const tags = leaderboardMetricRanks().get(String(areaId)) || [];
  if (!tags.length) return "";
  const shown = tags.slice(0, 4);
  const more = tags.length - shown.length;
  return `<span class="comparison-row-tags">${shown
    .map((t) => `<span class="comparison-row-tag${WardWiseScoring.medalClass(t.rank, " m-")}">#${t.rank} ${WardWiseExplorer.escapeHtml(metricLabelById(t.metricId))}</span>`)
    .join("")}${more > 0 ? `<span class="comparison-row-tag">+${more}</span>` : ""}</span>`;
}

function renderWeightedRanker() {
  const table = document.querySelector("#comparison-table");
  const mini = document.querySelector("#mini-report");
  if (!table) return;
  const head = document.getElementById("ranker-head") || document.getElementById("ranker-title");
  const status = document.getElementById("ranker-search-status");
  const selected = explorerState.currentWardId && findArea(explorerState.currentWardId);
  if (head) head.hidden = Boolean(selected);
  if (mini) mini.hidden = !selected;
  table.hidden = Boolean(selected);
  const title = document.getElementById("ranker-title");
  if (title) title.textContent = lensActive() ? `Precincts in ${lensWardLabel()}` : "Leaderboard";
  if (selected) {
    renderMiniReport(explorerState.currentWardId, mini);
    return;
  }
  const query = explorerState.rankerQuery;
  const scored = [...explorerState.scores]
    .filter((score) => score.score !== null && score.score !== undefined)
    .sort((a, b) => a.rank - b.rank);
  // A ward's precincts (at most 40) all fit: the top-10 cap is for the citywide lists.
  const rows = query
    ? scored.filter((row) => rankerSearchText(findArea(row.area_id)).includes(query))
    : (lensActive() ? scored : scored.slice(0, 10));
  if (status) {
    status.textContent = query
      ? (rows.length ? `${rows.length} of ${scored.length} ${labelLower()} match` : `No ${labelLower()} match`)
      : "";
  }
  if (query && !rows.length) {
    table.innerHTML = `<div class="comparison-empty"><p>No ${WardWiseExplorer.escapeHtml(labelLower())} match “${WardWiseExplorer.escapeHtml(query)}”.</p></div>`;
    return;
  }
  if (!rows.length) {
    table.innerHTML = `
      <div class="comparison-empty">
        <p><strong>No metrics selected.</strong></p>
        <p>Tap metric squares in the panel — or let <button type="button" class="comparison-empty-surprise">Surprise me</button> pick a starting mix.</p>
      </div>`;
    table.querySelector(".comparison-empty-surprise")?.addEventListener("click", () =>
      document.getElementById("surprise-me")?.click());
    return;
  }
  table.innerHTML = `
    <div class="comparison-header">
      <span>${WardWiseExplorer.escapeHtml(areaConfig().label)}</span>
      <span>${explorerState.deltaMode ? "Change" : "Score"}</span>
    </div>
    ${!explorerState.deltaMode && partialYearNote() ? `<p class="comparison-note">${WardWiseExplorer.escapeHtml(partialYearNote())}</p>` : ""}
    ${rows
      .map((row) => {
        const isSelected = String(row.area_id) === explorerState.currentWardId;
        const ward = findArea(row.area_id);
        const bar = explorerState.deltaMode || !Number.isFinite(Number(row.score))
          ? ""
          : `<span class="comparison-row-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, Number(row.score))).toFixed(1)}%"></i></span>`;
        return `
          <button class="comparison-row${isSelected ? " is-selected" : ""}" type="button" data-ward-id="${row.area_id}">
            <span class="comparison-row-main">
              <span class="comparison-row-rank num">${row.rank ? String(row.rank).padStart(2, "0") : "—"}</span>
              ${renderWardVisualSignifierMarkup(ward)}
              <span class="comparison-row-copy">
                <span class="comparison-row-title">${WardWiseExplorer.escapeHtml(ward?.display_name || row.area_id)}</span>
                ${renderWardTopCommunityAreasMarkup(ward)}
              </span>
            </span>
            <strong>${rankerScoreText(row.score)}</strong>
            ${bar}
            ${renderRankTags(row.area_id)}
          </button>
        `;
      })
      .join("")}
  `;
  table.querySelectorAll(".comparison-row").forEach((row) => {
    row.addEventListener("click", () => selectWard(row.dataset.wardId));
    row.addEventListener("mouseenter", () => previewWard(row.dataset.wardId));
    row.addEventListener("mouseleave", () => clearWardPreview(row.dataset.wardId));
  });
}

// ---- the mini report ----
// What the leaderboard card shows once an area is selected: where it stands on the current list,
// the whole field with it pinned, its strongest and weakest measures, and the way to the full report.
// Rendered from the already-loaded slice, so every weight / year / geography change re-renders it.
const MINI_REPORT_LINKS = { report: true, compare: true }; // flipped on as those pages ship

function renderMiniReport(areaId, container) {
  if (!container) return;
  const esc = WardWiseExplorer.escapeHtml;
  const area = findArea(areaId);
  const geo = WardWiseGeography.byApi(explorerState.areaType);
  const nameFor = (id) => findArea(id)?.display_name || String(id);
  const standing = scoreForWard(areaId);
  const n = rankedScoreCount();
  const listName = activePreset()?.name || "your list";
  const slice = currentSlice();
  const selectedIds = selectedMetricWeights().map(([metricId]) => metricId);
  const standings = WardWiseScoring.metricStandings(slice, areaId, selectedIds);
  const metricById = new Map(explorerState.metrics.map((metric) => [metric.metric_id, metric]));
  const missing = selectedIds.filter((id) => !standings.some((item) => item.metric_id === id));

  // identity
  let sub = "";
  if (explorerState.areaType === "ward") {
    sub = renderWardTopCommunityAreasMarkup(area).replace("comparison-row-community-areas", "mini-sub");
  } else if (explorerState.areaType === "community_area") {
    const wards = [...(area?.ward_overlaps || [])]
      .filter((w) => (w.community_area_pct ?? 0) >= 1)
      .sort((a, b) => (b.community_area_pct ?? 0) - (a.community_area_pct ?? 0))
      .slice(0, 4);
    sub = wards.length
      ? `<span class="mini-sub">${wards
          .map((w) => `<button type="button" class="mini-chip" data-act="goto" data-area-type="ward" data-area-id="${esc(w.ward_id)}" title="${esc(`${WardWiseExplorer.formatNumber(w.community_area_pct ?? 0, { maximumFractionDigits: 0 })}% of this neighborhood is in ${w.display_name}`)}">${esc(w.display_name)}</button>`)
          .join("")}</span>`
      : "";
  } else if (explorerState.areaType === "precinct") {
    sub = area?.primary_community_area ? `<span class="mini-sub">${esc(area.primary_community_area)}</span>` : "";
  } else {
    // unnamed cells carry their coordinate as both name and long name: no point saying it twice
    const longName = area?.long_name && !area.long_name.startsWith(area.display_name || "\u0000") ? area.long_name : "";
    sub = longName ? `<span class="mini-sub">${esc(longName)}</span>` : "";
  }
  // The mockup's trio: SCORE / RANK / who holds the seat (or, off wards, the places it overlaps).
  let stats = "";
  if (!explorerState.deltaMode) {
    const scoreText = standing?.score != null ? WardWiseExplorer.formatNumber(standing.score, { maximumFractionDigits: 1 }) : "—";
    const rankText = standing?.rank ? `<b>#${standing.rank}</b> <small>/ ${n}</small>` : "<b>—</b>";
    let third;
    if (explorerState.areaType === "ward") {
      third = `<span class="mini-stat"><small>Alderman</small><b class="mini-stat-name" data-alder>${renderMiniAlderName(areaId)}</b></span>`;
    } else if (explorerState.areaType === "community_area") {
      const wards = [...(area?.ward_overlaps || [])].filter((w) => (w.community_area_pct ?? 0) >= 1).sort((a, b) => (b.community_area_pct ?? 0) - (a.community_area_pct ?? 0)).slice(0, 3);
      third = `<span class="mini-stat"><small>Wards</small><b class="mini-stat-name">${wards.length ? esc(wards.map((w) => Number(w.ward_id)).join(" · ")) : "—"}</b></span>`;
    } else if (explorerState.areaType === "precinct") {
      const cityN = explorerState.cityScores.filter((s) => s.score !== null && s.score !== undefined).length;
      const cityRank = standing?.city_rank ? `<b>#${standing.city_rank}</b> <small>/ ${cityN}</small>` : "<b>—</b>";
      third = `<span class="mini-stat"><small>Citywide</small><span class="num">${cityRank}</span></span>`;
    } else {
      third = `<span class="mini-stat"><small>Cell</small><b class="mini-stat-name">${esc(area?.chi_id || areaId)}</b></span>`;
    }
    stats = `<div class="mini-stats" aria-label="At a glance">
      <span class="mini-stat"><small>Score</small><b class="num">${esc(scoreText)}</b></span>
      <span class="mini-stat"><small>Rank</small><span class="num">${rankText}</span></span>
      ${third}
    </div>`;
    const top = wardScoreComponents(areaId)
      .filter((c) => Number.isFinite(Number(c.normalized_score)))
      .sort((a, b) => b.normalized_score * b.weight - a.normalized_score * a.weight)
      .slice(0, 3);
    if (top.length) {
      stats += `<div class="mini-contrib"><span class="mini-contrib-row mini-contrib-head"><span>Measure</span><span>Score (0-100)</span><span>Weight</span></span>${top.map((c) => {
        const high = isPriorityWeight(c.weight);
        const raw = rawValueLine(c.metric_id, areaId);
        return `<span class="mini-contrib-row"><span class="mini-contrib-label">${esc(metricById.get(c.metric_id)?.label || c.metric_id)}</span>` +
          `<b class="num">${WardWiseExplorer.formatNumber(c.normalized_score, { maximumFractionDigits: 1 })}</b>` +
          `<span class="mini-weight${high ? " is-high" : ""}">${high ? "★" : ""}${WardWiseExplorer.formatNumber(c.weight, { maximumFractionDigits: 1 })}×</span>` +
          (raw ? `<span class="mini-contrib-raw">${esc(raw)}</span>` : "") + `</span>`;
      }).join("")}</div>`;
    }
  }
  const represented = "";

  // standing
  let hero;
  let lede;
  if (explorerState.deltaMode) {
    const fromYear = document.getElementById("delta-from-year")?.value;
    const toYear = document.getElementById("delta-to-year")?.value;
    const hasScore = standing?.score != null;
    hero = `<div class="ww-hero-big num${hasScore && standing.score < 0 ? " down" : ""}">${hasScore ? esc(rankerScoreText(standing.score)) : "—"}` +
      `<small>${hasScore ? `wellbeing points, ${esc(fromYear)} → ${esc(toYear)}` : "no change data for this window"}</small></div>`;
    lede = hasScore
      ? `<p class="ww-lede">${standing.rank ? `<b>${WardWiseScoring.ordinal(standing.rank)}</b> biggest improvement of ${n} ${esc(geo.plural)} on ${esc(listName)}.` : ""}</p>`
      : "";
  } else if (standing?.rank) {
    const ahead = standings.filter((item) => item.rank <= Math.ceil(item.n / 2)).length;
    const podium = standings.filter((item) => item.rank <= 3).length;
    hero = WardWiseCharts.heroRank({ rank: standing.rank, of: n, plural: geo.plural });
    const clauses = [];
    clauses.push(`On <b>${esc(listName)}</b>, ${esc(nameFor(areaId))} is ahead of the middle ${esc(geo.noun)} on <b>${ahead} of ${standings.length}</b> measures`);
    if (podium) clauses.push(`and on the podium for ${podium}`);
    let text = `${clauses.join(" ")}.`;
    if (missing.length) {
      const names = missing.slice(0, 3).map((id) => metricById.get(id)?.label || id);
      const more = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
      text += ` <span class="soft">${missing.length === 1 ? "One measure has" : `${missing.length} measures have`} no record for ${esc(WardWiseGeography.labelLower(geo))} here: ${esc(names.join(", "))}${more}.</span>`;
    }
    lede = `<p class="ww-lede">${text}</p>`;
  } else {
    hero = `<div class="ww-hero-big num">—<small>not scored on ${esc(listName)}</small></div>`;
    lede = `<p class="ww-lede"><span class="soft">None of the selected measures has a record for this ${esc(geo.noun)}.</span></p>`;
  }

  // the field
  let field = "";
  if (!explorerState.deltaMode && standing?.rank) {
    field = WardWiseCharts.densityField({
      rows: explorerState.scores, areaId, nameFor, noun: geo.noun, plural: geo.plural, listName,
    });
  }

  // strongest / weakest, or biggest movers in change mode
  let peek = "";
  if (explorerState.deltaMode) {
    const movers = wardScoreComponents(areaId)
      .sort((a, b) => Math.abs(b.normalized_score) * b.weight - Math.abs(a.normalized_score) * a.weight)
      .slice(0, 5);
    if (movers.length) {
      peek = `<div class="ww-peekhead">Biggest changes</div><div class="mini-movers">${movers
        .map((c) => {
          const metric = metricById.get(c.metric_id);
          const fmt = (v) => WardWiseExplorer.formatMetricValue(v, metric);
          const sign = c.normalized_score > 0 ? "+" : "";
          return `<div class="mini-mover"><span class="lbl">${esc(metric?.label || c.metric_id)}</span>` +
            `<span class="vals">${esc(fmt(c.value_from))} → ${esc(fmt(c.value_to))}</span>` +
            `<b class="num ${c.normalized_score >= 0 ? "up" : "down"}">${sign}${WardWiseExplorer.formatNumber(c.normalized_score, { maximumFractionDigits: 1 })}</b></div>`;
        })
        .join("")}</div>`;
    }
  } else if (standings.length) {
    const strongest = standings.slice(0, 3);
    const weakest = standings.length > 3 ? standings.slice(-2).reverse() : [];
    const box = (item, weak) => WardWiseCharts.rankBox({
      metricId: item.metric_id,
      label: metricById.get(item.metric_id)?.label || item.metric_id,
      rank: item.rank,
      of: item.n,
      weak: weak && item.rank > item.n / 2,
      open: explorerState.miniOpenMetric === item.metric_id,
    });
    peek = `<div class="ww-peekhead">Strongest</div><div class="ww-rankboxes">${strongest.map((i) => box(i, false)).join("")}</div>`;
    if (weakest.length) {
      peek += `<div class="ww-peekhead">Weakest</div><div class="ww-rankboxes">${weakest.map((i) => box(i, true)).join("")}</div>`;
    }
    const openId = explorerState.miniOpenMetric;
    if (openId && standings.some((item) => item.metric_id === openId)) {
      const entries = Object.entries(slice)
        .filter(([, cells]) => cells && openId in cells)
        .map(([id, cells]) => ({ area_id: id, s: Number(cells[openId].s), v: cells[openId].v }))
        .sort((a, b) => b.s - a.s || String(a.area_id).localeCompare(String(b.area_id)))
        .map((entry, index) => ({ ...entry, rank: index + 1 }));
      peek += WardWiseCharts.relativeStrip({ metric: metricById.get(openId), entries, areaId, nameFor });
    }
    peek += `<p class="mini-peeknote">Tap a box to see everyone on that measure's real scale.</p>`;
  }

  // Some values rest on a small base (a precinct's handful of 311 requests): say so rather than
  // hide them. The tag is precomputed per (geography, metric) by the pipeline.
  const methodology = explorerState.metricMethodology[explorerState.areaType] || {};
  const smallBase = selectedIds.some((id) => (methodology[id] || []).includes("small_base"));
  const smallBaseNote = smallBase
    ? `<p class="mini-peeknote">Some measures here rest on fewer than 20 underlying records — shown, not hidden, with that caveat.</p>`
    : "";

  // the way onward (the report / compare pages speak peer geographies only; the lens stays here)
  const ctas = [];
  if (MINI_REPORT_LINKS.report && !geo.explorerOnly) {
    ctas.push(`<a class="ww-cta" href="${esc(WardWiseGeography.reportUrl(explorerState.areaType, areaId, { weights: explorerState.weights, presetId: explorerState.activePresetId, year: explorerState.selectedYear }))}">Open full report →</a>`);
  }
  if (explorerState.areaType === "ward") {
    ctas.push(`<button type="button" class="ww-cta ghost" data-act="precincts" data-area-id="${esc(areaId)}">See its precincts</button>`);
  }
  if (MINI_REPORT_LINKS.compare && !geo.explorerOnly) {
    ctas.push(`<a class="ww-cta ghost" href="${esc(WardWiseGeography.compareUrl(explorerState.areaType, areaId, null, { weights: explorerState.weights, year: explorerState.selectedYear }))}">Compare with another ${esc(geo.noun)}</a>`);
  }
  if (lensActive()) {
    ctas.push(`<button type="button" class="ww-cta ghost" data-act="goto" data-area-type="ward" data-area-id="${esc(explorerState.lensWardId)}">Back to ${esc(lensWardLabel())}</button>`);
  }

  container.innerHTML = `
    <div class="mini-head">
      <button type="button" class="ww-linkbtn mini-back" data-act="back">← Leaderboard</button>
    </div>
    <div class="mini-ident">
      ${renderWardVisualSignifierMarkup(area)}
      <div class="mini-ident-copy">
        <h3 class="ww-areaname">${esc(area?.display_name || areaId)}</h3>
        ${sub}
      </div>
    </div>
    ${represented}
    ${stats}
    ${smallBaseNote}
    ${explorerState.deltaMode ? hero : ""}
    ${lede}
    ${field}
    ${peek}
    ${ctas.length ? `<div class="ww-ctas">${ctas.join("")}</div>` : ""}
  `;
  WardWiseCharts.attachTips(container);
  if (explorerState.areaType === "ward") loadMiniAlderLine(areaId, container);
}

function renderMiniAlderName(wardId) {
  const cached = explorerState.profileCache.get(`ward:${wardId}`);
  if (cached === undefined) return `<span class="soft">…</span>`;
  const alder = cached?.alderperson;
  return alder?.name ? WardWiseExplorer.escapeHtml(alder.name) : `<span class="soft">—</span>`;
}

function renderMiniAlderLine(wardId) {
  const cached = explorerState.profileCache.get(`ward:${wardId}`);
  if (cached === undefined) return `<span class="soft">Finding the alderperson…</span>`;
  const alder = cached?.alderperson;
  if (!alder?.name) return `<span class="soft">No alderperson profile on file.</span>`;
  return `Represented by <b>${WardWiseExplorer.escapeHtml(alder.name)}</b>`;
}

async function loadMiniAlderLine(wardId, container) {
  const key = `ward:${wardId}`;
  if (explorerState.profileCache.has(key)) return;
  try {
    const details = await WardWiseExplorer.fetchWardDetails(wardId);
    explorerState.profileCache.set(key, details);
  } catch (_error) {
    explorerState.profileCache.set(key, null);
  }
  // Only refresh the one line, and only if this ward is still the one on screen.
  if (explorerState.currentWardId !== String(wardId)) return;
  const line = container.querySelector("[data-alder]");
  if (line) line.innerHTML = line.classList.contains("mini-stat-name") ? renderMiniAlderName(wardId) : renderMiniAlderLine(wardId);
}

function initMiniReportActions() {
  document.getElementById("mini-report")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "back") {
      clearSelectedWard();
      WardWiseExplorer.track("mini_report_back", { area_type: explorerState.areaType });
    } else if (act === "rankbox") {
      const metricId = target.dataset.metricbox;
      explorerState.miniOpenMetric = explorerState.miniOpenMetric === metricId ? null : metricId;
      renderWeightedRanker();
    } else if (act === "goto") {
      // a ward chip on a neighborhood's report: jump geographies and select that ward
      const areaType = target.dataset.areaType;
      const areaId = target.dataset.areaId;
      switchAreaType(areaType).then(() => {
        if (explorerState.areaType === areaType && findArea(areaId)) selectWard(areaId);
      });
    } else if (act === "precincts") {
      enterPrecinctLens(target.dataset.areaId);
    }
  });
}

function initMetricSearch() {
  const input = document.getElementById("metric-search");
  if (!input) return;
  input.addEventListener("input", () => {
    explorerState.metricQuery = input.value.trim().toLowerCase();
    renderMetricControls();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      input.value = "";
      explorerState.metricQuery = "";
      renderMetricControls();
    }
  });
}

function initRankerSearch() {
  const input = document.getElementById("ranker-search");
  if (!input) return;
  input.placeholder = `Filter ${labelLower()}…`;
  input.addEventListener("input", () => {
    explorerState.rankerQuery = input.value.trim().toLowerCase();
    renderWeightedRanker();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && input.value) {
      input.value = "";
      explorerState.rankerQuery = "";
      renderWeightedRanker();
    }
  });
}

function renderSelectedWardHistory() {
  refreshTimelineForSelectedMetrics();
}

async function refreshTimelineForSelectedMetrics() {
  const metricIds = selectedTimelineMetricIds();
  if (!metricIds.length) {
    explorerState.metricTimeline = null;
    explorerState.timelineMetricKey = "";
    explorerState.timelineLoading = false;
    renderCompositeTimeline();
    return;
  }

  const metricKey = metricIds.join(",");
  if (explorerState.timelineMetricKey === metricKey && explorerState.metricTimeline) {
    renderCompositeTimeline();
    return;
  }

  explorerState.timelineMetricKey = metricKey;
  explorerState.timelineLoading = true;
  renderCompositeTimeline();
  try {
    const timelineData = await WardWiseExplorer.fetchTimeline({
      areaType: explorerState.areaType,
      metricIds,
      wardId: explorerState.lensWardId, // the lens fetches one ward's precinct series, not 1,291
    });
    if (explorerState.timelineMetricKey !== metricKey) return;
    explorerState.metricTimeline = timelineData;
    explorerState.timelineLoading = false;
    renderCompositeTimeline();
  } catch (error) {
    if (explorerState.timelineMetricKey !== metricKey) return;
    explorerState.metricTimeline = null;
    explorerState.timelineLoading = false;
    renderTimelineError(error);
  }
}

function selectedTimelineMetricIds() {
  return selectedMetricWeights().map(([metricId]) => metricId);
}

function renderCompositeTimeline() {
  const container = document.querySelector("#time-series");
  if (!container) return;

  if (explorerState.timelineLoading) {
    container.innerHTML = "<p>Loading weighted composite history...</p>";
    return;
  }

  if (!selectedMetricWeights().length) {
    container.innerHTML = "<p>Choose at least one metric to see history.</p>";
    return;
  }

  const timeline = buildCompositeTimeline();
  if (!timeline.series.length) {
    container.innerHTML = "<p>No weighted composite timeline is available yet.</p>";
    return;
  }

  container.innerHTML = renderCompositeTimeseries(timeline);
  attachTimelineHoverHandlers(container);
}

function buildCompositeTimeline() {
  const selectedWeights = selectedMetricWeights();
  const metricTimeline = explorerState.metricTimeline;
  if (!selectedWeights.length || !metricTimeline?.series?.length) {
    return { series: [] };
  }

  const metricById = new Map(explorerState.metrics.map((metric) => [metric.metric_id, metric]));
  const selectedMetricIds = new Set(selectedWeights.map(([metricId]) => metricId));
  const snapshots = new Map();
  metricTimeline.series.forEach((metricSeries) => {
    if (!selectedMetricIds.has(metricSeries.metric_id)) return;
    (metricSeries.values || []).forEach((value, index) => {
      if (value === null || value === undefined) return;
      const snapshotRecord = metricTimeline.snapshots?.[index] || {};
      const snapshotId = snapshotRecord.snapshot_id || snapshotRecord.collected_at;
      if (!snapshotId) return;
      if (!snapshots.has(snapshotId)) {
        snapshots.set(snapshotId, {
          snapshotId,
          collectedAt: snapshotRecord.collected_at,
          observationsByMetric: new Map(),
        });
      }
      const snapshot = snapshots.get(snapshotId);
      if (!snapshot.observationsByMetric.has(metricSeries.metric_id)) {
        snapshot.observationsByMetric.set(metricSeries.metric_id, new Map());
      }
      snapshot.observationsByMetric
        .get(metricSeries.metric_id)
        .set(metricSeries.area_id, Number(value));
    });
  });

  const orderedSnapshots = [...snapshots.values()].sort((a, b) =>
    String(a.collectedAt || a.snapshotId).localeCompare(String(b.collectedAt || b.snapshotId)),
  );
  const wardSeries = explorerState.wards.map((ward) => ({
    ward,
    observations: [],
  }));
  const averageObservations = [];

  orderedSnapshots.forEach((snapshot) => {
    const domains = metricDomainsForSnapshot(snapshot.observationsByMetric, selectedWeights);
    const snapshotScores = [];
    wardSeries.forEach((series) => {
      const score = compositeScoreForWard({
        wardId: areaIdOf(series.ward),
        observationsByMetric: snapshot.observationsByMetric,
        domains,
        metricById,
        selectedWeights,
      });
      if (score === null) return;
      const observation = {
        value: score,
        collected_at: snapshot.collectedAt,
        snapshot_id: snapshot.snapshotId,
      };
      series.observations.push(observation);
      snapshotScores.push(score);
    });
    if (snapshotScores.length) {
      averageObservations.push({
        value: snapshotScores.reduce((sum, value) => sum + value, 0) / snapshotScores.length,
        collected_at: snapshot.collectedAt,
        snapshot_id: snapshot.snapshotId,
      });
    }
  });

  const visibleWardSeries = wardSeries.filter((series) => series.observations.length);
  const allValues = [
    ...visibleWardSeries.flatMap((series) => series.observations.map((observation) => observation.value)),
    ...averageObservations.map((observation) => observation.value),
  ];
  return {
    series: visibleWardSeries,
    averageSeries: {
      observations: averageObservations,
    },
    selectedWardId: explorerState.currentWardId,
    snapshotIds: orderedSnapshots.map((snapshot) => snapshot.snapshotId),
    snapshotCount: orderedSnapshots.length,
    rangeStart: orderedSnapshots[0]?.collectedAt,
    rangeEnd: orderedSnapshots.at(-1)?.collectedAt,
    min: Math.min(...allValues),
    max: Math.max(...allValues),
  };
}

function timelineSnapshotRangeSummary(timeline) {
  const count = timeline.snapshotCount || timeline.snapshotIds?.length || 0;
  if (!count) return "";
  if (count === 1) {
    return `Showing 1 snapshot collected ${WardWiseExplorer.formatDateTime(timeline.rangeStart)}.`;
  }
  return `Showing ${count} snapshots from ${WardWiseExplorer.formatDateTime(timeline.rangeStart)} to ${WardWiseExplorer.formatDateTime(timeline.rangeEnd)}.`;
}

function selectedMetricWeights() {
  const metricIds = new Set(explorerState.metrics.map((metric) => metric.metric_id));
  return Object.entries(explorerState.weights)
    .map(([metricId, weight]) => [metricId, Number(weight)])
    .filter(
      ([metricId, weight]) =>
        metricIds.has(metricId) &&
        Number.isFinite(weight) &&
        weight > 0 &&
        metricAvailableForArea(metricId),
    );
}

function metricDomainsForSnapshot(observationsByMetric, selectedWeights) {
  const domains = new Map();
  selectedWeights.forEach(([metricId]) => {
    const values = [...(observationsByMetric.get(metricId)?.values() || [])].filter(Number.isFinite);
    if (!values.length) return;
    domains.set(metricId, {
      min: Math.min(...values),
      max: Math.max(...values),
    });
  });
  return domains;
}

function compositeScoreForWard({
  wardId,
  observationsByMetric,
  domains,
  metricById,
  selectedWeights,
}) {
  let weightedTotal = 0;
  let appliedWeight = 0;
  selectedWeights.forEach(([metricId, weight]) => {
    const value = observationsByMetric.get(metricId)?.get(wardId);
    const domain = domains.get(metricId);
    if (!Number.isFinite(value) || !domain) return;
    const normalized = normalizeMetricValue(
      value,
      domain.min,
      domain.max,
      metricById.get(metricId)?.direction || "higher",
    );
    weightedTotal += normalized * weight;
    appliedWeight += weight;
  });
  return appliedWeight ? weightedTotal / appliedWeight : null;
}

function normalizeMetricValue(value, minimum, maximum, direction) {
  if (maximum === minimum) return 50;
  const normalized = ((value - minimum) / (maximum - minimum)) * 100;
  return Math.max(0, Math.min(100, direction === "lower" ? 100 - normalized : normalized));
}

function renderCompositeTimeseries(timeline) {
  const selectedSeries = timeline.selectedWardId
    ? timeline.series.find((series) => String(areaIdOf(series.ward)) === String(timeline.selectedWardId))
    : null;
  const selectedWard = selectedSeries?.ward;
  const title = selectedWard?.display_name || `Average across ${labelLower()}`;
  const latestAverage = timeline.averageSeries.observations.at(-1);
  const latestSelected = selectedSeries?.observations.at(-1);
  const comparisonSeries = timeline.series.filter(
    (series) => String(areaIdOf(series.ward)) !== String(timeline.selectedWardId),
  );
  return `
    <div class="history-card">
      <p class="eyebrow">Weighted composite</p>
      <h3>${WardWiseExplorer.escapeHtml(title)}</h3>
      <p class="timeline-range">${WardWiseExplorer.escapeHtml(timelineSnapshotRangeSummary(timeline))}</p>
      <p class="timeline-note">All ${areaNoun()} histories are shown at 0.1 opacity for comparison. Hover a point to see its snapshot time.</p>
      <svg class="sparkline" viewBox="0 0 100 100" role="img" aria-label="Weighted composite timeline">
        ${renderTimelinePath({
          observations: timeline.averageSeries.observations,
          timeline,
          opacity: selectedSeries ? 0.65 : 1,
          strokeWidth: 3,
          label: `Average across ${labelLower()}`,
        })}
        ${comparisonSeries.map((series) => renderTimelinePath({
          observations: series.observations,
          timeline,
          opacity: 0.1,
          strokeWidth: 1.4,
          label: series.ward.display_name,
        })).join("")}
        ${selectedSeries ? renderTimelinePath({
          observations: selectedSeries.observations,
          timeline,
          opacity: 1,
          strokeWidth: 3.4,
          label: selectedSeries.ward.display_name,
        }) : ""}
      </svg>
      <div class="timeline-tooltip" role="status" hidden></div>
      <div class="observation-list">
        <article>
          <strong>${WardWiseExplorer.formatNumber(latestAverage?.value, { maximumFractionDigits: 2 })}</strong>
          <span>${capitalize(areaNoun())} average latest ${WardWiseExplorer.formatDateTime(latestAverage?.collected_at)}</span>
          <small>Average is recalculated from every ${areaNoun()}'s weighted composite for each snapshot.</small>
        </article>
        ${
          latestSelected
            ? `
              <article>
                <strong>${WardWiseExplorer.formatNumber(latestSelected.value, { maximumFractionDigits: 2 })}</strong>
                <span>${WardWiseExplorer.escapeHtml(selectedWard.display_name)} latest ${WardWiseExplorer.formatDateTime(latestSelected.collected_at)}</span>
                <small>The selected ${areaNoun()} line is opaque; other ${areaNoun()} lines remain faint comparisons.</small>
              </article>
            `
            : ""
        }
      </div>
    </div>
  `;
}

function renderTimelinePath({ observations, timeline, opacity, strokeWidth, label }) {
  const pointData = observations
    .map((observation) => {
      const coords = timelinePoint(observation, timeline);
      if (!coords) return null;
      return { observation, coords };
    })
    .filter(Boolean);
  if (!pointData.length) return "";
  const polylinePoints = pointData.map((point) => point.coords).join(" ");
  return `
    <g class="timeline-series" opacity="${opacity}" data-label="${WardWiseExplorer.escapeHtml(label)}">
      <polyline class="timeline-hit-line" points="${polylinePoints}" fill="none" stroke="transparent" stroke-width="10" vector-effect="non-scaling-stroke" pointer-events="stroke"></polyline>
      <polyline points="${polylinePoints}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke"></polyline>
      ${pointData
        .map(({ observation, coords }) => {
          const [x, y] = coords.split(",");
          return `
            <circle
              class="timeline-point"
              cx="${x}"
              cy="${y}"
              r="${Math.max(1.6, strokeWidth)}"
              data-label="${WardWiseExplorer.escapeHtml(label)}"
              data-value="${WardWiseExplorer.escapeHtml(WardWiseExplorer.formatNumber(observation.value, { maximumFractionDigits: 2 }))}"
              data-date="${WardWiseExplorer.escapeHtml(WardWiseExplorer.formatDateTime(observation.collected_at))}"
            ></circle>
          `;
        })
        .join("")}
    </g>
  `;
}

function attachTimelineHoverHandlers(container) {
  const tooltip = container.querySelector(".timeline-tooltip");
  const chart = container.querySelector(".sparkline");
  if (!tooltip || !chart) return;

  const showTimelineTooltip = (target) => {
    const series = target.closest(".timeline-series");
    if (!series) return;
    series.classList.add("is-hovered");
    tooltip.hidden = false;
    tooltip.innerHTML = `
      <strong>${target.dataset.label || series.dataset.label}</strong>
      <span>${target.dataset.value} weighted composite</span>
      <small>${target.dataset.date}</small>
    `;
  };

  const hideTimelineTooltip = (target) => {
    const series = target.closest(".timeline-series");
    if (series) series.classList.remove("is-hovered");
    tooltip.hidden = true;
  };

  container.querySelectorAll(".timeline-point, .timeline-hit-line").forEach((target) => {
    target.addEventListener("pointerenter", () => showTimelineTooltip(target));
    target.addEventListener("pointermove", (event) => positionTimelineTooltip(event, tooltip, container));
    target.addEventListener("pointerleave", () => hideTimelineTooltip(target));
  });
}

function positionTimelineTooltip(event, tooltip, container) {
  WardWiseExplorer.positionTimelineTooltip(event, tooltip, container);
}

function timelinePoint(observation, timeline) {
  const index = timeline.snapshotIds.indexOf(observation.snapshot_id);
  if (index < 0) return null;
  const x = timeline.snapshotIds.length === 1 ? 50 : (index / (timeline.snapshotIds.length - 1)) * 100;
  const y = timeline.max === timeline.min
    ? 50
    : 100 - ((Number(observation.value) - timeline.min) / (timeline.max - timeline.min)) * 100;
  return `${roundChartCoordinate(x)},${roundChartCoordinate(y)}`;
}

function roundChartCoordinate(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

// A failed score/geography fetch lands where the reader is looking (the leaderboard column), says
// what happened, and offers to try again. Always clears the map spinner so no caller can leave it on.
function renderMetricError(error, retry) {
  const message = WardWiseExplorer.escapeHtml(error.message || "Unable to load metric data.");
  const table = document.querySelector("#comparison-table");
  const mini = document.getElementById("mini-report");
  setMapShadeLoading(false);
  if (mini) mini.hidden = true;
  if (!table) return;
  table.hidden = false;
  table.innerHTML = `
    <div class="comparison-error" role="alert">
      <p>${message}</p>
      ${retry ? `<button type="button" class="ww-cta ghost" data-act="retry">Try again</button>` : ""}
    </div>`;
  table.querySelector('[data-act="retry"]')?.addEventListener("click", () => retry(), { once: true });
}

function renderTimelineError(error) {
  const message = WardWiseExplorer.escapeHtml(error.message || "Unable to load history.");
  const container = document.querySelector("#time-series");
  if (container) container.innerHTML = `<p>${message}</p>`;
}

function updateSelectedWardLabel(wardId) {
  for (const layer of explorerState.mapLayers.values()) {
    layer.unbindTooltip();
  }
  if (!wardId) return;
  const selectedLayer = explorerState.mapLayers.get(String(wardId));
  const props = selectedLayer?.feature?.properties || {};
  const labelText = props.precinct_number ?? props.ward_number ?? props.community_area_number ?? props.chi_id ?? props.label;
  if (!selectedLayer || labelText == null) return;
  selectedLayer
    .bindTooltip(labelText.toString(), {
      className: "ward-label",
      permanent: true,
      direction: "center",
    })
    .openTooltip();
}

function scoreForWard(wardId) {
  return explorerState.scores.find((score) => String(score.area_id) === String(wardId));
}

function rankedScoreCount() {
  return explorerState.scores.filter((score) => score.score !== null && score.score !== undefined).length;
}

initExplorer();
