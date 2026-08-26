"""Gift code UI views, modals, and CRUD operations (announce-only)."""

import discord
import sqlite3
import logging
from datetime import datetime, date

from .pimp_my_bot import theme, check_interaction_user
from .permission_handler import PermissionManager
from . import gift_channels

logger = logging.getLogger('gift')


# ---------------------------------------------------------------------------
# Standalone helper / CRUD functions  (cog = GiftOperations instance)
# ---------------------------------------------------------------------------

async def get_admin_info(cog, user_id):
    """Get admin info - delegates to centralized PermissionManager"""
    is_admin, is_global = PermissionManager.is_admin(user_id)
    if not is_admin:
        return None
    return (user_id, 1 if is_global else 0)


async def get_available_alliances(cog, interaction: discord.Interaction):
    """Get available alliances - delegates to centralized PermissionManager"""
    user_id = interaction.user.id
    guild_id = interaction.guild_id if interaction.guild else None

    alliances, _ = PermissionManager.get_admin_alliances(user_id, guild_id or 0)
    return alliances


async def create_gift_code(cog, interaction: discord.Interaction):
    cog.settings_cursor.execute("SELECT 1 FROM admin WHERE id = ?", (interaction.user.id,))
    if not cog.settings_cursor.fetchone():
        await interaction.response.send_message(
            f"{theme.deniedIcon} You are not authorized to create gift codes.",
            ephemeral=True
        )
        return

    modal = CreateGiftCodeModal(cog)
    try:
        await interaction.response.send_modal(modal)
    except Exception as e:
        cog.logger.exception(f"Error showing modal: {e}")
        if not interaction.response.is_done():
            await interaction.response.send_message(
                f"{theme.deniedIcon} An error occurred while showing the gift code creation form.",
                ephemeral=True
            )


async def list_gift_codes(cog, interaction: discord.Interaction):
    cog.cursor.execute("""
        SELECT giftcode, date, note, expiry_date
        FROM gift_codes
        WHERE COALESCE(is_active, 1) = 1
          AND (expiry_date IS NULL OR expiry_date = '' OR expiry_date >= date('now'))
        ORDER BY date DESC
    """)

    codes = cog.cursor.fetchall()

    if not codes:
        await interaction.response.send_message(
            "No active gift codes found in the database.",
            ephemeral=True
        )
        return

    embed = discord.Embed(
        title=f"{theme.giftIcon} Active Gift Codes",
        description="Currently active, non-expired gift codes.",
        color=theme.emColor1
    )

    for code, added_date, note, expiry_date in codes:
        value = f"Added: {added_date}"
        if note:
            value += f"\nNote: {note}"
        if expiry_date:
            value += f"\nExpires: {expiry_date}"
        embed.add_field(name=f"Code: {code}", value=value, inline=False)

    await interaction.response.send_message(embed=embed, ephemeral=True)


