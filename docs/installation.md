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
3. **Invite the bot to your server.** This is the one step that actually
   decides which server the bot ends up in — nothing later in this guide
   does, so it's worth walking through in full:
   1. In your application, go to **OAuth2 → URL Generator** (left sidebar).
   2. Under **Scopes**, check `bot` and `applications.commands`.
   3. Under **Bot Permissions** (a new section appears once `bot` is
      checked), check **Administrator**. The bot checks for Administrator
      on every `/settings` use and won't proceed without it — this is a
      hard requirement, not just a recommendation, since it manages roles,
      channels, and messages across many parts of your server.
   4. Copy the **Generated URL** at the bottom of the page and open it in a
      browser where you're logged into Discord.
   5. Discord shows a dropdown of every server where *you* have Manage
      Server permission. **You choose the server here** — this is the
      entire "which server" decision, made by you in Discord's own UI, not
      by anything the bot's code does. Pick your alliance's server and
      click **Authorize**.

   The bot's account is now a member of that server, independent of
   whether you've even downloaded the code yet. To add it to a second
   server later (or move it to a different one), reuse this exact same
   URL and go through the picker again — there's no separate "join
   another server" mechanism, it's this flow every time.
4. **Copy the bot token** from the Bot page (click "Reset Token" if you
   haven't generated one yet). Keep this secret — anyone with it can control
   your bot. You'll use this token in the next section, to actually log the
   bot process in — inviting it here only put its account in your server;
   it can't come online until it authenticates with this token.

## Option A: Run directly with Python

1. Install **Python 3.11 or newer**.
2. Clone this repository:
   ```bash
   git clone https://github.com/lynxexp/police-chief-project.git
   cd police-chief-project
   ```
3. Create a file named `bot_token.txt` in the repo root containing just the
   bot token you copied in **Before you start**, step 4 (no quotes, no
   extra whitespace). This is what actually logs the bot process into
   Discord — inviting it to your server earlier only added its account as
   a member; without a valid token here, it can't come online at all, and
   fails immediately with an "Invalid bot token" error.

   If you skip this step, `python main.py` just asks you for the token
   interactively on first run instead, and writes it to `bot_token.txt`
   itself so you're not asked again.
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
or get killed isn't watching anything).

Registering it as a Scheduled Task takes one command — `setup_watchdog_task.ps1`
(repo root) does the whole thing: registers it to run at every startup *and*
every 2 minutes, as SYSTEM so it works whether anyone's logged in or not, and
runs it once immediately to confirm it worked. From an elevated PowerShell
prompt, in the repo folder:

```powershell
.\setup_watchdog_task.ps1
```

Same script whether this is your own PC or a Windows VPS — a VPS is just a
Windows box you reach over RDP instead of sitting at, and Task Scheduler
doesn't care which. Re-running it later (after moving the repo, say) safely
replaces the old registration. To remove it: `Unregister-ScheduledTask
-TaskName "PoliceChiefBotWatchdog"`.

This also gives you the "runs unattended" behavior Option B (Docker) gets
for free from its restart policy — worth doing on any install left running
without someone watching it.

### Linux VPS without Docker

If you're running Option A directly on a Linux VPS (not Option B/Docker,
which already restarts itself via its own restart policy), the same gap
exists: nothing supervises the process, so a crash just leaves the bot down.
`police-chief-bot.service` (repo root) is a systemd unit that restarts it on
a crash or kill (not on a deliberate `systemctl stop`, and not on the bot's
own in-place `os.execl()` restart — see `cogs/bot_restart.py` — since that
never actually exits the process). Edit its `WorkingDirectory`/`ExecStart`
paths to match where you cloned the repo, then enable it:

```bash
sudo cp police-chief-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now police-chief-bot
```

## Option B: Docker

Better suited to a VPS or home server you want running unattended. A
`docker/` folder is included with a `Dockerfile`, `docker-compose.yml`, and
`bootstrap.sh`.

**Want the web dashboard too, not just the bot?** `docker-compose.yml`
already defines both as one stack (`police-chief-bot` and
`police-chief-webapp` services in the same file) — skip this section
entirely and follow [webapp-deployment.md's "Deploying to a
VPS"](webapp-deployment.md#deploying-to-a-vps) instead, which covers
both together from a single `docker compose up -d`.

1. Clone the repository (same as above).
2. Build the image from the repo root:
   ```bash
   docker build -t police-chief-bot:latest -f docker/Dockerfile .
   ```
3. Open `docker/docker-compose.yml` and replace
   `DISCORD_BOT_TOKEN=<your bot token here>` under `police-chief-bot`
   with your actual token (the one from **Before you start**, step 4),
   then start **just that service**:
   ```bash
   docker compose -f docker/docker-compose.yml up -d police-chief-bot
   ```
   Naming the service, rather than a bare `up -d`, matters here — the
   same file also defines `police-chief-webapp`, and a bare `up -d`
   would try to start it too, unconfigured, which exits immediately on
   a missing `DISCORD_CLIENT_ID`/`SESSION_SECRET`/etc. and then
   crash-loops forever under `restart: unless-stopped`.

   Also note the token has to be edited into the file itself — it's a
   literal placeholder there, not a `${DISCORD_BOT_TOKEN}` substitution,
   so setting an environment variable of that name first has no effect.

   `docker-compose.yml` mounts a local `db/` folder into the container so
   your data survives container restarts/rebuilds — check the compose file
   before your first run if you want to change where that lives on the host.
4. Check logs with `docker compose -f docker/docker-compose.yml logs -f`,
   then follow the same first-time `/settings` steps as Option A above.

Restarts behave differently in a container: the bot just exits, and your
orchestrator (Docker's own restart policy, or Kubernetes/Podman if you're
running it that way) is expected to bring it back up automatically — no
manual restart command needed, unlike the Windows-host case above.

## Staying updated

The bot checks GitHub for new releases every 6 hours (and once at startup)
and DMs the Global Admin when it's behind — see the **Version** line and
**Update Checks** toggle in the Bot Health menu (`/health`) if you want to
turn that off and update on your own schedule instead. Either way, updating
itself is one step:

- **Option A (Windows):** run `update.ps1` from the bot's folder. It pulls
  the latest code, reinstalls dependencies only if `requirements.txt`
  actually changed, and restarts the bot for you.
- **Option A (Linux/Mac):** run `./update.sh` — same thing, and it restarts
  via `systemctl` automatically if you've set up
  `police-chief-bot.service`.
- **Option B (Docker):** `git pull && docker compose pull && docker compose up -d`
  — both the bot and (if you're running it) the web dashboard publish real
  images to GHCR now (see the comments in `docker-compose.yml`), so this
  pulls prebuilt images rather than rebuilding locally. Each image's GHCR
  package needs to be set to Public once (Package settings → Danger Zone →
  Change visibility) before `pull` works — it's private by default, and
  fails with "unauthorized" until then. If you'd rather not depend on the
  registry, `docker compose up -d --build` still rebuilds locally instead.
  See [webapp-deployment.md](webapp-deployment.md#deploying-to-a-vps) for
  Watchtower, which automates this `pull && up -d` step entirely.

Neither script ever discards local changes — if you've edited tracked
files yourself, `git pull` will say so and stop, same as it would running
the command by hand.

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
