"""Automated Solana data ingestion — fetches on-chain data and writes to S3 as Parquet.

Designed to be called on a schedule (cron, EventBridge, Cloudflare cron, etc.)
Every run takes a snapshot of the current on-chain state and appends it to S3.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import polars as pl

from src.services.s3_service import key_exists, read_parquet, write_parquet, write_delta
from src.services.solana_rpc import _call, _call_with_url

if TYPE_CHECKING:
    from config import Config


def _get_rpc_urls(cfg: Config) -> list[str]:
    """Build the ordered list of RPC URLs to try for a given method.

    Priority order:
      1. Primary URL (``solana_rpc_url``)
      2. Fallback URL (``solana_rpc_fallback_url``), if configured
      3. Extra URLs from ``solana_rpc_urls`` config setting

    Duplicate URLs are removed so each endpoint is only tried once.
    """
    seen: set[str] = set()
    urls: list[str] = []

    def _add(u: str) -> None:
        if u and u not in seen:
            seen.add(u)
            urls.append(u)

    _add(cfg.solana_rpc_url)

    fallback = getattr(cfg, "solana_rpc_fallback_url", None)
    if fallback:
        _add(fallback)

    extra = getattr(cfg, "solana_rpc_urls", None)
    if extra:
        for u in extra:
            _add(u)

    return urls


def _call_with_retry(
    cfg: Config,
    method: str,
    params: list | None = None,
    *,
    max_retries: int | None = None,
    base_delay: float | None = None,
) -> dict:
    """Call the Solana RPC with multi-URL rotation + retry/backoff on rate limits.

    When one RPC endpoint returns a rate-limit (429 / 403), the function
    moves to the next URL in the configured list, giving us multiple rate-limit
    budgets to work with.  For each URL the standard exponential backoff is
    applied before giving up on that endpoint.

    Non-rate-limit errors (connection refused, timeout, bad request, etc.)
    are raised immediately — they won't benefit from a different endpoint.

    Parameters
    ----------
    max_retries
        Per-URL retry count (defaults to ``cfg.rpc_max_retries``).
        Use a higher value for methods that are aggressively rate-limited
        on public endpoints (e.g. ``getLargestAccounts``).
    base_delay
        Initial backoff delay in seconds (defaults to ``cfg.rpc_retry_delay_seconds``).
        Doubles on each retry up to 60 s.
    """
    urls = _get_rpc_urls(cfg)
    max_retries = max_retries if max_retries is not None else getattr(cfg, "rpc_max_retries", 3)
    base_delay = base_delay if base_delay is not None else getattr(cfg, "rpc_retry_delay_seconds", 1.0)
    timeout = getattr(cfg, "rpc_timeout", 30)
    last_exc: Exception | None = None

    for url_idx, url in enumerate(urls):
        delay = base_delay
        for attempt in range(max_retries + 1):
            try:
                return _call_with_url(url, method, params, timeout)
            except Exception as exc:
                last_exc = exc
                msg = str(exc)
                # Only rotate/retry on rate-limit errors; bail immediately on others
                is_rate_limit = "429" in msg or "Too Many Requests" in msg or "403" in msg
                if not is_rate_limit:
                    raise
                if attempt >= max_retries:
                    host = url.split("/")[2] if "//" in url else url
                    print(
                        f"[ingestion] {method} rate-limited on URL#{url_idx} "
                        f"({host}) — exhausted retries, trying next endpoint"
                    )
                    break  # Move to next URL
                host = url.split("/")[2] if "//" in url else url
                print(
                    f"[ingestion] {method} rate-limited on URL#{url_idx} "
                    f"({host}, attempt {attempt + 1}/{max_retries + 1}), "
                    f"retrying in {delay:.1f}s"
                )
                time.sleep(delay)
                delay = min(delay * 1.5, 60.0)

    msg = (
        f"{method} failed after {len(urls)} URL(s), "
        f"{max_retries + 1} attempt(s) each"
    )
    raise last_exc if last_exc else RuntimeError(msg)


def _sol_rpc_call(cfg: Config, method: str, params: list | None = None) -> dict:
    """Thin wrapper around solana_rpc._call using the Polars API's own RPC URL."""
    from src.services.solana_rpc import _call as rpc_call

    return rpc_call(cfg, method, params)


# ── Stablecoin snapshot ────────────────────────────────────────────────────


