import hmac
import os

from flask import Flask, jsonify, request

from config import (
    ALLOW_RPC_URL_OVERRIDE,
    API_WRITE_TOKEN,
    CLUSTER_RPC,
    DEFAULT_CLUSTER,
    DEFAULT_MINT,
    DEFAULT_TRANSFER_LIMIT,
    INSERT_TABLE_PREFIX,
    RPC_TABLE_NAME,
    S3_METRICS_TABLE_PATH,
    S3_METRICS_VALUES_TABLE_PATH,
    env,
)
from insert import insert_delta
from metrics import latest_metrics
from rpc import fetch_transfers
from rpc_cache import cached_signatures, read_cached_transfers

app = Flask(__name__)


@app.get("/healthz")
def healthz():
    return jsonify(status="ok")


@app.get("/metrics")
def get_metrics():
    try:
        metrics, latest_date = latest_metrics(S3_METRICS_TABLE_PATH, S3_METRICS_VALUES_TABLE_PATH)
    except Exception:
        return jsonify(error="unable to read polars_metrics/polars_metrics_values Delta tables"), 503

    if metrics is None:
        return jsonify(error="polars_metrics/polars_metrics_values Delta tables have no rows"), 503

    return jsonify(data=metrics, date=str(latest_date))


def _rpc_response(payload, cache_status, cache_write=None):
    """Attach cache state to a /rpc reply as headers rather than body keys.

    Adapted from Ari's PR #18, whose reasoning is worth keeping verbatim: the
    body doubles as the Delta table's schema, so an added key changes the
    table. Cache state is operational metadata about how the answer was
    obtained, not a fact about the chain, and it does not belong in rows that
    Databricks will later read.

    X-Cache:       HIT  — served from dev/mlh/rpc without calling the chain
                   MISS — fetched from the RPC
    X-Cache-Write: ok | failed — only present when a write was attempted
    """
    response = jsonify(**payload)
    response.headers["X-Cache"] = cache_status
    if cache_write is not None:
        response.headers["X-Cache-Write"] = "ok" if cache_write else "failed"
    return response


@app.get("/rpc")
def get_rpc():
    """Return the last N transfers for a mint, S3 first, RPC only on a miss.

        1. read the Delta cache at dev/mlh/rpc
        2. if it already holds `limit` rows for this mint, return them
        3. otherwise call the RPC, append only the signatures not already
           cached, and return the result

    Only the missing signatures are written because a Delta append does not
    deduplicate: re-appending the same rows every request would grow the table
    without adding anything to it.
    """
    mint = request.args.get("mint", DEFAULT_MINT)
    cluster = request.args.get("cluster", DEFAULT_CLUSTER)

    if cluster not in CLUSTER_RPC:
        return jsonify(
            error="unknown cluster",
            detail=f"cluster must be one of {sorted(CLUSTER_RPC)}",
        ), 400

    # ?rpc= lets the caller name the host this server will connect to. That is
    # an SSRF primitive, and this host answers IMDS on 169.254.169.254 without
    # a token, so it stays off unless explicitly enabled. cluster= already
    # covers picking a network.
    override = request.args.get("rpc")
    if override and not ALLOW_RPC_URL_OVERRIDE:
        return jsonify(
            error="rpc override is disabled",
            detail="select a network with ?cluster= instead",
        ), 400

    rpc_url = (override if ALLOW_RPC_URL_OVERRIDE and override else None) \
        or env("SOLANA_RPC_URL") or CLUSTER_RPC[cluster]

    try:
        limit = int(request.args.get("limit", DEFAULT_TRANSFER_LIMIT))
    except ValueError:
        return jsonify(error="limit must be an integer"), 400
    limit = min(max(limit, 1), 1000)

    refresh = request.args.get("refresh", "false").lower() == "true"

    if not refresh:
        cached = read_cached_transfers(mint, cluster, limit)
        if len(cached) >= limit:
            return _rpc_response({
                "mint": mint,
                "cluster": cluster,
                "limit": limit,
                "source": "s3",
                "table": RPC_TABLE_NAME,
                "count": len(cached),
                "newly_cached": 0,
                "transfers": cached,
            }, "HIT")

    try:
        transfers = fetch_transfers(mint, cluster, rpc_url, limit)
    except Exception as exc:
        # Echo the request back alongside the error. The success and
        # cache-failure paths both return mint/cluster/limit, and a caller
        # holding several in-flight requests cannot tell which one failed from
        # {error, detail} alone.
        return jsonify(
            mint=mint,
            cluster=cluster,
            limit=limit,
            source="rpc",
            error="Solana RPC request failed",
            detail=str(exc),
        ), 502

    # Write back only what the cache does not already hold.
    newly_cached = 0
    known = cached_signatures(mint, cluster)
    missing = [row for row in transfers if row["signature"] not in known]
    if missing:
        try:
            insert_delta(RPC_TABLE_NAME, missing)
            newly_cached = len(missing)
        except Exception as exc:
            # The caller asked for transfers and we have them. A cache write
            # failure is reported alongside the data rather than replacing it
            # with a 502 — the request itself succeeded, and losing an answer
            # the RPC was already paid for would be the worse outcome.
            return _rpc_response({
                "mint": mint,
                "cluster": cluster,
                "limit": limit,
                "source": "rpc",
                "table": RPC_TABLE_NAME,
                "count": len(transfers),
                "newly_cached": 0,
                "cache_error": str(exc),
                "transfers": transfers,
            }, "MISS", cache_write=False)

    # None when there was nothing to write, so the header is omitted entirely.
    # Reporting "failed" for an attempt that never happened would be a lie —
    # every signature was already cached, which is a success.
    return _rpc_response({
        "mint": mint,
        "cluster": cluster,
        "limit": limit,
        "source": "rpc",
        "table": RPC_TABLE_NAME,
        "count": len(transfers),
        "newly_cached": newly_cached,
        "transfers": transfers,
    }, "MISS", cache_write=True if missing else None)


