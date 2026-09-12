# sdp-metrics-api — ECS deployment (AWS CDK)

Deploys `sdp-metrics-api` as an ECS Fargate service behind a public Application Load Balancer:

- Builds the image from `../../Dockerfile` and pushes it to an auto-created ECR repo (`cdk deploy` handles `docker build`/`push` — no manual step).
- Fargate service (256 CPU / 512 MiB, `desiredCount: 1`), ALB health check on `/healthz`.
- Task role scoped to read-only S3 access (`s3:GetObject` + prefix-scoped `s3:ListBucket`) on the Delta table's bucket/prefix — no static AWS credentials anywhere.

## Prerequisites

- AWS CLI credentials for the target account (`aws sts get-caller-identity` should work)
- `cdk bootstrap` run once per account/region:

  ```bash
  npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
  ```

## Configure

Set these before `synth`/`deploy` — **defaults are placeholders**, confirm the real values:

```bash
export CDK_DEFAULT_ACCOUNT=<your-account-id>
export CDK_DEFAULT_REGION=us-east-1
export DELTA_BUCKET_NAME=tmp-sdp-data       # bucket, no s3:// prefix
export DELTA_TABLE_PREFIX=analytics_cache   # key prefix of the Delta table root
```

## Deploy

```bash
npm install
npm run synth   # sanity-check the generated CloudFormation
npm run deploy
```

The stack output `MetricsApiUrl` gives the ALB URL for `GET /metrics`.

## Tear down

```bash
npx cdk destroy
```
