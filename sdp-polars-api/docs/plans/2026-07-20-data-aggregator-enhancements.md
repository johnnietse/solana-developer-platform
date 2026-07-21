# Data Aggregator Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded token mints with dynamic on-chain discovery, expand ingested data (holders, whales, validators), and wire WebSocket to real Solana devnet data.

**Architecture:** New `token_discovery.py` service queries `getProgramAccounts` to find all SPL token mints dynamically. Three new ingestion methods write holder/whale/validator snapshots to Delta tables. Existing WebSocket connection manager wired to `wss://api.devnet.solana.com` with 3 subscriptions.

**Tech Stack:** Python, Polars, Delta Lake, Solana RPC/WebSocket (devnet), APScheduler

## Global Constraints

- Devnet RPC only: `https://api.devnet.solana.com`
- All data written to Delta tables at `s3://tmp-sdp-data/dev/mlh/sdp_data/{table}/`
- Config goes in `config.py` with env var overrides
- Follow existing patterns: Blueprint injection for routes, `_register_*` pattern, config injected via `app.config["APP_CFG"]`
- Run in Docker container via gunicorn

---

### Task 1: Dynamic Token Discovery Service

**Files:**
- Create: `src/services/token_discovery.py`

**Interfaces:**
- Produces: `discover_token_mints(cfg) -> list[dict]` — returns `[{mint, decimals, supply, slot}]`
- Produces: `resolve_token_symbol(cfg, mint) -> str` — returns a human-readable symbol

- [ ] **Step 1: Create `src/services/token_discovery.py`**

```python
"""Dynamic token discovery via getProgramAccounts on the SPL Token program."""

from __future__ import annotations

import struct
from typing import TYPE_CHECKING
from urllib.error import HTTPError

from src.services.solana_rpc import _call

if TYPE_CHECKING:
    from config import Config

SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MINT_ACCOUNT_SIZE = 82  # Mint accounts are exactly 82 bytes


def discover_token_mints(cfg: Config) -> list[dict]:
    """Discover all SPL token mints by querying getProgramAccounts with a data-size filter.

    Returns a list of dicts with keys: mint, decimals, supply, slot
    Returns empty list on RPC errors.
    """
    try:
        resp = _call(
            cfg,
            "getProgramAccounts",
            [
                SPL_TOKEN_PROGRAM,
                {
                    "encoding": "jsonParsed",
                    "filters": [{"dataSize": MINT_ACCOUNT_SIZE}],
                },
            ],
        )
    except (HTTPError, Exception) as exc:
        print(f"[token_discovery] getProgramAccounts failed: {exc}")
        return []

    accounts = resp.get("result", [])
    if not accounts:
        return []

    mints = []
    for acc in accounts:
        try:
            account_data = acc.get("account", {})
            parsed = account_data.get("data", {}).get("parsed", {})
            info = parsed.get("info", {})
            mint_addr = acc.get("pubkey", "")
            if not mint_addr:
                continue
            decimals = info.get("decimals", 0)
            supply = info.get("supply", "0")
            mint_authority = info.get("mintAuthority", None)
            mints.append({
                "mint": mint_addr,
                "decimals": decimals,
                "supply": supply,
                "slot": account_data.get("slot", 0),
                "mint_authority": mint_authority,
            })
        except Exception as exc:
            print(f"[token_discovery] Failed to parse account: {exc}")
            continue

    print(f"[token_discovery] Found {len(mints)} token mints")
    return mints


def resolve_token_symbol(cfg: Config, mint: str) -> str:
    """Resolve a human-readable symbol for a token mint.

    Currently uses a known list; in the future could query a token registry.
    """
    KNOWN_STABLECOINS = {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
        "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": "USDC_DEV",
        "9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z": "PYUSD_DEV",
        "2bRGcWaoBAeCsom8QqfDjfkhU552LVLwC8FQpj64ee37": "CAD_COIN",
    }
    return KNOWN_STABLECOINS.get(mint, f"{mint[:4]}...{mint[-4:]}")
```

- [ ] **Step 2: Verify the file is valid Python**

