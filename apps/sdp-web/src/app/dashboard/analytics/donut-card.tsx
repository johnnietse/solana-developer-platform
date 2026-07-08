"use client";

import { useRef, type ReactElement, type ReactNode } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { ChartCard } from "./chart-card";
import { DONUT_COLORS } from "./analytics-utils";

interface CenterLabelProps {
  cx: number | string;
  cy: number | string;
  label: string;
  sublabel: string;
}

function CenterLabel({ cx, cy, label, sublabel }: CenterLabelProps) {
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
      <tspan x={cx} dy="-0.5em" className="text-xl font-semibold" fill="#1c1c1d">
        {label}
      </tspan>
      <tspan x={cx} dy="1.4em" className="text-xs" fill="rgba(28,28,29,0.72)">
        {sublabel}
      </tspan>
    </text>
  );
}

interface DonutCardProps {
  title: string;
  description: string;
  data: Array<{ name: string; value: number; holderCount?: number }>;
  centerLabel: string;
  centerSublabel: string;
  tooltip: ReactElement;
  colors?: string[];
  headerAction?: ReactNode;
  onItemClick?: (name: string) => void;
}

export function DonutCard({
  title,
  description,
  data,
  centerLabel,
  centerSublabel,
  tooltip,
  colors = DONUT_COLORS,
  headerAction,
  onItemClick,
}: DonutCardProps) {
  const chartRef = useRef<HTMLDivElement>(null);

  return (
    <ChartCard title={title} description={description} headerAction={headerAction} chartRef={chartRef}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={72}
            outerRadius={110}
            dataKey="value"
            strokeWidth={0}
            onClick={(d) => onItemClick?.(d.name as string)}
            style={{ cursor: onItemClick ? "pointer" : undefined }}
          >
            {data.map((_, i) => (
              <Cell key={`cell-${i}`} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip content={tooltip} />
          <Legend
            formatter={(value: string) => (
              <span className="text-sm text-[rgba(28,28,29,0.72)]">{value}</span>
            )}
          />
          <g>
            <CenterLabel cx="50%" cy="50%" label={centerLabel} sublabel={centerSublabel} />
          </g>
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
