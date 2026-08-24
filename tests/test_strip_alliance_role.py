"""Regression tests for stripping a member's alliance tag role (e.g.
"APX") when they're deactivated/removed from that alliance -- the mirror
image of cogs/alliance_registration.py's auto-assign-on-/register.

Deliberately does NOT touch the generic "Registered" role: that reflects
having an in-game ID linked to Discord at all, independent of any one
alliance, and stays even after removal from a specific alliance (this was
an explicit decision, not an oversight -- see the docstring on
_strip_alliance_role itself)."""
from __future__ import annotations

import asyncio
import sqlite3

import discord

import cogs.alliance_member_operations as amo


class FakeRole:
    def __init__(self, name, id_):
        self.name = name
        self.id = id_

    def __eq__(self, other):
        return isinstance(other, FakeRole) and self.id == other.id

    def __hash__(self):
        return hash(self.id)


class FakeMember:
    def __init__(self, roles=None, remove_exc=None):
        self.roles = list(roles or [])
        self._remove_exc = remove_exc
        self.removed = []

    async def remove_roles(self, role, reason=None):
        if self._remove_exc is not None:
            raise self._remove_exc
        self.roles = [r for r in self.roles if r != role]
        self.removed.append(role)


class FakeGuild:
    def __init__(self, roles=None, member=None):
        self.id = 1
        self.roles = list(roles or [])
        self._member = member

    def get_member(self, discord_id):
        return self._member


class FakeBot:
    def __init__(self, guild=None):
        self._guild = guild

    def get_guild(self, guild_id):
        return self._guild


class _ForbiddenStub(discord.Forbidden):
    def __init__(self):  # bypass HTTPException's real ctor -- args unused here
        pass


def _setup_dbs(tmp_path, monkeypatch, *, tag="APX", discord_id=42, server_id=999):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)

    users = sqlite3.connect("db/users.sqlite")
    users.execute(
        "CREATE TABLE users (fid INTEGER PRIMARY KEY, discord_id INTEGER, discord_server_id INTEGER)"
    )
    users.execute(
        "INSERT INTO users VALUES (7, ?, ?)", (discord_id, server_id)
    )
    users.commit()
    users.close()

    alliance = sqlite3.connect("db/alliance.sqlite")
    alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, tag TEXT)")
    alliance.execute("INSERT INTO alliance_list VALUES (5, ?)", (tag,))
    alliance.commit()
    alliance.close()


def test_strips_role_the_member_has(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch)
    role = FakeRole("APX", 1)
    member = FakeMember(roles=[role])
    guild = FakeGuild(roles=[role], member=member)
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))

    assert member.removed == [role]


def test_noop_when_member_never_had_the_role(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch)
    role = FakeRole("APX", 1)
    member = FakeMember(roles=[])  # doesn't have it
    guild = FakeGuild(roles=[role], member=member)
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))

    assert member.removed == []


def test_noop_when_alliance_has_no_tag(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch, tag=None)
    role = FakeRole("Whatever", 1)
    member = FakeMember(roles=[role])
    guild = FakeGuild(roles=[role], member=member)
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))

    assert member.removed == []


def test_noop_when_member_not_linked_to_discord(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch, discord_id=None, server_id=None)
    bot = FakeBot(guild=None)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))  # must not raise


def test_noop_when_guild_not_found(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch)
    bot = FakeBot(guild=None)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))  # must not raise


def test_noop_when_member_left_the_guild(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch)
    role = FakeRole("APX", 1)
    guild = FakeGuild(roles=[role], member=None)  # get_member returns None
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))  # must not raise


def test_forbidden_swallowed_without_raising(tmp_path, monkeypatch):
    _setup_dbs(tmp_path, monkeypatch)
    role = FakeRole("APX", 1)
    member = FakeMember(roles=[role], remove_exc=_ForbiddenStub())
    guild = FakeGuild(roles=[role], member=member)
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))  # must not raise


# ---------------------------------------------------------------------------
# Structural guards: wired into both real deactivation call sites.
# ---------------------------------------------------------------------------

def test_bulk_deactivate_calls_strip_alliance_role():
    import inspect
    src = inspect.getsource(amo._RemoveSelectedConfirmView.confirm)
    assert "_strip_alliance_role" in src


def test_single_member_deactivate_calls_strip_alliance_role():
    import inspect
    src = inspect.getsource(amo.IDSearchModal.on_submit)
    assert "_strip_alliance_role" in src


def test_registered_role_survives_deactivation(tmp_path, monkeypatch):
    """A member holding BOTH "Registered" and their alliance tag role
    keeps "Registered" after deactivation -- only the tag role is
    stripped."""
    _setup_dbs(tmp_path, monkeypatch)
    registered = FakeRole("Registered", 1)
    tag_role = FakeRole("APX", 2)
    member = FakeMember(roles=[registered, tag_role])
    guild = FakeGuild(roles=[registered, tag_role], member=member)
    bot = FakeBot(guild=guild)

    asyncio.run(amo._strip_alliance_role(bot, 5, 7))

    assert member.removed == [tag_role]
    assert registered in member.roles
