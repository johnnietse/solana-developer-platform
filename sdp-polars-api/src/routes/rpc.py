"""GET /rpc endpoint — parses token data from Solana RPC with S3 caching."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import read_delta, write_delta, list_keys
from src.services.solana_rpc import get_signatures_for_address, get_transaction

if TYPE_CHECKING:
    from config import Config

log = logging.getLogger(__name__)

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

        # ── Check S3 cache (Delta) first ──
        df = read_delta(cfg, "rpc_cache")
        if df is not None and "mint" in df.columns:
            cached = df.filter(pl.col("mint") == token_address)
            if not cached.is_empty():
                records = cached.to_dicts()
                return jsonify({
                    "token_address": token_address,
                    "source": "cache",
                    "transfers": records[:limit],
                    "total": len(records),
                    "scanned": None,  # not applicable on the cache path
                    "total_cached": len(records),  # retained for existing callers
                })

        # ── Fetch from RPC ──
        try:
            signatures = get_signatures_for_address(cfg, token_address, limit=limit)
        except Exception as exc:
            log.exception("getSignaturesForAddress failed for %s", token_address)
            return jsonify({
                "error": "Solana RPC request failed",
                "detail": f"{type(exc).__name__}: {exc}",
                "token_address": token_address,
                "rpc_url": cfg.solana_rpc_url,
            }), 502

        transfers: list[dict] = []
        scanned = 0

        for sig in signatures:
            try:
                tx = get_transaction(cfg, sig["signature"])
            except Exception as exc:
                # One bad signature should not sink the whole batch.
                log.warning("getTransaction failed for %s: %s", sig.get("signature"), exc)
                continue
            if not tx:
                continue

            scanned += 1
            parsed = _parse_transfer(tx, sig["signature"])
            if parsed:
                transfers.append(parsed)

        # ── Cache to S3 as Delta (Databricks-readable) ──
        if transfers:
            # Caching is best-effort: the caller asked for transfers, so a cache
            # write failure (e.g. schema drift) must not fail the request.
            try:
                write_delta(cfg, "rpc_cache", pl.DataFrame(transfers), mode="append")
            except Exception as exc:
                log.warning("rpc_cache write failed (%s): %s", type(exc).__name__, exc)

        return jsonify({
            "token_address": token_address,
            "source": "rpc",
            "transfers": transfers[:limit],
            "total": len(transfers),
            # Signatures reference the address in accountKeys; only some of them
            # actually move tokens. Surfacing both makes an empty result readable.
            "scanned": scanned,
        })

    app.register_blueprint(rpc_bp)


TOKEN_PROGRAM_IDS: set[str] = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # SPL Token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # Token-2022
}


def _token_change(meta: dict) -> dict | None:
    """Find the SPL token balance delta in a transaction, or None if there is none.

    Pre/post balances are matched by ``accountIndex``, per the RPC
    json-structures spec: ``owner`` is optional and one owner can hold several
    accounts for the same mint, so matching on owner drops or mismatches rows.
    """
    pre_by_index = {
        b.get("accountIndex"): b for b in (meta.get("preTokenBalances") or [])
    }

    for post in meta.get("postTokenBalances") or []:
        pre = pre_by_index.get(post.get("accountIndex"))
        if pre is None or pre.get("mint") != post.get("mint"):
            continue

        # programId is optional; only reject when it is present and not a token program.
        program_id = post.get("programId") or pre.get("programId")
        if program_id and program_id not in TOKEN_PROGRAM_IDS:
            continue

        post_amount = int(post.get("uiTokenAmount", {}).get("amount") or 0)
        pre_amount = int(pre.get("uiTokenAmount", {}).get("amount") or 0)
        change = post_amount - pre_amount
        if change == 0:
            continue

        decimals = post.get("uiTokenAmount", {}).get("decimals", 0) or 0
        # Keys here become a nested struct in the rpc_cache Delta table — adding
        # one breaks appends against existing data, so keep this shape stable.
        return {
            "mint": post.get("mint", ""),
            "owner": post.get("owner") or pre.get("owner") or "",
            "change": abs(change),
            # uiAmount is deprecated and may be null — derive from the raw amount.
            "ui_change": abs(change) / (10**decimals) if decimals else float(abs(change)),
            "decimals": decimals,
        }

    return None


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

    token_change = _token_change(meta)
    if token_change is None:
        # Not an SPL token transfer — the address appeared in accountKeys but no
        # token balance moved. Callers asked for transfers, so drop it.
        return None

    return {
        "signature": signature,
        "mint": (token_change or {}).get("mint", ""),
        "owner": (token_change or {}).get("owner", ""),
        "change": (token_change or {}).get("change", 0),
        "ui_change": (token_change or {}).get("ui_change", 0),
        "decimals": (token_change or {}).get("decimals", 0),
        "slot": slot,
        "block_time": block_time,
        "fee": fee,
        "token_transfer": token_change,
        "account_keys": account_keys,
        "pre_balances": pre_balances,
        "post_balances": post_balances,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }
