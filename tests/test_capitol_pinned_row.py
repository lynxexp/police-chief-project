"""Pinned own-row dedup test for Capitol War's Honor Roll parsing.

Every Capitol War screenshot has an extra row at the very bottom showing the
viewer's own entry, out of rank order (see docs/ocr-reference/capitol_war.md
-- "Pinned own-row"). This is the same mechanism already proven for Vault
Trap's ranking pages (tests/test_vault_pinned_row.py) -- Capitol War's row
parser (`parse_capitol_rows`) reuses `drop_pinned_trailing_row` directly
rather than re-implementing this dedup, so this test locks in that reuse
actually works end-to-end through the tag-filtering pipeline too."""
from __future__ import annotations

from harness import ct


# Mirrors the reference doc's literal example: "1 [APX]Lynx 12,780,331 (!)"
# pinned at the bottom of every page, here appended after a normal run of
# higher (worse) ranks -- rank 1 appearing after rank 99 is the out-of-order
# signal that triggers the drop.
HONOR_ROLL_WITH_PIN = (
    "Honor Roll Rank Chief Points "
    "95 [APX]momo 556,937 "
    "96 [APX]5StarGeneral 556,728 "
    "97 [APX]DAMIAN29DANMILLE 542,944 "
    "98 [APX]legoman 502,133 "
    "99 [APX]Champ134 457,781 "
    "1 [APX]Lynx 12,780,331"
)

# Same page, but the pinned row is for a DIFFERENT alliance (a rival's own
# viewer would see their own pin) -- included so the dedup is proven to run
# on raw rank order, independent of tag filtering having happened yet.
HONOR_ROLL_WITH_PIN_MIXED_TAGS = (
    "Honor Roll Rank Chief Points "
    "95 [FOH]momo 556,937 "
    "96 [S42]5StarGeneral 556,728 "
    "97 [L4W]DAMIAN29DANMILLE 542,944 "
    "98 [Yns]legoman 502,133 "
    "99 [APX]Champ134 457,781 "
    "1 [APX]Lynx 12,780,331"
)


def test_pinned_own_row_dropped_from_capitol_rankings():
    """The pinned rank-1 self-row trailing after rank 99 must not survive as
    a phantom extra row -- same pattern vault_track.parse_player_rows
    already handles, reused here via drop_pinned_trailing_row."""
    rows, total_candidates = ct.parse_capitol_rows(HONOR_ROLL_WITH_PIN, "APX")
    ranks = [r["rank"] for r in rows]
    points = [r["damage"] for r in rows]
    assert 1 not in ranks, f"pinned self-row (rank 1) leaked: {rows}"
    assert 12_780_331 not in points, f"pinned self-row's points leaked: {rows}"
    assert len(rows) == 5 and ranks[-1] == 99, f"unexpected rows: {rows}"
    # total_candidates already reflects the dedup (pinned row dropped before
    # the tag-filter count is taken), so it should equal the 5 real rows.
    assert total_candidates == 5, f"expected 5 candidates after pin-drop, got {total_candidates}"


def test_pinned_row_dedup_runs_before_tag_filter_sees_it():
    """Even when the state-wide page mixes several rival tags around the
    pin, the pinned row is still recognized and dropped by rank order alone
    -- tag filtering happens afterward and never gets a chance to keep or
    discard it as a 'real' cross-alliance row."""
    rows, total_candidates = ct.parse_capitol_rows(HONOR_ROLL_WITH_PIN_MIXED_TAGS, "APX")
    # Only rank 99 (Champ134, [APX]) should survive -- the rival rows are
    # tag-filtered out, and the pinned rank-1 [APX]Lynx row is dropped by
    # the pin dedup before it would otherwise have survived tag filtering.
    assert len(rows) == 1, f"expected exactly 1 surviving APX row, got: {rows}"
    assert rows[0]["rank"] == 99
    assert rows[0]["name"].strip() == "Champ134"
    # 5 candidates total after pin-drop (4 rival tags + 1 APX), before the
    # tag filter narrows it down to the 1 APX row above.
    assert total_candidates == 5


def test_drop_pinned_trailing_row_is_the_shared_vault_track_function():
    """Structural guard against silent re-implementation: capitol_war.py
    must be calling vault_track's actual drop_pinned_trailing_row, not a
    lookalike copy -- see cogs/capitol_war.py's imports."""
    import cogs.vault_track as vault_track
    import cogs.capitol_war as capitol_war
    assert capitol_war.drop_pinned_trailing_row is vault_track.drop_pinned_trailing_row
