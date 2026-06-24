#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${KORA_SURFPOOL_STATE_DIR:-"${ROOT_DIR}/.secrets/kora-surfpool"}"
RUNTIME_ENV_FILE="${STATE_DIR}/runtime.env"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: pnpm kora:surfpool:integration -- <test-files...>" >&2
  exit 1
fi

cleanup() {
  "${ROOT_DIR}/scripts/kora-surfpool/down.sh"
}
trap cleanup EXIT

if [ -n "${KORA_SURFPOOL_KORA_RPC_URL:-}" ]; then
  export KORA_RPC_URL="${KORA_SURFPOOL_KORA_RPC_URL}"
elif [ "${DOPPLER_RUN_ACTIVE:-}" = "1" ]; then
  export KORA_RPC_URL="http://127.0.0.1:18080"
else
  export KORA_RPC_URL="${KORA_RPC_URL:-http://127.0.0.1:18080}"
fi

export FEE_PAYMENT_PROVIDER="${FEE_PAYMENT_PROVIDER:-kora}"
export RUN_INTEGRATION_TESTS="${RUN_INTEGRATION_TESTS:-true}"
export KORA_SURFPOOL_SHIM="${KORA_SURFPOOL_SHIM:-true}"
export SDP_INTEGRATION_CUSTODY_PROVIDER="${SDP_INTEGRATION_CUSTODY_PROVIDER:-local}"
export CUSTODY_PRIVATE_KEY="${CUSTODY_PRIVATE_KEY:-kora-surfpool-local-custody}"
export DATABASE_URL="${KORA_SURFPOOL_DATABASE_URL:-postgresql://sdp:sdp@127.0.0.1:5432/sdp}"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${DATABASE_URL}"

"${ROOT_DIR}/scripts/kora-surfpool/up.sh"
if [ -f "${RUNTIME_ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${RUNTIME_ENV_FILE}"
  set +a
fi

export SDP_INTEGRATION_CUSTODY_PROVIDER="${SDP_INTEGRATION_CUSTODY_PROVIDER:-local}"
export CUSTODY_PRIVATE_KEY="${CUSTODY_PRIVATE_KEY:-kora-surfpool-local-custody}"
export DATABASE_URL="${KORA_SURFPOOL_DATABASE_URL:-postgresql://sdp:sdp@127.0.0.1:5432/sdp}"
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${DATABASE_URL}"

pnpm --filter @sdp/api db:postgres:bootstrap
pnpm --filter @sdp/api-integration exec vitest run "$@"
