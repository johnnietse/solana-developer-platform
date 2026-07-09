"use client";

import { useRef, type ReactNode } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { ChartCard } from "./chart-card";
import { formatCurrency } from "./analytics-utils";

interface StackTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}

function StackTooltipContent({ active, payload, label }: StackTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-3 py-2 shadow-[0_2px_10px_rgba(28,28,29,0.08)]">
      <p className="text-xs text-[rgba(28,28,29,0.44)]">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="text-xs" style={{ color: p.color }}>
          {p.name}: {formatCurrency(p.value)}
        </p>
      ))}
    </div>
  );
}

interface StackedChartCardProps {
  title: string;
  description: string;
  data: Array<{ date: string; [symbol: string]: number | string }>;
  keys: string[];
  colors?: Record<string, string>;
  headerAction?: ReactNode;
}

export function StackedChartCard({ title, description, data, keys, colors, headerAction }: StackedChartCardProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  return (
    <ChartCard title={title} description={description} headerAction={headerAction} chartRef={chartRef}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(28,28,29,0.12)" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: "rgba(28,28,29,0.72)", fontSize: 12 }} axisLine={false} tickLine={false} />
          <Tooltip content={<StackTooltipContent />} />
          <Legend
            formatter={(value: string) => (
              <span className="text-sm text-[rgba(28,28,29,0.72)]">{value}</span>
            )}
          />
          {keys.map((key) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="a"
              fill={colors?.[key] ?? "#888"}
              radius={[2, 2, 0, 0]}
              maxBarSize={24}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
