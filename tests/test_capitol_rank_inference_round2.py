"""Regression tests for Capitol War's rank-inference history, documented in
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md ("Round 2" and
"Round 3").

Round 1 bug: `_finalize_capitol_session` and `capitol_add` each used to run

    for i, row in enumerate(sorted(parsed_rows, key=lambda r: -r['damage']), start=1):
        if row.get('rank') is None:
            row['rank'] = i

which backfilled a MISSING rank with its 1-based position in the
points-sorted list of rows that survived alliance-tag filtering. That
"position/previous-row + 1" style inference is valid for Vault Trap (no
rows are ever filtered out, so adjacent parsed rows really are
rank-adjacent) but not for Capitol War: rows are filtered by alliance tag
before this stage, so the "previous surviving row" is very often NOT
rank-adjacent to the current row -- most of the real ranks between two
kept rows legitimately belong to other alliances and were correctly
discarded, not skipped by mistake. The backfilled number was plausible
looking (small, in-range) but arbitrary, and collided with whatever real
row already held that number -- invisibly, since rank_sequence_warnings
only ever compares rows with rank_explicit=True, and an inferred row is
never explicit.

Round 2 fix: stop backfilling entirely -- any row with no explicit OCR'd
rank digit kept rank=None / rank_explicit=False, no matter what. Safe, but
too blunt: it also killed off inference that has nothing to do with the
Round 1 bug. Within a SINGLE screenshot, before tag filtering, nothing has
been dropped from the sequence yet -- adjacency in the parsed chunk list
really is rank-adjacency, exactly like Vault Trap's own page. Round 2's fix
threw that safe case out along with the unsafe one.

Round 3 fix (current behavior, see `_infer_capitol_ranks` in
cogs/capitol_war.py): rank determination -- both explicit-digit reads and
position-based inference -- now runs on the FULL, unfiltered per-screenshot
chunk list, BEFORE tag filtering removes any row. A row with no explicit
digit is inferred from the nearest chunk (by index distance, either
direction) with a known rank in that SAME image; only a row with no anchor
anywhere in its own screenshot falls back to rank=None. Tag filtering then
carries each surviving row's already-determined rank along -- no
re-inference against the filtered/gappy subset, which is what made Round 1's
version wrong in the first place.

Real examples from the doc's "Round 2"/"Round 3" sections, run through the
actual `parse_capitol_rows` + session-merge pipeline (not synthetic
worst-case text):

- Daddy (IMG_6984): no digit before "Daddy" at all, but WutZa's explicit
  "12" is one chunk later in the SAME image -> infers rank 11.
- Ruri (IMG_6984): no digit before "Ruri" (the wrapped-name fix already
  stops "Nakamura" polluting Ruri's NAME); Kazuha's explicit "13" is one
  chunk earlier and Amanises's explicit "15" is one chunk later -> both
  agree on rank 14.
- ChiefFAFO (IMG_6996): no digit before "ChiefFAFO"; XXX TARGET's explicit
  "72" is one chunk later -> infers rank 71.

None of these may collide with an unrelated real row's rank (Daddy must not
land on Valhalla907's genuine 10, Ruri must not land on Kazuha's genuine 13,
ChiefFAFO must not land on Bake's genuine 44 from a totally different
screenshot) -- the Round 1 bug's exact failure mode.

The genuinely-explicit collisions (Rank 6, Rank 16 -- both sides of the
collision have rank_explicit=True) must still fire exactly as before; this
history must not touch rank_sequence_warnings or its Capitol War call site.
"""
from __future__ import annotations

from harness import bt, ct


# ---------------------------------------------------------------------------
# Raw OCR text, verbatim from the mismatch doc's "Round 2"/"Round 3" section
# (Daddy / Ruri) and its earlier raw-OCR appendix (ChiefFAFO, Kazuha Nakamura
# / Valhalla907 for the collision-partner context). Bake's row has no quoted
# raw OCR excerpt in the doc -- only its review-table values (rank 44,
# points 3,473,237, tag APX) -- so its chunk is synthesized to match those
# documented values exactly, standing in for "some other real screenshot"
# the way the doc describes it ("a completely different screenshot near the
# top of the list").
# ---------------------------------------------------------------------------

