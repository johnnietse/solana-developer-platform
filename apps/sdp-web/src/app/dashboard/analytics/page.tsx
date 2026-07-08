import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { AnalyticsWorkspace } from "./analytics-workspace";

export const dynamic = "force-dynamic";

function generateHolderHistory(length: number): Array<{ date: string; value: number }> {
  const data: Array<{ date: string; value: number }> = [];
  let holders = 420_000;
  for (let i = length - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    holders += Math.round((Math.random() - 0.45) * 5000);
    data.push({ date: date.toISOString().slice(0, 10), value: holders });
  }
  return data;
}

function generateSupplyHistory(
  symbols: string[],
  supplies: number[]
): Array<{ date: string; [symbol: string]: string | number }> {
  const data: Array<{ date: string; [symbol: string]: string | number }> = [];
  const current = [...supplies];
  for (let i = 29; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const entry: Record<string, number | string> = { date: date.toISOString().slice(0, 10) };
    for (let j = 0; j < symbols.length; j++) {
      current[j] += Math.round((Math.random() - 0.48) * current[j] * 0.005);
      entry[symbols[j]] = current[j];
    }
    data.push(entry as { date: string; [symbol: string]: string | number });
  }
  return data;
}

const holdersHistory = generateHolderHistory(30);
const supplyHistory = generateSupplyHistory(["USDC", "PYUSD"], [48_000_000_000, 9_500_000_000]);

const mockData = {
  stablecoins: [
    {
      mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP",
      symbol: "USDC", name: "USD Coin",
      totalSupply: 50_000_000_000, circulatingSupply: 48_000_000_000,
      holderCount: 250_000, medianBalance: 750_000,
      priceUsd: 1, marketCapUsd: 48_000_000_000, percentChange24h: 0.01,
    },
    {
      mintAddress: "CXk2jShYcgGMqk7joPcbBykDzaqCwN92xe9WLPVUgZf1",
      symbol: "PYUSD", name: "PayPal USD",
      totalSupply: 10_000_000_000, circulatingSupply: 9_500_000_000,
      holderCount: 50_000, medianBalance: 500_000,
      priceUsd: 1, marketCapUsd: 9_500_000_000, percentChange24h: 0.02,
    },
  ],
  holders: {
    totalHolders: 450_000,
    geography: [
      { region: "North America", percentage: 45, holderCount: 202_500 },
      { region: "Europe", percentage: 25, holderCount: 112_500 },
      { region: "Asia", percentage: 20, holderCount: 90_000 },
      { region: "Unknown", percentage: 10, holderCount: 45_000 },
    ],
    attribution: [
      { category: "exchange", percentage: 46.67, holderCount: 210_000 },
      { category: "protocol", percentage: 2.33, holderCount: 10_500 },
      { category: "team", percentage: 5.33, holderCount: 24_000 },
      { category: "retail", percentage: 45.67, holderCount: 205_500 },
    ],
  },
  holdersHistory,
  supplyHistory,
  lastUpdated: new Date().toISOString(),
};

export default async function AnalyticsPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  return <AnalyticsWorkspace data={mockData} error={null} lastUpdated={mockData.lastUpdated} />;
}
