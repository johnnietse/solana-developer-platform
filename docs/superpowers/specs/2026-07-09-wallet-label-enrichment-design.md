# Wallet Label Enrichment Design (Phase 2)

**Date:** 2026-07-09
**Status:** Approved
**Author:** Development Agent

## Overview

Phase 1 delivered a real-data analytics pipeline: a cron ingests Solana RPC
token supply + holders into Databricks every 5 minutes, and the API/dashboard
read exclusively from Databricks with no mock data. As part of that ingestion,
every discovered wallet is upserted into `wallet_labels` with default values
(`geography='Unknown'`, `attribution_category='unknown'`, `source='sdp-analytics'`).

**Phase 2 enriches `wallet_labels` with real geography and attribution data**
using free, Solana-native sources, so the dashboard's geography and attribution
charts become meaningful. Enrichment runs as a **Databricks PySpark notebook
(Option A)** on a **daily** schedule, with a one-time backfill of existing
wallets. All sources are free; Nansen/Arkham (paid) are excluded.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│              Analytics Ingestion Cron (every 5 min) — UNCHANGED       │
│  apps/sdp-api/src/crons/analytics-ingestion.ts                       │
│  Upserts discovered wallets into wallet_labels with defaults         │
│  (geography='Unknown', attribution_category='unknown')               │
└──────────────────────────┬───────────────────────────────────────────┘
                           │  wallet_labels accumulates every wallet
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Wallet Label Enrichment Notebook (NEW — Databricks)      │
│  PySpark notebook, scheduled DAILY (~02:00 UTC) + manual backfill     │
│                                                                      │
│  1. Extract unlabeled wallets from wallet_labels                     │
│     (WHERE geography='Unknown' OR attribution_category='unknown')    │
│  2. For each wallet (batched):                                       │
│     a. Helius Wallet Identity API  → attribution_category (PRIMARY)  │
│     b. SolanaFM API                → cross-verify + tags             │
│     c. Custom heuristics           → program-ID → protocol map       │
│     d. Static lists                → known exchange deposit addrs    │
│  3. Compute confidence = # agreeing sources / # consulted            │
│  4. MERGE enriched rows back into wallet_labels                     │
│  5. Report coverage % + avg confidence (validation)                  │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│              SDP API — GET /v1/data-products/analytics  (UNCHANGED)   │
│  apps/sdp-api/src/routes/data-products/analytics.ts                 │
│  Reads wallet_labels → geography + attribution distributions         │
│  Enriched values flow through automatically                         │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Dashboard (Next.js) — UNCHANGED                          │
│  apps/sdp-web/src/app/dashboard/analytics/page.tsx                  │
│  Charts aggregate wallet_labels; render real data once enriched     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Enrichment (Databricks notebook — daily + backfill)

1. Notebook reads unlabeled wallets from `wallet_labels`
   (`WHERE geography='Unknown' OR attribution_category='unknown'`).
   Joined with `token_holders` to prioritize wallets holding >$1000.
2. For each wallet batch, the notebook calls external APIs and applies
   local logic:
   - **Helius Wallet Identity API** (primary): `GET /v1/wallet/{address}/identity?api-key=...`
     returns `{ name, category }` where category ∈ {exchange, defi, institution, …}.
     Maps to `attribution_category`.
   - **SolanaFM API** (cross-verify): account/token lookups; confirms or
     contradicts Helius; contributes to confidence.
   - **Custom heuristics**: static map of known program IDs → protocol
     (Jupiter, Raydium, Orca, …) for program-owned wallets.
   - **Static lists**: public known exchange deposit addresses →
     `attribution_category='exchange:<name>'`; geography from exchange→country map.
3. `confidence` = (number of independent sources that agree) / (number consulted).
   `source_detail` = concatenated contributing source names (e.g. `"helius+solanaFM+static"`).
4. `MERGE INTO wallet_labels … WHEN MATCHED THEN UPDATE` upserts enriched rows
   idempotently. `updated_at` refreshed.
5. Report cell logs: % wallets labeled, % >$1000 wallets labeled, avg confidence,
   % labeled wallets with ≥2-source agreement.

### Geography honesty note

Precise per-wallet geography is **only reliably derivable for exchange-attributed
wallets** (via a static exchange→HQ-country map: Coinbase→USA, Kraken→USA,
Binance→"Unknown"/Global, etc.). Non-exchange wallets (DeFi protocols, individuals)
truthfully remain `geography='Unknown'`. The dashboard already handles an
"Unknown"-dominant geography distribution gracefully (100% Unknown fallback).
This is intentional — we never fabricate geography.

### Serving (API request) — unchanged from Phase 1

`analytics.ts` already queries `wallet_labels` for `geography` and
`attribution_category` distributions and filters out `'Unknown'`/`'unknown'`.
Enriched values appear automatically; no API or dashboard code changes are
required for Phase 2 core.

---

## Components

### 1. Schema extension — `wallet_labels`

**Current:** `wallet_address, geography, attribution_category, source, updated_at`

