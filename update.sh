#!/usr/bin/env bash
# Updates Police Chief Bot to the latest version and restarts it.
#
# Run this from the repo root whenever the bot DMs you that an update is
# available, or anytime you want to check. Plain `git pull` plus the two
# things that actually need doing around it: reinstalling dependencies
# only if requirements.txt actually changed, and restarting the bot.
#
# Never force-resets or discards anything -- if local edits conflict with
# the update, `git pull` says so and stops, same as any other git repo.
#
# If the bot is running under systemd (see police-chief-bot.service),
# this restarts it via systemctl instead of killing the process directly,
# so systemd's own state stays consistent.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

branch=$(git rev-parse --abbrev-ref HEAD)
echo "Checking for updates (branch: $branch)..."
git fetch origin "$branch"

behind=$(git rev-list --count "HEAD..origin/$branch")
if [ "$behind" -eq 0 ]; then
    echo "Already up to date."
    exit 0
fi

echo ""
echo "$behind new commit(s):"
git log --oneline "HEAD..origin/$branch"
echo ""

reqs_changed=$(git diff --name-only "HEAD..origin/$branch" -- requirements.txt)

if ! git pull origin "$branch"; then
    echo "git pull failed -- resolve the conflict above, then run this again."
    exit 1
fi

if [ -n "$reqs_changed" ]; then
    echo "requirements.txt changed -- reinstalling dependencies..."
    ./bot_venv/bin/pip install -r requirements.txt
fi

echo "Restarting the bot..."
if systemctl is-enabled --quiet police-chief-bot 2>/dev/null; then
    sudo systemctl restart police-chief-bot
else
    pkill -f "bot_venv.*main\.py|python.*main\.py" 2>/dev/null || true
    sleep 2
    nohup ./bot_venv/bin/python main.py > bot_stdout.log 2> bot_stderr.log &
    disown
fi

echo ""
echo "Updated and restarted. Check bot_stdout.log to confirm it came back up."
