#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { MetricsApiStack } from "../lib/metrics-api-stack";

const app = new cdk.App();

// NOTE: DELTA_BUCKET_NAME/DELTA_TABLE_PREFIX default to a placeholder —
// confirm the real bucket/prefix and override via env vars before deploying.
new MetricsApiStack(app, "SdpMetricsApiStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  deltaBucketName: process.env.DELTA_BUCKET_NAME ?? "tmp-sdp-data",
  deltaTablePrefix: process.env.DELTA_TABLE_PREFIX ?? "analytics_cache",
});
