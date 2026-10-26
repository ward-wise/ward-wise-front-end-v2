#!/usr/bin/env python3
"""Render the public site to dist/ for GitHub Pages.

    python scripts/build_static.py [--out dist] [--ga-id G-XXXX] [--sha <git sha>]

Every page template becomes dist/<path>/index.html (the root page is dist/index.html). Static
assets are copied as-is and referenced with ?v=<content hash>, so a change to any file busts the
cache for exactly that file. Also written: dist/.nojekyll (Pages must not run Jekyll),
dist/404.html, dist/build.json (what the smoke check reads), and a meta-refresh page for each
redirect in site.REDIRECTS (CloudFront answers those with a real 301 in production; the fallback is
for anyone browsing Pages directly).

No Flask here — only Jinja2 — so the build runs anywhere Python does.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import penlight_site as site_mod  # noqa: E402

STATIC_EXCLUDE = {".DS_Store"}


def content_versions(static_dir: Path) -> dict[str, str]:
    versions: dict[str, str] = {}
    for path in sorted(static_dir.rglob("*")):
        if path.is_file() and path.name not in STATIC_EXCLUDE:
            digest = hashlib.sha1(path.read_bytes()).hexdigest()[:10]
            versions[str(path.relative_to(static_dir))] = digest
    return versions


def git_sha(default: str = "local") -> str:
    """The commit this build was rendered FROM: the checkout's own HEAD.

    Not GITHUB_SHA: the Pages workflow builds both channels (main → root, dev → /dev) on a push to
    either branch, so GITHUB_SHA names whichever branch triggered the run, and the root once reported
    the preview branch's commit while serving main's pages. GITHUB_SHA is only the fallback when there's no git."""
    try:
        return subprocess.check_output(["git", "rev-parse", "--short=12", "HEAD"], text=True,
                                       cwd=Path(__file__).resolve().parents[1], stderr=subprocess.DEVNULL).strip()
    except Exception:  # noqa: BLE001
        return (os.environ.get("GITHUB_SHA") or default)[:12]


def redirect_html(target: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        f"<meta http-equiv=\"refresh\" content=\"0; url={target}\">"
        f"<link rel=\"canonical\" href=\"{target}\"><title>Redirecting…</title></head>"
        f"<body><p>Moved to <a href=\"{target}\">{target}</a>.</p>"
        "<script>location.replace(" + json.dumps(target) + " + location.search + location.hash)</script>"
        "</body></html>\n"
    )


def build(out: Path, ga_id: str | None, sha: str, posthog_key: str | None = None) -> int:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    versions = content_versions(site_mod.STATIC)
    env = site_mod.make_environment(lambda name: versions.get(name, ""), app_base="", ga_id=ga_id,
                                      posthog_key=posthog_key, build_sha=sha)

    written = 0
    for page in site_mod.PAGES:
        template = env.get_template(page.template)
        html = template.render(**site_mod.page_context(page))
        for path in (page.path, *page.aliases):
            target = out / "index.html" if path == "/" else out / path.strip("/") / "index.html"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(html, encoding="utf-8")
            written += 1

    for source, target in site_mod.REDIRECTS.items():
        path = out / source.strip("/") / "index.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(redirect_html(target), encoding="utf-8")

    shutil.copytree(site_mod.STATIC, out / "static", ignore=shutil.ignore_patterns(*STATIC_EXCLUDE))
    (out / ".nojekyll").write_text("", encoding="utf-8")
    # Pages serves 404.html for unknown paths. /report/<slug>/<id> is a known path with a dynamic
    # tail (CloudFront rewrites it to /report/ in production); on bare Pages the 404 page bounces it.
    (out / "404.html").write_text(env.get_template("404.html").render(**site_mod.page_context(site_mod.PAGES_BY_KEY["map"], path="/404")), encoding="utf-8")
    (out / "build.json").write_text(json.dumps({
        "sha": sha,
        "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "pages": [page.path for page in site_mod.PAGES],
        "assets": len(versions),
    }, indent=2) + "\n", encoding="utf-8")
    (out / "CNAME").write_text(os.environ.get("PAGES_CNAME", "pages.penlight.wardwise.org") + "\n", encoding="utf-8")
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="dist")
    parser.add_argument("--ga-id", default=os.environ.get("GA_ID") or None,
                        help="Google Analytics measurement id (or GA_ID env); omitted = no analytics")
    parser.add_argument("--posthog-key", default=os.environ.get("POSTHOG_KEY") or None,
                        help="PostHog project key (or POSTHOG_KEY env); omitted = no PostHog")
    parser.add_argument("--sha", default=None, help="build identifier (default: GITHUB_SHA or git HEAD)")
    args = parser.parse_args(argv)
    out = Path(args.out).resolve()
    sha = args.sha or git_sha()
    pages = build(out, args.ga_id, sha, args.posthog_key)
    print(f"built {pages} pages + {len(list((out / 'static').iterdir()))} assets → {out} (build {sha})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
