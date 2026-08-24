"""Auto-reactivation on re-register (decision #1): if a deactivated fid
re-registers via /register — same server, a different server ("move"), or
attaching Discord to an fid that already exists but was never linked — it
comes back active with `deactivated_at` cleared and its history untouched.

Drives the real AllianceRegistration cog against real temp sqlite DBs
(db/users.sqlite, db/alliance.sqlite) via monkeypatch.chdir, same technique
as test_member_deactivation.py. No Discord gateway needed: interaction is a
minimal duck-typed stand-in, matching the style already used in
test_alliance_registration.py.
"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace

import cogs.alliance_registration as ar


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _make_dbs(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)

    users = sqlite3.connect("db/users.sqlite")
    users.execute("""
        CREATE TABLE users (
            fid INTEGER PRIMARY KEY,
            nickname TEXT,
            chief_office_lv INTEGER,
            kid INTEGER,
            alliance TEXT,
            discord_id INTEGER,
            discord_server_id INTEGER,
            discord_id_updated_at TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            deactivated_at TEXT
        )
    """)
    users.commit()
    users.close()

    alliance = sqlite3.connect("db/alliance.sqlite")
    alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, name TEXT)")
    alliance.execute("INSERT INTO alliance_list VALUES (5, 'TestAlli')")
    alliance.commit()
    alliance.close()


def _make_cog():
    cog = ar.AllianceRegistration.__new__(ar.AllianceRegistration)
    cog.bot = SimpleNamespace(get_cog=lambda name: None, get_guild=lambda gid: None)
    cog.conn_users = sqlite3.connect("db/users.sqlite", check_same_thread=False)
    cog.c_users = cog.conn_users.cursor()
    cog.conn_alliance = sqlite3.connect("db/alliance.sqlite", check_same_thread=False)
    cog.c_alliance = cog.conn_alliance.cursor()
    cog.is_registration_enabled = lambda: True
    return cog


def _interaction(user_id, guild_id):
    sent = []

    async def send_message(*a, **k):
        sent.append((a, k))

    async def followup_send(*a, **k):
        sent.append((a, k))

    guild = SimpleNamespace(id=guild_id, name=f"Guild{guild_id}")

    return SimpleNamespace(
        user=SimpleNamespace(id=user_id),
        guild=guild,
        guild_id=guild_id,
        response=SimpleNamespace(send_message=send_message, is_done=lambda: False),
        followup=SimpleNamespace(send=followup_send),
    ), sent


def _insert_deactivated_row(*, fid, discord_id, server_id, alliance="5"):
    conn = sqlite3.connect("db/users.sqlite")
    conn.execute(
        "INSERT INTO users (fid, nickname, chief_office_lv, kid, alliance, "
        "discord_id, discord_server_id, is_active, deactivated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
        (fid, "Benched", 10, 911, alliance, discord_id, server_id, _now_iso()),
    )
    conn.commit()
    conn.close()


def _fetch(fid):
    conn = sqlite3.connect("db/users.sqlite")
    row = conn.execute(
        "SELECT is_active, deactivated_at, nickname FROM users WHERE fid = ?", (fid,)
    ).fetchone()
    conn.close()
    return row


def test_same_server_reregister_reactivates(tmp_path, monkeypatch):
    """A deactivated fid whose Discord link already points at this exact
    server: /register on that server reactivates it in place."""
    _make_dbs(tmp_path, monkeypatch)
    _insert_deactivated_row(fid=100, discord_id=42, server_id=9)
    cog = _make_cog()
    inter, sent = _interaction(user_id=42, guild_id=9)

    asyncio.run(ar.AllianceRegistration.register.callback(cog, inter, fid=100, alliance=5, name="Benched"))

    is_active, deactivated_at, nickname = _fetch(100)
    assert (is_active, deactivated_at) == (1, None)
    assert nickname == "Benched", "history/name must survive reactivation"
    assert sent and "reactivated" in str(sent[0]).lower()


def test_attach_to_existing_reactivates(tmp_path, monkeypatch):
    """A deactivated fid with no Discord link at all (discord_id NULL):
    /register attaches the caller's Discord id and reactivates in one step."""
    _make_dbs(tmp_path, monkeypatch)
    _insert_deactivated_row(fid=101, discord_id=None, server_id=None)
    cog = _make_cog()
    inter, sent = _interaction(user_id=77, guild_id=9)

    asyncio.run(ar.AllianceRegistration.register.callback(cog, inter, fid=101, alliance=5, name="Benched"))

    is_active, deactivated_at, nickname = _fetch(101)
    assert (is_active, deactivated_at) == (1, None)
    assert nickname == "Benched"

    conn = sqlite3.connect("db/users.sqlite")
    discord_id = conn.execute("SELECT discord_id FROM users WHERE fid = ?", (101,)).fetchone()[0]
    conn.close()
    assert discord_id == 77


def test_move_server_reactivates_on_confirm(tmp_path, monkeypatch):
    """A deactivated fid already linked to the caller but on a *different*
    server: /register offers to move the registration; confirming the move
    also reactivates."""
    _make_dbs(tmp_path, monkeypatch)
    _insert_deactivated_row(fid=102, discord_id=55, server_id=1)
    cog = _make_cog()
    inter, sent = _interaction(user_id=55, guild_id=2)  # different server (2 != 1)

    asyncio.run(ar.AllianceRegistration.register.callback(cog, inter, fid=102, alliance=5, name="Benched"))
    # Still deactivated — only the move view was shown, nothing written yet.
    assert _fetch(102)[0] == 0

    # Find the view that was sent and confirm the move.
    (_args, kwargs) = sent[0]
    view = kwargs["view"]

    async def edit_message(*a, **k):
        pass
    confirm_inter = SimpleNamespace(
        user=SimpleNamespace(id=55),
        guild=None,  # role assignment is guild-only; None makes it a clean no-op here
        response=SimpleNamespace(edit_message=edit_message),
    )
    asyncio.run(view.confirm.callback(confirm_inter))

    is_active, deactivated_at, nickname = _fetch(102)
    assert (is_active, deactivated_at) == (1, None)
    assert nickname == "Benched"

    conn = sqlite3.connect("db/users.sqlite")
    server_id = conn.execute(
        "SELECT discord_server_id FROM users WHERE fid = ?", (102,)
    ).fetchone()[0]
    conn.close()
    assert server_id == 2


def test_active_member_same_server_reregister_is_not_falsely_flagged(tmp_path, monkeypatch):
    """An already-active member re-running /register on the same server gets
    the normal 'already registered' response, with no bogus reactivation note."""
    _make_dbs(tmp_path, monkeypatch)
    conn = sqlite3.connect("db/users.sqlite")
    conn.execute(
        "INSERT INTO users (fid, nickname, alliance, discord_id, discord_server_id, is_active) "
        "VALUES (?, ?, ?, ?, ?, 1)",
        (103, "AlreadyHere", "5", 88, 9),
    )
    conn.commit()
    conn.close()
    cog = _make_cog()
    inter, sent = _interaction(user_id=88, guild_id=9)

    asyncio.run(ar.AllianceRegistration.register.callback(cog, inter, fid=103, alliance=5, name="AlreadyHere"))

    assert _fetch(103)[0] == 1
    assert sent and "reactivated" not in str(sent[0]).lower()
