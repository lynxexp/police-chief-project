"""Alliance registration flow. /register links an in-game ID to a Discord account (multi-FID, cross-server). /unregister detaches one of your own."""
import discord
from discord.ext import commands
import sqlite3
import asyncio
import logging
from contextlib import closing
from datetime import datetime, timezone
from .pimp_my_bot import theme
from .alliance import check_alliance_state
from .gift_state_resolver import verify_add_state, get_alliance_kid
from .bot_level_mapping import parse_furnace_level, parse_state
from .alliance_member_edit import apply_member_edit, reactivate_member

logger = logging.getLogger('alliance')


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class AllianceRegistration(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

        self.conn_alliance = sqlite3.connect("db/alliance.sqlite", timeout=30.0, check_same_thread=False)
        self.c_alliance = self.conn_alliance.cursor()

        self.conn_users = sqlite3.connect("db/users.sqlite", timeout=30.0, check_same_thread=False)
        self.c_users = self.conn_users.cursor()

    async def cog_unload(self):
        self.conn_alliance.close()
        self.conn_users.close()

    # ── Registration state helpers ─────────────────────────────────────────

    def _get_user_row(self, fid: int):
        """Return (fid, discord_id, discord_server_id, alliance, nickname, is_active)
        or None. Looked up globally (not alliance-scoped) — a deactivated row is
        still an *existing* row, so it's found here too (and reactivated below)
        rather than falling through to a fresh INSERT that would collide on the
        fid primary key."""
        self.c_users.execute(
            "SELECT fid, discord_id, discord_server_id, alliance, nickname, is_active "
            "FROM users WHERE fid = ?",
            (fid,),
        )
        return self.c_users.fetchone()

    def _linked_fids_for(self, discord_id: int) -> list:
        """All FIDs owned by this Discord user across all servers.
        Returns list of (fid, nickname, alliance, discord_server_id)."""
        self.c_users.execute(
            "SELECT fid, nickname, alliance, discord_server_id "
            "FROM users WHERE discord_id = ? "
            "ORDER BY nickname COLLATE NOCASE",
            (discord_id,),
        )
        return self.c_users.fetchall()

    def set_registration_enabled(self, enabled: bool) -> None:
        """Persist the global self-registration toggle to settings.sqlite."""
        try:
            with sqlite3.connect("db/settings.sqlite") as conn:
                cursor = conn.cursor()
                cursor.execute("CREATE TABLE IF NOT EXISTS register_settings (enabled BOOLEAN)")
                cursor.execute("SELECT COUNT(*) FROM register_settings")
                exists = cursor.fetchone()[0] > 0
                if exists:
                    cursor.execute(
                        "UPDATE register_settings SET enabled = ? WHERE rowid = 1",
                        (enabled,),
                    )
                else:
                    cursor.execute(
                        "INSERT INTO register_settings VALUES (?)", (enabled,)
                    )
                conn.commit()
        except Exception as e:
            logger.error(f"Error updating register settings: {e}")
            print(f"Error updating register settings: {e}")

    def is_registration_enabled(self) -> bool:
        """Check if registration is enabled in the settings database."""
        try:
            with closing(sqlite3.connect("db/settings.sqlite")) as conn:
                cursor = conn.cursor()

                cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='register_settings'")
                table_exists = cursor.fetchone()

                if not table_exists:
                    return False

                cursor.execute("SELECT enabled FROM register_settings WHERE rowid = 1")
                result = cursor.fetchone()

                return bool(result[0]) if result else False

        except Exception as e:
            logger.error(f"Error checking registration status: {e}")
            print(f"Error checking registration status: {e}")
            return False

    # ── Welcome DM on join ───────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        """Prompt a brand-new member to register their in-game ID, by DM.
        Only fires while self-registration is turned on (the same global
        toggle /register itself checks) -- prompting someone to run a
        command that would just tell them registration is disabled isn't
        useful. DMs are best-effort: many members have server-DMs closed,
        and there's no existing "welcome channel" concept in this bot to
        fall back to, so a closed-DM failure is expected and simply
        skipped, not treated as an error (same discord.Forbidden handling
        used everywhere else in this bot that DMs a user)."""
        if member.bot:
            return
        if not self.is_registration_enabled():
            return

        embed = discord.Embed(
            title=f"{theme.linkIcon} Welcome!",
            description=(
                f"Glad to have you here! To get set up, link your in-game ID "
                f"to your Discord account:\n\n"
                f"`/register id:<your in-game ID> alliance:<pick from the list> "
                f"name:<your in-game name>`\n\n"
                f"Start typing your alliance's name and pick it from the "
                f"suggestions that pop up. Use your actual in-game name for "
                f"`name` -- your Discord name often doesn't match it, and the "
                f"bot needs your real in-game name to match you up in "
                f"screenshots.\n\n"
                f"Run `/help` any time for more info or other commands."
            ),
            color=theme.emColor1,
        )
        try:
            await member.send(embed=embed)
        except discord.Forbidden:
            pass
        except Exception as e:
            logger.warning(f"Welcome DM to member {member.id} failed: {e}")

    async def alliance_autocomplete(self, interaction: discord.Interaction, current: str):
        def _read():
            with sqlite3.connect("db/alliance.sqlite", timeout=30.0) as conn:
                return conn.execute("SELECT alliance_id, name FROM alliance_list").fetchall()
        alliances = await asyncio.to_thread(_read)

        return [
            discord.app_commands.Choice(name=name, value=alliance_id)
            for alliance_id, name in alliances if current.lower() in name.lower()
        ][:25]

    def _alliance_exists(self, alliance_id: int) -> bool:
        with sqlite3.connect("db/alliance.sqlite", timeout=30.0) as conn:
            return conn.execute(
                "SELECT 1 FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
            ).fetchone() is not None

    # ── DB writes ──────────────────────────────────────────────────────────

    def _insert_new_user(self, fid: int, user_data: dict, alliance: int,
                         discord_id: int, server_id: int):
        self.c_users.execute(
            "INSERT INTO users (fid, nickname, chief_office_lv, kid, "
            "alliance, discord_id, discord_server_id, discord_id_updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (fid, user_data["nickname"], user_data["chief_office_lv"], user_data["kid"],
             alliance, discord_id, server_id, _now_iso()),
        )
        self.conn_users.commit()

    def _attach_discord_to_existing(self, fid: int, discord_id: int, server_id: int):
        """Link a Discord account to an fid already in `users` (no self-registration
        needed for this fid — an admin add or an older registration created the row).
        Also reactivates it if it had been deactivated: a member re-registering is
        exactly the "re-added" signal that clears is_active, per decision #1."""
        self.c_users.execute(
            "UPDATE users SET discord_id = ?, discord_server_id = ?, "
            "discord_id_updated_at = ?, is_active = 1, deactivated_at = NULL "
            "WHERE fid = ?",
            (discord_id, server_id, _now_iso(), fid),
        )
        self.conn_users.commit()

    def _move_registration_to_server(self, fid: int, new_server_id: int):
        """Also reactivates a deactivated fid — moving a registration is still
        the owner re-registering (via /register), which reactivates per decision #1."""
        self.c_users.execute(
            "UPDATE users SET discord_server_id = ?, discord_id_updated_at = ?, "
            "is_active = 1, deactivated_at = NULL WHERE fid = ?",
            (new_server_id, _now_iso(), fid),
        )
        self.conn_users.commit()

    def _detach_discord(self, fid: int):
        self.c_users.execute(
            "UPDATE users SET discord_id = NULL, discord_server_id = NULL, "
            "discord_id_updated_at = ? WHERE fid = ?",
            (_now_iso(), fid),
        )
        self.conn_users.commit()

    # ── Registration roles ───────────────────────────────────────────────────
    # Best-effort Discord role assignment: a generic "Registered" role plus
    # one named after the alliance's short tag (e.g. "APX"), auto-created in
    # the guild the first time either is needed. Unlike every other Discord
    # resource this bot touches (channels, in cogs/alliance_channels.py and
    # cogs/alliance_id_channel.py), which always require an admin to pick an
    # EXISTING one via a settings picker, these two are auto-created --
    # deliberately simpler, since the whole point is "just works" on a brand
    # new registration with nothing to configure first. A failure at any
    # step here (missing Manage Roles, role positioned above the bot's own
    # highest role, running in a DM with no guild) must never break the
    # registration it's decorating -- it's a nice-to-have side effect, not
    # part of the critical path.

    async def _get_or_create_role(self, guild: discord.Guild, name: str) -> "discord.Role | None":
        role = discord.utils.get(guild.roles, name=name)
        if role is not None:
            return role
        try:
            return await guild.create_role(
                name=name, reason="Auto-created by Police Chief Bot for member registration",
            )
        except discord.Forbidden:
            logger.warning(
                f"Cannot create role {name!r} in guild {guild.id} -- bot needs "
                f"**Manage Roles** permission."
            )
        except Exception as e:
            logger.warning(f"Failed to create role {name!r} in guild {guild.id}: {e}")
        return None

    async def _assign_role(self, member: discord.Member, role: discord.Role) -> None:
        if role in member.roles:
            return
        try:
            await member.add_roles(role, reason="Completed /register")
        except discord.Forbidden:
            logger.warning(
                f"Cannot assign role {role.name!r} to member {member.id} in guild "
                f"{member.guild.id} -- the bot's own top role must be positioned "
                f"ABOVE {role.name!r} in Server Settings -> Roles."
            )
        except Exception as e:
            logger.warning(f"Failed to assign role {role.name!r} to member {member.id}: {e}")

    async def _apply_registration_roles(self, interaction: discord.Interaction, alliance_id) -> None:
        """Assign the "Registered" role plus the alliance's tag role, if
        this /register call happened in a guild (it can also run in a DM,
        see current_server_id's own None-guard above -- roles make no
        sense there, so this is skipped entirely)."""
        if interaction.guild is None:
            return
        member = interaction.user
        # Duck-typed rather than isinstance(member, discord.Member) --
        # guild is not None already guarantees discord.py resolved a real
        # Member here, this is just a defensive fallback.
        if not hasattr(member, "add_roles"):
            return
        guild = interaction.guild

        registered_role = await self._get_or_create_role(guild, "Registered")
        if registered_role is not None:
            await self._assign_role(member, registered_role)

        self.c_alliance.execute(
            "SELECT tag FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
        )
        row = self.c_alliance.fetchone()
        tag = (row[0] or "").strip() if row else ""
        if tag:
            tag_role = await self._get_or_create_role(guild, tag)
            if tag_role is not None:
                await self._assign_role(member, tag_role)

    # ── /register ──────────────────────────────────────────────────────────

    @discord.app_commands.command(
        name="register",
        description="Link your in-game ID to your Discord account. Multiple IDs supported.",
    )
    @discord.app_commands.describe(
        fid="Your In-Game ID",
        alliance="Your Alliance Name",
        name="Your in-game name (your Discord name often doesn't match this)",
        state="Your state number. Only needed if your alliance spans several states",
        level="Your Chief's Office level, like 12",
    )
    @discord.app_commands.rename(fid="id")
    @discord.app_commands.autocomplete(alliance=alliance_autocomplete)
    async def register(self, interaction: discord.Interaction, fid: int, alliance: int, name: str,
                       state: "int | None" = None, level: "str | None" = None):
        if not self.is_registration_enabled():
            await interaction.response.send_message(
                f"{theme.deniedIcon} Registration is currently disabled.",
                ephemeral=True
            )
            return

        chief_office_lv = None
        if level is not None:
            chief_office_lv = parse_furnace_level(level)
            if chief_office_lv is None:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} `{level}` isn't a Chief's Office level. "
                    f"Try something like `12` (valid range 1-45).", ephemeral=True)
                return

        caller_id = interaction.user.id
        current_server_id = interaction.guild_id if interaction.guild else None

        # Autocomplete is only a suggestion UI - users can submit any integer.
        if not self._alliance_exists(alliance):
            await interaction.response.send_message(
                f"{theme.deniedIcon} That alliance doesn't exist. Pick one from the suggestions.",
                ephemeral=True,
            )
            return

        existing = self._get_user_row(fid)

        if existing and existing[1] is not None and existing[1] != caller_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} This ID is already registered to another Discord user. "
                f"Contact an admin if this needs to be fixed.",
                ephemeral=True,
            )
            return

        if existing and existing[1] == caller_id:
            existing_server_id = existing[2]
            if existing_server_id == current_server_id:
                changed = []
                if name or chief_office_lv:
                    changed = await asyncio.to_thread(apply_member_edit, fid,
                                                      nickname=name, chief_office_lv=chief_office_lv)
                reactivated = not existing[5] and await asyncio.to_thread(reactivate_member, fid)
                notes = []
                if changed:
                    notes.append(f"Updated your {' and '.join(changed)}.")
                if reactivated:
                    notes.append("Your account was deactivated and has been reactivated.")
                note = " ".join(notes) if notes else "Nothing to change."
                # Re-running /register while already fully set up is a
                # reasonable way to self-heal a stripped role, so this
                # cheap, idempotent no-op-if-already-has-it call still
                # applies here too, not just on a genuine DB change.
                await self._apply_registration_roles(interaction, existing[3])
                await interaction.response.send_message(
                    f"{theme.verifiedIcon} ID `{fid}` is already registered to you here. {note}",
                    ephemeral=True,
                )
                return
            view = _MoveServerView(
                cog=self, fid=fid, caller_id=caller_id,
                old_server_id=existing_server_id, new_server_id=current_server_id,
            )
            old_name = self._server_name_or_id(existing_server_id, interaction)
            new_name = self._server_name_or_id(current_server_id, interaction)
            await interaction.response.send_message(
                f"{theme.infoIcon} ID `{fid}` is currently registered on **{old_name}**.\n"
                f"Move the registration here ({new_name})?",
                view=view, ephemeral=True,
            )
            return

        if existing:
            was_deactivated = not existing[5]
            self._attach_discord_to_existing(fid, caller_id, current_server_id)
            if name or chief_office_lv:
                await asyncio.to_thread(apply_member_edit, fid,
                                        nickname=name, chief_office_lv=chief_office_lv)
            await self._apply_registration_roles(interaction, alliance)
            await self._send_register_success(interaction, fid, caller_id, action="linked",
                                             reactivated=was_deactivated)
            return

        # Resolve state with one probe; defer first since it's slow.
        await interaction.response.defer(ephemeral=True)
        if state is not None:
            kid = parse_state(state)
            if kid is None:
                await interaction.followup.send(
                    f"{theme.deniedIcon} `{state}` isn't a state number. "
                    f"Enter digits only, like `911`.", ephemeral=True)
                return
        else:
            gift_cog = self.bot.get_cog("GiftOperations")
            kid = (await verify_add_state(gift_cog, fid, alliance))[0] if gift_cog else None
            # No home state to inherit or confirm against, so we can't work it out.
            if kid is None and await asyncio.to_thread(get_alliance_kid, alliance) is None:
                await interaction.followup.send(
                    f"{theme.infoIcon} This alliance has members in several states, so "
                    f"we can't tell which one you're in. Run `/register` again and fill in "
                    f"the **state** option with your state number.", ephemeral=True)
                return

        state_error = check_alliance_state(alliance, kid)
        if state_error:
            await interaction.followup.send(f"{theme.deniedIcon} {state_error}", ephemeral=True)
            return

        user_data = {"nickname": name, "chief_office_lv": chief_office_lv or 0, "kid": kid}
        self._insert_new_user(fid, user_data, alliance, caller_id, current_server_id)
        linked_vault_rows = await self._auto_link_vault_history(alliance, fid, user_data["nickname"])
        linked_capitol_rows = await self._auto_link_capitol_history(alliance, fid, user_data["nickname"])
        await self._apply_registration_roles(interaction, alliance)
        await self._send_register_success(interaction, fid, caller_id, action="registered",
                                         linked_vault_rows=linked_vault_rows,
                                         linked_capitol_rows=linked_capitol_rows)

    async def _auto_link_vault_history(self, alliance_id: int, fid: int, nickname: str) -> int:
        """Best-effort: link this brand-new member's historical unmatched Vault
        Trap OCR rows (fid=NULL, raw_name matched their nickname) to their new
        fid. No-op if the VaultTrack cog isn't loaded."""
        vault_cog = self.bot.get_cog("VaultTrack")
        if vault_cog is None:
            return 0
        try:
            return await vault_cog.auto_link_unmatched_by_name(alliance_id, fid, nickname)
        except Exception as e:
            logger.warning(f"Vault Trap auto-link failed for new member {fid}: {e}")
            return 0

    async def _auto_link_capitol_history(self, alliance_id: int, fid: int, nickname: str) -> int:
        """Same auto-link as `_auto_link_vault_history`, for Capitol War's
        unmatched capitol_war_points rows. No-op if the CapitolWar cog isn't loaded."""
        capitol_cog = self.bot.get_cog("CapitolWar")
        if capitol_cog is None:
            return 0
        try:
            return await capitol_cog.auto_link_unmatched_by_name(alliance_id, fid, nickname)
        except Exception as e:
            logger.warning(f"Capitol War auto-link failed for new member {fid}: {e}")
            return 0

    async def _send_register_success(self, interaction: discord.Interaction,
                                     fid: int, caller_id: int, action: str,
                                     linked_vault_rows: int = 0, linked_capitol_rows: int = 0,
                                     reactivated: bool = False):
        all_linked = self._linked_fids_for(caller_id)
        if len(all_linked) > 1:
            lines = "\n".join(
                f"  {theme.fidIcon} `{f}` — {n or '(unnamed)'}"
                for f, n, _, _ in all_linked
            )
            extra = f"\n\nYou now have **{len(all_linked)} characters** linked:\n{lines}"
        else:
            extra = ""
        verb = "Linked" if action == "linked" else "Registered"
        msg = f"{theme.verifiedIcon} {verb} ID `{fid}` to your Discord account.{extra}"
        if reactivated:
            msg += f"\n{theme.verifiedIcon} This ID had been deactivated — it's active again, with its full history intact."
        if linked_vault_rows:
            msg += (f"\n{theme.verifiedIcon} Linked {linked_vault_rows} historical "
                    f"Vault Trap record(s) to your name.")
        if linked_capitol_rows:
            msg += (f"\n{theme.verifiedIcon} Linked {linked_capitol_rows} historical "
                    f"Capitol War record(s) to your name.")
        # Called from both the deferred (new-user) and non-deferred (attach) paths.
        if interaction.response.is_done():
            await interaction.followup.send(msg, ephemeral=True)
        else:
            await interaction.response.send_message(msg, ephemeral=True)

    def _server_name_or_id(self, server_id, interaction):
        if server_id is None:
            return "(no server)"
        guild = self.bot.get_guild(server_id) if self.bot else None
        if guild and guild.name:
            return guild.name
        if interaction.guild and interaction.guild.id == server_id:
            return interaction.guild.name
        return f"server `{server_id}`"

    # ── /unregister ────────────────────────────────────────────────────────

    async def unregister_autocomplete(self, interaction: discord.Interaction, current: str):
        rows = self._linked_fids_for(interaction.user.id)
        cur = (current or "").lower()
        choices = []
        for fid, nickname, alliance, _ in rows:
            label = f"{nickname or '(unnamed)'} ({fid})"
            if cur and cur not in str(fid) and cur not in (nickname or "").lower():
                continue
            choices.append(discord.app_commands.Choice(name=label[:100], value=fid))
            if len(choices) >= 25:
                break
        return choices

    @discord.app_commands.command(
        name="unregister",
        description="Unlink one of your in-game IDs from your Discord account.",
    )
    @discord.app_commands.describe(fid="The in-game ID to unlink")
    @discord.app_commands.rename(fid="id")
    @discord.app_commands.autocomplete(fid=unregister_autocomplete)
    async def unregister(self, interaction: discord.Interaction, fid: int):
        caller_id = interaction.user.id
        existing = self._get_user_row(fid)

        if not existing:
            await interaction.response.send_message(
                f"{theme.deniedIcon} ID `{fid}` is not in the database.",
                ephemeral=True,
            )
            return

        linked_discord_id = existing[1]
        if linked_discord_id is None:
            await interaction.response.send_message(
                f"{theme.deniedIcon} ID `{fid}` is not linked to any Discord user.",
                ephemeral=True,
            )
            return

        if linked_discord_id != caller_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} ID `{fid}` is linked to a different Discord user. "
                f"Only the owner can unregister it (or an admin via the admin tools).",
                ephemeral=True,
            )
            return

        self._detach_discord(fid)
        remaining = self._linked_fids_for(caller_id)
        if remaining:
            lines = "\n".join(
                f"  {theme.fidIcon} `{f}` — {n or '(unnamed)'}"
                for f, n, _, _ in remaining
            )
            extra = f"\n\nYou still have **{len(remaining)} character(s)** linked:\n{lines}"
        else:
            extra = "\n\nYou no longer have any characters linked."
        await interaction.response.send_message(
            f"{theme.verifiedIcon} Unlinked ID `{fid}` from your Discord account.{extra}",
            ephemeral=True,
        )


class _MoveServerView(discord.ui.View):
    def __init__(self, cog: AllianceRegistration, fid: int, caller_id: int,
                 old_server_id, new_server_id):
        super().__init__(timeout=120)
        self.cog = cog
        self.fid = fid
        self.caller_id = caller_id
        self.old_server_id = old_server_id
        self.new_server_id = new_server_id

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.caller_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} This prompt is for someone else.",
                ephemeral=True,
            )
            return False
        return True

    @discord.ui.button(label="Move here", style=discord.ButtonStyle.success,
                       emoji=f"{theme.verifiedIcon}")
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button):
        self.cog._move_registration_to_server(self.fid, self.new_server_id)
        row = self.cog._get_user_row(self.fid)
        if row is not None:
            await self.cog._apply_registration_roles(interaction, row[3])
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(
            content=f"{theme.verifiedIcon} ID `{self.fid}` is now registered here.",
            view=self,
        )

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary,
                       emoji=f"{theme.backIcon}")
    async def cancel(self, interaction: discord.Interaction, _button: discord.ui.Button):
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(
            content=f"{theme.infoIcon} No change made. Registration remains on the original server.",
            view=self,
        )


async def setup(bot):
    await bot.add_cog(AllianceRegistration(bot))
