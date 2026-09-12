# sdp-metrics-api

Flask API serving Solana RPC counts and transfer data, backed by Delta tables in S3, using Polars as the data framework.

## Endpoints

- `GET /healthz` — liveness check. Never touches S3.
- `GET /rpc` — transaction count for one SPL mint over a lookback window, cached as a Delta table on S3 (see below).
- `GET /rpc/series` — per-day counts for the same mint, for plotting. Takes the same query string as `/rpc`. Deliberately a separate route: `/rpc`'s body *is* the `rpc_counts` Delta schema and cannot grow fields, whereas this is a read-only view whose shape is not a table, so it is not cached to Delta.
- `POST /insert?table_name=X` — writes a JSON payload to S3 as a Delta table (Databricks-readable). Accepts either a bare array or `{"data": [...]}`; `mode` is `append` (default) or `overwrite`.

### There is no `/metrics` here

This service does not serve metrics, despite its name. Two other services do, and
which one you want depends on the shape:

| you want | ask |
|----------|-----|
| the analytics overview — stablecoins, holder counts, supply history | `sdp-api`, `GET /v1/data-products/analytics`, which reads Databricks |
| the metric catalog — every metric id with its current value per provider | `sdp-polars-api`, `GET /metrics`, which reads `dev/mlh/polars_metrics_values` |

An earlier version of this README documented a `/metrics` route on this service.
It was never implemented: `app.py` registers `/metric` (singular), which returns
the raw values table rather than either shape above, and nothing in the repository
calls it. `metrics.py` in this directory holds a copy of the catalog-join logic
that `sdp-polars-api` actually ships, and has no callers.

### `GET /rpc`

Counts the signatures for one SPL mint over a lookback window.

| param            | default               | notes                                             |
| ---------------- | --------------------- | ------------------------------------------------- |
| `mint`           | `config.DEFAULT_MINT` | SPL mint address                                  |
| `cluster`        | `devnet`              | `devnet` / `mainnet-beta` / `testnet`             |
| `days`           | `30`                  | 1-365                                             |
| `refresh`        | off                   | `true` bypasses the cache                         |
| `include_failed` | off                   | counts failed txs; never cached (see below)       |
| `rpc`            | cluster default       | overrides the RPC URL — never expose to a browser |

The response body **is** the `dev.mlh.rpc_counts` Delta schema, so `insert_rpc.py`
appends it verbatim. Changing these keys changes the table:

| column             | type                           |
| ------------------ | ------------------------------ |
| `mint`             | str                            |
| `cluster`          | str                            |
| `days`             | i64                            |
| `transactionCount` | i64                            |
| `since`            | str (`%Y-%m-%dT%H:%M:%S.000Z`) |

Cache state is reported in the `X-Cache: HIT|MISS` response header rather than in
the body, which keeps the body byte-for-byte the table schema. A cache write that
fails (no AWS credentials, say) is logged and the request still succeeds — it just
costs a live RPC read next time. `include_failed` changes the count but is not one
of the columns, so those calls are answered live and never cached.

### Delta table schema

Mirrors the `analytics_cache` table from `docs/superpowers/plans/2026-07-08-analytics-databricks-enrichment.md`:

| column         | type      |
| -------------- | --------- |
| `response_json`| STRING (JSON: `stablecoins`, `holders`, `holdersHistory`, `supplyHistory`, `lastUpdated`) |
| `holder_count` | BIGINT    |
| `total_supply` | DOUBLE    |
| `snapshot_at`  | TIMESTAMP |

`S3_DELTA_TABLE_PATH` defaults to `s3://tmp-sdp-data/dev/mlh` — **this is a placeholder pointing at the `tmp-sdp-data` bucket with a guessed key prefix. Confirm the real prefix and override it** via env var (see `.env.example`).

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env   # edit S3_DELTA_TABLE_PATH / AWS_REGION
set -a && source .env && set +a
.venv/bin/python app.py
```

### AWS credentials

Resolved in this order:

1. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (plus optional `AWS_SESSION_TOKEN`), passed straight to Polars as storage options.
2. `AWS_PROFILE`, resolved through boto3 (`pl.CredentialProviderAWS`), which is what makes named and SSO profiles work and refreshes tokens as they expire. An unknown profile fails immediately with botocore's `ProfileNotFound`.
3. Otherwise the default chain — ECS task role, instance profile, `~/.aws/credentials`.

`AWS_PROFILE` must **not** be passed as a `storage_options` key: `object_store` has no such config key, ignores it silently, and then falls through to the EC2 instance-metadata endpoint, turning a typo'd profile name into a confusing IMDS timeout.

## Test

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -v
```

## Docker

```bash
docker build -t sdp-metrics-api -f Dockerfile .
docker run --rm -p 8080:8080 \
  -e S3_DELTA_TABLE_PATH=s3://tmp-sdp-data/dev/mlh \
  -e AWS_REGION=us-east-1 \
  -e AWS_PROFILE=your-profile \
  -v ~/.aws:/home/metrics/.aws:ro \
  sdp-metrics-api
```

## Deploy to ECS

See [`infra/cdk/README.md`](infra/cdk/README.md).
