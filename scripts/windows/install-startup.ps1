#Requires -RunAsAdministrator
# Installs two scheduled tasks under \FOOD\ so that, after a Windows restart,
# the FOOD platform (port 3901) and the Cloudflare Named Tunnel start on their
# own. Safe to run again: existing FOOD tasks are replaced.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1
#   (options: -TunnelName food-platform -CloudflaredConfig <path> -UsePassword -StartNow)
#
# See docs\WINDOWS-TELEGRAM-STARTUP.md.
param(
    [string]$TunnelName = "food-platform",
    [string]$CloudflaredConfig = (Join-Path $env:USERPROFILE ".cloudflared\config.yml"),
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$StartupDelaySeconds = 30,
    [switch]$UsePassword,
    [switch]$StartNow
)
$ErrorActionPreference = "Stop"
$TaskPath = "\FOOD\"
$PlatformTask = "FOOD Platform"
$TunnelTask = "FOOD Cloudflare Tunnel"
$RepoDir = $RepoDir.TrimEnd("\")

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# --- Checks before touching Task Scheduler --------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "node.exe was not found in PATH. Install Node.js 22 or add it to PATH." }
$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflared) { Fail "cloudflared.exe was not found in PATH. Install it first (docs, step 1)." }
if (-not (Test-Path (Join-Path $RepoDir "platform\server.js"))) { Fail "platform\server.js not found under $RepoDir" }
if (-not (Test-Path (Join-Path $RepoDir ".env"))) { Fail ".env not found in $RepoDir (the platform reads its settings from it)" }
if (-not (Test-Path $CloudflaredConfig)) { Fail "cloudflared config not found: $CloudflaredConfig (docs, step 4)" }

$config = Get-Content -Raw -Path $CloudflaredConfig
if ($config -notmatch "(?m)^\s*tunnel:\s*\S+") { Fail "$CloudflaredConfig has no 'tunnel:' line" }
$credMatch = [regex]::Match($config, "(?m)^\s*credentials-file:\s*(.+?)\s*$")
if (-not $credMatch.Success) { Fail "$CloudflaredConfig has no 'credentials-file:' line" }
$credFile = $credMatch.Groups[1].Value.Trim('"', "'")
if (-not [System.IO.Path]::IsPathRooted($credFile)) { Fail "credentials-file must be an absolute path (the task does not run from your profile folder): $credFile" }
if (-not (Test-Path $credFile)) { Fail "credentials-file not found: $credFile" }
if ($config -notmatch "service:\s*http://(localhost|127\.0\.0\.1):3901") { Fail "$CloudflaredConfig must route the hostname to http://localhost:3901" }
if ($config -match "trycloudflare") { Fail "$CloudflaredConfig refers to a Quick Tunnel; use the Named Tunnel hostname" }

# --- Task definitions -------------------------------------------------------
$powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$common = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File"
$platformArgs = "$common `"$RepoDir\scripts\windows\run-platform.ps1`" -NodePath `"$node`" -RepoDir `"$RepoDir`""
$tunnelArgs = "$common `"$RepoDir\scripts\windows\run-tunnel.ps1`" -CloudflaredPath `"$cloudflared`" -ConfigPath `"$CloudflaredConfig`" -TunnelName `"$TunnelName`" -RepoDir `"$RepoDir`""

# At startup (no login needed) and at this user's logon: with Windows Fast
# Startup, "Shut down" + power on may not fire the startup trigger. Running
# both is safe: each run script exits if its process is already running.
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$bootTrigger.Delay = "PT{0}S" -f $StartupDelaySeconds
$user = "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$triggers = @($bootTrigger, $logonTrigger)

# One instance per task; no Task Scheduler time limit; restarts are handled
# (and bounded) by the run script's supervisor, not here.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd

$credential = $null
if ($UsePassword) {
    $credential = Get-Credential -UserName $user -Message "Windows password for $user (stored by Task Scheduler, not by FOOD)"
}

foreach ($spec in @(
        @{ Name = $PlatformTask; Args = $platformArgs; Description = "FOOD platform (node platform/server.js on :3901). Logs: $RepoDir\logs" },
        @{ Name = $TunnelTask; Args = $tunnelArgs; Description = "Cloudflare Named Tunnel '$TunnelName' -> http://localhost:3901. Logs: $RepoDir\logs" }
    )) {
    $existing = Get-ScheduledTask -TaskPath $TaskPath -TaskName $spec.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $spec.Name -Confirm:$false
        Write-Host "Replaced existing task $($spec.Name)"
    }
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $spec.Args -WorkingDirectory $RepoDir
    if ($credential) {
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $spec.Name -Action $action -Trigger $triggers -Settings $settings `
            -User $user -Password $credential.GetNetworkCredential().Password -RunLevel Limited -Description $spec.Description | Out-Null
    } else {
        # S4U: runs whether or not you are logged on, without storing a password.
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
        Register-ScheduledTask -TaskPath $TaskPath -TaskName $spec.Name -Action $action -Trigger $triggers -Settings $settings `
            -Principal $principal -Description $spec.Description | Out-Null
    }
    Write-Host "Installed task $TaskPath$($spec.Name)" -ForegroundColor Green
}

Write-Host "node:        $node"
Write-Host "cloudflared: $cloudflared"
Write-Host "config:      $CloudflaredConfig (tunnel '$TunnelName')"
Write-Host "logs:        $RepoDir\logs"

if ($StartNow) {
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $PlatformTask
    Start-ScheduledTask -TaskPath $TaskPath -TaskName $TunnelTask
    Write-Host "Started both tasks. Check with: powershell -ExecutionPolicy Bypass -File scripts\windows\food-status.ps1"
}
