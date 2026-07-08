#!/usr/bin/env python3
"""
Solana RPC token query script.
Usage:  python scripts/query-token-rpc.py [mint-address]

Queries a Solana devnet token for:
  - Total supply
  - Largest holders
  - Recent transaction signatures
  - Token account (holder) count

Default: USDC devnet (Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr)
"""

import json
import sys
import time
import urllib.request

RPC = "https://api.devnet.solana.com"
DEFAULT_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"


def rpc(method, params=None, retries=3):
    params = params or []
    for attempt in range(retries):
        try:
            payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
            req = urllib.request.Request(RPC, data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode())
            if "error" in result:
                msg = result["error"].get("message", "")
                if "Too many requests" in msg and attempt < retries - 1:
                    time.sleep(1 * (attempt + 1))
                    continue
                raise RuntimeError(msg)
            return result["result"]
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1 * (attempt + 1))
                continue
            raise


def main():
    mint = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MINT
    print(f"\n=== Solana Devnet RPC Token Query ===")
    print(f"Mint: {mint}\n")

    # 1. Supply
    print("1. Supply...")
    info = rpc("getAccountInfo", [mint, {"encoding": "jsonParsed"}])
    p = info["value"]["data"]["parsed"]["info"]
    supply = int(p["supply"]) / 10 ** p["decimals"]
    print(f"   Decimals:   {p['decimals']}")
    print(f"   Supply:     {supply:,.2f}")

    # 2. Largest holders
    print("\n2. Largest holders...")
    time.sleep(0.5)
    try:
        largest = rpc("getTokenLargestAccounts", [mint])
        for i, a in enumerate(largest.get("value", [])[:5]):
            bal = float(a.get("uiAmount", 0))
            print(f"   [{i+1}] {a['address'][:12]}...  {bal:,.2f}")
    except Exception as e:
        print(f"   Skipped: {e}")

    # 3. Recent signatures
    print("\n3. Recent transaction signatures...")
    time.sleep(0.5)
    try:
        sigs = rpc("getSignaturesForAddress", [mint, {"limit": 5}])
        print(f"   Found: {len(sigs)} sigs")
        for s in sigs[:3]:
            print(f"   {s['signature'][:20]}...  slot={s['slot']}")
    except Exception as e:
        print(f"   {e}")

    print("\n=== Done ===")


if __name__ == "__main__":
    main()
