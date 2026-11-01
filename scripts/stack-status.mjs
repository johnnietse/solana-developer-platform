#!/usr/bin/env node
/**
 * One command that says whether the platform is actually working.
 *
 * `docker ps` tells you a container is up; it does not tell you the API can
 * reach Databricks, or that the web app is proxying /rpc to the right service.
 * This calls each piece and reports what a user would experience, so a broken
 * dependency shows up here rather than as an empty tab in the dashboard.
 *
 *     node scripts/stack-status.mjs
 *
 * Exit code is 0 when everything required is up, 1 when something is down.
 * Optional pieces (Databricks) report but do not fail the run.
 *
 * Covers the /api/polars proxy and the Polars service. For the full
 * docker-compose platform, including sdp-metrics-api, use platform-status.mjs.
 */

const DEPLOYED_RPC = process.env.POLARS_RPC_API_BASE_URL || "http://35.171.121.207:8080";
const WEB = process.env.SDP_WEB_URL || "http://localhost:3002";
const API = process.env.SDP_API_URL || "http://localhost:8787";
const POLARS = process.env.POLARS_LOCAL_URL || "http://localhost:8081";
const DOCS = process.env.SDP_DOCS_URL || "http://localhost:3001";

/** USDC. Always has activity, so an empty result means a real fault. */
const DEMO_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * The platform's own issued token: one transaction, its own creation.
 *
 * Worth its own check because it is the shape the cache used to refuse. The
 * old rule asked "does the cache hold a full page", which a token with one
 * transaction can never satisfy, so every load called the chain — for exactly
 * the tokens this platform exists to measure.
 */
const QUIET_MINT = "2bRGcWaoBAeCsom8QqfDjfkhU552LVLwC8FQpj64ee37";

const results = [];

/**
 * A parser's verdict that the response is wrong despite its status. Without
 * this, a 200 with no rows prints a warning under a line that still says UP
 * and the run exits 0, which is the failure this script exists to catch.
 */
const fault = (note) => ({ fault: true, note });

async function check(name, url, { expect = [200], optional = false, parse, method, body } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: method ?? "GET",
      redirect: "manual",
      ...(body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - started;
    let verdict = "";
    if (parse) {
      try {
        verdict = (await parse(res)) ?? "";
      } catch (err) {
        verdict = fault(`unparsable body: ${err instanceof Error ? err.message : err}`);
      }
    }
    const note = verdict.fault ? verdict.note : verdict;
    const ok = expect.includes(res.status) && !verdict.fault;
    results.push({ name, ok, optional, status: res.status, ms, note });
  } catch (err) {
    results.push({
      name,
      ok: false,
      optional,
      status: 0,
      ms: Date.now() - started,
      note: err instanceof Error ? err.message : String(err),
    });
  }
}

// A 307 is the healthy answer for a dashboard page: it means the route
// compiled and the auth guard redirected. A 500 would mean a broken page.
const AUTH_REDIRECT = [307, 302, 200];

await check("web  /dashboard/analytics", `${WEB}/dashboard/analytics`, { expect: AUTH_REDIRECT });
await check("web  /dashboard/issuance", `${WEB}/dashboard/issuance`, { expect: AUTH_REDIRECT });
await check("web  /dashboard/payments", `${WEB}/dashboard/payments`, { expect: AUTH_REDIRECT });
await check("docs", `${DOCS}/`, { expect: AUTH_REDIRECT });

await check("api  /health", `${API}/health`);
await check("api  /v1/data-products/user-analytics", `${API}/v1/data-products/user-analytics`, {
  // 401 is correct without a session; it proves the route and auth guard work.
  expect: [401],
});
await check("api  /v1/data-products/analytics", `${API}/v1/data-products/analytics`, {
  optional: true,
  parse: async (res) => {
    if (res.status === 200) return "Databricks reachable";
    const body = await res.json().catch(() => ({}));
    return body?.meta?.error ?? `HTTP ${res.status}`;
  },
});

// Every route the Polars Pipeline tab reads. /dashboard is deliberately not
// here: this build of the service does not have it, which is why that tab
// renders PolarsAnalyticsView rather than PolarsDashboard.
await check("polars local /health", `${POLARS}/health`);
await check("polars local /metrics", `${POLARS}/metrics`);

// These three assert a ROW COUNT, not just a status. They answered 200 with
// zero rows for six weeks: ingestion had moved to writing under `insert/`
// while the readers still listed the abandoned bare prefix, so the panels
// rendered empty and every check here still passed. A 200 says the route
// works; only the count says the pipeline does.
const rowCount = (label) => async (res) => {
  const body = await res.json();
  const rows = body.rows ?? body.count ?? (body.data ?? []).length;
  if (!rows) return fault(`EMPTY: ${label} answered 200 with no rows — check the S3 prefix the reader lists`);
  const dates = (body.data ?? []).map((r) => r.date).filter(Boolean).sort();
  const span = dates.length ? `, ${dates[0]}..${dates[dates.length - 1]}` : "";
  return `${rows} rows${span}`;
};

