# Started by the "FOOD Platform" scheduled task at Windows startup.
# Runs node platform/server.js from the repository (so .env is loaded from
# there) under the restart supervisor. Exits immediately, without starting a
# second copy, if something already listens on the platform port.
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [int]$Port = 3901
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "supervise.ps1")
$logDir = Join-Path $RepoDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listening) {
    Write-SupervisorLog $logDir "platform" ("port {0} is already in use by PID {1}; not starting another platform" -f $Port, $listening.OwningProcess)
    exit 0
}

exit (Invoke-Supervised -Name "platform" -FilePath $NodePath -Arguments @("platform/server.js") -WorkingDirectory $RepoDir -LogDir $logDir)
