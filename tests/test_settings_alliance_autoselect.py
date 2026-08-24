"""Regression tests: VaultSettingsView / CapitolSettingsView must
auto-select the alliance (skip the manual dropdown pick) when the opening
admin only manages one alliance -- mirrors the existing shortcut in
MainMenu.show_alliance_management (cogs/bot_main_menu.py), which was
already applied to several other alliance-picker menus (gift_channels.py,
alliance_member_operations.py, alliance_logs.py) but missing from these
two settings views specifically. A multi-alliance admin must still see
the plain, unselected dropdown exactly as before."""
from __future__ import annotations

import sqlite3
from types import SimpleNamespace

from harness import bt, ct


def _fake_alliance_conn(rows):
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE alliance_list (alliance_id INTEGER PRIMARY KEY, name TEXT)")
    conn.executemany("INSERT INTO alliance_list (alliance_id, name) VALUES (?, ?)", rows)
    conn.commit()
    return conn


def test_vault_settings_view_auto_selects_when_admin_has_one_alliance(monkeypatch):
    monkeypatch.setattr(
        bt.PermissionManager, "get_admin_alliances",
        staticmethod(lambda uid, gid: ([(5, "Apex")], False)),
    )
    cog = SimpleNamespace(alliance_conn=_fake_alliance_conn([(5, "Apex")]))
    view = bt.VaultSettingsView(cog=cog, original_user_id=1, guild_id=100)
    assert view.alliance_id == 5

    timeout_btn = next(c for c in view.children if getattr(c, "label", None) == "Session Timeout")
    assert timeout_btn.disabled is False, "settings buttons should be enabled immediately"


def test_vault_settings_view_leaves_multi_alliance_admin_unselected(monkeypatch):
    monkeypatch.setattr(
        bt.PermissionManager, "get_admin_alliances",
        staticmethod(lambda uid, gid: ([(5, "Apex"), (6, "Bravo")], False)),
    )
    cog = SimpleNamespace(alliance_conn=_fake_alliance_conn([(5, "Apex"), (6, "Bravo")]))
    view = bt.VaultSettingsView(cog=cog, original_user_id=1, guild_id=100)
    assert view.alliance_id is None

    timeout_btn = next(c for c in view.children if getattr(c, "label", None) == "Session Timeout")
    assert timeout_btn.disabled is True, "must still require an explicit pick with 2+ alliances"


def test_vault_settings_view_backward_compatible_with_no_guild_id():
    """guild_id defaults to None (old call sites, if any remain) -- must
    not crash and must not auto-select without a guild to resolve against."""
    cog = SimpleNamespace(alliance_conn=_fake_alliance_conn([(5, "Apex")]))
    view = bt.VaultSettingsView(cog=cog, original_user_id=1)
    assert view.alliance_id is None


def test_capitol_settings_view_auto_selects_when_admin_has_one_alliance(monkeypatch):
    monkeypatch.setattr(
        ct.PermissionManager, "get_admin_alliances",
        staticmethod(lambda uid, gid: ([(5, "Apex")], False)),
    )
    cog = SimpleNamespace(alliance_conn=_fake_alliance_conn([(5, "Apex")]))
    view = ct.CapitolSettingsView(cog=cog, original_user_id=1, guild_id=100)
    assert view.alliance_id == 5

    timeout_btn = next(c for c in view.children if getattr(c, "label", None) == "Session Timeout")
    assert timeout_btn.disabled is False


def test_capitol_settings_view_leaves_multi_alliance_admin_unselected(monkeypatch):
    monkeypatch.setattr(
        ct.PermissionManager, "get_admin_alliances",
        staticmethod(lambda uid, gid: ([(5, "Apex"), (6, "Bravo")], False)),
    )
    cog = SimpleNamespace(alliance_conn=_fake_alliance_conn([(5, "Apex"), (6, "Bravo")]))
    view = ct.CapitolSettingsView(cog=cog, original_user_id=1, guild_id=100)
    assert view.alliance_id is None


def test_vault_settings_button_callback_passes_guild_id():
    """Structural guard: the Settings button callback must actually thread
    interaction.guild_id through to VaultSettingsView, not just rely on
    the view's own default."""
    import inspect
    src = inspect.getsource(bt.VaultMenuView.settings)
    assert "guild_id=" in src


def test_capitol_settings_button_callback_passes_guild_id():
    import inspect
    src = inspect.getsource(ct.CapitolMenuView.settings)
    assert "guild_id=" in src
