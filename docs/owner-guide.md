# Owner Guide

The **Bot Owner** is the single highest permission tier — a recovery anchor
that always exists so the bot can never end up with no one able to manage
it. Everything a Global Admin can do (see the [Admin Guide](admin-guide.md)),
plus the actions on this page, which are deliberately restricted to just the
Owner because they're either irreversible or affect the entire bot install
at once rather than one alliance.

## Becoming the Owner

- **Fresh install:** the first person to ever run `/settings` is
  automatically made Owner. No separate claim step.
- **Multiple existing Global Admins, no Owner** (e.g. after a migration or
  manual database edit left ownership unclaimed): `/settings` shows a
  "claim ownership" banner to eligible Global Admins. First to click it
  becomes Owner — atomic, so only one person can win the race even if
  several click around the same time.

## Transferring ownership

`/settings` → **Permissions** → open the current Owner's entry → **Transfer
Owner**. Pick a recipient from existing Global Admins (they must already be
Global tier — promote them first if they're not). Confirm, and ownership
moves immediately; you become a regular Global Admin. This can only be
initiated by the current Owner, for themselves — there's no way for anyone
else to trigger it.

## Backup & restore

Any Global Admin can **create** a backup (`/settings` → **Backup**), but
**restoring** one is Owner-only — stricter than Transfer Owner itself, since
a restore can silently overwrite the `admin`/`adminserver` tables and
change who the Owner even is.

```
/restore file:<backup zip> password:<only if it was encrypted>
```

What happens:

1. The zip is validated — real zip, sane file size, every entry is a plain
   `name.sqlite` filename (anything else, including path-traversal
   attempts, rejects the whole zip rather than silently skipping the bad
   entry), and every extracted database passes a SQLite integrity check.
   Nothing under `db/` is touched during this step.
2. You get a confirmation showing exactly what's in the backup, its total
   size, and anything currently in `db/` that this particular backup
   doesn't include.
3. On **Confirm**: a fresh safety backup of the **current** data is taken
   first. If that safety backup fails for any reason, the restore is
   aborted and nothing is written — you're never left with no way back.
4. The validated files are written into `db/`, then the bot restarts the
   same way the Restart Bot button does. On Windows you'll need to run
   `python main.py` again manually afterward (see
   [Installation](installation.md#restarting)); other platforms restart
   themselves.

If you're migrating to a new install rather than recovering from a mistake,
see [Migrating between installs](installation.md#migrating-between-installs)
in the Installation guide — restore is one step of that process, not the
whole thing (you'll also want **Change Server** and channel reconfiguration
afterward).

## Why these two are Owner-only

Both actions can change *who has access to the bot at all* — a bad restore
could hand ownership to whoever the backup's data says was Owner at backup
time, and Transfer Owner is literally that. Every other admin action in this
bot (deleting an alliance, restarting the process, managing members) is
scoped to one alliance or is reversible enough that Global Admin is a
sufficient bar. These two aren't, so the bar is higher.
