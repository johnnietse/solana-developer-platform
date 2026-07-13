// Loads repo-root .env.local and starts the sdp-api dev server (pnpm dev:node).
// Usage: node start-api.mjs   (run from the repo root)
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, ".env.local");
const env = { ...process.env };

if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  console.log(`Loaded env from ${envPath}`);
} else {
  console.warn(`No .env.local found at ${envPath}; running with existing environment.`);
}

const apiDir = path.join(root, "apps/sdp-api");
const child = spawn("pnpm", ["dev:node"], { cwd: apiDir, env, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("Failed to start sdp-api:", err.message);
  process.exit(1);
});
