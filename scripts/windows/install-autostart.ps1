<#
  Registers (or updates) the "FOOD Platform + Tunnel" scheduled task, which
  runs food-supervisor.ps1 hidden at logon of the current user.

  Usage:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1 [-StartNow]
#>
param(
  [string]$TaskName = "FOOD Platform + Tunnel",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$supervisor = Join-Path $PSScriptRoot "food-supervisor.ps1"
if (-not (Test-Path $supervisor)) { throw "missing $supervisor" }

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisor`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
# IgnoreNew + the supervisor's own mutex = never two supervisors. If the
# supervisor itself dies, Task Scheduler restarts it (every minute, up to 999x).
$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description "Keeps FOOD Platform (:3901) and Cloudflare tunnel food-telegram running. Script: $supervisor" | Out-Null
Write-Host "registered scheduled task '$TaskName' (at logon of $user)"

if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "started '$TaskName'"
}
