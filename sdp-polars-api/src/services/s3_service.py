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


def _session(cfg: Config) -> boto3.Session:
    """A boto3 session honouring AWS_PROFILE when one is configured."""
    return boto3.Session(profile_name=cfg.aws_profile) if cfg.aws_profile else boto3.Session()


def credentials_available(cfg: Config) -> bool:
    """Whether the AWS credential chain resolves to anything usable."""
    try:
        return _session(cfg).get_credentials() is not None
    except Exception:
        return False


def _storage_options(cfg: Config) -> dict:
    """Build Delta Lake storage options from the AWS credential chain.

    Resolved through boto3 rather than read straight off the environment.
    delta-rs does not consult ``~/.aws/credentials`` or the container
    credential endpoint itself, so reading only ``AWS_ACCESS_KEY_ID`` and
    ``AWS_SECRET_ACCESS_KEY`` breaks three common setups: a named profile, an
    SSO/STS session, and an ECS task role. All three issue temporary
    credentials that additionally require ``AWS_SESSION_TOKEN``, which the
    previous implementation never forwarded — so the Parquet write (boto3,
    full chain) would succeed while the Delta write failed.
    """
    opts = {
        "AWS_REGION": cfg.s3_region,
        "AWS_S3_ALLOW_UNSAFE_RENAME": "true",
    }

    try:
        creds = _session(cfg).get_credentials()
    except Exception:
        creds = None

    if creds is not None:
        frozen = creds.get_frozen_credentials()
        opts["AWS_ACCESS_KEY_ID"] = frozen.access_key
        opts["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
        if frozen.token:
            opts["AWS_SESSION_TOKEN"] = frozen.token

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
    path: str | None = None,
) -> str:
    """Write a Polars DataFrame as a Delta Lake table to S3.

    By default writes to ``s3://{bucket}/{DELTA_ROOT}/{table_name}/``.
    If ``path`` is given, writes to ``s3://{bucket}/{path}/`` instead
    (used by ``/insert`` to write to arbitrary S3 locations).

    Databricks can query either path as::

        SELECT * FROM delta.'s3://{bucket}/{DELTA_ROOT}/{table_name}'

    Args:
        cfg: App config.
        table_name: Table name (e.g. ``"stablecoins"``, ``"network"``).
        df: DataFrame to write.
        mode: ``"append"`` or ``"overwrite"``.
        path: If set, override the S3 path instead of ``{DELTA_ROOT}/{table_name}``.

    Returns:
        The full S3 Delta table URI.
    """
    from deltalake import write_deltalake

    if path:
        delta_uri = f"s3://{cfg.s3_bucket}/{path.strip('/')}"
    else:
        delta_uri = f"s3://{cfg.s3_bucket}/{DELTA_ROOT}/{table_name}"

    kwargs = {}
    if mode == "overwrite":
        # An overwrite replaces the table wholesale, so let the incoming schema
        # replace the stored one too. Without this delta-rs rejects any write
        # whose column set differs from the existing table.
        kwargs["schema_mode"] = "overwrite"

    # Polars exports Int128 columns (values outside the int64 range) using its
    # own Arrow format string, which pyarrow's C Data Interface importer does
    # not recognize ("Invalid or unsupported format string: '_pli128'").
    # Casting to Decimal first produces a standard decimal128 array instead.
    int128_cols = [name for name, dtype in df.schema.items() if dtype == pl.Int128]
    if int128_cols:
        df = df.with_columns(pl.col(c).cast(pl.Decimal(38, 0)) for c in int128_cols)

    write_deltalake(
        delta_uri,
        df.to_arrow(),
        mode=mode,
        storage_options=_storage_options(cfg),
        **kwargs,
    )
    return delta_uri


def scan_delta(
    cfg: Config,
    table_name: str | None = None,
    path: str | None = None,
) -> pl.LazyFrame | None:
    """Lazily scan a Delta table on S3, returning a Polars LazyFrame.

    Prefer this over :func:`read_delta` when the caller filters or selects:
    Polars pushes predicates and projections down to the scan, so only the
    matching row groups are fetched instead of the whole table.

    Returns ``None`` if the table cannot be read.
    """
    if path:
        delta_uri = f"s3://{cfg.s3_bucket}/{path.strip('/')}"
    elif table_name:
        delta_uri = f"s3://{cfg.s3_bucket}/{DELTA_ROOT}/{table_name}"
    else:
        return None

    try:
        return pl.scan_delta(delta_uri, storage_options=_storage_options(cfg))
    except Exception:
        return None


def read_delta(
    cfg: Config,
    table_name: str | None = None,
    path: str | None = None,
) -> pl.DataFrame | None:
    """Read a Delta Lake table from S3 into a Polars DataFrame.

    Provide either ``table_name`` (reads from ``{DELTA_ROOT}/{table_name}/``)
    or ``path`` (reads from an arbitrary S3 path).

    Returns ``None`` if the table doesn't exist yet.
    """
    from deltalake import DeltaTable

    if path:
        delta_uri = f"s3://{cfg.s3_bucket}/{path.strip('/')}"
    elif table_name:
        delta_uri = f"s3://{cfg.s3_bucket}/{DELTA_ROOT}/{table_name}"
    else:
        return None

    try:
        dt = DeltaTable(delta_uri, storage_options=_storage_options(cfg))
        return pl.from_arrow(dt.to_pyarrow_table())
    except Exception:
        return None
