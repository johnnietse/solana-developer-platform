"use client";

import { useState, useCallback, useMemo, type ReactNode } from "react";
import { Maximize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { motion } from "motion/react";
import { KpiCards } from "./kpi-cards";
import { StablecoinCards } from "./stablecoin-cards";
import { BarChartCard } from "./bar-chart-card";
import { AreaChartCard } from "./area-chart-card";
import { StackedChartCard } from "./stacked-chart-card";
import { DonutCard } from "./donut-card";
import { AnalyticsTable } from "./analytics-table";
import { InsightBanners } from "./insight-banners";
import { GeoTooltip, AttrTooltip } from "./chart-tooltips";
import { ConcentrationMetrics } from "./concentration-metrics";
import { ReportButton } from "./analytics-report";
import { relativeTime, downloadCsv, formatCurrency, formatNumber, SUPPLY_KEYS } from "./analytics-utils";
import type { AnalyticsResponse } from "./analytics-types";

const ChartModal = lazy(async () => ({ default: (await import("./chart-modal")).ChartModal }));
const ChartDrillDown = lazy(async () => ({ default: (await import("./chart-drill-down")).ChartDrillDown }));

function LiveDot({ lastUpdated }: { lastUpdated: string }) {
  const hoursSinceUpdate = useMemo(
    () => (Date.now() - new Date(lastUpdated).getTime()) / 3_600_000,
    [lastUpdated]
  );
  const isStale = hoursSinceUpdate > 4;
  const isOld = hoursSinceUpdate > 24;
  const color = isOld ? "#9e2b38" : isStale ? "#d97706" : "#0c804c";
  const label = isOld ? "Stale" : isStale ? "Delayed" : "Live";
  return (
    <span className="relative flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {!isStale && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ backgroundColor: color }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ backgroundColor: color }}
        />
      </span>
      <span className="text-xs font-medium" style={{ color }}>
        {label}
      </span>
    </span>
  );
}



export function AnalyticsWorkspace({
  data,
  error,
  lastUpdated,
}: {
  data: AnalyticsResponse | null;
  error: string | null;
  lastUpdated: string | null;
}) {
  const [period, setPeriod] = useState("30d");
  const [modalChartKey, setModalChartKey] = useState<string | null>(null);
  const closeModal = useCallback(() => setModalChartKey(null), []);
  const [drillDown, setDrillDown] = useState<{
    title: string;
    subtitle?: string;
    items: Array<{ label: string; value: string }>;
  } | null>(null);
  const closeDrillDown = useCallback(() => setDrillDown(null), []);
  const onCoinClick = useCallback(
    (symbol: string) => {
      const coin = data.stablecoins.find((c) => c.symbol === symbol);
      if (!coin) return;
      setDrillDown({
        title: coin.symbol,
        subtitle: coin.name,
        items: [
          { label: "Market Cap", value: formatCurrency(coin.marketCapUsd ?? 0) },
          { label: "Total Supply", value: formatCurrency(coin.totalSupply) },
          { label: "Circulating Supply", value: formatCurrency(coin.circulatingSupply) },
          { label: "Holders", value: formatNumber(coin.holderCount) },
          { label: "Median Balance", value: formatCurrency(coin.medianBalance) },
          { label: "Price", value: coin.priceUsd != null ? `$${coin.priceUsd.toFixed(2)}` : "—" },
          { label: "24h Change", value: coin.percentChange24h != null ? `${(coin.percentChange24h * 100).toFixed(2)}%` : "—" },
        ],
      });
    },
    [data.stablecoins]
  );
  const onRegionClick = useCallback(
    (region: string) => {
      const entry = data.holders.geography.find((g) => g.region === region);
      if (!entry) return;
      setDrillDown({
        title: region,
        subtitle: "Holder region",
        items: [
          { label: "Share", value: `${entry.percentage}%` },
          { label: "Holders", value: formatNumber(entry.holderCount) },
        ],
      });
    },
    [data.holders.geography]
  );
  const onAttrClick = useCallback(
    (category: string) => {
      const entry = data.holders.attribution.find(
        (a) => a.category === category.toLowerCase()
      );
      if (!entry) return;
      setDrillDown({
        title: category,
        subtitle: "Holder category",
        items: [
          { label: "Share", value: `${entry.percentage}%` },
          { label: "Holders", value: formatNumber(entry.holderCount) },
        ],
      });
    },
    [data.holders.attribution]
  );

  if (error) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">Analytics unavailable</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.56)]">{error}</p>
          <div className="mt-4">
            <Button onClick={() => window.location.reload()} variant="outline" type="button">
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <p className="text-sm text-[rgba(28,28,29,0.56)]">Loading analytics...</p>
      </div>
    );
  }

  const totalTvl = useMemo(
    () => data.stablecoins.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0),
    [data.stablecoins]
  );
  const totalHolders = data.holders.totalHolders;
  const avgBalance = useMemo(
    () =>
      data.stablecoins.length
        ? data.stablecoins.reduce((s, c) => s + c.medianBalance, 0) / data.stablecoins.length
        : 0,
    [data.stablecoins]
  );

  const prevTvl = useMemo(
    () => (data.holdersHistory?.[0]?.value ? (totalTvl / data.holdersHistory[0].value) * totalTvl : totalTvl * 0.97),
    [totalTvl, data.holdersHistory]
  );
  const prevHolders = useMemo(
    () => totalHolders * 0.985,
    [totalHolders]
  );
  const prevBalance = useMemo(
    () => avgBalance * 0.992,
    [avgBalance]
  );

  const supplyData = useMemo(
    () => data.stablecoins.map((c) => ({ name: c.symbol, value: c.circulatingSupply })),
    [data.stablecoins]
  );
  const balanceData = useMemo(
    () => data.stablecoins.map((c) => ({ name: c.symbol, value: c.medianBalance })),
    [data.stablecoins]
  );
  const holderRegionData = useMemo(
    () => data.holders.geography.map((g) => ({ name: g.region, value: g.holderCount })),
    [data.holders.geography]
  );
  const geoData = useMemo(
    () =>
      data.holders.geography.map((g) => ({
        name: g.region,
        value: g.percentage,
        holderCount: g.holderCount,
      })),
    [data.holders.geography]
  );
  const attrData = useMemo(
    () =>
      data.holders.attribution.map((a) => ({
        name: a.category.charAt(0).toUpperCase() + a.category.slice(1),
        value: a.percentage,
        holderCount: a.holderCount,
      })),
    [data.holders.attribution]
  );

  const periodDays = period === "7d" ? 7 : period === "30d" ? 30 : period === "90d" ? 90 : Infinity;
  const filteredHolderHistory = useMemo(
    () => (data.holdersHistory ?? []).slice(-periodDays),
    [data.holdersHistory, periodDays]
  );
  const filteredSupplyHistory = useMemo(
    () => (data.supplyHistory ?? []).slice(-periodDays),
    [data.supplyHistory, periodDays]
  );

  const chartMap: Record<string, { title: string; chart: ReactNode }> = useMemo(() => ({
    "circulating-supply": {
      title: "Circulating Supply",
      chart: <BarChartCard title="Circulating Supply" description="By stablecoin" data={supplyData} configs={[{ dataKey: "value", label: "Supply", formatter: (v) => `$${(v / 1_000_000_000).toFixed(1)}B`, isCurrency: true }]} barSize={52} />,
    },
    "median-balance": {
      title: "Median Holder Balance",
      chart: <BarChartCard title="Median Holder Balance" description="By stablecoin" data={balanceData} configs={[{ dataKey: "value", label: "Balance", formatter: (v) => `$${(v / 1_000).toFixed(0)}K`, isCurrency: true }]} barSize={52} />,
    },
    "holder-geography": {
      title: "Holder Geography",
      chart: <DonutCard title="Holder Geography" description="Regional distribution" data={geoData} centerLabel={`${Math.max(...geoData.map((g) => g.value), 0).toFixed(0)}%`} centerSublabel="top region" tooltip={<GeoTooltip />} />,
    },
    "holder-attribution": {
      title: "Holder Attribution",
      chart: <DonutCard title="Holder Attribution" description="By category" data={attrData} centerLabel={`${Math.max(...attrData.map((a) => a.value), 0).toFixed(0)}%`} centerSublabel="top category" tooltip={<AttrTooltip />} />,
    },
    "holder-growth": {
      title: "Holder Growth",
      chart: <AreaChartCard title="Holder Growth" description={`Total unique holders over the last ${periodDays === Infinity ? "all" : periodDays} days`} data={filteredHolderHistory} color="#2163b6" gradientColor="#2163b6" formatValue={(v) => `${(v / 1_000).toFixed(0)}K`} />,
    },
    "supply-composition": {
      title: "Supply Composition",
      chart: <StackedChartCard title="Supply Composition" description={`Circulating supply over time by stablecoin`} data={filteredSupplyHistory} keys={SUPPLY_KEYS} />,
    },
    "holders-by-region": {
      title: "Holders by Region",
      chart: <BarChartCard title="Holders by Region" description="Absolute holder counts across regions" data={holderRegionData} configs={[{ dataKey: "value", label: "Holders", formatter: (v) => `${(v / 1_000).toFixed(0)}K` }]} barSize={28} layout="vertical" />,
    },
  }), [supplyData, balanceData, geoData, attrData, filteredHolderHistory, filteredSupplyHistory, holderRegionData, periodDays]);

  return (
    <div className="flex flex-col gap-6" data-analytics-root>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="flex items-center gap-2 rounded-md border border-[rgba(28,28,29,0.1)] bg-white px-2.5 py-1 shadow-[0_2px_10px_rgba(28,28,29,0.04)]">
              <LiveDot lastUpdated={lastUpdated ?? new Date().toISOString()} />
              <span className="text-xs text-[rgba(28,28,29,0.72)]">
                Updated {relativeTime(lastUpdated)}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Select value={period} onValueChange={setPeriod}>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </Select>
          <ReportButton />
          <Button variant="outline" type="button" onClick={() => downloadCsv(data.stablecoins)}>
            Export CSV
          </Button>
        </div>
      </motion.div>

      <KpiCards
        totalTvl={totalTvl}
        totalHolders={totalHolders}
        avgBalance={avgBalance}
        prevTvl={prevTvl}
        prevHolders={prevHolders}
        prevBalance={prevBalance}
        holderHistory={filteredHolderHistory.map((d) => d.value)}
      />

      <ConcentrationMetrics stablecoins={data.stablecoins} />

      <InsightBanners
        stablecoins={data.stablecoins}
        geography={data.holders.geography}
        attribution={data.holders.attribution}
      />

      <StablecoinCards stablecoins={data.stablecoins} />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut", delay: 0.08 }}
        className="grid grid-cols-1 gap-6 lg:grid-cols-2"
      >
        <BarChartCard
          title="Circulating Supply"
          description="By stablecoin"
          data={supplyData}
          configs={[{ dataKey: "value", label: "Supply", formatter: (v) => `$${(v / 1_000_000_000).toFixed(1)}B`, isCurrency: true }]}
          barSize={52}
          onItemClick={onCoinClick}
          headerAction={
            <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("circulating-supply")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
              <Maximize2Icon className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <BarChartCard
          title="Median Holder Balance"
          description="By stablecoin"
          data={balanceData}
          configs={[{ dataKey: "value", label: "Balance", formatter: (v) => `$${(v / 1_000).toFixed(0)}K`, isCurrency: true }]}
          barSize={52}
          onItemClick={onCoinClick}
          headerAction={
            <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("median-balance")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
              <Maximize2Icon className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut", delay: 0.12 }}
        className="grid grid-cols-1 gap-6 lg:grid-cols-2"
      >
        <DonutCard
          title="Holder Geography"
          description="Regional distribution"
          data={geoData}
          centerLabel={`${Math.max(...geoData.map((g) => g.value), 0).toFixed(0)}%`}
          centerSublabel="top region"
          tooltip={<GeoTooltip />}
          onItemClick={onRegionClick}
          headerAction={
            <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("holder-geography")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
              <Maximize2Icon className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <DonutCard
          title="Holder Attribution"
          description="By category"
          data={attrData}
          centerLabel={`${Math.max(...attrData.map((a) => a.value), 0).toFixed(0)}%`}
          centerSublabel="top category"
          tooltip={<AttrTooltip />}
          onItemClick={onAttrClick}
          headerAction={
            <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("holder-attribution")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
              <Maximize2Icon className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </motion.div>

      {(filteredHolderHistory.length > 0 || filteredSupplyHistory.length > 0) && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut", delay: 0.16 }}
          className="grid grid-cols-1 gap-6 lg:grid-cols-2"
        >
          {filteredHolderHistory.length > 0 && (
            <AreaChartCard
              title="Holder Growth"
              description={`Total unique holders over the last ${periodDays === Infinity ? "all available" : periodDays} days`}
              data={filteredHolderHistory}
              color="#2163b6"
              gradientColor="#2163b6"
              formatValue={(v) => `${(v / 1_000).toFixed(0)}K`}
              headerAction={
                <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("holder-growth")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
                  <Maximize2Icon className="h-3.5 w-3.5" />
                </Button>
              }
            />
          )}
          {filteredSupplyHistory.length > 0 && (
            <StackedChartCard
              title="Supply Composition"
              description="Circulating supply over time by stablecoin"
              data={filteredSupplyHistory}
              keys={SUPPLY_KEYS.filter((k) =>
                filteredSupplyHistory.some((d) => k in d)
              )}
              headerAction={
                <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("supply-composition")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
                  <Maximize2Icon className="h-3.5 w-3.5" />
                </Button>
              }
            />
          )}
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut", delay: 0.2 }}
      >
        <BarChartCard
          title="Holders by Region"
          description="Absolute holder counts across regions"
          data={holderRegionData}
          configs={[{ dataKey: "value", label: "Holders", formatter: (v) => `${(v / 1_000).toFixed(0)}K` }]}
          barSize={28}
          layout="vertical"
          onItemClick={onRegionClick}
          headerAction={
            <Button variant="ghost" size="sm" type="button" onClick={() => setModalChartKey("holders-by-region")} className="h-7 w-7 p-0 text-[rgba(28,28,29,0.72)] hover:text-[#1c1c1d]">
              <Maximize2Icon className="h-3.5 w-3.5" />
            </Button>
          }
        />
      </motion.div>

      <AnalyticsTable
        stablecoins={data.stablecoins}
        geography={data.holders.geography}
        attribution={data.holders.attribution}
      />

      {modalChartKey && chartMap[modalChartKey] && (
        <Suspense fallback={null}>
          <ChartModal
            open
            onClose={closeModal}
            title={chartMap[modalChartKey].title}
          >
            {chartMap[modalChartKey].chart}
          </ChartModal>
        </Suspense>
      )}

      {drillDown && (
        <Suspense fallback={null}>
          <ChartDrillDown
            open
            onClose={closeDrillDown}
            title={drillDown.title}
            subtitle={drillDown.subtitle}
            items={drillDown.items}
          />
        </Suspense>
      )}
    </div>
  );
}
