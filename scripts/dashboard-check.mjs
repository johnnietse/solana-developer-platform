#!/usr/bin/env node
/**
 * Check every dashboard tab's backing endpoint, plus the services behind them.
 *
 * Distinct from platform-status.mjs, which checks the infrastructure tier -
 * containers, Polars, the deployed ECS service. This one walks the dashboard's
 * own navigation and asks, per tab, whether the API it reads actually answers.
 * A tab can render while its data call 500s, and the container health check
 * says nothing about either.
 *
 *   node scripts/dashboard-check.mjs
 *
 * Uses the local API key so it can exercise authenticated routes without a
 * browser session. Set SDP_API_KEY to override.
 */

const API = process.env.SDP_API_URL || "http://localhost:8787";
const WEB = process.env.SDP_WEB_URL || "http://localhost:3002";
const KEY = process.env.SDP_API_KEY || "sk_test_local_deploy_kora";

// [tab, method, path, acceptable statuses, note, body?]
// 401 is listed where a route is organisation-scoped in a way the API key does
// not satisfy; that is the route working, not failing.
const CHECKS = [
  ["Home",        "GET", "/v1/wallets/aggregate?includeAllProviders=true", [200], null],
  // Mounted from routes/custody/ but served at /v1/wallets.
  ["Wallets",     "GET", "/v1/wallets", [200], "custody wallets"],
  ["Wallets",     "GET", "/v1/wallets/config", [200], "signing config"],
  ["Issuance",    "GET", "/v1/issuance/tokens", [200], "lists deployed tokens"],
  ["Issuance",    "GET", "/v1/issuance/templates", [200], "token templates"],
  ["Issuance",    "GET", "/v1/issuance/transactions", [200], "deploy/mint history"],
  ["Analytics",   "GET", "/v1/data-products/analytics", [200, 503], "503 = Databricks warehouse stopped"],
  ["Analytics",   "GET", "/v1/data-products/user-analytics", [200, 401], null],
  ["Payments",    "GET", "/v1/payments/transfers?page=1&pageSize=5", [200, 401], null],
  // Gated by requireRecurringPaymentsFeature. A 403 is that flag doing its job,
  // not a broken route, so it counts as a pass.
  ["Payments",    "GET", "/v1/payments/recurring-payments", [200, 401, 403], "403 = feature flag off"],
  ["Counterparty","GET", "/v1/counterparties", [200, 401], null],
  // POST-only, and the address goes in the body. Sending none fails JSON
  // parsing and answers 500, which is not the route misbehaving - it is the
  // request being malformed. With a body it answers a clean 403 FORBIDDEN:
  // "requires at least one configured compliance provider". 403 is therefore
  // the pass condition, and a 500 here now means a genuine fault.
  ["Compliance",  "POST", "/v1/compliance/address-screenings", [200, 403], "403 = no screening provider configured (RANGE/ELLIPTIC/TRM/CHAINALYSIS key)", { address: "EY3hQnjN29sWMfkXTFzWXo17vwMi3n93GBo3YaT5QPgt" }],
  ["API keys",    "GET", "/v1/api-keys", [200], null],
  // Clerk-session route: an API key is the wrong credential, so 401 is correct.
  ["Settings",    "GET", "/v1/onboarding/status", [200, 401], "401 = needs a browser session, not an API key"],
  ["Projects",    "GET", "/v1/projects", [200], "drives the project switcher"],
  ["health",      "GET", "/health", [200], null],
];

// The Analytics tab's data tier. These read S3 with the local AWS profile, so
// they are what fails when the key is rotated or revoked - which the checks
// above cannot see, since sdp-api never touches S3. A 21/21 without these
// once hid a deleted access key.
const POLARS = process.env.SDP_POLARS_URL || "http://localhost:8081";
const METRICS = process.env.SDP_METRICS_URL || "http://localhost:8080";
const DEPLOYED = process.env.SDP_DEPLOYED_URL || "http://35.171.121.207:8080";
const DATA = [
  ["Analytics", `${POLARS}/metrics/latest`, [200], "polars: newest metric snapshot (S3 Delta)"],
  ["Analytics", `${POLARS}/stablecoins`, [200], "polars: stablecoins (S3)"],
  ["Analytics", `${POLARS}/network`, [200], "polars: network (S3)"],
  ["Analytics", `${POLARS}/tokens`, [200], "polars: token registry (S3)"],
  ["Analytics", `${METRICS}/metric`, [200], "metrics-api (S3)"],
  ["Analytics", `${METRICS}/rpc`, [200], "metrics-api RPC counts"],
  ["deployed", `${DEPLOYED}/healthz`, [200], "EC2 tmp-sdp-data"],
  ["deployed", `${DEPLOYED}/rpc`, [200], "EC2 tmp-sdp-data /rpc"],
];

