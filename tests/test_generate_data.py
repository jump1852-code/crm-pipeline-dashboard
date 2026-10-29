"""Tests for the synthetic data generator — the dashboard trusts these invariants."""

from __future__ import annotations

import csv
import importlib.util
import json
import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("generate_data", ROOT / "scripts" / "generate_data.py")
assert spec and spec.loader
gen = importlib.util.module_from_spec(spec)
sys.modules["generate_data"] = gen
spec.loader.exec_module(gen)

AS_OF = date(2026, 10, 30)
STAGES = ["Qualify", "Develop", "Propose", "Negotiate"]


@pytest.fixture(scope="module")
def data() -> dict:
    return gen.generate(640, 2026, AS_OF)


@pytest.fixture(scope="module")
def opps(data: dict) -> list[dict]:
    return data["opportunities"]


def test_deterministic_for_same_seed() -> None:
    assert gen.generate(120, 7, AS_OF) == gen.generate(120, 7, AS_OF)


def test_different_seed_changes_data() -> None:
    assert gen.generate(120, 7, AS_OF) != gen.generate(120, 8, AS_OF)


def test_flagged_as_synthetic(data: dict) -> None:
    assert data["meta"]["synthetic"] is True
    assert "fictional" in data["meta"]["company"].lower()


def test_unique_ids(opps: list[dict]) -> None:
    ids = [o["id"] for o in opps]
    assert len(ids) == len(set(ids))


def test_status_stage_consistency(opps: list[dict]) -> None:
    for o in opps:
        if o["status"] == "Open":
            assert o["stage"] in STAGES
            assert o["actual_close_date"] is None
            assert 0 < o["probability"] < 100
            assert o["forecast_category"] in {"Pipeline", "Best case", "Committed"}
        else:
            assert o["stage"] == "Closed"
            assert o["actual_close_date"] is not None
        if o["status"] == "Won":
            assert o["probability"] == 100 and o["forecast_category"] == "Won" and o["loss_reason"] is None
        if o["status"] == "Lost":
            assert o["probability"] == 0 and o["loss_reason"] and o["lost_at_stage"] in STAGES


def test_dates_are_ordered_and_not_in_future(opps: list[dict]) -> None:
    for o in opps:
        assert o["created_on"] <= AS_OF.isoformat()
        assert o["created_on"] <= o["last_activity_on"] <= AS_OF.isoformat()
        if o["actual_close_date"]:
            assert o["created_on"] <= o["actual_close_date"] <= AS_OF.isoformat()


def test_amounts_positive(opps: list[dict]) -> None:
    assert all(o["amount"] > 0 for o in opps)


def test_realistic_mix(opps: list[dict]) -> None:
    closed = [o for o in opps if o["status"] != "Open"]
    win_rate = sum(o["status"] == "Won" for o in closed) / len(closed)
    assert 0.25 <= win_rate <= 0.5, win_rate
    open_stages = {o["stage"] for o in opps if o["status"] == "Open"}
    assert open_stages == set(STAGES)


def test_targets_cover_every_rep_and_quarter(data: dict, opps: list[dict]) -> None:
    reps = {o["owner"] for o in opps}
    pairs = {(t["owner"], t["quarter"]) for t in data["targets"]}
    assert pairs == {(r, q) for r in reps for q in (1, 2, 3, 4)}
    assert all(t["quota"] > 0 for t in data["targets"])


def test_committed_files_match_generator(data: dict) -> None:
    """The JSON/CSV in the repo must be exactly what the default generator run produces."""
    committed = json.loads((ROOT / "site" / "data" / "crm.json").read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(data))
    with (ROOT / "data" / "opportunities.csv").open(encoding="utf-8") as fh:
        assert sum(1 for _ in csv.DictReader(fh)) == len(data["opportunities"])
