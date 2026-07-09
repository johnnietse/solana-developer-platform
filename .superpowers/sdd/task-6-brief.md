# Task 6: Remove mock data from dashboard page.tsx

**Files:**
- Modify: `apps/sdp-web/src/app/dashboard/analytics/page.tsx`

**Responsibility:** Remove all mock data generators and fallback logic. The dashboard should only show real data or error states.

**Changes:**

Replace the entire file content with:
```typescript
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getAuthEntryPath } from "@/lib/auth-entry";
import { AnalyticsWorkspace } from "./analytics-workspace";
import type { AnalyticsResponse, UserAnalyticsResponse, ResponseMeta } from "./analytics-types";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const { userId } = await auth();
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

    const [stablecoinRes, userTokenRes] = await Promise.all([
      fetch(`${baseUrl}/v1/data-products/analytics`, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      }),
      fetch(`${baseUrl}/v1/data-products/user-analytics`, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
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
```

**Verification:**
- `pnpm --filter sdp-web typecheck 2>&1 | Select-String "analytics/page"` — Expected: no output

**Context:**
- `ResponseMeta` type was added in Task 2 (analytics-types.ts)
- The `AnalyticsWorkspace` component already handles `null` data (loading state) and `error` string (error state)
- No mock data should remain in this file