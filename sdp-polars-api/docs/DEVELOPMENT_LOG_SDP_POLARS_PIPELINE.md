# SDP Polars API — Development Log

> **Branch:** `main`
> **Commit:** `9677893`
> **Date:** 2026-07-21
> **Author:** Johnnie Tse
> **Fork:** `github.com/johnnietse/solana-developer-platform`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Pipeline Components](#2-pipeline-components)
3. [Data Flow & Storage](#3-data-flow--storage)
4. [WebSocket Real-Time Ingestion](#4-websocket-real-time-ingestion)
5. [Retry & Fallback System](#5-retry--fallback-system)
6. [API Endpoints](#6-api-endpoints)
7. [Configuration](#7-configuration)
8. [Deployment](#8-deployment)
9. [Databricks Integration](#9-databricks-integration)
10. [Known Limitations](#10-known-limitations)
11. [Roadmap](#11-roadmap)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Docker Container                             │
│                                                                     │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────────────────┐ │
│  │  Scheduler  │───▶│  Ingesters   │───▶│   S3 Delta Lake (S3)    │ │
│  │  (15 min)   │    │  (5 types)   │    │  ┌──────────────────┐   │ │
│  └────────────┘    └──────────────┘    │  │ stablecoins      │   │ │
│                                          │  │ network          │   │ │
│  ┌──────────────────────────┐            │  │ holders           │   │ │
│  │ WebSocket Connection     │───────────▶│  │ whales            │   │ │
│  │ (auto-reconnect)         │  events    │  │ validators        │   │ │
│  │                         │  holders   │  │ events            │   │ │
│  └──────────────────────────┘            │  └──────────────────┘   │ │
│                                          └──────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Flask API Server (port 8080)                                │   │
│  │  /ingest/*  /health  /metrics  /rpc  /holders  /tokens      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                        ┌──────────────────────┐
                        │  Databricks External   │
                        │  Location ✅          │
                        │  (IAM Role via S3)     │
                        └──────────────────────┘
                                    │
                                    ▼
                        ┌──────────────────────┐
                        │  Databricks External   │
                        │  Tables (Waddah runs   │
                        │  8 lines of SQL)       │
                        └──────────────────────┘
```

### Design Principles

- **Direct-to-S3 writes** — no intermediary database or SQL INSERT bridge
- **Delta format** — transactional, schema-evolution-safe Parquet storage
- **15-minute auto-scheduler** — immediate first run, then every 15 min
- **Multi-layer fallback** — primary RPC → secondary RPC → WebSocket accumulator → validator proxy
- **async WebSocket** — auto-reconnecting, event-driven holder & event accumulation
- **Containerized** — Docker with `--restart unless-stopped` for production reliability

---

## 2. Pipeline Components

### 2.1 Ingestion Module (`src/services/ingestion.py`)

The core ingestion engine. Contains five snapshot fetchers and a unified S3 Delta writer.

| Function | Data Source | RPC Method(s) | Fallback |
|---|---|---|---|
| `fetch_stablecoins_snapshot` | Solana RPC | `getTokenSupply` per mint | `FALLBACK_MINTS` (hardcoded devnet mints) |
| `fetch_network_snapshot` | Solana RPC | `getSupply`, `getRecentPerformanceSamples`, `getTransactionCount`, `getInflationRate`, `getEpochInfo` | None (each call is isolated) |
| `fetch_holders_snapshot` | Solana RPC → WebSocket | `getProgramAccounts` (blocked) → WebSocket accumulator | WebSocket `snapshot_holders()` |
| `fetch_whales_snapshot` | Solana RPC → Validators | `getLargestAccounts` (429'd) → `getVoteAccounts` | Validator stake proxy (NEW) |
| `fetch_validators_snapshot` | Solana RPC | `getVoteAccounts` | None |

### 2.2 WebSocket Holder Tracker (`src/services/ws_ingestion.py`)

New real-time holder accumulation system.

- **`_HOLDER_ACCUMULATOR`**: module-level `dict[str, dict[str, int]]` keyed by mint address
- **`_on_program()`**: async callback on Token `programSubscribe` — parses `jsonParsed` account data for mint, owner, balance
- **`snapshot_holders()`**: returns top 20 holders per mint as Polars DataFrame
- **Dual-compatible**: handles both `jsonParsed` and `base64` account data
- **Filters**: supports optional `target_mints` set, falls back to all accumulated data

### 2.3 WebSocket Connection Manager (`src/websocket/connection.py`)

Fully async WebSocket lifecycle:

- `subscribe()`: sends `programSubscribe` with `jsonParsed` encoding + `dataSize` filter
- Auto-reconnect on disconnect (exponential backoff)
- `SubscriptionType` enum: `PROGRAM`, `ACCOUNT`, `LOGS`
- Callback-based: `on_program`, `on_account`, `on_logs`
- Handler invocations are `async def` compatible

### 2.4 Scheduler (`src/services/scheduler.py`)

```python
def start_scheduler(app):
    schedule.every(15).minutes.do(_run_ingestion, cfg, app)
    threading.Thread(target=_run_scheduler, daemon=True).start()
    _run_ingestion(cfg, app)  # immediate first run
```

- Runs on a daemon thread, starts on app boot
- Executes all 5 ingesters in sequence
- Attempts Databricks SQL Warehouse push (gracefully skipped if credentials missing)
- Logs per-table row counts and S3 URIs

### 2.5 Token Discovery (`src/services/token_discovery.py`)

Dynamic token mint discovery with fallback.

- **Primary**: `getProgramAccounts` on SPL Token program with `dataSize=82` filter
- **Fallback**: `FALLBACK_MINTS` dict when RPC blocks `getProgramAccounts` (common on devnet)
- `resolve_token_symbol()`: mint → symbol lookup from `FALLBACK_MINTS`

---

## 3. Data Flow & Storage

### 3.1 S3 Delta Schema

All tables written to `s3://tmp-sdp-data/dev/mlh/sdp_data/` as Delta Lake format.

#### `stablecoins`
| Column | Type | Source |
|---|---|---|
| `date` | `String` | `YYYY-MM-DD` |
| `mint` | `String` | Token mint address |
| `symbol` | `String` | Human-readable symbol |
| `supply` | `Int64` | Raw supply (smallest unit) |
| `decimals` | `Int64` | Token decimals |
| `ui_supply` | `Float64` | User-facing supply (`supply / 10^decimals`) |
| `scraped_at` | `String` | ISO 8601 timestamp |

#### `network`
| Column | Type | Source |
|---|---|---|
| `date` | `String` | `YYYY-MM-DD` |
| `total_sol_supply` | `Float64` | `getSupply.total` |
| `circulating_sol_supply` | `Float64` | `getSupply.circulating` |
| `non_circulating_sol_supply` | `Float64` | `getSupply.nonCirculating` |
| `tps` | `Float64` | `getRecentPerformanceSamples` |
| `transaction_count` | `Int64` | `getTransactionCount` |
| `inflation_rate` | `Float64` | `getInflationRate.total * 100` |
| `epoch` | `Int64` | `getEpochInfo.epoch` |
| `slot` | `Int64` | `getEpochInfo.absoluteSlot` |
| `scraped_at` | `String` | ISO 8601 timestamp |

#### `holders`
| Column | Type | Source |
|---|---|---|
| `mint` | `String` | Token mint |
| `owner` | `String` | Holder wallet address |
| `balance` | `Int64` | Raw token balance |
| `ui_balance` | `Float64` | User-facing balance |
| `scraped_at` | `String` | ISO 8601 timestamp |

#### `whales`
| Column | Type | Source |
|---|---|---|
| `address` | `String` | Validator node pubkey (proxy) |
| `lamports` | `Int64` | Activated stake |
| `ui_balance` | `Float64` | SOL balance |
| `rank` | `Int64` | Rank by stake |
| `scraped_at` | `String` | ISO 8601 timestamp |
| `source` | `String` | `"rpc"` or `"validators"` (NEW) |

#### `validators`
| Column | Type | Source |
|---|---|---|
| `status` | `String` | `"current"` or `"delinquent"` |
| `vote_address` | `String` | Validator vote account |
| `node_pubkey` | `String` | Validator node identity |
| `activated_stake` | `Int64` | Total activated stake |
| `commission` | `Int64` | Commission percentage |
| `last_vote` | `Int64` | Last voted slot |
| `root_slot` | `Int64` | Root slot |
| `epoch_credits` | `String` | Epoch credits (serialized) |
| `scraped_at` | `String` | ISO 8601 timestamp |

#### `events`
| Column | Type | Source |
|---|---|---|
| (auto-detected by Delta) | | WebSocket `logsSubscribe` output |

### 3.2 S3 Path Structure

```
s3://tmp-sdp-data/
├── dev/mlh/sdp_data/
│   ├── stablecoins/          ← Delta table, auto-ingested every 15 min
│   ├── network/              ← Delta table
│   ├── holders/              ← Delta table
│   ├── whales/               ← Delta table
│   ├── validators/           ← Delta table
│   └── events/               ← Delta table
├── stablecoins/              ← OLD stale data (SQL INSERT era, deleted)
├── network/                  ← OLD stale data
└── ...
```

---

## 4. WebSocket Real-Time Ingestion

### 4.1 Connection Lifecycle

1. **Startup**: `create_app()` starts WebSocket listener on a background thread
2. **Connection**: Opens WSS to `wss://api.devnet.solana.com/`
3. **Subscription**: Sends `programSubscribe` for Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
4. **Accumulation**: Each account update parsed → `_HOLDER_ACCUMULATOR[mint][owner] = balance`
5. **Snapshot**: On `/ingest/holders` or scheduled run, `snapshot_holders()` extracts top 20 per mint
6. **Reconnect**: On disconnect, auto-reconnects with exponential backoff

### 4.2 Handler Architecture (`src/websocket/connection.py`)

```python
class SubscriptionType(Enum):
    PROGRAM = "programSubscribe"
    ACCOUNT = "accountSubscribe"
    LOGS = "logsSubscribe"

async def subscribe(url, sub_type, params, callbacks):
    # Opens WSS connection
    # Sends subscription request
    # Loops: receive message → route to callback
    # On error: reconnect with backoff
```

### 4.3 On-Program Handler (`src/websocket/handlers.py` ➜ `src/services/ws_ingestion.py`)

```python
async def _on_program(ws, raw: dict):
    params = raw.get("params", {})
    result = params.get("result", {})
    account_data = result.get("account", {}).get("data", [])
    
    if isinstance(account_data, list) and len(account_data) >= 2:
        # jsonParsed format
        parsed = account_data[0].get("parsed", {})
        info = parsed.get("info", {})
        mint = info.get("mint", "")
        owner = info.get("owner", "")
        balance = int(info.get("tokenAmount", {}).get("amount", "0"))
    else:
        # base64 fallback
        raw_bytes = base64.b64decode(account_data[0])
        mint = Pubkey.from_bytes(raw_bytes[0:32])
        owner = Pubkey.from_bytes(raw_bytes[32:64])
        balance = int.from_bytes(raw_bytes[64:72], "little")
    
    _HOLDER_ACCUMULATOR.setdefault(mint, {}).setdefault(str(owner), 0)
    _HOLDER_ACCUMULATOR[mint][str(owner)] = balance
```

---

## 5. Retry & Fallback System

### 5.1 Multi-URL Rotation (`src/services/solana_rpc.py`)

```python
def _get_rpc_urls(cfg: Config) -> list[str]:
    """Returns prioritized list of RPC URLs to try."""
    # 1. Primary SOLANA_RPC_URL
    # 2. All SOLANA_RPC_URLS (comma-separated env var)
    # 3. Fallback to https://api.devnet.solana.com
```

- Rotates through multiple RPC endpoints on failure
- Each URL tried before moving to next
- Configurable via `SOLANA_RPC_URLS` env var (comma-separated)

### 5.2 Per-Method Retry Overrides (`ingestion.py`)

```python
def fetch_stablecoins_snapshot(cfg):
    # Default retry: max_retries=3, base_delay=5.0

def fetch_whales_snapshot(cfg):
    # Fast-fail: max_retries=2, base_delay=2.0 (getLargestAccounts always blocked)

def fetch_holders_snapshot(cfg):
    # RPC getProgramAccounts → retry → WebSocket fallback

def _call_with_retry(cfg, method, params, max_retries=3, base_delay=5.0):
    # Exponential backoff: delay = min(base_delay * 2^attempt, 60s)
    # Multi-URL rotation via _get_rpc_urls()
```

### 5.3 Whales Proxy Strategy (NEW in this iteration)

When `getLargestAccounts` fails (permanently 429 on devnet):

1. **Primary**: `getLargestAccounts` — returns 20 largest SOL accounts
2. **Fallback**: `getVoteAccounts` — extracts top 20 validators by `activatedStake`
3. **Source tag**: `"rpc"` vs `"validators"` column to distinguish data provenance

### 5.4 Holders Three-Tier Fallback

1. **Primary**: RPC `getProgramAccounts` on Token program (403 on devnet) → error
2. **Fallback**: WebSocket accumulator filtered by known mints
3. **Ultimate fallback**: Full WebSocket accumulator (all tokens on devnet)

---

## 6. API Endpoints

| Method | Path | Description | Added/Modified |
|---|---|---|---|
| `GET` | `/health` | Health check with uptime | ✅ Existing |
| `GET` | `/ingest/all` | Run all 5 ingesters + Databricks push | ✅ **Fixed: was missing holders/whales/validators** |
| `GET` | `/ingest/stablecoins` | Stablecoin snapshot | ✅ Existing |
| `GET` | `/ingest/network` | Network metrics snapshot | ✅ Existing |
| `GET` | `/ingest/holders` | Holder snapshot (NEW) | ✅ **Added** |
| `GET` | `/ingest/whales` | Whale account snapshot (NEW) | ✅ **Added** |
| `GET` | `/ingest/validators` | Validator snapshot (NEW) | ✅ **Added** |
| `GET` | `/ingest/databricks` | Databricks push | ✅ Existing |
| `GET` | `/metrics` | Historical metrics from S3 | ✅ Existing |
| `GET` | `/rpc?token_address=X` | Token transfers via S3 cache | ✅ Existing |
| `GET` | `/holders/<mint>` | Top holders for a mint | ✅ Existing |
| `GET` | `/stablecoins?days=N` | Stablecoin supply history | ✅ Existing |
| `GET` | `/stablecoins/median` | Median supply per token | ✅ Existing |
| `GET` | `/network?days=N` | Historical network metrics | ✅ Existing |
| `POST` | `/insert?table_name=X` | Write custom data to S3 | ✅ Existing |
| `GET` | `/tokens` | Token registry | ✅ Existing |
| `POST` | `/tokens/register` | Register new token | ✅ Existing |

---

## 7. Configuration

### 7.1 Environment Variables (`config.py`)

| Variable | Default | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | *required* | AWS S3 access |
| `AWS_SECRET_ACCESS_KEY` | *required* | AWS S3 secret |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Primary RPC endpoint |
| `SOLANA_RPC_URLS` | `""` | Comma-separated fallback RPC URLs |
| `S3_BUCKET` | `tmp-sdp-data` | S3 bucket |
| `S3_REGION` | `us-east-1` | AWS region |
| `DELTA_ROOT` | `dev/mlh/sdp_data` | S3 prefix for Delta tables |
| `RPC_MAX_RETRIES` | `3` | Default RPC retry count |
| `RPC_RETRY_DELAY_SECONDS` | `5` | Base retry delay |
| `RPC_TIMEOUT` | `15` | RPC request timeout (seconds) |
| `SCHEDULER_INTERVAL_MINUTES` | `15` | Ingestion interval |
| `DATABRICKS_TOKEN` | `None` | (Legacy) Databricks PAT |
| `DATABRICKS_HOST` | `None` | (Legacy) Databricks workspace URL |
| `DATABRICKS_WAREHOUSE_ID` | `None` | (Legacy) SQL Warehouse ID |

### 7.2 Devnet Token Mints (`token_discovery.py`)

```python
FALLBACK_MINTS = {
    "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": ("USDC", 6),   # Devnet USDC
    "9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z": ("PYUSD", 6),  # Devnet PYUSD
}
```

> **Change from previous version:** Removed mainnet USDC (`EPjFWdd5...`) and mainnet USDT (`Es9vMFrz...`) from fallback mints — they don't exist on devnet and always returned 0 supply. Devnet symbols renamed from `USDC_DEV`/`PYUSD_DEV` to `USDC`/`PYUSD`.

---

## 8. Deployment

### 8.1 Docker

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["gunicorn", "--worker-class", "gevent", "--workers", "1", "--bind", "0.0.0.0:8080", "app:app"]
```

### 8.2 Container Lifecycle

```powershell
# Build
docker build -t sdp-polars-api .

# Run (with auto-restart)
docker run -d --name sdp-polars-api `
  --restart unless-stopped `
  -p 8081:8080 `
  -e AWS_ACCESS_KEY_ID=<your-key> `
  -e AWS_SECRET_ACCESS_KEY=<your-secret> `
  -e SOLANA_RPC_URL=https://api.devnet.solana.com `
  sdp-polars-api

# Verify (30s wait for scheduler first run)
curl.exe http://127.0.0.1:8081/health

# Full ingest
curl.exe http://127.0.0.1:8081/ingest/all
```

### 8.3 ECS Deployment (`deploy/deploy-ecs.ps1`)

Pre-configured Fargate deployment with:
- Task role: `arn:aws:iam::017605949106:role/sdp-polars-api-task-role`
- ECR + ECS + CloudWatch Logs integration
- Environment variables from AWS Secrets Manager

---

## 9. Databricks Integration

### 9.1 Current State

| Component | Status | Details |
|---|---|---|
| **IAM Role** | ✅ Configured | `arn:aws:iam::017605949106:role/databricks-ajzoddwggc45lttyula27v-storage-credential-role` |
| **External Location** | ✅ Configured | `s3://tmp-sdp-data/` in Waddah's workspace |
| **External Tables** | ⏳ Needs Waddah | **8 lines of SQL** — see Section 9.2 |

### 9.2 SQL to Create External Tables

```sql
CREATE CATALOG IF NOT EXISTS sdp MANAGED LOCATION 's3://tmp-sdp-data/';
CREATE SCHEMA IF NOT EXISTS sdp.raw;

CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.stablecoins USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/stablecoins/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.network USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/network/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.holders USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/holders/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.whales USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/whales/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.validators USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/validators/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.events USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/events/';
```

### 9.3 Architecture Rationale

```
Pipeline → S3 Delta (Direct Write) → External Tables (Read via IAM)
                ↑                          ↑
         No warehouse creds         One-time SQL by Waddah
```

- **No PAT/token needed** in the pipeline itself
- **No SQL INSERT bridge** — eliminates redundant data copy
- **Auto-refreshing** — new data every 15 min, immediately queryable
- **Clean separation** — pipeline writes, Databricks reads, no overlap

---

## 10. Known Limitations

### 10.1 Devnet Constraints

| Limitation | Root Cause | Impact | Workaround |
|---|---|---|---|
| No real whales | `getLargestAccounts` 429 on devnet | Whales = validators proxy | Validator stake fallback |
| No token auto-discovery | `getProgramAccounts` 403 on devnet | Hardcoded fallback mints | `FALLBACK_MINTS` dict |
| Mainnet tokens show 0 supply | USDC/USDT mints don't exist on devnet | Only devnet tokens tracked | Switch to mainnet RPC |
| WebSocket holders ≠ our tokens | Devnet has different tokens than fallback mints | Holder data from all devnet activity | Acceptable for devnet |

### 10.2 External Dependencies

| Dependency | Status | What's Needed |
|---|---|---|
| **Waddah's Databricks workspace** | Blocked | 8 lines SQL for External Tables |
| **Paid RPC key (Helius/QuickNode)** | Blocked | `getLargestAccounts` for real whales, `getProgramAccounts` for auto-discovery |
| **Slack DM to Waddah** | Blocked | Not in connected workspace |

---

## 11. Roadmap

### 🔴 Immediate (After Dependencies Unblocked)

- [ ] Waddah runs 8 SQL lines → `sdp.raw.*` tables queryable in Databricks
- [ ] Message Waddah through any available channel with pre-drafted content
- [ ] Clean up old stale data at `s3://tmp-sdp-data/stablecoins/`, `s3://tmp-sdp-data/network/` root level

### 🟡 Short-Term

- [ ] Add `/health` endpoint with per-table last-ingestion timestamps
- [ ] Remove unused `DATABRICKS_TOKEN` / `DATABRICKS_WAREHOUSE_ID` env vars
- [ ] Strip out legacy SQL INSERT bridge code (`databricks_push.py` with warehouse path)
- [ ] Create proper Databricks Unity Catalog metastore for the workspace

### 🔵 Medium-Term (With Paid RPC)

- [ ] Switch to Helius/QuickNode mainnet RPC
- [ ] Real whale data via `getLargestAccounts`
- [ ] Auto-discover stablecoins on mainnet via `getProgramAccounts`
- [ ] WebSocket tracks actual USDC/USDT holders
- [ ] Historical time-series for all tables

### 🟣 Long-Term

- [ ] Prometheus metrics / Grafana dashboard for pipeline health
- [ ] Alerting on ingestion failures
- [ ] Partition pruning (partition Delta tables by date)
- [ ] Multi-region S3 replication
- [ ] CI/CD pipeline for container builds + ECS deployment

---

## Appendix A: File Manifest

```
sdp-polars-api/
├── .dockerignore
├── .gitignore
├── Dockerfile
├── SETUP.md
├── app.py                          # Flask entry point
├── config.py                       # Environment config
├── requirements.txt
├── deploy/
│   ├── databricks-prod-workspace.md
│   ├── deploy-ecs.ps1
│   └── ecs-task-def.json
├── docs/
│   ├── DEVELOPMENT_LOG_SDP_POLARS_PIPELINE.md   ← This file
│   ├── waddah-message-draft.md                  ← Draft to send Waddah
│   └── plans/
│       └── 2026-07-20-data-aggregator-enhancements.md
├── queries/
│   └── databricks-analytics.sql
├── scripts/
│   ├── run-ingestion-loop.ps1
│   └── schedule-ingestion.ps1
└── src/
    ├── __init__.py
    ├── routes/
    │   ├── __init__.py
    │   ├── analytics.py
    │   ├── databricks_push.py
    │   ├── holders.py
    │   ├── ingest.py              ← /ingest/all and individual endpoints
    │   ├── insert.py
    │   ├── metrics.py
    │   ├── network.py
    │   ├── rpc.py
    │   ├── stablecoins.py
    │   ├── stablecoins_median.py
    │   └── tokens.py
    ├── services/
    │   ├── __init__.py
    │   ├── databricks_push.py     ← Legacy SQL INSERT bridge
    │   ├── ingestion.py           ← Core ingesters (stablecoins, network, holders, whales, validators)
    │   ├── s3_service.py          ← S3 read/write utilities
    │   ├── scheduler.py           ← 15-min auto-scheduler
    │   ├── solana_rpc.py          ← RPC client with retry
    │   ├── token_discovery.py     ← Token mint discovery + FALLBACK_MINTS
    │   ├── token_registry.py      ← Token UUID registry
    │   └── ws_ingestion.py        ← WebSocket holder accumulator (NEW)
    └── websocket/
        ├── connection.py          ← Async WebSocket connection manager
        ├── handlers.py            ← WebSocket message handlers
        └── routes.py              ← Flask-SocketIO routes
```

---

## Appendix B: Key Changes Made

| Date | Change | Files Affected | Impact |
|---|---|---|---|
| 2026-07-20 | **Whales validator proxy** — `fetch_whales_snapshot` falls back to `getVoteAccounts` when `getLargestAccounts` blocked | `ingestion.py` | Whales went from 0 → 17 rows |
| 2026-07-20 | **Holder three-tier fallback** — RPC → filtered WebSocket → unfiltered WebSocket | `ingestion.py`, `ws_ingestion.py` | Holders consistently returning data |
| 2026-07-20 | **Multi-URL rotation** — `_get_rpc_urls()` for RPC failover | `ingestion.py`, `solana_rpc.py` | Pipeline survives RPC failures |
| 2026-07-20 | **Per-method retry overrides** — `max_retries` and `base_delay` params | `ingestion.py` | Whales fail fast (2s), stablecoins retry longer (5s) |
| 2026-07-21 | **Devnet-only fallback mints** — removed mainnet USDC/USDT | `token_discovery.py` | Stablecoins show real devnet data instead of 0s |
| 2026-07-21 | **Symbol rename** — `USDC_DEV` → `USDC`, `PYUSD_DEV` → `PYUSD` | `token_discovery.py` | Cleaner naming on devnet |
| 2026-07-21 | **`/ingest/all` fix** — was missing holders/whales/validators | `ingest.py` | One endpoint runs all 5 ingesters |
| 2026-07-21 | **Individual endpoints** — `/ingest/holders`, `/ingest/whales`, `/ingest/validators` | `ingest.py` | Independent triggering per table |
| 2026-07-21 | **Secret scrubbing** — removed hardcoded AWS keys, Databricks tokens from docs | `SETUP.md`, `docs/plans/*.md` | Repository safe for public fork |
| 2026-07-21 | **Initial commit** — 41 files, all pipeline components | Entire repo | First tracked version in GitHub |

---

*Generated 2026-07-21. For questions, contact Johnnie Tse.*
