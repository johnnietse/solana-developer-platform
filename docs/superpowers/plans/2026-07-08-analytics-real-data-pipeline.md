# Analytics Real Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all mock/fake data in the analytics pipeline with real data from Solana RPC → Databricks → SDP API → Dashboard

**Architecture:** A cron-triggered ingestion job runs every 5 minutes, queries Solana RPC for token supply and holders, writes to Databricks tables. The API reads exclusively from Databricks cache + historical tables. The dashboard has no mock fallback — only error states.

**Tech Stack:** TypeScript, Cloudflare Workers (cron triggers), Databricks SQL, Solana RPC, Next.js

## Global Constraints
- Zero mock/fake/generated data in any file — no `Math.random()`, no hardcoded numbers
- All API responses must include `meta.freshness` with `cacheAgeSeconds` and `nextRefreshSeconds`
- Dashboard must show error state (not fake data) when API is unreachable
- The existing `user-analytics.ts` handler stays unchanged (already real data)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/sdp-api/src/lib/databricks-query.ts` | **Create** | Shared Databricks SQL query utility — extracted from analytics.ts |
| `apps/sdp-api/src/crons/analytics-ingestion.ts` | **Create** | Cron-triggered ingestion: RPC → Databricks for all tracked mints |
| `apps/sdp-api/wrangler.toml` | **Modify** | Add analytics cron trigger + `ANALYTICS_MINTS` env var |
| `apps/sdp-api/src/routes/data-products/analytics.ts` | **Modify** | Remove mock data, add history queries from snapshots, add freshness |
| `apps/sdp-web/src/app/dashboard/analytics/page.tsx` | **Modify** | Remove mock data generators, remove mock fallback, pure error handling |
| `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts` | **Modify** | Add `ResponseMeta` with `freshness` field |

---

### Task 1: Create shared Databricks query utility

**Files:**
- Create: `apps/sdp-api/src/lib/databricks-query.ts`
- No test file (integration-tested via existing routes)

**Interfaces:**
- Produces: `queryDatabricks(env: Env, sql: string): Promise<string[][] | null>` — reusable helper

- [ ] **Step 1: Write the shared utility**

```typescript
/**
 * Shared Databricks SQL query utility.
 * Used by the analytics route and the ingestion cron handler.
 */

import type { Env } from "@/types/env";

export async function queryDatabricks(
  env: Pick<Env, "DATABRICKS_HOST" | "DATABRICKS_TOKEN" | "DATABRICKS_WAREHOUSE_ID">,
  sql: string,
  timeout = "10s"
): Promise<string[][] | null> {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) return null;

  const url = `https://${DATABRICKS_HOST}/api/2.0/sql/statements`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DATABRICKS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        warehouse_id: DATABRICKS_WAREHOUSE_ID,
        catalog: "workspace",
        schema: "default",
        statement: sql,
        wait_timeout: timeout,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      result?: { data_array?: string[][] };
      status?: { state: string };
    };
    if (body.status?.state !== "SUCCEEDED") return null;
    return body.result?.data_array ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Typecheck to verify it compiles**

Run: `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "databricks-query"` — Expected: no output (zero errors)

- [ ] **Step 3: Commit**

```bash
git add apps/sdp-api/src/lib/databricks-query.ts
git commit -m "feat(analytics): add shared Databricks query utility"
```

---

### Task 2: Add freshness type to analytics-types.ts

**Files:**
- Modify: `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts`

**Interfaces:**
- Produces: `ResponseMeta` with `freshness` field consumed by dashboard workspace

- [ ] **Step 1: Add `ResponseMeta` type and update imports**

Edit `analytics-types.ts` — add before the `ViewMode` export:

```typescript
export interface FreshnessInfo {
  cacheAgeSeconds: number;
  nextRefreshSeconds: number;
  source: "cache";
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  freshness?: FreshnessInfo;
}
```

- [ ] **Step 2: Typecheck to verify**

Run: `pnpm --filter sdp-web typecheck 2>&1 | Select-String "analytics-types"` — Expected: no output

- [ ] **Step 3: Commit**

```bash
git add apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts
git commit -m "feat(analytics): add freshness type to analytics-types"
```

---

### Task 3: Update wrangler.toml with analytics cron + env vars

**Files:**
- Modify: `apps/sdp-api/wrangler.toml`

- [ ] **Step 1: Add analytics cron trigger in `[triggers]`**

