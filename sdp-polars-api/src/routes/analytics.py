"""GET /analytics endpoint — returns data in AnalyticsResponse format.

Bridges the Polars API to the dashboard's existing Analytics tab by returning
data shaped exactly like the SDP API's ``/v1/data-products/analytics`` response.

The dashboard server component calls this as a fallback when the SDP API
returns empty or insufficient data (no Databricks pipeline yet).

This is a temporary bridge — remove once the Databricks pipeline is fully
provisioned and the SDP API returns complete analytics data.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify

from src.services.s3_service import key_exists, list_keys, read_parquet
from src.services.token_registry import get_all_tokens

if TYPE_CHECKING:
    from config import Config

analytics_bp = Blueprint("analytics", __name__)


def _register_analytics_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @analytics_bp.route("/analytics", methods=["GET"])
    def get_analytics():
        """Return analytics data shaped like the SDP API's AnalyticsResponse.

        Reads stablecoin supplies from S3, enriches with token registry
        metadata, and returns a response that the dashboard's Stablecoin
        Analytics tab can render directly.
        """
        days = int(getattr(cfg, "default_metrics_days", 30))
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        # ── 1. Load stablecoin data ──────────────────────────────────────
        all_keys = [k for k in list_keys(cfg, "stablecoins") if k.endswith(".parquet")]
        frames: list[pl.DataFrame] = []

        for key in sorted(all_keys):
            try:
                df = read_parquet(cfg, key)
                frames.append(df)
            except Exception as exc:
                print(f"[analytics] Skipping {key}: {exc}")
                continue

        if not frames:
            return jsonify({
                "data": None,
                "meta": {
                    "source": "polars-api",
                    "error": "No stablecoin data available. Click 'Ingest Now' in the Polars Pipeline tab to start collecting data.",
                },
            }), 503

        combined = pl.concat(frames, how="vertical_relaxed")
        if "date" in combined.columns:
            combined = combined.filter(pl.col("date") >= cutoff.strftime("%Y-%m-%d"))

        if combined.is_empty():
            return jsonify({
                "data": None,
                "meta": {
                    "source": "polars-api",
                    "error": "No stablecoin data in the last 30 days. Click 'Ingest Now' in the Polars Pipeline tab.",
                },
            }), 503

        # Convert to dicts early for use in multiple places
        rows = combined.to_dicts()

        # ── 2. Load token registry for names ─────────────────────────────
        registry_tokens = get_all_tokens(cfg)
        name_by_mint: dict[str, str] = {t["mint"]: t.get("name", t["symbol"]) for t in registry_tokens}
        symbol_by_mint: dict[str, str] = {t["mint"]: t["symbol"] for t in registry_tokens}

        # ── 4. Build supply history by date/symbol ───────────────────────
        supply_by_date: dict[str, dict] = {}
        for row in rows:
            date = row.get("date", "")
            sym = row.get("symbol", "UNKNOWN")
            us = float(row.get("ui_supply", 0) or 0)
            if date not in supply_by_date:
                supply_by_date[date] = {"date": date}
            supply_by_date[date][sym] = us

        supply_history = sorted(supply_by_date.values(), key=lambda x: x["date"])

        # ── 3. Build latest-per-symbol Stablecoin entries ─────────────────
        latest_by_symbol: dict[str, dict] = {}
        rows = combined.to_dicts()
        for row in rows:
            symbol = row.get("symbol", "UNKNOWN")
            date = row.get("date", "")
            if symbol not in latest_by_symbol or date > latest_by_symbol[symbol].get("date", ""):
                latest_by_symbol[symbol] = row

        stablecoin_entries: list[dict] = []
        all_mints: list[str] = []
        for symbol, row in latest_by_symbol.items():
            mint = row.get("mint", "")
            all_mints.append(mint)

            # Try to load cached holders from S3
            holder_count = 0
            holder_key = f"holders/{mint}.parquet"
            if key_exists(cfg, holder_key):
                try:
                    hdf = read_parquet(cfg, holder_key)
                    holder_count = len(hdf)
                except Exception:
                    pass

            # Try to get median balance from holder data
            median_balance = 0
            holder_key = f"holders/{mint}.parquet"
            if key_exists(cfg, holder_key):
                try:
                    hdf = read_parquet(cfg, holder_key)
                    if "ui_amount" in hdf.columns:
                        median_balance = float(hdf["ui_amount"].median())
                except Exception:
                    pass

            # Price oracle - placeholder for future integration
            price_usd = 1.0  # TODO: integrate price oracle
            
            # 24h change - compute from supply history if available
            percent_change_24h = 0.0
            if len(supply_history) >= 2:
                latest = supply_history[-1].get(symbol, 0)
                previous = supply_history[-2].get(symbol, 0)
                if previous > 0:
                    percent_change_24h = ((latest - previous) / previous) * 100

            ui_supply = float(row.get("ui_supply", 0) or 0)

            stablecoin_entries.append({
                "mintAddress": mint,
                "symbol": symbol,
                "name": name_by_mint.get(mint, symbol),
                "totalSupply": float(row.get("supply", 0) or 0),
                "circulatingSupply": ui_supply,
                "holderCount": holder_count,
                "medianBalance": median_balance,
                "priceUsd": price_usd,
                "marketCapUsd": ui_supply * price_usd,
                "percentChange24h": percent_change_24h,
            })

        total_holders = sum(e["holderCount"] for e in stablecoin_entries)

        # ── 5. Build geography/attribution from holder data ──────────────
        geography = []
        attribution = []
        if total_holders > 0:
            # Try to aggregate from holder data
            geo_counts = {}
            attr_counts = {}
            for mint in all_mints:
                holder_key = f"holders/{mint}.parquet"
                if key_exists(cfg, holder_key):
                    try:
                        hdf = read_parquet(cfg, holder_key)
                        if "geography" in hdf.columns:
                            for row in hdf.to_dicts():
                                geo = row.get("geography", "Unknown")
                                geo_counts[geo] = geo_counts.get(geo, 0) + 1
                        if "attribution_category" in hdf.columns:
                            for row in hdf.to_dicts():
                                attr = row.get("attribution_category", "unknown")
                                attr_counts[attr] = attr_counts.get(attr, 0) + 1
                    except Exception:
                        pass
            
            if geo_counts:
                for region, count in sorted(geo_counts.items(), key=lambda x: -x[1]):
                    geography.append({
                        "region": region,
                        "percentage": round((count / total_holders) * 100, 2),
                        "holderCount": count,
                    })
            else:
                geography = [{
                    "region": "Unknown",
                    "percentage": 100.0,
                    "holderCount": total_holders,
                }]
            
            if attr_counts:
                for category, count in sorted(attr_counts.items(), key=lambda x: -x[1]):
                    attribution.append({
                        "category": category,
                        "percentage": round((count / total_holders) * 100, 2),
                        "holderCount": count,
                    })
            else:
                attribution = [{
                    "category": "unknown",
                    "percentage": 100.0,
                    "holderCount": total_holders,
                }]
        else:
            geography = [{
                "region": "Unknown",
                "percentage": 100.0,
                "holderCount": 0,
            }]
            attribution = [{
                "category": "unknown",
                "percentage": 100.0,
                "holderCount": 0,
            }]

        # ── 5. Build response ────────────────────────────────────────────
        now_iso = datetime.now(timezone.utc).isoformat()
        response = {
            "stablecoins": stablecoin_entries,
            "holders": {
                "totalHolders": total_holders,
                "geography": geography,
                "attribution": attribution,
            },
            "holdersHistory": [],
            "supplyHistory": supply_history,
            "lastUpdated": now_iso,
        }

        return jsonify({
            "data": response,
            "meta": {
                "source": "polars-api",
                "totalStablecoins": len(stablecoin_entries),
                "historyDays": len(supply_history),
            },
        })

    app.register_blueprint(analytics_bp)
