"""Editing member names, Chief's Office levels and states by hand.

The player API no longer returns names or levels, so admins maintain them here.
"""

import asyncio
import logging
import sqlite3
from datetime import datetime

import discord

from .bot_level_mapping import format_furnace_level, parse_furnace_level, parse_state
from .gift_state_resolver import set_user_kid
from .pimp_my_bot import theme, safe_edit_message, check_interaction_user

logger = logging.getLogger(__name__)

PLACEHOLDER_PREFIX = "Player "


def is_placeholder_name(nickname, fid) -> bool:
    """True when a member still carries the auto-generated 'Player <id>' name."""
    return str(nickname or "").strip() == f"{PLACEHOLDER_PREFIX}{fid}"


def _log_change(table: str, fid, old, new):
    """Record a manual edit in the same history the sync used to write."""
    try:
        with sqlite3.connect('db/changes.sqlite', timeout=30.0) as conn:
            columns = ("old_nickname", "new_nickname") if table == "nickname_changes" \
                else ("old_chief_office_lv", "new_chief_office_lv")
            conn.execute(
                f"INSERT INTO {table} (fid, {columns[0]}, {columns[1]}, change_date) "
                f"VALUES (?, ?, ?, ?)",
                (fid, old, new, datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            )
            conn.commit()
    except sqlite3.Error as e:
        logger.warning(f"Member edit: could not write {table} history for {fid}: {e}")


def reactivate_member(fid, conn=None) -> bool:
    """Clear a deactivated member's `is_active` flag (auto-reactivation on
    re-register / re-add — history stays untouched, only the flag flips).
    Returns False (no-op) if the fid doesn't exist or is already active.

    Pass an open `conn` to fold this into a caller's own transaction/cursor
    (the caller commits); otherwise a short-lived connection is opened and
    committed here."""
    owns_conn = conn is None
    if owns_conn:
        conn = sqlite3.connect('db/users.sqlite', timeout=30.0)
    try:
        row = conn.execute("SELECT is_active FROM users WHERE fid = ?", (fid,)).fetchone()
        if not row or row[0]:
            return False
        conn.execute(
            "UPDATE users SET is_active = 1, deactivated_at = NULL WHERE fid = ?", (fid,)
        )
        if owns_conn:
            conn.commit()
        logger.info(f"Member edit: {fid} reactivated")
        return True
    finally:
        if owns_conn:
            conn.close()


def apply_member_edit(fid, *, nickname=None, chief_office_lv=None, kid=None, alliance_id=None):
    """Write a member's name/level/state; returns the fields that changed.
    `alliance_id` scopes the edit so an admin can't touch another alliance's member."""
    changed = []
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        if alliance_id is None:
            row = conn.execute(
                "SELECT nickname, chief_office_lv, kid FROM users WHERE fid = ?", (fid,)).fetchone()
        else:
            row = conn.execute(
                "SELECT nickname, chief_office_lv, kid FROM users WHERE fid = ? AND alliance = ?",
                (fid, str(alliance_id))).fetchone()
        if not row:
            return changed
        old_nickname, old_chief_office, old_kid = row

        if nickname is not None and nickname != old_nickname:
            conn.execute("UPDATE users SET nickname = ? WHERE fid = ?", (nickname, fid))
            changed.append("name")
        if chief_office_lv is not None and chief_office_lv != old_chief_office:
            conn.execute("UPDATE users SET chief_office_lv = ? WHERE fid = ?", (chief_office_lv, fid))
            changed.append("level")
        if kid is not None and kid != old_kid:
            set_user_kid(fid, kid, conn=conn)
            changed.append("state")
        conn.commit()

    if "name" in changed:
        _log_change("nickname_changes", fid, old_nickname, nickname)
        logger.info(f"Member edit: {fid} renamed '{old_nickname}' -> '{nickname}'")
    if "level" in changed:
        _log_change("chief_office_changes", fid, old_chief_office, chief_office_lv)
        logger.info(f"Member edit: {fid} chief office {old_chief_office} -> {chief_office_lv}")
    if "state" in changed:
        logger.info(f"Member edit: {fid} state {old_kid} -> {kid}")
    return changed


def enqueue_catchups(bot, fids):
    """Previously queued owed-code redemption for members whose state just changed.
    Police Chief has no per-player redemption API to queue against (gift codes are
    announce-only now), so this is a no-op that always returns 0 - kept so call
    sites don't need to change."""
    return 0


def parse_edit_line(line):
    """`id, name, level, state` -> (fid, nickname, chief_office_lv, kid), or an error string.
    Every field after the id is optional."""
    parts = [p.strip() for p in line.split(",")]
    fid = parts[0]
    if not fid.isdigit():
        return f"`{line.strip()[:60]}` - doesn't start with a player ID"
    nickname = parts[1] if len(parts) > 1 and parts[1] else None
    chief_office_lv = None
    if len(parts) > 2 and parts[2]:
        chief_office_lv = parse_furnace_level(parts[2])
        if chief_office_lv is None:
            return f"`{fid}` - `{parts[2][:30]}` isn't a Chief's Office level (try `12`)"
    kid = None
    if len(parts) > 3 and parts[3]:
        kid = parse_state(parts[3])
        if kid is None:
            return f"`{fid}` - `{parts[3][:30]}` isn't a state number (try `911`)"
    return (fid, nickname, chief_office_lv, kid)


def apply_edit_lines(text, alliance_id=None):
    """Apply `id, name, level, state` lines -> (updated, skipped, errors, state_fids).
    state_fids are the members needing a code catch-up."""
    updated, skipped, errors, state_fids = 0, 0, [], []
    for line in (text or "").splitlines():
        if not line.strip():
            continue
        parsed = parse_edit_line(line)
        if isinstance(parsed, str):
            errors.append(parsed)
            continue
        fid, nickname, chief_office_lv, kid = parsed
        if nickname is None and chief_office_lv is None and kid is None:
            skipped += 1
            continue
        changed = apply_member_edit(fid, nickname=nickname, chief_office_lv=chief_office_lv,
                                    kid=kid, alliance_id=alliance_id)
        if changed:
            updated += 1
            if "state" in changed:
                state_fids.append(fid)
        else:
            skipped += 1
    return updated, skipped, errors, state_fids


def edit_result_embed(title, updated, skipped, errors, *, added=None, caught=0, reactivated=0):
    """Shared outcome embed for the single, bulk and CSV edit paths."""
    lines = [f"{theme.upperDivider}"]
    if added is not None:
        lines.append(f"{theme.addIcon} **Members added:** `{added}`")
    lines.append(f"{theme.verifiedIcon} **Members updated:** `{updated}`")
    if reactivated:
        lines.append(f"{theme.refreshIcon} **Reactivated:** `{reactivated}` (were deactivated)")
    if caught:
        lines.append(f"{theme.giftIcon} **Catching up on codes:** `{caught}` member(s) with a new state")
    if skipped:
        lines.append(f"{theme.infoIcon} **Unchanged:** `{skipped}` (already matched, or nothing to set)")
    if errors:
        shown = errors[:10]
        lines.append(f"{theme.deniedIcon} **Couldn't read {len(errors)} line(s):**")
        lines.extend(f"└ {e}" for e in shown)
        if len(errors) > len(shown):
            lines.append(f"└ ...and {len(errors) - len(shown)} more")
    lines.append(f"{theme.lowerDivider}")
    return discord.Embed(
        title=title,
        description="\n".join(lines),
        color=theme.emColor2 if errors and not updated else theme.emColor1,
    )


class MemberEditModal(discord.ui.Modal):
    """Edit one member's name, Chief's Office level and state."""

    def __init__(self, parent_view, fid, nickname, chief_office_lv, alliance_id, kid=None):
        super().__init__(title="Edit Member")
        self.parent_view = parent_view
        self.fid = fid
        self.alliance_id = alliance_id

        current_name = "" if is_placeholder_name(nickname, fid) else str(nickname or "")
        self.name_input = discord.ui.TextInput(
            label="Name",
            placeholder="The player's in-game name",
            default=current_name,
            required=False,
            max_length=100,
        )
        self.level_input = discord.ui.TextInput(
            label="Chief's Office level (optional)",
            placeholder="e.g. 12. Leave blank to keep it as it is.",
            default=format_furnace_level(chief_office_lv) if chief_office_lv else "",
            required=False,
            max_length=20,
        )
        self.state_input = discord.ui.TextInput(
            label="State (optional)",
            placeholder="e.g. 911. Leave blank to keep it as it is.",
            default=str(kid) if kid else "",
            required=False,
            max_length=5,
        )
        self.add_item(self.name_input)
        self.add_item(self.level_input)
        self.add_item(self.state_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.parent_view.author_id):
            return
        nickname = self.name_input.value.strip() or None
        raw_level = self.level_input.value.strip()
        chief_office_lv = parse_furnace_level(raw_level) if raw_level else None
        if raw_level and chief_office_lv is None:
            await interaction.response.send_message(
                f"{theme.deniedIcon} `{raw_level}` isn't a Chief's Office level. "
                f"Try a number like `12` (valid range 1-45).",
                ephemeral=True)
            return
        raw_state = self.state_input.value.strip()
        kid = parse_state(raw_state) if raw_state else None
        if raw_state and kid is None:
            await interaction.response.send_message(
                f"{theme.deniedIcon} `{raw_state}` isn't a state number. Enter digits only, like `911`.",
                ephemeral=True)
            return

        changed = await asyncio.to_thread(
            apply_member_edit, self.fid, nickname=nickname, chief_office_lv=chief_office_lv,
            kid=kid, alliance_id=self.alliance_id)
        note = f"Nothing changed for `{self.fid}`."
        if changed:
            note = f"Updated {', '.join(changed)} for `{self.fid}`."
            if "state" in changed and enqueue_catchups(self.parent_view.cog.bot, [self.fid]):
                note += " Redeeming the codes they missed."
        await self.parent_view.refresh_after_edit(interaction, note)


class BulkMemberEditModal(discord.ui.Modal):
    """Edit a whole list of members in one go, one `id, name, level, state` per line."""

    def __init__(self, parent_view, alliance_id, prefill=""):
        super().__init__(title="Bulk Edit Members")
        self.parent_view = parent_view
        self.alliance_id = alliance_id
        self.lines_input = discord.ui.TextInput(
            label="Per line: id, name, level, state",
            style=discord.TextStyle.paragraph,
            placeholder="306234280, THANOS IS RIGHT, 12, 2560\n123051289, SKORN, 30, 911",
            default=prefill,
            required=True,
            max_length=4000,
        )
        self.add_item(self.lines_input)

    async def on_submit(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.parent_view.author_id):
            return
        updated, skipped, errors, state_fids = await asyncio.to_thread(
            apply_edit_lines, self.lines_input.value, self.alliance_id)
        caught = enqueue_catchups(self.parent_view.cog.bot, state_fids)
        logger.info(f"Bulk member edit on alliance {self.alliance_id}: "
                    f"{updated} updated, {skipped} unchanged, {len(errors)} rejected")
        await interaction.response.send_message(
            embed=edit_result_embed(f"{theme.editListIcon} Bulk Edit Complete",
                                    updated, skipped, errors, caught=caught),
            ephemeral=True)
        await self.parent_view.refresh_after_edit(interaction, None, already_responded=True)


def build_prefill(members, limit=25):
    """Bulk-modal lines; placeholder names are blanked so the admin types into an empty slot."""
    lines = []
    for m in members[:limit]:
        name = "" if is_placeholder_name(m['nickname'], m['fid']) else m['nickname']
        level = format_furnace_level(m['chief_office_lv']) if m.get('chief_office_lv') else ""
        state = m['kid'] if m.get('kid') else ""
        lines.append(f"{m['fid']}, {name}, {level}, {state}")
    return "\n".join(lines)
