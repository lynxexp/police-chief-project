"""Regression tests for the /restore command (cogs/bot_backup.py) -- the
most destructive single action in this bot (it can overwrite every
alliance's data, all at once, including the admin/adminserver tables that
determine who the Bot Owner even is). Coverage focuses on the three real
safety properties the design promises:

1. Nothing under db/ is ever touched until Confirm is explicitly clicked
   (validation writes only into a caller-owned temp staging directory).
2. A validation failure (bad zip, zip-slip attempt, corrupt file, wrong
   password, empty zip) always raises ValueError with zero partial writes
   -- not a different exception type, not some files written and others
   not.
3. Confirm always takes a fresh safety backup of CURRENT data first, and
   aborts with nothing written if that safety backup itself fails.

Also covers the Owner-only gating (stricter than every other admin action
in this bot) and that it reuses BotHealth.perform_restart for the actual
restart step rather than duplicating that platform-aware logic."""
from __future__ import annotations

import asyncio
import importlib
import os
import shutil
import sqlite3
import tempfile
import zipfile
from types import SimpleNamespace

import pyzipper

bb = importlib.import_module("cogs.bot_backup")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_sqlite_file(path, table="t"):
    conn = sqlite3.connect(path)
    conn.execute(f"CREATE TABLE {table} (id INTEGER)")
    conn.execute(f"INSERT INTO {table} VALUES (1)")
    conn.commit()
    conn.close()


def _make_zip(tmp_path, entries: dict, *, password=None, readme=True):
    """entries: {arcname: local_sqlite_path_or_None}. None means write a
    valid throwaway sqlite file under that name."""
    zip_path = str(tmp_path / "backup.zip")
    real_paths = {}
    for name, src in entries.items():
        if src is None:
            p = str(tmp_path / f"_src_{name}")
            _make_sqlite_file(p)
            real_paths[name] = p
        else:
            real_paths[name] = src

    if password:
        with pyzipper.AESZipFile(zip_path, 'w', compression=pyzipper.ZIP_LZMA,
                                  encryption=pyzipper.WZ_AES) as zf:
            zf.setpassword(password.encode())
            for name, src in real_paths.items():
                zf.write(src, name)
            if readme:
                zf.writestr("README.txt", "hi")
    else:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for name, src in real_paths.items():
                zf.write(src, name)
            if readme:
                zf.writestr("README.txt", "hi")
    return zip_path


def _cog(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "db").mkdir(exist_ok=True)
    (tmp_path / "backups").mkdir(exist_ok=True)
    cog = bb.BackupOperations.__new__(bb.BackupOperations)
    cog.bot = SimpleNamespace(get_cog=lambda name: None)
    cog.db_path = str(tmp_path / "db" / "backup.sqlite")
    cog.backup_dir = str(tmp_path / "backups")
    cog.setup_database()
    return cog


# ---------------------------------------------------------------------------
# _validate_and_extract_restore_zip -- the core validation logic
# ---------------------------------------------------------------------------

def test_extracts_valid_files_and_ignores_readme(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None, "users.sqlite": None})
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    names, missing = cog._validate_and_extract_restore_zip(zip_path, None, dest)

    assert names == ["alliance.sqlite", "users.sqlite"]
    assert os.path.exists(os.path.join(dest, "alliance.sqlite"))
    assert not os.path.exists(os.path.join(dest, "README.txt"))


def test_reports_files_missing_from_the_backup(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    # _cog() itself creates db/backup.sqlite (BackupOperations.setup_database),
    # so that's already a "current" file alongside these two.
    _make_sqlite_file(str(tmp_path / "db" / "alliance.sqlite"))
    _make_sqlite_file(str(tmp_path / "db" / "users.sqlite"))
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None})
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    names, missing = cog._validate_and_extract_restore_zip(zip_path, None, dest)

    assert names == ["alliance.sqlite"]
    assert missing == ["backup.sqlite", "users.sqlite"]


