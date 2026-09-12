"""Superseded. Kept for reference, not imported by anything here.

`latest_metrics` below is a copy of the catalog join that `sdp-polars-api`
actually ships and serves, at sdp-polars-api/src/routes/metrics.py. This
service registers no route that calls it, and nothing else in the repository
imports this module.

Do not edit this to fix a `/metrics` bug - you would be editing the copy that
is not running. Change sdp-polars-api instead. This file is left in place only
so the duplication is visible rather than silently rediscovered.
"""

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, STORAGE_OPTIONS


def read_delta(path):
    return pl.read_delta(path, storage_options=STORAGE_OPTIONS, credential_provider=DELTA_CREDENTIAL_PROVIDER)


def latest_metrics(metrics_path, values_path):
    metrics_df = read_delta(metrics_path)
    values_df = read_delta(values_path)

    if metrics_df.is_empty() or values_df.is_empty():
        return None, None

    latest_date = values_df["date"].max()
    latest_values = values_df.filter(pl.col("date") == latest_date)

    metrics = (
        metrics_df.join(latest_values, left_on="id", right_on="metric_id", how="inner")
        .group_by(["id", "name", "description", "tab", "unit"])
        .agg(pl.struct(["provider_id", "value"]).alias("values"))
        .sort("id")
        .to_dicts()
    )

    return metrics, latest_date
