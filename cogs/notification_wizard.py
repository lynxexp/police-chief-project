"""
Notification setup wizard. Guides users through first-time notification configuration.
"""
import discord
from discord.ext import commands
import sqlite3
import logging
from datetime import datetime, timedelta
import pytz
import os
import json
from typing import Dict
import uuid
import sys
sys.path.insert(0, os.path.dirname(__file__))
from notification_event_types import get_event_icon, RECURRENCE_TYPES, DEFAULT_EVENT_ICON
from .notification_schedule import calculate_next_occurrence
from .permission_handler import PermissionManager
from .pimp_my_bot import theme

logger = logging.getLogger('notification')

class NotificationWizard(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.db_path = 'db/events.sqlite'
        os.makedirs('db', exist_ok=True)

        self.conn = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        self.cursor = self.conn.cursor()

        # Enable WAL mode
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.commit()

        # Create wizard tracking table
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS wizard_notifications (
                notification_id INTEGER PRIMARY KEY,
                guild_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                created_by_wizard INTEGER DEFAULT 1,
                wizard_run_id TEXT,
                FOREIGN KEY (notification_id) REFERENCES vault_notifications(id) ON DELETE CASCADE
            )
        """)

        # Admin-configured custom event calendar. Ships with zero pre-filled rows. Also created in
        # notification_system.py, which owns the reminder-posting loop that
        # reads it; both cogs defensively ensure it exists, same as every
        # other shared table in this DB.
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS custom_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id INTEGER,
                name TEXT,
                icon_url TEXT,
                first_occurrence TEXT,
                recurrence_type TEXT,
                recurrence_interval INTEGER,
                reminder_offsets TEXT,
                channel_id INTEGER,
                created_by INTEGER,
                created_at TEXT
            )
        """)
        self.conn.commit()

    async def cog_unload(self):
        """Close database connections when cog is unloaded."""
        try:
            self.conn.close()
        except Exception:
            pass

    async def check_admin(self, interaction: discord.Interaction) -> bool:
        """Check if user is an admin"""
        is_admin, _ = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You don't have permission to use this command!",
                ephemeral=True
            )
        return is_admin

    # ---- custom_events CRUD helpers -------------------------------------------------

    def list_custom_events(self, guild_id: int) -> list[dict]:
        """This guild's configured custom events, for the Manage Events list."""
        self.cursor.execute("""
            SELECT id, name, icon_url, first_occurrence, recurrence_type, recurrence_interval,
                   reminder_offsets, channel_id
            FROM custom_events WHERE guild_id = ? ORDER BY name COLLATE NOCASE
        """, (guild_id,))
        return [
            {
                "id": r[0], "name": r[1], "icon_url": r[2], "first_occurrence": r[3],
                "recurrence_type": r[4], "recurrence_interval": r[5],
                "reminder_offsets": r[6], "channel_id": r[7],
            }
            for r in self.cursor.fetchall()
        ]

    def get_custom_event(self, event_id: int) -> dict | None:
        self.cursor.execute("""
            SELECT id, guild_id, name, icon_url, first_occurrence, recurrence_type,
                   recurrence_interval, reminder_offsets, channel_id, created_by
            FROM custom_events WHERE id = ?
        """, (event_id,))
        row = self.cursor.fetchone()
        if not row:
            return None
        return {
            "id": row[0], "guild_id": row[1], "name": row[2], "icon_url": row[3],
            "first_occurrence": row[4], "recurrence_type": row[5], "recurrence_interval": row[6],
            "reminder_offsets": row[7], "channel_id": row[8], "created_by": row[9],
        }

    async def save_custom_event(self, session: "CustomEventSession") -> int:
        """
        Insert or update a custom_events row, then (re)materialize it into a
        single vault_notifications row via NotificationSystem's generic
        save_notification()/delete_notification() API, keyed to the
        admin-defined event rather than a fixed event name.
        """
        now_iso = datetime.now(pytz.UTC).isoformat()
        first_occurrence_iso = session.first_occurrence.isoformat()
        offsets_json = json.dumps(sorted(session.reminder_offsets(), reverse=True))

        if session.editing_id:
            self.cursor.execute("""
                UPDATE custom_events
                SET name = ?, icon_url = ?, first_occurrence = ?, recurrence_type = ?,
                    recurrence_interval = ?, reminder_offsets = ?, channel_id = ?
                WHERE id = ?
            """, (
                session.name, session.icon_url, first_occurrence_iso, session.recurrence_type,
                session.recurrence_interval, offsets_json, session.channel_id, session.editing_id
            ))
            event_id = session.editing_id
        else:
            self.cursor.execute("""
                INSERT INTO custom_events
                (guild_id, name, icon_url, first_occurrence, recurrence_type, recurrence_interval,
                 reminder_offsets, channel_id, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                session.guild_id, session.name, session.icon_url, first_occurrence_iso,
                session.recurrence_type, session.recurrence_interval, offsets_json,
                session.channel_id, session.user_id, now_iso
            ))
            event_id = self.cursor.lastrowid
        self.conn.commit()

        notif_cog = self.bot.get_cog("NotificationSystem")
        if notif_cog:
            # Drop any previously materialized reminder row(s) for this event, then recreate
            # (simplest way to keep the reminder in sync with edited name/date/recurrence/offsets).
            self.cursor.execute("SELECT id FROM vault_notifications WHERE custom_event_id = ?", (event_id,))
            for (old_id,) in self.cursor.fetchall():
                await notif_cog.delete_notification(old_id)

            now_utc = datetime.now(pytz.UTC)
            next_occ = calculate_next_occurrence(
                session.first_occurrence, session.recurrence_type, session.recurrence_interval,
                from_date=now_utc
            )
            offsets = sorted(session.reminder_offsets(), reverse=True)
            times_str = "-".join(str(o) for o in offsets)
            description = f"CUSTOM_TIMES:{times_str}|%i **%n** starts in %t!"

            if session.recurrence_type == "daily":
                repeat_minutes = max(1, session.recurrence_interval) * 1440
            elif session.recurrence_type == "weekly":
                repeat_minutes = max(1, session.recurrence_interval) * 7 * 1440
            else:  # monthly - not a fixed period, advanced via calculate_next_occurrence instead
                repeat_minutes = -2

            await notif_cog.save_notification(
                guild_id=session.guild_id,
                channel_id=session.channel_id,
                start_date=next_occ,
                hour=next_occ.hour,
                minute=next_occ.minute,
                timezone="UTC",
                description=description,
                created_by=session.user_id,
                notification_type=6,
                mention_type=session.mention_type or "none",
                repeat_enabled=True,
                repeat_minutes=repeat_minutes,
                event_type=session.name,
                custom_event_id=event_id,
            )

        return event_id

    async def delete_custom_event(self, event_id: int) -> bool:
        self.cursor.execute("SELECT id FROM custom_events WHERE id = ?", (event_id,))
        if not self.cursor.fetchone():
            return False

        notif_cog = self.bot.get_cog("NotificationSystem")
        if notif_cog:
            self.cursor.execute("SELECT id FROM vault_notifications WHERE custom_event_id = ?", (event_id,))
            for (nid,) in self.cursor.fetchall():
                await notif_cog.delete_notification(nid)

        self.cursor.execute("DELETE FROM custom_events WHERE id = ?", (event_id,))
        self.conn.commit()
        return True

    async def show_wizard(self, interaction: discord.Interaction):
        """Launch the custom event calendar wizard"""
        if not await self.check_admin(interaction):
            return

        embed = discord.Embed(
            title=f"{theme.wizardIcon} Event Calendar Wizard",
            description=(
                "*Welcome, oh seeker of convenient event notifications.*\n\n"
                "This server doesn't come with any pre-built events - you build your own calendar "
                "from scratch, and I'll help you set up reminders for it in a channel of your choice, "
                f"so your members never forget another event. {theme.wizardIcon}\n\n"
                "**Important:**\n"
                "- Make sure you've created a channel where you want the notifications to appear.\n"
                "- If you want to use a separate role for alerts, set that up in advance too.\n"
                "- Resulting notifications can be adjusted manually as needed.\n\n"
                "**What you can do here:**\n"
                "- Create a new custom event (name, icon, first occurrence, recurrence, reminders, channel).\n"
                "- Edit or delete an event you already configured.\n\n"
                "**Are you ready to get started?**"
            ),
            color=discord.Color.gold()
        )
        view = CustomEventsMenuView(self, interaction.guild_id, interaction.user.id)

        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)

class CustomEventSession:
    """
    Stores in-progress state for creating or editing one admin-configured
    custom_events row.

    Deliberately scoped to a single event, since each custom_events row owns
    its own channel and reminder_offsets.

    Exposes the same channel_id/mention_type/notification_type/custom_times/
    timezone/is_update/existing_notifications attributes (and a
    load_existing_notifications shim) that CommonSettingsHubView and its
    child views (WizardChannelSelectView, WizardMentionSelectView,
    WizardNotificationTypeView, WizardCustomTimesModal, WizardTimezoneModal)
    already expect, so those generic, non-event-specific views are reused
    here unmodified.
    """
    def __init__(self, cog, guild_id: int, user_id: int, editing_id: int = None):
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id
        self.editing_id = editing_id
        self.is_update = editing_id is not None
        self.existing_notifications = {}

        # Custom event fields (custom_events columns)
        self.name = None
        self.icon_url = None
        self.first_occurrence = None  # datetime, UTC-aware
        self.recurrence_type = None   # "daily" | "weekly" | "monthly"
        self.recurrence_interval = 1

        # Reused by CommonSettingsHubView & friends
        self.channel_id = None
        self.mention_type = "none"
        self.notification_type = None  # e.g., 1, 2, 3, 4, 5, 6 (custom)
        self.custom_times = None  # For notification_type 6
        self.timezone = "UTC"

    def load_existing_notifications(self, channel_id: int):
        """
        No-op compatibility shim for WizardChannelSelectView.channel_selected,
        which calls this after the admin picks a channel. Custom events don't
        need to reconstruct state from existing vault_notifications rows here -
        editing an existing custom event pre-fills the session directly from
        its custom_events row instead (see CustomEventManageSelectView).
        """
        return

    def reminder_offsets(self) -> list[int]:
        """Reminder lead times (minutes before the event), descending, from
        whichever of notification_type/custom_times the admin picked via the
        reused WizardNotificationTypeView / WizardCustomTimesModal."""
        presets = {
            1: [30, 10, 5, 0],
            2: [10, 5, 0],
            3: [5, 0],
            4: [5],
            5: [0],
        }
        if self.notification_type == 6 and self.custom_times:
            sep = ',' if ',' in self.custom_times else '-'
            return [int(t.strip()) for t in self.custom_times.split(sep)]
        return presets.get(self.notification_type, [10, 5, 0])


class CustomEventsMenuView(discord.ui.View):
    """Top-level entry point: create a new custom event, or manage existing ones."""
    def __init__(self, cog: NotificationWizard, guild_id: int, user_id: int):
        super().__init__(timeout=7200)
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id

    @discord.ui.button(label="Create New Event", emoji=f"{theme.wizardIcon}", style=discord.ButtonStyle.success, row=0)
    async def create_event(self, interaction: discord.Interaction, button: discord.ui.Button):
        session = CustomEventSession(self.cog, self.guild_id, self.user_id)
        view = CustomEventDetailsHubView(self.cog, session)
        await view.show(interaction)

    @discord.ui.button(label="Manage Events", emoji=f"{theme.listIcon}", style=discord.ButtonStyle.primary, row=0)
    async def manage_events(self, interaction: discord.Interaction, button: discord.ui.Button):
        rows = self.cog.list_custom_events(self.guild_id)
        if not rows:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No custom events configured yet. Use **Create New Event** to build your first one.",
                ephemeral=True
            )
            return
        view = CustomEventManageSelectView(self.cog, self.guild_id, self.user_id, rows)
        await view.show(interaction)

    @discord.ui.button(label="Cancel", emoji=f"{theme.deniedIcon}", style=discord.ButtonStyle.danger, row=0)
    async def cancel_wizard(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Cancel the wizard"""
        embed = discord.Embed(
            title="Wizard Cancelled",
            description="The event calendar wizard has been cancelled.",
            color=theme.emColor2
        )
        await interaction.response.edit_message(embed=embed, view=None)

class CommonSettingsHubView(discord.ui.View):
    """Step 1: Configure common settings (channel, mention, notification times, timezone)"""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session

    async def show(self, interaction: discord.Interaction):
        """Display the common settings hub"""
        # Build status display
        channel_status = f"{theme.verifiedIcon} Configured" if self.session.channel_id else f"{theme.warnIcon} Required"
        mention_status = f"{theme.verifiedIcon} Configured" if self.session.mention_type else f"{theme.warnIcon} Required"
        notif_status = f"{theme.verifiedIcon} Configured" if self.session.notification_type else f"{theme.settingsIcon} Default (10m, 5m, Time)"
        timezone_status = f"{theme.verifiedIcon} {self.session.timezone}" if self.session.timezone != "UTC" else f"{theme.settingsIcon} UTC (Default)"

        # Get channel name if configured
        channel_name = ""
        if self.session.channel_id:
            channel = interaction.guild.get_channel(self.session.channel_id)
            if channel:
                channel_name = f" - #{channel.name}"

        # Get mention description
        mention_desc = ""
        if self.session.mention_type:
            if self.session.mention_type == "everyone":
                mention_desc = " - @everyone"
            elif self.session.mention_type.startswith("role_"):
                role_id = int(self.session.mention_type.split("_")[1])
                role = interaction.guild.get_role(role_id)
                mention_desc = f" - @{role.name}" if role else " - Role"
            elif self.session.mention_type.startswith("member_"):
                member_id = int(self.session.mention_type.split("_")[1])
                member = interaction.guild.get_member(member_id)
                mention_desc = f" - @{member.name}" if member else " - Member"
            elif self.session.mention_type == "none":
                mention_desc = " - No Mention"

        # Get notification type description
        notif_desc = ""
        if self.session.notification_type:
            notif_map = {
                1: " - 30m, 10m, 5m & Time",
                2: " - 10m, 5m & Time",
                3: " - 5m & Time",
                4: " - Only 5m",
                5: " - Only Time",
                6: f" - Custom: {self.session.custom_times}" if self.session.custom_times else " - Custom"
            }
            notif_desc = notif_map.get(self.session.notification_type, "")

        embed = discord.Embed(
            title=f"{theme.settingsIcon} Reminder Settings - {self.session.name}",
            description=(
                "Now let's configure how reminders for this event get posted.\n\n"
                "**You need to do one thing here:**\n"
                "- Specify a channel where you want the reminders to appear.\n\n"
                "**You might also want to adjust:**\n"
                "- Who gets mentioned in the reminder. No mention by default.\n"
                "- How far ahead of the event to remind people. 10m and 5m before and at the event time by default.\n\n"
                "**Settings:**\n"
                f"{theme.pinIcon} **Channel:** {channel_status}{channel_name}\n"
                f"{theme.announceIcon} **Mention:** {mention_status}{mention_desc}\n"
                f"{theme.timeIcon} **Reminder Times:** {notif_status}{notif_desc}\n\n"
                "Click the buttons below to configure each setting.\n"
                "When ready, click **Save Event**."
            ),
            color=theme.emColor1
        )

        # Check if updating an existing event
        if self.session.is_update:
            embed.set_footer(text=f"{theme.infoIcon} Updating existing event")

        self.clear_items()

        # Required settings buttons
        channel_button = discord.ui.Button(
            label="Set Channel",
            emoji=f"{theme.pinIcon}",
            style=discord.ButtonStyle.success if self.session.channel_id else discord.ButtonStyle.danger,
            row=0
        )
        channel_button.callback = self.configure_channel
        self.add_item(channel_button)

        mention_button = discord.ui.Button(
            label="Set Mention",
            emoji=f"{theme.announceIcon}",
            style=discord.ButtonStyle.success if self.session.mention_type and self.session.mention_type != "none" else discord.ButtonStyle.secondary,
            row=0
        )
        mention_button.callback = self.configure_mention
        self.add_item(mention_button)

        # Optional settings buttons
        notif_button = discord.ui.Button(
            label="Reminder Times",
            emoji=f"{theme.timeIcon}",
            style=discord.ButtonStyle.success if self.session.notification_type else discord.ButtonStyle.secondary,
            row=1
        )
        notif_button.callback = self.configure_notification_times
        self.add_item(notif_button)

        # Continue button (disabled if required settings not configured)
        can_continue = bool(self.session.channel_id)
        continue_button = discord.ui.Button(
            label="Save Event",
            emoji=f"{theme.verifiedIcon}",
            style=discord.ButtonStyle.primary,
            disabled=not can_continue,
            row=2
        )
        continue_button.callback = self.continue_to_events
        self.add_item(continue_button)

        back_button = discord.ui.Button(
            label="Back",
            emoji=f"{theme.backIcon}",
            style=discord.ButtonStyle.secondary,
            row=2
        )
        back_button.callback = self.back_to_details
        self.add_item(back_button)

        if interaction.response.is_done():
            await interaction.edit_original_response(embed=embed, view=self)
        else:
            await interaction.response.edit_message(embed=embed, view=self)

    async def configure_channel(self, interaction: discord.Interaction):
        """Show channel selection"""
        view = WizardChannelSelectView(self.cog, self.session, self)
        await view.show(interaction)

    async def configure_mention(self, interaction: discord.Interaction):
        """Show mention type selection"""
        view = WizardMentionSelectView(self.cog, self.session, self)
        await view.show(interaction)

    async def configure_notification_times(self, interaction: discord.Interaction):
        """Show notification times selection"""
        view = WizardNotificationTypeView(self.cog, self.session, self)
        await view.show(interaction)

    async def configure_timezone(self, interaction: discord.Interaction):
        """Show timezone modal"""
        modal = WizardTimezoneModal(self.session, self)
        await interaction.response.send_modal(modal)

    async def back_to_details(self, interaction: discord.Interaction):
        """Return to the name/icon/date/recurrence step"""
        view = CustomEventDetailsHubView(self.cog, self.session)
        await view.show(interaction)

    async def continue_to_events(self, interaction: discord.Interaction):
        """Save the custom event and materialize its reminder"""
        event_id = await self.cog.save_custom_event(self.session)

        embed = discord.Embed(
            title=f"{theme.verifiedIcon} Event Saved",
            description=(
                f"**{self.session.name}** has been saved to this server's event calendar.\n\n"
                f"{theme.pinIcon} **Channel:** <#{self.session.channel_id}>\n"
                f"{theme.timeIcon} **Reminders:** {', '.join(str(o) for o in sorted(self.session.reminder_offsets(), reverse=True))} minute(s) before\n\n"
                "Run the wizard again any time to create another event, or to edit/delete this one."
            ),
            color=theme.emColor3
        )
        embed.set_footer(text=f"Event ID: {event_id}")
        await interaction.response.edit_message(embed=embed, view=None)

class WizardChannelSelectView(discord.ui.View):
    """Channel selection for wizard"""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession, parent_view: CommonSettingsHubView):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session
        self.parent_view = parent_view

        # Add channel select dropdown
        channel_select = discord.ui.ChannelSelect(
            placeholder="Select notification channel",
            min_values=1,
            max_values=1,
            channel_types=[discord.ChannelType.text, discord.ChannelType.news]
        )
        channel_select.callback = self.channel_selected
        self.add_item(channel_select)

    async def show(self, interaction: discord.Interaction):
        """Display channel selection"""
        embed = discord.Embed(
            title=f"{theme.pinIcon} Select Notification Channel",
            description="Choose the channel where notifications will be posted.",
            color=theme.emColor1
        )
        await interaction.response.edit_message(embed=embed, view=self)

    async def channel_selected(self, interaction: discord.Interaction):
        """Handle channel selection"""
        channel_id = int(interaction.data["values"][0])
        self.session.channel_id = channel_id

        # Load existing wizard notifications for this channel
        self.session.load_existing_notifications(channel_id)

        # Return to common settings hub
        await self.parent_view.show(interaction)

