"use client";

import type { RampProviderEstimateResult } from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { Loader2Icon } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  onSelect: () => void;
}

function ProviderCardEstimate({
  estimate,
  estimateLoading,
}: {
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
}) {
  if (estimateLoading) {
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-text-low" />;
  }

  if (estimate?.status === "ok") {
    const { direction, fiatCurrency, assetRail, fiatAmount, cryptoAmount, fees } =
      estimate.estimate;
    const isFiatOut = direction === "offramp";
    const amount = isFiatOut ? fiatAmount : cryptoAmount;
    const unit = isFiatOut ? fiatCurrency : getCryptoRailAssetLabel(assetRail);
    const feeLines: Array<{ label: string; value: string }> = [];
    if (fees.network && Number(fees.network) > 0) {
      feeLines.push({ label: "Network", value: fees.network });
    }
    if (fees.provider && Number(fees.provider) > 0) {
      feeLines.push({ label: "Provider", value: fees.provider });
    }
    if (feeLines.length === 0 && Number(fees.total) > 0) {
      feeLines.push({ label: "Fee", value: fees.total });
    }
    return (
      <div className="shrink-0 text-right">
        <p className="text-xs text-text-low">You get</p>
        <p className="text-base font-medium text-text-extra-high">{`≈ ${amount} ${unit}`}</p>
        {feeLines.map((line) => (
          <p key={line.label} className="text-xs text-text-low">
            {`${line.label} ${line.value} ${fees.currency}`}
          </p>
        ))}
      </div>
    );
  }

  if (estimate?.status === "unsupported") {
    return <p className="shrink-0 text-sm text-text-low">Rate known at quote</p>;
  }

  if (estimate?.status === "error") {
    return <p className="shrink-0 text-sm text-text-low">Unavailable</p>;
  }

  return null;
}

export function ProviderCard({
  option,
  active,
  estimate,
  estimateLoading,
  onSelect,
}: ProviderCardProps) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        layout: { type: "spring", stiffness: 500, damping: 40, mass: 0.6 },
        opacity: { duration: 0.15 },
        scale: { duration: 0.15 },
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl bg-border-extra-light px-4 py-3 text-left outline outline-2 -outline-offset-2 transition-colors",
        active
          ? "outline-border-medium ring-2 ring-text-low ring-offset-2 ring-offset-white"
          : "outline-transparent hover:bg-border-light"
      )}
    >
      <Image
        src={RAMP_PROVIDER_LOGOS[option.id]}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-lg object-contain"
      />

      <p
        className={cn(
          "min-w-0 flex-1 text-lg leading-tight text-text-extra-high",
          active ? "font-medium" : "font-normal"
        )}
      >
        {option.title}
      </p>

      <ProviderCardEstimate estimate={estimate} estimateLoading={estimateLoading} />
    </motion.button>
  );
}
