<#
.SYNOPSIS
  Run continuous data ingestion - fetches Solana data every 15 minutes.

.DESCRIPTION
  Runs a loop that calls the Polars API /ingest/all endpoint every 15 minutes.
  Keeps S3 data fresh with up-to-date Solana on-chain metrics.

  Run this in a separate PowerShell window alongside the main stack.

  For ECS production: use AWS EventBridge scheduler instead.

.EXAMPLE
  .\scripts\run-ingestion-loop.ps1
#>

$url = "http://127.0.0.1:8081/ingest/all"
$intervalSec = 900  # 15 minutes

Write-Host "SDP Polars Ingestion Loop" -ForegroundColor Cyan
Write-Host "URL: $url" -ForegroundColor Gray
Write-Host "Interval: $($intervalSec / 60) minutes" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop`n" -ForegroundColor Yellow

while ($true) {
  $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60
    $body = $r.Content.Substring(0, [Math]::Min(120, $r.Content.Length))
    Write-Host "[$now] $($r.StatusCode) - $body" -ForegroundColor Green
  } catch {
    Write-Host "[$now] Failed: $_" -ForegroundColor Red
  }
  Write-Host "  Next run in $($intervalSec / 60) min...  (Ctrl+C to stop)" -ForegroundColor Gray
  Start-Sleep -Seconds $intervalSec
}
