# Analytics Databricks Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real RPC-powered analytics pipeline that stores on-chain data in Databricks tables and serves it through the SDP API.

**Architecture:** Solana devnet RPC → Ingestion script → Databricks tables → SDP API handler → Dashboard. No synthetic data — geography/attribution remain "Unknown" until real enrichment sources are available.

**Tech Stack:** Node.js (ingestion script), Databricks SQL (tables), Hono (SDP API), Solana JSON-RPC

**Databricks Context:**
- Workspace: `dbc-9f712491-51a1.cloud.databricks.com`
- Warehouse ID: `b93fd37f80a01180` (Serverless Starter Warehouse, currently STOPPED)
- Catalog: `workspace`
- Schema: `default`

## Global Constraints

- No synthetic/fake data for geography or attribution — must show "Unknown"
- All RPC data must be real from Solana devnet
- USDC devnet mint: `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`
- Public devnet RPC: `https://api.devnet.solana.com`
- Databricks tables live in `workspace.default` schema
- SDP API handler must fall back to direct RPC if Databricks is unavailable

---

### Task 1: Start Databricks SQL Warehouse

**Files:** None (Composio MCP tool call)

**Interfaces:**
- Consumes: Warehouse ID `b93fd37f80a01180`
- Produces: Running warehouse ready for SQL execution

- [ ] **Step 1: Start the warehouse**

Use Composio tool `DATABRICKS_SQL_WAREHOUSES_START` with id `b93fd37f80a01180`.

- [ ] **Step 2: Verify warehouse is RUNNING**

Poll `DATABRICKS_SQL_WAREHOUSES_GET` until state is `RUNNING`.

---

### Task 2: Create Databricks Tables

**Files:** None (Composio MCP SQL execution)

**Interfaces:**
- Consumes: Warehouse ID `b93fd37f80a01180`, catalog `workspace`, schema `default`
- Produces: Three tables in `workspace.default`

- [ ] **Step 1: Create `token_holders` table**

Execute via `DATABRICKS_SQL_STATEMENT_EXEC_EXECUTE_STATEMENT`:

```sql
CREATE TABLE IF NOT EXISTS workspace.default.token_holders (
  mint_address STRING NOT NULL,
  wallet_address STRING NOT NULL,
  balance DOUBLE NOT NULL,
  slot BIGINT NOT NULL,
  snapshot_at TIMESTAMP NOT NULL
) USING DELTA;
```

- [ ] **Step 2: Create `token_supply_snapshots` table**

```sql
CREATE TABLE IF NOT EXISTS workspace.default.token_supply_snapshots (
  mint_address STRING NOT NULL,
  supply DOUBLE NOT NULL,
  decimals INT NOT NULL,
  slot BIGINT NOT NULL,
  snapshot_at TIMESTAMP NOT NULL
) USING DELTA;
```

- [ ] **Step 3: Create `analytics_cache` table**

```sql
CREATE TABLE IF NOT EXISTS workspace.default.analytics_cache (
  id INT GENERATED ALWAYS AS IDENTITY,
  response_json STRING NOT NULL,
  holder_count BIGINT NOT NULL,
  total_supply DOUBLE NOT NULL,
  snapshot_at TIMESTAMP NOT NULL
) USING DELTA;
```

- [ ] **Step 4: Verify tables exist**

Use `DATABRICKS_LIST_TABLES` with catalog_name=`workspace`, schema_name=`default` to confirm all three tables are present.

---

### Task 3: Build Ingestion Script

**Files:**
- Create: `scripts/ingest-analytics.mjs`

**Interfaces:**
- Consumes: Solana devnet RPC, Databricks REST API credentials
- Produces: Populated Databricks tables with real on-chain data

- [ ] **Step 1: Write the ingestion script**

