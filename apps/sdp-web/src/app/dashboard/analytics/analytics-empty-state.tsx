"use client";

import type { LucideIcon } from "lucide-react";
import { InboxIcon } from "lucide-react";

export function AnalyticsEmptyState({
  icon: Icon = InboxIcon,
  title,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <Icon className="h-10 w-10 text-[rgba(28,28,29,0.44)]" />
      <p className="text-base font-medium text-[rgba(28,28,29,0.72)]">{title}</p>
      <p className="max-w-sm text-center text-sm text-[rgba(28,28,29,0.44)]">{description}</p>
    </div>
  );
}
