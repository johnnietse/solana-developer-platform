export interface StablecoinEntry {
  mintAddress: string;
  symbol: string;
  name: string;
  totalSupply: number;
  circulatingSupply: number;
  holderCount: number;
  medianBalance: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  percentChange24h: number | null;
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

export interface AnalyticsResponse {
  stablecoins: StablecoinEntry[];
  holders: {
    totalHolders: number;
    geography: GeographyEntry[];
    attribution: AttributionEntry[];
  };
  holdersHistory?: Array<{ date: string; value: number }>;
  supplyHistory?: Array<{ date: string; [symbol: string]: string | number }>;
  lastUpdated: string;
}
