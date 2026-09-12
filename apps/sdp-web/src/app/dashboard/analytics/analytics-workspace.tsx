"use client";

import { Button } from "@/components/ui/button";
import type { UserAnalyticsResponse } from "./analytics-types";
import { MyTokensView } from "./my-tokens-view";

/**
 * Analytics workspace.
 *
 * Previously a three-tab surface (Stablecoin Analytics / Databricks / My
 * Tokens). The first two were removed — the stablecoin view depended on a
 * Databricks cache this deployment does not populate, and both rendered
 * placeholder holder data rather than measurements. Only the account's own
 * issued tokens remain, which are backed by Postgres and live RPC.
 */
export function AnalyticsWorkspace({
  userTokenData,
  error,
}: {
  userTokenData: UserAnalyticsResponse | null;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
          <p className="text-[19px] leading-6 font-medium text-[#1c1c1d]">Analytics unavailable</p>
          <p className="mt-0.5 text-sm text-[rgba(28,28,29,0.56)]">{error}</p>
          <div className="mt-4">
            <Button onClick={() => window.location.reload()} variant="outline" type="button">
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-analytics-root>
      <MyTokensView data={userTokenData} />
    </div>
  );
}