async def mark_gift_code_expired(cog, interaction: discord.Interaction):
    """Select an active code from a dropdown, confirm, then flip is_active off
    (the code stops showing in List Gift Codes / future announcements reference
    it as expired) without deleting its row."""
    admin_info = await get_admin_info(cog, interaction.user.id)
    if not admin_info:
        await interaction.response.send_message(
            f"{theme.deniedIcon} You are not authorized to perform this action.",
            ephemeral=True
        )
        return

    cog.cursor.execute("""
        SELECT giftcode, date, note
        FROM gift_codes
        WHERE COALESCE(is_active, 1) = 1
        ORDER BY date DESC
    """)
    codes = cog.cursor.fetchall()

    if not codes:
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.deniedIcon} No Active Gift Codes",
                description="There are no active gift codes to mark expired.",
                color=theme.emColor2
            ),
            ephemeral=True
        )
        return

    total_codes = len(codes)
    codes_to_show = codes[:25] if total_codes > 25 else codes

    select_options = [
        discord.SelectOption(
            label=f"Code: {code}",
            description=(f"Added: {added_date}" + (f" | {note[:40]}" if note else ""))[:100],
            value=code
        )
        for code, added_date, note in codes_to_show
    ]

    select = discord.ui.Select(
        placeholder="Select a gift code to mark expired",
        options=select_options
    )

    async def select_callback(select_interaction):
        selected_code = select_interaction.data["values"][0]

        confirm = discord.ui.Button(
            style=discord.ButtonStyle.danger,
            label="Confirm Mark Expired",
            custom_id="confirm"
        )
        cancel = discord.ui.Button(
            style=discord.ButtonStyle.secondary,
            label="Cancel",
            custom_id="cancel"
        )

        async def button_callback(button_interaction):
            try:
                if button_interaction.data.get('custom_id') == "confirm":
                    try:
                        cog.cursor.execute(
                            "UPDATE gift_codes SET is_active = 0 WHERE giftcode = ?", (selected_code,)
                        )
                        cog.conn.commit()

                        success_embed = discord.Embed(
                            title=f"{theme.verifiedIcon} Gift Code Marked Expired",
                            description=(
                                f"**Details**\n"
                                f"{theme.upperDivider}\n"
                                f"{theme.giftIcon} **Gift Code:** `{selected_code}`\n"
                                f"{theme.userIcon} **Marked by:** {button_interaction.user.mention}\n"
                                f"{theme.timeIcon} **Time:** <t:{int(datetime.now().timestamp())}:R>\n"
                                f"{theme.lowerDivider}\n"
                                f"It no longer appears in **List Gift Codes**."
                            ),
                            color=theme.emColor3
                        )

                        await button_interaction.response.edit_message(
                            embed=success_embed,
                            view=None
                        )

                    except Exception:
                        await button_interaction.response.send_message(
                            f"{theme.deniedIcon} An error occurred while marking the gift code expired.",
                            ephemeral=True
                        )

                else:
                    cancel_embed = discord.Embed(
                        title=f"{theme.deniedIcon} Cancelled",
                        description="The gift code was left active.",
                        color=theme.emColor2
                    )
                    await button_interaction.response.edit_message(
                        embed=cancel_embed,
                        view=None
                    )

            except Exception as e:
                cog.logger.exception(f"Button callback error: {str(e)}")
                try:
                    await button_interaction.response.send_message(
                        f"{theme.deniedIcon} An error occurred while processing the request.",
                        ephemeral=True
                    )
                except Exception:
                    await button_interaction.followup.send(
                        f"{theme.deniedIcon} An error occurred while processing the request.",
                        ephemeral=True
                    )

        confirm.callback = button_callback
        cancel.callback = button_callback

        confirm_view = discord.ui.View()
        confirm_view.add_item(confirm)
        confirm_view.add_item(cancel)

        confirmation_embed = discord.Embed(
            title=f"{theme.warnIcon} Confirm Mark Expired",
            description=(
                f"**Gift Code Details**\n"
                f"{theme.upperDivider}\n"
                f"{theme.giftIcon} **Selected Code:** `{selected_code}`\n"
                f"{theme.infoIcon} This stops it from showing as active. Its history stays "
                f"in the database - use **Delete Gift Code** to remove it entirely.\n"
                f"{theme.lowerDivider}\n"
            ),
            color=theme.emColor4
        )

        await select_interaction.response.edit_message(
            embed=confirmation_embed,
            view=confirm_view
        )

    select.callback = select_callback
    view = discord.ui.View()
    view.add_item(select)

    description_text = (
        f"**Instructions**\n"
        f"{theme.upperDivider}\n"
        f"{theme.num1Icon} Select a gift code from the menu below\n"
        f"{theme.num2Icon} Confirm your selection\n"
        f"{theme.num3Icon} The code stops showing as active (its row is kept)\n"
        f"{theme.lowerDivider}\n"
    )

    if total_codes > 25:
        description_text += (
            f"\n{theme.warnIcon} **Note:** Showing 25 of {total_codes} active codes.\n"
            f"Newest codes are shown first."
        )

    initial_embed = discord.Embed(
        title=f"{theme.warnIcon} Mark Gift Code Expired",
        description=description_text,
        color=theme.emColor1
    )

    await interaction.response.send_message(
        embed=initial_embed,
        view=view,
        ephemeral=True
    )


