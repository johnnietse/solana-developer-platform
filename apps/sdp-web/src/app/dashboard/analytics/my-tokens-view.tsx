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
import { AreaChartCard } from "./area-chart-card";
import { Select, SelectItem } from "@/components/ui/select";
import type {
  TokenActivity,
  TokenActivityResponse,
  TokenActivitySeriesResponse,
  TokenSeries,
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

/** Window options for the transactions charts, in days. */
const CHART_WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

/**
 * Daily transaction counts for every issued mint, in one request. Refetches
 * when the window changes, so the grid tracks the control rather than a
 * snapshot taken at mount.
 */
function useTransactionSeries(days: number, enabled: boolean) {
  const [tokens, setTokens] = useState<TokenSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTokens([]);
      return;
    }

    const controller = new AbortController();
    setTokens(null);
    setError(null);

    fetch(`/api/dashboard/analytics/rpc/series?days=${days}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((body: { data: TokenActivitySeriesResponse }) => setTokens(body.data.tokens ?? []))
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") {
          return;
        }
        setError(cause instanceof Error ? cause.message : "Unable to load activity");
      });

    return () => controller.abort();
  }, [days, enabled]);

  return { tokens, error };
}

function TokenChartCard({
  token,
  entry,
  days,
  error,
}: {
  token: UserAnalyticsResponse["tokens"][number];
  entry: TokenSeries | undefined;
  days: number;
  error: string | null;
}) {
  const points = (entry?.series ?? []).map((point) => ({
    date: point.date,
    value: point.transactionCount,
  }));
  const total = points.reduce((sum, point) => sum + point.value, 0);

  // Whole-request failure, this token's own failure, still loading, then data.
  const description = error
    ? error
    : entry?.error
      ? `Activity unavailable (${entry.error})`
      : entry === undefined
        ? "Loading on-chain activity…"
        : `${formatNumber(total)} transaction${total === 1 ? "" : "s"} over the last ${days} days`;

  return (
    <AreaChartCard
      title={token.symbol || token.name}
      description={description}
      data={points}
      color="#2163b6"
      gradientColor="#2163b6"
      formatValue={(v) => `${formatNumber(v)} tx`}
    />
  );
}

function TransactionsGrid({ tokens }: { tokens: UserAnalyticsResponse["tokens"] }) {
  // Only deployed tokens have a mint to chart.
  const charted = tokens.filter((token) => !!token.mintAddress);
  const [window, setWindow] = useState("30");
  const days = Number(window);
  const { tokens: series, error } = useTransactionSeries(days, charted.length > 0);

  if (charted.length === 0) {
    return null;
  }

  const byMint = new Map((series ?? []).map((entry) => [entry.mint, entry]));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay: 0.04 }}
      className="flex flex-col gap-3"
    >
      {/* Filters sit in one row above the charts. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">Transactions</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.56)]">
            Daily on-chain activity per issued token
          </p>
        </div>
        <Select
          value={window}
          onValueChange={(value) => {
            if (value) setWindow(value);
          }}
        >
          {CHART_WINDOWS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {charted.map((token) => (
          <TokenChartCard
            key={token.tokenId}
            token={token}
            entry={series === null ? undefined : byMint.get(token.mintAddress as string)}
            days={days}
            error={error}
          />
        ))}
      </div>
    </motion.div>
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

      <TransactionsGrid tokens={tokens} />

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