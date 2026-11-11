# Contributing

Penlight is a volunteer civic-data project. This repo exists so that improving the site doesn't
require a data pipeline, AWS credentials, or the maintainer's laptop: **a merged pull request is a
deploy.**

```bash
./run.sh          # http://localhost:1837, real data, no credentials
```

Looking for something to work on? [wardwise.org/get-involved](https://www.wardwise.org/get-involved)
lists open ideas. They are tickets on [ward-wise/ideas](https://github.com/ward-wise/ideas). New
measures live in a repo of their own and join the site through
[ward-wise-measures](https://github.com/ward-wise/ward-wise-measures). Pages and site fixes come here.

## Two channels

| Branch | Where it serves | Who merges |
|---|---|---|
| `dev` | **dev.wardwise.org** — the preview channel, same live data | any collaborator, after one approving review |
| `main` | **www.wardwise.org** — the stable site | the maintainer, via a PR from `dev` |

Day to day you work against `dev`. A PR into `main` from any other branch fails the required
`main-from-dev` check, so everything reaches the stable site through the preview first. When the
preview looks right, open a PR `dev → main`; that
PR is the release note. Both channels build from every push, so `dev.wardwise.org` is never behind
what's merged.

## The loop

1. Branch from `dev`, edit templates under `templates/` or files under `static/`, reload.
2. `python scripts/build_static.py && python scripts/check_build.py dist` — the same two commands
   CI runs. `python server.py --built` shows you exactly what Pages will serve.
3. Open a PR into `dev`. The `pages / build` check must pass and one collaborator must approve.
   Changes to the deploy mechanism itself (`.github/`, `scripts/build_static.py`,
   `penlight_site.py`, `views.json`) need the maintainer's review on any branch (`.github/CODEOWNERS`).
4. Merge. `dev.wardwise.org` updates within a few minutes; `/build.json` on either host shows
   which commit is live there.

## Adding a page

Add a `Page` to `penlight_site.PAGES` (path, template, and the `ui.<name>` endpoint the templates
use), write the template extending `base.html`, and build. If the page should appear in the
Explore menu it needs an entry in the API's view registry too — open an issue and it'll be added
upstream, then `views.json` gets refreshed from `/api/views`.

## One file the backend reads

`static/presets.js` (the curated lists on the map) is also read by the API repo's pipeline, which
builds the ward narratives from the same lists. Keep it a plain array literal assigned to
`window.WardWisePresets`; `scripts/check_build.py` parses it the way the pipeline does and fails the
build if it can't. Add or reorder lists freely; just don't turn the file into code.

## Where things live

This repo renders what the API returns; it doesn't produce the data. Data questions — a metric's
definition, a wrong number, coverage years, a new metric, a new API field — belong to the private
backend. You don't need access to it: open an issue in *this* repo and it'll get routed. The
proxy in `server.py` is deliberately dumb; it forwards bytes and does no shaping.

Pages that need a signed-in reader (survey, account, request access, admin, submissions) stay in
the backend and are served on the same host in production. Locally, links to them open the live
site.

## Conventions

Match what's there — this codebase has a consistent voice.

- **No bundler, and let's keep it that way.** Vanilla JS in an IIFE, attached to `window`. A
  contributor should be able to edit a file and reload.
- **Comments explain *why*, not *what*.** The existing comments are load-bearing. Write in that
  register or don't write.
- **Escape everything.** JS renders HTML by string interpolation; `WardWiseExplorer.escapeHtml`
  (aliased to `esc` in most files) is not optional.
- **CSS uses custom properties** defined at the top of `styles.css`. Reach for an existing token
  before inventing a color. Both themes (`[data-theme="classic"]` and `"dark"`) must work.
- **Nothing in this repo may talk to AWS.** No presigned URLs, no bucket names, no keys. The API
  is the only backend.

## Testing a change

`python -m pytest` builds the site and opens every page at phone and desktop width; see
[TESTING.md](TESTING.md). It catches pages that fail to build, broken internal links, sideways
scroll and script crashes, not everything. Before opening a PR, still load the pages you touched
and check the browser console is clean. For the map: switching geography (ward / neighborhood / χGRID) works,
toggling metrics rescores the choropleth and the leaderboard, a ward's mini report shows its
photo. Sanity-check against <https://penlight.wardwise.org> if you're unsure whether something
is your change or already the case live.
