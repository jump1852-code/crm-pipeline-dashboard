"""Browser smoke test: the dashboard renders, filters work and drag-and-drop updates KPIs.

Skipped automatically when Playwright (or a browser) is not installed.
Run locally with:  pip install playwright && playwright install chromium && pytest
"""

from __future__ import annotations

import functools
import http.server
import os
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")

SITE = Path(__file__).resolve().parents[1] / "site"


@pytest.fixture(scope="module")
def base_url() -> Iterator[str]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture(scope="module")
def page(base_url: str) -> Iterator[object]:
    with sync_api.sync_playwright() as p:
        kwargs: dict[str, object] = {"args": ["--no-sandbox"]}
        if os.environ.get("CHROME_PATH"):
            kwargs["executable_path"] = os.environ["CHROME_PATH"]
        try:
            browser = p.chromium.launch(**kwargs)
        except Exception as exc:  # pragma: no cover - environment dependent
            pytest.skip(f"no browser available: {exc}")
        pg = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.goto(base_url)
        pg.wait_for_selector(".kpi")
        pg.errors = errors  # type: ignore[attr-defined]
        yield pg
        browser.close()


def test_overview_renders_without_errors(page) -> None:
    assert page.locator(".kpi").count() == 6
    assert page.locator(".f-bar").count() == 5
    assert page.locator("#leaderboard tr").count() == 11
    assert page.errors == []


def test_slicers_filter_the_leaderboard(page) -> None:
    page.select_option("#f-country", "Vietnam")
    assert page.locator("#leaderboard tr").count() == 2
    page.click("#reset")
    assert page.locator("#leaderboard tr").count() == 11


def test_timeline_draws_one_bar_per_open_deal(page) -> None:
    page.click("[data-view=timeline]")
    open_deals = int(page.inner_text("#gantt-sub").split()[0])
    assert page.locator(".g-bar").count() == open_deals > 0


def test_kanban_drag_to_won_updates_kpi(page) -> None:
    page.click("[data-view=overview]")
    before = page.inner_text(".kpi .v")
    page.click("[data-view=kanban]")
    page.drag_and_drop("[data-stage=Negotiate] .card >> nth=0", "[data-stage=Won]")
    page.click("[data-view=overview]")
    assert page.inner_text(".kpi .v") != before
    assert page.errors == []
