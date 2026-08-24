"""Regression tests for the "Round 5" fix in
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md: an EXPLICIT rank
digit that's wildly inconsistent with its same-image neighbors (a genuine
digit misread, not a missing digit) is now discarded and re-inferred from
those trustworthy neighbors via `_drop_implausible_explicit_ranks`, instead
of merely being flagged (Round 4's warn-only behavior) while the wrong
number stays displayed and stored.

Covers the doc's real examples directly. Two are caught by a single wildly-
wrong-magnitude anchor (only one trustworthy direction available):
- ReddXking: real rank 90, OCR misread the leading digit as "06" (-> 6),
  colliding with CoolDude1031's genuine rank 6. Trustworthy same-image
  neighbor: qlphasix, explicit 89, one chunk earlier -> 89 + 1 = 90.
- Baba: real rank 91, OCR misread as "11". Trustworthy same-image
  neighbor: Kopassus Elite, explicit 92, one chunk later -> 92 - 1 = 91.

Two more are caught by a *smaller* gap that only becomes trustworthy once
both directions independently predict the same value (a stricter magnitude
check alone would have missed these -- see the "both-directions agreement"
branch of `_drop_implausible_explicit_ranks`):
- Merccc: real rank 9, OCR misread as "6" (gap of only 3). hamadona's
  explicit 8 (one chunk earlier -> 9) and Valhalla907's explicit 10 (one
  chunk later -> 9) agree exactly, confirming the misread despite the
  small magnitude, and without colliding with CoolDude1031's genuine
  rank 6.
- Juancho Diego: real rank 19, OCR misread as "16" (gap of only 3, and a
  collision with Nightmare's genuine rank 16). Zizi's explicit 18 (one
  chunk earlier -> 19) and Andrew21's explicit 20 (one chunk later -> 19)
  agree exactly.

All four raw chunk lists below are verbatim from
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md (also reproduced in
test_capitol_mismatch_round4.py's RAW_SHOTS as IMG_7019/IMG_7021/
IMG_7035/IMG_7036)."""
from __future__ import annotations

from harness import bt, ct


# ---------------------------------------------------------------------------
# Direct unit coverage of _drop_implausible_explicit_ranks.
# ---------------------------------------------------------------------------

def test_wildly_inconsistent_explicit_digit_is_discarded():
    """A single implausible explicit value, with trustworthy neighbors
    right next to it, is dropped (turned back into None) and its original
    value returned in the `misread` list -- its own good neighbors are left
    untouched (julink=87, nightfire=88, qlphasix=89, ReddXking misread
    "6", real 90)."""
    explicit = [87, 88, 89, 6]
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == [87, 88, 89, None]
    assert misread == [None, None, None, 6]


def test_plausible_explicit_digits_are_left_alone():
    """A normal, self-consistent explicit sequence must not be touched at
    all -- no false positives on legitimate data."""
    explicit = [10, None, None, None, 14]
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == explicit
    assert misread == [None] * len(explicit)


def test_agreeing_neighbors_correct_even_a_small_gap():
    """When there's a trustworthy anchor on BOTH sides and they
    independently predict the exact same value, that agreement alone is
    strong enough evidence to correct even a small-magnitude deviation --
    this is Merccc's real scenario (hamadona's explicit 8, one chunk
    earlier, predicts 9; Valhalla907's explicit 10, one chunk later, also
    predicts 9; Merccc's own misread "6" disagrees with both). A dropped
    row nearby would have broken this agreement rather than produced it,
    which is what makes it trustworthy even at a gap of only 3."""
    explicit = [8, 6, 10]  # both directions independently predict 9
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == [8, None, 10]
    assert misread == [None, 6, None]


def test_single_direction_small_gap_is_not_corrected():
    """With only ONE side to validate against (no corroborating second
    anchor), a small deviation has nothing to rule out the "a row was
    silently dropped nearby" explanation -- stays conservative and leaves
    it alone, unlike the both-directions-agree case above."""
    explicit = [8, 6]  # only one anchor available, predicts 9 (gap 3)
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == explicit
    assert misread == [None, None]


def test_no_trustworthy_neighbor_anywhere_leaves_value_untouched():
    """A lone explicit value with no other explicit anchor anywhere in the
    image has nothing to validate against -- must be left alone rather than
    discarded on no evidence at all."""
    explicit = [None, 6, None]
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == explicit
    assert misread == [None, None, None]


def test_correction_does_not_propagate_to_a_bad_values_own_neighbors():
    """A single wildly-wrong explicit value (index 2) sits between two
    otherwise-fine values on each side. Each of those neighbors has its OWN
    other, genuinely good anchor to validate against (index 0 via index 1,
    index 4 via index 3), so discarding index 2 must not drag either of
    them down with it -- one bad digit doesn't chain into its neighbors."""
    explicit = [8, 10, 999, 12, 14]
    corrected, misread = ct._drop_implausible_explicit_ranks(explicit)
    assert corrected == [8, 10, None, 12, 14]
    assert misread == [None, None, 999, None, None]


# ---------------------------------------------------------------------------
# End-to-end: the real ReddXking and Baba screenshots.
# ---------------------------------------------------------------------------

REDDXKING_TEXT = (
    "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
    "86 [L4W]AIaa Ztn 851,552 87 [BOO]julink 820,264 "
    "88 [L4W]nightfire 813,282 89 [APX]qlphasix 781,760 "
    "06 [APX]ReddXking 626,162 [APX]Lynx 12,780,331"
)

