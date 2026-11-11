// The public full report: one ward, neighborhood or χGRID, read through a basket of measures.
//
// Structure (after Connor's redesign, generalised to every geography): who this is, where it
// stands on the basket (hero ordinal + the whole field), the basket itself (editable in place),
// strongest and weakest measures, rank over time, and then Penlight's own long-form sections —
// the domain bloom, every measure against the average area, how the business mix is changing,
// and the area's best light — mounted from report_domains.js.
//
// URL is state: /report/<slug>/<id>?m=<basket>&p=<preset>&y=<year>. A link reproduces the page.
(function () {
  "use strict";
  if (!window.WW_REPORT) return;

  const esc = (t) => WardWiseExplorer.escapeHtml(t == null ? "" : String(t));
  const G = window.WardWiseGeography;
  const S = window.WardWiseScoring;
  const C = window.WardWiseCharts;
  const root = () => document.getElementById("report-root");

  const MAX_YEAR_FETCHES = { ward: 8, community_area: 8, chi: 5 };
  const WORKERS = { ward: 3, community_area: 3, chi: 2 };
  const FIRST_TRAJECTORY_YEAR = 2012;

  const state = {
    manifest: null,
    cfg: G.byApi(window.WW_REPORT.area_type || "ward"),
    areaId: null,
    areas: {},          // areaType -> [area]
    slices: {},         // areaType -> {yearKey: slice}
    weights: {},
    presetId: null,
    year: "latest",
    terms: null,        // aldermanic terms (ward pages only)
    details: {},        // ward id -> /api/wards/<id>
    openMetric: null,
    overTime: { key: null, status: "idle", points: [] },
    domains: { key: null, status: "idle", ctx: null, report: null },
    changes: { key: null, status: "idle", report: null },
    changesWindow: null,   // {from, to, cats} carried in the URL
    narrative: null,       // /api/narratives/<type>/<id> or null when none is published
    tab: "overview",       // which in-page tab is open (?tab=); print shows them all
    token: 0,
  };

  // The report is long, so it is read through tabs. Each tab names the sections it shows; the
  // alder tab exists only on ward pages. Order is reading order.
  const TABS = [
    { id: "overview", label: "Overview", sections: ["report-hero", "report-read", "report-mix", "report-ctas", "report-peek"] },
    { id: "overtime", label: "Over time", sections: ["report-overtime"] },
    { id: "changes", label: "What changed", sections: ["report-changes"] },
    { id: "domains", label: "Every measure", sections: ["report-domains"] },
    { id: "alder", label: "Alderperson", sections: ["report-alder-tab"], wardOnly: true },
  ];

  function tabsFor() {
    return TABS.filter((tab) => !tab.wardOnly || state.cfg.api === "ward");
  }

  function tabById(id) {
    return tabsFor().find((tab) => tab.id === id) || tabsFor()[0];
  }

  // ---- data ----

  function areaList() {
    return state.areas[state.cfg.api] || [];
  }

  function findArea(id) {
    return areaList().find((area) => String(G.areaIdOf(area, state.cfg)) === String(id));
  }

  function nameFor(id) {
    const area = findArea(id);
    return area ? state.cfg.name(area) : String(id);
  }

  async function loadAreas(cfg) {
    if (!state.areas[cfg.api]) state.areas[cfg.api] = await cfg.loadAreas();
    return state.areas[cfg.api];
  }

  async function loadSlice(yearKey, areaType = state.cfg.api) {
    const bucket = (state.slices[areaType] ||= {});
    if (bucket[yearKey]) return bucket[yearKey];
    const data = await WardWiseExplorer.fetchJson(
      `/api/metrics/score-matrix?area_type=${encodeURIComponent(areaType)}&year=${encodeURIComponent(yearKey)}`,
      "Unable to load scores.",
    );
    // the reader's contested-direction choices (dir=) are fixed for the page, so flip once on arrival
    bucket[yearKey] = S.orientSlice((data.matrix || {})[yearKey] || {}, S.directions.flipped(state.manifest.metrics));
    return bucket[yearKey];
  }

  function currentSlice() {
    return (state.slices[state.cfg.api] || {})[String(state.year)] || {};
  }

  function metricsForGeography() {
    const types = state.manifest.metric_area_types || {};
    return (state.manifest.metrics || []).filter((metric) => {
      const list = types[metric.metric_id];
      return !list || list.includes(state.cfg.api);
    });
  }

  function metricById(id) {
    if (!state._metricById) state._metricById = new Map((state.manifest.metrics || []).map((m) => [m.metric_id, m]));
    return state._metricById.get(id);
  }

  // ---- URL ----

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    state.dir = S.directions.apply(state.manifest.metrics, params.get("dir")); // contested readings, see scoring.js
    const known = new Set((state.manifest.metrics || []).map((m) => m.metric_id));
    const presetId = params.get("p");
    const parsed = G.parseMix(params.get("m"));
    if (parsed) {
      state.weights = Object.fromEntries(Object.entries(parsed).filter(([id]) => known.has(id)));
      state.presetId = WardWisePresetTools.byId(presetId) ? presetId : null;
    } else {
      applyPreset(WardWisePresetTools.byId(presetId) || WardWisePresetTools.random(), { silent: true });
    }
    const year = params.get("y");
    state.year = year && /^\d{4}$/.test(year) ? Number(year) : "latest";
    const from = params.get("from");
    const to = params.get("to");
    const cats = (params.get("cat") || "").split(",").filter(Boolean);
    if ((from && /^\d{4}$/.test(from)) || (to && /^\d{4}$/.test(to)) || cats.length) {
      state.changesWindow = { from: from ? Number(from) : null, to: to ? Number(to) : null, cats };
    }
    state.tab = tabById(params.get("tab") || "overview").id;
  }

  function queryString() {
    const params = new URLSearchParams();
    const mix = G.serializeMix(state.weights);
    if (mix) params.set("m", mix);
    if (state.presetId) params.set("p", state.presetId);
    if (state.year !== "latest") params.set("y", String(state.year));
    if (state.dir) params.set("dir", state.dir);
    if (state.changesWindow?.from) params.set("from", String(state.changesWindow.from));
    if (state.changesWindow?.to) params.set("to", String(state.changesWindow.to));
    if (state.changesWindow?.cats?.length) params.set("cat", state.changesWindow.cats.join(","));
    if (state.tab && state.tab !== "overview") params.set("tab", state.tab);
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  function writeUrl({ push } = {}) {
    const path = `/report/${state.cfg.slug}/${encodeURIComponent(state.areaId)}${queryString()}`;
    if (push) window.history.pushState(null, "", path);
    else window.history.replaceState(null, "", path);
  }

  // ---- basket ----

  function availableIds() {
    return new Set(metricsForGeography().map((m) => m.metric_id));
  }

  function applyPreset(preset, { silent } = {}) {
    if (!preset) return;
    const ok = availableIds();
    const { weights, used } = WardWisePresetTools.resolveWeights(
      preset, (state.manifest.metrics || []).map((m) => m.metric_id), (id) => ok.has(id));
    if (!used.length) return;
    state.weights = Object.fromEntries(Object.entries(weights).filter(([, w]) => w > 0));
    state.presetId = preset.id;
    if (!silent) WardWiseExplorer.track("report_preset", { preset_id: preset.id, area_type: state.cfg.api });
  }

  function basketIds() {
    const ok = availableIds();
    return Object.entries(state.weights)
      .filter(([id, w]) => Number(w) > 0 && metricById(id))
      .map(([id]) => id)
      .filter((id) => ok.has(id) || true); // unavailable ids stay in the basket; facts report them
  }

  function basketFacts() {
    const slice = currentSlice();
    const ok = availableIds();
    const cells = slice[String(state.areaId)] || {};
    const usable = [];
    const absent = [];   // this geography never has it
    const noRecord = []; // the geography has it, this area / year does not
    for (const id of basketIds()) {
      if (!ok.has(id)) absent.push(id);
      else if (id in cells) usable.push(id);
      else noRecord.push(id);
    }
    return { usable, absent, noRecord };
  }

  // ---- renderers ----

  function listName() {
    return WardWisePresetTools.byId(state.presetId)?.name || "your list";
  }

  function yearWords() {
    return state.year === "latest" ? "latest data" : `${state.year} data`;
  }

  function renderHead() {
    const geoOptions = G.peerTypes()
      .map((cfg) => `<option value="${cfg.api}"${cfg.api === state.cfg.api ? " selected" : ""}>${esc(cfg.label)}</option>`)
      .join("");
    const areaOptions = areaList()
      .map((area) => {
        const id = String(G.areaIdOf(area, state.cfg));
        const sub = state.cfg.sub(area);
        return `<option value="${esc(id)}"${id === String(state.areaId) ? " selected" : ""}>${esc(state.cfg.name(area))}${sub ? ` — ${esc(sub)}` : ""}</option>`;
      })
      .join("");
    const years = (state.manifest.data_years || []).filter((y) => y >= FIRST_TRAJECTORY_YEAR && y <= new Date().getFullYear()).reverse();
    const yearOptions = [`<option value="latest"${state.year === "latest" ? " selected" : ""}>Latest</option>`]
      .concat(years.map((y) => `<option value="${y}"${state.year === y ? " selected" : ""}>${y}</option>`))
      .join("");
    const back = G.landingUrl(state.cfg.api, state.areaId, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir });
    return `
      <div class="report-controls">
        <a class="ww-linkbtn" href="${esc(back)}">← Map view</a>
        <label class="report-select"><span>Geography</span><select id="rp-geo">${geoOptions}</select></label>
        <label class="report-select report-select-area"><span>${esc(G.capitalize(state.cfg.noun))}</span><select id="rp-area">${areaOptions}</select></label>
        <label class="report-select"><span>Year</span><select id="rp-year">${yearOptions}</select></label>
      </div>`;
  }

  function renderIdentity() {
    const area = findArea(state.areaId);
    let sub = "";
    if (state.cfg.api === "ward") {
      const overlaps = [...(area?.community_area_overlaps || [])]
        .filter((o) => o.name && (o.ward_area_pct ?? 0) > 0)
        .sort((a, b) => (b.ward_area_pct ?? 0) - (a.ward_area_pct ?? 0))
        .slice(0, 4)
        .map((o) => `<span class="wardreport-area">${esc(o.name)}<em>${Math.round(o.ward_area_pct)}%</em></span>`)
        .join("");
      sub = overlaps ? `<div class="wardreport-areas">${overlaps}</div>` : "";
    } else if (state.cfg.api === "community_area") {
      const wards = [...(area?.ward_overlaps || [])]
        .filter((w) => (w.community_area_pct ?? 0) >= 1)
        .sort((a, b) => (b.community_area_pct ?? 0) - (a.community_area_pct ?? 0))
        .slice(0, 4)
        .map((w) => `<a class="wardreport-area" href="${esc(G.reportUrl("ward", w.ward_id, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}" title="${esc(`${Math.round(w.community_area_pct ?? 0)}% of this neighborhood is in ${w.display_name}`)}">${esc(w.display_name)}<em>${Math.round(w.community_area_pct ?? 0)}%</em></a>`)
        .join("");
      sub = wards ? `<div class="wardreport-areas">${wards}</div>` : "";
    } else {
      const longName = area?.long_name && !area.long_name.startsWith(area.display_name || " ") ? area.long_name : "";
      const places = area?.poi_summary?.total_count;
      const bits = [longName, places ? `${places} mapped places` : ""].filter(Boolean);
      sub = bits.length ? `<p class="ww-areasub">${esc(bits.join(" · "))}</p>` : "";
    }
    const signifier = area?.visual_signifier?.image_url
      ? `<img class="report-signifier" src="${esc(area.visual_signifier.image_url)}" alt="${esc(area.visual_signifier.alt || area.visual_signifier.name || "")}" loading="lazy">`
      : "";
    const alder = "";  // the alderperson card lives on its own tab (renderAlderShell)
    return `
      <div class="report-identity">
        ${signifier}
        <div class="report-identity-copy">
          <p class="eyebrow">Full report</p>
          <h1 class="ww-areaname report-title">${esc(nameFor(state.areaId))}</h1>
          ${sub}
        </div>
      </div>
      ${alder}`;
  }

  function renderRepresented() {
    const details = state.details[state.areaId];
    if (details === undefined) return `<p class="ww-lede"><span class="soft">Finding the alderperson…</span></p>`;
    const alder = details?.alderperson;
    if (!alder?.name) return `<p class="ww-lede"><span class="soft">No alderperson profile on file.</span></p>`;
    const roster = termRoster();
    const office = alder.ward_office?.address ? `${alder.ward_office.address}${alder.ward_office.phone ? ` · ${alder.ward_office.phone}` : ""}` : "";
    return `
      <section class="alder-card report-alder">
        ${alder.photo_url ? `<img class="alder-photo" src="${esc(alder.photo_url)}" alt="${esc(alder.name)}">` : ""}
        <div>
          <p class="eyebrow">Represented by</p>
          <h3>${esc(alder.name)}</h3>
          ${office ? `<p class="soft">${esc(office)}</p>` : ""}
          ${alder.email ? `<p><a class="profile-link" href="mailto:${esc(alder.email)}">${esc(alder.email)}</a></p>` : ""}
          ${roster ? `<p class="report-roster">${roster}</p>` : ""}
        </div>
      </section>`;
  }

  // "Held by X since 2019; before that Y (2011–2019)." from /api/aldermanic-terms.
  function termRoster() {
    const terms = state.terms?.terms;
    if (!terms) return "";
    const seen = [];
    for (const key of Object.keys(terms).sort()) {
      const ward = terms[key]?.wards?.[state.areaId];
      for (const member of ward?.members || []) {
        const last = seen[seen.length - 1];
        if (last && last.name === member.name) {
          last.end = member.end;
        } else {
          seen.push({ name: member.name, start: member.start, end: member.end });
        }
      }
    }
    if (!seen.length) return "";
    const year = (iso) => String(iso || "").slice(0, 4);
    const current = seen[seen.length - 1];
    const previous = seen.slice(0, -1).slice(-2).reverse();
    let text = `Council seat held since ${esc(year(current.start))}`;
    if (previous.length) {
      text += `; before that ${previous.map((p) => `${esc(p.name)} (${esc(year(p.start))}–${esc(year(p.end))})`).join(", ")}`;
    }
    return `${text}.`;
  }

  function composite() {
    return S.computeComposite(currentSlice(), state.weights);
  }

  function renderHero() {
    const { rows, byId, ranked } = composite();
    const standing = byId.get(String(state.areaId));
    const facts = basketFacts();
    const standings = S.metricStandings(currentSlice(), state.areaId, facts.usable);
    const label = (id) => metricById(id)?.label || id;
    const lackWords = [];
    if (facts.absent.length) {
      lackWords.push(`${facts.absent.length === 1 ? "one measure has" : `${facts.absent.length} measures have`} no ${esc(state.cfg.noun)} version (${esc(facts.absent.slice(0, 3).map(label).join(", "))}${facts.absent.length > 3 ? ` and ${facts.absent.length - 3} more` : ""})`);
    }
    if (facts.noRecord.length) {
      lackWords.push(`${facts.noRecord.length === 1 ? "one measure has" : `${facts.noRecord.length} measures have`} no ${esc(yearWords())} here (${esc(facts.noRecord.slice(0, 3).map(label).join(", "))}${facts.noRecord.length > 3 ? ` and ${facts.noRecord.length - 3} more` : ""})`);
    }
    let hero;
    let lede;
    if (standing?.rank) {
      const ahead = standings.filter((item) => item.rank <= Math.ceil(item.n / 2)).length;
      const podium = standings.filter((item) => item.rank <= 3).length;
      hero = C.heroRank({ rank: standing.rank, of: ranked, plural: state.cfg.plural });
      lede = `On <b>${esc(listName())}</b> with ${esc(yearWords())}, ${esc(nameFor(state.areaId))} is ahead of the middle ${esc(state.cfg.noun)} on <b>${ahead} of ${standings.length}</b> measures${podium ? ` and on the podium for ${podium}` : ""}.`;
    } else {
      hero = `<div class="ww-hero-big num">—<small>not scored on ${esc(listName())}</small></div>`;
      lede = `None of the selected measures has a ${esc(yearWords())} record for this ${esc(state.cfg.noun)}.`;
    }
    if (lackWords.length) lede += ` <span class="soft">${G.capitalize(lackWords.join("; "))}.</span>`;
    const field = standing?.rank
      ? C.densityField({ rows, areaId: state.areaId, nameFor, noun: state.cfg.noun, plural: state.cfg.plural, listName: listName() })
      : "";
    return `<section class="report-card report-hero">${hero}<p class="ww-lede">${lede}</p>${field}</section>`;
  }

  // The written profile, when one has been built for this area. Every number in it that matches
  // a strongest/weakest value links to that measure's rank box.
  function renderRead() {
    const n = state.narrative;
    if (!n) return `<div data-read hidden></div>`;
    const paragraphs = (n.paragraphs || []).map((text, index) => {
      const marks = (n.mentions || []).filter((m) => m.field === "paragraphs" && m.index === index).sort((a, b) => a.start - b.start);
      let html = "";
      let cursor = 0;
      for (const mark of marks) {
        if (mark.start < cursor) continue;
        html += esc(text.slice(cursor, mark.start));
        html += `<a href="#" class="report-prose-num" data-act="prose-metric" data-metric="${esc(mark.metric_id)}">${esc(text.slice(mark.start, mark.end))}</a>`;
        cursor = mark.end;
      }
      html += esc(text.slice(cursor));
      return `<p>${html}</p>`;
    }).join("");
    const when = n.provenance?.generated_at ? new Date(n.provenance.generated_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "";
    return `
      <section class="report-card report-read" data-read>
        <p class="eyebrow">Read</p>
        <h2 class="report-prose-head">${esc(n.headline)}</h2>
        <div class="report-prose">${paragraphs}</div>
        <p class="report-prose-note"><b>Reading these numbers.</b> ${esc(n.reading_note)}</p>
        <footer class="report-prose-provenance">Written by a model (${esc(n.provenance?.model || "Claude")}) from Ward Wise's own data${when ? ` on ${esc(when)}` : ""}; every number links to its measure${n.stale ? "; written from an earlier data release" : ""}. <a href="/suggest-metric">Report a problem</a>.</footer>
      </section>`;
  }

  async function loadNarrative() {
    const key = `${state.cfg.api}|${state.areaId}`;
    try {
      const data = await WardWiseExplorer.fetchJson(`/api/narratives/${encodeURIComponent(state.cfg.api)}/${encodeURIComponent(state.areaId)}`, "");
      if (`${state.cfg.api}|${state.areaId}` !== key) return;
      state.narrative = data;
    } catch (_error) {
      state.narrative = null;
    }
    const host = root()?.querySelector("[data-read]");
    if (host) {
      host.outerHTML = renderRead();
      const peek = root()?.querySelector(".report-peek");
      if (peek) peek.outerHTML = renderPeek();
        applyTab();  // a re-rendered section must keep its tab's hidden state
      C.attachTips(root());
    }
  }

  function narrativeAside(metricId) {
    const n = state.narrative;
    if (!n) return "";
    const hit = (n.strongest || []).concat(n.weakest || []).find((s) => s.metric_id === metricId);
    return hit ? `<p class="report-prose-aside">${esc(hit.sentence)}</p>` : "";
  }

  function renderMix() {
    const ok = availableIds();
    const allIds = (state.manifest.metrics || []).map((m) => m.metric_id);
    const active = WardWisePresetTools.byId(state.presetId);
    const chips = WardWisePresets.map((preset) => {
      const { used, missing } = WardWisePresetTools.resolveWeights(preset, allIds, (id) => ok.has(id));
      const on = active && active.id === preset.id;
      const count = missing.length && used.length ? ` <em>${used.length}/${preset.metric_ids.length}</em>` : "";
      return `<button type="button" class="preset-chip${on ? " is-on" : ""}" data-act="preset" data-preset-id="${esc(preset.id)}" title="${esc(preset.tagline)}"${used.length ? "" : " disabled"}>${WardWisePresetTools.iconHtml(preset, (metricById(preset.icon_metric) || {}).category)}<span class="preset-chip-name">${esc(preset.name)}</span>${count}</button>`;
    }).join("");
    const ids = basketIds();
    const cells = currentSlice()[String(state.areaId)] || {};
    const pills = ids.map((id) => {
      const metric = metricById(id);
      const standing = S.metricStanding(currentSlice(), id, state.areaId);
      const weight = Number(state.weights[id]);
      const rank = standing ? `<span class="rk${S.medalClass(standing.rank, " m-")}">${S.ordinal(standing.rank)}</span>` : `<span class="rk none">${ok.has(id) ? "no record" : "n/a here"}</span>`;
      return `<button type="button" class="ww-pill on" data-act="remove" data-metric-id="${esc(id)}" title="Remove ${esc(metric.label)} from the list">${esc(metric.label)}${weight !== 1 ? ` <em>×${weight}</em>` : ""} ${rank} <span class="x" aria-hidden="true">×</span></button>`;
    }).join("");
    const byDomain = new Map();
    for (const metric of metricsForGeography()) {
      if (ids.includes(metric.metric_id)) continue;
      const key = metric.category || "other";
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key).push(metric);
    }
    const addOptions = [...byDomain.keys()].sort().map((domain) =>
      `<optgroup label="${esc(domain.replaceAll("_", " "))}">${byDomain.get(domain)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((m) => `<option value="${esc(m.metric_id)}">${esc(m.label)}</option>`).join("")}</optgroup>`).join("");
    return `
      <section class="report-card report-mix">
        <div class="preset-mixhead">Counting <b>${esc(active ? active.name : "Your list")}</b><span>${ids.length} measures</span></div>
        <p class="preset-note">${esc(active ? active.tagline : "the measures you picked — the standing above is scored on exactly these")}</p>
        <div class="preset-chips">${chips}</div>
        <details class="report-editor"${active ? "" : " open"}>
          <summary>Customize the list</summary>
          <div class="ww-pilltray">${pills || `<span class="soft">Nothing selected yet.</span>`}</div>
          <label class="report-add"><span>Add a measure</span>
            <select id="rp-add"><option value="">Choose…</option>${addOptions}</select>
          </label>
        </details>
      </section>`;
  }

  function renderCtas() {
    const landing = G.landingUrl(state.cfg.api, state.areaId, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir });
    const compare = true
      ? `<a class="ww-cta ghost" href="${esc(G.compareUrl(state.cfg.api, state.areaId, null, { weights: state.weights, year: state.year, directions: state.dir }))}">Compare with another ${esc(state.cfg.noun)}</a>`
      : "";
    const index = `<a class="ww-cta ghost" href="${esc(G.indexUrl(state.cfg.api, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir }))}">See the whole index</a>`;
    // A ward opens onto its precincts: the map page's single-ward lens (explorer-only geography).
    const precincts = state.cfg.api === "ward"
      ? `<a class="ww-cta ghost" href="${esc(G.landingUrl("precinct", null, { weights: state.weights, presetId: state.presetId, year: state.year, directions: state.dir, extra: { ward: state.areaId } }))}">See its precincts on the map</a>`
      : "";
    return `<div class="ww-ctas report-ctas"><a class="ww-cta" href="${esc(landing)}">See every ${esc(state.cfg.noun)} on the map</a>${precincts}${compare}${index}</div>`;
  }

  function renderPeek() {
    const facts = basketFacts();
    const slice = currentSlice();
    const standings = S.metricStandings(slice, state.areaId, facts.usable);
    if (!standings.length) return "";
    const strongest = standings.slice(0, 3);
    const weakest = standings.length > 3 ? standings.slice(-2).reverse() : [];
    const box = (item, weak) => C.rankBox({
      metricId: item.metric_id,
      label: metricById(item.metric_id)?.label || item.metric_id,
      rank: item.rank,
      of: item.n,
      weak: weak && item.rank > item.n / 2,
      open: state.openMetric === item.metric_id,
    });
    let html = `<section class="report-card report-peek"><div class="ww-peekhead">Strongest</div><div class="ww-rankboxes">${strongest.map((i) => box(i, false)).join("")}</div>`;
    if (weakest.length) html += `<div class="ww-peekhead">Weakest</div><div class="ww-rankboxes">${weakest.map((i) => box(i, true)).join("")}</div>`;
    if (state.openMetric && standings.some((item) => item.metric_id === state.openMetric)) {
      const id = state.openMetric;
      const entries = Object.entries(slice)
        .filter(([, cells]) => cells && id in cells)
        .map(([areaId, cells]) => ({ area_id: areaId, s: Number(cells[id].s), v: cells[id].v }))
        .sort((a, b) => b.s - a.s || String(a.area_id).localeCompare(String(b.area_id)))
        .map((entry, index) => ({ ...entry, rank: index + 1 }));
      html += narrativeAside(id);
      html += C.relativeStrip({ metric: metricById(id), entries, areaId: state.areaId, nameFor });
    }
    html += `<p class="mini-peeknote">Tap a box to see everyone on that measure's real scale.</p></section>`;
    return html;
  }

  function renderOverTimeShell() {
    return `<section class="report-card report-overtime" id="rp-overtime">
      <div class="ww-mainhead">Rank over time<span>where ${esc(nameFor(state.areaId))} stood on ${esc(listName())} in each year's data</span></div>
      <div data-overtime-body><p class="soft">Loads when you scroll here.</p></div>
    </section>`;
  }

  function renderChangesShell() {
    return `<section class="report-card report-changes" id="rp-changes">
      <div class="ww-mainhead">What changed over time<span>every dated measure for ${esc(nameFor(state.areaId))}, read between two years — independent of your list</span></div>
      <div data-changes-body><p class="soft">Loads when you scroll here.</p></div>
    </section>`;
  }

  function renderDomainsShell() {
    return `<section class="panel metrics-panel report-domains" id="rp-domains">
      <div class="report-domains-head">
        <h2>Every measure, by domain</h2>
        <p class="soft">The equal-weight picture: each wellbeing domain against the average ${esc(state.cfg.noun)}, how each measure is moving, the business mix over time, and this ${esc(state.cfg.noun)}'s best light. This section does not depend on your list.</p>
      </div>
      <div data-domains-body><p class="soft">Loads when you scroll here.</p></div>
    </section>`;
  }

  // ---- tabs ----

  function renderTabs() {
    const tabs = tabsFor();
    const buttons = tabs.map((tab) => {
      const on = tab.id === state.tab;
      return `<button type="button" role="tab" id="rp-tab-${esc(tab.id)}" class="metric-subtab${on ? " is-active" : ""}"
        aria-selected="${on}" tabindex="${on ? 0 : -1}" data-act="tab" data-tab="${esc(tab.id)}">${esc(tab.label)}</button>`;
    }).join("");
    return `<div class="metric-subtabs report-tabs" role="tablist" aria-label="Report sections">${buttons}</div>`;
  }

  // The alderperson card renders inside the identity block on ward pages; the tab shows the same
  // card in its own panel so the page's top stays short.
  function renderAlderShell() {
    if (state.cfg.api !== "ward") return "";
    return `<section class="report-card report-alder-tab" data-alder-tab>${renderRepresented()}</section>`;
  }

  // Sections are all in the DOM (print shows every one); the open tab is the one not hidden.
  function applyTab() {
    const el = root();
    if (!el) return;
    const active = tabById(state.tab);
    state.tab = active.id;
    for (const tab of tabsFor()) {
      const on = tab.id === active.id;
      const button = el.querySelector(`#rp-tab-${CSS.escape(tab.id)}`);
      if (button) {
        button.classList.toggle("is-active", on);
        button.setAttribute("aria-selected", String(on));
        button.tabIndex = on ? 0 : -1;
      }
      let first = null;
      for (const cls of tab.sections) {
        const section = el.querySelector(`.${CSS.escape(cls)}`);
        if (!section) continue;
        section.hidden = !on;
        if (!first) {
          // the tab's first section is its panel for assistive tech; the rest just follow it
          section.setAttribute("role", "tabpanel");
          if (!section.id) section.id = `rp-panel-${tab.id}`;  // lazy sections keep their own ids
          section.setAttribute("aria-labelledby", `rp-tab-${tab.id}`);
          first = section;
        }
      }
      if (button && first) button.setAttribute("aria-controls", first.id);
    }
    // a lazy section behind a tab can't be scrolled to, so opening the tab is its trigger
    fireLazyFor(active);
  }

  function fireLazyFor(tab) {
    const loaders = { overtime: loadOverTime, changes: loadChanges, domains: loadDomains };
    const statuses = { overtime: state.overTime, changes: state.changes, domains: state.domains };
    if (loaders[tab.id] && statuses[tab.id].status === "idle") loaders[tab.id]();
  }

  function selectTab(id, { focus } = {}) {
    if (!tabById(id) || tabById(id).id === state.tab) return;
    state.tab = tabById(id).id;
    writeUrl();
    applyTab();
    WardWiseExplorer.track("report_tab", { tab: state.tab, area_type: state.cfg.api });
    if (focus) {
      const controls = root()?.querySelector(`#rp-tab-${CSS.escape(state.tab)}`)?.getAttribute("aria-controls");
      const panel = controls ? document.getElementById(controls) : null;
      if (panel) {
        panel.tabIndex = -1;
        panel.focus({ preventScroll: true });
      }
    }
  }

  function onTabKeydown(event) {
    const button = event.target.closest('[role="tab"][data-tab]');
    if (!button) return;
    const ids = tabsFor().map((tab) => tab.id);
    const index = ids.indexOf(button.dataset.tab);
    let next = null;
    if (event.key === "ArrowRight") next = ids[(index + 1) % ids.length];
    else if (event.key === "ArrowLeft") next = ids[(index - 1 + ids.length) % ids.length];
    else if (event.key === "Home") next = ids[0];
    else if (event.key === "End") next = ids[ids.length - 1];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    root()?.querySelector(`#rp-tab-${CSS.escape(next)}`)?.focus();
  }

  function renderShare() {
    return `<div class="report-share">
      <button type="button" class="ww-cta ghost" data-act="copy">Copy link</button>
      <button type="button" class="ww-cta ghost" data-act="print">Print</button>
      <span class="soft">The link carries this ${esc(state.cfg.noun)}, the list and the year.</span>
    </div>`;
  }

  function render() {
    const el = root();
    if (!el) return;
    document.title = `${nameFor(state.areaId)} — full report — Ward Wise`;
    const overTimeBody = el.querySelector("[data-overtime-body]")?.innerHTML;
    el.innerHTML = renderHead() + renderIdentity() + renderTabs()
      + `<div class="report-tabpanels">${renderHero() + renderRead() + renderMix() + renderCtas() + renderPeek() + renderOverTimeShell() + renderChangesShell() + renderDomainsShell() + renderAlderShell()}</div>`
      + renderShare();
    C.attachTips(el);
    wireControls();
    applyTab();
    // the lazy sections keep what they had if nothing about them changed
    if (overTimeBody && state.overTime.key === overTimeKey() && state.overTime.status === "ready") renderOverTime();
    if (state.domains.status === "ready" && state.domains.key === domainsKey()) mountDomains();
    if (state.changes.status === "ready" && state.changes.key === changesKey()) mountChanges();
    observeLazy();
    if (state.cfg.api === "ward") loadRepresented();
  }

  function wireControls() {
    document.getElementById("rp-geo")?.addEventListener("change", async (event) => {
      const cfg = G.byApi(event.target.value);
      await switchGeography(cfg);
    });
    document.getElementById("rp-area")?.addEventListener("change", (event) => {
      state.areaId = event.target.value;
      state.openMetric = null;
      resetNarrative();
      writeUrl({ push: true });
      WardWiseExplorer.track("report_area", { area_type: state.cfg.api, area_id: state.areaId });
      render();
      loadNarrative();
    });
    document.getElementById("rp-year")?.addEventListener("change", async (event) => {
      await setYear(event.target.value === "latest" ? "latest" : Number(event.target.value));
    });
    document.getElementById("rp-add")?.addEventListener("change", (event) => {
      const id = event.target.value;
      if (!id) return;
      state.weights[id] = 1;
      state.presetId = null;
      writeUrl();
      render();
    });
  }

  async function setYear(year) {
    state.year = year;
    await loadSlice(String(year));
    writeUrl();
    render();
  }

  function resetNarrative() {
    state.narrative = null;
  }

  async function switchGeography(cfg) {
    resetNarrative();
    state.cfg = cfg;
    state.openMetric = null;
    await loadAreas(cfg);
    const ranked = S.computeComposite(await loadSlice(String(state.year)), state.weights).rows.filter((r) => r.rank);
    state.areaId = String(ranked[0]?.area_id ?? G.areaIdOf(areaList()[0], cfg));
    writeUrl({ push: true });
    render();
    loadNarrative();
  }

  async function loadRepresented() {
    if (state.details[state.areaId] !== undefined) return;
    const id = state.areaId;
    try {
      state.details[id] = await WardWiseExplorer.fetchWardDetails(id);
    } catch (_error) {
      state.details[id] = null;
    }
    if (state.areaId !== id) return;
    const host = root()?.querySelector("[data-alder-tab]");
    if (host) host.innerHTML = renderRepresented();
  }

  // ---- rank over time ----

  function overTimeKey() {
    return `${state.cfg.api}|${state.areaId}|${G.serializeMix(state.weights)}`;
  }

  function sampledYears() {
    const years = (state.manifest.data_years || []).filter((y) => y >= FIRST_TRAJECTORY_YEAR && y <= new Date().getFullYear());
    const cap = MAX_YEAR_FETCHES[state.cfg.api] || 8;
    if (years.length <= cap) return years;
    // always keep the newest years; thin the older ones evenly
    const newest = years.slice(-Math.ceil(cap / 2));
    const older = years.slice(0, years.length - newest.length);
    const step = older.length / Math.floor(cap / 2);
    const picked = [];
    for (let i = 0; i < Math.floor(cap / 2); i += 1) picked.push(older[Math.floor(i * step)]);
    return [...new Set([...picked, ...newest])].sort((a, b) => a - b);
  }

  async function loadOverTime() {
    const key = overTimeKey();
    if (state.overTime.key === key && state.overTime.status !== "idle") return;
    const token = ++state.token;
    const years = sampledYears();
    state.overTime = { key, status: "loading", points: years.map((year) => ({ year, pending: true })) };
    renderOverTime();
    const queue = [...years];
    const worker = async () => {
      while (queue.length) {
        const year = queue.shift();
        try {
          const slice = await loadSlice(String(year));
          if (state.token !== token) return;
          const { byId, ranked } = S.computeComposite(slice, state.weights);
          const row = byId.get(String(state.areaId));
          const point = state.overTime.points.find((p) => p.year === year);
          Object.assign(point, { pending: false, rank: row?.rank || null, of: ranked, used: row?.used || 0, empty: !row?.rank });
        } catch (_error) {
          const point = state.overTime.points.find((p) => p.year === year);
          if (point) Object.assign(point, { pending: false, empty: true });
        }
        if (state.token === token) renderOverTime();
      }
    };
    await Promise.all(Array.from({ length: WORKERS[state.cfg.api] || 3 }, worker));
    if (state.token === token) {
      state.overTime.status = "ready";
      renderOverTime();
    }
  }

  function termBands() {
    if (state.cfg.api !== "ward" || !state.terms?.terms) return [];
    const keys = Object.keys(state.terms.terms).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    return keys.map((start, i) => ({ from: start, to: keys[i + 1] || start + 4, label: `${start} term` }));
  }

  function renderOverTime() {
    const host = root()?.querySelector("[data-overtime-body]");
    if (!host) return;
    const { points, status } = state.overTime;
    const n = points.reduce((best, p) => Math.max(best, p.of || 0), 0) || S.computeComposite(currentSlice(), state.weights).ranked || 1;
    const real = points.filter((p) => p.rank);
    const chips = points.map((p) => {
      const cls = `ww-yearchip${p.pending ? " pending" : ""}${p.empty ? " empty" : ""}${String(p.year) === String(state.year) ? " on" : ""}`;
      const rank = p.pending ? "…" : p.rank ? `<span class="rk${S.medalClass(p.rank, " m-")}">${S.ordinal(p.rank)}</span>` : `<span class="rk none">no data</span>`;
      return `<button type="button" class="${cls}" data-act="year" data-year="${p.year}" title="Read the report with ${p.year} data"><span class="yr">${p.year}</span>${rank}</button>`;
    }).join("");
    let caption = "";
    if (status === "ready" && real.length > 1) {
      const first = real[0];
      const last = real[real.length - 1];
      const moved = first.rank - last.rank;
      caption = moved === 0
        ? `<b>Same standing</b> in ${first.year} and ${last.year}.`
        : `<b>${moved > 0 ? "Up" : "Down"} ${Math.abs(moved)} place${Math.abs(moved) === 1 ? "" : "s"}</b> between ${first.year} and ${last.year} on ${esc(listName())}${real.some((p) => p.used < basketFacts().usable.length) ? " (earlier years rest on fewer measures)" : ""}.`;
    } else if (status === "ready" && real.length <= 1) {
      caption = `<b>Only one year</b> of the current list has data for this ${esc(state.cfg.noun)}.`;
    }
    host.innerHTML =
      (real.length > 1 || status !== "ready" ? C.trajectory({ points, n, currentYear: state.year, bands: termBands() }) : "") +
      `<div class="ww-yearchips">${chips}</div>` +
      (caption ? `<p class="ww-trendcap">${caption}</p>` : "");
  }

  // ---- domains ----

  function changesKey() {
    return `${state.cfg.api}|${state.areaId}`;
  }

  async function loadChanges() {
    const key = changesKey();
    if (state.changes.key === key && state.changes.status !== "idle") return;
    const host = root()?.querySelector("[data-changes-body]");
    state.changes = { key, status: "loading", report: null };
    if (host) host.innerHTML = `<p class="soft">Loading history…</p>`;
    const cfg = state.cfg;
    const ctx = {
      manifest: state.manifest,
      get metrics() { return metricsForGeography(); },
      areaType: cfg.api,
      get areaId() { return state.areaId; },
      get areas() { return state.areas[cfg.api] || []; },
      idOf: (area) => String(G.areaIdOf(area, cfg)),
      get label() { return nameFor(state.areaId); },
      noun: cfg.noun,
      plural: cfg.plural,
      remapYears: cfg.remapYears,
      get terms() { return state.terms; },
      get slices() { return state.slices[cfg.api] || {}; },
      loadSlice: (yearKey) => loadSlice(yearKey, cfg.api),
      root: () => root(),
      dictionaryBase: "/dictionary",
      initialWindow: state.changesWindow,
      onState: (w) => { state.changesWindow = w; writeUrl(); },
    };
    const report = WardWiseReportChanges.create(ctx);
    await report.load();
    if (state.changes.key !== key) return;
    state.changes = { key, status: report.status === "ready" ? "ready" : "error", report };
    mountChanges();
    if (cfg.api !== "chi") report.loadPeers();
  }

  function mountChanges() {
    const host = root()?.querySelector("[data-changes-body]");
    const { report } = state.changes;
    if (!host || !report) return;
    report.mount(host);
  }

  function domainsKey() {
    return `${state.cfg.api}|${state.areaId}`;
  }

  async function loadDomains() {
    const key = domainsKey();
    if (state.domains.key === key && state.domains.status !== "idle") return;
    const host = root()?.querySelector("[data-domains-body]");
    state.domains = { key, status: "loading", ctx: null, report: null };
    if (host) host.innerHTML = `<p class="soft">Loading every measure…</p>`;
    const cfg = state.cfg;
    const ctx = {
      manifest: state.manifest,
      get metrics() { return metricsForGeography(); },
      get slices() { return state.slices[cfg.api] || {}; },
      get areaId() { return state.areaId; },
      get areas() { return state.areas[cfg.api] || []; },
      idOf: (area) => String(G.areaIdOf(area, cfg)),
      areaType: cfg.api,
      noun: cfg.noun,
      plural: cfg.plural,
      get label() { return nameFor(state.areaId); },
      get shortLabel() { return cfg.short(findArea(state.areaId)); },
      remapYears: cfg.remapYears,
      dictionaryBase: "/dictionary",
      root: () => root(),
      character: { status: "idle" },
      metricById: null,
    };
    const report = WardWiseReportDomains.create(ctx);
    // the trend column needs each metric's last two vintages
    const needed = new Set(["latest"]);
    for (const metric of ctx.metrics) {
      const window_ = report.trendWindow(metric.metric_id);
      if (window_) { needed.add(String(window_.from)); needed.add(String(window_.to)); }
    }
    try {
      const queue = [...needed];
      const worker = async () => { while (queue.length) await loadSlice(queue.shift(), cfg.api); };
      await Promise.all(Array.from({ length: WORKERS[cfg.api] || 3 }, worker));
    } catch (_error) {
      if (state.domains.key === key) {
        state.domains.status = "error";
        if (host) host.innerHTML = `<p>Couldn't load the full breakdown — try reloading.</p>`;
      }
      return;
    }
    if (state.domains.key !== key) return;
    state.domains = { key, status: "ready", ctx, report };
    mountDomains();
  }

  function mountDomains() {
    const host = root()?.querySelector("[data-domains-body]");
    const { report } = state.domains;
    if (!host || !report) return;
    // the domain section shows the LATEST picture regardless of the year pill: its trend column
    // is already time-aware, and its slices are keyed "latest"
    report.mount(host);
  }

  // ---- lazy sections ----

  // The two heavy sections load when the reader gets near them. IntersectionObserver does the
  // watching; a scroll/visibility check backs it up (observers stay silent in hidden tabs), and
  // the cheap rank-over-time section starts on its own shortly after first paint.
  function observeLazy() {
    const pending = new Map([["rp-overtime", loadOverTime], ["rp-changes", loadChanges], ["rp-domains", loadDomains]]);
    const fire = (id) => {
      const load = pending.get(id);
      if (!load) return;
      pending.delete(id);
      load();
    };
    const check = () => {
      for (const id of [...pending.keys()]) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top < window.innerHeight + 240) fire(id);
      }
    };
    if (window.IntersectionObserver) {
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          fire(entry.target.id);
        }
      }, { rootMargin: "240px 0px" });
      pending.forEach((_load, id) => {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      });
    }
    window.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    if (state.tab === "overtime") setTimeout(() => fire("rp-overtime"), 1500);
    setTimeout(check, 400);
  }

  // ---- delegated actions ----

  function onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    if (act === "preset") {
      applyPreset(WardWisePresetTools.byId(target.dataset.presetId));
      state.openMetric = null;
      writeUrl();
      render();
    } else if (act === "remove") {
      delete state.weights[target.dataset.metricId];
      state.presetId = null;
      writeUrl();
      render();
    } else if (act === "prose-metric") {
      event.preventDefault();
      const id = target.dataset.metric;
      const box = root()?.querySelector(`.ww-rankbox[data-metricbox="${CSS.escape(id)}"]`);
      if (box) {
        state.openMetric = id;
        const peek = root()?.querySelector(".report-peek");
        if (peek) {
          peek.outerHTML = renderPeek();
        applyTab();  // a re-rendered section must keep its tab's hidden state
          C.attachTips(root());
        }
        const fresh = root()?.querySelector(`.ww-rankbox[data-metricbox="${CSS.escape(id)}"]`);
        fresh?.classList.add("is-linked");
        fresh?.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => fresh?.classList.remove("is-linked"), 1600);
      } else {
        window.location.href = `/dictionary?metric=${encodeURIComponent(id)}`;
      }
    } else if (act === "rankbox") {
      const id = target.dataset.metricbox;
      state.openMetric = state.openMetric === id ? null : id;
      const peek = root()?.querySelector(".report-peek");
      if (peek) {
        peek.outerHTML = renderPeek();
        applyTab();  // a re-rendered section must keep its tab's hidden state
        C.attachTips(root());
      }
    } else if (act === "tab") {
      selectTab(target.dataset.tab, { focus: true });
    } else if (act === "year") {
      setYear(Number(target.dataset.year));
    } else if (act === "copy") {
      WardWiseExplorer.track("report_shared", { how: "copy_link" });
      const url = window.location.href;
      const done = () => { target.textContent = "Link copied"; setTimeout(() => { target.textContent = "Copy link"; }, 2000); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => window.prompt("Copy this link", url));
      else window.prompt("Copy this link", url);
    } else if (act === "print") {
      WardWiseExplorer.track("report_shared", { how: "print" });
      window.print();
    }
  }

  // ---- boot ----

  async function boot() {
    const el = root();
    try {
      state.manifest = await WardWiseExplorer.fetchExplorerManifest();
      readUrl();
      await loadAreas(state.cfg);
      const requested = window.WW_REPORT.area_id;
      const normalized = requested ? state.cfg.normalizeId(requested) : null;
      if (normalized && findArea(normalized)) {
        state.areaId = normalized;
      } else {
        await loadSlice(String(state.year));
        const ranked = S.computeComposite(currentSlice(), state.weights).rows.filter((r) => r.rank);
        state.areaId = String(ranked[0]?.area_id ?? G.areaIdOf(areaList()[0], state.cfg));
        if (requested && el) {
          el.insertAdjacentHTML("afterbegin", `<p class="report-note">No ${esc(state.cfg.noun)} called “${esc(requested)}” — showing ${esc(nameFor(state.areaId))} instead.</p>`);
        }
      }
      await loadSlice(String(state.year));
      if (state.year !== "latest" && !Object.keys(currentSlice()).length) state.year = "latest";
      writeUrl();
      render();
      loadNarrative();
      WardWiseExplorer.track("report_full", { area_type: state.cfg.api, area_id: state.areaId, preset_id: state.presetId });
      if (state.cfg.api === "ward") {
        WardWiseExplorer.fetchJson("/api/aldermanic-terms", "Unable to load terms.")
          .then((terms) => { state.terms = terms; const host = root()?.querySelector("[data-alder-tab]"); if (host) host.innerHTML = renderRepresented(); if (state.overTime.status === "ready") renderOverTime(); if (state.changes.status === "ready") state.changes.report?.rerender(); })
          .catch(() => {});
      }
    } catch (error) {
      if (el) el.innerHTML = `<p class="report-note">Couldn't load the report — ${esc(error.message || "try reloading")}.</p>`;
    }
  }

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onTabKeydown);
  window.addEventListener("popstate", () => window.location.reload());
  document.addEventListener("wardwise:themechange", () => { if (state.manifest && state.areaId) render(); });
  WardWiseReportDomains.installPrintHandlers();
  boot();
})();