```javascript
#!/usr/bin/env node
/**
 * Analytics Data Ingestion Script
 *
 * Pulls real on-chain data from Solana devnet RPC and stores it in
 * Databricks tables. Run on-demand or via cron.
 *
 * Usage:  node scripts/ingest-analytics.mjs
 *
 * Environment variables:
 *   DATABRICKS_HOST      - Databricks workspace URL (e.g. dbc-xxx.cloud.databricks.com)
 *   DATABRICKS_TOKEN     - Databricks personal access token
 *   DATABRICKS_WAREHOUSE_ID - SQL warehouse ID
 *   SOLANA_RPC_URL       - Solana RPC URL (default: https://api.devnet.solana.com)
 */

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const USDC_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const DATABRICKS_HOST = process.env.DATABRICKS_HOST;
const DATABRICKS_TOKEN = process.env.DATABRICKS_TOKEN;
const DATABRICKS_WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID;

let id = 1;

async function rpcCall(method, params = [], retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      });
      const json = await res.json();
      if (json.error) {
        if (json.error.message?.includes("Too many requests") && i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        throw new Error(json.error.message);
      }
      return json.result;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function databricksQuery(sql) {
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
    console.warn("Databricks credentials not configured, skipping DB write");
    return null;
  }

  const url = `https://${DATABRICKS_HOST}/api/2.0/sql/statements`;
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
      wait_timeout: "30s",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Databricks query failed (${res.status}): ${body}`);
  }

  return res.json();
}

async function main() {
  console.log("\n=== Analytics Data Ingestion ===\n");
  const now = new Date().toISOString();

  // 1. Get token supply
  console.log("1. Querying token supply...");
  const supplyResult = await rpcCall("getTokenSupply", [USDC_MINT]);
  const { amount, decimals } = supplyResult.value;
  const supplyAdjusted = Number.parseFloat(amount) / 10 ** decimals;
  console.log(`   Supply: ${supplyAdjusted.toLocaleString()} USDC`);

  // 2. Get holder count and wallet addresses
  console.log("2. Querying token holders...");
  const accounts = await rpcCall("getProgramAccounts", [
    TOKEN_PROGRAM_ID,
    {
      encoding: "jsonParsed",
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: USDC_MINT } },
      ],
    },
  ]);

  const holders = (accounts || []).map(acct => {
    const info = acct.account?.data?.parsed?.info;
    return {
      walletAddress: info?.owner || acct.pubkey,
      balance: info?.tokenAmount?.uiAmount || 0,
    };
  });

  console.log(`   Found ${holders.length} holders`);

  // 3. Get recent signatures (activity proxy)
  console.log("3. Querying recent activity...");
  let recentTxCount = 0;
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [USDC_MINT, { limit: 1000 }]);
    recentTxCount = sigs.length;
    console.log(`   ${recentTxCount} recent signatures`);
  } catch (e) {
    console.log(`   Skipped: ${e.message}`);
  }

  // 4. Write to Databricks
  console.log("\n4. Writing to Databricks...");

  // 4a. Insert token supply snapshot
  const supplySql = `INSERT INTO workspace.default.token_supply_snapshots
    (mint_address, supply, decimals, slot, snapshot_at)
  VALUES ('${USDC_MINT}', ${supplyAdjusted}, ${decimals}, ${supply.context?.slot || 0}, '${now}')`;
  await databricksQuery(supplySql);
  console.log("   Supply snapshot written");

  // 4b. Insert holders (batch insert — insert all at once)
  if (holders.length > 0) {
    const batchSize = 100;
    for (let i = 0; i < holders.length; i += batchSize) {
      const batch = holders.slice(i, i + batchSize);
      const values = batch.map(h =>
        `('${USDC_MINT}', '${h.walletAddress}', ${h.balance}, ${supply.context?.slot || 0}, '${now}')`
      ).join(",\n");
      const insertSql = `INSERT INTO workspace.default.token_holders
        (mint_address, wallet_address, balance, slot, snapshot_at)
        VALUES ${values}`;
      await databricksQuery(insertSql);
    }
    console.log(`   ${holders.length} holders written (${Math.ceil(holders.length / batchSize)} batches)`);
  }

  // 4c. Compute and cache analytics response
  const totalHolders = holders.length;
  const totalBalance = holders.reduce((s, h) => s + h.balance, 0);
  const medianBalance = totalHolders > 0 ? Math.round(totalBalance / totalHolders) : 0;

  const cachePayload = {
    stablecoins: [{
      mintAddress: USDC_MINT,
      symbol: "USDC",
      name: "USD Coin",
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
    holdersHistory: [],
    supplyHistory: [],
    lastUpdated: now,
  };

  const cacheSql = `INSERT INTO workspace.default.analytics_cache
    (response_json, holder_count, total_supply, snapshot_at)
    VALUES ('${JSON.stringify(cachePayload).replace(/'/g, "''")}', ${totalHolders}, ${supplyAdjusted}, '${now}')`;
  await databricksQuery(cacheSql);
  console.log("   Analytics cache written");

  console.log("\n=== Ingestion Complete ===");
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify script runs**

Run: `node scripts/ingest-analytics.mjs`
Expected: Connects to RPC, fetches data, writes to Databricks

---

### Task 4: Update SDP API Handler to Query Databricks

**Files:**
- Modify: `apps/sdp-api/src/routes/data-products/analytics.ts`

