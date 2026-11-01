"""Solana RPC client — minimal JSON-RPC over HTTP with fallback support."""

from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from config import Config


def _call_with_url(url: str, method: str, params: list[Any] | None = None, timeout: int = 30) -> dict:
    """Make a JSON-RPC request to a specific Solana RPC endpoint."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000),
        "method": method,
        "params": params or [],
    }).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _call(cfg: Config, method: str, params: list[Any] | None = None) -> dict:
    """Make a JSON-RPC request with automatic fallback to backup RPC.

    Tries primary RPC first; on 429/timeout/5xx/JSON-RPC error, falls back to backup RPC if configured.
    """
    primary_url = cfg.solana_rpc_url
    fallback_url = cfg.solana_rpc_fallback_url

    def _try_url(url: str) -> dict:
        resp = _call_with_url(url, method, params)
        # Check for JSON-RPC error
        if "error" in resp:
            raise ValueError(f"JSON-RPC error: {resp['error']}")
        return resp

    # Try primary
    try:
        return _try_url(primary_url)
    except (urllib.error.HTTPError, ValueError) as e:
        # HTTP 429/5xx or JSON-RPC error
        if fallback_url:
            is_retryable = (
                isinstance(e, urllib.error.HTTPError) and e.code in (429, 500, 502, 503, 504)
            ) or isinstance(e, ValueError)
            if is_retryable:
                print(f"[solana_rpc] Primary RPC error ({type(e).__name__}), trying fallback...")
                return _try_url(fallback_url)
        raise
    except (urllib.error.URLError, TimeoutError) as e:
        if fallback_url:
            print(f"[solana_rpc] Primary RPC error ({type(e).__name__}), trying fallback...")
            return _try_url(fallback_url)
        raise


def get_token_supply(cfg: Config, token_address: str) -> dict | None:
    """Fetch token supply info from the RPC.

    Returns the ``result`` dict or ``None`` on failure.
    """
    try:
        resp = _call(cfg, "getTokenSupply", [token_address])
        return resp.get("result")
    except Exception as exc:
        print(f"[solana_rpc] getTokenSupply failed for {token_address}: {exc}")
        return None


def get_token_accounts(
    cfg: Config, token_address: str, limit: int = 100
) -> list[dict]:
    """Fetch token accounts (holders) for a given mint address.

    Returns a list of account info dicts (up to *limit*).
    """
    result: list[dict] = []
    page_key: str | None = None

    while len(result) < limit:
        params: list[Any] = [token_address, {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}]
        if page_key:
            params[1]["page"] = {"pageKey": page_key}

        resp = _call(cfg, "getProgramAccounts", params)
        accounts = resp.get("result", [])
        if not accounts:
            break

        # Parse each account
        for acc in accounts:
            if len(result) >= limit:
                break
            info = acc.get("account", {})
            parsed = {
                "address": acc.get("pubkey"),
                "owner": info.get("owner"),
                "lamports": info.get("lamports"),
                "data": info.get("data"),
                "executable": info.get("executable"),
            }
            result.append(parsed)

        # Check for next page
        page_key = resp.get("result", {}).get("page", {}).get("nextPageKey")
        if not page_key:
            break

    return result[:limit]


def get_token_largest_accounts(cfg: Config, mint: str) -> list[dict]:
    """Fetch the largest token accounts (top holders) for a given mint.

    Returns a list of dicts sorted by balance descending, each with:
      address, amount, decimals, uiAmount
    """
    try:
        resp = _call(cfg, "getTokenLargestAccounts", [mint])
        value = resp.get("result", {}).get("value", [])
        return value if isinstance(value, list) else []
    except Exception as exc:
        print(f"[solana_rpc] getTokenLargestAccounts failed for {mint}: {exc}")
        return []


def get_signatures_for_address(
    cfg: Config, address: str, limit: int = 100
) -> list[dict]:
    """Fetch recent confirmed signatures for an address.

    Used to get token transfer history for a token mint or owner.
    Returns empty list on RPC errors (rate limits, timeouts, etc.).
    """
    try:
        resp = _call(
            cfg,
            "getSignaturesForAddress",
            [address, {"limit": min(limit, 1000)}],
        )
        return resp.get("result", [])
    except Exception as exc:
        print(f"[solana_rpc] getSignaturesForAddress failed for {address}: {exc}")
        raise


def count_signatures_since(
    cfg: Config,
    address: str,
    days: int,
    include_failed: bool = False,
    page_size: int = 1000,
    max_pages: int = 50,
) -> dict:
    """Count confirmed signatures for *address* over the last *days* days.

    Walks getSignaturesForAddress backwards a page at a time, stopping at the
    first entry older than the cutoff. Answers "how much activity has this mint
    seen" without materialising every transaction, which is what ``/rpc`` does.

    Pagination is capped at *max_pages*: a busy mainnet address can hold
    millions of signatures, and an uncapped walk would hammer the RPC for the
    length of the window. When the cap is hit the count is a floor, not a
    total, so ``complete`` reports which one the caller is holding — returning
    a truncated count as though it were final is the failure this guards.

    Returns a dict with: count, pages, cutoff, complete, scanned.
    """
    cutoff = int(time.time()) - days * 24 * 60 * 60
    before: str | None = None
    total = 0
    scanned = 0
    pages = 0

    while pages < max_pages:
        query: dict[str, Any] = {"limit": min(page_size, 1000)}
        if before:
            query["before"] = before

        resp = _call(cfg, "getSignaturesForAddress", [address, query])
        signatures = resp.get("result", []) or []
        if not signatures:
            return {
                "count": total, "pages": pages, "cutoff": cutoff,
                "complete": True, "scanned": scanned,
            }

        pages += 1
        for entry in signatures:
            scanned += 1
            block_time = entry.get("blockTime")
            # Signatures come back newest-first, so the first one older than the
            # cutoff means every remaining entry is older too.
            if block_time is not None and block_time < cutoff:
                return {
                    "count": total, "pages": pages, "cutoff": cutoff,
                    "complete": True, "scanned": scanned,
                }
            if not include_failed and entry.get("err") is not None:
                continue
            total += 1

        before = signatures[-1]["signature"]
        # A short page means the address has no older signatures to walk.
        if len(signatures) < query["limit"]:
            return {
                "count": total, "pages": pages, "cutoff": cutoff,
                "complete": True, "scanned": scanned,
            }

    return {
        "count": total, "pages": pages, "cutoff": cutoff,
        "complete": False, "scanned": scanned,
    }


def get_transaction(cfg: Config, signature: str) -> dict | None:
    """Fetch a confirmed transaction by signature.
    Returns None on RPC errors (rate limits, timeouts, etc.).
    """
    try:
        resp = _call(
            cfg,
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}],
        )
        return resp.get("result")
    except Exception as exc:
        print(f"[solana_rpc] getTransaction failed for {signature[:16]}...: {exc}")
        return None