async def delete_gift_code(cog, interaction: discord.Interaction):
    try:
        with sqlite3.connect('db/settings.sqlite') as settings_conn:
            settings_cursor = settings_conn.cursor()

            settings_cursor.execute("""
                SELECT 1 FROM admin
                WHERE id = ? AND is_initial = 1
            """, (interaction.user.id,))

            is_admin = settings_cursor.fetchone()

        if not is_admin:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title=f"{theme.deniedIcon} Unauthorized Access",
                    description="This action requires Global Admin privileges.",
                    color=theme.emColor2
                ),
                ephemeral=True
            )
            return

        cog.cursor.execute("""
            SELECT giftcode, date, COALESCE(is_active, 1)
            FROM gift_codes
            ORDER BY date ASC
        """)

        codes = cog.cursor.fetchall()

        if not codes:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title=f"{theme.deniedIcon} No Gift Codes",
                    description="There are no gift codes in the database to delete.",
                    color=theme.emColor2
                ),
                ephemeral=True
            )
            return

        # Discord limits Select menus to 25 options
        total_codes = len(codes)
        codes_to_show = codes[:25] if total_codes > 25 else codes

        select_options = []
        for code, added_date, is_active in codes_to_show:
            status_display = f"{theme.verifiedIcon} Active" if is_active else f"{theme.warnIcon} Expired"
            select_options.append(
                discord.SelectOption(
                    label=f"Code: {code}",
                    description=f"{status_display} | Added: {added_date}",
                    value=code
                )
            )

        if not select_options:
            await interaction.response.send_message(
                embed=discord.Embed(
                    title=f"{theme.deniedIcon} No Gift Codes Available",
                    description="No gift codes found in the database to delete.",
                    color=theme.emColor2
                ),
                ephemeral=True
            )
            return

        select = discord.ui.Select(
            placeholder="Select a gift code to delete",
            options=select_options
        )

        async def select_callback(select_interaction):
            selected_code = select_interaction.data["values"][0]

            confirm = discord.ui.Button(
                style=discord.ButtonStyle.danger,
                label="Confirm Delete",
                custom_id="confirm"
            )
            cancel = discord.ui.Button(
                style=discord.ButtonStyle.secondary,
                label="Cancel",
                custom_id="cancel"
            )

            async def button_callback(button_interaction):
                try:
                    if button_interaction.data.get('custom_id') == "confirm":
                        try:
                            cog.cursor.execute("DELETE FROM gift_codes WHERE giftcode = ?", (selected_code,))
                            cog.conn.commit()

                            success_embed = discord.Embed(
                                title=f"{theme.verifiedIcon} Gift Code Deleted",
                                description=(
                                    f"**Deletion Details**\n"
                                    f"{theme.upperDivider}\n"
                                    f"{theme.giftIcon} **Gift Code:** `{selected_code}`\n"
                                    f"{theme.userIcon} **Deleted by:** {button_interaction.user.mention}\n"
                                    f"{theme.timeIcon} **Time:** <t:{int(datetime.now().timestamp())}:R>\n"
                                    f"{theme.lowerDivider}\n"
                                ),
                                color=theme.emColor3
                            )

                            await button_interaction.response.edit_message(
                                embed=success_embed,
                                view=None
                            )

                        except Exception as e:
                            await button_interaction.response.send_message(
                                f"{theme.deniedIcon} An error occurred while deleting the gift code.",
                                ephemeral=True
                            )

                    else:
                        cancel_embed = discord.Embed(
                            title=f"{theme.deniedIcon} Deletion Cancelled",
                            description="The gift code deletion was cancelled.",
                            color=theme.emColor2
                        )
                        await button_interaction.response.edit_message(
                            embed=cancel_embed,
                            view=None
                        )

                except Exception as e:
                    cog.logger.exception(f"Button callback error: {str(e)}")
                    try:
                        await button_interaction.response.send_message(
                            f"{theme.deniedIcon} An error occurred while processing the request.",
                            ephemeral=True
                        )
                    except Exception:
                        await button_interaction.followup.send(
                            f"{theme.deniedIcon} An error occurred while processing the request.",
                            ephemeral=True
                        )

            confirm.callback = button_callback
            cancel.callback = button_callback

            confirm_view = discord.ui.View()
            confirm_view.add_item(confirm)
            confirm_view.add_item(cancel)

            confirmation_embed = discord.Embed(
                title=f"{theme.warnIcon} Confirm Deletion",
                description=(
                    f"**Gift Code Details**\n"
                    f"{theme.upperDivider}\n"
                    f"{theme.giftIcon} **Selected Code:** `{selected_code}`\n"
                    f"{theme.warnIcon} **Warning:** This action cannot be undone!\n"
                    f"{theme.lowerDivider}\n"
                ),
                color=theme.emColor4
            )

            await select_interaction.response.edit_message(
                embed=confirmation_embed,
                view=confirm_view
            )

        select.callback = select_callback
        view = discord.ui.View()
        view.add_item(select)

        # Build description with truncation notice if needed
        description_text = (
            f"**Instructions**\n"
            f"{theme.upperDivider}\n"
            f"{theme.num1Icon} Select a gift code from the menu below\n"
            f"{theme.num2Icon} Confirm your selection\n"
            f"{theme.num3Icon} The code will be permanently deleted\n"
            f"{theme.lowerDivider}\n"
        )

        if total_codes > 25:
            description_text += (
                f"\n{theme.warnIcon} **Note:** Showing 25 of {total_codes} codes.\n"
                f"Oldest codes are shown first.\n"
                f"To delete newer codes, you'll need to delete the older ones first."
            )

        initial_embed = discord.Embed(
            title=f"{theme.trashIcon} Delete Gift Code",
            description=description_text,
            color=theme.emColor1
        )

        await interaction.response.send_message(
            embed=initial_embed,
            view=view,
            ephemeral=True
        )

    except Exception as e:
        cog.logger.exception(f"Delete gift code error: {str(e)}")
        await interaction.response.send_message(
            f"{theme.deniedIcon} An error occurred while processing the request.",
            ephemeral=True
        )


