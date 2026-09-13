"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UserAnalyticsResponse } from "./analytics-types";
import { MyTokensView } from "./my-tokens-view";
import { TokenTransfersView } from "./token-transfers-view";

/**
 * Analytics workspace.
 *
 * This was briefly a single view. The Stablecoin Analytics and Databricks tabs
 * had been removed because both read a Databricks cache this deployment does
 * not populate — correct at the time, since a tab that renders nothing is
 * worse than no tab.
 *
 * Token Transfers is added back on a different footing: it reads the Polars
 * API, not Databricks. That service ingests from Solana RPC on its own
 * schedule and writes Delta tables to S3 every fifteen minutes, so it has
 * current data regardless of whether the Databricks warehouse is running. The
 * two sources fail independently, which is the whole reason this tab can be
 * trusted while the others could not.
 *
 * Requests go through /api/polars/*, which routes to the local container or
 * the deployed ECS service depending on the route. Both are reachable; see
 * that route handler for which is picked and why.
 */

type TabKey = "tokens" | "transfers";

const TABS: { key: TabKey; label: string }[] = [
  { key: "tokens", label: "My Tokens" },
  { key: "transfers", label: "Token Transfers" },
];

export function AnalyticsWorkspace({
  userTokenData,
  error,
}: {
  userTokenData: UserAnalyticsResponse | null;
  error: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("tokens");

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
      <div className="flex gap-4 border-b border-[rgba(28,28,29,0.1)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "px-1 pb-2 text-sm text-[rgba(28,28,29,0.56)] transition-colors hover:text-[#1c1c1d]",
              tab === t.key && "border-b-2 border-blue-500 font-semibold text-[#1c1c1d]"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "transfers" ? (
        // The account's tokens come from the SDP API and Postgres; their
        // on-chain activity comes from the Polars API's GET /rpc.
        <TokenTransfersView tokens={userTokenData?.tokens ?? null} />
      ) : (
        <MyTokensView data={userTokenData} />
      )}
    </div>
  );
}