class WizardMentionSelectView(discord.ui.View):
    """Mention type selection for wizard"""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession, parent_view: CommonSettingsHubView):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session
        self.parent_view = parent_view

    async def show(self, interaction: discord.Interaction):
        """Display mention selection"""
        embed = discord.Embed(
            title=f"{theme.announceIcon} Select Mention Type",
            description=(
                "Choose how to mention users:\n\n"
                "1️⃣ @everyone\n"
                "2️⃣ Specific Role\n"
                "3️⃣ Specific Member\n"
                "4️⃣ No Mention"
            ),
            color=theme.emColor1
        )

        self.clear_items()

        everyone_button = discord.ui.Button(
            label="@everyone",
            emoji=f"{theme.announceIcon}",
            style=discord.ButtonStyle.danger,
            row=0
        )
        everyone_button.callback = lambda i: self.mention_selected(i, "everyone")
        self.add_item(everyone_button)

        role_button = discord.ui.Button(
            label="Select Role",
            emoji=f"{theme.membersIcon}",
            style=discord.ButtonStyle.success,
            row=0
        )
        role_button.callback = self.select_role
        self.add_item(role_button)

        member_button = discord.ui.Button(
            label="Select Member",
            emoji=f"{theme.userIcon}",
            style=discord.ButtonStyle.primary,
            row=0
        )
        member_button.callback = self.select_member
        self.add_item(member_button)

        no_mention_button = discord.ui.Button(
            label="No Mention",
            emoji=f"{theme.muteIcon}",
            style=discord.ButtonStyle.secondary,
            row=0
        )
        no_mention_button.callback = lambda i: self.mention_selected(i, "none")
        self.add_item(no_mention_button)

        await interaction.response.edit_message(embed=embed, view=self)

    async def mention_selected(self, interaction: discord.Interaction, mention_type: str):
        """Handle mention selection"""
        self.session.mention_type = mention_type
        await self.parent_view.show(interaction)

    async def select_role(self, interaction: discord.Interaction):
        """Show role selector"""
        role_select = discord.ui.RoleSelect(
            placeholder="Select a role to mention",
            min_values=1,
            max_values=1
        )

        async def role_callback(select_interaction):
            role_id = select_interaction.data["values"][0]
            self.session.mention_type = f"role_{role_id}"
            await self.parent_view.show(select_interaction)

        role_select.callback = role_callback
        view = discord.ui.View(timeout=7200)
        view.add_item(role_select)

        embed = discord.Embed(
            title=f"{theme.membersIcon} Select Role",
            description="Choose a role to mention:",
            color=theme.emColor1
        )
        await interaction.response.edit_message(embed=embed, view=view)

    async def select_member(self, interaction: discord.Interaction):
        """Show member selector"""
        member_select = discord.ui.UserSelect(
            placeholder="Select a member to mention",
            min_values=1,
            max_values=1
        )

        async def member_callback(select_interaction):
            member_id = select_interaction.data["values"][0]
            self.session.mention_type = f"member_{member_id}"
            await self.parent_view.show(select_interaction)

        member_select.callback = member_callback
        view = discord.ui.View(timeout=7200)
        view.add_item(member_select)

        embed = discord.Embed(
            title=f"{theme.userIcon} Select Member",
            description="Choose a member to mention:",
            color=theme.emColor1
        )
        await interaction.response.edit_message(embed=embed, view=view)

