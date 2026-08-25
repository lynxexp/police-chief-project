# Police Chief Discord Bot

Discord Bot written in Python for managing alliances in *Police Chief* (Android package `com.slg.policewar`). This bot is free, open source and self-hosted.

**Repository:** https://github.com/lynxexp/police-chief-project

## Documentation

- **[Installation](docs/installation.md)** — running it locally or on a dedicated host (Docker), plus how to migrate an existing install's data to a new one.
- **[User Guide](docs/user-guide.md)** — for regular alliance members: registering, checking your stats, uploading screenshots.
- **[Admin Guide](docs/admin-guide.md)** — for alliance/server/global admins: settings, permissions, tracking channels, gift codes, scheduling.
- **[Owner Guide](docs/owner-guide.md)** — the small set of bot-owner-only actions: transferring ownership, backup/restore.
- **[Web Dashboard Guide](docs/webapp-guide.md)** — optional companion web dashboard: browser views of alliance stats, an event calendar, and admin tools. Not required — everything works from Discord alone.
- **[Web Dashboard Deployment](docs/webapp-deployment.md)** — running the optional web dashboard alongside the bot.

## Features

- **Alliance management** — register alliances, add/edit/remove members by ID, track
  nickname/Chief's Office level/state history, alliance-wide power tracking, and a
  tiered admin permission system (Bot Owner / Global Admin / Server Admin / Alliance
  Admin).
- **Vault Trap and Capitol War tracking with real OCR auto-detection** — upload a
  results screenshot and the bot parses damage/points and rankings and matches names to
  registered members automatically, with a review step before anything's saved.
  Capitol War tracking filters the game's state-wide rankings down to just your
  alliance using a configurable short tag. Other event types (PD Development, Arms
  Race, Officer Program, Hero Program, Alliance Faceoff, State Capitol Siege) are
  manual-entry only for now — no screenshots have been available yet to tune OCR
  parsing for them.
- **Self-registration** — members link their own in-game ID via `/register`, with
  automatic Discord role assignment (a generic "Registered" role plus one matching
  their alliance's short tag), and an optional welcome DM prompting new server members
  to register.
- **Gift code announcements** — admins add a gift code (with an optional note/expiry)
  and the bot posts an announcement embed to each alliance's configured channel with a
  link to Police Chief's redemption page. **The bot cannot redeem codes for members
  automatically**: unlike some other mobile SLGs, Police Chief's only known redemption
  surface (`policechief.walgames.com/en/redeemhub`) requires each player to log in via
  OAuth (Facebook/Google/Apple), so there's no player ID/key the bot could use to redeem
  on a member's behalf. Members redeem manually using the announced code and link; the
  bot just tracks which codes are active/expired.
- **Admin-configurable shift/appointment scheduler** — admins define their own
  appointment types (no fixed list), and members book/cancel time slots per type, with
  notifications, an admin manual-override, and an archive of past schedules with change
  history.
- **Admin-configured custom event reminder calendar** — admins create their own events
  (name, icon, first occurrence, recurrence, reminder lead times, target channel)
  through a setup wizard; the bot computes each event's next occurrence and posts
  reminder embeds automatically. There is no pre-filled event list — Police Chief has
  no publicly verified event calendar, so admins build their own from scratch.
- **Per-alliance activity log** — Discord-channel audit trail of member
  reactivate/deactivate/transfer actions and every completed Vault Trap/Capitol War
  submission.
- **Bot theming** — customize the emoji used throughout the bot's menus and embeds per
  server.
- **Backup & restore** — on-demand local or Discord-DM database backups, optionally
  password-protected, plus a validated `/restore` flow (Bot Owner only) with an
  automatic safety backup before anything's overwritten.
- **Web dashboard** *(optional add-on, not required)* — a browser companion covering
  alliance stats, leaderboards, attendance, a browsable event calendar, and admin tools
  (notifications, custom events, theming, permissions, backups) as an alternative to the
  equivalent Discord commands. Everything above works fully without it. See the
  [Web Dashboard Guide](docs/webapp-guide.md).

## Getting Started

See **[docs/installation.md](docs/installation.md)** for full setup instructions
(local Python or Docker), plus how to migrate an existing install's data to a new one.

Quick version: install Python 3.11+, clone this repo, put your bot token in
`bot_token.txt`, run `python main.py`, then run `/settings` in Discord.

## Support

This bot is community-maintained and self-hosted; there is no official support channel.
Check the [documentation](#documentation) first, then open an issue on this repository
if something's broken.

## License

MIT — see [LICENSE](LICENSE).
