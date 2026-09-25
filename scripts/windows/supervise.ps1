# Shared by run-platform.ps1 and run-tunnel.ps1 (dot-sourced).
# Runs one program, restarts it if it exits, and gives up after too many
# exits in a short window, so a broken setup never restarts in a tight loop.
# Every start, exit and give-up is written to logs\food-supervisor.log.

function Write-SupervisorLog {
    param([string]$LogDir, [string]$Name, [string]$Message)
    $line = "{0} [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Name, $Message
    Add-Content -Path (Join-Path $LogDir "food-supervisor.log") -Value $line
    Write-Host $line
}

function Invoke-Supervised {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$LogDir,
        [int]$MaxRestarts = 5,
        [int]$WindowMinutes = 10,
        [int]$BaseDelaySeconds = 10,
        [int]$MaxDelaySeconds = 60
    )
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $exits = New-Object System.Collections.Generic.List[datetime]
    $attempt = 0
    while ($true) {
        # One pair of files per start, so a restart never overwrites the output
        # of the run that just crashed.
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $stdout = Join-Path $LogDir ("{0}-{1}.out.log" -f $Name, $stamp)
        $stderr = Join-Path $LogDir ("{0}-{1}.err.log" -f $Name, $stamp)
        Write-SupervisorLog $LogDir $Name ("starting: {0} {1}" -f $FilePath, ($Arguments -join " "))
        $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
        Write-SupervisorLog $LogDir $Name ("running as PID {0}" -f $proc.Id)
        $proc.WaitForExit()
        $code = $proc.ExitCode
        Write-SupervisorLog $LogDir $Name ("EXITED with code {0} (see {1})" -f $code, $stderr)

        $now = Get-Date
        $exits.Add($now)
        $recent = @($exits | Where-Object { $_ -gt $now.AddMinutes(-$WindowMinutes) })
        if ($recent.Count -gt $MaxRestarts) {
            Write-SupervisorLog $LogDir $Name ("GAVE UP: exited {0} times in {1} minutes; not restarting. Fix the error, then start the task again." -f $recent.Count, $WindowMinutes)
            return 1
        }
        $attempt = $recent.Count
        $delay = [Math]::Min($MaxDelaySeconds, $BaseDelaySeconds * $attempt)
        Write-SupervisorLog $LogDir $Name ("restarting in {0}s (exit {1} of {2} allowed in {3} min)" -f $delay, $recent.Count, $MaxRestarts, $WindowMinutes)
        Start-Sleep -Seconds $delay
    }
}
