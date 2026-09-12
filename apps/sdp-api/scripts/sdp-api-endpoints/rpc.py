import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from config import PAGE_SIZE


@dataclass
class Options:
    mint: str
    cluster: str
    days: int
    rpc_url: str
    include_failed: bool


def solana_rpc(rpc_url, method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RPC HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"RPC request failed: {exc.reason}") from exc

    if body.get("error"):
        message = body["error"].get("message", "Unknown RPC error")
        raise RuntimeError(message)

    return body["result"]


def count_recent_transactions(options):
    cutoff = int(time.time()) - options.days * 24 * 60 * 60
    before = None
    total = 0
    pages = 0

    while True:
        query = {"limit": PAGE_SIZE}
        if before:
            query["before"] = before

        signatures = solana_rpc(
            options.rpc_url,
            "getSignaturesForAddress",
            [options.mint, query],
        )

        if not signatures:
            break

        pages += 1

        for entry in signatures:
            block_time = entry.get("blockTime")
            if block_time is not None and block_time < cutoff:
                return total, pages, cutoff

            if not options.include_failed and entry.get("err") is not None:
                continue

            total += 1

        before = signatures[-1]["signature"]

        if len(signatures) < PAGE_SIZE:
            break

    return total, pages, cutoff


def format_timestamp(unix_seconds):
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ── Transfers, with an S3 cache in front of the RPC ────────────────────────
#
# GET /rpc reads the cache first and only calls the RPC for what is missing.
# The cache is the Delta table at s3://tmp-sdp-data/dev/mlh/rpc, written
# through the same insert_delta() that backs POST /insert, so both endpoints
# produce tables Databricks reads the same way.


def fetch_transfers(mint, cluster, rpc_url, limit, include_failed=False):
    """Return the most recent transfers for a mint, newest first.

    One getSignaturesForAddress call per page. A signature against the mint is
    treated as a transfer; resolving each one with getTransaction would give
    exact token amounts but costs an extra RPC round trip per row, which on
    devnet's public endpoint means rate limiting long before 100 rows.
    """
    rows = []
    before = None

    while len(rows) < limit:
        query = {"limit": min(PAGE_SIZE, limit - len(rows))}
        if before:
            query["before"] = before

        signatures = solana_rpc(rpc_url, "getSignaturesForAddress", [mint, query])
        if not signatures:
            break

        for entry in signatures:
            if not include_failed and entry.get("err") is not None:
                continue

            rows.append({
                "mint": mint,
                "cluster": cluster,
                "signature": entry["signature"],
                "slot": entry.get("slot"),
                "block_time": entry.get("blockTime"),
                "failed": entry.get("err") is not None,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            })

            if len(rows) >= limit:
                break

        before = signatures[-1]["signature"]

        if len(signatures) < query["limit"]:
            break

    return rows
