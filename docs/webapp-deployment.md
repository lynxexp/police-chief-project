# Web dashboard deployment

Covers running `webapp/` alongside the bot with Docker Compose — locally
first, then on a VPS (see [Deploying to a VPS](#deploying-to-a-vps) for
the typical from-scratch path), and exposing it publicly through a
reverse proxy. See the webapp's own `.env.example` and
`webapp/backend/src/config.ts` for what every setting actually does.

## One-time setup: Discord OAuth credentials

On the **same** Discord Application the bot token already belongs to
(never a new one):

1. [discord.com/developers/applications](https://discord.com/developers/applications) → open that application.
2. **OAuth2 → General** → Redirects → add `http://localhost:3000/api/auth/callback`
   (or your real domain's `/api/auth/callback` once you're past local-only).
3. Generate a Client Secret there too (shown once — copy it immediately).

## Local (loopback-only)

Good for trying the dashboard out or developing against real data before
committing to a VPS. Everything here also applies verbatim on a VPS —
see [Deploying to a VPS](#deploying-to-a-vps) below for the full
from-scratch walkthrough (provisioning, firewall, DNS, the works).

1. Build both images from the **repo root**:
   ```bash
   docker build -t police-chief-bot:latest -f docker/Dockerfile .
   docker build -t police-chief-webapp:latest -f webapp/Dockerfile .
   ```
   (Change `docker/docker-compose.yml`'s `police-chief-bot` `image:` line
   back to `police-chief-bot:latest` if you build it locally rather than
   pulling — see the comment there.)
2. Fill in `docker/docker-compose.yml`'s `police-chief-webapp` service:
   `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
   (same token the bot uses), and a `SESSION_SECRET` you generate once
   and never change (`openssl rand -base64 32`) — rotating it invalidates
   every existing session.
3. `docker compose -f docker/docker-compose.yml up -d`
4. Visit `http://localhost:3000`.

This binds to `127.0.0.1:3000` only — reachable from the host machine,
not the internet. That's the entire point of leaving `TRUST_PROXY=false`
here: there's no proxy in front of it yet, so the app must not trust
`X-Forwarded-*` headers from anywhere.

Sessions and OAuth tokens live in the `police-chief-bot/webapp-db/` bind
mount (separate from the bot's own `db/`, so nothing that touches the
bot's data can wipe web sessions or vice versa).

## Deploying to a VPS

The typical way to run this for a real alliance: one small VPS running
both the bot and the dashboard continuously, unattended, reachable from
the internet. This walks through a fresh VPS from nothing to a working
dashboard at your own domain. Everything is Docker, so the OS distinction
mostly stops mattering after step 2 — Ubuntu is used for concrete
commands, but any Linux distribution with a current Docker install works
the same from that point on.

### Requirements

- **A VPS running Linux** (Ubuntu 22.04/24.04 LTS is the least friction —
  every command below assumes it; Debian is nearly identical). Any
  mainstream provider works — this doesn't depend on anything
  provider-specific.
- **1 vCPU / 2 GB RAM / 20 GB disk** is comfortably enough for the bot,
  the dashboard, and Docker's own image/log overhead together, with room
  to grow. The bot process itself is much lighter — its own health check
  is tuned to warn under 500 MB free and treat 1 GB total as a normal,
  supported floor (see `DISK_FREE_WARNING_MB` in `cogs/bot_health.py`) —
  but the two Docker images, their build layers, and Node's dependency
  tree for the dashboard push the realistic minimum for *this combined*
  deployment well above what the bot needs alone. 1 GB RAM can work for
  the bot in isolation but leaves very little headroom once the webapp
  and Docker itself are also running on the same box.
- **A domain name** (or a subdomain) pointed at the VPS, if you want the
  dashboard reachable at a real URL instead of by IP — needed for the
  reverse-proxy step later, optional if you're fine reaching it over SSH
  port-forwarding or a VPN instead.
- **SSH access** to the VPS (every provider gives you this at
  provisioning time, usually as `root` with a password or an SSH key you
  uploaded).
- Everything from [Before you start](installation.md#before-you-start) in
  the main installation guide — the Discord application, its bot token,
  and the bot already invited to your server. The dashboard piggybacks on
  the same Discord application (see **One-time setup** above) rather than
  needing a second one.

### 1. Provision the VPS and do first-login hardening

Create the VPS through your provider's dashboard (Ubuntu 22.04 or 24.04
image), then SSH in as the initial user (usually `root`):

```bash
ssh root@your.vps.ip.address
```

Running everything as `root` long-term is avoidable risk for no benefit
here — create a normal user with `sudo`, and lock down SSH to key-based
login only:

```bash
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copies your existing authorized key over, if you provisioned with one
```

Log out and back in as `deploy` from here on (`ssh deploy@your.vps.ip.address`).
If you provisioned without an SSH key and are still on password auth,
set one up now (`ssh-copy-id deploy@your.vps.ip.address` from your own
machine) before disabling password login in `/etc/ssh/sshd_config`
(`PasswordAuthentication no`, then `sudo systemctl restart sshd`) — do
this only after confirming key-based login actually works, or you'll
lock yourself out.

### 2. Firewall

`ufw` ships enabled-but-inactive on most Ubuntu images. Open only what's
actually needed — SSH, and HTTP/HTTPS for the reverse proxy — before
turning it on, or you'll cut your own SSH session:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Note that **3000 (the dashboard's own port) is deliberately never opened
here** — Compose only binds it to `127.0.0.1` (see the `ports:` entry in
`docker/docker-compose.yml`), so it's unreachable from outside the VPS
either way; the reverse proxy (added later, on 80/443) is the only public
entry point by design.

### 3. Install Docker

Docker's own convenience script is the least error-prone way to get a
current Docker Engine + Compose plugin on a fresh box:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in (or `newgrp docker`) to pick up the group change,
then confirm both pieces are present:

```bash
docker --version
docker compose version
```

### 4. Point DNS at the VPS

Skip this if you're not exposing the dashboard publicly yet. In your
domain registrar or DNS provider, add an **A record** (or AAAA, for
IPv6) for the subdomain you want (e.g. `dashboard.youralliance.com`)
pointing at the VPS's public IP. DNS propagation is usually fast but can
take up to a few hours — the reverse-proxy step later depends on this
already resolving correctly, so it's worth starting the propagation now
and moving on to the next steps while it settles.

### 5. Clone the repository

```bash
sudo mkdir -p /opt/docker/police-chief-bot
sudo chown $USER:$USER /opt/docker/police-chief-bot
git clone https://github.com/lynxexp/police-chief-project.git /opt/docker/police-chief-bot/src
cd /opt/docker/police-chief-bot/src
```

`/opt/docker/police-chief-bot/` is the convention `docker/docker-compose.yml`'s
bind mounts already assume (`db/`, `webapp-db/` live as siblings of `src/`
here) — using it as-is means you won't need to edit any volume paths.

### 6. Discord OAuth credentials

Follow [One-time setup: Discord OAuth credentials](#one-time-setup-discord-oauth-credentials)
above now if you haven't already — same steps, same Discord application.
Use your real domain's callback URL from the start
(`https://dashboard.youralliance.com/api/auth/callback`) rather than
`localhost`, since this deployment is headed straight for public access;
you can always add `localhost` alongside it later for local dev.

### 7. Configure the environment

Open `docker/docker-compose.yml` and fill in the `police-chief-bot` and
`police-chief-webapp` services' `environment:` blocks: the bot token,
`DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` from the step above,
`DISCORD_REDIRECT_URI` set to your real domain's callback URL, and a
`SESSION_SECRET` generated once with `openssl rand -base64 32` (see
[Session secret rotation](#session-secret-rotation) for what happens if
this ever changes). Leave `TRUST_PROXY=false` for now — it flips to
`true` in the reverse-proxy step below, not before.

### 8. Get the images

The webapp has no published image (no CI pipeline builds one yet) — it's
always built locally:

```bash
docker build -t police-chief-webapp:latest -f webapp/Dockerfile .
```

The bot does have a published image, built and pushed by
`.github/workflows/docker.yml` on every release
(`ghcr.io/lynxexp/bot:latest`, matching `docker/docker-compose.yml`'s
default) — **but only once that package's visibility is set to Public**.
GitHub packages published with the default `GITHUB_TOKEN` start out
private even on a public repository, so check this once at
`github.com/users/lynxexp/packages/container/bot/settings` → **Danger
Zone** → **Change visibility**. Once it's public:

```bash
docker compose -f docker/docker-compose.yml pull police-chief-bot
```

If you'd rather not depend on the registry at all (or the package is
still private), build the bot locally instead and point the compose file
back at the local tag:

```bash
docker build -t police-chief-bot:latest -f docker/Dockerfile .
```
```yaml
# docker/docker-compose.yml
police-chief-bot:
  image: police-chief-bot:latest   # instead of ghcr.io/lynxexp/bot:latest
```

### 9. Start everything

```bash
docker compose -f docker/docker-compose.yml up -d
docker compose -f docker/docker-compose.yml logs -f
```

Watch for the bot's `Connected to Discord as <YourBot>#____` line and
the webapp's server-started log. `Ctrl+C` exits the log follow without
stopping the containers.

### 10. Verify

From the VPS itself (or via SSH port-forwarding — `ssh -L 3000:localhost:3000 deploy@your.vps.ip`
— if you haven't added the reverse proxy yet): visit
`http://localhost:3000` and confirm the Discord sign-in screen loads.
In Discord, run `/settings` in your server and confirm the bot responds.
Once both check out, move on to making it reachable at your real domain.

### 11. Go public with a reverse proxy

Continue with [Going public: adding a reverse proxy](#going-public-adding-a-reverse-proxy)
below — same steps here as on any other host, using the domain you
pointed at this VPS in step 4.

### 12. Staying updated

```bash
cd /opt/docker/police-chief-bot/src
git pull
docker compose -f docker/docker-compose.yml build police-chief-webapp
docker compose -f docker/docker-compose.yml pull police-chief-bot   # or rebuild it locally, matching whichever you chose in step 8
docker compose -f docker/docker-compose.yml up -d
```

Same "never discards local changes" guarantee as the Windows/Linux
`update.ps1`/`update.sh` scripts in the main [installation guide](installation.md#staying-updated) —
`git pull` stops and tells you if you've edited a tracked file yourself.

### Migrating an existing install's data to this VPS

If you already have a running local or test deployment and want to move
its data here rather than starting fresh, use the bot's own `/backup`
and `/restore` — the [Migrating between installs](installation.md#migrating-between-installs)
flow in the main installation guide, run once for this move too — rather
than copying `db/` over by hand. It's strictly better than a raw file
copy: it validates the backup on the way in, takes a fresh safety backup
of whatever's already there before writing anything, and never risks
grabbing a `.sqlite` file mid-write the way copying a live `db/` folder
can. Concretely:

1. Do steps 1–8 above first (VPS ready, repo cloned, images available,
   but not yet started), then start the containers (step 9) with a
   **fresh** `db/` — don't copy anything over yet.
2. On the **old** install: `/settings` → **Backup** → **Create Backup
   Now** → **Save Locally**. Copy the resulting zip to the VPS however's
   convenient (`scp`, a Discord DM to yourself, whatever).
3. On the **new** (VPS) install: run `/settings` once first if you
   haven't (this makes whoever runs it the Bot Owner, so `/restore` has
   someone authorized to run it), then `/restore file:<the backup zip>` —
   Bot Owner only.
4. Finish the rest of the [Migrating between installs](installation.md#migrating-between-installs)
   checklist — **Change Server** for your alliance and reconfiguring
   channels — since those don't travel with the backup either way.

This covers all of the bot's own data (alliance records, Vault Trap/
Capitol War history, members, permissions — everything under `db/`).
It does **not** cover `webapp-db/` — the dashboard's session/OAuth
database is a separate folder the bot's backup system never looks at.
That's fine to just leave behind: existing dashboard users see a normal
"sign in with Discord" screen once and nothing alliance-related is at
risk. If you'd rather preserve existing web sessions anyway, copy
`webapp-db/` over by hand the same way as before
(`/opt/docker/police-chief-bot/webapp-db/` on the new host) — it's a much
smaller, lower-stakes file than `db/`, so a raw copy there is fine even
though it isn't for the bot's own data.

The only value that actually has to change between hosts is
`DISCORD_REDIRECT_URI` (and the matching redirect URI registered in the
Discord Developer Portal) — everything else about the deployment is
host-independent by design.

## Going public: adding a reverse proxy

Once you actually want this reachable from outside the host, add a
`caddy` service rather than exposing the webapp's port directly —
automatic Let's Encrypt, minimal config, and it's the natural point to
also terminate TLS for any other service you run later.

1. In `docker/docker-compose.yml`, stop publishing the webapp's port to
   the host: delete its `ports:` entry.
2. Add a `networks:` bridge so Caddy can reach `police-chief-webapp` by
   service name (compose gives every service on a shared network a DNS
   entry matching its name automatically).
3. Add the `caddy` service, with a `Caddyfile` reverse-proxying your
   domain to `police-chief-webapp:3000`.
4. Flip `TRUST_PROXY=true` on the webapp service. This is what makes the
   session cookie's `Secure` flag and the OAuth redirect scheme trust
   `X-Forwarded-Proto` from Caddy instead of assuming plain HTTP — do
   this **only** once a real proxy is actually terminating TLS in front
   of the app, never before, or the app will trust forwarded headers an
   attacker could otherwise spoof directly.
5. Update `DISCORD_REDIRECT_URI` to `https://yourdomain.example/api/auth/callback`
   and add that exact URI in the Discord Developer Portal (Discord
   matches redirect URIs by exact string — old ones can stay registered
   alongside new ones, no need to remove `localhost` for continued local
   dev access).

## Session secret rotation

If `SESSION_SECRET` is ever rotated (leak, routine hygiene), every
existing session and in-flight OAuth login becomes invalid immediately —
users just see a normal "sign in with Discord" screen again, nothing
breaks, but plan for it rather than doing it mid-incident without
warning anyone.
