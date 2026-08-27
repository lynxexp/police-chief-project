# Installation

Two ways to run the bot: directly with Python (simplest for a single alliance
on your own machine), or in Docker (better for a dedicated host/VPS you want
running continuously). Both use the same `db/` folder layout and config, so
you can start local and move to Docker later without losing data — see
[Migrating between installs](#migrating-between-installs) at the bottom.

## Before you start

1. **A Discord bot application.** Go to
   [discord.com/developers/applications](https://discord.com/developers/applications),
   create a new application, then add a Bot user to it.
2. **Privileged Gateway Intents.** In the application's **Bot** page, enable:
   - **Server Members Intent** — required for new-member welcome DMs and
     several member-lookup features. Without this the bot will fail to log
     in with a clear error telling you to enable it.
   - **Message Content Intent** — required to read messages in Vault Trap /
     Capitol War tracking channels and ID-lookup channels.
3. **Invite the bot to your server** with the `applications.commands` and
   `bot` scopes, and grant it **Administrator** permission. The bot checks
   for Administrator on every `/settings` use and won't proceed without it —
   this is a hard requirement, not just a recommendation, since the bot
   manages roles, channels, and messages across many parts of your server.
4. **Copy the bot token** from the Bot page (click "Reset Token" if you
   haven't generated one yet). Keep this secret — anyone with it can control
   your bot.

## Option A: Run directly with Python

1. Install **Python 3.11 or newer**.
2. Clone this repository:
   ```bash
   git clone https://github.com/lynxexp/police-chief-project.git
   cd police-chief-project
   ```
3. Create a file named `bot_token.txt` in the repo root containing just your
   bot token (no quotes, no extra whitespace).
4. Run it:
   ```bash
   python main.py
   ```
   On first run this automatically creates a virtual environment
   (`bot_venv/`) and installs everything from `requirements.txt` — no manual
   `pip install` needed. Subsequent runs reuse the same venv and start much
   faster.
5. Once you see `Connected to Discord as <YourBot>#____` in the console,
   go to your Discord server and run `/settings`.

### First-time setup in Discord

The **first person** to run `/settings` on a fresh install is automatically
made the **Bot Owner** — the highest permission tier (see the
[Owner Guide](owner-guide.md)). Make sure this is you or someone you trust;
there's no separate "claim ownership" step for a genuinely fresh install.

From there, `/settings` → **Alliances** → **Add Alliance** to create your
first alliance, then use **Channel Setup** to point the bot at your
Vault Trap / Capitol War tracking channels, gift code channel, and log
channel. See the [Admin Guide](admin-guide.md) for the full settings tour.

### Restarting

On Windows, the bot does **not** auto-restart itself (a technical limitation —
see the code comments in `cogs/bot_restart.py` if you're curious). Whenever
something in the bot triggers a restart (the Restart Bot button, or a
successful `/restore`), it exits cleanly and prints the exact command to run
again. On Linux/Mac it restarts itself in place automatically.

This also means an **unexpected** exit (a crash, or the process getting
killed) needs the same manual `python main.py` — and unless someone notices,
the bot can simply stay down with no reminder for anyone that it happened.
`watchdog.ps1` (repo root) closes that gap: it checks a heartbeat the bot
writes every 30 seconds (`heartbeat.txt`, via `cogs/bot_health.py`) and, if
it's gone stale — dead process or a hung one — kills anything still running
and starts a fresh `python main.py`, logging what it did to `watchdog.log`.
It's a check-once-and-exit script, meant to run on a repeating schedule
rather than as its own long-lived process (a watchdog that can itself hang
or get killed isn't watching anything). Register it as a Scheduled Task —
run this once, from an elevated PowerShell prompt, adjusting the path if
your clone lives somewhere else:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\police-chief-bot\watchdog.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
Register-ScheduledTask -TaskName "PoliceChiefBotWatchdog" -Action $action -Trigger $trigger -Description "Restarts Police Chief Bot if it stops responding" -RunLevel Highest
```

This also gives you the "runs unattended" behavior Option B (Docker) gets
for free from its restart policy — worth doing on any Windows install left
running without someone watching it.

## Option B: Docker

Better suited to a VPS or home server you want running unattended. A
`docker/` folder is included with a `Dockerfile`, `docker-compose.yml`, and
`bootstrap.sh`.

1. Clone the repository (same as above).
2. Build the image from the repo root:
   ```bash
   docker build -t police-chief-bot:latest -f docker/Dockerfile .
   ```
3. Set your bot token as an environment variable and start it:
   ```bash
   export DISCORD_BOT_TOKEN=your_token_here
   docker compose -f docker/docker-compose.yml up -d
   ```
   `docker-compose.yml` mounts a local `db/` folder into the container so
   your data survives container restarts/rebuilds — check the compose file
   before your first run if you want to change where that lives on the host.
4. Check logs with `docker compose -f docker/docker-compose.yml logs -f`,
   then follow the same first-time `/settings` steps as Option A above.

Restarts behave differently in a container: the bot just exits, and your
orchestrator (Docker's own restart policy, or Kubernetes/Podman if you're
running it that way) is expected to bring it back up automatically — no
manual restart command needed, unlike the Windows-host case above.

## Migrating between installs

If you've been testing on one server/machine and want to move to a
different one (e.g. local → Docker host, or test server → production
server) without losing your Vault Trap/Capitol War history, member
registrations, and admin permissions:

1. On the old install, back up everything: `/settings` → **Backup** →
   **Create Backup Now** → **Save Locally**. This captures all 16 database
   files in one zip, safely even while the bot is running.
2. Copy that zip to the new install.
3. Start the bot on the new install (following Option A or B above), invite
   it to the target server, and run `/settings` there once (this makes
   whoever runs it first an admin — needed so `/restore` has an Owner to
   authorize it).
4. Run `/restore file:<the backup zip>` — Bot Owner only. It validates the
   backup, shows you exactly what it'll restore, takes a fresh safety
   backup of whatever's currently there first, then writes the restored
   data and restarts.
5. `/settings` → **Alliances** → your alliance → **Change Server** to
   repoint the alliance record at the server you're now running on — this
   is the one field that doesn't travel automatically with the backup,
   since it's inherently tied to whichever Discord server the alliance was
   originally created on.
6. Reconfigure channels (`Channel Setup`, log channel, redemption channel,
   etc.) to point at the new server's actual channels — the old channel IDs
   won't resolve here.

See the [Owner Guide](owner-guide.md#backup--restore) for more on backup/restore specifics.