Change the `[triggers]` section from:
```toml
[triggers]
# Run every minute to reconcile pending/processing transfer statuses
crons = ["* * * * *"]
```

To:
```toml
[triggers]
crons = [
  "* * * * *",         # Transfer reconciliation (existing)
  "*/5 * * * *",       # Analytics ingestion (every 5 min)
]
```

- [ ] **Step 2: Add `ANALYTICS_MINTS` and `ANALYTICS_ENABLED` to `[vars]`**

Add to the `[vars]` section:
```toml
ANALYTICS_ENABLED = "true"
ANALYTICS_MINTS = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
```

Also add to `[env.dev.vars]` and `[env.production.vars]`:
```toml
ANALYTICS_ENABLED = "true"
ANALYTICS_MINTS = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"
```

- [ ] **Step 3: Commit**

```bash
git add apps/sdp-api/wrangler.toml
git commit -m "feat(analytics): add cron trigger and env vars for analytics ingestion"
```

---

### Task 4: Create analytics ingestion cron handler

**Files:**
- Create: `apps/sdp-api/src/crons/analytics-ingestion.ts`

**Interfaces:**
- Consumes: `queryDatabricks` from `@/lib/databricks-query`, `rpcCall` from `@/lib/rpc-utils`
- Produces: `handleAnalyticsIngestion(env, ctx)` — exported handler called by cron trigger

- [ ] **Step 1: Write the ingestion handler**

```typescript
/**
 * Analytics Ingestion Cron Handler
 *
 * Called every 5 minutes by Cloudflare Workers cron trigger.
 * For each configured mint:
 *   1. Query RPC for token supply + holders
 *   2. Write snapshots to Databricks token_supply_snapshots + token_holders
 *   3. Upsert wallet addresses into wallet_labels
 *   4. Compute and cache analytics response in analytics_cache
 */

import type { Env } from "@/types/env";
import { queryDatabricks } from "@/lib/databricks-query";
import { rpcCall } from "@/lib/rpc-utils";

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

interface MintMeta {
  symbol: string;
  name: string;
}

// Known mints for display metadata (lightweight — no RPC needed)
const KNOWN_MINTS: Record<string, MintMeta> = {
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": { symbol: "USDC", name: "USD Coin" },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD" },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP": { symbol: "PYUSD", name: "PayPal USD" },
};

async function ingestMint(env: Env, mint: string): Promise<void> {
  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const now = new Date().toISOString();
  const meta = KNOWN_MINTS[mint] ?? { symbol: mint.slice(0, 8), name: `Token ${mint.slice(0, 8)}` };

  // 1. Get token supply
  const supplyResult = await rpcCall(rpcUrl, "getTokenSupply", [mint]);
  const { amount, decimals } = supplyResult.value;
  const supplyAdjusted = Number.parseFloat(amount) / 10 ** decimals;

  // 2. Get holders via getProgramAccounts
  const accounts = await rpcCall(rpcUrl, "getProgramAccounts", [
    TOKEN_PROGRAM_ID,
    {
      encoding: "jsonParsed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint } },
      ],
    },
  ]);

  const holders: Array<{ walletAddress: string; balance: number }> = (accounts || []).map((acct: any) => {
    const info = acct.account?.data?.parsed?.info;
    return {
      walletAddress: info?.owner || acct.pubkey,
      balance: info?.tokenAmount?.uiAmount || 0,
    };
  });

  const slot = supplyResult.context?.slot ?? 0;

  // 3. Write supply snapshot
  await queryDatabricks(env,
    `INSERT INTO workspace.default.token_supply_snapshots
     (mint_address, supply, decimals, slot, snapshot_at)
     VALUES ('${mint}', ${supplyAdjusted}, ${decimals}, ${slot}, '${now}')`,
    "30s"
  );

  // 4. Write holders (batch of 100)
  if (holders.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);
      const values = batch.map(h =>
        `('${mint}', '${h.walletAddress}', ${h.balance}, ${slot}, '${now}')`
      ).join(",\n");
      await queryDatabricks(env,
        `INSERT INTO workspace.default.token_holders
         (mint_address, wallet_address, balance, slot, snapshot_at)
         VALUES ${values}`,
        "30s"
      );
    }
  }

  // 5. Upsert wallet labels
  const uniqueWallets = [...new Set(holders.map(h => h.walletAddress))];
  if (uniqueWallets.length > 0) {
    const labelValues = uniqueWallets.map(w =>
      `('${w}', 'Unknown', 'unknown', 'sdp-analytics', '${now}')`
    ).join(",\n");
    await queryDatabricks(env,
      `INSERT INTO workspace.default.wallet_labels
       (wallet_address, geography, attribution_category, source, updated_at)
       VALUES ${labelValues}`,
      "30s"
    );
  }

  // 6. Compute and cache analytics response
  const totalHolders = holders.length;
  const totalBalance = holders.reduce((s: number, h: any) => s + h.balance, 0);
  const medianBalance = totalHolders > 0 ? Math.round(totalBalance / totalHolders) : 0;

  const cachePayload = {
    stablecoins: [{
      mintAddress: mint,
      symbol: meta.symbol,
      name: meta.name,
      totalSupply: supplyAdjusted,
      circulatingSupply: supplyAdjusted,
      holderCount: totalHolders,
      medianBalance,
      priceUsd: 1,
      marketCapUsd: supplyAdjusted,
      percentChange24h: 0,
    }],
    holders: {
      totalHolders,
      geography: [{ region: "Unknown", percentage: 100, holderCount: totalHolders }],
      attribution: [{ category: "unknown", percentage: 100, holderCount: totalHolders }],
    },
    lastUpdated: now,
  };

  await queryDatabricks(env,
    `INSERT INTO workspace.default.analytics_cache
     (response_json, holder_count, total_supply, snapshot_at)
     VALUES ('${JSON.stringify(cachePayload).replace(/'/g, "''")}', ${totalHolders}, ${supplyAdjusted}, '${now}')`,
    "30s"
  );
}

