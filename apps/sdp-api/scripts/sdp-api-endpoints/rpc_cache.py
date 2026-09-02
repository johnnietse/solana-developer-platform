"""S3 cache for GET /rpc — read side.

The cache is a Delta table at s3://tmp-sdp-data/dev/mlh/rpc holding one row per
transfer. Writes go through insert_delta(), the same function POST /insert
uses, so there is one write path to S3 rather than two that can drift apart.

The read side lives here because it is a different concern from talking to the
RPC: rpc.py knows Solana, this knows the cache.
"""

import polars as pl

from config import DELTA_CREDENTIAL_PROVIDER, RPC_TABLE_PATH, STORAGE_OPTIONS


def read_cached_transfers(mint, cluster, limit):
    """Return up to `limit` cached transfers for a mint, newest first.

    Returns [] when the table does not exist yet, which is the normal state on
    the first call rather than an error. A missing table and an unreadable one
    are deliberately not distinguished here: either way the caller's next move
    is to go to the RPC.
    """
    try:
        frame = pl.scan_delta(
            RPC_TABLE_PATH,
            storage_options=STORAGE_OPTIONS,
            credential_provider=DELTA_CREDENTIAL_PROVIDER,
        )
    except Exception:
        return []

    try:
        rows = (
            frame.filter((pl.col("mint") == mint) & (pl.col("cluster") == cluster))
            # block_time is null for transactions the cluster has not timestamped
            # yet; nulls_last keeps those from sorting above real recent rows.
            .sort("block_time", descending=True, nulls_last=True)
            .limit(limit)
            .collect()
        )
    except Exception:
        return []

    return rows.to_dicts()


def cached_signatures(mint, cluster):
    """Every signature already cached for this mint, as a set.

    Used to write only what is missing. Delta appends do not deduplicate, so
    without this every request would re-append the same rows and the table
    would grow without bound while returning the same 100 transfers.
    """
    try:
        frame = pl.scan_delta(
            RPC_TABLE_PATH,
            storage_options=STORAGE_OPTIONS,
            credential_provider=DELTA_CREDENTIAL_PROVIDER,
        )
        rows = (
            frame.filter((pl.col("mint") == mint) & (pl.col("cluster") == cluster))
            .select("signature")
            .collect()
        )
    except Exception:
        return set()

    return set(rows["signature"].to_list())
