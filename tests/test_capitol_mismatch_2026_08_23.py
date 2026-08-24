"""Regression tests for the real 19-screenshot Capitol War mismatch
documented in docs/ocr-reference/capitol_war_mismatch_2026-08-23.md --
"duplicating numbers and getting some out of order" in the review screen.

Raw OCR text below is pulled verbatim from that doc's `log/bot.txt`
excerpts (a representative subset of the real 19 screenshots, covering
every disputed row) and run through the actual parsing/merge pipeline --
not synthetic worst-case text.

Three distinct bugs, three test groups:

1. The review list must be ordered by points (descending), not by the
   OCR'd rank digit -- a misread rank (e.g. real rank 90 OCR'd as "06",
   which `int("06")` collapses to 6) must not scramble display order or
   collide with an unrelated row at that same small number.
2. rank_sequence_warnings' duplicate detection must fire for genuine
   cross-screenshot rank collisions, without being swamped by false
   "missing" gap warnings -- Capitol War rows are a tag-filtered SUBSET of
   a state-wide ranking, so most rank numbers between this alliance's
   min/max legitimately belong to other alliances and are not "missing".
3. A two-line wrapped name (e.g. "Kazuha Nakamura") splices the points
   value between its two lines; the trailing wrapped word must not leak
   onto the front of the NEXT row's chunk and corrupt that row's name.
"""
from __future__ import annotations

from harness import bt, ct


# ---------------------------------------------------------------------------
# Raw OCR text per screenshot, verbatim from the mismatch doc's `log/bot.txt`
# excerpts -- a representative subset of the real 19-screenshot session
# covering every row the doc calls out as disputed.
# ---------------------------------------------------------------------------

RAW_SHOTS = {
    # Ranks 1/2/4 have no explicit digit at all (rely on other screenshots /
    # the review's own inference); 3 and 5 are explicit.
    "IMG_6982": (
        "Rank Chief Points [APX]Lynx 12,780,331 [APX]LTC 11,792,466 "
        "3 [APX]Tony Montana 11,119,046 [APX]Jesslyn 8,833,752 "
        "5 [APX]Chief3e6e6ee0 8,620,267"
    ),
    # CoolDude1031's real rank is 6 (explicit, correct). Merccc's real rank
    # is 9 but OCR read "6" again -- a 9/6 digit confusion.
    "IMG_6983": (
        "Rank Chief Points 6 [APX]CoolDude1031 7,842,127 "
        "[APX]FrankSloup 7,128,968 8 [542]hamadona 7,021,456 "
        "6 [APX]Merccc 6,578,892 10 [APX]Valhalla907 6,569,772"
    ),
    # ReddXking's real rank is 90 (sequence 86..90); OCR read "06", which
    # int("06") collapses to 6 -- colliding with CoolDude1031 and Merccc
    # above despite this row's points (626,162) being nowhere near theirs.
    # The doc's raw excerpt trails off with "..." after this row (more real
    # rows follow in the actual screenshot) -- a trailing row is kept here
    # too so ReddXking's garbled-to-6 rank isn't mistaken by
    # drop_pinned_trailing_row for a legitimate pinned-own-row (which is
    # recognized by exactly this shape: last chunk's rank <= the previous
    # chunk's rank). Truncating the fixture right at ReddXking would be an
    # unrealistic screenshot boundary that the real image doesn't have.
    "IMG_6999": (
        "Rank Chief Points 86 [L4W]AIaa Ztn 851,552 87 [BOO]julink 820,264 "
        "88 [L4W]nightfire 813,282 89 [APX]qlphasix 781,760 "
        "06 [APX]ReddXking 626,162 91 [FOH]NextPerson 620,000"
    ),
    # Baba's real rank is 91 (continues the 86-95 sequence); OCR read "11".
    "IMG_7001": (
        "Rank Chief Points 11 [APX]Baba 598,307 92 [F0H]Kopassus Elite 597,041 "
        "93 [L4W]Chief Tenpenny 589,026 76 [542]0sadolor 588,774 "
        "95 [FOH]momo 556,937"
    ),
    # Juancho Diego's real rank is 19 (sequence 16,17,18,19,20); OCR read
    # "16" again -- another 9/6 confusion, colliding with Nightmare's
    # genuine rank 16.
    "IMG_6985": (
        "Rank Chief Points 16 [APX]Nightmare 5,337,431 "
        "17 [L4W]Chief Iuna 5,316,378 18 [APX]Zizi 5,076,417 "
        "16 [APX]Juancho Diego 4,941,456 20 [APX]Andrew21 4,937,814"
    ),
    # "Kazuha Nakamura" wraps to two lines; the points value gets OCR'd
    # between them ("Kazuha 5,877,477 Nakamura"), and the trailing word
    # "Nakamura" leaks onto the front of the next chunk, ahead of Ruri's
    # own tag ("Nakamura [APX]Ruri").
    "IMG_6984": (
        "Rank Chief Points [APX]Daddy 6,451,998 12 [APX]WutZa 6,408,943 "
        "13 [APX]Kazuha 5,877,477 Nakamura [APX]Ruri 5,846,802 "
        "15 [APX]Amanises 5,786,355"
    ),
}