# ---------------------------------------------------------------------------
# Modals
# ---------------------------------------------------------------------------

class CreateGiftCodeModal(discord.ui.Modal):
    def __init__(self, cog):
        super().__init__(title="Create Gift Code")
        self.cog = cog

        self.giftcode = discord.ui.TextInput(
            label="Gift Code",
            placeholder="Enter the gift code",
            required=True,
            min_length=4,
            max_length=20
        )
        self.add_item(self.giftcode)

        self.note = discord.ui.TextInput(
            label="Note (optional)",
            placeholder="e.g. 500 gold + 3 energy, week 12 code",
            required=False,
            max_length=200
        )
        self.add_item(self.note)

        self.expiry = discord.ui.TextInput(
            label="Expiry date (optional, YYYY-MM-DD)",
            placeholder="e.g. 2026-09-01",
            required=False,
            max_length=10
        )
        self.add_item(self.expiry)

    async def on_submit(self, interaction: discord.Interaction):
        logger = self.cog.logger
        # thinking=True makes this a NEW ephemeral message; without it a modal submit
        # just edits the menu the modal was opened from (ephemeral flag is ignored).
        await interaction.response.defer(ephemeral=True, thinking=True)

        code = self.cog.clean_gift_code(self.giftcode.value)
        note = self.note.value.strip() or None
        expiry_raw = self.expiry.value.strip()

        final_embed = discord.Embed(title=f"{theme.giftIcon} Gift Code Creation Result")

        expiry_date = None
        if expiry_raw:
            try:
                expiry_date = date.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                final_embed.title = f"{theme.deniedIcon} Invalid Expiry Date"
                final_embed.description = (
                    f"`{expiry_raw}` isn't a valid date. Use the format `YYYY-MM-DD`, "
                    f"e.g. `2026-09-01`, or leave it blank."
                )
                final_embed.color = theme.emColor2
                await interaction.edit_original_response(embed=final_embed)
                return

        logger.info(f"[CreateGiftCodeModal] Code entered: {code}")

        self.cog.cursor.execute(
            "SELECT COALESCE(is_active, 1) FROM gift_codes WHERE giftcode = ?", (code,)
        )
        row = self.cog.cursor.fetchone()
        reactivated = False

        try:
            if row and row[0]:
                logger.info(f"[CreateGiftCodeModal] Code {code} already exists and is active.")
                final_embed.title = f"{theme.infoIcon} Gift Code Exists"
                final_embed.description = (
                    f"**Gift Code Details**\n{theme.upperDivider}\n"
                    f"{theme.giftIcon} **Gift Code:** `{code}`\n"
                    f"{theme.verifiedIcon} **Status:** Code already exists and is active.\n"
                    f"{theme.lowerDivider}\n"
                )
                final_embed.color = theme.emColor1
                await interaction.edit_original_response(embed=final_embed)
                return

            if row:
                # Exists but inactive (previously marked expired / hard-recreated) - reactivate.
                reactivated = True
                # announced_by_bot = 1: this reactivation announces
                # synchronously below, same as a fresh insert -- without this,
                # a code that was web-added (announced_by_bot=0) and then
                # deactivated before the polling loop caught it would get
                # announced a second time by that loop.
                self.cog.cursor.execute(
                    "UPDATE gift_codes SET is_active = 1, note = ?, expiry_date = ?, "
                    "created_by = ?, announced_by_bot = 1 WHERE giftcode = ?",
                    (note, expiry_date, interaction.user.id, code)
                )
            else:
                today = datetime.now().strftime("%Y-%m-%d")
                self.cog.cursor.execute(
                    "INSERT INTO gift_codes (giftcode, date, note, expiry_date, is_active, created_by) "
                    "VALUES (?, ?, ?, ?, 1, ?)",
                    (code, today, note, expiry_date, interaction.user.id)
                )
            self.cog.conn.commit()
        except sqlite3.Error as db_err:
            logger.exception(f"[CreateGiftCodeModal] DB Error saving code '{code}': {db_err}")
            final_embed.title = f"{theme.deniedIcon} Database Error"
            final_embed.description = f"Failed to save gift code `{code}` to the database. Please check logs."
            final_embed.color = theme.emColor2
            await interaction.edit_original_response(embed=final_embed)
            return

        logger.info(f"[CreateGiftCodeModal] Code '{code}' saved (reactivated={reactivated}).")

        posted, total, failed = await gift_channels.announce_new_code(
            self.cog, code, note, expiry_date, interaction.user
        )

        if total == 0:
            announce_line = (
                f"{theme.warnIcon} **Announcement:** No alliances have a gift code channel "
                f"configured yet - nothing was announced."
            )
        elif failed:
            announce_line = (
                f"{theme.warnIcon} **Announcement:** Posted to {posted}/{total} channels "
                f"({len(failed)} failed - check channel permissions)."
            )
        else:
            announce_line = f"{theme.verifiedIcon} **Announcement:** Posted to all {total} configured channel(s)."

        final_embed.title = f"{theme.verifiedIcon} Gift Code {'Reactivated' if reactivated else 'Added'}"
        detail_lines = (
            f"**Gift Code Details**\n{theme.upperDivider}\n"
            f"{theme.giftIcon} **Gift Code:** `{code}`\n"
        )
        if note:
            detail_lines += f"{theme.editListIcon} **Note:** {note}\n"
        if expiry_date:
            detail_lines += f"{theme.timeIcon} **Expires:** {expiry_date}\n"
        detail_lines += f"{announce_line}\n{theme.lowerDivider}\n"
        final_embed.description = detail_lines
        final_embed.color = theme.emColor3

        try:
            await interaction.edit_original_response(embed=final_embed)
            logger.info(f"[CreateGiftCodeModal] Final result embed sent for code {code}.")
        except Exception as final_edit_err:
            logger.exception(f"[CreateGiftCodeModal] Failed to edit interaction with final result for {code}: {final_edit_err}")


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

