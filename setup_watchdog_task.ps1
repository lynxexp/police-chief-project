<#
.SYNOPSIS
  Registers the Police Chief Bot watchdog as a Windows Scheduled Task.

.DESCRIPTION
  Run this once, from an elevated PowerShell prompt, on whichever machine
  actually runs the bot -- your own PC if self-hosting, or a Windows VPS.
  It's the same script either way: a VPS is just a Windows box you happen
  to reach over RDP instead of sitting in front of, and Task Scheduler
  doesn't care which.

  Two triggers, so the watchdog covers both failure modes:
    - At startup: the bot comes back up promptly after a reboot (Windows
      Update, a VPS host maintenance restart), not just whenever the next
      2-minute tick happens to land.
    - Every 2 minutes, indefinitely: catches a crash or hang while the
      machine stays up.

  Registered to run as SYSTEM, so it works identically whether you're
  logged in, logged out, or -- the VPS case that actually matters -- your
  RDP session has been closed the whole time. No password to store, no
  dependency on an interactive session surviving.

  Idempotent: re-running this replaces any previous registration instead
  of erroring or duplicating it, so it's safe to run again after editing
  watchdog.ps1 or moving the repo.
#>

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogScript = Join-Path $repoRoot "watchdog.ps1"
$taskName = "PoliceChiefBotWatchdog"

if (-not (Test-Path $watchdogScript)) {
    throw "watchdog.ps1 not found at $watchdogScript -- run this from inside the police-chief-bot repo."
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Task '$taskName' already exists -- removing it first so this is a clean re-install."
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$watchdogScript`""

$triggers = @(
    New-ScheduledTaskTrigger -AtStartup
    New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 2) `
        -RepetitionDuration ([TimeSpan]::MaxValue)
)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

# SYSTEM + ServiceAccount logon type -- runs with no user session at all,
# which is the whole point on a VPS nobody's remoted into right now.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description "Restarts Police Chief Bot if its heartbeat goes stale (crash, hang, or reboot)." | Out-Null

Write-Host "Registered '$taskName'. Running it once now to confirm it actually works..."
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Last run result: $($info.LastTaskResult) (0 = success)"
Write-Host ""
Write-Host "Done. It will now check every 2 minutes, and at every startup, indefinitely."
Write-Host "Verify anytime with:  Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host "Remove it with:       Unregister-ScheduledTask -TaskName '$taskName'"
