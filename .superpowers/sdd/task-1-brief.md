# Task 1: Create shared Databricks query utility

**Files:**
- Create: `apps/sdp-api/src/lib/databricks-query.ts`

**Responsibility:** Shared Databricks SQL query utility — extracted from the current inline helper in analytics.ts. Used by both the analytics route and the ingestion cron handler.

**Interface — Produces:**
```typescript
export async function queryDatabricks(
  env: Pick<Env, "DATABRICKS_HOST" | "DATABRICKS_TOKEN" | "DATABRICKS_WAREHOUSE_ID">,
  sql: string,
  timeout?: string
): Promise<string[][] | null>
```

- Takes `env` with Databricks credentials, SQL string, and optional timeout (default "10s")
- Returns `string[][]` (rows x columns) or `null` if Databricks is not configured or query fails
- Never throws — returns `null` on error

**Implementation:**
```typescript
import type { Env } from "@/types/env";

export async function queryDatabricks(
  env: Pick<Env, "DATABRICKS_HOST" | "DATABRICKS_TOKEN" | "DATABRICKS_WAREHOUSE_ID">,
  sql: string,
  timeout = "10s"
): Promise<string[][] | null> {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) return null;

  const url = `https://${DATABRICKS_HOST}/api/2.0/sql/statements`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${DATABRICKS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        warehouse_id: DATABRICKS_WAREHOUSE_ID,
        catalog: "workspace",
        schema: "default",
        statement: sql,
        wait_timeout: timeout,
      }),
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      result?: { data_array?: string[][] };
      status?: { state: string };
    };
    if (body.status?.state !== "SUCCEEDED") return null;
    return body.result?.data_array ?? null;
  } catch {
    return null;
  }
}
```

**Verification:**
- Run: `pnpm --filter @sdp/api typecheck 2>&1 | Select-String "databricks-query"` — Expected: no output

**Context:**
- `Env` type already has `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_WAREHOUSE_ID` fields (lines 220-223 in `src/types/env.d.ts`)
- This file is at `apps/sdp-api/src/lib/databricks-query.ts`
- The `@/types/env` import alias is already configured in the project