def fetch_stablecoin_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch supply for all discovered SPL token mints.

    Uses dynamic on-chain discovery via getProgramAccounts.
    Falls back to empty DataFrame on error.
    """
    from src.services.token_discovery import discover_token_mints, resolve_token_symbol

    if cfg.token_discovery_enabled:
        mints = discover_token_mints(cfg)
    else:
        mints = []

    if not mints:
        return pl.DataFrame({
            "date": [],
            "mint": [],
            "symbol": [],
            "supply": [],
            "decimals": [],
            "ui_supply": [],
            "scraped_at": [],
        })

    records = []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).isoformat()

    for mint_info in mints:
        try:
            resp = _call(cfg, "getTokenSupply", [mint_info["mint"]])
            result = resp.get("result", {}).get("value", {})
            supply = int(result.get("amount", "0"))
            decimals = result.get("decimals", mint_info["decimals"])
            ui_supply = float(result.get("uiAmountString", "0"))
        except Exception as exc:
            print(f"[ingestion] getTokenSupply failed for {mint_info['mint'][:8]}...: {exc}")
            supply = int(mint_info["supply"])
            decimals = mint_info["decimals"]
            ui_supply = float(supply) / (10 ** decimals) if decimals else float(supply)

        symbol = resolve_token_symbol(cfg, mint_info["mint"])
        records.append({
            "date": today,
            "mint": mint_info["mint"],
            "symbol": symbol,
            "supply": supply,
            "decimals": decimals,
            "ui_supply": ui_supply,
            "scraped_at": now_iso,
        })

    print(f"[ingestion] Stablecoin snapshot: {len(records)} tokens")
    return pl.DataFrame(records)


# ── Network snapshot ───────────────────────────────────────────────────────


def fetch_network_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch current Solana network-level metrics.

    Returns a single-row DataFrame with fields:
      date, total_sol_supply, circulating_sol_supply,
      tps, transaction_count, inflation_rate, epoch, slot, scraped_at
    """
    now = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    row: dict[str, Any] = {"date": today, "scraped_at": now.isoformat()}

    # getSupply
    try:
        supply = _sol_rpc_call(cfg, "getSupply", [{"commitment": "finalized"}])
        if supply and "result" in supply:
            value = supply["result"]["value"]
            row["total_sol_supply"] = int(value.get("total", 0)) / 1e9
            row["circulating_sol_supply"] = int(value.get("circulating", 0)) / 1e9
            row["non_circulating_sol_supply"] = int(value.get("nonCirculating", 0)) / 1e9
    except Exception as exc:
        print(f"[ingestion] getSupply failed: {exc}")

    # getRecentPerformanceSamples (for TPS)
    try:
        perf = _sol_rpc_call(cfg, "getRecentPerformanceSamples", [1])
        if perf and "result" in perf and perf["result"]:
            sample = perf["result"][0]
            slot_count = sample.get("numSlots", 1)
            tx_count = sample.get("numTransactions", 0)
            sample_period_secs = sample.get("samplePeriodSecs", 1)
            row["tps"] = round(
                tx_count / max(sample_period_secs, 1), 2
            ) if sample_period_secs else 0
            row["slot"] = sample.get("slot", 0)
    except Exception as exc:
        print(f"[ingestion] getRecentPerformanceSamples failed: {exc}")

    # getTransactionCount
    try:
        tx_count = _sol_rpc_call(cfg, "getTransactionCount")
        if tx_count and "result" in tx_count:
            row["transaction_count"] = tx_count["result"]
    except Exception as exc:
        print(f"[ingestion] getTransactionCount failed: {exc}")

    # getInflationRate
    try:
        infl = _sol_rpc_call(cfg, "getInflationRate")
        if infl and "result" in infl:
            row["inflation_rate"] = round(infl["result"].get("total", 0) * 100, 4)
    except Exception as exc:
        print(f"[ingestion] getInflationRate failed: {exc}")

    # getEpochInfo
    try:
        epoch = _sol_rpc_call(cfg, "getEpochInfo")
        if epoch and "result" in epoch:
            row["epoch"] = epoch["result"].get("epoch", 0)
            if "slot" not in row:
                row["slot"] = epoch["result"].get("absoluteSlot", 0)
    except Exception as exc:
        print(f"[ingestion] getEpochInfo failed: {exc}")

    return pl.DataFrame([row])


