# Message to Waddah

**Status:** NOT SENT — Waddah not found in connected Slack workspace (Johnnie Tse's Workspace).

## What's Done
- ✅ Full pipeline running in Docker, auto-ingests every 15 min
- ✅ 6 Delta tables landing at `s3://tmp-sdp-data/dev/mlh/sdp_data/`:
  `stablecoins`, `network`, `holders`, `whales`, `validators`, `events`
- ✅ External Location `s3://tmp-sdp-data/` is working (confirmed data accessible)

## What We Need From You

**Paste this in your Databricks SQL Editor and run:**

```sql
CREATE CATALOG IF NOT EXISTS sdp MANAGED LOCATION 's3://tmp-sdp-data/';
CREATE SCHEMA IF NOT EXISTS sdp.raw;

CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.stablecoins USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/stablecoins/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.network USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/network/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.holders USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/holders/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.whales USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/whales/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.validators USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/validators/';
CREATE EXTERNAL TABLE IF NOT EXISTS sdp.raw.events USING DELTA LOCATION 's3://tmp-sdp-data/dev/mlh/sdp_data/events/';
```

That's it — 8 lines, one-time setup. Data auto-refreshes every 15 min.

## To send this
You need to reach Waddah — either:
1. Invite him to your Slack workspace (Johnnie Tse's Workspace)
2. Or DM him in the MLH Fellowship / Solana Dev Platform workspace
3. Or email him
