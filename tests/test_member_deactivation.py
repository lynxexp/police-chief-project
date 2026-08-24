"""Soft-delete ("Deactivate") member coverage.

"Remove Members" now flips `users.is_active` + `deactivated_at` instead of
DELETE-ing the row, so a deactivated member's history (vault trap damage,
attendance records, name/level history — anything keyed by fid in other
tables) survives untouched, and the flag can be cleared again later via
`reactivate_member`.

Uses a real temp sqlite `users` table (mirroring main.py's schema) via
`monkeypatch.chdir`, since `reactivate_member` and the removal code paths
hardcode the relative path `db/users.sqlite` — same technique as
test_main_bootstrap.py's chdir-based fixtures.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

import cogs.alliance_member_edit as ame


def _make_users_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)
    conn = sqlite3.connect("db/users.sqlite")
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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def test_deactivate_preserves_row_and_history(tmp_path, monkeypatch):
    """The UPDATE used by both real removal code paths (bulk Remove Selected
    and single-FID ID-search remove) must not delete the row — nickname,
    level, state and any fid-keyed history elsewhere must survive."""
    conn = _make_users_db(tmp_path, monkeypatch)
    conn.execute(
        "INSERT INTO users (fid, nickname, chief_office_lv, kid, alliance) "
        "VALUES (?, ?, ?, ?, ?)",
        (111, "OldGuard", 12, 911, "5"),
    )
    conn.commit()

    # Same UPDATE shape as _RemoveSelectedConfirmView.confirm() / the
    # IDSearchModal remove-context confirm_callback.
    ts = _now_iso()
    conn.execute(
        "UPDATE users SET is_active = 0, deactivated_at = ? WHERE fid IN (?)",
        (ts, 111),
    )
    conn.commit()

    row = conn.execute(
        "SELECT fid, nickname, chief_office_lv, kid, alliance, is_active, deactivated_at "
        "FROM users WHERE fid = ?", (111,),
    ).fetchone()
    assert row is not None, "deactivation must not delete the row"
    assert row[1:5] == ("OldGuard", 12, 911, "5"), "history/metadata fields must be untouched"
    assert row[5] == 0
    assert row[6] == ts

    assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1
    conn.close()


def test_reactivate_member_clears_flag_and_timestamp(tmp_path, monkeypatch):
    conn = _make_users_db(tmp_path, monkeypatch)
    conn.execute(
        "INSERT INTO users (fid, nickname, is_active, deactivated_at) "
        "VALUES (?, ?, 0, ?)",
        (222, "Benched", _now_iso()),
    )
    conn.commit()
    conn.close()  # reactivate_member opens its own connection to db/users.sqlite

    reactivated = ame.reactivate_member(222)
    assert reactivated is True

    conn2 = sqlite3.connect("db/users.sqlite")
    row = conn2.execute(
        "SELECT nickname, is_active, deactivated_at FROM users WHERE fid = ?", (222,),
    ).fetchone()
    assert row == ("Benched", 1, None)
    conn2.close()


def test_reactivate_member_noop_when_already_active(tmp_path, monkeypatch):
    conn = _make_users_db(tmp_path, monkeypatch)
    conn.execute("INSERT INTO users (fid, nickname, is_active) VALUES (?, ?, 1)", (333, "Live"))
    conn.commit()
    conn.close()

    assert ame.reactivate_member(333) is False

    conn2 = sqlite3.connect("db/users.sqlite")
    row = conn2.execute("SELECT is_active, deactivated_at FROM users WHERE fid = ?", (333,)).fetchone()
    assert row == (1, None)
    conn2.close()


def test_reactivate_member_missing_fid_returns_false(tmp_path, monkeypatch):
    _make_users_db(tmp_path, monkeypatch).close()
    assert ame.reactivate_member(999999) is False


def test_reactivate_member_shared_connection_lets_caller_batch(tmp_path, monkeypatch):
    """When a caller passes its own `conn`, reactivate_member must still apply
    the UPDATE against it (readable on that same connection) without forcing
    its own commit — used by the CSV-import and admin-add reactivation passes,
    which batch several fids into one commit."""
    conn = _make_users_db(tmp_path, monkeypatch)
    conn.execute("INSERT INTO users (fid, nickname, is_active) VALUES (?, ?, 0)", (444, "Pending"))
    conn.execute("INSERT INTO users (fid, nickname, is_active) VALUES (?, ?, 0)", (445, "AlsoPending"))
    conn.commit()

    assert ame.reactivate_member(444, conn=conn) is True
    assert ame.reactivate_member(445, conn=conn) is True
    # Visible on the same connection/transaction before the caller commits.
    row = conn.execute("SELECT is_active FROM users WHERE fid = ?", (444,)).fetchone()
    assert row == (1,)

    conn.commit()  # caller batches the commit, as the CSV-import pass does
    conn2 = sqlite3.connect("db/users.sqlite")
    rows = conn2.execute(
        "SELECT fid, is_active, deactivated_at FROM users WHERE fid IN (444, 445) ORDER BY fid"
    ).fetchall()
    assert rows == [(444, 1, None), (445, 1, None)]
    conn2.close()
    conn.close()
