"""Regression tests for the "Change Server" admin action
(Alliance.show_change_server_for, cogs/alliance.py) -- repoints an
existing alliance's discord_server_id to whichever server the click
happens on. Added to support moving the bot from a test server to a
production install: Vault Trap/Capitol War history (alliance_id-keyed)
and admin permissions (Discord-user-id-keyed) already carry over
untouched, but alliance_list.discord_server_id is set once at alliance
creation and was never otherwise updatable."""
from __future__ import annotations

import asyncio
import sqlite3
from types import SimpleNamespace

import cogs.alliance as alliance_mod


def _make_cog(tmp_path, monkeypatch, bot=None):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)
    conn = sqlite3.connect("db/alliance.sqlite")
    return alliance_mod.Alliance(bot=bot or SimpleNamespace(get_guild=lambda gid: None), conn=conn)


def _insert_alliance(name="Apex", server_id=111):
    with sqlite3.connect("db/alliance.sqlite") as conn:
        conn.execute(
            "INSERT INTO alliance_list (name, discord_server_id) VALUES (?, ?)",
            (name, server_id),
        )
        conn.commit()
        return conn.execute(
            "SELECT alliance_id FROM alliance_list WHERE name = ?", (name,)
        ).fetchone()[0]


def _get_server_id(alliance_id):
    with sqlite3.connect("db/alliance.sqlite") as conn:
        return conn.execute(
            "SELECT discord_server_id FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
        ).fetchone()[0]


def _interaction(*, guild_id=222, guild_name="Real Server", user_id=1, guild=True):
    sent = []

    async def send_message(*a, **k):
        sent.append((a, k))

    return SimpleNamespace(
        user=SimpleNamespace(id=user_id),
        guild=SimpleNamespace(id=guild_id, name=guild_name) if guild else None,
        guild_id=guild_id if guild else None,
        response=SimpleNamespace(send_message=send_message, is_done=lambda: False),
    ), sent


def test_denies_in_dm_context(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance()
    inter, sent = _interaction(guild=False)

    asyncio.run(cog.show_change_server_for(inter, aid))

    assert sent and "DM" in str(sent[0])
    assert _get_server_id(aid) == 111, "must not touch the DB from a DM context"


def test_denies_unknown_alliance(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    inter, sent = _interaction()

    asyncio.run(cog.show_change_server_for(inter, 9999))

    assert sent and "not found" in str(sent[0]).lower()


def test_noop_when_already_on_this_server(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=222)
    inter, sent = _interaction(guild_id=222)

    asyncio.run(cog.show_change_server_for(inter, aid))

    assert sent and "already" in str(sent[0]).lower()
    assert _get_server_id(aid) == 222


def test_shows_confirmation_without_writing_yet(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=111)
    inter, sent = _interaction(guild_id=222, guild_name="Real Server")

    asyncio.run(cog.show_change_server_for(inter, aid))

    assert len(sent) == 1
    _args, kwargs = sent[0]
    assert kwargs.get("view") is not None
    assert _get_server_id(aid) == 111, "must not write until Confirm is actually clicked"


def test_confirm_updates_discord_server_id(tmp_path, monkeypatch):
    monkeypatch.setattr(
        alliance_mod.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: True),
    )
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=111)
    inter, sent = _interaction(guild_id=222, guild_name="Real Server", user_id=1)

    asyncio.run(cog.show_change_server_for(inter, aid))
    _args, kwargs = sent[0]
    view = kwargs["view"]

    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    confirm_inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        guild=SimpleNamespace(id=222),
        guild_id=222,
        response=SimpleNamespace(edit_message=edit_message, is_done=lambda: False),
    )
    asyncio.run(view.confirm.callback(confirm_inter))

    assert _get_server_id(aid) == 222
    assert edits
    assert "Server Updated" in edits[0][1]["embed"].title


def test_confirm_reverifies_permission_at_click_time(tmp_path, monkeypatch):
    """A viewer who was authorized when the prompt opened but loses
    permission before clicking Confirm (e.g. demoted) must be denied --
    this re-checks fresh, not off a cached flag from when the menu opened."""
    monkeypatch.setattr(
        alliance_mod.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: False),
    )
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=111)
    inter, sent = _interaction(guild_id=222, user_id=1)

    asyncio.run(cog.show_change_server_for(inter, aid))
    _args, kwargs = sent[0]
    view = kwargs["view"]

    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))

    confirm_inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        guild=SimpleNamespace(id=222),
        guild_id=222,
        response=SimpleNamespace(send_message=send_message, is_done=lambda: False),
    )
    asyncio.run(view.confirm.callback(confirm_inter))

    assert _get_server_id(aid) == 111, "must not write when permission check fails at click time"
    assert denied and "permission" in str(denied[0]).lower()


def test_wrong_viewer_cannot_confirm(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=111)
    inter, sent = _interaction(guild_id=222, user_id=1)

    asyncio.run(cog.show_change_server_for(inter, aid))
    _args, kwargs = sent[0]
    view = kwargs["view"]

    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))

    other_inter = SimpleNamespace(
        user=SimpleNamespace(id=999),  # not the original clicker
        response=SimpleNamespace(send_message=send_message, is_done=lambda: False),
    )
    asyncio.run(view.confirm.callback(other_inter))

    assert _get_server_id(aid) == 111
    assert denied and "someone else" in str(denied[0]).lower()


def test_cancel_leaves_server_untouched(tmp_path, monkeypatch):
    cog = _make_cog(tmp_path, monkeypatch)
    aid = _insert_alliance(server_id=111)
    inter, sent = _interaction(guild_id=222, user_id=1)

    asyncio.run(cog.show_change_server_for(inter, aid))
    _args, kwargs = sent[0]
    view = kwargs["view"]

    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    cancel_inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        response=SimpleNamespace(edit_message=edit_message, is_done=lambda: False),
    )
    asyncio.run(view.cancel.callback(cancel_inter))

    assert _get_server_id(aid) == 111
    assert edits
    assert "No Change" in edits[0][1]["embed"].title


# ---------------------------------------------------------------------------
# Structural guard: the hub button must actually route to this method.
# ---------------------------------------------------------------------------

def test_hub_button_routes_to_show_change_server_for():
    import inspect
    import cogs.bot_main_menu as bmm
    src = inspect.getsource(bmm.AllianceHubView.change_server)
    assert "show_change_server_for" in src
