"""Tests for Capitol War's channel-listener ingestion path (CapitolSession)
and the find_conflicting_channel_owner extension it depends on.

Vault Trap's real primary ingestion path is a channel listener: admins
configure a channel, members post screenshots into it over time, and the bot
auto-detects, batches, and merges them before handing off to a review screen
(see cogs/vault_track.py's VaultSession). This suite covers the Capitol War
port of that system (cogs/capitol_war.py's CapitolSession) at the two levels
that matter and don't require a live Discord connection:

  1. The flat cross-screenshot merge (rows_by_points, resolved via the same
     _better_row tiebreaker /capitol_add already uses for its own multi-
     attachment merge) -- exercised against tag-filtered rows from
     parse_capitol_rows, the same way a real session would see them.
  2. Session lifecycle correctness (snapshot survives a failed finalize,
     is deleted only on success, engine/timer methods are genuinely the
     shared VaultSession implementations and not re-derived copies) --
     mirrors tests/test_ocr_snapshot_lifecycle.py's approach for VaultSession.

And the shared channel-conflict guard (cogs/attendance_ocr_setup.py's
find_conflicting_channel_owner), extended to know about
alliancesettings.capitol_score_channel so Vault Trap and Capitol War can
never silently double-book the same Discord channel.
"""
from __future__ import annotations

import asyncio
import sqlite3
from types import SimpleNamespace

import pytest

from harness import bt, ct


# ---------------------------------------------------------------------------
# Flat multi-screenshot merge
# ---------------------------------------------------------------------------

# Same reference-doc-derived Honor Roll text test_capitol_tag_filter.py uses,
# trimmed to a handful of APX rows -- "screenshot 1" of a two-screenshot
# session upload.
SCREENSHOT_1_TEXT = (
    "Honor Roll Rankings tab Ranking Rewards tab Rank Chief Points "
    "1 [APX]Lynx 12,780,331 "
    "2 [APX]LTC 11,792,466 "
    "3 [APX]Tony Montana 11,119,046 "
    "42 [L4W]Chief Nicol 3,518,601 "
)

# "screenshot 2": rank 2's name comes back OCR-garbled here ("LTC" -> "LT0"),
# but a brand new row (rank 4) is present that screenshot 1 never captured.
# A real session posts both under the same (channel, user) and must end up
# with the *better* name for rank 2 (screenshot 1's clean "LTC") while still
# picking up screenshot 2's new row -- this is exactly what CapitolSession.
# add_message's `_better_row`-guarded merge into rows_by_points does, one
# image at a time; this test drives that same merge step directly, without
# needing a live Discord attachment/message.
SCREENSHOT_2_TEXT = (
    "Honor Roll Rankings tab Ranking Rewards tab Rank Chief Points "
    "2 [APX]LT0 11,792,466 "
    "4 [APX]Jesslyn 8,833,752 "
)

ROSTER = [(101, "Lynx"), (102, "LTC"), (103, "Tony Montana"), (104, "Jesslyn")]


def _merge_screenshot(rows_by_points: dict, text: str, tag: str, roster: list) -> None:
    """The exact one-liner both /capitol_add and CapitolSession.add_message
    use to fold one screenshot's tag-filtered rows into a running merge."""
    parsed_rows, _candidates = ct.parse_capitol_rows(text, tag)
    for row in parsed_rows:
        key = row["damage"]
        existing = rows_by_points.get(key)
        if existing is None or ct._better_row(existing, row, roster=roster):
            rows_by_points[key] = row


