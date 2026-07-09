/**
 * Shared Databricks SQL query utility.
 * Used by the analytics route and the ingestion cron handler.
 */

import type { Env } from "@/types/env";

export async function queryDatabricks(
  env: Pick<Env, "DATABRICKS_HOST" | "DATABRICKS_TOKEN" | "DATABRICKS_WAREHOUSE_ID">,
  sql: string,
  timeout = "10s"
): Promise<string[][] | null> {
  const { DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_WAREHOUSE_ID } = env;
  if (!DATABRICKS_HOST || !DATABRICKS_TOKEN || !DATABRICKS_WAREHOUSE_ID) {
    console.error("[databricks-query] Missing credentials");
    return null;
  }

  const url = `https://${DATABRICKS_HOST}/api/2.0/sql/statements`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

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
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      console.error(`[databricks-query] HTTP ${res.status} from ${url}`);
      return null;
    }
    const body = await res.json() as {
      result?: { data_array?: string[][] };
      status?: { state: string };
    };
    if (body.status?.state?.toLowerCase() !== "succeeded") {
      console.error(`[databricks-query] Non-SUCCEEDED status: ${body.status?.state}`);
      return null;
    }
    return body.result?.data_array ?? null;
  } catch (err) {
    console.error("[databricks-query] Fetch failed:", err);
    clearTimeout(timeoutId);
    return null;
  }
}
