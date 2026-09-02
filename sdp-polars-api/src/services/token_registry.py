"""Token registry — stable UUIDs for tracked tokens.

Maps token mint addresses to human-readable UUIDs so downstream systems
(Databricks, dashboard, APIs) can reference tokens by a stable identifier
that never changes, even if the underlying mint address does.

The registry is stored in S3 (``token-registry/registry.parquet``) and
loaded on demand.
"""

from __future__ import annotations

import uuid as _uuid
from typing import TYPE_CHECKING, Any

import polars as pl

from src.services.s3_service import key_exists, read_parquet, write_parquet

if TYPE_CHECKING:
    from config import Config


# ── Bootstrap entries ──────────────────────────────────────────────────────
# These are the initial tokens we track. UUIDs are deterministic (v5 from
# the mint address + a namespace) so they're reproducible anywhere.

_REGISTRY_NAMESPACE = _uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")  # DNS namespace


def _uuid_from_mint(mint: str) -> str:
    """Generate a deterministic UUID v5 from a mint address."""
    return str(_uuid.uuid5(_REGISTRY_NAMESPACE, mint))


BOOTSTRAP_TOKENS: list[dict[str, Any]] = [
    # Mainnet stablecoins
    {
        "uuid": _uuid_from_mint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "symbol": "USDC",
        "name": "USD Coin",
        "network": "mainnet",
        "decimals": 6,
    },
    {
        "uuid": _uuid_from_mint("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        "symbol": "USDT",
        "name": "Tether USD",
        "network": "mainnet",
        "decimals": 6,
    },
    {
        "uuid": _uuid_from_mint("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP"),
        "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPXg4gQzNBP",
        "symbol": "PYUSD",
        "name": "PayPal USD",
        "network": "mainnet",
        "decimals": 6,
    },
    # Devnet test tokens
    {
        "uuid": _uuid_from_mint("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr"),
        "mint": "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr",
        "symbol": "USDC_DEV",
        "name": "USD Coin (Devnet)",
        "network": "devnet",
        "decimals": 6,
    },
    {
        "uuid": _uuid_from_mint("9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z"),
        "mint": "9fxDZ7rBCNdHureibbAVa6J73srhCYWoKYZWwegXe72Z",
        "symbol": "PYUSD_DEV",
        "name": "PayPal USD (Devnet)",
        "network": "devnet",
        "decimals": 6,
    },
]


# ── Registry CRUD ──────────────────────────────────────────────────────────


def _s3_key() -> str:
    return "token-registry/registry.parquet"


def load_registry(cfg: Config) -> pl.DataFrame:
    """Load the token registry from S3, falling back to bootstrap."""
    if key_exists(cfg, _s3_key()):
        try:
            return read_parquet(cfg, _s3_key())
        except Exception:
            pass
    # Bootstrap and persist
    df = pl.DataFrame(BOOTSTRAP_TOKENS)
    write_parquet(cfg, _s3_key(), df)
    return df


def get_all_tokens(cfg: Config) -> list[dict]:
    """Return all registered tokens as dicts."""
    df = load_registry(cfg)
    return df.to_dicts()


def get_token_by_uuid(cfg: Config, token_uuid: str) -> dict | None:
    """Look up a token by its UUID."""
    df = load_registry(cfg)
    filtered = df.filter(pl.col("uuid") == token_uuid)
    if filtered.is_empty():
        return None
    return filtered.to_dicts()[0]


def get_token_by_mint(cfg: Config, mint: str) -> dict | None:
    """Look up a token by its mint address."""
    df = load_registry(cfg)
    filtered = df.filter(pl.col("mint") == mint)
    if filtered.is_empty():
        return None
    return filtered.to_dicts()[0]


def register_token(cfg: Config, mint: str, symbol: str, name: str = "", network: str = "devnet", decimals: int = 6) -> dict:
    """Register a new token, generating a deterministic UUID."""
    existing = get_token_by_mint(cfg, mint)
    if existing:
        return existing

    token = {
        "uuid": _uuid_from_mint(mint),
        "mint": mint,
        "symbol": symbol,
        "name": name or symbol,
        "network": network,
        "decimals": decimals,
    }
    df = load_registry(cfg)
    new_row = pl.DataFrame([token])
    combined = pl.concat([df, new_row], how="vertical_relaxed")
    write_parquet(cfg, _s3_key(), combined)
    return token