class WizardNotificationTypeView(discord.ui.View):
    """Notification times selection for wizard"""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession, parent_view: CommonSettingsHubView):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session
        self.parent_view = parent_view

    async def show(self, interaction: discord.Interaction):
        """Display notification type selection"""
        embed = discord.Embed(
            title=f"{theme.alarmClockIcon} Select Notification Times",
            description="Choose when to send notifications before each event:",
            color=theme.emColor1
        )

        self.clear_items()

        # Type 1: 30m, 10m, 5m & Time
        type1_btn = discord.ui.Button(
            label="30m, 10m, 5m & Time",
            style=discord.ButtonStyle.primary,
            row=0
        )
        type1_btn.callback = lambda i: self.type_selected(i, 1)
        self.add_item(type1_btn)

        # Type 2: 10m, 5m & Time
        type2_btn = discord.ui.Button(
            label="10m, 5m & Time",
            style=discord.ButtonStyle.primary,
            row=0
        )
        type2_btn.callback = lambda i: self.type_selected(i, 2)
        self.add_item(type2_btn)

        # Type 3: 5m & Time
        type3_btn = discord.ui.Button(
            label="5m & Time",
            style=discord.ButtonStyle.primary,
            row=1
        )
        type3_btn.callback = lambda i: self.type_selected(i, 3)
        self.add_item(type3_btn)

        # Type 4: Only 5m
        type4_btn = discord.ui.Button(
            label="Only 5m",
            style=discord.ButtonStyle.primary,
            row=1
        )
        type4_btn.callback = lambda i: self.type_selected(i, 4)
        self.add_item(type4_btn)

        # Type 5: Only Time
        type5_btn = discord.ui.Button(
            label="Only Time",
            style=discord.ButtonStyle.primary,
            row=1
        )
        type5_btn.callback = lambda i: self.type_selected(i, 5)
        self.add_item(type5_btn)

        # Type 6: Custom
        type6_btn = discord.ui.Button(
            label="Custom Times",
            style=discord.ButtonStyle.success,
            row=2
        )
        type6_btn.callback = self.show_custom_modal
        self.add_item(type6_btn)

        await interaction.response.edit_message(embed=embed, view=self)

    async def type_selected(self, interaction: discord.Interaction, notification_type: int):
        """Handle notification type selection"""
        self.session.notification_type = notification_type
        self.session.custom_times = None
        await self.parent_view.show(interaction)

    async def show_custom_modal(self, interaction: discord.Interaction):
        """Show custom times modal"""
        modal = WizardCustomTimesModal(self.session, self.parent_view)
        await interaction.response.send_modal(modal)

