#!/usr/bin/env node
/**
 * Solana RPC token query script.
 * Usage:  node scripts/query-token-rpc.mjs [mint-address]
 *
 * Queries a Solana devnet token for:
 *   - Total supply
 *   - Largest holders
 *   - Recent transaction signatures
 *   - Token account (holder) count
 *
 * Default: USDC devnet (Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr)
 */

const RPC = "https://api.devnet.solana.com";
const DEFAULT_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";

let id = 1;

async function rpc(method, params = [], retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      });
      const json = await res.json();
      if (json.error) {
        if (json.error.message?.includes("Too many requests") && i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
          continue;
        }
        throw new Error(json.error.message);
      }
      return json.result;
    } catch (e) {
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

async function main() {
  const mint = process.argv[2] || DEFAULT_MINT;
  console.log(`\n=== Solana Devnet RPC Token Query ===`);
  console.log(`Mint: ${mint}\n`);

  // 1. Supply
  console.log("1. Supply...");
  const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  const p = info?.value?.data?.parsed?.info;
  if (p) {
    const supply = Number(p.supply) / 10 ** p.decimals;
    console.log(`   Decimals:   ${p.decimals}`);
    console.log(`   Supply:     ${supply.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }

  // 2. Largest holders
  console.log("\n2. Largest holders...");
  await new Promise(r => setTimeout(r, 500));
  try {
    const largest = await rpc("getTokenLargestAccounts", [mint]);
    (largest.value || []).slice(0, 5).forEach((a, i) => {
      console.log(`   [${i + 1}] ${a.address.slice(0, 12)}...  ${Number(a.uiAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    });
  } catch (e) {
    console.log(`   Skipped: ${e.message}`);
  }

  // 3. Recent signatures
  console.log("\n3. Recent transaction signatures...");
  await new Promise(r => setTimeout(r, 500));
  try {
    const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 5 }]);
    console.log(`   Found: ${sigs.length} sigs`);
    sigs.slice(0, 3).forEach(s => console.log(`   ${s.signature.slice(0, 20)}...  slot=${s.slot}`));
  } catch (e) {
    console.log(`   ${e.message}`);
  }

  console.log("\n=== Done ===");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
