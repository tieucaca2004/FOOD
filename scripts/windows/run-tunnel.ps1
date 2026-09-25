# Started by the "FOOD Cloudflare Tunnel" scheduled task at Windows startup.
# Runs the Cloudflare Named Tunnel (fixed hostname -> http://localhost:3901)
# under the restart supervisor. Exits immediately, without starting a second
# copy, if a cloudflared process is already running this tunnel.
param(
    [Parameter(Mandatory = $true)][string]$CloudflaredPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [string]$TunnelName = "food-platform",
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "supervise.ps1")
$logDir = Join-Path $RepoDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$running = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "\btunnel\b" -and $_.CommandLine -match "\brun\b" -and $_.CommandLine -match [regex]::Escape($TunnelName) } |
    Select-Object -First 1
if ($running) {
    Write-SupervisorLog $logDir "tunnel" ("cloudflared is already running tunnel '{0}' as PID {1}; not starting another" -f $TunnelName, $running.ProcessId)
    exit 0
}
if (-not (Test-Path $ConfigPath)) {
    Write-SupervisorLog $logDir "tunnel" ("config file not found: {0}" -f $ConfigPath)
    exit 1
}

$arguments = @("tunnel", "--config", "`"$ConfigPath`"", "--logfile", "`"$(Join-Path $logDir 'cloudflared.log')`"", "run", $TunnelName)
exit (Invoke-Supervised -Name "tunnel" -FilePath $CloudflaredPath -Arguments $arguments -WorkingDirectory $RepoDir -LogDir $logDir)
