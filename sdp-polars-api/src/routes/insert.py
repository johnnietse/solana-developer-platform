"""POST /insert endpoint — writes data to S3 (Delta + Parquet)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import write_parquet, write_delta

if TYPE_CHECKING:
    from config import Config

insert_bp = Blueprint("insert", __name__)


def _register_insert_routes(app):
    """Inject config into the blueprint (called at app init)."""
    cfg: Config = app.config["APP_CFG"]

    @insert_bp.route("/insert", methods=["POST"])
    def insert_data():
        table_name = request.args.get("table_name")
        if not table_name:
            return jsonify({"error": "Missing required query param: table_name"}), 400

        body = request.get_json(silent=True)
        if not body or "data" not in body:
            return jsonify({"error": "Request body must contain a 'data' array"}), 400

        records = body["data"]
        if not isinstance(records, list) or not records:
            return jsonify({"error": "'data' must be a non-empty array of objects"}), 400

        # Convert to Polars DataFrame
        df = pl.DataFrame(records)

        # Add ingested_at timestamp if not present
        if "ingested_at" not in df.columns:
            now = datetime.now(timezone.utc)
            df = df.with_columns(pl.lit(now).alias("ingested_at"))

        # Write Delta format (Databricks-readable)
        delta_uri = write_delta(cfg, table_name, df, mode="append")

        # Legacy Parquet
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        s3_key = cfg.s3_path_templates["insert"].format(
            table=table_name,
            date=today,
        )
        write_parquet(cfg, s3_key, df)

        return jsonify({
            "status": "ok",
            "table": table_name,
            "rows": len(df),
            "s3_key": delta_uri,
            "parquet_key": f"s3://{cfg.s3_bucket}/{s3_key}",
        }), 201

    app.register_blueprint(insert_bp)
