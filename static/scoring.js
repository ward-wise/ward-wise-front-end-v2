// The composite score, standings and basket math — pure functions over a score-matrix slice.
//
// A slice is `matrix[year]` from /api/metrics/score-matrix: {area_id: {metric_id: {s, v}}} where
// `s` is the direction-aware 0-100 normalized score and `v` the raw value. Everything on the
// landing, the mini report, the full report and the comparison page scores through this one
// module, so a rank shown on any of them is the same rank. computeComposite mirrors the server's
// compute_weighted_scores to the displayed digit (round half-up to 2dp; ties broken by area id).
// A page that honours the reader's contested directions scores an orientSlice() of the slice.
window.WardWiseScoring = (function () {
  const round2 = (value) => Math.round(value * 100) / 100;

  function activeWeights(weights) {
    return Object.entries(weights || {})
      .map(([id, weight]) => [id, Number(weight)])
      .filter(([, weight]) => Number.isFinite(weight) && weight > 0);
  }

  // rows: every area in the slice (null score when none of the basket is measured there),
  // sorted best first, ranked over the scored ones. `used`/`of` say how much of the basket the
  // area's score actually rests on — a 50-ward city where one ward is scored on 3 of 7 measures
  // should say so next to that ward's rank.
  function computeComposite(slice, weights) {
    const active = activeWeights(weights);
    const rows = Object.entries(slice || {}).map(([areaId, cells]) => {
      let total = 0;
      let applied = 0;
      let used = 0;
      for (const [metricId, weight] of active) {
        if (cells && metricId in cells) {
          total += Number(cells[metricId].s) * weight;
          applied += weight;
          used += 1;
        }
      }
      return {
        area_id: areaId,
        score: applied ? round2(total / applied) : null,
        used,
        of: active.length,
      };
    });
    rows.sort(
      (a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || String(a.area_id).localeCompare(String(b.area_id)),
    );
    let rank = 1;
    for (const row of rows) if (row.score != null) row.rank = rank++;
    const byId = new Map(rows.map((row) => [String(row.area_id), row]));
    return { rows, byId, ranked: rank - 1 };
  }

  function areaStanding(slice, weights, areaId) {
    return computeComposite(slice, weights).byId.get(String(areaId)) || null;
  }

  // One measure: where this area sits among every area that has it, on the score AND the value.
  function metricStanding(slice, metricId, areaId) {
    const entries = [];
    for (const [id, cells] of Object.entries(slice || {})) {
      if (cells && metricId in cells) entries.push([id, Number(cells[metricId].s), cells[metricId].v]);
    }
    entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const index = entries.findIndex(([id]) => id === String(areaId));
    if (index === -1) return null;
    return { rank: index + 1, n: entries.length, value: entries[index][2], score: entries[index][1] };
  }

  // Standings for a basket, best first, dropping measures the area has no record of.
  function metricStandings(slice, areaId, metricIds) {
    return (metricIds || [])
      .map((metricId) => ({ metric_id: metricId, ...(metricStanding(slice, metricId, areaId) || {}) }))
      .filter((item) => item.rank)
      .sort((a, b) => a.rank - b.rank);
  }

  // Equal-weight index over one domain's measures, ranked among every area that has any of them.
  function domainIndexFacts(slice, areaId, domainMetricIds) {
    const weights = Object.fromEntries((domainMetricIds || []).map((id) => [id, 1]));
    const { byId, ranked } = computeComposite(slice, weights);
    const row = byId.get(String(areaId));
    if (!row || row.score == null) return null;
    return { index: row.score, rank: row.rank, of: ranked, measured: row.used, total: row.of };
  }

  // 1st..3rd get the strong tone, the bottom third the weak tone; too few measures => neither.
  function tercile(idx) {
    if (!idx || idx.muted) return "";
    if (idx.rank <= idx.of / 3) return "is-strong";
    if (idx.rank > (2 * idx.of) / 3) return "is-weak";
    return "";
  }

  // Equal-weight domain indexes for EVERY area in a slice at once — the same math as
  // domainIndexFacts in report_domains.js (mean of measured direction-adjusted scores; rank = 1 +
  // the count of areas strictly ahead; `of` = areas with anything measured in that domain), so the
  // index page's fingerprints agree with the full report's bloom.
  //   metrics: catalog rows for this geography. Returns {domains: [keys, alphabetical],
  //   byArea: Map(area_id -> [{domain, index, rank, of, measured, total, muted}])}.
  function domainIndexes(slice, metrics) {
    const byDomain = new Map();
    for (const metric of metrics || []) {
      const key = metric.category || "other";
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key).push(metric.metric_id);
    }
    const domains = [...byDomain.keys()].sort();
    const areaIds = Object.keys(slice || {});
    const byArea = new Map(areaIds.map((id) => [id, []]));
    for (const domain of domains) {
      const ids = byDomain.get(domain);
      const rows = [];
      for (const areaId of areaIds) {
        const cells = slice[areaId] || {};
        let total = 0;
        let measured = 0;
        for (const id of ids) {
          const score = cells[id]?.s;
          if (Number.isFinite(score)) {
            total += score;
            measured += 1;
          }
        }
        if (measured) rows.push({ areaId, index: total / measured, measured });
      }
      for (const row of rows) {
        const rank = 1 + rows.filter((other) => other.index > row.index + 1e-9).length;
        byArea.get(row.areaId).push({
          domain,
          index: row.index,
          rank,
          of: rows.length,
          measured: row.measured,
          total: ids.length,
          muted: row.measured < 3,
        });
      }
    }
    return { domains, byArea };
  }

  function median(values) {
    const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Where each score sits on the observed range, for charts that place every area on one axis.
  function distribution(rows) {
    const scores = (rows || []).map((row) => row.score).filter((s) => s != null);
    if (!scores.length) return null;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = Math.max(1e-9, max - min);
    return { min, max, median: median(scores), pct: (score) => ((score - min) / span) * 100 };
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = Number(n) % 100;
    return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
  }

  // 1st, 2nd, 3rd get the podium treatment; the number is always spelled out beside it.
  function medal(rank) {
    return rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
  }

  function medalClass(rank, prefix) {
    const name = medal(rank);
    return name ? ` ${prefix || ""}${name}` : "";
  }

  const basket = {
    serialize: (weights) => window.WardWiseGeography.serializeMix(weights),
    parse: (text) => window.WardWiseGeography.parseMix(text),
  };

  // ---- contested directions (byop v1.4 `direction_contested`) ----
  // Residents disagree which way is better for some measures (more plate readers: safer, or more
  // watched?). The catalog's `direction` is the default reading and the one the matrix's `s` was
  // normalized in; a reader may take the other one. metric.direction holds the reading in force (so
  // every label, sign and the change view follow it) and metric.default_direction the matrix's.
  const DIRECTIONS = ["higher", "lower"];

  // The other reading of a matrix score. Min-max normalization is symmetric (the 0-100 clamp, 50 on a
  // flat domain), so this is exactly the 2 dp value the pipeline would have stored had the metric's
  // direction been the other one — the same as flip_component_score in shared/civic_data/metrics.py.
  function flipScore(s) {
    return round2(100 - Number(s));
  }

  // The slice with `s` flipped on the given metrics; every other cell is shared, not copied. Memoized
  // per slice, so re-scoring on each weight change costs nothing until the choices change.
  const orientedSlices = new WeakMap();
  function orientSlice(slice, flippedIds) {
    const ids = [...new Set(flippedIds || [])].sort();
    if (!slice || !ids.length) return slice || {};
    const key = ids.join(",");
    const memo = orientedSlices.get(slice);
    if (memo && memo.key === key) return memo.slice;
    const out = {};
    for (const [areaId, cells] of Object.entries(slice)) {
      let copy = null;
      for (const id of ids) {
        if (cells && id in cells) {
          copy ||= { ...cells };
          copy[id] = { ...cells[id], s: flipScore(cells[id].s) };
        }
      }
      out[areaId] = copy || cells;
    }
    orientedSlices.set(slice, { key, slice: out });
    return out;
  }

  const contested = (metric) => Boolean(metric?.direction_contested) && DIRECTIONS.includes(metric.default_direction);

  const directions = {
    // dir=metric_id:higher,metric_id:lower -> {metric_id: "higher"|"lower"}; anything else is dropped.
    parse(text) {
      const choices = {};
      for (const token of String(text || "").split(",")) {
        const [id, direction] = token.split(":").map((part) => (part || "").trim());
        if (id && DIRECTIONS.includes(direction)) choices[id] = direction;
      }
      return choices;
    },
    // Remember each metric's default once, then apply the reader's choices to contested metrics only.
    // Returns the canonical dir= text for the page's links and URL.
    apply(metrics, choices) {
      const parsed = typeof choices === "string" || choices == null ? directions.parse(choices) : choices;
      for (const metric of metrics || []) {
        if (!("default_direction" in metric)) metric.default_direction = metric.direction || "higher";
        if (contested(metric) && parsed[metric.metric_id]) metric.direction = parsed[metric.metric_id];
      }
      return directions.serialize(metrics);
    },
    // One reader's choice; false when the metric isn't contested.
    set(metric, direction) {
      if (!contested(metric) || !DIRECTIONS.includes(direction)) return false;
      metric.direction = direction;
      return true;
    },
    isContested: contested,
    // The contested metrics read the other way from their default — the ones a slice must flip.
    flipped(metrics) {
      return (metrics || []).filter((m) => contested(m) && m.direction !== m.default_direction).map((m) => m.metric_id);
    },
    serialize(metrics) {
      return (metrics || [])
        .filter((m) => contested(m) && m.direction !== m.default_direction)
        .map((m) => `${m.metric_id}:${m.direction}`)
        .sort()
        .join(",");
    },
  };

  return {
    computeComposite,
    areaStanding,
    metricStanding,
    metricStandings,
    domainIndexFacts,
    distribution,
    tercile,
    domainIndexes,
    median,
    ordinal,
    medal,
    medalClass,
    basket,
    flipScore,
    orientSlice,
    directions,
  };
})();
