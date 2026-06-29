"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useRef, type ReactNode } from "react";
import { ChartCard } from "./chart-card";
import { PALLETE, formatCurrency, formatNumber } from "./analytics-utils";

interface BarChartConfig {
  dataKey: string;
  label: string;
  formatter: (v: number) => string;
  isCurrency?: boolean;
}

interface BarTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; dataKey: string }>;
  label?: string;
  configs?: BarChartConfig[];
}

function BarTooltipContent({ active, payload, configs }: BarTooltipProps) {
  if (!active || !payload?.length || !configs) return null;
  return (
    <div className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-3 py-2 shadow-[0_2px_10px_rgba(28,28,29,0.08)]">
      <p className="text-xs font-medium text-[#1c1c1d]">{payload[0].name}</p>
      {payload.map((p) => {
        const cfg = configs.find((c) => c.dataKey === p.dataKey);
        return (
          <p key={p.dataKey} className="text-xs text-[rgba(28,28,29,0.72)]">
            {cfg?.label ?? p.dataKey}: {cfg ? cfg.formatter(p.value) : p.value.toLocaleString()}
          </p>
        );
      })}
    </div>
  );
}

interface BarChartCardProps {
  title: string;
  description: string;
  data: Array<{ name: string; value: number }>;
  configs?: BarChartConfig[];
  barSize?: number;
  layout?: "horizontal" | "vertical";
  onItemClick?: (name: string) => void;
  headerAction?: ReactNode;
}

export function BarChartCard({ title, description, data, configs, barSize = 40, layout = "horizontal", onItemClick, headerAction }: BarChartCardProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const cfg: BarChartConfig = configs?.[0] ?? {
    dataKey: "value", label: "Value",
    formatter: (v: number) => v.toLocaleString(),
  };
  return (
    <ChartCard title={title} description={description} headerAction={headerAction} chartRef={chartRef}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={layout} margin={{ top: 8, right: 8, left: layout === "vertical" ? 60 : 0, bottom: 0 }}>
          {layout === "vertical" ? (
            <>
              <XAxis type="number" tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} width={90} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
            </>
          )}
          <Tooltip content={<BarTooltipContent configs={configs} />} cursor={{ fill: "rgba(28,28,29,0.04)" }} />
          <Bar dataKey={cfg.dataKey} radius={layout === "vertical" ? [0, 4, 4, 0] : [4, 4, 0, 0]} barSize={barSize} onClick={(d) => onItemClick?.(d.name as string)} style={{ cursor: onItemClick ? "pointer" : undefined }}>
            {data.map((_, i) => (
              <Cell key={`cell-${i}`} fill={PALLETE[i % PALLETE.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
