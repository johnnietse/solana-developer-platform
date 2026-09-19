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
 *      transaction. The cause turned out to be an undrained event queue, fixed
 *      in kora-surfpool-surfnet.mjs; the watchdog stays as the safety net.
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
 *
 * Chain state survives restarts. Surfpool has no persistence of its own, so a
 * restart used to erase every mint the dashboard had deployed while the
 * database kept listing them as active. The proxy now records every account a
 * transaction touches, re-reads those accounts while Surfpool is healthy, and
 * writes them back with the surfnet_setAccount cheatcode after any restart -
 * including a reboot, since the snapshot is a file.
 *
 *   GET /__proxy/status     upstream, health, restarts, snapshot size
 */

import { createServer } from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";

const PROXY_PORT = Number(process.env.PROXY_PORT || 8899);
const STATE = process.env.SURFPOOL_STATE || "/home/ohnnie/sdp/.secrets/kora-surfpool";
const INFO = `${STATE}/surfpool.json`;
const RESTART = process.env.SURFPOOL_RESTART || "/home/ohnnie/sdp/scripts/kora-surfpool/up.sh";
const PROBE_MS = Number(process.env.PROBE_MS || 20000);
// How long state queries must fail continuously before Surfpool counts as
// wedged. A devnet-forked Surfpool stalls for 15-40s at a time while fetching
// remote accounts and then recovers, so this must sit well above that; offline
// (the default) has no such stalls.
const WEDGE_MS = Number(process.env.WEDGE_MS || 90000);
// Outside STATE on purpose: down.sh cleans that directory.
const SNAPSHOT = process.env.SURFPOOL_SNAPSHOT || "/home/ohnnie/sdp/.secrets/surfpool-snapshot.json";

// Accounts that are part of the runtime, not state the dashboard created.
const SKIP_OWNERS = new Set([
  "NativeLoader1111111111111111111111111111111",
  "Sysvar1111111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
]);

let target = null;         // current upstream origin
let restarting = false;
let lastGoodAt = 0;
let restarts = 0;
let lastRestoreAt = null;
/** address -> { lamports, data (hex), owner, executable } */
let snapshot = {};
let lastSnapshotAt = null;
const pendingSignatures = new Set();

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

async function rpc(method, params = [], timeoutMs = 15000) {
  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function loadSnapshot() {
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  } catch {
    snapshot = {};
  }
}

