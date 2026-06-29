"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { computeInsights } from "./analytics-utils";
import type { StablecoinEntry, GeographyEntry, AttributionEntry } from "./analytics-types";

interface InsightBannersProps {
  stablecoins: StablecoinEntry[];
  geography: GeographyEntry[];
  attribution: AttributionEntry[];
}

export function InsightBanners({ stablecoins, geography, attribution }: InsightBannersProps) {
  const insights = useMemo(
    () => computeInsights(stablecoins, geography, attribution),
    [stablecoins, geography, attribution]
  );

  if (insights.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: 0.02 }}
      className="flex flex-col gap-2"
    >
      {insights.map((insight) => (
        <div
          key={insight.label}
          className="flex items-center gap-3 rounded-xl border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.03)] px-4 py-2.5"
        >
          <Badge variant={insight.variant} className="shrink-0">
            {insight.label}
          </Badge>
          <p className="text-sm text-[#1c1c1d]">{insight.message}</p>
        </div>
      ))}
    </motion.div>
  );
}
