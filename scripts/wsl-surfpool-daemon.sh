#!/usr/bin/env bash
# Start Surfpool + Kora so they OUTLIVE the shell that started them.
#
# up.sh backgrounds Surfpool with `&`, which is fine for a long-lived
# interactive session and wrong for `wsl.exe -- bash script.sh`: WSL tears the
# distro's processes down once the last shell exits, so Surfpool died the
# moment each setup command returned.
#
# The symptom was deeply misleading. Surfpool answered every check *inside* the
# script that started it, so each run reported success - then the next command
# found state methods hanging, and later even getVersion failing. It read like
# progressive corruption of a running service. It was a dead process each time,
# and surfpool.log ends after three clean startup lines with no error because
# nothing crashed.
#
# setsid detaches from the controlling terminal, nohup ignores SIGHUP, and a
# keepalive process holds the distro open so WSL does not reap the session.
set -uo pipefail

export PATH="/home/ohnnie/.local/bin:$PATH"
DST=/home/ohnnie/sdp
STATE="$DST/.secrets/kora-surfpool"
cd "$DST"

# SDP_SURFPOOL_MODE=offline runs without a devnet fork. Forking fetches any
# account it has not seen from the public devnet RPC, which rate-limits, and a
# fetch that hangs holds Surfpool's state lock - every query then hangs with it.
if [ "${SDP_SURFPOOL_MODE:-offline}" = "offline" ]; then
  unset SURFPOOL_REMOTE_RPC_URL
  export KORA_SURFPOOL_OFFLINE=true
else
  export SURFPOOL_REMOTE_RPC_URL="${SURFPOOL_REMOTE_RPC_URL:-https://api.devnet.solana.com}"
  export KORA_SURFPOOL_OFFLINE=false
fi
# Clock-driven blocks, so slots and blockhashes advance while idle like a real
# cluster.
export KORA_SURFPOOL_BLOCK_PRODUCTION_MODE="${KORA_SURFPOOL_BLOCK_PRODUCTION_MODE:-clock}"
export KORA_SURFPOOL_SLOT_TIME_MS="${KORA_SURFPOOL_SLOT_TIME_MS:-400}"
# Send Kora's transactions through the fixed-port proxy, which records the
# accounts they touch so they can be restored after a Surfpool restart.
export KORA_SHIM_UPSTREAM_RPC_URL="${KORA_SHIM_UPSTREAM_RPC_URL:-http://127.0.0.1:8899}"

# The WSL clone is a snapshot and does not follow edits on the Windows side;
# take up.sh from the Windows checkout like the proxy script does.
WIN_REPO=/mnt/c/Users/Johnnie/Documents/MLH_Fellowship_2026
tr -d '\r' < "$WIN_REPO/scripts/kora-surfpool/up.sh" > scripts/kora-surfpool/up.sh
# Carries the drainEvents fix; without it Surfpool freezes after ~1024 blocks.
tr -d '\r' < "$WIN_REPO/packages/sdp-api-integration/scripts/kora-surfpool-surfnet.mjs" \
  > packages/sdp-api-integration/scripts/kora-surfpool-surfnet.mjs

echo "== stopping anything still running =="
timeout 90 bash scripts/kora-surfpool/down.sh >/dev/null 2>&1 || true
pkill -f kora-surfpool-surfnet 2>/dev/null || true
pkill -f kora-surfpool-shim 2>/dev/null || true
sleep 2

echo "== keepalive so WSL does not reap the distro =="
# Without this the distro can shut down once no shell remains, taking Surfpool
# with it however well it is detached.
if ! pgrep -f 'sdp-surfpool-keepalive' >/dev/null 2>&1; then
  setsid nohup bash -c 'exec -a sdp-surfpool-keepalive sleep infinity' >/dev/null 2>&1 &
  disown 2>/dev/null || true
  echo "  keepalive started"
else
  echo "  keepalive already running"
fi

echo
echo "== starting Surfpool + Kora, detached =="
setsid nohup bash scripts/kora-surfpool/up.sh > "$STATE/up.out" 2>&1 &
disown 2>/dev/null || true

# up.sh waits for both services itself; poll for the artefacts it writes rather
# than guessing a fixed sleep.
for i in $(seq 1 60); do
  if [ -f "$STATE/surfpool.json" ] && [ -f "$STATE/runtime.env" ]; then
    break
  fi
  sleep 3
done

PORT="$(grep -oE '127[.]0[.]0[.]1:[0-9]+' "$STATE/surfpool.json" 2>/dev/null | head -1 | cut -d: -f2)"
echo "  port: ${PORT:-unknown}"

echo
echo "== does it survive? (checked after the starting shell has gone) =="
sleep 8
if [ -f "$STATE/surfpool.pid" ]; then
  PID="$(cat "$STATE/surfpool.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    echo "  pid $PID: alive"
  else
    echo "  pid $PID: DEAD - detaching did not hold"
  fi
fi

for m in getVersion getSlot getLatestBlockhash; do
  printf '  %-20s ' "$m"
  timeout 20 curl -s -w ' [http=%{http_code}]' --max-time 18 -X POST "http://127.0.0.1:${PORT}" \
    -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${m}\"}" | head -c 110
  echo
done
