import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

/**
 * Require a signed-in session before proxying anything.
 *
 * `src/proxy.ts` already covers this path - its matcher includes
 * `/(api|trpc)(.*)` and `/api/polars` is not in `isPublicRoute` - so an
 * anonymous request is redirected to /sign-in before reaching here. This check
 * is deliberate redundancy, matching what every route under /api/dashboard
 * already does: they call `await auth()` in the handler despite the same
 * middleware covering them.
 *
 * The redundancy is worth its four lines because of what sits downstream: this
 * handler reaches services that are otherwise unreachable from outside the
 * compose network. If the matcher in proxy.ts is ever narrowed, or this route
 * is lifted into an app without that middleware, the failure would be silent.
 */
async function requireSession(): Promise<NextResponse | null> {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });
  }
  return null;
}

const POLARS_API_BASE =
  process.env.POLARS_API_BASE_URL?.replace(/\/$/, "") || "http://127.0.0.1:8081";

/**
 * Where the deployed service lives.
 *
 * There are two Polars services with overlapping route names and different
 * contracts. The local one serves /dashboard, /tokens, /stablecoins and takes
 * ?token_address= on /rpc. The deployed one serves /healthz, /metrics, /rpc and
 * /insert, and takes ?mint=. Both are needed at once: the local service has
 * routes the deployed one has never had, and the deployed one is the thing
 * running on ECS that we actually want exercised.
 */
const POLARS_RPC_BASE = process.env.POLARS_RPC_API_BASE_URL?.replace(/\/$/, "");

/**
 * The routes the deployed service actually implements.
 *
 * Matched exactly, never as a prefix. `/rpc/count`, `/metrics/latest` and
 * `/metrics/catalog` are local-only routes that live under these names, so a
 * prefix match would send them somewhere that answers 404 and turn working
 * panels into broken ones.
 */
const DEPLOYED_ROUTES = new Set(["healthz", "metrics", "rpc"]);

/**
 * Explicit escape hatch: /api/polars/deployed/<path> always goes to the
 * deployed service, whatever the routing rules below would otherwise decide.
 *
 * This exists so the dashboard can prove the deployed container is working —
 * end to end, through ECS and ECR and S3 — rather than inferring it from a tab
 * that might have been served by the local service instead. Naming the target
 * in the URL means the answer cannot be ambiguous about where it came from.
 */
const DEPLOYED_PREFIX = "deployed";

/**
 * Read-only routes this proxy will forward. Anything absent is refused.
 *
 * An allowlist rather than a denylist, because the thing being protected is
 * not a fixed set of dangerous paths - it is every route the upstream services
 * happen to expose, now and in future. The local Polars container answers
 * `POST /insert?table_name=<anything>&mode=overwrite` with no authentication of
 * its own: it is only reachable inside the compose network, which is the whole
 * of its protection. Proxying it from the dashboard would have handed any
 * signed-in user the ability to overwrite a production Delta table on S3. The
 * deployed service rejects that write; the local one has never had to.
 *
 * The dashboard reads `rpc` and nothing else today. The rest are listed
 * because they are the service's other read routes and panels for them are
 * plausible; adding one later should not require reasoning about this file
 * again. Adding a *write* route should.
 */
const ALLOWED_READ_ROUTES = new Set([
  "health",
  "healthz",
  "rpc",
  "rpc/count",
  "rpc/series",
  "metrics",
  "metrics/latest",
  "metrics/catalog",
  "stablecoins",
  "stablecoins/median",
  "network",
  "tokens",
  "holders",
  "whales",
  "validators",
]);

function resolveTarget(path: string[] | undefined) {
  const segments = path ?? [];

  if (POLARS_RPC_BASE && segments[0] === DEPLOYED_PREFIX) {
    const rest = segments.slice(1).join("/");
    return { base: POLARS_RPC_BASE, path: rest, service: "deployed" as const };
  }

  const joined = segments.join("/");
  if (POLARS_RPC_BASE && segments.length === 1 && DEPLOYED_ROUTES.has(segments[0])) {
    return { base: POLARS_RPC_BASE, path: joined, service: "deployed" as const };
  }

  return { base: POLARS_API_BASE, path: joined, service: "local" as const };
}

/**
 * Proxy API route — forwards read requests to the Polars API services.
 *
 * GET /api/polars/rpc?mint=X&cluster=devnet&limit=N
 * GET /api/polars/metrics?days=N
 * GET /api/polars/stablecoins        (and the rest of ALLOWED_READ_ROUTES)
 * GET /api/polars/deployed/<route>   forces the ECS service
 *
 * Reads only. There is no POST here; see the note above the GET handler.
 *
 * Note the /rpc parameter name. The deployed service reads `mint` and defaults
 * it to USDC when absent, so a caller sending the older `token_address` gets a
 * valid 200 for the wrong token rather than an error. Callers in this app must
 * send `mint`.
 */

/**
 * Upstream headers worth keeping.
 *
 * The body carries a `source` field that says where an answer came from, but
 * these headers are the service's own account of it and are what the API docs
 * point at. Forwarding them means a caller can read cache behaviour the same
 * way from the browser as from curl.
 */
const FORWARDED_HEADERS = ["X-Cache", "X-Cache-Write"];

function withUpstreamHeaders(
  response: NextResponse,
  upstream: Response,
  service: "local" | "deployed"
) {
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) response.headers.set(name, value);
  }
  // Which service answered. Without this a caller cannot tell the two apart
  // from the response alone, which is exactly how a misrouted request goes
  // unnoticed: both return 200, and one of them is about the wrong thing.
  response.headers.set("X-Polars-Service", service);
  return response;
}

/**
 * Read an upstream reply without turning a valid answer into a proxy error.
 *
 * Flask renders HTML for 404 and 405, so calling .json() on those throws and
 * the catch below reports 502 — the proxy blaming itself for an answer the
 * service gave correctly. A caller then sees "proxy error" when the truth was
 * "wrong method", which is a worse lie than the original mistake.
 */
async function readUpstream(upstream: Response) {
  const text = await upstream.text();
  try {
    return { body: JSON.parse(text) as unknown, json: true };
  } catch {
    return { body: { error: text.slice(0, 400) || upstream.statusText }, json: false };
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const denied = await requireSession();
  if (denied) return denied;

  const { path } = await params;
  const url = new URL(_request.url);
  const route = resolveTarget(path);

  if (!ALLOWED_READ_ROUTES.has(route.path)) {
    return NextResponse.json(
      { error: { message: `Not a proxied route: ${route.path || "(root)"}` } },
      { status: 404 }
    );
  }

  const target = `${route.base}/${route.path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(60_000),
    });

    const { body } = await readUpstream(upstream);
    return withUpstreamHeaders(
      NextResponse.json(body, { status: upstream.status }),
      upstream,
      route.service
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Polars API proxy error: ${message}` }, { status: 502 });
  }
}

/**
 * No POST handler, deliberately.
 *
 * There was one; it forwarded an arbitrary body to the resolved target. The
 * only write route behind this proxy is the local container's
 * `POST /insert?table_name=<name>&mode=overwrite`, which has no authentication
 * of its own because nothing outside the compose network could reach it. The
 * dashboard never called it - token-transfers-view issues one request, a GET
 * to /rpc - so the handler existed purely as reachable surface.
 *
 * If a panel ever needs to write, it should call a route that names the table
 * it is allowed to touch, not a pass-through that accepts any of them.
 */
