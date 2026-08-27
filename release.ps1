<#
.SYNOPSIS
  Cuts a new release: bumps the version file, tags, pushes, and publishes
  a GitHub Release.

.DESCRIPTION
  Purely manual and explicit -- nothing in this repo calls this script for
  you, and it makes no judgment call about whether a given commit deserves
  a release. You decide that by choosing to run it, and when. Every commit
  in between just stays a commit.

  What it does, in order, stopping immediately if any step fails:
    1. Refuses to run on a dirty working tree, or a branch behind origin
       -- a release should be built from exactly what's on GitHub, not a
       local-only state.
    2. Computes the new version (from -Bump) or uses -Version directly,
       and writes it to the `version` file.
    3. Commits that one-line change ("Release vX.Y.Z").
    4. Creates an annotated tag `vX.Y.Z` and pushes both the commit and
       the tag to origin.
    5. Publishes a GitHub Release for that tag -- auto-generated notes
       from every commit since the last release, unless -Notes is given.
       This is what triggers .github/workflows/docker.yml to build and
       push the Docker image; pass -Draft to publish nothing yet and
       review/edit the release on GitHub first.

  Requires the GitHub CLI (`gh`), already authenticated.

.EXAMPLE
  .\release.ps1 -Bump patch
  .\release.ps1 -Bump minor -Draft
  .\release.ps1 -Version 2.0.0 -Notes "Rewritten notification pipeline."
  .\release.ps1 -Bump patch -DryRun
#>

param(
    [ValidateSet("patch", "minor", "major")]
    [string]$Bump,

    [string]$Version,

    [string]$Notes,

    [switch]$Draft,

    # Show what would happen -- new version, tag, and generated release
    # notes -- without touching the working tree, git remote, or GitHub.
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

if (-not $Bump -and -not $Version) {
    throw "Specify -Bump <patch|minor|major> or -Version <X.Y.Z>. See -?  for examples."
}
if ($Bump -and $Version) {
    throw "Specify only one of -Bump or -Version, not both."
}

# --- Safety checks -------------------------------------------------------

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) not found. Install it from https://cli.github.com/ first."
}
gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    throw "gh is not authenticated. Run 'gh auth login' first."
}

$dirty = git status --porcelain
if ($dirty) {
    throw "Working tree has uncommitted changes -- commit or stash them before releasing:`n$dirty"
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
git fetch --tags origin $branch | Out-Null
$behind = (git rev-list --count "HEAD..origin/$branch").Trim()
if ($behind -ne "0") {
    throw "Local branch is $behind commit(s) behind origin/$branch -- pull first."
}

# --- Compute the new version ----------------------------------------------

$currentVersion = (Get-Content "version" -Raw).Trim()

if ($Version) {
    $newVersion = $Version
} else {
    if ($currentVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "Current version '$currentVersion' isn't plain semver (X.Y.Z) -- use -Version to set one explicitly."
    }
    $parts = $currentVersion -split '\.' | ForEach-Object { [int]$_ }
    switch ($Bump) {
        "major" { $newVersion = "$($parts[0] + 1).0.0" }
        "minor" { $newVersion = "$($parts[0]).$($parts[1] + 1).0" }
        "patch" { $newVersion = "$($parts[0]).$($parts[1]).$($parts[2] + 1)" }
    }
}

if ($newVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "'$newVersion' isn't a valid semver version (expected X.Y.Z)."
}

$tag = "v$newVersion"
if (git tag -l $tag) {
    throw "Tag $tag already exists."
}

# --- Release notes, computed from what's actually in this release --------
# (before the version-bump commit exists, so it isn't listed as if it were
# a real change).

if ($Notes) {
    $releaseNotes = $Notes
} else {
    $lastTag = git describe --tags --abbrev=0 2>$null
    if ($lastTag) {
        $commits = git log --oneline "$lastTag..HEAD"
    } else {
        $commits = git log --oneline
    }
    $releaseNotes = if ($commits) { ($commits | ForEach-Object { "- $_" }) -join "`n" } else { "No notable changes." }
}

Write-Host "Current version: $currentVersion"
Write-Host "New version:     $newVersion ($tag)"
Write-Host ""
Write-Host "Release notes:"
Write-Host $releaseNotes
Write-Host ""

if ($DryRun) {
    Write-Host "Dry run -- nothing was changed, committed, tagged, or published."
    exit 0
}

# --- Bump, commit, tag, push ----------------------------------------------

Set-Content -Path "version" -Value $newVersion -Encoding utf8
git add version
git commit -m "Release $tag" | Out-Null
git tag -a $tag -m "Release $tag"
git push origin $branch
git push origin $tag

# --- Publish the GitHub Release -------------------------------------------

$ghArgs = @("release", "create", $tag, "--title", $tag, "--notes", $releaseNotes)
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs

Write-Host ""
if ($Draft) {
    Write-Host "Draft release $tag created -- review and publish it on GitHub when ready:"
    Write-Host "  gh release view $tag --web"
    Write-Host "(The Docker image build only runs once you publish it, not for a draft.)"
} else {
    Write-Host "Released $tag."
    Write-Host "Docker image build triggered: gh run list --workflow=docker.yml"
}