BABA_TEXT = (
    "Honor Roll. Rankings Ranking Rewards. Rank Chief Points "
    "11 [APX]Baba 598,307 92 [F0H]Kopassus Elite 597,041 "
    "93 [L4W]Chief 589,026 Tenpenny 76 [542]0sadolor 588,774 "
    "95 [FOH]momo 556,937 [APX]Lynx 12,780,331"
)

MERCCC_TEXT = (
    "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
    "6 [APX]CoolDude1031 7,842,127 [APX]FrankSloup 7,128,968 "
    "8 [S42]hamadona 7,021,456 6 [APX]Merccc 6,578,892 "
    "10 [APX]Valhalla907 6,569,772 [APX]Lynx 12,780,331"
)

JUANCHO_DIEGO_TEXT = (
    "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
    "16 [APX]Nightmare 5,337,431 17 [L4W]Chief Iuna 5,316,378 "
    "18 [APX]Zizi 5,076,417 16 [APX]Juancho Diego 4,941,456 "
    "20 [APX]Andrew21 4,937,814 [APX]Lynx 12,780,331"
)


def test_reddxking_rank_corrected_to_90():
    rows, _candidates = ct.parse_capitol_rows(REDDXKING_TEXT, "APX")
    by_name = {(r.get("name") or "").strip(): r for r in rows}
    assert "ReddXking" in by_name, by_name
    row = by_name["ReddXking"]
    assert row["rank"] == 90, row
    assert row["rank_explicit"] is False, row
    assert row["rank_misread"] == 6, row


def test_baba_rank_corrected_to_91():
    rows, _candidates = ct.parse_capitol_rows(BABA_TEXT, "APX")
    by_name = {(r.get("name") or "").strip(): r for r in rows}
    assert "Baba" in by_name, by_name
    row = by_name["Baba"]
    assert row["rank"] == 91, row
    assert row["rank_explicit"] is False, row
    assert row["rank_misread"] == 11, row


def test_uncorrected_neighbors_keep_their_own_explicit_ranks():
    """The correction must not disturb qlphasix's (or Kopassus Elite's) own
    correct, explicit rank -- only the implausible row itself changes."""
    rows, _candidates = ct.parse_capitol_rows(REDDXKING_TEXT, "APX")
    by_name = {(r.get("name") or "").strip(): r for r in rows}
    assert by_name["qlphasix"]["rank"] == 89
    assert by_name["qlphasix"]["rank_explicit"] is True
    assert by_name["qlphasix"]["rank_misread"] is None


def test_merccc_rank_corrected_to_9_via_both_directions_agreeing():
    """Merccc's real rank 9 was misread as "6" -- a smaller-magnitude
    misread than ReddXking/Baba's, only confidently correctable because
    hamadona (explicit 8, one chunk earlier) and Valhalla907 (explicit 10,
    one chunk later) independently agree on the same predicted value (9).
    Also confirms CoolDude1031's genuine rank 6 is untouched, so the two no
    longer collide."""
    rows, _candidates = ct.parse_capitol_rows(MERCCC_TEXT, "APX")
    by_name = {(r.get("name") or "").strip(): r for r in rows}
    merccc = by_name["Merccc"]
    assert merccc["rank"] == 9, merccc
    assert merccc["rank_explicit"] is False, merccc
    assert merccc["rank_misread"] == 6, merccc

    cooldude = by_name["CoolDude1031"]
    assert cooldude["rank"] == 6, cooldude
    assert cooldude["rank_explicit"] is True, cooldude
    assert cooldude["rank_misread"] is None, cooldude


def test_juancho_diego_rank_corrected_to_19_via_both_directions_agreeing():
    """Juancho Diego's real rank 19 was misread as "16" -- caught the same
    way as Merccc, via Zizi (explicit 18, one chunk earlier) and Andrew21
    (explicit 20, one chunk later) independently agreeing on 19. Also
    confirms Nightmare's genuine rank 16 is untouched, so the two no
    longer collide."""
    rows, _candidates = ct.parse_capitol_rows(JUANCHO_DIEGO_TEXT, "APX")
    by_name = {(r.get("name") or "").strip(): r for r in rows}
    juancho = by_name["Juancho Diego"]
    assert juancho["rank"] == 19, juancho
    assert juancho["rank_explicit"] is False, juancho
    assert juancho["rank_misread"] == 16, juancho

    nightmare = by_name["Nightmare"]
    assert nightmare["rank"] == 16, nightmare
    assert nightmare["rank_explicit"] is True, nightmare
    assert nightmare["rank_misread"] is None, nightmare


def test_capitol_rank_correction_warnings_direct_unit_check():
    """Direct unit test of the audit-warning generator: a row with
    rank_misread set produces a human-readable correction message; a row
    without one produces nothing."""
    rows = [
        {'name': 'ReddXking', 'rank': 90, 'rank_misread': 6},
        {'name': 'qlphasix', 'rank': 89, 'rank_misread': None},
    ]
    warnings = ct.capitol_rank_correction_warnings(rows)
    assert len(warnings) == 1
    assert "ReddXking" in warnings[0]
    assert "6" in warnings[0] and "90" in warnings[0]


def test_correction_warnings_reused_by_build_embed():
    """Structural guard: CapitolWarReviewView.build_embed must actually
    call capitol_rank_correction_warnings so the audit trail is wired into
    what the admin sees, not just a standalone unreferenced function."""
    import inspect
    src = inspect.getsource(ct.CapitolWarReviewView.build_embed)
    assert "capitol_rank_correction_warnings(self.rows)" in src
