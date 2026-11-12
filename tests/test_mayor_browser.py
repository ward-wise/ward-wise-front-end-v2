"""Mayor quiz (/mayor): the quiz sends its counts to both analytics tools, sends nothing from the demo
URLs, and shows no match or "You" dot until the reveal. Runs against a build with a fake GA id and
PostHog key; both tools' scripts are blocked, so what they would have sent sits in window.dataLayer
(Google Analytics) and window.posthog (PostHog stub)."""

from __future__ import annotations

import functools
import http.server
import re
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
        assert len(prof) == 1 and prof[0]["quiz_ward"] == "5" and not prof[0].get("skipped"), prof
        assert fin["finished_early"] is False, fin
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
    # the demo page really rendered: the map has candidate dots
    page.wait_for_selector("#hero-chart g.pt[data-id]", state="attached")
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
    assert page.locator(".mpct, .pod").count() == 0, "a match showed mid-quiz"
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
        assert len(opened) == 1 and opened[0]["person"] == person, opened
        assert opened[0]["page"] == "mayor"


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


def test_best_match_is_the_nearest_dot_on_the_map(page, mayor_site):
    # Connor, Nov 11: "the dot has to be closest to their closest match", and the number of statements a
    # candidate has answered must play no part. So the best match is the nearest candidate dot, solid
    # or hollow (placed by leaning), and the percent is map closeness (x, y are rounded to 2 decimals).
    run_quiz(page, mayor_site)
    _, ph = sent(page)
    fin = named(ph, "mayor_quiz_finished")[0]
    assert fin["match_method"] == "map"
    dots = page.evaluate("""([x, y]) => window.MayorCompassData.people
        .filter(p => p.cand && p.x != null && p.y != null)
        .map(p => ({id: p.id, lean: !!p.by_lean, d: Math.hypot(p.x - x, p.y - y)}))
        .sort((a, b) => a.d - b.d)""", [fin["x"], fin["y"]])
    assert any(d["lean"] for d in dots), "no candidate is placed by leaning"
    if dots[1]["d"] - dots[0]["d"] > 0.02:  # not a near tie that rounding could flip
        assert fin["best_match"] == dots[0]["id"], (fin["best_match"], dots[:3])
    assert abs(fin["best_match_pct"] - 100 * (1 - dots[0]["d"] / 20)) <= 1
    assert [t["pct"] for t in fin["top3"]] == sorted((t["pct"] for t in fin["top3"]), reverse=True)
    # the page: three ranked rows with no statement count, 1 2 3 on the map, hollow dots for leaning
    assert page.locator(".ranklist .pod").count() == 3
    assert "same side" not in page.locator(".ranklist").inner_text().lower()
    assert sorted(page.locator("#hero-chart .rkn").all_text_contents()) == ["1", "2", "3"]
    assert page.locator("#hero-chart .dot.lean").count() > 0, "no hollow dot for a candidate placed by leaning"
    # badge 1 on the map sits on the best match, and the ranked rows show the same people and percents
    # as the result that was counted
    badge1 = page.evaluate("""() => [...document.querySelectorAll("#hero-chart .rkn")]
        .find(t => t.textContent.trim() === "1")?.closest("[data-id]")?.dataset.id""")
    assert badge1 == fin["best_match"], (badge1, fin["best_match"])
    pods = page.evaluate("""() => [...document.querySelectorAll(".ranklist .pod")].map(b => ({
        id: b.dataset.id, pct: parseInt(b.querySelector(".pdp").textContent.match(/(\\d+)%/)[1], 10)}))""")
    assert pods == [{"id": t["id"], "pct": t["pct"]} for t in fin["top3"]], (pods, fin["top3"])
    assert page.locator("#mapnote").is_hidden()


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
    # one blue button on the screen: the result card has no second copy button (Connor, Nov 11)
    assert page.locator("#qcopy").count() == 0 and page.locator("#live .btn:not(.btn-ghost)").count() == 0
    types = page.evaluate("async () => (await navigator.clipboard.read())[0].types")
    assert "image/png" in types
    ga, ph = sent(page)
    assert [p.get("where") for p in named(ph, "mayor_quiz_card_copied")] == ["top"]
    assert len(named(ga, "mayor_quiz_card_copied")) == 1
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
    assert page.locator("#live .bd").count() == 0
    assert page.locator("#bdwhy").get_attribute("aria-expanded") == "false"
    page.click("#bdwhy")
    page.wait_for_selector("#live .bd .bdaxis")  # See why opens with the two lines, then any shared statements
    # the visitor's top issues come first in the list, and the old "Your top issues" line is gone
    assert page.locator("#live .topline").count() == 0
    flags = page.evaluate("[...document.querySelectorAll('#live .bdrow')].map(r => !!r.querySelector('.bds .chip'))")
    assert flags == sorted(flags, reverse=True), flags
    assert page.locator("#bdwhy").get_attribute("aria-expanded") == "true"
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_why_opened")) == 1, pairs
    page.click("#bdwhy")
    page.wait_for_function("!document.querySelector('#live .bd')")


