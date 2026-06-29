"use client";

import { motion } from "motion/react";
import { formatCurrency, formatNumber, PALLETE } from "./analytics-utils";
import type { StablecoinEntry } from "./analytics-types";

interface StablecoinCardsProps {
  stablecoins: StablecoinEntry[];
}

export function StablecoinCards({ stablecoins }: StablecoinCardsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: 0.04 }}
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {stablecoins.map((coin, i) => (
          <div
            key={coin.mintAddress}
            className="overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]"
            style={{ borderLeft: `3px solid ${PALLETE[i % PALLETE.length]}` }}
          >
            <div className="flex items-center justify-between pb-3">
              <div>
                <p className="text-lg font-medium text-[#1c1c1d]">{coin.symbol}</p>
                <p className="text-sm text-[rgba(28,28,29,0.56)]">{coin.name}</p>
              </div>
              {coin.percentChange24h != null && (
                <span
                  className={`inline-flex items-center gap-0.5 rounded-md px-2 py-0.5 text-xs font-medium ${
                    coin.percentChange24h >= 0
                      ? "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
                      : "bg-[rgba(158,43,56,0.1)] text-[#9e2b38]"
                  }`}
                >
                  {coin.percentChange24h >= 0 ? "↑" : "↓"}
                  {Math.abs(coin.percentChange24h * 100).toFixed(2)}%
                </span>
              )}
            </div>
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[rgba(28,28,29,0.56)]">Market Cap</span>
                <span className="text-base font-semibold text-[#1c1c1d]">
                  {formatCurrency(coin.marketCapUsd ?? 0)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[rgba(28,28,29,0.56)]">Holders</span>
                <span className="text-base font-semibold text-[#1c1c1d]">
                  {formatNumber(coin.holderCount)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[rgba(28,28,29,0.56)]">Circulating Supply</span>
                <span className="text-base font-semibold text-[#1c1c1d]">
                  {formatCurrency(coin.circulatingSupply)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-[rgba(28,28,29,0.56)]">Median Balance</span>
                <span className="text-base font-semibold text-[#1c1c1d]">
                  {formatCurrency(coin.medianBalance)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
