"""Bridge: Push S3 Parquet data → Databricks tables.

This bridges the gap between the Polars ingestion pipeline (RPC → S3) and
the Databricks-backed analytics that the SDP API reads from.

After each ingestion run, call ``push_to_databricks(cfg)`` to mirror the
latest S3 snapshots into the Databricks tables the SDP API's
``/v1/data-products/analytics`` endpoint queries.

Tables updated:
  - token_supply_snapshots  — append new rows
  - analytics_cache          — upsert latest aggregated snapshot
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import polars as pl
from src.services.s3_service import list_keys, read_parquet
from src.services.token_registry import get_all_tokens

if TYPE_CHECKING:
    from config import Config


# ── Databricks REST client ─────────────────────────────────────────────


def _db_execute(
    host: str,
    token: str,
    warehouse_id: str,
    statement: str,
    catalog: str = "workspace",
    schema: str = "default",
    wait: bool = True,
) -> dict | None:
    """Execute a SQL statement via the Databricks Statement Execution API.

    Returns the response dict on success, or None on failure.
    """
    import urllib.request
    import urllib.error

    url = f"https://{host}/api/2.0/sql/statements"
    body = json.dumps({
        "statement": statement,
        "warehouse_id": warehouse_id,
        "catalog": catalog,
        "schema": schema,
        "wait_timeout": "30s" if wait else "0s",
        "format": "JSON_ARRAY",
    }).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"[databricks_push] HTTP {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        print(f"[databricks_push] Request failed: {e}")
        return None


# ── Parsers ─────────────────────────────────────────────────────────────


def _parse_mints(cfg: Config) -> dict[str, str]:
    """Same mint list as ingestion.py."""
    from src.services.ingestion import _parse_mints as _im

    return _im(cfg)


# ── Token supply snapshots ──────────────────────────────────────────────


def _latest_delta_file(cfg: Config, delta_prefix: str) -> str | None:
    """Get the most recent Delta Parquet file by LastModified timestamp.

    Reads the Delta transaction log (``_delta_log/``) to find files, then
    returns the one most recently added.
    """
    from src.services.s3_service import _client

    s3 = _client(cfg)
    paginator = s3.get_paginator("list_objects_v2")
    latest: str | None = None
    latest_ts: float = 0

    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=delta_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(".snappy.parquet"):
                ts = obj["LastModified"].timestamp() if obj.get("LastModified") else 0
                if ts > latest_ts:
                    latest_ts = ts
                    latest = key

    return latest

_DB_TABLES_INITIALIZED = False
_DB_CATALOG: str = "workspace"
_DB_SCHEMA: str = "default"


def _discover_catalog(host: str, token: str, warehouse_id: str) -> bool:
    """Discover the default catalog and schema for this workspace."""
    global _DB_CATALOG, _DB_SCHEMA

    resp = _db_execute(host, token, warehouse_id, "SELECT CURRENT_CATALOG() AS cat, CURRENT_SCHEMA() AS sch")
    if resp:
        data = resp.get("result", {}).get("data_array", [])
        if data and len(data[0]) >= 2:
            _DB_CATALOG = str(data[0][0])
            _DB_SCHEMA = str(data[0][1])
            print(f"[databricks_push] Discovered catalog={_DB_CATALOG}, schema={_DB_SCHEMA}")
            return True
    return False


def _ensure_tables(host: str, token: str, warehouse_id: str) -> bool:
    """Attempt to create Databricks tables. May fail due to metastore permissions."""
    global _DB_TABLES_INITIALIZED
    if _DB_TABLES_INITIALIZED:
        return True

    if not _discover_catalog(host, token, warehouse_id):
        print(f"[databricks_push] Could not discover catalog")
        return False

    # Try to list existing catalogs to find a writable one
    resp = _db_execute(host, token, warehouse_id, "SHOW CATALOGS")
    if resp:
        data = resp.get("result", {}).get("data_array", [])
        if data:
            catalogs = [row[0] for row in data]
            print(f"[databricks_push] Available catalogs: {catalogs}")

    cat = _DB_CATALOG
    sch = _DB_SCHEMA

    ddl_statements = [
        # f"CREATE SCHEMA IF NOT EXISTS {cat}.{sch}",
        f"CREATE TABLE IF NOT EXISTS {cat}.{sch}.token_supply_snapshots (mint_address STRING, supply BIGINT, decimals INT, slot BIGINT, snapshot_at TIMESTAMP) USING DELTA",
        f"CREATE TABLE IF NOT EXISTS {cat}.{sch}.analytics_cache (response_json STRING, holder_count BIGINT, total_supply DOUBLE, snapshot_at TIMESTAMP) USING DELTA",
    ]

    for sql in ddl_statements:
        resp = _db_execute(host, token, warehouse_id, sql, wait=True,
                           catalog=cat, schema=sch)
        if resp is None:
            print(f"[databricks_push] DDL request failed (no response)")
            return False
        state = resp.get("status", {}).get("state", "")
        if state == "FAILED":
            err_msg = resp.get("status", {}).get("error", {}).get("message", "")
            print(f"[databricks_push] DDL failed: {err_msg[:200]}")
            print(f"[databricks_push] ⚠  Cannot auto-create tables. Need Waddah to run:")
            print(f"[databricks_push]    CREATE CATALOG sdp MANAGED LOCATION 's3://tmp-sdp-data/';")
            print(f"[databricks_push]    CREATE SCHEMA sdp.raw;")
            print(f"[databricks_push]    (one per table) CREATE EXTERNAL TABLE sdp.raw.X USING DELTA LOCATION '...';")
            return False

    _DB_TABLES_INITIALIZED = True
    return True
    _DB_TABLES_INITIALIZED = True
    return True


def push_supply_snapshots(cfg: Config, host: str, token: str, warehouse_id: str) -> int:
    """Push today's stablecoin snapshot to Databricks ``token_supply_snapshots``.

    Reads the latest Delta Parquet file and INSERTs rows not already present.
    Returns the number of rows inserted.
    """
    from src.services.s3_service import DELTA_ROOT

    if not _ensure_tables(host, token, warehouse_id):
        return 0

    # Read from our new Delta path instead of the old root-level flat Parquet
    delta_prefix = f"{DELTA_ROOT}/stablecoins/"
    latest_key = _latest_delta_file(cfg, delta_prefix)
    if not latest_key:
        print(f"[databricks_push] No stablecoin data at {delta_prefix}")
        return 0

    try:
        df = read_parquet(cfg, latest_key)
    except Exception as e:
        print(f"[databricks_push] Failed to read {latest_key}: {e}")
        return 0

    if df.is_empty():
        return 0

    rows = df.to_dicts()
    inserted = 0

    for row in rows:
        mint = row.get("mint", "")
        supply = int(row.get("supply", 0) or 0)
        decimals = str(row.get("decimals", 0))
        scraped_at = row.get("scraped_at", datetime.now(timezone.utc).isoformat())

        # De-duplicate: skip if this exact snapshot already exists
        table_ref = f"{_DB_CATALOG}.{_DB_SCHEMA}.token_supply_snapshots"
        check_sql = (
            f"SELECT COUNT(*) as cnt FROM {table_ref} "
            f"WHERE mint_address = '{mint}' AND snapshot_at = '{scraped_at}'"
        )
        check_resp = _db_execute(host, token, warehouse_id, check_sql, catalog=_DB_CATALOG, schema=_DB_SCHEMA)
        if check_resp:
            result = check_resp.get("result", {}).get("data_array", [])
            if result and int(result[0][0]) > 0:
                continue

        insert_sql = (
            f"INSERT INTO {table_ref} "
            f"(mint_address, supply, decimals, slot, snapshot_at) VALUES ("
            f"'{mint}', {supply}, {decimals}, 0, '{scraped_at}')"
        )
        resp = _db_execute(host, token, warehouse_id, insert_sql, catalog=_DB_CATALOG, schema=_DB_SCHEMA)
        if resp and resp.get("status", {}).get("state") == "SUCCEEDED":
            inserted += 1
        else:
            print(f"[databricks_push] INSERT failed for {mint}: {resp}")

    print(f"[databricks_push] Pushed {inserted} supply snapshot(s) to Databricks")
    return inserted


# ── Analytics cache ────────────────────────────────────────────────────


def push_analytics_cache(cfg: Config, host: str, token: str, warehouse_id: str) -> bool:
    """Upsert the latest aggregated analytics snapshot into ``analytics_cache``.

    Reads all S3 stablecoin data, computes an ``AnalyticsResponse``-shaped
    JSON blob, and writes it to the Databricks analytics_cache table so the
    SDP API can serve it fresh.
    """
    # Read all stablecoin data from the new Delta path
    from src.services.s3_service import DELTA_ROOT
    delta_prefix = f"{DELTA_ROOT}/stablecoins/"
    all_keys = [k for k in list_keys(cfg, delta_prefix) if k.endswith(".snappy.parquet")]
    frames: list[pl.DataFrame] = []

    for key in sorted(all_keys):
        try:
            df = read_parquet(cfg, key)
            frames.append(df)
        except Exception:
            continue

    if not frames:
        print("[databricks_push] No stablecoin data to cache")
        return False

    combined = pl.concat(frames, how="vertical_relaxed")

    # Build latest per-symbol
    latest_by_symbol: dict[str, dict] = {}
    for row in combined.to_dicts():
        symbol = row.get("symbol", "UNKNOWN")
        date = row.get("date", "")
        if symbol not in latest_by_symbol or date > latest_by_symbol[symbol].get("date", ""):
            latest_by_symbol[symbol] = row

    # Build supply history by date
    supply_by_date: dict[str, dict] = {}
    for row in combined.to_dicts():
        date = row.get("date", "")
        sym = row.get("symbol", "UNKNOWN")
        us = float(row.get("ui_supply", 0) or 0)
        if date not in supply_by_date:
            supply_by_date[date] = {"date": date}
        supply_by_date[date][sym] = us

    supply_history = sorted(supply_by_date.values(), key=lambda x: x["date"])

    # Get token registry for names
    registry_tokens = get_all_tokens(cfg)
    name_by_mint: dict[str, str] = {t["mint"]: t.get("name", t["symbol"]) for t in registry_tokens}

    # Stablecoin entries
    stablecoin_entries: list[dict] = []
    total_holders = 0
    for symbol, row in latest_by_symbol.items():
        mint = row.get("mint", "")
        ui_supply = float(row.get("ui_supply", 0) or 0)
        stablecoin_entries.append({
            "mintAddress": mint,
            "symbol": symbol,
            "name": name_by_mint.get(mint, symbol),
            "totalSupply": float(row.get("supply", 0) or 0),
            "circulatingSupply": ui_supply,
            "holderCount": 0,
            "medianBalance": 0,
            "priceUsd": 1.0,
            "marketCapUsd": ui_supply,
            "percentChange24h": 0.0,
        })

    now_iso = datetime.now(timezone.utc).isoformat()
    response_json = json.dumps({
        "stablecoins": stablecoin_entries,
        "holders": {
            "totalHolders": total_holders,
            "geography": [{"region": "Unknown", "percentage": 100, "holderCount": total_holders}],
            "attribution": [{"category": "unknown", "percentage": 100, "holderCount": total_holders}],
        },
        "holdersHistory": [],
        "supplyHistory": supply_history,
        "lastUpdated": now_iso,
    })

    total_supply = sum(e["circulatingSupply"] for e in stablecoin_entries)

    table_ref = f"{_DB_CATALOG}.{_DB_SCHEMA}.analytics_cache"
    insert_sql = (
        f"INSERT INTO {table_ref} "
        f"(response_json, holder_count, total_supply, snapshot_at) VALUES ("
        f"'{response_json.replace(chr(39), chr(39)+chr(39))}', "
        f"{total_holders}, {total_supply}, '{now_iso}')"
    )

    resp = _db_execute(host, token, warehouse_id, insert_sql, catalog=_DB_CATALOG, schema=_DB_SCHEMA)
    success = resp is not None and resp.get("status", {}).get("state") == "SUCCEEDED"
    if success:
        print(f"[databricks_push] Analytics cache updated ({len(stablecoin_entries)} tokens, {len(supply_history)} days)")
    return success


# ── Public API ──────────────────────────────────────────────────────────


def push_to_databricks(cfg: Config) -> dict:
    """Push latest S3 data to all Databricks analytics tables.

    Reads Databricks credentials from config extras (set via env vars).
    Returns a summary dict.

    Required env vars (set via CONFIG_EXTRA or injected to Docker):
      databricks_host, databricks_token, databricks_warehouse_id
    """
    extra = cfg.extra
    host = (
        cfg.databricks_host
        or extra.get("databricks_host")
        or extra.get("DATABRICKS_HOST")
    )
    token = (
        cfg.databricks_token
        or extra.get("databricks_token")
        or extra.get("DATABRICKS_TOKEN")
    )
    warehouse_id = (
        cfg.databricks_warehouse_id
        or extra.get("databricks_warehouse_id")
        or extra.get("DATABRICKS_WAREHOUSE_ID")
    )

    if not host or not token or not warehouse_id:
        return {
            "status": "skipped",
            "reason": "Databricks credentials not configured (set DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID via CONFIG_EXTRA or env vars)",
        }

    supply_count = push_supply_snapshots(cfg, host, token, warehouse_id)
    cache_ok = push_analytics_cache(cfg, host, token, warehouse_id)

    return {
        "status": "ok" if (supply_count > 0 or cache_ok) else "no_data",
        "supply_snapshots_pushed": supply_count,
        "analytics_cache_updated": cache_ok,
    }
