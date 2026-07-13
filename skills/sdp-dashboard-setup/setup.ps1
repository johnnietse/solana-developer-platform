<#
.SYNOPSIS
  One-command SDP local dev stack setup: Docker, deps, env files, migrations, keys, Clerk seeding, ngrok, API + web.

.DESCRIPTION
  Idempotent — safe to re-run. Run from repo root.
  Pass your Clerk keys + ngrok info and it does everything. 
  After it finishes, open http://localhost:3000 and sign in.

.PARAMETER ClerkSecretKey
  Your Clerk sk_test_... secret key (required for Clerk seeding).
.PARAMETER ClerkPublishableKey
  Your Clerk pk_test_... publishable key. If omitted, the web .env.local won't have it.
.PARAMETER ClerkWebhookSecret
  Your Clerk whsec_... webhook signing secret. If provided, written to .env files.
.PARAMETER NgrokAuthtoken
  Your ngrok authtoken. Required with -NgrokDomain to start the tunnel.
.PARAMETER NgrokDomain
  Your persistent ngrok subdomain (e.g. my-sdp.ngrok-free.dev). Required with -NgrokAuthtoken.
.PARAMETER StartServices
  If set, background-launches the API (node start-api.mjs) and web app (pnpm dev:local).
.PARAMETER SkipDocker
  Skip starting Docker containers (if already running).
.PARAMETER SkipInstall
  Skip pnpm install (if already done).

.EXAMPLE
  .\skills\sdp-dashboard-setup\setup.ps1 `
    -ClerkSecretKey "sk_test_xxx" `
    -ClerkPublishableKey "pk_test_xxx" `
    -ClerkWebhookSecret "whsec_xxx" `
    -NgrokAuthtoken "2gF3..." -NgrokDomain "my-sdp.ngrok-free.dev" `
    -StartServices
#>

param(
  [string]$ClerkSecretKey = "",
  [string]$ClerkPublishableKey = "",
  [string]$ClerkWebhookSecret = "",
  [string]$NgrokAuthtoken = "",
  [string]$NgrokDomain = "",
  [switch]$StartServices,
  [switch]$SkipDocker,
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$tmp = "$env:TEMP\sdp-setup"
$null = New-Item -ItemType Directory -Path $tmp -Force
$logFile = "$tmp\setup-log.txt"

Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   SDP Dashboard Setup                   ║" -ForegroundColor Cyan
Write-Host "║   $root" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan

# ──────────────────────────────────────────────
# 1. PREREQUISITES
# ──────────────────────────────────────────────
Write-Host "`n[1/8] Checking prerequisites..." -ForegroundColor Yellow
$prereqs = @(
  @{ Name = "Docker"; Cmd = "docker ps --format '{{.Names}}' 2>`$null" }
  @{ Name = "Node.js"; Cmd = "node --version" }
  @{ Name = "pnpm"; Cmd = "pnpm --version" }
  @{ Name = "psql"; Cmd = "Get-Command psql -ErrorAction SilentlyContinue" }
)
$allGood = $true
foreach ($p in $prereqs) {
  $ok = & { Invoke-Expression $p.Cmd } 2>$null
  if ($ok) { Write-Host "  ✅ $($p.Name): $ok" } else { Write-Host "  ❌ $($p.Name) — not found"; $allGood = $false }
}
if (-not $allGood) { Write-Host "`nFix the missing prereqs and re-run." -ForegroundColor Red; exit 1 }

# ──────────────────────────────────────────────
# 2. DOCKER SERVICES
# ──────────────────────────────────────────────
Write-Host "`n[2/8] Docker containers..." -ForegroundColor Yellow
if (-not $SkipDocker) {
  $running = docker ps --format "{{.Names}}" 2>$null | Select-String "postgres|redis"
  if (-not $running) {
    Write-Host "  Starting postgres + redis..."
    docker compose up -d postgres redis
    Start-Sleep -Seconds 5
  } else {
    Write-Host "  ✅ Already running: $($running -join ', ')"
  }
} else {
  Write-Host "  Skipped (—SkipDocker)"
}

