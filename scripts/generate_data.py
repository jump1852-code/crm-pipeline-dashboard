#!/usr/bin/env python3
"""Generate a realistic, 100 % SYNTHETIC B2B sales-pipeline dataset.

Nothing here comes from a real company. Account names are assembled from word
lists, reps are invented, and amounts are drawn from log-normal distributions.
The schema deliberately mirrors the Dynamics 365 Sales *Opportunity* table so
the dashboard logic maps 1:1 to a Power BI model built on Dataverse.

Usage::

    python scripts/generate_data.py                 # defaults: seed 2026, as-of 2026-10-30
    python scripts/generate_data.py --seed 7 --n 600 --as-of 2026-06-30

Outputs ``site/data/crm.json`` (used by the dashboard) and
``data/opportunities.csv`` (for Excel / Power BI import).
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

COMPANY = "Contoso Industrial Supply (fictional)"
CURRENCY = "USD"
FISCAL_YEAR = 2026

REGIONS = {
    "Thailand": ["Ananya Srisuk", "Krit Wongsawat", "Pim Chaiyaporn"],
    "Vietnam": ["Linh Tran", "Duc Nguyen"],
    "Malaysia": ["Aisyah Rahman", "Daniel Lim"],
    "Indonesia": ["Budi Santoso", "Sari Wijaya"],
    "Philippines": ["Miguel Reyes", "Clarisse Tan"],
}
#: fallback quarterly quota per rep (USD) if a rep has no bookings yet
QUOTA = {"Thailand": 420_000, "Vietnam": 360_000, "Malaysia": 330_000, "Indonesia": 380_000, "Philippines": 300_000}

PRODUCT_LINES = {  # name: (median deal size, sigma)
    "Pumps & Valves": (38_000, 0.55),
    "Safety Equipment": (16_000, 0.5),
    "Power Tools": (11_000, 0.45),
    "Maintenance Contracts": (52_000, 0.6),
}
INDUSTRIES = [
    "Manufacturing",
    "Energy & Utilities",
    "Food & Beverage",
    "Logistics",
    "Mining",
    "Infrastructure",
    "Automotive",
    "Pharma",
]
PREFIX = [
    "Apex",
    "Lotus",
    "Siam",
    "Mekong",
    "Coral",
    "Orchid",
    "Golden",
    "Harbor",
    "Summit",
    "Jade",
    "Monsoon",
    "Pacific",
    "Teak",
    "Banyan",
    "Eastern",
    "Silver",
    "Delta",
    "Royal",
    "Unity",
    "Pioneer",
    "Lumen",
    "Nova",
]
CORE = ["Bay", "Ridge", "Star", "River", "Peak", "Gate", "Field", "Crest", "Point", "Stone", "Wave", "Forge"]
SUFFIX = [
    "Engineering",
    "Industries",
    "Logistics",
    "Foods",
    "Energy",
    "Manufacturing",
    "Holdings",
    "Works",
    "Utilities",
    "Packaging",
    "Steel",
    "Chemicals",
]
LEGAL = {"Thailand": "Co., Ltd.", "Vietnam": "JSC", "Malaysia": "Sdn Bhd", "Indonesia": "PT", "Philippines": "Inc."}

# D365-style sales process. probability = default close probability per stage.
STAGES = [("Qualify", 0.10), ("Develop", 0.25), ("Propose", 0.50), ("Negotiate", 0.75)]
STAGE_DAYS = {"Qualify": 14, "Develop": 21, "Propose": 18, "Negotiate": 15}
LOSS_REASONS = ["Price", "Competitor", "No budget", "Timing", "No decision", "Product fit"]
NEXT_STEPS = [
    "Schedule site visit",
    "Send revised quote",
    "Technical demo",
    "Follow up with procurement",
    "Confirm budget owner",
    "Prepare tender documents",
    "Trial unit delivery",
    "Contract review",
]


@dataclass
class Opportunity:
    id: str
    name: str
    account: str
    industry: str
    country: str
    owner: str
    product_line: str
    stage: str
    status: str  # Open | Won | Lost
    amount: float
    probability: int
    forecast_category: str  # Pipeline | Best case | Committed | Won | Omitted
    created_on: str
    est_close_date: str
    actual_close_date: str | None
    loss_reason: str | None
    lost_at_stage: str | None
    last_activity_on: str
    next_step: str | None


def account_name(rng: random.Random, country: str) -> tuple[str, str]:
    """Return (legal account name, short name) for a fictional company."""
    short = f"{rng.choice(PREFIX)} {rng.choice(CORE)}"
    base = f"{short} {rng.choice(SUFFIX)}"
    legal = LEGAL[country]
    return (f"PT {base}" if legal == "PT" else f"{base} {legal}"), short


def forecast_category(prob: float) -> str:
    if prob >= 0.75:
        return "Committed"
    if prob >= 0.5:
        return "Best case"
    return "Pipeline"


def generate(n: int, seed: int, as_of: date) -> dict[str, object]:
    rng = random.Random(seed)
    start = date(FISCAL_YEAR - 1, 9, 1)
    horizon = (as_of - start).days
    accounts: dict[str, list[tuple[tuple[str, str], str]]] = {
        c: [(account_name(rng, c), rng.choice(INDUSTRIES)) for _ in range(28)] for c in REGIONS
    }
    rep_skill = {r: rng.uniform(0.85, 1.2) for reps in REGIONS.values() for r in reps}
    opps: list[Opportunity] = []

    for i in range(n):
        country = rng.choices(list(REGIONS), weights=[30, 18, 17, 20, 15])[0]
        owner = rng.choice(REGIONS[country])
        (acct, short), industry = rng.choice(accounts[country])
        line = rng.choices(list(PRODUCT_LINES), weights=[30, 28, 24, 18])[0]
        median, sigma = PRODUCT_LINES[line]
        amount = round(rng.lognormvariate(math.log(median), sigma) / 100) * 100
        # more recent deals are denser (growing pipeline)
        created = start + timedelta(days=int(horizon * rng.random() ** 0.55))
        cycle = int(sum(STAGE_DAYS.values()) * rng.uniform(0.6, 2.2))
        planned_close = created + timedelta(days=cycle)

        # Walk the stages to decide where the deal is today.
        skill = rep_skill[owner]
        day = created
        stage_idx = 0
        lost_at: str | None = None
        status = "Open"
        close_date: date | None = None
        for idx, (stage, _p) in enumerate(STAGES):
            stage_idx = idx
            day += timedelta(days=int(STAGE_DAYS[stage] * rng.uniform(0.5, 1.9)))
            if day > as_of:
                break
            advance = {0: 0.80, 1: 0.80, 2: 0.76, 3: 0.74}[idx] * skill
            if rng.random() > min(advance, 0.95):
                status, close_date, lost_at = "Lost", day, stage
                break
        else:
            day += timedelta(days=int(rng.uniform(3, 20)))
            if day <= as_of:
                status, close_date = "Won", day
            else:
                stage_idx = len(STAGES) - 1

        stage = STAGES[stage_idx][0]
        prob = STAGES[stage_idx][1]
        if status == "Open":
            est_close = max(planned_close, as_of + timedelta(days=rng.randint(-20, 25)))
            if rng.random() < 0.08:  # a few deals slip past their close date
                est_close = as_of - timedelta(days=rng.randint(3, 35))
            prob = min(0.95, max(0.05, prob + rng.uniform(-0.08, 0.08)))
            fc = forecast_category(prob)
            last_act = as_of - timedelta(days=int(rng.expovariate(1 / 9)))
            next_step: str | None = rng.choice(NEXT_STEPS)
        else:
            assert close_date is not None
            est_close = close_date
            prob = 1.0 if status == "Won" else 0.0
            fc = "Won" if status == "Won" else "Omitted"
            last_act = close_date
            next_step = None
        if status != "Open":
            stage = "Closed"

        opps.append(
            Opportunity(
                id=f"OPP-{10001 + i}",
                name=f"{short} – {line}",
                account=acct,
                industry=industry,
                country=country,
                owner=owner,
                product_line=line,
                stage=stage,
                status=status,
                amount=float(amount),
                probability=round(prob * 100),
                forecast_category=fc,
                created_on=created.isoformat(),
                est_close_date=est_close.isoformat(),
                actual_close_date=close_date.isoformat() if close_date else None,
                loss_reason=rng.choice(LOSS_REASONS) if status == "Lost" else None,
                lost_at_stage=lost_at,
                last_activity_on=max(created, min(last_act, as_of)).isoformat(),
                next_step=next_step,
            )
        )

    # Quotas: set like a sales-ops team would — from each rep's run-rate plus a stretch.
    booked: dict[str, float] = {r: 0.0 for reps in REGIONS.values() for r in reps}
    for o in opps:
        if o.status == "Won" and o.actual_close_date and o.actual_close_date[:4] == str(FISCAL_YEAR):
            booked[o.owner] += o.amount
    quarters_elapsed = max(1.0, (as_of - date(FISCAL_YEAR, 1, 1)).days / 91.25)
    targets = []
    for c, reps in REGIONS.items():
        for rep in reps:
            run_rate = booked[rep] / quarters_elapsed or QUOTA[c] / 4
            quota = round(run_rate * rng.uniform(1.0, 1.3) / 5000) * 5000
            targets += [{"owner": rep, "country": c, "quarter": q, "quota": quota} for q in (1, 2, 3, 4)]
    return {
        "meta": {
            "company": COMPANY,
            "currency": CURRENCY,
            "fiscal_year": FISCAL_YEAR,
            "as_of": as_of.isoformat(),
            "seed": seed,
            "synthetic": True,
            "note": "100% synthetic demo data generated by scripts/generate_data.py — not real customers or deals.",
            "stages": [s for s, _ in STAGES],
            "kpi_targets": {"win_rate": 35, "coverage": 3.0, "cycle_days": 75},
        },
        "targets": targets,
        "opportunities": [asdict(o) for o in opps],
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--n", type=int, default=640)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--as-of", type=date.fromisoformat, default=date(2026, 10, 30))
    args = ap.parse_args()

    data = generate(args.n, args.seed, args.as_of)
    out_json = ROOT / "site" / "data" / "crm.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    out_csv = ROOT / "data" / "opportunities.csv"
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    rows = data["opportunities"]
    assert isinstance(rows, list)
    with out_csv.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    status = {s: sum(1 for r in rows if r["status"] == s) for s in ("Open", "Won", "Lost")}
    print(f"wrote {len(rows)} synthetic opportunities -> {out_json.relative_to(ROOT)}, {out_csv.relative_to(ROOT)}")
    print("status mix:", status)


if __name__ == "__main__":
    main()
