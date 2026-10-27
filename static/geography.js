// The three geographies the explorer, reports and comparisons all speak, in one place: how each is
// loaded and labelled, and the URL vocabulary that lets a basket travel between pages unchanged.
//
// Every score row and geojson feature carries a uniform area_id; these configs say what that id is
// called in each source, how to normalize one that arrives from a URL, and how to talk about the
// area in a sentence ("Ward 14", "West Town", "OriHow"). Brand casing (χGRID) is preserved by the
// casing helpers, which is why sentences never call toLowerCase on a label directly.
window.WardWiseGeography = (function () {
  const api = () => window.WardWiseExplorer;
  const pad2 = (value) => String(Number(value)).padStart(2, "0");

  const AREA_TYPES = {
    ward: {
      api: "ward",
      slug: "ward",
      label: "Wards",
      noun: "ward",
      plural: "wards",
      idProp: "ward_id",
      normalizeId: (value) => (/^\d{1,2}$/.test(String(value)) ? pad2(value) : String(value)),
      loadAreas: () => api().fetchExplorerWards().then((r) => r.wards || []),
      loadGeojson: () => api().fetchWardGeojson(),
      rankerTitle: "Top wards by weighted composite",
      name: (area) => area?.display_name || `Ward ${Number(area?.ward_id)}`,
      sub: (area) =>
        (area?.community_area_overlaps || [])
          .slice(0, 2)
          .map((overlap) => overlap.name)
          .filter(Boolean)
          .join(" & "),
      short: (area) => `W${Number(area?.ward_id)}`,
      hasAlder: true,
      hasPopulation: true,
      remapYears: [2015, 2023],
    },
    community_area: {
      api: "community_area",
      slug: "neighborhood",
      label: "Neighborhoods",
      noun: "neighborhood",
      plural: "neighborhoods",
      idProp: "community_area_id",
      normalizeId: (value) => (/^\d{1,2}$/.test(String(value)) ? pad2(value) : String(value)),
      loadAreas: () => api().fetchCommunityAreas().then((r) => r.community_areas || []),
      loadGeojson: () => api().fetchCommunityAreaGeojson(),
      rankerTitle: "Top neighborhoods by weighted composite",
      name: (area) => area?.display_name || area?.name || `Neighborhood ${area?.community_area_id}`,
      sub: (area) => {
        const wards = (area?.ward_overlaps || [])
          .slice(0, 3)
          .map((overlap) => Number(overlap.ward_id ?? overlap.ward ?? overlap.ward_number))
          .filter((n) => Number.isFinite(n));
        return wards.length ? `Ward${wards.length > 1 ? "s" : ""} ${wards.join(" · ")}` : "";
      },
      short: (area) => `#${Number(area?.community_area_number ?? area?.community_area_id)}`,
      hasAlder: false,
      hasPopulation: false,
      remapYears: [],
    },
    chi: {
      api: "chi",
      slug: "chi",
      // User-facing labels use the χGRID brand mark; the area_type key stays the ASCII "chi".
      label: "χGRIDs",
      noun: "χGRID",
      plural: "χGRIDs",
      idProp: "chi_id",
      normalizeId: (value) => String(value).toUpperCase(),
      loadAreas: () => api().fetchChis().then((r) => r.chis || []),
      loadGeojson: () => api().fetchChigridGeojson(),
      rankerTitle: "Top χGRIDs by weighted composite",
      name: (area) => area?.display_name || area?.label || area?.chi_id || "χGRID",
      sub: (area) => area?.long_name || "",
      short: (area) => area?.chi_id || "",
      hasAlder: false,
      hasPopulation: false,
      remapYears: [],
    },
    precinct: {
      // Election precincts are a LENS on one ward, not a peer geography: explorer-only, entered
      // from a ward, loaded one ward at a time (options.wardId). explorerOnly keeps them out of the
      // report / compare / index pickers, which would otherwise list 1,291 unnamed rows.
      api: "precinct",
      slug: null,
      explorerOnly: true,
      parent: "ward",
      label: "Precincts",
      noun: "precinct",
      plural: "precincts",
      idProp: "ward_precinct",
      normalizeId: (value) => String(value).padStart(5, "0"),
      loadAreas: (options) => api().fetchPrecincts(options?.wardId).then((r) => r.precincts || []),
      loadGeojson: (options) => api().fetchPrecinctGeojson(options?.wardId),
      rankerTitle: "Precincts by weighted composite",
      name: (area) => area?.display_name || `Precinct ${area?.ward_precinct}`,
      sub: (area) => area?.primary_community_area || "",
      short: (area) => (area?.ward_id && area?.precinct_number != null
        ? `${Number(area.ward_id)}-${area.precinct_number}` : area?.ward_precinct || ""),
      hasAlder: false,
      hasPopulation: false,
      remapYears: [],
    },
  };

  // The geographies every page speaks (report, compare, index): the ones without explorerOnly.
  function peerTypes() {
    return Object.values(AREA_TYPES).filter((cfg) => !cfg.explorerOnly);
  }

  // byApi for pages that only handle peer geographies: an explorer-only type in a URL falls back
  // to wards rather than rendering a picker of 1,291 precincts.
  function peerByApi(areaType) {
    const cfg = AREA_TYPES[areaType];
    return cfg && !cfg.explorerOnly ? cfg : AREA_TYPES.ward;
  }

  const SLUG_TO_API = Object.fromEntries(peerTypes().map((cfg) => [cfg.slug, cfg.api]));

  function byApi(areaType) {
    return AREA_TYPES[areaType] || AREA_TYPES.ward;
  }

  function bySlug(slug) {
    const apiType = SLUG_TO_API[slug] || (AREA_TYPES[slug] ? slug : null);
    return apiType ? AREA_TYPES[apiType] : null;
  }

  function areaIdOf(area, cfg) {
    return area?.[cfg.idProp] ?? area?.area_id ?? area?.ward_id;
  }

  // Leave intentionally-cased brand nouns (χGRID) alone; only title-case plain words.
  function capitalize(text) {
    if (!text) return text;
    if (text !== text.toLowerCase()) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Plural label lowercased for mid-sentence use, preserving brand casing (χGRIDs).
  function labelLower(cfg) {
    const label = cfg.label;
    return label.slice(1) === label.slice(1).toLowerCase() ? label.toLowerCase() : label;
  }

  function countLabel(n, cfg) {
    return `${n} ${n === 1 ? cfg.noun : cfg.plural}`;
  }

  // ---- the basket in a URL: m=id,id:weight (weight 1 omitted) ----

  function serializeMix(weights) {
    return Object.entries(weights || {})
      .filter(([, weight]) => Number(weight) > 0)
      .map(([id, weight]) => (Number(weight) === 1 ? id : `${id}:${Number(weight)}`))
      .join(",");
  }

  function parseMix(text) {
    if (!text) return null;
    const weights = {};
    String(text)
      .split(",")
      .forEach((token) => {
        const [id, raw] = token.split(":");
        const key = (id || "").trim();
        if (!key) return;
        const weight = Number(raw ?? 1);
        weights[key] = Number.isFinite(weight) && weight > 0 ? weight : 1;
      });
    return Object.keys(weights).length ? weights : null;
  }

  function query(options) {
    const params = new URLSearchParams();
    const mix = options?.weights ? serializeMix(options.weights) : options?.mix;
    if (mix) params.set("m", mix);
    if (options?.presetId) params.set("p", options.presetId);
    if (options?.year && options.year !== "latest") params.set("y", String(options.year));
    if (options?.directions) params.set("dir", options.directions); // contested-direction choices, see scoring.js
    for (const [key, value] of Object.entries(options?.extra || {})) {
      if (value != null && value !== "") params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : "";
  }

  function reportUrl(areaType, areaId, options) {
    const cfg = byApi(areaType);
    return `/report/${cfg.slug}/${encodeURIComponent(areaId)}${query(options)}`;
  }

  function compareUrl(areaType, aId, bId, options) {
    const cfg = byApi(areaType);
    const extra = { area_type: cfg.api, a: aId, ...(bId ? { b: bId } : {}), ...(options?.extra || {}) };
    return `/compare${query({ ...options, extra })}`;
  }

  function indexUrl(areaType, options) {
    const cfg = byApi(areaType);
    return `/index${query({ ...options, extra: { area: cfg.api, ...(options?.extra || {}) } })}`;
  }

  function landingUrl(areaType, areaId, options) {
    const cfg = byApi(areaType);
    const extra = { area: cfg.api, ...(areaId ? { sel: areaId } : {}), ...(options?.extra || {}) };
    return `/${query({ ...options, extra })}`;
  }

  return {
    AREA_TYPES,
    byApi,
    bySlug,
    peerTypes,
    peerByApi,
    areaIdOf,
    capitalize,
    labelLower,
    countLabel,
    serializeMix,
    parseMix,
    reportUrl,
    compareUrl,
    indexUrl,
    landingUrl,
  };
})();
