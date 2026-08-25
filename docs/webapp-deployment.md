# Web dashboard deployment

Covers running `webapp/` alongside the bot with Docker Compose, and the
later move to exposing it publicly through a reverse proxy. See the
webapp's own `.env.example` and `webapp/backend/src/config.ts` for what
every setting actually does.

## One-time setup: Discord OAuth credentials

On the **same** Discord Application the bot token already belongs to
(never a new one):

1. [discord.com/developers/applications](https://discord.com/developers/applications) → open that application.
2. **OAuth2 → General** → Redirects → add `http://localhost:3000/api/auth/callback`
   (or your real domain's `/api/auth/callback` once you're past local-only).
3. Generate a Client Secret there too (shown once — copy it immediately).

## Local (loopback-only)

1. Build both images from the **repo root**:
   ```bash
   docker build -t police-chief-bot:latest -f docker/Dockerfile .
   docker build -t police-chief-webapp:latest -f webapp/Dockerfile .
   ```
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

## Moving to a VPS

Same compose file, same bind-mount convention (`/opt/docker/police-chief-bot/...`
on the new host). Copy `db/` and `webapp-db/` over, `docker compose up -d`.
The only value that has to change is `DISCORD_REDIRECT_URI` (and the
matching redirect URI registered in the Discord Developer Portal) —
everything else about the deployment is host-independent by design.

## Session secret rotation

If `SESSION_SECRET` is ever rotated (leak, routine hygiene), every
existing session and in-flight OAuth login becomes invalid immediately —
users just see a normal "sign in with Discord" screen again, nothing
breaks, but plan for it rather than doing it mid-incident without
warning anyone.
