"""Weekday-repeat (repeat_minutes == -1) bookkeeping in NotificationSystem.

The admin-configured custom-event wizard (CustomEventRecurrenceView) only
offers daily/weekly/monthly recurrence, not an arbitrary multi-weekday
picker, so weekly events just repeat on the same weekday as their
first_occurrence and there is nothing to "pass weekdays through" from the
wizard UI.

The underlying engine capability this test protects - updating a
notification into/out of weekday-repeat mode must sync repeat_enabled and
clean up notification_days, or the startup repair migration flips it back -
is still genuinely reused (NotificationSystem.update_notification still
accepts repeat_minutes=-1 + selected_weekdays for other call sites), so that
coverage stays.
"""
import asyncio
import importlib
import sqlite3
from datetime import datetime
from types import SimpleNamespace

import pytz

nsys = importlib.import_module("cogs.notification_system")


def _mk_system_cog():
    conn = sqlite3.connect(":memory:")
    conn.execute("""CREATE TABLE vault_notifications (
        id INTEGER PRIMARY KEY, guild_id INTEGER, channel_id INTEGER,
        hour INTEGER, minute INTEGER, timezone TEXT, description TEXT,
        notification_type INTEGER, mention_type TEXT, repeat_enabled INTEGER,
        repeat_minutes INTEGER, is_enabled INTEGER DEFAULT 1,
        next_notification TEXT, event_type TEXT, instance_identifier TEXT)""")
    conn.execute("CREATE TABLE notification_days (notification_id INTEGER, weekday TEXT)")
    conn.commit()
    cog = nsys.NotificationSystem.__new__(nsys.NotificationSystem)
    cog.conn = conn
    cog.cursor = conn.cursor()
    cog.bot = SimpleNamespace(get_cog=lambda name: None)
    return cog


def _update(cog, repeat_minutes, selected_weekdays=None):
    return asyncio.run(cog.update_notification(
        notification_id=1, hour=20, minute=0, timezone="UTC", description="d",
        notification_type=1, mention_type="none", repeat_minutes=repeat_minutes,
        selected_weekdays=selected_weekdays, skip_board_update=True,
        start_date=datetime(2026, 7, 27, tzinfo=pytz.UTC),
    ))


def test_update_to_weekday_mode_enables_repeat():
    cog = _mk_system_cog()
    cog.conn.execute("INSERT INTO vault_notifications (id, repeat_enabled, repeat_minutes) VALUES (1, 0, 0)")
    cog.conn.commit()

    assert _update(cog, -1, [0, 2]) is True

    enabled, minutes = cog.conn.execute(
        "SELECT repeat_enabled, repeat_minutes FROM vault_notifications WHERE id = 1").fetchone()
    assert (enabled, minutes) == (1, -1), "weekday mode must enable repeat on update"
    days = cog.conn.execute("SELECT weekday FROM notification_days WHERE notification_id = 1").fetchall()
    assert days == [("0|2",)]


def test_update_away_from_weekday_mode_cleans_up():
    cog = _mk_system_cog()
    cog.conn.execute("INSERT INTO vault_notifications (id, repeat_enabled, repeat_minutes) VALUES (1, 1, -1)")
    cog.conn.execute("INSERT INTO notification_days VALUES (1, '0|2')")
    cog.conn.commit()

    assert _update(cog, 0) is True

    enabled, minutes = cog.conn.execute(
        "SELECT repeat_enabled, repeat_minutes FROM vault_notifications WHERE id = 1").fetchone()
    assert (enabled, minutes) == (0, 0), "no-repeat must disable repeat on update"
    days = cog.conn.execute("SELECT weekday FROM notification_days WHERE notification_id = 1").fetchall()
    assert days == [], "stale day rows would be flipped back by the startup migration"
