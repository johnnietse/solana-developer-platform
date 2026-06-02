import { serve } from "@hono/node-server";
import { createApp, type SdpPlugin } from "@/app";
import { withProcessEnvFallback } from "@/lib/runtime-env";
import { nodeObservability } from "@/runtime/observability-node";
import type { Env } from "@/types/env";
import { examplePlugin } from "./plugins/example";

const plugins: SdpPlugin[] = [examplePlugin];

const env = withProcessEnvFallback({} as Env);
env.SDP_RUNTIME = "node";

const app = createApp({ observability: nodeObservability, plugins });

const port = Number(process.env.PORT) || 8787;
serve({ fetch: (req) => app.fetch(req, env), port });
console.log(`sdp-api private entrypoint listening on :${port}`);
