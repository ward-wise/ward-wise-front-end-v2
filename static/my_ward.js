// WardWiseMyWard: the one place a visitor picks their ward. It lives in the header on every
// page, remembers the choice in this browser, and tells the page when it changes. Pages never
// carry their own ward picker; they read get() and listen for "fd:myward".
// Standalone on purpose: the map and dictionary pages don't load frontdoor.js.
(function () {
  const KEY = "wardwise:ward";
  const WARDS = Array.from({ length: 50 }, (_, i) => String(i + 1).padStart(2, "0"));
  const listeners = new Set();
  let menu = null;
  let button = null;

  function get() {
    try {
      const value = localStorage.getItem(KEY);
      return value && WARDS.includes(value) ? value : null;
    } catch (_error) {
      return null;
    }
  }

  // how: "picker", "location" or "adopt" (taking the ward a link showed), for the ward_selected count.
  function set(ward, how) {
    const next = ward && WARDS.includes(ward) ? ward : null;
    if (next && next !== get() && window.WardWiseAnalytics) window.WardWiseAnalytics.track("ward_selected", { ward: next, how: how || "other" });
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch (_error) {
      /* private mode: the choice lasts for this page only */
    }
    announce(next);
  }

  function announce(ward) {
    paintButton();
    listeners.forEach((fn) => fn(ward));
    document.dispatchEvent(new CustomEvent("fd:myward", { detail: { ward } }));
  }

  // Another tab changed it.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) announce(get());
  });

  // --- Locate: which ward polygon holds the visitor's position ------------------------

  function inRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function inPolygon(point, polygon) {
    // First ring is the outline, the rest are holes.
    return inRing(point, polygon[0]) && !polygon.slice(1).some((hole) => inRing(point, hole));
  }

  // Whether [lon, lat] falls inside a GeoJSON Polygon or MultiPolygon.
  function contains(geometry, lon, lat) {
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some((polygon) => inPolygon([lon, lat], polygon));
  }

  async function wardAt(lon, lat) {
    const response = await fetch("/api/wards.geojson");
    if (!response.ok) throw new Error("Ward boundaries are unavailable.");
    const collection = await response.json();
    const hit = collection.features.find((feature) => contains(feature.geometry, lon, lat));
    return hit ? String(hit.properties.ward_id).padStart(2, "0") : null;
  }

  function locate(statusNode) {
    if (!navigator.geolocation) {
      statusNode.textContent = "This browser can't share its location.";
      return;
    }
    statusNode.textContent = "Finding your ward…";
    navigator.geolocation.getCurrentPosition(async (position) => {
      try {
        const ward = await wardAt(position.coords.longitude, position.coords.latitude);
        if (!ward) {
          if (window.WardWiseAnalytics) window.WardWiseAnalytics.track("lookup_failed", { how: "location" });
          statusNode.textContent = "That location is outside Chicago's 50 wards.";
          return;
        }
        set(ward, "location");
        close();
      } catch (error) {
        statusNode.textContent = error.message;
      }
    }, () => {
      statusNode.textContent = "Location is off. Pick your ward below.";
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  }

  // --- The picker (used in the header menu and inline on pages that need a ward) ------

  function pickerHtml(current) {
    return `
      <button type="button" class="mw-locate" data-mw-locate>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z"/><circle cx="10" cy="8" r="2.2"/></svg>
        Use my location
      </button>
      <p class="mw-status" data-mw-status role="status"></p>
      <p class="mw-label">Or choose a ward</p>
      <div class="mw-grid" role="group" aria-label="Wards 1 to 50">
        ${WARDS.map((ward) => `<button type="button" data-mw-ward="${ward}" aria-pressed="${ward === current}">${Number(ward)}</button>`).join("")}
      </div>
      <a class="mw-help" href="https://www.chicago.gov/city/en/depts/mayor/iframe/lookup_ward_and_alderman.html" target="_blank" rel="noopener">Find your ward by address on chicago.gov</a>`;
  }

  function wirePicker(root, { onPick } = {}) {
    root.addEventListener("click", (event) => {
      const pick = event.target.closest("[data-mw-ward]");
      if (pick) {
        set(pick.dataset.mwWard, "picker");
        if (onPick) onPick(pick.dataset.mwWard);
        return;
      }
      if (event.target.closest("[data-mw-locate]")) locate(root.querySelector("[data-mw-status]"));
    });
  }

  // Inline version, for a page with nothing to show until a ward is chosen.
  function mountInline(container) {
    container.innerHTML = `<div class="mw-inline">${pickerHtml(get())}</div>`;
    wirePicker(container);
  }

  // --- Header button + menu ------------------------------------------------------------

  function paintButton() {
    if (!button) return;
    const ward = get();
    button.querySelector("[data-mw-text]").textContent = ward ? `Ward ${Number(ward)}` : "Your ward";
    button.classList.toggle("is-set", Boolean(ward));
    if (menu) {
      menu.querySelectorAll("[data-mw-ward]").forEach((cell) => cell.setAttribute("aria-pressed", String(cell.dataset.mwWard === ward)));
    }
  }

  function open() {
    if (!menu) return;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const current = menu.querySelector('[aria-pressed="true"]') || menu.querySelector("[data-mw-locate]");
    current.focus();
  }

  function close() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  function initHeader() {
    const slot = document.querySelector("[data-mw-slot]");
    if (!slot) return;
    slot.innerHTML = `
      <button type="button" class="mw-button" aria-haspopup="dialog" aria-expanded="false" data-mw-button>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 18s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10z"/><circle cx="10" cy="8" r="2.2"/></svg>
        <span data-mw-text>Your ward</span>
        <svg class="mw-chev" viewBox="0 0 12 8" aria-hidden="true"><path d="m1 1.5 5 5 5-5"/></svg>
      </button>
      <div class="mw-menu" role="dialog" aria-label="Choose your ward" hidden data-mw-menu>
        <p class="mw-title">Your ward</p>
        <p class="mw-sub">Every page follows it. Saved in this browser only.</p>
        ${pickerHtml(get())}
        <button type="button" class="mw-clear" data-mw-clear>Clear</button>
      </div>`;
    button = slot.querySelector("[data-mw-button]");
    menu = slot.querySelector("[data-mw-menu]");
    wirePicker(menu, { onPick: close });
    button.addEventListener("click", () => (menu.hidden ? open() : close()));
    menu.querySelector("[data-mw-clear]").addEventListener("click", () => { set(null); close(); });
    document.addEventListener("click", (event) => {
      if (!slot.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        close();
        button.focus();
      }
    });
    paintButton();
  }

  window.WardWiseMyWard = {
    get,
    set,
    open,
    mountInline,
    contains,
    onChange: (fn) => listeners.add(fn),
    label: (ward) => `Ward ${Number(ward)}`,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initHeader);
  else initHeader();
})();
