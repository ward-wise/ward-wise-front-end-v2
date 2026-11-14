"""The top bar on a phone: "More" must be reachable without discovering a hidden swipe, and a
signed-out visitor must not see an empty account circle."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.browser


def _phone_page(browser, site_url):
    context = browser.new_context(viewport={"width": 390, "height": 844})
    page = context.new_page()
    page.goto(site_url + "/", wait_until="load")
    page.wait_for_timeout(1000)
    return context, page


def test_more_button_is_inside_the_phone_viewport(browser, site_url):
    context, page = _phone_page(browser, site_url)
    box = page.locator(".gn-more-toggle").bounding_box()
    context.close()
    assert box is not None
    assert box["x"] >= 0 and box["x"] + box["width"] <= 390, f"More is off-screen: {box}"


def test_phone_nav_links_have_a_finger_sized_tap_area(browser, site_url):
    context, page = _phone_page(browser, site_url)
    heights = page.evaluate(
        "() => [...document.querySelectorAll('.gn-links > a, .gn-more-toggle')].filter(el => el.offsetParent)"
        ".map(el => el.getBoundingClientRect().height)")
    context.close()
    assert heights and min(heights) >= 43, heights


def test_phone_bar_shows_three_links_and_more_lists_the_rest(browser, site_url):
    """A friend said the bar looked cut off on a phone (Nov 14): the bar shows three links and More,
    nothing runs past the edge, and the other links sit in a Pages group at the top of More."""
    context, page = _phone_page(browser, site_url)
    bar = page.evaluate("""() => [...document.querySelectorAll('.gn-links > a')].filter(a => a.offsetParent)
        .map(a => ({text: a.textContent.trim(), right: a.getBoundingClientRect().right}))""")
    more_right = page.evaluate("document.querySelector('.gn-more-toggle').getBoundingClientRect().right")
    width = page.evaluate("innerWidth")
    page.click("#gn-more-toggle")
    pages = page.locator(".gn-more-phone a").all_inner_texts()
    context.close()
    assert [b["text"].split()[0] for b in bar] == ["Mayor", "Map", "Your"], bar
    assert max(b["right"] for b in bar) < more_right <= width, (bar, more_right, width)
    assert "Data" in pages and "About" in pages, pages


def test_computer_bar_keeps_every_link_and_no_pages_group(browser, site_url):
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    page.goto(site_url + "/", wait_until="load")
    shown = page.evaluate("[...document.querySelectorAll('.gn-links > a')].filter(a => a.offsetParent).length")
    page.click("#gn-more-toggle")
    group = page.locator(".gn-more-phone").is_visible()
    context.close()
    assert shown >= 6 and not group, (shown, group)


def test_account_circle_is_hidden_when_signed_out(browser, site_url):
    context, page = _phone_page(browser, site_url)
    visible = page.locator("#nav-account").is_visible()
    context.close()
    assert not visible, "the empty account circle is showing to a signed-out visitor"
