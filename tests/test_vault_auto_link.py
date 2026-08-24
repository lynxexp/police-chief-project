"""Regression coverage for `VaultTrack.auto_link_unmatched_by_name` (Part A of
the vault-track/registration auto-link feature): when a new roster member is
created, previously-unmatched (fid=NULL) Vault Trap damage rows whose
raw_name strongly and unambiguously matches the new member's nickname should
be linked to the new fid — but only when the match is confident (>=
MATCH_AUTO_CONFIRM) AND unambiguous against the rest of the current roster.

Uses a real temp SQLite DB (via `init_vault_database`, same as
test_vault_persist_no_deadlock.py) and a minimal duck-typed stand-in for the
VaultTrack cog instance, so the method's real matching/DB logic runs
end-to-end without needing a live discord.py Bot.
"""
from __future__ import annotations

import asyncio
import sqlite3

from harness import bt


class _FakeVaultCog:
    """Just enough of VaultTrack for auto_link_unmatched_by_name: a vault
    conn/cursor and get_alliance_roster(alliance_id) -> [(fid, nick), ...]."""

    def __init__(self, vault_conn, roster):
        self.vault_conn = vault_conn
        self.vault_cursor = vault_conn.cursor()
        self._roster = roster

    def get_alliance_roster(self, alliance_id):
        return list(self._roster)


def _make_vault_db(tmp_path, monkeypatch):
    vault_db = tmp_path / "vault_data.sqlite"
    monkeypatch.setattr(bt, "VAULT_DB_PATH", str(vault_db))
    bt.init_vault_database()
    conn = sqlite3.connect(str(vault_db), timeout=30.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.commit()
    return conn


def _insert_hunt(conn, *, alliance_id, date, trap_number=1):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO vault_hunts (alliance_id, date, trap_number, rallies, total_damage) "
        "VALUES (?, ?, ?, 0, 0)",
        (alliance_id, date, trap_number),
    )
    conn.commit()
    return cur.lastrowid


def _insert_unmatched_row(conn, *, hunt_id, raw_name, damage=1000, rank=1):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO vault_player_damage (hunt_id, fid, raw_name, resolved_nickname, damage, rank, match_score) "
        "VALUES (?, NULL, ?, NULL, ?, ?, NULL)",
        (hunt_id, raw_name, damage, rank),
    )
    conn.commit()
    return cur.lastrowid


def _run(coro):
    return asyncio.run(coro)


def test_links_unambiguous_strong_match(tmp_path, monkeypatch):
    conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(conn, alliance_id=1, date="2026-08-01")
    row_id = _insert_unmatched_row(conn, hunt_id=hunt_id, raw_name="Saeed")

    # Roster has one clearly-different existing member; "Saeed" is the brand
    # new fid=4 who just registered.
    cog = _FakeVaultCog(conn, roster=[(6, "MiiKeY")])

    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=4, nickname="Saeed"))
    assert linked == 1

    row = conn.execute(
        "SELECT fid, resolved_nickname, match_score FROM vault_player_damage WHERE id = ?",
        (row_id,),
    ).fetchone()
    assert row[0] == 4
    assert row[1] == "Saeed"
    assert row[2] >= bt.MATCH_AUTO_CONFIRM
    conn.close()


def test_links_every_row_sharing_raw_name_across_hunts(tmp_path, monkeypatch):
    """A raw_name that recurs across multiple hunts for the same alliance gets
    every one of those rows linked, not just the first."""
    conn = _make_vault_db(tmp_path, monkeypatch)
    hunt1 = _insert_hunt(conn, alliance_id=1, date="2026-08-01", trap_number=1)
    hunt2 = _insert_hunt(conn, alliance_id=1, date="2026-08-08", trap_number=1)
    r1 = _insert_unmatched_row(conn, hunt_id=hunt1, raw_name="bella igor")
    r2 = _insert_unmatched_row(conn, hunt_id=hunt2, raw_name="bella igor")

    cog = _FakeVaultCog(conn, roster=[])
    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=5, nickname="bella igor"))
    assert linked == 2

    for rid in (r1, r2):
        fid = conn.execute("SELECT fid FROM vault_player_damage WHERE id = ?", (rid,)).fetchone()[0]
        assert fid == 5
    conn.close()


def test_ambiguous_against_other_roster_member_is_skipped(tmp_path, monkeypatch):
    """If another current roster member also scores confidently (or within
    MATCH_AMBIGUOUS_DELTA of the new member) on the same raw_name, the row is
    left unmatched for manual resolution instead of being auto-linked."""
    conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(conn, alliance_id=1, date="2026-08-01")
    row_id = _insert_unmatched_row(conn, hunt_id=hunt_id, raw_name="Jon Smith")

    # An existing roster member with a near-identical name to the new "Jon
    # Smith" registrant — classic collision case the guard exists for.
    cog = _FakeVaultCog(conn, roster=[(9, "John Smith")])
    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=4, nickname="Jon Smith"))
    assert linked == 0

    row = conn.execute("SELECT fid FROM vault_player_damage WHERE id = ?", (row_id,)).fetchone()
    assert row[0] is None
    conn.close()


def test_weak_match_is_not_linked(tmp_path, monkeypatch):
    conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(conn, alliance_id=1, date="2026-08-01")
    row_id = _insert_unmatched_row(conn, hunt_id=hunt_id, raw_name="xkq9 randomtext")

    cog = _FakeVaultCog(conn, roster=[])
    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=4, nickname="Saeed"))
    assert linked == 0

    row = conn.execute("SELECT fid FROM vault_player_damage WHERE id = ?", (row_id,)).fetchone()
    assert row[0] is None
    conn.close()


def test_scoped_to_alliance_does_not_touch_other_alliances(tmp_path, monkeypatch):
    conn = _make_vault_db(tmp_path, monkeypatch)
    other_hunt = _insert_hunt(conn, alliance_id=2, date="2026-08-01")
    other_row = _insert_unmatched_row(conn, hunt_id=other_hunt, raw_name="Saeed")

    cog = _FakeVaultCog(conn, roster=[])
    # Linking for alliance 1's new member "Saeed" must not touch alliance 2's
    # unmatched row of the same raw_name.
    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=4, nickname="Saeed"))
    assert linked == 0

    row = conn.execute("SELECT fid FROM vault_player_damage WHERE id = ?", (other_row,)).fetchone()
    assert row[0] is None
    conn.close()


def test_no_unmatched_rows_returns_zero(tmp_path, monkeypatch):
    conn = _make_vault_db(tmp_path, monkeypatch)
    cog = _FakeVaultCog(conn, roster=[])
    linked = _run(bt.VaultTrack.auto_link_unmatched_by_name(cog, alliance_id=1, fid=4, nickname="Saeed"))
    assert linked == 0
    conn.close()
