import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { AnalyticsWorkspace } from "./analytics-workspace";
import type { AnalyticsResponse, UserAnalyticsResponse, ResponseMeta } from "./analytics-types";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { userId, getToken } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }

  const apiBaseUrl =
    process.env.SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_SDP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL;

  let stablecoinData: AnalyticsResponse | null = null;
  let userTokenData: UserAnalyticsResponse | null = null;
  let error: string | null = null;
  let lastUpdated: string | null = null;

  if (apiBaseUrl) {
    const baseUrl = apiBaseUrl.replace(/\/$/, "");

    // Mint a Clerk JWT (sdp-api template carries the org_id claim the API
    // needs to scope user analytics to the active organization).
    const clerkToken = await getToken({ template: "sdp-api" }).catch(() => null);
    const authHeaders: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (clerkToken) {
      authHeaders.Authorization = `Bearer ${clerkToken}`;
    }

    const [stablecoinRes, userTokenRes] = await Promise.all([
      fetch(`${baseUrl}/v1/data-products/analytics`, {
        cache: "no-store",
        headers: authHeaders,
      }),
      fetch(`${baseUrl}/v1/data-products/user-analytics`, {
        cache: "no-store",
        headers: authHeaders,
      }),
    ]);

    if (stablecoinRes.ok) {
      const body = (await stablecoinRes.json()) as { data: AnalyticsResponse; meta: ResponseMeta };
      stablecoinData = body.data;
      lastUpdated = stablecoinData.lastUpdated;
    } else {
      const body = await stablecoinRes.json().catch(() => ({}));
      error = (body as any)?.meta?.error ?? `Analytics returned ${stablecoinRes.status}`;
    }

    if (userTokenRes.ok) {
      const body = (await userTokenRes.json()) as { data: UserAnalyticsResponse };
      userTokenData = body.data;
      const tokenUpdated = userTokenData.lastUpdated;
      if (!lastUpdated || tokenUpdated > lastUpdated) {
        lastUpdated = tokenUpdated;
      }
    } else {
      const tokenError = `User analytics returned ${userTokenRes.status}`;
      error = error ? `${error}; ${tokenError}` : tokenError;
    }
  } else {
    error = "Analytics API not configured. Set SDP_API_BASE_URL environment variable.";
  }

  return (
    <AnalyticsWorkspace
      stablecoinData={stablecoinData}
      userTokenData={userTokenData}
      error={error}
      lastUpdated={lastUpdated}
    />
  );
}
