"use client";

import type { ReactNode } from "react";

interface ChartCardProps {
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
  headerAction?: ReactNode;
  chartRef?: React.RefObject<HTMLDivElement | null>;
}

export function ChartCard({ title, description, children, className, headerAction, chartRef }: ChartCardProps) {
  return (
    <div
      className={`rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] shadow-[0_2px_10px_rgba(28,28,29,0.05)] print:break-inside-avoid print:border print:border-gray-300 print:shadow-none print:mb-4 ${className ?? ""}`}
      role="region"
      aria-label={`${title}: ${description}`}
    >
      <div className="flex items-start justify-between gap-4 p-5 pb-0">
        <div className="min-w-0">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">{title}</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.56)]">{description}</p>
        </div>
        {headerAction && <div className="flex shrink-0 items-center gap-1">{headerAction}</div>}
      </div>
      <div className="p-5">
        <div ref={chartRef} className="h-60 md:h-72 lg:h-80">{children}</div>
      </div>
    </div>
  );
}
