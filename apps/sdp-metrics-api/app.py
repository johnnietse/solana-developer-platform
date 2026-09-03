"""Flask entry point for the SDP metrics API.

Every env-derived path and credential comes from config.py, which is also what
insert.py / metrics.py / rpc_cache.py read, so a request can never resolve one
location while the cache writes another.
"""

import polars as pl
from flask import Flask, jsonify, request

from config import (
    CLUSTER_RPC,
    DEFAULT_CLUSTER,
    DEFAULT_DAYS,
    DEFAULT_MINT,
    RPC_TABLE_NAME,
    S3_PARQUET_PATH,
    STORAGE_OPTIONS,
)
from insert import insert_delta
from rpc import Options, count_recent_transactions, format_timestamp
from rpc_cache import read_cached

app = Flask(__name__)

# The /rpc response is the rpc_counts table's schema, verbatim. insert_rpc.py
# aborts if these drift apart, so any change here is a change to the table.
RPC_SCHEMA = ("mint", "cluster", "days", "transactionCount", "since")

MAX_DAYS = 365


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


@app.get("/metric")
def get_data():
    df = pl.read_parquet(S3_PARQUET_PATH, storage_options=STORAGE_OPTIONS)
    return jsonify(data=df.to_dicts())


def _parse_rpc_args(args):
    """Validate /rpc's query string, returning (Options, error_message)."""
    mint = (args.get("mint") or DEFAULT_MINT).strip()
    if not mint:
        return None, "mint must not be blank"

    cluster = (args.get("cluster") or DEFAULT_CLUSTER).strip()
    if cluster not in CLUSTER_RPC:
        return None, f"cluster must be one of {', '.join(sorted(CLUSTER_RPC))}"

    raw_days = args.get("days")
    if raw_days is None or raw_days == "":
        days = DEFAULT_DAYS
    else:
        try:
            days = int(raw_days)
        except ValueError:
            return None, "days must be an integer"
        if not 1 <= days <= MAX_DAYS:
            return None, f"days must be between 1 and {MAX_DAYS}"

    # An explicit `rpc` override reaches urlopen directly, so it is deliberately
    # not something the web dashboard's proxy ever forwards from a browser.
    rpc_url = (args.get("rpc") or CLUSTER_RPC[cluster]).strip()

    include_failed = (args.get("include_failed") or "").lower() in ("1", "true", "yes")

    return (
        Options(
            mint=mint,
            cluster=cluster,
            days=days,
            rpc_url=rpc_url,
            include_failed=include_failed,
        ),
        None,
    )


@app.get("/rpc")
def get_rpc():
    options, error = _parse_rpc_args(request.args)
    if error:
        return jsonify(error=error), 400

    refresh = (request.args.get("refresh") or "").lower() in ("1", "true", "yes")

    # include_failed changes the count but is not one of the table's columns, so
    # a row written under it would be indistinguishable from a default one.
    # Those calls stay live-only rather than poisoning the shared cache.
    cacheable = not options.include_failed

    if cacheable and not refresh:
        cached = read_cached(options.mint, options.cluster, options.days)
        if cached:
            # Cache state rides in a header so the body stays byte-for-byte the
            # rpc_counts schema and insert_rpc.py can pass it through verbatim.
            return jsonify(cached), 200, {"X-Cache": "HIT"}

    try:
        total, _pages, cutoff = count_recent_transactions(options)
    except RuntimeError as exc:
        # An upstream RPC failure is the provider's problem, not a bad request.
        return jsonify(error=str(exc)), 502

    record = {
        "mint": options.mint,
        "cluster": options.cluster,
        "days": options.days,
        "transactionCount": total,
        "since": format_timestamp(cutoff),
    }

    if cacheable:
        try:
            insert_delta(RPC_TABLE_NAME, [record])
        except Exception as exc:  # noqa: BLE001 - cache writes must never fail a read
            # No AWS credentials locally is the common case; the caller still
            # gets a correct answer, it just costs a live RPC read next time.
            app.logger.warning("rpc cache write to %s failed: %s", RPC_TABLE_NAME, exc)

    return jsonify(record), 200, {"X-Cache": "MISS"}


@app.post("/insert")
def insert_table():
    table_name = request.args.get("table_name")
    if not table_name:
        return jsonify(error="table_name query param is required"), 400

    payload = request.get_json(silent=True)
    # insert_rpc.py posts {"data": [...]}; the bare array form predates it and
    # still works, so both are accepted rather than breaking either caller.
    rows = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not rows:
        return jsonify(error="request body must be a non-empty JSON array of row objects"), 400

    mode = request.args.get("mode", "append")
    if mode not in ("append", "overwrite"):
        return jsonify(error="mode must be 'append' or 'overwrite'"), 400

    timestamp = (request.args.get("timestamp") or "").lower() in ("1", "true", "yes")

    path, written = insert_delta(table_name, rows, timestamp=timestamp, mode=mode)

    return jsonify(table_name=table_name, path=path, mode=mode, rows_written=written), 201


if __name__ == "__main__":
    import os

    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
