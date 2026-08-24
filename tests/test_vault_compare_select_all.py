"""VaultCompareView "Select All Active" / "Select All Total" (spec Part 6).

Below MAX_PLAYERS (8) candidates: select them all. Above it: rank by total
damage in the view's current date range and keep the top 8, setting `self.note`
to explain the truncation (mirrors the existing `_on_select` truncation-note
pattern). "Select All Total" additionally includes deactivated members that
"Select All Active" would never surface.

Drives the real VaultCompareView against real temp sqlite DBs (users +
vault), same duck-typed-cog style as test_vault_edit_view.py /
test_vault_auto_link.py — no Discord gateway needed.
"""
from __future__ import annotations

import asyncio
import sqlite3
from types import SimpleNamespace

from harness import bt


def _make_users_db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "users.sqlite"), check_same_thread=False)
    conn.execute("""
        CREATE TABLE users (
            fid INTEGER PRIMARY KEY,
            nickname TEXT,
            alliance TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            deactivated_at TEXT
        )
    """)
    conn.commit()
    return conn


def _insert_member(conn, *, fid, nickname, alliance="5", is_active=1):
    conn.execute(
        "INSERT INTO users (fid, nickname, alliance, is_active) VALUES (?, ?, ?, ?)",
        (fid, nickname, alliance, is_active),
    )
    conn.commit()


def _make_vault_db(tmp_path, monkeypatch):
    vault_db = tmp_path / "vault_data.sqlite"
    monkeypatch.setattr(bt, "VAULT_DB_PATH", str(vault_db))
    bt.init_vault_database()
    conn = sqlite3.connect(str(vault_db), timeout=30.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    return conn


def _insert_hunt(conn, *, alliance_id, date):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO vault_hunts (alliance_id, date, trap_number, rallies, total_damage) "
        "VALUES (?, ?, 1, 0, 0)",
        (alliance_id, date),
    )
    conn.commit()
    return cur.lastrowid


def _insert_damage(conn, *, hunt_id, fid, nickname, damage):
    conn.execute(
        "INSERT INTO vault_player_damage (hunt_id, fid, raw_name, resolved_nickname, damage, rank) "
        "VALUES (?, ?, ?, ?, ?, 1)",
        (hunt_id, fid, nickname, nickname, damage),
    )
    conn.commit()


class _Cog:
    def __init__(self, users_conn, vault_conn):
        self.users_conn = users_conn
        self.users_cursor = users_conn.cursor()
        self.vault_conn = vault_conn
        self.vault_cursor = vault_conn.cursor()

    def get_alliance_roster(self, alliance_id, active_only=True):
        return bt.VaultTrack.get_alliance_roster(self, alliance_id, active_only=active_only)


def _interaction(user_id=1):
    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    return SimpleNamespace(
        user=SimpleNamespace(id=user_id),
        response=SimpleNamespace(edit_message=edit_message, is_done=lambda: False),
    ), edits


def _make_view(tmp_path, monkeypatch, *, n_active=3, n_deactivated=0,
               damages=None, alliance_id=5):
    """n_active/n_deactivated members are created (fid = 1..N); `damages` is
    an optional {fid: total_damage} override (default 100 per fid, ascending
    by fid so ties don't matter for the tests below)."""
    users = _make_users_db(tmp_path)
    vault = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(vault, alliance_id=alliance_id, date="2026-08-01")

    damages = damages or {}
    fid = 1
    for _ in range(n_active):
        _insert_member(users, fid=fid, nickname=f"Active{fid}", alliance=str(alliance_id), is_active=1)
        dmg = damages.get(fid, fid * 100)
        _insert_damage(vault, hunt_id=hunt_id, fid=fid, nickname=f"Active{fid}", damage=dmg)
        fid += 1
    for _ in range(n_deactivated):
        _insert_member(users, fid=fid, nickname=f"Ex{fid}", alliance=str(alliance_id), is_active=0)
        dmg = damages.get(fid, fid * 100)
        _insert_damage(vault, hunt_id=hunt_id, fid=fid, nickname=f"Ex{fid}", damage=dmg)
        fid += 1

    cog = _Cog(users, vault)
    view = bt.VaultCompareView(
        cog=cog, original_user_id=1, alliance_id=alliance_id, alliance_name="TestAlli",
        from_date=None, to_date=None,
    )
    return view


