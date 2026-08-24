"""Active-only filtering for OCR matching and the alliance leaderboard
(decisions #2 and #3): deactivated members should be excluded from the Vault
Trap OCR fuzzy-match roster and the default leaderboard, while still being
reachable elsewhere (get_alliance_roster(active_only=False), player history).

Uses a real temp sqlite `users` table (mirroring main.py's schema) plus the
real vault DB via `bt.init_vault_database()`, same style as
test_vault_auto_link.py / test_vault_edit_view.py.
"""
from __future__ import annotations

import sqlite3

from harness import bt


def _make_users_db(tmp_path):
    users_db = tmp_path / "users.sqlite"
    conn = sqlite3.connect(str(users_db), check_same_thread=False)
    conn.execute("""
        CREATE TABLE users (
            fid INTEGER PRIMARY KEY,
            nickname TEXT,
            chief_office_lv INTEGER,
            kid INTEGER,
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


class _Cog:
    """Duck-typed VaultTrack stand-in: real users_cursor/vault_cursor, but
    binds the actual production methods so their real SQL runs."""

    def __init__(self, users_conn, vault_conn):
        self.users_conn = users_conn
        self.users_cursor = users_conn.cursor()
        self.vault_conn = vault_conn
        self.vault_cursor = vault_conn.cursor()

    def get_alliance_roster(self, alliance_id, active_only=True):
        return bt.VaultTrack.get_alliance_roster(self, alliance_id, active_only=active_only)

    def _fetch_current_members(self, alliance_id):
        return bt.VaultTrack._fetch_current_members(self, alliance_id)

    def get_match_roster(self, alliance_id, **kw):
        return bt.VaultTrack.get_match_roster(self, alliance_id, **kw)


def _insert_hunt(conn, *, alliance_id, date, trap_number=1):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO vault_hunts (alliance_id, date, trap_number, rallies, total_damage) "
        "VALUES (?, ?, ?, 0, 0)",
        (alliance_id, date, trap_number),
    )
    conn.commit()
    return cur.lastrowid


def _insert_matched_row(conn, *, hunt_id, fid, nickname, damage, rank=1):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO vault_player_damage (hunt_id, fid, raw_name, resolved_nickname, damage, rank) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (hunt_id, fid, nickname, nickname, damage, rank),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# get_alliance_roster(active_only=...)
# ---------------------------------------------------------------------------

def test_get_alliance_roster_defaults_active_only(tmp_path, monkeypatch):
    users = _make_users_db(tmp_path)
    _insert_member(users, fid=1, nickname="Active1", is_active=1)
    _insert_member(users, fid=2, nickname="Deactivated1", is_active=0)
    cog = _Cog(users, _make_vault_db(tmp_path, monkeypatch))

    roster = cog.get_alliance_roster("5")
    assert roster == [(1, "Active1")]


def test_get_alliance_roster_active_only_false_includes_everyone(tmp_path, monkeypatch):
    users = _make_users_db(tmp_path)
    _insert_member(users, fid=1, nickname="Active1", is_active=1)
    _insert_member(users, fid=2, nickname="Deactivated1", is_active=0)
    cog = _Cog(users, _make_vault_db(tmp_path, monkeypatch))

    roster = sorted(cog.get_alliance_roster("5", active_only=False))
    assert roster == [(1, "Active1"), (2, "Deactivated1")]


# ---------------------------------------------------------------------------
# OCR fuzzy-match roster (get_match_roster / _fetch_current_members)
# ---------------------------------------------------------------------------

def test_ocr_match_roster_excludes_deactivated_members(tmp_path, monkeypatch):
    users = _make_users_db(tmp_path)
    _insert_member(users, fid=1, nickname="Saeed", is_active=1)
    _insert_member(users, fid=2, nickname="Benched", is_active=0)
    cog = _Cog(users, _make_vault_db(tmp_path, monkeypatch))

    roster = cog.get_match_roster("5")
    fids_in_roster = {e[0] for e in roster}
    assert 1 in fids_in_roster
    assert 2 not in fids_in_roster, "a deactivated member must not be matchable by OCR"


# ---------------------------------------------------------------------------
# Leaderboard (_aggregate_leaderboard active_fids filter)
# ---------------------------------------------------------------------------

def test_aggregate_leaderboard_excludes_inactive_fids(tmp_path, monkeypatch):
    vault_conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(vault_conn, alliance_id=5, date="2026-08-01")
    _insert_matched_row(vault_conn, hunt_id=hunt_id, fid=1, nickname="Active1", damage=1000)
    _insert_matched_row(vault_conn, hunt_id=hunt_id, fid=2, nickname="Benched", damage=5000)

    # No filter: both appear.
    all_entries = bt._aggregate_leaderboard(
        vault_conn.cursor(), alliance_id=5, trap_number='both',
        from_date=None, to_date=None)
    assert {e['fid'] for e in all_entries} == {1, 2}

    # Active-only filter (as the real leaderboard view now applies): fid 2 drops out
    # even though it out-damaged fid 1 — deactivated members' history is preserved
    # but excluded from the default aggregate view (decision #3).
    active_entries = bt._aggregate_leaderboard(
        vault_conn.cursor(), alliance_id=5, trap_number='both',
        from_date=None, to_date=None, active_fids={1})
    assert {e['fid'] for e in active_entries} == {1}


def test_aggregate_leaderboard_empty_active_fids_returns_nothing(tmp_path, monkeypatch):
    vault_conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(vault_conn, alliance_id=5, date="2026-08-01")
    _insert_matched_row(vault_conn, hunt_id=hunt_id, fid=1, nickname="Active1", damage=1000)

    entries = bt._aggregate_leaderboard(
        vault_conn.cursor(), alliance_id=5, trap_number='both',
        from_date=None, to_date=None, active_fids=set())
    assert entries == []


def test_leaderboard_view_wires_active_only_roster(tmp_path, monkeypatch):
    """End-to-end through VaultLeaderboardView.__init__: a deactivated member's
    damage is excluded from the default leaderboard even though they have the
    highest total, while the active member is shown."""
    users = _make_users_db(tmp_path)
    _insert_member(users, fid=1, nickname="Active1", is_active=1)
    _insert_member(users, fid=2, nickname="Benched", is_active=0)
    vault_conn = _make_vault_db(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(vault_conn, alliance_id=5, date="2026-08-01")
    _insert_matched_row(vault_conn, hunt_id=hunt_id, fid=1, nickname="Active1", damage=1000)
    _insert_matched_row(vault_conn, hunt_id=hunt_id, fid=2, nickname="Benched", damage=99999)
    cog = _Cog(users, vault_conn)

    view = bt.VaultLeaderboardView(
        cog=cog, original_user_id=1, alliance_id=5, alliance_name="TestAlli",
        trap_number='both', from_date=None, to_date=None,
    )
    fids = {e['fid'] for e in view.entries}
    assert fids == {1}
    assert 2 not in fids, "deactivated member must not appear on the default leaderboard"
