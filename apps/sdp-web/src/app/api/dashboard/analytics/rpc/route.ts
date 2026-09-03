import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type {
  TokenActivity,
  UserAnalyticsResponse,
} from "@/app/dashboard/analytics/analytics-types";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

/**
 * GET /api/dashboard/analytics/rpc
 *
 * On-chain transaction activity for the tokens the signed-in account issued.
 *
 * The mint list is never taken from the caller. It is resolved server-side from
 * /v1/data-products/user-analytics, which is already org-scoped by the Clerk
 * JWT, so this route can only ever report on mints the account actually issued.
 * The upstream metrics API is unauthenticated and its /rpc accepts an arbitrary
 * `rpc` URL, which is why it is never exposed to the browser directly and why
 * no client-supplied parameter reaches it unvalidated.
 *
 * Query params: `days` (1-365, default 30), `cluster` (allowlisted),
 * `refresh=true` to bypass the metrics API's Delta-backed cache.
 */

const CLUSTERS = ["devnet", "mainnet-beta", "testnet"] as const;
type Cluster = (typeof CLUSTERS)[number];

const DEFAULT_CLUSTER: Cluster = "devnet";
const DEFAULT_DAYS = 30;

// Signature pagination on a cache miss can run long. Cap the wait so one busy
// mint cannot hold the whole table hostage — a timed-out mint reports null and
// the row still renders.
const RPC_TIMEOUT_MS = 20_000;
// The metrics API runs two gunicorn workers; a wider fan-out would just queue.
const MAX_CONCURRENCY = 4;

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

async function fetchActivity(
  baseUrl: string,
  mint: string,
  cluster: Cluster,
  days: number,
  refresh: boolean,
  traceId: string
): Promise<TokenActivity> {
  const query = new URLSearchParams({ mint, cluster, days: String(days) });
  if (refresh) {
    query.set("refresh", "true");
  }

  try {
    const upstream = await fetch(`${baseUrl}/rpc?${query.toString()}`, {
      headers: { "X-SDP-Trace-ID": traceId, "X-SDP-Source": "sdp-web" },
      cache: "no-store",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      return {
        mint,
        cluster,
        days,
        transactionCount: null,
        since: null,
        cached: null,
        error: `upstream ${upstream.status}`,
      };
    }

    // Echo the upstream's own cluster/days back rather than the requested ones
    // where present, so a cached row that answered a different window is not
    // mislabelled with the window we asked for.
    const body = (await upstream.json()) as {
      cluster?: string;
      days?: number;
      transactionCount?: number;
      since?: string;
    };

    return {
      mint,
      cluster: body.cluster ?? cluster,
      days: typeof body.days === "number" ? body.days : days,
      transactionCount: typeof body.transactionCount === "number" ? body.transactionCount : null,
      since: body.since ?? null,
      // The metrics API reports cache state in a header so the JSON body stays
      // identical to its Delta table schema.
      cached: upstream.headers.get("X-Cache") === "HIT",
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
    return { mint, cluster, days, transactionCount: null, since: null, cached: null, error: reason };
  }
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

export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.analytics.rpc", request);

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
  const refresh = params.get("refresh") === "true";

  let tokens: UserAnalyticsResponse["tokens"];
  try {
    const apiClient = await createOrgSdpApiClient(
      trace.childContext("route.dashboard.analytics.rpc.api")
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

  // Only deployed tokens have a mint to look up; drop anything that would not
  // survive as a base58 address before it reaches the RPC.
  const mints = [
    ...new Set(
      tokens
        .map((token) => token.mintAddress)
        .filter((mint): mint is string => !!mint && BASE58_MINT.test(mint))
    ),
  ];

  const activity = await mapWithLimit(mints, MAX_CONCURRENCY, (mint) =>
    fetchActivity(baseUrl, mint, cluster, days, refresh, trace.traceId)
  );

  logRouteResult(trace, 200);

  return NextResponse.json(
    {
      data: { activity, days, cluster, lastUpdated: new Date().toISOString() },
      meta: { requestId: trace.traceId, timestamp: new Date().toISOString() },
    },
    {
      headers: { "X-SDP-Trace-ID": trace.traceId, "Server-Timing": trace.serverTiming() },
    }
  );
}
