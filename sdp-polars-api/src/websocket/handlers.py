"""WebSocket subscription handlers for Solana RPC methods."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional, Union
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Union

from .connection import WebSocketConnection, WebSocketConfig, SubscriptionManager, subscription_manager

logger = logging.getLogger(__name__)


class CommitmentLevel(str, Enum):
    """Solana commitment levels."""
    PROCESSED = "processed"
    CONFIRMED = "confirmed"
    FINALIZED = "finalized"


class Encoding(str, Enum):
    """Account data encoding formats."""
    JSON = "json"
    JSON_PARSED = "jsonParsed"
    BASE58 = "base58"
    BASE64 = "base64"
    BASE64_ZSTD = "base64+zstd"


@dataclass
class AccountSubscribeParams:
    """Parameters for accountSubscribe."""
    pubkey: str
    commitment: Optional[CommitmentLevel] = None
    encoding: Optional[Encoding] = None


@dataclass
class AccountNotification:
    """Account notification payload."""
    context: Dict
    value: Dict


@dataclass
class SignatureSubscribeParams:
    """Parameters for signatureSubscribe."""
    signature: str
    commitment: Optional[CommitmentLevel] = None
    enable_received_notification: bool = False


@dataclass
class SignatureNotification:
    """Signature notification payload."""
    context: Dict
    value: Dict


@dataclass
class LogsSubscribeParams:
    """Parameters for logsSubscribe."""
    filter: Union[Dict, str]  # "all", "allWithVotes", or {"mentions": [pubkey]}
    commitment: Optional[CommitmentLevel] = None


@dataclass
class LogsNotification:
    """Logs notification payload."""
    context: Dict
    value: Dict


@dataclass
class ProgramSubscribeParams:
    """Parameters for programSubscribe."""
    program_id: str
    commitment: Optional[CommitmentLevel] = None
    encoding: Optional[Encoding] = None
    filters: Optional[List[Dict]] = None


@dataclass
class ProgramNotification:
    """Program notification payload."""
    context: Dict
    value: Dict


@dataclass
class BlockSubscribeParams:
    """Parameters for blockSubscribe."""
    commitment: Optional[CommitmentLevel] = None
    encoding: Optional[Encoding] = None
    transaction_details: Optional[str] = None  # "full", "accounts", "signatures", "none"
    show_rewards: bool = False
    max_supported_transaction_version: int = 0


@dataclass
class BlockNotification:
    """Block notification payload."""
    context: Dict
    value: Dict


@dataclass
class SlotSubscribeParams:
    """Parameters for slotSubscribe."""
    commitment: Optional[CommitmentLevel] = None


@dataclass
class SlotNotification:
    """Slot notification payload."""
    context: Dict
    value: Dict


class SubscriptionHandler:
    """Handles WebSocket subscription methods for Solana RPC."""

    def __init__(self, connection: 'WebSocketConnection'):
        self.connection = connection
        self._handlers: Dict[str, Callable] = {
            "accountSubscribe": self._handle_account_subscribe,
            "accountUnsubscribe": self._handle_account_unsubscribe,
            "signatureSubscribe": self._handle_signature_subscribe,
            "signatureUnsubscribe": self._handle_signature_unsubscribe,
            "logsSubscribe": self._handle_logs_subscribe,
            "logsUnsubscribe": self._handle_logs_unsubscribe,
            "programSubscribe": self._handle_program_subscribe,
            "programUnsubscribe": self._handle_program_unsubscribe,
            "blockSubscribe": self._handle_block_subscribe,
            "blockUnsubscribe": self._handle_block_unsubscribe,
            "slotSubscribe": self._handle_slot_subscribe,
            "slotUnsubscribe": self._handle_slot_unsubscribe,
            "slotsUpdatesSubscribe": self._handle_slots_updates_subscribe,
            "slotsUpdatesUnsubscribe": self._handle_slots_updates_unsubscribe,
            "rootSubscribe": self._handle_root_subscribe,
            "rootUnsubscribe": self._handle_root_unsubscribe,
            "voteSubscribe": self._handle_vote_subscribe,
            "voteUnsubscribe": self._handle_vote_unsubscribe,
        }

    async def handle_request(self, method: str, params: List, request_id: int) -> Dict:
        """Handle a subscription request."""
        handler = self._handlers.get(method)
        if not handler:
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }

        try:
            result = await handler(params)
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "result": result
            }
        except Exception as e:
            logger.error(f"Error handling {method}: {e}")
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": -32603,
                    "message": str(e)
                }
            }

    # ============================================================
    # Account Subscriptions
    # ============================================================

    async def _handle_account_subscribe(self, params: List) -> int:
        """Subscribe to account changes."""
        if not params:
            raise ValueError("Missing pubkey parameter")

        pubkey = params[0]
        commitment = params[1].get("commitment") if len(params) > 1 and isinstance(params[1], dict) else None
        encoding = params[1].get("encoding") if len(params) > 1 and isinstance(params[1], dict) else None

        # Validate pubkey format
        if not isinstance(pubkey, str) or len(pubkey) < 32:
            raise ValueError("Invalid pubkey format")

        params_list = [pubkey]
        if commitment or encoding:
            options = {}
            if commitment:
                options["commitment"] = commitment
            if encoding:
                options["encoding"] = encoding
            params_list.append(options)

        return await self.connection.subscribe(
            "accountSubscribe",
            params_list,
            callback=self._handle_account_notification,
        )

    async def _handle_account_notification(self, result: Dict):
        """Handle account notification."""
        logger.debug(f"Account notification: {result}")

    async def _handle_account_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from account notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "accountUnsubscribe")

    # ============================================================
    # Signature Subscriptions
    # ============================================================

    async def _handle_signature_subscribe(self, params: List) -> int:
        """Subscribe to signature status."""
        if not params:
            raise ValueError("Missing signature parameter")

        signature = params[0]
        commitment = params[1].get("commitment") if len(params) > 1 and isinstance(params[1], dict) else None
        enable_received = params[1].get("enableReceivedNotification", False) if len(params) > 1 and isinstance(params[1], dict) else False

        params_list = [signature]
        if commitment or enable_received:
            options = {}
            if commitment:
                options["commitment"] = commitment
            if enable_received:
                options["enableReceivedNotification"] = enable_received
            params_list.append(options)

        return await self.connection.subscribe(
            "signatureSubscribe",
            params_list,
            callback=self._handle_signature_notification,
        )

    async def _handle_signature_notification(self, result: Dict):
        """Handle signature notification."""
        logger.debug(f"Signature notification: {result}")

    async def _handle_signature_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from signature notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "signatureUnsubscribe")

    # ============================================================
    # Logs Subscriptions
    # ============================================================

    async def _handle_logs_subscribe(self, params: List) -> int:
        """Subscribe to transaction logs."""
        if not params:
            raise ValueError("Missing filter parameter")

        filter_param = params[0]
        commitment = params[1].get("commitment") if len(params) > 1 and isinstance(params[1], dict) else None

        # Validate filter
        if isinstance(filter_param, str):
            if filter_param not in ["all", "allWithVotes"]:
                raise ValueError("Invalid filter: must be 'all', 'allWithVotes', or object with 'mentions'")
        elif isinstance(filter_param, dict):
            if "mentions" not in filter_param:
                raise ValueError("Filter object must have 'mentions' field")
        else:
            raise ValueError("Invalid filter format")

        params_list = [filter_param]
        if commitment:
            params_list.append({"commitment": commitment})

        return await self.connection.subscribe(
            "logsSubscribe",
            params_list,
            callback=self._handle_logs_notification,
        )

    async def _handle_logs_notification(self, result: Dict):
        """Handle logs notification."""
        logger.debug(f"Logs notification: {result}")

    async def _handle_logs_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from logs."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "logsUnsubscribe")

    # ============================================================
    # Program Subscriptions
    # ============================================================

    async def _handle_program_subscribe(self, params: List) -> int:
        """Subscribe to program account changes."""
        if not params:
            raise ValueError("Missing program_id parameter")

        program_id = params[0]
        commitment = params[1].get("commitment") if len(params) > 1 and isinstance(params[1], dict) else None
        encoding = params[1].get("encoding") if len(params) > 1 and isinstance(params[1], dict) else None
        filters = params[1].get("filters") if len(params) > 1 and isinstance(params[1], dict) else None

        params_list = [program_id]
        if commitment or encoding or filters:
            options = {}
            if commitment:
                options["commitment"] = commitment
            if encoding:
                options["encoding"] = encoding
            if filters:
                options["filters"] = filters
            params_list.append(options)

        return await self.connection.subscribe(
            "programSubscribe",
            params_list,
            callback=self._handle_program_notification,
        )

    async def _handle_program_notification(self, result: Dict):
        """Handle program notification."""
        logger.debug(f"Program notification: {result}")

    async def _handle_program_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from program notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "programUnsubscribe")

    # ============================================================
    # Block Subscriptions
    # ============================================================

    async def _handle_block_subscribe(self, params: List) -> int:
        """Subscribe to block notifications."""
        commitment = params[0].get("commitment") if params and isinstance(params[0], dict) else None
        encoding = params[0].get("encoding") if params and isinstance(params[0], dict) else None
        transaction_details = params[0].get("transactionDetails") if params and isinstance(params[0], dict) else None
        show_rewards = params[0].get("showRewards", False) if params and isinstance(params[0], dict) else False
        max_supported_version = params[0].get("maxSupportedTransactionVersion", 0) if params and isinstance(params[0], dict) else 0

        params_list = []
        options = {}
        if commitment:
            options["commitment"] = commitment
        if encoding:
            options["encoding"] = encoding
        if transaction_details:
            options["transactionDetails"] = transaction_details
        if show_rewards:
            options["showRewards"] = show_rewards
        if max_supported_version:
            options["maxSupportedTransactionVersion"] = max_supported_version
        if options:
            params_list.append(options)

        return await self.connection.subscribe(
            "blockSubscribe",
            params_list,
            callback=self._handle_block_notification,
        )

    async def _handle_block_notification(self, result: Dict):
        """Handle block notification."""
        logger.debug(f"Block notification: {result}")

    async def _handle_block_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from block notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "blockUnsubscribe")

    # ============================================================
    # Slot Subscriptions
    # ============================================================

    async def _handle_slot_subscribe(self, params: List) -> int:
        """Subscribe to slot notifications."""
        commitment = params[0].get("commitment") if params and isinstance(params[0], dict) else None

        params_list = []
        if commitment:
            params_list.append({"commitment": commitment})

        return await self.connection.subscribe(
            "slotSubscribe",
            params_list,
            callback=self._handle_slot_notification,
        )

    async def _handle_slot_notification(self, result: Dict):
        """Handle slot notification."""
        logger.debug(f"Slot notification: {result}")

    async def _handle_slot_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from slot notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "slotUnsubscribe")

    # ============================================================
    # Slots Updates Subscriptions
    # ============================================================

    async def _handle_slots_updates_subscribe(self, params: List) -> int:
        """Subscribe to slots updates."""
        return await self.connection.subscribe(
            "slotsUpdatesSubscribe",
            [],
            callback=self._handle_slots_updates_notification,
        )

    async def _handle_slots_updates_notification(self, result: Dict):
        """Handle slots updates notification."""
        logger.debug(f"Slots updates notification: {result}")

    async def _handle_slots_updates_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from slots updates."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "slotsUpdatesUnsubscribe")

    # ============================================================
    # Root Subscriptions
    # ============================================================

    async def _handle_root_subscribe(self, params: List) -> int:
        """Subscribe to root notifications."""
        return await self.connection.subscribe(
            "rootSubscribe",
            [],
            callback=self._handle_root_notification,
        )

    async def _handle_root_notification(self, result: Dict):
        """Handle root notification."""
        logger.debug(f"Root notification: {result}")

    async def _handle_root_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from root notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "rootUnsubscribe")

    # ============================================================
    # Vote Subscriptions
    # ============================================================

    async def _handle_vote_subscribe(self, params: List) -> int:
        """Subscribe to vote notifications."""
        commitment = params[0].get("commitment") if params and isinstance(params[0], dict) else None

        params_list = []
        if commitment:
            params_list.append({"commitment": commitment})

        return await self.connection.subscribe(
            "voteSubscribe",
            params_list,
            callback=self._handle_vote_notification,
        )

    async def _handle_vote_notification(self, result: Dict):
        """Handle vote notification."""
        logger.debug(f"Vote notification: {result}")

    async def _handle_vote_unsubscribe(self, params: List) -> bool:
        """Unsubscribe from vote notifications."""
        if not params:
            raise ValueError("Missing subscription id")

        subscription_id = params[0]
        return await self.connection.unsubscribe(subscription_id, "voteUnsubscribe")


# Convenience functions for common subscription patterns

async def subscribe_to_account(
    connection: 'WebSocketConnection',
    pubkey: str,
    callback: Callable,
    commitment: Optional[str] = None,
    encoding: str = "jsonParsed",
) -> int:
    """Subscribe to account changes."""
    params = [pubkey]
    if commitment or encoding:
        options = {}
        if commitment:
            options["commitment"] = commitment
        if commitment:
            options["encoding"] = commitment
        params = [pubkey, options]

    return await connection.subscribe(
        "accountSubscribe",
        [pubkey, {"commitment": commitment, "encoding": encoding}] if commitment else [pubkey],
        callback=None,  # Will be set by caller
    )


async def subscribe_to_signature(
    connection: 'WebSocketConnection',
    signature: str,
    callback: Callable,
    commitment: Optional[str] = None,
    enable_received: bool = False,
) -> int:
    """Subscribe to signature status."""
    params = [signature]
    if commitment or enable_received:
        options = {}
        if commitment:
            options["commitment"] = commitment
        if enable_received:
            options["enableReceivedNotification"] = True
        params.append(options)

    return await connection.subscribe(
        "signatureSubscribe",
        params,
        callback=callback,
    )


async def subscribe_to_logs(
    connection: 'WebSocketConnection',
    callback: Callable,
    filter_type: str = "all",
    commitment: Optional[str] = None,
    mentions: Optional[List[str]] = None,
) -> int:
    """Subscribe to transaction logs."""
    if mentions:
        filter_param = {"mentions": mentions}
    else:
        filter_param = filter_type  # "all" or "allWithVotes"

    params = [filter_param]
    if commitment:
        params.append({"commitment": commitment})

    return await connection.subscribe(
        "logsSubscribe",
        params,
        callback=callback,
    )


async def subscribe_to_program(
    connection: 'WebSocketConnection',
    program_id: str,
    callback: Callable,
    commitment: Optional[str] = None,
    encoding: str = "jsonParsed",
    filters: Optional[List[Dict]] = None,
) -> int:
    """Subscribe to program account changes."""
    params = [program_id]
    options = {}
    if commitment:
        options["commitment"] = commitment
    if encoding:
        options["encoding"] = encoding
    if filters:
        options["filters"] = filters
    if options:
        params.append(options)

    return await connection.subscribe(
        "programSubscribe",
        params,
        callback=callback,
    )


async def subscribe_to_blocks(
    connection: 'WebSocketConnection',
    callback: Callable,
    commitment: Optional[str] = None,
    encoding: str = "jsonParsed",
    transaction_details: str = "full",
    show_rewards: bool = False,
    max_supported_version: int = 0,
) -> int:
    """Subscribe to block notifications."""
    options = {}
    if commitment:
        options["commitment"] = commitment
    if encoding:
        options["encoding"] = encoding
    if transaction_details:
        options["transactionDetails"] = transaction_details
    if show_rewards:
        options["showRewards"] = show_rewards
    if max_supported_version:
        options["maxSupportedTransactionVersion"] = max_supported_version

    params = [options] if options else []

    return await connection.subscribe(
        "blockSubscribe",
        params,
        callback=callback,
    )


async def subscribe_to_slots(
    connection: 'WebSocketConnection',
    callback: Callable,
    commitment: Optional[str] = None,
) -> int:
    """Subscribe to slot notifications."""
    params = []
    if commitment:
        params.append({"commitment": commitment})

    return await connection.subscribe(
        "slotSubscribe",
        params,
        callback=callback,
    )


async def subscribe_to_slots_updates(
    connection: 'WebSocketConnection',
    callback: Callable,
) -> int:
    """Subscribe to slots updates."""
    return await connection.subscribe(
        "slotsUpdatesSubscribe",
        [],
        callback=callback,
    )


async def subscribe_to_root(
    connection: 'WebSocketConnection',
    callback: Callable,
) -> int:
    """Subscribe to root notifications."""
    return await connection.subscribe(
        "rootSubscribe",
        [],
        callback=callback,
    )


async def subscribe_to_votes(
    connection: 'WebSocketConnection',
    callback: Callable,
    commitment: Optional[str] = None,
) -> int:
    """Subscribe to vote notifications."""
    params = []
    if commitment:
        params.append({"commitment": commitment})

    return await connection.subscribe(
        "voteSubscribe",
        params,
        callback=callback,
    )