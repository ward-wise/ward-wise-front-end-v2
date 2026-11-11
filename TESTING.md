# Testing

The tests exist so a change to a template or a stylesheet can't quietly break a page nobody
happened to open. They test the built site, the same `dist/` that Pages serves.

```bash
pip install -r requirements-dev.txt
python -m playwright install chromium   # once, for the browser tests
python -m pytest                        # everything (~2 min)
python -m pytest -m "not browser"       # build tests only (seconds, no network)
```

CI runs both groups on every PR (`.github/workflows/test.yml`).

## What's covered

**Build tests** (`tests/test_build.py`) run `scripts/build_static.py` into a temp directory, then:

- `scripts/check_build.py` passes on it (the same check the Pages workflow runs);
- every page has a non-empty `<title>` with no markup in it (an unclosed `{% block title %}`
  swallows the page's script and prints it as text) and a viewport that allows pinch zoom;
- no raw `{{` or `{%` reaches the page outside a script;
- every `href="/…"` points at a page the build contains, a `/report/<slug>/<id>` area report, or a
  path the private API serves on the same host (`/api`, `/login`, `/account`, `/metric-submissions`…).

**Browser tests** (`tests/test_browser_smoke.py`, marker `browser`) serve the build through
`server.py`'s own routes, so `/api/*` reaches the live API exactly as it does under
`python server.py --built`, and open every page at 390px and 1440px wide:

- the page must not scroll sideways;
- no uncaught script error (`pageerror`). Failed API calls, such as the signed-out `/api/me` 401,
  are not script errors and don't fail the test.

**Scoring math** (`tests/test_scoring_browser.py`, marker `browser`, no API) loads `static/scoring.js`
in Chromium and checks that flipping a contested metric (`flipScore`, `orientSlice`, the `dir=` URL
choices) gives exactly the score the pipeline would have stored for the other direction.

## Known bugs are marked, strictly

A page that is broken on `dev` today is listed in `KNOWN_OVERFLOW` or `KNOWN_BAD_TITLE` and runs
as `xfail(strict=True)`. The suite stays green. When a fix lands, the xfail turns into a failure
until the entry is deleted, so the list only shrinks and a fixed bug can't come back unnoticed.

## Adding a test

When you fix a bug a test could have caught, add the case that would have caught it: a known-bad
entry first, then remove it in the same commit as the fix. When you add a page to
`penlight_site.PAGES`, both test files pick it up automatically.
