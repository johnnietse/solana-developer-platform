import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

import polars as pl
from flask import Flask, jsonify, request

app = Flask(__name__)


def _env(name, default=None):
    # A blank `KEY=` line in a sourced .env sets the var to "" rather than
    # leaving it unset, so treat blank the same as unset instead of letting
    # it silently override a working default.
    value = os.environ.get(name)
    return value if value else default



if not os.environ.get("AWS_PROFILE"):
    os.environ.pop("AWS_PROFILE", None)



S3_METRICS_TABLE_PATH = _env("S3_METRICS_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics")
S3_METRICS_VALUES_TABLE_PATH = _env(
    "S3_METRICS_VALUES_TABLE_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics_values"
)
RPC_URL = _env("SOLANA_RPC_URL", "https://api.devnet.solana.com")
INSERT_BUCKET = _env("S3_INSERT_BUCKET", "tmp-sdp-data")


STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": _env("AWS_REGION", "us-east-1"),
        "aws_access_key_id": _env("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": _env("AWS_SECRET_ACCESS_KEY"),
    }.items()
    if value
}


_DELTA_CREDENTIAL_PROVIDER = None
if not STORAGE_OPTIONS.get("aws_access_key_id") and _env("AWS_PROFILE"):
    _DELTA_CREDENTIAL_PROVIDER = pl.CredentialProviderAWS(profile_name=os.environ["AWS_PROFILE"])

DEFAULT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
DEFAULT_CLUSTER = "devnet"
DEFAULT_DAYS = 30
PAGE_SIZE = 1000

CLUSTER_RPC = {
    "devnet": "https://api.devnet.solana.com",
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    "testnet": "https://api.testnet.solana.com",
}


@dataclass
class Options:
    mint: str
    cluster: str
    days: int
    rpc_url: str
    include_failed: bool


def solana_rpc(rpc_url, method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"RPC HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"RPC request failed: {exc.reason}") from exc

    if body.get("error"):
        message = body["error"].get("message", "Unknown RPC error")
        raise RuntimeError(message)

    return body["result"]


def count_recent_transactions(options):
    cutoff = int(time.time()) - options.days * 24 * 60 * 60
    before = None
    total = 0
    pages = 0

    while True:
        query = {"limit": PAGE_SIZE}
        if before:
            query["before"] = before

        signatures = solana_rpc(
            options.rpc_url,
            "getSignaturesForAddress",
            [options.mint, query],
        )

        if not signatures:
            break

        pages += 1

        for entry in signatures:
            block_time = entry.get("blockTime")
            if block_time is not None and block_time < cutoff:
                return total, pages, cutoff

            if not options.include_failed and entry.get("err") is not None:
                continue

            total += 1

        before = signatures[-1]["signature"]

        if len(signatures) < PAGE_SIZE:
            break

    return total, pages, cutoff


def format_timestamp(unix_seconds):
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


def _read_delta(path):
    return pl.read_delta(path, storage_options=STORAGE_OPTIONS, credential_provider=_DELTA_CREDENTIAL_PROVIDER)


@app.get("/metrics")
def get_metrics():
    try:
        metrics_df = _read_delta(S3_METRICS_TABLE_PATH)
        values_df = _read_delta(S3_METRICS_VALUES_TABLE_PATH)
    except Exception:
        return jsonify(error="unable to read polars_metrics/polars_metrics_values Delta tables"), 503

    if metrics_df.is_empty() or values_df.is_empty():
        return jsonify(error="polars_metrics/polars_metrics_values Delta tables have no rows"), 503

    latest_date = values_df["date"].max()
    latest_values = values_df.filter(pl.col("date") == latest_date)

    metrics = (
        metrics_df.join(latest_values, left_on="id", right_on="metric_id", how="inner")
        .group_by(["id", "name", "description", "tab", "unit"])
        .agg(pl.struct(["provider_id", "value"]).alias("values"))
        .sort("id")
        .to_dicts()
    )

    return jsonify(data=metrics, date=str(latest_date))


@app.get("/rpc")
def get_rpc():
    mint = request.args.get("mint", DEFAULT_MINT)
    cluster = request.args.get("cluster", DEFAULT_CLUSTER)
    days = int(request.args.get("days", DEFAULT_DAYS))
    rpc_url = request.args.get("rpc") or _env("SOLANA_RPC_URL") or CLUSTER_RPC[cluster]

    options = Options(mint=mint, cluster=cluster, days=days, rpc_url=rpc_url, include_failed=False)
    total, _pages, cutoff = count_recent_transactions(options)

    return jsonify(mint=mint, cluster=cluster, days=days, transactionCount=total, since=format_timestamp(cutoff))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
