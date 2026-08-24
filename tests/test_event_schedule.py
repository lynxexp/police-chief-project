"""Event date / cycle / schedule math.

Police Chief has no pre-filled event calendar - admins configure their own
custom events (name, first_occurrence, recurrence_type, recurrence_interval),
and a single generic `calculate_next_occurrence(first_occurrence,
recurrence_type, recurrence_interval, from_date)` in notification_schedule.py
computes the next occurrence for any of them. These tests exercise that
generic function directly, plus the schedule-adjacent helpers (time-slot
validation, minister slots, timezone parsing) that are event-agnostic and
reused as-is.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

import pytest
import pytz

from cogs.notification_event_types import (
    RECURRENCE_TYPES,
    round_to_5min_slot,
    validate_time_slot,
)
from cogs.notification_schedule import calculate_next_occurrence, NotificationSchedule
from cogs.minister_schedule import MinisterSchedule

# Fixed reference instant (a Thursday).
FROM = datetime(2026, 1, 15, 10, 30, tzinfo=pytz.UTC)
HHMM = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


# --- calculate_next_occurrence (generic admin-configured recurrence) --------------

def test_recurrence_types_are_daily_weekly_monthly():
    assert set(RECURRENCE_TYPES) == {"daily", "weekly", "monthly"}


def test_unknown_recurrence_type_returns_none():
    assert calculate_next_occurrence(FROM - timedelta(days=1), "yearly", 1, FROM) is None


def test_first_occurrence_in_future_is_returned_unchanged():
    first = FROM + timedelta(days=5)
    assert calculate_next_occurrence(first, "daily", 1, FROM) == first


def test_daily_recurrence_steps_by_interval():
    first = FROM - timedelta(days=10)
    nxt = calculate_next_occurrence(first, "daily", 3, FROM)
    assert nxt is not None and nxt >= FROM
    assert (nxt - first).days % 3 == 0


def test_daily_recurrence_same_day_not_skipped():
    first = FROM - timedelta(days=6)
    nxt = calculate_next_occurrence(first, "daily", 3, FROM)
    assert nxt == FROM  # exactly on-cycle at the asked instant


def test_weekly_recurrence_lands_on_same_weekday_as_first():
    first = datetime(2026, 1, 2, 10, 30, tzinfo=pytz.UTC)  # a Friday
    nxt = calculate_next_occurrence(first, "weekly", 2, FROM)
    assert nxt is not None and nxt >= FROM
    assert nxt.weekday() == first.weekday()
    assert (nxt - first).days % 14 == 0


def test_monthly_recurrence_clamps_short_months():
    first = datetime(2026, 1, 31, 9, 0, tzinfo=pytz.UTC)
    nxt = calculate_next_occurrence(first, "monthly", 1, datetime(2026, 2, 1, tzinfo=pytz.UTC))
    assert nxt.month == 2
    assert nxt.day == 28  # Feb has no 31st - clamped to month length


def test_monthly_recurrence_steps_by_interval():
    first = datetime(2026, 1, 15, tzinfo=pytz.UTC)
    nxt = calculate_next_occurrence(first, "monthly", 3, datetime(2026, 5, 1, tzinfo=pytz.UTC))
    # Jan 15 + 3mo = Apr 15 (already past May 1) -> steps another 3mo to May 15
    assert nxt == datetime(2026, 5, 15, tzinfo=pytz.UTC)


def test_recurrence_interval_defaults_to_one_when_falsy():
    first = FROM - timedelta(days=5)
    assert calculate_next_occurrence(first, "daily", 0, FROM) == \
        calculate_next_occurrence(first, "daily", 1, FROM)


# --- validate_time_slot ---

@pytest.mark.parametrize("value, ok", [
    ("14:05", True), ("00:00", True), ("23:55", True),
    ("14:03", False),    # not a 5-min increment
    ("24:00", False),    # hour out of range
    ("12:60", False),    # minute out of range
    ("abc", False), ("", False), ("14", False), ("14:5", True),  # "14:5" -> 5 min, %5==0
])
def test_validate_time_slot_5min(value, ok):
    assert validate_time_slot(value, "5min") is ok


def test_validate_time_slot_any_allows_non_5min():
    assert validate_time_slot("14:03", "any") is True
    assert validate_time_slot("24:00", "any") is False  # range still enforced


# --- round_to_5min_slot ---

@pytest.mark.parametrize("minute, expected", [(0, 0), (4, 0), (5, 5), (7, 5), (12, 10), (59, 55)])
def test_round_to_5min_slot(minute, expected):
    out = round_to_5min_slot(datetime(2026, 1, 1, 10, minute, 33, 123))
    assert out.minute == expected and out.second == 0 and out.microsecond == 0


# --- minister time slots ---

def test_minister_slots_mode0_is_48_half_hours():
    slots = MinisterSchedule.get_time_slots(None, 0)
    assert len(slots) == 48
    assert slots[0] == "00:00" and slots[-1] == "23:30"
    assert all(HHMM.match(s) for s in slots)
    assert all(int(s[3:]) in (0, 30) for s in slots)
    assert len(set(slots)) == len(slots)  # unique


def test_minister_slots_mode1_offset():
    slots = MinisterSchedule.get_time_slots(None, 1)
    assert len(slots) == 49
    assert slots[0] == "00:00" and "23:45" in slots
    assert all(HHMM.match(s) for s in slots)
    assert len(set(slots)) == len(slots)


# --- timezone parsing ---

@pytest.mark.parametrize("tz, minutes", [
    ("UTC", 0),
    ("UTC+05:30", 330),
    ("UTC-02:00", -120),
])
def test_timezone_object_offsets(tz, minutes):
    obj = NotificationSchedule._get_timezone_object(None, tz)
    off = obj.utcoffset(datetime(2026, 1, 1))
    assert off.total_seconds() / 60 == minutes


def test_timezone_object_etc_gmt_is_inverted():
    # Etc/GMT-3 is actually UTC+3.
    obj = NotificationSchedule._get_timezone_object(None, "Etc/GMT-3")
    assert obj.utcoffset(datetime(2026, 1, 1)).total_seconds() / 3600 == 3


@pytest.mark.parametrize("zone, shown", [
    ("UTC", "UTC"),
    ("Etc/GMT-3", "UTC+3"),
    ("Etc/GMT+5", "UTC-5"),
    ("UTC+05:30", "UTC+5:30"),
])
def test_timezone_display(zone, shown):
    assert NotificationSchedule._format_timezone_display(None, zone) == shown