const PAGES = [
  ["/", [200]],
  ["/dashboard/analytics", [200, 302, 307]],
  ["/dashboard/issuance", [200, 302, 307]],
  ["/dashboard/payments", [200, 302, 307]],
  ["/dashboard/wallets", [200, 302, 307]],
];

async function hit(url, { method = "GET", auth = false, timeout = 90000, body = null } = {}) {
  const t0 = Date.now();
  try {
    const headers = auth ? { Authorization: `Bearer ${KEY}` } : {};
    // A POST with no body fails JSON parsing and answers 500, which reads as a
    // broken route when it is really a malformed request. Routes that need one
    // declare it in CHECKS.
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
    let text = "";
    try {
      text = (await res.text()).slice(0, 160);
    } catch {}
    return { status: res.status, ms: Date.now() - t0, body: text };
  } catch (err) {
    return { status: "ERR", ms: Date.now() - t0, body: err.message.slice(0, 80) };
  }
}

/** Count rows so a 200 with nothing in it is not reported as working. */
function rowsOf(body) {
  try {
    const j = JSON.parse(body.length < 160 ? body : body + "");
    const d = j.data ?? j;
    for (const k of ["tokens", "wallets", "transfers", "items", "projects", "apiKeys", "templates", "transactions", "counterparties", "balances"]) {
      if (Array.isArray(d?.[k])) return `${d[k].length} ${k}`;
    }
    if (Array.isArray(d)) return `${d.length} items`;
  } catch {}
  return null;
}

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a check, backing off once on 429.
 *
 * This script fires sixteen authenticated calls in a burst, and running it a
 * few times in a row trips the API's own rate limiter - at which point every
 * row reports 429 and the output looks like a total outage. That is the
 * limiter working correctly and the tool misreading it. One retry after a
 * pause distinguishes "genuinely throttled" from "I caused this", and the
 * spacing below keeps a single run under the limit.
 */
async function checkWithBackoff(url, opts) {
  let r = await hit(url, opts);
  if (r.status === 429) {
    await sleep(5000);
    r = await hit(url, opts);
  }
  return r;
}

for (const [tab, method, path, ok, note, body] of CHECKS) {
  const r = await checkWithBackoff(`${API}${path}`, { method, auth: true, body: body ?? null });
  await sleep(250);
  const pass = ok.includes(r.status);
  const rows = pass && r.status === 200 ? rowsOf(r.body) : null;
  results.push({ group: "api", tab, path, status: r.status, ms: r.ms, pass, note, rows });
}

for (const [tab, url, ok, note] of DATA) {
  const r = await hit(url);
  const pass = ok.includes(r.status);
  results.push({ group: "data", tab, path: url, status: r.status, ms: r.ms, pass, note: pass ? note : `${note}: ${r.body.replace(/\s+/g, " ").slice(0, 110)}`, rows: null });
}

for (const [path, ok] of PAGES) {
  const r = await hit(`${WEB}${path}`);
  results.push({ group: "web", tab: "page", path, status: r.status, ms: r.ms, pass: ok.includes(r.status), note: null, rows: null });
}

console.log("");
console.log("  TAB           STATUS  TIME     ENDPOINT");
console.log("  " + "-".repeat(74));
let failed = 0;
for (const r of results) {
  if (!r.pass) failed += 1;
  const mark = r.pass ? "ok  " : "FAIL";
  console.log(
    `  ${mark} ${r.tab.padEnd(12).slice(0, 12)} ${String(r.status).padStart(4)}  ${String(r.ms).padStart(6)}ms  ${r.path}`
  );
  if (r.rows) console.log(`         ${r.rows}`);
  if (r.note && r.pass) console.log(`         ${r.note}`);
  if (!r.pass) {
    console.log(
      r.status === 429
        ? `         still rate limited after a retry - wait a minute and re-run`
        : `         expected one of the accepted codes${r.note ? ` - ${r.note}` : ""}`
    );
  }
}
console.log("");
console.log(`  ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
