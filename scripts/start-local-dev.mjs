/**
 * start-local-dev.mjs
 *
 * One-command local dev stack launcher.
 * Brings up Docker postgres + redis, then starts the API and web servers.
 *
 * Usage:
 *   node scripts/start-local-dev.mjs
 *   node scripts/start-local-dev.mjs --web-only   # skip Docker
 *
 * Stop:
 *   node scripts/stop-local-dev.mjs
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".tmp");
const WEB_DIR = path.join(ROOT, "apps", "sdp-web");
mkdirSync(TMP, { recursive: true });

const args = process.argv.slice(2);
const webOnly = args.includes("--web-only");

// ── Help ──────────────────────────────────────────────────────────────
if (args.includes("--help")) {
  console.log(`
Usage:
  node scripts/start-local-dev.mjs              # Full stack
  node scripts/start-local-dev.mjs --web-only    # Skip Docker

Starts Docker postgres:5433 + redis:6379, API (:8787), Web (:3000), ngrok.

Stop:  node scripts/stop-local-dev.mjs
`);
  process.exit(0);
}

// ── Helpers ────────────────────────────────────────────────────────────
function logFile(name) {
  return createWriteStream(path.join(TMP, `${name}.log`), { flags: "a" });
}

function spawnDetached(file, args, cwd, logName) {
  const out = logFile(logName);
  const proc = spawn(file, args, {
    cwd,
    stdio: ["ignore", out, out],
    shell: true,
    detached: true,
  });
  proc.unref();
  return proc;
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.slice(0, 100)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// ── Steps ──────────────────────────────────────────────────────────────

function startDocker() {
  return new Promise((resolve, reject) => {
    if (webOnly) {
      console.log("[docker] --web-only: skipping");
      resolve(false);
      return;
    }
    console.log("[docker] Starting postgres:5433 + redis:6379 ...");
    const proc = spawn("docker", ["compose", "up", "postgres", "redis", "-d"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    proc.on("exit", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`docker compose exited ${code}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

function startApi() {
  console.log("[api]   Starting sdp-api (tsx watch src/server.ts) ...");
  const proc = spawnDetached("node", ["start-api.mjs"], ROOT, "api-server");
  console.log(`  PID ${proc.pid} — .tmp/api-server.log`);
  return proc;
}

function startWeb() {
  console.log("[web]   Starting sdp-web (next dev) ...");
  const proc = spawnDetached("pnpm", ["dev"], WEB_DIR, "web-server");
  console.log(`  PID ${proc.pid} — .tmp/web-server.log`);
  return proc;
}

function startNgrok() {
  return new Promise((resolve) => {
    // Find ngrok binary
    const candidates = [
      "C:\\Users\\Johnnie\\ngrok\\ngrok.exe",
      path.join(process.env.LOCALAPPDATA || "", "ngrok", "ngrok.exe"),
      "ngrok",
    ];
    const bin = candidates.find((c) => {
      try {
        execSync(`"${c}" version 2>nul`, { stdio: "ignore", shell: true });
        return true;
      } catch {
        return false;
      }
    });

    if (!bin) {
      console.log("[ngrok] not found — skipping");
      resolve(null);
      return;
    }

    console.log("[ngrok] Starting tunnel to localhost:3000 ...");
    const out = logFile("ngrok");
    const proc = spawn(bin, ["http", "3000"], {
      stdio: ["ignore", out, out],
      shell: true,
      detached: true,
    });
    proc.unref();

    // Poll ngrok API for the URL
    const poll = (attempts) => {
      if (attempts <= 0) {
        console.log("  URL unknown (check http://127.0.0.1:4040)");
        resolve(proc);
        return;
      }
      setTimeout(async () => {
        try {
          const data = await fetchJson("http://127.0.0.1:4040/api/tunnels");
          const url = data.tunnels?.[0]?.public_url;
          if (url) {
            console.log(`  ${url} → localhost:3000`);
            resolve(proc);
          } else {
            poll(attempts - 1);
          }
        } catch {
          poll(attempts - 1);
        }
      }, 2000);
    };
    poll(10); // up to 20s
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   SDP Local Dev Stack — Starting     ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");

  await startDocker();
  const api = startApi();
  const web = startWeb();
  await startNgrok();

  // Persist PIDs for the stop script
  writeFileSync(
    path.join(TMP, "dev-pids.json"),
    JSON.stringify(
      { api: api.pid, web: web.pid, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );

  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Stack starting in background        ║");
  console.log("║                                      ║");
  console.log("║   Wait ~30s for compilation, then:    ║");
  console.log("║                                      ║");
  console.log("║   API    http://localhost:8787        ║");
  console.log("║   Web    http://localhost:3000        ║");
  console.log("║   ngrok  http://127.0.0.1:4040       ║");
  console.log("║                                      ║");
  console.log("║   Stop:  node scripts/stop-local-dev  ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