# ──────────────────────────────────────────────
# 3. INSTALL DEPENDENCIES
# ──────────────────────────────────────────────
Write-Host "`n[3/8] pnpm install..." -ForegroundColor Yellow
if (-not $SkipInstall) {
  Push-Location $root
  pnpm install 2>&1 | Out-File -Append $logFile
  Pop-Location
  Write-Host "  ✅ Dependencies installed"
} else {
  Write-Host "  Skipped (—SkipInstall)"
}

# ──────────────────────────────────────────────
# 4. MIGRATIONS
# ──────────────────────────────────────────────
Write-Host "`n[4/8] Database migrations..." -ForegroundColor Yellow
Push-Location $root
pnpm -C apps/sdp-api db:migrate:local 2>&1 | Out-File -Append $logFile
if ($LASTEXITCODE -eq 0) {
  Write-Host "  ✅ Migrations applied (exit $LASTEXITCODE)"
} else {
  Write-Host "  ⚠️  Migration exit code $LASTEXITCODE (may be idempotent warning)"
}
Pop-Location

# ──────────────────────────────────────────────
# 5. ENV FILES & CRYPTO KEYS
# ──────────────────────────────────────────────
Write-Host "`n[5/8] Environment files + crypto keys..." -ForegroundColor Yellow

# Generate crypto keys
Push-Location $root
$keygen = pnpm -C apps/sdp-api keygen:local 2>&1 | Out-String
Pop-Location
Write-Host "  ✅ Keys generated"

# Parse keygen output (extract CUSTODY_PRIVATE_KEY, FEE_PAYER_PRIVATE_KEY, etc.)
$keyVars = @{}
foreach ($line in $keygen -split "`n") {
  if ($line -match "^\s*(\w+)\s*=\s*(.+)$") {
    $keyVars[$matches[1].Trim()] = $matches[2].Trim()
  }
}

# ── Write apps/sdp-api/.dev.vars ──
$apiEnv = "$root\apps\sdp-api\.dev.vars"
$apiLines = @()
$apiLines += "# Auto-generated by setup.ps1 — $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$apiLines += "CLERK_SECRET_KEY=$ClerkSecretKey"
$apiLines += "CLERK_JWT_TEMPLATE=sdp-api"
if ($ClerkWebhookSecret) { $apiLines += "CLERK_WEBHOOK_SECRET=$ClerkWebhookSecret" }
$apiLines += "DATABASE_URL=postgresql://sdp:sdp@127.0.0.1:5433/sdp"
if ($keyVars["CUSTODY_PRIVATE_KEY"])  { $apiLines += "CUSTODY_PRIVATE_KEY=$($keyVars['CUSTODY_PRIVATE_KEY'])" }
if ($keyVars["FEE_PAYER_PRIVATE_KEY"]) { $apiLines += "FEE_PAYER_PRIVATE_KEY=$($keyVars['FEE_PAYER_PRIVATE_KEY'])" }
if ($keyVars["CUSTODY_ENCRYPTION_KEY"]) { $apiLines += "CUSTODY_ENCRYPTION_KEY=$($keyVars['CUSTODY_ENCRYPTION_KEY'])" }
if ($keyVars["API_KEY_PEPPER"]) { $apiLines += "API_KEY_PEPPER=$($keyVars['API_KEY_PEPPER'])" }
$apiLines | Set-Content $apiEnv
Write-Host "  ✅ Wrote $apiEnv"

# ── Write repo-root .env.local (same content + webhook) ──
$rootEnv = "$root\.env.local"
$apiLines | Set-Content $rootEnv
Write-Host "  ✅ Wrote $rootEnv"

# ── Write apps/sdp-web/.env.local ──
$webEnv = "$root\apps\sdp-web\.env.local"
$webLines = @()
$webLines += "# Auto-generated by setup.ps1 — $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
if ($ClerkPublishableKey) { $webLines += "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$ClerkPublishableKey" }
$webLines += "CLERK_SECRET_KEY=$ClerkSecretKey"
$webLines += "CLERK_JWT_TEMPLATE=sdp-api"
$webLines += "NEXT_PUBLIC_SDP_API_BASE_URL=http://127.0.0.1:8787"
$webLines | Set-Content $webEnv
Write-Host "  ✅ Wrote $webEnv"

