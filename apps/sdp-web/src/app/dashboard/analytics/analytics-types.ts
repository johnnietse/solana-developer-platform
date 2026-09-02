// ─────────────────────────────────────────────────────────────────────────────
// Analytics Data Types
// Shared between the server page (page.tsx) and the client workspace component.
//
// These types mirror the response shape of GET /v1/data-products/analytics
// from the SDP API. When the real API is wired up, the response should
// conform to this interface.
// ─────────────────────────────────────────────────────────────────────────────

export interface StablecoinEntry {
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

export interface GeographyEntry {
  region: string;
  percentage: number;
  holderCount: number;
}

export interface AttributionEntry {
  category: string;
  percentage: number;
  holderCount: number;
}

export interface TimeSeriesEntry {
  date: string;
  value: number;
}

export interface AnalyticsResponse {
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

export interface UserTokenEntry {
  tokenId: string;
  mintAddress: string | null;
  name: string;
  symbol: string;
  decimals: number;
  status: string;
  template: string;
  totalSupply: number;
  holderCount: number;
  medianBalance: number;
  deployedAt: string | null;
  createdAt: string;
}

export interface UserAnalyticsResponse {
  tokens: UserTokenEntry[];
  summary: {
    totalTokens: number;
    totalSupply: number;
    totalHolders: number;
    deployedTokens: number;
    pendingTokens: number;
  };
  lastUpdated: string;
}

/**
 * On-chain activity for one issued mint, from GET /api/dashboard/analytics/rpc.
 *
 * `transactionCount` and `since` mirror the metrics API's /rpc response, which
 * is itself the dev.mlh.rpc_counts Delta schema. Every field is nullable
 * because one mint failing upstream must not blank out the rest of the table.
 */
export interface TokenActivity {
  // The five fields below are the metrics API's /rpc response verbatim, which
  // is also the dev.mlh.rpc_counts Delta schema (see insert_rpc.py RPC_SCHEMA).
  // Keep them in step with it — the table renders one column per field.
  mint: string;
  cluster: string | null;
  days: number | null;
  transactionCount: number | null;
  since: string | null;
  // Transport metadata, not part of the schema: `cached` comes from the
  // X-Cache header, `error` is set when this mint's lookup failed.
  cached: boolean | null;
  error?: string;
}

export interface TokenActivityResponse {
  activity: TokenActivity[];
  days: number;
  cluster: string;
  lastUpdated: string;
}

export type ViewMode = "stablecoins" | "databricks" | "my-tokens";

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