await check("polars local /stablecoins", `${POLARS}/stablecoins?days=30`, {
  parse: rowCount("/stablecoins"),
});
await check("polars local /stablecoins/median", `${POLARS}/stablecoins/median`, {
  parse: async (res) => {
    const body = await res.json();
    const rows = body.median_supplies ?? [];
    if (!rows.length) return fault("EMPTY: no symbols analysed");
    // A NaN median serialises as null and renders as a blank cell, which
    // reads as a broken metric rather than as one missing sample.
    const broken = rows.filter((r) => r.median_supply == null).map((r) => r.symbol);
    if (broken.length) return fault(`NaN median for ${broken.join(", ")} — an unreadable sample is poisoning the maths`);
    const unreadable = rows.reduce((n, r) => n + (r.unreadable_samples ?? 0), 0);
    return `${rows.length} symbols, ${body.total_samples} samples, ${unreadable} unreadable`;
  },
});
await check("polars local /network", `${POLARS}/network?days=30`, {
  parse: rowCount("/network"),
});
await check("polars local /tokens", `${POLARS}/tokens`);
await check("polars local /rpc/count", `${POLARS}/rpc/count?mint=${DEMO_MINT}&days=1`);

await check("polars deployed /healthz", `${DEPLOYED_RPC}/healthz`);
await check(
  "polars deployed /rpc",
  `${DEPLOYED_RPC}/rpc?mint=${DEMO_MINT}&cluster=devnet&limit=25`,
  {
    parse: async (res) => {
      const body = await res.json();
      const rows = body.transfers ?? [];
      // The enrichment columns must be in the row shape even when a given row
      // has no amount yet: their absence means the service is an older build,
      // and the analytics view would silently show every amount as "—".
      const required = ["kind", "amount", "decimals", "source", "destination"];
      const first = rows[0] ?? {};
      const absent = required.filter((f) => !(f in first));
      if (rows.length && absent.length) {
        return fault(`OLD BUILD: row is missing ${absent.join(", ")}`);
      }
      return (
        `${rows.length} rows, ${body.resolved ?? 0} resolved, ` +
        `source=${body.source}, X-Cache=${res.headers.get("x-cache")}`
      );
    },
  }
);

// Two calls: the second must be served from cache even though the token has
// far fewer rows than the page asks for.
await fetch(`${DEPLOYED_RPC}/rpc?mint=${QUIET_MINT}&cluster=devnet&limit=25`, {
  signal: AbortSignal.timeout(45_000),
}).catch(() => {});
await check(
  "polars deployed /rpc  (quiet token)",
  `${DEPLOYED_RPC}/rpc?mint=${QUIET_MINT}&cluster=devnet&limit=25`,
  {
    parse: async (res) => {
      const body = await res.json();
      const cache = res.headers.get("x-cache");
      const rows = body.transfers?.length ?? 0;
      if (cache !== "HIT") {
        return fault(`NOT CACHED: ${rows} rows, X-Cache=${cache} — a quiet token is hitting the chain every load`);
      }
      return `${rows} rows, X-Cache=HIT, reason=${body.cache_reason}, age=${body.cache_age_seconds}s`;
    },
  }
);

// The one that catches a misrouted proxy: the deployed service defaults the
// mint to USDC, so the wrong base URL still returns 200 with plausible rows.
await check("web  proxy -> deployed /rpc", `${WEB}/api/polars/rpc?mint=${DEMO_MINT}&limit=25`, {
  parse: async (res) => {
    const body = await res.json();
    if (body.table !== "dev.mlh.rpc") {
      return fault(`WRONG SERVICE: table=${body.table ?? "none"} — check POLARS_RPC_API_BASE_URL`);
    }
    return `table=${body.table}, X-Cache=${res.headers.get("x-cache") ?? "not forwarded"}`;
  },
});

// The Deployed Service tab calls every deployed route through this prefix. It
// is checked here too so the terminal and the dashboard cannot disagree about
// whether the deployed container is reachable from the browser.
for (const [name, path, expect, method, body] of [
  ["healthz", "healthz", [200], "GET", null],
  ["metrics", "metrics", [200], "GET", null],
  ["rpc", `rpc?mint=${DEMO_MINT}&cluster=devnet&limit=5`, [200], "GET", null],
  // A POST, because that is what the write gate rejects. Sending GET gets a
  // 405 from Flask, which is a correct answer to the wrong question.
  ["insert gate", "insert?table_name=dev.mlh.gate_probe", [401], "POST", { data: [{ probe: 1 }] }],
]) {
  await check(`web  /api/polars/deployed/${name}`, `${WEB}/api/polars/deployed/${path}`, {
    expect,
    method,
    ...(body ? { body } : {}),
    parse: async (res) => {
      // The proxy stamps which service answered. If this ever reads "local",
      // every result in the dashboard's Deployed Service tab is about the
      // wrong service and would still look like a pass.
      const servedBy = res.headers.get("x-polars-service");
      if (servedBy !== "deployed") {
        return fault(`WRONG SERVICE: X-Polars-Service=${servedBy ?? "absent"}`);
      }
      return `served by ${servedBy}`;
    },
  });
}

let failed = 0;
console.log("");
for (const r of results) {
  const tag = r.ok ? "UP  " : r.optional ? "WARN" : "DOWN";
  if (!r.ok && !r.optional) failed += 1;
  const status = r.status || "no response";
  console.log(`[${tag}] ${r.name.padEnd(38)} ${String(status).padStart(4)}  ${String(r.ms).padStart(5)} ms`);
  if (r.note) console.log(`       ${r.note}`);
}

const required = results.filter((r) => !r.optional);
console.log("");
console.log(`${required.length - failed}/${required.length} required checks passed`);
if (results.some((r) => r.optional && !r.ok)) {
  console.log("Optional dependency degraded — the tab that reads it will be empty.");
}
process.exit(failed === 0 ? 0 : 1);
