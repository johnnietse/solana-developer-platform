# SDP Data Aggregator — Enhancement Design

**Date**: 2026-07-20
**Status**: Draft
**Target**: sdp-polars-api (Docker container, devnet only)

## 1. Dynamic Token Discovery

### Problem
`ingestion.py` hardcodes 5 token mints (`DEFAULT_STABLECOIN_MINTS`). Adding new tokens requires code changes, rebuild, and redeploy.

### Solution
Query `getProgramAccounts` on the SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) with a data-size filter for Mint accounts (82 bytes) to discover all token mints on-chain automatically.

### Implementation

**New service: `src/services/token_discovery.py`**

```
discover_token_mints(cfg) -> list[dict]
  ├── Calls getProgramAccounts(TokenProgram, dataSize=82)
  ├── Parses Mint account data (decimals, mintAuthority, supply)
  ├── Deduplicates and caches result to S3 (token-registry/)
  └── Returns list of {mint, decimals, mintAuthority, slot}

resolve_token_symbols(mints) -> dict[mint -> symbol]
  ├── Attempts to match against known stablecoin list (configurable)
  ├── Falls back to {mint[:4]}...{mint[-4:]} for unknown tokens
  └── Returns {mint: symbol} mapping
```

**Updated: `src/services/ingestion.py`**

- `fetch_stablecoin_snapshot()` now calls `discover_token_mints()` first
- Iterates all discovered mints, calling `getTokenSupply` for each
- Filters by configurable `STABLECOIN_MINTS` env var (optional override)
- Removes `DEFAULT_STABLECOIN_MINTS` hardcoded dict

### Config changes (`config.py`)
- Add `token_discovery_enabled: bool` (default: true)
- Add `stablecoin_mints_override: str | None` (optional comma-separated mint list)

### RPC Consideration
`getProgramAccounts` can return many results. On devnet this is manageable (<1000 mints). We add:
- Pagination support (built into `getProgramAccounts` via `page` param)
- Rate-limit safety (delay between pages, max retries)

---

## 2. Expanded Data Ingestion

### Problem
Current pipeline fetches only token supply + basic network stats. Missing holder distribution, whale accounts, and validator data.

### Solution
Add three new snapshot methods to the ingestion pipeline, each writing to its own Delta table.

### New data sources

| Snapshot | RPC Method | Delta Table | Frequency | Description |
|----------|-----------|-------------|-----------|-------------|
| Top holders | `getTokenLargestAccounts` | `holders/` | Every 15 min | Top 20 holders per discovered token |
| SOL whales | `getLargestAccounts` | `whales/` | Every 15 min | Top 20 SOL accounts |
| Validators | `getVoteAccounts` | `validators/` | Every 15 min | Current + delinquent validators |

### Updated: `src/services/ingestion.py`
- `ingest_holders(cfg)` — Iterates discovered mints, calls `getTokenLargestAccounts`, writes to `holders/` Delta
- `ingest_whales(cfg)` — Calls `getLargestAccounts`, writes to `whales/` Delta
- `ingest_validators(cfg)` — Calls `getVoteAccounts`, writes to `validators/` Delta
- All three added to the scheduler's 15-minute cycle

### Schema design

**holders Delta table:**
```
mint: str, holder_address: str, amount: i64, decimals: i32, ui_amount: f64, rank: i32, scraped_at: str
```

**whales Delta table:**
```
address: str, lamports: i64, ui_balance: f64, rank: i32, scraped_at: str
```

**validators Delta table:**
```
vote_address: str, node_pubkey: str, activated_stake: i64, commission: i8, epoch_vote_account: bool, root_slot: i64, last_vote: i64, scraped_at: str
```

---

## 3. WebSocket Real-Time Data

### Problem
Existing WebSocket infrastructure (`src/websocket/`) returns mock data. It has the right architecture (connection manager, subscription handlers, SocketIO bridge) but no real Solana connection.

### Solution
Wire the existing `WebSocketConnection` class to `wss://api.devnet.solana.com` with three subscriptions.

### Subscriptions

| Subscription | Filter | What we get | How we use it |
|-------------|--------|-------------|--------------|
| `logsSubscribe` | `mentions: [TokenProgram]` | Log messages for new token transactions | Detect new transfers in real-time |
| `programSubscribe` | `programId: TokenProgram` | Account changes for token accounts | Track holder count changes |
| `slotSubscribe` | (none) | Slot notifications | Monitor network health |

### Data flow

```
Solana WS (wss://api.devnet.solana.com)
  │
  ▼
WebSocketConnection (src/websocket/connection.py)
  │  └── Auto-reconnect, exponential backoff (already built)
  ▼
SubscriptionHandler (src/websocket/handlers.py)
  │  └── Parse notifications → structured dicts
  ▼
S3 write (new persist layer)
  │  └── Write parsed events to Delta tables (events/)
  ▼
SocketIO broadcast → Dashboard
```

### New service: `src/services/ws_ingestion.py`
- `start_ws_listeners(cfg)` — Creates WS connections, subscribes to 3 channels
- `_on_logs_notification(data)` — Parses log subscription events
- `_on_program_notification(data)` — Parses program account changes
- `_on_slot_notification(data)` — Parses slot updates
- Each writes parsed data to `events/` Delta table

### Integration
- Started from `app.py` alongside the scheduler
- Runs in a background thread (separate from scheduler)
- Reconnects automatically on disconnect (already built)

---

## 4. Waddah Communication

Send the drafted Slack message (see conversation log for full text) requesting Databricks PAT + IAM role ARN for production deployment.

---

## Implementation Order

1. **Dynamic token discovery** — Foundation for everything else
2. **Expanded data ingestion** — Depends on token discovery
3. **WebSocket wiring** — Independent, can be parallel

## Testing

- Unit tests for token discovery parsing
- Integration test: start container, verify new Delta tables appear in S3
- Manual verification: query new endpoints, check data freshness
