"""Real-time Solana data ingestion via WebSocket.

Streams slot updates, logs, and program account changes from
wss://api.devnet.solana.com into Delta tables.

Each subscription runs in its own daemon thread with a dedicated
asyncio event loop, using the existing WebSocketConnection class
as designed (async with auto-reconnect).
"""

from __future__ import annotations

import asyncio
import base64
import struct
import threading
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from config import Config

import polars as pl

from src.services.s3_service import write_delta
from src.websocket.connection import WebSocketConnection, WebSocketConfig

SOLANA_WS_URL = "wss://api.devnet.solana.com"
EVENTS_TABLE = "events"

# Buffer events and flush in batches — high-frequency WebSocket data would
# otherwise hammer S3 with tiny Delta appends (and trip S3 consistency races).
_EVENT_BUFFER: list[dict[str, Any]] = []
_EVENT_BUFFER_LOCK = threading.Lock()
_EVENT_FLUSH_INTERVAL = 5.0  # seconds
_EVENT_FLUSH_MAX = 100  # rows

# ── WebSocket-based holder accumulator ──────────────────────────────────
# Tracks token holder balances from real-time programSubscribe notifications.
# Each token account update contains (mint, owner, balance). We aggregate
# by (mint, owner) across all token accounts in memory.
#
# On devnet this populates with whatever tokens are actively transferring.
# On mainnet with real stablecoins, it tracks their holders directly.
# Used as a fallback when RPC getTokenLargestAccounts is unavailable.
_HOLDER_ACCUMULATOR: dict[str, tuple[str, str, int]] = {}  # account_pubkey -> (mint, owner, raw_balance)
_HOLDER_ACCUMULATOR_LOCK = threading.Lock()

# Base58 alphabet for Solana addresses (same as Bitcoin, minus 0/O/I/l)
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _bytes_to_base58(b: bytes) -> str:
    """Convert 32-byte Ed25519 public key to base58 Solana address."""
    n = int.from_bytes(b, "big")
    if n == 0:
        return _BASE58_ALPHABET[0]
    res: list[str] = []
    while n > 0:
        n, r = divmod(n, 58)
        res.append(_BASE58_ALPHABET[r])
    return "".join(reversed(res))


def _update_holder(account_pubkey: str, mint: str, owner: str, balance: int) -> None:
    """Update the in-memory holder accumulator with a single token account."""
    with _HOLDER_ACCUMULATOR_LOCK:
        if balance > 0:
            _HOLDER_ACCUMULATOR[account_pubkey] = (mint, owner, balance)
        else:
            _HOLDER_ACCUMULATOR.pop(account_pubkey, None)


def snapshot_holders(mints_of_interest: set[str] | None = None) -> pl.DataFrame:
    """Snapshot current holder data from the WebSocket accumulator.

    Returns the top 20 holders by balance for each tracked mint.
    If *mints_of_interest* is provided, only those mints are included.
    """
    with _HOLDER_ACCUMULATOR_LOCK:
        snapshot = dict(_HOLDER_ACCUMULATOR)

    # Aggregate by (mint, owner) across all token accounts
    owner_balances: dict[tuple[str, str], int] = {}
    for mint, owner, bal in snapshot.values():
        if mints_of_interest is not None and mint not in mints_of_interest:
            continue
        key = (mint, owner)
        owner_balances[key] = owner_balances.get(key, 0) + bal

    active_mints = set(m for m, _, _ in snapshot.values())

    if not owner_balances:
        print(f"[ws_ingestion] snapshot_holders: {len(snapshot)} accounts across "
              f"{len(active_mints)} mints, 0 match requested mints")
        return pl.DataFrame()

    print(f"[ws_ingestion] snapshot_holders: {len(owner_balances)} holder entries "
          f"across {len(set(k[0] for k in owner_balances))} mints")

    from src.services.token_discovery import FALLBACK_MINTS

    now_iso = datetime.now(timezone.utc).isoformat()
    records: list[dict[str, Any]] = []
    for (mint, owner), total_balance in owner_balances.items():
        decimals = 0
        entry = FALLBACK_MINTS.get(mint)
        if entry:
            decimals = entry[1]
        ui_amount = total_balance / (10 ** decimals) if decimals else float(total_balance)
        records.append({
            "mint": mint,
            "holder_address": owner,
            "amount": total_balance,
            "decimals": decimals,
            "ui_amount": ui_amount,
            "scraped_at": now_iso,
        })

    df = pl.DataFrame(records)
    df = df.sort("amount", descending=True)
    df = df.with_columns(
        pl.col("amount").rank("ordinal", descending=True).over("mint").cast(pl.Int64).alias("rank")
    )
    # Limit to top 20 per mint
    df = df.filter(pl.col("rank") <= 20)
    return df


