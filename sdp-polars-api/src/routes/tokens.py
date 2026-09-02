"""GET /tokens endpoint — token registry with stable UUIDs.

Part of the "Create token-uuid" scope item — provides stable identifiers
for all tracked tokens that can be used across systems (Databricks, APIs,
dashboard).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from flask import Blueprint, jsonify, request

from src.services.token_registry import get_all_tokens, get_token_by_uuid, register_token

if TYPE_CHECKING:
    from config import Config

tokens_bp = Blueprint("tokens", __name__)


def _register_tokens_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @tokens_bp.route("/tokens", methods=["GET"])
    def list_tokens():
        """List all registered tokens with their UUIDs, mints, and metadata."""
        tokens = get_all_tokens(cfg)
        return jsonify({
            "count": len(tokens),
            "tokens": tokens,
        })

    @tokens_bp.route("/tokens/<token_uuid>", methods=["GET"])
    def get_token(token_uuid):
        """Look up a token by its UUID."""
        token = get_token_by_uuid(cfg, token_uuid)
        if not token:
            return jsonify({"error": "Token not found"}), 404
        return jsonify(token)

    @tokens_bp.route("/tokens/register", methods=["POST"])
    def register_new_token():
        """Register a new token with a deterministic UUID."""
        body = request.get_json(silent=True)
        if not body:
            return jsonify({"error": "Request body required"}), 400

        mint = body.get("mint")
        symbol = body.get("symbol")
        if not mint or not symbol:
            return jsonify({"error": "Fields 'mint' and 'symbol' are required"}), 400

        token = register_token(
            cfg,
            mint=mint,
            symbol=symbol,
            name=body.get("name", ""),
            network=body.get("network", "devnet"),
            decimals=body.get("decimals", 6),
        )
        return jsonify(token), 201

    app.register_blueprint(tokens_bp)