def fetch_holders_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch top 20 holders for all discovered token mints.

    Strategy (tried in order):
      1. RPC ``getTokenLargestAccounts`` (with retry + URL rotation) — works
         on mainnet or with a capable devnet RPC.
      2. WebSocket holder accumulator — real-time fallback populated by
         ``programSubscribe`` in ``ws_ingestion.py``.  Requires the WS to
         have been running long enough to observe transfers for our tokens.
    """
    from src.services.token_discovery import discover_token_mints

    mints = discover_token_mints(cfg)
    now_iso = datetime.now(timezone.utc).isoformat()

    # ── 1. Try RPC ──────────────────────────────────────────────────────
    records: list[dict[str, Any]] = []
    for mint_info in mints[:50]:
        try:
            resp = _call_with_retry(
                cfg, "getTokenLargestAccounts", [mint_info["mint"]],
                max_retries=2, base_delay=2.0,
            )
            holders = resp.get("result", {}).get("value", [])
            for i, h in enumerate(holders):
                records.append({
                    "mint": mint_info["mint"],
                    "holder_address": h.get("address", ""),
                    "amount": int(h.get("amount", "0")),
                    "decimals": h.get("decimals", 0),
                    "ui_amount": float(h.get("uiAmount", 0) or 0),
                    "rank": i + 1,
                    "scraped_at": now_iso,
                })
        except Exception as exc:
            print(f"[ingestion] getTokenLargestAccounts failed for {mint_info['mint'][:8]}...: {exc}")
            continue

    # ── 2. Fallback: WebSocket accumulator ──────────────────────────────
    if not records:
        from src.services.ws_ingestion import snapshot_holders

        target_mints = {m["mint"] for m in mints}
        ws_df = snapshot_holders(target_mints)
        if ws_df.is_empty():
            # No data for our specific mints — return whatever the WS has
            # (real on-chain holder activity for tokens active on this network)
            ws_df = snapshot_holders(None)

        if not ws_df.is_empty():
            records = ws_df.to_dicts()
            print(f"[ingestion] Holders snapshot (WebSocket): {len(records)} records")
            return ws_df

    print(f"[ingestion] Holders snapshot: {len(records)} records")
    return pl.DataFrame(records) if records else pl.DataFrame()


def fetch_whales_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch the 20 largest SOL accounts (whales).

    Strategy (tried in order):
      1. RPC ``getLargestAccounts`` — works on mainnet or with a capable RPC.
      2. Validator stake proxy — uses ``getVoteAccounts`` validator stake
         amounts as a stand-in for large SOL holders.  Validators with
         large stakes are real SOL whales on the network.
    """
    from src.services.solana_rpc import _call as rpc_call

    now_iso = datetime.now(timezone.utc).isoformat()

    # ── 1. Try RPC ──────────────────────────────────────────────────────
    try:
        resp = _call_with_retry(
            cfg, "getLargestAccounts", [],
            max_retries=2, base_delay=2.0,
        )
        accounts = resp.get("result", {}).get("value", [])
        if accounts:
            records = [
                {
                    "address": a.get("address", ""),
                    "lamports": int(a.get("lamports", "0")),
                    "ui_balance": float(a.get("lamports", "0")) / 1e9,
                    "rank": i + 1,
                    "scraped_at": now_iso,
                    "source": "rpc",
                }
                for i, a in enumerate(accounts)
            ]
            print(f"[ingestion] Whales snapshot (RPC): {len(records)} records")
            return pl.DataFrame(records)
    except Exception as exc:
        print(f"[ingestion] getLargestAccounts failed: {exc}")

    # ── 2. Fallback: validator stake proxy ──────────────────────────────
    try:
        resp = rpc_call(cfg, "getVoteAccounts", [])
        result = resp.get("result", {})
        current = result.get("current", [])
        records = [
            {
                "address": v.get("nodePubkey", ""),
                "lamports": int(v.get("activatedStake", "0")),
                "ui_balance": int(v.get("activatedStake", "0")) / 1e9,
                "rank": i + 1,
                "scraped_at": now_iso,
                "source": "validators",
            }
            for i, v in enumerate(
                sorted(current, key=lambda x: int(x.get("activatedStake", "0")), reverse=True)[:20]
            )
        ]
        if records:
            print(f"[ingestion] Whales snapshot (validator proxy): {len(records)} records")
            return pl.DataFrame(records)
    except Exception as exc:
        print(f"[ingestion] Whales validator proxy failed: {exc}")

    return pl.DataFrame()


