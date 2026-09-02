#!/bin/bash
set -e

# Deploy the Polars API to ECR + ECS.
#
# Built on Waddah's fd-ingest deploy.sh: same .env loading, same section
# layout, same `|| true` on creates so a re-run is a no-op rather than an
# error. Three changes, each noted at the step it affects.

# ===== LOAD .env =====
if [ ! -f .env ]; then
  echo "❌ No .env file found — copy .env.example to .env and fill it in"
  exit 1
fi
source .env

: "${AWS_REGION:?set AWS_REGION in .env}"
: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID in .env}"
: "${ECR_REPO:?set ECR_REPO in .env}"
: "${CLUSTER_NAME:?set CLUSTER_NAME in .env}"
: "${TASK_FAMILY:?set TASK_FAMILY in .env}"

# POST /insert refuses to serve without this, so deploying without it would
# ship a service whose write endpoint always 503s. Caught here rather than
# after the rollout.
#
# It lands in the task definition, which means it is readable by anyone with
# ecs:DescribeTaskDefinition. That is acceptable for a devnet service whose
# blast radius is one S3 prefix; a production one belongs in Secrets Manager,
# referenced via "secrets" rather than "environment".
: "${API_WRITE_TOKEN:?set API_WRITE_TOKEN in .env — POST /insert is disabled without it}"

CONTAINER_NAME="${CONTAINER_NAME:-polars-api}"
SERVICE_NAME="${SERVICE_NAME:-$TASK_FAMILY}"
CONTAINER_PORT="${CONTAINER_PORT:-8080}"
HOST_PORT="${HOST_PORT:-8080}"

# ===== ENSURE ECR REPO EXISTS =====
echo "--- Ensure ECR repo exists ---"
aws ecr create-repository \
  --repository-name "$ECR_REPO" \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configuration encryptionType=AES256 \
  --region "$AWS_REGION" \
  --no-cli-pager --output json || true

# ===== AUTHENTICATE WITH ECR =====
echo "--- Authenticating with ECR ---"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# ===== BUILD & PUSH DOCKER IMAGE =====
# Tagged by commit as well as latest. "latest" alone cannot answer "what is
# running in production right now"; the task definition below pins the commit
# tag so a revision names the exact code it runs.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_URI="${REGISTRY}/${ECR_REPO}:${GIT_SHA}"
IMAGE_LATEST="${REGISTRY}/${ECR_REPO}:latest"

echo "--- Building Docker image (${GIT_SHA}) ---"
# --platform linux/amd64 matters: ECS container instances are amd64, and a
# build on an ARM machine otherwise produces an image that pushes fine and
# then fails at task start with "exec format error".
docker buildx build --platform linux/amd64 -t "$IMAGE_URI" -t "$IMAGE_LATEST" . --push

# ===== ENSURE ECS CLUSTER EXISTS =====
echo "--- Ensure ECS cluster exists ---"
aws ecs create-cluster \
  --cluster-name "$CLUSTER_NAME" \
  --region "$AWS_REGION" \
  --no-cli-pager --output json || true

# ===== ENSURE THE CLUSTER HAS CAPACITY =====
# The template launches an EC2 instance every run. This checks first: the
# target cluster already has a registered container instance, and launching
# another on each deploy would accumulate instances that nobody reaps —
# and removing them later would be a delete action.
INSTANCE_COUNT=$(aws ecs describe-clusters \
  --clusters "$CLUSTER_NAME" \
  --region "$AWS_REGION" \
  --query 'clusters[0].registeredContainerInstancesCount' \
  --output text --no-cli-pager 2>/dev/null || echo 0)

