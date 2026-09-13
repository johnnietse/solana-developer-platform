#!/usr/bin/env bash
# Bring up Surfpool (embedded) + Kora (shim) inside WSL.
#
# Both defaults are pure Node and both scripts live under
# packages/sdp-api-integration/scripts, so nothing needs a separate binary or a
# Kora container image. up.sh cds into that package before running them, which
# is why they look absent when you check the repo root.
#
# Run with `bash this-file` from Windows via:
#   wsl.exe -d Ubuntu -- bash /mnt/c/.../scripts/wsl-surfpool-up.sh
#
# `bash script.sh` does not read the login profile, so node is not on PATH
# unless it is added explicitly - hence the PATH line below rather than relying
# on the shell's own setup.
set -uo pipefail

export PATH="/home/ohnnie/.local/bin:$PATH"
DST=/home/ohnnie/sdp

cd "$DST"

echo "== toolchain =="
echo "node : $(node --version)"
echo "pnpm : $(pnpm --version)"
echo

echo "== bringing up Surfpool + Kora =="
echo "runtime=${KORA_SURFPOOL_RUNTIME:-embedded}  mode=${KORA_SURFPOOL_MODE:-shim}"
echo

# Time-boxed: up.sh waits up to 90s for Surfpool and 90s for Kora, so a genuine
# failure still returns rather than hanging this call indefinitely.
timeout 400 bash scripts/kora-surfpool/up.sh
status=$?

echo
echo "== result (exit $status) =="
STATE=/home/ohnnie/sdp/.secrets/kora-surfpool
for f in surfpool.json runtime.env kora.env; do
  if [ -f "$STATE/$f" ]; then
    echo "--- $f ---"
    # kora.env and runtime.env can hold a signer key; print only the
    # non-secret keys so a log or transcript never carries one.
    grep -vE 'PRIVATE_KEY|SECRET|SIGNER' "$STATE/$f" 2>/dev/null | head -12
  fi
done

if [ -f "$STATE/surfpool.log" ]; then
  echo "--- surfpool.log (tail) ---"
  tail -12 "$STATE/surfpool.log"
fi

exit $status
