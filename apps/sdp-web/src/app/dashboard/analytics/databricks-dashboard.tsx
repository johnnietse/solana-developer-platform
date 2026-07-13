"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  BarChart3Icon,
  ExternalLinkIcon,
  RefreshCwIcon,
  DatabaseIcon,
} from "lucide-react";

// ── Loading skeleton ──────────────────────────────────────────
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-1">
      {/* KPI card row */}
      <div className="grid grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl bg-[rgba(28,28,29,0.03)] p-4">
            <div className="h-3 w-16 animate-pulse rounded bg-[rgba(28,28,29,0.08)]" />
            <div className="mt-1 h-6 w-24 animate-pulse rounded bg-[rgba(28,28,29,0.1)]" />
            <div className="mt-0.5 h-2 w-20 animate-pulse rounded bg-[rgba(28,28,29,0.06)]" />
          </div>
        ))}
      </div>

      {/* Chart row — 2-column */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-3 rounded-xl bg-[rgba(28,28,29,0.03)] p-5">
          <div className="h-3 w-28 animate-pulse rounded bg-[rgba(28,28,29,0.08)]" />
          <div className="h-3 w-20 animate-pulse rounded bg-[rgba(28,28,29,0.06)]" />
          <div className="mt-2 flex items-end gap-2">
            {[40, 65, 45, 80, 55, 70, 50].map((h, i) => (
              <div
                key={i}
                className="flex-1 animate-pulse rounded-t bg-[rgba(28,28,29,0.1)]"
                style={{ height: `${h}px` }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 rounded-xl bg-[rgba(28,28,29,0.03)] p-5">
          <div className="h-3 w-24 animate-pulse rounded bg-[rgba(28,28,29,0.08)]" />
          <div className="h-3 w-16 animate-pulse rounded bg-[rgba(28,28,29,0.06)]" />
          <div className="mt-2 flex items-end gap-2">
            {[55, 70, 40, 60, 75, 45, 65].map((h, i) => (
              <div
                key={i}
                className="flex-1 animate-pulse rounded-t bg-[rgba(28,28,29,0.1)]"
                style={{ height: `${h}px` }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Wide chart placeholder */}
      <div className="flex flex-col gap-3 rounded-xl bg-[rgba(28,28,29,0.03)] p-5">
        <div className="h-3 w-32 animate-pulse rounded bg-[rgba(28,28,29,0.08)]" />
        <div className="h-3 w-24 animate-pulse rounded bg-[rgba(28,28,29,0.06)]" />
        <div className="mt-2 flex items-end gap-2">
          {[30, 45, 35, 55, 40, 50, 38, 60, 42, 48, 35, 52].map((h, i) => (
            <div
              key={i}
              className="flex-1 animate-pulse rounded-t bg-[rgba(28,28,29,0.1)]"
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Accent stripe ─────────────────────────────────────────────
function AccentBar() {
  return (
    <div className="flex h-1 overflow-hidden rounded-t-2xl bg-gradient-to-r from-[#FF3621] via-[#FF6D00] to-[#FFB800]" />
  );
}

// ── Main component ────────────────────────────────────────────
interface DatabricksDashboardProps {
  className?: string;
}

export function DatabricksDashboard({ className }: DatabricksDashboardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Databricks dashboard configuration — from env vars only, no hardcoded defaults
  const instanceUrl = process.env.NEXT_PUBLIC_DATABRICKS_INSTANCE_URL;
  const workspaceId = process.env.NEXT_PUBLIC_DATABRICKS_WORKSPACE_ID;
  const dashboardId = process.env.NEXT_PUBLIC_DATABRICKS_DASHBOARD_ID;
  const isConfigured = !!(instanceUrl && workspaceId && dashboardId);

  const dashboardConfig = {
    instanceUrl: instanceUrl ?? "",
    workspaceId: workspaceId ?? "",
    dashboardId: dashboardId ?? "",
    filters: {
      "f_page1~6a778f9a": JSON.stringify({
        columns: ["color", "x"],
        rows: [["Artemis", "2026-05-22T00:00:00.000Z"]],
      }),
    },
  };

  const directUrl = isConfigured
    ? `${dashboardConfig.instanceUrl}/dashboardsv3/${dashboardConfig.dashboardId}?o=${dashboardConfig.workspaceId}`
    : "#";

  const embedUrl = useMemo(() => {
    if (!isConfigured) return "";
    const baseUrl = `${dashboardConfig.instanceUrl}/embed/dashboardsv3/${dashboardConfig.dashboardId}`;
    const params = new URLSearchParams({
      o: dashboardConfig.workspaceId,
      ...dashboardConfig.filters,
    });
    return `${baseUrl}?${params.toString()}`;
  }, [isConfigured]);

  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    let loaded = false;

    const handleLoad = () => {
      loaded = true;
      setLoadedOnce(true);
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

  const handleRefresh = () => {
    if (!iframeRef.current) return;
    setError(null);
    setIsLoading(true);
    iframeRef.current.src = embedUrl;
  };

  // ── Not configured state ─────────────────────────────────
  if (!isConfigured) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <div className={cn("overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white shadow-[0_2px_10px_rgba(28,28,29,0.05)]", className)}>
          <AccentBar />
          <div className="flex items-center justify-between border-b border-[rgba(28,28,29,0.1)] px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.06)]">
                <BarChart3Icon className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
              </div>
              <div>
                <p className="text-[15px] font-medium text-[#1c1c1d]">Databricks Dashboard</p>
                <p className="text-xs text-[rgba(28,28,29,0.56)]">Token analytics overview</p>
              </div>
            </div>
          </div>
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(28,28,29,0.06)]">
              <DatabaseIcon className="h-6 w-6 text-[rgba(28,28,29,0.42)]" />
            </div>
            <div className="text-center">
              <p className="text-[17px] font-medium text-[#1c1c1d]">Databricks not configured</p>
              <p className="mt-1 text-sm text-[rgba(28,28,29,0.56)]">
                Set <code className="rounded bg-[rgba(28,28,29,0.06)] px-1 py-0.5 font-mono text-xs">NEXT_PUBLIC_DATABRICKS_INSTANCE_URL</code>,{" "}
                <code className="rounded bg-[rgba(28,28,29,0.06)] px-1 py-0.5 font-mono text-xs">WORKSPACE_ID</code>, and{" "}
                <code className="rounded bg-[rgba(28,28,29,0.06)] px-1 py-0.5 font-mono text-xs">DASHBOARD_ID</code>{" "}
                in your environment.
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Error state ──────────────────────────────────────────
  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <div
          className={cn(
            "overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white shadow-[0_2px_10px_rgba(28,28,29,0.05)]",
            className,
          )}
        >
          <AccentBar />
          <div className="flex items-center justify-between border-b border-[rgba(28,28,29,0.1)] px-6 py-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[rgba(28,28,29,0.06)]">
                <BarChart3Icon className="h-4 w-4 text-[rgba(28,28,29,0.72)]" />
              </div>
              <div>
                <p className="text-[15px] font-medium text-[#1c1c1d]">
                  Databricks Dashboard
                </p>
                <p className="text-xs text-[rgba(28,28,29,0.56)]">
                  Token analytics overview
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleRefresh}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-3 py-1.5 text-xs font-medium text-[rgba(28,28,29,0.72)] transition-colors hover:bg-white hover:text-[#1c1c1d]"
            >
              <RefreshCwIcon className="h-3 w-3" />
              Retry
            </button>
          </div>
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 px-6 py-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <BarChart3Icon className="h-6 w-6 text-red-500" />
            </div>
            <div className="text-center">
              <p className="text-[17px] font-medium text-[#1c1c1d]">
                Unable to load dashboard
              </p>
              <p className="mt-1 text-sm text-[rgba(28,28,29,0.56)]">
                {error}
              </p>
            </div>
            <a
              href={directUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Open in Databricks
              <ExternalLinkIcon className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Normal state ──────────────────────────────────────────
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div
        className={cn(
          "overflow-hidden rounded-2xl border border-[rgba(28,28,29,0.1)] bg-white shadow-[0_2px_10px_rgba(28,28,29,0.05)] transition-shadow hover:shadow-[0_4px_20px_rgba(28,28,29,0.08)]",
          className,
        )}
      >
        <AccentBar />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[rgba(28,28,29,0.1)] px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-50 to-amber-50">
              <DatabaseIcon className="h-4 w-4 text-[#FF6D00]" />
            </div>
            <div>
              <p className="text-[15px] font-medium text-[#1c1c1d]">
                Databricks Dashboard
              </p>
              <p className="text-xs text-[rgba(28,28,29,0.56)]">
                Token analytics overview
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-3 py-1.5 text-xs font-medium text-[rgba(28,28,29,0.72)] transition-colors hover:bg-white hover:text-[#1c1c1d]",
                isLoading && "cursor-not-allowed opacity-50",
              )}
            >
              <RefreshCwIcon
                className={cn("h-3 w-3", isLoading && "animate-spin")}
              />
              {isLoading ? "Loading..." : "Refresh"}
            </button>
            <a
              href={directUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-3 py-1.5 text-xs font-medium text-[rgba(28,28,29,0.72)] transition-colors hover:bg-white hover:text-[#1c1c1d]"
            >
              Open in Databricks
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          </div>
        </div>

        {/* Iframe body */}
        <div className="relative">
          {isLoading && (
            <div className="p-6">
              <DashboardSkeleton />
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={embedUrl}
            width="100%"
            height={isLoading && !loadedOnce ? undefined : 800}
            frameBorder={0}
            className={cn(
              "w-full border-0 transition-all duration-500",
              isLoading && !loadedOnce
                ? "h-0 overflow-hidden opacity-0"
                : "opacity-100",
              loadedOnce && isLoading && "h-0 overflow-hidden opacity-0",
            )}
            title="Databricks Analytics Dashboard"
            allow="clipboard-write; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[rgba(28,28,29,0.1)] px-6 py-3">
          <div className="flex items-center gap-2 text-xs text-[rgba(28,28,29,0.42)]">
            <DatabaseIcon className="h-3 w-3" />
            <span>Powered by Databricks SQL Warehouse</span>
          </div>
          {!isLoading && (
            <span className="text-xs text-[rgba(28,28,29,0.42)]">
              Last loaded just now
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

