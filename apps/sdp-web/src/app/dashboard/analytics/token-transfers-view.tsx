"use client";

/**
 * Token Transfers — how one issued token is performing on chain.
 *
 * This is the view the brief asks for. An institution issues a token through
 * the Issuance tab; this answers what happened to it afterwards. Pick one of
 * the account's tokens, and every number on the page describes that token and
 * nothing else.
 *
 * Three things are worth knowing before editing this file.
 *
 * 1. It speaks the DEPLOYED service's contract, not the one the rest of this
 *    directory was written against. The deployed /rpc takes ?mint= and returns
 *    one row per transaction touching the mint. The local service takes
 *    ?token_address= and returns a different row shape. The deployed service
 *    defaults the mint to USDC when the parameter is missing, so sending it the
 *    wrong parameter name returns a full, believable table for the wrong token.
 *
 * 2. Not every row has an amount. Amounts come from getTransaction, one call
 *    per signature, so the service resolves them under a budget and fills the
 *    rest on later requests. `resolved` says how many of `count` carry one.
 *    Volume is therefore a floor, not a total, and the page says so rather than
 *    printing a number that looks complete.
 *
 * 3. A quiet token is the normal case, not a failure. A token issued last week
 *    with one transaction is working exactly as expected, and the page says
 *    that in words instead of drawing an empty chart.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CoinsIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { UserTokenEntry } from "./analytics-types";

/* ── Deployed /rpc contract ─────────────────────────────────────────── */

/** What one transaction touching the mint did to it. */
type TransferKind = "transfer" | "mint" | "burn" | "no_movement";

interface TransferRow {
  mint: string;
  cluster: string;
  signature: string;
  slot: number;
  block_time: number | null;
  failed: boolean;
  fetched_at: string;

  // Present once the row has been resolved through getTransaction. `kind` null
  // means not resolved yet, which is different from "no_movement" — that is a
  // resolved answer saying the transaction touched the mint without moving it.
  kind: TransferKind | null;
  amount: number | null;
  decimals: number | null;
  /** Owner whose balance fell the most. Named `source` by the API. */
  source: string | null;
  /** Owner whose balance rose the most. */
  destination: string | null;
}

interface RpcResponse {
  mint: string;
  cluster: string;
  limit: number;
  /** Where the answer came from: the Delta cache, or the chain. */
  source: "s3" | "rpc";
  table: string;
  count: number;
  newly_cached: number;
  resolved: number;
  transfers: TransferRow[];
  cache_error?: string;

  // Only on a cache hit. `full` means the cache held a whole page; `fresh`
  // means it held fewer rows but recently enough to trust — the normal state
  // for a token that simply has not had many transactions.
  cache_reason?: "full" | "fresh";
  cache_age_seconds?: number | null;
}

const CLUSTERS = ["localnet", "devnet", "mainnet-beta", "testnet"] as const;
type Cluster = (typeof CLUSTERS)[number];

/**
 * The cluster this platform issues tokens on. Tokens deployed from the
 * dashboard live there, so looking them up on devnet always said "no
 * activity". localnet is the platform's own validator, served by the local
 * Polars container; the public clusters go to the deployed service.
 */
const PLATFORM_CLUSTER: Cluster = CLUSTERS.includes(
  process.env.NEXT_PUBLIC_SOLANA_NETWORK as Cluster
)
  ? (process.env.NEXT_PUBLIC_SOLANA_NETWORK as Cluster)
  : "devnet";

/**
 * Stand-in used when the account has no deployed token yet.
 *
 * A mint with real devnet activity, so the page demonstrates itself rather than
 * showing an empty shell. Labelled in the UI so nobody reads it as their own.
 */
const DEMO_TOKEN = {
  tokenId: "__demo__",
  mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  name: "Devnet USDC (example)",
  symbol: "USDC",
  status: "demo",
} as const;

interface SelectableToken {
  tokenId: string;
  mintAddress: string | null;
  name: string;
  symbol: string;
  status: string;
  createdAt?: string | null;
}

/* ── Formatting ─────────────────────────────────────────────────────── */

function shortAddress(value: string, head = 6, tail = 6) {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/**
 * Format to the token's own precision.
 *
 * Summing floats leaves noise — six transfers of 0.001 and 1.0 add up to
 * 2.0149999999999992 — and a volume figure with thirteen decimal places reads
 * as a broken number. The token's `decimals` is the precision that means
 * anything, so round there.
 */
function formatAmount(value: number | null, decimals: number | null) {
  if (value === null) return "—";
  const places = Math.min(decimals ?? 2, 9);
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: places,
  });
}

