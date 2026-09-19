#!/usr/bin/env bash
# Bring the whole platform up from cold, then prove it with the dashboard check.
# Run from Git Bash:  bash scripts/start-all.sh
#
# Idempotent - every step checks before acting, so running it on a stack that
# is already up just confirms it. It encodes the failures that actually happened
# on this machine after reboots, rather than the happy path:
#
#   1. Docker Desktop fails to start because a stale AF_UNIX socket at
#      %LOCALAPPDATA%\docker-secrets-engine\engine.sock cannot be renamed.
#      Windows cannot delete it either, so the directory is moved aside and
#      Docker recreates it clean. Happened twice.
#   2. Surfpool and Kora live in WSL and die with the session, so they are
#      started detached along with the fixed-port proxy and its watchdog.
set -uo pipefail

export MSYS_NO_PATHCONV=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
W=/mnt/c/Users/Johnnie/Documents/MLH_Fellowship_2026/scripts
cd "$REPO"

engine_up() { timeout 8 docker version --format '{{.Server.Version}}' 2>/dev/null | grep -qE '^[0-9]'; }
proxy_up() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST http://127.0.0.1:8899 \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash"}')" = "200" ]
}

echo "== 1/4 docker engine =="
if engine_up; then
  echo "  already up"
else
  powershell.exe -NoProfile -Command '
    Get-Process | Where-Object { $_.Name -like "*docker*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    $d = "$env:LOCALAPPDATA\docker-secrets-engine"
    if (Test-Path "$d\engine.sock") {
      Rename-Item $d -NewName ("docker-secrets-engine.broken-" + (Get-Date -Format yyyyMMdd-HHmmss))
      "  stale engine.sock moved aside"
    }
    Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  ' | tr -d '\r'
  for i in $(seq 1 80); do engine_up && break; sleep 3; done
  engine_up && echo "  up" || { echo "  Docker did not come up - open Docker Desktop and read its dialog"; exit 1; }
fi

echo "== 2/4 compose stack =="
docker compose up -d >/dev/null 2>&1
for i in $(seq 1 40); do
  docker compose ps --format '{{.Status}}' | grep -qE 'starting|Restarting|unhealthy' || break
  sleep 5
done
docker compose ps --format '  {{.Service}}\t{{.Status}}'

echo "== 3/4 surfpool + kora + proxy (WSL) =="
if proxy_up; then
  echo "  already serving on :8899"
else
  wsl.exe -d Ubuntu -- bash "$W/wsl-surfpool-daemon.sh" >/dev/null 2>&1
  wsl.exe -d Ubuntu -- bash "$W/wsl-surfpool-proxy-up.sh" >/dev/null 2>&1
  proxy_up && echo "  serving on :8899" || echo "  surfpool not answering - run: bash scripts/surfpool.sh restart"
fi
# Restarts so far and how many accounts would be restored after the next one.
curl -s --max-time 5 http://127.0.0.1:8899/__proxy/status | sed 's/^/  /'
echo

echo "== 4/4 dashboard check =="
node scripts/dashboard-check.mjs > /tmp/sdp-dashboard-check.txt 2>&1
rc=$?
grep -E 'FAIL|checks passed' /tmp/sdp-dashboard-check.txt
echo
echo "dashboard: http://localhost:3002"
exit $rc