**Add (backward-compatible — API only reads `geography`/`attribution_category`):**

| Column | Type | Purpose |
|--------|------|---------|
| `confidence` | `DOUBLE` | Fraction of independent sources agreeing (0.0–1.0) |
| `source_detail` | `STRING` | Which sources contributed, e.g. `"helius+solanaFM+static"` |

- `source` becomes the primary contributing source (e.g. `"helius"`).
- `updated_at` refreshed on each enrichment.
- New ingestion rows get `confidence=0.0` default via `ALTER TABLE … ADD COLUMN`.

**Migration SQL:**
```sql
ALTER TABLE workspace.default.wallet_labels
  ADD COLUMN confidence DOUBLE DEFAULT 0.0;

ALTER TABLE workspace.default.wallet_labels
  ADD COLUMN source_detail STRING DEFAULT 'sdp-analytics';
```

### 2. Databricks PySpark enrichment notebook (NEW)

**Location:** Databricks workspace (created via Databricks MCP / Composio).
**Language:** PySpark + Python (`requests` for external APIs).

Cells:
1. **Config**: read `HELIUS_API_KEY` from Databricks secrets (optional; if absent,
   Helius is skipped). SolanaFM is called **keyless** (no secret needed).
   Set `BATCH_SIZE`, rate-limit sleeps (SolanaFM 5 RPS keyless; Helius 2 RPS if used).
   Load embedded `HEURISTICS_MAP` (program-ID → protocol) and `STATIC_EXCHANGES`
   (address → exchange name + country) from the notebook itself.
2. **Extract**: `SELECT wallet_address FROM wallet_labels WHERE geography='Unknown' OR attribution_category='unknown'`; optional join to `token_holders` for balance prioritization.
3. **Enrich** (Python UDF / pandas map): per wallet batch:
   a. Check `STATIC_EXCHANGES` → attribution `exchange:<name>`, geography from country map.
   b. Check `HEURISTICS_MAP` → attribution `<protocol>` if wallet is a known program ID.
   c. Call **SolanaFM keyless** for tags/verification (best-effort, skip on failure).
   d. Call **Helius** only if `HELIUS_API_KEY` secret present (best-effort, skip on failure).
   e. Compute `attribution_category`, `geography`, `confidence` (# agreeing sources / # consulted), `source_detail`.
4. **Load**: `MERGE INTO workspace.default.wallet_labels USING enriched_tmp … WHEN MATCHED THEN UPDATE SET …`.
5. **Report**: print coverage metrics for validation.

### 3. Databricks Job scheduling (NEW)

- **Daily job** at ~02:00 UTC running the notebook.
- **Manual trigger** for one-time backfill of the existing 3 test wallets
  (and any accumulated rows).
- Scope (user-confirmed = all): backfill existing + ongoing new wallets +
  full historical — naturally covered because `wallet_labels` accumulates
  every wallet ever seen by ingestion.

### 4. Ingestion cron — UNCHANGED

`analytics-ingestion.ts` continues to upsert wallets with defaults. No change
needed. (Optional future: set `confidence=0.0` explicitly on insert — handled
by the column default.)

### 5. API + Dashboard — UNCHANGED

`analytics.ts` and `page.tsx` require no changes for Phase 2 core. Enriched
`wallet_labels` values flow through automatically. (Optional future enhancement:
expose `confidence` in the API response and show a label-confidence badge in UI.)

---

## Data Sources (free, Solana-native)

> **Key-availability constraint (2026-07-09):** Helius requires a paid account
> (no free key obtainable) and SolanaFM's signup site is currently down. The
> enrichment is therefore designed **self-contained by default**, with external
> APIs as **optional plug-ins** gated on secret presence. No mock data is ever used.
>
> **Discovered blockers (2026-07-09, execution):**
> - The Databricks MCP exposes **SQL execution only** — it cannot create notebooks
>   or schedule jobs. Enrichment compute therefore runs as Databricks SQL; the
>   daily schedule must live in the Cloudflare Worker cron (repo code change) or
>   be created manually in the Databricks UI.
> - **SolanaFM API returns HTTP 502** (service unavailable) when tested keyless,
>   so the SolanaFM plug-in is currently non-functional.
> - **Helius** remains blocked (no key) — this is the only true blocker for
>   attributing *real holder wallets*; without it (and with SolanaFM down) only
>   program-owned wallets are labeled by the heuristic.
> - **Mainnet RPC is available free** via the public endpoint
>   `https://api.mainnet.solana.com` (no key), so real supply/holder ingestion
>   works; `getProgramAccounts` for large mints (e.g. USDC) may exceed public
>   rate/size limits and fail gracefully per-mint.
> - The current `wallet_labels` rows are **devnet test wallets** (`TestWallet111…`),
>   which are not real program IDs or known exchanges, so the self-contained
>   heuristic enrichment correctly affects 0 rows. Real enrichment requires real
>   (mainnet) wallets flowing into `wallet_labels` **and** a Helius key for
>   attribution.
>
> **Achieved so far (via Databricks MCP):** schema migration (`confidence`,
> `source_detail` columns added) and a validated, ready-to-run heuristic
> `UPDATE` mapping verified program IDs → `protocol:*`. API enrichment + daily
> scheduling remain as repo-code work (pending approval).

| Source | Free? | Active now? | Role | Rate limit |
|--------|-------|-------------|------|-----------|
| **Custom heuristics** | Yes (self-built) | ✅ Always | Program-ID → protocol map for program-owned wallets | n/a (local) |
| **Static lists** | Yes (public repos) | ✅ Always | Known exchange deposit addresses + exchange→country map | n/a (local) |
| **SolanaFM API (keyless)** | Yes ($0, **no key needed**) | ✅ Best-effort | Account/token lookups for cross-verification + tags | 5 RPS w/o key |
| **Helius Wallet Identity API** | Yes (1M credits/mo) | 🔌 Only if `HELIUS_API_KEY` secret set | Primary `attribution_category` (exchange/defi/institution; 12,500+ labels) | 2 RPS (enhanced) |
| Nansen / Arkham | **No (paid)** | ❌ Excluded | — | — |

**Confidence model:** a wallet labeled by ≥2 independent sources is treated as
high-confidence. Single-source labels are kept but flagged with lower confidence.
The notebook attempts SolanaFM keyless and Helius (if keyed); on any API failure
it degrades gracefully to heuristics + static lists only.

**Coverage expectation:** With the self-contained core (heuristics + static lists
+ keyless SolanaFM), exchange and major-protocol wallets are labeled; the majority
of individual holder wallets truthfully remain `"Unknown"`. The ≥80%-of->$1000
target is reached only once Helius is wired in via secret.

---

## Success Criteria (validation)

The notebook report cell asserts:

- **Minimum:** ≥50% of all wallets have non-`"Unknown"` attribution.
- **Target:** ≥80% of wallets holding >$1000 are labeled.
- **Quality:** ≥90% of *labeled* wallets have ≥2-source agreement
  (`confidence` ≥ threshold) — proxy for "<5% misattribution" (no ground-truth oracle).
- **Manual spot-check:** 1–2 known exchange addresses verified correct.

---

## Prerequisites / Setup

- Obtain **free** Helius API key; (optional) SolanaFM API key.
- Store both in **Databricks secrets** (`HELIUS_API_KEY`, `SOLANAFM_API_KEY`).
- `ALTER TABLE` to add `confidence`, `source_detail` (migration SQL above).
- Create notebook + daily job in Databricks (via Databricks MCP / Composio).
- Run manual backfill job once; verify coverage metrics.

## Production Configuration (Option C) — for when you deploy for real

The repo's `wrangler.toml` ships with **Option B active** (free public mainnet RPC
+ smaller token) and **Option C commented out**. To switch to production-grade:

