/**
 * Shared Databricks SQL query utility.
 * Used by the analytics route and the ingestion cron handler.
 */

import type { Env } from "@/types/env";

/**
 * Unity Catalog location of the analytics tables. These defaults match the
 * original hardcoded `workspace.default`, so an existing deployment keeps
 * working untouched; a workspace organised differently sets DATABRICKS_CATALOG
 * / DATABRICKS_SCHEMA instead of having every query patched.
 */
export const DEFAULT_ANALYTICS_CATALOG = "workspace";
export const DEFAULT_ANALYTICS_SCHEMA = "default";

type CatalogEnv = Pick<Env, "DATABRICKS_CATALOG" | "DATABRICKS_SCHEMA">;

export function analyticsCatalog(env: CatalogEnv): string {
  return env.DATABRICKS_CATALOG || DEFAULT_ANALYTICS_CATALOG;
}

export function analyticsSchema(env: CatalogEnv): string {
  return env.DATABRICKS_SCHEMA || DEFAULT_ANALYTICS_SCHEMA;
}

/** Fully-qualified name for one analytics table, e.g. dev.mlh.analytics_cache. */
export function analyticsTable(env: CatalogEnv, table: string): string {
  return `${analyticsCatalog(env)}.${analyticsSchema(env)}.${table}`;
}

export async function queryDatabricks(
  env: Pick<
    Env,
    | "DATABRICKS_HOST"
    | "DATABRICKS_TOKEN"
    | "DATABRICKS_WAREHOUSE_ID"
    | "DATABRICKS_CATALOG"
    | "DATABRICKS_SCHEMA"
  >,
  sql: string,
  params: unknown[] = [],
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
        catalog: analyticsCatalog(env),
        schema: analyticsSchema(env),
        // Databricks SQL only supports named parameters (`:name` syntax), not
        // `:1` positional or `?`. Rewrite the caller's `:1`/`:2`/… placeholders
        // to `:p1`/`:p2`/… and bind each by its 1-based index. `::` casts are
        // left untouched because they are followed by a letter, not a digit.
        statement: sql.replace(/:(\d+)/g, (_m, n) => `:p${n}`),
        parameters: params.map((p, i) => ({ name: `p${i + 1}`, value: String(p) })),
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