@app.post("/insert")
def insert_endpoint():
    # Fail closed: no token configured means writes are off, not open.
    if not API_WRITE_TOKEN:
        return jsonify(
            error="write endpoint is not configured",
            detail="set API_WRITE_TOKEN to enable POST /insert",
        ), 503

    # compare_digest so a wrong token cannot be recovered by timing the reply.
    supplied = request.headers.get("X-API-Token", "")
    if not hmac.compare_digest(supplied, API_WRITE_TOKEN):
        return jsonify(error="unauthorized", detail="X-API-Token header required"), 401

    table_name = request.args.get("table_name")
    if not table_name:
        return jsonify(error="table_name query param is required"), 400

    # Confine writes to one prefix. Without this, table_name addresses any key
    # in the bucket — including dev/mlh/polars_metrics_values, which the
    # dashboard reads and Databricks owns.
    if not table_name.startswith(INSERT_TABLE_PREFIX):
        return jsonify(
            error="table_name outside the permitted prefix",
            detail=f"must start with {INSERT_TABLE_PREFIX}",
        ), 400

    # Dots become slashes, so anything else that carries path meaning is
    # rejected rather than normalized — a rule you can read is worth more than
    # a sanitizer you have to trust.
    if "/" in table_name or "\\" in table_name or ".." in table_name:
        return jsonify(
            error="invalid table_name",
            detail="use dotted names only, e.g. dev.mlh.my_table",
        ), 400

    body = request.get_json(silent=True)
    if not body or not isinstance(body.get("data"), list) or not body["data"]:
        return jsonify(error="request body must contain a non-empty 'data' array"), 400

    records = body["data"]
    if not all(isinstance(record, dict) for record in records):
        return jsonify(error="'data' must contain objects, not scalars or arrays"), 400

    timestamp = request.args.get("timestamp", "false").lower() == "true"

    try:
        path, rows = insert_delta(table_name, records, timestamp=timestamp)
    except Exception as exc:
        return jsonify(error="Delta write to S3 failed", detail=str(exc)), 502

    return jsonify(table_name=table_name, path=path, rows_written=rows), 201


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
