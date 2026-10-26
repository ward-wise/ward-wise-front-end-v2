"""Analytics: every count reaches both tools with the ward, and the private alert-settings token in
/alerts?m=<token> never reaches either. Runs against a build with a fake GA id and PostHog key.
Both tools' scripts are blocked, so gtag leaves its calls in window.dataLayer and the PostHog
stub keeps its calls in window.posthog, which is exactly what the tools would have read."""

from __future__ import annotations

import functools
import http.server
import json
import threading

import pytest

pytestmark = pytest.mark.browser

SECRET = "SECRETtoken123"


@pytest.fixture(scope="module")
def tracked_site(tmp_path_factory) -> str:
    """A second build, with both tools switched on, served as plain static files (no /api proxy:
    tests stub the few API calls they need)."""
    import build_static

    out = tmp_path_factory.mktemp("dist-tracked")
    assert build_static.main(["--out", str(out), "--sha", "test", "--ga-id", "G-TEST", "--posthog-key", "phc_test"]) == 0
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(out))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture
def page(browser):
    context = browser.new_context()
    # The tools' own scripts never load: what they would send is what's queued in the page.
    context.route("**/*googletagmanager.com/**", lambda route: route.abort())
    context.route("**/*posthog.com/**", lambda route: route.abort())
    page = context.new_page()
    yield page
    context.close()


def sent(page) -> dict:
    """Everything queued for Google Analytics and PostHog, plus the address bar."""
    return page.evaluate("""() => ({
        ga: (window.dataLayer || []).map((entry) => Array.from(entry)),
        posthog: Array.from(window.posthog || []).filter(Array.isArray),
        init: (window.posthog && window.posthog._i) || [],
        href: location.href,
    })""")


def events(page, name):
    data = sent(page)
    ga = [entry[2] for entry in data["ga"] if entry[:2] == ["event", name]]
    ph = [entry[2] for entry in data["posthog"] if entry[:2] == ["capture", name]]
    return ga, ph


def stub_manage_api(page, calls):
    def handle(route):
        calls.append(route.request.url)
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "email": "resident@example.org", "topics": [], "frequency": "weekly",
            "urgent_zoning": False, "status": "active", "ward": "05",
        }))
    page.route("**/api/alerts/preferences**", handle)


def test_leak_manage_token_reaches_neither_tool(page, tracked_site):
    page.goto(f"{tracked_site}/alerts?m={SECRET}&utm_source=email", wait_until="load")
    page.wait_for_timeout(500)
    data = sent(page)
    assert SECRET not in data["href"], data["href"]
    assert "utm_source=email" in data["href"], "only the token comes off the address"
    assert SECRET not in json.dumps(data, default=str), "the token reached an analytics queue"
    assert data["init"], "PostHog was not set up on a build with a key"


def test_leak_other_pages_keep_their_m_parameter(page, tracked_site):
    # On /k3 and /report, m= is the chosen measures, and it must stay in the link.
    page.goto(f"{tracked_site}/k3?m=abc", wait_until="load")
    assert "m=abc" in page.evaluate("location.href")