RAW_SHOTS = {
    # Valhalla907 explicit rank 10; Daddy immediately after with NO digit
    # (real rank should be 11, between Valhalla907's 10 and WutZa's
    # explicit 12 on the next screenshot). A row is appended after
    # Valhalla907 (WutZa, also explicit, matching IMG_6984 below) purely so
    # Valhalla907 isn't the trailing chunk -- drop_pinned_trailing_row
    # otherwise reads "10 <= 89" as the ranking panel's own-row pin (same
    # fixture technique test_capitol_mismatch_2026_08_23.py uses for
    # ReddXking).
    "IMG_6983_tail": (
        "Rank Chief Points 89 [APX]qlphasix 781,760 "
        "10 [APX]Valhalla907 6,569,772 12 [APX]WutZa 6,408,943"
    ),
    # Daddy (no digit) / WutZa (explicit 12) / Kazuha Nakamura (explicit
    # 13, wraps to two lines) / Ruri (no digit, immediately after the
    # wrapped-name splice) / Amanises (explicit 15). Daddy and Ruri both
    # have a same-image anchor to infer from (WutZa/Kazuha for Daddy;
    # Kazuha and Amanises for Ruri) -- see module docstring.
    "IMG_6984": (
        "Rank Chief Points [APX]Daddy 6,451,998 12 [APX]WutZa 6,408,943 "
        "13 [APX]Kazuha 5,877,477 Nakamura [APX]Ruri 5,846,802 "
        "15 [APX]Amanises 5,786,355"
    ),
    # ChiefFAFO (no digit) / XXX TARGET (explicit 72). ChiefFAFO backward-
    # infers from XXX TARGET, one chunk later in the same image.
    "IMG_6996": (
        "Rank Chief Points [APX]ChiefFAFO 1,791,813 72 [APX]XXX TARGET 1,787,780"
    ),
    # Bake -- synthesized chunk matching the doc's documented rank/points
    # for this row exactly (see module docstring above).
    "IMG_bake_synth": (
        "Rank Chief Points 44 [APX]Bake 3,473,237"
    ),
}


def _merge_session(shots: dict, tag: str = "APX") -> dict:
    """Mirrors CapitolSession.add_message / capitol_add's own merge -- same
    helper as tests/test_capitol_mismatch_2026_08_23.py's `_merge_session`."""
    rows_by_points: dict = {}
    for text in shots.values():
        repaired = bt.repair_ocr_digits(text)
        parsed_rows, _candidates = ct.parse_capitol_rows(repaired, tag)
        for row in parsed_rows:
            key = row["damage"]
            existing = rows_by_points.get(key)
            if existing is None or ct._better_row(existing, row, roster=None):
                rows_by_points[key] = row
    return rows_by_points


def _finalize_like_capitol_add(rows_by_points: dict) -> list[dict]:
    """Reproduces exactly what capitol_add / _finalize_capitol_session do
    with a session's merged rows: `parsed_rows = list(rows_by_points.
    values())`, with no rank backfill loop of any kind -- every row's rank
    was already fully determined inside parse_capitol_rows itself."""
    return list(rows_by_points.values())


def test_daddy_ruri_chieffafo_get_correctly_inferred_same_image_ranks():
    """The three real no-explicit-digit rows from the doc must come out of
    the finalize step with the SAME-IMAGE anchor-inferred rank (11/14/71),
    not None (Round 2 was too blunt) and not a stale filtered-list-position
    guess (the original Round 1 bug)."""
    rows_by_points = _merge_session(RAW_SHOTS)
    parsed_rows = _finalize_like_capitol_add(rows_by_points)
    by_name = {r["name"].strip(): r for r in parsed_rows}

    expected = {"Daddy": 11, "Ruri": 14, "ChiefFAFO": 71}
    for name, want_rank in expected.items():
        assert name in by_name, f"{name}'s row is missing entirely: {parsed_rows}"
        row = by_name[name]
        assert row["rank"] == want_rank, (
            f"{name} should infer rank {want_rank}, got rank={row['rank']!r}"
        )
        assert row["rank_explicit"] is False, (
            f"{name}'s rank was inferred, not OCR'd -- rank_explicit must be False"
        )


def test_daddy_ruri_chieffafo_do_not_collide_with_real_explicit_rows():
    """The specific collisions the Round 1 bug produced must not happen:
    Daddy must not show as #10 (Valhalla907's real rank), Ruri must not
    show as #13 (Kazuha Nakamura's real rank), and ChiefFAFO must not show
    as #44 (Bake's real rank, from a totally different screenshot)."""
    rows_by_points = _merge_session(RAW_SHOTS)
    parsed_rows = _finalize_like_capitol_add(rows_by_points)
    by_name = {r["name"].strip(): r for r in parsed_rows}

    assert by_name["Valhalla907"]["rank"] == 10
    assert by_name["Valhalla907"]["rank_explicit"] is True
    assert by_name["Kazuha"]["rank"] == 13
    assert by_name["Kazuha"]["rank_explicit"] is True
    assert by_name["Bake"]["rank"] == 44
    assert by_name["Bake"]["rank_explicit"] is True

    assert by_name["Daddy"]["rank"] != by_name["Valhalla907"]["rank"]
    assert by_name["Ruri"]["rank"] != by_name["Kazuha"]["rank"]
    assert by_name["ChiefFAFO"]["rank"] != by_name["Bake"]["rank"]


