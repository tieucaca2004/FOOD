# Stops the FOOD scheduled tasks and the processes they started (node
# platform/server.js and cloudflared for the tunnel). Does not remove the
# tasks: they start again at the next Windows startup or logon.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\stop-food.ps1
param([string]$TunnelName = "food-platform")
$TaskPath = "\FOOD\"

foreach ($name in @("FOOD Platform", "FOOD Cloudflare Tunnel")) {
    if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskPath $TaskPath -TaskName $name
        Write-Host "Stopped task $name"
    }
}

# Ending a task does not always end the program its script started.
$targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq "node.exe" -and $_.CommandLine -match "platform[\\/]server\.js") -or
    ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -match "\btunnel\b" -and $_.CommandLine -match "\brun\b" -and $_.CommandLine -match [regex]::Escape($TunnelName))
}
foreach ($p in $targets) {
    Stop-Process -Id $p.ProcessId -Force
    Write-Host "Stopped $($p.Name) (PID $($p.ProcessId))"
}
if (-not $targets) { Write-Host "No FOOD platform or tunnel process was running." }
