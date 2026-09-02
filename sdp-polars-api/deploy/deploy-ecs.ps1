<#
.SYNOPSIS
  Deploy the SDP Polars API Docker image to Amazon ECS Fargate.

.DESCRIPTION
  1. Creates ECR repository (if missing)
  2. Tags & pushes the local Docker image
  3. Creates CloudWatch log group (if missing)
  4. Creates IAM task role with S3 access (if missing)
  5. Registers ECS task definition
  6. Creates cluster & Fargate service in the default VPC

.PARAMETER AwsProfile
  AWS credential profile name (default: sdp-user).

.PARAMETER Region
  AWS region (default: us-east-1).

.PARAMETER ImageTag
  Docker image tag to push (default: latest).

.PARAMETER Cpu
  Fargate CPU units (default: 256).

.PARAMETER Memory
  Fargate memory MiB (default: 512).

.PARAMETER DesiredCount
  Number of ECS tasks to run (default: 1).

.EXAMPLE
  .\deploy\deploy-ecs.ps1

.EXAMPLE
  .\deploy\deploy-ecs.ps1 -AwsProfile production -ImageTag v1.2.3 -DesiredCount 2
#>

param(
  [string]$AwsProfile = "sdp-user",
  [string]$Region = "us-east-1",
  [string]$ImageTag = "latest",
  [int]$Cpu = 256,
  [int]$Memory = 512,
  [int]$DesiredCount = 1
)

$ErrorActionPreference = "Stop"

# ── Configuration ──────────────────────────────────────────────────────────
$AccountId = "017605949106"
$EcrRepoName = "sdp-polars-api"
$EcrUri = "${AccountId}.dkr.ecr.${Region}.amazonaws.com"
$ImageUrl = "${EcrUri}/${EcrRepoName}:${ImageTag}"
$ClusterName = "sdp-polars-api"
$ServiceName = "sdp-polars-api"
$LogGroup = "/ecs/sdp-polars-api"
$TaskRoleName = "sdp-polars-api-task-role"
$TaskFamily = "sdp-polars-api"
$ScriptRoot = Split-Path -Parent $PSScriptRoot

$AwsArgs = @("--region", $Region, "--profile", $AwsProfile)

Write-Host "╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   SDP Polars API — ECS Fargate Deployment          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "Account : $AccountId" -ForegroundColor Gray
Write-Host "Region  : $Region" -ForegroundColor Gray
Write-Host "Profile : $AwsProfile" -ForegroundColor Gray
Write-Host "Image   : $ImageUrl" -ForegroundColor Gray
Write-Host ""

# ── Helper ─────────────────────────────────────────────────────────────────
function aws-run {
  param([string]$Command, [string]$ErrorMessage)
  Write-Host "▶ aws $Command" -ForegroundColor Yellow
  $output = aws @AwsArgs --cli-read-timeout 30 $Command 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "$ErrorMessage"
    Write-Host "  $output" -ForegroundColor Red
    return $null
  }
  return $output
}

# ── Step 1: ECR Repository ────────────────────────────────────────────────
Write-Host "`n── Step 1/7: ECR Repository ──" -ForegroundColor Green
$repoExists = aws ecr describe-repositories --repository-names $EcrRepoName 2>$null
if (-not $repoExists) {
  aws-run "ecr create-repository --repository-name $EcrRepoName" "Creating ECR repo..."
  Write-Host "  ✓ Created repository $EcrRepoName" -ForegroundColor Green
} else {
  Write-Host "  ✓ Repository $EcrRepoName already exists" -ForegroundColor Green
}

# ── Step 2: Docker Login + Push ────────────────────────────────────────────
Write-Host "`n── Step 2/7: Docker Push ──" -ForegroundColor Green
Write-Host "  Logging in to ECR..." -ForegroundColor Gray
aws ecr get-login-password --region $Region --profile $AwsProfile | docker login --username AWS --password-stdin $EcrUri 2>$null
if ($LASTEXITCODE -ne 0) { throw "Docker login failed" }
Write-Host "  ✓ Logged in to ECR" -ForegroundColor Green

