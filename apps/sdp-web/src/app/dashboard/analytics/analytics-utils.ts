export function formatCurrency(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

export const PALLETE = ["#2163b6", "#0c804c", "#d97706", "#9e2b38", "#7c3aed", "#0d9488", "#0891b2", "#4f46e5"];

export const DONUT_COLORS = ["#2163b6", "#0c804c", "#d97706", "#9e2b38", "#7c3aed", "#0891b2"];

export function getColorForSymbol(symbol: string): string {
  return PALLETE[symbol.length % PALLETE.length];
}

/**
 * Build supply keys and color map dynamically from the actual data.
 * Extracts all symbol keys (excluding 'date') from supply history entries.
 */
export function buildSupplyKeys(
  supplyHistory: Array<{ date: string; [symbol: string]: string | number }>
): string[] {
  const keys = new Set<string>();
  for (const entry of supplyHistory) {
    for (const key of Object.keys(entry)) {
      if (key !== "date") keys.add(key);
    }
  }
  return Array.from(keys);
}

export function buildStackColors(keys: string[]): Record<string, string> {
  const colors: Record<string, string> = {};
  keys.forEach((key, i) => {
    colors[key] = PALLETE[i % PALLETE.length];
  });
  return colors;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function downloadCsv(
  tokens: Array<{
    symbol: string;
    name: string;
    totalSupply: number;
    circulatingSupply?: number;
    marketCapUsd?: number | null;
    holderCount: number;
    medianBalance: number;
    priceUsd?: number | null;
    percentChange24h?: number | null;
  }>
) {
  const headers = [
    "Symbol", "Name", "Total Supply", "Circulating Supply",
    "Market Cap", "Holders", "Median Balance", "Price", "24h Change",
  ];
  const rows = tokens.map((c) => [
    c.symbol,
    c.name,
    c.totalSupply.toString(),
    (c.circulatingSupply ?? c.totalSupply).toString(),
    (c.marketCapUsd ?? 0).toString(),
    c.holderCount.toString(),
    c.medianBalance.toString(),
    (c.priceUsd ?? 0).toString(),
    (c.percentChange24h ?? 0).toString(),
  ]);
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `analytics-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function computeHhi(
  tokens: Array<{ marketCapUsd?: number | null }>
): number {
  const total = tokens.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0);
  if (total === 0) return 0;
  return Math.round(
    tokens.reduce((s, c) => {
      const share = ((c.marketCapUsd ?? 0) / total) * 100;
      return s + share * share;
    }, 0)
  );
}

export function concentrationLabel(
  hhi: number
): { label: string; color: string } {
  if (hhi < 1500) return { label: "Low Concentration", color: "#0c804c" };
  if (hhi < 2500) return { label: "Moderate Concentration", color: "#d97706" };
  return { label: "High Concentration", color: "#9e2b38" };
}

export function computeInsights(
  tokens: Array<{
    symbol: string;
    marketCapUsd?: number | null;
  }>,
  geography: Array<{ region: string; percentage: number }>,
  attribution: Array<{ category: string; percentage: number }>
): Array<{ label: string; message: string; variant: "info" | "success" | "warning" }> {
  const insights: Array<{ label: string; message: string; variant: "info" | "success" | "warning" }> = [];

  const totalMc = tokens.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0);
  if (totalMc > 0 && tokens.length > 0) {
    const top = [...tokens].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))[0];
    const share = ((top.marketCapUsd ?? 0) / totalMc) * 100;
    insights.push({
      label: "Dominance",
      message: `${top.symbol} leads with ${share.toFixed(1)}% of total stablecoin market cap`,
      variant: "info" as const,
    });
  }

  if (geography.length > 0) {
    const topRegion = [...geography].sort((a, b) => b.percentage - a.percentage)[0];
    insights.push({
      label: "Geography",
      message: `${topRegion.region} accounts for ${topRegion.percentage}% of all holders`,
      variant: "success" as const,
    });
  }

  if (attribution.length > 0) {
    const topAttr = [...attribution].sort((a, b) => b.percentage - a.percentage)[0];
    insights.push({
      label: "Attribution",
      message: `${topAttr.category.charAt(0).toUpperCase() + topAttr.category.slice(1)} wallets represent ${topAttr.percentage}% of holders`,
      variant: "warning" as const,
    });
  }

  return insights;
}
