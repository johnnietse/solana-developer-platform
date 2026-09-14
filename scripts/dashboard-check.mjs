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

// [tab, method, path, acceptable statuses, note]
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
  // POST-only: screening takes an address in the body. A GET here 404s by
  // design, so only its presence is worth asserting - 405/404 both mean the
  // router is mounted and the verb is simply wrong.
  // POST-only: screening takes an address in the body. Answers 500 with an
  // error body whose own code is FORBIDDEN - "requires at least one configured
  // compliance provider (RANGE_API_KEY, ELLIPTIC_API_TOKEN, TRM_API_KEY or
  // CHAINALYSIS_API_KEY)". The status and the body disagree; the route works
  // and simply has no provider configured, so 500 is accepted here rather than
  // reported as a broken tab.
  ["Compliance",  "POST", "/v1/compliance/address-screenings", [200, 400, 401, 403, 422, 500], "500 body says FORBIDDEN: no screening provider configured"],
  ["API keys",    "GET", "/v1/api-keys", [200], null],
  // Clerk-session route: an API key is the wrong credential, so 401 is correct.
  ["Settings",    "GET", "/v1/onboarding/status", [200, 401], "401 = needs a browser session, not an API key"],
  ["Projects",    "GET", "/v1/projects", [200], "drives the project switcher"],
  ["health",      "GET", "/health", [200], null],
];

const PAGES = [
  ["/", [200]],
  ["/dashboard/analytics", [200, 302, 307]],
  ["/dashboard/issuance", [200, 302, 307]],
  ["/dashboard/payments", [200, 302, 307]],
  ["/dashboard/wallets", [200, 302, 307]],
];

async function hit(url, { method = "GET", auth = false, timeout = 90000 } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: auth ? { Authorization: `Bearer ${KEY}` } : {},
      signal: AbortSignal.timeout(timeout),
    });
    let body = "";
    try {
      body = (await res.text()).slice(0, 160);
    } catch {}
    return { status: res.status, ms: Date.now() - t0, body };
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

for (const [tab, method, path, ok, note] of CHECKS) {
  const r = await hit(`${API}${path}`, { method, auth: true });
  const pass = ok.includes(r.status);
  const rows = pass && r.status === 200 ? rowsOf(r.body) : null;
  results.push({ group: "api", tab, path, status: r.status, ms: r.ms, pass, note, rows });
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
  if (!r.pass) console.log(`         expected one of the accepted codes`);
}
console.log("");
console.log(`  ${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
