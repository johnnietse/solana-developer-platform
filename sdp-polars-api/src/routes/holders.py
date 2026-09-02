"""GET /holders endpoint — token holder enrichment.

Fetches the largest token accounts (top holders) for a given token mint
via Solana RPC and caches results to S3. Part of the "Enrich holders"
scope item.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING

import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import key_exists, read_parquet, write_parquet
from src.services.solana_rpc import get_token_largest_accounts

if TYPE_CHECKING:
    from config import Config

holders_bp = Blueprint("holders", __name__)


def _register_holders_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @holders_bp.route("/holders/<mint>", methods=["GET"])
    def get_holders(mint):
        """Fetch top token holders for a given mint address.

        Checks S3 cache first; if stale (>1h) or missing, fetches fresh
        from Solana RPC.

        Query params:
          - refresh: if "true", bypass cache and force RPC fetch
        """
        force_refresh = request.args.get("refresh", "").lower() == "true"
        now = datetime.now(timezone.utc)
        s3_key = f"holders/{mint}.parquet"

        # ── Check S3 cache (only if not forced refresh) ──
        if not force_refresh and key_exists(cfg, s3_key):
            try:
                df = read_parquet(cfg, s3_key)
                records = df.to_dicts()
                # Check if cache is fresh (< 1 hour old)
                if records and "scraped_at" in records[0]:
                    last_scrape = datetime.fromisoformat(records[0]["scraped_at"])
                    age_hours = (now - last_scrape).total_seconds() / 3600
                    if age_hours < 1:
                        return jsonify({
                            "mint": mint,
                            "source": "cache",
                            "holders": records,
                            "count": len(records),
                            "scraped_at": records[0]["scraped_at"],
                        })
            except Exception:
                pass  # Fall through to RPC fetch

        # ── Fetch from RPC ──
        try:
            accounts = get_token_largest_accounts(cfg, mint)
        except Exception as exc:
            return jsonify({
                "mint": mint,
                "source": "rpc",
                "error": f"RPC call failed: {exc}",
                "holders": [],
                "count": 0,
            }), 502
        if not accounts:
            return jsonify({"mint": mint, "source": "rpc", "holders": [], "count": 0})

        scraped_at = now.isoformat()
        records = []
        for i, acct in enumerate(accounts):
            records.append({
                "mint": mint,
                "rank": i + 1,
                "address": acct.get("address", ""),
                "amount": int(acct.get("amount", 0)),
                "decimals": acct.get("decimals", 0),
                "ui_amount": float(acct.get("uiAmount", 0) or 0),
                "percentage": 0.0,  # Will be calculated below
                "scraped_at": scraped_at,
            })

        # Calculate total supply and percentages
        total_ui = sum(r["ui_amount"] for r in records)
        if total_ui > 0:
            for r in records:
                r["percentage"] = round((r["ui_amount"] / total_ui) * 100, 4)

        # Cache to S3
        df = pl.DataFrame(records)
        write_parquet(cfg, s3_key, df)

        # Calculate concentration metrics
        top1_pct = records[0]["percentage"] if records else 0
        top10_pct = sum(r["percentage"] for r in records[:10]) if len(records) >= 10 else sum(r["percentage"] for r in records)

        return jsonify({
            "mint": mint,
            "source": "rpc",
            "holders": records,
            "count": len(records),
            "scraped_at": scraped_at,
            "concentration": {
                "top1_pct": top1_pct,
                "top10_pct": top10_pct,
                "num_holders": len(records),
            },
        })

    app.register_blueprint(holders_bp)