def test_manage_mode_still_works_after_the_token_is_lifted(page, tracked_site):
    calls = []
    stub_manage_api(page, calls)
    page.goto(f"{tracked_site}/alerts?m={SECRET}", wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    assert calls and f"m={SECRET}" in calls[0], calls
    assert page.evaluate("document.querySelector('#fd-alert-form').elements.email.value") == "resident@example.org"
    # A reload in the same tab keeps manage mode, though the address bar no longer has the token.
    page.reload(wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    assert len(calls) == 2 and f"m={SECRET}" in calls[1], calls


def test_civic_step_goes_to_both_tools_with_ward(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("""() => {
        localStorage.setItem("wardwise:ward", "05");
        // Keep the test page in place: stop the links from opening, after the count has run.
        document.addEventListener("click", (event) => event.preventDefault());
        for (const href of ["mailto:alder@example.org", "tel:3125550100", "https://311.chicago.gov", "https://example.com/", "mailto:harry@wardwise.org"]) {
            const link = Object.assign(document.createElement("a"), { href, textContent: href });
            document.body.append(link);
            link.click();
        }
    }""")
    ga, ph = events(page, "civic_step")
    expected = [{"step": "email", "ward": "05"}, {"step": "call", "ward": "05"}, {"step": "311", "ward": "05"}]
    for got in (ga, ph):
        assert [{k: e[k] for k in ("step", "ward")} for e in got] == expected, got
    assert all("alder@example.org" not in json.dumps(e) for e in ga + ph), "the link target was sent"


def test_alert_signup_started_is_counted_once(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    form = page.locator("#fd-alert-form")
    form.locator("input[name=email]").focus()
    page.locator("body").click(position={"x": 1, "y": 1})
    form.locator("input[name=email]").focus()
    ga, ph = events(page, "alert_signup_started")
    assert len(ga) == 1 and len(ph) == 1, (ga, ph)


def test_ward_pick_is_counted(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("window.WardWiseMyWard.set('12', 'picker')")
    ga, ph = events(page, "ward_selected")
    assert ga == ph == [{"ward": "12", "how": "picker", "page": "alerts"}], (ga, ph)


def test_counts_carry_the_ward_on_screen_too(page, tracked_site):
    page.goto(f"{tracked_site}/k3?ward=5", wait_until="load")
    page.evaluate("""() => { localStorage.setItem("wardwise:ward", "07"); WardWiseAnalytics.track("report_shared", { how: "copy_link" }); }""")
    ga, ph = events(page, "report_shared")
    assert [(e["ward"], e["viewed_ward"]) for e in ga] == [(e["ward"], e["viewed_ward"]) for e in ph] == [("07", "05")], (ga, ph)


def test_topic_section_open_is_counted(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("""() => {
        document.body.insertAdjacentHTML("beforeend",
          '<details class="wardreport-accordion" data-domain="health"><summary><span class="wardreport-domain">Health</span></summary>x</details>');
    }""")
    page.locator("details[data-domain] summary").click()
    ga, ph = events(page, "topic_opened")
    assert [e["topic"] for e in ga] == [e["topic"] for e in ph] == ["Health"], (ga, ph)


def test_leak_alias_alerts_address_is_scrubbed_too(page, tracked_site):
    page.goto(f"{tracked_site}/alerts/index.html?m={SECRET}", wait_until="load")
    data = sent(page)
    assert SECRET not in data["href"], data["href"]
    assert SECRET not in json.dumps(data, default=str)


def test_leak_posthog_backstop_scrubs_every_string(page, tracked_site):
    # Run PostHog's before_send on an event shaped like the worst case: tokens on alias paths, in
    # nested error frames and messages, in $set_once, and an exact Near me spot in the page link.
    page.goto(f"{tracked_site}/", wait_until="load")
    cleaned = page.evaluate("""(secret) => {
        const before = window.posthog._i[0][1].before_send;
        return JSON.stringify(before({
            event: "$exception",
            properties: {
                $current_url: "https://www.wardwise.org/alerts/index.html?M=" + secret,
                $referrer: "https://www.wardwise.org/near#lat=41.91&lng=-87.67&r=800",
                $exception_message: "fetch failed /api/alerts/preferences?%6D=" + secret,
                $exception_list: [{ stacktrace: { frames: [{ filename: "/alerts?x=1&m=" + secret }] } }],
                keep: "/k3?m=abc",
            },
            $set_once: { $initial_current_url: "/alerts#m=" + secret },
            $heatmap_data: { ["https://www.wardwise.org/alerts?m=" + secret]: [{ x: 1 }] },
        }));
    }""", SECRET)
    assert SECRET not in cleaned, cleaned
    assert "lat=41.91" not in cleaned, cleaned
    assert "/k3?m=abc" in cleaned, "measure lists on other pages must survive"


def test_manage_token_is_forgotten_on_a_later_visit(page, tracked_site):
    calls = []
    stub_manage_api(page, calls)
    page.goto(f"{tracked_site}/alerts?m={SECRET}", wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    # The next person at a shared computer opens Alerts from the home page in the same tab.
    page.goto(f"{tracked_site}/", wait_until="load")
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.wait_for_timeout(300)
    assert len(calls) == 1, calls
    assert page.evaluate("document.querySelector('#fd-alert-form').elements.email.value") == ""


def test_bad_manage_link_falls_back_to_sign_up(page, tracked_site):
    page.route("**/api/alerts/preferences**", lambda route: route.fulfill(
        status=404, content_type="application/json", body='{"error": "That link has expired."}'))
    page.goto(f"{tracked_site}/alerts?m=BAD", wait_until="load")
    page.wait_for_function("sessionStorage.getItem('wardwise:alerts-manage') === null")
    # Back in sign-up mode, so starting the form is a sign-up start.
    page.locator("#fd-alert-form input[name=email]").focus()
    ga, ph = events(page, "alert_signup_started")
    assert len(ga) == len(ph) == 1, (ga, ph)


def test_signup_confirmed_counts_once_with_ward(page, tracked_site):
    stub_manage_api(page, [])
    page.goto(f"{tracked_site}/alerts?alerts=confirmed&m={SECRET}", wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    assert "alerts=confirmed" not in page.evaluate("location.href")
    page.reload(wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    ga, ph = events(page, "alert_signup_confirmed")
    assert ga == ph == [], "a reload counted the confirmation again"
    page.goto(f"{tracked_site}/alerts?alerts=confirmed&m={SECRET}", wait_until="load")
    page.wait_for_function("document.querySelector('#fd-alert-form').elements.email.value !== ''")
    ga, ph = events(page, "alert_signup_confirmed")
    assert [e.get("ward") for e in ga] == [e.get("ward") for e in ph] == ["05"], (ga, ph)


def test_topic_opened_only_on_a_readers_tap(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("""() => document.body.insertAdjacentHTML("beforeend",
        '<details data-domain="character" open><summary><span class="wardreport-domain">Change</span></summary>x</details>' +
        '<details data-domain="health"><summary><span class="wardreport-domain">Health</span></summary>x</details>')""")
    page.evaluate("document.querySelectorAll('details[data-domain]').forEach((d) => { d.open = true; })")  # print opens all
    page.wait_for_timeout(100)
    assert events(page, "topic_opened") == ([], [])
    page.evaluate("document.querySelector('details[data-domain=health]').open = false")
    page.locator("details[data-domain=health] summary").click()
    ga, ph = events(page, "topic_opened")
    assert [e["topic"] for e in ga] == [e["topic"] for e in ph] == ["Health"], (ga, ph)


def test_home_map_measure_pick_is_counted(page, tracked_site, site_url):
    # The map needs real data: send this build's /api calls through the test server's proxy.
    page.route(f"{tracked_site}/api/**", lambda route: route.fulfill(
        response=route.fetch(url=route.request.url.replace(tracked_site, site_url))))
    page.goto(f"{tracked_site}/", wait_until="load")
    chips = page.locator(".fd-chips button[data-id]")
    chips.first.wait_for()
    current = page.locator(".fd-chips button[aria-pressed=true]").get_attribute("data-id")
    other = chips.nth(1)
    measure = other.get_attribute("data-id")
    assert measure != current
    page.locator(".fd-chips button[aria-pressed=true]").click()  # already showing: not a new open
    other.click()
    ga, ph = events(page, "measure_opened")
    assert [e["measure"] for e in ga] == [e["measure"] for e in ph] == [measure], (ga, ph)
    page.unroute_all(behavior="ignoreErrors")  # map data still loading must not fail the next test


def test_topic_opened_from_a_bloom_petal_and_not_on_close(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("""() => document.body.insertAdjacentHTML("beforeend",
        '<button data-domain-target="health">petal</button>' +
        '<details class="wardreport-accordion" data-domain="health"><summary><span class="wardreport-domain">Health</span></summary>x</details>')""")
    # The page's own petal handler opens the section, after the count's capture listener has run.
    page.evaluate("""() => document.querySelector('[data-domain-target]').addEventListener('click', () => {
        document.querySelector('details[data-domain=health]').open = true; })""")
    page.locator("[data-domain-target]").click()
    page.locator("[data-domain-target]").click()  # already open: not counted again
    page.locator("details[data-domain=health] summary").click()  # a reader closing it: not an open
    ga, ph = events(page, "topic_opened")
    assert [e["topic"] for e in ga] == [e["topic"] for e in ph] == ["Health"], (ga, ph)


def test_middle_click_on_a_civic_link_is_counted(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("""() => {
        document.addEventListener("auxclick", (event) => event.preventDefault());
        document.body.append(Object.assign(document.createElement("a"), { href: "tel:3125550100", textContent: "Call", id: "call" }));
    }""")
    page.locator("#call").click(button="middle")
    ga, ph = events(page, "civic_step")
    assert [e["step"] for e in ga] == [e["step"] for e in ph] == ["call"], (ga, ph)


def test_k3_ward_pick_counts_the_ward_on_screen(page, tracked_site, site_url):
    page.route(f"{tracked_site}/api/**", lambda route: route.fulfill(
        response=route.fetch(url=route.request.url.replace(tracked_site, site_url))))
    page.add_init_script("localStorage.setItem('wardwise:ward', '12')")
    with page.expect_response(lambda response: "score-matrix" in response.url):  # ward data loaded
        page.goto(f"{tracked_site}/k3", wait_until="load")
    page.fill("#k3-search", "5")
    page.press("#k3-search", "Enter")
    page.wait_for_function("(window.dataLayer || []).some((e) => e[1] === 'ward_selected')")
    ga, ph = events(page, "ward_selected")
    assert [(e["ward"], e["viewed_ward"], e["how"]) for e in ga] == [(e["ward"], e["viewed_ward"], e["how"]) for e in ph] \
        == [("12", "05", "search")], (ga, ph)
    page.unroute_all(behavior="ignoreErrors")


def test_alert_topics_chosen_counts_once(page, tracked_site):
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    boxes = page.locator("#fd-alert-form input[name=topics]")
    boxes.nth(0).click()
    boxes.nth(1).click()
    ga, ph = events(page, "alert_topics_chosen")
    assert len(ga) == len(ph) == 1, (ga, ph)


def test_page_still_works_when_a_blocker_removes_posthog(browser, tracked_site):
    context = browser.new_context()
    context.route("**/*googletagmanager.com/**", lambda route: route.abort())
    context.route("**/*posthog.com/**", lambda route: route.abort())
    # A blocker that pins window.posthog to undefined before the page's own scripts run.
    context.add_init_script("Object.defineProperty(window, 'posthog', { get: () => undefined, set: () => {} })")
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{tracked_site}/alerts", wait_until="load")
    page.evaluate("WardWiseAnalytics.track('report_shared', { how: 'print' })")
    context.close()
    assert errors == [], errors
