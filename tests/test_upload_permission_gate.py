"""Regression tests for gating the screenshot-upload channel-listener path
behind the existing "Add Permission" toggle (admin_only_add /
capitol_admin_only_add).

Previously, /vault_damage_add and /capitol_add respected this toggle, but
posting a screenshot directly in the configured tracking channel (by far
the more common way data gets submitted) bypassed it completely -- the
channel listener's on_message/process_*_data never consulted the toggle
or the bot's admin-tier system at all, so a Discord user with permission
to attach files in that channel could trigger OCR ingestion and submit
data regardless of their alliance-admin status. Fixed by adding
VaultTrack._enforce_upload_permission / CapitolWar._enforce_upload_permission,
called from process_vault_hunt_data / process_capitol_war_data before a
session is touched.

Both gates delegate to the new PermissionManager.can_manage_alliance --
a single, pure "is this user an admin (any tier) with access to this
specific alliance" predicate now shared by can_manage_vault,
can_manage_capitol, the "manage" branch of both check_*_permission
methods, and this new upload gate."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from harness import bt, ct


# ---------------------------------------------------------------------------
# PermissionManager.can_manage_alliance -- the shared predicate itself.
# ---------------------------------------------------------------------------

def _stub_admin(monkeypatch, pm, *, is_admin, is_global, alliance_ids=()):
    monkeypatch.setattr(pm, "is_admin", staticmethod(lambda uid: (is_admin, is_global)))
    monkeypatch.setattr(
        pm, "get_admin_alliance_ids",
        staticmethod(lambda uid, gid: (list(alliance_ids), is_global)),
    )


def test_can_manage_alliance_global_admin_always_true(monkeypatch):
    pm = bt.PermissionManager
    _stub_admin(monkeypatch, pm, is_admin=True, is_global=True)
    assert pm.can_manage_alliance(1, 100, 999) is True


def test_can_manage_alliance_alliance_admin_with_access(monkeypatch):
    pm = bt.PermissionManager
    _stub_admin(monkeypatch, pm, is_admin=True, is_global=False, alliance_ids=[5, 7])
    assert pm.can_manage_alliance(1, 100, 5) is True


def test_can_manage_alliance_alliance_admin_without_access(monkeypatch):
    pm = bt.PermissionManager
    _stub_admin(monkeypatch, pm, is_admin=True, is_global=False, alliance_ids=[5, 7])
    assert pm.can_manage_alliance(1, 100, 999) is False


def test_can_manage_alliance_non_admin_always_false(monkeypatch):
    pm = bt.PermissionManager
    _stub_admin(monkeypatch, pm, is_admin=False, is_global=False)
    assert pm.can_manage_alliance(1, 100, 5) is False


# ---------------------------------------------------------------------------
# Fake discord.Message -- only what _enforce_upload_permission touches.
# ---------------------------------------------------------------------------

class FakeChannel:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


class FakeMessage:
    def __init__(self, author_id=1, guild_id=100):
        self.channel = FakeChannel()
        self.author = SimpleNamespace(id=author_id, mention=f"<@{author_id}>")
        self.guild = SimpleNamespace(id=guild_id) if guild_id is not None else None


# ---------------------------------------------------------------------------
# VaultTrack._enforce_upload_permission
# ---------------------------------------------------------------------------

class _FakeVaultCog:
    def __init__(self, admin_only_add):
        self._admin_only_add = admin_only_add

    def get_vault_settings(self, alliance_id):
        return {"admin_only_add": self._admin_only_add}


def test_vault_upload_allowed_when_toggle_off(monkeypatch):
    """admin_only_add=0 ("Everyone") -- anyone can upload, no admin check
    even performed."""
    monkeypatch.setattr(
        bt.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: False),
    )
    cog = _FakeVaultCog(admin_only_add=0)
    msg = FakeMessage()
    allowed = asyncio.run(bt.VaultTrack._enforce_upload_permission(cog, msg, 42))
    assert allowed is True
    assert msg.channel.sent == []


def test_vault_upload_allowed_for_alliance_admin_when_toggle_on(monkeypatch):
    monkeypatch.setattr(
        bt.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: True),
    )
    cog = _FakeVaultCog(admin_only_add=1)
    msg = FakeMessage()
    allowed = asyncio.run(bt.VaultTrack._enforce_upload_permission(cog, msg, 42))
    assert allowed is True
    assert msg.channel.sent == []


def test_vault_upload_denied_for_non_admin_when_toggle_on(monkeypatch):
    monkeypatch.setattr(
        bt.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: False),
    )
    cog = _FakeVaultCog(admin_only_add=1)
    msg = FakeMessage(author_id=7)
    allowed = asyncio.run(bt.VaultTrack._enforce_upload_permission(cog, msg, 42))
    assert allowed is False
    assert len(msg.channel.sent) == 1, "a denial notice should be posted"
    content, kwargs = msg.channel.sent[0]
    assert "<@7>" in content
    assert kwargs.get("delete_after") == 10, "denial notice should self-clean the channel"


# ---------------------------------------------------------------------------
# CapitolWar._enforce_upload_permission -- identical shape, mirrored cog.
# ---------------------------------------------------------------------------

class _FakeCapitolCog:
    def __init__(self, admin_only_add):
        self._admin_only_add = admin_only_add

    def get_capitol_settings(self, alliance_id):
        return {"admin_only_add": self._admin_only_add}


def test_capitol_upload_allowed_when_toggle_off(monkeypatch):
    monkeypatch.setattr(
        ct.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: False),
    )
    cog = _FakeCapitolCog(admin_only_add=0)
    msg = FakeMessage()
    allowed = asyncio.run(ct.CapitolWar._enforce_upload_permission(cog, msg, 42))
    assert allowed is True
    assert msg.channel.sent == []


def test_capitol_upload_allowed_for_alliance_admin_when_toggle_on(monkeypatch):
    monkeypatch.setattr(
        ct.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: True),
    )
    cog = _FakeCapitolCog(admin_only_add=1)
    msg = FakeMessage()
    allowed = asyncio.run(ct.CapitolWar._enforce_upload_permission(cog, msg, 42))
    assert allowed is True
    assert msg.channel.sent == []


def test_capitol_upload_denied_for_non_admin_when_toggle_on(monkeypatch):
    monkeypatch.setattr(
        ct.PermissionManager, "can_manage_alliance",
        staticmethod(lambda uid, gid, aid: False),
    )
    cog = _FakeCapitolCog(admin_only_add=1)
    msg = FakeMessage(author_id=9)
    allowed = asyncio.run(ct.CapitolWar._enforce_upload_permission(cog, msg, 42))
    assert allowed is False
    assert len(msg.channel.sent) == 1
    content, kwargs = msg.channel.sent[0]
    assert "<@9>" in content
    assert kwargs.get("delete_after") == 10


# ---------------------------------------------------------------------------
# Structural guards: the gate must actually be wired into the upload entry
# point, not just exist unreferenced.
# ---------------------------------------------------------------------------

def test_vault_process_hunt_data_calls_the_gate():
    import inspect
    src = inspect.getsource(bt.VaultTrack.process_vault_hunt_data)
    assert "_enforce_upload_permission" in src


def test_capitol_process_war_data_calls_the_gate():
    import inspect
    src = inspect.getsource(ct.CapitolWar.process_capitol_war_data)
    assert "_enforce_upload_permission" in src