def fetch_validators_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch current and delinquent validators."""
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        resp = _call(cfg, "getVoteAccounts", [])
        result = resp.get("result", {})
        records = []
        for status, accounts in [("current", result.get("current", [])), ("delinquent", result.get("delinquent", []))]:
            for i, v in enumerate(accounts):
                records.append({
                    "status": status,
                    "vote_address": v.get("votePubkey", ""),
                    "node_pubkey": v.get("nodePubkey", ""),
                    "activated_stake": int(v.get("activatedStake", "0")),
                    "commission": v.get("commission", 0),
                    "epoch_vote_account": v.get("epochVoteAccount", False),
                    "root_slot": int(v.get("rootSlot", 0)),
                    "last_vote": int(v.get("lastVote", 0)),
                    "rank": i + 1,
                    "scraped_at": now_iso,
                })
        print(f"[ingestion] Validators snapshot: {len(records)} records")
        return pl.DataFrame(records)
    except Exception as exc:
        print(f"[ingestion] getVoteAccounts failed: {exc}")
        return pl.DataFrame()


# ── S3 persistence (Delta Lake — readable by Databricks) ─────────────────


def _append_to_delta(cfg: Config, table_name: str, df: pl.DataFrame) -> str:
    """Append a snapshot DataFrame to a Delta Lake table on S3.

    Data lands at ``s3://{bucket}/dev/mlh/sdp_data/{table_name}/``.

    Databricks can query it as::

        SELECT * FROM delta.'s3://{bucket}/dev/mlh/sdp_data/{table_name}'

    On schema mismatch (e.g. after a code change), the table is overwritten
    to reset the schema. This is safe because we always have the full
    snapshot in the legacy Parquet files.
    """
    try:
        delta_uri = write_delta(cfg, table_name, df, mode="append")
    except Exception as exc:
        # Schema mismatch — overwrite with current schema
        print(f"[ingestion] Delta append failed ({exc}), overwriting schema...")
        delta_uri = write_delta(cfg, table_name, df, mode="overwrite")
    return delta_uri


def _append_to_s3(cfg: Config, prefix: str, df: pl.DataFrame) -> str:
    """Legacy: append a snapshot DataFrame to S3 as Parquet (kept for backwards compat)."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    s3_key = f"{prefix}/{today}.parquet"

    if key_exists(cfg, s3_key):
        existing = read_parquet(cfg, s3_key)
        combined = pl.concat([existing, df], how="vertical_relaxed")
        if "scraped_at" in combined.columns:
            combined = combined.sort("scraped_at", descending=True).unique(
                subset=[c for c in combined.columns if c != "scraped_at"],
                keep="first",
            )
    else:
        combined = df

    write_parquet(cfg, s3_key, combined)
    return f"s3://{cfg.s3_bucket}/{s3_key}"


# ── Public API ─────────────────────────────────────────────────────────────


def ingest_stablecoins(cfg: Config) -> dict:
    """Fetch stablecoin snapshot and persist to S3 (Delta + Parquet).

    Returns a summary dict with keys: status, table, rows, s3_key.
    """
    df = fetch_stablecoin_snapshot(cfg)
    if df.is_empty():
        return {"status": "ok", "table": "stablecoins", "rows": 0, "s3_key": None}

    # Write Delta format (Databricks-readable)
    delta_key = _append_to_delta(cfg, "stablecoins", df)
    # Legacy Parquet (backwards compat)
    _append_to_s3(cfg, "insert/stablecoins", df)

    return {
        "status": "ok",
        "table": "stablecoins",
        "rows": len(df),
        "s3_key": delta_key,
    }


def ingest_network(cfg: Config) -> dict:
    """Fetch network snapshot and persist to S3 (Delta + Parquet).

    Returns a summary dict with keys: status, table, rows, s3_key.
    """
    df = fetch_network_snapshot(cfg)
    if df.is_empty():
        return {"status": "ok", "table": "network", "rows": 0, "s3_key": None}

    # Write Delta format (Databricks-readable)
    delta_key = _append_to_delta(cfg, "network", df)
    # Legacy Parquet (backwards compat)
    _append_to_s3(cfg, "insert/network", df)

    return {
        "status": "ok",
        "table": "network",
        "rows": len(df),
        "s3_key": delta_key,
    }


def ingest_holders(cfg: Config) -> dict:
    """Fetch and persist token holder data."""
    if not cfg.holders_ingestion_enabled:
        return {"status": "disabled"}
    df = fetch_holders_snapshot(cfg)
    if df.is_empty():
        return {"status": "ok", "rows": 0, "table": "holders"}
    delta_uri = _append_to_delta(cfg, "holders", df)
    return {"status": "ok", "rows": len(df), "table": "holders", "uri": delta_uri}


def ingest_whales(cfg: Config) -> dict:
    """Fetch and persist SOL whale data."""
    if not cfg.whales_ingestion_enabled:
        return {"status": "disabled"}
    df = fetch_whales_snapshot(cfg)
    if df.is_empty():
        return {"status": "ok", "rows": 0, "table": "whales"}
    delta_uri = _append_to_delta(cfg, "whales", df)
    return {"status": "ok", "rows": len(df), "table": "whales", "uri": delta_uri}


def ingest_validators(cfg: Config) -> dict:
    """Fetch and persist validator data."""
    if not cfg.validators_ingestion_enabled:
        return {"status": "disabled"}
    df = fetch_validators_snapshot(cfg)
    if df.is_empty():
        return {"status": "ok", "rows": 0, "table": "validators"}
    delta_uri = _append_to_delta(cfg, "validators", df)
    return {"status": "ok", "rows": len(df), "table": "validators", "uri": delta_uri}
