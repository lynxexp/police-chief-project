"""
Notification event type helpers.

Police Chief has no verified event schedule data, so this bot ships with a
DB-backed, admin-configured custom-event calendar (see the `custom_events`
table, created in notification_wizard.py / notification_system.py) instead
of any pre-filled event list.

This module keeps only the small set of generic, name-agnostic helpers
that other notification_*.py cogs still genuinely need (icon lookups
against the admin-configured custom_events table, and simple time-slot
validation utilities). It intentionally contains zero event-specific
names, dates, or cadences.
"""
import logging
import sqlite3
from datetime import datetime
from typing import Optional, List

logger = logging.getLogger('notification')

_EVENTS_DB = 'db/events.sqlite'

# The three generic recurrence primitives custom events can use.
# See notification_schedule.py for the actual next-occurrence date math.
RECURRENCE_TYPES = ('daily', 'weekly', 'monthly')

DEFAULT_EVENT_ICON = "📅"


def get_event_types(guild_id: Optional[int] = None) -> List[str]:
    """
    Names of this guild's admin-configured custom events, for use in dropdowns.

    Returns an empty list if guild_id isn't supplied (there is no longer a
    single global event list - custom events are per-guild).
    """
    if guild_id is None:
        return []
    try:
        with sqlite3.connect(_EVENTS_DB, timeout=30.0) as conn:
            rows = conn.execute(
                "SELECT name FROM custom_events WHERE guild_id = ? ORDER BY name COLLATE NOCASE",
                (guild_id,),
            ).fetchall()
        return [row[0] for row in rows]
    except sqlite3.Error:
        return []


def _looks_like_emoji(value: Optional[str]) -> bool:
    """
    True for values short enough (and not URL-shaped) to safely pass as a
    discord.py `emoji=` argument on a Button/SelectOption. Admins can type
    anything into a custom event's icon field; this keeps a stray pasted
    image URL or long string from crashing UI construction. Values that
    fail this check still work fine as plain text (e.g. the %i placeholder
    in a notification message) - callers needing that use get_event_icon()
    directly instead of this.
    """
    if not value:
        return False
    if value.startswith(("http://", "https://")):
        return False
    return len(value) <= 8


def get_event_icon(event_type: Optional[str], guild_id: Optional[int] = None) -> str:
    """
    Best-effort icon lookup for a (custom) event name.

    If guild_id is given, only that guild's custom_events row is considered.
    If not, any guild's row with a matching name is used (matching the old
    EVENT_CONFIG behavior, which was also not guild-scoped) as a best-effort
    fallback for call sites that only have the bare event name on hand.
    Falls back to a generic calendar emoji when nothing matches, or when the
    stored icon isn't emoji-safe (e.g. an admin pasted an image URL) - this
    return value is also used directly as a discord.py `emoji=` argument in
    several call sites, which raises if given anything but a short emoji.
    """
    if not event_type:
        return DEFAULT_EVENT_ICON
    try:
        with sqlite3.connect(_EVENTS_DB, timeout=30.0) as conn:
            if guild_id is not None:
                row = conn.execute(
                    "SELECT icon_url FROM custom_events WHERE guild_id = ? AND name = ? LIMIT 1",
                    (guild_id, event_type),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT icon_url FROM custom_events WHERE name = ? LIMIT 1",
                    (event_type,),
                ).fetchone()
        if row and _looks_like_emoji(row[0]):
            return row[0]
    except sqlite3.Error:
        pass
    return DEFAULT_EVENT_ICON


def validate_time_slot(time_str: str, slot_type: str = "5min") -> bool:
    """
    Validate if a time string matches the required slot format.

    Args:
        time_str: Time string in HH:MM format
        slot_type: Type of slot validation ("5min", "any", "fixed")

    Returns:
        True if valid, False otherwise
    """
    try:
        hours, minutes = map(int, time_str.split(":"))

        if not (0 <= hours <= 23 and 0 <= minutes <= 59):
            return False

        if slot_type == "5min":
            # Must be in 5-minute increments (0, 5, 10, 15, etc.)
            return minutes % 5 == 0

        return True
    except (ValueError, AttributeError):
        return False


def round_to_5min_slot(dt: datetime) -> datetime:
    """
    Round a datetime to the nearest 5-minute slot.

    Args:
        dt: Datetime object to round

    Returns:
        Rounded datetime object
    """
    minute = (dt.minute // 5) * 5
    return dt.replace(minute=minute, second=0, microsecond=0)