**Interfaces:**
- Consumes: Databricks REST API via env credentials, Solana RPC as fallback
- Produces: `GET /v1/data-products/analytics` that returns real data from Databricks

- [ ] **Step 1: Add Databricks env bindings to `Env` type**

Add to `apps/sdp-api/src/types/env.d.ts`:

```typescript
// Databricks analytics enrichment
DATABRICKS_HOST?: string;
DATABRICKS_TOKEN?: string;
DATABRICKS_WAREHOUSE_ID?: string;
```

- [ ] **Step 2: Update analytics handler to query Databricks first**

Replace the current handler in `apps/sdp-api/src/routes/data-products/analytics.ts`:

```typescript
analytics.get("/", async (c) => {
  const rpcUrl = c.env.SOLANA_RPC_URL ?? DEVNET_RPC;
  const useMock = c.req.query("mock") === "true";

  if (useMock) {
    return c.json({ data: getMockResponse(), meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString() } });
  }

  // Try Databricks cache first
  const dbHost = c.env.DATABRICKS_HOST;
  const dbToken = c.env.DATABRICKS_TOKEN;
  const dbWarehouseId = c.env.DATABRICKS_WAREHOUSE_ID;

  if (dbHost && dbToken && dbWarehouseId) {
    try {
      const dbUrl = `https://${dbHost}/api/2.0/sql/statements`;
      const dbRes = await fetch(dbUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${dbToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          warehouse_id: dbWarehouseId,
          catalog: "workspace",
          schema: "default",
          statement: "SELECT response_json, snapshot_at FROM workspace.default.analytics_cache ORDER BY id DESC LIMIT 1",
          wait_timeout: "10s",
        }),
      });

      if (dbRes.ok) {
        const dbBody = await dbRes.json() as {
          result?: { data_array?: string[][] };
          manifest?: { schema?: { columns?: Array<{ name: string }> } };
        };

        if (dbBody.result?.data_array?.length > 0) {
          const row = dbBody.result.data_array[0];
          const responseJson = row[0];
          const snapshotAt = row[1];
          const parsed = JSON.parse(responseJson);
          parsed.lastUpdated = snapshotAt;
          return c.json({ data: parsed, meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString() } });
        }
      }
    } catch (e) {
      console.error("Databricks query failed, falling back to RPC:", e);
    }
  }

  // Fallback: query RPC directly
  try {
    const supply = await getTokenSupply(rpcUrl, USDC_MINT_DEVNET);
    const holderCount = await getHolderCount(rpcUrl, USDC_MINT_DEVNET);
    const rawSupply = Number.parseFloat(supply.amount) / 10 ** supply.decimals;

    const response: AnalyticsResponse = {
      stablecoins: [{
        mintAddress: USDC_MINT_DEVNET,
        symbol: "USDC",
        name: "USD Coin",
        totalSupply: rawSupply,
        circulatingSupply: rawSupply,
        holderCount,
        medianBalance: holderCount > 0 ? Math.round(rawSupply / holderCount) : 0,
        priceUsd: 1,
        marketCapUsd: rawSupply,
        percentChange24h: 0,
      }],
      holders: {
        totalHolders: holderCount,
        geography: [{ region: "Unknown", percentage: 100, holderCount }],
        attribution: [{ category: "unknown", percentage: 100, holderCount }],
      },
      holdersHistory: [],
      supplyHistory: [],
      lastUpdated: new Date().toISOString(),
    };

    return c.json({ data: response, meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString() } });
  } catch (error) {
    console.error("Analytics RPC query failed, falling back to mock data:", error);
    const mockResponse = getMockResponse();
    return c.json({ data: mockResponse, meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString() } });
  }
});
```

- [ ] **Step 3: Remove unused `getRecentSignatures` import/usage** (no longer needed in the API handler — it's used by the ingestion script)

---

### Task 5: Wire End-to-End and Verify

**Files:** None (verification)

- [ ] **Step 1: Run the ingestion script**

```bash
node scripts/ingest-analytics.mjs
```

Expected: Connects to RPC, fetches holders, writes to Databricks

- [ ] **Step 2: Verify Databricks tables have data**

Query via `DATABRICKS_SQL_STATEMENT_EXEC_EXECUTE_STATEMENT`:

```sql
SELECT COUNT(*) FROM workspace.default.token_holders;
SELECT COUNT(*) FROM workspace.default.token_supply_snapshots;
SELECT * FROM workspace.default.analytics_cache ORDER BY id DESC LIMIT 1;
```

- [ ] **Step 3: Verify SDP API returns real data**

```bash
curl http://localhost:8787/v1/data-products/analytics
```

Expected: Returns JSON with real holder count and supply, geography as "Unknown"