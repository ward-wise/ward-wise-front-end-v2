window.WardWiseExplorer = {
  // Pure year-honesty math shared by the explorer and the Reports views. Callers supply a ctx
  // built from the manifest: {metricDataYears, forwardCarryYears, timeInvariantMetrics (Set),
  // metricValidFrom}. Semantics mirror the explorer exactly: a vintage carries forward
  // forwardCarryYears but never back; time-invariant facts apply from their valid_from; a change
  // window requires an actual remeasurement between its endpoints.
  yearMath: {
    hasValueForYear(ctx, metricId, target) {
      const years = (ctx.metricDataYears[metricId] || []).map(Number);
      if (years.some((m) => m <= target && target - m <= ctx.forwardCarryYears)) return true;
      if (ctx.timeInvariantMetrics.has(metricId)) {
        const validFrom = ctx.metricValidFrom[metricId];
        return validFrom == null || target >= validFrom;
      }
      return false;
    },
    latestMeasurementFor(ctx, metricId, target) {
      const years = (ctx.metricDataYears[metricId] || []).map(Number);
      const usable = years.filter((m) => m <= target && target - m <= ctx.forwardCarryYears);
      return usable.length ? Math.max(...usable) : null;
    },
    deltaExclusionReason(ctx, metricId, from, to) {
      if (ctx.timeInvariantMetrics.has(metricId)) return "constant by definition";
      const a = this.latestMeasurementFor(ctx, metricId, from);
      const b = this.latestMeasurementFor(ctx, metricId, to);
      if (a == null && b == null) return "no data in this window";
      if (a == null) {
        const first = Math.min(...(ctx.metricDataYears[metricId] || []).map(Number));
        return `not measured until ${first}`;
      }
      if (b == null) return "no data at the end year";
      if (a === b) return `single ${a} vintage — not remeasured in this window`;
      return null;
    },
  },

  // Shared hover-tooltip placement for the SVG timeline charts (explorer composite, ward-report
  // character charts): follow the pointer inside the container, clamped so the tooltip never
  // clips at the right/top edge.
  positionTimelineTooltip(event, tooltip, container) {
    const bounds = container.getBoundingClientRect();
    const x = event.clientX - bounds.left + 12;
    const y = event.clientY - bounds.top + 12;
    tooltip.style.left = `${Math.max(8, Math.min(x, bounds.width - 190))}px`;
    tooltip.style.top = `${Math.max(8, y)}px`;
  },

  // Single safe entry point for analytics events. WardWiseAnalytics (static/analytics.js, loaded in
  // every page's <head>) sends each one to Google Analytics and PostHog with the visitor's ward.
  // Never let analytics throw into the app.
  track(action, params = {}) {
    try {
      if (window.WardWiseAnalytics) window.WardWiseAnalytics.track(action, params);
    } catch (_error) {
      /* analytics is best-effort */
    }
  },

  async fetchWards() {
    return this.fetchJson("/api/wards", "Unable to load wards.");
  },

  async fetchExplorerWards() {
    return this.fetchJson("/api/explorer/wards", "Unable to load wards.");
  },

  async fetchWardGeojson() {
    return this.fetchJson("/api/wards.geojson", "Unable to load ward geometry.");
  },

  async fetchWardDetails(wardId) {
    return this.fetchJson(`/api/wards/${wardId}`, "Unable to load ward details.");
  },

  async fetchWardPlaces(wardId) {
    return this.fetchJson(`/api/wards/${wardId}/places`, "Unable to load places of interest.");
  },

  async fetchWardCommunityAreas(wardId) {
    return this.fetchJson(
      `/api/wards/${wardId}/community-areas`,
      "Unable to load community areas.",
    );
  },

  async fetchCommunityAreas() {
    return this.fetchJson("/api/community-areas", "Unable to load community areas.");
  },

  async fetchCommunityAreaGeojson() {
    return this.fetchJson("/api/community-areas.geojson", "Unable to load neighborhood geometry.");
  },

  async fetchChis() {
    return this.fetchJson("/api/chis", "Unable to load chis.");
  },

  async fetchChigridGeojson() {
    return this.fetchJson("/api/chigrid.geojson", "Unable to load chi geometry.");
  },

  // Precincts are a lens on one ward: pass its id to load only that ward's precincts.
  async fetchPrecincts(wardId) {
    const query = wardId ? `?ward=${encodeURIComponent(wardId)}` : "";
    return this.fetchJson(`/api/precincts${query}`, "Unable to load precincts.");
  },

  async fetchPrecinctGeojson(wardId) {
    const query = wardId ? `?ward=${encodeURIComponent(wardId)}` : "";
    return this.fetchJson(`/api/precincts.geojson${query}`, "Unable to load precinct geometry.");
  },

  async fetchMetrics() {
    return this.fetchJson("/api/metrics", "Unable to load metrics.");
  },

  async fetchExplorerManifest() {
    return this.fetchJson("/api/explorer/manifest", "Unable to load metrics.");
  },

  async fetchScores(weights, areaType = "ward", year = null) {
    const params = this.weightParams(weights);
    if (areaType && areaType !== "ward") params.set("area_type", areaType);
    if (year) params.set("year", year);
    const query = params.toString();
    return this.fetchJson(
      `/api/metrics/scores${query ? `?${query}` : ""}`,
      "Unable to load metric scores.",
    );
  },

  async fetchDelta(metricId, fromYear, toYear, areaType = "ward") {
    const params = new URLSearchParams();
    params.set("metric_id", metricId);
    params.set("from_year", fromYear);
    params.set("to_year", toYear);
    if (areaType && areaType !== "ward") params.set("area_type", areaType);
    return this.fetchJson(
      `/api/metrics/delta?${params.toString()}`,
      "Unable to load change-over-time data.",
    );
  },

  async fetchScoreDetails(areaId, weights, areaType = "ward") {
    const params = this.weightParams(weights);
    params.set("ward_id", areaId);
    if (areaType && areaType !== "ward") {
      params.set("area_type", areaType);
      params.set("area_id", areaId);
    }
    return this.fetchJson(
      `/api/metrics/scores/details?${params.toString()}`,
      "Unable to load metric score details.",
    );
  },

  // The API takes the metric list as one comma-joined GET parameter, and its proxy answers 414 once
  // the URL passes ~8 KB (about 290 ids is already over). Split the list into requests that stay well
  // under that, run them in parallel, and merge so callers still see a single response.
  async fetchMetricChunks(path, metricIds, params, message, merge) {
    const MAX_ENCODED = 3000;
    const chunks = [];
    let current = [];
    let size = 0;
    for (const id of metricIds || []) {
      const cost = encodeURIComponent(id).length + 3; // +3 for the encoded comma
      if (current.length && size + cost > MAX_ENCODED) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(id);
      size += cost;
    }
    if (current.length || !chunks.length) chunks.push(current);
    const results = await Promise.all(
      chunks.map((ids) => {
        const q = new URLSearchParams();
        if (ids.length) q.set("metrics", ids.join(","));
        for (const [key, value] of params) q.set(key, value);
        return this.fetchJson(`${path}?${q.toString()}`, message);
      }),
    );
    return results.length === 1 ? results[0] : merge(results);
  },

  async fetchComparison(metricIds, areaType = "ward") {
    const params = areaType ? [["area_type", areaType]] : [];
    return this.fetchMetricChunks("/api/metrics/comparison", metricIds, params, "Unable to load comparison data.", (parts) => {
      // Every chunk lists the same areas; fold each area's values together.
      const rows = new Map();
      for (const part of parts) {
        for (const row of part.rows || []) {
          const key = `${row.area_type}:${row.area_id}`;
          const have = rows.get(key);
          if (have) Object.assign(have.values, row.values);
          else rows.set(key, { ...row, values: { ...row.values } });
        }
      }
      return { ...parts[0], metrics: parts.flatMap((part) => part.metrics || []), rows: [...rows.values()] };
    });
  },

  async fetchTimeline({ metricIds = [], areaType = "ward", areaId, wardId } = {}) {
    const params = [];
    if (areaType) params.push(["area_type", areaType]);
    if (areaId) params.push(["area_id", areaId]);
    if (wardId && areaType === "precinct") params.push(["ward", wardId]);
    return this.fetchMetricChunks("/api/metrics/timeline", metricIds, params, "Unable to load history.", (parts) => {
      // A series' values line up with its own response's snapshot list, and each chunk's list only
      // covers that chunk's metrics. Build the union, then re-place every series onto it (null = not measured).
      // One response lists snapshots oldest first; keep that order across chunks so charts don't zigzag.
      const byId = new Map();
      for (const part of parts) {
        for (const snap of part.snapshots || []) if (!byId.has(snap.snapshot_id)) byId.set(snap.snapshot_id, snap);
      }
      const when = (snap) => `${snap.period_end || snap.collected_at || ""}|${snap.snapshot_id}`;
      const union = [...byId.values()].sort((a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0));
      const slot = new Map(union.map((snap, i) => [snap.snapshot_id, i]));
      const series = [];
      for (const part of parts) {
        const snaps = part.snapshots || [];
        for (const item of part.series || []) {
          const values = new Array(union.length).fill(null);
          (item.values || []).forEach((value, i) => {
            if (snaps[i]) values[slot.get(snaps[i].snapshot_id)] = value;
          });
          series.push({ ...item, values });
        }
      }
      return { ...parts[0], series, snapshots: union };
    });
  },

  async fetchTimeseries({ metricId, areaType = "ward", areaId } = {}) {
    const params = new URLSearchParams();
    if (metricId) params.set("metric_id", metricId);
    if (areaType) params.set("area_type", areaType);
    if (areaId) params.set("area_id", areaId);
    return this.fetchJson(`/api/metrics/timeseries?${params.toString()}`, "Unable to load history.");
  },

  async submitMetricRecommendation(payload) {
    return this.postJson(
      "/api/metric-recommendations",
      payload,
      "Unable to send your recommendation.",
    );
  },

  async submitMetricSelectionEvent(payload) {
    return this.postJson(
      "/api/metric-selection-events",
      payload,
      "Unable to record metric selection.",
    );
  },

  async fetchMetricRecommendations() {
    return this.fetchJson(
      "/api/metric-recommendations",
      "Unable to load metric recommendations.",
    );
  },

  async fetchMetricSubmissions() {
    return this.fetchJson(
      "/api/metric-submissions",
      "Unable to load metric submissions.",
    );
  },

  async updateMetricSubmission(submissionId, payload) {
    return this.patchJson(
      `/api/metric-submissions/${encodeURIComponent(submissionId)}`,
      payload,
      "Unable to update metric submission.",
    );
  },

  async fetchAccessUsers() {
    return this.fetchJson("/api/admin/users", "Unable to load people with access.");
  },

  async addAccessUser(payload) {
    return this.postJson("/api/admin/users", payload, "Unable to save access.");
  },

  async deleteAccessUser(email) {
    return this.deleteJson(
      `/api/admin/users/${encodeURIComponent(email)}`,
      "Unable to remove access.",
    );
  },

  async fetchApiKeys() {
    return this.fetchJson("/api/admin/api-keys", "Unable to load API keys.");
  },

  async createApiKey(payload) {
    return this.postJson("/api/admin/api-keys", payload, "Unable to create the key.");
  },

  async revokeApiKey(keyId) {
    return this.deleteJson(`/api/admin/api-keys/${encodeURIComponent(keyId)}`, "Unable to revoke the key.");
  },

  async fetchAdminMetricMetadata() {
    return this.fetchJson(
      "/api/admin/metrics/metadata",
      "Unable to load metric metadata.",
    );
  },

  async updateAdminMetricMetadata(metricId, payload) {
    return this.patchJson(
      `/api/admin/metrics/${encodeURIComponent(metricId)}/metadata`,
      payload,
      "Unable to update metric metadata.",
    );
  },

  async fetchJson(url, errorMessage) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(errorMessage);
    }
    return response.json();
  },

  async postJson(url, payload, errorMessage) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  async deleteJson(url, errorMessage) {
    const response = await fetch(url, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  async patchJson(url, payload, errorMessage) {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const validationMessage = this.formatValidationErrors(data.fields);
      throw new Error(validationMessage || data.error || errorMessage);
    }
    return data;
  },

  formatValidationErrors(fields) {
    if (!fields || typeof fields !== "object") return "";
    return Object.values(fields).filter(Boolean).join(" ");
  },

  weightQuery(weights) {
    const params = this.weightParams(weights);
    const query = params.toString();
    return query ? `?${query}` : "";
  },

  weightParams(weights) {
    const params = new URLSearchParams();
    Object.entries(weights || {}).forEach(([metricId, weight]) => {
      params.set(`weight_${metricId}`, weight);
    });
    return params;
  },

  escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },

  formatNumber(value, options = {}) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return "No data";
    return new Intl.NumberFormat(undefined, options).format(numericValue);
  },

  formatMetricValue(value, metric) {
    if (value === null || value === undefined) return "No data";
    if (metric?.unit === "rating") {
      return this.formatNumber(value, { maximumFractionDigits: 2 });
    }
    if (metric?.unit === "percent") {
      return `${this.formatNumber(value, { maximumFractionDigits: 1 })}%`;
    }
    if (metric?.unit === "currency") {
      return this.formatNumber(value, {
        maximumFractionDigits: 0,
        style: "currency",
        currency: "USD",
      });
    }
    if (metric?.unit === "miles") {
      return `${this.formatNumber(value, { maximumFractionDigits: 2 })} mi`;
    }
    if (metric?.unit === "rate_per_10000") {
      return `${this.formatNumber(value, { maximumFractionDigits: 1 })} per 10k`;
    }
    if (metric?.unit === "degrees_c") {
      return `${this.formatNumber(value, { maximumFractionDigits: 1 })} °C`;
    }
    return this.formatNumber(value, { maximumFractionDigits: 1 });
  },

  // The value with its unit spelled out, for places where the number stands alone and the reader
  // has to know what it counts ("0.2 (unitless index)", "3.4 days", "12.1 per 10k residents").
  formatMetricValueWithUnit(value, metric) {
    if (value === null || value === undefined) return "No data";
    const unit = String(metric?.unit || "");
    const id = String(metric?.metric_id || "");
    const num = (digits) => this.formatNumber(value, { maximumFractionDigits: digits });
    if (unit === "percent") return `${num(1)}%`;
    if (unit === "currency" || unit === "USD") return this.formatMetricValue(value, { unit: "currency" });
    if (unit === "rating") return `${num(2)} stars`;
    if (unit === "miles") return `${num(2)} miles`;
    if (unit === "degrees_c") return `${num(1)} °C`;
    if (unit === "days") return `${num(1)} ${Number(value) === 1 ? "day" : "days"}`;
    if (unit === "minutes") return `${num(1)} minutes`;
    if (unit === "rate_per_10000" || unit === "per_10000" || unit === "per 10k residents") return `${num(1)} per 10k residents`;
    if (unit === "acres_per_10000") return `${num(1)} acres per 10k residents`;
    if (unit === "count") return `${num(0)} in total`;
    if (unit === "index") return `${num(2)} (unitless index)`;
    if (unit === "score") return `${num(1)} (source's own score)`;
    if (unit === "ratio" && /miles_per_sq_mi/.test(id)) return `${num(1)} miles per sq mi`;
    if (unit === "rate" && /per_sqkm$/.test(id)) return `${num(1)} per sq km`;
    if (unit === "rate" && /per_household$/.test(id)) return `${num(2)} per household`;
    if (unit === "rate" || unit === "ratio") return `${num(2)} (${unit})`;
    return unit ? `${num(1)} ${unit}` : num(1);
  },

  formatCategory(category) {
    return this.escapeHtml(String(category || "").replaceAll("_", " "));
  },

  formatDate(value) {
    if (!value) return "Not recorded";
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  },

  formatDateTime(value) {
    if (!value) return "Not recorded";
    return new Date(value).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  },

  formatPercentOneDecimal(value, hasNonZeroSource = false) {
    const numericValue = Number(value);
    const safeValue = Number.isFinite(numericValue) ? numericValue : 0;
    if ((safeValue > 0 && safeValue < 0.1) || (safeValue === 0 && hasNonZeroSource)) {
      return "<0.1%";
    }
    return `${safeValue.toFixed(1)}%`;
  },

  renderWardProfile({ ward, alderperson, wardPlaces, communityAreas }) {
    return `
      <div class="panel-heading">
        <p class="eyebrow">Selected ward</p>
        <h2>${this.escapeHtml(ward.display_name)}</h2>
      </div>
      ${this.renderAlderpersonCard(alderperson || ward.alderperson)}
      ${this.renderWardNotes(ward)}
      ${this.renderPlaceSummary(wardPlaces || ward.poi_summary)}
      ${this.renderCommunitySummary(communityAreas || ward.community_area_overlaps)}
    `;
  },

  renderAlderpersonCard(alderperson) {
    if (!alderperson) {
      return "<p>No alderperson profile is available yet.</p>";
    }
    const photo = alderperson.photo_url
      ? `<img class="alder-photo" src="${this.escapeHtml(alderperson.photo_url)}" alt="${this.escapeHtml(alderperson.name)}">`
      : "";
    const website = alderperson.website_url
      ? `<a class="profile-link" href="${this.escapeHtml(alderperson.website_url)}" target="_blank" rel="noreferrer">Official website</a>`
      : "";
    return `
      <section class="alder-card">
        ${photo}
        <div>
          <p class="eyebrow">Alderperson</p>
          <h3>${this.escapeHtml(alderperson.name)}</h3>
          <p>${this.escapeHtml(alderperson.title)}</p>
          ${website}
        </div>
      </section>
    `;
  },

  renderWardNotes(ward) {
    const labels = ward.neighborhood_labels?.length
      ? `<p><strong>Neighborhood notes:</strong> ${ward.neighborhood_labels
          .map((label) => this.escapeHtml(label))
          .join(", ")}</p>`
      : "";
    const profile = ward.profile ? `<p>${this.escapeHtml(ward.profile)}</p>` : "";
    if (!labels && !profile) return "";
    return `
      <section class="ward-notes">
        <p class="eyebrow">Ward notes</p>
        ${labels}
        ${profile}
      </section>
    `;
  },

  renderPlaceSummary(wardPlaces) {
    const counts = Object.entries(wardPlaces?.counts_by_category || {});
    const chips = counts.length
      ? counts
          .map(
            ([category, count]) =>
              `<span class="metric-chip">${this.formatCategory(category)}: ${this.formatNumber(count)}</span>`,
          )
          .join("")
      : "<span class=\"metric-chip\">No mapped places yet</span>";
    return `
      <section>
        <p class="eyebrow">Mapped places</p>
        <h3>${this.formatNumber(wardPlaces?.total_count || 0)} places of interest</h3>
        <div class="metric-chip-list">${chips}</div>
      </section>
    `;
  },

  renderCommunitySummary(overlaps) {
    const communityAreas = Array.isArray(overlaps) ? overlaps : overlaps?.community_areas || [];
    if (!communityAreas.length) {
      return `
        <section>
          <p class="eyebrow">Community areas</p>
          <p>No community-area overlap data yet.</p>
        </section>
      `;
    }
    return `
      <section>
        <p class="eyebrow">Community areas</p>
        <div class="overlap-list">
          ${communityAreas.slice(0, 5).map((area) => this.renderCommunityAreaOverlap(area)).join("")}
        </div>
      </section>
    `;
  },

  renderCommunityAreaOverlap(area) {
    const wardPct = Number(area.ward_area_pct || 0);
    const overlapAreaSqFt = Number(area.overlap_area_sq_ft || 0);
    return `
      <article class="overlap-row">
        <div>
          <strong>${this.escapeHtml(area.name || "Community area")}</strong>
          <span>${this.formatPercentOneDecimal(wardPct, overlapAreaSqFt > 0)} of this ward</span>
        </div>
        <div class="overlap-bar" aria-hidden="true">
          <span style="width: ${Math.min(100, Math.max(0, wardPct))}%"></span>
        </div>
      </article>
    `;
  },
};
