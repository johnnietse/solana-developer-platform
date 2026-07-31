"""POST /insert endpoint — writes data to S3 (Delta + Parquet).

Usage:
    POST /insert?table_name=dev.mlh.polars_metrics
                [&mode=append|overwrite][&timestamp=true|false]
    Body: {"data": [{"col": "val"}, ...]}

``mode`` defaults to ``append``. Use ``overwrite`` for catalog/dimension
tables that are replaced wholesale (otherwise every call duplicates rows).

``timestamp`` defaults to ``true`` (adds an ``ingested_at`` column). Pass
``false`` to write the payload columns exactly as given.

Writes Delta to ``s3://tmp-sdp-data/dev/mlh/polars_metrics/``
(Databricks: ``SELECT * FROM dev.mlh.polars_metrics``)
"""
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

        # Append by default (fact tables); overwrite for dimension/catalog tables
        # that are replaced wholesale rather than accumulated.
        mode = request.args.get("mode", "append").lower()
        if mode not in ("append", "overwrite"):
            return jsonify({"error": "mode must be 'append' or 'overwrite'"}), 400

        # Convert to Polars DataFrame
        df = pl.DataFrame(records)

        # Add ingested_at timestamp if not present. Pass timestamp=false to
        # store the payload columns verbatim (e.g. a catalog table whose schema
        # is fixed by an upstream spec).
        add_timestamp = request.args.get("timestamp", "true").lower() != "false"
        if add_timestamp and "ingested_at" not in df.columns:
            now = datetime.now(timezone.utc)
            df = df.with_columns(pl.lit(now).alias("ingested_at"))

        # Convert table_name like "dev.mlh.polars_metrics" → S3 path "dev/mlh/polars_metrics/"
        s3_path = table_name.replace(".", "/")

        # Write Delta format (Databricks-readable) to the resolved path
        delta_uri = write_delta(cfg, table_name, df, mode=mode, path=s3_path)

        # Legacy Parquet (under insert/ prefix for backwards compat)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        s3_key = cfg.s3_path_templates["insert"].format(
            table=table_name,
            date=today,
        )
        write_parquet(cfg, s3_key, df)

        return jsonify({
            "status": "ok",
            "table": table_name,
            "mode": mode,
            "rows": len(df),
            "s3_key": delta_uri,
            "delta_path": f"s3://{cfg.s3_bucket}/{s3_path}/",
            "parquet_key": f"s3://{cfg.s3_bucket}/{s3_key}",
        }), 201

    app.register_blueprint(insert_bp)