async function saveSnapshot() {
  const tmp = `${SNAPSHOT}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(tmp, SNAPSHOT);
  lastSnapshotAt = new Date().toISOString();
}

/** Learn which accounts a landed transaction touched. */
async function trackSignature(signature) {
  const tx = await rpc("getTransaction", [
    signature,
    { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
  ]);
  if (!tx) return false; // not landed yet
  const keys = [
    ...(tx.transaction?.message?.accountKeys ?? []),
    ...(tx.meta?.loadedAddresses?.writable ?? []),
  ];
  for (const k of keys) if (!(k in snapshot)) snapshot[k] = null;
  return true;
}

/**
 * Re-read every tracked account so the snapshot follows balances and supply.
 * Only runs against a healthy upstream: reading a half-dead Surfpool would
 * overwrite good state with nulls.
 */
async function refreshSnapshot() {
  for (const sig of [...pendingSignatures]) {
    try {
      if (await trackSignature(sig)) pendingSignatures.delete(sig);
    } catch {}
  }
  const addresses = Object.keys(snapshot);
  if (addresses.length === 0) return;
  let changed = false;
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const { value } = await rpc("getMultipleAccounts", [chunk, { encoding: "base64" }]);
    chunk.forEach((addr, n) => {
      const acc = value[n];
      if (!acc || acc.executable || SKIP_OWNERS.has(acc.owner)) {
        // Programs and sysvars come back with every Surfpool; closed accounts
        // should stay closed.
        if (snapshot[addr] !== undefined) {
          delete snapshot[addr];
          changed = true;
        }
        return;
      }
      const next = {
        lamports: acc.lamports,
        data: Buffer.from(acc.data[0], "base64").toString("hex"),
        owner: acc.owner,
        executable: false,
      };
      if (JSON.stringify(snapshot[addr]) !== JSON.stringify(next)) {
        snapshot[addr] = next;
        changed = true;
      }
    });
  }
  if (changed || !lastSnapshotAt) await saveSnapshot();
}

// On-chain programs the dashboard's templates call that an offline Surfpool
// does not ship: Token ACL and its allowlist gate (the stablecoin template).
// Without them the deploy transaction is dropped silently and the API reports
// a confirmation timeout.
const SEED_PROGRAMS = (
  process.env.SEED_PROGRAMS ||
  "TACLkU6CiCdkQN2MjoyDkVg2yAH9zkxiHDsiztQ52TP,GATEzzqxhJnsWF6vHRsgtixxSB8PaQdcqGEVTEHWiULz"
)
  .split(",")
  .filter(Boolean);
const SEED_SOURCE = process.env.SEED_SOURCE_RPC || "https://api.devnet.solana.com";
const PROGRAM_CACHE = process.env.SURFPOOL_PROGRAM_CACHE || "/home/ohnnie/sdp/.secrets/surfpool-programs.json";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

/**
 * Program + programdata accounts, fetched from devnet once and cached, so
 * later restarts and reboots need no network at all.
 */
async function programAccounts() {
  try {
    const cached = JSON.parse(await readFile(PROGRAM_CACHE, "utf8"));
    if (SEED_PROGRAMS.every((p) => p in cached)) return cached;
  } catch {}
  const fetchAcc = async (addr) => {
    const res = await fetch(SEED_SOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [addr, { encoding: "base64" }] }),
      signal: AbortSignal.timeout(30000),
    });
    const v = (await res.json()).result?.value;
    if (!v) throw new Error(`${addr} not found on ${SEED_SOURCE}`);
    return {
      lamports: v.lamports,
      data: Buffer.from(v.data[0], "base64").toString("hex"),
      owner: v.owner,
      executable: v.executable,
    };
  };
  const out = {};
  for (const p of SEED_PROGRAMS) {
    const prog = await fetchAcc(p);
    // An upgradeable program account holds only a pointer; the code lives in
    // the programdata account whose address sits at bytes 4..36.
    const pdAddr = base58(Buffer.from(prog.data, "hex").subarray(4, 36));
    out[p] = { program: prog, programDataAddress: pdAddr, programData: await fetchAcc(pdAddr) };
  }
  await writeFile(PROGRAM_CACHE, JSON.stringify(out), { mode: 0o600 });
  return out;
}

async function seedPrograms() {
  let programs;
  try {
    programs = await programAccounts();
  } catch (err) {
    log(`program seed skipped: ${err.message}`);
    return;
  }
  for (const [id, p] of Object.entries(programs)) {
    // programdata first: the program account points at it.
    await rpc("surfnet_setAccount", [p.programDataAddress, p.programData]);
    await rpc("surfnet_setAccount", [id, p.program]);
  }
  log(`seeded ${Object.keys(programs).length} programs`);
}

/** Write the snapshot back into a fresh Surfpool. */
async function restoreSnapshot() {
  const entries = Object.entries(snapshot).filter(([, v]) => v);
  if (entries.length === 0) return;
  let ok = 0;
  for (const [addr, acc] of entries) {
    try {
      await rpc("surfnet_setAccount", [addr, acc]);
      ok += 1;
    } catch (err) {
      log(`restore ${addr} failed: ${err.message}`);
    }
  }
  lastRestoreAt = new Date().toISOString();
  log(`restored ${ok}/${entries.length} accounts from snapshot`);
}

/**
 * Restore once per Surfpool instance, keyed on the instanceId it writes to
 * surfpool.json. Probing for a missing account instead would also fire when an
 * account was legitimately closed, and resurrect it.
 */
let restoredInstance = null;
async function readInstanceId() {
  try {
    return JSON.parse(await readFile(INFO, "utf8")).instanceId ?? null;
  } catch {
    return null;
  }
}
async function restoreIfFresh() {
  const id = await readInstanceId();
  if (!id || id === restoredInstance) return;
  // Persisted so that restarting only the proxy does not roll a live instance
  // back to a snapshot up to one probe old.
  let done = null;
  try {
    done = (await readFile(`${SNAPSHOT}.instance`, "utf8")).trim();
  } catch {}
  if (done !== id) {
    await seedPrograms();
    await restoreSnapshot();
  }
  restoredInstance = id;
  await writeFile(`${SNAPSHOT}.instance`, id, { mode: 0o600 });
}

function log(msg) {
  console.log(`[surfpool-proxy ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function restartSurfpool() {
  if (restarting) return;
  restarting = true;
  log("upstream not serving state queries - restarting Surfpool");
  const before = await readInstanceId();
  await new Promise((resolve) => {
    // detached: the restart must outlive this call, and Surfpool dying with its
    // starting shell is the bug that made every earlier setup look flaky.
    const child = spawn("bash", [RESTART], {
      detached: true,
      stdio: "ignore",
      // The daemon script owns the forked-vs-offline choice.
      env: process.env,
    });
    child.unref();
    resolve();
  });
  // Done when a different instance answers a state query, rather than after a
  // fixed wait: every second here is a second the dashboard cannot transact.
  const deadline = Date.now() + 120000;
  target = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const id = await readInstanceId();
    if (!id || id === before) continue;
    await refreshTarget();
    if (await isHealthy()) break;
  }
  await refreshTarget();
  restarts += 1;
  // A new instance deserves the full grace period. Leaving lastGoodAt at its
  // pre-restart value made the first slow probe afterwards trigger another
  // restart at once.
  lastGoodAt = Date.now();
  restarting = false;
  log(`restart finished, upstream ${target ?? "unknown"}`);
}

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await refreshTarget();
    if (await isHealthy()) {
      lastGoodAt = Date.now();
      if (restarting) return;
      // Restore strictly before refresh: refreshing a fresh, unrestored
      // instance would read every account as missing and empty the snapshot.
      try {
        await restoreIfFresh();
        await refreshSnapshot();
      } catch (err) {
        log(`snapshot: ${err.message}`);
      }
      return;
    }
    if (restarting) return;
    if (Date.now() - lastGoodAt > WEDGE_MS) await restartSurfpool();
  } finally {
    ticking = false;
  }
}, PROBE_MS);

