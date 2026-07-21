"""GET /metrics endpoint — reads Solana overview metrics from Delta tables in S3.

Reads from Delta Lake format (``s3://{bucket}/dev/mlh/sdp_data/stablecoins``
and ``s3://{bucket}/dev/mlh/sdp_data/network``) so data is directly queryable
in Databricks with the same source of truth.
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


def _register_metrics_routes(app):
    """Inject config into the blueprint (called at app init)."""
    cfg: Config = app.config["APP_CFG"]

    @metrics_bp.route("/metrics", methods=["GET"])
    def get_metrics():
        days = request.args.get("days", default=cfg.default_metrics_days, type=int)
        days = min(max(days, 1), 365)

        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_str = cutoff.strftime("%Y-%m-%d")

        # ── Read stablecoins data from Delta ───────────────────────────────
        stable_data = []
        stable_table = read_delta(cfg, "stablecoins")
        if stable_table is not None:
            if "date" in stable_table.columns:
                stable_table = stable_table.filter(pl.col("date") >= cutoff_str)
            stable_data = stable_table.sort("date", descending=True).to_dicts()

        # ── Read network data from Delta ───────────────────────────────────
        network_data = []
        network_table = read_delta(cfg, "network")
        if network_table is not None:
            if "date" in network_table.columns:
                network_table = network_table.filter(pl.col("date") >= cutoff_str)
            network_data = network_table.sort("date", descending=True).to_dicts()

        return jsonify({
            "days": days,
            "stablecoins": stable_data,
            "network": network_data,
        })

    app.register_blueprint(metrics_bp)