def _merge_session(shots: dict, tag: str = "APX") -> dict:
    """Mirrors CapitolSession.add_message / capitol_add's own merge: OCR
    each screenshot's raw text, parse+tag-filter its rows, fold into one
    flat rows_by_points dict via the same _better_row tiebreaker the real
    session/command code uses."""
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


# ---------------------------------------------------------------------------
# Bug 1: points-descending order, not rank
# ---------------------------------------------------------------------------

def test_merged_session_rows_sort_by_points_not_garbled_rank():
    """The real symptom: ReddXking's row (626,162 points, rank garbled to
    6) must sort near the bottom of the list, not next to CoolDude1031/
    Merccc's ~7M/~6.5M-point rows just because they share a corrupted rank
    label. Points-descending order settles this regardless of what the
    rank field says."""
    rows_by_points = _merge_session(RAW_SHOTS)
    ordered = sorted(rows_by_points.values(), key=lambda r: -r["damage"])
    ordered_names = [r["name"].strip() for r in ordered]

    reddx_idx = ordered_names.index("ReddXking")
    cooldude_idx = ordered_names.index("CoolDude1031")
    merccc_idx = ordered_names.index("Merccc")
    qlphasix_idx = ordered_names.index("qlphasix")
    baba_idx = ordered_names.index("Baba")

    # ReddXking (626,162 pts) belongs down near qlphasix (781,760) and
    # Baba (598,307) -- the other genuinely low-point rows -- not up next
    # to the ~7M-point rows sharing its corrupted rank label.
    assert reddx_idx > cooldude_idx and reddx_idx > merccc_idx
    assert abs(reddx_idx - qlphasix_idx) <= 2 or abs(reddx_idx - baba_idx) <= 2

    # And the list truly is points-descending end to end.
    points = [r["damage"] for r in ordered]
    assert points == sorted(points, reverse=True)


def test_capitol_war_review_view_sort_rows_uses_points_not_rank():
    """Structural guard directly on CapitolWarReviewView._sort_rows -- must
    key on points descending, not the OCR'd rank field. Built via __new__
    (no live cog/Discord needed) since _sort_rows only touches self.rows."""
    view = ct.CapitolWarReviewView.__new__(ct.CapitolWarReviewView)
    view.rows = [
        {"name": "CoolDude1031", "damage": 7_842_127, "rank": 6, "rank_explicit": True},
        {"name": "Merccc", "damage": 6_578_892, "rank": 6, "rank_explicit": True},
        {"name": "ReddXking", "damage": 626_162, "rank": 6, "rank_explicit": True},
        {"name": "Baba", "damage": 598_307, "rank": 11, "rank_explicit": True},
    ]
    view._sort_rows()
    assert [r["name"] for r in view.rows] == [
        "CoolDude1031", "Merccc", "ReddXking", "Baba",
    ], view.rows
    # rank field is preserved on the rows -- not discarded, just not the
    # sort key.
    assert all(r["rank"] is not None for r in view.rows)


# ---------------------------------------------------------------------------
# Bug 2: rank_sequence_warnings duplicate detection, without the gap-noise
# flood a tag-filtered subset of a state-wide ranking would otherwise cause.
# ---------------------------------------------------------------------------

def test_capitol_war_review_embed_calls_rank_sequence_warnings_without_gaps():
    """Structural guard: CapitolWarReviewView.build_embed must call the
    shared rank_sequence_warnings with check_gaps=False, since Capitol
    War's rows are a tag-filtered subset of a state-wide ranking (most
    numbers between this alliance's min/max rank legitimately belong to
    other alliances, not "missing")."""
    import inspect
    src = inspect.getsource(ct.CapitolWarReviewView.build_embed)
    assert "rank_sequence_warnings(self.rows, check_gaps=False)" in src


def test_duplicate_rank_warnings_no_longer_fire_once_misreads_are_corrected():
    """Originally the real case here was: CoolDude1031 (genuine rank 6),
    Merccc (rank 9 misread as 6), and ReddXking (rank 90 misread as 6 via
    int("06")) all collided at rank 6 across three DIFFERENT screenshots,
    plus Nightmare (genuine 16) vs Juancho Diego (19 misread as 16) -- and
    this test originally asserted rank_sequence_warnings' duplicate
    detection fired for both. As of "Round 5" (see docs/ocr-reference/
    capitol_war_mismatch_2026-08-23.md), `_drop_implausible_explicit_ranks`
    now corrects all three misreads outright (ReddXking -> 90, Merccc -> 9,
    Juancho Diego -> 19) instead of leaving them colliding, so the
    duplicate warnings this test used to require now correctly disappear.
    rank_sequence_warnings' own duplicate-firing capability is still
    covered directly by
    test_vault_tracks_own_rank_sequence_warnings_default_unchanged below,
    with synthetic data decoupled from this real, now-fixed dataset."""
    rows_by_points = _merge_session(RAW_SHOTS)
    warnings = ct.rank_sequence_warnings(list(rows_by_points.values()), check_gaps=False)
    assert not any("6" in w and "twice" in w for w in warnings), warnings
    assert not any("16" in w and "twice" in w for w in warnings), warnings


