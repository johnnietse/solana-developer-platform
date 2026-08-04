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

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import write_parquet, write_delta

if TYPE_CHECKING:
    from config import Config

log = logging.getLogger(__name__)

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

        if not all(isinstance(r, dict) for r in records):
            return jsonify({"error": "'data' must contain objects, not scalars or arrays"}), 400

        # Append by default (fact tables); overwrite for dimension/catalog tables
        # that are replaced wholesale rather than accumulated.
        mode = request.args.get("mode", "append").lower()
        if mode not in ("append", "overwrite"):
            return jsonify({"error": "mode must be 'append' or 'overwrite'"}), 400

        # Ragged or mixed-type records raise here rather than at write time.
        try:
            df = pl.DataFrame(records)
        except Exception as exc:
            return jsonify({
                "error": "Could not build a table from 'data'",
                "detail": f"{type(exc).__name__}: {exc}",
            }), 400

        # Add ingested_at timestamp if not present. Pass timestamp=false to
        # store the payload columns verbatim (e.g. a catalog table whose schema
        # is fixed by an upstream spec).
        add_timestamp = request.args.get("timestamp", "true").lower() != "false"
        if add_timestamp and "ingested_at" not in df.columns:
            now = datetime.now(timezone.utc)
            df = df.with_columns(pl.lit(now).alias("ingested_at"))

        # Convert table_name like "dev.mlh.polars_metrics" → S3 path "dev/mlh/polars_metrics/"
        s3_path = table_name.replace(".", "/")

        # Write Delta format (Databricks-readable) to the resolved path. This is
        # the deliverable, so a failure here fails the request.
        try:
            delta_uri = write_delta(cfg, table_name, df, mode=mode, path=s3_path)
        except Exception as exc:
            log.exception("Delta write failed for %s", table_name)
            detail = f"{type(exc).__name__}: {exc}"
            # A column-set change on an existing table needs mode=overwrite.
            hint = (
                "Schema differs from the existing table — retry with mode=overwrite"
                if "schema" in detail.lower()
                else None
            )
            return jsonify({
                "error": "Delta write to S3 failed",
                "detail": detail,
                **({"hint": hint} if hint else {}),
                "table": table_name,
                "delta_path": f"s3://{cfg.s3_bucket}/{s3_path}/",
            }), 502

        # Legacy Parquet (under insert/ prefix for backwards compat). Best-effort:
        # the Delta table is what Databricks reads, so this must not fail the call.
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        s3_key = cfg.s3_path_templates["insert"].format(
            table=table_name,
            date=today,
        )
        parquet_key = None
        try:
            write_parquet(cfg, s3_key, df)
            parquet_key = f"s3://{cfg.s3_bucket}/{s3_key}"
        except Exception as exc:
            log.warning("legacy parquet write failed (%s): %s", type(exc).__name__, exc)

        return jsonify({
            "status": "ok",
            "table": table_name,
            "mode": mode,
            "rows": len(df),
            "columns": df.columns,
            "s3_key": delta_uri,
            "delta_path": f"s3://{cfg.s3_bucket}/{s3_path}/",
            "parquet_key": parquet_key,
        }), 201

    app.register_blueprint(insert_bp)