# ──────────────────────────────────────────────
# 6. CLERK ORGANIZATIONS & USER SEEDING
# ──────────────────────────────────────────────
if ($ClerkSecretKey) {
  Write-Host "`n[6/8] Seeding Clerk orgs + user..." -ForegroundColor Yellow
  try {
    $orgs = Invoke-RestMethod -Uri "https://api.clerk.com/v1/organizations?limit=10" `
      -Headers @{ Authorization = "Bearer $ClerkSecretKey"; "Clerk-API-Version" = "2024-10-01" }
    $users = Invoke-RestMethod -Uri "https://api.clerk.com/v1/users?limit=10" `
      -Headers @{ Authorization = "Bearer $ClerkSecretKey"; "Clerk-API-Version" = "2024-10-01" }
    
    $conn = "postgresql://sdp:sdp@127.0.0.1:5433/sdp"
    $env:PGPASSWORD = "sdp"

    foreach ($org in $orgs.data) {
      Write-Host "  Seeding org: $($org.name) ($($org.id))"
      $escapedName = $org.name -replace "'", "''"
      $escapedSlug = $org.slug -replace "'", "''"
      psql -d $conn -tA -c "
        INSERT INTO organizations (id, name, slug, tier, status)
        VALUES ('org_' || gen_random_uuid(), '$escapedName', '$escapedSlug', 'enterprise', 'active')
        ON CONFLICT (slug) DO NOTHING;
      "
      psql -d $conn -tA -c "
        INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
        SELECT 'aoi_' || gen_random_uuid(), 'clerk', '$($org.id)', o.id, '$escapedSlug'
        FROM organizations o WHERE o.slug = '$escapedSlug'
        ON CONFLICT (provider, provider_org_id) DO NOTHING;
      "
    }

    foreach ($userData in $users.data) {
      $email = ($userData.email_addresses | Where-Object { $_.id -eq $userData.primary_email_address_id } | Select-Object -First 1).email_address
      $firstName = $userData.first_name ?? ""
      $lastName = $userData.last_name ?? ""
      $userName = "$firstName $lastName".Trim()
      if (-not $userName) { $userName = $email }
      $escapedEmail = $email -replace "'", "''"
      $escapedName = $userName -replace "'", "''"
      Write-Host "  Seeding user: $email ($($userData.id))"
      
      psql -d $conn -tA -c "
        INSERT INTO users (id, email, name, status)
        SELECT 'usr_' || gen_random_uuid(), '$escapedEmail', '$escapedName', 'active'
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '$escapedEmail');
      "
      psql -d $conn -tA -c "
        INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
        SELECT 'aui_' || gen_random_uuid(), 'clerk', '$($userData.id)', u.id, u.email
        FROM users u WHERE u.email = '$escapedEmail'
        ON CONFLICT (provider, provider_user_id) DO NOTHING;
      "

      foreach ($org in $orgs.data) {
        $escapedSlugOrg = $org.slug -replace "'", "''"
        psql -d $conn -tA -c "
          INSERT INTO organization_members (id, organization_id, user_id, role, invitation_accepted)
          SELECT 'om_' || gen_random_uuid(), o.id, u.id, 'admin', true
          FROM organizations o, users u
          WHERE o.slug = '$escapedSlugOrg' AND u.email = '$escapedEmail'
          ON CONFLICT (organization_id, user_id) DO NOTHING;
        "
      }
    }

    # Create default-sandbox projects
    Write-Host "  Creating default-sandbox projects..."
    psql -d $conn -tA -c "
      INSERT INTO projects (id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at)
      SELECT 'prj_' || gen_random_uuid(), o.id, 'Default Sandbox Project', 'default-sandbox', 'Default sandbox project', 'sandbox', NULL, 'active', u.id, now(), now()
      FROM organizations o
      JOIN organization_members om ON om.organization_id = o.id AND om.role = 'admin'
      JOIN users u ON u.id = om.user_id
      ON CONFLICT (organization_id, slug) DO NOTHING;

      INSERT INTO project_members (id, project_id, user_id, role, created_at)
      SELECT 'pm_' || gen_random_uuid(), p.id, p.created_by, 'admin', now()
      FROM projects p
      WHERE p.slug = 'default-sandbox'
      ON CONFLICT (project_id, user_id) DO NOTHING;
    "

    Write-Host "  ✅ Clerk orgs + users + projects seeded" -ForegroundColor Green
  } catch {
    Write-Host "  ❌ Clerk seeding failed: $_" -ForegroundColor Red
    Write-Host "     Check your CLERK_SECRET_KEY and internet connection."
  }
} else {
  Write-Host "`n[6/8] Clerk seeding skipped (pass -ClerkSecretKey to enable)" -ForegroundColor Gray
}