def test_rejects_zip_with_no_sqlite_files(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = str(tmp_path / "empty.zip")
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr("README.txt", "nothing here")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(zip_path, None, dest)
        assert False, "must raise"
    except ValueError as e:
        assert "no .sqlite" in str(e)
    assert os.listdir(dest) == [], "nothing should be written for an empty zip"


def test_rejects_path_traversal_entry_and_writes_nothing(tmp_path, monkeypatch):
    """A zip-slip attempt (a path-separator or '..' in the entry name)
    must reject the WHOLE zip, before ANY file -- including the other,
    otherwise-legitimate entries -- gets written."""
    cog = _cog(tmp_path, monkeypatch)
    good_src = str(tmp_path / "_good.sqlite")
    _make_sqlite_file(good_src)
    zip_path = str(tmp_path / "evil.zip")
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.write(good_src, "alliance.sqlite")  # legitimate entry, written first
        zf.writestr("../../evil.sqlite", "malicious")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(zip_path, None, dest)
        assert False, "must raise"
    except ValueError as e:
        assert "unexpected entry" in str(e)
    assert os.listdir(dest) == [], (
        "the legitimate entry must NOT have been written either -- "
        "name validation runs fully before any writing starts"
    )


def test_rejects_subdirectory_entry(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = str(tmp_path / "subdir.zip")
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr("sub/alliance.sqlite", "data")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(zip_path, None, dest)
        assert False, "must raise"
    except ValueError:
        pass
    assert os.listdir(dest) == []


def test_rejects_corrupt_non_sqlite_content(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = str(tmp_path / "corrupt.zip")
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr("alliance.sqlite", b"this is not a real sqlite file at all")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(zip_path, None, dest)
        assert False, "must raise ValueError, not sqlite3.DatabaseError"
    except ValueError as e:
        assert "not a valid SQLite database" in str(e)
    except sqlite3.DatabaseError:
        assert False, "must be normalized to ValueError, not leak sqlite3.DatabaseError"


def test_encrypted_zip_requires_correct_password(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None}, password="hunter2")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    names, _ = cog._validate_and_extract_restore_zip(zip_path, "hunter2", dest)
    assert names == ["alliance.sqlite"]


def test_encrypted_zip_wrong_password_raises_valueerror(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None}, password="hunter2")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(zip_path, "wrongpass", dest)
        assert False, "must raise"
    except ValueError:
        pass
    assert os.listdir(dest) == []


def test_not_a_zip_at_all_raises_valueerror(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    junk_path = str(tmp_path / "junk.zip")
    with open(junk_path, "wb") as f:
        f.write(b"not a zip file")
    dest = tempfile.mkdtemp(dir=str(tmp_path))

    try:
        cog._validate_and_extract_restore_zip(junk_path, None, dest)
        assert False, "must raise"
    except ValueError:
        pass


# ---------------------------------------------------------------------------
# /restore command -- entry-point gating and staging behavior
# ---------------------------------------------------------------------------

class FakeAttachment:
    def __init__(self, filename, content_path):
        self.filename = filename
        self.size = os.path.getsize(content_path)
        self._content_path = content_path

    async def save(self, path):
        shutil.copyfile(self._content_path, path)


def _interaction(user_id):
    sent = []

    async def defer(*a, **k):
        pass

    async def followup_send(*a, **k):
        sent.append((a, k))

    return SimpleNamespace(
        user=SimpleNamespace(id=user_id),
        response=SimpleNamespace(defer=defer, is_done=lambda: True),
        followup=SimpleNamespace(send=followup_send),
    ), sent


def test_restore_denies_non_owner(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: False))
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None})
    attachment = FakeAttachment("backup.zip", zip_path)
    inter, sent = _interaction(user_id=1)

    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))
    inter.response.send_message = send_message

    asyncio.run(bb.BackupOperations.restore.callback(cog, inter, attachment, None))

    assert denied and "Owner" in str(denied[0])
    assert sent == []


def test_restore_rejects_non_zip_filename(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)
    real = str(tmp_path / "notazip.txt")
    with open(real, "w") as f:
        f.write("x")
    attachment = FakeAttachment("backup.txt", real)
    inter, sent = _interaction(user_id=1)
    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))
    inter.response.send_message = send_message

    asyncio.run(bb.BackupOperations.restore.callback(cog, inter, attachment, None))

    assert denied and ".zip" in str(denied[0])


def test_restore_rejects_oversized_file(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    monkeypatch.setattr(bb, "_RESTORE_MAX_UPLOAD_BYTES", 10)
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None})
    attachment = FakeAttachment("backup.zip", zip_path)
    inter, sent = _interaction(user_id=1)
    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))
    inter.response.send_message = send_message

    asyncio.run(bb.BackupOperations.restore.callback(cog, inter, attachment, None))

    assert denied and "too large" in str(denied[0]).lower()


def test_restore_valid_zip_sends_confirmation_view(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)
    zip_path = _make_zip(tmp_path, {"alliance.sqlite": None})
    attachment = FakeAttachment("backup.zip", zip_path)
    inter, sent = _interaction(user_id=1)

    asyncio.run(bb.BackupOperations.restore.callback(cog, inter, attachment, None))

    assert len(sent) == 1
    _args, kwargs = sent[0]
    assert isinstance(kwargs["view"], bb._RestoreConfirmView)
    assert kwargs["view"].restored_names == ["alliance.sqlite"]
    assert os.path.isdir(kwargs["view"].stage_dir)


def test_restore_invalid_zip_cleans_up_and_reports_error(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)
    zip_path = str(tmp_path / "empty.zip")
    with zipfile.ZipFile(zip_path, 'w') as zf:
        zf.writestr("README.txt", "nothing")
    attachment = FakeAttachment("backup.zip", zip_path)
    inter, sent = _interaction(user_id=1)

    asyncio.run(bb.BackupOperations.restore.callback(cog, inter, attachment, None))

    assert len(sent) == 1
    assert "no .sqlite" in str(sent[0]).lower() or "sqlite" in str(sent[0]).lower()


# ---------------------------------------------------------------------------
# _RestoreConfirmView -- the actual destructive step
# ---------------------------------------------------------------------------