Run: `python -c "import ast; ast.parse(open('src/services/token_discovery.py').read()); print('Syntax OK')"`

Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add src/services/token_discovery.py
git commit -m "feat: add dynamic token discovery service via getProgramAccounts"
```

---

### Task 2: Update Ingestion Pipeline with Dynamic Discovery + Expanded Data

**Files:**
- Modify: `src/services/ingestion.py`
- Modify: `src/services/scheduler.py`
- Modify: `config.py`

**Interfaces:**
- Consumes: `discover_token_mints(cfg)` from Task 1
- Consumes: `resolve_token_symbol(cfg, mint)` from Task 1
- Produces: 5 new ingestion functions that write to Delta tables

- [ ] **Step 1: Update `config.py` with new settings**

Add these fields after `ingestion_retry_delay_seconds`:

```python
    # Token discovery
    token_discovery_enabled: bool = getenv("TOKEN_DISCOVERY_ENABLED", "true").lower() == "true"

    # Expanded data ingestion
    holders_ingestion_enabled: bool = getenv("HOLDERS_INGESTION_ENABLED", "true").lower() == "true"
    whales_ingestion_enabled: bool = getenv("WHALES_INGESTION_ENABLED", "true").lower() == "true"
    validators_ingestion_enabled: bool = getenv("VALIDATORS_INGESTION_ENABLED", "true").lower() == "true"
```

- [ ] **Step 2: Update `src/services/ingestion.py`**

Replace the `DEFAULT_STABLECOIN_MINTS` dict with dynamic discovery. Replace the current `fetch_stablecoin_snapshot` with one that uses `discover_token_mints`. Add three new ingestion methods.

**Remove** the `DEFAULT_STABLECOIN_MINTS` dict entirely.

**Replace `fetch_stablecoin_snapshot`** with:

```python
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
```

**Add `fetch_holders_snapshot` after `fetch_network_snapshot`:**

```python
def fetch_holders_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch top 20 holders for all discovered token mints."""
    from src.services.token_discovery import discover_token_mints

    mints = discover_token_mints(cfg)
    now_iso = datetime.now(timezone.utc).isoformat()
    records = []

    for mint_info in mints[:50]:  # Limit to first 50 mints to avoid rate limits
        try:
            resp = _call(cfg, "getTokenLargestAccounts", [mint_info["mint"]])
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

    print(f"[ingestion] Holders snapshot: {len(records)} records")
    return pl.DataFrame(records) if records else pl.DataFrame()


def fetch_whales_snapshot(cfg: Config) -> pl.DataFrame:
    """Fetch the 20 largest SOL accounts (whales)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        resp = _call(cfg, "getLargestAccounts", [])
        accounts = resp.get("result", {}).get("value", [])
        records = [
            {
                "address": a.get("address", ""),
                "lamports": int(a.get("lamports", "0")),
                "ui_balance": float(a.get("lamports", "0")) / 1e9,
                "rank": i + 1,
                "scraped_at": now_iso,
            }
            for i, a in enumerate(accounts)
        ]
        print(f"[ingestion] Whales snapshot: {len(records)} records")
        return pl.DataFrame(records)
    except Exception as exc:
        print(f"[ingestion] getLargestAccounts failed: {exc}")
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
```

**Add 3 new public ingestion functions after `ingest_network`:**

```python
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
```

- [ ] **Step 3: Update `src/services/scheduler.py`**

Add the new ingestion functions to the scheduler job:

```python
def _run_ingestion(cfg: Config):
    """Run all ingestion tasks serially."""
    from src.services.ingestion import (
        ingest_stablecoins,
        ingest_network,
        ingest_holders,
        ingest_whales,
        ingest_validators,
    )
    from src.services.databricks_push import push_to_databricks

    results = {}
    for fn in [ingest_stablecoins, ingest_network, ingest_holders, ingest_whales, ingest_validators]:
        try:
            results[fn.__name__] = fn(cfg)
        except Exception as exc:
            results[fn.__name__] = {"status": "error", "error": str(exc)}

    # Always attempt Databricks push after ingestion
    try:
        results["push_to_databricks"] = push_to_databricks(cfg)
    except Exception as exc:
        results["push_to_databricks"] = {"status": "error", "error": str(exc)}

    print(f"[scheduler] Ingestion cycle complete: {json.dumps(results, default=str)[:500]}")