def test_check_gaps_false_suppresses_the_false_positive_gap_flood():
    """Without check_gaps=False, Capitol War's tag-filtered rank space
    (ranks scattered from 3 to 89, with most numbers in between belonging
    to OTHER alliances) generates dozens of bogus "missing" warnings that
    bury the two real duplicate warnings above. With check_gaps=False only
    the genuine duplicate signal survives."""
    rows_by_points = _merge_session(RAW_SHOTS)
    rows = list(rows_by_points.values())

    noisy = ct.rank_sequence_warnings(rows)  # default check_gaps=True
    quiet = ct.rank_sequence_warnings(rows, check_gaps=False)

    assert len(noisy) > 20, "expected the gap flood to still exist upstream"
    assert len(quiet) <= 4, f"duplicate-only warnings should be a short list, got: {quiet}"
    assert all("twice" in w for w in quiet)


def test_vault_tracks_own_rank_sequence_warnings_default_unchanged():
    """Vault Trap's own usage (no check_gaps kwarg) must keep reporting
    gaps exactly as before -- this is the same scenario
    test_capitol_collision_guard.py's
    test_rank_sequence_warnings_reused_for_capitol_rows already locks in,
    repeated here to make the default-preservation intent explicit
    alongside the new kwarg."""
    rows = [
        {"rank": 1, "rank_explicit": True, "damage": 100},
        {"rank": 2, "rank_explicit": True, "damage": 90},
        # rank 3 missing
        {"rank": 4, "rank_explicit": True, "damage": 70},
        {"rank": 4, "rank_explicit": True, "damage": 60},  # duplicate
    ]
    warnings = bt.rank_sequence_warnings(rows)
    assert any("3" in w and "missing" in w for w in warnings)
    assert any("4" in w and "twice" in w for w in warnings)


# ---------------------------------------------------------------------------
# Bug 3: wrapped-name splice must not corrupt the NEXT row's name.
# ---------------------------------------------------------------------------

def test_wrapped_name_trailing_word_does_not_corrupt_next_row():
    """"Kazuha Nakamura" wraps to two lines; OCR reads
    "13 [APX]Kazuha 5,877,477 Nakamura [APX]Ruri 5,846,802" -- the trailing
    "Nakamura" must not leak onto the front of Ruri's own row."""
    repaired = bt.repair_ocr_digits(RAW_SHOTS["IMG_6984"])
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")
    by_points = {r["damage"]: r for r in rows}

    ruri = by_points.get(5_846_802)
    assert ruri is not None, f"Ruri's row is missing entirely: {rows}"
    assert ruri["name"].strip() == "Ruri", (
        f"Ruri's name was corrupted by the wrapped-name leak: {ruri!r}"
    )
    assert "Nakamura" not in ruri["name"]

    # Kazuha's own row is a pragmatic partial name (not reconstructed to
    # "Kazuha Nakamura") -- acceptable per the fix's scope, still good
    # enough for fuzzy-matching against a roster member named "Kazuha
    # Nakamura".
    kazuha = by_points.get(5_877_477)
    assert kazuha is not None
    assert kazuha["name"].strip() == "Kazuha"

    # Amanises' row (after Ruri) must be unaffected -- the leak is
    # strictly local to the one row immediately following the wrap.
    amanises = by_points.get(5_786_355)
    assert amanises is not None
    assert amanises["name"].strip() == "Amanises"


def test_leading_wrap_leak_does_not_eat_a_genuine_rank_digit():
    """Sanity guard: a normal row's own explicit rank digit (e.g. "16
    [APX]Nightmare") must survive the new leading-noise strip untouched --
    only non-digit leaked words are stripped, never a real rank token."""
    repaired = bt.repair_ocr_digits(RAW_SHOTS["IMG_6985"])
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")
    by_name = {r["name"].strip(): r for r in rows}

    assert by_name["Nightmare"]["rank"] == 16
    assert by_name["Nightmare"]["rank_explicit"] is True
    assert by_name["Zizi"]["rank"] == 18
    assert by_name["Andrew21"]["rank"] == 20


def test_leading_wrap_leak_preserves_a_rank_digit_between_leak_and_tag():
    """When a leaked word is followed by an explicit rank digit before the
    next tag (e.g. "Mother 33 [APX]Rarefax", the wrapped-name-splice
    pattern recurring at IMG_6988 per the mismatch doc), the digit must
    survive -- only the leaked word is stripped."""
    text = "32 [L4W]Ask Your 3,905,548 Mother 33 [APX]Rarefax 3,800,000"
    repaired = bt.repair_ocr_digits(text)
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")
    assert len(rows) == 1
    assert rows[0]["name"].strip() == "Rarefax"
    assert rows[0]["rank"] == 33
    assert rows[0]["rank_explicit"] is True
