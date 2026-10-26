"""One description of the public site, shared by the dev server and the static build.

Every reader-facing page is a Jinja template that gets ALL its data from the Penlight API at
runtime. The only things the server used to inject at render time were link targets, the asset
cache-buster, the nav registry, and who is signed in. This module replaces those: a route table,
a `url_for` that knows the Flask endpoint names the templates still use, and the context both
`server.py` (live, mtime-versioned) and `scripts/build_static.py` (hashed, written to dist/) render
with. The signed-in avatar is rendered in the browser from `/api/me`.

Why keep the Flask endpoint names (`ui.reports_page`) in templates? Fixes still port both ways with
the gated pages that remain in the private app, which render from the same names.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Callable
from urllib.parse import urlencode

from jinja2 import Environment, FileSystemLoader, select_autoescape

ROOT = Path(__file__).resolve().parent
TEMPLATES = ROOT / "templates"
STATIC = ROOT / "static"
VIEWS_JSON = ROOT / "views.json"

# The live site. Pages this repo does NOT carry (survey, account, admin, request-access…) stay in
# the private app and are reached on the same host in production; locally they link out to it.
SITE_BASE_DEFAULT = "https://www.wardwise.org"
PUBLIC_BASE = "https://www.wardwise.org"
# PostHog's US cloud. The project key (POSTHOG_KEY) is public by design, like the GA id.
POSTHOG_HOST = "https://us.i.posthog.com"

# Features that are built but don't yet do everything their pages describe. Templates read these (and
# base.html hands them to JS as <body data-*>), so the "in testing" copy flips in one place at launch.
SITE_FLAGS = {
    # Ward alert emails: live since 2026-10-21 (digest Mondays 7:00 CT, same-day zoning daily 7:30 CT).
    # To pause them, set False in the same change as `scripts/remote_pipeline.sh schedule` (without
    # --alerts-on) and ALERTS_SENDING unset on the private app, so no page promises an email that won't come.
    "alerts_sending": True,
}


@dataclass(frozen=True)
class Page:
    key: str            # also the body[data-page] value and the view-registry key when there is one
    path: str           # canonical URL path
    template: str
    endpoint: str       # Flask endpoint name the templates use with url_for
    aliases: tuple[str, ...] = ()


# Pages built here. Order matters only for readability.
PAGES: tuple[Page, ...] = (
    # The redesign (Connor Florczyk, 2026-10): the front door is a home page, the map lives at /map.
    Page("home", "/", "home.html", "ui.index"),
    Page("map", "/map", "explorer.html", "ui.map_page"),
    Page("residents", "/for/residents", "residents.html", "ui.residents"),
    Page("planning", "/for/planning", "planning.html", "ui.planning"),
    Page("business", "/for/business", "business.html", "ui.business"),
    Page("financing", "/for/financing", "financing.html", "ui.financing"),
    Page("alerts", "/alerts", "alerts.html", "ui.alerts"),
    Page("k3", "/k3", "k3.html", "ui.k3"),
    Page("k3_dictionary", "/k3/dictionary", "k3_dictionary.html", "ui.k3_dictionary"),
    Page("reports", "/reports", "reports_hub.html", "ui.reports_page"),
    Page("relationship", "/reports/relationship", "report_relationship.html", "ui.relationship_page"),
    Page("drivers", "/reports/drivers", "report_drivers.html", "ui.drivers_page"),
    Page("impact", "/reports/impact", "report_impact.html", "ui.impact_page"),
    Page("deepdive", "/reports/deep-dive", "report_deepdive.html", "ui.report_deepdive_page"),
    Page("methodology", "/reports/methodology", "report_methodology.html", "ui.methodology_page"),
    Page("term", "/reports/term", "report_term.html", "ui.report_term_page"),
    Page("years", "/reports/data-years", "report_years.html", "ui.report_years_page"),
    Page("report", "/report", "report.html", "ui.report_page"),
    Page("compare", "/compare", "compare.html", "ui.compare_page"),
    Page("index", "/index", "index_page.html", "ui.index_page"),
    Page("menu", "/menu", "menu.html", "ui.menu_page"),
    Page("menu_ward", "/menu/ward", "menu_ward.html", "ui.menu_ward_page"),
    Page("menu_compare", "/menu/compare", "menu_compare.html", "ui.menu_compare_page"),
    Page("menu_map", "/menu/map", "menu_map.html", "ui.menu_map_page"),
    Page("menu_prices", "/menu/prices", "menu_prices.html", "ui.menu_prices_page"),
    Page("menu_costs", "/menu/costs", "menu_costs.html", "ui.menu_costs_page"),
    Page("menu_data", "/menu/data", "menu_data.html", "ui.menu_data_page"),
    Page("near", "/near", "near.html", "ui.near_page"),
    Page("near_change", "/near/change", "near_change.html", "ui.near_change_page"),
    Page("dictionary", "/dictionary", "dictionary.html", "ui.dictionary_page"),
    Page("data_notes", "/data-notes", "data_notes.html", "ui.data_notes_page"),
    Page("your_city", "/your-city", "your_city.html", "ui.your_city"),
    Page("about", "/about", "about.html", "ui.about_page", aliases=("/support",)),
    Page("signifiers", "/signifiers", "signifiers.html", "ui.signifiers_page"),
    Page("suggest_metric", "/suggest-metric", "suggest_metric.html", "ui.suggest_metric"),
    Page("suggest_photo", "/suggest-photo", "suggest_photo.html", "ui.suggest_photo"),
    Page("api_docs", "/api-docs", "api_docs.html", "ui.api_docs_page"),
    Page("privacy", "/privacy", "privacy.html", "ui.privacy_page"),
)
PAGES_BY_ENDPOINT = {page.endpoint: page for page in PAGES}
PAGES_BY_KEY = {page.key: page for page in PAGES}

# Paths that forward. /metrics is the old home of the dictionary + reports tabs; its fragment deep
# links are forwarded by the reports hub's own script.
REDIRECTS: dict[str, str] = {
    "/metrics": "/reports",
    # the comparison page became the relationship page (2026-10); the query string rides along
    "/reports/comparison": "/reports/relationship",
    # the causal report became the driver analysis (2026-10)
    "/reports/causal": "/reports/drivers",
}

# Endpoints that live in the private app (Flask on Lambda). Same host in production — CloudFront
# routes these prefixes there — so they render as plain paths; the dev server links out instead.
APP_ENDPOINTS: dict[str, str] = {
    "ui.values_survey_page": "/survey",
    "ui.maxdiff_page": "/survey/deepdive",
    "ui.request_access_page": "/request-access",
    "ui.metric_submissions_page": "/metric-submissions",
    "ui.metric_recommendations_page": "/metric-recommendations",
    "ui.admin_users_page": "/admin/users",
    "auth.login": "/login",
    "auth.logout": "/logout",
    "auth.account": "/account",
}
# Path prefixes CloudFront sends to the Lambda origin. Kept here as documentation AND as the list
# the dev server proxies, so the two can't drift.
APP_PATH_PREFIXES: tuple[str, ...] = (
    "/api/", "/login", "/logout", "/account", "/admin/", "/survey", "/request-access",
    "/metric-submissions", "/metric-recommendations", "/app-static/",
)


def load_views() -> dict:
    return json.loads(VIEWS_JSON.read_text(encoding="utf-8"))


def nav_groups(views: dict) -> list[tuple[str, list[SimpleNamespace]]]:
    """[(group, [view, …]), …] in registry order, views as attribute objects like the Flask side."""
    groups: list[tuple[str, list[SimpleNamespace]]] = []
    for group in views["groups"]:
        members = [SimpleNamespace(**view) for view in views["views"] if view["group"] == group]
        groups.append((group, members))
    return groups


def make_url_for(version_for: Callable[[str], str], app_base: str = "") -> Callable[..., str]:
    """A url_for that understands the endpoint names in the templates.

    `version_for(filename)` returns the cache-buster for a static file. `app_base` is prepended to
    private-app paths ("" in production, the live site URL in local dev)."""

    def url_for(endpoint: str, **values) -> str:
        if endpoint == "static":
            filename = values.pop("filename")
            values.pop("v", None)  # templates pass v=asset_version; we version by content instead
            version = version_for(filename)
            query = {"v": version} if version else {}
            query.update(values)
            return f"/static/{filename}" + (f"?{urlencode(query)}" if query else "")
        page = PAGES_BY_ENDPOINT.get(endpoint)
        if page is not None:
            path = page.path
            if endpoint == "ui.report_page" and values.get("slug") and values.get("area_id") is not None:
                path = f"/report/{values.pop('slug')}/{values.pop('area_id')}"
            return path + (f"?{urlencode(values)}" if values else "")
        if endpoint in APP_ENDPOINTS:
            path = APP_ENDPOINTS[endpoint]
            return app_base + path + (f"?{urlencode(values)}" if values else "")
        raise KeyError(f"url_for: unknown endpoint {endpoint!r} (add it to site.PAGES or site.APP_ENDPOINTS)")

    return url_for


def make_environment(version_for: Callable[[str], str], *, app_base: str = "", ga_id: str | None = None,
                     posthog_key: str | None = None, posthog_host: str = POSTHOG_HOST,
                     build_sha: str = "dev") -> Environment:
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES)),
        autoescape=select_autoescape(("html", "xml")),
        trim_blocks=False,
        lstrip_blocks=False,
    )
    views = load_views()
    env.globals.update({
        "url_for": make_url_for(version_for, app_base=app_base),
        "public_base": PUBLIC_BASE,  # absolute URLs for link-preview cards (og:url, og:image)
        "nav_groups": nav_groups(views),
        "view_endpoints": frozenset(view["endpoint"] for view in views["views"]),
        "ga_id": ga_id,
        "posthog_key": posthog_key,
        "posthog_host": posthog_host,
        "build_sha": build_sha,
        "app_base": app_base,
        "site_flags": SITE_FLAGS,
    })
    return env


def page_context(page: Page, *, path: str | None = None) -> dict:
    """What a page template sees beyond the globals: a request-like object (templates compare
    `request.endpoint`) and the registry groups the reports hub lists."""
    views = load_views()
    request = SimpleNamespace(endpoint=page.endpoint, path=path or page.path, args={}, query_string=b"")
    return {
        "request": request,
        "page_key": page.key,
        "groups": nav_groups(views)[1:],  # the hub lists everything but the Explore group
        "user": None,                       # rendered in the browser from /api/me
        "report": {"area_type": None, "slug": None, "area_id": None},  # report.js reads the URL
    }
