/**
 * stop-local-dev.mjs
 *
 * Stops the local dev stack started by start-local-dev.mjs.
 * Kills API, web, and ngrok processes. Leaves Docker containers running.
 *
 * Usage:
 *   node scripts/stop-local-dev.mjs
 *   node scripts/stop-local-dev.mjs --all   # also stops Docker containers
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".tmp");
const pidFile = path.join(TMP, "dev-pids.json");

const args = process.argv.slice(2);
const stopDocker = args.includes("--all");

function kill(pid, name) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[${name}] Killed PID ${pid}`);
  } catch {
    // already dead
  }
}

// Kill processes tracked in dev-pids.json
if (existsSync(pidFile)) {
  const pids = JSON.parse(readFileSync(pidFile, "utf8"));
  kill(pids.api, "api");
  kill(pids.web, "web");
} else {
  console.log("[warn] No dev-pids.json found — processes may still be running");
}

// Kill ngrok by name (it's always "ngrok")
try {
  spawnSync("taskkill", ["/f", "/im", "ngrok.exe"], { stdio: "ignore", shell: true });
  console.log("[ngrok] Killed");
} catch {
  // not running
}

if (stopDocker) {
  console.log("[docker] Stopping containers ...");
  spawnSync("docker", ["compose", "down"], { cwd: ROOT, stdio: "inherit", shell: true });
}

console.log("\nDone. Remaining node processes:");
spawnSync("tasklist", ["/fi", "IMAGENAME eq node.exe", "/fo", "table"], {
  stdio: "inherit",
  shell: true,
});
