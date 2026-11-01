#!/usr/bin/env bash
# Point the Docker stack at the Surfpool validator running inside WSL.
#
# Network path, which is not obvious:
#
#   container -> host.docker.internal -> Windows host -> WSL localhost forward
#
# The container cannot reach WSL's own address (172.23.x.x) - separate network
# namespace, verified failing. host.docker.internal resolves to the Windows
# host, and WSL2 forwards Windows localhost to services bound on 127.0.0.1
# inside the distro, so the hop works in that direction only.
#
# The Surfpool port is NOT stable. Surfnet picks it at startup and writes it to
# surfpool.json; there is no option to pin it. So this reads the current port
# rather than hardcoding one, and must be re-run after every Surfpool restart.
#
#   bash scripts/wire-surfpool.sh            # point at Surfpool + Kora
#   bash scripts/wire-surfpool.sh --revert   # back to devnet + native fees
set -uo pipefail

ENV_FILE=.env
STATE=/home/ohnnie/sdp/.secrets/kora-surfpool

# Replace a key in .env, or append it when absent. Writing through a temp file
# keeps .env intact if this is interrupted midway.
set_env() {
  local key="$1" value="$2"
  local tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

if [ "${1:-}" = "--revert" ]; then
  echo "reverting to devnet and native fee payment"
  set_env SOLANA_RPC_URL "https://api.devnet.solana.com"
  set_env SOLANA_NETWORK "devnet"
  set_env FEE_PAYMENT_PROVIDER "native"
  set_env KORA_RPC_URL ""
else
  echo "== reading the live Surfpool port from WSL =="
  PORT="$(wsl.exe -d Ubuntu -- bash -c "grep -oE '127[.]0[.]0[.]1:[0-9]+' ${STATE}/surfpool.json | head -1 | cut -d: -f2" 2>/dev/null | tr -d '\r')"

  if [ -z "$PORT" ]; then
    echo "Could not read a Surfpool port from ${STATE}/surfpool.json." >&2
    echo "Start it first:  wsl.exe -d Ubuntu -- bash /mnt/c/.../scripts/wsl-surfpool-up.sh" >&2
    exit 1
  fi
  echo "  surfpool port: $PORT"

  # Prove it answers before rewriting anything. A stale surfpool.json from a
  # dead instance is the likely failure here, and pointing the whole stack at a
  # dead node is worse than refusing.
  if ! curl -sf --max-time 10 -X POST "http://127.0.0.1:${PORT}" \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' >/dev/null; then
    echo "Surfpool did not answer getVersion on 127.0.0.1:${PORT} - stale surfpool.json?" >&2
    exit 1
  fi
  echo "  surfpool answered getVersion"

  set_env SOLANA_RPC_URL "http://host.docker.internal:${PORT}"
  set_env SOLANA_NETWORK "localnet"
  set_env FEE_PAYMENT_PROVIDER "kora"
  set_env KORA_RPC_URL "http://host.docker.internal:18080"
fi

echo
echo "== .env now says =="
grep -E '^(SOLANA_RPC_URL|SOLANA_NETWORK|FEE_PAYMENT_PROVIDER|KORA_RPC_URL)=' "$ENV_FILE"

echo
echo "== recreating sdp-api so it picks the values up =="
docker compose up -d sdp-api

echo
echo "== what the container sees =="
docker compose exec -T sdp-api sh -lc 'for v in SOLANA_RPC_URL SOLANA_NETWORK FEE_PAYMENT_PROVIDER KORA_RPC_URL; do eval val=\$$v; echo "  $v=${val:-<empty>}"; done'
