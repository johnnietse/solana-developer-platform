"""GET /rpc endpoint — parses token data from Solana RPC with S3 caching."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import key_exists, read_parquet, write_parquet
from src.services.solana_rpc import get_signatures_for_address, get_transaction

if TYPE_CHECKING:
    from config import Config

rpc_bp = Blueprint("rpc", __name__)


def _register_rpc_routes(app):
    """Inject config into the blueprint (called at app init)."""
    cfg: Config = app.config["APP_CFG"]

    @rpc_bp.route("/rpc", methods=["GET"])
    def get_rpc_data():
        token_address = request.args.get("token_address")
        if not token_address:
            return jsonify({"error": "Missing required query param: token_address"}), 400

        limit = request.args.get("limit", default=cfg.default_transfer_limit, type=int)
        limit = min(max(limit, 1), 1000)

        s3_key = cfg.s3_path_templates["rpc-cache"].format(
            token_address=token_address,
        )

        # ── Check S3 cache first ──
        if key_exists(cfg, s3_key):
            df = read_parquet(cfg, s3_key)
            records = df.to_dicts()
            return jsonify({
                "token_address": token_address,
                "source": "cache",
                "transfers": records[:limit],
                "total_cached": len(records),
            })

        # ── Fetch from RPC ──
        signatures = get_signatures_for_address(cfg, token_address, limit=limit)
        transfers: list[dict] = []

        for sig in signatures:
            tx = get_transaction(cfg, sig["signature"])
            if not tx:
                continue

            parsed = _parse_transfer(tx, sig["signature"])
            if parsed:
                transfers.append(parsed)

        # ── Cache to S3 ──
        if transfers:
            df = pl.DataFrame(transfers)
            write_parquet(cfg, s3_key, df)

        return jsonify({
            "token_address": token_address,
            "source": "rpc",
            "transfers": transfers[:limit],
            "total": len(transfers),
        })

    app.register_blueprint(rpc_bp)


def _parse_transfer(tx: dict, signature: str) -> dict | None:
    """Extract transfer info from a Solana transaction.

    Returns a dict with standardised fields, or None if not a transfer.
    """
    meta = tx.get("meta", {}) or {}
    tx_data = tx.get("transaction", {})
    message = tx_data.get("message", {})

    # Get slot and block time
    slot = tx.get("slot", 0)
    block_time = tx.get("blockTime")

    # Parse instructions looking for Token program transfers
    instructions = []
    for inner_ix_group in meta.get("innerInstructions", []):
        instructions.extend(inner_ix_group.get("instructions", []))

    # Also check top-level instructions
    instructions.extend(message.get("instructions", []))

    pre_balances = meta.get("preBalances", [])
    post_balances = meta.get("postBalances", [])
    fee = meta.get("fee", 0)

    # Get accounts from the message
    account_keys = message.get("accountKeys", [])

    # Try to find the transfer amount from postTokenBalances
    post_token_balances = meta.get("postTokenBalances", [])
    pre_token_balances = meta.get("preTokenBalances", [])
    token_change = None

    if post_token_balances and pre_token_balances:
        for post in post_token_balances:
            mint = post.get("mint", "")
            owner = post.get("owner", "")
            post_amount = int(post.get("uiTokenAmount", {}).get("amount", "0"))

            # Find matching pre balance
            for pre in pre_token_balances:
                if pre.get("mint") == mint and pre.get("owner") == owner:
                    pre_amount = int(pre.get("uiTokenAmount", {}).get("amount", "0"))
                    change = post_amount - pre_amount
                    if change != 0:
                        post_ui = post.get("uiTokenAmount", {}).get("uiAmount") or 0
                        pre_ui = pre.get("uiTokenAmount", {}).get("uiAmount") or 0
                        token_change = {
                            "mint": mint,
                            "owner": owner,
                            "change": abs(change),
                            "ui_change": abs(float(post_ui) - float(pre_ui)),
                            "decimals": post.get("uiTokenAmount", {}).get("decimals", 0),
                        }
                        break
            if token_change:
                break

    return {
        "signature": signature,
        "slot": slot,
        "block_time": block_time,
        "fee": fee,
        "token_transfer": token_change,
        "account_keys": account_keys,
        "pre_balances": pre_balances,
        "post_balances": post_balances,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }
