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
