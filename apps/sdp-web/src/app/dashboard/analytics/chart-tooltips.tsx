"use client";

interface GeoAttrPayload {
  name: string;
  value: number;
  payload: { holderCount?: number };
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<GeoAttrPayload>;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toString();
}

export function GeoTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-3 py-2 shadow-[0_2px_10px_rgba(28,28,29,0.08)]">
      <p className="text-xs font-medium text-[#1c1c1d]">{d.name}</p>
      <p className="text-xs text-[rgba(28,28,29,0.72)]">{d.value.toFixed(1)}% of holders</p>
      {d.payload.holderCount != null && (
        <p className="text-xs text-[rgba(28,28,29,0.44)]">{formatNumber(d.payload.holderCount)} holders</p>
      )}
    </div>
  );
}

export function AttrTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-3 py-2 shadow-[0_2px_10px_rgba(28,28,29,0.08)]">
      <p className="text-xs font-medium capitalize text-[#1c1c1d]">{d.name}</p>
      <p className="text-xs text-[rgba(28,28,29,0.72)]">{d.value.toFixed(1)}% of holders</p>
      {d.payload.holderCount != null && (
        <p className="text-xs text-[rgba(28,28,29,0.44)]">{formatNumber(d.payload.holderCount)} holders</p>
      )}
    </div>
  );
}