def test_building_rule_statements_are_compare_only(page, mayor_site):
    """Connor, Nov 11: the five housing and building rule statements move no dot and no match. The
    result offers them as a comparison with the top matches, and opening it is counted."""
    run_quiz(page, mayor_site)
    assert page.locator("#live .rulestab").count() == 0
    page.click("#rulesbtn")
    page.wait_for_selector("#live .rulestab")
    assert page.locator("#live .rulestab .rq").count() == 5
    assert page.locator("#live .rulestab .rh").count() == 2 + page.locator(".ranklist .pod").count()
    ga, ph = sent(page)
    for pairs in (ga, ph):
        assert len(named(pairs, "mayor_quiz_rules_opened")) == 1, pairs
    assert page.errors == []


QUIZ_ORDER = ["E5","C1","E6","S12","E17","S1","E20","C4","E19","S5","E13","S4","E18","C2","E3","S6","E16","C3","E15","C5","E21","S2","E11","E12"]
RULES = {"C2", "C3", "C4", "C5", "E12"}


def finish_to_result(page, site, keys):
    page.goto(f"{site}/mayor", wait_until="load")
    answer(page, keys)
    pass_issues(page)
    page.wait_for_selector("#pgo")
    page.click("#pskip")
    page.wait_for_function("document.querySelector('#cdwn') || document.querySelector('#live .reslabel')")
    if page.locator("#cdwn").count():
        page.keyboard.press("Space")
    page.wait_for_selector("#live .reslabel")


def test_building_rules_and_neutral_answers_do_not_place_you(page, mayor_site):
    """Round 12 (Connor, Nov 11): a line places you only with 2 agree or disagree answers on it. Agreeing
    with the five building-rule statements and answering Neutral everywhere else gives no match."""
    keys = ["5" if q in RULES else "3" for q in QUIZ_ORDER]
    finish_to_result(page, mayor_site, keys)
    assert page.locator(".ranklist .pod").count() == 0
    assert "too few statements" in page.locator("#live").inner_text()
    assert page.locator("#hero-chart .you-dot").count() == 0
    assert page.errors == []


def test_one_placed_line_matches_on_that_line_alone(page, mayor_site):
    """Economy answers only (enforcement all Neutral): you are matched on the economy alone, and the page
    says so. Closeness words sit beside each percent, and unplaced candidates are named."""
    econ = [q for q in QUIZ_ORDER if q.startswith("E") and q not in RULES]
    keys = [("5" if econ.index(q) % 2 else "4") if q in econ else "3" for q in QUIZ_ORDER]
    finish_to_result(page, mayor_site, keys)
    live = page.locator("#live").inner_text()
    assert "matched on the economy alone" in live
    assert "Not placed" not in live  # method notes sit behind a link (Connor, Nov 11)
    page.click("#howbtn")
    live = page.locator("#live").inner_text()
    assert page.locator(".ranklist .pod").count() == 3
    words = page.locator(".ranklist .cw").all_text_contents()
    assert len(words) == 3 and all(w in ("Very close", "Close", "Somewhat close", "Far") for w in words), words
    assert "Not placed (too few public positions)" in live and "Matt Brewer" in live
    names = page.evaluate("window.MayorCompassData.people.map(p => p.name)")
    assert "Toni Brooks" not in names  # did not file (Board list of Nov 9, 2026)
    _, ph = sent(page)
    assert named(ph, "mayor_quiz_finished")[0]["lines"] == "economy"
    assert page.errors == []


def test_quiz_order_matches_the_data_and_the_economy_line_is_balanced(page, mayor_site):
    """Round 13 (Connor, Nov 11): four consensus budget statements left and four where the parties split
    joined. The economy line stays 6 progressive-agree and 6 conservative-agree."""
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    qs = page.evaluate("window.MayorCompassData.questions.map(q => [q.qid, q.axis, q.agree_direction])")
    assert sorted(q[0] for q in qs) == sorted(QUIZ_ORDER)
    econ = [d for _, ax, d in qs if ax == "econ"]
    assert len(econ) == 12 and econ.count(1) == 6 and econ.count(-1) == 6
    for gone in ("E1", "E7", "E10", "E14"):
        assert gone not in QUIZ_ORDER


