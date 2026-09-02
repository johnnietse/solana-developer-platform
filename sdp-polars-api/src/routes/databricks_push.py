"""GET /push-to-databricks endpoint — bridge S3 data → Databricks.

Triggers a push of the latest S3 stablecoin data into the Databricks
analytics tables (token_supply_snapshots, analytics_cache) so the SDP
API can serve fresh data from its ``/v1/data-products/analytics`` endpoint.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flask import Blueprint, jsonify

from src.services.databricks_push import push_to_databricks

if TYPE_CHECKING:
    from config import Config

push_bp = Blueprint("databricks_push", __name__)


def _register_databricks_push_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @push_bp.route("/push-to-databricks", methods=["GET"])
    def get_push_to_databricks():
        """Push S3 stablecoin data to Databricks analytics tables.

        This bridges the gap between the Polars ingestion pipeline and the
        Databricks-backed SDP API analytics endpoint.

        Returns a summary of what was pushed.
        """
        result = push_to_databricks(cfg)
        return jsonify(result)

    app.register_blueprint(push_bp)
