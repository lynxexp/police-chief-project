<#
.SYNOPSIS
  Updates Police Chief Bot to the latest version and restarts it.

.DESCRIPTION
  Run this from the repo root (self-hosted PC or a Windows VPS) whenever
  the bot DMs you that an update is available, or anytime you want to
  check. It's a plain `git pull` plus the two things that actually need
  doing around it: reinstalling dependencies only if requirements.txt
  actually changed (most updates don't touch it), and restarting the bot
  the same way the watchdog does, so you don't have to separately kill
  and relaunch it yourself.

  Never force-resets or discards anything -- if you've made local edits
  that conflict with the update, `git pull` will say so and stop, same
  as it would for any other git repo.
#>

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Host "Checking for updates (branch: $branch)..."
git fetch origin $branch | Out-Null

$behind = (git rev-list --count "HEAD..origin/$branch").Trim()
if ($behind -eq "0") {
    Write-Host "Already up to date."
    exit 0
}

Write-Host ""
Write-Host "$behind new commit(s):"
git log --oneline "HEAD..origin/$branch"
Write-Host ""

$reqsChanged = (git diff --name-only "HEAD..origin/$branch" -- requirements.txt)

git pull origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Host "git pull failed -- resolve the conflict above, then run this again."
    exit 1
}

if ($reqsChanged) {
    Write-Host "requirements.txt changed -- reinstalling dependencies..."
    & "$repoRoot\bot_venv\Scripts\pip.exe" install -r requirements.txt
}

Write-Host "Restarting the bot..."
$existing = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -like "*main.py*" }
foreach ($p in $existing) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($existing) { Start-Sleep -Seconds 3 }

$pythonExe = Join-Path $repoRoot "bot_venv\Scripts\python.exe"
Start-Process -FilePath $pythonExe -ArgumentList "main.py" -WorkingDirectory $repoRoot `
    -RedirectStandardOutput (Join-Path $repoRoot "bot_stdout.log") `
    -RedirectStandardError (Join-Path $repoRoot "bot_stderr.log") `
    -WindowStyle Hidden

Write-Host ""
Write-Host "Updated and restarted. Check bot_stdout.log to confirm it came back up."
