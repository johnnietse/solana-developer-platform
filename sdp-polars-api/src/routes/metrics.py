"""GET /metrics endpoint — reads Solana metrics from Delta tables in S3.

Reads ``dev/mlh/polars_metrics_values/`` — a Delta table populated by
Databricks with daily metric snapshots (metric_id, provider_id, value).
Maps metric IDs to human-readable names and aggregates by date.

Usage:
    GET /metrics              # last 30 days (default)
    GET /metrics?days=7       # last 7 days
    GET /metrics?days=90      # last 90 days
"""

from __future__ import annotations

import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import read_delta, scan_delta

if TYPE_CHECKING:
    from config import Config

metrics_bp = Blueprint("metrics", __name__)

# Fallback metric ID → name map, used only when the catalog table is
# unreachable. The source of truth is the Delta catalog at
# dev/mlh/polars_metrics (written by /insert) — see _metric_names().
#
# It still mirrors the dev.mlh.metrics lookup table verbatim, because a fallback
# that disagrees with the catalog is worse than no fallback: ids 14/25/28/29
# were once mislabelled here and surfaced real values under the wrong name (the
# validator count rendered as "SOL Price"). Nothing about that is visible to a
# caller, so keep this map and the catalog in step.
METRIC_NAMES: dict[int, str] = {
    1: "Supply",
    2: "Transfer Volume",
    3: "Transfer Count",
    4: "Active Addresses",
    14: "Slots",
    15: "Fee Payers",
    16: "SOL Price",
    17: "Compute Units",
    18: "Fees",
    19: "Transaction Count (Total)",
    20: "Non Vote Transaction Count (Success)",
    21: "Non Vote Transaction Count (Failed)",
    22: "Transaction Count (Vote)",
    23: "DEX Volume",
    24: "DEX Traders",
    25: "DEX Transactions",
    26: "DEX Count",
    27: "Total Stake",
    28: "SOL Price (Network)",
    29: "Validator Count",
    30: "Top 3 ASN Share",
    31: "Stablecoin Count",
}

# Vendored copy of the catalog seed data, used when S3 is unreachable. Carries
# the full metadata (unit/description/tab) that METRIC_NAMES cannot.
_CATALOG_CSV = Path(__file__).resolve().parents[2] / "data" / "metrics-catalog.csv"

# Cached catalog lookup — the catalog changes rarely, so read it once per process.
_metric_catalog_cache: dict[int, dict] | None = None


def _catalog_from_csv() -> dict[int, dict] | None:
    """Load the vendored catalog CSV, or None if it is missing/unreadable."""
    try:
        with _CATALOG_CSV.open(newline="", encoding="utf-8") as fh:
            rows = list(csv.DictReader(fh))
    except (OSError, csv.Error):
        return None

    catalog: dict[int, dict] = {}
    for row in rows:
        try:
            metric_id = int(row["id"])
        except (KeyError, TypeError, ValueError):
            continue
        catalog[metric_id] = {
            "id": metric_id,
            "name": row.get("name", ""),
            "unit": row.get("unit"),
            "description": row.get("description"),
            "tab": row.get("tab"),
        }
    return catalog or None


def _metric_catalog(cfg: Config) -> dict[int, dict]:
    """Metric ID → full catalog row, resolved through three tiers.

    S3 Delta catalog is authoritative; the vendored CSV covers an S3 outage
    while keeping unit/description/tab; METRIC_NAMES is the last resort and
    carries names only. All three were verified to agree on all 22 metrics.
    """
    global _metric_catalog_cache
    if _metric_catalog_cache is not None:
        return _metric_catalog_cache

    catalog = read_delta(cfg, path="dev/mlh/polars_metrics")
    if catalog is not None and not catalog.is_empty():
        _metric_catalog_cache = {
            r["id"]: {
                "id": r["id"],
                "name": r.get("name", ""),
                "unit": r.get("unit"),
                "description": r.get("description"),
                "tab": r.get("tab"),
            }
            for r in catalog.to_dicts()
        }
        return _metric_catalog_cache

    from_csv = _catalog_from_csv()
    if from_csv is not None:
        _metric_catalog_cache = from_csv
        return _metric_catalog_cache

    _metric_catalog_cache = {
        k: {"id": k, "name": v, "unit": None, "description": None, "tab": None}
        for k, v in METRIC_NAMES.items()
    }
    return _metric_catalog_cache