def test_flat_merge_keeps_better_name_and_adds_new_rows():
    rows_by_points: dict = {}
    _merge_screenshot(rows_by_points, SCREENSHOT_1_TEXT, "APX", ROSTER)
    _merge_screenshot(rows_by_points, SCREENSHOT_2_TEXT, "APX", ROSTER)

    # 4 distinct points-keys survive across both screenshots (rank 2 merged,
    # not duplicated; L4W's row 42 was tag-filtered out of screenshot 1).
    assert set(rows_by_points.keys()) == {12_780_331, 11_792_466, 11_119_046, 8_833_752}

    # Rank 2's name is screenshot 1's clean "LTC", not screenshot 2's garbled
    # "LT0" -- _better_row picked the higher-roster-scoring name.
    assert rows_by_points[11_792_466]["name"].strip() == "LTC"

    # Screenshot 2's new row (rank 4, Jesslyn) made it into the merge.
    assert rows_by_points[8_833_752]["name"].strip() == "Jesslyn"

    # No L4W row leaked through despite being present in screenshot 1's raw text.
    assert 3_518_601 not in rows_by_points


def test_flat_merge_is_order_independent_for_the_better_name():
    """Uploading the garbled screenshot first must not "win" just because it
    arrived first -- _better_row must still prefer the higher-scoring name
    regardless of merge order, same guarantee EventGroup.merge gives Vault
    Trap."""
    rows_by_points: dict = {}
    _merge_screenshot(rows_by_points, SCREENSHOT_2_TEXT, "APX", ROSTER)
    _merge_screenshot(rows_by_points, SCREENSHOT_1_TEXT, "APX", ROSTER)
    assert rows_by_points[11_792_466]["name"].strip() == "LTC"


def test_capitol_session_add_message_merge_matches_the_module_helper():
    """Structural guard: CapitolSession.add_message must be using the same
    `_better_row`-guarded rows_by_points pattern this test drives directly,
    not a re-derived lookalike -- checked by asserting the merge tiebreaker
    it's built on is vault_track's actual function."""
    assert ct._better_row is bt._better_row


# ---------------------------------------------------------------------------
# CapitolSession lifecycle (bare __new__ instances, no Discord/asyncio loop
# beyond what's needed) -- mirrors tests/test_ocr_snapshot_lifecycle.py's
# `_vault_session` helper for VaultSession.
# ---------------------------------------------------------------------------

def _capitol_session(finalize_fails=False):
    s = ct.CapitolSession.__new__(ct.CapitolSession)
    s.finalized = False
    s.lock = asyncio.Lock()
    s.channel_id = 1
    s.user_id = 2
    s.timer_task = None
    calls = SimpleNamespace(deleted=0)

    async def _finalize_capitol_session(session, timed_out=False):
        if finalize_fails:
            raise RuntimeError("finalize blew up")

    async def _release_all_engines():
        pass

    s.cog = SimpleNamespace(_finalize_capitol_session=_finalize_capitol_session)
    s._release_all_engines = _release_all_engines
    s.delete_snapshot = lambda: setattr(calls, "deleted", calls.deleted + 1)
    return s, calls


def test_capitol_failed_finalize_keeps_snapshot():
    s, calls = _capitol_session(finalize_fails=True)
    with pytest.raises(RuntimeError):
        asyncio.run(s.finalize())
    assert calls.deleted == 0, "snapshot must survive a failed finalize for crash-resume"


def test_capitol_successful_finalize_deletes_snapshot():
    s, calls = _capitol_session()
    asyncio.run(s.finalize())
    assert calls.deleted == 1


def test_capitol_save_snapshot_noop_after_finalize(monkeypatch):
    s, _ = _capitol_session()
    s.finalized = True
    saved = []
    ocr_resume = __import__("cogs.ocr_resume", fromlist=["ocr_resume"])
    monkeypatch.setattr(ocr_resume, "save", lambda *a, **k: saved.append(a))
    s._snapshot_key = lambda: "capitol:1:2"
    s.save_snapshot()
    assert saved == [], "a finalized session must not re-create its snapshot"


def test_capitol_finalize_pops_active_session():
    key = (1, 2)
    s, _ = _capitol_session()
    ct._active_capitol_sessions[key] = s
    asyncio.run(s.finalize())
    assert key not in ct._active_capitol_sessions


