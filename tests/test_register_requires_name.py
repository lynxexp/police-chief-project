"""Regression: /register's `name` option is required, not optional.

Previously a brand-new registration with no `name` given fell back to a
placeholder nickname ("Player {fid}") that could never match a real
OCR'd screenshot name -- Discord display names frequently don't match a
player's actual in-game name, so `name` needs to be supplied explicitly
rather than silently defaulting to something useless. Making it a
required app_commands parameter (no default) means Discord's own slash
command UI won't let a user submit /register without filling it in."""
from __future__ import annotations

import asyncio
import inspect
import sqlite3
from types import SimpleNamespace

import cogs.alliance_registration as ar


def _mk_cog(monkeypatch):
    alliance = sqlite3.connect(":memory:")
    alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, name TEXT)")
    alliance.execute("INSERT INTO alliance_list VALUES (5, 'TestAlli')")
    alliance.commit()
    real_connect = sqlite3.connect

    def fake_connect(path, *a, **k):
        if str(path).endswith("alliance.sqlite"):
            return alliance
        return real_connect(path, *a, **k)

    monkeypatch.setattr(ar.sqlite3, "connect", fake_connect)

    cog = ar.AllianceRegistration.__new__(ar.AllianceRegistration)
    cog.is_registration_enabled = lambda: True
    cog._get_user_row = lambda fid: None
    inserted = []
    cog._insert_new_user = lambda fid, user_data, *a, **k: inserted.append(user_data)

    async def send_success(*a, **k):
        pass

    cog._send_register_success = send_success
    cog.bot = SimpleNamespace(get_cog=lambda name: object())

    async def _verify_add_state(gift_cog, fid, alliance):
        return 100, True

    monkeypatch.setattr(ar, "verify_add_state", _verify_add_state)
    monkeypatch.setattr(ar, "check_alliance_state", lambda a, k: None)
    return cog, inserted


def _interaction():
    sent = []

    async def send_message(*a, **k):
        sent.append((a, k))

    async def defer(*a, **k):
        pass

    async def followup_send(*a, **k):
        sent.append((a, k))

    return SimpleNamespace(
        user=SimpleNamespace(id=42),
        guild=object(),
        guild_id=9,
        response=SimpleNamespace(send_message=send_message, defer=defer),
        followup=SimpleNamespace(send=followup_send),
    ), sent


def test_name_parameter_has_no_default():
    """The app_commands signature itself must make `name` required --
    this is what actually stops Discord from letting a user submit the
    command without it."""
    sig = inspect.signature(ar.AllianceRegistration.register.callback)
    assert sig.parameters["name"].default is inspect.Parameter.empty


def test_calling_register_without_name_raises(monkeypatch):
    cog, _inserted = _mk_cog(monkeypatch)
    inter, _sent = _interaction()
    try:
        asyncio.run(ar.AllianceRegistration.register.callback(cog, inter, fid=7, alliance=5))
        assert False, "must raise without a name argument"
    except TypeError:
        pass


def test_new_registration_uses_given_name_verbatim(monkeypatch):
    """No more "Player {fid}" placeholder -- the nickname saved is exactly
    what the user typed."""
    cog, inserted = _mk_cog(monkeypatch)
    inter, _sent = _interaction()

    asyncio.run(ar.AllianceRegistration.register.callback(
        cog, inter, fid=7, alliance=5, name="RealIGN"))

    assert len(inserted) == 1
    assert inserted[0]["nickname"] == "RealIGN"
    assert "Player" not in inserted[0]["nickname"]
