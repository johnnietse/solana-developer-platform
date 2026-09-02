"""WebSocket routes for Flask-SocketIO integration."""

from __future__ import annotations

import json
import logging
from typing import Optional, Dict, Any, List

from flask import request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect
from flask import request

from .connection import WebSocketConnection, WebSocketConfig
from .handlers import SubscriptionHandler

logger = logging.getLogger(__name__)

# Initialize SocketIO
socketio = SocketIO(cors_allowed_origins="*", async_mode="threading", logger=True, engineio_logger=True)

# Global WebSocket connection for Solana RPC
_solana_ws_connection = None
_subscription_handler = None


def get_solana_ws_connection():
    """Get or create the Solana RPC WebSocket connection."""
    global _solana_ws_connection
    if _solana_ws_connection is None:
        from .connection import WebSocketConnection, WebSocketConfig
        from config import Config
        
        config = WebSocketConfig(
            url="wss://api.mainnet-beta.solana.com/",
            ping_interval=20,
            ping_timeout=10,
            close_timeout=10,
        )
        from .connection import WebSocketConnection
        connection = WebSocketConnection(config)
        # Note: connection.connect() is async, we'll handle this in the socketio event
        return connection
    return _solana_ws_connection


def get_subscription_handler():
    """Get or create the subscription handler."""
    global _subscription_handler
    if _subscription_handler is None:
        from .handlers import SubscriptionHandler
        connection = get_solana_ws_connection()
        from .handlers import SubscriptionHandler
        _subscription_handler = SubscriptionHandler(connection)
    return _subscription_handler


# SocketIO event handlers
@socketio.on('connect')
def handle_connect():
    """Handle client connection."""
    logger.info(f"Client connected: {request.sid}")
    emit('connected', {'status': 'connected', 'sid': request.sid})


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnect."""
    logger.info(f"Client disconnected: {request.sid}")
    # Clean up subscriptions for this client
    pass


@socketio.on('subscribe')
def handle_subscribe(data):
    """Handle subscription request from client."""
    try:
        method = data.get('method')
        params = data.get('params', [])
        request_id = data.get('id', 1)
        
        if not method:
            emit('error', {'id': data.get('id'), 'error': {'code': -32600, 'message': 'Missing method'}})
            return
        
        # Get subscription handler
        handler = get_subscription_handler()
        
        # Handle subscription methods
        if method in [
            'accountSubscribe', 'accountUnsubscribe',
            'signatureSubscribe', 'signatureUnsubscribe',
            'logsSubscribe', 'logsUnsubscribe',
            'programSubscribe', 'programUnsubscribe',
            'blockSubscribe', 'blockUnsubscribe',
            'slotSubscribe', 'slotUnsubscribe',
            'slotsUpdatesSubscribe', 'slotsUpdatesUnsubscribe',
            'rootSubscribe', 'rootUnsubscribe',
            'voteSubscribe', 'voteUnsubscribe',
        ]:
            # This would need the connection to be established
            # For now, return a mock response
            emit('response', {
                'jsonrpc': '2.0',
                'id': data.get('id', 1),
                'result': 1,
                'message': 'Subscription created (mock)'
            })
        else:
            emit('response', {
                'jsonrpc': '2.0',
                'id': data.get('id', 1),
                'error': {
                    'code': -32601,
                    'message': f'Method not found: {method}'
                }
            })
            
    except Exception as e:
        logger.error(f"Subscription error: {e}")
        emit('error', {'error': str(e)})


@socketio.on('unsubscribe')
def handle_unsubscribe(data):
    """Handle unsubscribe request."""
    try:
        subscription_id = data.get('subscription_id')
        method = data.get('method')
        
        if not subscription_id or not method:
            emit('error', {'error': 'Missing subscription_id or method'})
            return
        
        # TODO: Implement actual unsubscribe
        emit('response', {
            'jsonrpc': '2.0',
            'id': data.get('id', 1),
            'result': True,
            'message': 'Unsubscribed (mock)'
        })
    except Exception as e:
        logger.error(f"Unsubscribe error: {e}")
        emit('error', {'error': str(e)})


@socketio.on('get_subscriptions')
def handle_get_subscriptions():
    """Get list of active subscriptions."""
    # Return mock data for now
    emit('subscriptions', {
        'subscriptions': []
    })


# HTTP fallback endpoints for non-WebSocket clients
from flask import Blueprint, jsonify, request

ws_bp = Blueprint('ws', __name__, url_prefix='/ws')


@ws_bp.route('/subscribe', methods=['POST'])
def subscribe_http():
    """HTTP fallback for creating subscriptions."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'Missing JSON body'}), 400
    
    method = data.get('method')
    params = data.get('params', [])
    
    if not method:
        return jsonify({'error': 'Missing method'}), 400
    
    # Mock response for now
    return jsonify({
        'jsonrpc': '2.0',
        'id': 1,
        'result': 1,
        'message': 'Subscription created (mock)'
    }), 201


@ws_bp.route('/subscribe/<int:subscription_id>', methods=['DELETE'])
def unsubscribe_http(subscription_id):
    """HTTP fallback for unsubscribing."""
    return jsonify({
        'success': True,
        'subscription_id': subscription_id,
        'message': 'Unsubscribed (mock)'
    })


@ws_bp.route('/subscriptions', methods=['GET'])
def list_subscriptions():
    """List active subscriptions."""
    return jsonify({
        'subscriptions': []
    })