"""Regression tests for auto-assigning Discord roles on successful
/register: a generic "Registered" role, plus a role named after the
alliance's short tag (e.g. "APX"). Unlike every other Discord resource
this bot touches (channels, always picked by an admin from an existing
list -- see cogs/alliance_channels.py / cogs/alliance_id_channel.py),
these two roles are auto-created in the guild if missing, since the
whole point is that registration "just works" with nothing to configure
first.

Every failure mode here (missing Manage Roles, role above the bot's own
top role in the hierarchy, running in a DM with no guild) must be
swallowed, not raised -- role assignment is a best-effort side effect of
registration, never allowed to break the registration itself."""
from __future__ import annotations

import asyncio
import sqlite3
from types import SimpleNamespace

import discord

import cogs.alliance_registration as ar


class FakeRole:
    def __init__(self, name, id_):
        self.name = name
        self.id = id_

    def __eq__(self, other):
        return isinstance(other, FakeRole) and self.id == other.id

    def __hash__(self):
        return hash(self.id)


class FakeGuild:
    def __init__(self, roles=None, create_exc=None):
        self.id = 1
        self.roles = list(roles or [])
        self._create_exc = create_exc
        self.created_names = []
        self._next_id = 1000

    async def create_role(self, name, reason=None):
        if self._create_exc is not None:
            raise self._create_exc
        role = FakeRole(name, self._next_id)
        self._next_id += 1
        self.roles.append(role)
        self.created_names.append(name)
        return role


class FakeMember:
    def __init__(self, guild, roles=None, add_exc=None):
        self.id = 42
        self.guild = guild
        self.roles = list(roles or [])
        self._add_exc = add_exc
        self.added = []

    async def add_roles(self, role, reason=None):
        if self._add_exc is not None:
            raise self._add_exc
        self.roles.append(role)
        self.added.append(role)


class _ForbiddenStub(discord.Forbidden):
    def __init__(self):  # bypass HTTPException's real ctor -- args unused here
        pass


def _make_cog(tag="APX"):
    cog = ar.AllianceRegistration.__new__(ar.AllianceRegistration)
    cog.conn_alliance = sqlite3.connect(":memory:")
    cog.c_alliance = cog.conn_alliance.cursor()
    cog.c_alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, tag TEXT)")
    cog.c_alliance.execute("INSERT INTO alliance_list VALUES (5, ?)", (tag,))
    cog.conn_alliance.commit()
    return cog


def _interaction(guild, member):
    return SimpleNamespace(guild=guild, user=member)


# ---------------------------------------------------------------------------
# _get_or_create_role
# ---------------------------------------------------------------------------

def test_get_or_create_role_reuses_existing():
    cog = _make_cog()
    existing = FakeRole("Registered", 1)
    guild = FakeGuild(roles=[existing])
    role = asyncio.run(cog._get_or_create_role(guild, "Registered"))
    assert role is existing
    assert guild.created_names == []


def test_get_or_create_role_creates_when_missing():
    cog = _make_cog()
    guild = FakeGuild(roles=[])
    role = asyncio.run(cog._get_or_create_role(guild, "Registered"))
    assert role is not None
    assert role.name == "Registered"
    assert guild.created_names == ["Registered"]


def test_get_or_create_role_forbidden_returns_none_without_raising():
    cog = _make_cog()
    guild = FakeGuild(roles=[], create_exc=_ForbiddenStub())
    role = asyncio.run(cog._get_or_create_role(guild, "Registered"))
    assert role is None


# ---------------------------------------------------------------------------
# _assign_role
# ---------------------------------------------------------------------------

def test_assign_role_adds_when_missing():
    cog = _make_cog()
    guild = FakeGuild()
    role = FakeRole("Registered", 1)
    member = FakeMember(guild)
    asyncio.run(cog._assign_role(member, role))
    assert member.added == [role]


def test_assign_role_noop_when_already_has_it():
    cog = _make_cog()
    guild = FakeGuild()
    role = FakeRole("Registered", 1)
    member = FakeMember(guild, roles=[role])
    asyncio.run(cog._assign_role(member, role))
    assert member.added == [], "must not call add_roles again if already assigned"


def test_assign_role_forbidden_swallowed_without_raising():
    cog = _make_cog()
    guild = FakeGuild()
    role = FakeRole("Registered", 1)
    member = FakeMember(guild, add_exc=_ForbiddenStub())
    asyncio.run(cog._assign_role(member, role))  # must not raise


# ---------------------------------------------------------------------------
# _apply_registration_roles -- the orchestrating entry point
# ---------------------------------------------------------------------------

def test_apply_registration_roles_assigns_both_registered_and_tag_role():
    cog = _make_cog(tag="APX")
    guild = FakeGuild(roles=[])
    member = FakeMember(guild)
    inter = _interaction(guild, member)

    asyncio.run(cog._apply_registration_roles(inter, 5))

    names = {r.name for r in member.added}
    assert names == {"Registered", "APX"}


def test_apply_registration_roles_skips_tag_role_when_alliance_has_no_tag():
    cog = _make_cog(tag=None)
    guild = FakeGuild(roles=[])
    member = FakeMember(guild)
    inter = _interaction(guild, member)

    asyncio.run(cog._apply_registration_roles(inter, 5))

    names = {r.name for r in member.added}
    assert names == {"Registered"}


def test_apply_registration_roles_skips_entirely_in_dm_context():
    cog = _make_cog(tag="APX")
    member = FakeMember(guild=None)
    inter = _interaction(guild=None, member=member)

    asyncio.run(cog._apply_registration_roles(inter, 5))

    assert member.added == []


def test_apply_registration_roles_skips_when_user_has_no_add_roles():
    """A plain discord.User (DM-only user object with no add_roles method)
    must be skipped even if guild somehow ended up non-None."""
    cog = _make_cog(tag="APX")
    guild = FakeGuild(roles=[])
    plain_user = SimpleNamespace(id=99)  # no add_roles method
    inter = _interaction(guild, plain_user)

    asyncio.run(cog._apply_registration_roles(inter, 5))  # must not raise


def test_apply_registration_roles_reuses_existing_roles_across_calls():
    """Two different members registering into the same alliance must share
    the same auto-created roles, not create duplicates."""
    cog = _make_cog(tag="APX")
    guild = FakeGuild(roles=[])
    member1 = FakeMember(guild)
    member2 = FakeMember(guild)

    asyncio.run(cog._apply_registration_roles(_interaction(guild, member1), 5))
    asyncio.run(cog._apply_registration_roles(_interaction(guild, member2), 5))

    assert guild.created_names.count("Registered") == 1
    assert guild.created_names.count("APX") == 1


# ---------------------------------------------------------------------------
# Structural guards: role assignment must be wired into all three real
# /register success paths, not just exist unreferenced.
# ---------------------------------------------------------------------------

def test_register_command_calls_apply_registration_roles():
    import inspect
    src = inspect.getsource(ar.AllianceRegistration.register.callback)
    assert src.count("_apply_registration_roles") >= 3, (
        "expected calls from all three success paths (already-registered, "
        "attach-to-existing, brand-new) inside register()"
    )


def test_move_server_view_calls_apply_registration_roles():
    import inspect
    src = inspect.getsource(ar._MoveServerView.confirm)
    assert "_apply_registration_roles" in src
