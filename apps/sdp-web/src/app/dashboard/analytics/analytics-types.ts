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

export type ViewMode = "stablecoins" | "my-tokens";

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