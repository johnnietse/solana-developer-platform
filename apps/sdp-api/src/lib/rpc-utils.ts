/**
 * Shared RPC utility functions for querying Solana JSON-RPC endpoints.
 *
 * Provides generic and typed helpers used by analytics and other data-product
 * handlers. All functions target standard Solana RPC methods.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Generic RPC Caller
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a JSON-RPC call against a Solana RPC endpoint.
 *
 * @param url - The RPC endpoint URL.
 * @param method - The JSON-RPC method name (e.g. "getTokenSupply").
 * @param params - Array of parameters to pass to the method.
 * @returns The `result` field from the RPC response.
 * @throws If the HTTP request fails or the RPC returns an error.
 */
export async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `rpc-${Date.now()}`,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `RPC ${method} failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };

  if (body.error) {
    throw new Error(`RPC ${method} error: ${body.error.message}`);
  }

  return body.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Supply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the total supply of a token mint from the RPC.
 *
 * @param rpcUrl - The RPC endpoint URL.
 * @param mint - The mint address (base58).
 * @returns An object with the raw `amount` string and `decimals`.
 */
export async function getTokenSupply(
  rpcUrl: string,
  mint: string,
): Promise<{ amount: string; decimals: number }> {
  const result = (await rpcCall(rpcUrl, "getTokenSupply", [
    mint,
  ])) as { value: { amount: string; decimals: number } };

  return result.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Holder Count
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query the number of holders (token accounts with a non-zero balance) for a
 * given mint.
 *
 * Searches both the legacy Token program and Token-2022. Tokens issued by the
 * platform are Token-2022, whose accounts carry extensions and are larger
 * than 165 bytes, so the old `dataSize: 165` filter on the legacy program
 * alone counted zero holders for every platform token. The mint sits at
 * offset 0 and the u64 amount at offset 64 in both layouts; only those 8
 * amount bytes are fetched. This is expensive on mainnet; devnet and local
 * validators are manageable.
 *
 * @param rpcUrl - The RPC endpoint URL.
 * @param mint - The mint address (base58).
 * @returns The number of token accounts holding a positive balance of this mint.
 */
export async function getHolderCount(
  rpcUrl: string,
  mint: string,
): Promise<number> {
  const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  const countFor = async (programId: string, sizeFilter: object[]): Promise<number> => {
    const result = (await rpcCall(rpcUrl, "getProgramAccounts", [
      programId,
      {
        encoding: "base64",
        dataSlice: { offset: 64, length: 8 },
        filters: [...sizeFilter, { memcmp: { offset: 0, bytes: mint } }],
      },
    ])) as Array<{ account?: { data?: [string, string] } }>;
    if (!Array.isArray(result)) return 0;
    return result.filter((entry) => {
      const raw = entry.account?.data?.[0];
      if (!raw) return false;
      // atob rather than Buffer: this module also runs on Workers.
      return [...atob(raw)].some((ch) => ch.charCodeAt(0) !== 0);
    }).length;
  };

  // Token-2022 account sizes vary with extensions; a Token-2022 mint account
  // never has the mint's own address at offset 0, so the memcmp alone is
  // enough to exclude it.
  const [legacy, token2022] = await Promise.all([
    countFor(TOKEN_PROGRAM_ID, [{ dataSize: 165 }]),
    countFor(TOKEN_2022_PROGRAM_ID, []),
  ]);
  return legacy + token2022;
}