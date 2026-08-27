# Web dashboard guide

The web dashboard is an **optional add-on**, not a replacement for the Discord
bot — every feature it exposes is a companion view onto the same data the bot
already manages, and nothing here is required for the bot itself to work.
Skip this entirely if you're happy running everything through Discord slash
commands; the [User Guide](user-guide.md), [Admin Guide](admin-guide.md), and
[Owner Guide](owner-guide.md) cover that experience fully on their own.

If you do want it running, see [Web dashboard deployment](webapp-deployment.md)
first — this guide assumes it's already up and reachable in a browser.

## Signing in

Open the dashboard's URL and click **Sign in with Discord**. You'll be asked
to authorize the same Discord application the bot itself runs under — this
isn't a separate account system, it's your existing Discord identity.

- If you administer alliances on more than one Discord server, you'll land
  on a **"Which server?"** picker first. Pick one; you can switch later by
  signing out and back in (or by revisiting that picker if you administer
  guilds you haven't picked yet).
- If you're not an admin anywhere and have no in-game IDs linked to your
  Discord account, you'll see an empty profile page — that's expected, there's
  nothing to show yet. Link an ID with `/register` in Discord first (see the
  [User Guide](user-guide.md#getting-started-link-your-in-game-id)).

Every page in the dashboard shows your current **permission tier** (None /
Alliance / Server / Global / Owner) in the top-right corner — the same four
admin tiers described in the [Admin Guide](admin-guide.md#permission-tiers).
The dashboard enforces the exact same rules as the Discord bot's `/settings`
menu: what you can reach here is never more (or less) than what you could
already do in Discord.

## For every member

Nothing in this section requires any admin tier — just a Discord login and at
least one linked in-game ID (or membership in an alliance, for the
alliance-wide pages).

### Your profile (home page)

Lists every in-game ID linked to your Discord account, each showing its
alliance, Chief's Office level, and power. Click **View alliance →** on any
of them to open that alliance's overview.

### Alliance overview

Reached from your profile, or from any leaderboard/member page's back link.
Shows:

- **Vault Trap total damage** and **Capitol War total points** trend charts
  (one line per Vault Trap number, since most players only run one trap and
  mixing them into a single total would be misleading).
- The full **roster** — name, Chief's Office level, power — click any name
  to open their member detail page.
- Quick links to the Vault/Capitol leaderboards, attendance pages, and the
  event calendar.

### Leaderboards

`Alliance overview → Vault leaderboard` / `Capitol leaderboard`. Ranked by
total damage/points, with hunt/event counts and averages. The Vault
leaderboard splits into per-trap tabs (**Overall**, **Vault 1**, **Vault 2**,
...) whenever an alliance has more than one trap in use.

### Attendance

`Alliance overview → Vault attendance` / `Capitol attendance`. Shows how many
of the alliance's logged hunts/events each member actually appears in, as a
count and a percentage bar. Click **Export CSV** to download the
currently-displayed table (respecting whichever trap tab is selected) as a
spreadsheet.

### Member detail

Click any member's name anywhere in the dashboard. Shows:

- Vault Trap damage and Capitol War points trend charts.
- A power / combat power history chart.
- Nickname and Chief's Office level change history, with an **Export CSV**
  button that combines all four change logs (nickname, Chief's Office,
  power, combat power) into one file.

### Event calendar

`Alliance overview → Event calendar`. A month-grid calendar showing both
upcoming and past events for the alliance's Discord server — sourced from
admin-configured notifications and custom events (see
[Notifications](#notifications) and [Custom events](#custom-events) below).
Click any day to see its full event list in a panel underneath. Past events
are greyed out; future ones are highlighted. Navigate months with **Prev** /
**Next** / **Today**. This is genuinely new — there's no equivalent single
view in Discord, since the bot posts reminders as they happen rather than
showing a browsable calendar.

**Subscribe on your device** — click this button to add the alliance's
upcoming events to your phone or computer's own calendar app (Apple
Calendar, Outlook, Google Calendar), so you can use its normal reminder
alerts instead of relying on Discord. You get a **webcal://** link for a
one-click subscribe in Apple Calendar/Outlook, and a plain **https://** link
to paste into Google Calendar's **Other calendars → From URL**. The link is
personal to you (it's tied to your account, not the alliance) — don't share
it. Subscribed calendars only carry upcoming events (not past ones) and
refresh automatically every few hours as your calendar app re-polls it. If a
link leaks or you no longer trust a device it's on, click **Generate new
link** — the old link stops working immediately.

### Gift codes

Top nav → **Gift codes** (visible to everyone, no admin tier needed). Lists
currently active, non-expired codes with their notes. Redemption is always
manual — see the [User Guide](user-guide.md#gift-codes) for why the bot can't
redeem codes on your behalf.

## For admins

Everything below requires some admin tier (Alliance, Server, Global, or
Owner) — the same permission system described in the
[Admin Guide](admin-guide.md#permission-tiers). Pages you don't have the
right tier for either won't show relevant links, or will show a "not
authorized" response if you navigate there directly.

The **Admin** link (top nav, visible to any admin tier) takes you to the
admin home page: the list of alliances you can manage, plus (Global-tier and
up) quick links to admins, audit log, gift codes, themes, and (Owner-only)
backups.

### Alliance members

`Admin → pick an alliance`. A management-focused roster view showing fields
the member-facing roster doesn't: Discord link status, kingdom ID, active/
inactive status. Search by name or fid. Actions per member:

- **Deactivate** / **Reactivate**.
- **Link Discord…** / **Unlink Discord** — manually associate a member's
  in-game ID with a specific Discord user ID and server ID (mostly useful
  for fixing a mismatch or setting one up on a member's behalf).

### Channel setup

`Alliance members → Channel setup`. One page covering several independent
settings:

- **Main channel**, **gift redemption channel**, **Vault Trap score
  channel**, **Capitol War score channel** — same channel assignments as
  Discord's `/settings` → Channel Setup.
- **Gift code announcement channel** — separate save button, since it's a
  different underlying setting.
- **ID channels** — add/remove which channels members can post their raw
  in-game ID into for the bot to recognize.
- **ID channel scan settings** — scan on/off, whether to respond to invalid
  IDs, scan limit, and auto-delete timing. These are server-wide, not
  per-alliance, since one Discord server can host multiple alliances.
- **Theme** — which theme this Discord server uses (or "use global
  default"). See [Theming](#theming) below.
- A link through to **Notifications** for this server.

### Permissions & audit log

`Admin → Manage admins` (Global tier and up). Add an admin by Discord user
ID, set their tier (Global / Server / Alliance — Owner isn't settable here,
see below), and for Alliance tier, which alliance IDs they can manage.
Existing admins can have their tier changed or be removed from here too.

**Transferring bot ownership**: only the current Owner sees a **Make owner**
button, next to any Global admin. This is a one-way handoff — you become a
regular Global admin afterward. There's a confirmation prompt; think before
confirming, same as the equivalent Discord flow.

**Audit log** (`Manage admins → View audit log`) has two tabs:

- **Permission changes** — every admin add/remove/tier-change/ownership
  transfer, who did it, and before/after state. This mirrors the Discord
  bot's own permission audit trail exactly.
- **Activity log** — a broader dashboard-only log covering notification,
  theme, backup, gift code, and custom event create/update/delete actions
  performed through the web dashboard. This is *not* a full replica
  of everything the Discord bot does — it only records actions taken through
  this web dashboard specifically.

### Gift codes (admin)

`Admin → Gift codes` (Global tier and up — a code isn't scoped to one
alliance, it's announced everywhere at once). Add a code with an optional
note and expiry date; deactivate/reactivate existing ones. A code past its
expiry date is automatically hidden from the member-facing list even if
still marked active, and the admin table flags this with an
**(expired, hidden from members)** note so it doesn't look like a bug.

**Adding** a code here posts the same Discord announcement `/addcode` would
— the bot checks for web-added codes about once a minute and announces any
it finds to every alliance's configured gift code channel, so there's
normally a short delay (well under a minute) between adding a code here and
seeing it posted in Discord. **Deactivating**, **reactivating**, or editing
an existing code's note/expiry from here is DB-only and never posts a new
announcement — only a brand-new code triggers one, matching how repeated
edits in Discord don't re-announce either. See
[Admin Guide → Gift codes](admin-guide.md#gift-codes) for the Discord-side
announcement command.

### Backups

`Admin → Backups` (**Owner tier only**). Lists existing backups (name, size,
created time) — click a name to download it. Backups are deleted
automatically 7 days after creation (shown in the audit log's Activity tab
as `backup_expired`), whether they were created here or via the bot's own
`/settings` → **Backup** menu — both write into the same folder.

**Create a backup** snapshots every database file into a new zip, the same
way the bot's own backup system does.

**Restore from a backup** replaces ALL current data with the contents of a
backup zip. This is the highest-blast-radius action on the whole dashboard,
so it's built with several layers of safety:

- Upload a `.zip` and it's validated first — checked for safe file names and
  per-file database integrity — before anything is touched. You then see
  exactly which files will be restored (and which current files aren't in
  the backup and will be left alone) before deciding whether to continue.
- Confirming requires typing `RESTORE` into a text field, on top of the
  Owner-tier gate.
- A fresh safety backup of your **current** data is taken automatically
  immediately before the restore, so a bad restore can itself be undone by
  restoring that safety backup afterward.
- AES password-protected backups (the kind Discord's `/backup` can create
  with a password) aren't supported here — use Discord's `/restore` for
  those instead.
- Once the restore finishes, **both this web server and the Discord bot
  need to be restarted manually** to actually load the restored data —
  neither happens automatically. The page tells you this plainly when a
  restore completes.

### System Health

`Admin → System Health` (**Owner tier only**). The web equivalent of the
Discord bot's `/health` dashboard — the bot itself computes every check
(API status, database/log/disk health, dependency versions) and this page
just displays it, refreshing automatically every 15 seconds. If it ever
says "the Discord bot needs to have started at least once," that's literal
— this page has nothing to show until the bot has run and computed a status
at least one time.

**Version** shows what you're running and, if a newer release exists,
a link to its release notes plus the exact command to update (`update.ps1`
on Windows, `./update.sh` on Linux/Mac, or the `docker compose` command for
a Docker install). The **Automatic update checks** toggle here is the same
setting as the Bot Health menu's toggle in Discord — flip it in either
place and it applies everywhere; when on, the bot checks GitHub every 6
hours and DMs the Global Admin about new releases.

**Actions** run the same operations as their Discord counterparts, from the
web instead:

- **Run Cleanup** — WAL checkpoints, log archival, and stale-file cleanup.
- **Reload All Cogs** — hot-reloads the bot's code modules without a full
  restart (the Bot Health module itself can't reload itself while in use,
  so it's always skipped — this is normal, not a failure).
- **Clear Queue** — drops queued and failed background jobs; never touches
  one that's actively running.
- **Restart Bot** — asks for confirmation first. On Linux/Mac/Docker it
  restarts automatically; **on Windows it does not** unless `watchdog.ps1`
  is set up (see the [Installation guide](installation.md#restarting)) —
  the page tells you this before you confirm.

There's no direct connection between this web server and the Discord bot's
process — clicking an action here writes a request the bot picks up within
a couple of seconds and executes itself, the same "the database is the only
channel" design the rest of this app uses. A slow action (Run Cleanup can
take longer than others) may come back as "still running" rather than a
final result — that's not a failure, just check the dashboard again in a
moment.

### Theming

`Admin → Themes` (Global tier and up). Create a new theme (clones the
`default` theme's icon set as a starting point), delete one, or **set as
global default** — the theme every server uses unless it has its own
override (set per-server on that server's [Channel setup](#channel-setup)
page instead).

Open a theme to edit it:

- Every icon field, grouped into the same categories the bot's own `/pimp
  menu` uses (Status, Navigation, Actions, Display, Operations,
  Notifications, Events, Other) — each is a plain text field taking a
  unicode emoji or a Discord custom-emoji reference.
- Divider styles and embed color fields.
- A **live preview** cycling through 5 real embed layouts (Settings Menu,
  Alliance Changes, Gift Code Status, Member Info, Player Lookup) so you can
  see exactly how a change will look before saving.

Remember to click **Save** — the preview updates live as you type, but
nothing persists until you save.

### Notifications

`Channel setup → Notifications`, or `Admin → an alliance → Notifications`.
The web equivalent of the bot's notification wizard — one-off or repeating
reminder messages posted to a channel.

**Creating one** (`+ New notification`):

- **Channel**, **event name** (optional — shown as the event's label), and
  **date/time/timezone** for when it should first fire.
- **Reminder offsets** — how far ahead of the event time to send: 30/10/5
  minutes before + at the time, or shorter combinations, down to just "at
  the time."
- **Mention** — no mention, `@everyone`, a specific role, or a specific
  member.
- **Repeat**:
  - **One-time** — fires once, done.
  - **Custom interval** — a Months / Weeks / Days / Hours / Minutes picker
    (matching the bot's own repeat-interval option exactly). Combine fields
    freely — 2 days for "every other day," 2 weeks for "every 2 weeks," 1
    month for a roughly-monthly repeat. **Note on "Months" here**: it's a
    flat 30-day approximation (same as the bot's own picker), not true
    calendar-month math — it will slowly drift off a fixed day-of-month over
    time. If you need a reminder that lands on the same calendar date every
    month (handling shorter months correctly), use a **Custom event**
    instead (below) — that has real calendar-aware monthly recurrence.
  - **Specific weekdays** — pick one or more days of the week.
- **Message type** — plain text (with `%t`/`%n`/`%e`/`%d`/`%i` placeholders
  and `{tag}` for the mention, substituted when the bot actually sends it)
  or a full Discord embed (title, description, color, image, thumbnail,
  footer, author — with the same live preview component the theme editor
  uses).

**Editing an existing one**: same fields, reachable from the notification's
detail page, plus **Enable/Disable** and **Delete**. A notification's send
history is listed on its detail page too.

Notifications created via the [custom events](#custom-events) flow, or using
custom per-offset times, show up in the list but aren't editable through this
basic form — edit those through Custom Events instead, matching how the bot's
own basic notification editor works.

### Custom events

`Notifications → Custom events →`. The proper tool for a genuinely recurring
event with a real, fixed schedule — first occurrence date/time, then a true
calendar-aware recurrence:

- **Daily**, every N days.
- **Weekly**, every N weeks.
- **Monthly**, every N months — this one correctly clamps to the target
  month's actual length (e.g. a reminder set for the 31st lands on the 28th
  or 29th in February), unlike a notification's own "Custom interval"
  repeat.

**Post Discord notifications: On/Off** — every custom event has this toggle.
With it **on**, you also set reminder offsets, a target channel, mention
type, and message (plain text or embed), exactly like a regular notification
— creating or editing the event automatically creates/updates the
underlying notification that actually fires, so you never manage those two
things separately. With it **off**, none of those fields apply: the event
still appears on the [Event calendar](#event-calendar) for members to see (and still
recurs on its schedule), but nothing gets posted to Discord — useful for
tracking a date without spamming a channel about it.

**Attendance suggestions**: if your alliance has logged Vault Trap or
Capitol War attendance data but there's no custom event covering it yet, a
banner appears at the top of this page — **"Vault Trap has attendance data
recorded, but no reminder is set up for it"** (or Capitol War) — with a
**Create reminder →** link that pre-fills the name field. This only checks
whether *some* event with a matching name exists (e.g. "Vault Trap 1" counts
for "Vault Trap"), so it won't nag you once you've set one up under any
reasonable name.

### Schedule boards

`Notifications → Schedule boards →`. **Read-only** on the web — creating,
editing, or deleting a schedule board stays Discord-only, since a board is a
pinned message the bot keeps live-editing, which the web can't safely
coordinate. What this page *does* give you:

- The list of boards currently configured for the server (scope, target
  channel, max events, filters, timezone).
- A **live, fully interactive preview** — pick scope, channel, max events,
  timezone, name/time filters, and toggles (show disabled, expand repeats,
  hide daily reset) to see exactly what a board configured that way would
  display right now, bucketed the same way a real board's embed is
  (Imminent / Soon / Upcoming / 2-7 days / 1-2 weeks / Future), with
  pagination. Useful for tuning settings before recreating a board in
  Discord with the Schedule Boards menu.

## Quick reference

| Page | Who can see it |
|---|---|
| Your profile, alliance overview, leaderboards, attendance, member detail, calendar | Any signed-in member with a linked ID or alliance membership |
| Gift codes (view) | Anyone signed in |
| Admin home, alliance members, channel setup | Alliance tier and up (for their assigned alliance(s)) |
| Notifications, custom events, schedule boards | Server tier and up (guild-wide settings) |
| Permissions, audit log, gift codes (manage), themes | Global tier and up |
| Backups, System Health | Owner only |

## Troubleshooting

- **"This alliance has no linked Discord server"** — the alliance hasn't
  been connected to a Discord server yet (`/settings` → Alliances → that
  alliance → **Change Server** in Discord). Guild-scoped pages (channel
  setup, notifications, themes-per-server) can't work without this.
- **Signed in but see almost nothing** — you're signed in with a Discord
  account that has no linked in-game IDs and no admin tier. Link an ID with
  `/register` in Discord, or ask a Global admin to grant you a tier. Being
  signed in to the dashboard never grants access by itself — it only
  reflects whatever the bot's own permission system already says about you.
  See [Admin Guide → Permission tiers](admin-guide.md#permission-tiers).
- **A page 403s or looks empty when you expect data** — double check you're
  looking at the right server if you administer more than one (see
  [Signing in](#signing-in) above); the dashboard scopes everything to one
  active server at a time for Server-tier admins.
