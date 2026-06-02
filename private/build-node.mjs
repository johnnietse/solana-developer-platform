/* biome-ignore-all lint/security/noSecrets: file contains the esbuild banner template, which trips the high-entropy heuristic */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../apps/sdp-api");
const apiSrc = path.join(apiDir, "src");
const require = createRequire(path.join(apiDir, "package.json"));
const esbuild = require("esbuild");

const banner =
  "import{createRequire as __cr}from'module';" +
  "import{fileURLToPath as __furl}from'url';" +
  "import __path from'path';" +
  "const require=__cr(import.meta.url);" +
  "const __filename=__furl(import.meta.url);" +
  "const __dirname=__path.dirname(__filename);";

await esbuild.build({
  entryPoints: { server: path.join(here, "server.ts") },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outdir: path.join(here, "dist"),
  outExtension: { ".js": ".mjs" },
  alias: { "@": apiSrc },
  nodePaths: [path.join(apiDir, "node_modules")],
  external: ["pg-native", "@sentry/profiling-node"],
  banner: { js: banner },
});