def _write_event(cfg: Config, event_type: str, **fields: Any) -> None:
    """Buffer a single event row for batched Delta write.

    All event types share one schema so the Delta table stays consistent:
    ``event_type, slot, signature, log_count, pubkey, received_at``.
    Fields not applicable to a given event type are written as null/empty.
    """
    row = {
        "event_type": event_type,
        "slot": fields.get("slot", 0),
        "signature": fields.get("signature", ""),
        "log_count": fields.get("log_count", 0),
        "pubkey": fields.get("pubkey", ""),
        "received_at": datetime.now(timezone.utc).isoformat(),
    }
    with _EVENT_BUFFER_LOCK:
        _EVENT_BUFFER.append(row)
        if len(_EVENT_BUFFER) >= _EVENT_FLUSH_MAX:
            _flush_events(cfg)


def _flush_events(cfg: Config) -> None:
    """Flush buffered events to the Delta table in one append."""
    with _EVENT_BUFFER_LOCK:
        if not _EVENT_BUFFER:
            return
        batch = _EVENT_BUFFER.copy()
        _EVENT_BUFFER.clear()

    df = pl.DataFrame(batch)
    try:
        write_delta(cfg, EVENTS_TABLE, df, mode="append")
    except Exception as exc:
        print(f"[ws_ingestion] write_delta failed: {exc}")


def _start_flush_timer(cfg: Config) -> None:
    """Periodically flush the event buffer from a background thread."""
    def _tick():
        while True:
            _flush_events(cfg)
            threading.Event().wait(_EVENT_FLUSH_INTERVAL)

    t = threading.Thread(target=_tick, daemon=True, name="ws-flush")
    t.start()


async def _on_slot(data: dict[str, Any], cfg: Config) -> None:
    """Handle slot notification - write to Delta.

    ``data`` is ``params["result"]`` from the WebSocket notification
    (the connection manager passes the inner result object to callbacks).
    Solana slot notification shape: ``{"parent": int, "root": int, "slot": int}``
    """
    try:
        slot = data.get("slot", 0)
        if not slot:
            return
        _write_event(cfg, "slot", slot=slot)
    except Exception as exc:
        print(f"[ws_ingestion] slot handler error: {exc}")


async def _on_logs(data: dict[str, Any], cfg: Config) -> None:
    """Handle logs notification - check for token transfers.

    ``data`` is ``params["result"]`` from the WebSocket notification.
    Solana logs notification shape: ``{"value": {"signature": str, "logs": [str]}}``
    """
    try:
        value = data.get("value", {})
        sig = value.get("signature", "")
        logs = value.get("logs", [])
        if not sig or not logs:
            return
        _write_event(cfg, "logs", signature=sig, log_count=len(logs))
        print(f"[ws_ingestion] Logs: {sig[:16]}...")
    except Exception as exc:
        print(f"[ws_ingestion] logs handler error: {exc}")


