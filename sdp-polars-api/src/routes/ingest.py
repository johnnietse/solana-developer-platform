"""GET /ingest/* endpoints — trigger automated data ingestion.

Call these on a schedule (cron, EventBridge, etc.) to keep S3 data fresh.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flask import Blueprint, jsonify

from src.services.databricks_push import push_to_databricks
from src.services.ingestion import (
    ingest_holders,
    ingest_network,
    ingest_stablecoins,
    ingest_validators,
    ingest_whales,
)

if TYPE_CHECKING:
    from config import Config

ingest_bp = Blueprint("ingest", __name__)


def _register_ingest_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @ingest_bp.route("/ingest/stablecoins", methods=["GET"])
    def trigger_stablecoins():
        """Fetch stablecoin supplies from Solana RPC and persist to S3."""
        result = ingest_stablecoins(cfg)
        return jsonify(result), 201 if result["s3_key"] else 200

    @ingest_bp.route("/ingest/network", methods=["GET"])
    def trigger_network():
        """Fetch Solana network metrics from RPC and persist to S3."""
        result = ingest_network(cfg)
        return jsonify(result), 201 if result["s3_key"] else 200

    @ingest_bp.route("/ingest/holders", methods=["GET"])
    def trigger_holders():
        """Fetch top token holders for all stablecoins and persist to S3."""
        result = ingest_holders(cfg)
        return jsonify(result), 201 if result.get("rows", 0) > 0 else 200

    @ingest_bp.route("/ingest/whales", methods=["GET"])
    def trigger_whales():
        """Fetch largest Solana accounts (whales) and persist to S3."""
        result = ingest_whales(cfg)
        return jsonify(result), 201 if result.get("rows", 0) > 0 else 200

    @ingest_bp.route("/ingest/validators", methods=["GET"])
    def trigger_validators():
        """Fetch Solana validator set and persist to S3."""
        result = ingest_validators(cfg)
        return jsonify(result), 201 if result.get("rows", 0) > 0 else 200

    @ingest_bp.route("/ingest/all", methods=["GET"])
    def trigger_all():
        """Run all ingestion tasks + sync to Databricks."""
        stable = ingest_stablecoins(cfg)
        net = ingest_network(cfg)
        holders = ingest_holders(cfg)
        whales = ingest_whales(cfg)
        validators = ingest_validators(cfg)

        # Also push to Databricks if credentials are configured
        db_result = push_to_databricks(cfg)

        any_ok = any(
            r.get("s3_key") or r.get("rows", 0) > 0
            for r in (stable, net, holders, whales, validators)
        )

        return jsonify({
            "stablecoins": stable,
            "network": net,
            "holders": holders,
            "whales": whales,
            "validators": validators,
            "databricks_push": db_result,
        }), 201 if any_ok else 200

    @ingest_bp.route("/ingest/stablecoins", methods=["POST"])
    def trigger_stablecoins_post():
        """POST variant (idempotent)."""
        return trigger_stablecoins()

    @ingest_bp.route("/ingest/all", methods=["POST"])
    def trigger_all_post():
        """POST variant (idempotent)."""
        return trigger_all()

    app.register_blueprint(ingest_bp)