if [ "$INSTANCE_COUNT" = "0" ] || [ "$INSTANCE_COUNT" = "None" ]; then
  echo "--- Cluster has no container instances, launching one ---"
  : "${EC2_INSTANCE_TYPE:?cluster is empty and EC2_INSTANCE_TYPE is unset}"
  : "${EC2_KEY_PAIR:?cluster is empty and EC2_KEY_PAIR is unset}"
  : "${EC2_SECURITY_GROUP_ID:?cluster is empty and EC2_SECURITY_GROUP_ID is unset}"
  : "${EC2_SUBNET_ID:?cluster is empty and EC2_SUBNET_ID is unset}"

  AMI_ID=$(aws ssm get-parameters \
    --names /aws/service/ecs/optimized-ami/amazon-linux-2/recommended/image_id \
    --region "$AWS_REGION" \
    --query 'Parameters[0].Value' \
    --output text --no-cli-pager)

  aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --count 1 \
    --instance-type "$EC2_INSTANCE_TYPE" \
    --iam-instance-profile Name=ecsInstanceRole \
    --key-name "$EC2_KEY_PAIR" \
    --security-group-ids "$EC2_SECURITY_GROUP_ID" \
    --subnet-id "$EC2_SUBNET_ID" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$CLUSTER_NAME}]" \
    --user-data "#!/bin/bash
echo ECS_CLUSTER=$CLUSTER_NAME >> /etc/ecs/ecs.config" \
    --region "$AWS_REGION" \
    --no-cli-pager --output json || true

  echo "⏱ Waiting 60 seconds for EC2 to join ECS..."
  sleep 60
else
  echo "--- Cluster already has ${INSTANCE_COUNT} container instance(s), skipping EC2 launch ---"
fi

# ===== CREATE CLOUDWATCH LOG GROUP =====
aws logs create-log-group \
  --log-group-name "/ecs/$TASK_FAMILY" \
  --region "$AWS_REGION" \
  --no-cli-pager --output json || true

# ===== REGISTER TASK DEFINITION =====
# bridge networking with an explicit port mapping, because unlike fd-ingest
# this serves HTTP and something has to reach it.
#
# Memory is measured, not guessed. Under load — a /metrics Delta scan, a cold
# /rpc fetching 100 transfers and writing them back, repeated — the container
# peaks at 86 MB. 512 is six times that, and it fits the t3.micro container
# instance, which registers 940 MB in total.
#
# An earlier revision asked for 2048 on the theory that Polars, pyarrow and
# deltalake sit at ~400 MB resident. That is true of the other service, which
# also runs a scheduler and WebSocket listeners; it is not true here, and the
# task simply could not be placed: "no container instance met all of its
# requirements ... has insufficient memory available".
#
# memoryReservation is the soft limit ECS schedules against; memory is the hard
# cap the container is killed at. Reserving less than the cap lets the task be
# placed on a small instance while still allowing it to burst.
echo "--- Registering ECS task ---"

# TASK_ROLE_ARN gives the container its own AWS identity. Without one it falls
# back to the EC2 instance role, which on this cluster is ecsInstanceRole —
# ECS agent permissions only, no S3. That surfaces at runtime as
# "the operation lacked the necessary privileges" on every Delta read, so
# /metrics 503s and /rpc cannot write its cache while the service still
# reports healthy.
TASK_ROLE_ARGS=""
if [ -n "${TASK_ROLE_ARN:-}" ]; then
  TASK_ROLE_ARGS="--task-role-arn $TASK_ROLE_ARN"
  echo "    task role: $TASK_ROLE_ARN"
else
  echo "    WARNING: no TASK_ROLE_ARN — the container will have no S3 access"
fi