def test_campaign_site_and_voting_links_are_counted(page, mayor_site):
    """Connor, Nov 11: the result links to the top matches' campaign sites, where to vote and how to
    register, and every click is counted."""
    run_quiz(page, mayor_site)
    # keep the page here: the counter listens before the click would leave the page
    page.evaluate("document.addEventListener('click', e => e.preventDefault())")
    links = page.locator("#live a[data-mclink]")
    kinds = links.evaluate_all("els => els.map(a => a.dataset.mclink)")
    assert "where_to_vote" in kinds and "register" in kinds, kinds
    for k in ("where_to_vote", "register"):
        page.locator(f'#live a[data-mclink="{k}"]').first.dispatch_event("click")
    if "campaign_site" in kinds:
        page.locator('#live a[data-mclink="campaign_site"]').first.dispatch_event("click")
    _, ph = sent(page)
    got = [e["link"] for e in named(ph, "mayor_quiz_link")]
    assert "where_to_vote" in got and "register" in got, got
    assert all(e["where"] == "result" for e in named(ph, "mayor_quiz_link"))
    if "campaign_site" in kinds:
        assert any(e.get("person") for e in named(ph, "mayor_quiz_link") if e["link"] == "campaign_site")


def test_result_card_layout_and_drawer_links(page, mayor_site):
    """Connor, Nov 11: the left card and the map are one height; the lean-toward line and the 'you land'
    sentence are gone; the voter's dot stays within the candidates' range; the drawer links a candidate's
    campaign site and the voting pages, and those clicks are counted with where=drawer."""
    page.set_viewport_size({"width": 1440, "height": 1100})
    run_quiz(page, mayor_site)
    live = page.locator("#live").inner_text()
    assert "You said you lean toward" not in live and "you land" not in live
    h = page.evaluate("[document.querySelector('#live').getBoundingClientRect().height, document.querySelector('.ccol').getBoundingClientRect().height]")
    assert abs(h[0] - h[1]) <= 2, h
    me, rng = page.evaluate("""() => { const c = window.MayorCompassData.people.filter(p => p.cand && p.x != null && p.y != null);
        return [window._me, [Math.min(...c.map(p => p.x)), Math.max(...c.map(p => p.x)), Math.min(...c.map(p => p.y)), Math.max(...c.map(p => p.y))]]; }""")
    assert min(rng[0], 0) <= me["x"] <= max(rng[1], 0) and min(rng[2], 0) <= me["y"] <= max(rng[3], 0), (me, rng)
    pid = page.evaluate("window.MayorCompassData.people.find(p => p.cand && p.site).id")
    page.evaluate(f"document.querySelector('.crow[data-id=\"{pid}\"]').click()")
    page.wait_for_function("!document.querySelector('#drawer').hidden")
    page.evaluate("document.addEventListener('click', e => e.preventDefault())")
    for a in page.locator("#drawer a[data-mclink]").all():
        a.dispatch_event("click")
    _, ph = sent(page)
    got = {(e["link"], e["where"]) for e in named(ph, "mayor_quiz_link")}
    assert {("campaign_site", "drawer"), ("where_to_vote", "drawer"), ("register", "drawer")} <= got, got
    years = page.locator("#drawer .fact .chip").all_text_contents()
    assert any(re.fullmatch(r"\d{4}", y.strip()) for y in years), years


@pytest.mark.parametrize("placed, other", [("econ", "enforcement"), ("control", "economy")])
@pytest.mark.parametrize("side", [1, -1])
def test_share_card_names_only_the_line_you_were_placed_on(page, mayor_site, placed, other, side):
    """Answer every statement on one line strongly toward one side and stay neutral on the rest: you are
    placed on that line only, so the share card names that side of that line and nothing else."""
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    for i in range(1, 25):
        page.wait_for_function(f"document.querySelector('#quiz .qprog')?.textContent.includes('Statement {i} of 24')")
        q = page.evaluate("""() => {
            const t = document.querySelector('#qtext').textContent;
            return window.MayorCompassData.questions.find((q) => q.text === t);
        }""")
        toward = q["agree_direction"] * side > 0
        page.keyboard.press(("5" if toward else "1") if q["axis"] == placed else "3")
    pass_issues(page)
    page.wait_for_selector("#pgo")
    page.click("#pskip")
    skip_countdown(page)
    page.click("#qcard")
    alt = page.locator("#cardimg").get_attribute("alt")
    # the exact words for your side of the placed line, from the position that was counted
    _, ph = sent(page)
    fin = named(ph, "mayor_quiz_finished")[0]
    assert fin["lines"] == {"econ": "economy", "control": "enforcement"}[placed], fin
    v = fin["x"] if placed == "econ" else fin["y"]
    if placed == "econ":
        want = "Middle on the economy" if abs(v) < 1.5 else "Conservative on the economy" if v > 0 else "Progressive on the economy"
    else:
        want = "Middle on enforcement" if abs(v) < 1.5 else "Tougher enforcement" if v > 0 else "Lighter touch"
    assert alt == "Share card: " + want, (alt, v)
    assert (v > 0) == (side > 0) and abs(v) >= 1.5, ("the answers did not reach the side under test", v)
    assert other not in alt.lower(), alt
    assert page.errors == []


