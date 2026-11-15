// Where funding moved: a diverging heat grid of one measure between two chosen periods.
// Every dot is the same disc-sum the near-you circle uses, evaluated on a sample grid.
(function () {
  const mapEl = document.getElementById("chg-map");
  if (!mapEl || typeof L === "undefined") return;

  const FAMILIES = [
    ["menu_money_usd", "Menu-money $ (project at midpoint)", true],
    ["menu_money_spread_usd", "Menu-money $ (distributed along projects)", true],
    ["home_investment_usd", "Renovation $ (permits)", true],
    ["permits", "New-construction permits", false],
    ["licenses_new", "New business licenses", false],
    ["violent_crimes", "Violent crimes (NIBRS)", false],
    ["robbery", "Robberies", false],
    ["property_crimes", "Property crimes", false],
  ];
  const TERMS = [[2007, 2011], [2011, 2015], [2015, 2019], [2019, 2023], [2023, 2026]];
  const YEARS = Array.from({ length: 2026 - 1999 + 1 }, (_, i) => 1999 + i);

  const $ = (id) => document.getElementById(id);
  const familyEl = $("chg-family"), statusEl = $("chg-status");
  for (const [key, label] of FAMILIES) familyEl.add(new Option(label, key));
  for (const id of ["chg-a-from", "chg-a-to", "chg-b-from", "chg-b-to"])
    for (const y of YEARS) $(id).add(new Option(y, y));
  $("chg-a-from").value = 2015; $("chg-a-to").value = 2019;
  $("chg-b-from").value = 2019; $("chg-b-to").value = 2023;

  const presetsEl = $("chg-presets");
  for (let i = 1; i < TERMS.length; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "near-detail-chip";
    btn.textContent = `${TERMS[i - 1][0]}–${TERMS[i - 1][1]} → ${TERMS[i][0]}–${TERMS[i][1]}`;
    btn.addEventListener("click", () => {
      $("chg-a-from").value = TERMS[i - 1][0]; $("chg-a-to").value = TERMS[i - 1][1];
      $("chg-b-from").value = TERMS[i][0]; $("chg-b-to").value = TERMS[i][1];
      load();
    });
    presetsEl.appendChild(btn);
  }
  const decade = document.createElement("button");
  decade.type = "button"; decade.className = "near-detail-chip";
  decade.textContent = "2005–15 → 2015–25";
  decade.addEventListener("click", () => {
    $("chg-a-from").value = 2005; $("chg-a-to").value = 2015;
    $("chg-b-from").value = 2015; $("chg-b-to").value = 2025;
    load();
  });
  presetsEl.appendChild(decade);

  const map = L.map("chg-map", { dragging: !window.matchMedia("(pointer: coarse)").matches, scrollWheelZoom: true, preferCanvas: true })
    .setView([41.84, -87.68], 11);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 19,
  }).addTo(map);
  // ward borders sit in their own pane ABOVE the heat fill, so the fill can be contiguous
  // without swallowing the boundaries
  map.createPane("wards");
  map.getPane("wards").style.zIndex = 460;
  fetch("/api/wards.geojson").then((r) => r.json()).then((geojson) => {
    L.geoJSON(geojson, { pane: "wards",
      style: { color: "#334155", weight: 1.4, opacity: 0.8, fill: false },
      onEachFeature: (f, layer) => {
        const n = f.properties && f.properties.ward_number;
        if (n) layer.bindTooltip(`Ward ${n}`, { sticky: true });
      } }).addTo(map);
  }).catch(() => {});
  let dots = L.layerGroup().addTo(map);

  const fmt = (v, dollars) => dollars
    ? (Math.abs(v) >= 1e6 ? "$" + (v / 1e6).toFixed(1) + "M" : "$" + Math.round(v).toLocaleString())
    : Number(v.toFixed(1)).toLocaleString();

  // diverging ramp: losses red, gains blue-green, scaled to a robust quantile so one megaproject
  // doesn't wash every other dot to grey
  function color(delta, scale) {
    const t = Math.max(-1, Math.min(1, delta / scale));
    if (t >= 0) {
      const s = Math.pow(t, 0.6);
      return `rgb(${Math.round(240 - 195 * s)},${Math.round(244 - 100 * s)},${Math.round(245 - 65 * s)})`;
    }
    const s = Math.pow(-t, 0.6);
    return `rgb(${Math.round(245 - 25 * s)},${Math.round(240 - 170 * s)},${Math.round(240 - 180 * s)})`;
  }

  let timer = null;
  async function load() {
    clearTimeout(timer);
    const family = familyEl.value;
    const spec = FAMILIES.find((f) => f[0] === family) || FAMILIES[0];
    const a = `${$("chg-a-from").value}-${$("chg-a-to").value}`;
    const b = `${$("chg-b-from").value}-${$("chg-b-to").value}`;
    const radius = $("chg-radius").value;
    statusEl.textContent = "Computing…";
    try {
      const response = await fetch(
        `/api/near/change?family=${family}&a=${a}&b=${b}&radius=${radius}&spacing=${Math.max(radius / 2, 125)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "request_failed");
      dots.remove();
      dots = L.layerGroup();
      const deltas = payload.points.map((p) => Math.abs(p[3] - p[2])).sort((x, y) => x - y);
      const scale = Math.max(deltas[Math.floor(deltas.length * 0.92)] || 1, 1);
      // Each sample paints its whole grid cell, edge to edge: the map reads as a continuous
      // surface of "is this area gaining or losing", which is what the smoothing radius is for
      // — the radius is the measurement kernel around each sample, not a thing being drawn.
      const halfLat = Number(payload.spacing_m) / 2 / 111320;
      const halfLng = Number(payload.spacing_m) / 2 / 82700;
      for (const [lat, lng, va, vb] of payload.points) {
        const delta = vb - va;
        const dot = L.rectangle(
          [[lat - halfLat, lng - halfLng], [lat + halfLat, lng + halfLng]], {
            stroke: false, fillColor: color(delta, scale),
            fillOpacity: Math.abs(delta) < scale * 0.02 ? 0.3 : 0.78,
          });
        dot.bindTooltip(
          `<strong>${delta >= 0 ? "+" : ""}${fmt(delta, spec[2])}/yr</strong><br>` +
          `${payload.a.from}–${payload.a.to}: ${fmt(va, spec[2])}/yr<br>` +
          `${payload.b.from}–${payload.b.to}: ${fmt(vb, spec[2])}/yr`, { sticky: true });
        dot.on("click", () => { window.location.href = `/near#lat=${lat}&lng=${lng}&r=1000`; });
        dots.addLayer(dot);
      }
      dots.addTo(map);
      $("chg-legend-lo").textContent = "−" + fmt(scale, spec[2]) + "/yr or more";
      $("chg-legend-hi").textContent = "+" + fmt(scale, spec[2]) + "/yr or more";
      $("chg-legend-note").textContent =
        `${payload.label}: ${payload.a.rate_years.length} vs ${payload.b.rate_years.length} covered years; click a dot for its full report.`;
      statusEl.textContent = "";
      if (window.WardWiseExplorer && WardWiseExplorer.track)
        WardWiseExplorer.track("near_change_view", { family, a, b, radius });
    } catch (error) {
      statusEl.textContent = "Could not compute (" + error.message + ").";
    }
  }
  for (const id of ["chg-family", "chg-a-from", "chg-a-to", "chg-b-from", "chg-b-to", "chg-radius"])
    $(id).addEventListener("change", () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  load();
})();
