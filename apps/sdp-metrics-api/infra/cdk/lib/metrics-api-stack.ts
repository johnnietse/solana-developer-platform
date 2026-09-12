import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

export interface MetricsApiStackProps extends cdk.StackProps {
  /** S3 bucket that hosts the analytics_cache Delta table read by GET /metrics. */
  readonly deltaBucketName: string;
  /** Key prefix of the Delta table root within the bucket, e.g. "analytics_cache". */
  readonly deltaTablePrefix: string;
}

/**
 * ECS Fargate service for sdp-metrics-api: a Flask + Polars app that serves
 * GET /metrics by reading the latest row of a Delta table on S3.
 *
 * The container image is built directly from apps/sdp-metrics-api's Dockerfile
 * and pushed to an auto-created ECR repo as part of `cdk deploy` — no manual
 * `docker build`/`docker push` step is required.
 */
export class MetricsApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MetricsApiStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "MetricsApiVpc", { maxAzs: 2, natGateways: 1 });

    const cluster = new ecs.Cluster(this, "MetricsApiCluster", { vpc });

    const deltaTablePath = `s3://${props.deltaBucketName}/${props.deltaTablePrefix}`;

    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "MetricsApiService", {
      cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      publicLoadBalancer: true,
      circuitBreaker: { rollback: true },
      // desiredCount is 1, so the default 50% minHealthyPercent would let
      // the service drop to zero running tasks mid-deploy.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskImageOptions: {
        // Build context is apps/sdp-metrics-api (three levels up from
        // infra/cdk/lib), matching where the Dockerfile lives.
        image: ecs.ContainerImage.fromAsset(path.join(__dirname, "..", "..", "..")),
        containerPort: 8080,
        environment: {
          S3_DELTA_TABLE_PATH: deltaTablePath,
          AWS_REGION: this.region,
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "sdp-metrics-api",
          logRetention: logs.RetentionDays.TWO_WEEKS,
        }),
      },
    });

    // /healthz never touches S3, so ALB target health tracks the process,
    // not Delta table availability.
    service.targetGroup.configureHealthCheck({
      path: "/healthz",
      healthyHttpCodes: "200",
    });

    const deltaBucketArn = `arn:aws:s3:::${props.deltaBucketName}`;

    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ReadDeltaTableObjects",
        actions: ["s3:GetObject"],
        resources: [`${deltaBucketArn}/${props.deltaTablePrefix}/*`],
      }),
    );

    service.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ListDeltaTablePrefix",
        actions: ["s3:ListBucket"],
        resources: [deltaBucketArn],
        conditions: {
          StringLike: { "s3:prefix": [`${props.deltaTablePrefix}/*`] },
        },
      }),
    );

    new cdk.CfnOutput(this, "MetricsApiUrl", {
      value: `http://${service.loadBalancer.loadBalancerDnsName}/metrics`,
    });

    new cdk.CfnOutput(this, "DeltaTablePath", { value: deltaTablePath });
  }
}
