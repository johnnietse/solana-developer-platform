# SDP Polars API — Local Setup Guide

A containerized Flask API for fetching, processing, and serving Solana
on-chain data using Polars. Data flows:

```
Solana RPC → Polars API → S3 (Parquet) → Dashboard + Databricks
```

## Prerequisites

- Docker Desktop
- AWS CLI configured with profile `sdp-user`
  ```powershell
  aws configure --profile sdp-user
  # AWS Access Key ID: (from ~/.aws/credentials)
  # AWS Secret Access Key: (from ~/.aws/credentials)
  # Default region: us-east-1
  ```
- SDP monorepo running (Postgres, Redis, SDP API, Next.js dashboard)

## Quick Start

### 1. Build and run

```powershell
cd sdp-polars-api
docker build -t sdp-polars-api .
docker run -d --name sdp-polars-api `
  -p 8081:8080 `
  -e AWS_PROFILE=sdp-user `
  -v "$env:USERPROFILE\.aws:/root/.aws:ro" `
  --network solana-developer-platform_default `
  --add-host host.docker.internal:host-gateway `
  sdp-polars-api
```

### 2. Verify

```powershell
curl.exe http://127.0.0.1:8081/health
# → {"status":"ok"}
```

### 3. Ingest data

```powershell
# One-time: fetch stablecoin supplies + network metrics
curl.exe http://127.0.0.1:8081/ingest/all

# Continuous: run the loop script in a separate terminal
.\scripts\run-ingestion-loop.ps1
```

### 4. Check the dashboard

Open http://localhost:3000 in your browser, sign in with Clerk, and
navigate to **Polars** in the sidebar.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/stablecoins?days=N` | Stablecoin supply history |
| GET | `/stablecoins/median` | Median supply per token (Polars) |
| GET | `/network?days=N` | Solana network metrics |
| GET | `/rpc?token_address=X` | Token transfers (S3 cache → RPC) |
| GET | `/tokens` | Token registry with UUIDs |
| GET | `/tokens/<uuid>` | Lookup token by UUID |
| POST | `/tokens/register` | Register a new token |
| GET | `/holders/<mint>` | Top token holders |
| POST | `/insert?table_name=X` | Write custom data to S3 |
| GET | `/ingest/stablecoins` | Trigger stablecoin snapshot |
| GET | `/ingest/network` | Trigger network snapshot |
| GET | `/ingest/all` | Trigger all snapshots |

## Data Storage

All data is written as Parquet files to `s3://tmp-sdp-data/`:

| Prefix | Contents |
|--------|----------|
| `stablecoins/YYYY-MM-DD.parquet` | Stablecoin supply snapshots |
| `network/YYYY-MM-DD.parquet` | Network metric snapshots |
| `holders/<mint>.parquet` | Top holder accounts per token |
| `rpc-cache/<token_address>.parquet` | Cached token transfers |
| `token-registry/registry.parquet` | Token UUID registry |
| `insert/<table>/YYYY-MM-DD.parquet` | User-inserted data |

## Databricks Integration

Create external tables in Databricks to query the same data:

```sql
CREATE SCHEMA IF NOT EXISTS sdp;
USE sdp;

CREATE OR REPLACE TABLE sdp.stablecoins
USING delta
LOCATION 's3://tmp-sdp-data/stablecoins/'
AS SELECT * FROM delta.`s3://tmp-sdp-data/stablecoins/';
```

See `queries/databricks-analytics.sql` for full example queries.

## Deployment (ECS Fargate)

```powershell
.\deploy\deploy-ecs.ps1
```

Requires IAM permissions: `ecr:*`, `ecs:*`, `iam:CreateRole`, `logs:CreateLogGroup`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `NoCredentialsError` | Mount AWS credentials: `-v "$env:USERPROFILE\.aws:/root/.aws:ro" -e AWS_PROFILE=sdp-user` |
| `429 Too Many Requests` | Solana RPC rate limit. Wait 30s and retry. Uses devnet RPC by default. |
| Container won't start | Check port conflict: `docker ps` to see if port 8081 is in use. |
| Dashboard shows no data | Run an initial ingest: `curl.exe http://127.0.0.1:8081/ingest/all` |
