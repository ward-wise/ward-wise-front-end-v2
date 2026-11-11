"""Mayor quiz (/mayor): the quiz sends its counts to both analytics tools, sends nothing from the demo
URLs, and shows no match or "You" dot until the reveal. Runs against a build with a fake GA id and
PostHog key; both tools' scripts are blocked, so what they would have sent sits in window.dataLayer
(Google Analytics) and window.posthog (PostHog stub)."""

from __future__ import annotations

import functools
import http.server
import threading

import pytest

pytestmark = pytest.mark.browser

WORDS = {"1": "strongly_disagree", "2": "disagree", "3": "neutral", "4": "agree", "5": "strongly_agree", "6": "not_sure"}
# 24 keys, a mix of every value, with one 6 (Not sure) in the middle.
KEYS = list("12345" "43216" "55341" "24135" "2413")
assert len(KEYS) == 24 and KEYS.count("6") == 1


@pytest.fixture(scope="module")
def mayor_site(tmp_path_factory) -> str:
    import build_static

    out = tmp_path_factory.mktemp("dist-mayor")
    assert build_static.main(["--out", str(out), "--sha", "test", "--ga-id", "G-TEST", "--posthog-key", "phc_test"]) == 0

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(out)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture
def page(browser):
    context = browser.new_context()
    context.route("**/*googletagmanager.com/**", lambda route: route.abort())
    context.route("**/*posthog.com/**", lambda route: route.abort())
    page = context.new_page()
    page.set_default_timeout(10_000)
    page.errors = []
    page.on("pageerror", lambda err: page.errors.append(str(err)))
    yield page
    context.close()


def sent(page, prefix="mayor_quiz_"):
    """(ga, posthog): lists of (event name, props) for events whose name starts with prefix."""
    data = page.evaluate("""() => ({
        ga: (window.dataLayer || []).map((entry) => Array.from(entry)),
        posthog: Array.from(window.posthog || []).filter(Array.isArray),
    })""")
    ga = [(e[1], e[2] if len(e) > 2 else {}) for e in data["ga"] if e[0] == "event" and str(e[1]).startswith(prefix)]
    ph = [(e[1], e[2] if len(e) > 2 else {}) for e in data["posthog"] if e[0] == "capture" and str(e[1]).startswith(prefix)]
    return ga, ph


def named(pairs, name):
    return [props for n, props in pairs if n == name]


def answer(page, keys):
    for i, key in enumerate(keys, start=1):
        page.wait_for_function(f"document.querySelector('#quiz .qprog')?.textContent.includes('Statement {i} of 24')")
        page.keyboard.press(key)


def pass_issues(page, pick=2):
    page.wait_for_selector("#tgo")
    for chip in page.locator("#quiz .tchip").all()[:pick]:
        chip.click()
    page.click("#tgo")


def skip_countdown(page):
    """Click or any key skips the 3-2-1. With reduced motion there is none, so wait for either."""
    page.wait_for_function("document.querySelector('#cdwn') || document.querySelector('.pod')")
    if page.locator("#cdwn").count():
        page.keyboard.press("Space")
    page.wait_for_selector(".pod")


def run_quiz(page, site, picks=True):
    page.goto(f"{site}/mayor", wait_until="load")
    answer(page, KEYS)
    pass_issues(page)
    page.wait_for_selector("#pgo")
    if picks:
        page.select_option("#pw", "5")
        page.locator("[data-age]").first.click()
        page.click("#pgo")
    else:
        page.click("#pskip")
    skip_countdown(page)
    page.wait_for_function("document.querySelector('.youg, .you-dot')")


def test_full_run_sends_the_whole_story_once(page, mayor_site):
    run_quiz(page, mayor_site)
    ga, ph = sent(page)
    assert [n for n, _ in ga] == [n for n, _ in ph], "GA and PostHog got different events"
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_started")) == 1
        assert len(named(pairs, "mayor_quiz_finished")) == 1
        assert all(props.get("page") == "mayor" for _, props in pairs), pairs
        answers = named(pairs, "mayor_quiz_answer")
        assert len(answers) == 24, len(answers)
        assert [a["answer"] for a in answers] == [WORDS[k] for k in KEYS]
        assert [a["number"] for a in answers] == list(range(1, 25))
        assert all(isinstance(a["statement"], str) and a["statement"] and isinstance(a["matters"], bool) for a in answers)
        assert len(named(pairs, "mayor_quiz_issues")) == 1 and len(named(pairs, "mayor_quiz_issues")[0]["issues"]) == 2
        fin = named(pairs, "mayor_quiz_finished")[0]
        assert len(fin["answers"]) == 24, fin["answers"]
        assert fin["quiz_ward"] == "5", fin
        assert fin.get("age_band"), fin
        assert isinstance(fin["best_match"], str) and fin["best_match"], fin
        pct = fin["best_match_pct"]
        assert isinstance(pct, int) and not isinstance(pct, bool) and 0 <= pct <= 100, fin
        assert len(fin["top3"]) <= 3 and all({"id", "pct"} <= set(t) for t in fin["top3"]), fin["top3"]
        prof = named(pairs, "mayor_quiz_profile")
        assert prof and prof[0]["quiz_ward"] == "5" and not prof[0].get("skipped"), prof
    assert page.errors == []