```toml
# In [env.production.vars]:
ANALYTICS_MINTS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC (real stablecoin)
ANALYTICS_RPC_URL = "https://your-dedicated-rpc.example.com"        # dedicated RPC (paid)
HELIUS_API_KEY    = "your-helius-key"                               # enables attribution (free tier may suffice)
```

Why Option C for production (not B):
- Public RPC is **not for production** (Solana docs): rate-limited, may 403-block,
  and cannot return USDC-scale `getProgramAccounts`.
- Production tracks **real stablecoins** (USDC/USDT/PYUSD), not a small test token.
- **Attribution needs Helius** (or equivalent managed label source); the heuristic
  alone is insufficient for production-grade labels.

Cost note: dedicated RPC is paid (start small); Helius may be **free** on its
1M-credits/mo tier — verify it covers your enrichment volume.

Option B remains the free dev/demo path: real holders flow in for $0, unlabeled
until a Helius key is added.

---

## Files to Create / Modify

### Create
- Databricks PySpark notebook: `wallet_label_enrichment` (in Databricks workspace)
- Databricks Job: daily schedule + manual backfill trigger

### Modify (Databricks DDL)
- `wallet_labels` table: `ADD COLUMN confidence DOUBLE`, `ADD COLUMN source_detail STRING`

### No code changes required (Phase 2 core)
- `apps/sdp-api/src/crons/analytics-ingestion.ts` — unchanged
- `apps/sdp-api/src/routes/data-products/analytics.ts` — unchanged
- `apps/sdp-web/src/app/dashboard/analytics/page.tsx` — unchanged
- `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts` — unchanged

---

## Migration Path

### Phase 2a — Schema + Setup
1. `ALTER TABLE` add `confidence`, `source_detail`.
2. Store API keys in Databricks secrets.
3. Create enrichment notebook + daily job.

### Phase 2b — Backfill + Ongoing
1. Run manual backfill on existing 3 test wallets (+ any accumulated).
2. Verify coverage metrics meet success criteria.
3. Enable daily job for ongoing enrichment of newly discovered wallets.

### Future (out of scope)
- Expose `confidence` in API response; show label-confidence badge in dashboard.
- Add Dune Analytics as an additional source (Approach 3, deferred).
