"""GET /stablecoins/median endpoint — calculates intelligent median stablecoin metrics.

"Plot median stablecoin data using Polars" — original scope item from
the Solana Developer Platform architecture planning doc.

Features:
- Time-weighted median (recent data weighted more heavily)
- Outlier detection and removal using modified Z-score
- Trend detection (increasing/decreasing/stable)
- Configurable via environment variables
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

import numpy as np
import polars as pl
from flask import Blueprint, jsonify, request

from src.services.s3_service import list_keys, read_parquet

if TYPE_CHECKING:
    from config import Config

median_bp = Blueprint("stablecoins_median", __name__)


def _get_config_value(cfg: Config, key: str, default: any, cast_type: type = None):
    """Get config value from env extra or default."""
    val = cfg.extra.get(key, default)
    if cast_type and val is not None:
        try:
            return cast_type(val)
        except (ValueError, TypeError):
            return default
    return val


def _modified_z_score_outliers(values: np.ndarray, threshold: float = 3.5) -> np.ndarray:
    """Detect outliers using modified Z-score (more robust than standard Z-score).
    
    Uses median and MAD (Median Absolute Deviation) instead of mean/std.
    """
    if len(values) < 4:
        return np.zeros(len(values), dtype=bool)
    
    median = np.median(values)
    mad = np.median(np.abs(values - median))
    
    if mad == 0:
        return np.zeros(len(values), dtype=bool)
    
    modified_z_scores = 0.6745 * (values - median) / mad
    return np.abs(modified_z_scores) > threshold


def _time_weighted_median(values: np.ndarray, timestamps: np.ndarray, 
                          half_life_days: float = 30.0) -> float:
    """Calculate time-weighted median with exponential decay.
    
    More recent observations get exponentially higher weights.
    """
    if len(values) == 0:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    
    # Convert timestamps to days since epoch
    now = timestamps.max()
    days_ago = (now - timestamps) / np.timedelta64(1, 'D')
    
    # Exponential decay weights
    weights = np.exp(-days_ago * np.log(2) / half_life_days)
    
    # Sort by value for weighted median calculation
    sorted_idx = np.argsort(values)
    sorted_values = values[sorted_idx]
    sorted_weights = weights[sorted_idx]
    
    # Weighted median: find value where cumulative weight crosses 50%
    cumsum_weights = np.cumsum(sorted_weights)
    total_weight = cumsum_weights[-1]
    
    if total_weight == 0:
        return float(np.median(values))
    
    median_idx = np.searchsorted(cumsum_weights, total_weight / 2)
    median_idx = min(median_idx, len(sorted_values) - 1)
    
    return float(sorted_values[median_idx])


def _detect_trend(values: np.ndarray, timestamps: np.ndarray) -> dict:
    """Detect trend direction and strength using linear regression on recent data."""
    if len(values) < 3:
        return {"direction": "insufficient_data", "strength": 0.0, "slope": 0.0}
    
    # Use last 30 days of data for trend
    now = timestamps.max()
    cutoff = now - np.timedelta64(30, 'D')
    mask = timestamps >= cutoff
    
    recent_values = values[mask]
    recent_times = timestamps[mask]
    
    if len(recent_values) < 3:
        return {"direction": "insufficient_data", "strength": 0.0, "slope": 0.0}
    
    # Convert to days since epoch for regression
    x = (recent_times - recent_times.min()) / np.timedelta64(1, 'D')
    y = recent_values.astype(float)
    
    # Linear regression
    n = len(x)
    x_mean = np.mean(x)
    y_mean = np.mean(y)
    
    numerator = np.sum((x - x_mean) * (y - y_mean))
    denominator = np.sum((x - x_mean) ** 2)
    
    if denominator == 0:
        return {"direction": "flat", "strength": 0.0, "slope": 0.0}
    
    slope = numerator / denominator
    
    # R-squared for strength
    y_pred = slope * (x - x_mean) + y_mean
    ss_res = np.sum((y - y_pred) ** 2)
    ss_tot = np.sum((y - y_mean) ** 2)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0
    
    if slope > 0.01 * np.std(y):
        direction = "increasing"
    elif slope < -0.01 * np.std(y):
        direction = "decreasing"
    else:
        direction = "stable"
    
    return {
        "direction": direction,
        "strength": float(r_squared),
        "slope": float(slope),
        "slope_per_day": float(slope)
    }


def _intelligent_median_analysis(df: pl.DataFrame, cfg: Config, median_params: dict) -> list[dict]:
    """Perform intelligent median analysis with outlier removal, time-weighting, and trend detection."""
    
    # Get configurable parameters from median_params, converting from strings
    outlier_threshold = float(median_params.get("MEDIAN_OUTLIER_THRESHOLD", cfg.median_outlier_threshold))
    half_life_days = float(median_params.get("MEDIAN_HALF_LIFE_DAYS", cfg.median_half_life_days))
    min_samples = int(median_params.get("MEDIAN_MIN_SAMPLES", cfg.median_min_samples))
    remove_outliers = median_params.get("MEDIAN_REMOVE_OUTLIERS", str(cfg.median_remove_outliers)).lower() == "true"
    
    results = []
    
    # Group by symbol
    for symbol in df["symbol"].unique():
        symbol_df = df.filter(pl.col("symbol") == symbol)
        
        if len(symbol_df) < min_samples:
            continue
        
        # Extract values and timestamps
        values = symbol_df["ui_supply"].to_numpy()
        timestamps = symbol_df["scraped_at_dt"].to_numpy()
        
        # Remove outliers if enabled
        if remove_outliers and len(values) >= 4:
            outlier_mask = _modified_z_score_outliers(values)
            if outlier_mask.any():
                values = values[~outlier_mask]
                timestamps = timestamps[~outlier_mask]
        
        if len(values) < 3:
            continue
        
        # Calculate various medians
        simple_median = float(np.median(values))
        time_weighted_median = _time_weighted_median(values, timestamps, half_life_days)
        
        # Trimmed mean (remove top/bottom 10%)
        trimmed_mean = float(np.mean(np.sort(values)[int(len(values)*0.1):int(len(values)*0.9)]))
        
        # Trend detection
        trend = _detect_trend(values, timestamps)
        
        # Basic stats
        min_val = float(np.min(values))
        max_val = float(np.max(values))
        mean_val = float(np.mean(values))
        std_val = float(np.std(values)) if len(values) > 1 else 0.0
        
        results.append({
            "symbol": symbol,
            "median_supply": simple_median,
            "time_weighted_median": time_weighted_median,
            "trimmed_mean": trimmed_mean,
            "min_supply": min_val,
            "max_supply": max_val,
            "mean_supply": mean_val,
            "std_supply": std_val if std_val > 0 else None,
            "sample_count": len(values),
            "outliers_removed": int(outlier_mask.sum()) if remove_outliers and len(values) >= 4 else 0,
            "trend": trend,
            "analysis_timestamp": datetime.now(timezone.utc).isoformat()
        })
    
    return results


median_bp = Blueprint("stablecoins_median", __name__)


def _register_stablecoins_median_routes(app):
    cfg: Config = app.config["APP_CFG"]

    @median_bp.route("/stablecoins/median", methods=["GET"])
    def get_stablecoin_median():
        """Return intelligent median analysis per stablecoin.
        
        Query parameters:
        - remove_outliers: bool (default: true)
        - half_life_days: float (default: 30)
        - outlier_threshold: float (default: 3.5)
        - min_samples: int (default: 3)
        """
        # Override config with query params if provided
        remove_outliers = request.args.get("remove_outliers", "true").lower() == "true"
        half_life_days = float(request.args.get("half_life_days", cfg.median_half_life_days))
        outlier_threshold = float(request.args.get("outlier_threshold", cfg.median_outlier_threshold))
        min_samples = int(request.args.get("min_samples", cfg.median_min_samples))
        
        all_keys = [k for k in list_keys(cfg, "stablecoins") if k.endswith(".parquet")]
        frames: list[pl.DataFrame] = []

        for key in sorted(all_keys):
            try:
                df = read_parquet(cfg, key)
                frames.append(df)
            except Exception as exc:
                print(f"[stablecoins/median] Skipping {key}: {exc}")
                continue

        if not frames:
            return jsonify({"count": 0, "median_supplies": []})

        combined = pl.concat(frames, how="vertical_relaxed")

        if "symbol" not in combined.columns or "ui_supply" not in combined.columns:
            return jsonify({"count": 0, "median_supplies": []})

        # Ensure scraped_at is datetime
        if combined["scraped_at"].dtype == pl.String:
            combined = combined.with_columns(
                pl.col("scraped_at").str.to_datetime(time_zone="UTC").alias("scraped_at_dt")
            )
        elif combined["scraped_at"].dtype == pl.Datetime:
            combined = combined.with_columns(
                pl.col("scraped_at").alias("scraped_at_dt")
            )
        else:
            # Try to parse as datetime with UTC timezone
            combined = combined.with_columns(
                pl.col("scraped_at").str.to_datetime(time_zone="UTC").alias("scraped_at_dt")
            )

        # Override config with query params for this request
        median_params = {
            "MEDIAN_REMOVE_OUTLIERS": str(remove_outliers).lower(),
            "MEDIAN_HALF_LIFE_DAYS": str(half_life_days),
            "MEDIAN_OUTLIER_THRESHOLD": str(outlier_threshold),
            "MEDIAN_MIN_SAMPLES": str(min_samples),
        }

        try:
            results = _intelligent_median_analysis(combined, cfg, median_params)
        finally:
            pass

        return jsonify({
            "count": len(results),
            "total_samples": len(combined),
            "median_supplies": results,
            "parameters": {
                "remove_outliers": remove_outliers,
                "half_life_days": half_life_days,
                "outlier_threshold": outlier_threshold,
                "min_samples": min_samples
            }
        })

    app.register_blueprint(median_bp)
