"""The static build: every page renders, the CI sanity check passes, and links between pages
point at pages that exist. No network, no browser; runs in a few seconds."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import check_build
from conftest import ALL_PATHS, page_file, site

# Served by the private API on the same host in production (CONTRIBUTING.md, "Where things live"),
# so the build never contains them and a link to one is not broken.
BACKEND_PREFIXES = ("/api", "/login", "/logout", "/account", "/admin", "/survey", "/request-access",
                    "/submissions", "/metric-submissions", "/auth")
# server.py's /report/<slug>/<area_id>; CloudFront rewrites it to /report/ in production.
AREA_REPORT = re.compile(r"^/report/[^/]+/[^/]+$")

HREF = re.compile(r'href="(/[^"#?]*)')


def test_ci_sanity_check_passes(built_site: Path):
    assert check_build.main(["check_build.py", str(built_site)]) == 0


KNOWN_BAD_TITLE = {}


@pytest.mark.parametrize("path", [
    pytest.param(p, marks=pytest.mark.xfail(reason=KNOWN_BAD_TITLE[p], strict=True)) if p in KNOWN_BAD_TITLE else p
    for p in ALL_PATHS])
def test_page_has_title_and_zoomable_viewport(built_site: Path, path: str):
    html = page_file(built_site, path).read_text(encoding="utf-8")
    title = re.search(r"<title>(.*?)</title>", html, re.S)
    assert title and title.group(1).strip(), f"{path}: empty <title>"
    # Browsers print everything inside <title> as text, so markup there means a block ran on.
    assert "<" not in title.group(1), f"{path}: markup inside <title> (unclosed title block?)"
    viewport = re.search(r'<meta name="viewport" content="([^"]*)"', html)
    assert viewport, f"{path}: no viewport meta"
    assert "user-scalable=no" not in viewport.group(1), f"{path}: blocks pinch zoom"


@pytest.mark.parametrize("path", ALL_PATHS)
def test_no_template_syntax_leaks_into_page(built_site: Path, path: str):
    # An unclosed {% block %} swallows what follows it; a stray {{ or {% means Jinja never saw it.
    html = page_file(built_site, path).read_text(encoding="utf-8")
    body = re.sub(r"<script\b.*?</script>", "", html, flags=re.S)
    assert "{%" not in body and "{{" not in body, f"{path}: raw template syntax in the page"


def test_internal_links_resolve(built_site: Path):
    known = {p.path for p in site.PAGES} | {a for p in site.PAGES for a in p.aliases}
    broken = []
    for path in ALL_PATHS:
        html = page_file(built_site, path).read_text(encoding="utf-8")
        for target in set(HREF.findall(html)):
            target = target.rstrip("/") or "/"
            if target.startswith("/static/") or target.startswith(BACKEND_PREFIXES) or AREA_REPORT.match(target):
                continue
            if target in known or (built_site / target.strip("/")).exists():
                continue
            broken.append(f"{path} -> {target}")
    assert not broken, "links to pages the build does not contain:\n" + "\n".join(sorted(broken))


# Attributes whose values a visitor can read (tooltips, screen readers, empty-field hints).
VISIBLE_ATTRS = re.compile(r'\s(?:title|alt|aria-label|placeholder)="([^"]*)"')
# Text that comes from views.json (maintainer-owned), so it can't be fixed from a template.
# Delete the entry when the maintainer renames it there.
KNOWN_PENLIGHT: dict[str, str] = {}
META_DESCRIPTION = re.compile(r'<meta\s+name="description"\s+content="([^"]*)"')


def test_no_penlight_in_visible_text(built_site: Path):
    """The old name "Penlight" stays out of anything a visitor reads. Hostnames, CSS classes,
    the penlight-build meta and code comments are not visible, so they are stripped first."""
    leaks = []
    for path in ALL_PATHS:
        if path in KNOWN_PENLIGHT:
            continue
        html = page_file(built_site, path).read_text(encoding="utf-8")
        title = re.search(r"<title>(.*?)</title>", html, re.S)
        found = [title.group(1)] if title else []
        found += META_DESCRIPTION.findall(html)
        html = re.sub(r"<!--.*?-->", "", html, flags=re.S)
        html = re.sub(r"<(script|style)\b.*?</\1>", "", html, flags=re.S | re.I)
        found += VISIBLE_ATTRS.findall(html)
        found.append(re.sub(r"<[^>]*>", " ", html))
        if any("Penlight" in chunk for chunk in found):
            leaks.append(path)
    assert not leaks, 'visible "Penlight" on: ' + ", ".join(leaks)


def test_mayor_page_has_disclaimer_and_correction_email(built_site: Path):
    """Chi Hack Night 11/10: the quiz says it may contain errors, that distance is not a judgment,
    and where a candidate can send a correction."""
    html = page_file(built_site, "/mayor").read_text(encoding="utf-8")
    fix = re.search(r'<p class="small" id="m-fix">(.*?)</p>', html, re.S)
    assert fix, "no correction paragraph in How this works"
    text = fix.group(1)
    assert "may contain errors" in text
    assert "two lines only" in text and "not wrong for being there" in text
    assert 'href="mailto:connor@wardwise.org?subject=' in text


def test_mayor_how_this_works_is_short_with_the_method_folded(built_site: Path):
    """Connor, Nov 11: "How this works" is five plain bullets; the full method folds behind one link."""
    html = page_file(built_site, "/mayor").read_text(encoding="utf-8")
    howlist = re.search(r'<ul class="howlist">(.*?)</ul>', html, re.S)
    assert howlist and howlist.group(1).count("<li>") == 5
    assert "does not endorse" in howlist.group(1)
    assert re.search(r'<details class="howmore"><summary>Full method and fact-check history</summary>', html)
    assert "Side to side is the economy" not in html.split('id="candidates"')[0]  # map explainer gone from the quiz panel


def test_mayor_data_rulings_hold():
    """Round 12 and 13 data rulings (Connor, Nov 11): who is placed, who left, which statements count."""
    import json
    raw = (Path(__file__).resolve().parent.parent / "static" / "mayor_compass_data.js").read_text(encoding="utf-8")
    d = json.loads(raw[raw.index("{"):].rstrip().rstrip(";"))
    by = {p["name"]: p for p in d["people"]}
    assert "Toni Brooks" not in by
    assert by["Susana Mendoza"]["x"] is None and by["Joe Holberg"]["x"] is None  # no fact answers an economy statement directly
    qids = {q["qid"] for q in d["questions"]}
    assert not qids & {"E1", "E7", "E10", "E14"} and {"E18", "E19", "E20", "E21"} <= qids
    wilson = {a["qid"] for a in by["Willie Wilson"]["answers"]}
    assert "S2" not in wilson
    assert "E1" not in {a["qid"] for a in by["Harold Washington"]["answers"]}
    notes = {(p["name"], a["qid"]): a.get("note") for p in d["people"] for a in p["answers"]}
    assert notes[("Lori Lightfoot", "E11")] and notes[("Richard J. Daley", "S4")]
    assert d["anchor"]["mid"] == 0