```

- [ ] **Step 4: Verify Python syntax**

Run: `python -c "import ast; ast.parse(open('src/services/ingestion.py').read()); print('Syntax OK')"`

Expected: `Syntax OK`

- [ ] **Step 5: Commit**

```bash
git add src/services/ingestion.py src/services/scheduler.py config.py
git commit -m "feat: dynamic token discovery + expanded data ingestion (holders, whales, validators)"
```

---

### Task 3: Wire WebSocket to Real Solana Data

**Files:**
- Create: `src/services/ws_ingestion.py`
- Modify: `app.py`

**Interfaces:**
- Consumes: `WebSocketConnection`, `SubscriptionManager` from `src/websocket/connection.py`
- Produces: Background thread that streams real-time Solana data to S3

- [ ] **Step 1: Create `src/services/ws_ingestion.py`**

```python
"""Real-time Solana data ingestion via WebSocket.

Streams slot updates, logs, and program account changes from
wss://api.devnet.solana.com into Delta tables.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from config import Config

import polars as pl

from src.websocket.connection import WebSocketConnection, WebSocketConfig

SOLANA_WS_URL = "wss://api.devnet.solana.com"


def _on_slot(data: dict, cfg: Config) -> None:
    """Handle slot notification - write to Delta."""
    try:
        slot = data.get("params", {}).get("result", {}).get("slot", 0)
        if not slot:
            return
        df = pl.DataFrame([{
            "slot": slot,
            "received_at": datetime.now(timezone.utc).isoformat(),
        }])
        from src.services.s3_service import write_delta
        write_delta(cfg, "events", df, mode="append")
        print(f"[ws_ingestion] Slot {slot}")
    except Exception as exc:
        print(f"[ws_ingestion] slot handler error: {exc}")


def _on_logs(data: dict, cfg: Config) -> None:
    """Handle logs notification - check for token transfers."""
    try:
        params = data.get("params", {}).get("result", {}).get("value", {})
        sig = params.get("signature", "")
        logs = params.get("logs", [])
        if not sig or not logs:
            return
        df = pl.DataFrame([{
            "signature": sig,
            "logs": json.dumps(logs),
            "received_at": datetime.now(timezone.utc).isoformat(),
        }])
        from src.services.s3_service import write_delta
        write_delta(cfg, "events", df, mode="append")
        print(f"[ws_ingestion] Logs: {sig[:16]}...")
    except Exception as exc:
        print(f"[ws_ingestion] logs handler error: {exc}")


def _on_program(data: dict, cfg: Config) -> None:
    """Handle program account change notification."""
    try:
        result = data.get("params", {}).get("result", {})
        value = result.get("value", {})
        pubkey = value.get("pubkey", "")
        if not pubkey:
            return
        df = pl.DataFrame([{
            "pubkey": pubkey,
            "received_at": datetime.now(timezone.utc).isoformat(),
        }])
        from src.services.s3_service import write_delta
        write_delta(cfg, "events", df, mode="append")
        print(f"[ws_ingestion] Program account: {pubkey[:16]}...")
    except Exception as exc:
        print(f"[ws_ingestion] program handler error: {exc}")


def start_ws_listeners(cfg: Config) -> None:
    """Start WebSocket listeners in a background thread for each subscription."""
    ws_cfg = WebSocketConfig(url=SOLANA_WS_URL)

    def _run_slot():
        conn = WebSocketConnection(ws_cfg)
        conn.connect()
        conn.subscribe("slotSubscribe", [], lambda d: _on_slot(d, cfg))
        conn.run_forever()

    def _run_logs():
        conn = WebSocketConnection(ws_cfg)
        conn.connect()
        conn.subscribe("logsSubscribe", [{"mentions": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]}], lambda d: _on_logs(d, cfg))
        conn.run_forever()

    def _run_program():
        conn = WebSocketConnection(ws_cfg)
        conn.connect()
        conn.subscribe("programSubscribe", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", {"filters": [{"dataSize": 165}]}], lambda d: _on_program(d, cfg))
        conn.run_forever()

    threads = [
        threading.Thread(target=_run_slot, daemon=True, name="ws-slot"),
        threading.Thread(target=_run_logs, daemon=True, name="ws-logs"),
        threading.Thread(target=_run_program, daemon=True, name="ws-program"),
    ]
    for t in threads:
        t.start()
        print(f"[ws_ingestion] Started {t.name}")

    print(f"[ws_ingestion] All WebSocket listeners started")
```

- [ ] **Step 2: Update `app.py` to start WS listeners**

Add after `start_scheduler(app.config["APP_CFG"])`:

```python
    # ── Start WebSocket real-time listeners ──
    from src.services.ws_ingestion import start_ws_listeners
    start_ws_listeners(app.config["APP_CFG"])
```

And add the import at the top of `app.py`:

```python
from src.services.ws_ingestion import start_ws_listeners
```

- [ ] **Step 3: Verify syntax**

Run: `python -c "import ast; ast.parse(open('src/services/ws_ingestion.py').read()); print('Syntax OK')"`

Expected: `Syntax OK`

- [ ] **Step 4: Commit**

```bash
git add src/services/ws_ingestion.py app.py
git commit -m "feat: wire WebSocket to real Solana devnet data with 3 subscriptions"
```

---

### Task 4: Rebuild, Deploy, Test, and Send Waddah Message

**Files:** (no code changes)

- [ ] **Step 1: Rebuild Docker container**

```bash
docker stop sdp-polars-api
docker rm sdp-polars-api
docker build -t sdp-polars-api .
```

Run from: `C:\Users\Johnnie\Documents\MLH_Fellowship_2026\sdp-polars-api`

- [ ] **Step 2: Start container with env vars**

```bash
docker run -d --name sdp-polars-api --restart unless-stopped -p 8081:8080 \
  -e S3_BUCKET=tmp-sdp-data \
  -e S3_REGION=us-east-1 \
  -e SOLANA_RPC_URL=https://api.devnet.solana.com \
  -e ANALYTICS_ENABLED=true \
  -e PORT=8080 \
  sdp-polars-api
```

- [ ] **Step 3: Verify health and metrics**

Run: `curl -s http://localhost:8081/health`
Expected: `{"status":"ok"}`

Run: `curl -s "http://localhost:8081/metrics?days=1"`
Expected: JSON with stablecoins + network data

- [ ] **Step 4: Verify new Delta tables appear in S3**

Run: `aws s3 ls s3://tmp-sdp-data/dev/mlh/sdp_data/ --profile sdp-user`
Expected: `holders/`, `whales/`, `validators/`, `events/` prefixes appear (after first ingestion cycle)

- [ ] **Step 5: Send Waddah message on Slack**

Send this message to Waddah Al Drobi on Slack:

> Hey Waddah,
>
> We've built the full Polars API pipeline with 3 endpoints (GET /metrics, GET /rpc, POST /insert) and it's running locally in Docker. The data is auto-ingesting every 15 minutes into S3 Delta format and Databricks managed tables.
>
> **Current data flowing:**
> - Stablecoin supplies (dynamically discovered on-chain, no more hardcoded mints)
> - Network metrics (TPS, slot, inflation rate, supply)
> - Token holders, SOL whales, validator info
> - Real-time WebSocket events from devnet
>
> **The blocker for production deployment:**
> We're using a free-tier Databricks workspace with a serverless warehouse that can't read S3 directly (need IAM role-based External Locations). We're bridging with SQL INSERT but this creates a redundant copy.
>
> **What we need from you:**
> 1. A Databricks Personal Access Token from your workspace (where S3 IAM access is configured)
> 2. An IAM role ARN with read access to s3://tmp-sdp-data/dev/mlh/sdp_data/*
>
> With those, we can switch to the clean architecture you designed — single source of truth in S3, Databricks reads directly, no duplication.
>
> Happy to jump on a call to walk through it. Thanks!

- [ ] **Step 6: Commit final changes**

```bash
git add -A
git commit -m "feat: data aggregator enhancements + WebSocket real-time"
```
