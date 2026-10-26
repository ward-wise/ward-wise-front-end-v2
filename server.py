"""Ward Wise Penlight — local dev server for the public site.

Renders the same templates the static build does (live, so edit-and-reload works) and proxies
`/api/*` to the Penlight API so every page gets real data with no credentials. In production none
of this runs: GitHub Pages serves the built pages and CloudFront routes `/api/*` to the API.

    python server.py            # Jinja live, http://localhost:1837
    python server.py --built    # serve dist/ exactly as Pages will (run scripts/build_static.py first)

Environment:
  PENLIGHT_API_BASE   where /api/* is forwarded             (default: https://penlight.wardwise.org)
  PENLIGHT_SITE_BASE  where private-app pages link to         (default: https://penlight.wardwise.org)
  PROXY_ALLOW_WRITES  1 to forward POSTs upstream             (default: 0, stubbed — see proxy())
  GA_ID               analytics id to render                   (default: none locally)
  PORT                default 1837, the year Chicago was incorporated
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import requests
from flask import Flask, Response, abort, jsonify, redirect, request, send_from_directory

import penlight_site as _site  # route table + Jinja environment, shared with the static build

API_BASE = os.environ.get("PENLIGHT_API_BASE", _site.SITE_BASE_DEFAULT).rstrip("/")
SITE_BASE = os.environ.get("PENLIGHT_SITE_BASE", _site.SITE_BASE_DEFAULT).rstrip("/")
ALLOW_WRITES = os.environ.get("PROXY_ALLOW_WRITES", "0") == "1"
BUILT = "--built" in sys.argv
DIST = Path(__file__).resolve().parent / "dist"

# Headers that describe the *hop*, not the payload — forwarding them would corrupt the
# response (a re-chunked body carrying the upstream's Content-Length, say).
HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding", "connection"}

app = Flask(__name__, static_folder=None)

# One keep-alive session for every upstream call. Reusing the TCP and TLS connection saves a few
# hundred milliseconds per request, which is the difference between autocomplete feeling live and
# feeling laggy.
HTTP = requests.Session()


def _mtime_version(filename: str) -> str:
    path = _site.STATIC / filename
    return str(int(path.stat().st_mtime)) if path.exists() else ""


ENV = _site.make_environment(_mtime_version, app_base=SITE_BASE, ga_id=os.environ.get("GA_ID") or None,
                             posthog_key=os.environ.get("POSTHOG_KEY") or None, build_sha="dev")


# --- Pages -------------------------------------------------------------------

def _render(page: _site.Page, path: str | None = None) -> str:
    ENV.cache.clear() if ENV.cache is not None else None  # pick up template edits without restarting
    return ENV.get_template(page.template).render(**_site.page_context(page, path=path))


def _register_page(page: _site.Page) -> None:
    def view(**_kwargs):
        if BUILT:
            rel = "index.html" if page.path == "/" else f"{page.path.strip('/')}/index.html"
            return send_from_directory(DIST, rel)
        return _render(page, request.path)

    for path in (page.path, *page.aliases):
        app.add_url_rule(path, endpoint=f"page_{page.key}_{len(app.url_map._rules)}", view_func=view)


for _page in _site.PAGES:
    _register_page(_page)


@app.get("/report/<slug>/<area_id>")
def report_area(slug: str, area_id: str):
    # CloudFront rewrites this to /report/ in production; the page reads its own URL.
    page = _site.PAGES_BY_KEY["report"]
    if BUILT:
        return send_from_directory(DIST, "report/index.html")
    return _render(page, request.path)


def _redirect_keeping_query(target: str):
    # Same as the built meta-refresh pages: the query string (metric, area…) carries over.
    return lambda: redirect(target + (f"?{request.query_string.decode()}" if request.query_string else ""), 301)


for _source, _target in _site.REDIRECTS.items():
    app.add_url_rule(_source, endpoint=f"redirect_{_source}", view_func=_redirect_keeping_query(_target))


@app.get("/static/<path:filename>")
def static_file(filename: str):
    return send_from_directory(DIST / "static" if BUILT else _site.STATIC, filename)


@app.get("/build.json")
def build_manifest():
    if BUILT:
        return send_from_directory(DIST, "build.json")
    return jsonify({"sha": "dev", "built_at": None})


@app.get("/.well-known/<path:_>")
def well_known(_):
    abort(404)


# --- API proxy ---------------------------------------------------------------

@app.route("/api/<path:api_path>", methods=["GET", "POST"])
def proxy(api_path: str):
    """Forward to the Penlight API, streaming bytes through untouched.

    Bytes, not JSON: /api/civic-assets/... serves the signifier JPEGs that the map view and
    Support page render, so the proxy has to stay content-type agnostic. Cookies are NOT
    forwarded: local dev is always signed out (/api/me → 401), by design.
    """
    if request.method == "POST" and not ALLOW_WRITES:
        # The map view POSTs an analytics event on every metric toggle. Clicking around locally
        # shouldn't write rows into production, so acknowledge without forwarding.
        return jsonify({"ok": True, "stubbed": True})

    upstream = f"{API_BASE}/api/{api_path}"
    try:
        response = HTTP.request(
            request.method,
            upstream,
            params=request.args,
            data=request.get_data(),
            headers={"Content-Type": request.content_type} if request.content_type else {},
            timeout=30,
        )
    except requests.RequestException as error:
        return jsonify({"error": f"Upstream request failed: {error}"}), 502

    headers = [(key, value) for key, value in response.headers.items() if key.lower() not in HOP_BY_HOP]
    return Response(response.content, status=response.status_code, headers=headers)


# Pages that stay in the private app (survey, account, admin…). Locally they link out to the live
# site via url_for; a direct hit here says so instead of 404ing mysteriously.
for _prefix in _site.APP_PATH_PREFIXES:
    if _prefix.startswith("/api/"):
        continue
    _rule = _prefix.rstrip("/") or "/"

    def _elsewhere(_prefix=_prefix, **_kw):
        return redirect(f"{SITE_BASE}{request.full_path.rstrip('?')}", 302)

    app.add_url_rule(_rule, endpoint=f"app_{_rule}", view_func=_elsewhere)
    app.add_url_rule(f"{_rule}/<path:_rest>", endpoint=f"app_{_rule}_rest", view_func=_elsewhere)


if __name__ == "__main__":
    if BUILT and not DIST.exists():
        raise SystemExit("dist/ not found — run `python scripts/build_static.py` first")
    print(f"Penlight public site ({'built dist/' if BUILT else 'live templates'}) → API {API_BASE}")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 1837)), debug=not BUILT)