aws ecs register-task-definition \
  --family "$TASK_FAMILY" \
  --network-mode bridge \
  $TASK_ROLE_ARGS \
  --container-definitions "[
    {
      \"name\": \"$CONTAINER_NAME\",
      \"image\": \"$IMAGE_URI\",
      \"essential\": true,
      \"memory\": 512,
      \"memoryReservation\": 256,
      \"cpu\": 512,
      \"portMappings\": [
        {\"containerPort\": $CONTAINER_PORT, \"hostPort\": $HOST_PORT, \"protocol\": \"tcp\"}
      ],
      \"logConfiguration\": {
        \"logDriver\": \"awslogs\",
        \"options\": {
          \"awslogs-group\": \"/ecs/$TASK_FAMILY\",
          \"awslogs-region\": \"$AWS_REGION\",
          \"awslogs-stream-prefix\": \"ecs\"
        }
      },
      \"healthCheck\": {
        \"command\": [\"CMD-SHELL\", \"curl -fsS http://localhost:${CONTAINER_PORT}/healthz || exit 1\"],
        \"interval\": 30,
        \"timeout\": 5,
        \"retries\": 3,
        \"startPeriod\": 30
      },
      \"environment\": [
        {\"name\": \"AWS_REGION\", \"value\": \"$AWS_REGION\"},
        {\"name\": \"S3_INSERT_BUCKET\", \"value\": \"${S3_BUCKET_NAME:-tmp-sdp-data}\"},
        {\"name\": \"S3_RPC_TABLE_NAME\", \"value\": \"${S3_RPC_TABLE_NAME:-dev.mlh.rpc}\"},
        {\"name\": \"SOLANA_RPC_URL\", \"value\": \"${SOLANA_RPC_URL:-https://api.devnet.solana.com}\"},
        {\"name\": \"PORT\", \"value\": \"$CONTAINER_PORT\"},
        {\"name\": \"INSERT_TABLE_PREFIX\", \"value\": \"${INSERT_TABLE_PREFIX:-dev.mlh.}\"},
        {\"name\": \"API_WRITE_TOKEN\", \"value\": \"$API_WRITE_TOKEN\"}
      ]
    }
  ]" \
  --requires-compatibilities EC2 \
  --region "$AWS_REGION" \
  --no-cli-pager --output json

# ===== CREATE OR UPDATE ECS SERVICE =====
# create-service with `|| true` silently does nothing when the service already
# exists, which means a second deploy would push a new image and never roll
# onto it. Create when absent, update when present.
EXISTING=$(aws ecs describe-services \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME" \
  --region "$AWS_REGION" \
  --query 'services[?status==`ACTIVE`].serviceName' \
  --output text --no-cli-pager 2>/dev/null || echo "")

# minimumHealthyPercent=0, maximumPercent=100: stop the old task before
# starting the new one.
#
# The default (100/200) starts the replacement first, which cannot work here —
# one container instance, a static hostPort, and the old task still holding it:
#   "unable to place a task ... is already using a port required by your task"
# The deployment sits in PRIMARY with 0 running forever while the old revision
# keeps serving, so a deploy silently does nothing.
#
# The cost is a few seconds of downtime per deploy. Avoiding that needs dynamic
# port mapping behind a load balancer, or a second container instance — both
# more infrastructure than a single devnet service warrants.
DEPLOY_CONFIG="minimumHealthyPercent=0,maximumPercent=100"

if [ -z "$EXISTING" ]; then
  echo "--- Creating ECS service ---"
  aws ecs create-service \
    --cluster "$CLUSTER_NAME" \
    --service-name "$SERVICE_NAME" \
    --task-definition "$TASK_FAMILY" \
    --desired-count 1 \
    --launch-type EC2 \
    --deployment-configuration "$DEPLOY_CONFIG" \
    --region "$AWS_REGION" \
    --no-cli-pager --output json
else
  echo "--- Updating ECS service onto the new task definition ---"
  aws ecs update-service \
    --cluster "$CLUSTER_NAME" \
    --service "$SERVICE_NAME" \
    --task-definition "$TASK_FAMILY" \
    --deployment-configuration "$DEPLOY_CONFIG" \
    --region "$AWS_REGION" \
    --no-cli-pager --output json >/dev/null
fi

echo "⏱ Waiting for the service to reach a steady state..."
aws ecs wait services-stable \
  --cluster "$CLUSTER_NAME" \
  --services "$SERVICE_NAME" \
  --region "$AWS_REGION"

echo "✅ Deployment ${SERVICE_NAME} (${GIT_SHA}) complete."
