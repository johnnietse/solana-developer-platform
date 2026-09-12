import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { AnalyticsWorkspace } from "./analytics-workspace";
import type { UserAnalyticsResponse } from "./analytics-types";

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

  let userTokenData: UserAnalyticsResponse | null = null;
  let error: string | null = null;

  if (!apiBaseUrl) {
    error = "Analytics API not configured. Set SDP_API_BASE_URL environment variable.";
  } else {
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

    // An unreachable API rejects rather than returning a response, so this has
    // to catch: without it the throw escapes to the global error boundary and
    // the whole route 500s instead of rendering the message below.
    try {
      const res = await fetch(`${baseUrl}/v1/data-products/user-analytics`, {
        cache: "no-store",
        headers: authHeaders,
      });

      if (res.ok) {
        const body = (await res.json()) as { data: UserAnalyticsResponse };
        userTokenData = body.data;
      } else {
        error = `User analytics returned ${res.status}`;
      }
    } catch (cause) {
      console.error("User analytics fetch failed:", cause);
      error = "Analytics API is unreachable.";
    }
  }

  return <AnalyticsWorkspace userTokenData={userTokenData} error={error} />;
}
