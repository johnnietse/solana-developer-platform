#!/usr/bin/env bash
# Set up Surfpool + Kora inside WSL.
#
# Surfpool publishes no Windows build - its npm package declares only
# darwin-x64, darwin-arm64 and linux-x64-gnu, so importing it on Windows throws
# "Cannot find module @solana/surfpool-win32-x64-msvc". Linux is the only way to
# run it on this machine, which is also why CI runs these jobs on ubuntu-latest.
#
# The repo is cloned into the Linux filesystem rather than used from /mnt/c.
# Both platforms would otherwise share one node_modules, and native modules are
# built per platform - installing here would break the Windows stack.
set -euo pipefail

SRC=/mnt/c/Users/Johnnie/Documents/MLH_Fellowship_2026
DST=/home/ohnnie/sdp
BRANCH=merged-api

echo "== clone =="
if [ -d "$DST/.git" ]; then
  echo "already present at $DST"
else
  rm -rf "$DST"
  git -c safe.directory='*' clone --branch "$BRANCH" "file://$SRC" "$DST"
fi

cd "$DST"
echo "branch : $(git rev-parse --abbrev-ref HEAD)"
echo "head   : $(git log --oneline -1)"

# .env is gitignored, so the clone does not carry it. The stack needs the Clerk
# keys and Databricks settings from it.
if [ -f "$SRC/.env" ] && [ ! -f "$DST/.env" ]; then
  cp "$SRC/.env" "$DST/.env"
  echo "env    : copied from the Windows checkout"
fi

echo
echo "== toolchain =="
echo "node   : $(node --version)"
echo "pnpm   : $(/home/ohnnie/.local/bin/pnpm --version)"

echo
echo "== install (integration package only) =="
export PATH="/home/ohnnie/.local/bin:$PATH"
pnpm install --filter @sdp/api-integration 2>&1 | tail -6

echo
echo "== does surfpool load on linux? =="
cd "$DST/packages/sdp-api-integration"
node -e "
import('@solana/surfpool')
  .then((m) => {
    console.log('  surfpool imported OK');
    console.log('  exports:', Object.keys(m).slice(0, 6).join(', '));
  })
  .catch((e) => {
    console.log('  IMPORT FAILED:', e.message.split('\n')[0]);
    process.exit(1);
  });
"
