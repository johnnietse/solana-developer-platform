import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function GET() {
  try {
    const apiClient = await createSdpApiClient();
    const response = await apiClient.request("/v1/payments/ramps/onramp/support");
    const responseBody = await response.text();
    const contentType = response.headers.get("Content-Type") ?? "application/json";

    return new NextResponse(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch onramp support",
      },
      { status: 500 }
    );
  }
}
