#Requires -RunAsAdministrator
# Removes the FOOD startup tasks and stops their processes. Leaves the
# Cloudflare tunnel, its DNS record, the Telegram webhook, .env and logs as
# they are.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-startup.ps1
param([string]$TunnelName = "food-platform")
$TaskPath = "\FOOD\"

& (Join-Path $PSScriptRoot "stop-food.ps1") -TunnelName $TunnelName

foreach ($name in @("FOOD Platform", "FOOD Cloudflare Tunnel")) {
    if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $name -Confirm:$false
        Write-Host "Removed task $TaskPath$name"
    } else {
        Write-Host "Task $TaskPath$name was not installed"
    }
}