def test_capitol_session_reuses_vault_session_engine_and_timer_methods():
    """CapitolSession must reuse VaultSession's _ensure_engine/
    _release_all_engines/restart_timer/_timer_run/stop_timer directly (class-
    level assignments), not re-derived copies -- see the import block's note
    in cogs/capitol_war.py on why those (and not finalize/cancel, which close
    over vault_track's own _active_sessions dict) are safe to share."""
    assert ct.CapitolSession._ensure_engine is bt.VaultSession._ensure_engine
    assert ct.CapitolSession._release_all_engines is bt.VaultSession._release_all_engines
    assert ct.CapitolSession.restart_timer is bt.VaultSession.restart_timer
    assert ct.CapitolSession._timer_run is bt.VaultSession._timer_run
    assert ct.CapitolSession.stop_timer is bt.VaultSession.stop_timer
    # finalize/cancel must NOT be shared -- they touch module-level
    # `_active_sessions` dicts that differ between the two cogs.
    assert ct.CapitolSession.finalize is not bt.VaultSession.finalize
    assert ct.CapitolSession.cancel is not bt.VaultSession.cancel


def test_capitol_session_button_template_does_not_collide_with_vault():
    """Distinct custom_id prefixes ('capitolsess:' vs 'vaultsess:') so the two
    DynamicItem registrations parse only their own buttons after a restart."""
    capitol_id = f"capitolsess:done:{111}:{222}"
    vault_id = f"vaultsess:done:{111}:{222}"
    assert ct.CapitolSessionButton.__discord_ui_compiled_template__.match(capitol_id)
    assert ct.CapitolSessionButton.__discord_ui_compiled_template__.match(vault_id) is None
    assert bt.VaultSessionButton.__discord_ui_compiled_template__.match(vault_id)
    assert bt.VaultSessionButton.__discord_ui_compiled_template__.match(capitol_id) is None


# ---------------------------------------------------------------------------
# find_conflicting_channel_owner -- extended to know about
# alliancesettings.capitol_score_channel (cogs/attendance_ocr_setup.py).
# Both directions must be refused: an alliance can't claim a channel Vault
# Trap Tracking already owns, and vice versa.
# ---------------------------------------------------------------------------

def _make_conflict_dbs(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)

    alliance = sqlite3.connect("db/alliance.sqlite")
    alliance.execute(
        "CREATE TABLE alliance_list (alliance_id INTEGER, name TEXT)"
    )
    alliance.execute(
        "CREATE TABLE alliancesettings (alliance_id INTEGER PRIMARY KEY, "
        "vault_score_channel INTEGER, capitol_score_channel INTEGER)"
    )
    alliance.executemany(
        "INSERT INTO alliance_list (alliance_id, name) VALUES (?, ?)",
        [(1, "VaultAlliance"), (2, "CapitolAlliance"), (3, "ThirdAlliance")],
    )
    alliance.commit()
    alliance.close()

    settings = sqlite3.connect("db/settings.sqlite")
    settings.execute(
        "CREATE TABLE ocr_channel_settings (channel_id INTEGER PRIMARY KEY, alliance_id INTEGER)"
    )
    settings.commit()
    settings.close()


def _set_vault_channel(alliance_id: int, channel_id: int) -> None:
    with sqlite3.connect("db/alliance.sqlite") as conn:
        conn.execute(
            "INSERT INTO alliancesettings (alliance_id, vault_score_channel) VALUES (?, ?) "
            "ON CONFLICT(alliance_id) DO UPDATE SET vault_score_channel = excluded.vault_score_channel",
            (alliance_id, channel_id),
        )
        conn.commit()


def _set_capitol_channel(alliance_id: int, channel_id: int) -> None:
    with sqlite3.connect("db/alliance.sqlite") as conn:
        conn.execute(
            "INSERT INTO alliancesettings (alliance_id, capitol_score_channel) VALUES (?, ?) "
            "ON CONFLICT(alliance_id) DO UPDATE SET capitol_score_channel = excluded.capitol_score_channel",
            (alliance_id, channel_id),
        )
        conn.commit()


