// What changed over time: one area, every dated measure, read between two years.
//
// Two columns — moved the right way, moved the wrong way — each row carrying the two anchored
// readings, a small sparkline and any honesty flags; a neutral block for what the ward office
// decided (wards only); and a paragraph counting everything the window could not honestly read
// as movement, by reason. The rules are the ones written down in the redesign's README, mapped
// onto Penlight's manifest fields:
//   direction unknown disqualifies · a measurement change is not a trend · office decisions are
//   not verdicts · anchors, not exact years · bounded scores move in points · small bases and
//   running registers are flagged and sorted last · the 2023 redraw is disclosed.
//
// create(ctx) — ctx is read live (getters welcome):
//   manifest, metrics (catalog rows for this geography), areaType, areaId, areas, idOf(area),
//   label, noun, plural, remapYears, terms (null | /api/aldermanic-terms payload),
//   slices ({yearKey: slice}), loadSlice(yearKey) -> Promise<slice>, root() -> element,
//   dictionaryBase, initialWindow ({from, to, cats} | null), onState({from, to, cats})
window.WardWiseReportChanges = (function () {
  "use strict";

  const CHANGE_FLOOR_YEAR = 2015;
  const esc = (t) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  // A change in how something is counted reads as a cliff. Windows that straddle the break are
  // set aside; a window inside one era still compares like with like.
  const MEASUREMENT_BREAKS = [
    { test: (id) => id.startsWith("c311_"), year: 2019, note: "the 311 system changed in December 2018" },
  ];

  // Decisions made in the ward office (the term report's "level" set): reported in their own
  // neutral block on wards, never as a verdict on the neighborhood, and set aside elsewhere
  // because the ward-level figure was only apportioned onto the smaller geography.
  const OFFICE_METRIC_IDS = new Set([
    "council_attendance_pct", "nonroutine_bills_sponsored_current_session", "participatory_budgeting",
    "menu_budget_utilization", "menu_active_transport_share", "menu_project_diversity",
    "menu_spending_spread", "menu_streets_share", "menu_lighting_share", "menu_sidewalks_share",
    "menu_alleys_share", "menu_parks_share", "menu_cameras_share", "menu_schools_share",
  ]);

  const WARD_STAMPED = new Set(["direct_ward", "license_ward_field"]);

  function humanizeDomain(category) {
    return (category || "other").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }

  function unitKind(metric) {
    const unit = String(metric.unit || "").toLowerCase();
    if (unit === "percent") return "percent";
    if (/score|index|rating/.test(unit)) return "bounded";
    if (/per_?10|rate/.test(unit)) return "rate";
    if (/currency|usd|dollar/.test(unit)) return "money";
    if (/mile|day|hour|minute/.test(unit)) return "measure";
    return "count";
  }

  function fmtValue(value, metric) {
    return WardWiseExplorer.formatMetricValue(value, metric);
  }

  function create(ctx) {
    const state = {
      series: null,        // Map(metric_id -> {points:[{year,value}], dropped:{partial,forward}, rampIn, live})
      status: "idle",
      window: null,        // {from, to}
      cats: new Set(),     // active domain filters (empty = all)
      open: new Set(),     // open disclosures, by metric id
      peers: "idle",       // idle | loading | ready | failed
      host: null,
      error: null,
    };

    const metricsById = () => {
      if (!state._byId) state._byId = new Map((ctx.metrics || []).map((m) => [m.metric_id, m]));
      return state._byId;
    };
    const coverageOf = (id) => (ctx.manifest.coverage || {})[id] || {};
    const methodologyOf = (id) => ((ctx.manifest.metric_methodology || {})[ctx.areaType] || {})[id] || [];
    const provenanceOf = (id) => ((ctx.manifest.metric_provenance || {}).metrics || ctx.manifest.metric_provenance || {})[id] || {};

    // ---- series ----

    async function load() {
      state.status = "loading";
      state.error = null;
      const ids = (ctx.metrics || []).map((m) => m.metric_id);
      let data;
      try {
        data = await WardWiseExplorer.fetchTimeline({ metricIds: ids, areaType: ctx.areaType, areaId: ctx.areaId });
      } catch (error) {
        state.status = "error";
        state.error = error;
        return;
      }
      state.series = reshape(data);
      state.status = "ready";
      if (!state.window) {
        const initial = ctx.initialWindow;
        state.window = pickWindow(initial?.from, initial?.to);
        if (initial?.cats?.length) state.cats = new Set(initial.cats);
      }
    }

    function reshape(data) {
      const snapshots = data.snapshots || [];
      const currentYear = new Date().getFullYear();
      const today = new Date().toISOString().slice(0, 10);
      const out = new Map();
      for (const series of data.series || []) {
        if (String(series.area_id) !== String(ctx.areaId)) continue;
        const byYear = new Map();
        let anyValue = false;
        (series.values || []).forEach((value, i) => {
          if (!Number.isFinite(value)) return;
          anyValue = true;
          const end = snapshots[i]?.period_end;
          if (!end) return;
          byYear.set(Number(String(end).slice(0, 4)), value);   // later stamps win: the array is in collected order
        });
        const dropped = { partial: 0, forward: 0 };
        let points = [...byYear.entries()].map(([year, value]) => ({ year, value })).sort((a, b) => a.year - b.year);
        const before = points.length;
        points = points.filter((p) => p.year < currentYear);          // the year in progress
        dropped.partial += before - points.length;
        const coverage = coverageOf(series.metric_id);
        if (coverage.latest_period_end && String(coverage.latest_period_end) > today && points.length) {
          const stampYear = Number(String(coverage.latest_period_end).slice(0, 4));
          if (points[points.length - 1].year === stampYear) {
            points.pop();
            dropped.forward += 1;
          }
        }
        if (coverage.latest_metadata?.partial_year && coverage.latest_period_end && points.length) {
          const stampYear = Number(String(coverage.latest_period_end).slice(0, 4));
          if (points[points.length - 1].year === stampYear) {
            points.pop();
            dropped.partial += 1;
          }
        }
        const rampIn = trimRampIn(points);
        if (rampIn) points = points.filter((p) => p.year >= rampIn);
        out.set(series.metric_id, { points, dropped, rampIn, live: !byYear.size && anyValue });
      }
      return out;
    }

    // A series that starts thin (a register filling in, a feed switched on mid-year) reads as a
    // boom. Trim the run-up: everything before the first reading at 60% of the later median.
    function trimRampIn(points) {
      if (points.length < 4) return null;
      const values = points.map((p) => p.value);
      if (values.every((v, i) => i === 0 || v >= values[i - 1])) return null;   // a register, flagged later
      const reference = median(values.slice(Math.floor(values.length / 2)));
      if (!(reference > 0)) return null;
      const first = values.findIndex((v) => v >= 0.6 * reference);
      return first > 0 ? points[first].year : null;
    }

    function seriesFor(id) {
      return state.series?.get(id) || null;
    }

    function localCtx() {
      const m = ctx.manifest;
      const years = {};
      for (const [id, entry] of state.series || []) years[id] = entry.points.map((p) => p.year);
      return {
        metricDataYears: years,
        forwardCarryYears: m.forward_carry_years ?? 3,
        timeInvariantMetrics: new Set(m.time_invariant_metrics || []),
        metricValidFrom: m.metric_valid_from || {},
      };
    }

    function latestFullYear() {
      let latest = CHANGE_FLOOR_YEAR;
      for (const entry of state.series?.values() || []) {
        for (const p of entry.points) if (p.year > latest) latest = p.year;
      }
      return latest;
    }

    function allYears() {
      const years = new Set();
      for (const entry of state.series?.values() || []) for (const p of entry.points) if (p.year >= CHANGE_FLOOR_YEAR) years.add(p.year);
      return [...years].sort((a, b) => a - b);
    }

    function pickWindow(from, to) {
      const last = latestFullYear();
      let a = Number.isFinite(Number(from)) && from ? Number(from) : null;
      let b = Number.isFinite(Number(to)) && to ? Number(to) : null;
      if (a == null || b == null) return defaultWindow();
      if (a > b) [a, b] = [b, a];
      a = Math.max(CHANGE_FLOOR_YEAR, Math.min(a, last));
      b = Math.max(CHANGE_FLOOR_YEAR, Math.min(b, last));
      if (a === b) return defaultWindow();
      return { from: a, to: b };
    }

    function defaultWindow() {
      const to = latestFullYear();
      return { from: Math.max(CHANGE_FLOOR_YEAR, to - 8), to };
    }

    // ---- classification ----

    function excluded(metric, reason, extra = {}) {
      return { metric, kind: "excluded", reason, ...extra };
    }

    function classify(id, window_) {
      const metric = metricsById().get(id);
      const entry = seriesFor(id);
      if (!metric) return null;
      if (!entry || entry.live) return excluded(metric, entry ? "no dated history" : "no history for this area");
      if (metric.direction !== "higher" && metric.direction !== "lower") return excluded(metric, "no stated direction");
      const isOffice = OFFICE_METRIC_IDS.has(id);
      if (isOffice && ctx.areaType !== "ward") return excluded(metric, `a ward-office decision, apportioned onto this ${ctx.noun}`);
      const local = localCtx();
      const math = WardWiseExplorer.yearMath;
      if (entry.points.length < 2 && !local.timeInvariantMetrics.has(id)) return excluded(metric, "measured once so far");
      const reason = math.deltaExclusionReason(local, id, window_.from, window_.to);
      if (reason) return excluded(metric, reason);
      const a = math.latestMeasurementFor(local, id, window_.from);
      const b = math.latestMeasurementFor(local, id, window_.to);
      for (const brk of MEASUREMENT_BREAKS) {
        if (brk.test(id) && a < brk.year && brk.year <= b) return excluded(metric, `measurement changed (${brk.note})`);
      }
      const fromValue = entry.points.find((p) => p.year === a)?.value;
      const toValue = entry.points.find((p) => p.year === b)?.value;
      if (!Number.isFinite(fromValue) || !Number.isFinite(toValue)) return excluded(metric, "no data at both ends");

      const kind = unitKind(metric);
      const bounded = kind === "percent" || kind === "bounded";
      const delta = toValue - fromValue;
      const sameSign = fromValue !== 0 && Math.sign(fromValue) === Math.sign(toValue || fromValue);
      const pct = !bounded && sameSign ? (delta / Math.abs(fromValue)) * 100 : null;
      const move = metric.direction === "lower" ? -delta : delta;
      const flatAbs = bounded ? 0.5 : null;
      const flat = bounded ? Math.abs(delta) < flatAbs : pct != null ? Math.abs(pct) < 1 : delta === 0;
      const verdict = flat ? "flat" : move > 0 ? "improved" : "worsened";
      const inWindow = entry.points.filter((p) => p.year >= a && p.year <= b);
      const peak = Math.max(...entry.points.map((p) => Math.abs(p.value)), 1e-9);
      const flags = [];

      // low start: a big percentage off a tiny base
      const absFloor = kind === "count" ? Math.abs(fromValue) < 10 : kind === "rate" ? Math.abs(fromValue) < 5 : kind === "percent" ? Math.abs(fromValue) < 2 : false;
      const lowStart = (pct != null && Math.abs(pct) >= 40 && (absFloor || Math.abs(fromValue) / peak < 0.5))
        || (pct == null && !bounded && fromValue === 0 && toValue !== 0);
      if (lowStart) flags.push({ key: "low-start", label: "low start", title: `Starts from ${fmtValue(fromValue, metric)}: a large change off a small base.` });

      // running register: a count that only ever grows is a list filling in, not momentum
      const monotone = inWindow.length >= 5 && inWindow.every((p, i) => i === 0 || p.value >= inWindow[i - 1].value);
      if (kind === "count" && delta > 0 && monotone) flags.push({ key: "register", label: "running register", title: "Only ever grows: a register filling in rather than a change on the ground." });

      // the ward map was redrawn inside the window and this figure is stamped by ward
      const allocation = coverageOf(id).latest_metadata?.allocation_method;
      const remaps = (ctx.remapYears || []).filter((year) => a < year && year <= b);
      if (remaps.length && WARD_STAMPED.has(allocation)) {
        flags.push({ key: "redraw", label: `spans the ${remaps[remaps.length - 1]} redraw`, title: `Ward boundaries were redrawn in ${remaps.join(" and ")}; the two readings describe different ground.` });
      }

      // ACS 5-year estimates share years when the anchors are fewer than five apart
      if (methodologyOf(id).includes("acs_5yr") && b - a < 5) flags.push({ key: "acs", label: "overlapping ACS windows", title: "Five-year Census estimates that overlap in time move slowly by construction." });

      // the run-up only matters when it reaches into the window
      if (entry.rampIn && entry.rampIn > window_.from) flags.push({ key: "begins", label: `data begins ${entry.rampIn}`, title: `Earlier readings were a run-up (the feed filling in) and are set aside.` });
      if (b < window_.to) flags.push({ key: "latest", label: `latest reading ${b}`, title: `Nothing newer than ${b} yet; the reading carries forward.` });
      if (a > window_.from) flags.push({ key: "first", label: `first reading ${a}`, title: `No reading at ${window_.from}; the comparison starts at ${a}.` });

      const demoted = flags.some((f) => f.key === "low-start" || f.key === "register" || f.key === "acs");
      const magnitude = pct != null ? Math.abs(pct) : bounded ? Math.abs(delta) : Math.abs(delta) / Math.max(Math.abs(fromValue), 1);
      return {
        metric, kind: isOffice ? "office" : "trend", verdict, anchors: { from: a, to: b }, fromValue, toValue, delta, pct,
        bounded, unit: kind, points: inWindow, magnitude, flags, demoted,
        avg: peerFacts(id, window_, metric),
      };
    }

    function peerFacts(id, window_, metric) {
      const from = ctx.slices?.[String(window_.from)];
      const to = ctx.slices?.[String(window_.to)];
      if (!from || !to) return null;
      const deltas = [];
      for (const areaId of Object.keys(from)) {
        const x = from[areaId]?.[id];
        const y = to[areaId]?.[id];
        if (x && y && Number.isFinite(x.v) && Number.isFinite(y.v)) deltas.push(y.v - x.v);
      }
      if (!deltas.length) return null;
      return { delta: mean(deltas), peerDeltas: deltas, n: deltas.length, metric };
    }

    function allRows() {
      const window_ = state.window || defaultWindow();
      return (ctx.metrics || []).map((m) => classify(m.metric_id, window_)).filter(Boolean);
    }

    // ---- rendering ----

    function deltaText(row) {
      const sign = row.delta > 0 ? "+" : row.delta < 0 ? "−" : "";
      if (row.bounded) return `${sign}${Math.abs(row.delta).toFixed(1)} pts`;
      const raw = fmtValue(Math.abs(row.delta), row.metric);
      return row.pct != null ? `${sign}${raw} (${sign}${Math.abs(row.pct).toFixed(0)}%)` : `${sign}${raw}`;
    }

    function dictHref(id) {
      return `${ctx.dictionaryBase || "/dictionary"}?metric=${encodeURIComponent(id)}`;
    }

    function rowHtml(row, tone) {
      const id = row.metric.metric_id;
      const open = state.open.has(id);
      const flags = row.flags.map((f) => `<span class="ww-flag" title="${esc(f.title)}">${esc(f.label)}</span>`).join("");
      const icon = window.WardWiseIcons?.svg ? `<span class="ww-change-icon" aria-hidden="true">${WardWiseIcons.svg(row.metric)}</span>` : "";
      const spark = WardWiseCharts.sparkline(row.points, { tone });
      const detailId = `chg-${id}`;
      return `
        <li class="ww-change is-${esc(row.verdict)}${row.demoted ? " is-demoted" : ""}${row.kind === "office" ? " is-office" : ""}" data-metric="${esc(id)}">
          <button type="button" class="ww-change-head" data-act="chg-toggle" data-metric="${esc(id)}" aria-expanded="${open}" aria-controls="${detailId}">
            <span class="ww-change-main">
              <span class="ww-change-label">${icon}${esc(row.metric.label)}</span>
              <span class="ww-change-cat">${esc(humanizeDomain(row.metric.category))}</span>
              <span class="ww-change-pair num">${esc(fmtValue(row.fromValue, row.metric))} → ${esc(fmtValue(row.toValue, row.metric))}<span class="ww-change-years"> · ${row.anchors.from}–${row.anchors.to}</span></span>
              ${flags ? `<span class="ww-flags">${flags}</span>` : ""}
            </span>
            <span class="ww-change-viz">${spark}<span class="ww-change-delta num">${esc(deltaText(row))}</span></span>
          </button>
          <div class="ww-change-detail" id="${detailId}"${open ? "" : " hidden"}>${open ? detailHtml(row) : ""}</div>
        </li>`;
    }

    function detailHtml(row) {
      const id = row.metric.metric_id;
      const m = row.metric;
      const M = window.WardWiseReportDomains?.math;
      const avgCell = row.avg
        ? (M?.comparisonHtml
          ? M.comparisonHtml(m, row.delta, row.avg.delta, (v) => M.formatDelta(v, m), row.avg.peerDeltas, { noun: ctx.noun, plural: ctx.plural })
          : esc(deltaTextRaw(row.avg.delta, m)))
        : (state.peers === "loading" ? `<span class="soft">loading…</span>` : `<span class="soft">not loaded</span>`);
      const provenance = provenanceOf(id);
      const method = methodologyOf(id);
      const how = [
        coverageOf(id).latest_metadata?.allocation_method ? String(coverageOf(id).latest_metadata.allocation_method).replaceAll("_", " ") : "",
        provenance.measurement_tier ? `${provenance.measurement_tier} tier` : "",
        method.includes("acs_5yr") ? "ACS 5-year estimate" : "",
        method.includes("modeled") ? "modeled" : "",
        method.includes("areal_allocation") ? "apportioned by area" : "",
      ].filter(Boolean).join(" · ") || "direct";
      const better = m.direction === "lower" ? "lower is better" : "higher is better";
      const flagLines = row.flags.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.title)}</dd>`).join("");
      return `<dl>
        <dt>${row.anchors.from} reading</dt><dd class="num">${esc(fmtValue(row.fromValue, m))}</dd>
        <dt>${row.anchors.to} reading</dt><dd class="num">${esc(fmtValue(row.toValue, m))}</dd>
        <dt>Change</dt><dd class="num">${esc(deltaText(row))}</dd>
        <dt>Readings in window</dt><dd>${row.points.length}</dd>
        <dt>Average ${esc(ctx.noun)} change</dt><dd>${avgCell}</dd>
        <dt>Better when</dt><dd>${better}</dd>
        <dt>How measured</dt><dd>${esc(how)}</dd>
        ${m.source ? `<dt>Source</dt><dd>${esc(m.source)}</dd>` : ""}
        ${flagLines}
        <dt>Dictionary</dt><dd><a href="${esc(dictHref(id))}">${esc(m.label)}</a></dd>
      </dl>`;
    }

    function deltaTextRaw(delta, metric) {
      const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
      return `${sign}${fmtValue(Math.abs(delta), metric)}`;
    }

    function sortRows(rows) {
      return [...rows].sort((a, b) => (a.demoted === b.demoted ? b.magnitude - a.magnitude : a.demoted ? 1 : -1));
    }

    function termChips() {
      const terms = ctx.terms?.terms;
      const last = latestFullYear();
      const chips = [];
      if (terms) {
        for (const key of Object.keys(terms).map(Number).sort((a, b) => a - b)) {
          if (key < CHANGE_FLOOR_YEAR || key >= last) continue;
          const to = Math.min(key + 4, last);
          chips.push({ from: key, to, label: `${key}→${to} term` });
        }
      }
      chips.push({ from: CHANGE_FLOOR_YEAR, to: last, label: `${CHANGE_FLOOR_YEAR}→${last}` });
      return chips;
    }

    function controlsHtml(rows) {
      const years = allYears();
      const w = state.window;
      const option = (y, sel) => `<option value="${y}"${y === sel ? " selected" : ""}>${y}</option>`;
      const fromOptions = years.filter((y) => y < latestFullYear()).map((y) => option(y, w.from)).join("");
      const toOptions = years.filter((y) => y > CHANGE_FLOOR_YEAR).map((y) => option(y, w.to)).join("");
      const chips = termChips().map((c) =>
        `<button type="button" class="preset-chip${c.from === w.from && c.to === w.to ? " is-on" : ""}" data-act="chg-preset" data-from="${c.from}" data-to="${c.to}">${esc(c.label)}</button>`).join("");
      const counts = new Map();
      for (const row of rows) {
        if (row.kind === "excluded") continue;
        const key = row.metric.category || "other";
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const cats = [...counts.keys()].sort().map((key) =>
        `<button type="button" class="ww-catchip" data-act="chg-cat" data-cat="${esc(key)}" aria-pressed="${state.cats.has(key)}">${esc(humanizeDomain(key))} <em>${counts.get(key)}</em></button>`).join("");
      return `
        <div class="ww-changes-controls">
          <label class="report-select"><span>From</span><select data-chg="from">${fromOptions}</select></label>
          <label class="report-select"><span>To</span><select data-chg="to">${toOptions}</select></label>
          <div class="preset-chips">${chips}</div>
        </div>
        <div class="ww-catchips">${cats}</div>`;
    }

    function headerHtml(rows) {
      const w = state.window;
      const good = rows.filter((r) => r.kind === "trend" && r.verdict === "improved").length;
      const bad = rows.filter((r) => r.kind === "trend" && r.verdict === "worsened").length;
      const flat = rows.filter((r) => r.kind === "trend" && r.verdict === "flat").length;
      const out = rows.filter((r) => r.kind === "excluded").length;
      return `
        <p class="ww-changes-lede">Between <b>${w.from}</b> and <b>${w.to}</b>, <b>${good} measure${good === 1 ? "" : "s"} moved the right way, ${bad} the wrong way</b> and ${flat} held flat in ${esc(ctx.label)}. ${out} could not be read as movement (listed below). Each row is anchored to the nearest readings, printed beside it. Weaker evidence than the standings above.</p>
        <details class="ww-changes-howto"><summary>How to read this</summary>
          <p>Right way and wrong way follow each measure's own direction (a poverty rate that fell moved the right way). Percentages and scores move in points, not percent. A change off a tiny base, a count that only ever grows, or two overlapping Census estimates is flagged and sorted last. Where the ward map was redrawn inside the window, the two readings describe different ground and the row says so. Decisions made in the ward office are reported separately and never as a verdict on the neighborhood.</p>
        </details>`;
    }

    function columnHtml(title, rows, cls, tone) {
      const list = sortRows(rows).map((row) => rowHtml(row, tone)).join("");
      return `<section class="ww-changes-col ${cls}"><h4>${esc(title)} <em>${rows.length}</em></h4><ul class="ww-changes-list">${list || `<li class="soft ww-change-empty">Nothing in this window.</li>`}</ul></section>`;
    }

    function officeHtml(rows) {
      if (ctx.areaType !== "ward") return "";
      const office = rows.filter((r) => r.kind === "office" && r.verdict !== "flat");
      if (!office.length) return "";
      return `<section class="ww-changes-office">
        <div class="ww-mainhead">How the ward office's budget shifted<span>choices made in the ward office, reported without a verdict — a priority moved, not a condition of the neighborhood</span></div>
        <ul class="ww-changes-list">${sortRows(office).map((row) => rowHtml(row, "neutral")).join("")}</ul>
      </section>`;
    }

    function excludedHtml(rows) {
      const reasons = new Map();
      const add = (reason, label) => {
        if (!reasons.has(reason)) reasons.set(reason, []);
        reasons.get(reason).push(label);
      };
      for (const row of rows) if (row.kind === "excluded") add(row.reason, row.metric.label);
      const office = rows.filter((r) => r.kind === "office" && r.verdict === "flat").length;
      let dropped = 0;
      let forward = 0;
      for (const entry of state.series?.values() || []) {
        dropped += entry.dropped.partial;
        forward += entry.dropped.forward;
      }
      const demoted = rows.filter((r) => r.kind === "trend" && r.demoted).length;
      const items = [...reasons.entries()].map(([reason, labels]) => {
        const shown = labels.slice(0, 3).map(esc).join(", ");
        const more = labels.length > 3 ? ` and ${labels.length - 3} more` : "";
        return `<li><b>${labels.length}</b> ${esc(reason)}: ${shown}${more}.</li>`;
      }).join("");
      const extras = [
        office ? `<li><b>${office}</b> ward-office decision${office === 1 ? "" : "s"} unchanged.</li>` : "",
        dropped ? `<li><b>${dropped}</b> reading${dropped === 1 ? "" : "s"} dated ${new Date().getFullYear()} set aside as the year in progress.</li>` : "",
        forward ? `<li><b>${forward}</b> forward-dated reading${forward === 1 ? "" : "s"} set aside.</li>` : "",
        demoted ? `<li><b>${demoted}</b> row${demoted === 1 ? "" : "s"} flagged (low start, running register, overlapping estimates) and sorted last.</li>` : "",
      ].join("");
      return `<section class="ww-changes-excluded"><h4>Not in this section</h4><ul>${items}${extras}</ul></section>`;
    }

    function peersHtml() {
      if (state.peers === "ready") return "";
      if (ctx.areaType === "chi" && state.peers === "idle") {
        return `<p class="ww-changes-peers"><button type="button" class="ww-cta ghost" data-act="chg-peers">Compare with the average ${esc(ctx.noun)}</button> <span class="soft">two year slices, a few megabytes</span></p>`;
      }
      if (state.peers === "loading") return `<p class="ww-changes-peers soft">Loading the average ${esc(ctx.noun)}'s change…</p>`;
      if (state.peers === "failed") return `<p class="ww-changes-peers soft">The average ${esc(ctx.noun)}'s change could not be loaded.</p>`;
      return "";
    }

    function filtered(rows) {
      if (!state.cats.size) return rows;
      return rows.filter((r) => r.kind === "excluded" || state.cats.has(r.metric.category || "other"));
    }

    function bodyHtml() {
      if (state.status === "error") return `<p class="soft">Couldn't load this ${esc(ctx.noun)}'s history — try reloading.</p>`;
      if (state.status !== "ready") return `<p class="soft">Loading history…</p>`;
      if (!state.series.size) return `<p class="soft">No dated history for this ${esc(ctx.noun)} yet.</p>`;
      const rows = allRows();
      const visible = filtered(rows);
      const good = visible.filter((r) => r.kind === "trend" && r.verdict === "improved");
      const bad = visible.filter((r) => r.kind === "trend" && r.verdict === "worsened");
      return headerHtml(rows) + controlsHtml(rows) + peersHtml() +
        `<div class="ww-changes-cols">${columnHtml("Moved the right way", good, "is-good", "up")}${columnHtml("Moved the wrong way", bad, "is-bad", "down")}</div>` +
        officeHtml(visible) + excludedHtml(rows);
    }

    function mount(el) {
      state.host = el;
      el.innerHTML = bodyHtml();
      if (!el.dataset.chgWired) {
        el.dataset.chgWired = "1";
        el.addEventListener("click", onClick);
        el.addEventListener("change", onChange);
      }
    }

    function rerender() {
      if (state.host) mount(state.host);
    }

    function setWindow(from, to) {
      state.window = pickWindow(from, to);
      state.peers = state.peers === "ready" ? "idle" : state.peers;
      ctx.onState?.({ from: state.window.from, to: state.window.to, cats: [...state.cats] });
      rerender();
      if (ctx.areaType !== "chi") loadPeers();
    }

    async function loadPeers() {
      if (!state.window || !ctx.loadSlice) return;
      const { from, to } = state.window;
      if (ctx.slices?.[String(from)] && ctx.slices?.[String(to)]) {
        state.peers = "ready";
        rerender();
        return;
      }
      state.peers = "loading";
      rerender();
      try {
        await Promise.all([ctx.loadSlice(String(from)), ctx.loadSlice(String(to))]);
        state.peers = "ready";
      } catch (_error) {
        state.peers = "failed";
      }
      rerender();
    }

    function onClick(event) {
      const target = event.target.closest("[data-act]");
      if (!target || !state.host?.contains(target)) return;
      const act = target.dataset.act;
      if (act === "chg-toggle") {
        const id = target.dataset.metric;
        if (state.open.has(id)) state.open.delete(id);
        else state.open.add(id);
        const li = target.closest(".ww-change");
        const detail = li?.querySelector(".ww-change-detail");
        const open = state.open.has(id);
        target.setAttribute("aria-expanded", String(open));
        if (detail) {
          detail.hidden = !open;
          if (open) {
            const row = classify(id, state.window);
            detail.innerHTML = row && row.kind !== "excluded" ? detailHtml(row) : "";
          }
        }
        event.stopPropagation();
      } else if (act === "chg-preset") {
        setWindow(Number(target.dataset.from), Number(target.dataset.to));
        event.stopPropagation();
      } else if (act === "chg-cat") {
        const key = target.dataset.cat;
        if (state.cats.has(key)) state.cats.delete(key);
        else state.cats.add(key);
        ctx.onState?.({ from: state.window.from, to: state.window.to, cats: [...state.cats] });
        rerender();
        event.stopPropagation();
      } else if (act === "chg-peers") {
        loadPeers();
        event.stopPropagation();
      }
    }

    function onChange(event) {
      const which = event.target.dataset.chg;
      if (!which) return;
      const w = state.window;
      const value = Number(event.target.value);
      setWindow(which === "from" ? value : w.from, which === "to" ? value : w.to);
    }

    return { load, mount, rerender, setWindow, getWindow: () => state.window, defaultWindow, classify, seriesFor, loadPeers, allRows,
      get status() { return state.status; } };
  }

  return { create, OFFICE_METRIC_IDS, MEASUREMENT_BREAKS, CHANGE_FLOOR_YEAR };
})();