def _metric_names(cfg: Config) -> dict[int, str]:
    """Metric ID → name, projected out of the full catalog."""
    return {k: v["name"] for k, v in _metric_catalog(cfg).items()}


def _register_metrics_routes(app):
    """Inject config into the blueprint (called at app init)."""
    cfg: Config = app.config["APP_CFG"]

    @metrics_bp.route("/metrics", methods=["GET"])
    def get_metrics():
        days = request.args.get("days", default=cfg.default_metrics_days, type=int)
        days = min(max(days, 1), 365)

        # These are daily metrics, so compare dates rather than timestamps.
        # A "now" cutoff with a time component includes or drops the boundary
        # day depending on the hour the request happens to run — the same query
        # returned 1732 rows in the afternoon and 1829 rows at 2am.
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).date()

        # ── Read from polars_metrics_values (created by Waddah in Databricks) ─
        # Scanned lazily so the date filter is pushed down to the Delta scan
        # rather than pulling the whole table into memory first.
        source = "dev/mlh/polars_metrics_values"
        lf = scan_delta(cfg, path=source)
        df = (
            lf.filter(pl.col("date") >= cutoff).collect()
            if lf is not None
            else None
        )
        if df is None:
            # read_delta returns None for any failure, so this covers a missing
            # table and an S3 credential/permission problem alike. Report it as
            # unavailable rather than as an empty-but-successful result.
            return jsonify({
                "days": days,
                "metrics": [],
                "count": 0,
                "source": source,
                "error": (
                    f"Could not read the Delta table at {source} — it is missing, "
                    "or S3 credentials/permissions are not configured"
                ),
            }), 503

        if df.is_empty():
            # An empty window is not the same fact as an empty table, and the
            # dashboard cannot tell them apart from a zero count: both render a
            # blank panel. This table is written by Databricks, so when that
            # warehouse stops, the newest row simply ages past the default
            # 30-day window and the panel goes blank while the pipeline looks
            # fine everywhere else.
            #
            # So: look again with no window. If rows exist, serve the most
            # recent day and say plainly that the data is stale, rather than
            # reporting nothing and sending the reader after a fault that is
            # not there.
            everything = lf.collect() if lf is not None else None
            if everything is None or everything.is_empty():
                return jsonify({
                    "days": days,
                    "metrics": [],
                    "count": 0,
                    "source": source,
                    "stale": False,
                })

            newest = everything["date"].max()
            return jsonify({
                "days": days,
                "metrics": [],
                "count": 0,
                "source": source,
                "stale": True,
                "newest_date": str(newest),
                "note": (
                    f"No metrics in the last {days} days. The table's newest row "
                    f"is {newest}; the data is stale, not missing. Widen the "
                    "window with ?days= to read it."
                ),
            })

        # (the date filter already ran as part of the scan above)

        # Add human-readable metric name
        name_map = pl.DataFrame([
            {"metric_id": k, "metric_name": v}
            for k, v in _metric_names(cfg).items()
        ])
        df = df.join(name_map, on="metric_id", how="left")

        # Sort by date + metric
        df = df.sort(["date", "metric_id"])

        # Group by date → { date: { metric_name: value, ... } }
        metrics_by_date: list[dict] = []
        # No as_dict here. partition_by(as_dict=True) returns
        # dict[key_tuple, DataFrame], and iterating that dict yields the key
        # tuples rather than the frames - the bug this replaced. Asking for
        # frames directly cannot be got wrong the same way, and maintain_order
        # keeps the groups in date order.
        for date_group in df.partition_by("date", maintain_order=True):
            date_val = str(date_group["date"][0])
            row: dict = {"date": date_val}
            for r in date_group.to_dicts():
                name = r.get("metric_name") or f"metric_{r['metric_id']}"
                row[name] = r["value"]
            metrics_by_date.append(row)

        return jsonify({
            "days": days,
            "count": len(metrics_by_date),
            "source": source,
            "metrics": metrics_by_date,
        })

    @metrics_bp.route("/metrics/catalog", methods=["GET"])
    def get_metrics_catalog():
        """Return the metric definitions, with no readings attached.

        The catalog answers what a metric IS — its name, unit, description and
        which dashboard tab it belongs to. /metrics and /metrics/latest answer
        what it MEASURED. The dashboard needs both: it reads units from here to
        format values it reads from there, and it groups the page by `tab`.

        This exists as its own route because it keeps working when the values
        table is empty or stale. _metric_catalog falls back from the S3 Delta
        table to a vendored CSV to a name-only map, so a reader can still see
        the 22 definitions and tell "no readings yet" apart from "the service
        is broken" — which is the whole diagnostic value of the panel.
        """
        catalog = _metric_catalog(cfg)
        entries = sorted(catalog.values(), key=lambda r: r["id"])

        tabs: dict[str, int] = {}
        for entry in entries:
            tab = entry.get("tab") or "Uncategorised"
            tabs[tab] = tabs.get(tab, 0) + 1

        return jsonify({
            "count": len(entries),
            "source": "dev/mlh/polars_metrics",
            "tabs": tabs,
            "data": entries,
        })

    @metrics_bp.route("/metrics/latest", methods=["GET"])
    def get_metrics_latest():
        """Return the most recent snapshot, one entry per metric.

        A different projection of the same two tables that ``/metrics`` reads.
        ``/metrics`` gives a wide time series — one row per date, metrics as
        columns — which suits charting. This gives the newest date only, keeps
        each metric as its own object with its catalog metadata attached, and
        preserves the per-provider values that the wide pivot has to collapse.
        """
        source = "dev/mlh/polars_metrics_values"
        lf = scan_delta(cfg, path=source)
        if lf is None:
            return jsonify({
                "error": (
                    f"Could not read the Delta table at {source} — it is missing, "
                    "or S3 credentials/permissions are not configured"
                ),
                "source": source,
            }), 503

        # Resolve the newest date first so the row filter is pushed into the
        # scan, rather than collecting every date and discarding most of them.
        try:
            latest_date = lf.select(pl.col("date").max()).collect().item()
        except Exception:
            latest_date = None

        if latest_date is None:
            return jsonify({
                "error": f"{source} has no rows",
                "source": source,
            }), 503

        values = lf.filter(pl.col("date") == latest_date).collect()
        catalog = _metric_catalog(cfg)

        # Group by metric, keeping every provider's reading for that date.
        by_metric: dict[int, list[dict]] = {}
        for row in values.to_dicts():
            by_metric.setdefault(row["metric_id"], []).append({
                "provider_id": row.get("provider_id"),
                "value": row.get("value"),
            })

        data = []
        for metric_id in sorted(by_metric):
            meta = catalog.get(metric_id, {})
            data.append({
                "id": metric_id,
                # An id absent from the catalog still gets an entry rather than
                # being dropped — a value with no name is a catalog gap worth
                # seeing, not a row to hide.
                "name": meta.get("name") or f"metric_{metric_id}",
                "unit": meta.get("unit"),
                "description": meta.get("description"),
                "tab": meta.get("tab"),
                "values": by_metric[metric_id],
            })

        return jsonify({
            "date": str(latest_date),
            "count": len(data),
            "source": source,
            "data": data,
        })

    app.register_blueprint(metrics_bp)
