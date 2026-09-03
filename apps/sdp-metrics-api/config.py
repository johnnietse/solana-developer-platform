import os

import polars as pl
from dotenv import load_dotenv

# Every path and credential below is resolved at import time, and this module is
# what app.py and the CLI scripts read them through, so .env has to land in
# os.environ before the first env() call rather than in each entry point.
load_dotenv()


def env(name, default=None):
    # A blank `KEY=` line in a sourced .env sets the var to "" rather than
    # leaving it unset, so treat blank the same as unset instead of letting
    # it silently override a working default.
    value = os.environ.get(name)
    return value if value else default


if not os.environ.get("AWS_PROFILE"):
    os.environ.pop("AWS_PROFILE", None)


S3_METRICS_TABLE_PATH = env("S3_METRICS_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics")
S3_METRICS_VALUES_TABLE_PATH = env(
    "S3_METRICS_VALUES_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics_values"
)
S3_PARQUET_PATH = env(
    "S3_PARQUET_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics_values/**/*.parquet"
)
RPC_URL = env("SOLANA_RPC_URL", "https://api.devnet.solana.com")
INSERT_BUCKET = env("S3_INSERT_BUCKET", "tmp-sdp-data")

# /rpc caches its answers here. The read path is derived from the same dotted
# name insert_delta() writes to, so the cache can never read one location while
# writing another: dev.mlh.rpc_counts -> s3://tmp-sdp-data/dev/mlh/rpc_counts.
#
# Deliberately NOT dev.mlh.rpc: that path holds the old per-signature table
# (mint, cluster, signature, slot, block_time, failed, fetched_at) written by
# the retired sdp-polars-api. These rows are one-per-window aggregates, so
# appending them there fails on a 5-vs-7 field schema mismatch -- which app.py
# swallows, leaving every call a live RPC read.
RPC_TABLE_NAME = env("RPC_TABLE_NAME", "dev.mlh.rpc_counts")
S3_RPC_TABLE_PATH = env(
    "S3_RPC_TABLE_PATH", f"s3://{INSERT_BUCKET}/{RPC_TABLE_NAME.replace('.', '/')}"
)
RPC_CACHE_TTL_SECONDS = int(env("RPC_CACHE_TTL_SECONDS", "3600"))

STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": env("AWS_REGION", "us-east-1"),
        "aws_access_key_id": env("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": env("AWS_SECRET_ACCESS_KEY"),
    }.items()
    if value
}

DELTA_CREDENTIAL_PROVIDER = None
if not STORAGE_OPTIONS.get("aws_access_key_id") and env("AWS_PROFILE"):
    DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS(profile_name=os.environ["AWS_PROFILE"])

DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DEFAULT_CLUSTER = "devnet"
DEFAULT_DAYS = 30
PAGE_SIZE = 1000

CLUSTER_RPC = {
    "devnet": "https://api.devnet.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    "testnet": "https://api.testnet.solana.com",
}
