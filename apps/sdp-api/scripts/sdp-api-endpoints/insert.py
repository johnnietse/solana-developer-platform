"""POST /insert support — write JSON payloads as Delta tables to S3."""

from datetime import datetime, timezone

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, INSERT_BUCKET, STORAGE_OPTIONS


def insert_delta(table_name, records, timestamp=False):
    """Build a DataFrame from records and append it as a Delta table on S3.

    table_name uses dots (Databricks catalog.schema.table style); S3 uses
    slashes, so dev.mlh.polars_metrics -> s3://tmp-sdp-data/dev/mlh/polars_metrics.

    timestamp=True adds an ingested_at column; default False writes the payload
    columns exactly as given so appends match the existing table schema.
    """
    df = pl.DataFrame(records)

    if timestamp and "ingested_at" not in df.columns:
        df = df.with_columns(pl.lit(datetime.now(timezone.utc)).alias("ingested_at"))

    path = f"s3://{INSERT_BUCKET}/{table_name.replace('.', '/')}"
    df.write_delta(
        path,
        mode="append",
        storage_options=STORAGE_OPTIONS,
        credential_provider=DELTA_CREDENTIAL_PROVIDER,
    )

    return path, len(df)