class WizardCustomTimesModal(discord.ui.Modal, title="Set Custom Notification Times"):
    """Modal for custom notification times"""
    def __init__(self, session: CustomEventSession, parent_view: CommonSettingsHubView):
        super().__init__()
        self.session = session
        self.parent_view = parent_view

        self.custom_times_input = discord.ui.TextInput(
            label="Custom Notification Times",
            placeholder="Enter times in minutes (e.g., 60-20-15-4-2 or 60-20-15-4-2-0)",
            min_length=1,
            max_length=50,
            required=True,
            style=discord.TextStyle.short
        )
        self.add_item(self.custom_times_input)

    async def on_submit(self, interaction: discord.Interaction):
        """Validate and save custom times"""
        try:
            times_str = self.custom_times_input.value.strip()
            times = [int(t) for t in times_str.split('-')]

            # Validation
            if not all(isinstance(t, int) and t >= 0 for t in times):
                raise ValueError("All times must be non-negative integers")
            if not times:
                raise ValueError("At least one time must be specified")
            if not all(times[i] > times[i + 1] for i in range(len(times) - 1)):
                raise ValueError("Times must be in descending order")

            # Save to session
            self.session.notification_type = 6
            self.session.custom_times = times_str

            # Return to hub using followup since modal consumed the interaction
            await interaction.response.defer()
            # We need to edit the original message
            await interaction.edit_original_response(embed=None, view=self.parent_view)
            await self.parent_view.show(interaction)

        except ValueError as e:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid input: {str(e)}",
                ephemeral=True
            )