def at_statement(page, i):
    page.wait_for_function(f"document.querySelector('#quiz .qprog')?.textContent.includes('Statement {i} of 24')")


def test_keyboard_stays_in_the_card_and_arrows_only_answer_there(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    at_statement(page, 1)
    # The down arrow on the page scrolls; it does not answer Not sure.
    page.evaluate("document.activeElement && document.activeElement.blur()")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    assert "Statement 1 of 24" in page.locator("#quiz .qprog").inner_text()
    # Answer with Enter on a focused button: focus lands on the next statement, still in the card.
    page.focus('#quiz .ans[data-v="1"]')
    page.keyboard.press("Enter")
    at_statement(page, 2)
    assert page.evaluate("document.querySelector('#quiz').contains(document.activeElement)")
    assert page.evaluate("document.activeElement.id") == "qtext"
    # From inside the card the arrow keys answer.
    page.keyboard.press("ArrowRight")
    at_statement(page, 3)
    # The star keeps focus on itself.
    page.focus("#star")
    page.keyboard.press("Enter")
    page.wait_for_function("document.querySelector('#star')?.getAttribute('aria-pressed') === 'true'")
    assert page.evaluate("document.activeElement.id") == "star"
    assert page.errors == []


def test_closing_a_candidate_drawer_returns_focus_to_its_row(page, mayor_site):
    run_quiz(page, mayor_site)
    row = page.locator("#mc .crow[data-id]").first
    pid = row.get_attribute("data-id")
    row.focus()
    page.keyboard.press("Enter")
    page.wait_for_selector("#drawer:not([hidden])")
    page.keyboard.press("Escape")
    page.wait_for_selector("#drawer", state="hidden")
    assert page.evaluate("document.activeElement.dataset.id") == pid
    assert page.errors == []


def test_keyboard_focus_stays_with_the_card_on_the_last_two_steps(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    at_statement(page, 1)
    page.focus('#quiz .ans[data-v="1"]')
    for i in range(1, 25):
        at_statement(page, i)
        page.keyboard.press("4")
    page.wait_for_selector("#tgo")
    assert page.evaluate("document.activeElement.id") == "qtext", "focus left the card at the issues step"
    page.focus("#tskip")
    page.keyboard.press("Enter")
    page.wait_for_selector("#pgo")
    assert page.evaluate("document.activeElement.id") == "qtext", "focus left the card at the picks step"
    assert page.errors == []


def test_a_jump_from_the_pinned_strip_keeps_keyboard_focus_in_the_card(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    answer(page, KEYS[:12])
    at_statement(page, 13)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_selector("#qpin.on")
    page.focus('#qpin .mseg[data-k="2"]')
    page.keyboard.press("Enter")
    at_statement(page, 3)
    assert page.evaluate("document.activeElement.id") == "qtext"
    assert page.errors == []


def test_arrows_answer_after_a_click_on_the_card_background(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    at_statement(page, 1)
    page.click("#quiz .qctx")  # not a button: focus stays on the page body
    assert page.evaluate("document.activeElement === document.body")
    page.keyboard.press("ArrowRight")
    at_statement(page, 2)
    # a click outside the card turns the arrows back into scrolling
    page.click("h1")
    page.keyboard.press("ArrowDown")
    page.wait_for_timeout(200)
    assert "Statement 2 of 24" in page.locator("#quiz .qprog").inner_text()
    assert page.errors == []


def test_finish_now_is_counted_as_an_early_finish(page, mayor_site):
    page.goto(f"{mayor_site}/mayor", wait_until="load")
    answer(page, KEYS[:12])
    page.click("#qfin")
    pass_issues(page)
    page.wait_for_selector("#pgo")
    page.click("#pskip")
    skip_countdown(page)
    _, ph = sent(page)
    fin = named(ph, "mayor_quiz_finished")
    assert len(fin) == 1 and fin[0]["finished_early"] is True, fin
    assert page.errors == []
