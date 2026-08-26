# Admin Guide

Everything here requires being an admin in the bot's own permission system —
separate from Discord's server roles. See [Permission tiers](#permission-tiers)
below for how that works. Almost everything in this guide is reached through
one command:

```
/settings
```

If you manage only one alliance, `/settings` → Alliances skips straight to
that alliance's hub instead of making you pick from a list.

## Permission tiers

Four tiers, checked independently of Discord's own server roles/permissions:

| Tier | Scope |
|---|---|
| **Bot Owner** | Everything, everywhere. Exactly one at a time. See the [Owner Guide](owner-guide.md). |
| **Global Admin** | Every alliance, on every server the bot is in, plus admin management itself. |
| **Server Admin** | Every alliance on *their* Discord server (no explicit alliance assignments). |
| **Alliance Admin** | Only the specific alliance(s) they've been assigned to. |

Adding/removing admins and changing tiers is Global-Admin-and-up only:
`/settings` → **Permissions**. Pick a user, assign a tier, and (for Alliance
Admin) which alliance(s) they can manage. There's also an audit log here of
every admin change (who did what, when).

## Alliance management

`/settings` → **Alliances** → **Add Alliance** to create one, or pick an
existing alliance to open its hub, which has:

- **Manage Members** — add/edit/deactivate members by ID, bulk actions,
  power rankings, nickname/level history.
- **Channel Setup** — point the bot at your Vault Trap, Capitol War, gift
  code, and ID-lookup channels for this alliance.
- **Edit Name**, **Set State** (locks the alliance to one state/server
  number if it spans multiple), **Set Tag** (the 3-character in-game tag,
  e.g. "APX" — used to filter Capitol War's state-wide rankings down to just
  your alliance, and to auto-create the matching Discord role on member
  registration).
- **History** — alliance-wide change history.
- **Power Rankings** — member power leaderboard.
- **State Lock** / **Auto-remove Transfers** — toggles.
- **Change Server** — repoints this alliance at whichever Discord server
  you run this from. Only needed when moving the bot to a different
  install; see [Migrating between installs](installation.md#migrating-between-installs).
- **Delete Alliance** — removes the alliance and all its data. Confirmation
  required; this cannot be undone (short of restoring an earlier backup).

## Member registration

`/settings` → **Self-Registration** controls the global `/register` on/off
switch, plus how the bot handles "ID channels" (channels members can post
their raw in-game ID into, which the bot scans and responds to).

Per-alliance, under **Vault Trap Tracking** / **Capitol War Tracking**
settings, two independent toggles control who can interact with each
tracker:

- **Add Permission** — "Everyone" or "Admins only." Gates *both* the manual
  `/vault_damage_add` / `/capitol_add` commands **and** uploading
  screenshots directly to the tracking channel. Default: Everyone.
- **View Permission** — same idea, for viewing saved data.

## Vault Trap / Capitol War tracking

Each alliance's tracking channels (set via Channel Setup) auto-detect
uploaded screenshots, OCR them, and walk the uploader through a review
before saving. Per-alliance settings (`/settings` → alliance → **Vault Trap
Tracking** / **Capitol War Tracking**) include:

- **Session Timeout** — how long to wait for more screenshots (a multi-page
  result) before finalizing.
- **Toggle Auto-Delete** — delete the uploaded screenshots after the
  session is fully resolved (Submit, Cancel, or timeout — not just Submit).
  On by default.
- **Toggle Add/View Permission** — see above.
- **Toggle Full Name History Match** (Vault Trap only) — match players by
  every name they've ever used, not just their current one.
- **Toggle Info Message / Pin Info** — post (and optionally pin) a helper
  message in the channel explaining what to upload.

Capitol War specifically needs the alliance's **Set Tag** filled in (see
above) — without it, the bot can't tell your members apart from the rest of
the state-wide rankings the game shows.

## Activity log

`/settings` → alliance → **Set Log Channel** (reached from the alliance
hub). Once set, the bot posts audit-trail embeds there for:

- Member reactivate/deactivate/transfer actions.
- Every completed Vault Trap / Capitol War submission (who, what date, how
  many players matched).

This is separate from the OS-level log files (`log/` folder) the bot also
keeps — this one's meant for admins to actually see in Discord.

## Gift codes

`/settings` → alliance → gift code settings to set the announcement channel.
Admins add codes with an optional note/expiry; the bot posts an
announcement with a link to the redemption page. Redemption itself is
always manual — see the [User Guide](user-guide.md#gift-codes) for why.

## Shift / appointment scheduler

Fully admin-defined — there's no fixed list of appointment types. Create
your own types, and the bot handles the booking UI, notifications, manual
overrides, and archiving past schedules with change history.

## Custom event calendar

`/settings` → notification/event setup wizard. Create events (name, icon,
first occurrence, recurrence rule, reminder lead times, target channel) —
there's no pre-filled calendar, since Police Chief has no publicly verified
event schedule. The bot computes each event's next occurrence and posts
reminders automatically once you've defined it.

Each event has a **Turn Notifications Off/On** toggle. With notifications
off, the event still recurs and still shows up on the calendar (including
the member-facing web [Event calendar](webapp-guide.md#event-calendar)), but
nothing gets posted to Discord — no reminder times, message, or channel to
set. Turn it back on to configure those and resume posting.

## Bot theming

`/pimp menu` — customize which emoji the bot uses throughout its menus and
embeds, per server. Themes can be exported/imported as JSON, or shared to an
online gallery.

## Backups

`/settings` → **Backup** — any Global Admin can create one (DM or local
save, optionally password-protected) and configure automatic backup
scheduling/retention. **Restoring** a backup is Bot-Owner-only — see the
[Owner Guide](owner-guide.md#backup--restore).

## Restarting the bot

`/settings` → **Maintenance** → **Restart Bot** (Global Admin and up). Shows
a confirmation, warns if there's work in flight, then restarts. On Windows
this means the process exits and you'll need to run `python main.py` again
manually — see [Installation](installation.md#restarting).
