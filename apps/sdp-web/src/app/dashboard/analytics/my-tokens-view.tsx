"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CoinsIcon } from "lucide-react";
import { formatCurrency, formatNumber } from "./analytics-utils";
import { AnalyticsEmptyState } from "./analytics-empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  TokenActivity,
  TokenActivityResponse,
  UserAnalyticsResponse,
} from "./analytics-types";

interface MyTokensViewProps {
  data: UserAnalyticsResponse | null;
}

const ACTIVITY_DAYS = 30;

/**
 * On-chain activity is fetched from the client rather than in the server page
 * because a cache miss walks RPC signature pages per mint — slow enough that
 * blocking the whole Analytics render on it would be worse than an empty cell
 * that fills in a moment later.
 */
function useTokenActivity(enabled: boolean) {
  const [activity, setActivity] = useState<Map<string, TokenActivity> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const controller = new AbortController();

    fetch(`/api/dashboard/analytics/rpc?days=${ACTIVITY_DAYS}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { data: TokenActivityResponse }) => {
        setActivity(new Map(body.data.activity.map((entry) => [entry.mint, entry])));
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        setFailed(true);
      });

    return () => controller.abort();
  }, [enabled]);

  return { activity, failed };
}

/** Formats the `since` cutoff (ISO-8601 from /rpc) as a short local date. */
function formatSince(since: string): string {
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime())
    ? since
    : parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function ActivityCell({
  mint,
  activity,
  failed,
  field,
}: {
  mint: string | null;
  activity: Map<string, TokenActivity> | null;
  failed: boolean;
  field: "cluster" | "days" | "transactionCount" | "since";
}) {
  // A token with no mint was never deployed, so there is nothing on-chain to
  // count — that is a real "—", not a pending lookup.
  if (!mint) {
    return <span className="text-[rgba(28,28,29,0.4)]">—</span>;
  }

  if (failed) {
    return <span className="text-[rgba(28,28,29,0.4)]">—</span>;
  }

  if (!activity) {
    return <span className="inline-block h-4 w-12 animate-pulse rounded bg-[rgba(28,28,29,0.08)]" />;
  }

  const entry = activity.get(mint);
  const value = entry?.[field] ?? null;

  if (!entry || value === null) {
    return (
      <span className="text-[rgba(28,28,29,0.4)]" title={entry?.error ?? "No data"}>
        —
      </span>
    );
  }

  const title = entry.cached ? "From cache" : "Live from RPC";

  if (field === "transactionCount") {
    return (
      <span className="text-[#1c1c1d]" title={title}>
        {formatNumber(value as number)}
      </span>
    );
  }

  if (field === "since") {
    return (
      <span className="text-[rgba(28,28,29,0.72)]" title={value as string}>
        {formatSince(value as string)}
      </span>
    );
  }

  return (
    <span className="text-[rgba(28,28,29,0.72)]" title={title}>
      {String(value)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[18px] border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-6 py-6 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <p className="text-[15px] text-[rgba(28,28,29,0.56)]">{label}</p>
      <p className="mt-2 text-[24px] leading-none font-medium tracking-[-0.03em] text-[#1c1c1d] sm:text-[30px]">
        {value}
      </p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-28 animate-pulse rounded-[18px] bg-[rgba(28,28,29,0.05)]"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl bg-[rgba(28,28,29,0.05)]" />
    </div>
  );
}

export function MyTokensView({ data }: MyTokensViewProps) {
  // Must run before the early returns below — a hook cannot sit behind a
  // conditional, and `data` arrives null on the first render.
  const { activity, failed } = useTokenActivity((data?.tokens.length ?? 0) > 0);

  if (!data) {
    return <LoadingSkeleton />;
  }

  const { tokens, summary } = data;

  if (tokens.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
      >
        <AnalyticsEmptyState
          icon={CoinsIcon}
          title="No tokens found"
          description="No tokens found. Create your first token to see analytics."
        />
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-4"
      >
        <SummaryCard label="Total Tokens" value={formatNumber(summary.totalTokens)} />
        <SummaryCard label="Total Supply" value={formatCurrency(summary.totalSupply)} />
        <SummaryCard label="Total Holders" value={formatNumber(summary.totalHolders)} />
        <SummaryCard
          label="Deployed / Pending"
          value={`${summary.deployedTokens} / ${summary.pendingTokens}`}
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut", delay: 0.08 }}
        className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] shadow-[0_2px_10px_rgba(28,28,29,0.05)]"
      >
        <div className="p-5 pb-0">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">My Tokens</p>
          <p className="text-sm text-[rgba(28,28,29,0.56)]">
            All tokens created under your account
          </p>
        </div>
        <div className="overflow-x-auto p-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Mint Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Supply</TableHead>
                <TableHead>Holders</TableHead>
                <TableHead>Cluster</TableHead>
                <TableHead>Window (days)</TableHead>
                <TableHead>Transactions</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.tokenId}>
                  <TableCell className="font-medium text-[#1c1c1d]">
                    {token.name}
                  </TableCell>
                  <TableCell className="text-[rgba(28,28,29,0.72)]">
                    {token.symbol}
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate font-mono text-xs text-[rgba(28,28,29,0.56)]">
                    {token.mintAddress ?? "—"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
                        token.status === "deployed"
                          ? "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
                          : token.status === "pending"
                            ? "bg-[rgba(217,119,6,0.1)] text-[#d97706]"
                            : "bg-[rgba(28,28,29,0.06)] text-[rgba(28,28,29,0.56)]"
                      }`}
                    >
                      {token.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-[#1c1c1d]">
                    {formatCurrency(token.totalSupply)}
                  </TableCell>
                  <TableCell className="text-[#1c1c1d]">
                    {formatNumber(token.holderCount)}
                  </TableCell>
                  {(["cluster", "days", "transactionCount", "since"] as const).map((field) => (
                    <TableCell key={field}>
                      <ActivityCell
                        mint={token.mintAddress}
                        activity={activity}
                        failed={failed}
                        field={field}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </motion.div>
    </div>
  );
}