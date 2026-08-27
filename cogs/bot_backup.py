"""
Database backup and restore system. Manages scheduled and manual backups.
"""
import discord
from discord.ext import commands, tasks
import sqlite3
import os
import re
import zipfile
import datetime
import tempfile
import pyzipper
import shutil
import traceback
import logging
import asyncio
from .permission_handler import PermissionManager
from .pimp_my_bot import theme

logger = logging.getLogger('bot')

# Only a bare "name.sqlite" (no path separators, no "..") is ever accepted
# out of a restore zip -- rejects zip-slip attempts (entries that would
# write outside db/) outright rather than trying to sanitize them.
_RESTORE_SQLITE_NAME_RE = re.compile(r'^[A-Za-z0-9_-]+\.sqlite$')
_RESTORE_MAX_UPLOAD_BYTES = 500 * 1024 * 1024

class BackupOperations(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self.db_path = "db/backup.sqlite"
        self.backup_dir = "backups"
        self.log_path = "log/backuplog.txt"
        os.makedirs("log", exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)
        self.setup_database()
        self.automatic_backup_loop.start()

    DEFAULT_SETTINGS = {
        'auto_enabled': 1,
        'auto_interval_hours': 3,
        'keep_automatic': 2,
        'keep_manual': 5,
    }

    def setup_database(self):
        os.makedirs("db", exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS backup_passwords (
                discord_id TEXT PRIMARY KEY,
                backup_password TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        cursor.execute('''
            CREATE TABLE IF NOT EXISTS backup_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                auto_enabled INTEGER NOT NULL DEFAULT 1,
                auto_interval_hours INTEGER NOT NULL DEFAULT 3,
                keep_automatic INTEGER NOT NULL DEFAULT 2,
                keep_manual INTEGER NOT NULL DEFAULT 5,
                last_auto_backup_at TEXT
            )
        ''')
        cursor.execute('''
            INSERT OR IGNORE INTO backup_settings (id) VALUES (1)
        ''')

        conn.commit()
        conn.close()

    def get_settings(self) -> dict:
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM backup_settings WHERE id = 1").fetchone()
        if not row:
            return dict(self.DEFAULT_SETTINGS, last_auto_backup_at=None)
        return dict(row)

    def update_settings(self, **kwargs) -> None:
        if not kwargs:
            return
        cols = ", ".join(f"{k} = ?" for k in kwargs)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                f"UPDATE backup_settings SET {cols} WHERE id = 1",
                list(kwargs.values()),
            )
            conn.commit()

    async def cog_unload(self):
        self.automatic_backup_loop.cancel()

    def get_disk_space_info(self):
        """Get disk space information in MB"""
        try:
            # Get disk usage for the current directory
            total, used, free = shutil.disk_usage(".")
            return {
                'total_mb': total / (1024 * 1024),
                'used_mb': used / (1024 * 1024),
                'free_mb': free / (1024 * 1024)
            }
        except Exception as e:
            logger.error(f"Error getting disk space: {e}")
            print(f"Error getting disk space: {e}")
            return None

    def estimate_backup_size(self):
        """Estimate the size of a backup in MB"""
        try:
            total_size = 0
            for file in os.listdir("db"):
                if file.endswith(".sqlite"):
                    file_path = os.path.join("db", file)
                    total_size += os.path.getsize(file_path)
            
            estimated_compressed = total_size * 1.2 # 20% overhead for compression and packaging
            return estimated_compressed / (1024 * 1024)
        except Exception as e:
            logger.error(f"Error estimating backup size: {e}")
            print(f"Error estimating backup size: {e}")
            return 50  # Conservative default of 50MB

    def can_create_backup(self, save_locally=True):
        """Check if we have enough space to create a backup"""
        space_info = self.get_disk_space_info()
        if not space_info:
            return False, "Cannot determine disk space"
        
        estimated_size = self.estimate_backup_size()
        
        if save_locally:
            required_space = estimated_size + 50  # 50MB buffer for local saves
        else:
            required_space = estimated_size + 10  # 10MB buffer for DM sends (backup deleted after send)
        
        if space_info['free_mb'] < required_space:
            return False, f"Insufficient disk space. Need {required_space:.1f}MB, have {space_info['free_mb']:.1f}MB"
        
        if not save_locally and estimated_size > 24: # Check if backup would exceed Discord's 25MB limit for DM
            return False, f"Backup too large for Discord ({estimated_size:.1f}MB > 24MB limit)"
        
        return True, "OK"

    def log_backup(self, admin_id: str, success: bool, backup_type: str, method: str, filename: str = None, error_message: str = None):
        try:
            timestamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            log_message = f"[{timestamp}] "
            log_message += f"Type: {backup_type} | Method: {method} | "
            log_message += f"Admin ID: {admin_id} | "
            log_message += f"Status: {theme.verifiedIcon + ' Success' if success else theme.deniedIcon + ' Failed'}"
            if filename:
                log_message += f" | File: {filename}"
            if error_message:
                log_message += f" | Error: {error_message}"
            log_message += "\n"
            log_message += f"{theme.upperDivider}\n"

            with open(self.log_path, 'a', encoding='utf-8') as log_file:
                log_file.write(log_message)
        except Exception as e:
            logger.error(f"Logging error: {e}")
            print(f"Logging error: {e}")

    @tasks.loop(minutes=5)
    async def automatic_backup_loop(self):
        try:
            settings = self.get_settings()
            if not settings.get('auto_enabled'):
                return

            interval_hours = max(1, int(settings.get('auto_interval_hours') or 3))
            last_at = settings.get('last_auto_backup_at')
            if last_at:
                try:
                    last_dt = datetime.datetime.fromisoformat(last_at)
                    if datetime.datetime.utcnow() - last_dt < datetime.timedelta(hours=interval_hours):
                        return
                except ValueError:
                    pass

            with sqlite3.connect("db/settings.sqlite") as conn:
                global_admins = conn.execute(
                    "SELECT id FROM admin WHERE is_initial = 1"
                ).fetchall()

            can_backup, reason = self.can_create_backup(save_locally=True)
            if not can_backup:
                logger.info(f"Automatic backup skipped: {reason}")
                for admin_id in global_admins:
                    self.log_backup(str(admin_id[0]), False, "Automatic Backup", "Local", None, reason)
                return

            keep = max(1, int(settings.get('keep_automatic') or 2))
            # One backup per cycle, attributed to the first global admin (for their password).
            owner_id = str(global_admins[0][0]) if global_admins else "system"
            try:
                filename = await self.create_backup(owner_id, "Automatic", save_locally=True)
                if filename:
                    self.log_backup(owner_id, True, "Automatic Backup", "Local", filename)
                    await self.cleanup_old_backups("automatic", keep=keep)
                else:
                    self.log_backup(owner_id, False, "Automatic Backup", "Local", None, "Backup creation failed")
            except Exception as e:
                self.log_backup(owner_id, False, "Automatic Backup", "Local", None, str(e))

            self.update_settings(last_auto_backup_at=datetime.datetime.utcnow().isoformat())

        except Exception as e:
            logger.error(f"Automatic backup error: {e}")
            print(f"Automatic backup error: {e}")

    @automatic_backup_loop.before_loop
    async def before_automatic_backup(self):
        await self.bot.wait_until_ready()

    async def show_backup_menu(self, interaction: discord.Interaction):
        is_admin, is_global = PermissionManager.is_admin(interaction.user.id)
        if not is_admin or not is_global:
            await interaction.response.send_message(f"{theme.deniedIcon} This menu is only available for Global Admins!", ephemeral=True)
            return

        space_info = self.get_disk_space_info()
        estimated_backup_size = self.estimate_backup_size()
        backup_files = self.get_backup_files()
        settings = self.get_settings()

        free_line = (
            f"{theme.saveIcon} **Free Space:** {space_info['free_mb']:.1f} MB"
            if space_info else
            f"{theme.saveIcon} **Free Space:** Unknown"
        )
        if settings.get('auto_enabled'):
            auto_line = (
                f"{theme.alarmClockIcon} **Auto Backup:** Every "
                f"{settings.get('auto_interval_hours', 3)} hour(s) "
                f"· keep last {settings.get('keep_automatic', 2)}"
            )
        else:
            auto_line = f"{theme.alarmClockIcon} **Auto Backup:** Disabled"

        embed = discord.Embed(
            title=f"{theme.saveIcon} Backup System",
            description=(
                f"**System Status**\n"
                f"{theme.upperDivider}\n"
                f"{free_line}\n"
                f"{theme.chartIcon} **Estimated Backup Size:** {estimated_backup_size:.1f} MB\n"
                f"{theme.documentIcon} **Local Backups:** {len(backup_files)} files\n"
                f"{auto_line}\n"
                f"{theme.lowerDivider}\n\n"
                f"**Available Operations**\n"
                f"{theme.upperDivider}\n"
                f"{theme.lockIcon} **Set Password**\n"
                f"└ Encrypt future backups with a password\n\n"
                f"{theme.saveIcon} **Create Backup**\n"
                f"└ Make a backup now via DM or local save\n\n"
                f"{theme.settingsIcon} **Auto Backup Settings**\n"
                f"└ Schedule automatic backups and retention\n\n"
                f"{theme.listIcon} **View Local Backups**\n"
                f"└ List and clean up saved backup files\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1,
        )

        if space_info and space_info['free_mb'] < 100:
            embed.add_field(
                name=f"{theme.warnIcon} Low Disk Space Warning",
                value=f"Only {space_info['free_mb']:.1f} MB free. Consider cleaning old backups.",
                inline=False,
            )

        await interaction.response.edit_message(embed=embed, view=BackupView(self))

    def get_backup_files(self):
        """Get list of all local backup files"""
        backup_files = []
        try:
            for file in os.listdir(self.backup_dir):
                if file.endswith('.zip'):
                    backup_files.append(os.path.join(self.backup_dir, file))
        except Exception:
            pass
        return sorted(backup_files, key=os.path.getmtime, reverse=True)

    def _snapshot_dbs(self, dest_dir):
        """Snapshot every db/*.sqlite into dest_dir via SQLite's online backup API (WAL-safe)."""
        for f in os.listdir("db"):
            if f.endswith(".sqlite"):
                src = sqlite3.connect(os.path.join("db", f), timeout=30.0)
                try:
                    dst = sqlite3.connect(os.path.join(dest_dir, f))
                    try:
                        src.backup(dst)
                    finally:
                        dst.close()
                finally:
                    src.close()

    def _write_db_zip(self, filepath, password, readme_content):
        """Zip snapshots of all db/*.sqlite + README (AES-LZMA if password, else DEFLATED). Sync — use to_thread."""
        with tempfile.TemporaryDirectory() as snap_dir:
            self._snapshot_dbs(snap_dir)
            names = sorted(f for f in os.listdir(snap_dir) if f.endswith(".sqlite"))
            if password:
                with pyzipper.AESZipFile(filepath, 'w', compression=pyzipper.ZIP_LZMA, encryption=pyzipper.WZ_AES) as zf:
                    zf.setpassword(password.encode())
                    for f in names:
                        zf.write(os.path.join(snap_dir, f), f)
                    zf.writestr("README.txt", readme_content)
            else:
                with zipfile.ZipFile(filepath, 'w', zipfile.ZIP_DEFLATED) as zf:
                    for f in names:
                        zf.write(os.path.join(snap_dir, f), f)
                    zf.writestr("README.txt", readme_content)

    async def create_backup(self, user_id: str, backup_type: str = "Manual", save_locally: bool = True):
        try:
            # Get password
            conn = sqlite3.connect(self.db_path)
            cursor = conn.cursor()
            cursor.execute("SELECT backup_password FROM backup_passwords WHERE discord_id = ?", (user_id,))
            password_result = cursor.fetchone()
            conn.close()

            backup_password = password_result[0] if password_result else None

            timestamp = datetime.datetime.now()
            backup_name = f"{backup_type.lower()}_{timestamp.strftime('%Y%m%d_%H%M%S')}"

            if save_locally:
                # Save to local backups folder
                filename = f"{backup_name}_encrypted.zip" if backup_password else f"{backup_name}.zip"
                filepath = os.path.join(self.backup_dir, filename)
                enc_line = "Encryption: AES (Password Protected)\n" if backup_password else ""
                extract_pw = " using your backup password" if backup_password else ""
                readme_content = (
                    "Local Backup\n"
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                    f"Created: {timestamp.strftime('%Y-%m-%d %H:%M:%S')}\n"
                    f"User ID: {user_id}\n"
                    f"Type: {backup_type}\n"
                    "Contains: All SQLite database files\n"
                    f"{enc_line}"
                    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
                    "To restore:\n"
                    f"1. Extract this ZIP file{extract_pw}\n"
                    "2. Replace your db/ folder contents with these files\n"
                    "3. Restart the bot\n\n"
                    f"{theme.robotIcon} Police Chief Discord Bot Backup System\n"
                )
                await asyncio.to_thread(self._write_db_zip, filepath, backup_password, readme_content)
                return filename
            
            else:
                # Send via DM - create temporary file
                with tempfile.TemporaryDirectory() as temp_dir:
                    filename = f"{backup_name}_encrypted.zip" if backup_password else f"{backup_name}.zip"
                    temp_filepath = os.path.join(temp_dir, filename)
                    enc_line = "Encryption: AES (Password Protected)\n" if backup_password else ""
                    extract_pw = " using your backup password" if backup_password else ""
                    readme_content = (
                        "Discord Backup\n"
                        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                        f"Created: {timestamp.strftime('%Y-%m-%d %H:%M:%S')}\n"
                        f"User ID: {user_id}\n"
                        f"Type: {backup_type}\n"
                        "Contains: All SQLite database files\n"
                        f"{enc_line}"
                        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
                        "To restore:\n"
                        f"1. Extract this ZIP file{extract_pw}\n"
                        "2. Replace your db/ folder contents with these files\n"
                        "3. Restart the bot\n\n"
                        "⚠️ This backup expires in 30 days from Discord\n\n"
                        f"{theme.robotIcon} Police Chief Discord Bot Backup System\n"
                    )
                    await asyncio.to_thread(self._write_db_zip, temp_filepath, backup_password, readme_content)
                    
                    # Check file size before sending
                    file_size = os.path.getsize(temp_filepath)
                    if file_size > 24 * 1024 * 1024:
                        return None
                    
                    try: # Send to user via DM
                        user = await self.bot.fetch_user(int(user_id))
                        dm_channel = user.dm_channel or await user.create_dm()
                        
                        embed = discord.Embed(
                            title=f"{theme.saveIcon} Database Backup",
                            description=(
                                f"**Backup Details**\n"
                                f"{theme.upperDivider}\n"
                                f"{theme.calendarIcon} **Created:** {timestamp.strftime('%Y-%m-%d %H:%M:%S')}\n"
                                f"{theme.documentIcon} **Type:** {backup_type}\n"
                                f"{theme.shieldIcon} **Password Protected:** {'Yes' if backup_password else 'No'}\n"
                                f"{theme.chartIcon} **File Size:** {file_size / 1024 / 1024:.2f} MB\n"
                                f"{theme.lowerDivider}\n\n"
                                f"{theme.warnIcon} **Important:**\n"
                                f"• {'Use your backup password to open this file' if backup_password else 'This file is not password protected'}\n"
                                f"• Store this file in a secure location\n"
                                f"• This backup expires in 30 days from Discord"
                            ),
                            color=theme.emColor3
                        )

                        with open(temp_filepath, 'rb') as f:
                            file = discord.File(f, filename=filename)
                            await dm_channel.send(embed=embed, file=file)

                        return filename

                    except Exception as e:
                        logger.error(f"Error sending backup via DM: {e}")
                        print(f"Error sending backup via DM: {e}")
                        return None

        except Exception as e:
            logger.error(f"Backup creation error: {e}")
            print(f"Backup creation error: {e}")
            traceback.print_exc()
            return None

    def _validate_and_extract_restore_zip(self, zip_path: str, password, dest_dir: str) -> tuple:
        """Extract every valid, safely-named *.sqlite member from a backup
        zip into dest_dir, then integrity-check each one before returning.
        Sync -- run via asyncio.to_thread.

        Raises ValueError with a human-readable reason on ANY problem: not
        a valid zip, a wrong/missing password, a suspicious member name
        (zip-slip attempt -- rejects the WHOLE zip rather than silently
        skipping just that entry, since a crafted zip is reason enough not
        to trust anything else in it either), zero valid members, or a
        failed integrity check. Nothing gets written to db/ from this
        method at all -- it only ever writes into dest_dir (a caller-owned
        temp staging directory), so a validation failure here can never
        leave live data half-overwritten.

        Returns (restored_names, missing_from_zip) -- `missing_from_zip`
        is informational only: which of the *currently present* db/*.sqlite
        files this backup doesn't include (e.g. an older backup predating
        a newer feature's own db file), so the confirmation prompt can
        surface it without treating it as an error."""
        try:
            zf = pyzipper.AESZipFile(zip_path, 'r')
        except Exception as e:
            raise ValueError(f"Not a valid zip file: {e}")

        valid_names = []
        with zf:
            if password:
                zf.setpassword(password.encode())
            try:
                names = zf.namelist()
            except RuntimeError as e:
                raise ValueError(f"Could not read zip contents (wrong password?): {e}")

            for name in names:
                if name == "README.txt":
                    continue
                if not _RESTORE_SQLITE_NAME_RE.match(name):
                    raise ValueError(
                        f"Refusing to restore: unexpected entry {name!r} in the "
                        f"backup zip (only plain *.sqlite filenames are allowed). "
                        f"This zip may be corrupted or tampered with."
                    )
                valid_names.append(name)

            if not valid_names:
                raise ValueError("This backup zip contains no .sqlite files.")

            for name in valid_names:
                try:
                    data = zf.read(name)
                except RuntimeError as e:
                    raise ValueError(f"Could not read {name!r} (wrong password?): {e}")
                with open(os.path.join(dest_dir, name), "wb") as f:
                    f.write(data)

        for name in valid_names:
            dest_path = os.path.join(dest_dir, name)
            conn = sqlite3.connect(dest_path)
            try:
                try:
                    result = conn.execute("PRAGMA integrity_check").fetchone()
                except sqlite3.DatabaseError as e:
                    raise ValueError(
                        f"{name} is not a valid SQLite database ({e}) -- "
                        f"refusing to restore a corrupted database file."
                    )
                if not result or result[0] != "ok":
                    raise ValueError(
                        f"{name} failed its integrity check ({result[0] if result else 'no result'}) "
                        f"-- refusing to restore a corrupted database file."
                    )
            finally:
                conn.close()

        current_names = (
            {f for f in os.listdir("db") if f.endswith(".sqlite")}
            if os.path.isdir("db") else set()
        )
        missing_from_zip = sorted(current_names - set(valid_names))

        return sorted(valid_names), missing_from_zip

    async def cleanup_old_backups(self, backup_type: str, keep: int = 2):
        """Clean up old local backups, keeping only the most recent ones"""
        try:
            backup_files = []
            for file in os.listdir(self.backup_dir):
                if file.startswith(backup_type.lower()) and file.endswith('.zip'):
                    filepath = os.path.join(self.backup_dir, file)
                    backup_files.append((filepath, os.path.getmtime(filepath)))
            
            # Sort by modification time (newest first)
            backup_files.sort(key=lambda x: x[1], reverse=True)
            
            # Remove old files
            removed_count = 0
            for filepath, _ in backup_files[keep:]:
                try:
                    os.remove(filepath)
                    removed_count += 1
                except Exception as e:
                    logger.error(f"Error removing {filepath}: {e}")
                    print(f"Error removing {filepath}: {e}")
            
            return removed_count
        except Exception as e:
            logger.error(f"Cleanup error: {e}")
            print(f"Cleanup error: {e}")
            return 0

    # ── /restore ─────────────────────────────────────────────────────────────
    # Bot Owner only (stricter than every other admin action in this bot,
    # including Transfer Owner and Restart Bot -- restoring can silently
    # overwrite the admin/adminserver tables themselves, i.e. it can change
    # who the Owner even is, so the gate needs to be at least that strict).
    # Validation writes only into a temp staging directory (see
    # _validate_and_extract_restore_zip); nothing under db/ is touched
    # until the admin explicitly confirms on the follow-up prompt, and even
    # then a fresh safety backup of the CURRENT data is taken first so a
    # bad restore can itself be undone.

    @discord.app_commands.command(
        name="restore",
        description="Restore ALL bot data from a backup zip (Bot Owner only)",
    )
    @discord.app_commands.describe(
        file="The backup .zip file to restore",
        password="Password, only if this backup was created with one",
    )
    async def restore(self, interaction: discord.Interaction, file: discord.Attachment,
                      password: "str | None" = None):
        if not PermissionManager.is_owner(interaction.user.id):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Only the Bot Owner can restore from a backup -- "
                f"this replaces every alliance's data at once.",
                ephemeral=True,
            )
            return

        if not file.filename.lower().endswith(".zip"):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please attach a `.zip` backup file.", ephemeral=True
            )
            return

        if file.size > _RESTORE_MAX_UPLOAD_BYTES:
            await interaction.response.send_message(
                f"{theme.deniedIcon} That file is too large "
                f"({file.size / 1024 / 1024:.0f} MB, limit "
                f"{_RESTORE_MAX_UPLOAD_BYTES // 1024 // 1024} MB).",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True, thinking=True)

        stage_dir = tempfile.mkdtemp(prefix="restore_stage_")
        zip_path = os.path.join(stage_dir, "_upload.zip")
        try:
            await file.save(zip_path)
            restored_names, missing = await asyncio.to_thread(
                self._validate_and_extract_restore_zip, zip_path, password, stage_dir
            )
        except ValueError as e:
            shutil.rmtree(stage_dir, ignore_errors=True)
            await interaction.followup.send(f"{theme.deniedIcon} {e}", ephemeral=True)
            return
        except Exception as e:
            shutil.rmtree(stage_dir, ignore_errors=True)
            logger.error(f"Restore validation failed: {e}")
            await interaction.followup.send(
                f"{theme.deniedIcon} Failed to read that backup: {e}", ephemeral=True
            )
            return
        finally:
            try:
                os.remove(zip_path)
            except OSError:
                pass

        total_size = sum(
            os.path.getsize(os.path.join(stage_dir, n)) for n in restored_names
        )
        desc = (
            f"{theme.warnIcon} **This will overwrite ALL current bot data** -- every "
            f"alliance's Vault Trap/Capitol War history, member registrations, admin "
            f"permissions, settings, everything -- with the contents of this backup.\n\n"
            f"A safety backup of the **current** data is taken automatically first, "
            f"so this can be undone by restoring that safety backup afterward if "
            f"something's wrong.\n\n"
            f"**Files to restore ({len(restored_names)}, {total_size / 1024 / 1024:.1f} MB):**\n"
            + "\n".join(f"• {n}" for n in restored_names)
        )
        if missing:
            desc += (
                f"\n\n{theme.infoIcon} Not included in this backup (left as-is): "
                + ", ".join(missing)
            )
        desc += (
            f"\n\n{theme.warnIcon} The bot must restart to load the restored data. "
            f"On Windows it does **not** auto-restart -- you'll need to run "
            f"`python main.py` again afterward."
        )

        embed = discord.Embed(
            title=f"{theme.saveIcon} Confirm Restore",
            description=desc,
            color=theme.emColor2,
        )
        view = _RestoreConfirmView(self, interaction.user.id, stage_dir, restored_names)
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)