def test_genuinely_anchorless_row_still_shows_no_rank():
    """A row with no explicit digit ANYWHERE in its own screenshot (no
    other row in that image to anchor from at all) must still correctly
    come out as rank=None / rank_explicit=False -- the one case Round 3's
    inference is not supposed to fill in."""
    text = "Rank Chief Points [APX]Solo 100,000"
    repaired = bt.repair_ocr_digits(text)
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")
    assert len(rows) == 1
    assert rows[0]["name"].strip() == "Solo"
    assert rows[0]["rank"] is None
    assert rows[0]["rank_explicit"] is False


def test_review_embed_shows_honest_placeholder_for_genuinely_anchorless_row():
    """The review screen must render "**?**" for a row with no rank at all
    (this file's existing convention for "we don't have confident data
    here", matching how an unmatched/no-roster-match row already renders
    "no match")."""
    text = "Rank Chief Points [APX]Solo 100,000"
    repaired = bt.repair_ocr_digits(text)
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")

    view = ct.CapitolWarReviewView.__new__(ct.CapitolWarReviewView)
    # roster=[] / alliance_id=None keeps _enrich_row's roster-matching and
    # learned-alias lookup paths inert (no DB access needed) -- this test is
    # only about the rank field's display, not name matching.
    view.roster = []
    view.alliance_id = None
    view.rows = [ct.CapitolWarReviewView._enrich_row(view, r) for r in rows]
    ct.resolve_unique_assignments(view.rows, view.roster)
    view._sort_rows()
    view.existing_event_id = None
    view.tag_note = None
    view.alliance_name = "Test Alliance"
    view.event_meta = {"date": "2026-08-23", "event_time": None}
    view.page = 0

    embed = view.build_embed()
    rendered = "\n".join(f.value for f in embed.fields if f.value)

    assert view.rows[0]["rank"] is None
    assert "**?**" in rendered, rendered


def test_duplicate_rank_warnings_still_fire_for_genuinely_explicit_collisions():
    """This history must not touch the still-valid case: two rows that BOTH
    have an explicit OCR'd digit (e.g. the Rank 6 / Rank 16 collisions from
    Round 1) must still be flagged by rank_sequence_warnings. Built
    directly (not from these fixtures, which don't reproduce those
    particular collisions) to isolate exactly the mechanism in play."""
    rows = [
        {"name": "CoolDude1031", "damage": 7_842_127, "rank": 6, "rank_explicit": True},
        {"name": "Merccc", "damage": 6_578_892, "rank": 6, "rank_explicit": True},
        {"name": "Nightmare", "damage": 5_337_431, "rank": 16, "rank_explicit": True},
        {"name": "Juancho Diego", "damage": 4_941_456, "rank": 16, "rank_explicit": True},
    ]
    warnings = ct.rank_sequence_warnings(rows, check_gaps=False)
    assert any("6" in w and "twice" in w for w in warnings), warnings
    assert any("16" in w and "twice" in w for w in warnings), warnings


def test_duplicate_rank_warnings_do_not_fire_for_inferred_vs_explicit_rows():
    """Sanity guard on the flip side: an inferred-rank row (rank_explicit=
    False) sharing a number with a real explicit row must NOT be treated as
    a duplicate -- that's not a genuine OCR collision, it's just two rows
    that happen to hold the same integer, one of which was never actually
    OCR'd. Locks in that rank_sequence_warnings itself correctly ignores
    non-explicit rows, independent of whichever inference produced the
    number on the non-explicit side."""
    rows = [
        {"name": "Valhalla907", "damage": 6_569_772, "rank": 10, "rank_explicit": True},
        {"name": "Daddy", "damage": 6_451_998, "rank": 10, "rank_explicit": False},
    ]
    warnings = ct.rank_sequence_warnings(rows, check_gaps=False)
    assert warnings == [], warnings


def test_no_position_based_rank_backfill_loop_remains_in_capitol_war_source():
    """Structural guard: neither _finalize_capitol_session nor capitol_add
    should contain a filtered-list-position rank backfill assignment --
    that logic (the Round 1 bug) lives nowhere in this cog anymore; all
    rank determination happens inside parse_capitol_rows on the full
    unfiltered per-screenshot list."""
    import inspect
    finalize_src = inspect.getsource(ct.CapitolWar._finalize_capitol_session)
    # capitol_add is wrapped as an app_commands.Command; .callback is the
    # underlying plain function inspect.getsource can read.
    add_src = inspect.getsource(ct.CapitolWar.capitol_add.callback)
    assert "row['rank'] = i" not in finalize_src
    assert "row['rank'] = i" not in add_src
