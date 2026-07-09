/**
 * Analytics Data Product — RPC-powered stablecoin analytics.
 *
 * Pipeline:
 *   Layer 1: Solana RPC → getTokenSupply, getProgramAccounts, getSignaturesForAddress
 *   Layer 2: Databricks → wallet labels, geography mapping, attribution (Phase 2)
 *   Layer 3: SDP API → GET /v1/data-products/analytics
 *
 * This handler queries the public devnet RPC directly. Production should use
 * a dedicated RPC provider (Helius/QuickNode) to avoid rate limits.
 *
 * USDC devnet mint: Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
 * USDC mainnet mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
 */

import { Hono } from "hono";
import type { Env } from "@/types/env";
import { queryDatabricks } from "@/lib/databricks-query";

const analytics = new Hono<{ Bindings: Env }>();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StablecoinEntry {
  mintAddress: string;
  symbol: string;
  name: string;
  totalSupply: number;
  circulatingSupply: number;
  holderCount: number;
  medianBalance: number;
  priceUsd: number;
  marketCapUsd: number;
  percentChange24h: number;
}

interface GeographyEntry {
  region: string;
  percentage: number;
  holderCount: number;
}

interface AttributionEntry {
  category: string;
  percentage: number;
  holderCount: number;
}

interface TimeSeriesEntry {
  date: string;
  value: number;
}