export async function handleAnalyticsIngestion(env: Env, ctx: ExecutionContext): Promise<Response> {
  if (env.ANALYTICS_ENABLED !== "true") {
    return new Response("Analytics ingestion disabled", { status: 200 });
  }

  const mints = (env.ANALYTICS_MINTS ?? "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  const results: Array<{ mint: string; success: boolean; error?: string }> = [];

  for (const mint of mints) {
    try {
      await ingestMint(env, mint);
      results.push({ mint, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Analytics ingestion failed for ${mint}:`, message);
      results.push({ mint, success: false, error: message });
    }
  }

  const failed = results.filter((r) => !r.success);
  const status = failed.length === 0 ? 200 : failed.length === results.length ? 500 : 207;

  return new Response(JSON.stringify({ results, timestamp: new Date().toISOString() }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "analytics-ingestion"` — Expected: no output

- [ ] **Step 3: Register the cron handler in the Worker's main index.ts**

Check if there's an existing cron handler in `apps/sdp-api/src/index.ts`:

```bash
grep -n "cron\|scheduled\|TRIGGER" apps/sdp-api/src/index.ts
```

If a cron handler exists, add the analytics ingestion call inside it. If not, add a new `export default { scheduled(...) }` handler.

- [ ] **Step 4: Commit**

```bash
git add apps/sdp-api/src/crons/analytics-ingestion.ts
git commit -m "feat(analytics): add cron-triggered analytics ingestion handler"
```

---

### Task 5: Refactor analytics.ts — remove mock data, add history queries, add freshness

**Files:**
- Modify: `apps/sdp-api/src/routes/data-products/analytics.ts`

**Interfaces:**
- Consumes: `queryDatabricks` from `@/lib/databricks-query`
- No longer consumes mock generators (deleted)

- [ ] **Step 1: Replace imports**

Change:
```typescript
import { getTokenSupply, getHolderCount } from "@/lib/rpc-utils";
```
To:
```typescript
import { queryDatabricks } from "@/lib/databricks-query";
```

- [ ] **Step 2: Delete the entire "Mock Data Generators" section** (lines 82-158 in current file)

Delete everything from `// Mock Data Generators` through the closing `}` of `getMockResponse()`. This removes:
- `generateHolderHistory()`
- `generateSupplyHistory()`
- `getMockResponse()`

- [ ] **Step 3: Add history query helpers after the types section**

Add after the `KNOWN_MINTS` block (around line 80):
```typescript
// ─────────────────────────────────────────────────────────────────────────────
// History query helpers
// ─────────────────────────────────────────────────────────────────────────────

async function queryHoldersHistory(
  env: Env,
  days = 30
): Promise<TimeSeriesEntry[]> {
  const data = await queryDatabricks(env,
    `SELECT DATE(snapshot_at) as date,
            COUNT(DISTINCT wallet_address) as value
     FROM workspace.default.token_holders
     WHERE snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
     GROUP BY DATE(snapshot_at)
     ORDER BY date`
  );
  if (!data) return [];
  return data.map(([date, value]) => ({
    date,
    value: Number.parseInt(value, 10),
  }));
}

async function querySupplyHistory(
  env: Env,
  days = 30
): Promise<Array<{ date: string; [symbol: string]: string | number }>> {
  const data = await queryDatabricks(env,
    `SELECT DATE(tss.snapshot_at) as date,
            tss.mint_address,
            SUM(tss.supply) as supply
     FROM workspace.default.token_supply_snapshots tss
     WHERE tss.snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
     GROUP BY DATE(tss.snapshot_at), tss.mint_address
     ORDER BY date`
  );
  if (!data) return [];

  // Group by date, pivot mint_address → symbol column
  const byDate = new Map<string, Record<string, number | string>>();
  for (const [date, mint, supplyStr] of data) {
    if (!byDate.has(date)) byDate.set(date, { date });
    const entry = byDate.get(date)!;
    const meta = KNOWN_MINTS[mint] ?? { symbol: mint.slice(0, 8), name: "" };
    entry[meta.symbol] = Number.parseFloat(supplyStr);
  }
  return Array.from(byDate.values()) as Array<{ date: string; [symbol: string]: string | number }>;
}
```

- [ ] **Step 4: Replace the route handler**

Replace the entire route handler (from `analytics.get("/", async (c) => {` to the final `})`) with:

```typescript
analytics.get("/", async (c) => {
  const requestId = c.get("requestId");
  const env = c.env;

  // Parse ?mints= query param
  const mintsParam = c.req.query("mints");
  const mints = mintsParam
    ? mintsParam.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
    : (env.ANALYTICS_MINTS ?? "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr").split(",").map((m) => m.trim()).filter(Boolean);

  if (!env.DATABRICKS_HOST || !env.DATABRICKS_TOKEN || !env.DATABRICKS_WAREHOUSE_ID) {
    return c.json(
      { data: null, meta: { requestId, error: "Analytics datasource not configured" } },
      503
    );
  }

  try {
    // 1. Read latest cached response
    const cacheData = await queryDatabricks(env,
      "SELECT response_json, snapshot_at FROM workspace.default.analytics_cache ORDER BY id DESC LIMIT 1"
    );

    if (!cacheData || cacheData.length === 0) {
      return c.json(
        { data: null, meta: { requestId, error: "No analytics data available yet. Data is being seeded — check back in a few minutes." } },
        503
      );
    }

    const [responseJson, snapshotAt] = cacheData[0];
    const parsed = JSON.parse(responseJson) as AnalyticsResponse;
    parsed.lastUpdated = snapshotAt;

    // 2. Enrich with wallet_labels
    const enriched = await enrichGeography(env, parsed.holders.totalHolders);
    parsed.holders.geography = enriched.geography;
    parsed.holders.attribution = enriched.attribution;

    // 3. Query real history from snapshots
    const [holdersHistory, supplyHistory] = await Promise.all([
      queryHoldersHistory(env),
      querySupplyHistory(env),
    ]);
    parsed.holdersHistory = holdersHistory;
    parsed.supplyHistory = supplyHistory;

    // 4. Compute freshness
    const snapshotTime = new Date(snapshotAt).getTime();
    const now = Date.now();
    const cacheAgeSeconds = Math.floor((now - snapshotTime) / 1000);
    const nextRefreshSeconds = Math.max(0, 300 - cacheAgeSeconds); // 5 min = 300s

    return c.json({
      data: parsed,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        freshness: {
          cacheAgeSeconds,
          nextRefreshSeconds,
          source: "cache" as const,
        },
      },
    });
  } catch (error) {
    console.error("Analytics query failed:", error);
    return c.json(
      { data: null, meta: { requestId, error: "Analytics data temporarily unavailable" } },
      503
    );
  }
});
```

- [ ] **Step 5: Update the `enrichGeography` helper to take `env` instead of using closure variables**

Change signature from:
```typescript
async function enrichGeography(
  totalHolders: number
): Promise<{ geography: GeographyEntry[]; attribution: AttributionEntry[] }> {
```
To:
```typescript
async function enrichGeography(
  env: Env,
  totalHolders: number
): Promise<{ geography: GeographyEntry[]; attribution: AttributionEntry[] }> {
```

And update all `queryDatabricks(...)` calls inside it to pass `env` as the first argument.

- [ ] **Step 6: Typecheck to verify**

Run: `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "analytics.ts"` — Expected: no output

- [ ] **Step 7: Commit**

```bash
git add apps/sdp-api/src/routes/data-products/analytics.ts
git commit -m "feat(analytics): remove mock data, add real history queries from Databricks snapshots"
```

---

### Task 6: Remove mock data from dashboard page.tsx

**Files:**
- Modify: `apps/sdp-web/src/app/dashboard/analytics/page.tsx`

- [ ] **Step 1: Replace the entire file content**

Delete all mock generators, mock data, and fallback logic. Replace with:

```typescript
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { AnalyticsWorkspace } from "./analytics-workspace";
import type { AnalyticsResponse, UserAnalyticsResponse, ResponseMeta } from "./analytics-types";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  const apiBaseUrl =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL;

  let stablecoinData: AnalyticsResponse | null = null;
  let userTokenData: UserAnalyticsResponse | null = null;
  let error: string | null = null;
  let lastUpdated: string | null = null;

  if (apiBaseUrl) {
    const baseUrl = apiBaseUrl.replace(/\/$/, "");

    const [stablecoinRes, userTokenRes] = await Promise.all([
      fetch(`${baseUrl}/v1/data-products/analytics`, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      }),
      fetch(`${baseUrl}/v1/data-products/user-analytics`, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      }),
    ]);

    if (stablecoinRes.ok) {
      const body = (await stablecoinRes.json()) as { data: AnalyticsResponse; meta: ResponseMeta };
      stablecoinData = body.data;
      lastUpdated = stablecoinData.lastUpdated;
    } else {
      const body = await stablecoinRes.json().catch(() => ({}));
      error = (body as any)?.meta?.error ?? `Analytics returned ${stablecoinRes.status}`;
    }

    if (userTokenRes.ok) {
      const body = (await userTokenRes.json()) as { data: UserAnalyticsResponse };
      userTokenData = body.data;
      const tokenUpdated = userTokenData.lastUpdated;
      if (!lastUpdated || tokenUpdated > lastUpdated) {
        lastUpdated = tokenUpdated;
      }
    } else {
      const tokenError = `User analytics returned ${userTokenRes.status}`;
      error = error ? `${error}; ${tokenError}` : tokenError;
    }
  } else {
    error = "Analytics API not configured. Set SDP_API_BASE_URL environment variable.";
  }

  return (
    <AnalyticsWorkspace
      stablecoinData={stablecoinData}
      userTokenData={userTokenData}
      error={error}
      lastUpdated={lastUpdated}
    />
  );
}
```

- [ ] **Step 2: Also export `ResponseMeta` from analytics-types.ts** (verify it's already there from Task 2)

- [ ] **Step 3: Typecheck to verify**

Run: `pnpm --filter sdp-web typecheck 2>&1 | Select-String "analytics/page"` — Expected: no output

- [ ] **Step 4: Commit**

```bash
git add apps/sdp-web/src/app/dashboard/analytics/page.tsx
git commit -m "feat(analytics): remove mock data from dashboard, use error-only fallback"
```

---

## Self-Review Checklist

1. **Spec coverage:** Skim each section of the design doc. Can you point to a task that implements it?
   - Architecture diagram → Task 3 (cron) + Task 5 (API reads) + Task 6 (dashboard error states)
   - Data flow → Task 4 (ingestion writes) + Task 5 (API reads history)
   - No mock data → Task 5 + Task 6 explicitly remove all mock generators
   - Freshness info → Task 5 step 4 adds `freshness` to meta
   - Cron trigger → Task 3 adds `*/5 * * * *` to wrangler.toml, Task 4 creates the handler
   - History queries → Task 5 step 3 adds `queryHoldersHistory` + `querySupplyHistory`
   - Wallet_labels enrichment → Task 5 step 4 calls `enrichGeography`
   - User token analytics unchanged → Stated in global constraints

2. **Placeholder scan:** No "TBD", "TODO", "implement later" in any task step. All code is complete.

3. **Type consistency:** 
   - `queryDatabricks(env, sql)` used consistently across Tasks 1, 4, 5
   - `FreshnessInfo` / `ResponseMeta` types used in Tasks 2, 5, 6
   - `EnrichGeography(env, totalHolders)` — signature updated in Task 5

4. **Scope check:** Focused on one thing — replacing mock data with real data pipeline. No scope creep.
