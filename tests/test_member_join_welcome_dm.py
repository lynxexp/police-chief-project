"""Regression tests for the on_member_join welcome-DM listener
(cogs/alliance_registration.py) -- prompts a brand-new member to run
/register, by DM, but only while the global self-registration toggle is
on (prompting someone to run a command that would just tell them
registration is disabled isn't useful), and never for bots. DM failures
(discord.Forbidden -- closed DMs, common) are swallowed silently, matching
every other DM-send call site in this bot.

AllianceRegistration.__init__ opens real sqlite connections to
db/alliance.sqlite / db/users.sqlite (hardcoded paths, not injectable), so
instances here are built via __new__ to skip __init__ entirely --
on_member_join itself only touches self.is_registration_enabled() and the
member object, neither of which needs those connections."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import discord

from harness import bt  # noqa: F401 -- ensures the cogs package import path is set up

import importlib

ar = importlib.import_module("cogs.alliance_registration")


def _make_cog(registration_enabled: bool):
    cog = ar.AllianceRegistration.__new__(ar.AllianceRegistration)
    cog.is_registration_enabled = lambda: registration_enabled
    return cog


class FakeMember:
    def __init__(self, *, bot=False, send_exc=None, guild_name="Apex Server", uid=1):
        self.bot = bot
        self.id = uid
        self.guild = SimpleNamespace(name=guild_name)
        self._send_exc = send_exc
        self.sent = []

    async def send(self, *args, **kwargs):
        if self._send_exc is not None:
            raise self._send_exc
        self.sent.append((args, kwargs))


class _FakeForbidden(discord.Forbidden):
    def __init__(self):  # bypass HTTPException's real ctor -- args unused here
        pass


def test_dm_sent_when_registration_enabled():
    cog = _make_cog(registration_enabled=True)
    member = FakeMember()
    asyncio.run(cog.on_member_join(member))
    assert len(member.sent) == 1
    _, kwargs = member.sent[0]
    embed = kwargs.get("embed")
    assert embed is not None
    assert "/register" in embed.description
    # Generic on purpose -- one Discord server can host several alliances
    # (alliance_list.discord_server_id is many-to-one), so the message
    # must not name a specific server/alliance that may not match the
    # one this member is actually joining to register under.
    assert "Apex Server" not in embed.title
    assert "Apex Server" not in embed.description


def test_no_dm_when_registration_disabled():
    cog = _make_cog(registration_enabled=False)
    member = FakeMember()
    asyncio.run(cog.on_member_join(member))
    assert member.sent == []


def test_no_dm_for_bot_members():
    cog = _make_cog(registration_enabled=True)
    member = FakeMember(bot=True)
    asyncio.run(cog.on_member_join(member))
    assert member.sent == []


def test_closed_dms_swallowed_without_raising():
    cog = _make_cog(registration_enabled=True)
    member = FakeMember(send_exc=_FakeForbidden())
    asyncio.run(cog.on_member_join(member))  # must not raise


def test_unexpected_send_error_swallowed_without_raising():
    cog = _make_cog(registration_enabled=True)
    member = FakeMember(send_exc=RuntimeError("network blip"))
    asyncio.run(cog.on_member_join(member))  # must not raise


def test_members_intent_enabled_in_main():
    """Structural guard: on_member_join can never fire at all without the
    privileged Members gateway intent -- main.py must actually request it,
    not just handle discord.PrivilegedIntentsRequired after the fact."""
    import pathlib
    main_path = pathlib.Path(__file__).resolve().parent.parent / "main.py"
    text = main_path.read_text(encoding="utf-8")
    assert "intents.members = True" in text
