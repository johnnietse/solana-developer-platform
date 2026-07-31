"""GET /metrics endpoint — reads Solana metrics from Delta tables in S3.

Reads ``dev/mlh/polars_metrics_values/`` — a Delta table populated by
Databricks with daily metric snapshots (metric_id, provider_id, value).
Maps metric IDs to human-readable names and aggregates by date.

Usage:
    GET /metrics              # last 30 days (default)
    GET /metrics?days=7       # last 7 days
    GET /metrics?days=90      # last 90 days
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import read_delta

if TYPE_CHECKING:
    from config import Config

metrics_bp = Blueprint("metrics", __name__)

# Fallback metric ID → name map, used only when the catalog table is
# unreachable. The source of truth is the Delta catalog at
# dev/mlh/polars_metrics (written by /insert) — see _metric_names().
METRIC_NAMES: dict[int, str] = {
    1: "Supply",
    2: "Transfer Volume",
    3: "Transfer Count",
    4: "Active Addresses",
    14: "Slots",
    15: "Fee Payers",
    16: "SOL Price",
    17: "Compute Units",
    18: "Fees",
    19: "Transaction Count (Total)",
    20: "Non Vote Transaction Count (Success)",
    21: "Non Vote Transaction Count (Failed)",
    22: "Transaction Count (Vote)",
    23: "DEX Volume",
    24: "DEX Traders",
    25: "DEX Transactions",
    26: "DEX Count",
    27: "Total Stake",
    28: "SOL Price (Network)",
    29: "Validator Count",
    30: "Top 3 ASN Share",
    31: "Stablecoin Count",
}

# Cached catalog lookup — the catalog changes rarely, so read it once per process.
_metric_names_cache: dict[int, str] | None = None


def _metric_names(cfg: Config) -> dict[int, str]:
    """Metric ID → name, read from the S3 catalog with a static fallback."""
    global _metric_names_cache
    if _metric_names_cache is None:
        catalog = read_delta(cfg, path="dev/mlh/polars_metrics")
        if catalog is not None and not catalog.is_empty():
            _metric_names_cache = {r["id"]: r["name"] for r in catalog.to_dicts()}
        else:
            _metric_names_cache = METRIC_NAMES
    return _metric_names_cache


def _register_metrics_routes(app):
    """Inject config into the blueprint (called at app init)."""
    cfg: Config = app.config["APP_CFG"]

    @metrics_bp.route("/metrics", methods=["GET"])
    def get_metrics():
        days = request.args.get("days", default=cfg.default_metrics_days, type=int)
        days = min(max(days, 1), 365)

        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        # ── Read from polars_metrics_values (created by Waddah in Databricks) ─
        df = read_delta(cfg, path="dev/mlh/polars_metrics_values")
        if df is None or df.is_empty():
            return jsonify({
                "days": days,
                "metrics": [],
                "error": "No metrics data found at dev/mlh/polars_metrics_values",
            })

        # Filter by date
        df = df.filter(pl.col("date") >= cutoff)

        # Add human-readable metric name
        name_map = pl.DataFrame([
            {"metric_id": k, "metric_name": v}
            for k, v in _metric_names(cfg).items()
        ])
        df = df.join(name_map, on="metric_id", how="left")

        # Sort by date + metric
        df = df.sort(["date", "metric_id"])

        # Group by date → { date: { metric_name: value, ... } }
        # partition_by(as_dict=True) yields {key_tuple: frame}; iterating it
        # directly walks the key tuples, not the frames.
        metrics_by_date: list[dict] = []
        for date_group in df.partition_by("date", maintain_order=True):
            date_val = str(date_group["date"][0])
            row: dict = {"date": date_val}
            for r in date_group.to_dicts():
                name = r.get("metric_name") or f"metric_{r['metric_id']}"
                row[name] = r["value"]
            metrics_by_date.append(row)

        return jsonify({
            "days": days,
            "metrics": metrics_by_date,
        })

    app.register_blueprint(metrics_bp)
