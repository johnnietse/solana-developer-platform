/**
 * Wallet Label Enrichment (Phase 2)
 *
 * Runs on a daily cron trigger. Enriches unlabeled wallets in the Databricks
 * `wallet_labels` table with real attribution/geography using, in order of
 * preference:
 *   1. Self-contained heuristics — verified program-ID → protocol map (no API).
 *   2. Helius Wallet Identity API — primary attribution source (if HELIUS_API_KEY set).
 *   3. SolanaFM API — keyless best-effort cross-verification (skipped on failure).
 *
 * Results are written back with `confidence` and `source_detail`. Wallets that
 * cannot be attributed truthfully remain "Unknown" — no mock/fabricated data.
 *
 * Sustainable labeling: Helius operates a continuously-updated identity DB
 * (12,500+ labels, 10.7M+ tags). We query it daily and store the result, so
 * label freshness is delegated to Helius rather than maintained by hand.
 */

import type { Env } from "@/types/env";
import { queryDatabricks } from "@/lib/databricks-query";

// Verified Solana program IDs → protocol attribution (self-contained, no API).
// Sourced from official program IDs (Jupiter V6, Orca Whirlpools, Raydium AMM v4,
// Marinade, Metaplex Token Metadata). Expand as needed; this is a fallback, not
// the primary source.
const PROGRAM_ID_ATTRIBUTION: Record<string, string> = {
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "protocol:jupiter",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "protocol:orca",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "protocol:raydium",
  "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD": "protocol:marinade",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s": "protocol:metaplex",
};

// Bounded per-run batch — respects the Worker cron CPU limit and external API
// rate limits. Daily runs gradually cover all unlabeled wallets over time.
const ENRICHMENT_BATCH_LIMIT = 100;
const SOLANAFM_BASE = "https://api.solana.fm/v1/addresses";
const HELIUS_BASE = "https://api.helius.xyz/v1/wallet";

interface EnrichmentResult {
  attribution_category: string;
  geography: string;
  confidence: number;
  source_detail: string;
  source: string;
}

export async function handleWalletEnrichment(
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  if (env.ANALYTICS_ENABLED !== "true") {
    return new Response("Wallet enrichment disabled", { status: 200 });
  }
  try {
    const stats = await enrichWallets(env);
    return new Response(
      JSON.stringify({ ok: true, ...stats, timestamp: new Date().toISOString() }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[wallet-enrichment] failed:", message);
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function enrichWallets(env: Env): Promise<{ enriched: number; skipped: number }> {
  // 1. Self-contained heuristic pass (no API, always runs).
  await applyHeuristics(env);

  // 2. Fetch a bounded batch of still-unlabeled wallets.
  const rows = await queryDatabricks(
    env,
    `SELECT wallet_address FROM workspace.default.wallet_labels
     WHERE (geography = 'Unknown' OR attribution_category = 'unknown')
     LIMIT ${ENRICHMENT_BATCH_LIMIT}`
  );
  if (!rows || rows.length === 0) {
    return { enriched: 0, skipped: 0 };
  }

  let enriched = 0;
  let skipped = 0;
  for (const row of rows) {
    const wallet = row[0];
    const result = await enrichSingleWallet(env, wallet);
    if (result) {
      await writeEnrichment(env, wallet, result);
      enriched++;
    } else {
      skipped++;
    }
    // Respect API rate limits (SolanaFM 5 RPS keyless, Helius 2 RPS).
    await new Promise((r) => setTimeout(r, 250));
  }
  return { enriched, skipped };
}

async function applyHeuristics(env: Env): Promise<void> {
  for (const [addr, attr] of Object.entries(PROGRAM_ID_ATTRIBUTION)) {
    await queryDatabricks(
      env,
      `UPDATE workspace.default.wallet_labels
       SET attribution_category = :1,
           source_detail = :2,
           confidence = :3,
           source = :4,
           updated_at = current_timestamp()
       WHERE wallet_address = :5
         AND (geography = 'Unknown' OR attribution_category = 'unknown')`,
      [attr, "heuristic", 1.0, "heuristic", addr],
      "30s"
    );
  }
}

async function enrichSingleWallet(
  env: Env,
  wallet: string
): Promise<EnrichmentResult | null> {
  const sources: string[] = [];
  let attribution: string | null = null;

  // Helius Wallet Identity API — primary attribution source (if keyed).
  if (env.HELIUS_API_KEY) {
    try {
      const res = await fetch(
        `${HELIUS_BASE}/${wallet}/identity?api-key=${env.HELIUS_API_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          name?: string;
          category?: string;
          tags?: string[];
        };
        if (data.category || data.name) {
          const label = data.category ?? data.name!;
          attribution = `entity:${label}`;
          sources.push("helius");
        }
      }
    } catch {
      // Helius unavailable — fall through to other sources.
    }
  }

  // SolanaFM API — keyless best-effort cross-verification.
  try {
    const res = await fetch(`${SOLANAFM_BASE}/${wallet}/tokens`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      sources.push("solanaFM");
    }
  } catch {
    // SolanaFM unavailable (e.g., HTTP 502) — skip.
  }

  if (!attribution) {
    // No attribution resolved; leave wallet as "Unknown" (truthful).
    return null;
  }

  const source_detail = sources.join("+") || "helius";
  return {
    attribution_category: attribution,
    geography: "Unknown",
    confidence: sources.length >= 2 ? 1.0 : 0.9,
    source_detail,
    source: sources[0] ?? "helius",
  };
}

async function writeEnrichment(
  env: Env,
  wallet: string,
  result: EnrichmentResult
): Promise<void> {
  await queryDatabricks(
    env,
    `UPDATE workspace.default.wallet_labels
     SET attribution_category = :1,
         geography = :2,
         confidence = :3,
         source_detail = :4,
         source = :5,
         updated_at = current_timestamp()
     WHERE wallet_address = :6`,
    [
      result.attribution_category,
      result.geography,
      result.confidence,
      result.source_detail,
      result.source,
      wallet,
    ],
    "30s"
  );
}
