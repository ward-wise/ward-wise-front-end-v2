// Shared by the metric pages (relationship, deep dive, driver and impact analysis): the catalog load, area
// markers, the "what is this metric?" block, the correlation statistics and their plain-English
// reading, and the pieces of the over-time evidence (grade chip, checklist).
// Each page is its own template and script now; this is the part they had in common.
window.WardWiseMetricPages = (function () {
  "use strict";

  const api = window.WardWiseExplorer || {};
  const esc = api.escapeHtml || ((v) => String(v));
  const fmt = api.formatNumber || ((v) => (v == null ? "—" : String(Math.round(v * 100) / 100)));

  const AREA_TYPES = ["ward", "community_area", "chi"];

  function areaWord(t) {
    return t === "ward" ? "wards" : t === "chi" ? "χGRIDs" : "neighborhoods";
  }

  function areaParam(value) {
    return AREA_TYPES.includes(value) ? value : "ward";
  }

  // --- catalog + markers --------------------------------------------------------------------
  async function loadCatalog() {
    const payload = await api.fetchMetrics();
    const catalog = (payload.metrics || []).slice().sort((a, b) => (a.label || "").localeCompare(b.label || ""));
    return {
      catalog,
      labels: Object.fromEntries(catalog.map((m) => [m.metric_id, m.label || m.metric_id])),
      byId: Object.fromEntries(catalog.map((m) => [m.metric_id, m])),
      allIds: catalog.map((m) => m.metric_id),
    };
  }

  async function loadMarkers() {
    const markers = { ward: {}, community_area: {}, chi: {} };
    try {
      const resp = (await api.fetchExplorerWards?.()) ?? (await api.fetchJson("/api/explorer/wards", ""));
      const wards = Array.isArray(resp) ? resp : resp?.wards || [];
      for (const w of wards) {
        markers.ward[String(w.ward_id)] = {
          number: w.ward_number ?? w.ward_id,
          image: w.visual_signifier?.image_url || null,
        };
      }
    } catch (e) { /* numbers-only fallback */ }
    try {
      const resp = (await api.fetchCommunityAreas?.()) ?? (await api.fetchJson("/api/community-areas", ""));
      const list = Array.isArray(resp) ? resp : resp?.community_areas || [];
      for (const c of list) {
        markers.community_area[String(c.community_area_id)] = {
          number: c.community_area_number ?? c.community_area_id,
          image: c.visual_signifier?.image_url || null,
        };
      }
    } catch (e) { /* numbers-only fallback */ }
    try {
      const resp = await api.fetchJson("/api/chis", "");
      const list = Array.isArray(resp) ? resp : resp?.chis || [];
      // chis are plain dots on the scatter (no number/photo) — the title still names them.
      for (const c of list) markers.chi[String(c.chi_id)] = { number: null, image: null };
    } catch (e) { /* plain dots */ }
    return markers;
  }

  function fillSelect(select, catalog, defaultId) {
    if (!select) return;
    select.innerHTML = catalog
      .map((m) => `<option value="${esc(m.metric_id)}">${esc(m.label || m.metric_id)}</option>`)
      .join("");
    if (defaultId) select.value = defaultId;
  }

  // Geography toggle: three buttons, one active; the callback gets the area type.
  function wireToggle(id, onChange) {
    const group = document.getElementById(id);
    if (!group) return;
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-area-type]");
      if (!button) return;
      group.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b === button));
      onChange(button.dataset.areaType);
    });
  }

  function setToggle(id, areaType) {
    document.querySelectorAll(`#${id} button`).forEach((b) =>
      b.classList.toggle("is-active", b.dataset.areaType === areaType),
    );
  }

  // The page's state lives in the query string, so every view is a shareable link.
  function writeQuery(params) {
    const q = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
    history.replaceState(null, "", `${location.pathname}${q.toString() ? `?${q}` : ""}`);
  }

  async function copyShareLink(button) {
    WardWiseExplorer.track("report_shared", { how: "copy_link" });
    try {
      await navigator.clipboard.writeText(location.href);
      button.textContent = "Link copied ✓";
    } catch (e) {
      button.textContent = location.href;
    }
    setTimeout(() => { button.textContent = "Copy share link"; }, 2000);
  }

  // --- metric metadata, humanized for the "what is this metric?" section --------------------
  function humanizeCategory(c) {
    if (!c) return "";
    return c.replace(/_/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());
  }

  function unitLabel(u) {
    return ({
      percent: "Percent",
      currency: "Dollars",
      count: "Count",
      rate: "Rate",
      ratio: "Ratio",
      miles: "Miles",
      score: "Score",
      days: "Days",
      acres_per_10000: "Acres per 10,000 residents",
    })[u] || (u ? humanizeCategory(u) : "");
  }

  function directionLabel(d) {
    if (d === "higher") return "Higher is better";
    if (d === "lower") return "Lower is better";
    return "";
  }

  function chip(text) {
    return text ? `<span class="deepdive-chip">${esc(text)}</span>` : "";
  }

  function metricAbout(m) {
    const lead = m.description || m.methodology || "";
    const showMethod = m.methodology && m.methodology !== m.description;
    return `
      <p class="deepdive-about">${esc(lead)}</p>
      ${showMethod ? `<p class="deepdive-line"><span class="deepdive-line-label">How it's measured</span> ${esc(m.methodology)}</p>` : ""}
      ${m.calculation ? `<p class="deepdive-line"><span class="deepdive-line-label">How it's computed</span> ${esc(m.calculation)}</p>` : ""}
      <div class="deepdive-chips">
        ${chip(unitLabel(m.unit))}
        ${chip(directionLabel(m.direction))}
        ${chip(humanizeCategory(m.category))}
        ${m.source ? chip(`Source: ${m.source}`) : ""}
      </div>`;
  }

  function methodologyBlock(ids, byId) {
    const cards = ids
      .map((id) => {
        const m = byId[id] || {};
        const src = m.source_url
          ? `<a href="${esc(m.source_url)}" rel="noopener">${esc(m.source || "source")}</a>`
          : esc(m.source || "");
        // "Explore" is a partner site showing the underlying records, not where the number
        // came from — kept on its own line so the credit lands on the right project.
        const explore = m.explore?.url
          ? `<a href="${esc(m.explore.url)}" target="_blank" rel="noopener noreferrer">${esc(m.explore.label || "more detail")}</a>`
          : "";
        return `<div class="metric-method-card">
          <p class="metric-method-name">${esc(m.label || id)}</p>
          <p class="metric-method-text">${esc(m.methodology || m.description || "")}</p>
          ${src ? `<p class="metric-method-src">Source: ${src}</p>` : ""}
          ${explore ? `<p class="metric-method-src">Explore further: ${explore}</p>` : ""}
        </div>`;
      })
      .join("");
    return `<div class="metric-methodology"><p class="metric-method-head">How these are measured</p>${cards}</div>`;
  }

  // --- stats ----------------------------------------------------------------------------------
  function pearson(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of points) {
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const cov = n * sxy - sx * sy;
    const dx = Math.sqrt(n * sxx - sx * sx);
    const dy = Math.sqrt(n * syy - sy * sy);
    if (dx === 0 || dy === 0) return null;
    return cov / (dx * dy);
  }

  // --- the lag grid: every area-year at gaps of −5..+5 years ----------------------------------
  // series = /api/metrics/pair-series: {areas, x: {y0, v: [[value|null per year] per area]}, y: …,
  // agreement: {gaps: [{k, n, n_years, same, r, quads, p, sig, null_mean, null_band, ci, by_year,
  // r_by_year}]}}. k > 0 reads Y k years after X; k < 0 reads it before (X is the later one).
  // The API computes every number shown for "changes" (shared/civic_data/dynamics.py
  // agreement_profile: same-direction share, area-shuffle p, year-bootstrap range, effective N); this
  // only lays out the points to draw. "changes" are the statistics' own year-adjusted change (the
  // year-over-year difference minus that year's mean across areas: faster or slower than the city),
  // so the zero lines split each panel into moved-the-same-way and moved-opposite-ways. "levels"
  // plots the values themselves, split at each panel's medians: descriptive only, no test.
  const LAG_GAPS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

  function yearAdjustedChanges(rows) {
    const d = rows.map((row) => row.map((v, t) => (t > 0 && v != null && row[t - 1] != null ? v - row[t - 1] : null)));
    const T = Math.max(0, ...d.map((row) => row.length));
    for (let t = 0; t < T; t += 1) {
      let sum = 0, n = 0;
      for (const row of d) if (row[t] != null) { sum += row[t]; n += 1; }
      if (n) for (const row of d) if (row[t] != null) row[t] -= sum / n;
    }
    return d;
  }

  function medianOf(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function quadCounts(pts, cx, cy) {
    const quads = { both_up: 0, x_up_y_down: 0, x_down_y_up: 0, both_down: 0, tie: 0 };
    for (const d of pts) {
      const sx = Math.sign(d.x - cx), sy = Math.sign(d.y - cy);
      if (!sx || !sy) quads.tie += 1;
      else quads[sx > 0 ? (sy > 0 ? "both_up" : "x_up_y_down") : (sy > 0 ? "x_down_y_up" : "both_down")] += 1;
    }
    return quads;
  }

  function lagPanels(series, mode = "changes") {
    const xs = series?.x, ys = series?.y;
    if (!xs?.v || !ys?.v) return null;
    const levels = mode === "levels";
    const X = levels ? xs.v : yearAdjustedChanges(xs.v), Y = levels ? ys.v : yearAdjustedChanges(ys.v);
    const areas = series.areas || [];
    const server = Object.fromEntries((series.agreement?.gaps || []).map((g) => [g.k, g]));
    return LAG_GAPS.map((k) => {
      const pts = [];
      areas.forEach((area, a) => {
        (X[a] || []).forEach((xv, t) => {
          if (xv == null) return;
          const year = xs.y0 + t, ty = year + k - ys.y0;
          const yv = ty >= 0 ? Y[a]?.[ty] : null;
          if (yv != null) pts.push({ area, year, x: xv, y: yv });
        });
      });
      const g = server[k];
      if (!levels && g) return { ...g, k, pts, cx: 0, cy: 0 };
      // levels (descriptive), or an API that predates the agreement statistics
      const cx = levels && pts.length ? medianOf(pts.map((d) => d.x)) : 0;
      const cy = levels && pts.length ? medianOf(pts.map((d) => d.y)) : 0;
      const quads = quadCounts(pts, cx, cy);
      const decided = pts.length - quads.tie;
      const years = pts.map((d) => d.year);
      return {
        k, pts, n: pts.length, cx, cy, quads, p: null, sig: false,
        r: pts.length >= 10 ? pearson(pts.map((d) => [d.x, d.y])) : null,
        same: decided ? (quads.both_up + quads.both_down) / decided : null,
        years: years.length ? [Math.min(...years), Math.max(...years)] : null,
      };
    });
  }

  // Spearman's ρ = Pearson on the ranks. Catches any monotonic relationship — including curved/log
  // ones a straight-line Pearson r understates — so a big ρ-vs-r gap flags a non-linear tie.
  function rank(values) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j < order.length && order[j][0] === order[i][0]) j += 1;
      const avg = (i + j + 1) / 2; // average rank for ties (1-based)
      for (let k = i; k < j; k += 1) ranks[order[k][1]] = avg;
      i = j;
    }
    return ranks;
  }

  function spearman(points) {
    if (points.length < 2) return null;
    const rx = rank(points.map((p) => p[0]));
    const ry = rank(points.map((p) => p[1]));
    return pearson(rx.map((r, i) => [r, ry[i]]));
  }

  function regression(points) {
    const n = points.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of points) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const slope = (n * sxy - sx * sy) / denom;
    return { slope, intercept: (sy - slope * sx) / n };
  }

  // Below this |r| we call it "no relationship" and hide the trend line — a line through an
  // essentially random cloud reads as a pattern that isn't there. Set at 0.05 so |r| = 0.10 still
  // reads as a (weak) relationship while true noise reads as none.
  const NEGLIGIBLE_R = 0.05;

  function strengthBand(a) {
    return a < NEGLIGIBLE_R ? 0 : a < 0.3 ? 1 : a < 0.5 ? 2 : a < 0.7 ? 3 : 4;
  }

  function bareStrength(a) {
    return ["no", "a weak", "a moderate", "a strong", "a very strong"][strengthBand(a)];
  }

  function correlationWord(r) {
    const a = Math.abs(r);
    // "no relationship" carries no direction — "no negative relationship" is self-contradictory.
    if (a < NEGLIGIBLE_R) return "no relationship";
    return `${bareStrength(a)} ${r >= 0 ? "positive" : "negative"} relationship`;
  }

  // Pearson describes the linear tie; Spearman (ρ) the monotonic one. When ρ is materially
  // stronger, the relationship is real but curved — say so rather than let the weak linear r
  // read as "barely related."
  function correlationSentence(r, rho, yLabel, xLabel, n, areaType) {
    const areas = `${n} ${areaWord(areaType)}`;
    const monotonic =
      rho != null && strengthBand(Math.abs(rho)) > strengthBand(Math.abs(r)) && Math.abs(rho) - Math.abs(r) >= 0.1;
    if (!monotonic) {
      return `${esc(yLabel)} shows ${correlationWord(r)} with ${esc(xLabel)} across ${areas}.`;
    }
    const linear = Math.abs(r) < NEGLIGIBLE_R ? "no linear relationship" : `${bareStrength(Math.abs(r))} linear relationship`;
    return `${esc(yLabel)} shows ${linear} with ${esc(xLabel)}, but the stronger rank correlation (ρ) points to a non-linear one, across ${areas}.`;
  }

  // Links carry the geography only when the reader chose one; otherwise each page opens on the
  // geography that suits its measures (the API's default_area_type).
  function withArea(path, params, areaType) {
    const q = new URLSearchParams(params);
    if (areaType) q.set("area", areaType);
    return `${path}?${q}`;
  }
  const relationshipUrl = (xId, yId, areaType) => withArea("/reports/relationship", { x: xId, y: yId }, areaType);
  const comparisonUrl = relationshipUrl; // the comparison page became the relationship page
  const deepDiveUrl = (metricId, areaType) => withArea("/reports/deep-dive", { metric: metricId }, areaType);
  const driversUrl = (metricId, areaType) => withArea("/reports/drivers", { metric: metricId }, areaType);
  const causalUrl = driversUrl; // the causal report became the driver analysis
  const impactUrl = (metricId, areaType) => withArea("/reports/impact", { metric: metricId }, areaType);

  // --- grouped picker -------------------------------------------------------------------------
  // One <optgroup> per wellbeing domain, so 270 measures read as eleven short lists.
  function fillGroupedSelect(select, catalog, defaultId) {
    if (!select) return;
    const groups = new Map();
    for (const m of catalog) {
      const key = m.category || "other";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    select.innerHTML = [...groups.entries()]
      .sort((a, b) => humanizeCategory(a[0]).localeCompare(humanizeCategory(b[0])))
      .map(([key, list]) => `<optgroup label="${esc(humanizeCategory(key))}">${list
        .map((m) => `<option value="${esc(m.metric_id)}">${esc(m.label || m.metric_id)}</option>`).join("")}</optgroup>`)
      .join("");
    if (defaultId) select.value = defaultId;
  }

  // The redesign's segmented pill (.fd-seg) with aria-pressed and the sliding thumb.
  function setSeg(id, value) {
    const seg = document.getElementById(id);
    if (!seg) return;
    let active = null;
    seg.querySelectorAll("button[data-value]").forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute("aria-pressed", String(on));
      if (on) active = b;
    });
    if (active) {
      seg.classList.add("has-thumb");
      seg.style.setProperty("--seg-x", `${active.offsetLeft}px`);
      seg.style.setProperty("--seg-w", `${active.offsetWidth}px`);
    }
  }

  function wireSeg(id, onChange) {
    const seg = document.getElementById(id);
    seg?.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button || button.getAttribute("aria-pressed") === "true") return;
      setSeg(id, button.dataset.value);
      onChange(button.dataset.value);
    });
  }

  // --- scatter points with each area's photo / number, and the reader's own ward -----------
  const REPORT_SLUG = { ward: "ward", community_area: "neighborhood", chi: "chi" };

  function scatterPoints(rows, xId, yId, areaType, markers) {
    const pts = [];
    for (const row of rows || []) {
      const x = row.values?.[xId], y = row.values?.[yId];
      if (x == null || y == null) continue;
      const id = String(row.area_id);
      const marker = markers?.[areaType]?.[id] || {};
      const name = row.display_name || id;
      pts.push({
        id, name, x, y,
        image: marker.image || null,
        glyph: areaType === "community_area" ? String(name).trim().charAt(0).toUpperCase() : String(marker.number ?? id).replace(/^0/, ""),
        href: `/report/${REPORT_SLUG[areaType]}/${encodeURIComponent(id)}`,
      });
    }
    return pts;
  }

  // Wards are the only geography a reader picks in the header; highlight it on ward charts.
  function myAreaId(areaType, ward) {
    const w = ward ?? window.WardWiseMyWard?.get?.();
    return areaType === "ward" && w ? String(w) : null;
  }

  // --- the answer, in words -----------------------------------------------------------------
  // "Where X is higher, Y tends to be higher": the cross-section read as a sentence a resident
  // can repeat, with the statistics after it rather than in front of it.
  function answerSentence(r, rho, xLabel, yLabel, n, areaType) {
    const areas = `${n} ${areaWord(areaType)}`;
    if (r == null) return `Not enough ${areaWord(areaType)} have both measures to compare.`;
    if (Math.abs(r) < NEGLIGIBLE_R && !(rho != null && Math.abs(rho) >= 0.3)) {
      return `Across ${areas}, ${esc(yLabel)} doesn't track ${esc(xLabel)}: places high on one are no more likely to be high on the other.`;
    }
    const lead = Math.abs(r) >= NEGLIGIBLE_R ? r : rho;
    const dir = lead >= 0 ? "higher" : "lower";
    return `Where ${esc(xLabel)} is higher, ${esc(yLabel)} tends to be ${dir}: ${correlationWord(lead)} across ${areas}.`;
  }

  // --- over-time evidence: grade + checklist ----------------------------------------------
  // Graded evidence, never a "causes" verdict (Harry, 2026-10-13). The API computes the grade;
  // these only render it.
  const GRADE_TEXT = {
    none: ["We can't tell", "The two don't move together within places over time, so the data can't say whether one affects the other."],
    weak: ["Weak evidence", "They move together within places, but nothing yet separates one driving the other from both following something else."],
    suggestive: ["Suggestive evidence", "They move together, and the timing and other checks lean toward the first measure moving before the second."],
    moderate: ["Moderate evidence", "They move together, the first tends to move first, the pattern survives the likeliest other explanation, and there are enough sharp changes to compare against."],
  };

  function gradeChip(grade) {
    const [label] = GRADE_TEXT[grade] || GRADE_TEXT.none;
    return `<span class="rel-grade rel-grade-${esc(grade || "none")}">${esc(label)}</span>`;
  }

  function gradeSentence(grade) {
    return esc((GRADE_TEXT[grade] || GRADE_TEXT.none)[1]);
  }

  // Each check carries `detail` (the numbers), `why` (in words: why it failed, or what holds it up)
  // and sometimes `caveat` (a pass that rests on one year). A failed check always says why, so a
  // reader can see what kept a pair's grade down; passes keep to the numbers. labelFor turns the
  // metric ids the API puts in the common-factor check ("Survives controlling for poverty_pct") into
  // their names.
  function checklist(items, labelFor = null) {
    if (!items?.length) return "";
    const named = (text, c) => (labelFor && c.z?.length
      ? c.z.reduce((acc, id) => acc.split(id).join(labelFor(id)), text || "") : text);
    return `<ul class="rel-checklist">${items.map((c) => `
      <li class="${c.pass ? "is-pass" : "is-fail"}">
        <span class="rel-check" aria-hidden="true">${c.pass ? "✓" : "–"}</span>
        <span><strong>${esc(named(c.label, c))}</strong>${c.detail ? ` <span class="rel-check-detail">${esc(named(c.detail, c))}</span>` : ""}
          ${!c.pass && c.why ? `<span class="rel-check-why">${esc(named(c.why, c))}</span>` : ""}
          ${c.caveat ? `<span class="rel-check-caveat">${esc(named(c.caveat, c))}</span>` : ""}</span>
      </li>`).join("")}</ul>`;
  }

  async function fetchJsonOrNull(url) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      return response.ok ? response.json() : null;
    } catch (_e) {
      return null;
    }
  }

  return {
    esc, fmt, areaWord, areaParam, loadCatalog, loadMarkers, fillSelect, wireToggle, setToggle,
    writeQuery, copyShareLink, metricAbout, methodologyBlock,
    pearson, spearman, regression, NEGLIGIBLE_R, lagPanels, LAG_GAPS, correlationSentence, comparisonUrl, deepDiveUrl,
    relationshipUrl, causalUrl, driversUrl, impactUrl, fillGroupedSelect, setSeg, wireSeg, scatterPoints, myAreaId,
    answerSentence, gradeChip, gradeSentence, checklist, fetchJsonOrNull, humanizeCategory, REPORT_SLUG,
  };
})();