interface AnalyticsResponse {
  stablecoins: StablecoinEntry[];
  holders: {
    totalHolders: number;
    geography: GeographyEntry[];
    attribution: AttributionEntry[];
  };
  holdersHistory: TimeSeriesEntry[];
  supplyHistory: Array<{ date: string; [symbol: string]: string | number }>;
  lastUpdated: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEVNET_RPC = "https://api.devnet.solana.com";
const USDC_MINT_DEVNET = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

// Known stablecoin mints metadata for display
const KNOWN_MINTS: Record<string, { symbol: string; name: string }> = {
  [USDC_MINT_DEVNET]: { symbol: "USDC", name: "USD Coin" },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
};

// ─────────────────────────────────────────────────────────────────────────────
// History Query Helpers (real data from Databricks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query daily holder counts over the trailing `days` window from the
 * `token_holders` table. Returns one TimeSeriesEntry per day.
 */
async function queryHoldersHistory(env: Env, days = 30): Promise<TimeSeriesEntry[]> {
  const rows = await queryDatabricks(
    env,
    `SELECT DATE(snapshot_at) as snapshot_date, COUNT(DISTINCT wallet_address) AS holders
     FROM workspace.default.token_holders
     WHERE snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
     GROUP BY DATE(snapshot_at)
     ORDER BY snapshot_date ASC`
  );
  if (!rows) return [];
  return rows.map(([date, value]) => ({
    date,
    value: Number.parseInt(value, 10) || 0,
  }));
}

/**
 * Query daily supply snapshots over the trailing `days` window from the
 * `token_supply_snapshots` table. Returns one entry per day with a column
 * per mint symbol.
 */
async function querySupplyHistory(
  env: Env,
  days = 30
): Promise<Array<{ date: string; [symbol: string]: string | number }>> {
  const rows = await queryDatabricks(
    env,
    `SELECT DATE(snapshot_at) as snapshot_date, mint_address, SUM(supply) as total_supply
     FROM workspace.default.token_supply_snapshots
     WHERE snapshot_at >= DATE_SUB(CURRENT_DATE(), INTERVAL ${days} DAY)
     GROUP BY DATE(snapshot_at), mint_address
     ORDER BY snapshot_date ASC, mint_address ASC`
  );
  if (!rows) return [];

  const byDate = new Map<string, { date: string; [symbol: string]: string | number }>();
  for (const [date, mint, supply] of rows) {
    const entry = byDate.get(date) ?? { date };
    const symbol = KNOWN_MINTS[mint]?.symbol ?? mint.slice(0, 8);
    entry[symbol] = Number.parseFloat(supply) || 0;
    byDate.set(date, entry);
  }
  return Array.from(byDate.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handler
// ─────────────────────────────────────────────────────────────────────────────

analytics.get("/", async (c) => {
  // Parse ?mints= query param: comma-separated mint addresses
  const mintsParam = c.req.query("mints");
  const mints = mintsParam
    ? mintsParam.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
    : (c.env.ANALYTICS_MINTS
        ? c.env.ANALYTICS_MINTS.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
        : [USDC_MINT_DEVNET]);

  // ── Helper: enrich holders with wallet_labels ─────────────────────────────
  async function enrichGeography(
    env: Env,
    totalHolders: number
  ): Promise<{ geography: GeographyEntry[]; attribution: AttributionEntry[] }> {
    const labelData = await queryDatabricks(
      env,
      `SELECT geography, COUNT(*) AS cnt
       FROM workspace.default.wallet_labels
       WHERE geography IS NOT NULL AND geography != 'Unknown'
       GROUP BY geography
       ORDER BY cnt DESC`
    );

    if (labelData && labelData.length > 0) {
      const totalLabeled = labelData.reduce((s, r) => s + Number.parseInt(r[1], 10), 0);
      const geography = labelData.map(([region, count]) => ({
        region,
        percentage: totalLabeled > 0 ? Math.round((Number.parseInt(count, 10) / totalLabeled) * 100) : 0,
        holderCount: Number.parseInt(count, 10),
      }));
      const attribution = await queryDatabricks(
        env,
        `SELECT attribution_category, COUNT(*) AS cnt
         FROM workspace.default.wallet_labels
         WHERE attribution_category IS NOT NULL AND attribution_category != 'unknown'
         GROUP BY attribution_category
         ORDER BY cnt DESC`
      );
      const attrEntries = attribution
        ? attribution.map(([category, count]) => ({
            category,
            percentage: totalLabeled > 0 ? Math.round((Number.parseInt(count, 10) / totalLabeled) * 100) : 0,
            holderCount: Number.parseInt(count, 10),
          }))
        : [{ category: "unknown", percentage: 100, holderCount: totalHolders }];
      return { geography, attribution: attrEntries };
    }

    return {
      geography: [{ region: "Unknown", percentage: 100, holderCount: totalHolders }],
      attribution: [{ category: "unknown", percentage: 100, holderCount: totalHolders }],
    };
  }

  // ── Check Databricks credentials ──────────────────────────────────────────
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = c.env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
    return c.json(
      { data: null, meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString(), error: "Databricks credentials not configured" } },
      503
    );
  }

  // ── Read latest analytics_cache row ───────────────────────────────────────
  const cacheData = await queryDatabricks(
    c.env,
    "SELECT response_json, snapshot_at FROM workspace.default.analytics_cache ORDER BY id DESC LIMIT 1"
  );
  if (!cacheData || cacheData.length === 0) {
    return c.json(
      { data: null, meta: { requestId: c.get("requestId"), timestamp: new Date().toISOString(), error: "No analytics cache available. Data is being seeded — check back in a few minutes." } },
      503
    );
  }

  const [responseJson, snapshotAt] = cacheData[0];
  const parsed = JSON.parse(responseJson) as AnalyticsResponse;
  parsed.lastUpdated = snapshotAt;

  // Enrich with wallet_labels if available
  const enriched = await enrichGeography(c.env, parsed.holders.totalHolders);
  parsed.holders.geography = enriched.geography;
  parsed.holders.attribution = enriched.attribution;

  // Query real history from token_holders and token_supply_snapshots
  const [holdersHistory, supplyHistory] = await Promise.all([
    queryHoldersHistory(c.env, 30),
    querySupplyHistory(c.env, 30),
  ]);
  parsed.holdersHistory = holdersHistory;
  parsed.supplyHistory = supplyHistory;

  // Freshness metadata derived from the cache snapshot time
  const snapshotMs = new Date(snapshotAt).getTime();
  const nowMs = Date.now();
  const cacheAgeSeconds = Math.max(0, Math.round((nowMs - snapshotMs) / 1000));
  const nextRefreshSeconds = Math.max(0, 300 - cacheAgeSeconds);

  return c.json({
    data: parsed,
    meta: {
      requestId: c.get("requestId"),
      timestamp: new Date().toISOString(),
      freshness: {
        cacheAgeSeconds,
        nextRefreshSeconds,
        source: "cache",
      },
    },
  });
});

export default analytics;