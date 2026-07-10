"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface DatabricksDashboardProps {
  className?: string;
}

export function DatabricksDashboard({ className }: DatabricksDashboardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Databricks dashboard configuration
  const dashboardConfig = {
    instanceUrl: ""  // Set via NEXT_PUBLIC_DATABRICKS_INSTANCE_URL,
    workspaceId: ""  // Set via NEXT_PUBLIC_DATABRICKS_WORKSPACE_ID,
    dashboardId: ""  // Set via NEXT_PUBLIC_DATABRICKS_DASHBOARD_ID,
    // Filter parameters from the URL
    filters: {
      "f_page1~6a778f9a": JSON.stringify({
        columns: ["color", "x"],
        rows: [["Artemis", "2026-05-22T00:00:00.000Z"]],
      }),
    },
  };

  // Build the embed URL with filters
  const embedUrl = useMemo(() => {
    const baseUrl = `${dashboardConfig.instanceUrl}/embed/dashboardsv3/${dashboardConfig.dashboardId}`;
    const params = new URLSearchParams({
      o: dashboardConfig.workspaceId,
      ...dashboardConfig.filters,
    });
    return `${baseUrl}?${params.toString()}`;
  }, []);

  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    let loaded = false;

    const handleLoad = () => {
      loaded = true;
      setIsLoading(false);
    };

    const handleError = () => {
      if (!loaded) {
        setError("Failed to load Databricks dashboard");
        setIsLoading(false);
      }
    };

    iframe.addEventListener("load", handleLoad);
    iframe.addEventListener("error", handleError);

    return () => {
      iframe.removeEventListener("load", handleLoad);
      iframe.removeEventListener("error", handleError);
    };
  }, []);

  if (error) {
    return (
      <div className={cn("flex min-h-[400px] items-center justify-center", className)}>
        <div className="w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">Unable to load Databricks dashboard</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.56)]">{error}</p>
          <div className="mt-4">
            <a
              href={`https://${dashboardConfig.instanceUrl}/dashboardsv3/${dashboardConfig.dashboardId}?o=${dashboardConfig.workspaceId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open in Databricks
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#fcfcfa] z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-3 border-blue-600 border-t-transparent" />
            <p className="text-sm text-[rgba(28,28,29,0.56)]">Loading Databricks dashboard...</p>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={embedUrl}
        width="100%"
        height="800"
        frameBorder={0}
        className={cn("w-full border-0 bg-white", isLoading ? "opacity-0" : "opacity-100")}
        title="Databricks Analytics Dashboard"
        allow="clipboard-write; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}

function useMemo<T>(factory: () => T, deps: React.DependencyList): T {
  const ref = useRef<{ deps: React.DependencyList; value: T } | null>(null);
  if (!ref.current || !depsAreEqual(ref.current.deps, deps)) {
    ref.current = { deps, value: factory() };
  }
  return ref.current.value;
}

function depsAreEqual(a: React.DependencyList, b: React.DependencyList): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}