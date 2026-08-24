"""
Gift code orchestrator cog. Announce-only: Police Chief has no per-player
redemption API, so this cog just tracks codes an admin adds and
announces them to each alliance's configured channel. Delegates to
gift_channels and gift_views for the heavy lifting.
"""

import discord
from discord.ext import commands
import sqlite3
import os
import logging

from .pimp_my_bot import theme, safe_edit_message
from . import gift_channels
from .gift_views import GiftView


class GiftOperations(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

        self.logger = logging.getLogger('gift')  # Operations log -> gift.log

        self.logger.info("GiftOperations Cog initializing...")

        os.makedirs('db', exist_ok=True)

        if hasattr(bot, 'conn'):
            self.conn = bot.conn
            self.cursor = self.conn.cursor()
        else:
            self.conn = sqlite3.connect('db/giftcode.sqlite', timeout=30.0)
            self.cursor = self.conn.cursor()

            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA cache_size=10000")
            self.conn.execute("PRAGMA temp_store=MEMORY")
            self.conn.commit()

        # Settings DB Connection
        self.settings_conn = sqlite3.connect('db/settings.sqlite', timeout=30.0, check_same_thread=False)
        self.settings_cursor = self.settings_conn.cursor()

        # Alliance DB Connection
        self.alliance_conn = sqlite3.connect('db/alliance.sqlite', timeout=30.0, check_same_thread=False)
        self.alliance_cursor = self.alliance_conn.cursor()

        # Gift Code Channel Table: alliance_id -> the channel new codes are announced in
        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS giftcode_channel (
                alliance_id INTEGER,
                channel_id INTEGER,
                PRIMARY KEY (alliance_id)
            )
        """)
        self.conn.commit()

        # gift_codes itself is created elsewhere (main.py) with just
        # (giftcode TEXT PRIMARY KEY, date TEXT). Add the announce-only columns
        # this cog needs, following the existing ALTER-if-missing pattern.
        for ddl in (
            "ALTER TABLE gift_codes ADD COLUMN note TEXT",
            "ALTER TABLE gift_codes ADD COLUMN expiry_date TEXT",
            "ALTER TABLE gift_codes ADD COLUMN is_active INTEGER DEFAULT 1",
            "ALTER TABLE gift_codes ADD COLUMN created_by INTEGER",
            # Legacy column. No longer
            # read or written anywhere - left in place rather than dropped.
            "ALTER TABLE gift_codes ADD COLUMN validation_status TEXT DEFAULT 'pending'",
        ):
            try:
                self.cursor.execute(ddl)
                self.conn.commit()
            except sqlite3.OperationalError:
                pass

    # ── Utility methods ─────────────────────────────────────────────────

    async def cog_unload(self):
        for conn_name in ['conn', 'settings_conn', 'alliance_conn']:
            if hasattr(self, conn_name):
                try:
                    getattr(self, conn_name).close()
                except Exception:
                    pass

    def clean_gift_code(self, giftcode):
        import unicodedata
        cleaned = ''.join(char for char in giftcode if unicodedata.category(char)[0] != 'C')
        return cleaned.strip()

    # ── Event listeners ─────────────────────────────────────────────────

    @commands.Cog.listener()
    async def on_ready(self):
        self.logger.info("GiftOps Cog: on_ready triggered.")
        try:
            self.logger.info("Validating gift code channels...")
            self.cursor.execute("SELECT channel_id, alliance_id FROM giftcode_channel")
            channel_configs = self.cursor.fetchall()

            invalid_channels = []
            for channel_id, alliance_id in channel_configs:
                channel = self.bot.get_channel(channel_id)
                if not channel:
                    invalid_channels.append(channel_id)
                elif not isinstance(channel, discord.TextChannel):
                    invalid_channels.append(channel_id)
                elif not channel.permissions_for(channel.guild.me).send_messages:
                    self.logger.warning(f"Missing send message permissions in channel {channel_id}.")

            if invalid_channels:
                unique_invalid = list(set(invalid_channels))
                placeholders = ','.join('?' * len(unique_invalid))
                try:
                    self.cursor.execute(f"DELETE FROM giftcode_channel WHERE channel_id IN ({placeholders})", unique_invalid)
                    self.conn.commit()
                except sqlite3.Error as db_err:
                    self.logger.exception(f"DATABASE ERROR removing invalid channels: {db_err}")

            self.logger.info("GiftOps Cog: on_ready setup finished successfully.")

        except sqlite3.Error as db_err:
            self.logger.exception(f"DATABASE ERROR during on_ready setup: {db_err}")
        except Exception as e:
            self.logger.exception(f"UNEXPECTED ERROR during on_ready setup: {e}")

    # ── Menu entry point ──────────────────────────────────────────────

    async def show_gift_menu(self, interaction: discord.Interaction):
        gift_menu_embed = discord.Embed(
            title=f"{theme.giftIcon} Gift Code Operations",
            description=(
                "Here you can manage gift codes and announce them to your alliances.\n\n"
                "Police Chief has no auto-redemption API, so the bot can't redeem codes "
                "for members automatically. Instead, add a "
                "code here and the bot posts an announcement to every alliance's "
                "configured gift code channel, with a link members use to redeem it "
                "themselves.\n\n"
                f"If you're new here, start with **Manage Channels** to set up the "
                f"channel each alliance should receive gift code announcements in.\n\n"
                f"**Available Operations**\n"
                f"{theme.upperDivider}\n"
                f"{theme.giftIcon} **Add Gift Code**\n"
                f"└ Add a new code (with an optional note/expiry) and announce it\n\n"
                f"{theme.listIcon} **List Gift Codes**\n"
                f"└ View all active, non-expired codes\n\n"
                f"{theme.warnIcon} **Mark Code Expired**\n"
                f"└ Stop showing a code as active, without deleting its history\n\n"
                f"{theme.announceIcon} **Manage Channels**\n"
                f"└ Set up the channel each alliance receives announcements in\n\n"
                f"{theme.trashIcon} **Delete Gift Code**\n"
                f"└ Permanently remove a code (rarely needed)\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1
        )
        view = GiftView(self, interaction.user.id)
        await safe_edit_message(interaction, embed=gift_menu_embed, view=view)

    # ── Delegation to gift_channels ───────────────────────────────────

    async def setup_gift_channel(self, interaction):
        return await gift_channels.setup_gift_channel(self, interaction)

    async def manage_channel_settings(self, interaction):
        return await gift_channels.manage_channel_settings(self, interaction)

    async def delete_gift_channel(self, interaction):
        return await gift_channels.delete_gift_channel(self, interaction)

    async def delete_gift_channel_for_alliance(self, interaction, alliance_id):
        return await gift_channels.delete_gift_channel_for_alliance(self, interaction, alliance_id)

    # ── Delegation to gift_views ──────────────────────────────────────

    async def create_gift_code(self, interaction):
        from .gift_views import create_gift_code as _create
        return await _create(self, interaction)

    async def list_gift_codes(self, interaction):
        from .gift_views import list_gift_codes as _list
        return await _list(self, interaction)

    async def mark_gift_code_expired(self, interaction):
        from .gift_views import mark_gift_code_expired as _mark
        return await _mark(self, interaction)

    async def delete_gift_code(self, interaction):
        from .gift_views import delete_gift_code as _delete
        return await _delete(self, interaction)

    async def get_admin_info(self, user_id):
        from .gift_views import get_admin_info as _info
        return await _info(self, user_id)

    async def get_available_alliances(self, interaction):
        from .gift_views import get_available_alliances as _alliances
        return await _alliances(self, interaction)


async def setup(bot):
    await bot.add_cog(GiftOperations(bot))