class WizardTimezoneModal(discord.ui.Modal, title="Set Timezone"):
    """Modal for timezone selection"""
    def __init__(self, session: CustomEventSession, parent_view: CommonSettingsHubView):
        super().__init__()
        self.session = session
        self.parent_view = parent_view

        self.timezone_input = discord.ui.TextInput(
            label="Timezone",
            placeholder="e.g., UTC, America/New_York, UTC+2, UTC-5",
            default=session.timezone,
            required=True,
            max_length=50
        )
        self.add_item(self.timezone_input)

    async def on_submit(self, interaction: discord.Interaction):
        """Validate and save timezone"""
        try:
            tz_input = self.timezone_input.value.strip()

            # Convert UTC+X or UTC-X to appropriate timezone format
            if tz_input.upper() == "UTC":
                tz_name = "UTC"
            elif tz_input.upper().startswith("UTC+") or tz_input.upper().startswith("UTC-"):
                # Extract offset
                offset_str = tz_input[3:]  # Remove "UTC"

                # Parse offset - support both formats
                if ':' in offset_str:
                    # HH:MM format
                    parts = offset_str.split(':')
                    hours = int(parts[0])
                    minutes = int(parts[1])
                    offset = hours + (minutes / 60.0 if hours >= 0 else -minutes / 60.0)
                else:
                    # Decimal format
                    offset = float(offset_str)

                # Convert to Etc/GMT timezone (note: Etc/GMT has inverted signs)
                if offset >= 0:
                    tz_name = f"Etc/GMT-{int(offset)}"
                else:
                    tz_name = f"Etc/GMT+{int(abs(offset))}"
            else:
                # Try as pytz timezone
                tz_name = tz_input

            # Validate timezone
            pytz.timezone(tz_name)
            self.session.timezone = tz_name

            # Return to hub
            await interaction.response.defer()
            await self.parent_view.show(interaction)

        except Exception as e:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid timezone! Please use a valid timezone name (e.g., UTC, America/New_York, UTC+2).",
                ephemeral=True
            )

