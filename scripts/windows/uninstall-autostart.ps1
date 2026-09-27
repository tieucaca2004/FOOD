<#
  Removes the "FOOD Platform + Tunnel" scheduled task and stops its supervisor.
  Leaves the Platform and cloudflared processes running; stop them yourself
  if you want them down.
#>
param([string]$TaskName = "FOOD Platform + Tunnel")

$ErrorActionPreference = "Stop"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed scheduled task '$TaskName'"
} else {
  Write-Host "scheduled task '$TaskName' not found"
}
