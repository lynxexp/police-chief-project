# User Guide

For regular alliance members — no admin permissions needed for anything on
this page.

## Getting started: link your in-game ID

When you join a server running this bot, you may get a DM prompting you to
register (only if the server's admin has self-registration turned on). Either
way, run:

```
/register id:<your in-game ID> alliance:<pick from the list> name:<your in-game name>
```

- **`id`** — your in-game player ID (the numeric ID, not your name).
- **`alliance`** — start typing your alliance's name and pick it from the
  suggestions that pop up.
- **`name`** — your **in-game** name specifically. This is required
  deliberately: your Discord display name often doesn't match your in-game
  name, and the bot needs your real in-game name to match you up correctly
  when it reads Vault Trap/Capitol War screenshots.
- **`state`** — only needed if your alliance's members are spread across
  multiple states; otherwise leave it blank.
- **`level`** — optional, your Chief's Office level (e.g. `12`).

If your alliance has a short tag configured (e.g. "APX"), successfully
registering gives you two Discord roles automatically: a generic
**Registered** role, and a role matching your alliance's tag. Both are
created automatically if they don't already exist — no admin setup needed
for this specifically.

**Already registered somewhere else?** Running `/register` again lets you:
- Move your registration to the server you're currently on, if it's linked
  to a different one.
- Update your in-game name or Chief's Office level, if either has changed.
- Nothing happens if you're already fully set up here — you'll just get a
  confirmation.

To unlink an ID from your Discord account:

```
/unregister id:<pick from your linked IDs>
```

This only ever removes IDs linked to *your own* Discord account.

## Checking your stats

If your alliance has these enabled (an admin controls this via a per-alliance
toggle — ask them if a command below says you don't have permission):

- `/vault_player_history` — your own Vault Trap damage history over time.
- `/capitol_player_history` — your own Capitol War points history over time.
- `/vault_compare` — compare your Vault Trap damage against other members,
  with quick presets (1 Week / 1 Month / 3 Months) or a custom date range.
- `/capitol_compare` — same, for Capitol War points.

## Uploading Vault Trap / Capitol War screenshots

If your alliance's tracking channels are open to members (an admin decides
this — some alliances restrict uploading to admins only), post your
in-game results screenshot directly in the configured channel. The bot:

1. Detects the screenshot and starts a collection session, showing a live
   progress message.
2. Lets you post more screenshots (for a multi-page result) within a short
   window before finalizing.
3. Shows you a review screen with the parsed rows — check that names and
   numbers matched correctly, since OCR isn't perfect. Anything it couldn't
   confidently match is flagged for a human to fix.
4. You (or whoever uploaded) click **Submit** to save it, or **Cancel** to
   discard.

Your uploaded screenshots get deleted automatically afterward (whether you
submit or cancel) if your alliance has that setting on, so the channel
doesn't fill up with old images.

If you're told you don't have permission to upload here, an alliance admin
has restricted this to admins only for this alliance — ask them to upload on
your behalf, or to open it up if that's not intentional.

## Gift codes

Admins post active gift codes to a configured announcement channel. This bot
**cannot redeem codes for you automatically** — Police Chief's redemption
page requires you to log in yourself (Facebook/Google/Apple), so there's no
way for the bot to do it on your behalf. Redeem manually using the code and
link posted in the announcement.

## Booking shifts / appointments

If your alliance uses the shift scheduler (admin-configured appointment
types — e.g. construction/research time slots), the bot posts a persistent
message with buttons in a designated channel. Click a time slot to book it,
or cancel your own booking from the same message. You'll get a reminder
before your slot if notifications are enabled.

## Quick reference

Run `/help` any time for a shorter in-Discord version of the registration
basics above.

| Command | What it does |
|---|---|
| `/register` | Link your in-game ID (and alliance, name) to your Discord account |
| `/unregister` | Unlink one of your own IDs |
| `/help` | Quick reminder of the above, in Discord |
| `/vault_player_history` | Your own Vault Trap history |
| `/capitol_player_history` | Your own Capitol War history |
| `/vault_compare` | Compare Vault Trap damage against others |
| `/capitol_compare` | Compare Capitol War points against others |

## Troubleshooting

- **"ID already registered to another Discord user"** — someone else
  claimed that ID first. Ask an alliance admin to sort it out (they can see
  who it's linked to and detach it if it's a mistake).
- **"Registration is currently disabled"** — an admin has temporarily
  turned off self-registration server-wide. Ask them to re-enable it, or to
  register you manually.
- **Didn't get a welcome DM when you joined** — either self-registration is
  off, or your Discord privacy settings block DMs from server members
  (Discord doesn't let bots detect which, so the bot just quietly skips
  sending it rather than erroring). Run `/register` directly instead.
