"""GET /network endpoint — reads Solana network metrics history from S3."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import list_keys, read_parquet

if TYPE_CHECKING:
    from config import Config

network_bp = Blueprint("network", __name__)


def _register_network_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @network_bp.route("/network", methods=["GET"])
    def get_network():
        days = request.args.get("days", default=cfg.default_metrics_days, type=int)
        days = min(max(days, 1), 365)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        all_keys = [k for k in list_keys(cfg, "network") if k.endswith(".parquet")]
        frames: list[pl.DataFrame] = []

        for key in sorted(all_keys):
            try:
                df = read_parquet(cfg, key)
                frames.append(df)
            except Exception as exc:
                print(f"[network] Skipping {key}: {exc}")
                continue

        if not frames:
            return jsonify({"days": days, "rows": 0, "data": []})

        combined = pl.concat(frames, how="vertical_relaxed")
        if "date" in combined.columns:
            combined = combined.filter(pl.col("date") >= cutoff.strftime("%Y-%m-%d"))

        combined = combined.sort("date", descending=True)

        return jsonify({
            "days": days,
            "rows": len(combined),
            "data": combined.to_dicts(),
        })

    app.register_blueprint(network_bp)