async def _on_program(data: dict[str, Any], cfg: Config) -> None:
    """Handle program account change — parse token account and track holders.

    ``data`` is ``params["result"]`` from the WebSocket notification.
    Solana program notification shape:
    ``{"value": {"pubkey": str, "account": {"data": {...} | [...], ...}}}``

    The account data may arrive as ``jsonParsed`` (preferred — includes mint,
    owner, balance directly) or ``base64`` (fallback — raw 165-byte token
    account layout that we decode manually).
    """
    try:
        value = data.get("value", {})
        pubkey = value.get("pubkey", "")
        if not pubkey:
            return

        # Always write the event for the events Delta table
        _write_event(cfg, "program", pubkey=pubkey)

        # Parse account data to extract mint, owner, balance
        account = value.get("account", {})
        raw_data = account.get("data")
        if not raw_data:
            return

        mint: str | None = None
        owner: str | None = None
        raw_balance: int = 0

        # ── jsonParsed format (structured, no manual decoding) ──
        if isinstance(raw_data, dict):
            parsed = raw_data.get("parsed", {})
            info = parsed.get("info", {})
            mint = info.get("mint")
            owner = info.get("owner")
            token_amount = info.get("tokenAmount", {})
            raw_balance = int(token_amount.get("amount", "0"))

        # ── base64 format (raw 165-byte token account layout) ──
        elif isinstance(raw_data, (list, tuple)) and len(raw_data) >= 2:
            decoded = base64.b64decode(raw_data[0])
            if len(decoded) >= 72:
                mint = _bytes_to_base58(decoded[0:32])
                owner = _bytes_to_base58(decoded[32:64])
                raw_balance = struct.unpack('<Q', decoded[64:72])[0]

        if mint and owner:
            _update_holder(pubkey, mint, owner, raw_balance)

    except Exception as exc:
        print(f"[ws_ingestion] program handler error: {exc}")


def _start_single_subscription(
    cfg: Config,
    name: str,
    method: str,
    params: list[Any],
    handler: Callable[[dict[str, Any], Config], None],
) -> None:
    """Run one WebSocket subscription in a daemon thread with its own asyncio loop.

    Uses ``asyncio.run()`` to create a fresh event loop inside the thread,
    connecting, subscribing, and then keeping the loop alive indefinitely.
    """
    async def _run():
        conn = WebSocketConnection(WebSocketConfig(url=SOLANA_WS_URL))
        try:
            await conn.connect()
            await conn.subscribe(method, params, lambda d: handler(d, cfg))
            print(f"[ws_ingestion] Subscribed to {method}")
        except Exception as exc:
            print(f"[ws_ingestion] Failed to subscribe to {method}: {exc}")
            return

        # Keep the event loop alive — _listen/_reconnect run as background tasks
        await asyncio.get_running_loop().create_future()

    thread = threading.Thread(target=lambda: asyncio.run(_run()), daemon=True, name=f"ws-{name}")
    thread.start()
    print(f"[ws_ingestion] Started {name} thread")


def start_ws_listeners(cfg: Config) -> None:
    """Start WebSocket listeners in background threads.

    Creates three daemon threads, each with its own asyncio event loop:
      1. slotSubscribe — slot notifications
      2. logsSubscribe — log messages mentioning the SPL Token program
      3. programSubscribe — token program account changes
    """
    subscriptions = [
        ("slot", "slotSubscribe", [], _on_slot),
        (
            "logs",
            "logsSubscribe",
            [{"mentions": ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]}],
            _on_logs,
        ),
        (
            "program",
            "programSubscribe",
            [
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                {
                    "encoding": "jsonParsed",
                    "filters": [{"dataSize": 165}],
                },
            ],
            _on_program,
        ),
    ]

    for name, method, params, handler in subscriptions:
        _start_single_subscription(cfg, name, method, params, handler)

    # Start the periodic flush timer for buffered events
    _start_flush_timer(cfg)

    print(f"[ws_ingestion] All WebSocket listeners started")
