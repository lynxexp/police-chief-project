"""Coverage for the three VaultDamageEditView safety/UX fixes:

1. Delete Hunt requires a Confirm/Cancel step before the DB rows actually
   disappear (previously a single click deleted immediately).
2. Editing a hunt to a colliding (alliance_id, date, trap_number) surfaces a
   clear, actionable message instead of the generic "Failed to save record."
3. The hunt-list dropdown paginates past the first 25 hunts instead of
   making hunt #26+ permanently unreachable.

Drives the real DB-backed code paths (VaultDamageEditView, its delete-confirm
view, and RecordEditModal) against a temp sqlite file, same style as
test_vault_persist_no_deadlock.py — no Discord gateway/bot needed.
"""
from __future__ import annotations

import asyncio
import sqlite3
from types import SimpleNamespace

from harness import bt

import cogs.attendance_ocr_parsers as attendance_ocr_parsers


def _interaction(user_id=1):
    sent = []
    edits = []

    async def send_message(*a, **k):
        sent.append((a, k))

    async def edit_message(*a, **k):
        edits.append((a, k))

    inter = SimpleNamespace(
        user=SimpleNamespace(id=user_id),
        response=SimpleNamespace(
            send_message=send_message,
            edit_message=edit_message,
            is_done=lambda: False,
        ),
    )
    return inter, sent, edits


def _make_view(tmp_path, monkeypatch, alliance_id=7):
    vault_db = tmp_path / "vault_data.sqlite"
    monkeypatch.setattr(bt, "VAULT_DB_PATH", str(vault_db))
    bt.init_vault_database()

    conn = sqlite3.connect(str(vault_db), check_same_thread=False)
    cursor = conn.cursor()
    cog = SimpleNamespace(vault_cursor=cursor, vault_conn=conn)

    # The real delete path also cleans up a linked attendance event via a
    # module-level helper in a different db file — stub it out so the test
    # never touches the repo's real db/attendance.sqlite.
    monkeypatch.setattr(attendance_ocr_parsers, "delete_vault_attendance_event", lambda hunt_id: None)

    view = bt.VaultDamageEditView(cog, original_user_id=1, alliance_id=alliance_id)
    view.can_manage = True
    return view, cog, conn, cursor


def _insert_hunt(cursor, conn, *, alliance_id, date, trap_number, rallies=10, total_damage=500000):
    cursor.execute(
        "INSERT INTO vault_hunts (alliance_id, date, trap_number, rallies, total_damage) "
        "VALUES (?, ?, ?, ?, ?)",
        (alliance_id, date, trap_number, rallies, total_damage),
    )
    conn.commit()
    return cursor.lastrowid


def _insert_player(cursor, conn, *, hunt_id, fid, name, damage, rank):
    cursor.execute(
        "INSERT INTO vault_player_damage (hunt_id, fid, raw_name, resolved_nickname, damage, rank) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (hunt_id, fid, name, name, damage, rank),
    )
    conn.commit()


def _counts(cursor, hunt_id):
    hunts = cursor.execute("SELECT COUNT(*) FROM vault_hunts WHERE id = ?", (hunt_id,)).fetchone()[0]
    players = cursor.execute(
        "SELECT COUNT(*) FROM vault_player_damage WHERE hunt_id = ?", (hunt_id,)).fetchone()[0]
    return hunts, players


# ---------------------------------------------------------------------------
# Gap 1 — delete confirmation
# ---------------------------------------------------------------------------