class CustomEventDetailsHubView(discord.ui.View):
    """Step 1 of the custom event wizard: name, icon, first occurrence, recurrence."""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session

    async def show(self, interaction: discord.Interaction):
        s = self.session
        name_status = f"{theme.verifiedIcon} {s.name}" if s.name else f"{theme.warnIcon} Required"
        icon_status = s.icon_url if s.icon_url else f"{theme.settingsIcon} Default ({DEFAULT_EVENT_ICON})"
        if s.first_occurrence:
            date_status = f"{theme.verifiedIcon} {s.first_occurrence.strftime('%Y-%m-%d %H:%M')} UTC"
        else:
            date_status = f"{theme.warnIcon} Required"
        if s.recurrence_type:
            recur_status = f"{theme.verifiedIcon} {s.recurrence_type.capitalize()}, every {s.recurrence_interval}"
        else:
            recur_status = f"{theme.warnIcon} Required"

        embed = discord.Embed(
            title=f"{theme.wizardIcon} " + ("Edit Custom Event" if s.is_update else "New Custom Event"),
            description=(
                "Build the calendar entry for this event. Police Chief has no built-in "
                "event schedule, so every field here is up to you.\n\n"
                "**Required:**\n"
                f"{theme.editListIcon} **Name:** {name_status}\n"
                f"{theme.timeIcon} **First Occurrence (UTC):** {date_status}\n"
                f"{theme.refreshIcon} **Recurrence:** {recur_status}\n\n"
                "**Optional:**\n"
                f"{theme.calendarIcon} **Icon:** {icon_status}\n\n"
                "Click the buttons below to configure each field.\n"
                "When ready, click **Continue** to set reminders and a channel."
            ),
            color=theme.emColor1
        )

        self.clear_items()

        name_button = discord.ui.Button(
            label="Set Name", emoji=f"{theme.editListIcon}",
            style=discord.ButtonStyle.success if s.name else discord.ButtonStyle.danger, row=0
        )
        name_button.callback = self.set_name
        self.add_item(name_button)

        icon_button = discord.ui.Button(
            label="Set Icon (optional)", emoji=f"{theme.calendarIcon}",
            style=discord.ButtonStyle.success if s.icon_url else discord.ButtonStyle.secondary, row=0
        )
        icon_button.callback = self.set_icon
        self.add_item(icon_button)

        date_button = discord.ui.Button(
            label="Set Date & Time", emoji=f"{theme.timeIcon}",
            style=discord.ButtonStyle.success if s.first_occurrence else discord.ButtonStyle.danger, row=1
        )
        date_button.callback = self.set_datetime
        self.add_item(date_button)

        recur_button = discord.ui.Button(
            label="Set Recurrence", emoji=f"{theme.refreshIcon}",
            style=discord.ButtonStyle.success if s.recurrence_type else discord.ButtonStyle.danger, row=1
        )
        recur_button.callback = self.set_recurrence
        self.add_item(recur_button)

        can_continue = bool(s.name and s.first_occurrence and s.recurrence_type)
        continue_button = discord.ui.Button(
            label="Continue", emoji=f"{theme.forwardIcon}",
            style=discord.ButtonStyle.primary, disabled=not can_continue, row=2
        )
        continue_button.callback = self.continue_to_settings
        self.add_item(continue_button)

        cancel_button = discord.ui.Button(
            label="Cancel", emoji=f"{theme.deniedIcon}", style=discord.ButtonStyle.secondary, row=2
        )
        cancel_button.callback = self.cancel
        self.add_item(cancel_button)

        if interaction.response.is_done():
            await interaction.edit_original_response(embed=embed, view=self)
        else:
            await interaction.response.edit_message(embed=embed, view=self)

    async def set_name(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CustomEventNameModal(self.session, self))

    async def set_icon(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CustomEventIconModal(self.session, self))

    async def set_datetime(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CustomEventDateTimeModal(self.session, self))

    async def set_recurrence(self, interaction: discord.Interaction):
        view = CustomEventRecurrenceView(self.cog, self.session, self)
        await view.show(interaction)

    async def continue_to_settings(self, interaction: discord.Interaction):
        view = CommonSettingsHubView(self.cog, self.session)
        await view.show(interaction)

    async def cancel(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title="Cancelled",
            description="Event creation/edit cancelled. No changes were saved.",
            color=theme.emColor2
        )
        await interaction.response.edit_message(embed=embed, view=None)