def _stage_with_file(tmp_path, name="alliance.sqlite"):
    stage_dir = tempfile.mkdtemp(dir=str(tmp_path))
    _make_sqlite_file(os.path.join(stage_dir, name))
    return stage_dir, [name]


def test_confirm_wrong_viewer_denied(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))

    inter = SimpleNamespace(user=SimpleNamespace(id=999), response=SimpleNamespace(send_message=send_message))
    asyncio.run(view.confirm.callback(inter))

    assert denied and "someone else" in str(denied[0]).lower()
    assert os.path.isdir(stage_dir), "must not clean up or act on a denied click"


def test_confirm_reverifies_owner_at_click_time(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: False))
    cog = _cog(tmp_path, monkeypatch)
    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    denied = []

    async def send_message(*a, **k):
        denied.append((a, k))

    inter = SimpleNamespace(user=SimpleNamespace(id=1), response=SimpleNamespace(send_message=send_message))
    asyncio.run(view.confirm.callback(inter))

    assert denied and "Owner" in str(denied[0])
    assert not os.path.exists(os.path.join("db", "alliance.sqlite"))


def test_confirm_aborts_if_safety_backup_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)

    async def failing_backup(*a, **k):
        return None
    cog.create_backup = failing_backup

    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    async def edit_original_response(*a, **k):
        edits.append((a, k))

    inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        response=SimpleNamespace(edit_message=edit_message),
        edit_original_response=edit_original_response,
    )
    asyncio.run(view.confirm.callback(inter))

    assert not os.path.exists(os.path.join("db", "alliance.sqlite")), (
        "must not write restored files if the safety backup itself failed"
    )
    assert not os.path.isdir(stage_dir), "staging dir should still be cleaned up"
    assert any("Aborted" in e[1]["embed"].title for e in edits)


def test_confirm_success_writes_files_and_calls_perform_restart(tmp_path, monkeypatch):
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)

    async def ok_backup(*a, **k):
        return "pre_restore_safety_20260824.zip"
    cog.create_backup = ok_backup

    restart_calls = []

    async def fake_perform_restart(interaction):
        restart_calls.append(interaction)

    health_cog = SimpleNamespace(perform_restart=fake_perform_restart)
    cog.bot = SimpleNamespace(get_cog=lambda name: health_cog if name == "BotHealth" else None)

    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    async def edit_message(*a, **k):
        pass

    inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        response=SimpleNamespace(edit_message=edit_message),
    )
    asyncio.run(view.confirm.callback(inter))

    assert os.path.exists(os.path.join("db", "alliance.sqlite")), "restored file must be written into db/"
    assert not os.path.isdir(stage_dir), "staging dir must be cleaned up after a successful write"
    assert restart_calls == [inter], "must hand off to BotHealth.perform_restart with the confirm interaction"


def test_confirm_falls_back_gracefully_without_bot_health_cog(tmp_path, monkeypatch):
    """If BotHealth isn't loaded for some reason, still complete the write
    and tell the admin to restart manually, rather than crashing."""
    monkeypatch.setattr(bb.PermissionManager, "is_owner", staticmethod(lambda uid: True))
    cog = _cog(tmp_path, monkeypatch)

    async def ok_backup(*a, **k):
        return "safety.zip"
    cog.create_backup = ok_backup
    cog.bot = SimpleNamespace(get_cog=lambda name: None)

    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    async def edit_original_response(*a, **k):
        edits.append((a, k))

    inter = SimpleNamespace(
        user=SimpleNamespace(id=1),
        response=SimpleNamespace(edit_message=edit_message),
        edit_original_response=edit_original_response,
    )
    asyncio.run(view.confirm.callback(inter))

    assert os.path.exists(os.path.join("db", "alliance.sqlite"))
    assert any("Restore Complete" in e[1]["embed"].title for e in edits)


def test_cancel_cleans_up_without_writing(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    edits = []

    async def edit_message(*a, **k):
        edits.append((a, k))

    inter = SimpleNamespace(user=SimpleNamespace(id=1), response=SimpleNamespace(edit_message=edit_message))
    asyncio.run(view.cancel.callback(inter))

    assert not os.path.exists(os.path.join("db", "alliance.sqlite"))
    assert not os.path.isdir(stage_dir)
    assert edits and "Cancelled" in edits[0][1]["embed"].title


def test_timeout_cleans_up_unresolved_staging_dir(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)

    asyncio.run(view.on_timeout())

    assert not os.path.isdir(stage_dir)


def test_timeout_does_not_touch_an_already_resolved_view(tmp_path, monkeypatch):
    cog = _cog(tmp_path, monkeypatch)
    stage_dir, names = _stage_with_file(tmp_path)
    view = bb._RestoreConfirmView(cog, viewer_id=1, stage_dir=stage_dir, restored_names=names)
    view._resolved = True
    os.makedirs(stage_dir, exist_ok=True)  # simulate it still existing post-resolve

    asyncio.run(view.on_timeout())

    assert os.path.isdir(stage_dir), "must not double-cleanup / touch a view that already resolved"