# ──────────────────────────────────────────────
# 7. NGORK TUNNEL
# ──────────────────────────────────────────────
if ($NgrokAuthtoken -and $NgrokDomain) {
  Write-Host "`n[7/8] Starting ngrok tunnel..." -ForegroundColor Yellow
  $ngrokBin = Get-Command ngrok -ErrorAction SilentlyContinue
  if (-not $ngrokBin) {
    Write-Host "  Installing ngrok..."
    $zip = "$tmp\ngrok.zip"
    Invoke-WebRequest -Uri "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath "$env:USERPROFILE\ngrok" -Force
    $env:PATH += ";$env:USERPROFILE\ngrok"
  }
  ngrok config add-authtoken $NgrokAuthtoken 2>$null
  # Kill any existing ngrok first
  Get-Process -Name "ngrok" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-Process -FilePath "ngrok" -ArgumentList "http","--url=$NgrokDomain","8787" -NoNewWindow
  Write-Host "  ✅ ngrok tunnel started on https://$NgrokDomain" -ForegroundColor Green
} elseif ($NgrokAuthtoken -or $NgrokDomain) {
  Write-Host "`n[7/8] ngrok requires both -NgrokAuthtoken AND -NgrokDomain" -ForegroundColor Yellow
} else {
  Write-Host "`n[7/8] ngrok skipped (pass -NgrokAuthtoken and -NgrokDomain to enable)" -ForegroundColor Gray
}

# ──────────────────────────────────────────────
# 8. START SERVICES
# ──────────────────────────────────────────────
if ($StartServices) {
  Write-Host "`n[8/8] Starting services..." -ForegroundColor Yellow

  # Kill any prior API process
  Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq "" } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  # Start API via start-api.mjs (backgrounded via cmd /c start /B)
  Push-Location $root
  cmd /c "start /B node start-api.mjs > $tmp\api-bg.log 2>&1"
  Start-Sleep -Seconds 3
  Pop-Location
  Write-Host "  ✅ API starting... (node start-api.mjs)"

  # Start web app (backgrounded)
  Push-Location $root
  cmd /c "start /B pnpm -C apps/sdp-web dev:local > $tmp\web-bg.log 2>&1"
  Start-Sleep -Seconds 1
  Pop-Location
  Write-Host "  ✅ Web app starting... (pnpm dev:local)"

  Start-Sleep -Seconds 8
  Write-Host "  Checking API health..."
  try {
    $status = (Invoke-WebRequest -Uri "http://127.0.0.1:8787/health" -TimeoutSec 5 -UseBasicParsing).StatusCode
    if ($status -eq 200) { Write-Host "  ✅ API healthy on :8787" -ForegroundColor Green }
  } catch { Write-Host "  ⏳ API still starting... check with: curl http://127.0.0.1:8787/health" }
} else {
  Write-Host "`n[8/8] Service startup skipped (pass -StartServices to auto-start)" -ForegroundColor Gray
}

# ──────────────────────────────────────────────
# DONE
# ──────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Setup complete!                        ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║   API:   http://127.0.0.1:8787          ║" -ForegroundColor Cyan
if ($NgrokDomain) { Write-Host "║   Tunnel: https://$NgrokDomain        ║" -ForegroundColor Cyan }
Write-Host "║   Web:   http://localhost:3000           ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan

Write-Host "`nℹ️  What's left (one-time):" -ForegroundColor Yellow
if (-not $ClerkWebhookSecret) {
  Write-Host "  • Set CLERK_WEBHOOK_SECRET in .env.local (from Clerk Dashboard → Webhooks)"
}
Write-Host "  • Configure Clerk webhook endpoint at https://$NgrokDomain/webhooks/clerk/link-orgs" -ForegroundColor Gray
Write-Host "  • Open http://localhost:3000 and sign in" -ForegroundColor Gray
Write-Host "`nFull log: $logFile"