function formatWhen(row: TransferRow) {
  if (!row.block_time) return `slot ${row.slot}`;
  return new Date(row.block_time * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(unixSeconds: number | null) {
  if (!unixSeconds) return "unknown";
  const seconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (seconds < 90) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "12 s old", "4 min old" — how stale the cached page is. */
function describeAge(seconds: number) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s old`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min old`;
  return `${Math.round(minutes / 60)} h old`;
}

function explorerUrl(signature: string, cluster: string) {
  // mainnet-beta is the explorer's default and takes no query parameter.
  const suffix =
    cluster === "mainnet-beta"
      ? ""
      : cluster === "localnet"
        ? `?cluster=custom&customUrl=${encodeURIComponent("http://localhost:8899")}`
        : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/* ── Presentational pieces ──────────────────────────────────────────── */

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn" | "good";
}) {
  const valueColor =
    tone === "warn" ? "text-[#9e2b38]" : tone === "good" ? "text-[#0c804c]" : "text-[#1c1c1d]";
  return (
    <div className="rounded-xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-4 py-3">
      <p className="text-xs text-[rgba(28,28,29,0.56)]">{label}</p>
      <p className={`mt-1 text-[20px] leading-none font-medium tracking-[-0.02em] ${valueColor}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-[rgba(28,28,29,0.44)]">{sub}</p>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "deployed" || status === "active"
      ? "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
      : status === "pending"
        ? "bg-[rgba(217,119,6,0.1)] text-[#d97706]"
        : "bg-[rgba(28,28,29,0.06)] text-[rgba(28,28,29,0.56)]";
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

function KindPill({ kind }: { kind: TransferKind | null }) {
  if (kind === null) {
    return (
      <span
        className="inline-flex items-center rounded-md bg-[rgba(28,28,29,0.06)] px-1.5 py-0.5 text-xs text-[rgba(28,28,29,0.44)]"
        title="Amount not resolved yet — this row still needs a getTransaction call"
      >
        pending
      </span>
    );
  }
  const label = kind === "no_movement" ? "no movement" : kind;
  const tone =
    kind === "mint"
      ? "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
      : kind === "burn"
        ? "bg-[rgba(158,43,56,0.1)] text-[#9e2b38]"
        : kind === "transfer"
          ? "bg-[rgba(37,99,235,0.1)] text-[#2563eb]"
          : "bg-[rgba(28,28,29,0.06)] text-[rgba(28,28,29,0.56)]";
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

/* ── Derived metrics ────────────────────────────────────────────────── */

/**
 * Everything the page shows, derived in one place.
 *
 * Kept out of the JSX so each number has a name and a reason, and so the
 * distinction between "no data" and "zero" survives: `volume` is null when
 * nothing has been resolved, which renders as "—", where 0 would claim the
 * token moved nothing.
 */
function useMetrics(transfers: TransferRow[], decimals: number | null) {
  return useMemo(() => {
    const total = transfers.length;
    const failed = transfers.filter((t) => t.failed).length;
    const resolved = transfers.filter((t) => t.kind !== null);
    const moved = resolved.filter((t) => t.kind === "transfer" && t.amount !== null);

    const mints = resolved.filter((t) => t.kind === "mint");
    const burns = resolved.filter((t) => t.kind === "burn");

    const volume = moved.length
      ? moved.reduce((sum, t) => sum + (t.amount ?? 0), 0)
      : null;
    const largest = moved.length ? Math.max(...moved.map((t) => t.amount ?? 0)) : null;

    const counterparties = new Set<string>();
    for (const t of resolved) {
      if (t.source) counterparties.add(t.source);
      if (t.destination) counterparties.add(t.destination);
    }

    const times = transfers.map((t) => t.block_time).filter((t): t is number => t !== null);
    const newest = times.length ? Math.max(...times) : null;
    const oldest = times.length ? Math.min(...times) : null;

    // Transactions per day, oldest to newest, for the activity chart. Built
    // from block_time rather than fetched_at: when the chain saw it, not when
    // we did.
    const byDay = new Map<string, number>();
    for (const t of times) {
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    const activity = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({
        day,
        label: new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        count,
      }));

    const netSupply =
      mints.length || burns.length
        ? mints.reduce((s, t) => s + (t.amount ?? 0), 0) -
          burns.reduce((s, t) => s + (t.amount ?? 0), 0)
        : null;

    return {
      total,
      failed,
      failureRate: total ? failed / total : 0,
      resolvedCount: resolved.length,
      volume,
      largest,
      transferCount: moved.length,
      counterparties: counterparties.size,
      mints: mints.length,
      burns: burns.length,
      netSupply,
      newest,
      oldest,
      activity,
      decimals,
    };
  }, [transfers, decimals]);
}

/* ── View ───────────────────────────────────────────────────────────── */

export function TokenTransfersView({ tokens }: { tokens: UserTokenEntry[] | null }) {
  const [cluster, setCluster] = useState<Cluster>(PLATFORM_CLUSTER);
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<RpcResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /**
   * The account's tokens, falling back to the demo mint.
   *
   * Falls back when the list is empty *or* when nothing in it has been
   * deployed: a page listing three pending tokens and no activity reads as
   * broken, when in fact there is nothing on chain to query yet.
   */
  const list: SelectableToken[] = useMemo(() => {
    const own = (tokens ?? []).map((t) => ({
      tokenId: t.tokenId,
      mintAddress: t.mintAddress,
      name: t.name,
      symbol: t.symbol,
      status: t.status,
      createdAt: t.deployedAt ?? t.createdAt,
    }));
    // Always offered, not only when the account has no tokens: it is the one
    // row that exercises the deployed service and its S3 cache with real
    // devnet traffic, whatever cluster the account's own tokens live on.
    return [...own, DEMO_TOKEN];
  }, [tokens]);

  const load = useCallback(
    async (mint: string, forCluster: Cluster, rowLimit: number, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        mint,
        cluster: forCluster,
        limit: String(rowLimit),
      });
      // The deployed service answers from its S3 cache whenever that cache
      // holds a full page, so a busy mint never fetched again and showed weeks
      // old rows as current. Refresh asks it to go to the chain and write the
      // new rows back.
      if (refresh) query.set("refresh", "true");
      const res = await fetch(`/api/polars/rpc?${query.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.detail ?? json?.error ?? `HTTP ${res.status}`);
      setData(json as RpcResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Select the first token that has a mint, and load it once.
  useEffect(() => {
    if (selected) return;
    const first = list.find((t) => t.mintAddress);
    if (!first?.mintAddress) return;
    setSelected(first.mintAddress);
    void load(first.mintAddress, cluster, limit);
  }, [list, selected, cluster, limit, load]);

  const transfers = data?.transfers ?? [];
  const decimals = transfers.find((t) => t.decimals !== null)?.decimals ?? null;
  const m = useMetrics(transfers, decimals);
  const token = list.find((t) => t.mintAddress === selected);
  const isDemo = token?.tokenId === DEMO_TOKEN.tokenId;

  const reload = (mint = selected, c = cluster, n = limit, refresh = false) => {
    if (mint) void load(mint, c, n, refresh);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* ── Which token ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CoinsIcon className="h-4 w-4" />
            My Tokens
          </CardTitle>
          <CardDescription>
            Tokens issued under this account. Select one to see how it is performing on chain. A
            token with no mint address has not been deployed to a cluster yet, so there is nothing
            to measure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg border border-[rgba(28,28,29,0.08)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-[rgba(28,28,29,0.02)]">
                <tr className="border-b border-[rgba(28,28,29,0.1)]">
                  <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Name</th>
                  <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Symbol</th>
                  <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Mint address</th>
                  <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {list.map((t) => {
                  const isSelected = t.mintAddress === selected;
                  return (
                    <tr
                      key={t.tokenId}
                      className={`border-b border-[rgba(28,28,29,0.06)] last:border-0 ${
                        isSelected ? "bg-[rgba(37,99,235,0.06)]" : ""
                      }`}
                    >
                      <td className="px-3 py-2 font-medium text-[#1c1c1d]">{t.name}</td>
                      <td className="px-3 py-2 text-[rgba(28,28,29,0.72)]">{t.symbol}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[rgba(28,28,29,0.56)]">
                        {t.mintAddress ? shortAddress(t.mintAddress, 8, 8) : "not deployed"}
                      </td>
                      <td className="px-3 py-2">
                        <StatusPill status={t.status} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant={isSelected ? "default" : "outline"}
                          disabled={!t.mintAddress || loading}
                          onClick={() => {
                            if (!t.mintAddress) return;
                            setSelected(t.mintAddress);
                            // The example mint only exists on devnet; the
                            // account's own tokens live on the platform cluster.
                            const c: Cluster =
                              t.tokenId === DEMO_TOKEN.tokenId ? "devnet" : PLATFORM_CLUSTER;
                            setCluster(c);
                            reload(t.mintAddress, c);
                          }}
                        >
                          {isSelected ? "Selected" : "View activity"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {isDemo && (
            <p className="mt-3 text-xs text-[rgba(28,28,29,0.56)]">
              No deployed token on this account yet, so an example mint with real devnet activity
              is shown. It is not one of your tokens.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── How it is performing ───────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{token ? `${token.name} activity` : "Token activity"}</CardTitle>
          <CardDescription>
            The last {limit} transactions touching this mint, from GET /rpc. Served from the Delta
            cache on S3 when it already holds enough rows, otherwise fetched from the Solana RPC
            and written back.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {CLUSTERS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCluster(c);
                  reload(selected, c);
                }}
                disabled={loading}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  cluster === c
                    ? "border-blue-500 bg-blue-50 font-medium text-blue-700"
                    : "border-[rgba(28,28,29,0.12)] text-[rgba(28,28,29,0.56)] hover:border-[rgba(28,28,29,0.3)]"
                }`}
              >
                {c}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-2">
              {[25, 100, 250].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => {
                    setLimit(n);
                    reload(selected, cluster, n);
                  }}
                  disabled={loading}
                  className={`rounded-md border px-2 py-1 text-xs transition ${
                    limit === n
                      ? "border-[rgba(28,28,29,0.3)] font-medium text-[#1c1c1d]"
                      : "border-[rgba(28,28,29,0.12)] text-[rgba(28,28,29,0.56)]"
                  }`}
                >
                  {n} rows
                </button>
              ))}
              <Button size="sm" variant="outline" disabled={!selected || loading} onClick={() => reload(selected, cluster, limit, true)}>
                {loading ? "Loading..." : "Refresh"}
              </Button>
            </span>
          </div>

          {token?.mintAddress && (
            <p className="font-mono text-xs text-[rgba(28,28,29,0.56)]">
              {token.symbol} · {token.mintAddress}
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-[rgba(158,43,56,0.06)] px-3 py-2 text-sm text-[#9e2b38]">
              {error}
            </p>
          )}

          {data?.cache_error && (
            <p className="rounded-lg bg-[rgba(217,119,6,0.08)] px-3 py-2 text-sm text-[#d97706]">
              Transactions are live from the chain, but writing them back to the cache failed:{" "}
              {data.cache_error}
            </p>
          )}

          {/* Nothing on chain yet. Said in words, because an empty chart reads
              as a broken page when it is in fact a new token. */}
          {data && m.total === 0 && (
            <div className="rounded-xl border border-dashed border-[rgba(28,28,29,0.2)] px-5 py-8 text-center">
              <p className="text-[15px] font-medium text-[#1c1c1d]">No activity yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-[rgba(28,28,29,0.56)]">
                This mint has no transactions on {cluster}. That is expected for a token that was
                just issued: activity appears here as soon as someone transfers, mints or burns it.
              </p>
            </div>
          )}

          {data && m.total > 0 && (
            <>
              {/* Tier 0: available from signatures alone. */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard
                  label="Transactions"
                  value={String(m.total)}
                  sub={`newest ${m.activity.length} day${m.activity.length === 1 ? "" : "s"}`}
                />
                <StatCard
                  label="Last activity"
                  value={relativeTime(m.newest)}
                  sub={m.newest ? new Date(m.newest * 1000).toLocaleDateString() : undefined}
                  tone={m.newest && Date.now() / 1000 - m.newest > 30 * 86400 ? "warn" : "default"}
                />
                <StatCard
                  label="Failed"
                  value={`${m.failed}`}
                  sub={m.total ? `${(m.failureRate * 100).toFixed(1)}% of transactions` : undefined}
                  tone={m.failureRate > 0.1 ? "warn" : m.failed === 0 ? "good" : "default"}
                />
                <StatCard
                  label="Served from"
                  value={data.source === "s3" ? "S3 cache" : "Live RPC"}
                  sub={
                    data.source === "s3"
                      ? data.cache_age_seconds != null
                        ? `${describeAge(data.cache_age_seconds)}, chain not called`
                        : "chain not called"
                      : `${data.newly_cached} newly cached`
                  }
                />
              </div>

              {/* Tier 1: needs getTransaction, so it is reported with its own
                  coverage rather than presented as a complete total. */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard
                  label="Volume moved"
                  value={formatAmount(m.volume, m.decimals)}
                  sub={
                    m.resolvedCount < m.total
                      ? `at least — ${m.resolvedCount} of ${m.total} rows resolved`
                      : `across ${m.transferCount} transfers`
                  }
                />
                <StatCard
                  label="Largest transfer"
                  value={formatAmount(m.largest, m.decimals)}
                  sub={m.transferCount ? "single transaction" : "no transfers resolved"}
                />
                <StatCard
                  label="Counterparties"
                  value={m.counterparties ? String(m.counterparties) : "—"}
                  sub="distinct wallets seen"
                />
                <StatCard
                  label="Supply events"
                  value={m.mints + m.burns ? `${m.mints} / ${m.burns}` : "—"}
                  sub={
                    m.netSupply !== null
                      ? `net ${m.netSupply >= 0 ? "+" : ""}${formatAmount(m.netSupply, m.decimals)}`
                      : "mints / burns"
                  }
                />
              </div>

              {m.resolvedCount < m.total && (
                <p className="text-xs text-[rgba(28,28,29,0.56)]">
                  {m.total - m.resolvedCount} row{m.total - m.resolvedCount === 1 ? "" : "s"} have
                  not had their amounts resolved yet. Amounts come from one getTransaction call per
                  transaction, which the service budgets per request and fills in over subsequent
                  loads, so volume here is a floor rather than a total.
                </p>
              )}

              {/* Activity over time. One bar per day the chain saw something. */}
              {m.activity.length > 1 && (
                <div className="rounded-xl border border-[rgba(28,28,29,0.08)] p-4">
                  <p className="mb-3 text-sm font-medium text-[#1c1c1d]">Transactions per day</p>
                  <div className="h-48 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={m.activity} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(28,28,29,0.08)" vertical={false} />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: "rgba(28,28,29,0.56)" }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fontSize: 11, fill: "rgba(28,28,29,0.56)" }}
                          tickLine={false}
                          axisLine={false}
                          width={28}
                        />
                        <Tooltip
                          cursor={{ fill: "rgba(37,99,235,0.06)" }}
                          contentStyle={{
                            borderRadius: 10,
                            border: "1px solid rgba(28,28,29,0.1)",
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="count" name="Transactions" fill="#2563eb" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* The rows themselves. */}
              <div className="max-h-[28rem] overflow-auto rounded-lg border border-[rgba(28,28,29,0.08)]">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-[rgba(28,28,29,0.1)]">
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">When</th>
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Type</th>
                      <th className="px-3 py-2 text-right font-medium text-[rgba(28,28,29,0.56)]">
                        Amount
                      </th>
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">From</th>
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">To</th>
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Result</th>
                      <th className="px-3 py-2 font-medium text-[rgba(28,28,29,0.56)]">Signature</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transfers.map((row) => (
                      <tr
                        key={row.signature}
                        className="border-b border-[rgba(28,28,29,0.06)] last:border-0"
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-[rgba(28,28,29,0.72)]">
                          {formatWhen(row)}
                        </td>
                        <td className="px-3 py-2">
                          <KindPill kind={row.kind} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          {formatAmount(row.amount, row.decimals ?? decimals)}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-[rgba(28,28,29,0.56)]">
                          {row.source ? shortAddress(row.source) : "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-[rgba(28,28,29,0.56)]">
                          {row.destination ? shortAddress(row.destination) : "—"}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ${
                              row.failed
                                ? "bg-[rgba(158,43,56,0.1)] text-[#9e2b38]"
                                : "bg-[rgba(12,128,76,0.1)] text-[#0c804c]"
                            }`}
                          >
                            {row.failed ? "failed" : "success"}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <a
                            href={explorerUrl(row.signature, row.cluster)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 underline-offset-2 hover:underline"
                          >
                            {shortAddress(row.signature, 6, 6)}
                            <ExternalLinkIcon className="h-3 w-3" />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Where every number above came from, and how old it is. */}
              <p className="text-xs text-[rgba(28,28,29,0.44)]">
                Source table {data.table} ·{" "}
                {data.source === "s3"
                  ? `read from cache (${data.cache_reason ?? "hit"})`
                  : "fetched from chain"}{" "}
                ·{" "}
                {m.resolvedCount}/{m.total} rows resolved · newest transaction{" "}
                {relativeTime(m.newest)}
                {transfers[0]?.fetched_at
                  ? ` · cached ${relativeTime(Math.floor(new Date(transfers[0].fetched_at).getTime() / 1000))}`
                  : ""}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
