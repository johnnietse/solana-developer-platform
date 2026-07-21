"""S3 read/write service using Polars + boto3 + Delta Lake."""

from __future__ import annotations

import polars as pl
import boto3
from botocore.config import Config as BotoConfig
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from config import Config


# ── Delta Lake storage options (resolved from config) ───────────────────

DELTA_ROOT = "dev/mlh/sdp_data"  # Waddah's suggested path prefix


def _storage_options(cfg: Config) -> dict:
    """Build Delta Lake storage options from the AWS credential chain."""
    opts = {
        "AWS_REGION": cfg.s3_region,
        "AWS_S3_ALLOW_UNSAFE_RENAME": "true",
    }
    # Try explicit keys from env first, then fall back to profile
    import os
    ak = os.environ.get("AWS_ACCESS_KEY_ID")
    sk = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if ak and sk:
        opts["AWS_ACCESS_KEY_ID"] = ak
        opts["AWS_SECRET_ACCESS_KEY"] = sk
    return opts


def _client(cfg: Config):
    """Create an S3 client using the default credential chain."""
    return boto3.client(
        "s3",
        region_name=cfg.s3_region,
        config=BotoConfig(retries={"max_attempts": 3, "mode": "adaptive"}),
    )


# ── Parquet (legacy) ─────────────────────────────────────────────────────


def read_parquet(cfg: Config, s3_key: str) -> pl.DataFrame:
    """Read a Parquet file from S3 into a Polars DataFrame."""
    s3 = _client(cfg)
    obj = s3.get_object(Bucket=cfg.s3_bucket, Key=s3_key)
    return pl.read_parquet(obj["Body"])


def write_parquet(
    cfg: Config, s3_key: str, df: pl.DataFrame
) -> None:
    """Write a Polars DataFrame as Parquet to S3."""
    tmp = Path(f"/tmp/{s3_key.replace('/', '_')}")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(tmp)
    try:
        s3 = _client(cfg)
        s3.upload_file(str(tmp), cfg.s3_bucket, s3_key)
    finally:
        tmp.unlink(missing_ok=True)


def key_exists(cfg: Config, s3_key: str) -> bool:
    """Check whether an S3 object exists."""
    s3 = _client(cfg)
    try:
        s3.head_object(Bucket=cfg.s3_bucket, Key=s3_key)
        return True
    except Exception:
        return False


def list_keys(cfg: Config, prefix: str) -> list[str]:
    """List all S3 object keys under a prefix."""
    s3 = _client(cfg)
    keys: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return keys


# ── Delta Lake (Databricks-readable) ────────────────────────────────────


def write_delta(
    cfg: Config,
    table_name: str,
    df: pl.DataFrame,
    mode: str = "append",
) -> str:
    """Write a Polars DataFrame as a Delta Lake table to S3.

    The table is written to ``s3://{bucket}/{DELTA_ROOT}/{table_name}/``,
    which Databricks can query as::

        SELECT * FROM delta.'s3://{bucket}/{DELTA_ROOT}/{table_name}'

    Args:
        cfg: App config.
        table_name: Table name (e.g. ``"stablecoins"``, ``"network"``).
        df: DataFrame to write.
        mode: ``"append"`` or ``"overwrite"``.

    Returns:
        The full S3 Delta table URI.
    """
    from deltalake import write_deltalake

    delta_uri = f"s3://{cfg.s3_bucket}/{DELTA_ROOT}/{table_name}"
    write_deltalake(
        delta_uri,
        df.to_arrow(),
        mode=mode,
        storage_options=_storage_options(cfg),
    )
    return delta_uri


def read_delta(
    cfg: Config,
    table_name: str,
) -> pl.DataFrame | None:
    """Read a Delta Lake table from S3 into a Polars DataFrame.

    Returns ``None`` if the table doesn't exist yet.
    """
    from deltalake import DeltaTable

    delta_uri = f"s3://{cfg.s3_bucket}/{DELTA_ROOT}/{table_name}"
    try:
        dt = DeltaTable(delta_uri, storage_options=_storage_options(cfg))
        return pl.from_arrow(dt.to_pyarrow_table())
    except Exception:
        return None
