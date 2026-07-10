/**
 * SDP API — Cloudflare Workers entrypoint.
 *
 * Thin wrapper around the runtime-neutral `createApp` from `app.ts`. All CF
 * specifics (ExecutionContext, KV / Hyperdrive bindings via `Env`, Sentry CF
 * SDK, `ctx.waitUntil`) live here. The Node entrypoint lands in `server.ts`
 * (HOO-511) and consumes the same `createApp` factory.
 */

import { createApp } from "@/app";
import { runPendingTransfersReconciliation } from "@/cron/pending-transfers";
import { runRecurringPaymentsCollection } from "@/cron/recurring-payments";
import { handleAnalyticsIngestion } from "@/crons/analytics-ingestion";
import { handleWalletEnrichment } from "@/crons/wallet-enrichment";
import { handleTokenDiscovery } from "@/crons/token-discovery";
import { handleUserTokenSync } from "@/crons/sync-user-tokens";
import { handleTokenRetirement } from "@/crons/retire-tokens";
import {
  isRecurringPaymentCollectionEnabled,
  isRecurringPaymentsEnabled,
} from "@/lib/feature-flags";
import { withProcessEnvFallback } from "@/lib/runtime-env";
import { WorkersBackgroundRunner } from "@/runtime/background-cf";
import { getSentryOptions, isSentryEnabled } from "@/runtime/observability";
import { cloudflareObservability, withSentry } from "@/runtime/observability-cf";
import type { Env } from "@/types/env";

const app = createApp({ observability: cloudflareObservability });

const worker = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, withProcessEnvFallback(env), ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const runtimeEnv = withProcessEnvFallback(env);
    const bg = new WorkersBackgroundRunner(ctx);
    const observability = isSentryEnabled(runtimeEnv) ? cloudflareObservability : undefined;
    runPendingTransfersReconciliation({
      env: runtimeEnv,
      bg,
      observability,
    });
    if (isRecurringPaymentsEnabled(runtimeEnv) && isRecurringPaymentCollectionEnabled(runtimeEnv)) {
      runRecurringPaymentsCollection({
        env: runtimeEnv,
        bg,
        observability,
      });
    }
    // Analytics ingestion (every 5 min via separate cron trigger)
    ctx.waitUntil(handleAnalyticsIngestion(runtimeEnv, ctx));

    // Wallet label enrichment (daily via separate cron trigger)
    if (controller.cron === "0 2 * * *") {
      ctx.waitUntil(handleWalletEnrichment(runtimeEnv, ctx));
    }

    // Token discovery (daily at 3am)
    if (controller.cron === "0 3 * * *") {
      ctx.waitUntil(handleTokenDiscovery(runtimeEnv, ctx));
    }

    // User token sync (daily at 4am)
    if (controller.cron === "0 4 * * *") {
      ctx.waitUntil(handleUserTokenSync(runtimeEnv, ctx));
    }

    // Token retirement (daily at 5am)
    if (controller.cron === "0 5 * * *") {
      ctx.waitUntil(handleTokenRetirement(runtimeEnv));
    }
  },
  request(
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: Env | Record<string, unknown>,
    executionCtx?: ExecutionContext
  ) {
    if (!env) {
      return app.request(input, init, env, executionCtx);
    }

    return app.request(input, init, withProcessEnvFallback(env as Env), executionCtx);
  },
} satisfies ExportedHandler<Env> & {
  request: typeof app.request;
};

export default withSentry(getSentryOptions, worker);
