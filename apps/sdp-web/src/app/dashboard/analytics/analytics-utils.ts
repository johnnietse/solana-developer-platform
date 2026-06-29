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

export const PALLETE = ["#2163b6", "#0c804c", "#d97706", "#9e2b38", "#7c3aed", "#0d9488"];

export const DONUT_COLORS = ["#2163b6", "#0c804c", "#d97706", "#9e2b38", "#7c3aed"];

export const STACK_COLORS: Record<string, string> = {
  USDC: "#2163b6",
  USDT: "#d97706",
  PYUSD: "#0c804c",
};

export function getColorForSymbol(symbol: string): string {
  return STACK_COLORS[symbol] ?? PALLETE[symbol.length % PALLETE.length];
}

export const SUPPLY_KEYS = ["USDC", "PYUSD"];

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
  stablecoins: Array<{
    symbol: string;
    name: string;
    totalSupply: number;
    circulatingSupply: number;
    marketCapUsd: number | null;
    holderCount: number;
    medianBalance: number;
    priceUsd: number | null;
    percentChange24h: number | null;
  }>
) {
  const headers = [
    "Symbol", "Name", "Total Supply", "Circulating Supply",
    "Market Cap", "Holders", "Median Balance", "Price", "24h Change",
  ];
  const rows = stablecoins.map((c) => [
    c.symbol,
    c.name,
    c.totalSupply.toString(),
    c.circulatingSupply.toString(),
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
  stablecoins: Array<{ marketCapUsd: number | null }>
): number {
  const total = stablecoins.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0);
  if (total === 0) return 0;
  return Math.round(
    stablecoins.reduce((s, c) => {
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
  stablecoins: Array<{
    symbol: string;
    marketCapUsd: number | null;
  }>,
  geography: Array<{ region: string; percentage: number }>,
  attribution: Array<{ category: string; percentage: number }>
): Array<{ label: string; message: string; variant: "info" | "success" | "warning" }> {
  const insights: Array<{ label: string; message: string; variant: "info" | "success" | "warning" }> = [];

  const totalMc = stablecoins.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0);
  if (totalMc > 0 && stablecoins.length > 0) {
    const top = [...stablecoins].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))[0];
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
