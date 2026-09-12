"""GET /stablecoins endpoint — reads stablecoin supply history from S3."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import list_snapshot_keys, read_parquet

if TYPE_CHECKING:
    from config import Config

stablecoins_bp = Blueprint("stablecoins", __name__)


def _register_stablecoins_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @stablecoins_bp.route("/stablecoins", methods=["GET"])
    def get_stablecoins():
        days = request.args.get("days", default=cfg.default_metrics_days, type=int)
        days = min(max(days, 1), 365)
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        all_keys = list_snapshot_keys(cfg, "stablecoins")
        frames: list[pl.DataFrame] = []

        for key in sorted(all_keys):
            try:
                df = read_parquet(cfg, key)
                frames.append(df)
            except Exception as exc:
                print(f"[stablecoins] Skipping {key}: {exc}")
                continue

        if not frames:
            return jsonify({"days": days, "rows": 0, "data": []})

        # diagonal_relaxed, not vertical_relaxed: the snapshot schema gained and
        # lost columns across the prefix change, and vertical_ concat requires
        # identical column sets. diagonal_ unions the columns and fills the
        # gaps with null, so an older row simply lacks the newer fields.
        combined = pl.concat(frames, how="diagonal_relaxed")
        if "date" in combined.columns:
            combined = combined.filter(pl.col("date") >= cutoff.strftime("%Y-%m-%d"))

        combined = combined.sort("date", descending=True)

        return jsonify({
            "days": days,
            "rows": len(combined),
            "data": combined.to_dicts(),
        })

    app.register_blueprint(stablecoins_bp)
