<#
.SYNOPSIS
  Restarts the Police Chief Bot if it's dead or hung.

.DESCRIPTION
  Meant to run on a repeating schedule (Windows Task Scheduler, e.g. every
  2 minutes) rather than as a long-running loop of its own -- a script
  babysitting the bot is only useful if something more durable than the
  bot's own process is watching it, and Task Scheduler survives reboots
  and doesn't depend on any process staying alive itself.

  Liveness is judged by cogs/bot_health.py's heartbeat_loop, which writes
  the current UTC time to heartbeat.txt every 30 seconds once the bot is
  fully connected to Discord. A stale/missing heartbeat catches BOTH a
  fully-dead process (crashed, killed, machine rebooted) and a hung-but-
  still-running one (deadlocked, stuck on a blocking call) -- a plain
  "is python.exe running" check would miss the second case entirely.

  A freshly-started bot takes some time to finish loading cogs and
  connect to Discord before its first heartbeat write, so a running
  process younger than $startupGraceSeconds is left alone even with no
  heartbeat yet, rather than being killed mid-startup.
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$heartbeatFile = Join-Path $repoRoot "heartbeat.txt"
$logFile = Join-Path $repoRoot "watchdog.log"
$archiveDir = Join-Path $repoRoot "logs_archive"
$pythonExe = Join-Path $repoRoot "bot_venv\Scripts\python.exe"

$staleAfterSeconds = 120     # heartbeat writes every 30s; 4 missed writes = dead/hung
$startupGraceSeconds = 180   # module loading + Discord handshake, generously

function Write-Log($msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    "$ts  $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
}

$existing = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like "*main.py*" }

$heartbeatAge = $null
if (Test-Path $heartbeatFile) {
    $heartbeatAge = (Get-Date) - (Get-Item $heartbeatFile).LastWriteTime
}

$heartbeatStale = ($null -eq $heartbeatAge) -or ($heartbeatAge.TotalSeconds -gt $staleAfterSeconds)

if (-not $heartbeatStale) {
    exit 0  # healthy -- nothing to do
}

if ($existing) {
    $oldestStart = ($existing | ForEach-Object { $_.CreationDate } | Sort-Object | Select-Object -First 1)
    $processAge = (Get-Date) - $oldestStart
    if ($processAge.TotalSeconds -lt $startupGraceSeconds) {
        # Still starting up -- no heartbeat yet is expected at this age.
        exit 0
    }
    Write-Log "Heartbeat stale (process running $([int]$processAge.TotalSeconds)s, no fresh heartbeat) -- treating as hung."
    foreach ($p in $existing) {
        Write-Log "Stopping stale process PID $($p.ProcessId)."
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
} else {
    Write-Log "No main.py process found and no fresh heartbeat -- bot is not running."
}

# Archive whatever the previous run left behind instead of truncating it --
# it's the only record of why THIS restart was needed.
if ((Test-Path (Join-Path $repoRoot "bot_stdout.log")) -or (Test-Path (Join-Path $repoRoot "bot_stderr.log"))) {
    New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
    $ts2 = (Get-Date).ToString("yyyyMMdd_HHmmss")
    Move-Item (Join-Path $repoRoot "bot_stdout.log") (Join-Path $archiveDir "bot_stdout_$ts2.log") -ErrorAction SilentlyContinue
    Move-Item (Join-Path $repoRoot "bot_stderr.log") (Join-Path $archiveDir "bot_stderr_$ts2.log") -ErrorAction SilentlyContinue
}

Write-Log "Restarting bot."
Start-Process -FilePath $pythonExe -ArgumentList "main.py" -WorkingDirectory $repoRoot `
    -RedirectStandardOutput (Join-Path $repoRoot "bot_stdout.log") `
    -RedirectStandardError (Join-Path $repoRoot "bot_stderr.log") `
    -WindowStyle Hidden
Write-Log "Restart command issued."
