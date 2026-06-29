"use client";

import { motion } from "motion/react";
import { computeHhi, concentrationLabel, PALLETE } from "./analytics-utils";

function DominanceBar({
  name,
  share,
  color,
}: {
  name: string;
  share: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-right text-xs font-medium text-[rgba(28,28,29,0.72)]">
        {name}
      </span>
      <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[rgba(28,28,29,0.06)]">
        <div
          className="rounded-full transition-all duration-500"
          style={{ width: `${share}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-12 text-xs font-medium text-[#1c1c1d]">{share.toFixed(1)}%</span>
    </div>
  );
}

interface ConcentrationMetricsProps {
  stablecoins: Array<{ symbol: string; name: string; marketCapUsd: number | null }>;
}

export function ConcentrationMetrics({ stablecoins }: ConcentrationMetricsProps) {
  const hhi = computeHhi(stablecoins);
  const { label, color } = concentrationLabel(hhi);
  const total = stablecoins.reduce((s, c) => s + (c.marketCapUsd ?? 0), 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="grid grid-cols-1 gap-4 sm:grid-cols-4"
    >
      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)] sm:col-span-1">
        <p className="text-[15px] text-[rgba(28,28,29,0.56)]">Market Concentration</p>
        <div className="mt-2 flex items-baseline gap-2">
          <p className="text-[24px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d] sm:text-[30px]">
            {hhi.toLocaleString()}
          </p>
          <span
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium"
            style={{
              backgroundColor: `${color}15`,
              color,
            }}
          >
            {label}
          </span>
        </div>
      </div>

      <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)] sm:col-span-3">
        <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">Market Share Distribution</p>
        <div className="mt-4 space-y-3">
          {stablecoins.map((coin, i) => {
            const share = total > 0 ? ((coin.marketCapUsd ?? 0) / total) * 100 : 0;
            return (
              <DominanceBar
                key={coin.symbol}
                name={coin.symbol}
                share={share}
                color={PALLETE[i % PALLETE.length]}
              />
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