/** Note what a request will change, so the snapshot can follow it. */
function observe(requestBody, responseText) {
  let reqs, resps;
  try {
    reqs = [].concat(JSON.parse(requestBody));
    resps = [].concat(JSON.parse(responseText));
  } catch {
    return;
  }
  reqs.forEach((r, i) => {
    const out = resps.find((x) => x?.id === r?.id) ?? resps[i];
    if (!r || !out || out.error) return;
    if (r.method === "sendTransaction" && typeof out.result === "string") {
      pendingSignatures.add(out.result);
    } else if (
      ["requestAirdrop", "surfnet_setAccount", "surfnet_setTokenAccount"].includes(r.method) &&
      typeof r.params?.[0] === "string" &&
      !(r.params[0] in snapshot)
    ) {
      snapshot[r.params[0]] = null;
    }
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__proxy/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        upstream: target,
        healthy: Date.now() - lastGoodAt < PROBE_MS * 2,
        lastGoodAt: new Date(lastGoodAt).toISOString(),
        restarting,
        restarts,
        snapshotAccounts: Object.values(snapshot).filter(Boolean).length,
        pendingSignatures: pendingSignatures.size,
        lastSnapshotAt,
        lastRestoreAt,
      })
    );
    return;
  }
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
      if (req.method === "POST") observe(Buffer.concat(chunks).toString("utf8"), text);
    } catch (err) {
      // 502 rather than a hang: a caller that gets an answer can retry, and the
      // 300s undici timeouts were the worst part of every earlier failure.
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `surfpool proxy: ${err.message}` }));
    }
  });
});

await loadSnapshot();
await refreshTarget();
lastGoodAt = Date.now();
server.listen(PROXY_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${PROXY_PORT}, upstream ${target ?? "unknown"}`);
  log(`watchdog probing getLatestBlockhash every ${PROBE_MS / 1000}s, restart after ${WEDGE_MS / 1000}s down`);
  log(`snapshot ${SNAPSHOT}: ${Object.values(snapshot).filter(Boolean).length} accounts`);
});
