import { NextRequest, NextResponse } from "next/server";

const SDP_API_BASE = process.env.SDP_API_BASE_URL ?? "https://api.solana.com";

// Only these endpoints may be called through the playground proxy.
const ALLOWED_ENDPOINTS = [
  "/v1/compliance/address-screenings",
  "/v1/issuance/tokens",
];

export async function POST(req: NextRequest) {
  let endpoint: string, method: string, body: unknown, apiKey: string;
  try {
    ({ endpoint, method, body, apiKey } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!endpoint || !apiKey) {
    return NextResponse.json({ error: "Missing endpoint or apiKey" }, { status: 400 });
  }

  // Strip query string before checking allowlist
  const path = endpoint.split("?")[0];
  if (!ALLOWED_ENDPOINTS.includes(path)) {
    return NextResponse.json({ error: "Endpoint not permitted" }, { status: 403 });
  }

  let apiRes: Response;
  try {
    apiRes = await fetch(`${SDP_API_BASE}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return NextResponse.json({ error: "Could not reach SDP API" }, { status: 502 });
  }

  const data = await apiRes.json().catch(() => ({}));
  return NextResponse.json({ status: apiRes.status, data });
}
