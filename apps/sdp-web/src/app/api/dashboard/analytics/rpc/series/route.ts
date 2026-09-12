import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { UserAnalyticsResponse } from "@/app/dashboard/analytics/analytics-types";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

/**
 * GET /api/dashboard/analytics/rpc/series
 *
 * Per-day transaction counts for every mint the signed-in account issued, one
 * entry per token so the dashboard can render a grid in a single round trip
 * rather than one request per card.
 *
 * The mint list is resolved server-side from /v1/data-products/user-analytics
 * and is never taken from the caller. An optional `mint` narrows the response
 * to one token, but only after it is checked against that list — a mint the
 * account did not issue is a 403, not a proxied request.
 *
 * One token failing upstream does not fail the response: that entry carries an
 * `error` and the rest still render.
 *
 * Query params: `mint` (optional), `days` (1-365, default 30),
 * `cluster` (allowlisted).
 */

const CLUSTERS = ["devnet", "mainnet-beta", "testnet"] as const;
type Cluster = (typeof CLUSTERS)[number];

const DEFAULT_CLUSTER: Cluster = "devnet";
const DEFAULT_DAYS = 30;

// A series walks every signature in the window, so it can run longer than the
// single-count call. Still bounded — the chart shows an error rather than hang.
const SERIES_TIMEOUT_MS = 30_000;
// The metrics API runs two gunicorn workers; a wider fan-out would just queue.
const MAX_CONCURRENCY = 4;

interface TokenSeries {
  mint: string;
  series: Array<{ date: string; transactionCount: number }>;
  since: string | null;
  error?: string;
}

/** Maps `items` with at most `limit` in flight, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fetchSeries(
  baseUrl: string,
  mint: string,
  cluster: string,
  days: number,
  traceId: string
): Promise<TokenSeries> {
  const query = new URLSearchParams({ mint, cluster, days: String(days) });

  try {
    const upstream = await fetch(`${baseUrl}/rpc/series?${query.toString()}`, {
      headers: { "X-SDP-Trace-ID": traceId, "X-SDP-Source": "sdp-web" },
      cache: "no-store",
      signal: AbortSignal.timeout(SERIES_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      return { mint, series: [], since: null, error: `upstream ${upstream.status}` };
    }

    const body = (await upstream.json()) as {
      series?: Array<{ date: string; transactionCount: number }>;
      since?: string;
    };

    return { mint, series: body.series ?? [], since: body.since ?? null };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    return { mint, series: [], since: null, error: reason };
  }
}

const BASE58_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function metricsApiBaseUrl(): string | null {
  const base = process.env.METRICS_API_BASE_URL;
  return base ? base.replace(/\/$/, "") : null;
}

function parseDays(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
    return DEFAULT_DAYS;
  }
  return parsed;
}

function parseCluster(raw: string | null): Cluster {
  return CLUSTERS.includes(raw as Cluster) ? (raw as Cluster) : DEFAULT_CLUSTER;
}

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.analytics.rpc.series", request);

  const { userId, orgId } = await auth();
  if (!userId) {
    logRouteResult(trace, 401);
    return NextResponse.json({ error: { message: "Authentication required" } }, { status: 401 });
  }
  if (!orgId) {
    logRouteResult(trace, 403);
    return NextResponse.json(
      { error: { message: "Active organization required" } },
      { status: 403 }
    );
  }

  const baseUrl = metricsApiBaseUrl();
  if (!baseUrl) {
    logRouteResult(trace, 500);
    return NextResponse.json(
      { error: { message: "METRICS_API_BASE_URL is not configured" } },
      { status: 500 }
    );
  }

  const params = new URL(request.url).searchParams;
  const days = parseDays(params.get("days"));
  const cluster = parseCluster(params.get("cluster"));
  const requestedMint = params.get("mint");

  let tokens: UserAnalyticsResponse["tokens"];
  try {
    const apiClient = await createOrgSdpApiClient(
      trace.childContext("route.dashboard.analytics.rpc.series.api")
    );
    const userAnalytics = await apiClient.fetch<UserAnalyticsResponse>(
      "/v1/data-products/user-analytics"
    );
    tokens = userAnalytics.tokens ?? [];
  } catch (error) {
    console.error("User analytics lookup failed:", error);
    logRouteResult(trace, 502);
    return NextResponse.json(
      { error: { message: "Unable to resolve tokens for this account" } },
      { status: 502 }
    );
  }

  const ownedMints = [
    ...new Set(
      tokens
        .map((token) => token.mintAddress)
        .filter((mint): mint is string => !!mint && BASE58_MINT.test(mint))
    ),
  ];

  // Authorisation, not validation: the caller may only chart what they issued.
  if (requestedMint && !ownedMints.includes(requestedMint)) {
    logRouteResult(trace, 403);
    return NextResponse.json(
      { error: { message: "Unknown mint for this account" } },
      { status: 403 }
    );
  }

  const mints = requestedMint ? [requestedMint] : ownedMints;

  const series = await mapWithLimit(mints, MAX_CONCURRENCY, (mint) =>
    fetchSeries(baseUrl, mint, cluster, days, trace.traceId)
  );

  logRouteResult(trace, 200);
  return NextResponse.json(
    {
      data: { cluster, days, tokens: series },
      meta: { requestId: trace.traceId, timestamp: new Date().toISOString() },
    },
    {
      headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
    }
  );
}
