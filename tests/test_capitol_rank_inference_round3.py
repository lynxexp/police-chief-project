"""Regression tests for the "Round 3" fix in
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md: rank determination
(explicit-digit read + position inference) must run on the FULL, unfiltered
per-screenshot chunk list, BEFORE alliance-tag filtering -- not after, and
not "not at all" (Round 2's fix, which was safe but too blunt).

This file covers the doc's other real anchor-inference example (Lynx / LTC
/ Jesslyn, IMG_6982 -- ranks 1, 2, 4 with no explicit digit, anchored off
ranks 3 and 5) which test_capitol_rank_inference_round2.py doesn't exercise
directly, plus a direct unit test of `_infer_capitol_ranks` itself covering
forward-only, backward-only, both-directions, and no-anchor-at-all cases."""
from __future__ import annotations

from harness import bt, ct


# Verbatim from the doc's raw-OCR appendix: ranks 1, 2, 4 have no explicit
# digit at all; only "3" (Tony Montana) and "5" (Chief3e6e6ee0) are present.
IMG_6982 = (
    "Rank Chief Points [APX]Lynx 12,780,331 [APX]LTC 11,792,466 "
    "3 [APX]Tony Montana 11,119,046 [APX]Jesslyn 8,833,752 "
    "5 [APX]Chief3e6e6ee0 8,620,267"
)


def test_lynx_ltc_jesslyn_infer_correct_ranks_from_same_image_anchors():
    """Lynx (no digit, 2 chunks before Tony Montana's explicit '3') must
    infer rank 1; LTC (no digit, 1 chunk before) must infer rank 2; Jesslyn
    (no digit, between Tony Montana's explicit 3 and Chief3e6e6ee0's
    explicit 5) must infer rank 4 -- all from position within this ONE
    image, none of it carried over from any other screenshot."""
    repaired = bt.repair_ocr_digits(IMG_6982)
    rows, _candidates = ct.parse_capitol_rows(repaired, "APX")
    by_name = {r["name"].strip(): r for r in rows}

    assert by_name["Lynx"]["rank"] == 1
    assert by_name["Lynx"]["rank_explicit"] is False
    assert by_name["LTC"]["rank"] == 2
    assert by_name["LTC"]["rank_explicit"] is False
    assert by_name["Jesslyn"]["rank"] == 4
    assert by_name["Jesslyn"]["rank_explicit"] is False

    # The explicit anchors themselves are untouched.
    assert by_name["Tony Montana"]["rank"] == 3
    assert by_name["Tony Montana"]["rank_explicit"] is True
    assert by_name["Chief3e6e6ee0"]["rank"] == 5
    assert by_name["Chief3e6e6ee0"]["rank_explicit"] is True


def test_inference_survives_tag_filtering_to_a_different_alliance_view():
    """Requesting a DIFFERENT alliance's tag from the same image must not
    change how APX's own explicit/inferred ranks were determined -- rank
    determination happens on the full list before the tag filter ever
    narrows anything down, so filtering for a tag with zero matches here
    just returns an empty list, not different ranks for APX rows."""
    repaired = bt.repair_ocr_digits(IMG_6982)
    rows, total_candidates = ct.parse_capitol_rows(repaired, "ZZZ")
    assert rows == []
    assert total_candidates == 5  # Lynx, LTC, Tony Montana, Jesslyn, Chief3e6e6ee0


# ---------------------------------------------------------------------------
# Direct unit coverage of _infer_capitol_ranks -- the anchor-inference
# helper itself, independent of the surrounding parse/tag-filter pipeline.
# ---------------------------------------------------------------------------

def test_infer_capitol_ranks_anchor_only_after():
    """No anchor before the target chunks, only a LATER one -- must
    backward-infer from it (this is exactly Lynx/LTC's shape: the first
    rows of a screenshot with no digit until a few rows in)."""
    chunks = [" [APX]A ", " [APX]B ", " 3 [APX]C "]
    ranks, explicit, _ = ct._infer_capitol_ranks(chunks)
    assert ranks == [1, 2, 3]
    assert explicit == [False, False, True]


def test_infer_capitol_ranks_anchor_only_before():
    """No anchor after the target chunks, only an EARLIER one -- must
    forward-infer from it."""
    chunks = [" 10 [APX]A ", " [APX]B ", " [APX]C "]
    ranks, explicit, _ = ct._infer_capitol_ranks(chunks)
    assert ranks == [10, 11, 12]
    assert explicit == [True, False, False]


def test_infer_capitol_ranks_nearest_anchor_wins_both_directions():
    """A chunk between two anchors uses whichever is nearer; when
    equidistant, both directions must agree (as they do for a consistent
    sequence) rather than silently picking an arbitrary wrong one."""
    chunks = [" 10 [APX]A ", " [APX]B ", " [APX]C ", " [APX]D ", " 14 [APX]E "]
    ranks, explicit, _ = ct._infer_capitol_ranks(chunks)
    assert ranks == [10, 11, 12, 13, 14]
    assert explicit == [True, False, False, False, True]


def test_infer_capitol_ranks_no_anchor_anywhere_stays_none():
    """A chunk list with zero explicit digits anywhere leaves every rank
    None -- the correct honest fallback, not a guess."""
    chunks = [" [APX]A ", " [APX]B ", " [APX]C "]
    ranks, explicit, _ = ct._infer_capitol_ranks(chunks)
    assert ranks == [None, None, None]
    assert explicit == [False, False, False]


def test_infer_capitol_ranks_strips_explicit_digit_from_chunk_text():
    """The explicit digit is removed from the chunk in place (so later
    name-cleanup steps never see it as a stray token) -- the tag and name
    text around it must survive untouched."""
    chunks = [" 41 [APX]jukesy "]
    ranks, explicit, _ = ct._infer_capitol_ranks(chunks)
    assert ranks == [41]
    assert explicit == [True]
    assert "41" not in chunks[0]
    assert "[APX]jukesy" in chunks[0]
