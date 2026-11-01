#!/usr/bin/env bash
# Restart Surfpool forking devnet instead of running offline.
#
# up.sh starts Surfpool offline when no managed RPC is configured, and an
# offline surfnet has no chain state to answer from. The symptom is specific
# and misleading: metadata methods succeed while state methods hang with no
# response at all.
#
#   getVersion getHealth getConfig            -> 200
#   getBalance getSlot getLatestBlockhash     -> no response, curl http=000
#
# Nothing can be deployed in that state, because building any transaction needs
# getLatestBlockhash. Forking devnet gives the node real accounts and blockhashes
# while keeping local cheatcode funding, which is the combination Kora needs.
#
# surfnet.mjs sets offline:false whenever SURFPOOL_REMOTE_RPC_URL is present.
set -uo pipefail

export PATH="/home/ohnnie/.local/bin:$PATH"
DST=/home/ohnnie/sdp
cd "$DST"

export SURFPOOL_REMOTE_RPC_URL="${SURFPOOL_REMOTE_RPC_URL:-https://api.devnet.solana.com}"
export KORA_SURFPOOL_OFFLINE=false

echo "== stopping the offline instance =="
timeout 120 bash scripts/kora-surfpool/down.sh 2>&1 | tail -4 || true

echo
echo "== starting, forking ${SURFPOOL_REMOTE_RPC_URL} =="
timeout 400 bash scripts/kora-surfpool/up.sh 2>&1 | tail -12
status=$?

STATE="$DST/.secrets/kora-surfpool"
PORT=""
if [ -f "$STATE/surfpool.json" ]; then
  PORT="$(grep -oE '127[.]0[.]0[.]1:[0-9]+' "$STATE/surfpool.json" | head -1 | cut -d: -f2)"
fi

echo
echo "== state methods now answering? (this is the point of the restart) =="
if [ -n "$PORT" ]; then
  echo "  port: $PORT"
  for m in getVersion getSlot getLatestBlockhash; do
    printf '  %-20s ' "$m"
    curl -s -w ' [http=%{http_code}]' --max-time 25 -X POST "http://127.0.0.1:${PORT}" \
      -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${m}\"}" | head -c 130
    echo
  done
else
  echo "  no port in surfpool.json"
fi

exit $status