async def _global_admin_check(interaction: discord.Interaction) -> bool:
    """Re-verify Global Admin on every click (persisted menus can be re-clicked)."""
    _, is_global = PermissionManager.is_admin(interaction.user.id)
    if not is_global:
        await interaction.response.send_message(
            f"{theme.deniedIcon} Only global admins can use this menu.", ephemeral=True
        )
        return False
    return True


class BackupView(discord.ui.View):
    def __init__(self, cog):
        super().__init__(timeout=7200)
        self.cog = cog

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await _global_admin_check(interaction)

    @discord.ui.button(label="Set Password", emoji=f"{theme.lockIcon}", style=discord.ButtonStyle.primary, row=0)
    async def set_password(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_modal(BackupPasswordModal(self.cog))

    @discord.ui.button(label="Create Backup", emoji=f"{theme.saveIcon}", style=discord.ButtonStyle.success, row=0)
    async def create_backup(self, interaction: discord.Interaction, button: discord.ui.Button):
        embed = discord.Embed(
            title=f"{theme.saveIcon} Create Backup",
            description=(
                f"Choose how you want to receive your backup:\n\n"
                f"**{theme.messageIcon} Direct Message**\n"
                f"• Sent to your DMs immediately\n"
                f"• Limited to 24MB (Discord limit)\n"
                f"• Expires in 30 days\n\n"
                f"**{theme.saveIcon} Save Locally**\n"
                f"• Saved to server's backup folder\n"
                f"• No size limit (uses server storage)\n"
                f"• Permanent until manually deleted"
            ),
            color=theme.emColor1,
        )
        await interaction.response.send_message(
            embed=embed, view=BackupChoiceView(self.cog, interaction.user.id), ephemeral=True
        )

    @discord.ui.button(label="Auto Backup Settings", emoji=f"{theme.settingsIcon}", style=discord.ButtonStyle.primary, row=0)
    async def settings_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = BackupSettingsView(self.cog)
        await interaction.response.edit_message(embed=view.build_embed(), view=view)

    @discord.ui.button(label="View Local Backups", emoji=f"{theme.listIcon}", style=discord.ButtonStyle.primary, row=1)
    async def view_backups(self, interaction: discord.Interaction, button: discord.ui.Button):
        view = BackupManageView(self.cog)
        await interaction.response.edit_message(embed=view.build_embed(), view=view)

    @discord.ui.button(label="Restore from Backup", emoji=f"{theme.retryIcon}", style=discord.ButtonStyle.danger, row=1)
    async def restore_info(self, interaction: discord.Interaction, button: discord.ui.Button):
        # Discord has no way to attach a file to a button click -- a
        # restore zip can only be uploaded as a slash-command attachment,
        # so this button is purely informational rather than the entry
        # point itself. Bot-Owner-only (see BackupOperations.restore), so
        # non-owners are told that plainly rather than pointed at a
        # command they can't actually run.
        is_owner = PermissionManager.is_owner(interaction.user.id)
        if is_owner:
            desc = (
                f"Restoring has to be done through `/restore` (Discord doesn't "
                f"let a file be attached to a button click) -- run it with the "
                f"backup zip attached:\n\n"
                f"`/restore file:<attach your backup .zip> "
                f"password:<only if it's encrypted>`\n\n"
                f"You'll get a confirmation prompt showing exactly what's in "
                f"the backup before anything is touched, and a safety backup "
                f"of the current data is taken automatically first."
            )
        else:
            desc = (
                f"Restoring from a backup is restricted to the Bot Owner -- it "
                f"replaces every alliance's data at once, so only the single "
                f"most-trusted admin tier can trigger it. Ask the Bot Owner to "
                f"run `/restore` if you need data restored."
            )
        await interaction.response.send_message(
            embed=discord.Embed(
                title=f"{theme.retryIcon} Restore from Backup",
                description=desc,
                color=theme.emColor1 if is_owner else theme.emColor2,
            ),
            ephemeral=True,
        )

    @discord.ui.button(label="Back", emoji=f"{theme.backIcon}", style=discord.ButtonStyle.secondary, row=1)
    async def back_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        main_menu_cog = self.cog.bot.get_cog("MainMenu")
        if main_menu_cog:
            await main_menu_cog.show_maintenance(interaction)


class _RestoreConfirmView(discord.ui.View):
    """Confirm/Cancel for BackupOperations.restore. Holds the already-
    validated, already-integrity-checked staging directory (see
    _validate_and_extract_restore_zip) -- nothing under db/ is touched
    until Confirm is actually clicked, and the staging directory is
    cleaned up on every exit path (confirm, cancel, or timeout) so a
    forgotten prompt doesn't leak disk space."""

    def __init__(self, cog, viewer_id: int, stage_dir: str, restored_names: list):
        super().__init__(timeout=300)
        self.cog = cog
        self.viewer_id = viewer_id
        self.stage_dir = stage_dir
        self.restored_names = restored_names
        self._resolved = False

    async def on_timeout(self):
        if not self._resolved:
            shutil.rmtree(self.stage_dir, ignore_errors=True)

    @discord.ui.button(label="Confirm Restore", style=discord.ButtonStyle.danger,
                       emoji=f"{theme.verifiedIcon}", row=0)
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button):
        if interaction.user.id != self.viewer_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} This prompt is for someone else.", ephemeral=True,
            )
            return
        # Re-verify at click time, not just at command-entry time -- this
        # prompt can sit open for up to 5 minutes.
        if not PermissionManager.is_owner(interaction.user.id):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Only the Bot Owner can restore from a backup.",
                ephemeral=True,
            )
            return

        self._resolved = True
        for child in self.children:
            child.disabled = True
        await interaction.response.edit_message(
            embed=discord.Embed(
                title=f"{theme.saveIcon} Taking a safety backup of current data...",
                color=theme.emColor1,
            ),
            view=self,
        )

        safety_filename = await self.cog.create_backup(
            str(interaction.user.id), "Pre-Restore Safety", save_locally=True
        )
        if not safety_filename:
            shutil.rmtree(self.stage_dir, ignore_errors=True)
            await interaction.edit_original_response(
                embed=discord.Embed(
                    title=f"{theme.deniedIcon} Restore Aborted",
                    description=(
                        "Could not create a safety backup of the current data, "
                        "so the restore was **not** performed -- refusing to "
                        "overwrite data with no way back if something's wrong."
                    ),
                    color=theme.emColor2,
                ),
                view=None,
            )
            return

        try:
            os.makedirs("db", exist_ok=True)
            for name in self.restored_names:
                # shutil.move, not os.replace -- the staging dir lives under
                # the system temp dir, which in a Docker deployment is on a
                # different filesystem than a bind-mounted db/ volume.
                # os.replace (like os.rename) can't cross that boundary and
                # raises EXDEV ("Invalid cross-device link"); shutil.move
                # already handles this by falling back to copy+delete when
                # a same-filesystem rename isn't possible, while still doing
                # a plain atomic rename (no fallback needed) whenever it is.
                shutil.move(
                    os.path.join(self.stage_dir, name),
                    os.path.join("db", name),
                )
        except Exception as e:
            logger.error(f"Restore write failed: {e}")
            await interaction.edit_original_response(
                embed=discord.Embed(
                    title=f"{theme.deniedIcon} Restore Failed Mid-Write",
                    description=(
                        f"Error: {e}\n\nA safety backup of the pre-restore data "
                        f"was saved as `{safety_filename}` -- restore that if "
                        f"the db/ folder is now in a bad state."
                    ),
                    color=theme.emColor2,
                ),
                view=None,
            )
            return
        finally:
            shutil.rmtree(self.stage_dir, ignore_errors=True)

        health_cog = self.cog.bot.get_cog("BotHealth")
        if health_cog is None:
            await interaction.edit_original_response(
                embed=discord.Embed(
                    title=f"{theme.verifiedIcon} Restore Complete",
                    description=(
                        f"Data restored (pre-restore safety backup: "
                        f"`{safety_filename}`). Restart the bot manually to "
                        f"load it."
                    ),
                    color=theme.emColor3,
                ),
                view=None,
            )
            return
        # Reuses the exact same restart path the "Restart Bot" health-menu
        # button uses (marker-persist + platform-aware restart_process) --
        # see cogs/bot_health.py's perform_restart -- rather than
        # duplicating that logic here.
        await health_cog.perform_restart(interaction)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary,
                       emoji=f"{theme.backIcon}", row=0)
    async def cancel(self, interaction: discord.Interaction, _button: discord.ui.Button):
        if interaction.user.id != self.viewer_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} This prompt is for someone else.", ephemeral=True,
            )
            return
        self._resolved = True
        shutil.rmtree(self.stage_dir, ignore_errors=True)
        await interaction.response.edit_message(
            embed=discord.Embed(
                title=f"{theme.infoIcon} Restore Cancelled",
                description="No changes were made.",
                color=theme.emColor1,
            ),
            view=None,
        )