Write-Host "  Tagging image as $ImageUrl ..." -ForegroundColor Gray
docker tag sdp-polars-api:latest $ImageUrl 2>$null
if ($LASTEXITCODE -ne 0) { throw "Docker tag failed" }

Write-Host "  Pushing image (this may take a few minutes)..." -ForegroundColor Gray
docker push $ImageUrl 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }
Write-Host "  ✓ Image pushed" -ForegroundColor Green

# ── Step 3: CloudWatch Log Group ──────────────────────────────────────────
Write-Host "`n── Step 3/7: CloudWatch Logs ──" -ForegroundColor Green
$logExists = aws logs describe-log-groups --log-group-name-prefix $LogGroup 2>$null
if (-not ($logExists -match $LogGroup)) {
  aws-run "logs create-log-group --log-group-name $LogGroup" "Creating log group..."
  Write-Host "  ✓ Created log group $LogGroup" -ForegroundColor Green
} else {
  Write-Host "  ✓ Log group $LogGroup already exists" -ForegroundColor Green
}

# ── Step 4: IAM Task Role ─────────────────────────────────────────────────
Write-Host "`n── Step 4/7: IAM Task Role ──" -ForegroundColor Green
$roleExists = aws iam get-role --role-name $TaskRoleName 2>$null
if (-not $roleExists) {
  Write-Host "  Creating IAM role $TaskRoleName ..." -ForegroundColor Gray

  # Trust policy for ECS tasks
  $trustPolicy = @"
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ecs-tasks.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
"@

  aws iam create-role `
    --role-name $TaskRoleName `
    --assume-role-policy-document $trustPolicy `
    --description "Grants SDP Polars API tasks access to S3" 2>$null | Out-Null

  # Attach S3 access policy
  $s3Policy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket",
        "s3:HeadObject"
      ],
      "Resource": [
        "arn:aws:s3:::tmp-sdp-data/*",
        "arn:aws:s3:::tmp-sdp-data"
      ]
    }
  ]
}
"@

  aws iam put-role-policy `
    --role-name $TaskRoleName `
    --policy-name "sdp-polars-api-s3-access" `
    --policy-document $s3Policy 2>$null | Out-Null

  Write-Host "  ✓ Created IAM role $TaskRoleName with S3 access" -ForegroundColor Green
} else {
  Write-Host "  ✓ IAM role $TaskRoleName already exists" -ForegroundColor Green
}

# ── Step 5: Register Task Definition ──────────────────────────────────────
Write-Host "`n── Step 5/7: Task Definition ──" -ForegroundColor Green

# Read template and substitute image URL
$taskDefPath = Join-Path $PSScriptRoot "ecs-task-def.json"
$taskDef = Get-Content $taskDefPath -Raw
$taskDef = $taskDef -replace '017605949106\.dkr\.ecr\.[\w-]+\.amazonaws\.com/sdp-polars-api:latest', $ImageUrl

# Write temp file with resolved image URL
$tmpTaskDef = Join-Path $env:TEMP "sdp-polars-task-def.json"
Set-Content -Path $tmpTaskDef -Value $taskDef

$result = aws ecs register-task-definition --cli-input-json "file://$tmpTaskDef" 2>&1
if ($LASTEXITCODE -ne 0) { throw "Task definition registration failed: $result" }
Remove-Item $tmpTaskDef -Force -ErrorAction SilentlyContinue
Write-Host "  ✓ Registered task definition $TaskFamily" -ForegroundColor Green

# ── Step 6: ECS Cluster ────────────────────────────────────────────────────
Write-Host "`n── Step 6/7: ECS Cluster ──" -ForegroundColor Green
$clusterExists = aws ecs describe-clusters --clusters $ClusterName 2>$null
if (-not ($clusterExists -match '"status": "ACTIVE"')) {
  aws-run "ecs create-cluster --cluster-name $ClusterName --capacity-providers FARGATE" "Creating cluster..."
  Write-Host "  ✓ Created cluster $ClusterName" -ForegroundColor Green
} else {
  Write-Host "  ✓ Cluster $ClusterName already exists" -ForegroundColor Green
}

