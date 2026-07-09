# Task 2: Add freshness type to analytics-types.ts

**Files:**
- Modify: `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts`

**Responsibility:** Add `FreshnessInfo` and `ResponseMeta` types for the API response freshness tracking.

**Changes:**
Add these two interfaces before the `ViewMode` export at the bottom of the file:

```typescript
export interface FreshnessInfo {
  cacheAgeSeconds: number;
  nextRefreshSeconds: number;
  source: "cache";
}

export interface ResponseMeta {
  requestId: string;
  timestamp: string;
  freshness?: FreshnessInfo;
}
```

**Context:**
- File is at `apps/sdp-web/src/app/dashboard/analytics/analytics-types.ts`
- The `ViewMode` type is the last export in the file (`export type ViewMode = "stablecoins" | "my-tokens";`)
- Add the new types just before that line

**Verification:**
- `pnpm --filter sdp-web typecheck 2>&1 | Select-String "analytics-types"` — Expected: no output