def test_delete_hunt_click_does_not_delete_immediately(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-01", trap_number=1)
    _insert_player(cursor, conn, hunt_id=hunt_id, fid=100, name="Alice", damage=1000, rank=1)
    _insert_player(cursor, conn, hunt_id=hunt_id, fid=101, name="Bob", damage=900, rank=2)

    view._load_records()
    view._select_record(hunt_id)

    inter, sent, edits = _interaction()
    asyncio.run(view._on_delete(inter))

    # Nothing deleted yet — a confirm/cancel view must be shown instead.
    assert _counts(cursor, hunt_id) == (1, 2)
    assert len(edits) == 1
    shown_view = edits[0][1].get("view")
    assert isinstance(shown_view, bt.VaultDeleteHuntConfirmView)
    shown_embed = edits[0][1].get("embed")
    # The confirm prompt must state what will be lost, including the row count.
    assert "2" in shown_embed.description
    assert "Trap 1" in shown_embed.description


def test_delete_hunt_confirm_button_deletes(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-01", trap_number=1)
    _insert_player(cursor, conn, hunt_id=hunt_id, fid=100, name="Alice", damage=1000, rank=1)

    view._load_records()
    view._select_record(hunt_id)

    inter, _, edits = _interaction()
    asyncio.run(view._on_delete(inter))
    confirm_view = edits[0][1]["view"]

    confirm_btn = next(c for c in confirm_view.children if c.label == "Confirm Delete")
    inter2, _, edits2 = _interaction()
    asyncio.run(confirm_btn.callback(inter2))

    assert _counts(cursor, hunt_id) == (0, 0)
    # Back on the (now empty) hunt view.
    assert edits2[0][1]["view"] is view


def test_delete_hunt_cancel_button_leaves_data_intact(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    hunt_id = _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-01", trap_number=1)
    _insert_player(cursor, conn, hunt_id=hunt_id, fid=100, name="Alice", damage=1000, rank=1)

    view._load_records()
    view._select_record(hunt_id)

    inter, _, edits = _interaction()
    asyncio.run(view._on_delete(inter))
    confirm_view = edits[0][1]["view"]

    cancel_btn = next(c for c in confirm_view.children if c.label == "Cancel")
    inter2, _, edits2 = _interaction()
    asyncio.run(cancel_btn.callback(inter2))

    assert _counts(cursor, hunt_id) == (1, 1)
    assert view.selected_record_id == hunt_id  # selection preserved
    assert edits2[0][1]["view"] is view


# ---------------------------------------------------------------------------
# Gap 2 — colliding (alliance_id, date, trap_number) on edit
# ---------------------------------------------------------------------------

def test_edit_hunt_to_colliding_date_trap_shows_clear_message(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    other_id = _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-01", trap_number=1)
    target_id = _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-08", trap_number=1)

    view._load_records()
    view._select_record(target_id)

    modal = bt.RecordEditModal(view)
    # Simulate the admin retyping the date to collide with the other hunt's
    # (alliance_id, date, trap_number). TextInput.value has no public setter
    # (Discord sets it via the real modal-submit payload); poke the backing
    # field the same way the library populates it.
    modal.date_input._value = "2026-06-01"
    modal.trap_number_input._value = "1"
    modal.rallies_input._value = str(view.rallies)
    modal.total_damage_input._value = str(view.total_damage)

    inter, sent, edits = _interaction()
    asyncio.run(modal.on_submit(inter))

    assert len(sent) == 1
    message = sent[0][0][0] if sent[0][0] else sent[0][1].get("content", "")
    assert "Failed to save record." not in message
    assert "already" in message.lower()

    # The target hunt's row must be unchanged (update rolled back, not partially applied).
    row = cursor.execute(
        "SELECT date, trap_number FROM vault_hunts WHERE id = ?", (target_id,)).fetchone()
    assert row == ("2026-06-08", 1)
    # Both hunts still present.
    assert cursor.execute("SELECT COUNT(*) FROM vault_hunts WHERE alliance_id = 7").fetchone()[0] == 2


# ---------------------------------------------------------------------------
# Gap 3 — hunt-list pagination past the first 25
# ---------------------------------------------------------------------------

def test_hunt_list_paginates_past_25(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    # 30 hunts, alternating trap 1/2 so (alliance_id, date, trap_number) stays unique.
    hunt_ids = []
    for i in range(30):
        hunt_ids.append(_insert_hunt(
            cursor, conn, alliance_id=7,
            date=f"2026-01-{i + 1:02d}", trap_number=(i % 2) + 1))

    view._load_records()
    assert len(view._records) == 30
    assert view._total_record_pages() == 2
    assert view.record_page == 0

    # Page 1 (today's behavior): the 25 newest hunts (date DESC), oldest-first
    # of those 30 excluded. date desc means Jan 30 is first-listed, so page 1
    # holds days 30..6, page 2 holds days 5..1.
    view._build_components()
    page1_values = {opt.value for opt in view.date_trap_select.options}
    assert len(page1_values) == 25
    # The 5 oldest hunts (days 1-5) must NOT be reachable on page 1...
    oldest_five_ids = {str(hid) for hid in hunt_ids[:5]}
    assert page1_values.isdisjoint(oldest_five_ids)
    prev_btn = next(c for c in view.children if getattr(c, "row", None) == 1 and c.label == "Prev")
    next_btn = next(c for c in view.children if getattr(c, "row", None) == 1 and c.label == "Next")
    assert prev_btn.disabled is True   # page 1 of 2 — can't go further back
    assert next_btn.disabled is False

    # ...until Next is clicked, which must make them reachable.
    inter, _, edits = _interaction()
    asyncio.run(view._on_record_next(inter))
    assert view.record_page == 1
    page2_values = {opt.value for opt in view.date_trap_select.options}
    assert len(page2_values) == 5
    assert page2_values == oldest_five_ids

    prev_btn2 = next(c for c in view.children if getattr(c, "row", None) == 1 and c.label == "Prev")
    next_btn2 = next(c for c in view.children if getattr(c, "row", None) == 1 and c.label == "Next")
    assert prev_btn2.disabled is False
    assert next_btn2.disabled is True  # last page — can't go further forward

    # And an oldest-page hunt is now actually selectable.
    view._select_record(hunt_ids[0])
    assert view.selected_record_id == hunt_ids[0]


def test_hunt_list_single_page_shows_no_pagination_buttons(tmp_path, monkeypatch):
    view, cog, conn, cursor = _make_view(tmp_path, monkeypatch)
    _insert_hunt(cursor, conn, alliance_id=7, date="2026-06-01", trap_number=1)
    view._load_records()
    view._build_components()
    assert view._total_record_pages() == 1
    assert not any(getattr(c, "row", None) == 1 for c in view.children)
