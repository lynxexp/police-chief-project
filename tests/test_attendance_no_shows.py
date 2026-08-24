import sqlite3
import pytest
from cogs import attendance_no_shows as ns

# NO_SHOW_EVENT_TYPES is deliberately [] in production (see attendance_no_shows.py's
# module docstring): no Police Chief event has a confirmed registration+result OCR
# flow yet, so there's nothing to pre-fill the filter with. The ranking/incident
# machinery itself (compute_no_shows / player_no_show_incidents / set_excused) is
# still generic and fully reusable once such an event exists - these tests exercise
# it directly with an explicit event-type list, the same way a future admin-enabled
# event would, rather than through the (currently empty) module constant.
_TRACKED_EVENTS = ["pd_development", "arms_race"]


def _seed(path):
    with sqlite3.connect(path) as c:
        c.execute("CREATE TABLE attendance_sessions (session_id TEXT PRIMARY KEY, "
                  "event_type TEXT, event_date TEXT, alliance_id INTEGER, awaiting_result INTEGER)")
        c.execute("CREATE TABLE attendance_records (session_id TEXT, player_id, player_name TEXT, "
                  "status TEXT, alliance_id INTEGER, excused INTEGER DEFAULT 0, excused_reason TEXT, "
                  "UNIQUE(session_id, player_id))")

        def sess(sid, etype, date, closed=1):
            c.execute("INSERT INTO attendance_sessions VALUES (?,?,?,?,?)",
                      (sid, etype, date, 1, 0 if closed else 1))

        def rec(sid, fid, status, excused=0):
            c.execute("INSERT INTO attendance_records (session_id, player_id, player_name, status, "
                      "alliance_id, excused) VALUES (?,?,?,?,?,?)",
                      (sid, fid, f"P{fid}", status, 1, excused))

        # 4 closed sessions across two hypothetical reg+result event types -
        # stored with the INTERNAL event keys, exactly as attendance_sessions
        # does in production.
        sess("s1", "pd_development", "2026-07-01")
        sess("s2", "arms_race", "2026-07-05")
        sess("s3", "pd_development", "2026-07-08")
        sess("s4", "arms_race", "2026-07-10")
        sess("open", "pd_development", "2026-07-11", closed=0)   # excluded: awaiting result
        sess("other", "vault", "2026-07-09")                      # excluded: event type

        # fid 100: 1 attended, 3 no-shows (repeat offender)
        rec("s1", 100, "present"); rec("s2", 100, "absent"); rec("s3", 100, "absent"); rec("s4", 100, "absent")
        # fid 200: 3 attended, 1 no-show, 1 excused
        rec("s1", 200, "present"); rec("s2", 200, "present"); rec("s3", 200, "present"); rec("s4", 200, "absent", excused=1)
        # fid 201 is another session for 200 to reach a real no-show + threshold
        rec("open", 200, "absent")  # excluded (open session)
        # fid 300: only 2 tracked -> below min_events threshold
        rec("s1", 300, "absent"); rec("s2", 300, "present")
        # fid 400: absent in excluded sessions only -> not counted
        rec("open", 400, "absent"); rec("other", 400, "absent")
        c.commit()


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "attendance.sqlite"
    _seed(str(path))
    monkeypatch.setattr(ns, "_ATT_DB", str(path))
    return str(path)


def test_ranks_repeat_offender_first(db):
    rows = ns.compute_no_shows(1, _TRACKED_EVENTS, min_events=3)
    assert [r["fid"] for r in rows] == [100, 200]   # 300 filtered (2 tracked), 400 absent-only-in-excluded
    top = rows[0]
    assert top["fid"] == 100 and top["no_shows"] == 3 and top["attended"] == 1 and top["excused"] == 0
    assert round(top["rate"], 2) == 0.75


def test_excused_absence_is_not_a_no_show(db):
    rows = ns.compute_no_shows(1, _TRACKED_EVENTS, min_events=3)
    p200 = next(r for r in rows if r["fid"] == 200)
    assert p200["no_shows"] == 0 and p200["excused"] == 1 and p200["attended"] == 3
    assert p200["rate"] == 0.0   # excused excluded from numerator and denominator


def test_rank_line_isolates_rtl_names():
    """An Arabic name must not reorder the rank number and stats around it."""
    row = {"name": "ملك الظلام", "fid": 123, "no_shows": 2, "attended": 3,
           "excused": 0, "rate": 0.4}
    line = ns._format_rank_line(4, row)
    assert line.startswith("‎"), "line needs an LRM anchor to stay left-aligned"
    assert "⁨ملك الظلام⁩" in line, "RTL name must be bidi-isolated"
    assert line.index("**4.**") < line.index("ملك"), "rank stays before the name"


def test_rank_line_latin_names_unchanged():
    row = {"name": "Virlix", "fid": 1, "no_shows": 2, "attended": 1,
           "excused": 0, "rate": 0.66, "display_name": "Virlix"}
    line = ns._format_rank_line(1, row)
    assert line == "**1.** Virlix (`1`) - 2 no-shows | 1 attended | 0 excused (66%)"


def test_no_show_event_types_intentionally_empty():
    """No Police Chief event has a confirmed registration+result OCR flow yet
    (see the module docstring), so the filter is deliberately inert - an
    empty list, not a guessed one - until a real event qualifies. The filter
    cycle degrades to just "Both" (an empty tuple = no filter) accordingly."""
    assert ns.NO_SHOW_EVENT_TYPES == []
    assert ns._EVENT_LABELS == ["Both"]
    assert ns._EVENT_STATES == [()]


def test_compute_no_shows_returns_empty_for_no_event_types():
    """compute_no_shows short-circuits to [] when given no event types - the
    state NO_SHOW_EVENT_TYPES is in today - rather than querying with an
    empty IN (...) clause."""
    assert ns.compute_no_shows(1, ns.NO_SHOW_EVENT_TYPES, min_events=1) == []


def test_event_and_status_filters(db):
    rows = ns.compute_no_shows(1, ["pd_development"], min_events=1)
    p100 = next(r for r in rows if r["fid"] == 100)
    assert p100["attended"] == 1 and p100["no_shows"] == 1   # only s1 (present) + s3 (absent)


def test_date_window_excludes_older(db):
    rows = ns.compute_no_shows(1, _TRACKED_EVENTS, since_date="2026-07-06", min_events=1)
    p100 = next(r for r in rows if r["fid"] == 100)
    assert p100["no_shows"] == 2   # only s3, s4 within window


def test_incidents_list_and_excuse_roundtrip(db):
    inc = ns.player_no_show_incidents(1, 100, _TRACKED_EVENTS)
    assert [i["session_id"] for i in inc] == ["s4", "s3", "s2"]   # all absences, newest first
    assert all(i["excused"] is False for i in inc)

    ns.set_excused("s2", 100, True, "told us in advance")
    inc2 = {i["session_id"]: i for i in ns.player_no_show_incidents(1, 100, _TRACKED_EVENTS)}
    assert inc2["s2"]["excused"] is True and inc2["s2"]["reason"] == "told us in advance"

    # excusing removes it from the no-show count
    rows = {r["fid"]: r for r in ns.compute_no_shows(1, _TRACKED_EVENTS, min_events=3)}
    assert rows[100]["no_shows"] == 2 and rows[100]["excused"] == 1

    # clearing resets both columns
    ns.set_excused("s2", 100, False)
    assert ns.player_no_show_incidents(1, 100, _TRACKED_EVENTS)[2]["reason"] is None
