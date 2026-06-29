"use client";

import { useRef, type ReactNode } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { ChartCard } from "./chart-card";

interface AreaTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
  formatValue: (v: number) => string;
}

function AreaTooltipContent({ active, payload, label, formatValue }: AreaTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-3 py-2 shadow-[0_2px_10px_rgba(28,28,29,0.08)]">
      <p className="text-xs text-[rgba(28,28,29,0.44)]">{label}</p>
      <p className="text-sm font-medium text-[#1c1c1d]">{formatValue(payload[0].value)}</p>
    </div>
  );
}

interface AreaChartCardProps {
  title: string;
  description: string;
  data: Array<{ date: string; value: number }>;
  color: string;
  gradientColor: string;
  formatValue: (v: number) => string;
  headerAction?: ReactNode;
}

export function AreaChartCard({ title, description, data, color, gradientColor, formatValue, headerAction }: AreaChartCardProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  return (
    <ChartCard title={title} description={description} headerAction={headerAction} chartRef={chartRef}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={gradientColor} stopOpacity={0.15} />
              <stop offset="100%" stopColor={gradientColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(28,28,29,0.12)" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip content={<AreaTooltipContent formatValue={formatValue} />} />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#grad-${color.replace("#", "")})`} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