def test_skipping_the_picks_step_sends_a_skipped_profile(page, mayor_site):
    run_quiz(page, mayor_site, picks=False)
    ga, ph = sent(page)
    for pairs in (ga, ph):
        prof = named(pairs, "mayor_quiz_profile")
        assert len(prof) == 1, prof
        assert prof[0]["skipped"] is True, prof[0]
        for key in ("quiz_ward", "age_band", "leaning"):
            assert key not in prof[0], prof[0]
        fin = named(pairs, "mayor_quiz_finished")[0]
        assert not fin.get("quiz_ward"), fin


@pytest.mark.parametrize("demo", ["1", "mid", "card"])
def test_demo_urls_send_nothing(page, mayor_site, demo):
    page.goto(f"{mayor_site}/mayor?demo={demo}", wait_until="load")
    page.wait_for_timeout(1500)
    page.keyboard.press("3")
    page.wait_for_timeout(300)
    ga, ph = sent(page)
    assert ga == [] and ph == [], (ga, ph)
    assert page.errors == []


def test_no_match_or_dot_until_the_reveal(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    page.wait_for_selector("#quiz .ans")
    assert page.locator(".you-dot, .you-halo, .youg").count() == 0
    answer(page, KEYS[:6])
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 7 of 24')")
    assert page.locator(".mpct, .mbest, .pod").count() == 0, "a match showed mid-quiz"
    assert page.locator(".you-dot, .you-halo, .youg").count() == 0, "the You dot showed mid-quiz"
    assert "Your best match" not in page.inner_text("body")
    answer_rest = KEYS[6:]
    for i, key in enumerate(answer_rest, start=7):
        page.wait_for_function(f"document.querySelector('#quiz .qprog')?.textContent.includes('Statement {i} of 24')")
        page.keyboard.press(key)
    pass_issues(page)
    page.wait_for_selector("#pgo")
    assert page.locator(".mpct, .pod, .you-dot").count() == 0, "a match showed before the reveal"
    page.click("#pskip")
    skip_countdown(page)
    page.wait_for_function("document.querySelector('.you-dot')")
    assert page.locator(".mpct").count() > 0
    assert page.locator(".you-dot").count() > 0


def test_opening_a_person_after_the_reveal_is_counted(page, mayor_site):
    run_quiz(page, mayor_site)
    pod = page.locator(".pod").first
    person = pod.get_attribute("data-id")
    assert person
    pod.click()
    page.wait_for_function("!document.querySelector('#drawer').hidden")
    ga, ph = sent(page)
    for pairs in (ga, ph):
        opened = named(pairs, "mayor_quiz_person_opened")
        assert opened and opened[-1]["person"] == person, opened
        assert opened[-1]["page"] == "mayor"


def test_page_loads_without_errors(page, mayor_site):
    response = page.goto(f"{mayor_site}/mayor", wait_until="load")
    assert response.status == 200
    page.wait_for_selector("#quiz .ans")
    page.wait_for_timeout(500)
    assert page.errors == []


def test_change_my_answers_is_counted_and_starts_over(page, mayor_site):
    run_quiz(page, mayor_site)
    page.click("#qredo")
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 1 of 24')")
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_restart")) == 1, pairs
    # A second run is a new quiz run: it counts as started again.
    page.keyboard.press("3")
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_started")) == 2


def test_share_card_download_is_counted_and_saves_a_png(page, mayor_site):
    run_quiz(page, mayor_site)
    page.click("#qcard")
    page.wait_for_selector("#card-dl")
    with page.expect_download() as info:
        page.click("#card-dl")
    assert info.value.suggested_filename.endswith(".png")
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_share_card")) == 1, pairs
    assert page.errors == []


def test_best_match_is_the_closest_answers_not_the_nearest_dot(page, mayor_site):
    # Connor, Nov 11: the match is a count. Statement by statement, the same answer is a full point and
    # each step apart earns less (1, .75, .35, .1, 0). Only people with 8 or more sourced answers are ranked.
    run_quiz(page, mayor_site)
    _, ph = sent(page)
    fin = named(ph, "mayor_quiz_finished")[0]
    assert fin["match_method"] == "closeness"
    words = {"strongly_agree": 2, "agree": 1, "neutral": 0, "disagree": -1, "strongly_disagree": -2}
    mine = {q: words[a] for q, a in fin["answers"].items() if a in words}
    people = page.evaluate("window.MayorCompassData.people.filter(p => p.cand).map(p => ({id: p.id, answers: p.answers.map(a => [a.qid, a.value])}))")
    scores = {}
    for p in people:
        shared = [(mine[q], v) for q, v in p["answers"] if q in mine]
        if len(p["answers"]) >= 8 and len(shared) >= 5:
            scores[p["id"]] = sum([1, .75, .35, .1, 0][abs(u - v)] for u, v in shared) / len(shared)
    assert scores, "nobody qualified"
    best = max(scores.values())
    assert abs(scores[fin["best_match"]] - best) < 1e-9, (fin["best_match"], scores)
    assert abs(fin["best_match_pct"] - 100 * best) <= 0.5 + 1e-9
    assert all(t["id"] in scores for t in fin["top3"]), "someone with too few answers was ranked"
    assert [t["pct"] for t in fin["top3"]] == sorted((t["pct"] for t in fin["top3"]), reverse=True)
    # the page shows the count beside the percent, and marks the top 3 on the map
    assert "Same side on" in page.locator(".pod").first.inner_text()
    assert sorted(page.locator("#hero-chart .rkn").all_text_contents()) == [str(i + 1) for i in range(len(fin["top3"]))]
    assert page.locator(".mnone").filter(has_text="Not enough answers yet").count() > 0


def test_every_drawer_offers_a_correction_email_naming_the_person(page, mayor_site):
    run_quiz(page, mayor_site)
    pod = page.locator(".pod").first
    pod.click()
    page.wait_for_function("!document.querySelector('#drawer').hidden")
    name = page.locator("#dr-name").inner_text()
    href = page.locator("#drawer .fixline a").get_attribute("href")
    assert href.startswith("mailto:connor@wardwise.org?subject="), href
    from urllib.parse import unquote
    assert unquote(href.split("subject=", 1)[1]) == "Mayor quiz correction: " + name


def test_bar_follows_you_jumps_back_and_pins(page, mayor_site):
    """The bar rings the statement you are on, a click on it jumps there, Backspace goes back, the bar pins
    under the site header when the card scrolls away, and Copy my results stays hidden until there is a result."""
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=mayor_site)
    page.goto(f"{mayor_site}/mayor")
    answer(page, KEYS[:6])
    where = "() => [document.querySelector('#quiz .qprog').innerText, [...document.querySelectorAll('#quiz .mseg')].findIndex(b => b.classList.contains('cur'))]"
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 7 of 24')")
    page.locator("#quiz .mseg").nth(2).click()
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 3 of 24')")
    text, cur = page.evaluate(where)
    assert cur == 2 and "6 answered" in text
    page.keyboard.press("Backspace")
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 2 of 24')")
    page.click("#quiz .qprog [data-back]")
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 1 of 24')")
    assert page.locator("#quiz .qprog [data-back]").is_disabled()
    assert not page.evaluate("document.getElementById('qpin').classList.contains('on')")
    page.mouse.wheel(0, 1200)
    page.wait_for_function("document.getElementById('qpin').classList.contains('on')")
    page.locator("#qpin .mseg").nth(4).click()
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 5 of 24')")
    assert page.locator("#copyres").is_hidden(), "Copy my results shows before there is a result"
    assert page.errors == []