class CustomEventNameModal(discord.ui.Modal, title="Event Name"):
    def __init__(self, session: CustomEventSession, parent_view: CustomEventDetailsHubView):
        super().__init__()
        self.session = session
        self.parent_view = parent_view
        self.name_input = discord.ui.TextInput(
            label="Event Name",
            placeholder="e.g., Weekly Raid",
            default=session.name or "",
            max_length=100,
            required=True
        )
        self.add_item(self.name_input)

    async def on_submit(self, interaction: discord.Interaction):
        self.session.name = self.name_input.value.strip()
        await interaction.response.defer()
        await self.parent_view.show(interaction)


class CustomEventIconModal(discord.ui.Modal, title="Event Icon (Optional)"):
    def __init__(self, session: CustomEventSession, parent_view: CustomEventDetailsHubView):
        super().__init__()
        self.session = session
        self.parent_view = parent_view
        self.icon_input = discord.ui.TextInput(
            label="Icon (a single emoji), optional",
            placeholder=f"Leave blank to use the default {DEFAULT_EVENT_ICON}",
            default=session.icon_url or "",
            max_length=50,
            required=False
        )
        self.add_item(self.icon_input)

    async def on_submit(self, interaction: discord.Interaction):
        value = self.icon_input.value.strip()
        self.session.icon_url = value or None
        await interaction.response.defer()
        await self.parent_view.show(interaction)


class CustomEventDateTimeModal(discord.ui.Modal, title="First Occurrence (UTC)"):
    def __init__(self, session: CustomEventSession, parent_view: CustomEventDetailsHubView):
        super().__init__()
        self.session = session
        self.parent_view = parent_view
        default_date = session.first_occurrence.strftime("%Y-%m-%d") if session.first_occurrence else ""
        default_time = session.first_occurrence.strftime("%H:%M") if session.first_occurrence else ""
        self.date_input = discord.ui.TextInput(
            label="Date (YYYY-MM-DD, UTC)",
            placeholder="2026-09-01",
            default=default_date,
            max_length=10,
            required=True
        )
        self.add_item(self.date_input)
        self.time_input = discord.ui.TextInput(
            label="Time (HH:MM, 24h, UTC)",
            placeholder="18:00",
            default=default_time,
            max_length=5,
            required=True
        )
        self.add_item(self.time_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            date_str = self.date_input.value.strip()
            time_str = self.time_input.value.strip()
            naive = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            self.session.first_occurrence = pytz.UTC.localize(naive)
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date/time. Use YYYY-MM-DD for the date and HH:MM (24h) for the time, both in UTC.",
                ephemeral=True
            )
            return
        await interaction.response.defer()
        await self.parent_view.show(interaction)


class CustomEventRecurrenceView(discord.ui.View):
    """Pick Daily / Weekly / Monthly, then the interval."""
    def __init__(self, cog: NotificationWizard, session: CustomEventSession, parent_view: CustomEventDetailsHubView):
        super().__init__(timeout=7200)
        self.cog = cog
        self.session = session
        self.parent_view = parent_view

    async def show(self, interaction: discord.Interaction):
        current = (
            f"{self.session.recurrence_type.capitalize()}, every {self.session.recurrence_interval}"
            if self.session.recurrence_type else "Not set"
        )
        embed = discord.Embed(
            title=f"{theme.refreshIcon} Set Recurrence",
            description=(
                "How often does this event repeat?\n\n"
                "**Daily** - fires every N days\n"
                "**Weekly** - fires every N weeks, on the same weekday as the first occurrence\n"
                "**Monthly** - fires every N months, on the same day of month as the first occurrence\n\n"
                f"Current: **{current}**"
            ),
            color=theme.emColor1
        )
        self.clear_items()
        for label, value in (("Daily", "daily"), ("Weekly", "weekly"), ("Monthly", "monthly")):
            btn = discord.ui.Button(
                label=label,
                style=discord.ButtonStyle.success if self.session.recurrence_type == value else discord.ButtonStyle.primary,
                row=0
            )
            btn.callback = self._make_callback(value)
            self.add_item(btn)

        back_button = discord.ui.Button(label="Back", emoji=f"{theme.backIcon}", style=discord.ButtonStyle.secondary, row=1)
        back_button.callback = self.back
        self.add_item(back_button)

        await interaction.response.edit_message(embed=embed, view=self)

    def _make_callback(self, recurrence_type: str):
        async def callback(interaction: discord.Interaction):
            self.session.recurrence_type = recurrence_type
            modal = CustomEventIntervalModal(self.session, self)
            await interaction.response.send_modal(modal)
        return callback

    async def back(self, interaction: discord.Interaction):
        await self.parent_view.show(interaction)


class CustomEventIntervalModal(discord.ui.Modal, title="Recurrence Interval"):
    def __init__(self, session: CustomEventSession, recurrence_view: CustomEventRecurrenceView):
        super().__init__()
        self.session = session
        self.recurrence_view = recurrence_view
        unit = {"daily": "days", "weekly": "weeks", "monthly": "months"}[session.recurrence_type]
        self.interval_input = discord.ui.TextInput(
            label=f"Every how many {unit}?",
            placeholder="1",
            default=str(session.recurrence_interval or 1),
            max_length=3,
            required=True
        )
        self.add_item(self.interval_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            interval = int(self.interval_input.value.strip())
            if interval < 1:
                raise ValueError
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Interval must be a positive whole number.", ephemeral=True
            )
            return
        self.session.recurrence_interval = interval
        await interaction.response.defer()
        await self.recurrence_view.parent_view.show(interaction)


