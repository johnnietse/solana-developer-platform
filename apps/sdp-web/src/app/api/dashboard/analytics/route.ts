import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";

/**
 * GET /api/dashboard/analytics
 *
 * Proxies to the SDP API's analytics data product endpoint.
 * This is a public data product (no project context required).
 * Falls back to mock data if the upstream is unavailable.
 */
export async function GET(request: Request) {
  const trace = createTimedTrace("route.dashboard.analytics", request);

  const { userId } = await auth();
  if (!userId) {
    logRouteResult(trace, 401);
    return NextResponse.json({ error: { message: "Authentication required" } }, { status: 401 });
  }

  const apiBaseUrl =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL;

  if (!apiBaseUrl) {
    logRouteResult(trace, 500);
    return NextResponse.json(
      { error: { message: "SDP API base URL not configured" } },
      { status: 500 }
    );
  }

  try {
    const upstreamUrl = `${apiBaseUrl.replace(/\/$/, "")}/v1/data-products/analytics`;
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-SDP-Trace-ID": trace.traceId,
        "X-SDP-Source": "sdp-web",
      },
      cache: "no-store",
    });

    const body = await upstream.json();
    logRouteResult(trace, upstream.status);

    return NextResponse.json(body, {
      status: upstream.status,
      headers: {
        "X-SDP-Trace-ID": trace.traceId,
        "Server-Timing": trace.serverTiming(),
      },
    });
  } catch (error) {
    console.error("Analytics proxy failed:", error);
    logRouteResult(trace, 502);
    return NextResponse.json(
      { error: { message: "Analytics data temporarily unavailable" } },
      { status: 502 }
    );
  }
}