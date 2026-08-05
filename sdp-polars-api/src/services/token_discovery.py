"""Dynamic token discovery via getProgramAccounts on the SPL Token program."""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.error import HTTPError

from src.services.solana_rpc import _call

if TYPE_CHECKING:
    from config import Config

SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
MINT_ACCOUNT_SIZE = 82  # Mint accounts are exactly 82 bytes

def _get_fallback_mints(cfg: Config) -> dict[str, tuple[str, int]]:
    """Parse fallback mints from config."""
    mints = {}
    if cfg.fallback_mints:
        for entry in cfg.fallback_mints.split(","):
            parts = entry.strip().split(":")
            if len(parts) == 3:
                mints[parts[0]] = (parts[1], int(parts[2]))
    return mints


def _fallback_mints(cfg: Config) -> list[dict]:
    """Return the fallback mint list when getProgramAccounts is unavailable."""
    return [
        {
            "mint": addr,
            "decimals": dec,
            "supply": "0",
            "slot": 0,
            "mint_authority": None,
        }
        for addr, (_, dec) in _get_fallback_mints(cfg).items()
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
        return _fallback_mints(cfg)

    accounts = resp.get("result", [])
    if not accounts:
        print("[token_discovery] No accounts returned, using fallback mints")
        return _fallback_mints(cfg)

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

    Uses fallback mints from config as the symbol registry; unknown mints get
    a shortened address like ``AbCd...WxYz``.
    """
    entry = _get_fallback_mints(cfg).get(mint)
    if entry:
        return entry[0]
    return f"{mint[:4]}...{mint[-4:]}"
