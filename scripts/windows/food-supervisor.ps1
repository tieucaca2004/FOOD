<#
  FOOD supervisor: keeps the Platform (:3901) and the Cloudflare Named Tunnel
  (food-telegram -> telegram.atieu.com) running on this Windows machine.

  - One instance only (named mutex); a second copy exits immediately.
  - Never starts a duplicate: an existing listener on :3901 or an existing
    cloudflared running our tunnel config is adopted, not replaced.
  - Restarts either process if it dies (checked every -IntervalSeconds).
  - Logs to <repo>\logs\windows\. Holds no secrets: the Platform reads .env
    itself, cloudflared reads its credentials file from the config.

  Run by the "FOOD Platform + Tunnel" scheduled task (install-autostart.ps1),
  or by hand:  powershell -ExecutionPolicy Bypass -File food-supervisor.ps1
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$TunnelConfig = (Join-Path $env:USERPROFILE ".cloudflared\food-telegram.yml"),
  [int]$PlatformPort = 3901,
  [int]$IntervalSeconds = 15,
  [int]$LogRetentionDays = 14
)

$ErrorActionPreference = "Stop"
$LogDir = Join-Path $RepoRoot "logs\windows"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$SupervisorLog = Join-Path $LogDir ("supervisor-{0:yyyyMMdd}.log" -f (Get-Date))

function Write-Log([string]$Level, [string]$Message) {
  $line = "{0:yyyy-MM-ddTHH:mm:ss.fffK} [{1}] {2}" -f (Get-Date), $Level, $Message
  Add-Content -Path $SupervisorLog -Value $line -Encoding UTF8
}

$mutex = New-Object System.Threading.Mutex($false, "Local\FOOD-Supervisor")
try {
  $acquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $acquired = $true # previous supervisor was killed; we now own the mutex
}
if (-not $acquired) {
  Write-Log "INFO" "another supervisor instance is already running; exiting (pid $PID)"
  exit 0
}

function Get-PlatformListenerPid {
  $conn = Get-NetTCPConnection -LocalPort $PlatformPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return $conn.OwningProcess }
  return $null
}

function Get-TunnelProcess {
  $cfg = [regex]::Escape($TunnelConfig)
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
    Where-Object { $_.CommandLine -match $cfg } |
    Select-Object -First 1
}

function Start-Platform {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { Write-Log "ERROR" "node not found on PATH; cannot start Platform"; return }
  $stamp = "{0:yyyyMMdd-HHmmss}" -f (Get-Date)
  $p = Start-Process -FilePath $node -ArgumentList "platform/server.js" `
    -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "platform-$stamp.out.log") `
    -RedirectStandardError (Join-Path $LogDir "platform-$stamp.err.log")
  Write-Log "INFO" "started Platform: pid $($p.Id), logs platform-$stamp.*.log"
}

function Start-Tunnel {
  $cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cf) { Write-Log "ERROR" "cloudflared not found on PATH; cannot start tunnel"; return }
  if (-not (Test-Path $TunnelConfig)) { Write-Log "ERROR" "tunnel config missing: $TunnelConfig"; return }
  $tunnelLog = Join-Path $LogDir "cloudflared.log"
  $p = Start-Process -FilePath $cf -WindowStyle Hidden -PassThru -ArgumentList @(
    "tunnel", "--no-autoupdate", "--config", "`"$TunnelConfig`"",
    "--logfile", "`"$tunnelLog`"", "--loglevel", "info", "run"
  )
  Write-Log "INFO" "started cloudflared: pid $($p.Id), log cloudflared.log"
}

function Remove-OldLogs {
  Get-ChildItem $LogDir -Filter *.log -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$LogRetentionDays) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Log "INFO" "supervisor started: pid $PID, repo $RepoRoot, port $PlatformPort, config $TunnelConfig"
Remove-OldLogs
$lastPlatformPid = $null
$lastTunnelPid = $null

try {
  while ($true) {
    try {
      $platformPid = Get-PlatformListenerPid
      if ($platformPid) {
        if ($platformPid -ne $lastPlatformPid) { Write-Log "INFO" "Platform listening on :$PlatformPort (pid $platformPid)" }
      } else {
        if ($lastPlatformPid) { Write-Log "WARN" "Platform (pid $lastPlatformPid) no longer listening on :$PlatformPort" }
        Start-Platform
      }
      $lastPlatformPid = $platformPid

      $tunnel = Get-TunnelProcess
      if ($tunnel) {
        if ($tunnel.ProcessId -ne $lastTunnelPid) { Write-Log "INFO" "cloudflared running (pid $($tunnel.ProcessId))" }
        $lastTunnelPid = $tunnel.ProcessId
      } else {
        if ($lastTunnelPid) { Write-Log "WARN" "cloudflared (pid $lastTunnelPid) exited" }
        Start-Tunnel
        $lastTunnelPid = $null
      }
    } catch {
      Write-Log "ERROR" "supervisor loop: $($_.Exception.Message)"
    }

    # Roll the supervisor log over at midnight.
    $SupervisorLog = Join-Path $LogDir ("supervisor-{0:yyyyMMdd}.log" -f (Get-Date))
    Start-Sleep -Seconds $IntervalSeconds
  }
} finally {
  Write-Log "INFO" "supervisor stopping (pid $PID)"
  $mutex.ReleaseMutex()
}
