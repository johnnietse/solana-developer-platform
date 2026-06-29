"use client";

import { SkeletonBlock } from "@/components/ui/skeleton-block";

export function AnalyticsLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <SkeletonBlock key={i} className="h-52 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SkeletonBlock className="h-96 rounded-xl" />
        <SkeletonBlock className="h-96 rounded-xl" />
      </div>
    </div>
  );
}