def test_copy_my_result_puts_a_picture_on_the_clipboard_and_is_counted(page, mayor_site):
    page.context.grant_permissions(["clipboard-read", "clipboard-write"], origin=mayor_site)
    run_quiz(page, mayor_site)
    assert page.locator("#copyres").is_visible()
    page.click("#copyres")
    page.wait_for_function("document.querySelector('#copyres').innerText.includes('Copied')")
    page.click("#qcopy")
    page.wait_for_function("document.querySelector('#qcopy').innerText.includes('Copied')")
    types = page.evaluate("async () => (await navigator.clipboard.read())[0].types")
    assert "image/png" in types
    ga, ph = sent(page)
    assert [p.get("where") for p in named(ph, "mayor_quiz_card_copied")] == ["top", "result"]
    assert len(named(ga, "mayor_quiz_card_copied")) == 2
    assert page.errors == []


def test_start_over_asks_once_then_clears_everything(page, mayor_site):
    run_quiz(page, mayor_site)
    page.click("#live [data-reset]")
    page.click("#live [data-reset-no]")
    assert page.locator(".youg, .you-dot").count() > 0
    page.click("#live [data-reset]")
    page.click("#live [data-reset-yes]")
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('Statement 1 of 24')")
    assert "0 answered" in page.locator("#quiz .qprog").inner_text()
    assert page.locator(".youg, .you-dot").count() == 0
    stored = page.evaluate("[localStorage.getItem('mc-answers'), localStorage.getItem('mc-done'), localStorage.getItem('mc-top3')]")
    assert stored == ["{}", "false", "[]"]
    ga, ph = sent(page)
    assert [p.get("finished") for p in named(ph, "mayor_quiz_reset")] == [True]
    page.reload()
    page.wait_for_function("document.querySelector('#quiz .qprog')?.textContent.includes('0 answered')")
    assert page.errors == []


def test_statement_list_stays_behind_see_why(page, mayor_site):
    """Connor, Nov 11: the open list under the result was too much. It opens on "See why" and is counted."""
    run_quiz(page, mayor_site)
    assert page.locator("#live .bdrow").count() == 0
    assert page.locator("#bdwhy").get_attribute("aria-expanded") == "false"
    page.click("#bdwhy")
    page.wait_for_selector("#live .bdrow")
    assert page.locator("#bdwhy").get_attribute("aria-expanded") == "true"
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_why_opened")) == 1, pairs
    page.click("#bdwhy")
    page.wait_for_function("!document.querySelector('#live .bdrow')")
