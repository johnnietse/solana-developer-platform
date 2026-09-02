"""WebSocket connection manager for Solana RPC WebSocket subscriptions."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set
from enum import Enum

import websockets
from websockets.exceptions import ConnectionClosed, WebSocketException

logger = logging.getLogger(__name__)


class SubscriptionType(Enum):
    """WebSocket subscription types."""
    ACCOUNT = "accountSubscribe"
    PROGRAM = "programSubscribe"
    LOGS = "logsSubscribe"
    SIGNATURE = "signatureSubscribe"
    BLOCK = "blockSubscribe"
    SLOT = "slotSubscribe"
    SLOTS_UPDATES = "slotsUpdatesSubscribe"
    ROOT = "rootSubscribe"
    VOTE = "voteSubscribe"


@dataclass
class Subscription:
    """Represents a WebSocket subscription."""
    id: int
    type: SubscriptionType
    params: Dict
    callback: Optional[Callable] = None
    created_at: datetime = field(default_factory=datetime.utcnow)
    active: bool = True
    filters: Dict = field(default_factory=dict)


@dataclass
class WebSocketConfig:
    """WebSocket connection configuration."""
    url: str
    ping_interval: int = 20
    ping_timeout: int = 10
    close_timeout: int = 10
    max_size: int = 2**20  # 1MB
    max_queue: int = 1000
    reconnect_attempts: int = 5
    reconnect_delay: float = 1.0
    reconnect_max_delay: float = 60.0


class WebSocketConnection:
    """Manages a single WebSocket connection with automatic reconnection."""

    def __init__(self, config: WebSocketConfig):
        self.config = config
        self.websocket: Optional[websockets.WebSocketClientProtocol] = None
        self.connected = False
        self.reconnecting = False
        self._subscriptions: Dict[int, Subscription] = {}
        self._next_subscription_id = 1
        self._message_queue: asyncio.Queue = asyncio.Queue(maxsize=config.max_queue)
        self._response_futures: Dict[int, asyncio.Future] = {}
        self._listener_task: Optional[asyncio.Task] = None
        self._reconnect_task: Optional[asyncio.Task] = None
        self._message_handlers: Dict[str, Callable] = {}
        self._lock = asyncio.Lock()

    async def connect(self) -> bool:
        """Establish WebSocket connection."""
        async with self._lock:
            if self.connected:
                return True

            try:
                self.websocket = await websockets.connect(
                    self.config.url,
                    ping_interval=self.config.ping_interval,
                    ping_timeout=self.config.ping_timeout,
                    close_timeout=self.config.close_timeout,
                    max_size=self.config.max_size,
                )
                self.connected = True
                self._listener_task = asyncio.create_task(self._listen())
                logger.info(f"Connected to {self.config.url}")
                return True
            except Exception as e:
                logger.error(f"Failed to connect to {self.config.url}: {e}")
                self.connected = False
                return False

    async def disconnect(self):
        """Close WebSocket connection."""
        async with self._lock:
            self.connected = False
            
            if self._listener_task:
                self._listener_task.cancel()
                try:
                    await self._listener_task
                except asyncio.CancelledError:
                    pass

            if self._reconnect_task:
                self._reconnect_task.cancel()
                try:
                    await self._reconnect_task
                except asyncio.CancelledError:
                    pass

            if self.websocket:
                try:
                    await self.websocket.close()
                except Exception:
                    pass
                self.websocket = None

            self.connected = False
            logger.info("Disconnected from WebSocket")

    async def _listen(self):
        """Listen for incoming messages."""
        try:
            async for message in self.websocket:
                await self._handle_message(message)
        except ConnectionClosed:
            logger.warning("WebSocket connection closed")
            self.connected = False
            if not self.reconnecting:
                asyncio.create_task(self._reconnect())
        except Exception as e:
            logger.error(f"WebSocket listener error: {e}")
            self.connected = False
            if not self.reconnecting:
                asyncio.create_task(self._reconnect())

    async def _handle_message(self, message: str):
        """Process incoming WebSocket message."""
        try:
            data = json.loads(message)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse WebSocket message: {e}")
            return

        # Handle response to subscription request
        if "id" in data and "result" in data:
            sub_id = data["id"]
            if sub_id in self._response_futures:
                future = self._response_futures.pop(sub_id)
                if not future.done():
                    future.set_result(data["result"])
            return

        # Handle subscription notifications
        if "method" in data and "params" in data:
            method = data["method"]
            params = data["params"]
            subscription_id = params.get("subscription")

            if subscription_id and subscription_id in self._subscriptions:
                subscription = self._subscriptions[subscription_id]
                if subscription.callback:
                    try:
                        await subscription.callback(params.get("result"))
                    except Exception as e:
                        logger.error(f"Subscription callback error: {e}")

    async def subscribe(
        self,
        method: str,
        params: List,
        callback: Optional[Callable] = None,
        filters: Optional[Dict] = None,
    ) -> int:
        """Create a new subscription."""
        if not self.connected:
            raise RuntimeError("Not connected to WebSocket")

        sub_id = self._next_subscription_id
        self._next_subscription_id += 1

        request = {
            "jsonrpc": "2.0",
            "id": self._next_subscription_id,
            "method": method,
            "params": params,
        }

        future = asyncio.get_event_loop().create_future()
        self._response_futures[self._next_subscription_id] = future

        try:
            await self.websocket.send(json.dumps({
                "jsonrpc": "2.0",
                "id": self._next_subscription_id,
                "method": method,
                "params": params,
            }))
        except Exception as e:
            logger.error(f"Failed to send subscription request: {e}")
            raise

        try:
            result = await asyncio.wait_for(future, timeout=10.0)
            subscription_id = result
        except asyncio.TimeoutError:
            raise TimeoutError("Subscription request timed out")
        except Exception as e:
            logger.error(f"Subscription failed: {e}")
            raise

        # Enum values match the method names (e.g., "slotSubscribe" -> SubscriptionType.SLOT)
        type_ = next((m for m in SubscriptionType if m.value == method), None)
        subscription = Subscription(
            id=subscription_id,
            type=type_,
            params={"method": method, "params": params},
            callback=callback,
        )
        self._subscriptions[subscription_id] = subscription

        logger.info(f"Subscribed to {method} with id {subscription_id}")
        return subscription_id

    async def unsubscribe(self, subscription_id: int, method: str) -> bool:
        """Cancel a subscription."""
        if not self.connected:
            return False

        if subscription_id not in self._subscriptions:
            return False

        request = {
            "jsonrpc": "2.0",
            "id": self._next_subscription_id,
            "method": method.replace("Subscribe", "Unsubscribe"),
            "params": [subscription_id],
        }

        future = asyncio.get_event_loop().create_future()
        self._response_futures[self._next_subscription_id] = future

        try:
            await self.websocket.send(json.dumps(request))
            await asyncio.wait_for(future, timeout=10.0)
        except Exception as e:
            logger.error(f"Unsubscribe failed: {e}")
            return False

        if subscription_id in self._subscriptions:
            del self._subscriptions[subscription_id]

        logger.info(f"Unsubscribed from {subscription_id}")
        return True

    async def _reconnect(self):
        """Attempt to reconnect with exponential backoff."""
        if self.reconnecting:
            return

        self.reconnecting = True
        delay = self.config.reconnect_delay

        for attempt in range(self.config.reconnect_attempts):
            logger.info(f"Reconnection attempt {attempt + 1}/{self.config.reconnect_attempts}")
            await asyncio.sleep(delay)

            if await self.connect():
                # Resubscribe to all active subscriptions
                for sub_id, subscription in self._subscriptions.items():
                    try:
                        await self.subscribe(
                            subscription.params["method"],
                            subscription.params["params"],
                            subscription.callback,
                            subscription.filters,
                        )
                    except Exception as e:
                        logger.error(f"Failed to resubscribe {subscription.id}: {e}")

                logger.info("Reconnected and resubscribed successfully")
                self.reconnecting = False
                return

            delay = min(delay * 2, self.config.reconnect_max_delay)

        logger.error("Max reconnection attempts reached")
        self.reconnecting = False

    async def send(self, data: Dict) -> bool:
        """Send a message over the WebSocket."""
        if not self.connected or not self.websocket:
            return False

        try:
            await self.websocket.send(json.dumps(data))
            return True
        except Exception as e:
            logger.error(f"Failed to send message: {e}")
            return False

    def is_connected(self) -> bool:
        return self.connected and self.websocket is not None

    def get_active_subscriptions(self) -> List[Subscription]:
        return list(self._subscriptions.values())


class SubscriptionManager:
    """High-level subscription manager for multiple WebSocket connections."""

    def __init__(self):
        self.connections: Dict[str, WebSocketConnection] = {}
        self._default_config: Optional[WebSocketConfig] = None

    def set_default_config(self, config: WebSocketConfig):
        self._default_config = config

    def get_connection(self, name: str) -> Optional[WebSocketConnection]:
        return self.connections.get(name)

    def create_connection(self, name: str, config: Optional[WebSocketConfig] = None) -> WebSocketConnection:
        config = config or self._default_config
        if not config:
            raise ValueError("No WebSocket configuration provided")

        connection = WebSocketConnection(config)
        self.connections[name] = connection
        return connection

    async def connect_all(self) -> Dict[str, bool]:
        results = {}
        for name, conn in self.connections.items():
            results[name] = await conn.connect()
        return results

    async def disconnect_all(self):
        for conn in self.connections.values():
            await conn.disconnect()

    async def close(self):
        await self.disconnect_all()
        self.connections.clear()


# Global subscription manager instance
subscription_manager = SubscriptionManager()