# ── Step 7: Fargate Service ────────────────────────────────────────────────
Write-Host "`n── Step 7/7: Fargate Service ──" -ForegroundColor Green

# Discover default VPC
$vpcJson = aws ec2 describe-vpcs --filters "Name=is-default,Values=true" 2>$null
if (-not $vpcJson) { throw "No default VPC found in this account/region." }
$vpcId = ($vpcJson | ConvertFrom-Json).Vpcs[0].VpcId
Write-Host "  Using VPC: $vpcId" -ForegroundColor Gray

# Get public subnets in the default VPC
$subnetsJson = aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpcId" 2>$null
$subnets = ($subnetsJson | ConvertFrom-Json).Subnets | Where-Object { $_.MapPublicIpOnAssignment -eq $true }
if (-not $subnets) { $subnets = ($subnetsJson | ConvertFrom-Json).Subnets }
$subnetIds = ($subnets.SubnetId) -join ","
Write-Host "  Subnets: $subnetIds" -ForegroundColor Gray

# Get default security group
$sgJson = aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpcId" "Name=group-name,Values=default" 2>$null
$sgId = ($sgJson | ConvertFrom-Json).SecurityGroups[0].GroupId
Write-Host "  Security Group: $sgId" -ForegroundColor Gray

# Create or update the service
$serviceExists = aws ecs describe-services --cluster $ClusterName --services $ServiceName 2>$null
if ($serviceExists -match '"status": "ACTIVE"') {
  Write-Host "  Updating existing service..." -ForegroundColor Gray
  aws ecs update-service `
    --cluster $ClusterName `
    --service $ServiceName `
    --task-definition $TaskFamily `
    --desired-count $DesiredCount `
    --force-new-deployment 2>$null | Out-Null
  Write-Host "  ✓ Service $ServiceName updated" -ForegroundColor Green
} else {
  Write-Host "  Creating service..." -ForegroundColor Gray
  aws ecs create-service `
    --cluster $ClusterName `
    --service-name $ServiceName `
    --task-definition $TaskFamily `
    --desired-count $DesiredCount `
    --launch-type FARGATE `
    --network-configuration "awsvpcConfiguration={subnets=[$subnetIds],securityGroups=[$sgId],assignPublicIp=ENABLED}" `
    --platform-version LATEST 2>$null | Out-Null
  Write-Host "  ✓ Service $ServiceName created" -ForegroundColor Green
}

# ── Done ───────────────────────────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Deployment complete!                              ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "ECR Image : $ImageUrl" -ForegroundColor White
Write-Host "Cluster   : $ClusterName" -ForegroundColor White
Write-Host "Service   : $ServiceName" -ForegroundColor White
Write-Host "Task Def  : $TaskFamily (latest revision)" -ForegroundColor White

# Grab the public IP of the running task (if any)
$taskJson = aws ecs list-tasks --cluster $ClusterName --service-name $ServiceName --desired-status RUNNING 2>$null
if ($taskJson) {
  $taskArns = ($taskJson | ConvertFrom-Json).taskArns
  if ($taskArns) {
    $taskDetail = aws ecs describe-tasks --cluster $ClusterName --tasks $taskArns[0] 2>$null
    $eniId = ($taskDetail | ConvertFrom-Json).tasks[0].attachments[0].details | Where-Object { $_.name -eq "networkInterfaceId" } | Select-Object -ExpandProperty value
    if ($eniId) {
      $eniInfo = aws ec2 describe-network-interfaces --network-interface-ids $eniId 2>$null
      $publicIp = ($eniInfo | ConvertFrom-Json).NetworkInterfaces[0].Association.PublicIp
      if ($publicIp) {
        Write-Host ""
        Write-Host "Public URL : http://${publicIp}:8080/health" -ForegroundColor Green
        Write-Host ""
      }
    }
  }
}
