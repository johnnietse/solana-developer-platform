#!/usr/bin/env node
/**
 * Fixed-port front door for Surfpool, with a watchdog.
 *
 * Two problems this solves, both of which otherwise need a person:
 *
 *   1. Surfnet picks a random port at startup and offers no way to pin it, so
 *      every restart moved the address and the Docker stack had to be
 *      re-pointed by hand.
 *   2. Surfpool 1.4.0 stops answering state queries after a while with its
 *      process still alive. getVersion keeps returning 200 throughout, which is
 *      exactly how it kept looking healthy while being unable to serve a
 *      transaction.
 *
 * Listening on one fixed port and forwarding to whatever Surfpool currently
 * uses means the stack points at this, once, forever. The watchdog probes with
 * getLatestBlockhash - a state method, deliberately, since getVersion cannot
 * tell a wedged instance from a working one - and restarts Surfpool when it
 * stops answering, then picks up the new port by re-reading surfpool.json.
 *
 *   node scripts/surfpool-proxy.mjs          listen on 8899
 *   PROXY_PORT=9000 node scripts/surfpool-proxy.mjs
 *
 * Runs inside WSL, where Surfpool lives.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const PROXY_PORT = Number(process.env.PROXY_PORT || 8899);
const STATE = process.env.SURFPOOL_STATE || "/home/ohnnie/sdp/.secrets/kora-surfpool";
const INFO = `${STATE}/surfpool.json`;
const RESTART = process.env.SURFPOOL_RESTART || "/home/ohnnie/sdp/scripts/kora-surfpool/up.sh";
const PROBE_MS = Number(process.env.PROBE_MS || 20000);

let target = null;         // current upstream origin
let restarting = false;
let lastGoodAt = 0;

async function readPort() {
  try {
    const j = JSON.parse(await readFile(INFO, "utf8"));
    const m = String(j.rpcUrl || "").match(/:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function refreshTarget() {
  const port = await readPort();
  if (port && target !== `http://127.0.0.1:${port}`) {
    target = `http://127.0.0.1:${port}`;
    log(`upstream -> ${target}`);
  }
  return target;
}

/**
 * A state method, not getVersion.
 *
 * This is the whole point of the watchdog: a wedged Surfpool answers
 * getVersion perfectly and cannot serve a transaction. Probing the cheap
 * static method is what made three earlier diagnoses wrong.
 */
async function isHealthy() {
  if (!target) return false;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j?.result?.value?.blockhash);
  } catch {
    return false;
  }
}

function log(msg) {
  console.log(`[surfpool-proxy ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function restartSurfpool() {
  if (restarting) return;
  restarting = true;
  log("upstream not serving state queries - restarting Surfpool");
  await new Promise((resolve) => {
    // detached: the restart must outlive this call, and Surfpool dying with its
    // starting shell is the bug that made every earlier setup look flaky.
    const child = spawn("bash", [RESTART], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SURFPOOL_REMOTE_RPC_URL: process.env.SURFPOOL_REMOTE_RPC_URL || "https://api.devnet.solana.com",
        KORA_SURFPOOL_OFFLINE: "false",
      },
    });
    child.unref();
    // up.sh waits for its own readiness; give it room, then re-read the port.
    setTimeout(resolve, 60000);
  });
  target = null;
  await refreshTarget();
  restarting = false;
  log(`restart finished, upstream ${target ?? "unknown"}`);
}

setInterval(async () => {
  await refreshTarget();
  if (await isHealthy()) {
    lastGoodAt = Date.now();
    return;
  }
  if (restarting) return;
  // One failed probe can be a slow devnet fetch behind a forked call. Two in a
  // row, twenty seconds apart, is a wedge.
  if (Date.now() - lastGoodAt > PROBE_MS * 2) await restartSurfpool();
}, PROBE_MS);

const server = createServer(async (req, res) => {
  await refreshTarget();
  if (!target) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "surfpool upstream unknown - is it running?" }));
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    try {
      const upstream = await fetch(target + (req.url || "/"), {
        method: req.method,
        headers: { "Content-Type": req.headers["content-type"] || "application/json" },
        body: ["GET", "HEAD"].includes(req.method || "") ? undefined : Buffer.concat(chunks),
        signal: AbortSignal.timeout(120000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(text);
    } catch (err) {
      // 502 rather than a hang: a caller that gets an answer can retry, and the
      // 300s undici timeouts were the worst part of every earlier failure.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `surfpool proxy: ${err.message}` }));
    }
  });
});

await refreshTarget();
lastGoodAt = Date.now();
server.listen(PROXY_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${PROXY_PORT}, upstream ${target ?? "unknown"}`);
  log(`watchdog probing getLatestBlockhash every ${PROBE_MS / 1000}s`);
});
