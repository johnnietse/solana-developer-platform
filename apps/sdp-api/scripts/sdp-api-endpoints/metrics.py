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
