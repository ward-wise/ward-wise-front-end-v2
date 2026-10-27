"""The contested-direction flip in static/scoring.js, run in Chromium against the pipeline's own math.

The score matrix stores s = round(normalize(v, direction), 2) (shared/civic_data/metrics.py in the
private API repo). A reader who takes the other reading of a contested metric gets flipScore(s);
that must be exactly the s the pipeline would have stored for the other direction, or a flipped
rank could differ from the same basket scored server-side.
"""

from __future__ import annotations

import random
from pathlib import Path

import pytest

pytestmark = pytest.mark.browser

STATIC = Path(__file__).resolve().parents[1] / "static"


def _normalize(value: float, lo: float, hi: float, direction: str) -> float:
    """normalize_metric_value + the matrix's 2 dp rounding, as the pipeline does it."""
    if hi == lo:
        return 50.0
    n = ((value - lo) / (hi - lo)) * 100
    if direction == "lower":
        n = 100 - n
    return round(max(0.0, min(100.0, n)), 2)


@pytest.fixture(scope="module")
def scoring_page(browser):
    """A blank page with the two modules loaded; `browser` is pytest-playwright's session Chromium."""
    page = browser.new_page()
    page.set_content("<!doctype html><title>scoring</title>")
    page.add_script_tag(path=str(STATIC / "geography.js"))
    page.add_script_tag(path=str(STATIC / "scoring.js"))
    yield page
    page.close()


def test_flip_score_is_the_matrix_value_for_the_other_direction(scoring_page):
    rng = random.Random(7)
    cases = []
    for _ in range(4000):
        lo = rng.uniform(-50, 50)
        hi = lo + rng.choice([0.0, rng.uniform(0.001, 1000)])
        value = rng.choice([lo, hi, rng.uniform(lo, hi)])
        cases.append([_normalize(value, lo, hi, "lower"), _normalize(value, lo, hi, "higher")])
    mismatches = scoring_page.evaluate(
        "(cases) => cases.filter(([lower, higher]) => WardWiseScoring.flipScore(lower) !== higher"
        " || WardWiseScoring.flipScore(higher) !== lower)",
        cases,
    )
    assert mismatches == []


def test_a_flipped_reading_reorders_the_composite(scoring_page):
    result = scoring_page.evaluate("""() => {
      const S = WardWiseScoring;
      const metrics = [
        {metric_id: "alpr", direction: "lower", direction_contested: true},
        {metric_id: "parks", direction: "higher"},
      ];
      const slice = {
        "01": {alpr: {s: 90, v: 1}, parks: {s: 40, v: 4}},
        "02": {alpr: {s: 10, v: 9}, parks: {s: 60, v: 6}},
        "03": {parks: {s: 55, v: 5}},
      };
      const weights = {alpr: 1, parks: 1};
      const order = (s) => S.computeComposite(s, weights).rows.map((r) => [r.area_id, r.score]);
      const asDefault = order(S.orientSlice(slice, S.directions.flipped(metrics)));
      const text = S.directions.apply(metrics, "alpr:higher,parks:lower,nope:higher,alpr:sideways");
      const flippedIds = S.directions.flipped(metrics);
      const oriented = S.orientSlice(slice, flippedIds);
      return {
        asDefault, asFlipped: order(oriented), text, flippedIds,
        parksDirection: metrics[1].direction,
        sharedCell: oriented["03"] === slice["03"],
        memoized: S.orientSlice(slice, ["alpr"]) === oriented,
        untouched: slice["01"].alpr.s,
        roundTrip: S.directions.parse(text),
        notContested: S.directions.set(metrics[1], "lower"),
      };
    }""")
    assert result["asDefault"] == [["01", 65], ["03", 55], ["02", 35]]
    assert result["asFlipped"] == [["02", 75], ["03", 55], ["01", 25]]
    assert result["text"] == "alpr:higher"  # uncontested and unknown metrics, bad values: ignored
    assert result["flippedIds"] == ["alpr"]
    assert result["parksDirection"] == "higher"
    assert result["sharedCell"] and result["memoized"]
    assert result["untouched"] == 90  # the loaded slice is never mutated
    assert result["roundTrip"] == {"alpr": "higher"}
    assert result["notContested"] is False


def test_links_carry_the_readings(scoring_page):
    url = scoring_page.evaluate(
        "() => WardWiseGeography.reportUrl('ward', '12', {weights: {alpr: 1}, directions: 'alpr:higher'})"
    )
    assert url == "/report/ward/12?m=alpr&dir=alpr%3Ahigher"