def test_select_all_active_under_cap_selects_everyone(tmp_path, monkeypatch):
    view = _make_view(tmp_path, monkeypatch, n_active=3, n_deactivated=2)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_active(inter))

    assert sorted(view.selected_fids) == [1, 2, 3]
    assert view.note == ""


def test_select_all_active_excludes_deactivated(tmp_path, monkeypatch):
    view = _make_view(tmp_path, monkeypatch, n_active=2, n_deactivated=3)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_active(inter))

    assert sorted(view.selected_fids) == [1, 2]


def test_select_all_active_over_cap_keeps_top_8_by_damage(tmp_path, monkeypatch):
    # 10 active members, fid N has damage = N * 100 (fid 10 highest).
    view = _make_view(tmp_path, monkeypatch, n_active=10, n_deactivated=0)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_active(inter))

    assert len(view.selected_fids) == view.MAX_PLAYERS == 8
    assert set(view.selected_fids) == {3, 4, 5, 6, 7, 8, 9, 10}, \
        "must keep the 8 highest-damage active members, dropping the 2 lowest"
    assert "top 8" in view.note and "10 active members" in view.note


def test_select_all_total_includes_deactivated_members(tmp_path, monkeypatch):
    view = _make_view(tmp_path, monkeypatch, n_active=3, n_deactivated=2)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_total(inter))

    assert sorted(view.selected_fids) == [1, 2, 3, 4, 5]
    # Names for the deactivated members (not on the active-only picker roster)
    # must still resolve correctly in the summary/footer.
    assert view._nick_by_fid[4] == "Ex4"
    assert view._nick_by_fid[5] == "Ex5"


def test_select_all_total_over_cap_ranks_across_active_and_deactivated(tmp_path, monkeypatch):
    """A deactivated member with the highest damage must still be picked by
    "Select All Total" even though "Select All Active" would never see them."""
    damages = {i: i * 100 for i in range(1, 9)}
    damages[9] = 100000  # deactivated fid 9 — highest damage by far
    view = _make_view(tmp_path, monkeypatch, n_active=8, n_deactivated=2, damages=damages)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_total(inter))

    # fid 9 (deactivated) has damage 100000; fid 10 (deactivated, unspecified)
    # defaults to 10*100=1000; fids 1-8 (active) have damage = fid*100. The two
    # lowest (fid 1: 100, fid 2: 200) must be dropped to make room.
    assert len(view.selected_fids) == view.MAX_PLAYERS == 8
    assert 9 in view.selected_fids, "top-damage deactivated member must be included"
    assert 1 not in view.selected_fids and 2 not in view.selected_fids, \
        "the two lowest-damage members must be dropped"
    assert "top 8" in view.note and "10 total members" in view.note


def test_select_all_active_then_total_updates_note_and_selection(tmp_path, monkeypatch):
    """Switching from Select All Active to Select All Total re-evaluates the
    selection and note from scratch rather than merging with the old pick."""
    view = _make_view(tmp_path, monkeypatch, n_active=3, n_deactivated=3)
    inter, _edits = _interaction()

    asyncio.run(view._on_select_all_active(inter))
    assert sorted(view.selected_fids) == [1, 2, 3]

    asyncio.run(view._on_select_all_total(inter))
    assert sorted(view.selected_fids) == [1, 2, 3, 4, 5, 6]
    assert view.note == ""


def test_select_all_wrong_user_is_rejected(tmp_path, monkeypatch):
    view = _make_view(tmp_path, monkeypatch, n_active=2)
    sent = []

    async def send_message(*a, **k):
        sent.append((a, k))
    inter = SimpleNamespace(
        user=SimpleNamespace(id=999),  # not original_user_id (1)
        response=SimpleNamespace(send_message=send_message),
    )

    asyncio.run(view._on_select_all_active(inter))

    assert view.selected_fids == []
    assert sent, "a denial message must be sent for a mismatched user"
