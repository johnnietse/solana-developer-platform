"""Automated ingestion scheduler — runs on a timer inside the Flask app.

The scheduler fetches Solana on-chain data and writes to S3 Delta tables
on a regular interval, keeping the data fresh for Databricks queries.
"""

from __future__ import annotations

import atexit
import json
import logging
from typing import TYPE_CHECKING

from apscheduler.schedulers.background import BackgroundScheduler

if TYPE_CHECKING:
    from config import Config

logger = logging.getLogger("sdp-polars.scheduler")
_scheduler: BackgroundScheduler | None = None


def _run_ingestion(cfg: Config):
    """Run all ingestion tasks serially."""
    from src.services.ingestion import (
        ingest_stablecoins,
        ingest_network,
        ingest_holders,
        ingest_whales,
        ingest_validators,
    )
    from src.services.databricks_push import push_to_databricks

    results = {}
    for fn in [ingest_stablecoins, ingest_network, ingest_holders, ingest_whales, ingest_validators]:
        try:
            results[fn.__name__] = fn(cfg)
        except Exception as exc:
            results[fn.__name__] = {"status": "error", "error": str(exc)}

    # Always attempt Databricks push after ingestion
    try:
        results["push_to_databricks"] = push_to_databricks(cfg)
    except Exception as exc:
        results["push_to_databricks"] = {"status": "error", "error": str(exc)}

    print(f"[scheduler] Ingestion cycle complete: {json.dumps(results, default=str)[:500]}")


def start_scheduler(cfg: Config) -> None:
    """Start the background ingestion scheduler.

    Runs ``/ingest/all`` (stablecoins + network + Databricks push) on a
    configurable interval.

    The interval is controlled by the ``INGESTION_INTERVAL_MINUTES`` env var
    (default: 15 minutes).
    """
    global _scheduler

    if _scheduler is not None:
        return  # Already running

    interval = getattr(cfg, "ingestion_interval_minutes", 15)
    logger.info("Starting — will ingest every %d minute(s)", interval)

    _scheduler = BackgroundScheduler(daemon=True)

    # _run_ingestion imports inside to avoid circular imports at module level

    # Run immediately on startup, then every N minutes
    from apscheduler.triggers.interval import IntervalTrigger
    from datetime import datetime, timezone

    _scheduler.add_job(
        _run_ingestion, args=[cfg],
        trigger=IntervalTrigger(minutes=interval),
        id="ingestion",
        next_run_time=datetime.now(timezone.utc),  # Fire immediately
    )

    _scheduler.start()
    logger.info("Started (interval=%d min, immediate first run)", interval)

    # Shut down the scheduler when the app exits
    atexit.register(stop_scheduler)


def stop_scheduler() -> None:
    """Gracefully shut down the background scheduler."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Stopped")
