// Near you, selector-first: the map is only for choosing a spot; once chosen, the report takes
// over — term circles up top (with a home marker and per-term counts for the selected layers),
// one measures-by-terms table, and a detail explorer with its own map of actual businesses.
// Coordinates only ever travel in the URL hash — no addresses.
(function () {
  const mapEl = document.getElementById("near-map");
  if (!mapEl || typeof L === "undefined") return;

  const CHICAGO_CENTER = [41.8781, -87.6298];

  const NEAR_METRICS = [
    { family: "permits", direction: 1,
      note: "New-construction permits issued in your circle. Renovation and demolition permits are counted separately — they used to be folded in here." },
    { family: "home_investment_usd", direction: 1, dollars: true,
      note: "Reported cost of renovation and alteration permits — money going into existing buildings (rehabs, roofs, kitchens) rather than new ones. Applicants' own estimates, and small jobs never get a permit, so read it as a floor." },
    { family: "licenses_new", direction: 1, note: "New business licenses — storefront churn and openings. Chicago consolidated its licence taxonomy in December 2012 and reissued much of the city onto new records, so 2012 and 2013 read high; the years on either side are comparable." },
    { family: "licenses_restaurants_new", direction: 1,
      note: "New restaurants: the restaurant-with-liquor licence plus retail-food licences the name classifier calls restaurants. Chicago consolidated its licence taxonomy in December 2012 and reissued much of the city onto new records, so 2012 and 2013 read high; the years on either side are comparable." },
    { family: "licenses_food_new", direction: 1, note: "New food-business licenses (restaurants, groceries, bakeries). Chicago consolidated its licence taxonomy in December 2012 and reissued much of the city onto new records, so 2012 and 2013 read high; the years on either side are comparable." },
    { combinedClosures: true, label: "Business closures", direction: -1,
      note: "Both methods, de-duplicated: licences that ended with no later transaction (lagged two years so late renewals don't read as deaths), plus businesses Google marks permanently closed that the licence rule missed." },
    { family: "menu_money_usd", dollars: true, note: "Menu-money project dollars geocoded into your circle, 2005 to now (a small share of older projects with unnamed or garbled locations is missing). A block-spanning project counts here at its midpoint; the funding-moved map offers a distributed-along-the-project variant." },
    { family: "violent_crimes", direction: -1,
      note: "Homicide, sexual assault, assault, battery — geocoded by block. We follow the FBI's NIBRS standard, which classes robbery as a crime against property; robbery is under property crimes and broken out below." },
    { family: "property_crimes", direction: -1,
      note: "Theft, burglary, vehicle theft, damage, arson — plus robbery, which NIBRS classes against property (the older UCR summary index counted it as violent)." },
    { family: "robbery", label: "· robberies", direction: -1,
      note: "Broken out of property crimes so the older UCR grouping stays reconstructable: violent + robberies = the UCR violent index." },
    { family: "crashes", direction: -1, note: "Police-reported traffic crashes (recorded from 2015)." },
    { family: "crash_injuries", direction: -1, note: "People injured in those crashes." },
    { family: "c311_requests", label: "311 requests (six tracked types)",
      note: "The six request types below, added up. Chicago's 311 feed carries dozens more types; we fetch these six, so this is not every 311 call. Counts start in 2019 — the response-speed rows below reach back to 2011 because they come from a different, already-aggregated source." },
    { family: "c311_graffiti", note: "311 graffiti-removal requests (2019+)." },
    { metric: "c311_graffiti_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close graffiti requests — neighborhood-grid blend." },
    { family: "c311_rodent", note: "311 rodent-baiting requests (2019+)." },
    { metric: "c311_rodent_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close rodent requests — neighborhood-grid blend." },
    { family: "c311_pothole", note: "311 pothole reports (2019+)." },
    { metric: "c311_pothole_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close pothole reports — neighborhood-grid blend." },
    { family: "c311_street_light", note: "311 street-light-out reports (2019+)." },
    { metric: "c311_street_light_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close street-light reports — neighborhood-grid blend." },
    { family: "c311_tree_debris", note: "311 tree-debris requests (2019+)." },
    { metric: "c311_tree_debris_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close tree-debris requests — neighborhood-grid blend." },
    { family: "c311_garbage_cart", note: "311 garbage-cart requests (2019+)." },
    { metric: "c311_garbage_cart_days", label: "· days to close", mode: "level", direction: -1,
      note: "Median days to close garbage-cart requests — neighborhood-grid blend." },
    { family: "divvy_trips", note: "Divvy rides started (system data begins April 2020)." },
    { family: "sales_n", direction: 1, note: "Property sales recorded." },
    { family: "sales_usd", direction: 1, dollars: true, note: "Property sale dollars — volume, not prices." },
    { family: "murals", note: "Murals installed (registry, counted by installation year)." },
    { family: "landmarks", note: "Official landmarks designated." },
    { metric: "median_household_income", label: "Median household income", mode: "level", dollars: true,
      note: "Neighborhood-grid blend; 5-year Census averages — terms can share the latest vintage." },
    { metric: "median_gross_rent", label: "Median rent (Census)", mode: "level", dollars: true,
      note: "Neighborhood-grid blend; 5-year Census averages — terms can share the latest vintage." },
    { metric: "observed_asking_rent_usd", label: "Asking rent (Zillow)", mode: "level", dollars: true,
      note: "Zillow observed asking rent — a current-market number the Census can't see yet; recent terms only." },
    { metric: "poverty_pct", label: "Poverty rate", mode: "level", percent: true,
      note: "Neighborhood-grid blend." },
    { metric: "rent_burdened_households_pct", label: "Rent-burdened households", mode: "level", percent: true,
      note: "Share paying 30%+ of income in rent." },
  ];

  const LAYERS = [
    { family: "licenses_new", label: "New businesses", color: "#15803d", scale: 1 },
    { family: "licenses_restaurants_new", label: "New restaurants", color: "#65a30d", scale: 1 },
    { family: "licenses_closed", label: "Closures", color: "#b91c1c", scale: 1 },
    { family: "menu_money_usd", label: "Menu $", color: "#7c2d92", scale: 1 / 60000, dollars: true },
    { family: "violent_crimes", label: "Violent crime", color: "#831843", scale: 0.4 },
    { family: "property_crimes", label: "Property crime", color: "#92400e", scale: 0.2 },
    { family: "permits", label: "Permits", color: "#1d4ed8", scale: 0.5 },
    { family: "crashes", label: "Crashes", color: "#c2410c", scale: 0.4 },
    { family: "rezonings", label: "Rezonings", color: "#0f766e", scale: 2 },
  ];
  const layerEnabled = { licenses_new: true, licenses_closed: true };

  // menu-money project categories have their own vocabulary — a street resurfacing and a
  // taqueria should not share a shopfront icon
  const MENU_EMOJI = [
    [/street resurfac|street redesign|viaduct/i, "🛣️"], [/sidewalk|pedestrian/i, "🚶"],
    [/alley/i, "🛤️"], [/lighting/i, "💡"], [/traffic signal/i, "🚦"],
    [/camera|police/i, "📷"], [/park/i, "🌳"], [/school/i, "🏫"],
    [/bicycle|bike/i, "🚲"], [/beautification/i, "🌷"], [/cdot|misc/i, "🚧"],
  ];

  // category text -> marker emoji for the detail map
  const CATEGORY_EMOJI = [
    [/restaurant/i, "🍽️"], [/coffee|tea/i, "☕"], [/bar|tavern|liquor/i, "🍺"],
    [/grocer|food service|food business|convenience|bakery/i, "🛒"], [/gym|fitness/i, "🏋️"],
    [/child care/i, "🧒"], [/tobacco/i, "🚬"], [/pawn/i, "💎"], [/secondhand/i, "🛍️"],
    [/auto/i, "🚗"], [/amusement|music|dance|entertainment/i, "🎭"], [/patio/i, "🌤️"],
    [/street|transport|lighting|sidewalk|alley/i, "🚧"], [/park/i, "🌳"], [/school/i, "🏫"],
    [/camera|security/i, "📷"],
  ];
  // rezoning rows: [lat, lng, year, "RS-3 → RM-5 · 1234 N X St", capacity_sqft_delta, category],
  // category upzoning|downzoning|lateral|unknown. "lateral" is a known even FAR change; "unknown" is
  // a rezoning whose FAR on either side isn't known, and any category this file doesn't know looks
  // like it too, so nothing unresolved is ever passed off as lateral.
  const REZONING_STYLE = {
    upzoning: { emoji: "🏗️", color: "#c2410c", label: "Upzoning" },
    downzoning: { emoji: "🏡", color: "#1d4ed8", label: "Downzoning" },
    lateral: { emoji: "📐", color: "#64748b", label: "Lateral rezoning" },
    unknown: { emoji: "❔", color: "#a1a1aa", label: "FAR change unknown" },
  };
  const rezoningStyle = (category) => REZONING_STYLE[category] || REZONING_STYLE.unknown;
  const escHtml = (text) => String(text == null ? "" : text).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  // eLMS-derived text is not ours: escape it, and drop rows the map can't place
  const validRow = (r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])
    && Number.isFinite(r[2]);
  const fmtSqft = (value) => (Number.isFinite(value)
    ? `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.round(Math.abs(value)).toLocaleString()} sq ft zoned`
    : null);

  function emojiFor(category, kind) {
    if (kind === "rezoning") return rezoningStyle(category).emoji;
    if (kind === "menu_money") {
      for (const [pattern, emoji] of MENU_EMOJI) if (pattern.test(category || "")) return emoji;
      return "🚧";
    }
    for (const [pattern, emoji] of CATEGORY_EMOJI) if (pattern.test(category || "")) return emoji;
    return "🏪";
  }

  // Picker map: choosing a spot is its whole job.
  const map = L.map("near-map", { scrollWheelZoom: false }).setView(CHICAGO_CENTER, 12);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 19,
  }).addTo(map);
  fetch("/api/wards.geojson").then((r) => r.json()).then((geojson) => {
    L.geoJSON(geojson, {
      style: { color: "#7c3aed", weight: 1.4, opacity: 0.7, fill: false },
      onEachFeature: (feature, layer) => {
        const number = feature.properties && feature.properties.ward_number;
        if (number) layer.bindTooltip(`Ward ${number}`, { sticky: true, direction: "top" });
      },
    }).addTo(map);
  }).catch(() => {});
  let pin = null;
  let circle = null;
  let fetchTimer = null;
  let lastPayload = null;
  let detailTerm = null;
  let detailMap = null;
  let detailMarkers = null;
  let radiusM = 1000;
  let chartKey = null;   // which measure's annual series is open under the table
  let detailFocus = "all";   // which kind the detail map is showing

  const statusEl = document.getElementById("near-status");
  const pickerEl = document.getElementById("near-picker");
  const chooseEl = document.getElementById("near-choose");
  const resultsEl = document.getElementById("near-results");
  const areasEl = document.getElementById("near-areas");
  const stripEl = document.getElementById("near-strip");
  const termsEl = document.getElementById("near-terms");
  const layerBar = document.getElementById("near-overlays");
  const radiusEl = document.getElementById("near-radius");

  function fmt(value, spec) {
    if (value == null) return "—";
    if (spec && spec.dollars) {
      if (Math.abs(value) >= 1e6) return "$" + (value / 1e6).toFixed(1) + "M";
      return "$" + Math.round(value).toLocaleString();
    }
    if (spec && spec.percent) return value.toFixed(1) + "%";
    return Math.abs(value) >= 100 ? Math.round(value).toLocaleString()
      : Number(value.toFixed(1)).toLocaleString();
  }

  // Three states: choose (location first) -> picker map (only if they ask, or geolocation
  // fails) -> report. Most people want the block they are standing on, so the map is the
  // fallback rather than the toll gate.
  function showChooser() {
    if (chooseEl) chooseEl.hidden = false;
    pickerEl.hidden = true;
    resultsEl.hidden = true;
  }

  function showPicker(show, message) {
    pickerEl.hidden = !show;
    if (chooseEl) chooseEl.hidden = show || !resultsEl.hidden;
    if (show) {
      if (message) statusEl.textContent = message;
      setTimeout(() => map.invalidateSize(), 60);
    }
  }

  function locateMe() {
    if (!navigator.geolocation) {
      showPicker(true, "This browser can't share a location — pick a spot on the map instead.");
      return;
    }
    if (chooseEl) chooseEl.dataset.busy = "1";
    const locateButtons = document.querySelectorAll("#near-locate, #near-locate-map");
    locateButtons.forEach((button) => { button.disabled = true; button.textContent = "Locating…"; });
    const restore = () => locateButtons.forEach((button) => {
      button.disabled = false;
      button.textContent = "Use my location";
    });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        restore();
        if (chooseEl) chooseEl.hidden = true;
        setPoint(position.coords.latitude, position.coords.longitude);
      },
      () => {
        restore();
        showPicker(true, "Couldn't get your location — pick a spot on the map instead.");
      },
      { timeout: 10000 });
  }

  function setPoint(lat, lng, { push = true } = {}) {
    lat = Math.round(lat * 1e4) / 1e4;
    lng = Math.round(lng * 1e4) / 1e4;
    if (!pin) {
      pin = L.marker([lat, lng], { draggable: true }).addTo(map);
      pin.on("dragend", () => {
        const at = pin.getLatLng();
        setPoint(at.lat, at.lng);
      });
      circle = L.circle([lat, lng], { radius: radiusM, color: "#2b6cb0", weight: 2,
                                      fillOpacity: 0.05 }).addTo(map);
    } else {
      pin.setLatLng([lat, lng]);
      circle.setLatLng([lat, lng]);
      circle.setRadius(radiusM);
    }
    map.setView([lat, lng], Math.max(map.getZoom(), 13));
    if (push) window.location.hash = `lat=${lat}&lng=${lng}&r=${radiusM}`;
    statusEl.textContent = "Looking around " + lat.toFixed(4) + ", " + lng.toFixed(4) + "…";
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(() => loadSummary(lat, lng), 250);
  }

  async function loadSummary(lat, lng) {
    try {
      const response = await fetch(`/api/near/summary?lat=${lat}&lng=${lng}&radius=${radiusM}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "request_failed");
      lastPayload = payload;
      render(payload);
    } catch (error) {
      resultsEl.hidden = true;
      showPicker(true, "Could not load this point (" + error.message + ").");
    }
  }

  function memberNames(ward) {
    const names = (ward.members || []).map((m) => m.name).filter(Boolean);
    return names.length ? names.join(" → ") : "(no roster recorded)";
  }

  function termLabel(term) {
    return term.to && term.to !== term.from ? `${term.from}–${term.to}` : `${term.from}`;
  }

  function renderLayerChips(payload) {
    if (!layerBar) return;
    layerBar.innerHTML = "";
    const families = payload.families || {};
    for (const spec of LAYERS) {
      const meta = families[spec.family];
      if (!meta || !meta.years) continue;
      const wrap = document.createElement("label");
      wrap.className = "near-overlay-chip";
      wrap.style.setProperty("--chip", spec.color);
      wrap.innerHTML = `<input type="checkbox"${layerEnabled[spec.family] ? " checked" : ""}>` +
        `<span>${spec.label} <em>${meta.years[0]}–${meta.years[1]}</em></span>`;
      wrap.querySelector("input").addEventListener("change", (event) => {
        layerEnabled[spec.family] = event.target.checked;
        if (lastPayload) render(lastPayload);
      });
      layerBar.appendChild(wrap);
    }
  }

  // ---- term circles, home marker, per-term counts for the selected layers ------------------
  const WARD_STRIP_COLORS = ["#7c3aed", "#0e7490", "#b45309", "#15803d", "#be185d", "#4338ca",
                             "#a16207", "#0f766e"];
  function termStripHtml(payload) {
    const eraCells = payload.era_cells || [];
    const terms = payload.terms || [];
    if (!eraCells.length || !terms.length) return "";
    const cellsByEra = Object.fromEntries(eraCells.map((e) => [e.era, e.cells]));
    const allCells = eraCells[0].cells;
    // Project in METRES about the pin, not by stretching the cell bounding box to a square: the
    // circle is centred on your spot, and a degree of longitude is only ~0.74 of a degree of
    // latitude here, so the old box mapping both off-centred the pin and squashed the disc.
    const centre = payload.point || {};
    const originLat = Number.isFinite(centre.lat) ? centre.lat
      : allCells.reduce((sum, c) => sum + c[0], 0) / allCells.length;
    const originLng = Number.isFinite(centre.lng) ? centre.lng
      : allCells.reduce((sum, c) => sum + c[1], 0) / allCells.length;
    const lngScale = Math.cos((originLat * Math.PI) / 180);
    // half a cell of slack so edge cells sit inside the ring rather than straddling it
    const spanM = (centre.radius_m || 1000) + 60;
    const px = (lng) => 50 + (((lng - originLng) * lngScale * 111320) / spanM) * 46;
    const py = (lat) => 50 - (((lat - originLat) * 111320) / spanM) * 46;
    const wardColor = {};
    let nextColor = 0;
    const home = payload.point || {};

    const panels = terms.slice().reverse().map((term) => {
      const cells = cellsByEra[term.ward_map] || allCells;
      const wardsHere = new Set();
      const squares = cells.map(([clat, clng, ward]) => {
        if (!ward) return "";
        wardsHere.add(ward);
        if (!(ward in wardColor)) wardColor[ward] = WARD_STRIP_COLORS[nextColor++ % WARD_STRIP_COLORS.length];
        return `<rect x="${(px(clng) - 2.4).toFixed(1)}" y="${(py(clat) - 2.4).toFixed(1)}"
          width="4.8" height="4.8" fill="${wardColor[ward]}" fill-opacity="0.16"><title>Ward ${ward}</title></rect>`;
      }).join("");
      const activity = term.cell_activity || {};
      let marks = "";
      const perYear = Math.max(1, (term.to || term.from) - term.from || 1);
      for (const spec of LAYERS) {
        if (!layerEnabled[spec.family]) continue;
        for (const [clat, clng, value] of activity[spec.family] || []) {
          const r = Math.min(0.8 + Math.sqrt((value * spec.scale) / perYear) * 1.6, 4.5);
          marks += `<circle cx="${px(clng).toFixed(1)}" cy="${py(clat).toFixed(1)}" r="${r.toFixed(1)}"
            fill="${spec.color}" fill-opacity="0.55"></circle>`;
        }
      }
      const homeMark = Number.isFinite(home.lat)
        ? `<text x="${px(home.lng).toFixed(1)}" y="${(py(home.lat) + 2.6).toFixed(1)}"
             text-anchor="middle" font-size="8" paint-order="stroke" stroke="#fff"
             stroke-width="2">⌂</text>` : "";
      // per-term counts for the selected layers: what's rising and falling, at a glance
      const pointMetrics = (term.circle_metrics || {}).point_metrics || {};
      const stats = LAYERS.filter((spec) => layerEnabled[spec.family])
        .map((spec) => {
          const entry = pointMetrics[spec.family];
          if (!entry) return null;
          return `<span style="--w:${spec.color}">${fmt(entry.per_year, spec)}</span>`;
        }).filter(Boolean).join(" ");
      const label = termLabel(term);
      const legend = [...wardsHere].sort((a, b) => a - b)
        .map((w) => `<span style="--w:${wardColor[w]}">W${w}</span>`).join(" ");
      return `<figure class="near-era-panel">
        <svg viewBox="0 0 100 100" role="img" aria-label="Your circle in the ${label} term">${squares}${marks}
          <circle cx="50" cy="50" r="48" fill="none" stroke="#64748b" stroke-width="1.5"/>${homeMark}</svg>
        <figcaption><strong>${label}</strong> <em>(${term.ward_map} map)</em><br>
          <span class="near-panel-stats">${stats || "&nbsp;"}</span><br>${legend}</figcaption>
      </figure>`;
    }).join("");
    return `<div class="near-era-panels">${panels}</div>
      <p class="near-verdict-note">Per-year rates for the selected layers under each circle,
        colored to match. ⌂ marks your spot; ward colors are consistent across the panels.</p>`;
  }

  // ---- the matrix ------------------------------------------------------------------------
  function observedPerYear(payload, term) {
    const rows = (payload.events || {}).business_closed_observed || [];
    const from = term.from, to = term.to || term.from;
    const inTerm = rows.filter((r) => r[2] >= from && r[2] <= to);
    if (!inTerm.length) return null;
    const years = Math.max(1, to - from);
    return { per_year: inTerm.length / years, total: inTerm.length };
  }

  const closureKey = (r) =>
    `${String(r[3] || "").toLowerCase().replace(/[^a-z0-9]/g, "")}@${r[0].toFixed(3)},${r[1].toFixed(3)}`;

  // One closure count from both methods. The licence-rule total is authoritative (it comes from
  // the cell counts, not the capped event list); Google sightings are added only where they are
  // not the same business the rule already counted, matched on name and block.
  function closuresCombined(payload, term) {
    const metrics = (term.circle_metrics || {}).point_metrics || {};
    const ruleEntry = metrics.licenses_closed;
    const events = payload.events || {};
    const from = term.from, to = term.to || term.from;
    const within = (rows) => (rows || []).filter((r) => r[2] >= from && r[2] <= to);
    const ruleRows = within(events.business_closed);
    const seen = new Set(ruleRows.map(closureKey));
    const extra = within(events.business_closed_observed).filter((r) => !seen.has(closureKey(r)));
    const ruleTotal = ruleEntry ? ruleEntry.total : ruleRows.length;
    if (!ruleEntry && !ruleRows.length && !extra.length) return null;
    const years = Math.max(1, (ruleEntry && ruleEntry.covered_years.length) || (to - from) || 1);
    const total = ruleTotal + extra.length;
    return { per_year: total / years, total, rule: ruleTotal, added: extra.length, years };
  }

  function tableHtml(payload) {
    const terms = (payload.terms || []).slice().reverse();  // oldest -> newest, left to right
    if (!terms.length) return "";
    const header = terms.map((term) => {
      const roster = (term.wards || [])
        .map((w) => `W${Number(w.ward)} (${Math.round(w.share * 100)}%): ${memberNames(w)}`)
        .join("\n");
      return `<th title="${roster.replaceAll('"', "&quot;")}">${termLabel(term)}
        <small>${term.ward_map} map</small></th>`;
    }).join("");

    const rows = [];
    for (const spec of NEAR_METRICS) {
      const cells = terms.map((term) => {
        const circleMetrics = term.circle_metrics || {};
        if (spec.combinedClosures) {
          const entry = closuresCombined(payload, term);
          return entry ? { value: entry.per_year,
                           text: `${fmt(entry.per_year, spec)}<span class="near-unit">/yr</span>`,
                           title: `${entry.total} over ${entry.years} years — ${entry.rule} by the`
                             + ` licence rule, ${entry.added} more seen only on Google` } : null;
        }
        if (spec.observed) {
          const entry = observedPerYear(payload, term);
          return entry ? { value: entry.per_year,
                           text: `${fmt(entry.per_year, spec)}<span class="near-unit">/yr</span>`,
                           title: `${entry.total} total — Google-observed, incomplete by nature` } : null;
        }
        if (spec.family) {
          const entry = (circleMetrics.point_metrics || {})[spec.family];
          if (!entry) return null;
          const byWard = (term.wards || []).map((w) => {
            const e = (w.point_metrics || {})[spec.family];
            return e ? `W${Number(w.ward)}: ${fmt(e.per_year, spec)}/yr` : null;
          }).filter(Boolean).join(" · ");
          return { value: entry.per_year,
                   text: `${fmt(entry.per_year, spec)}<span class="near-unit">/yr</span>`,
                   title: `${fmt(entry.total, spec)} over ${entry.covered_years.length} covered years`
                     + (byWard ? ` — ${byWard}` : "") };
        }
        const entry = (circleMetrics.polygon_metrics || {})[spec.metric];
        if (!entry) return null;
        const blended = entry.confidence === "ward_smoothed" ? " (area blend)" : "";
        // A term is four years; showing only its final reading threw away the other three and
        // made adjacent terms look identical whenever they shared the newest Census vintage.
        // Average what the term actually saw, and say which years that was.
        const mean = entry.mean;
        if (mean && mean.years && mean.years.length > 1) {
          const span = `${mean.years[0]}–${String(mean.years[mean.years.length - 1]).slice(2)}`;
          return { value: mean.v,
                   text: `${fmt(mean.v, spec)}<span class="near-unit">${span}</span>`,
                   title: `mean of ${mean.years.join(", ")}${blended}`
                     + ` — ended at ${fmt(entry.last.v, spec)} in ${entry.last.year}` };
        }
        return { value: entry.last.v,
                 text: `${fmt(entry.last.v, spec)}<span class="near-unit">'${String(entry.last.year).slice(2)}</span>`,
                 title: `as of ${entry.last.year}${blended}` };
      });
      if (!cells.some(Boolean)) continue;
      const label = spec.label
        || (window.__nearFamilies && window.__nearFamilies[spec.family]) || spec.family;
      let bestIdx = -1, worstIdx = -1;
      if (spec.direction && cells.filter(Boolean).length >= 2) {
        let best = -Infinity, worst = Infinity;
        cells.forEach((cell, index) => {
          if (!cell) return;
          const v = cell.value * spec.direction;
          if (v > best) { best = v; bestIdx = index; }
          if (v < worst) { worst = v; worstIdx = index; }
        });
        if (bestIdx === worstIdx) { bestIdx = worstIdx = -1; }
      }
      const tds = cells.map((cell, index) => {
        if (!cell) return "<td class=\"near-na\">—</td>";
        const cls = index === bestIdx ? " class=\"near-best\""
          : index === worstIdx ? " class=\"near-worst\"" : "";
        return `<td${cls} title="${(cell.title || "").replaceAll('"', "&quot;")}">${cell.text}</td>`;
      }).join("");
      // the combined row charts the licence-rule series, the only one with a full history
      const key = spec.combinedClosures ? "licenses_closed" : (spec.family || spec.metric || "");
      const openable = key ? " near-row-openable" : "";
      const isOpen = key && key === chartKey ? " is-open" : "";
      rows.push(`<tr class="near-row${openable}${isOpen}"${key ? ` data-series="${key}"` : ""}>` +
        `<th title="${(spec.note || "").replaceAll('"', "&quot;")}">${label}</th>${tds}</tr>`);
    }
    return `<section class="near-table-section">
      <div class="near-table-scroll"><table class="near-matrix">
        <thead><tr><th></th>${header}</tr></thead><tbody>${rows.join("")}</tbody>
      </table></div>
      <p class="near-verdict-note"><span class="near-best-key">best</span> and
        <span class="near-worst-key">worst</span> term per measure (only measures with a clear
        good direction, covering 2+ terms). Values are per-year rates; level measures show their
        data year — two terms sharing the newest Census vintage show the same number because it
        IS the same measurement. Hover a cell for totals and the by-ward split, hover a term for
        who represented each slice. <strong>Click any measure</strong> to chart it year by year.</p>
    </section>`;
  }

  // ---- annual series chart: the year-by-year shape behind a term-averaged row --------------
  function chartHtml(payload) {
    if (!chartKey) return "";
    const series = (payload.series || {})[chartKey];
    const spec = NEAR_METRICS.find((m) => (m.family || m.metric) === chartKey);
    if (!series || !spec) return "";
    const label = spec.label
      || (window.__nearFamilies && window.__nearFamilies[spec.family]) || chartKey;
    const first = series.first;
    const points = series.values
      .map((value, index) => ({ year: first + index, value }))
      .filter((p) => p.value != null);
    if (points.length < 2) return "";
    const years = points.map((p) => p.year);
    const values = points.map((p) => p.value);
    const minYear = Math.min(...years), maxYear = Math.max(...years);
    const maxValue = Math.max(...values, 0);
    const minValue = Math.min(...values, 0);
    const W = 720, H = 210, L = 58, R = 12, T = 14, B = 30;
    const px = (year) => L + ((year - minYear) / Math.max(1, maxYear - minYear)) * (W - L - R);
    const py = (value) => T + (1 - (value - minValue) / Math.max(1e-9, maxValue - minValue)) * (H - T - B);
    const color = (LAYERS.find((l) => l.family === chartKey) || {}).color || "#155e75";

    // aldermanic term boundaries, labelled — the whole point of overlaying them on the series.
    // Terms run on a fixed four-year cadence, so a series reaching back past our rosters (licences
    // to 1995, sales to 1999) still gets its terms marked; only the who is missing.
    const known = (payload.terms || []).slice().reverse();
    const earliest = known.length ? known[0].from : 2007;
    const synthetic = [];
    for (let start = earliest - 4; start >= minYear - 3; start -= 4) {
      synthetic.unshift({ from: start, to: start + 4, wards: [] });
    }
    const terms = synthetic.concat(known);
    const bands = terms.map((term, index) => {
      const from = Math.max(term.from, minYear);
      const to = Math.min(term.to || term.from, maxYear);
      if (to < minYear || from > maxYear) return "";
      const x0 = px(from), x1 = px(to);
      const names = (term.wards || []).filter((w) => w.primary)
        .flatMap((w) => (w.members || []).map((m) => m.name)).filter(Boolean);
      const who = names.length ? names.join(" → ") : "";
      const shade = index % 2 ? '<rect x="' + x0.toFixed(1) + '" y="' + T + '" width="' +
        Math.max(0, x1 - x0).toFixed(1) + '" height="' + (H - T - B) + '" fill="#0f172a" fill-opacity="0.035"></rect>' : "";
      return shade +
        `<line x1="${x0.toFixed(1)}" y1="${T}" x2="${x0.toFixed(1)}" y2="${H - B}"
           stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3"></line>
         <text x="${(x0 + 3).toFixed(1)}" y="${T + 10}" font-size="9" fill="#64748b">
           ${termLabel(term)}<title>${who}</title></text>`;
    }).join("");

    const line = points.map((p, i) => `${i ? "L" : "M"}${px(p.year).toFixed(1)},${py(p.value).toFixed(1)}`).join(" ");
    const dots = points.map((p) =>
      `<circle cx="${px(p.year).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="2.6" fill="${color}">
         <title>${p.year}: ${fmt(p.value, spec)}</title></circle>`).join("");
    const ticks = [minValue, (minValue + maxValue) / 2, maxValue].map((v) =>
      `<text x="${L - 6}" y="${(py(v) + 3).toFixed(1)}" font-size="9" fill="#64748b"
         text-anchor="end">${fmt(v, spec)}</text>
       <line x1="${L}" y1="${py(v).toFixed(1)}" x2="${W - R}" y2="${py(v).toFixed(1)}"
         stroke="#e2e8f0" stroke-width="1"></line>`).join("");
    const xLabels = [minYear, maxYear].map((year) =>
      `<text x="${px(year).toFixed(1)}" y="${H - B + 16}" font-size="9" fill="#64748b"
         text-anchor="${year === minYear ? "start" : "end"}">${year}</text>`).join("");

    return `<section class="near-chart">
      <div class="near-chart-head">
        <h3>${label} — year by year</h3>
        <button type="button" class="near-chart-close" aria-label="Close chart">close</button>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="near-chart-svg" role="img"
        aria-label="${label} by year with aldermanic terms marked">
        ${ticks}${bands}
        <path d="${line}" fill="none" stroke="${color}" stroke-width="2"
          stroke-linejoin="round"></path>${dots}${xLabels}
      </svg>
      <p class="near-verdict-note">Every year the source covers, for this circle. Dashed lines mark
        aldermanic term changes (hover a term label for who held the seat); an in-progress final
        year is left out. ${spec.note || ""}</p>
    </section>`;
  }

  // ---- detail explorer: one closures list, methodology in footnotes, and a real map --------
  function detailHtml(payload) {
    const terms = payload.terms || [];
    const events = payload.events || {};
    if (!terms.length || !Object.keys(events).length) return "";
    const inTerm = (kind, term) => (events[kind] || [])
      .filter((r) => validRow(r) && r[2] >= term.from && r[2] <= (term.to || term.from));
    const withData = terms.filter((term) =>
      ["business_open", "business_closed", "business_closed_observed", "menu_money", "rezoning"]
        .some((kind) => inTerm(kind, term).length));
    if (!withData.length) return "";
    if (!detailTerm || !withData.some((t) => t.term === detailTerm)) {
      detailTerm = withData[0].term;  // terms arrive newest-first; default to the newest
    }
    const chips = withData.map((term) =>
      `<button type="button" class="near-detail-chip${term.term === detailTerm ? " is-active" : ""}"
        data-term="${term.term}">${termLabel(term)}</button>`).join("");
    const active = withData.find((t) => t.term === detailTerm);

    const opened = inTerm("business_open", active);
    const closed = [
      ...inTerm("business_closed", active).map((r) => ({ r, marker: "*" })),
      ...inTerm("business_closed_observed", active).map((r) => ({ r, marker: "†" })),
    ].sort((a, b) => b.r[2] - a.r[2]);
    const menu = inTerm("menu_money", active).sort((a, b) => b[2] - a[2] || (b[4] || 0) - (a[4] || 0));
    const rezonings = inTerm("rezoning", active).sort((a, b) => b[2] - a[2]);
    const hasRezonings = terms.some((term) => inTerm("rezoning", term).length);
    if (!hasRezonings && detailFocus === "rezoning") detailFocus = "all";

    const rezoningItem = (r) => {
      const sqft = fmtSqft(r[4]);
      return `<li><span class="near-detail-year">${r[2]}</span> ${emojiFor(r[5], "rezoning")} ${escHtml(r[3])}` +
        `${sqft ? ` <em>${sqft}</em>` : ""}` +
        ` <span class="near-detail-cat">${rezoningStyle(r[5]).label}</span></li>`;
    };
    const item = (r, marker, kind) => kind === "rezoning" ? rezoningItem(r) :
      `<li><span class="near-detail-year">${r[2]}</span> ${emojiFor(r[5], kind)} ${r[3]}` +
      `${marker ? `<sup>${marker}</sup>` : ""}` +
      `${r[4] != null ? ` <em>${fmt(r[4], { dollars: true })}</em>` : ""}` +
      `${r[5] ? ` <span class="near-detail-cat">${r[5]}</span>` : ""}</li>`;
    const list = (title, color, entries, cap, kind) => {
      if (!entries.length) return "";
      const items = entries.slice(0, cap).map((e) => e.marker !== undefined
        ? item(e.r, e.marker, kind) : item(e, null, kind)).join("");
      const more = entries.length > cap ? `<li class="near-detail-more">…and ${entries.length - cap} more</li>` : "";
      return `<div class="near-detail-col" style="--chip:${color}">
        <h3>${title} <em>${entries.length}</em></h3><ul>${items}${more}</ul></div>`;
    };

    const FOCUSES = [["all", "Everything"], ["business_open", "New businesses"],
                     ["business_closed", "Closures"], ["menu_money", "Menu-money projects"],
                     ...(hasRezonings ? [["rezoning", "Rezonings"]] : [])];
    const focusChips = FOCUSES.map(([key, label]) =>
      `<button type="button" class="near-detail-chip near-focus-chip${detailFocus === key ? " is-active" : ""}"
        data-focus="${key}">${label}</button>`).join("");

    return `<section class="near-detail">
      <h2>In detail</h2>
      <div class="near-detail-chips">${chips}</div>
      <div class="near-detail-chips near-detail-focus">${focusChips}</div>
      <div id="near-detail-map" class="near-detail-map"></div>
      <div class="near-detail-cols">
        ${list("New businesses", "#15803d", opened, 250)}
        ${list("Closures", "#b91c1c", closed, 250)}
        ${list("Menu-money projects", "#7c2d92", menu, 250, "menu_money")}
        ${list("Rezonings", "#0f766e", rezonings, 250, "rezoning")}
      </div>
      <p class="near-verdict-note"><sup>*</sup> licence-rule closure: the last licence expired
        with no later transaction, lagged two years so late renewals don't read as deaths.
        <sup>†</sup> Google-observed: a matched business whose listing is marked permanently
        closed — covers recent years the licence rule can't see yet, incomplete by nature.
        Map markers: green opened, red closed, purple menu projects${hasRezonings
          ? "; rezonings 🏗️ up (orange), 🏡 down (blue), 📐 lateral (grey), ❔ FAR change unknown (light grey), passed ordinances only" : ""}.</p>
    </section>`;
  }

  function renderDetailMap(payload) {
    const container = document.getElementById("near-detail-map");
    if (!container || !lastPayload) return;
    const terms = payload.terms || [];
    const active = terms.find((t) => t.term === detailTerm) || terms[0];
    if (!active) return;
    if (!detailMap) {
      detailMap = L.map(container, { scrollWheelZoom: false });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2jye_1_91a0198a0781fa7a84176b2a", {
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO", maxZoom: 19,
      }).addTo(detailMap);
    }
    if (detailMarkers) detailMap.removeLayer(detailMarkers);
    const events = payload.events || {};
    const inTerm = (kind) => (events[kind] || [])
      .filter((r) => validRow(r) && r[2] >= active.from && r[2] <= (active.to || active.from));
    // tooltip: what it is first, then when/how much, then where — a menu row used to show only
    // its location string, which read as an address with no explanation attached
    const marker = (r, color, kindLabel, kind) => {
      const [, , year, text, amount, category] = r;
      const head = amount != null
        ? `<strong>${kindLabel}</strong> · ${fmt(amount, { dollars: true })}`
        : `<strong>${text || kindLabel}</strong>`;
      const bits = [`${year}`];
      if (category) bits.push(category);
      const where = amount != null && text ? `<br><span class="near-tip-where">${text}</span>` : "";
      return L.marker([r[0], r[1]], {
        icon: L.divIcon({ className: "near-emoji-pin", iconSize: [22, 22],
          html: `<span style="--pin:${color}">${emojiFor(category, kind)}</span>` }),
      }).bindTooltip(`${head}<br>${bits.join(" · ")}${where}`);
    };
    const rezoningMarker = (r) => {
      const [, , year, text, sqftDelta, category] = r;
      const style = rezoningStyle(category);
      const bits = [`${year}`, style.label];
      const sqft = fmtSqft(sqftDelta);
      if (sqft) bits.push(sqft);
      return L.marker([r[0], r[1]], {
        icon: L.divIcon({ className: "near-emoji-pin", iconSize: [22, 22],
          html: `<span style="--pin:${style.color}">${style.emoji}</span>` }),
      }).bindTooltip(`<strong>${escHtml(text) || "Rezoning"}</strong><br>${bits.join(" · ")}`);
    };
    const show = (kind) => detailFocus === "all" || detailFocus === kind
      || (detailFocus === "business_closed" && kind === "business_closed_observed");
    const groups = [];
    if (show("business_open"))
      groups.push(...inTerm("business_open").map((r) => marker(r, "#15803d", "Opened", "business")));
    if (show("business_closed"))
      groups.push(...inTerm("business_closed").map((r) => marker(r, "#b91c1c", "Closed (licence rule)", "business")));
    if (show("business_closed_observed"))
      groups.push(...inTerm("business_closed_observed").map((r) => marker(r, "#7f1d1d", "Closed (seen on Google)", "business")));
    if (show("menu_money"))
      groups.push(...inTerm("menu_money").map((r) => marker(r, "#7c2d92", "Menu-money project", "menu_money")));
    if (show("rezoning"))
      groups.push(...inTerm("rezoning").map(rezoningMarker));
    detailMarkers = L.layerGroup(groups).addTo(detailMap);
    const point = payload.point || {};
    if (Number.isFinite(point.lat)) {
      // the analysis circle IS the frame: show its whole perimeter, not a zoomed-in slice.
      // Bounds computed arithmetically — circle.getBounds() needs a map view to exist first.
      const dLat = radiusM / 111320;
      const dLng = radiusM / (111320 * Math.cos(point.lat * Math.PI / 180));
      detailMap.fitBounds([[point.lat - dLat, point.lng - dLng],
                           [point.lat + dLat, point.lng + dLng]], { padding: [10, 10] });
      detailMarkers.addLayer(L.circle([point.lat, point.lng], { radius: radiusM,
        color: "#2b6cb0", weight: 2, dashArray: "6 4", fill: false, interactive: false }));
    }
    setTimeout(() => detailMap.invalidateSize(), 60);
  }

  function render(payload) {
    if (!payload.inside_chicago) {
      resultsEl.hidden = true;
      showPicker(true, "That point is outside Chicago — drop the pin inside the city.");
      return;
    }
    statusEl.textContent = "";
    resultsEl.hidden = false;
    if (chooseEl) chooseEl.hidden = true;
    showPicker(false);
    if (payload.families) {
      window.__nearFamilies = Object.fromEntries(
        Object.entries(payload.families).map(([key, meta]) => [key, meta.label || key]));
    }
    renderLayerChips(payload);

    const areaBits = [];
    if (payload.areas.community_area && payload.areas.community_area.name)
      areaBits.push(`<strong>${payload.areas.community_area.name}</strong>`);
    const point = payload.point || {};
    if (Number.isFinite(point.lat)) {
      areaBits.push(`${point.lat.toFixed(3)}, ${point.lng.toFixed(3)} · ${(point.radius_m / 1000).toFixed(1)} km circle`);
    }
    areasEl.innerHTML = areaBits.join(" · ");

    stripEl.innerHTML = termStripHtml(payload);
    termsEl.innerHTML = tableHtml(payload) + chartHtml(payload) + detailHtml(payload);
    termsEl.querySelectorAll(".near-detail-chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        detailTerm = chip.dataset.term;
        if (lastPayload) render(lastPayload);
      }));
    termsEl.querySelectorAll("tr[data-series]").forEach((row) =>
      row.addEventListener("click", () => {
        const key = row.dataset.series;
        chartKey = chartKey === key ? null : key;
        if (chartKey && window.WardWiseExplorer && WardWiseExplorer.track) {
          WardWiseExplorer.track("near_metric_open", { metric: chartKey, radius: radiusM });
          if (window.WardWiseAnalytics) window.WardWiseAnalytics.measureOpened(chartKey, null);
        }
        if (lastPayload) render(lastPayload);
        const chart = termsEl.querySelector(".near-chart");
        if (chart) chart.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }));
    termsEl.querySelectorAll(".near-focus-chip").forEach((chip) =>
      chip.addEventListener("click", () => {
        detailFocus = chip.dataset.focus;
        if (lastPayload) render(lastPayload);
      }));
    const closeChart = termsEl.querySelector(".near-chart-close");
    if (closeChart) closeChart.addEventListener("click", (event) => {
      event.stopPropagation();
      chartKey = null;
      if (lastPayload) render(lastPayload);
    });
    if (detailMap) { detailMap.remove(); detailMap = null; detailMarkers = null; }
    renderDetailMap(payload);
    if (window.WardWiseExplorer && WardWiseExplorer.track) {
      WardWiseExplorer.track("near_view", { terms: (payload.terms || []).length, radius: radiusM });
    }
  }

  async function goToAddress(value) {
    const query = String(value || "").trim();
    if (query.length < 3) return;
    try {
      const response = await fetch(`/api/near/geocode?q=${encodeURIComponent(query)}`);
      const payload = await response.json();
      if (payload.found) {
        if (chooseEl) chooseEl.hidden = true;
        setPoint(payload.lat, payload.lng);
      } else {
        if (window.WardWiseAnalytics) window.WardWiseAnalytics.track("lookup_failed", { how: "address" });
        showPicker(true, "Couldn't place that — try '2045 N Damen Ave' or 'Damen & North', or click the map.");
      }
    } catch (error) {
      showPicker(true, "Address lookup failed — pick a spot on the map instead.");
    }
  }
  const addressForm = document.getElementById("near-address-form");
  if (addressForm) addressForm.addEventListener("submit", (event) => {
    event.preventDefault();
    goToAddress(document.getElementById("near-address").value);
  });
  const addressBar = document.getElementById("near-address-form-bar");
  if (addressBar) addressBar.addEventListener("submit", (event) => {
    event.preventDefault();
    goToAddress(document.getElementById("near-address-bar").value);
  });

  const methodologyButton = document.getElementById("near-methodology-open");
  const methodologyDialog = document.getElementById("near-methodology");
  if (methodologyButton && methodologyDialog)
    methodologyButton.addEventListener("click", () => methodologyDialog.showModal());

  map.on("click", (event) => setPoint(event.latlng.lat, event.latlng.lng));
  document.querySelectorAll("#near-locate, #near-locate-map")
    .forEach((button) => button.addEventListener("click", locateMe));
  const showMapButton = document.getElementById("near-show-map");
  if (showMapButton) showMapButton.addEventListener("click", () => showPicker(true));
  document.getElementById("near-change").addEventListener("click", () => {
    resultsEl.hidden = true;
    showChooser();
  });
  if (radiusEl) radiusEl.addEventListener("change", () => {
    radiusM = Number(radiusEl.value) || 1000;
    if (pin) {
      const at = pin.getLatLng();
      setPoint(at.lat, at.lng);
    }
  });

  // shareable hash: /near#lat=..&lng=..&r=..
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const hashLat = parseFloat(params.get("lat"));
  const hashLng = parseFloat(params.get("lng"));
  const hashR = parseInt(params.get("r"), 10);
  if ([500, 1000, 1500, 2000].includes(hashR)) {
    radiusM = hashR;
    if (radiusEl) radiusEl.value = String(hashR);
  }
  if (Number.isFinite(hashLat) && Number.isFinite(hashLng)) {
    setPoint(hashLat, hashLng, { push: false });
  }
})();
