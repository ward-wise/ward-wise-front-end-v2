// Menu money · Project map: every geocoded project over a span of years, filterable by ward and
// category. The ward outlines follow the years shown: a 2012 project is drawn over the 2003 map it
// was funded under, not today's wards.
// URL is state: /menu/map?from=&to=&ward=&category=&focus=<line id>  (?year= = a one-year range)
(function () {
  "use strict";
  const M = window.WardWiseMenu;
  const root = document.getElementById("mh-map");
  if (!root || !window.L) return;
  const esc = M.esc;
  const state = { data: null, from: null, to: null, ward: null, category: null, focus: null, items: [] };
  let map = null;
  let layer = null;
  let wardLayer = null;
  let shownEra = null;
  let loadToken = 0;

  function readUrl(data) {
    const params = new URLSearchParams(window.location.search);
    Object.assign(state, M.readRange(params, data));
    const ward = Number(params.get("ward"));
    state.ward = ward >= 1 && ward <= 50 ? ward : null;
    state.category = params.get("category") || null;
    state.focus = params.get("focus") || null;
  }
  function writeUrl() {
    M.setUrl("/menu/map", { ...M.rangeParams(state.from, state.to), ward: state.ward, category: state.category, focus: state.focus });
  }

  function controls() {
    const cats = (state.data.categories || []).map((c) => `<option value="${esc(c)}"${c === state.category ? " selected" : ""}>${esc(c)}</option>`).join("");
    return `
      <div class="ed-controls">
        ${M.rangeControls(state.data, state.from, state.to, "mm")}
        <label class="report-select">Ward <select id="mm-ward"><option value="">All wards</option>${M.wardOptions(state.ward)}</select></label>
        <label class="report-select">Category <select id="mm-cat"><option value="">All categories</option>${cats}</select></label>
      </div>
      <p class="mh-note" id="mm-count"></p>
      <p class="mh-note" id="mm-era"></p>`;
  }

  function popup(r) {
    return `<strong>${esc(r.item)}</strong><br>${esc(r.location)}<br>Ward ${r.ward} · ${r.year} · ${M.moneyExact(r.cost)}<br>
      <span class="mh-chip tone-${M.tone(r.category)}">${esc(M.shortName(r.category))}</span>
      ${r.source_url ? ` <a href="${esc(r.source_url)}" rel="noopener">source PDF</a>` : ""}`;
  }

  function color(category) {
    const value = getComputedStyle(document.body).getPropertyValue(`--menu-cat-${M.tone(category)}`).trim();
    return value || "#888";
  }

  // Outlines: the map in force in the last year shown. A range across a remap says so — the dots
  // keep the ward numbers they were posted under, which won't all match the outlines drawn.
  function drawWards() {
    const era = M.wardMap(state.to);
    const firstEra = M.wardMap(state.from);
    const note = root.querySelector("#mm-era");
    note.textContent = firstEra === era
      ? `Ward boundaries: the ${era} map, in force for ${M.rangeLabel(state.from, state.to)}.`
      : `This range spans a ward remap. Outlines show the ${era} map (in force in ${state.to}); projects from earlier years were funded under the ${firstEra === 2003 && era === 2023 ? "2003 and 2015 maps" : `${firstEra} map`}, so their ward numbers refer to different boundaries.`;
    if (era === shownEra) return;
    shownEra = era;
    M.eraWards(era).then((geo) => {
      if (shownEra !== era) return;
      if (wardLayer) wardLayer.remove();
      wardLayer = L.geoJSON(geo, {
        style: (f) => ({ color: "#5b6472", weight: f.properties.ward === state.ward ? 2.5 : 1, fill: false, opacity: f.properties.ward === state.ward ? 0.9 : 0.5 }),
        interactive: false,
      }).addTo(map);
    }).catch(() => {});
  }

  function draw() {
    const inCat = (r) => !state.category || r.category === state.category;
    const shown = state.items.filter((r) => r.lat != null && inCat(r));
    const unplaced = state.items.filter((r) => r.lat == null && inCat(r)).length;
    if (layer) layer.remove();
    layer = L.layerGroup();
    let focusMarker = null;
    const maxCost = Math.max(1, ...shown.map((r) => r.cost || 0));
    const renderer = L.canvas({ padding: 0.3 });
    // Long ranges put thousands of dots down; shrink them so streets stay readable.
    const scale = shown.length > 3000 ? 0.55 : shown.length > 800 ? 0.75 : 1;
    shown.forEach((r) => {
      const marker = L.circleMarker([r.lat, r.lng], {
        renderer, radius: scale * (2.5 + 8 * Math.sqrt((r.cost || 0) / maxCost)), color: color(r.category), weight: 1,
        fillColor: color(r.category), fillOpacity: 0.5,
      }).bindPopup(() => popup(r));
      if (r.id === state.focus) focusMarker = marker;
      layer.addLayer(marker);
    });
    layer.addTo(map);
    const total = shown.reduce((s, r) => s + (r.cost || 0), 0);
    root.querySelector("#mm-count").textContent =
      `${shown.length.toLocaleString()} projects · ${M.money(total)} · ${M.rangeLabel(state.from, state.to)}`
      + `${M.rangePartial(state.data, state.from, state.to) ? " (includes a partial year)" : ""}`
      + `${unplaced ? ` · ${unplaced.toLocaleString()} not placed on the map (see Data & methods)` : ""}`;
    map.invalidateSize();  // the notes above the map can change its offset after Leaflet measured it
    if (focusMarker) {
      map.setView(focusMarker.getLatLng(), 16);
      focusMarker.openPopup();
    } else if (shown.length && state.ward) {
      map.fitBounds(L.latLngBounds(shown.map((r) => [r.lat, r.lng])).pad(0.1));
    }
    drawWards();
    M.renderCite(root.querySelector("#mh-cite"), state.data.release,
      `project map, ${M.rangeLabel(state.from, state.to)}${state.ward ? `, Ward ${state.ward}` : ""}${state.category ? `, ${state.category}` : ""}`);
  }

  async function load() {
    const token = ++loadToken;
    root.querySelector("#mm-count").textContent = "Loading projects…";
    const yearsWanted = M.rangeYears(state.from, state.to);
    let items = [];
    try {
      if (state.ward) {
        // One call returns the ward's whole history; keep the years in range.
        const all = (await M.items({ ward: state.ward })).items || [];
        items = all.filter((r) => r.year >= state.from && r.year <= state.to);
      } else {
        const pages = await Promise.all(yearsWanted.map((y) => M.items({ year: y }).then((p) => p.items || []).catch(() => [])));
        items = pages.flat();
      }
    } catch (_error) {
      items = [];
    }
    if (token !== loadToken) return;  // a newer selection superseded this one
    state.items = items;
    draw();
  }

  function init() {
    root.innerHTML = `${controls()}<div id="mm-canvas" class="mh-map-canvas" role="region" aria-label="Map of menu projects"></div><div id="mh-cite"></div>`;
    map = L.map("mm-canvas", { dragging: !window.matchMedia("(pointer: coarse)").matches, scrollWheelZoom: false, preferCanvas: true }).setView([41.84, -87.68], 11);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(map);
    M.bindRange(root, "mm", (from, to) => {
      Object.assign(state, { from, to, focus: null });
      root.querySelector("#mm-from").value = from; root.querySelector("#mm-to").value = to;
      writeUrl(); load();
    });
    root.querySelector("#mm-ward").addEventListener("change", (e) => {
      state.ward = Number(e.target.value) || null; state.focus = null; shownEra = null; writeUrl(); load();
    });
    root.querySelector("#mm-cat").addEventListener("change", (e) => { state.category = e.target.value || null; writeUrl(); draw(); });
    load();
  }

  M.summary().then((data) => {
    state.data = data;
    readUrl(data);
    writeUrl();
    init();
  }).catch((error) => M.unavailable(root, error));
})();
