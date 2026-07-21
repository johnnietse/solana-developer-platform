<#
.SYNOPSIS
  Schedule Polars API data ingestion every 15 minutes.

.DESCRIPTION
  Creates a Windows scheduled task that calls /ingest/all every 15 minutes.
  For local dev - keeps S3 data fresh automatically.

  For production ECS: use AWS EventBridge scheduler instead.

.EXAMPLE
  .\scripts\schedule-ingestion.ps1
#>

$taskName = "SDP-Polars-Ingestion"
$scriptFile = "$env:TEMP\sdp-polars-ingest.ps1"
$ingestUrl = "http://127.0.0.1:8081/ingest/all"

# Create the runner script
@"
`$url = "$ingestUrl"
try {
  `$r = Invoke-WebRequest -Uri `$url -UseBasicParsing -TimeoutSec 30
  Write-Host "[`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] `$(`$r.StatusCode) - `$(`$r.Content.Substring(0, [Math]::Min(80, `$r.Content.Length)))"
} catch {
  Write-Host "[`$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Failed: `$_"
}
"@ | Set-Content -Path $scriptFile -Force

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptFile`""
$trigger = New-ScheduledTaskTrigger -Once -RepetitionInterval (New-TimeSpan -Minutes 15) -At (Get-Date).AddMinutes(1) -RepetitionDuration ([TimeSpan]::MaxValue)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -AllowStartIfOnBatteries

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
  Write-Host "OK Scheduled task '$taskName' created" -ForegroundColor Green
  Write-Host "  Runs every 15 minutes" -ForegroundColor Gray
  Write-Host "  URL: $ingestUrl" -ForegroundColor Gray
  Write-Host ""
  Write-Host "To stop: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor Yellow
} catch {
  Write-Host "FAILED: $_" -ForegroundColor Red
  Write-Host "Run manually:" -ForegroundColor Yellow
  Write-Host "  while (`$true) { curl $ingestUrl; sleep 900 }" -ForegroundColor Gray
}
