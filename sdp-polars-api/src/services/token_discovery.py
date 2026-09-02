"""Dynamic token discovery via getProgramAccounts on the SPL Token program."""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.error import HTTPError

from src.services.solana_rpc import _call

if TYPE_CHECKING:
    from config import Config

SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MINT_ACCOUNT_SIZE = 82  # Mint accounts are exactly 82 bytes

# ── Fallback mints ──────────────────────────────────────────────────────────
# Used when getProgramAccounts is unavailable (e.g., public devnet RPC returns
# 403 for heavy queries).  Keyed by mint address; values are (symbol, decimals).
FALLBACK_MINTS: dict[str, tuple[str, int]] = {
    # Devnet tokens that actually exist on devnet
    # (mainnet addresses removed — they always return 0 on devnet)
    "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": ("USDC", 6),
    "9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z": ("PYUSD", 6),
}


def _fallback_mints() -> list[dict]:
    """Return the fallback mint list when getProgramAccounts is unavailable."""
    return [
        {
            "mint": addr,
            "decimals": dec,
            "supply": "0",
            "slot": 0,
            "mint_authority": None,
        }
        for addr, (_, dec) in FALLBACK_MINTS.items()
    ]


def discover_token_mints(cfg: Config) -> list[dict]:
    """Discover all SPL token mints by querying getProgramAccounts with a data-size filter.

    Falls back to ``FALLBACK_MINTS`` when the RPC does not support
    getProgramAccounts (common on public devnet endpoints).

    Returns a list of dicts with keys: mint, decimals, supply, slot, mint_authority
    Never returns an empty list (falls back to known mints).
    """
    try:
        resp = _call(
            cfg,
            "getProgramAccounts",
            [
                SPL_TOKEN_PROGRAM,
                {
                    "encoding": "jsonParsed",
                    "filters": [{"dataSize": MINT_ACCOUNT_SIZE}],
                },
            ],
        )
    except (HTTPError, Exception) as exc:
        print(f"[token_discovery] getProgramAccounts unavailable ({exc}), using fallback mints")
        return _fallback_mints()

    accounts = resp.get("result", [])
    if not accounts:
        print("[token_discovery] No accounts returned, using fallback mints")
        return _fallback_mints()

    mints = []
    for acc in accounts:
        try:
            account_data = acc.get("account", {})
            parsed = account_data.get("data", {}).get("parsed", {})
            info = parsed.get("info", {})
            mint_addr = acc.get("pubkey", "")
            if not mint_addr:
                continue
            decimals = info.get("decimals", 0)
            supply = info.get("supply", "0")
            mint_authority = info.get("mintAuthority", None)
            mints.append({
                "mint": mint_addr,
                "decimals": decimals,
                "supply": supply,
                "slot": account_data.get("slot", 0),
                "mint_authority": mint_authority,
            })
        except Exception as exc:
            print(f"[token_discovery] Failed to parse account: {exc}")
            continue

    print(f"[token_discovery] Found {len(mints)} token mints (via getProgramAccounts)")
    return mints


def resolve_token_symbol(cfg: Config, mint: str) -> str:
    """Resolve a human-readable symbol for a token mint.

    Uses ``FALLBACK_MINTS`` as the symbol registry; unknown mints get
    a shortened address like ``AbCd...WxYz``.
    """
    entry = FALLBACK_MINTS.get(mint)
    if entry:
        return entry[0]
    return f"{mint[:4]}...{mint[-4:]}"
