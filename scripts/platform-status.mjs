#!/usr/bin/env node
/**
 * Status of the full eight-service platform defined by ./docker-compose.yml.
 *
 * Distinct from scripts/stack-status.mjs, which was written for the nested
 * checkout: that stack has the /api/polars proxy and no sdp-metrics-api, this
 * one is the reverse. Running the wrong script against the wrong stack reports
 * failures that are really just absent routes.
 *
 * Data routes assert a ROW COUNT, never just a status. Three of them answered
 * 200 with zero rows for six weeks because ingestion had moved to writing under
 * a different S3 prefix than the reader listed. A 200 says the process is up;
 * only the count says the pipeline is.
 */

const WEB = process.env.SDP_WEB_URL || "http://localhost:3002";
const DOCS = process.env.SDP_DOCS_URL || "http://localhost:3001";
const API = process.env.SDP_API_URL || "http://localhost:8787";
const METRICS = process.env.SDP_METRICS_URL || "http://localhost:8080";
const POLARS = process.env.SDP_POLARS_URL || "http://localhost:8081";
const DEPLOYED = process.env.POLARS_RPC_API_BASE_URL || "http://35.171.121.207:8080";

const MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
// Clerk sends an unauthenticated dashboard request to sign-in. Either the page
// or the redirect proves the route is wired; only a 5xx is a real failure.
const AUTH_OK = [200, 302, 307];

const results = [];

async function check(name, url, { expect = [200], optional = false, parse, timeout = 120000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout) });
    const ms = Date.now() - t0;
    let note = null;
    if (parse && res.ok) {
      try {
        note = await parse(await res.json(), res);
      } catch (err) {
        note = `unparseable body: ${err.message}`;
      }
    }
    const ok = expect.includes(res.status) && !(note && note.startsWith("EMPTY"));
    results.push({ name, status: res.status, ms, ok, optional, note });
  } catch (err) {
    results.push({ name, status: "ERR", ms: Date.now() - t0, ok: false, optional, note: err.message });
  }
}

/** Rows, not status. An empty answer here is a failure even at 200. */
function rows(label) {
  return (body) => {
    const n = body.rows ?? body.count ?? (body.data ?? body.metrics ?? body.transfers ?? []).length;
    if (!n) return `EMPTY: ${label} answered 200 with no rows — check the S3 prefix the reader lists`;
    const dates = (body.data ?? body.metrics ?? []).map((r) => r.date).filter(Boolean).sort();
    const span = dates.length ? `, ${dates[0]}..${dates[dates.length - 1]}` : "";
    return `${n} rows${span}`;
  };
}

// ── web + docs ────────────────────────────────────────────────────────────
await check("web  /dashboard/analytics", `${WEB}/dashboard/analytics`, { expect: AUTH_OK });
await check("web  /dashboard/issuance", `${WEB}/dashboard/issuance`, { expect: AUTH_OK });
await check("web  /dashboard/payments", `${WEB}/dashboard/payments`, { expect: AUTH_OK });
await check("docs", `${DOCS}/`, { expect: AUTH_OK });

// ── sdp-api (node) ────────────────────────────────────────────────────────
await check("api  /health", `${API}/health`);
await check("api  /v1/data-products/user-analytics", `${API}/v1/data-products/user-analytics`, {
  expect: [401],
});
await check("api  /v1/data-products/analytics", `${API}/v1/data-products/analytics`, {
  expect: [200],
  optional: true,
});

// ── sdp-metrics-api ───────────────────────────────────────────────────────
// Absent from the nested stack entirely, so these routes have never been
// covered by the other script.
await check("metrics /healthz", `${METRICS}/healthz`);
await check("metrics /rpc", `${METRICS}/rpc?days=1`);
await check("metrics /rpc/series", `${METRICS}/rpc/series?days=1`, {
  parse: (b) => {
    const s = b.series ?? [];
    if (!s.length) return "EMPTY: no daily buckets returned";
    return `${s.length} daily buckets since ${b.since}`;
  },
});
// /insert must reject an unauthenticated write. A 200 here is a security bug,
// not a passing check.
await check("metrics /insert gate", `${METRICS}/insert`, { expect: [401, 403, 405] });

// ── sdp-polars-api ────────────────────────────────────────────────────────
await check("polars /health", `${POLARS}/health`);
await check("polars /metrics", `${POLARS}/metrics`, { parse: rows("/metrics") });
await check("polars /stablecoins", `${POLARS}/stablecoins`, { parse: rows("/stablecoins") });
await check("polars /network", `${POLARS}/network`, { parse: rows("/network") });
await check("polars /tokens", `${POLARS}/tokens`, { parse: rows("/tokens") });
await check("polars /stablecoins/median", `${POLARS}/stablecoins/median`, {
  parse: (b) => {
    const r = b.median_supplies ?? [];
    if (!r.length) return "EMPTY: no symbols analysed";
    const nan = r.filter((x) => x.median_supply == null).map((x) => x.symbol);
    if (nan.length) return `BROKEN: null median for ${nan.join(", ")}`;
    return `${r.length} symbols, ${b.total_samples} samples`;
  },
});

// ── deployed ECS service ──────────────────────────────────────────────────
await check("deployed /healthz", `${DEPLOYED}/healthz`);
await check("deployed /rpc", `${DEPLOYED}/rpc?mint=${MINT}&cluster=devnet&limit=25`, {
  parse: (b, res) => {
    const t = b.transfers ?? [];
    if (!t.length) return "EMPTY: deployed service returned no transfers";
    return `${t.length} rows, ${b.resolved ?? 0} resolved, source=${b.source}, X-Cache=${res.headers.get("X-Cache")}`;
  },
});

// ── report ────────────────────────────────────────────────────────────────
let failed = 0;
console.log("");
for (const r of results) {
  if (!r.ok && !r.optional) failed += 1;
  const tag = r.ok ? "UP  " : r.optional ? "WARN" : "DOWN";
  console.log(`[${tag}] ${r.name.padEnd(38)} ${String(r.status).padStart(4)}  ${String(r.ms).padStart(6)} ms`);
  if (r.note) console.log(`       ${r.note}`);
}
const required = results.filter((r) => !r.optional);
console.log("");
console.log(`${required.length - failed}/${required.length} required checks passed`);
if (results.some((r) => r.optional && !r.ok)) {
  console.log("Optional dependency degraded — the tab that reads it will be empty.");
}
process.exit(failed === 0 ? 0 : 1);