def test_capitol_cannot_claim_a_vault_trap_channel(tmp_path, monkeypatch):
    """Alliance 1 already uses channel 555 for Vault Trap Tracking; alliance
    2 trying to claim the same channel for Capitol War must be refused with
    a conflict naming Vault Trap Tracking."""
    _make_conflict_dbs(tmp_path, monkeypatch)
    _set_vault_channel(1, 555)

    from cogs.attendance_ocr_setup import find_conflicting_channel_owner
    conflict = find_conflicting_channel_owner(555, requesting_alliance_id=2)
    assert conflict is not None
    feature, alliance_id, alliance_name = conflict
    assert feature == "Vault Trap Tracking"
    assert alliance_id == 1
    assert alliance_name == "VaultAlliance"


def test_vault_cannot_claim_a_capitol_war_channel(tmp_path, monkeypatch):
    """Alliance 2 already uses channel 777 for Capitol War Tracking; alliance
    1 trying to claim the same channel for Vault Trap must be refused with a
    conflict naming Capitol War Tracking."""
    _make_conflict_dbs(tmp_path, monkeypatch)
    _set_capitol_channel(2, 777)

    from cogs.attendance_ocr_setup import find_conflicting_channel_owner
    conflict = find_conflicting_channel_owner(777, requesting_alliance_id=1)
    assert conflict is not None
    feature, alliance_id, alliance_name = conflict
    assert feature == "Capitol War Tracking"
    assert alliance_id == 2
    assert alliance_name == "CapitolAlliance"


def test_same_alliance_repicking_its_own_channel_is_not_a_conflict(tmp_path, monkeypatch):
    _make_conflict_dbs(tmp_path, monkeypatch)
    _set_vault_channel(1, 555)
    _set_capitol_channel(1, 777)

    from cogs.attendance_ocr_setup import find_conflicting_channel_owner
    assert find_conflicting_channel_owner(555, requesting_alliance_id=1) is None
    assert find_conflicting_channel_owner(777, requesting_alliance_id=1) is None


def test_free_channel_has_no_conflict(tmp_path, monkeypatch):
    _make_conflict_dbs(tmp_path, monkeypatch)
    _set_vault_channel(1, 555)
    _set_capitol_channel(2, 777)

    from cogs.attendance_ocr_setup import find_conflicting_channel_owner
    assert find_conflicting_channel_owner(999, requesting_alliance_id=3) is None


def test_conflict_checker_survives_missing_capitol_column(tmp_path, monkeypatch):
    """A boot order where capitol_war.py's migration hasn't run yet (column
    doesn't exist) must not crash the Vault Trap / Screenshot Upload checks
    -- see find_conflicting_channel_owner's own docstring."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)
    alliance = sqlite3.connect("db/alliance.sqlite")
    alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, name TEXT)")
    # No capitol_score_channel column at all -- pre-migration shape.
    alliance.execute(
        "CREATE TABLE alliancesettings (alliance_id INTEGER PRIMARY KEY, vault_score_channel INTEGER)"
    )
    alliance.execute("INSERT INTO alliance_list VALUES (1, 'VaultAlliance')")
    alliance.execute("INSERT INTO alliancesettings (alliance_id, vault_score_channel) VALUES (1, 555)")
    alliance.commit()
    alliance.close()
    settings = sqlite3.connect("db/settings.sqlite")
    settings.execute("CREATE TABLE ocr_channel_settings (channel_id INTEGER PRIMARY KEY, alliance_id INTEGER)")
    settings.commit()
    settings.close()

    from cogs.attendance_ocr_setup import find_conflicting_channel_owner
    conflict = find_conflicting_channel_owner(555, requesting_alliance_id=2)
    assert conflict is not None and conflict[0] == "Vault Trap Tracking"
    assert find_conflicting_channel_owner(1234, requesting_alliance_id=2) is None