class CustomEventManageSelectView(discord.ui.View):
    """Pick an existing custom event, then Edit or Delete it."""
    def __init__(self, cog: NotificationWizard, guild_id: int, user_id: int, rows: list):
        super().__init__(timeout=7200)
        self.cog = cog
        self.guild_id = guild_id
        self.user_id = user_id
        self.rows = rows
        self.selected_id = rows[0]["id"] if rows else None
        self.add_item(CustomEventSelectDropdown(self))

    async def show(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title=f"{theme.listIcon} Manage Custom Events",
            description="Select an event below, then **Edit** or **Delete** it.",
            color=theme.emColor1
        )
        if interaction.response.is_done():
            await interaction.edit_original_response(embed=embed, view=self)
        else:
            await interaction.response.edit_message(embed=embed, view=self)

    @discord.ui.button(label="Edit", emoji=f"{theme.editListIcon}", style=discord.ButtonStyle.primary, row=1)
    async def edit_selected(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.selected_id:
            await interaction.response.send_message(f"{theme.deniedIcon} Select an event first.", ephemeral=True)
            return
        row = self.cog.get_custom_event(self.selected_id)
        if not row:
            await interaction.response.send_message(f"{theme.deniedIcon} That event no longer exists.", ephemeral=True)
            return

        session = CustomEventSession(self.cog, self.guild_id, self.user_id, editing_id=row["id"])
        session.name = row["name"]
        session.icon_url = row["icon_url"]
        session.first_occurrence = datetime.fromisoformat(row["first_occurrence"])
        session.recurrence_type = row["recurrence_type"]
        session.recurrence_interval = row["recurrence_interval"]
        session.channel_id = row["channel_id"]
        try:
            offsets = json.loads(row["reminder_offsets"]) if row["reminder_offsets"] else [10, 5, 0]
        except (ValueError, TypeError):
            offsets = [10, 5, 0]
        session.notification_type = 6
        session.custom_times = "-".join(str(o) for o in sorted(offsets, reverse=True))

        # mention_type isn't a custom_events column - pull it back from the
        # already-materialized reminder row so editing doesn't silently reset it.
        self.cog.cursor.execute(
            "SELECT mention_type FROM vault_notifications WHERE custom_event_id = ? LIMIT 1",
            (row["id"],)
        )
        existing = self.cog.cursor.fetchone()
        if existing and existing[0]:
            session.mention_type = existing[0]

        view = CustomEventDetailsHubView(self.cog, session)
        await view.show(interaction)

    @discord.ui.button(label="Delete", emoji=f"{theme.deniedIcon}", style=discord.ButtonStyle.danger, row=1)
    async def delete_selected(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.selected_id:
            await interaction.response.send_message(f"{theme.deniedIcon} Select an event first.", ephemeral=True)
            return
        row = self.cog.get_custom_event(self.selected_id)
        if not row:
            await interaction.response.send_message(f"{theme.deniedIcon} That event no longer exists.", ephemeral=True)
            return

        view = CustomEventDeleteConfirmView(self.cog, row)
        await interaction.response.send_message(
            f"{theme.warnIcon} **Delete \"{row['name']}\"?** This also removes its scheduled reminder. "
            "This cannot be undone.",
            view=view,
            ephemeral=True
        )

    @discord.ui.button(label="Back", emoji=f"{theme.backIcon}", style=discord.ButtonStyle.secondary, row=1)
    async def back(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = CustomEventsMenuView(self.cog, self.guild_id, self.user_id)
        embed = discord.Embed(
            title=f"{theme.wizardIcon} Event Calendar Wizard",
            description="What would you like to do?",
            color=discord.Color.gold()
        )
        await interaction.response.edit_message(embed=embed, view=view)


class CustomEventSelectDropdown(discord.ui.Select):
    def __init__(self, parent_view: CustomEventManageSelectView):
        self.parent_view = parent_view
        options = []
        for row in parent_view.rows[:25]:
            options.append(discord.SelectOption(
                label=row["name"][:100],
                value=str(row["id"]),
                emoji=get_event_icon(row["name"], parent_view.guild_id),
                default=(row["id"] == parent_view.selected_id)
            ))
        super().__init__(placeholder="Select an event...", options=options, row=0)

    async def callback(self, interaction: discord.Interaction):
        self.parent_view.selected_id = int(self.values[0])
        for option in self.options:
            option.default = (option.value == self.values[0])
        await interaction.response.edit_message(view=self.parent_view)


class CustomEventDeleteConfirmView(discord.ui.View):
    """Confirmation view for deleting a custom event, mirroring the
    templates cog's ResetConfirmView Yes/No pattern."""
    def __init__(self, cog: NotificationWizard, row: dict):
        super().__init__(timeout=60)
        self.cog = cog
        self.row = row

    @discord.ui.button(label="Yes, Delete", style=discord.ButtonStyle.danger)
    async def confirm_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        success = await self.cog.delete_custom_event(self.row["id"])
        if success:
            await interaction.response.edit_message(
                content=f"{theme.verifiedIcon} \"{self.row['name']}\" has been deleted.",
                view=None
            )
        else:
            await interaction.response.edit_message(
                content=f"{theme.deniedIcon} Could not delete that event (it may already be gone).",
                view=None
            )
        self.stop()

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary)
    async def cancel_delete(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.edit_message(content="Deletion cancelled.", view=None)
        self.stop()

async def setup(bot):
    await bot.add_cog(NotificationWizard(bot))