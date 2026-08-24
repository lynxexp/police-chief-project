"""Regression tests: a successful Vault Trap / Capitol War submission
posts an audit embed to the alliance's configured Activity Log channel
(the same channel/setting alliance_member_operations.py's member-roster
actions already use -- see /settings -> alliance -> Set Log Channel),
via the shared `_post_alliance_log` helper. Previously Vault Trap and
Capitol War activity was only ever written to log/bot.txt on disk --
never visible to admins in Discord at all.

Drives the real persist path end-to-end (same fixture pattern as
test_vault_persist_no_deadlock.py) rather than mocking internals, so this
proves the log call actually fires from a genuine commit, not just that
the helper function works in isolation."""
from __future__ import annotations

import asyncio
import sqlite3
from unittest.mock import AsyncMock, MagicMock

from harness import bt, ct


def _interaction():
    interaction = MagicMock()
    interaction.response.is_done = MagicMock(return_value=False)
    interaction.response.defer = AsyncMock()
    interaction.followup.send = AsyncMock()
    interaction.edit_original_response = AsyncMock()
    interaction.user.mention = "<@555>"
    interaction.user.id = 555
    return interaction


def test_vault_submission_posts_to_alliance_log(tmp_path, monkeypatch):
    vault_db = tmp_path / "vault_data.sqlite"
    alliance_db = tmp_path / "alliance.sqlite"
    monkeypatch.setattr(bt, "VAULT_DB_PATH", str(vault_db))
    bt.init_vault_database()

    vault_conn = sqlite3.connect(str(vault_db), timeout=30.0, check_same_thread=False)
    vault_conn.execute("PRAGMA journal_mode=WAL")
    vault_conn.commit()
    alliance_conn = sqlite3.connect(str(alliance_db), check_same_thread=False)
    alliance_conn.execute(
        "CREATE TABLE alliancesettings (alliance_id INTEGER PRIMARY KEY, vault_damage_range INTEGER)")
    alliance_conn.commit()

    logged = []

    async def fake_post_log(client, alliance_id, embed):
        logged.append((client, alliance_id, embed))

    monkeypatch.setattr(bt, "_post_alliance_log", fake_post_log)

    ds = bt.DataSubmit(alliance_conn, vault_conn)
    interaction = _interaction()
    rows = [
        {"fid": 1001, "name": "P1", "nickname": "Nick1", "damage": 5000, "rank": 1, "candidates": []},
        {"fid": None, "name": "P2", "nickname": None, "damage": 4000, "rank": 2, "candidates": []},
    ]

    asyncio.run(ds.process_full_submission(
        interaction,
        hunt_meta={"date": "2026-06-05", "trap_number": 2, "rallies": 40, "total_damage": 9000},
        player_rows=rows, alliance_id=7, alliance_name="Apex",
    ))

    assert len(logged) == 1, "exactly one log post per successful submission"
    client, alliance_id, embed = logged[0]
    assert alliance_id == 7
    assert "Apex" in embed.description
    assert "<@555>" in embed.description
    assert "555" in embed.description
    assert "2026-06-05" in embed.description
    assert "1 matched" in embed.description
    assert "1 unmatched" in embed.description
    assert "Vault Trap Submitted" in embed.title

    vault_conn.close()
    alliance_conn.close()


def test_capitol_submission_posts_to_alliance_log(tmp_path, monkeypatch):
    capitol_db = tmp_path / "capitol_war.sqlite"
    alliance_db = tmp_path / "alliance.sqlite"
    monkeypatch.setattr(ct, "CAPITOL_DB_PATH", str(capitol_db))
    ct.init_capitol_database()

    capitol_conn = sqlite3.connect(str(capitol_db), timeout=30.0, check_same_thread=False)
    capitol_conn.execute("PRAGMA journal_mode=WAL")
    capitol_conn.commit()
    alliance_conn = sqlite3.connect(str(alliance_db), check_same_thread=False)
    alliance_conn.execute("CREATE TABLE alliancesettings (alliance_id INTEGER PRIMARY KEY)")
    alliance_conn.commit()

    logged = []

    async def fake_post_log(client, alliance_id, embed):
        logged.append((client, alliance_id, embed))

    monkeypatch.setattr(ct, "_post_alliance_log", fake_post_log)

    ds = ct.CapitolDataSubmit(alliance_conn, capitol_conn)
    interaction = _interaction()
    rows = [
        {"fid": 2001, "name": "Q1", "nickname": "Nick1", "damage": 90000, "rank": 5, "candidates": []},
    ]

    asyncio.run(ds.process_full_submission(
        interaction,
        event_meta={"date": "2026-08-24", "event_time": None},
        player_rows=rows, alliance_id=9, alliance_name="Apex",
    ))

    assert len(logged) == 1
    client, alliance_id, embed = logged[0]
    assert alliance_id == 9
    assert "Apex" in embed.description
    assert "<@555>" in embed.description
    assert "2026-08-24" in embed.description
    assert "1 matched" in embed.description
    assert "Capitol War Submitted" in embed.title


def test_vault_persist_calls_the_log_helper():
    """Structural guard: _post_alliance_log must actually be wired into
    the persist path, not just exist unreferenced."""
    import inspect
    src = inspect.getsource(bt.DataSubmit._persist_hunt_and_render)
    assert "_post_alliance_log" in src


def test_capitol_persist_calls_the_log_helper():
    import inspect
    src = inspect.getsource(ct.CapitolDataSubmit.process_full_submission)
    assert "_post_alliance_log" in src
