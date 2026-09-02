> **Note (July 24, 2026):** This is the current state of the repo before any changes from this morning's (July 24) meeting with Waddah. External Tables on Databricks still need to be created via SQL Editor (`CREATE TABLE ... USING delta LOCATION ...`).

---

# SDP Polars API — Fellowship Contributions

## What I've Built

A Solana data ingestion pipeline using **Polars + Flask + Delta Lake**:

| Component | What it does |
|-----------|-------------|
| `GET /ingest/all` | Fetches Solana devnet data every 15 min (stablecoins, network, holders, whales, validators, events) |
| `GET /stablecoins?days=N` | Stablecoin supply history (USDC, PYUSD on devnet) |
| `GET /stablecoins/median` | Median supply per token (Polars) |
| `GET /network?days=N` | Solana network metrics (TPS, SOL supply, epoch) |
| `GET /holders/<mint>` | Top token holders |
| `GET /rpc?token_address=X` | Token transfers from RPC, cached as Delta on S3 |
| `POST /insert?table_name=X` | Write custom data to S3 as Delta (Databricks-readable) |

**Data flows:** `Solana RPC → Polars API → S3 Delta Lake → Databricks External Tables`

**Repo:** [github.com/johnnietse/solana-developer-platform](https://github.com/johnnietse/solana-developer-platform)

## Waddah's Task Spec

From Jul 17:
> `select * from delta.'s3://tmp-sdp-data/dev/mlh/sdp_data'`
>
> Implement `/insert` to S3. Must be readable on Databricks.
> Implement `/rpc` endpoint (start with just RPC response).
> Implement `/metrics` through Polars.

---

# Solana Developer Platform

Solana Developer Platform (SDP) is an enterprise development platform for building Solana applications with wallets, token issuance, payments, compliance checks, and a hosted dashboard.

## Status

SDP is pre-mainnet software. The public repository and APIs are intended for enterprise development, evaluation, and devnet integrations.

This codebase has not been audited. Do not use it to custody production funds, run mainnet financial workflows, or protect regulated production activity without your own review, testing, and security assessment.

Full self-hosting is a work in progress. The repository includes local development and infrastructure helpers, but the primary supported path today is the hosted platform and devnet-oriented development.

The hosted platform is available at https://platform.solana.com and the public docs are at https://platform.solana.com/docs.

## What is in this repo?

- `apps/sdp-api`: Cloudflare Workers API, OpenAPI source, route handlers, Postgres/KV integrations
- `apps/sdp-web`: dashboard application
- `apps/sdp-docs`: public documentation site and generated API reference
- `packages/sdp-types`: shared runtime types and product constants
- `packages/sdp-api-integration`: maintainer-oriented integration test harness
- `infra`: local and deployment infrastructure helpers
- `docs/ops`: operator and maintainer notes

The supported public API areas are health, API keys, wallets, projects, issuance, payments, and compliance. Internal routes and provider-specific operational details are not part of the public surface.

## Local Development

Prerequisites:

- Node.js 22+
- pnpm 10.16+
- Git

Install dependencies:

```bash
pnpm install
```

Create a local API environment file:

```bash
cp apps/sdp-api/.dev.vars.example apps/sdp-api/.dev.vars
```

For local devnet work, set `SOLANA_RPC_URL=https://api.devnet.solana.com` in `apps/sdp-api/.dev.vars`.

Start local services:

```bash
pnpm db:postgres:up
pnpm --filter @sdp/api db:postgres:bootstrap
pnpm dev
```

Useful local URLs:

- API: http://localhost:8787
- API docs: http://localhost:8787/docs
- Dashboard: http://localhost:3000

Some provider-backed features require separate vendor credentials, such as custody providers, compliance providers, fiat ramps, dashboard auth, and integration tests.

## Checks

Common checks:

```bash
pnpm --filter @sdp/api test
pnpm --filter @sdp/api typecheck
pnpm --filter sdp-docs check:links
pnpm --filter sdp-docs build
pnpm typecheck
```

Generated artifacts should be regenerated with their owning scripts rather than hand-edited:

```bash
pnpm -C apps/sdp-api openapi:generate
pnpm -C apps/sdp-docs generate:api
pnpm -C apps/sdp-docs generate:ai
```

## Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and the [local development notes](docs/contributing/local-development.md) before opening a pull request. Include tests for behavior changes and keep public documentation aligned with the OpenAPI source.

## License

This project is licensed under the [MIT License](LICENSE).

## Security

Report security issues using the process in [`SECURITY.md`](SECURITY.md). Do not open public issues for vulnerabilities or suspected secrets.

This repo includes a **pre-commit secret scanner** to prevent accidentally committing Clerk keys, API tokens, private keys, or other secrets. After cloning, install it:

```bash
node scripts/install-secret-scan.mjs
```

The hook runs automatically on every `git commit`. Run `node scripts/scan-secrets.mjs --all` to manually scan the working tree.
