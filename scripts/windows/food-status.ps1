# One-screen health check after a reboot (or any time):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\food-status.ps1
# Prints PASS/FAIL per check and exits 1 if anything failed. Never prints
# the bot token or the webhook secret.
param(
    [string]$TunnelName = "food-platform",
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$Port = 3901
)
$TaskPath = "\FOOD\"
$failed = 0
function Report([bool]$Ok, [string]$Label, [string]$Detail) {
    if ($Ok) { Write-Host ("PASS  {0}  {1}" -f $Label, $Detail) -ForegroundColor Green }
    else { Write-Host ("FAIL  {0}  {1}" -f $Label, $Detail) -ForegroundColor Red; $script:failed++ }
}

# 1. Scheduled tasks
foreach ($name in @("FOOD Platform", "FOOD Cloudflare Tunnel")) {
    $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { Report $false "task: $name" "not installed (run install-startup.ps1)"; continue }
    $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $name
    Report ($task.State -eq "Running") "task: $name" ("state={0} lastRun={1} lastResult={2}" -f $task.State, $info.LastRunTime, $info.LastTaskResult)
}

# 2. Processes
$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$platform = $procs | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "platform[\\/]server\.js" }
$tunnel = $procs | Where-Object { $_.Name -eq "cloudflared.exe" -and $_.CommandLine -match "\brun\b" -and $_.CommandLine -match [regex]::Escape($TunnelName) }
Report ([bool]$platform) "process: platform" ("PIDs: {0}" -f (($platform | ForEach-Object { $_.ProcessId }) -join ", "))
Report ([bool]$tunnel) "process: cloudflared" ("PIDs: {0}" -f (($tunnel | ForEach-Object { $_.ProcessId }) -join ", "))
if (@($platform).Count -gt 1) { Report $false "single platform" "more than one platform process is running" }
if (@($tunnel).Count -gt 1) { Report $false "single tunnel" "more than one cloudflared process is running this tunnel" }

# 3. Local and public health
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
Report ([bool]$listening) "port $Port" "listening"
try {
    $local = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://127.0.0.1:$Port/api/platform/health"
    Report ($local.StatusCode -eq 200) "local health" "HTTP $($local.StatusCode)"
} catch { Report $false "local health" $_.Exception.Message }

# Only TELEGRAM_WEBHOOK_BASE_URL is read from .env; nothing else is printed.
$envFile = Join-Path $RepoDir ".env"
$base = $null
if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*TELEGRAM_WEBHOOK_BASE_URL\s*=" } | Select-Object -Last 1
    if ($line) { $base = ($line -replace "^\s*TELEGRAM_WEBHOOK_BASE_URL\s*=\s*", "").Trim().Trim('"', "'").TrimEnd("/") }
}
if ($base) {
    try {
        $public = Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "$base/api/platform/health"
        Report ($public.StatusCode -eq 200) "public health" "$base -> HTTP $($public.StatusCode)"
    } catch { Report $false "public health" ("{0}: {1}" -f $base, $_.Exception.Message) }
} else {
    Report $false "public health" "TELEGRAM_WEBHOOK_BASE_URL is not set in .env"
}

# 4. Telegram webhook (reads it back; changes nothing)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    Push-Location $RepoDir
    $output = & $node "platform/scripts/setup-telegram-webhook.js" "--check" 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $output | ForEach-Object { Write-Host "      $_" }
    Report ($code -eq 0) "telegram webhook" "points at the fixed URL (see details above)"
} else {
    Report $false "telegram webhook" "node.exe not found in PATH"
}

# 5. Supervisor: did anything give up?
$supervisorLog = Join-Path $RepoDir "logs\food-supervisor.log"
if (Test-Path $supervisorLog) {
    $tail = Get-Content $supervisorLog -Tail 200
    $gaveUp = $tail | Where-Object { $_ -match "GAVE UP" } | Select-Object -Last 1
    Report (-not $gaveUp) "supervisor" $(if ($gaveUp) { $gaveUp } else { "no give-up recorded recently" })
    Write-Host "      last supervisor entries:"
    Get-Content $supervisorLog -Tail 5 | ForEach-Object { Write-Host "      $_" }
}

Write-Host ""
if ($failed -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$failed CHECK(S) FAILED" -ForegroundColor Red
exit 1
