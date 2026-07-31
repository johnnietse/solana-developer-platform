import json
import os
import time
import urllib.error
import urllib.request

import boto3
import polars as pl
from botocore.exceptions import ClientError
from flask import Flask, jsonify, request

app = Flask(__name__)

S3_PARQUET_PATH = os.environ.get(
    "S3_PARQUET_PATH", "s3://tmp-sdp-data/dev/mlh/polars_metrics_values/**/*.parquet"
)
S3_RPC_CACHE_PATH = os.environ.get("S3_RPC_CACHE_PATH", "s3://tmp-sdp-data/rpc-cache")
RPC_URL = os.environ.get("SOLANA_RPC_URL", "https://api.devnet.solana.com")
INSERT_BUCKET = os.environ.get("S3_INSERT_BUCKET", "tmp-sdp-data")

# Static keys if they're set, otherwise polars falls back to the default AWS
# chain (~/.aws/credentials, ECS task role, instance profile).
STORAGE_OPTIONS = {
    key: value
    for key, value in {
        "aws_region": os.environ.get("AWS_REGION", "us-east-1"),
        "aws_access_key_id": os.environ.get("AWS_ACCESS_KEY_ID"),
        "aws_secret_access_key": os.environ.get("AWS_SECRET_ACCESS_KEY"),
        "aws_session_token": os.environ.get("AWS_SESSION_TOKEN"),
    }.items()
    if value
}

_CACHE_BUCKET, _CACHE_PREFIX = S3_RPC_CACHE_PATH.removeprefix("s3://").split("/", 1)
s3 = boto3.client(
    "s3",
    region_name=STORAGE_OPTIONS.get("aws_region", "us-east-1"),
    **{k: v for k, v in STORAGE_OPTIONS.items() if k != "aws_region"},
)


def _rpc(method, params, retries=5):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC_URL, data=body, headers={"Content-Type": "application/json"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.load(resp)["result"]
        except urllib.error.HTTPError as exc:
            # Public RPC endpoints rate-limit hard; back off and retry rather
            # than fail a request that's fetching ~100 transactions in a row.
            if exc.code != 429 or attempt == retries - 1:
                raise
            time.sleep(2**attempt)


def _fetch_transfers(address):
    signatures = _rpc("getSignaturesForAddress", [address, {"limit": 100}])
    transfers = []
    for sig in signatures:
        # Each transaction can hold several transfers (CPIs through a single
        # swap/route), so 100 transfers is usually reached well before 100
        # transactions are fetched — stopping early avoids hammering a free
        # public RPC with calls the response doesn't need.
        if len(transfers) >= 100:
            break
        time.sleep(0.1)
        tx = _rpc(
            "getTransaction",
            [sig["signature"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}],
        )
        if not tx:
            continue
        instructions = list(tx["transaction"]["message"]["instructions"])
        # Most transfers on active tokens happen as CPIs (DEX/router swaps)
        # rather than top-level instructions, so inner instructions matter too.
        for group in (tx.get("meta") or {}).get("innerInstructions") or []:
            instructions.extend(group["instructions"])
        for ix in instructions:
            # Only SPL Token program instructions are token transfers. Other
            # programs' `parsed` field isn't even always a dict — spl-memo's
            # is the raw memo string — so this check must come first.
            if ix.get("program") != "spl-token":
                continue
            parsed = ix.get("parsed")
            if not parsed or parsed.get("type") not in ("transfer", "transferChecked"):
                continue
            info = parsed["info"]
            transfers.append(
                {
                    "signature": sig["signature"],
                    "blockTime": tx.get("blockTime"),
                    "source": info.get("source"),
                    "destination": info.get("destination"),
                    "amount": info.get("amount") or (info.get("tokenAmount") or {}).get("amount"),
                }
            )
    return transfers[:100]


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


@app.get("/metric")
def get_data():
    df = pl.read_parquet(S3_PARQUET_PATH, storage_options=STORAGE_OPTIONS)
    return jsonify(data=df.to_dicts())


@app.get("/rpc")
def get_rpc():
    address = request.args.get("address")
    if not address:
        return jsonify(error="address query param is required"), 400

    key = f"{_CACHE_PREFIX.rstrip('/')}/{address}.json"

    try:
        cached = s3.get_object(Bucket=_CACHE_BUCKET, Key=key)
        return jsonify(data=json.loads(cached["Body"].read()), source="s3")
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("NoSuchKey", "404"):
            raise

    transfers = _fetch_transfers(address)
    s3.put_object(
        Bucket=_CACHE_BUCKET, Key=key, Body=json.dumps(transfers).encode(), ContentType="application/json"
    )
    return jsonify(data=transfers, source="rpc")


@app.post("/insert")
def insert_table():
    table_name = request.args.get("table_name")
    if not table_name:
        return jsonify(error="table_name query param is required"), 400

    mode = request.args.get("mode", "append")
    if mode not in ("append", "overwrite"):
        return jsonify(error="mode must be 'append' or 'overwrite'"), 400

    rows = request.get_json(silent=True)
    if not isinstance(rows, list) or not rows:
        return jsonify(error="request body must be a non-empty JSON array of row objects"), 400

    # table_name uses dots (Databricks catalog.schema.table style); S3 uses
    # slashes, so dev.mlh.polars_metrics -> s3://tmp-sdp-data/dev/mlh/polars_metrics.
    path = f"s3://{INSERT_BUCKET}/{table_name.replace('.', '/')}"
    df = pl.DataFrame(rows)
    df.write_delta(path, mode=mode, storage_options=STORAGE_OPTIONS)

    return jsonify(table_name=table_name, path=path, mode=mode, rows_written=df.height), 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
