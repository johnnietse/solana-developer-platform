import { handleAnalyticsIngestion } from "./apps/sdp-api/src/crons/analytics-ingestion";
import { withProcessEnvFallback } from "./apps/sdp-api/src/lib/runtime-env";

const env = withProcessEnvFallback({} as any);
env.ANALYTICS_ENABLED = "true";

const ctx = {
  waitUntil: (p: Promise<any>) => p,
  passThroughOnException: () => {},
};

console.log("Starting ingestion...");
const result = await handleAnalyticsIngestion(env, ctx);
console.log("Ingestion result:", result.status, await result.text());
