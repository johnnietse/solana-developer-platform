#!/usr/bin/env bash
# Start the fixed-port Surfpool proxy inside WSL, detached.
#
# Copies the current proxy from the Windows checkout rather than relying on the
# WSL clone being up to date - the clone is a snapshot and does not follow
# edits made on the Windows side.
#
# Detached for the same reason Surfpool is: WSL reaps processes when the last
# shell exits, so a proxy started plainly would die with this script and take
# the fixed port with it.
set -uo pipefail

WIN_REPO=/mnt/c/Users/Johnnie/Documents/MLH_Fellowship_2026
DST=/home/ohnnie/sdp
STATE="$DST/.secrets/kora-surfpool"
PROXY_PORT="${PROXY_PORT:-8899}"

export PATH="/home/ohnnie/.local/bin:$PATH"

cp "$WIN_REPO/scripts/surfpool-proxy.mjs" "$DST/scripts/surfpool-proxy.mjs"
echo "proxy copied from the Windows checkout"

echo "== stopping any previous proxy =="
pkill -f 'surfpool-proxy.mjs' 2>/dev/null || true
sleep 1

echo "== starting proxy on :$PROXY_PORT =="
cd "$DST"
# Restart via the daemon script, NOT up.sh directly. up.sh reuses a running
# instance, and a wedged Surfpool is still running - so pointing the watchdog at
# it produced a "restart" that changed nothing and left the same dead port in
# place. The daemon script runs down.sh and pkill first, so the replacement is
# real.
PROXY_PORT="$PROXY_PORT" \
SURFPOOL_STATE="$STATE" \
SURFPOOL_RESTART="$WIN_REPO/scripts/wsl-surfpool-daemon.sh" \
  setsid nohup node scripts/surfpool-proxy.mjs > "$STATE/proxy.log" 2>&1 &
disown 2>/dev/null || true

sleep 5
echo
echo "== proxy alive? =="
if pgrep -f 'surfpool-proxy.mjs' >/dev/null 2>&1; then
  echo "  process: running (pid $(pgrep -f 'surfpool-proxy.mjs' | head -1))"
else
  echo "  process: NOT RUNNING"
fi

echo
echo "== does the fixed port serve a state query? =="
printf '  getLatestBlockhash via :%s  ' "$PROXY_PORT"
timeout 25 curl -s -w '[http=%%{http_code}]' --max-time 22 -X POST "http://127.0.0.1:${PROXY_PORT}" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash"}' | head -c 120
echo
echo
echo "== proxy log =="
tail -6 "$STATE/proxy.log" 2>/dev/null | sed 's/^/  /'
