// WardWiseFrontDoor: the home page, the ward report card, the planner and business pages, and ward alerts.
// (Connor Florczyk's redesign, ported from cflorczyk9/ward-wise-redesign; the Guild pages stayed behind.)
// Each block looks for its own root element and does nothing when the page lacks it,
// so one script serves every proposal page.
(function () {
  const api = window.WardWiseExplorer;
  const esc = (value) => api.escapeHtml(value);
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Every API read goes through fetchJson. Keep each answer for ten minutes in this tab, so a
  // page you already saw (or one we prefetched) paints at once instead of waiting a second on
  // the live API. Failures are never cached.
  const memo = new Map();
  const rawFetchJson = api.fetchJson.bind(api);
  api.fetchJson = (url, message) => {
    if (memo.has(url)) return memo.get(url);
    const key = `fd:${url}`;
    try {
      const hit = JSON.parse(sessionStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.t < 600000) {
        const cached = Promise.resolve(hit.v);
        memo.set(url, cached);
        return cached;
      }
    } catch (_error) {
      /* storage unavailable: fall through to the network */
    }
    const request = rawFetchJson(url, message).then((value) => {
      try {
        const packed = JSON.stringify({ t: Date.now(), v: value });
        if (packed.length < 1500000) sessionStorage.setItem(key, packed);
      } catch (_error) {
        /* over quota: the in-memory copy still helps */
      }
      return value;
    });
    request.catch(() => memo.delete(url));
    memo.set(url, request);
    return request;
  };

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));

  // Placeholders that hold the exact space the content will take.
  const skel = (cls = "", style = "") => `<span class="fd-skel ${cls}"${style ? ` style="${style}"` : ""}></span>`;
  function skelRows(count) {
    return Array.from({ length: count }, (_, i) => `
      <div class="fd-row is-skel" aria-hidden="true">
        <div class="fd-skel-stack">${skel("fd-skel-line is-lg", `width: ${55 + (i * 17) % 30}%`)}${skel("fd-skel-line", "width: 70%")}</div>
        <div>${skel("fd-skel-line is-lg", "width: 60%")}</div>
        <div class="fd-skel-stack">${skel("fd-skel-line", "width: 50%")}${skel("fd-skel-line", "width: 80%")}</div>
        <div>${skel("fd-skel-line", "width: 100%; height: 6px")}</div>
      </div>`).join("");
  }
  function skelFeed(count) {
    return `<ul class="fd-feed" aria-hidden="true">${Array.from({ length: count }, (_, i) => `
      <li class="is-skel">${skel("fd-skel-line", "width: 70%")}<div class="fd-skel-stack">${skel("fd-skel-line is-lg", `width: ${70 + (i * 13) % 25}%`)}${skel("fd-skel-line", "width: 45%")}</div></li>`).join("")}</ul>`;
  }
  function skelBlock(lines) {
    return `<div class="fd-skel-stack" aria-hidden="true">${lines.map(([cls, width]) => skel(`fd-skel-line ${cls}`, `width: ${width}`)).join("")}</div>`;
  }

  // What a visitor sees when data doesn't arrive. Browsers report a dropped connection as
  // "Failed to fetch" (or "Load failed" in Safari), which means nothing to anyone.
  function friendly(error) {
    const message = (error && error.message) || "";
    return !message || /failed to fetch|load failed|networkerror|network error/i.test(message)
      ? "The data service didn't respond. It's usually back within a minute."
      : message;
  }

  function failNotice(error) {
    return `<div class="fd-fail" role="status">
        <p class="fd-fail-title">This couldn't load right now.</p>
        <p class="fd-small">${esc(friendly(error))}</p>
        <button type="button" class="fd-link-btn" data-fd-retry>Try again</button>
      </div>`;
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-fd-retry]")) window.location.reload();
  });

  // Swap in new content with a short staggered rise.
  function swapIn(node, html) {
    node.innerHTML = html;
    node.classList.remove("fd-swap");
    void node.offsetWidth;
    node.classList.add("fd-swap");
  }

  // Dots render at the left edge and glide to their place on the next frame.
  function settleDots(scope) {
    const dots = [...scope.querySelectorAll(".fd-dot[data-left]")];
    if (!dots.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      dots.forEach((dot, i) => {
        dot.style.transitionDelay = REDUCED ? "0ms" : `${Math.min(i, 8) * 45 + 150}ms`;
        dot.style.left = `${dot.dataset.left}%`;
      });
    }));
  }

  function countUp(el, to, format, duration = 900) {
    if (REDUCED || !Number.isFinite(to)) {
      el.textContent = format(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el.textContent = format(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = format(to);
    };
    requestAnimationFrame(step);
  }

  // Each set is populated for every area at its geography. The resident card is chosen
  // for things a voter can hold an alderperson to (permit processing covers 47 of 50 wards
  // and shows "No data" elsewhere). The snapshot uses community areas because that is how
  // owners name where they are, and it skips business openings and closures, which only
  // exist by ward.
  const SETS = {
    residents: {
      areaType: "ward",
      framing: "ranked",
      metrics: [
        "c311_pothole_days",
        "c311_response_days",
        "violent_crime_rate_per_10000",
        "park_acres_per_10000_residents",
        "new_residential_units_permitted_est",
        "building_permit_processing_days",
        "school_proficiency_pct",
        "median_household_income",
        "nonroutine_bills_sponsored_current_session",
        "menu_streets_share",
      ],
    },
    preview: {
      areaType: "ward",
      framing: "ranked",
      metrics: [
        "c311_pothole_days",
        "violent_crime_rate_per_10000",
        "park_acres_per_10000_residents",
        "median_household_income",
      ],
    },
    snapshot: {
      areaType: "community_area",
      framing: "neutral",
      metrics: [
        "median_household_income",
        "observed_asking_rent_usd",
        "licensed_food_businesses_per_10000_residents",
        "licensed_coffee_shops_per_10000_residents",
        "licensed_grocery_stores_per_10000_residents",
        "licensed_chain_restaurant_share_pct",
        "public_transit_pct",
        "active_transportation_pct",
        "violent_crime_rate_per_10000",
      ],
    },
    // Same layout as the snapshot, with rows split into sections ([data-fd-rows="<key>"]).
    // Its metrics are the sections' metrics, in order.
    financing: {
      areaType: "community_area",
      framing: "neutral",
      sections: {
        demographics: [
          "median_household_income",
          "poverty_pct",
          "observed_asking_rent_usd",
          "public_transit_pct",
        ],
        business: [
          "total_establishments_per_10000_residents",
          "bank_branches_per_10000_residents",
          "sbif_grants_count",
          "sbif_grant_dollars",
          "zoned_business_commercial_pct",
          "vacant_building_complaints_per_10000_residents",
          "property_crime_rate_per_10000",
        ],
      },
    },
  };
  Object.values(SETS).forEach((set) => {
    if (set.sections && !set.metrics) set.metrics = Object.values(set.sections).flat();
  });

  // Plain names for the rows. The API labels carry their source in parentheses, which the
  // source line under each name already covers.
  const SHORT_LABELS = {
    c311_pothole_days: "Pothole repair time",
    c311_response_days: "311 response time",
    violent_crime_rate_per_10000: "Violent crime",
    park_acres_per_10000_residents: "Park space",
    new_residential_units_permitted_est: "New homes permitted",
    building_permit_processing_days: "Permit processing time",
    school_proficiency_pct: "School proficiency",
    median_household_income: "Median household income",
    nonroutine_bills_sponsored_current_session: "Bills sponsored",
    menu_streets_share: "Menu money on resurfacing",
    observed_asking_rent_usd: "Asking rent",
    licensed_food_businesses_per_10000_residents: "Food businesses",
    licensed_coffee_shops_per_10000_residents: "Coffee shops",
    licensed_grocery_stores_per_10000_residents: "Grocery stores",
    licensed_chain_restaurant_share_pct: "Chain restaurant share",
    public_transit_pct: "Commute by transit",
    active_transportation_pct: "Walk or bike to work",
    modeled_fear_walking_pct: "Walking at night (est.)",
    chain_restaurant_share_pct: "Chain restaurants",
    poverty_pct: "Poverty rate",
    total_establishments_per_10000_residents: "Employer businesses",
    bank_branches_per_10000_residents: "Bank branches",
    sbif_grants_count: "Small business grants",
    sbif_grant_dollars: "Small business grant dollars",
    zoned_business_commercial_pct: "Land zoned for business",
    vacant_building_complaints_per_10000_residents: "Vacant building complaints",
    property_crime_rate_per_10000: "Property crime",
  };

  const UNIT_SUFFIX = {
    days: " days",
    "per 10k residents": " per 10k",
    acres_per_10000: " acres per 10k",
    units: " homes",
  };

  function formatValue(value, metric) {
    if (value === null || value === undefined) return "No data";
    const suffix = UNIT_SUFFIX[metric?.unit];
    if (suffix) {
      const unit = Number(value) === 1 ? suffix.replace(/s$/, "") : suffix;
      return `${api.formatNumber(value, { maximumFractionDigits: 1 })}${unit}`;
    }
    return api.formatMetricValue(value, metric);
  }

  function ordinal(n) {
    const tail = n % 100;
    if (tail >= 11 && tail <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Where one area sits among all areas for one metric. `rank` is 1 = best, using the
  // metric's direction. `share` is the fraction of areas with a lower raw value, for the
  // business snapshot, where "better" depends on who is reading (high rent is good news
  // for a landlord and bad news for a tenant).
  function standing(rows, metric, areaId) {
    const present = rows
      .map((row) => ({ id: row.area_id, value: row.values[metric.metric_id] }))
      .filter((entry) => entry.value !== null && entry.value !== undefined);
    const mine = present.find((entry) => entry.id === areaId);
    if (!mine) return null;
    const better = metric.direction === "lower"
      ? present.filter((entry) => entry.value < mine.value).length
      : present.filter((entry) => entry.value > mine.value).length;
    const below = present.filter((entry) => entry.value < mine.value).length;
    const tied = present.filter((entry) => entry.value === mine.value).length - 1;
    const rank = better + 1;
    return {
      value: mine.value,
      rank,
      of: present.length,
      position: present.length > 1 ? (rank - 1) / (present.length - 1) : 0.5,
      share: present.length > 1 ? below / (present.length - 1) : 0.5,
      tied,
      above: present.length - 1 - below - tied,
      median: median(present.map((entry) => entry.value)),
    };
  }

  function higherThan(spot) {
    // Many areas can share a floor value (no grants this year), so a tie isn't "the lowest".
    const top = spot.tied && spot.above === 0;
    if (spot.share <= 0 && spot.tied) return top ? "Same as all" : "Tied for lowest";
    if (top) return "Tied for highest";
    if (spot.share >= 1) return "The highest";
    if (spot.share <= 0) return "The lowest";
    return `Higher than ${Math.round(spot.share * 100)}%`;
  }

  function band(spot) {
    if (spot.position < 1 / 3) return { key: "good", label: "Top third" };
    if (spot.position > 2 / 3) return { key: "weak", label: "Bottom third" };
    return { key: "mid", label: "Middle third" };
  }

  function metricRow(metric, spot, framing, areaNoun) {
    const name = SHORT_LABELS[metric.metric_id] || metric.label;
    const nameCell = `
      <div class="fd-row-name">
        <a href="/dictionary#metric=${encodeURIComponent(metric.metric_id)}">${esc(name)}</a>
        <small title="${esc(metric.source)}">${esc(metric.source)}</small>
      </div>`;
    if (!spot) {
      return `<div class="fd-row">${nameCell}<div class="fd-row-value">No data</div><div class="fd-row-rank"><small>Not measured here yet</small></div><div class="fd-row-bar"></div></div>`;
    }
    const medianLine = `Median ${esc(formatValue(spot.median, metric))}`;
    if (framing === "ranked") {
      const b = band(spot);
      return `
        <div class="fd-row">
          ${nameCell}
          <div class="fd-row-value">${esc(formatValue(spot.value, metric))}</div>
          <div class="fd-row-rank">
            <span class="fd-band-${b.key}">${b.label}</span>
            <small>${ordinal(spot.rank)} of ${spot.of} ${areaNoun}. ${medianLine}</small>
          </div>
          <div class="fd-row-bar">
            <div class="fd-track"><span class="fd-dot fd-dot-${b.key}" data-left="${(spot.position * 100).toFixed(1)}" style="left: 0%"></span></div>
            <div class="fd-track-ends" aria-hidden="true"><span>Best</span><span>Median</span><span>Worst</span></div>
          </div>
        </div>`;
    }
    return `
      <div class="fd-row">
        ${nameCell}
        <div class="fd-row-value">${esc(formatValue(spot.value, metric))}</div>
        <div class="fd-row-rank">
          <span class="fd-band-mid">${higherThan(spot)}</span>
          <small>of ${spot.of} ${areaNoun}. ${medianLine}</small>
        </div>
        <div class="fd-row-bar">
          <div class="fd-track"><span class="fd-dot" data-left="${(spot.share * 100).toFixed(1)}" style="left: 0%"></span></div>
          <div class="fd-track-ends" aria-hidden="true"><span>Lowest</span><span>Median</span><span>Highest</span></div>
        </div>
      </div>`;
  }

  // The dictionary's own words for each measure, for pages that print an appendix.
  function appendixEntry(metric) {
    const name = SHORT_LABELS[metric.metric_id] || metric.label;
    const source = metric.source_url
      ? `<a href="${esc(metric.source_url)}" target="_blank" rel="noopener">${esc(metric.source)}</a>`
      : esc(metric.source || "");
    // Name on the left, the explanation on the right, like a glossary.
    return `
      <div class="fd-appendix-entry">
        <h4><a href="/dictionary#metric-entry-${esc(metric.metric_id)}">${esc(name)}</a></h4>
        <div class="fd-appendix-body">
          ${metric.methodology ? `<p><span>How to read it.</span> ${esc(metric.methodology)}</p>` : ""}
          ${metric.calculation && metric.calculation !== metric.methodology ? `<p><span>How it's calculated.</span> ${esc(metric.calculation)}</p>` : ""}
          ${source ? `<p class="fd-appendix-source">Source: ${source}</p>` : ""}
        </div>
      </div>`;
  }

  // Sectioned sets list their notes under the same headings as their tables.
  function appendixGroups(set, metrics, root) {
    if (!set.sections) return metrics.map(appendixEntry).join("");
    return Object.entries(set.sections).map(([key, ids]) => {
      const title = root.querySelector(`[data-fd-rows="${key}"]`)?.closest("section")?.querySelector("h2")?.textContent;
      const entries = metrics.filter((metric) => ids.includes(metric.metric_id)).map(appendixEntry).join("");
      return entries ? `<div class="fd-appendix-group">${title ? `<h3>${esc(title)}</h3>` : ""}${entries}</div>` : "";
    }).join("");
  }

  function readHash(key) {
    return new URLSearchParams(window.location.hash.slice(1)).get(key);
  }

  function writeHash(key, value) {
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set(key, value);
    history.replaceState(null, "", `#${params.toString()}`);
  }


  // --- Report cards (resident card, home preview, business snapshot) ---------------

  function clearHash() {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  // Wards come from the header's "your ward" choice (my_ward.js). A #ward= link shows that
  // ward without changing the visitor's own, with an offer to adopt it. Neighborhoods aren't
  // wards, so the business snapshot keeps its own picker, starting from the visitor's ward.
  async function initReport(root) {
    const set = SETS[root.dataset.fdReport];
    const isWard = set.areaType === "ward";
    const my = window.WardWiseMyWard;
    const picker = root.querySelector("[data-fd-picker]");
    const rowsEl = root.querySelector("[data-fd-rows]");
    // A sectioned set fills each [data-fd-rows="<key>"] with its own metrics.
    const slots = [...root.querySelectorAll("[data-fd-rows]")];
    const idsFor = (slot) => set.sections?.[slot.dataset.fdRows] || set.metrics;
    const appendixEl = root.querySelector("[data-fd-appendix]");
    const titleEl = root.querySelector("[data-fd-title]");
    const eyebrowEl = root.querySelector("[data-fd-eyebrow]");
    const metaEl = root.querySelector("[data-fd-meta]");
    const summaryEl = root.querySelector("[data-fd-summary]");
    const viewingEl = root.querySelector("[data-fd-viewing]");
    const emptyEl = root.querySelector("[data-fd-empty]");
    const bodyEl = root.querySelector("[data-fd-body]");
    const mapSlot = root.querySelector("[data-fd-minimap]");
    const hashKey = root.dataset.fdHash;
    const areaNoun = isWard ? "wards" : "neighborhoods";
    const hashWard = () => (isWard && hashKey ? readHash(hashKey) : null);
    let current = null;
    let map = null;

    const early = isWard ? hashWard() || (my && my.get()) : null;
    if (isWard && !early) {
      showEmpty(true);
    } else {
      slots.forEach((slot) => { slot.innerHTML = skelRows(idsFor(slot).length || 1); });
      if (mapSlot) mapSlot.innerHTML = `<div class="fd-skel fd-map-skel" aria-hidden="true"></div>`;
      if (titleEl && early) titleEl.textContent = `Ward ${Number(early)}`;
      if (summaryEl && set.framing === "ranked") {
        summaryEl.innerHTML = [0, 1, 2].map(() => `<div>${skel("fd-skel-line is-xl", "width: 48px")}${skel("fd-skel-line", "width: 90px; margin-top: 8px")}</div>`).join("");
      }
      if (metaEl) metaEl.innerHTML = skel("fd-skel-line", "width: 320px; max-width: 100%");
    }

    function showEmpty(on) {
      if (!emptyEl) return;
      emptyEl.hidden = !on;
      if (bodyEl) bodyEl.hidden = on;
      if (on && my) my.mountInline(emptyEl.querySelector("[data-fd-empty-picker]"));
    }

    let data;
    try {
      data = await api.fetchComparison(set.metrics, set.areaType);
    } catch (error) {
      rowsEl.innerHTML = failNotice(error);
      [...slots.slice(1), appendixEl, mapSlot, summaryEl, metaEl].forEach((node) => { if (node) node.innerHTML = ""; });
      // The contact card and City Clerk feeds have their own sources, so they can still show.
      if (early) document.dispatchEvent(new CustomEvent("fd:area", { detail: { areaType: set.areaType, areaId: early } }));
      return;
    }
    const metrics = set.metrics
      .map((id) => data.metrics.find((metric) => metric.metric_id === id))
      .filter(Boolean);
    if (appendixEl) appendixEl.innerHTML = appendixGroups(set, metrics, root);
    root.querySelectorAll("[data-fd-count]").forEach((el) => {
      const n = (set.sections?.[el.dataset.fdCount] || []).filter((id) => metrics.some((m) => m.metric_id === id)).length;
      el.textContent = n ? `${n} measure${n === 1 ? "" : "s"}` : "";
    });
    const areas = [...data.rows].sort((a, b) => (isWard
      ? Number(a.area_id) - Number(b.area_id)
      : a.display_name.localeCompare(b.display_name)));

    function renderViewing() {
      if (!isWard) return;
      const mine = my && my.get();
      if (eyebrowEl) eyebrowEl.textContent = current && current === mine ? "Your ward" : "Viewing";
      if (!viewingEl) return;
      if (!current || current === mine) {
        viewingEl.hidden = true;
        return;
      }
      viewingEl.hidden = false;
      viewingEl.innerHTML = `<button type="button" class="fd-chip-btn" data-fd-adopt>Make Ward ${Number(current)} your ward</button>${mine ? `<button type="button" class="fd-chip-btn is-quiet" data-fd-mine>Back to Ward ${Number(mine)}</button>` : ""}`;
    }

    async function render(areaId) {
      current = areaId;
      showEmpty(false);
      if (hashKey) {
        if (isWard && my && areaId === my.get()) clearHash();
        else writeHash(hashKey, areaId);
      }
      if (picker && picker.value !== areaId) picker.value = areaId;
      if (map) map.select(areaId);
      renderViewing();
      document.dispatchEvent(new CustomEvent("fd:area", { detail: { areaType: set.areaType, areaId } }));
      const area = areas.find((row) => row.area_id === areaId);
      const spots = metrics.map((metric) => standing(data.rows, metric, areaId));
      slots.forEach((slot) => {
        const ids = idsFor(slot);
        const rows = metrics
          .map((metric, i) => (ids.includes(metric.metric_id) ? metricRow(metric, spots[i], set.framing, areaNoun) : ""))
          .join("");
        slot.innerHTML = rows || `<p class="fd-small">No measures in this section yet.</p>`;
        settleDots(slot);
      });
      if (titleEl) titleEl.textContent = area ? area.display_name : "";
      root.querySelectorAll("[data-fd-link]").forEach((link) => {
        link.href = link.dataset.fdLink.replace("{id}", areaId);
      });

      if (summaryEl && set.framing === "ranked") {
        const measured = spots.filter(Boolean);
        const top = measured.filter((spot) => band(spot).key === "good").length;
        const bottom = measured.filter((spot) => band(spot).key === "weak").length;
        summaryEl.innerHTML = `
          <div><strong class="fd-band-good" data-n="${top}">0</strong><span>in the top third</span></div>
          <div><strong class="fd-band-weak" data-n="${bottom}">0</strong><span>in the bottom third</span></div>
          <div><strong data-n="${measured.length}">0</strong><span>measures</span></div>`;
        summaryEl.querySelectorAll("[data-n]").forEach((el) => countUp(el, Number(el.dataset.n), (v) => String(Math.round(v)), 600));
      }

      if (metaEl && isWard) {
        metaEl.innerHTML = skel("fd-skel-line", "width: 320px; max-width: 100%");
        try {
          const details = await api.fetchWardDetails(areaId);
          if (current !== areaId) return;
          const alder = details.alderperson || {};
          const places = (details.ward?.community_area_overlaps || []).slice(0, 3).map((a) => a.name).join(", ");
          metaEl.classList.remove("fd-in");
          void metaEl.offsetWidth;
          metaEl.classList.add("fd-in");
          metaEl.textContent = [
            alder.name ? `Alderperson ${alder.name}` : null,
            places || null,
            details.ward?.population ? `Population ${api.formatNumber(details.ward.population)}` : null,
          ].filter(Boolean).join(" · ");
        } catch (_error) {
          metaEl.textContent = "";
        }
      } else if (metaEl) {
        metaEl.textContent = `Compared with all ${areas.length} community areas`;
      }
    }

    // Where to start.
    let initial = early;
    if (!isWard) {
      initial = hashKey ? readHash(hashKey) : null;
      if (!initial && my && my.get()) {
        // The neighborhood that covers the most of the visitor's ward.
        try {
          const details = await api.fetchWardDetails(my.get());
          const main = [...(details.ward?.community_area_overlaps || [])].sort((a, b) => b.ward_area_pct - a.ward_area_pct)[0];
          if (main) initial = String(main.community_area_number).padStart(2, "0");
        } catch (_error) {
          /* fall back below */
        }
      }
      initial = initial || (areas.find((row) => row.display_name === "Logan Square") || areas[0]).area_id;
      picker.innerHTML = areas
        .map((row) => `<option value="${esc(row.area_id)}"${row.area_id === initial ? " selected" : ""}>${esc(row.display_name)}</option>`)
        .join("");
      picker.addEventListener("change", () => render(picker.value));
    }

    if (isWard) {
      viewingEl?.addEventListener("click", (event) => {
        if (event.target.closest("[data-fd-adopt]")) my.set(current, "adopt");
        if (event.target.closest("[data-fd-mine]")) render(my.get());
      });
      document.addEventListener("fd:myward", (event) => {
        const ward = event.detail.ward;
        clearHash();
        if (ward) render(ward);
        else {
          current = null;
          showEmpty(true);
        }
      });
    }
    root.querySelector("[data-fd-print]")?.addEventListener("click", () => {
      api.track("report_shared", { how: "print" });
      window.print();
    });
    // A printout says when it was made. beforeprint also covers Ctrl+P, not just the button.
    const printedEl = root.querySelector("[data-fd-printed]");
    if (printedEl) {
      window.addEventListener("beforeprint", () => {
        const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
        printedEl.textContent = `Printed from Ward Wise on ${today}.`;
      });
    }
    if (initial) render(initial);

    if (mapSlot && window.WardWiseCivicMap) {
      map = await window.WardWiseCivicMap.create(mapSlot, {
        areaType: set.areaType,
        label: `Map of Chicago's ${areaNoun}. Select one to see its numbers.`,
        tooltip: (id) => `<strong>${esc(map ? map.nameOf(id) : "")}</strong>`,
        onSelect: (id) => render(id),
      });
      map.paint(() => "var(--map-empty)");
      if (current) map.select(current);
    }
  }


  // --- Explore: the homepage map --------------------------------------------------

  const EXPLORE = {
    ward: [
      "c311_pothole_days",
      "violent_crime_rate_per_10000",
      "modeled_fear_walking_pct",
      "park_acres_per_10000_residents",
      "median_household_income",
      "new_residential_units_permitted_est",
      "school_proficiency_pct",
      "c311_response_days",
      "chain_restaurant_share_pct",
    ],
    community_area: [
      "median_household_income",
      "observed_asking_rent_usd",
      "violent_crime_rate_per_10000",
      "modeled_fear_walking_pct",
      "public_transit_pct",
      "licensed_grocery_stores_per_10000_residents",
      "licensed_coffee_shops_per_10000_residents",
      "chain_restaurant_share_pct",
    ],
  };

  // Light to dark blue. Darker is better, whichever way the metric runs. Values are CSS
  // variables (defined in static/dark/home.css) so the ramp switches with the theme.
  const RAMP = ["var(--ramp-0)", "var(--ramp-1)", "var(--ramp-2)", "var(--ramp-3)", "var(--ramp-4)"];

  // Measures where "better" depends on who is asking. Cheap rent is good for a tenant and often
  // a sign of disinvestment, so the map shows these from low to high with no verdict.
  const NEUTRAL = new Set(["observed_asking_rent_usd"]);

  // Measures whose "better" direction is a value call get it said in words.
  const DIRECTION_LABEL = {
    chain_restaurant_share_pct: "Fewer chains ranks higher",
    licensed_chain_restaurant_share_pct: "Fewer chains ranks higher",
  };

  // Estimates rather than counts. The panel says so wherever the number appears.
  const MODELED = {
    modeled_fear_walking_pct: "Share of adults likely to feel unsafe walking alone near home at night. An estimate from a national survey, not a count of crimes.",
  };

  // Where the number comes from: the original dataset, and the dictionary entry that explains it.
  function sourceLine(metric) {
    if (!metric.source) return "";
    const source = metric.source_url
      ? `<a href="${esc(metric.source_url)}" target="_blank" rel="noopener">${esc(metric.source)}</a>`
      : esc(metric.source);
    return `<p class="fd-small fd-source-line">From ${source}.<br><a href="/dictionary#metric-entry-${esc(metric.metric_id)}">How it's measured</a></p>`;
  }

  async function initExplore() {
    const root = document.querySelector("[data-fd-explore]");
    if (!root || !window.WardWiseCivicMap) return;
    const mapNode = root.querySelector("[data-fd-map]");
    const panel = root.querySelector("[data-fd-panel]");
    const chips = root.querySelector("[data-fd-measures]");
    const geoButtons = [...root.querySelectorAll("[data-fd-geo] button")];

    const cache = {};
    const state = { areaType: "ward", metricId: EXPLORE.ward[0], selected: null };
    let map = null;
    let data = null;

    const nounFor = (areaType) => (areaType === "ward" ? "wards" : "neighborhoods");
    const metricOf = () => data.metrics.find((metric) => metric.metric_id === state.metricId);

    async function loadData(areaType) {
      if (!cache[areaType]) cache[areaType] = api.fetchComparison(EXPLORE[areaType], areaType);
      return cache[areaType];
    }

    function spotsFor(metric) {
      const spots = new Map();
      data.rows.forEach((row) => spots.set(row.area_id, standing(data.rows, metric, row.area_id)));
      return spots;
    }

    function tone(spot) {
      if (!spot) return null;
      const place = NEUTRAL.has(state.metricId) ? 1 - spot.share : spot.position;
      return RAMP[4 - Math.min(4, Math.floor(place * 5))];
    }

    function setLegend() {
      const neutral = NEUTRAL.has(state.metricId);
      root.querySelector("[data-fd-legend-lo]").textContent = neutral ? "Lower" : "Worse";
      root.querySelector("[data-fd-legend-hi]").textContent = neutral ? "Higher" : "Better";
    }

    function renderChips() {
      chips.innerHTML = EXPLORE[state.areaType].map((id) => {
        const metric = data.metrics.find((m) => m.metric_id === id);
        if (!metric) return "";
        return `<button type="button" data-id="${esc(id)}" aria-pressed="${id === state.metricId}">${esc(SHORT_LABELS[id] || metric.label)}</button>`;
      }).join("");
    }

    function listItem(row, spot, metric) {
      return `<li><button type="button" data-select="${esc(row.area_id)}"><span>${esc(row.display_name)}</span><strong>${esc(formatValue(spot.value, metric))}</strong></button></li>`;
    }

    function renderPanel() {
      const metric = metricOf();
      const spots = spotsFor(metric);
      const noun = nounFor(state.areaType);
      const name = SHORT_LABELS[metric.metric_id] || metric.label;
      const neutral = NEUTRAL.has(metric.metric_id);
      const better = neutral ? "Shown from low to high" : DIRECTION_LABEL[metric.metric_id] || (metric.direction === "lower" ? "Lower is better" : "Higher is better");

      if (!state.selected) {
        const ranked = data.rows
          .map((row) => ({ row, spot: spots.get(row.area_id) }))
          .filter((entry) => entry.spot)
          .sort((a, b) => (neutral ? b.spot.value - a.spot.value : a.spot.rank - b.spot.rank));
        const median = ranked.length ? ranked[0].spot.median : null;
        swapIn(panel, `
          <p class="fd-tag">${esc(better)}</p>
          <h3 class="fd-h2">${esc(name)}</h3>
          <p class="fd-small">${esc(MODELED[metric.metric_id] || metric.description || "")}</p>
          <p class="fd-explore-median">City median <strong>${esc(formatValue(median, metric))}</strong></p>
          <div class="fd-explore-lists">
            <div><p class="fd-tag">${neutral ? "Highest" : "Best"}</p><ol class="fd-pick">${ranked.slice(0, 3).map((e) => listItem(e.row, e.spot, metric)).join("")}</ol></div>
            <div><p class="fd-tag">${neutral ? "Lowest" : "Worst"}</p><ol class="fd-pick">${ranked.slice(-3).reverse().map((e) => listItem(e.row, e.spot, metric)).join("")}</ol></div>
          </div>
          <p class="fd-small fd-explore-hint">Select any ${state.areaType === "ward" ? "ward" : "neighborhood"} on the map for its numbers.</p>
          ${sourceLine(metric)}`);
        return;
      }

      const row = data.rows.find((r) => r.area_id === state.selected);
      const spot = spots.get(state.selected);
      const link = state.areaType === "ward"
        ? `/for/residents#ward=${state.selected}`
        : `/for/business#area=${state.selected}`;
      const linkLabel = state.areaType === "ward" ? "Full report card" : "Full neighborhood snapshot";
      const b = spot ? band(spot) : null;
      swapIn(panel, `
        <button type="button" class="fd-back" data-clear>All ${esc(noun)}</button>
        <h3 class="fd-h1">${esc(row ? row.display_name : "")}</h3>
        <p class="fd-small" data-fd-alder></p>
        <div class="fd-explore-stat">
          <p class="fd-tag">${esc(name)}</p>
          <p class="fd-explore-value" data-fd-value>${esc(spot ? formatValue(spot.value, metric) : "No data")}</p>
          ${spot && neutral ? `<p><span class="fd-band-mid">${higherThan(spot)}</span> <span class="fd-small">of ${spot.of} ${esc(noun)}. Median ${esc(formatValue(spot.median, metric))}.</span></p>
          <div class="fd-track"><span class="fd-dot" data-left="${(spot.share * 100).toFixed(1)}" style="left: 0%"></span></div>
          <div class="fd-track-ends" aria-hidden="true"><span>Lowest</span><span>Median</span><span>Highest</span></div>` : ""}
          ${spot && !neutral ? `<p><span class="fd-band-${b.key}">${b.label}</span> <span class="fd-small">${ordinal(spot.rank)} of ${spot.of} ${esc(noun)}. Median ${esc(formatValue(spot.median, metric))}.</span></p>
          <div class="fd-track"><span class="fd-dot fd-dot-${b.key}" data-left="${(spot.position * 100).toFixed(1)}" style="left: 0%"></span></div>
          <div class="fd-track-ends" aria-hidden="true"><span>Best</span><span>Median</span><span>Worst</span></div>` : ""}
          ${MODELED[metric.metric_id] ? `<p class="fd-small">${esc(MODELED[metric.metric_id])}</p>` : ""}
          ${sourceLine(metric)}
        </div>
        <div class="fd-actions">
          <a class="fd-btn" href="${link}">${linkLabel}</a>
          ${state.areaType === "ward" && window.WardWiseMyWard
            ? (window.WardWiseMyWard.get() === state.selected
              ? `<span class="fd-your-ward">Your ward</span>`
              : `<button type="button" class="fd-chip-btn" data-fd-adopt-ward="${esc(state.selected)}">Make this my ward</button>`)
            : ""}
        </div>`);
      settleDots(panel);
      if (spot) countUp(panel.querySelector("[data-fd-value]"), spot.value, (v) => formatValue(v, metric), 700);
      if (state.areaType === "ward") {
        const target = panel.querySelector("[data-fd-alder]");
        api.fetchWardDetails(state.selected).then((details) => {
          const alder = details.alderperson?.name;
          if (alder && target.isConnected) {
            target.textContent = `Alderperson ${alder}`;
            target.classList.add("fd-in");
          }
        }).catch(() => {});
      }
    }

    function paint() {
      setLegend();
      const metric = metricOf();
      const spots = spotsFor(metric);
      map.paint((id) => tone(spots.get(id)));
      map.select(state.selected);
    }

    function tooltip(id) {
      const metric = metricOf();
      const row = data.rows.find((r) => r.area_id === id);
      const spot = standing(data.rows, metric, id);
      if (!row) return null;
      const standingText = !spot ? "" : NEUTRAL.has(metric.metric_id)
        ? `${higherThan(spot)}`
        : `${ordinal(spot.rank)} of ${spot.of}`;
      return `<strong>${esc(row.display_name)}</strong><span>${esc(spot ? formatValue(spot.value, metric) : "No data")}</span>${standingText ? `<em>${standingText}</em>` : ""}`;
    }

    function selectArea(id) {
      state.selected = state.selected === id ? null : id;
      map.select(state.selected);
      renderPanel();
    }

    const seg = root.querySelector("[data-fd-geo]");
    function moveThumb() {
      const active = seg.querySelector('[aria-pressed="true"]');
      if (!active) return;
      seg.classList.add("has-thumb");
      seg.style.setProperty("--seg-x", `${active.offsetLeft}px`);
      seg.style.setProperty("--seg-w", `${active.offsetWidth}px`);
    }
    window.addEventListener("resize", moveThumb);

    async function switchGeography(areaType) {
      state.areaType = areaType;
      state.selected = null;
      if (!EXPLORE[areaType].includes(state.metricId)) state.metricId = EXPLORE[areaType][0];
      geoButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === areaType)));
      moveThumb();
      root.classList.add("is-loading");
      data = await loadData(areaType);
      map = await window.WardWiseCivicMap.create(mapNode, {
        areaType,
        label: `Map of Chicago's ${nounFor(areaType)}, shaded by the selected measure`,
        tooltip,
        onSelect: selectArea,
      });
      root.classList.remove("is-loading");
      const mine = window.WardWiseMyWard && window.WardWiseMyWard.get();
      if (areaType === "ward" && mine) state.selected = mine;
      renderChips();
      paint();
      renderPanel();
    }

    chips.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-id]");
      if (!button) return;
      if (button.dataset.id !== state.metricId && window.WardWiseAnalytics) window.WardWiseAnalytics.measureOpened(button.dataset.id, null);
      state.metricId = button.dataset.id;
      chips.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      paint();
      renderPanel();
    });
    geoButtons.forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.value !== state.areaType) switchGeography(button.dataset.value);
    }));
    panel.addEventListener("click", (event) => {
      const pick = event.target.closest("[data-select]");
      if (pick) selectArea(pick.dataset.select);
      if (event.target.closest("[data-clear]")) selectArea(state.selected);
      const adopt = event.target.closest("[data-fd-adopt-ward]");
      if (adopt) window.WardWiseMyWard.set(adopt.dataset.fdAdoptWard, "adopt");
    });
    document.addEventListener("fd:myward", (event) => {
      if (!map || state.areaType !== "ward") return;
      if (event.detail.ward) state.selected = event.detail.ward;
      map.select(state.selected);
      renderPanel();
    });

    mapNode.innerHTML = `<div class="fd-skel fd-map-skel" aria-hidden="true"></div>`;
    panel.innerHTML = skelBlock([["", "30%"], ["is-xl", "75%"], ["", "90%"], ["", "60%"], ["is-lg", "45%"]]) +
      `<div style="margin-top: 20px">${skelBlock([["", "100%"], ["", "100%"], ["", "100%"], ["", "100%"]])}</div>`;

    try {
      await switchGeography("ward");
      // Warm what people click next: the other geography, and the pages the panel links to.
      idle(() => {
        loadData("community_area");
        window.WardWiseCivicMap.loadGeometry("community_area");
        api.fetchComparison(SETS.residents.metrics, "ward");
        api.fetchComparison(SETS.snapshot.metrics, "community_area");
      });
    } catch (error) {
      root.classList.remove("is-loading");
      mapNode.innerHTML = "";
      panel.innerHTML = failNotice(error);
    }
  }

  // --- Home: live counts -----------------------------------------------------------

  async function initCounts() {
    if (!document.querySelector("[data-fd-count]")) return;
    try {
      const manifest = await api.fetchExplorerManifest();
      const metrics = manifest.metrics || [];
      const counts = {
        metrics: metrics.length,
        domains: new Set(metrics.map((metric) => metric.category)).size,
        sources: new Set(metrics.map((metric) => metric.source)).size,
      };
      document.querySelectorAll("[data-fd-count]").forEach((el) => {
        if (counts[el.dataset.fdCount]) el.textContent = counts[el.dataset.fdCount];
      });
    } catch (_error) {
      /* the markup holds a neutral placeholder, never a stale number */
    }
  }

  // --- Planning: CSV download + housing lists ----------------------------------------

  function csvCell(value) {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  async function initDownloads() {
    const root = document.getElementById("fd-download");
    if (!root) return;
    const domainPicker = document.getElementById("fd-download-domain");
    const geoPicker = document.getElementById("fd-download-geo");
    const button = document.getElementById("fd-download-go");
    const status = document.getElementById("fd-download-status");

    let manifest;
    try {
      manifest = await api.fetchExplorerManifest();
    } catch (error) {
      status.textContent = friendly(error);
      return;
    }
    const byDomain = new Map();
    (manifest.metrics || []).forEach((metric) => {
      if (!byDomain.has(metric.category)) byDomain.set(metric.category, []);
      byDomain.get(metric.category).push(metric);
    });
    domainPicker.innerHTML = [...byDomain.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([category, list]) => {
        const name = String(category || "").replaceAll("_", " ");
        return `<option value="${esc(category)}">${esc(name.charAt(0).toUpperCase() + name.slice(1))} (${list.length})</option>`;
      })
      .join("");

    button.addEventListener("click", async () => {
      const category = domainPicker.value;
      const areaType = geoPicker.value;
      // Metrics never measured at this geography would only be empty columns.
      const ids = byDomain.get(category)
        .filter((metric) => (manifest.metric_area_types?.[metric.metric_id] || ["ward"]).includes(areaType))
        .map((metric) => metric.metric_id);
      if (!ids.length) {
        status.textContent = "Nothing in this domain is measured at that geography yet.";
        return;
      }
      button.disabled = true;
      status.textContent = `Preparing ${ids.length} measures…`;
      try {
        const data = await api.fetchComparison(ids, areaType);
        const metrics = ids.map((id) => data.metrics.find((metric) => metric.metric_id === id)).filter(Boolean);
        const lines = [
          ["area_id", "area_name", ...metrics.map((metric) => metric.metric_id)],
          ["", "label", ...metrics.map((metric) => metric.label)],
          ["", "unit", ...metrics.map((metric) => metric.unit)],
          ["", "source", ...metrics.map((metric) => metric.source)],
          ...data.rows.map((row) => [row.area_id, row.display_name, ...metrics.map((metric) => row.values[metric.metric_id])]),
        ];
        const blob = new Blob([lines.map((line) => line.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `wardwise-${category}-${areaType}.csv`;
        link.click();
        URL.revokeObjectURL(link.href);
        status.textContent = `Downloaded ${data.rows.length} areas and ${metrics.length} measures.`;
      } catch (error) {
        status.textContent = friendly(error);
      } finally {
        button.disabled = false;
      }
    });
  }

  // Top five and bottom five areas for one measure, as two ruled lists.
  async function initWardLists(rootId, metricId, highLabel, lowLabel, areaType = "ward") {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.innerHTML = [0, 1].map(() => `<div class="fd-card">${skelBlock([["is-lg", "30%"], ["", "100%"], ["", "100%"], ["", "100%"], ["", "100%"], ["", "100%"]])}</div>`).join("");
    try {
      const data = await api.fetchComparison([metricId], areaType);
      const metric = data.metrics[0];
      const rows = data.rows
        .filter((row) => row.values[metricId] !== null && row.values[metricId] !== undefined)
        .sort((a, b) => b.values[metricId] - a.values[metricId]);
      const item = (row) => `<li><span>${esc(row.display_name)}</span><strong>${esc(formatValue(row.values[metricId], metric))}</strong></li>`;
      root.innerHTML = `
        <div class="fd-card"><h3 class="fd-h3">${esc(highLabel)}</h3><ol class="fd-list">${rows.slice(0, 5).map(item).join("")}</ol></div>
        <div class="fd-card"><h3 class="fd-h3">${esc(lowLabel)}</h3><ol class="fd-list">${rows.slice(-5).reverse().map(item).join("")}</ol></div>`;
      return { measured: rows.length, total: data.rows.length };
    } catch (error) {
      root.innerHTML = failNotice(error);
      return null;
    }
  }

  function initHousing() {
    initWardLists("fd-housing", "new_residential_units_permitted_est", "Most", "Fewest");
    const chainNote = document.querySelector("[data-fd-chain-note]");
    const chains = async () => {
      if (chainNote) chainNote.textContent = "";
      const counts = await initWardLists("fd-chains", "chain_restaurant_share_pct", "Most chain restaurants", "Most independent restaurants", chainGeo);
      if (!chainNote || !counts) return;
      const noun = chainGeo === "ward" ? "wards" : "neighborhoods";
      chainNote.textContent = `Showing ${noun}. ${counts.measured} of ${counts.total} ${noun} have data. Areas with few restaurants can swing a lot.`;
    };
    let chainGeo = "ward";
    chains();
    const seg = document.querySelector("[data-fd-chain-geo]");
    if (seg) seg.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button || button.dataset.value === chainGeo) return;
      chainGeo = button.dataset.value;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      chains();
    });
  }

  // --- Membership: dues ------------------------------------------------------------

  // Proposed dues, for discussion with the team. Nothing here is a settled price.
  const TIERS = {
    neighbor: { name: "Resident", dues: 0 },
    local: { name: "Community", dues: 300 },
    partner: { name: "Organization", dues: 2500 },
    anchor: { name: "Institution", dues: 7500 },
  };

  const TIER_INCLUDES = {
    neighbor: ["Everything on the public site", "Email updates for your ward", "Nominate new measures"],
    local: ["Seats for your whole team", "Custom views you can share", "A vote on what gets built next", "Analysis at $100 an hour"],
    partner: ["Everything in Community", "A quarterly data briefing", "API access", "Priority on new-measure requests"],
    anchor: ["Everything in Organization", "10 hours of custom analysis a year", "Higher-volume API with an uptime promise", "Eligible for a council seat"],
  };

  // Budget sets the tier, with two floors. Developers and consultancies resell what they
  // learn, so they start at Organization, and city or county agencies start at Institution.
  // Aldermanic offices and campaigns can't join at all, since the site ranks them (charter).
  function tierFor(type, budget) {
    if (type === "resident") return "neighbor";
    const byBudget = { small: "local", mid: "local", large: "partner", xl: "anchor" }[budget] || "local";
    const floor = { developer: "partner", agency: "anchor" }[type];
    const order = ["neighbor", "local", "partner", "anchor"];
    return floor && order.indexOf(floor) > order.indexOf(byBudget) ? floor : byBudget;
  }

  function money(value) {
    return api.formatNumber(value, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }

  function initDues() {
    const root = document.getElementById("fd-dues");
    if (!root) return;
    const type = root.querySelector("[name=fd-type]");
    const out = document.getElementById("fd-dues-result");
    const update = () => {
      const budget = root.querySelector("[name=fd-budget]:checked")?.value;
      const key = tierFor(type.value, budget);
      const tier = TIERS[key];
      const founding = root.querySelector("[name=fd-founding]")?.checked;
      const sliding = root.querySelector("[name=fd-sliding]")?.checked;
      const firstYear = founding ? Math.round(tier.dues * 0.7) : tier.dues;
      const amount = tier.dues === 0
        ? "Free"
        : sliding ? "Pay what you can" : `${money(firstYear)}<small> ${founding ? "first year" : "per year"}</small>`;
      const notes = [];
      if (founding && tier.dues && !sliding) notes.push(`Founding price, 30% off the first year. Then ${money(tier.dues)} a year, held for two years.`);
      if (sliding && tier.dues) notes.push(`Listed at ${money(tier.dues)}. Nobody is turned away for money.`);
      swapIn(out, `
        <p class="fd-tag">Your membership</p>
        <h3 class="fd-h2">${esc(tier.name)}</h3>
        <p class="fd-amount">${amount}</p>
        ${notes.map((note) => `<p class="fd-note">${esc(note)}</p>`).join("")}
        <ul class="fd-ticks">${TIER_INCLUDES[key].map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
        <div class="fd-actions"><a class="fd-btn" href="/guild/join?type=${encodeURIComponent(type.value)}&budget=${encodeURIComponent(budget || "")}">Apply</a></div>`);
    };
    root.addEventListener("input", update);
    root.addEventListener("change", update);
    update();
  }

  // --- Membership: application -------------------------------------------------------

  // Form checks in the site's own style instead of the browser's warning bubbles. The message
  // sits under the field, and goes away as soon as the field is fixed.
  function fieldMessage(field) {
    if (field.type === "checkbox") return "Check this box to continue.";
    if (field.tagName === "SELECT") return "Choose one to continue.";
    if (field.validity.valueMissing) return "Please fill this in.";
    if (field.type === "email") return "Enter an email address, like name@example.org.";
    if (field.type === "url") return "Enter a full web address, like https://example.org.";
    return "Please check this.";
  }

  function showFieldError(field) {
    const holder = field.closest(".fd-field, .fd-choice, .fd-ab-send") || field.parentElement;
    let note = holder.querySelector(":scope > .fd-field-error");
    if (!note) {
      note = document.createElement("p");
      note.className = "fd-field-error";
      note.id = `${field.id || field.name}-error`;
      holder.append(note);
    }
    note.textContent = fieldMessage(field);
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", note.id);
    field.focus();
    const clear = () => {
      if (!field.checkValidity()) return;
      note.remove();
      field.removeAttribute("aria-invalid");
      field.removeAttribute("aria-describedby");
      field.removeEventListener("input", clear);
      field.removeEventListener("change", clear);
    };
    field.addEventListener("input", clear);
    field.addEventListener("change", clear);
  }

  // Returns true when every field in scope is valid; otherwise flags the first bad one.
  function checkFields(scope) {
    const invalid = [...scope.querySelectorAll("input, select, textarea")].find((field) => !field.checkValidity());
    if (invalid) showFieldError(invalid);
    return !invalid;
  }

  function initJoin() {
    const form = document.getElementById("fd-join");
    if (!form) return;
    const steps = [...form.querySelectorAll(".fd-step")];
    const dots = [...document.querySelectorAll(".fd-steps li")];
    const params = new URLSearchParams(window.location.search);
    const presetType = params.get("type");
    if (presetType && [...form.elements.type.options].some((option) => option.value === presetType)) {
      form.elements.type.value = presetType;
    }
    if (params.get("budget")) {
      const radio = form.querySelector(`[name=budget][value="${CSS.escape(params.get("budget"))}"]`);
      if (radio) radio.checked = true;
    }
    let current = 0;

    function tierLine() {
      const tier = TIERS[tierFor(form.elements.type.value, form.querySelector("[name=budget]:checked")?.value)];
      return `${tier.name}, ${tier.dues ? `${money(tier.dues)} per year` : "free"}`;
    }

    function renderReview() {
      const needs = [...form.querySelectorAll("[name=needs]:checked")].map((box) => box.value);
      const rows = [
        ["Organization", form.elements.org.value],
        ["Contact", `${form.elements.name.value}, ${form.elements.email.value}`],
        ["Type", form.elements.type.selectedOptions[0]?.textContent],
        ["Membership", tierLine()],
        ["Areas", form.elements.areas.value || "Not given"],
        ["Interested in", needs.join(", ") || "Not given"],
      ];
      document.getElementById("fd-join-review").innerHTML = rows
        .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
        .join("");
    }

    function show(index, { focus = true } = {}) {
      current = index;
      steps.forEach((step, i) => { step.hidden = i !== index; });
      dots.forEach((dot, i) => {
        dot.classList.toggle("is-current", i === index);
        dot.classList.toggle("is-done", i < index);
      });
      if (focus) steps[index].querySelector("input, select, textarea")?.focus();
      if (index === steps.length - 1) renderReview();
    }

    // People type "example.org". Add the https:// the web address field needs instead of rejecting it.
    const site = form.elements.site;
    if (site) {
      site.addEventListener("blur", () => {
        const value = site.value.trim();
        if (value && !/^https?:\/\//i.test(value)) site.value = `https://${value}`;
      });
    }

    const updateTier = () => { document.getElementById("fd-join-tier").textContent = tierLine(); };
    form.addEventListener("change", updateTier);
    form.addEventListener("click", (event) => {
      if (event.target.closest("[data-fd-back]")) {
        show(current - 1);
        return;
      }
      if (!event.target.closest("[data-fd-next]")) return;
      if (!checkFields(steps[current])) return;
      show(current + 1);
    });

    form.addEventListener("submit", (event) => {
      // No members table exists yet, so the application stays in the browser.
      event.preventDefault();
      if (!checkFields(form)) return;
      form.hidden = true;
      document.querySelector(".fd-steps").hidden = true;
      const done = document.getElementById("fd-join-done");
      done.querySelector("[data-fd-done-org]").textContent = form.elements.org.value;
      done.querySelector("[data-fd-done-tier]").textContent = tierLine();
      done.hidden = false;
      done.focus();
      window.scrollTo({ top: 0 });
    });

    updateTier();
    show(0, { focus: false });
  }

  // --- Civic: contact your alderperson + what's happening in the ward ----------------

  // Everything here comes from public records. Legislation and meetings are the City Clerk's
  // eLMS API, reached through /clerk because it sends no CORS headers. Permits and 311 are the
  // city data portal, which the browser can read directly.
  const PORTAL = "https://data.cityofchicago.org/resource";
  const CLERK_SITE = "https://chicityclerkelms.chicago.gov";
  const CHICAGO_TIME = { timeZone: "America/Chicago" };

  function isoDaysAgo(days) {
    return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  }

  function formatDay(value) {
    const date = new Date(value);
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString("en-US", { ...CHICAGO_TIME, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  }

  function formatWhen(value) {
    const date = new Date(value);
    return `${date.toLocaleDateString("en-US", { ...CHICAGO_TIME, weekday: "short", month: "short", day: "numeric" })}, ${date.toLocaleTimeString("en-US", { ...CHICAGO_TIME, hour: "numeric", minute: "2-digit" })}`;
  }

  function sentenceCase(text) {
    const lower = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  function clip(text, length) {
    return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
  }

  async function portal(dataset, params) {
    const query = new URLSearchParams(params);
    const response = await fetch(`${PORTAL}/${dataset}.json?${query}`);
    if (!response.ok) throw new Error("The city data portal did not respond.");
    return response.json();
  }

  async function clerk(path, params) {
    const response = await fetch(`/api/clerk/${path}?${new URLSearchParams(params)}`);
    if (!response.ok) throw new Error("The City Clerk's records did not respond.");
    return response.json();
  }

  function feed(items, empty) {
    if (!items.length) return `<p class="fd-small">${esc(empty)}</p>`;
    return `<ul class="fd-feed">${items.join("")}</ul>`;
  }

  function feedItem({ date, title, meta, href }) {
    const heading = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(title)}</a>`
      : esc(title);
    return `<li><time>${esc(date)}</time><div><p class="fd-feed-title">${heading}</p>${meta ? `<p class="fd-feed-meta">${esc(meta)}</p>` : ""}</div></li>`;
  }

  async function renderContact(node, wardId) {
    node.innerHTML = `
      <div class="fd-contact-head" aria-hidden="true">${skel("fd-skel-dot", "width: 64px; height: 64px")}
        <div class="fd-skel-stack" style="flex: 1">${skel("fd-skel-line", "width: 40%")}${skel("fd-skel-line is-lg", "width: 70%")}${skel("fd-skel-line", "width: 25%")}</div></div>
      ${skelBlock([["is-xl", "60%"], ["", "100%"], ["", "90%"], ["", "80%"]])}`;
    try {
      const { alderperson: alder = {} } = await api.fetchWardDetails(wardId);
      const office = alder.ward_office || {};
      const hall = alder.city_hall_office || {};
      const phone = (office.phone || "").split("/")[0].trim();
      swapIn(node, `
        <div class="fd-contact-head">
          ${alder.photo_url ? `<img src="${esc(alder.photo_url)}" alt="" width="64" height="64">` : ""}
          <div>
            <p class="fd-tag">Your alderperson</p>
            <h3 class="fd-h3">${esc(alder.name || "Not listed")}</h3>
            <p class="fd-small">Ward ${Number(wardId)}</p>
          </div>
        </div>
        <div class="fd-actions">
          ${alder.email ? `<a class="fd-btn" href="mailto:${esc(alder.email)}">Email</a>` : ""}
          ${phone ? `<a class="fd-btn fd-btn-ghost" href="tel:${esc(phone.replace(/[^\d+]/g, ""))}">Call ${esc(phone)}</a>` : ""}
        </div>
        <dl class="fd-contact-list">
          ${office.address ? `<div><dt>Ward office</dt><dd>${esc(office.address)}, ${esc(office.city || "Chicago")}</dd></div>` : ""}
          ${hall.address ? `<div><dt>City Hall</dt><dd>${esc(hall.address)}</dd></div>` : ""}
          ${alder.email ? `<div><dt>Email</dt><dd>${esc(alder.email)}</dd></div>` : ""}
        </dl>`);
    } catch (_error) {
      node.innerHTML = `<p class="fd-small">Contact details are unavailable right now. The city lists every alderperson at <a href="https://www.chicago.gov/city/en/about/wards.html" target="_blank" rel="noopener">chicago.gov</a>.</p>`;
    }
  }

  // "Routine" in the Clerk's records still leaves sign permits, driveway permits and landmark
  // fee waivers, which crowd out real proposals downtown. Zoning has its own alert topic.
  const PAPERWORK = /^(SIGNS|ALLEY \| Ingress|HISTORICAL LANDMARKS \| Permit Fee|ZONING RECLASSIFICATIONS|CLAIMS|COMMENDATIONS|PARKING \| Disabled)/;
  function newsworthy(matters) {
    return (matters || []).filter((matter) => !PAPERWORK.test(matter.matterCategory || ""));
  }

  async function renderLegislation(node, wardId) {
    node.innerHTML = skelFeed(4);
    try {
      // Routine items are parking permits and sign permits, dozens a month. Leave them out.
      const data = await clerk("matter", {
        filter: `filingOffice eq '${wardId}' and routine eq 'NO'`,
        sort: "introductionDate desc",
        top: "40",
      });
      node.innerHTML = feed(newsworthy(data.data).slice(0, 4).map((matter) => feedItem({
        date: formatDay(matter.introductionDate),
        title: clip(matter.title || matter.recordNumber, 110),
        meta: `${matter.type}, ${String(matter.status || "").replace(/^\d+-/, "")}`,
        href: `${CLERK_SITE}/Matter/?matterId=${matter.matterId}`,
      })), "No recent legislation from this ward's office.");
    } catch (error) {
      node.innerHTML = `<p class="fd-small">${esc(friendly(error))}</p>`;
    }
  }

  async function renderMeetings(node) {
    node.innerHTML = skelFeed(5);
    try {
      // The API sorts but won't filter by date, so take the latest scheduled and keep the future.
      const data = await clerk("meeting", { sort: "date desc", top: "25" });
      const now = Date.now();
      const upcoming = (data.data || [])
        .filter((meeting) => new Date(meeting.date).getTime() > now)
        .filter((meeting) => !/cancel/i.test(`${meeting.status} ${meeting.comment || ""}`))
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(0, 5);
      node.innerHTML = feed(upcoming.map((meeting) => {
        const comment = (meeting.comment || "").match(/comment[^.\n]*deadline[^.\n]*/i);
        return feedItem({
          date: formatWhen(meeting.date),
          title: meeting.body,
          meta: comment ? sentenceCase(comment[0]).replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, (m) => m[0].toUpperCase() + m.slice(1)).replace(/\b(am|pm)\b/g, (m) => m.toUpperCase()) : "City Hall, 121 N. LaSalle",
          href: `${CLERK_SITE}/Meeting/?meetingId=${meeting.meetingId}`,
        });
      }), "No meetings are scheduled yet.");
    } catch (error) {
      node.innerHTML = `<p class="fd-small">${esc(friendly(error))}</p>`;
    }
  }

  async function renderPermits(node, wardId) {
    node.innerHTML = skelFeed(4);
    try {
      const rows = await portal("ydr8-5enu", {
        $select: "permit_,permit_type,issue_date,street_number,street_direction,street_name,work_description",
        // Temporary structures (festival tents, stages) file as new construction with an
        // "erection starts" window. They are most of some wards' permits and none of the news.
        $where: `ward='${Number(wardId)}' AND issue_date > '${isoDaysAgo(183)}' AND permit_type in ('PERMIT - NEW CONSTRUCTION','PERMIT - WRECKING/DEMOLITION') AND NOT upper(work_description) like '%ERECTION STARTS%'`,
        $order: "issue_date DESC",
        $limit: "5",
      });
      node.innerHTML = feed(rows.map((row) => feedItem({
        date: formatDay(row.issue_date),
        title: `${/WRECKING/.test(row.permit_type) ? "Demolition" : "New construction"} at ${[row.street_number, row.street_direction, sentenceCase(row.street_name).replace(/\b\w/g, (c) => c.toUpperCase())].filter(Boolean).join(" ")}`,
        meta: clip(sentenceCase(row.work_description), 120),
      })), "No new buildings or demolitions permitted in the last six months.");
    } catch (error) {
      node.innerHTML = `<p class="fd-small">${esc(friendly(error))}</p>`;
    }
  }

  async function render311(node, wardId) {
    node.innerHTML = skelBlock([["is-lg", "90%"], ["is-lg", "75%"], ["is-lg", "60%"], ["is-lg", "50%"], ["is-lg", "40%"]]);
    try {
      const rows = await portal("v6vf-nfxy", {
        $select: "sr_type,count(*) as n",
        $where: `ward='${Number(wardId)}' AND created_date > '${isoDaysAgo(7)}' AND sr_type != '311 INFORMATION ONLY CALL'`,
        $group: "sr_type",
        $order: "n DESC",
        $limit: "5",
      });
      const max = Math.max(1, ...rows.map((row) => Number(row.n)));
      node.innerHTML = rows.length
        ? `<ul class="fd-bars">${rows.map((row) => `
            <li><span>${esc(row.sr_type.replace(/ Complaint$/, "").replace(/^Buildings - /, ""))}</span><strong>${esc(row.n)}</strong><i style="width: ${(Number(row.n) / max * 100).toFixed(0)}%"></i></li>`).join("")}</ul>`
        : `<p class="fd-small">No 311 requests in the last seven days.</p>`;
    } catch (error) {
      node.innerHTML = `<p class="fd-small">${esc(friendly(error))}</p>`;
    }
  }

  function initCivic() {
    const root = document.querySelector("[data-fd-civic]");
    if (!root) return;
    const parts = {
      contact: root.querySelector("[data-fd-contact]"),
      legislation: root.querySelector("[data-fd-legislation]"),
      meetings: root.querySelector("[data-fd-meetings]"),
      permits: root.querySelector("[data-fd-permits]"),
      requests: root.querySelector("[data-fd-311]"),
    };
    let meetingsLoaded = false;

    function load(wardId) {
      root.querySelectorAll("[data-fd-ward-name]").forEach((el) => { el.textContent = `Ward ${Number(wardId)}`; });
      if (parts.contact) renderContact(parts.contact, wardId);
      if (parts.legislation) renderLegislation(parts.legislation, wardId);
      if (parts.permits) renderPermits(parts.permits, wardId);
      if (parts.requests) render311(parts.requests, wardId);
      // Council meetings are citywide, so they load once.
      if (parts.meetings && !meetingsLoaded) {
        meetingsLoaded = true;
        renderMeetings(parts.meetings);
      }
    }

    if (root.dataset.fdCivic === "mine") {
      // Standalone page (alerts): shows the visitor's own ward, or asks for one.
      const my = window.WardWiseMyWard;
      const empty = root.querySelector("[data-fd-civic-empty]");
      const body = root.querySelector("[data-fd-civic-body]");
      const apply = (ward) => {
        if (empty) empty.hidden = Boolean(ward);
        if (body) body.hidden = !ward;
        if (!ward) {
          if (empty && my) my.mountInline(empty.querySelector("[data-fd-empty-picker]"));
          return;
        }
        load(ward);
      };
      apply(my ? my.get() : null);
      document.addEventListener("fd:myward", (event) => apply(event.detail.ward));
    } else {
      // Follows the report card on the same page, and stays out of sight until there's a ward.
      root.hidden = true;
      document.addEventListener("fd:area", (event) => {
        if (event.detail.areaType !== "ward") return;
        root.hidden = false;
        load(event.detail.areaId);
      });
      document.addEventListener("fd:myward", (event) => {
        if (!event.detail.ward) root.hidden = true;
      });
    }
  }

  // --- Alert builder ------------------------------------------------------------------
  // One page: topics on the left, and the email on the right redraws from live records as
  // they change. Each topic has a loader that answers { count, items } for a ward over a
  // window of days. The email is written the way a sending job would mail it (tables, inline
  // styles, no web fonts, no SVG) so the same markup can move to the server later.

  const ALERT_PREFS = "wardwise:alerts";
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const M = {
    page: `background:#f5f5f7;padding:24px 12px;font-family:${FONT};`,
    card: "width:100%;max-width:600px;margin:0 auto;background:#ffffff;border-radius:18px;border-collapse:separate;",
    brand: "font-size:15px;font-weight:600;color:#1d1d1f;vertical-align:middle;letter-spacing:-0.01em;",
    pill: "display:inline-block;background:#f5f5f7;border-radius:980px;padding:5px 12px;font-size:13px;font-weight:600;color:#1d1d1f;",
    eyebrow: "font-size:13px;color:#6e6e73;margin:0 0 6px;",
    h1: "font-size:28px;line-height:1.12;font-weight:700;letter-spacing:-0.02em;color:#1d1d1f;margin:0 0 10px;",
    summary: "font-size:16px;line-height:1.45;color:#424245;margin:0;",
    note: "background:#eef5fd;border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.45;color:#1d1d1f;",
    section: "border-top:1px solid #e8e8ed;padding:20px 0 4px;",
    h2: "font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.01em;",
    count: "font-size:13px;color:#86868b;",
    date: "width:62px;padding:8px 12px 8px 0;vertical-align:top;font-size:13px;line-height:1.4;color:#86868b;white-space:nowrap;",
    cell: "padding:8px 0;vertical-align:top;",
    title: "font-size:15px;line-height:1.4;font-weight:600;color:#1d1d1f;text-decoration:none;",
    meta: "font-size:13px;line-height:1.45;color:#6e6e73;margin-top:2px;",
    tag: "display:inline-block;margin-left:6px;border-radius:980px;background:#f5f5f7;padding:1px 8px;font-size:11px;font-weight:600;color:#6e6e73;vertical-align:1px;",
    empty: "font-size:14px;color:#86868b;padding:4px 0 12px;margin:0;",
    more: "font-size:13px;color:#0066cc;text-decoration:none;display:inline-block;padding:4px 0 12px;",
    barLabel: "font-size:14px;color:#1d1d1f;padding:5px 12px 5px 0;",
    barNum: "font-size:14px;font-weight:600;color:#1d1d1f;text-align:right;width:40px;padding:5px 0;",
    alder: "background:#f5f5f7;border-radius:14px;padding:16px;",
    link: "color:#0066cc;text-decoration:none;",
    foot: "font-size:12px;line-height:1.55;color:#86868b;text-align:center;padding:20px 28px 28px;",
  };

  const icon = (d) => `<svg viewBox="0 0 20 20" aria-hidden="true">${d}</svg>`;
  const TOPICS = [
    {
      id: "zoning", label: "Zoning changes", hint: "Requests to change what can be built on a lot", on: true,
      noun: ["zoning change", "zoning changes"],
      empty: "No new zoning requests in your ward.",
      icon: icon('<rect x="3" y="3" width="6" height="6" rx="1.2"/><rect x="11" y="3" width="6" height="6" rx="1.2"/><rect x="3" y="11" width="6" height="6" rx="1.2"/><path d="M11 14h6M14 11v6"/>'),
    },
    {
      id: "legislation", label: "New legislation", hint: "What your alderperson introduces at City Council", on: true,
      noun: ["new City Council proposal", "new City Council proposals"],
      empty: "Nothing new introduced by your alderperson.",
      icon: icon('<path d="M5.5 2.5h6l3.5 3.5v11.5H5.5z"/><path d="M11.5 2.5V6H15M8 10h4.5M8 13h4.5"/>'),
    },
    {
      id: "hearings", label: "Hearings", hint: "City Council committee meetings open to public comment", on: true, ahead: true,
      noun: ["City Hall hearing", "City Hall hearings"],
      empty: "No hearings on the calendar yet.",
      icon: icon('<rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 2.5v4M13 2.5v4"/>'),
    },
    {
      id: "closures", label: "Street closures", hint: "Block parties, festivals, races and full closures", on: true, ahead: true,
      noun: ["street closure", "street closures"],
      empty: "No full street closures planned.",
      icon: icon('<rect x="2.5" y="7" width="15" height="4.5" rx="1"/><path d="M5 11.5v5.5M15 11.5v5.5M6.5 7l-3 4.5M11 7l-3 4.5M15.5 7l-3 4.5"/>'),
    },
    {
      id: "businesses", label: "New businesses", hint: "Restaurants, bars and shops licensed to open", on: true,
      noun: ["new business", "new businesses"],
      empty: "No new storefront licenses.",
      icon: icon('<path d="M3 8 4.5 3.5h11L17 8"/><path d="M3 8a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 4 0 2.5 2.5 0 0 0 5 0"/><path d="M4.5 10.5V17h11v-6.5M8.5 17v-4h3v4"/>'),
    },
    {
      id: "permits", label: "Construction and demolition", hint: "New building and wrecking permits", on: true,
      noun: ["building or demolition permit", "building and demolition permits"],
      empty: "No new building or demolition permits.",
      icon: icon('<path d="M4 17V8.5l6-4.5 6 4.5V17"/><path d="M8 17v-5h4v5M2.5 17h15"/>'),
    },
    {
      id: "requests", label: "311 trends", hint: "What neighbors reported most", on: false,
      noun: null,
      empty: "No 311 requests.",
      icon: icon('<path d="M4 4h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 14H9l-4 3v-3H4a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 4 4z"/>'),
    },
    {
      id: "elections", label: "Election dates", hint: "Voting and runoff dates for city races", on: true,
      noun: null,
      empty: "",
      icon: icon('<rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><path d="m7 10 2.2 2.2L13.5 8"/>'),
    },
  ];

  // Licenses a neighbor would notice opening. Offices, peddlers, raffles and tow trucks are left out.
  const STOREFRONT = {
    "Retail Food Establishment": "Restaurant or food shop",
    "Consumption on Premises - Incidental Activity": "Liquor served on site",
    "Tavern": "Tavern",
    "Package Goods": "Liquor store",
    "Outdoor Patio": "Outdoor patio",
    "Public Place of Amusement": "Entertainment venue",
    "Late Hour": "Open late",
    "Children's Services Facility License": "Child care",
    "Tobacco": "Tobacco sales",
    "Motor Vehicle Services License": "Auto repair",
    "Filling Station": "Gas station",
    "Wholesale Food Establishment": "Food wholesaler",
    "Shared Kitchen User (Long Term)": "Shared kitchen",
  };
  const LIQUOR = /consumption on premises|tavern|package goods|liquor/i;

  const CLOSURE_KIND = { "Block Party": "Block party", Festival: "Festival", Athletic: "Race or athletic event", Parade: "Parade" };

  const ELECTIONS = [
    { date: "2027-02-23T12:00:00", title: "Municipal election", meta: "Mayor, clerk, treasurer and all 50 alderpersons" },
    { date: "2027-04-06T12:00:00", title: "Runoff election", meta: "In races where no candidate won a majority" },
  ];

  const monthDay = (value) => new Date(value).toLocaleDateString("en-US", { ...CHICAGO_TIME, month: "short", day: "numeric" });
  const titleCase = (text) => sentenceCase(text)
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/(\s)(Of|And|The|At|In|On|For)\b/g, (_m, space, word) => space + word.toLowerCase());

  const shared = new Map();
  function remember(key, make) {
    if (!shared.has(key)) {
      const promise = make();
      promise.catch(() => shared.delete(key));
      shared.set(key, promise);
    }
    return shared.get(key);
  }

  function wardFeature(ward) {
    return remember("ward-geo", () => api.fetchWardGeojson()).then((collection) =>
      collection.features.find((feature) => String(feature.properties.ward_id).padStart(2, "0") === ward));
  }

  function bounds(geometry) {
    const points = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).flat(2);
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }

  async function geocode(addresses) {
    if (!addresses.length) return {};
    const response = await fetch("/api/geocode/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!response.ok) throw new Error("The address lookup did not respond.");
    return response.json();
  }

  // "Zoning Reclassification Map No. 2-I at 2400 W Grenshaw St a.k.a. 1124 S Western Ave - App No. 23149T1"
  // gives "2400 W Grenshaw St". Filings that cover many lots list them all; the first one places it.
  function zoningAddress(title) {
    const match = String(title).match(/(?:\s|-|[A-Z])at (\d[^,;/]*?)(?:\s*-\s*App|,|;|\/| a\.k\.a\.| and |$)/);
    if (!match) return null;
    const shown = match[1].trim();
    return { shown, lookup: shown.replace(/^(\d+)-\d+/, "$1") };
  }

  function clerkStatus(status) {
    return sentenceCase(String(status || "").replace(/^\d+-/, ""));
  }

  const LOADERS = {
    async zoning(ward, days) {
      const [data, feature] = await Promise.all([
        remember("zoning", () => clerk("matter", {
          filter: "matterCategory eq 'ZONING RECLASSIFICATIONS'",
          sort: "introductionDate desc",
          top: "100",
        })),
        wardFeature(ward),
      ]);
      const since = isoDaysAgo(days);
      const recent = (data.data || [])
        .filter((matter) => (matter.introductionDate || "").slice(0, 10) >= since)
        .map((matter) => ({ matter, address: zoningAddress(matter.title) }))
        .filter((row) => row.address);
      const lookups = [...new Set(recent.map((row) => row.address.lookup))].sort();
      const points = await remember(`geocode:${lookups.join("|")}`, () => geocode(lookups));
      const mine = recent.filter(({ address }) => {
        const point = points[address.lookup];
        return point && window.WardWiseMyWard.contains(feature.geometry, point[0], point[1]);
      });
      return {
        count: mine.length,
        items: mine.map(({ matter, address }) => ({
          date: formatDay(matter.introductionDate),
          title: `Zoning change at ${address.shown}`,
          meta: /committee/i.test(matter.status || "") ? "Filed with City Council. Waiting for a Zoning Committee hearing." : clerkStatus(matter.status),
          href: `${CLERK_SITE}/Matter/?matterId=${matter.matterId}`,
        })),
      };
    },

    async legislation(ward, days) {
      const data = await clerk("matter", {
        filter: `filingOffice eq '${ward}' and routine eq 'NO'`,
        sort: "introductionDate desc",
        top: "60",
      });
      const since = isoDaysAgo(days);
      const rows = newsworthy(data.data).filter((matter) => (matter.introductionDate || "").slice(0, 10) >= since);
      return {
        count: rows.length,
        items: rows.map((matter) => ({
          date: formatDay(matter.introductionDate),
          title: clip(matter.title || matter.recordNumber, 120),
          meta: `${matter.type}. ${clerkStatus(matter.status)}.`,
          href: `${CLERK_SITE}/Matter/?matterId=${matter.matterId}`,
        })),
      };
    },

    async hearings(_ward, days) {
      const data = await remember("meetings", () => clerk("meeting", { sort: "date desc", top: "40" }));
      const now = Date.now();
      const until = now + days * 864e5;
      const rows = (data.data || [])
        .filter((meeting) => {
          const at = new Date(meeting.date).getTime();
          return at > now && at < until;
        })
        .filter((meeting) => !/cancel/i.test(`${meeting.status} ${meeting.comment || ""}`))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      return {
        count: rows.length,
        items: rows.map((meeting) => {
          const time = new Date(meeting.date).toLocaleTimeString("en-US", { ...CHICAGO_TIME, hour: "numeric", minute: "2-digit" });
          return {
            date: formatDay(meeting.date),
            title: meeting.body,
            meta: `${time} at City Hall, 121 N. LaSalle. Anyone can sign up to comment.`,
            href: `${CLERK_SITE}/Meeting/?meetingId=${meeting.meetingId}`,
            tag: /zoning/i.test(meeting.body) ? "Zoning" : "",
          };
        }),
      };
    },

    async closures(ward, days) {
      const feature = await wardFeature(ward);
      const [west, south, east, north] = bounds(feature.geometry);
      const rows = await portal("jdis-5sry", {
        $select: "applicationnumber,worktypedescription,applicationstartdate,applicationenddate,streetnumberfrom,direction,streetname,suffix,latitude,longitude",
        $where: `streetclosure='Full' AND applicationstartdate >= '${isoDaysAgo(0)}' AND applicationstartdate < '${isoDaysAgo(-days)}' AND latitude between ${south} and ${north} AND longitude between ${west} and ${east}`,
        $order: "applicationstartdate",
        $limit: "500",
      });
      const inWard = rows.filter((row) => window.WardWiseMyWard.contains(feature.geometry, Number(row.longitude), Number(row.latitude)));
      const items = inWard.map((row) => {
        const kind = CLOSURE_KIND[row.worktypedescription] || "Street closed for work";
        const block = Math.floor(Number(row.streetnumberfrom) / 100) * 100;
        const street = [row.direction, titleCase(row.streetname), titleCase(row.suffix || "")].filter(Boolean).join(" ");
        const start = formatDay(row.applicationstartdate);
        const end = formatDay(row.applicationenddate || row.applicationstartdate);
        return {
          date: start,
          title: `${kind} on the ${block} block of ${street}`,
          meta: start === end ? `Closed to traffic ${start}.` : `Closed to traffic ${start} to ${end}.`,
        };
      });
      // One event often files a permit per side of the street. Show it once.
      const seen = new Set();
      const unique = items.filter((item) => {
        const key = `${item.title}|${item.meta}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { count: unique.length, items: unique };
    },

    async businesses(ward, days) {
      const rows = await portal("r5kz-chrr", {
        $select: "doing_business_as_name,legal_name,license_description,address,date_issued",
        $where: `ward='${Number(ward)}' AND application_type='ISSUE' AND date_issued > '${isoDaysAgo(days)}'`,
        $order: "date_issued DESC",
        $limit: "300",
      });
      const places = new Map();
      rows.filter((row) => STOREFRONT[row.license_description]).forEach((row) => {
        const address = (String(row.address || "").match(/^\d+\s+[NSEW]\s+.+?\s(?:ST|AVE|BLVD|RD|DR|PL|CT|PKWY|HWY|WAY|TER|LN|SQ)\b/) || [row.address])[0];
        const key = `${row.doing_business_as_name || row.legal_name}|${address}`;
        if (!places.has(key)) places.set(key, { row, address, kinds: new Set() });
        places.get(key).kinds.add(row.license_description);
      });
      const list = [...places.values()];
      return {
        count: list.length,
        items: list.map(({ row, address, kinds }) => ({
          date: formatDay(row.date_issued),
          title: `${titleCase(row.doing_business_as_name || row.legal_name)} at ${titleCase(address)}`,
          meta: `${[...kinds].map((kind) => STOREFRONT[kind]).join(", ")}.`,
          tag: [...kinds].some((kind) => LIQUOR.test(kind)) ? "Liquor" : "",
        })),
      };
    },

    async permits(ward, days) {
      const rows = await portal("ydr8-5enu", {
        $select: "permit_,permit_type,issue_date,street_number,street_direction,street_name,work_description",
        // Temporary structures (festival tents, stages) file as new construction with an
        // "erection starts" window. They are most of some wards' permits and none of the news.
        $where: `ward='${Number(ward)}' AND issue_date > '${isoDaysAgo(days)}' AND permit_type in ('PERMIT - NEW CONSTRUCTION','PERMIT - WRECKING/DEMOLITION') AND NOT upper(work_description) like '%ERECTION STARTS%'`,
        $order: "issue_date DESC",
        $limit: "100",
      });
      return {
        count: rows.length,
        items: rows.map((row) => ({
          date: formatDay(row.issue_date),
          title: `${/WRECKING/.test(row.permit_type) ? "Demolition" : "New construction"} at ${[row.street_number, row.street_direction, titleCase(row.street_name)].filter(Boolean).join(" ")}`,
          meta: clip(sentenceCase(row.work_description), 120),
          tag: /WRECKING/.test(row.permit_type) ? "Demolition" : "",
        })),
      };
    },

    async requests(ward, days) {
      const where = `ward='${Number(ward)}' AND created_date > '${isoDaysAgo(days)}' AND sr_type != '311 INFORMATION ONLY CALL'`;
      const [top, total] = await Promise.all([
        portal("v6vf-nfxy", { $select: "sr_type,count(*) as n", $where: where, $group: "sr_type", $order: "n DESC", $limit: "5" }),
        portal("v6vf-nfxy", { $select: "count(*) as n", $where: where }),
      ]);
      return {
        count: Number(total[0]?.n || 0),
        bars: top.map((row) => ({ label: row.sr_type.replace(/ Complaint$/, "").replace(/^Buildings - /, ""), n: Number(row.n) })),
      };
    },

    async elections() {
      const upcoming = ELECTIONS.filter((e) => new Date(e.date).getTime() > Date.now());
      return {
        count: upcoming.length,
        badge: upcoming[0] ? monthDay(upcoming[0].date) : "",
        items: upcoming.map((e) => {
          const away = Math.ceil((new Date(e.date).getTime() - Date.now()) / 864e5);
          return { date: monthDay(e.date), title: `${e.title}, ${new Date(e.date).getFullYear()}`, meta: `${e.meta}. ${away} days away.` };
        }),
      };
    },
  };

  // --- The email ---

  function mailRows(items) {
    const shown = items.slice(0, 5);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${shown.map((item) => `
      <tr>
        <td class="m-date" style="${M.date}">${esc(item.date)}</td>
        <td style="${M.cell}">${item.href
          ? `<a href="${esc(item.href)}" style="${M.title}">${esc(item.title)}</a>`
          : `<span style="${M.title}">${esc(item.title)}</span>`}${item.tag ? `<span style="${M.tag}">${esc(item.tag)}</span>` : ""}
          ${item.meta ? `<div style="${M.meta}">${esc(item.meta)}</div>` : ""}
        </td>
      </tr>`).join("")}</table>${items.length > shown.length ? `<p style="${M.empty}">And ${items.length - shown.length} more.</p>` : ""}`;
  }

  function mailBars(bars) {
    const max = Math.max(1, ...bars.map((bar) => bar.n));
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:12px;">${bars.map((bar) => `
      <tr>
        <td style="${M.barLabel}">${esc(bar.label)}
          <div style="height:6px;border-radius:3px;background:#e8e8ed;margin-top:5px;"><div style="height:6px;border-radius:3px;background:#0071e3;width:${Math.round(bar.n / max * 100)}%;"></div></div>
        </td>
        <td style="${M.barNum}">${bar.n}</td>
      </tr>`).join("")}</table>`;
  }

  function windowWords(freq) {
    return freq === "monthly" ? { now: "this month", next: "in the next 30 days", span: 30 } : { now: "this week", next: "in the next 7 days", span: 7 };
  }

  function sectionInner(topic, state, freq, preview) {
    const words = windowWords(freq);
    const when = topic.ahead ? words.next : words.now;
    let count = "";
    let body;
    if (!state || state.status === "loading") {
      body = preview
        ? `<span class="skel" style="width:78%"></span><span class="skel" style="width:52%"></span><span class="skel" style="width:64%"></span>`
        : "";
    } else if (state.status === "error") {
      body = `<p style="${M.empty}">This section couldn't load right now.</p>`;
    } else if (topic.id === "requests") {
      count = state.count ? `${state.count.toLocaleString()} ${when}` : "";
      body = state.bars.length ? mailBars(state.bars) : `<p style="${M.empty}">${esc(topic.empty.replace(/\.$/, ""))} ${when}.</p>`;
    } else if (!state.items.length) {
      body = `<p style="${M.empty}">${esc(topic.empty.replace(/\.$/, ""))}${topic.id === "elections" ? "" : ` ${when}`}.</p>`;
    } else {
      count = topic.id === "elections" ? "" : `${state.count} ${when}`;
      body = mailRows(state.items);
    }
    return `<div style="${M.section}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="${M.h2}">${esc(topic.label)}</td>
          <td align="right" style="${M.count}">${esc(count)}</td>
        </tr></table>
        <div style="padding-top:6px;">${body}</div>
      </div>`;
  }

  function summaryText(view) {
    const words = windowWords(view.freq);
    const on = TOPICS.filter((topic) => view.on.has(topic.id) && topic.noun);
    if (on.some((topic) => !view.data[topic.id] || view.data[topic.id].status === "loading")) return null;
    const parts = on
      .map((topic) => ({ topic, n: view.data[topic.id].status === "ready" ? view.data[topic.id].count : 0 }))
      .filter((part) => part.n > 0)
      .map(({ topic, n }) => `${n.toLocaleString()} ${topic.noun[n === 1 ? 0 : 1]}`);
    if (!parts.length) return { text: `A quiet ${words.now.replace("this ", "")} in the topics you follow.`, subject: `a quiet ${words.now.replace("this ", "")}` };
    const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items[0]);
    return { text: `${list(parts)}.`.replace(/^./, (c) => c.toUpperCase()), subject: list(parts.slice(0, 2)) };
  }

  function subjectLine(view) {
    const summary = summaryText(view);
    if (!summary) return null;
    return `Ward ${Number(view.ward)} ${windowWords(view.freq).now}: ${summary.subject}`;
  }

  function rangeLabel(freq) {
    const days = windowWords(freq).span;
    const fmt = (d) => d.toLocaleDateString("en-US", { ...CHICAGO_TIME, month: "short", day: "numeric" });
    return `${fmt(new Date(Date.now() - days * 864e5))} to ${fmt(new Date())}`;
  }

  function alderInner(alder, ward) {
    if (!alder) return `<span class="skel" style="width:40%"></span><span class="skel" style="width:65%"></span>`;
    const phone = ((alder.ward_office || {}).phone || "").split("/")[0].trim();
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${alder.photo_url ? `<td style="width:56px;vertical-align:top;"><img src="${esc(alder.photo_url)}" width="44" height="44" alt="" style="border-radius:22px;display:block;object-fit:cover;"></td>` : ""}
        <td style="vertical-align:top;">
          <div style="font-size:13px;color:#6e6e73;">Your alderperson, Ward ${Number(ward)}</div>
          <div style="font-size:16px;font-weight:600;color:#1d1d1f;margin:2px 0 4px;">${esc(alder.name || "Not listed")}</div>
          <div style="font-size:14px;">${[
            alder.email ? `<a href="mailto:${esc(alder.email)}" style="${M.link}">Email</a>` : "",
            phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ""))}" style="${M.link}">${esc(phone)}</a>` : "",
          ].filter(Boolean).join(`<span style="color:#d2d2d7;"> &nbsp;|&nbsp; </span>`)}</div>
        </td>
      </tr></table>`;
  }

  // preview=true: every topic is drawn (hidden ones collapsed) so toggles can animate, and
  // loading parts show placeholders. preview=false: only chosen topics, as it would be sent.
  function emailHtml(view, preview) {
    const words = windowWords(view.freq);
    const summary = summaryText(view);
    const origin = window.location.origin;
    const sections = TOPICS
      .filter((topic) => preview || view.on.has(topic.id))
      .map((topic) => `<div data-sec="${topic.id}"${preview ? ` class="sec${view.on.has(topic.id) ? "" : " off"}"` : ""}><div>${sectionInner(topic, view.data[topic.id], view.freq, preview)}</div></div>`)
      .join("");
    return `<div class="m-page" style="${M.page}">
      <table role="presentation" cellpadding="0" cellspacing="0" class="m-card" style="${M.card}">
        <tr><td class="m-pad" style="padding:24px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td><img src="${origin}/static/logo-email.png" width="28" height="28" alt="" style="vertical-align:middle;margin-right:6px;"><span style="${M.brand}">Ward Wise</span></td>
            <td align="right"><span style="${M.pill}">Ward ${Number(view.ward)}</span></td>
          </tr></table>
        </td></tr>
        <tr><td class="m-pad" style="padding:28px 28px 20px;">
          <p style="${M.eyebrow}">${esc(rangeLabel(view.freq))}</p>
          <h1 style="${M.h1}">${words.now.replace(/^./, (c) => c.toUpperCase())} in Ward ${Number(view.ward)}</h1>
          <p style="${M.summary}" data-summary>${summary ? esc(summary.text) : (preview ? `<span class="skel" style="width:85%"></span>` : "")}</p>
        </td></tr>
        ${preview || view.urgent ? `<tr><td class="m-pad" style="padding:0 28px;"><div data-sec="urgent"${preview ? ` class="sec${view.urgent ? "" : " off"}"` : ""}><div><div style="padding-bottom:20px;"><div style="${M.note}">Same-day alerts are on. When a zoning change in Ward ${Number(view.ward)} gets a hearing date, we'll email you that day.</div></div></div></div></td></tr>` : ""}
        <tr><td class="m-pad" style="padding:0 28px;">${sections}</td></tr>
        <tr><td class="m-pad" style="padding:12px 28px 0;"><div style="${M.alder}" data-alder>${alderInner(view.alder, view.ward)}</div></td></tr>
        <tr><td class="m-pad" style="${M.foot}">
          You're getting this because you asked for Ward ${Number(view.ward)} alerts on Ward Wise.<br>
          <a href="${origin}/alerts" style="${M.link}">Change your alerts</a> &nbsp;|&nbsp; <a href="${origin}/alerts" style="${M.link}">Unsubscribe</a><br><br>
          Records from the Office of the City Clerk and the Chicago Data Portal.<br>Built by volunteers at Chi Hack Night.
        </td></tr>
      </table>
    </div>`;
  }

  // Phones: less padding around the card. Clients that ignore this still get the desktop layout.
  const MAIL_CSS = "@media (max-width: 520px) { .m-page { padding: 12px 0 !important; } .m-card { border-radius: 0 !important; } .m-pad { padding-left: 18px !important; padding-right: 18px !important; } .m-date { width: 50px !important; } }";

  const PREVIEW_CSS = `
    :host { display: block; }
    a:hover { text-decoration: underline !important; }
    .sec { display: grid; grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 0.45s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0.3s ease; }
    .sec > div { min-height: 0; overflow: hidden; }
    .sec.off { grid-template-rows: 0fr; opacity: 0; }
    .skel { animation: sh 1.4s ease infinite; background: linear-gradient(90deg, #f0f0f3 25%, #e4e4e9 37%, #f0f0f3 63%); background-size: 400% 100%; border-radius: 6px; display: block; height: 12px; margin: 8px 0; }
    @keyframes sh { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
    .fresh { animation: rise 0.45s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    @media (prefers-reduced-motion: reduce) { .sec { transition: none; } .skel, .fresh { animation: none; } }
  `;

  // --- The page ---

  function storedManageToken() {
    try {
      return sessionStorage.getItem("wardwise:alerts-manage");
    } catch (_error) {
      return null;
    }
  }

  function initAlertBuilder() {
    const root = document.getElementById("fd-alert-builder");
    if (!root) return;
    const my = window.WardWiseMyWard;
    const form = root.querySelector("#fd-alert-form");
    const topicList = root.querySelector("[data-fd-ab-topics]");
    const wardNode = root.querySelector("[data-fd-ab-ward]");
    const seg = root.querySelector("[data-fd-ab-freq]");
    const urgentBox = root.querySelector("[data-fd-ab-urgent]");
    const emailInput = form.elements.email;
    const note = root.querySelector("#fd-alert-note");
    const host = root.querySelector("[data-fd-ab-email]");
    const toNode = root.querySelector("[data-fd-mail-to]");
    const subjectNode = root.querySelector("[data-fd-mail-subject]");
    const shadow = host.attachShadow({ mode: "open" });

    let prefs = null;
    try { prefs = JSON.parse(localStorage.getItem(ALERT_PREFS) || "null"); } catch (_error) { /* defaults */ }
    const view = {
      ward: my ? my.get() : null,
      freq: prefs?.freq === "monthly" ? "monthly" : "weekly",
      urgent: Boolean(prefs?.urgent),
      on: new Set(Array.isArray(prefs?.topics) ? prefs.topics : TOPICS.filter((t) => t.on).map((t) => t.id)),
      data: {},
      alder: null,
    };
    let run = 0;

    function save() {
      try {
        localStorage.setItem(ALERT_PREFS, JSON.stringify({ topics: [...view.on], freq: view.freq, urgent: view.urgent }));
      } catch (_error) {
        /* private mode: choices last for this visit */
      }
    }

    // Controls
    topicList.innerHTML = TOPICS.map((topic) => `
      <li>
        <label class="fd-ab-topic">
          <span class="fd-ab-icon">${topic.icon}</span>
          <span class="fd-ab-text"><strong>${esc(topic.label)}</strong><small>${esc(topic.hint)}</small></span>
          <span class="fd-ab-count" data-fd-ab-count="${topic.id}" aria-hidden="true"></span>
          <input type="checkbox" role="switch" class="fd-switch" name="topics" value="${topic.id}"${view.on.has(topic.id) ? " checked" : ""}>
        </label>
      </li>`).join("");
    urgentBox.checked = view.urgent;
    seg.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === view.freq)));

    function moveThumb() {
      const active = seg.querySelector('[aria-pressed="true"]');
      if (!active || !active.offsetWidth) return;
      seg.classList.add("has-thumb");
      seg.style.setProperty("--seg-x", `${active.offsetLeft}px`);
      seg.style.setProperty("--seg-w", `${active.offsetWidth}px`);
    }
    requestAnimationFrame(moveThumb);
    window.addEventListener("resize", moveThumb);

    function paintCount(topicId) {
      const node = topicList.querySelector(`[data-fd-ab-count="${topicId}"]`);
      const state = view.data[topicId];
      let text = "";
      if (!view.ward) text = "";
      else if (!state || state.status === "loading") text = "…";
      else if (state.status === "ready") text = state.badge != null ? state.badge : String(state.count.toLocaleString());
      if (node.textContent === text) return;
      node.textContent = text;
      node.classList.toggle("is-zero", text === "0");
      node.classList.toggle("is-wait", text === "…");
      if (text && text !== "…" && !REDUCED) {
        node.classList.remove("is-pop");
        void node.offsetWidth;
        node.classList.add("is-pop");
      }
    }

    function paintWard() {
      wardNode.innerHTML = view.ward
        ? `<strong>Ward ${Number(view.ward)}</strong><span data-fd-ab-alder>${view.alder?.name ? esc(view.alder.name) : ""}</span><button type="button" class="fd-link-btn" data-fd-change-ward>Change</button>`
        : `<button type="button" class="fd-btn fd-btn-ghost" data-fd-change-ward>Choose your ward</button>`;
    }

    function paintHead() {
      const subject = view.ward ? subjectLine(view) : null;
      if (!view.ward) subjectNode.textContent = "Your ward this week";
      else if (!subject) subjectNode.innerHTML = `<span class="fd-skel fd-skel-line" style="width: 70%"></span>`;
      else if (subjectNode.textContent !== subject) {
        subjectNode.textContent = subject;
        subjectNode.classList.remove("fd-swap-text");
        void subjectNode.offsetWidth;
        subjectNode.classList.add("fd-swap-text");
      }
      const summaryNode = shadow.querySelector("[data-summary]");
      const summary = summaryText(view);
      if (summaryNode && summary && summaryNode.textContent !== summary.text) {
        summaryNode.textContent = summary.text;
        summaryNode.classList.remove("fresh");
        void summaryNode.offsetWidth;
        summaryNode.classList.add("fresh");
      }
    }

    function paintSection(topicId) {
      const topic = TOPICS.find((t) => t.id === topicId);
      const node = shadow.querySelector(`[data-sec="${topicId}"] > div`);
      if (!node) return;
      node.innerHTML = sectionInner(topic, view.data[topicId], view.freq, true);
      node.firstElementChild?.classList.add("fresh");
    }

    function drawEmail() {
      if (!view.ward) {
        shadow.innerHTML = "";
        host.classList.add("is-empty");
        let slot = host.parentElement.querySelector(".fd-ab-noward");
        if (!slot) {
          slot = document.createElement("div");
          slot.className = "fd-ab-noward";
          host.after(slot);
        }
        slot.innerHTML = `<p class="fd-body">Choose your ward to see the email you'd get.</p><div data-fd-ab-picker></div>`;
        if (my) my.mountInline(slot.querySelector("[data-fd-ab-picker]"));
        return;
      }
      host.classList.remove("is-empty");
      host.parentElement.querySelector(".fd-ab-noward")?.remove();
      shadow.innerHTML = `<style>${PREVIEW_CSS}${MAIL_CSS}</style>${emailHtml(view, true)}`;
    }

    function load() {
      const token = ++run;
      const days = windowWords(view.freq).span;
      view.data = {};
      TOPICS.forEach((topic) => paintCount(topic.id));
      drawEmail();
      paintHead();
      if (!view.ward) return;
      const ward = view.ward;
      TOPICS.forEach((topic) => {
        view.data[topic.id] = { status: "loading" };
        paintCount(topic.id);
        remember(`${topic.id}:${ward}:${days}`, () => LOADERS[topic.id](ward, days))
          .then((result) => ({ status: "ready", ...result }))
          .catch((error) => ({ status: "error", message: error.message }))
          .then((state) => {
            if (token !== run) return;
            view.data[topic.id] = state;
            paintCount(topic.id);
            paintSection(topic.id);
            paintHead();
          });
      });
    }

    function loadAlder() {
      view.alder = null;
      paintWard();
      if (!view.ward) return;
      const ward = view.ward;
      api.fetchWardDetails(ward).then(({ alderperson }) => {
        if (ward !== view.ward) return;
        view.alder = alderperson || {};
        paintWard();
        const node = shadow.querySelector("[data-alder]");
        if (node) {
          node.innerHTML = alderInner(view.alder, ward);
          node.classList.add("fresh");
        }
      }).catch(() => {
        view.alder = {};
      });
    }

    // Events
    topicList.addEventListener("change", (event) => {
      const box = event.target.closest("input[name=topics]");
      if (!box) return;
      if (box.checked) view.on.add(box.value);
      else view.on.delete(box.value);
      shadow.querySelector(`[data-sec="${box.value}"]`)?.classList.toggle("off", !box.checked);
      paintHead();
      save();
    });

    seg.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button || button.dataset.value === view.freq) return;
      view.freq = button.dataset.value;
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      moveThumb();
      save();
      load();
    });

    urgentBox.addEventListener("change", () => {
      view.urgent = urgentBox.checked;
      shadow.querySelector('[data-sec="urgent"]')?.classList.toggle("off", !view.urgent);
      save();
    });

    emailInput.addEventListener("input", () => {
      toNode.textContent = emailInput.value.trim() || "you@example.com";
    });

    wardNode.addEventListener("click", (event) => {
      if (event.target.closest("[data-fd-change-ward]") && my) {
        event.stopPropagation();
        my.open();
      }
    });

    document.addEventListener("fd:myward", (event) => {
      if (event.detail.ward === view.ward) return;
      view.ward = event.detail.ward;
      loadAlder();
      load();
    });

    root.querySelector("[data-fd-ab-open]").addEventListener("click", () => {
      if (!view.ward) return;
      const subject = subjectLine(view) || `Ward ${Number(view.ward)} alerts`;
      const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title><style>${MAIL_CSS}</style></head><body style="margin:0;background:#f5f5f7;">${emailHtml(view, false)}</body></html>`;
      window.open(URL.createObjectURL(new Blob([doc], { type: "text/html" })), "_blank");
    });

    // Sign-up and manage. A new address gets a confirmation email first (double opt-in); links in
    // that email and in every alert come back here with ?m=<token> to change or stop alerts. The
    // head script (templates/_analytics_head.html) lifts the token out of the address bar before
    // analytics loads and keeps it for this tab, so it is read from there.
    const params = new URLSearchParams(window.location.search);
    let manageToken = params.get("m") || window.WardWiseManageToken || storedManageToken();
    const submitButton = root.querySelector("[data-fd-ab-submit]");
    const emailLabel = root.querySelector("[data-fd-ab-email-label]");
    const privacy = root.querySelector("[data-fd-ab-privacy]");
    const unsubscribeButton = root.querySelector("[data-fd-ab-unsubscribe]");
    // penlight_site.SITE_FLAGS.alerts_sending, via <body data-alerts-sending>. Until alerts launch, every
    // message says so: sign-ups are real (an early list) but no alert email goes out yet.
    const sending = document.body.dataset.alertsSending === "true";
    const FLASH = {
      confirmed: sending
        ? "You're confirmed. Your alerts start with the next email."
        : "You're confirmed and on the early list. Alerts are still in testing, so nothing is sent yet; your first alert goes out when they launch.",
      unsubscribed: "You're unsubscribed. No more alert emails will be sent.",
      expired: "That link has expired or isn't valid. Sign up again below and we'll send a fresh one.",
      suppressed: "Email to this address keeps bouncing, so alerts are paused. Sign up again with another address.",
    };
    const say = (text, ok) => { note.textContent = text; note.classList.toggle("fd-ab-note-ok", Boolean(ok)); };
    if (FLASH[params.get("alerts")]) say(FLASH[params.get("alerts")], params.get("alerts") === "confirmed");
    // The sign-up steps, each counted with the ward the alerts are for.
    const step = (action, extra = {}) => api.track(action, { ward: view.ward || undefined, ...extra });
    // Counted once: the flag comes off the address so a reload or bookmark doesn't count it again.
    // With a manage link too, wait for the settings so the count carries the alerts' ward.
    const confirmed = params.get("alerts") === "confirmed";
    if (confirmed) {
      const url = new URL(window.location.href);
      url.searchParams.delete("alerts");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
      if (!manageToken) step("alert_signup_confirmed");
    }
    // Sign-up only (a bad manage link falls back to sign-up later), each once per visit.
    let started = false;
    let chosen = false;
    form.addEventListener("focusin", () => {
      if (manageToken || started) return;
      started = true;
      step("alert_signup_started");
    });
    topicList.addEventListener("change", () => {
      if (manageToken || chosen) return;
      chosen = true;
      step("alert_topics_chosen", { topics: view.on.size });
    });

    function whenFirst() {
      return view.freq === "monthly" ? "on the first Monday of next month" : "next Monday";
    }

    function syncControls() {
      topicList.querySelectorAll("input[name=topics]").forEach((box) => { box.checked = view.on.has(box.value); });
      urgentBox.checked = view.urgent;
      seg.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === view.freq)));
      moveThumb();
    }

    function enterManageMode(prefs) {
      emailInput.value = prefs.email;
      emailInput.readOnly = true;
      emailInput.required = false;
      emailLabel.textContent = "Alerts for";
      toNode.textContent = prefs.email;
      submitButton.textContent = prefs.status === "unsubscribed" ? "Turn alerts back on" : "Save changes";
      privacy.hidden = true;
      unsubscribeButton.hidden = prefs.status === "unsubscribed";
      view.on = new Set(prefs.topics);
      view.freq = prefs.frequency;
      view.urgent = Boolean(prefs.urgent_zoning);
      syncControls();
      save();
      if (prefs.ward && prefs.ward !== view.ward) {
        view.ward = prefs.ward;
        paintWard();
        loadAlder();
        load();
      }
      if (prefs.status === "unsubscribed" && !params.get("alerts")) say(FLASH.unsubscribed);
    }

    async function alertsApi(path, body) {
      const response = await fetch(path, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Something went wrong. Try again in a few minutes.");
      return data;
    }

    if (manageToken) {
      alertsApi(`/api/alerts/preferences?m=${encodeURIComponent(manageToken)}`)
        .then((prefs) => {
          enterManageMode(prefs);
          if (confirmed) step("alert_signup_confirmed");
        })
        .catch((error) => {
          // A bad or expired link: forget it, so "Sign up again below" signs up.
          try { sessionStorage.removeItem("wardwise:alerts-manage"); } catch (_error) { /* nothing stored */ }
          manageToken = null;
          if (confirmed) step("alert_signup_confirmed");
          say(error.message);
        });
    }

    unsubscribeButton.addEventListener("click", async () => {
      try {
        const prefs = await alertsApi(`/api/alerts/preferences?m=${encodeURIComponent(manageToken)}`, { unsubscribe: true });
        enterManageMode(prefs);
        say(FLASH.unsubscribed);
        step("alert_managed", { change: "unsubscribed" });
      } catch (error) {
        say(error.message);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!view.ward) {
        say("Choose your ward first.");
        if (my) my.open();
        return;
      }
      if (!view.on.size) {
        say("Turn on at least one topic.");
        return;
      }
      if (!manageToken && !emailInput.checkValidity()) {
        showFieldError(emailInput);
        return;
      }
      const prefs = { ward: view.ward, topics: [...view.on], frequency: view.freq, urgent: view.urgent };
      submitButton.disabled = true;
      try {
        if (manageToken) {
          const saved = await alertsApi(`/api/alerts/preferences?m=${encodeURIComponent(manageToken)}`, prefs);
          enterManageMode(saved);
          step("alert_managed", { change: "saved", topics: view.on.size });
          say(sending ? `Saved. Your next email goes out ${whenFirst()}.`
            : "Saved. Alerts are still in testing, so nothing is sent yet; your first alert goes out when they launch.", true);
        } else {
          await alertsApi("/api/alerts/subscribe", { ...prefs, email: emailInput.value.trim(), website: form.elements.website.value });
          step("alert_signup_submitted", { topics: view.on.size, frequency: view.freq });
          say(sending ? `Check ${emailInput.value.trim()} for a confirmation email. Click its link and your first alert goes out ${whenFirst()}.`
            : `Check ${emailInput.value.trim()} for a confirmation email. Click its link to join the early list. Alerts are still in testing, so your first alert goes out when they launch.`, true);
        }
      } catch (error) {
        say(error.message);
      } finally {
        submitButton.disabled = false;
      }
    });

    paintWard();
    loadAlder();
    load();
  }

  // --- Scroll reveals -----------------------------------------------------------------

  // Sections below the fold rise in as they arrive. The primary content right under each hero
  // (map, report card, forms) is left alone so it never waits on an animation.
  function initReveal() {
    const targets = [...document.querySelectorAll(".fd-theme main > section.fd-section > .fd-wrap > *, .fd-split-bar, .fd-figures")]
      .filter((el) => !el.closest("[data-fd-explore], [data-fd-report]"));
    const figures = [...document.querySelectorAll(".fd-figure strong")];
    if (!("IntersectionObserver" in window) || REDUCED) {
      targets.forEach((el) => el.classList.add("is-visible"));
      return;
    }
    targets.forEach((el) => {
      if (el.classList.contains("fd-split-bar")) return;
      el.classList.add("fd-reveal");
      const index = [...el.parentElement.children].indexOf(el);
      el.style.setProperty("--reveal-delay", `${Math.min(index, 4) * 80}ms`);
    });
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
        if (entry.target.classList.contains("fd-figures")) {
          figures.forEach((el) => {
            const to = Number(el.textContent.replace(/[^\d.]/g, ""));
            countUp(el, to, (v) => String(Math.round(v)), 1100);
          });
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
    targets.forEach((el) => observer.observe(el));
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-fd-report]").forEach(initReport);
    initExplore();
    initCounts();
    initDownloads();
    initHousing();
    initDues();
    initJoin();
    initCivic();
    initAlertBuilder();
    initReveal();
  });

  window.WardWiseFrontDoor = { tierFor, standing, TIERS };
})();
