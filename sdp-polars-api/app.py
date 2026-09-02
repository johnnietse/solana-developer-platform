"""SDP Polars API — Flask application entry point.

Endpoints built on Polars + S3 + Solana RPC:

  - GET  /health                   — health check
  - GET  /metrics?days=N           — read metrics from S3
  - POST /insert?table_name=X      — write delta data to S3
  - GET  /rpc?token_address=X      — fetch/parse token transfers from Solana RPC
  - GET  /ingest/stablecoins       — trigger stablecoin snapshot
  - GET  /ingest/network           — trigger network snapshot
  - GET  /ingest/all               — trigger all snapshots
  - GET  /stablecoins?days=N       — stablecoin supply history
  - GET  /stablecoins/median       — median stablecoin supplies (Polars)
  - GET  /network?days=N           — network metrics history
"""

from __future__ import annotations

import logging
import os
import sys

# ── Logging (visible in Docker/gunicorn) ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    stream=sys.stdout,
)

# Ensure the project root is on the path so ``from src import …`` works.
_app_root = os.path.dirname(os.path.abspath(__file__))
if _app_root not in sys.path:
    sys.path.insert(0, _app_root)

from flask import Flask, jsonify

from config import Config
from src.routes.metrics import _register_metrics_routes
from src.routes.insert import _register_insert_routes
from src.routes.rpc import _register_rpc_routes
from src.routes.ingest import _register_ingest_routes
from src.routes.analytics import _register_analytics_routes
from src.routes.databricks_push import _register_databricks_push_routes
from src.routes.stablecoins import _register_stablecoins_routes
from src.routes.stablecoins_median import _register_stablecoins_median_routes
from src.routes.network import _register_network_routes
from src.routes.tokens import _register_tokens_routes
from src.routes.holders import _register_holders_routes
from src.websocket.routes import socketio, ws_bp


def create_app(cfg: Config | None = None) -> Flask:
    """Application factory."""
    app = Flask(__name__)
    app.config["APP_CFG"] = cfg or Config()

    # ── Health check ──
    @app.route("/health")
    def health():
        return jsonify({"status": "ok"})

    # ── Initialize SocketIO ──
    socketio.init_app(app, cors_allowed_origins="*", async_mode="threading")

    # ── Start background ingestion scheduler ──
    from src.services.scheduler import start_scheduler

    start_scheduler(app.config["APP_CFG"])

    # ── Start WebSocket real-time listeners ──
    from src.services.ws_ingestion import start_ws_listeners

    start_ws_listeners(app.config["APP_CFG"])

    # ── Register route blueprints ──
    _register_metrics_routes(app)
    _register_insert_routes(app)
    _register_rpc_routes(app)
    _register_ingest_routes(app)
    _register_analytics_routes(app)
    _register_databricks_push_routes(app)
    _register_stablecoins_routes(app)
    _register_stablecoins_median_routes(app)
    _register_network_routes(app)
    _register_tokens_routes(app)
    _register_holders_routes(app)

    # Register WebSocket blueprint
    app.register_blueprint(ws_bp, url_prefix="/ws")

    return app


if __name__ == "__main__":
    cfg = Config()
    app = create_app(cfg)
    app.run(host=cfg.host, port=cfg.port, debug=cfg.debug)
