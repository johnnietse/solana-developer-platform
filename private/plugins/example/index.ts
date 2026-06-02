import type { SdpPlugin } from "@/app";
import { registerFallbackKeys } from "@/lib/runtime-env";

registerFallbackKeys("EXAMPLE_SECRET");

export const examplePlugin: SdpPlugin = {
  name: "example",
  register(app) {
    app.get("/example/hello", (c) => c.json({ ok: true }));
  },
};
