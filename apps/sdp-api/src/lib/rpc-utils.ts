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
 * Query the number of token accounts (holders) for a given mint.
 *
 * Uses `getProgramAccounts` with a `dataSize` filter for the Token program
 * and a `memcmp` filter on the mint address. This is expensive on mainnet;
 * devnet is manageable.
 *
 * @param rpcUrl - The RPC endpoint URL.
 * @param mint - The mint address (base58).
 * @returns The number of token accounts holding this mint.
 */
export async function getHolderCount(
  rpcUrl: string,
  mint: string,
): Promise<number> {
  // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

  const result = (await rpcCall(rpcUrl, "getProgramAccounts", [
    TOKEN_PROGRAM_ID,
    {
      encoding: "base64",
      filters: [
        { dataSize: 165 }, // Token account size
        {
          memcmp: {
            offset: 0, // Mint address starts at offset 0
            bytes: mint,
          },
        },
      ],
    },
  ])) as Array<unknown>;

  return Array.isArray(result) ? result.length : 0;
}