class GiftView(discord.ui.View):
    def __init__(self, cog, original_user_id):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id

    @discord.ui.button(
        label="Add Gift Code",
        style=discord.ButtonStyle.green,
        custom_id="create_gift",
        emoji=f"{theme.giftIcon}",
        row=0
    )
    async def create_gift(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.create_gift_code(interaction)

    @discord.ui.button(
        label="List Gift Codes",
        style=discord.ButtonStyle.blurple,
        custom_id="list_gift",
        emoji=f"{theme.listIcon}",
        row=0
    )
    async def list_gift(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.list_gift_codes(interaction)

    @discord.ui.button(
        label="Mark Code Expired",
        emoji=f"{theme.warnIcon}",
        style=discord.ButtonStyle.secondary,
        custom_id="mark_gift_expired",
        row=0
    )
    async def mark_gift_expired_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.mark_gift_code_expired(interaction)

    @discord.ui.button(
        label="Manage Channels",
        style=discord.ButtonStyle.secondary,
        custom_id="manage_gift_channels",
        emoji=f"{theme.announceIcon}",
        row=1
    )
    async def manage_channels_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.manage_channel_settings(interaction)

    @discord.ui.button(
        label="Delete Gift Code",
        emoji=f"{theme.trashIcon}",
        style=discord.ButtonStyle.danger,
        custom_id="delete_gift",
        row=1
    )
    async def delete_gift_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        try:
            await self.cog.delete_gift_code(interaction)
        except Exception as e:
            self.cog.logger.exception(f"Delete gift button error: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} An error occurred while processing delete request.",
                ephemeral=True
            )

    @discord.ui.button(
        label="Main Menu",
        emoji=f"{theme.homeIcon}",
        style=discord.ButtonStyle.secondary,
        custom_id="main_menu_from_gifts",
        row=2
    )
    async def main_menu_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        try:
            main_menu_cog = self.cog.bot.get_cog("MainMenu")
            if main_menu_cog:
                await main_menu_cog.show_main_menu(interaction)
        except Exception as e:
            logger.error(f"Error returning to main menu: {e}")
            print(f"Error returning to main menu: {e}")
