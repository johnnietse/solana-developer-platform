#!/usr/bin/env node
/**
 * Fetch USDC holders from Solana devnet and output as JSON.
 * Usage: node scripts/fetch-holders.mjs > holders.json
 */
const RPC = "https://api.devnet.solana.com";
const USDC_MINT = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let id = 1;
async function rpcCall(method, params = [], retries = 3) {
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
  console.error("Fetching holders...");
  const accounts = await rpcCall("getProgramAccounts", [
    TOKEN_PROGRAM_ID,
    { encoding: "jsonParsed", filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: USDC_MINT } }] },
  ]);

  const holders = (accounts || []).map(acct => {
    const info = acct.account?.data?.parsed?.info;
    return {
      walletAddress: info?.owner || acct.pubkey,
      balance: info?.tokenAmount?.uiAmount || 0,
    };
  });

  console.error(`Found ${holders.length} holders`);
  process.stdout.write(JSON.stringify(holders));
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });