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


def _newest_first(records: list[dict]) -> list[dict]:
    """Order transfers newest-first and drop duplicate signatures.

    "Last N transfers" is only meaningful against a known order, and cached rows
    carry no guaranteed ordering of their own.
    """
    seen: set[str] = set()
    unique: list[dict] = []
    for r in sorted(records, key=lambda r: (r.get("slot") or 0), reverse=True):
        sig = r.get("signature")
        if sig in seen:
            continue
        seen.add(sig)
        unique.append(r)
    return unique


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
        # The spec is "check s3 first, otherwise read from RPC" AND "returns the
        # last 100 transfers". Serving a short cache would satisfy the first and
        # break the second, so the cache is only authoritative when it holds at
        # least `limit` rows; otherwise fall through and top it up from RPC.
        cached_records: list[dict] = []
        df = read_delta(cfg, "rpc_cache")
        if df is not None and "mint" in df.columns:
            cached_records = _newest_first(
                df.filter(pl.col("mint") == token_address).to_dicts()
            )
            if len(cached_records) >= limit:
                return jsonify({
                    "token_address": token_address,
                    "source": "cache",
                    "transfers": cached_records[:limit],
                    "total": len(cached_records),
                    "scanned": None,  # not applicable on the cache path
                    "total_cached": len(cached_records),  # retained for callers
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
            parsed = _parse_transfer(tx, sig["signature"], prefer_mint=token_address)
            if parsed:
                transfers.append(parsed)

        # ── Cache to S3 as Delta (Databricks-readable) ──
        # rpc_cache is append-only, so only write signatures it does not already
        # hold — otherwise every refetch duplicates rows for the same mint.
        known = {r.get("signature") for r in cached_records}
        fresh = [t for t in transfers if t["signature"] not in known]
        if fresh:
            # Caching is best-effort: the caller asked for transfers, so a cache
            # write failure (e.g. schema drift) must not fail the request.
            try:
                write_delta(cfg, "rpc_cache", pl.DataFrame(fresh), mode="append")
            except Exception as exc:
                log.warning("rpc_cache write failed (%s): %s", type(exc).__name__, exc)

        # Merge what we just fetched with anything already cached, newest first.
        merged = _newest_first(transfers + cached_records)

        return jsonify({
            "token_address": token_address,
            "source": "rpc",
            "transfers": merged[:limit],
            "total": len(merged),
            "cached_before": len(cached_records),
            "newly_cached": len(fresh),
            # Signatures reference the address in accountKeys; only some of them
            # actually move tokens. Surfacing both makes an empty result readable.
            "scanned": scanned,
        })

    app.register_blueprint(rpc_bp)


TOKEN_PROGRAM_IDS: set[str] = {
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  # SPL Token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  # Token-2022
}


def _token_change(meta: dict, prefer_mint: str | None = None) -> dict | None:
    """Find the SPL token balance delta in a transaction, or None if there is none.

    Pre/post balances are matched by ``accountIndex``, per the RPC
    json-structures spec: ``owner`` is optional and one owner can hold several
    accounts for the same mint, so matching on owner drops or mismatches rows.

    ``prefer_mint`` is the mint the caller asked about. getSignaturesForAddress
    returns every transaction referencing that address, and such a transaction
    routinely moves several different tokens — so without this the first delta
    in the list wins and the response describes some unrelated token.
    """
    pre_by_index = {
        b.get("accountIndex"): b for b in (meta.get("preTokenBalances") or [])
    }

    posts = meta.get("postTokenBalances") or []
    if prefer_mint:
        posts = sorted(posts, key=lambda p: p.get("mint") != prefer_mint)

    for post in posts:
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


def _parse_transfer(
    tx: dict, signature: str, prefer_mint: str | None = None
) -> dict | None:
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

    token_change = _token_change(meta, prefer_mint=prefer_mint)
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
