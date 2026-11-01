#!/usr/bin/env bash
# One command for the whole Surfpool loop. Run from Git Bash on Windows.
#
#   bash scripts/surfpool.sh status    is it healthy right now?
#   bash scripts/surfpool.sh restart   restart it and re-point the stack
#   bash scripts/surfpool.sh off       back to devnet, native fee payment
#
# Why this exists: Surfpool 1.4.0 stops answering state queries after a while
# with its process still alive, and its port changes on every restart. Both of
# those otherwise mean hand-running two scripts and reading a JSON file. The
# dashboard drives everything else on its own - this is only here so recovering
# from a wedged validator does not need anyone's help.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WSL_REPO=/mnt/c/Users/Johnnie/Documents/MLH_Fellowship_2026
STATE=/home/ohnnie/sdp/.secrets/kora-surfpool
CMD="${1:-status}"

port_now() {
  wsl.exe -d Ubuntu -- bash -c \
    "grep -oE '127[.]0[.]0[.]1:[0-9]+' ${STATE}/surfpool.json 2>/dev/null | head -1 | cut -d: -f2" \
    2>/dev/null | tr -d '\r'
}

# Ask for a blockhash, not a version. getVersion answers from a wedged
# instance, which is exactly how this looked healthy while being unusable -
# only a state method proves it can serve a transaction.
healthy() {
  local port="$1"
  [ -z "$port" ] && return 1
  curl -sf --max-time 12 -X POST "http://127.0.0.1:${port}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash"}' >/dev/null 2>&1
}

case "$CMD" in
  status)
    PORT="$(port_now)"
    echo "surfpool port : ${PORT:-none}"
    if healthy "$PORT"; then
      echo "surfpool      : HEALTHY (serving state queries)"
    else
      echo "surfpool      : WEDGED or down  ->  bash scripts/surfpool.sh restart"
    fi
    if curl -sf --max-time 10 http://127.0.0.1:18080/health >/dev/null 2>&1; then
      echo "kora          : healthy"
    else
      echo "kora          : down"
    fi
    echo
    echo "stack is pointed at:"
    grep -E '^(SOLANA_RPC_URL|FEE_PAYMENT_PROVIDER|KORA_RPC_URL)=' "$REPO/.env" 2>/dev/null | sed 's/^/  /'
    ;;

  restart)
    echo "== restarting Surfpool + Kora in WSL =="
    wsl.exe -d Ubuntu -- bash "$WSL_REPO/scripts/wsl-surfpool-daemon.sh" 2>&1 | tr -d '\r' | tail -6
    echo
    echo "== re-pointing the Docker stack at the new port =="
    bash "$REPO/scripts/wire-surfpool.sh" 2>&1 | grep -E 'surfpool port|answered|SOLANA_RPC_URL=|KORA_RPC_URL=|FEE_PAYMENT'
    echo
    PORT="$(port_now)"
    if healthy "$PORT"; then
      echo "ready - the Deploy button should work now"
    else
      echo "surfpool still not serving state queries on ${PORT:-?}; try again"
      exit 1
    fi
    ;;

  off)
    bash "$REPO/scripts/wire-surfpool.sh" --revert 2>&1 | tail -6
    ;;

  *)
    echo "usage: bash scripts/surfpool.sh [status|restart|off]" >&2
    exit 1
    ;;
esac