class BackupChoiceView(discord.ui.View):
    def __init__(self, cog, user_id):
        super().__init__(timeout=60)
        self.cog = cog
        self.user_id = user_id

    @discord.ui.button(label="Send to DM", emoji=f"{theme.messageIcon}", style=discord.ButtonStyle.primary)
    async def send_dm(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(f"{theme.deniedIcon} This is not your menu!", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        
        # Check if we can create DM backup
        can_backup, reason = self.cog.can_create_backup(save_locally=False)
        if not can_backup:
            embed = discord.Embed(
                title=f"{theme.deniedIcon} Cannot Create DM Backup",
                description=reason,
                color=theme.emColor2
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
            return
        
        filename = await self.cog.create_backup(str(self.user_id), "Manual", save_locally=False)
        
        if filename:
            embed = discord.Embed(
                title=f"{theme.verifiedIcon} Backup Sent",
                description=f"Backup `{filename}` has been sent to your direct messages!",
                color=theme.emColor3
            )
            self.cog.log_backup(str(self.user_id), True, "Manual Backup", "DM", filename)
        else:
            embed = discord.Embed(
                title=f"{theme.deniedIcon} Backup Failed",
                description="Failed to create or send backup. Check file size and try local save instead.",
                color=theme.emColor2
            )
            self.cog.log_backup(str(self.user_id), False, "Manual Backup", "DM", None, "Creation/send failed")

        await interaction.followup.send(embed=embed, ephemeral=True)

    @discord.ui.button(label="Save Locally", emoji=f"{theme.saveIcon}", style=discord.ButtonStyle.success)
    async def save_local(self, interaction: discord.Interaction, button: discord.ui.Button):
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(f"{theme.deniedIcon} This is not your menu!", ephemeral=True)
            return

        await interaction.response.defer(ephemeral=True)
        
        # Check if we can create local backup
        can_backup, reason = self.cog.can_create_backup(save_locally=True)
        if not can_backup:
            embed = discord.Embed(
                title=f"{theme.deniedIcon} Cannot Create Local Backup",
                description=reason,
                color=theme.emColor2
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
            return
        
        filename = await self.cog.create_backup(str(self.user_id), "Manual", save_locally=True)
        
        if filename:
            file_path = os.path.join(self.cog.backup_dir, filename)
            file_size = os.path.getsize(file_path) / (1024 * 1024)
            
            embed = discord.Embed(
                title=f"{theme.verifiedIcon} Local Backup Created",
                description=(
                    f"**Backup Details:**\n"
                    f"{theme.documentIcon} **File:** {filename}\n"
                    f"{theme.chartIcon} **Size:** {file_size:.2f} MB\n"
                    f"{theme.pinIcon} **Location:** `{os.path.abspath(file_path)}`\n\n"
                    f"Use 'View Local Backups' to manage your saved backups."
                ),
                color=theme.emColor3
            )
            self.cog.log_backup(str(self.user_id), True, "Manual Backup", "Local", filename)
        else:
            embed = discord.Embed(
                title=f"{theme.deniedIcon} Backup Failed",
                description="Failed to create local backup. Check disk space and try again.",
                color=theme.emColor2
            )
            self.cog.log_backup(str(self.user_id), False, "Manual Backup", "Local", None, "Creation failed")

        await interaction.followup.send(embed=embed, ephemeral=True)


class BackupManageView(discord.ui.View):
    """View Local Backups page: lists files and lets the admin trim manual
    backups beyond the configured keep count."""

    def __init__(self, cog, status_note: str | None = None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.status_note = status_note

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await _global_admin_check(interaction)

    def build_embed(self) -> discord.Embed:
        backup_files = self.cog.get_backup_files()
        settings = self.cog.get_settings()
        embed = discord.Embed(
            title=f"{theme.listIcon} Local Backup Files",
            color=theme.emColor1,
        )

        if not backup_files:
            embed.description = (
                f"No local backup files yet.\n\n"
                f"Use **Create Backup** from the Backup System menu, or wait "
                f"for the next automatic backup."
            )
            return embed

        total_size = 0
        for filepath in backup_files[:10]:
            filename = os.path.basename(filepath)
            file_size = os.path.getsize(filepath)
            total_size += file_size
            mod_time = datetime.datetime.fromtimestamp(os.path.getmtime(filepath))
            embed.add_field(
                name=f"{theme.documentIcon} {filename}",
                value=(
                    f"{theme.chartIcon} {file_size / (1024 * 1024):.2f} MB\n"
                    f"{theme.alarmClockIcon} {mod_time.strftime('%Y-%m-%d %H:%M:%S')}"
                ),
                inline=True,
            )

        embed.add_field(
            name=f"{theme.chartIcon} Summary",
            value=(
                f"Total shown: {total_size / (1024 * 1024):.2f} MB · "
                f"Files: {min(len(backup_files), 10)} of {len(backup_files)}\n"
                f"Retention: keep last **{settings.get('keep_manual', 5)}** manual · "
                f"**{settings.get('keep_automatic', 2)}** automatic"
            ),
            inline=False,
        )

        if self.status_note:
            embed.add_field(
                name=f"{theme.verifiedIcon} Last Action",
                value=self.status_note,
                inline=False,
            )

        return embed

    @discord.ui.button(label="Clean Old Backups", emoji=f"{theme.cleanIcon}", style=discord.ButtonStyle.secondary, row=0)
    async def clean_backups(self, interaction: discord.Interaction, button: discord.ui.Button):
        settings = self.cog.get_settings()
        keep_manual = max(1, int(settings.get('keep_manual') or 5))
        keep_auto = max(1, int(settings.get('keep_automatic') or 2))
        manual_removed = await self.cog.cleanup_old_backups("manual", keep=keep_manual)
        auto_removed = await self.cog.cleanup_old_backups("automatic", keep=keep_auto)

        if manual_removed == 0 and auto_removed == 0:
            self.status_note = (
                f"Already within retention limits — nothing to remove."
            )
        else:
            parts = []
            if manual_removed:
                parts.append(f"{manual_removed} manual")
            if auto_removed:
                parts.append(f"{auto_removed} automatic")
            self.status_note = f"Removed {' and '.join(parts)} backup(s)."

        await interaction.response.edit_message(embed=self.build_embed(), view=self)

    @discord.ui.button(label="Back", emoji=f"{theme.backIcon}", style=discord.ButtonStyle.secondary, row=0)
    async def back_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.cog.show_backup_menu(interaction)


class BackupSettingsView(discord.ui.View):
    """Configure auto-backup behavior: on/off, interval, and how many of each
    type to keep."""

    def __init__(self, cog):
        super().__init__(timeout=7200)
        self.cog = cog
        self._build_components()

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        return await _global_admin_check(interaction)

    def build_embed(self) -> discord.Embed:
        s = self.cog.get_settings()
        last = s.get('last_auto_backup_at') or '—'
        if last != '—':
            try:
                last = datetime.datetime.fromisoformat(last).strftime('%Y-%m-%d %H:%M UTC')
            except ValueError:
                pass
        status = (
            f"{theme.verifiedIcon} `enabled`" if s.get('auto_enabled')
            else f"{theme.deniedIcon} `disabled`"
        )
        return discord.Embed(
            title=f"{theme.settingsIcon} Auto Backup Settings",
            description=(
                f"Control how often the bot creates automatic local backups "
                f"and how many it keeps before pruning older ones.\n\n"
                f"{theme.upperDivider}\n"
                f"{theme.alarmClockIcon} **Auto Backup:** {status}\n"
                f"{theme.timeIcon} **Interval:** every "
                f"`{s.get('auto_interval_hours', 3)}` hour(s)\n"
                f"{theme.saveIcon} **Retention (Automatic):** keep last "
                f"`{s.get('keep_automatic', 2)}`\n"
                f"{theme.documentIcon} **Retention (Manual):** keep last "
                f"`{s.get('keep_manual', 5)}`\n"
                f"{theme.lowerDivider}\n\n"
                f"_Last automatic backup:_ `{last}`"
            ),
            color=theme.emColor1,
        )

    def _build_components(self):
        self.clear_items()
        s = self.cog.get_settings()
        enabled = bool(s.get('auto_enabled'))

        toggle = discord.ui.Button(
            label=f"Auto Backup: {'On' if enabled else 'Off'}",
            emoji=f"{theme.alarmClockIcon}",
            style=discord.ButtonStyle.success if enabled else discord.ButtonStyle.secondary,
            row=0,
        )
        toggle.callback = self._toggle_enabled
        self.add_item(toggle)

        interval_btn = discord.ui.Button(
            label="Edit Interval", emoji=f"{theme.timeIcon}",
            style=discord.ButtonStyle.secondary, row=0,
        )
        interval_btn.callback = self._edit_interval
        self.add_item(interval_btn)

        retention_btn = discord.ui.Button(
            label="Edit Retention", emoji=f"{theme.saveIcon}",
            style=discord.ButtonStyle.secondary, row=0,
        )
        retention_btn.callback = self._edit_retention
        self.add_item(retention_btn)

        back_btn = discord.ui.Button(
            label="Back", emoji=f"{theme.backIcon}",
            style=discord.ButtonStyle.secondary, row=1,
        )
        back_btn.callback = self._back
        self.add_item(back_btn)

    async def _refresh(self, interaction: discord.Interaction):
        self._build_components()
        await interaction.response.edit_message(embed=self.build_embed(), view=self)

    async def _toggle_enabled(self, interaction: discord.Interaction):
        s = self.cog.get_settings()
        self.cog.update_settings(auto_enabled=0 if s.get('auto_enabled') else 1)
        await self._refresh(interaction)

    async def _edit_interval(self, interaction: discord.Interaction):
        await interaction.response.send_modal(
            _BackupNumberModal(
                self.cog, parent_view=self, field='auto_interval_hours',
                title="Set Auto Backup Interval",
                label="Hours between backups (1-168)",
                default=str(self.cog.get_settings().get('auto_interval_hours', 3)),
                min_value=1, max_value=168,
            )
        )

    async def _edit_retention(self, interaction: discord.Interaction):
        s = self.cog.get_settings()
        await interaction.response.send_modal(
            _RetentionModal(
                self.cog, parent_view=self,
                default_auto=str(s.get('keep_automatic', 2)),
                default_manual=str(s.get('keep_manual', 5)),
            )
        )

    async def _back(self, interaction: discord.Interaction):
        await self.cog.show_backup_menu(interaction)


class _BackupNumberModal(discord.ui.Modal):
    """Single-field numeric modal that writes to a specific column on
    backup_settings, then refreshes the parent view in place."""

    def __init__(self, cog, parent_view, field, title, label, default,
                 min_value: int, max_value: int):
        super().__init__(title=title)
        self.cog = cog
        self.parent_view = parent_view
        self.field = field
        self.min_value = min_value
        self.max_value = max_value
        self.input = discord.ui.TextInput(
            label=label, default=default, required=True, max_length=5,
        )
        self.add_item(self.input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            value = int(self.input.value.strip())
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please enter a whole number.", ephemeral=True
            )
            return
        if not (self.min_value <= value <= self.max_value):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Value must be between {self.min_value} and {self.max_value}.",
                ephemeral=True,
            )
            return

        self.cog.update_settings(**{self.field: value})
        self.parent_view._build_components()
        await interaction.response.edit_message(
            embed=self.parent_view.build_embed(), view=self.parent_view
        )


class _RetentionModal(discord.ui.Modal):
    """Two-field modal for the auto + manual retention counts. Validates both
    before writing so a single bad value doesn't half-update the settings."""

    def __init__(self, cog, parent_view, default_auto: str, default_manual: str):
        super().__init__(title="Edit Backup Retention")
        self.cog = cog
        self.parent_view = parent_view
        self.auto_input = discord.ui.TextInput(
            label="Automatic backups to keep (1-30)",
            default=default_auto, required=True, max_length=5,
        )
        self.manual_input = discord.ui.TextInput(
            label="Manual backups to keep (1-30)",
            default=default_manual, required=True, max_length=5,
        )
        self.add_item(self.auto_input)
        self.add_item(self.manual_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            auto = int(self.auto_input.value.strip())
            manual = int(self.manual_input.value.strip())
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Both fields must be whole numbers.", ephemeral=True
            )
            return
        if not (1 <= auto <= 30) or not (1 <= manual <= 30):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Both values must be between 1 and 30.", ephemeral=True
            )
            return

        self.cog.update_settings(keep_automatic=auto, keep_manual=manual)
        self.parent_view._build_components()
        await interaction.response.edit_message(
            embed=self.parent_view.build_embed(), view=self.parent_view
        )


class BackupPasswordModal(discord.ui.Modal, title="Set Backup Password"):
    def __init__(self, cog):
        super().__init__()
        self.cog = cog

    password = discord.ui.TextInput(
        label="Backup Password",
        placeholder="Enter a secure password (leave empty to remove password)...",
        min_length=0,
        max_length=50,
        required=False
    )

    async def on_submit(self, interaction: discord.Interaction):
        password_value = self.password.value.strip()
        
        conn = sqlite3.connect(self.cog.db_path)
        cursor = conn.cursor()
        
        if password_value:
            cursor.execute(
                "INSERT OR REPLACE INTO backup_passwords (discord_id, backup_password) VALUES (?, ?)",
                (str(interaction.user.id), password_value)
            )
            message = "Your backup password has been saved successfully!"
            title = f"{theme.verifiedIcon} Password Set"
        else:
            cursor.execute("DELETE FROM backup_passwords WHERE discord_id = ?", (str(interaction.user.id),))
            message = "Your backup password has been removed. Future backups will not be encrypted."
            title = f"{theme.verifiedIcon} Password Removed"
        
        conn.commit()
        conn.close()

        embed = discord.Embed(
            title=title,
            description=message,
            color=theme.emColor3
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

async def setup(bot):
    await bot.add_cog(BackupOperations(bot))