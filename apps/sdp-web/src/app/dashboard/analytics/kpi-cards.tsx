"use client";

import { motion } from "motion/react";
import { formatCurrency, formatNumber } from "./analytics-utils";

interface KpiCardsProps {
  totalTvl: number;
  totalHolders: number;
  avgBalance: number;
  prevTvl: number;
  prevHolders: number;
  prevBalance: number;
  holderHistory?: number[];
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const w = 120; const h = 32;
  const min = Math.min(...data); const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} className="shrink-0" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <linearGradient id={`s-grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.2} />
        <stop offset="100%" stopColor={color} stopOpacity={0.02} />
      </linearGradient>
      <polyline fill={`url(#s-grad-${color.replace("#", "")})`} stroke="none" points={`0,${h} ${points} ${w},${h}`} />
      <polyline fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

function ChangeBadge({ current, previous }: { current: number; previous: number }) {
  const change = previous !== 0 ? ((current - previous) / previous) * 100 : 0;
  const isPositive = change >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium ${
        isPositive
          ? "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
          : "bg-[rgba(158,43,56,0.1)] text-[#9e2b38]"
      }`}
    >
      {isPositive ? "↑" : "↓"}
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function MetricCard({ label, value, changeCurrent, changePrevious, sparklineData, sparklineColor }: {
  label: string;
  value: string;
  changeCurrent: number;
  changePrevious: number;
  sparklineData: number[];
  sparklineColor: string;
}) {
  return (
    <div className="rounded-[18px] border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-6 py-6 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="space-y-2">
        <p className="text-[15px] text-[rgba(28,28,29,0.56)]">{label}</p>
        <div className="flex items-baseline gap-2">
          <p className="text-[24px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d] sm:text-[30px]">
            {value}
          </p>
          <ChangeBadge current={changeCurrent} previous={changePrevious} />
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Sparkline data={sparklineData} color={sparklineColor} />
      </div>
    </div>
  );
}

export function KpiCards({ totalTvl, totalHolders, avgBalance, prevTvl, prevHolders, prevBalance, holderHistory }: KpiCardsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="grid grid-cols-1 gap-4 sm:grid-cols-3"
    >
      <MetricCard
        label="Total Value Locked"
        value={formatCurrency(totalTvl)}
        changeCurrent={totalTvl}
        changePrevious={prevTvl}
        sparklineData={holderHistory ?? []}
        sparklineColor="#2163b6"
      />
      <MetricCard
        label="Total Holders"
        value={formatNumber(totalHolders)}
        changeCurrent={totalHolders}
        changePrevious={prevHolders}
        sparklineData={holderHistory ?? []}
        sparklineColor="#0c804c"
      />
      <MetricCard
        label="Avg Holder Balance"
        value={formatCurrency(avgBalance)}
        changeCurrent={avgBalance}
        changePrevious={prevBalance}
        sparklineData={holderHistory ?? []}
        sparklineColor="#d97706"
      />
    </motion.div>
  );
}
