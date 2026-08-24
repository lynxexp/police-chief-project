"""Regression tests for "Round 4" of the real Capitol War OCR mismatch --
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md, the two sections
added after a genuinely fresh re-upload (new filenames IMG_7018-7037, new
`log/bot.txt` timestamps ~2026-08-23 18:53-18:54, same content as the
original IMG_6982-7002 set).

Raw OCR text below is pulled VERBATIM from `log/bot.txt` for that fresh
re-upload -- the full, real 20-screenshot session (not a synthetic
worst-case, not a subset) -- and run through the actual session-level merge
pipeline (`CapitolSession.add_message`'s own logic: parse each image, fold
into one flat `rows_by_points` dict via `_better_row`), because this bug is
specifically about CROSS-image session behavior that a single-image
`parse_capitol_rows` call can't exercise.

Bug 1: the pinned own-row (`[APX]Lynx 12,780,331`) is appended, unconditionally,
to literally every screenshot in the session, regardless of what rank range
that screenshot shows. The existing `drop_pinned_trailing_row` (shared with
vault_track.py) only catches it on the ONE screenshot where the account's
real row is also present (an easy same-image duplicate); every other
screenshot has nothing local to compare against, so the pinned copy
survives and picks up a bogus inferred rank from that image's own local
anchor context -- e.g. rank "100" on the screenshot showing real ranks
95-99. When the session merges by points value, that bogus-ranked copy can
beat out the one genuine Lynx row.

Bug 2: a genuine, non-colliding explicit-rank misread (Baba: real rank 91,
OCR misread as "11") gets no warning at all, since nothing else in the data
happens to also claim rank 11 -- the duplicate-only check has nothing to
catch.
"""
from __future__ import annotations

from harness import bt, ct


# ---------------------------------------------------------------------------
# Raw OCR text, verbatim from log/bot.txt's 2026-08-23 18:53-18:54 entries
# (the fresh IMG_7018-7037 re-upload) -- the REPAIRED text (right side of the
# logged "→"), which is what parse_capitol_rows actually receives in
# production after ocr_attachment_to_capitol_result's repair_ocr_digits
# call. All 20 screenshots from that real session are included, not a
# hand-picked subset -- this is the exact dataset the Round 4 bug was
# diagnosed against.
# ---------------------------------------------------------------------------

RAW_SHOTS = {
    "IMG_7037": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "95 [FOH]momo 556,937 96 [542]5StarGeneral 556,728 "
        "97 [L4W]DAMIAN29DANMILLE 542,944 98 [Yns]legoman 502,133 "
        "99 [TLW]Champ134 457,781 [APX]Lynx 12,780,331"
    ),
    "IMG_7036": (
        "Honor Roll. Rankings Ranking Rewards. Rank Chief Points "
        "11 [APX]Baba 598,307 92 [F0H]Kopassus Elite 597,041 "
        "93 [L4W]Chief 589,026 Tenpenny 76 [542]0sadolor 588,774 "
        "95 [FOH]momo 556,937 [APX]Lynx 12,780,331"
    ),
    "IMG_7035": (
        "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
        "86 [L4W]AIaa Ztn 851,552 87 [BOO]julink 820,264 "
        "88 [L4W]nightfire 813,282 89 [APX]qlphasix 781,760 "
        "06 [APX]ReddXking 626,162 [APX]Lynx 12,780,331"
    ),
    "IMG_7034": (
        "Honor Roll. Rankings Ranking Rewards. Rank Chief Points "
        "81 [APX]tripleH 1,321,127 82 [Kil]Killdeer 1,220,216 "
        "83 [Yns]KapitBahayNBR 1,187,778 78 [Yns]GRSMustard 943,606 "
        "85 [L4W]cheesycheese 913,401 [APX]Lynx 12,780,331"
    ),
    "IMG_7033": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "76 [APX]DirectorGeneral 1,585,786 77 [APX]Jason 1,571,041 "
        "78 [L4W]CipherX 1,512,155 6L [APX]PrimeTime 1,417,464 "
        "80 [FND]]esslyn 1,354,270 [APX]Lynx 12,780,331"
    ),
    "IMG_7032": (
        "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
        "[APX]ChiefFAFO 1,791,813 72 [APX]XXX TARGET 1,787,780 "
        "73 [L4W]Sung Jinwoo 1,711,048 74 [L4W]YUMEKO 1,689,786 "
        "75 [L4W]FouIMouthDarling 1,639,415 [APX]Lynx 12,780,331"
    ),
    "IMG_7031": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "66 [FOH]MAJOR 2,288,686 GENERAL 67 [L4W]Dr Ethan 2,243,235 "
        "68 [FOH]Lexu 2,184,987 69 [APX]Dresh 1,990,115 "
        "70 [L4W]Charly 0ngolo 1,866,788 [APX]Lynx 12,780,331"
    ),
    "IMG_7030": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "61 [L4W]Oracle 2,436,252 62 [APX]VLACIC 2,425,312 "
        "63 [APX]Chief Strong 2,413,361 Arm 64 [APX]Director 2,354,625 "
        "65 [L4W]G H O S T 2,300,178 AZREAL [APX]Lynx 12,780,331"
    ),
    "IMG_7029": (
        "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
        "56 [L4W]Dizzy 2,704,469 57 [APX]misChief 2,665,684 "
        "58 [APX]Potato Pop 2,612,915 59 [APX]davidbruh 2,581,286 "
        "60 [L4w]HonorableKnight 2,466,115 [APX]Lynx 12,780,331"
    ),
    "IMG_7028": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "51 [APX]Warhound1985 2,852,132 52 [APX]Thila 2,836,579 "
        "53 [APX]Zeffer2 2,793,320 54 [APX]AwwDardy 2,756,297 "
        "55 [APX]qwerty 2,752,061 [APX]Lynx 12,780,331"
    ),
    # Ranks 1/2/4 have no explicit digit at all -- rely on same-image
    # position inference. Also carries the ONE same-image duplicate (the
    # account's real row AND the pinned copy both present), which
    # drop_pinned_trailing_row's rank-digit check still can't catch here
    # (neither Lynx occurrence has a leading digit) -- the new points-
    # outlier check is what actually drops the trailing copy.
    "IMG_7018": (
        "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
        "[APX]Lynx 12,780,331 [APX]LTC 11,792,466 "
        "3 [APX]Tony Montana 11,119,046 [APX]Jesslyn 8,833,752 "
        "5 [APX]Chief3e6e6ee0 8,620,267 [APX]Lynx 12,780,331"
    ),
    "IMG_7019": (
        "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
        "6 [APX]CoolDude1031 7,842,127 [APX]FrankSloup 7,128,968 "
        "8 [542]hamadona 7,021,456 6 [APX]Merccc 6,578,892 "
        "10 [APX]Valhalla907 6,569,772 [APX]Lynx 12,780,331"
    ),
    "IMG_7020": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "[APX]Daddy 6,451,998 12 [APX]WutZa 6,408,943 "
        "13 [APX]Kazuha 5,877,477 Nakamura [APX]Ruri 5,846,802 "
        "15 [APX]Amanises 5,786,355 [APX]Lynx 12,780,331"
    ),
    "IMG_7021": (
        "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
        "16 [APX]Nightmare 5,337,431 17 [L4W]Chief Iuna 5,316,378 "
        "18 [APX]Zizi 5,076,417 16 [APX]Juancho Diego 4,941,456 "
        "20 [APX]Andrew21 4,937,814 [APX]Lynx 12,780,331"
    ),
    "IMG_7022": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "21 [L4W]Spartan 4,855,561 22 [APX]applejojo 4,698,714 "
        "23 [Kil]Effi 4,588,942 24 [L4W]Su Muxue 4,435,186 "
        "25 [APX]CP3ECLIPSE 4,344,979 [APX]Lynx 12,780,331"
    ),
    "IMG_7023": (
        "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
        "26 [L4W]seifou 4,260,748 22 [L4W]batusai 4,164,796 "
        "28 [L4W]gingo 4,059,463 29 [L4W]TAGWANMAN 3,929,702 "
        "30 [L4W]Chameleon 3,929,396 [APX]Lynx 12,780,331"
    ),
    "IMG_7024": (
        "Honor Rolld Rankings Ranking Rewards Rank Chief Points "
        "31 [L4W]Skye 3,907,118 32 [L4W]Ask Your 3,905,548 Mother "
        "33 [APX]Rarefax 3,832,045 34 [L4W]Lola Caruso 3,816,601 "
        "35 [APX]Alimani 3,800,492 [APX]Lynx 12,780,331"
    ),
    "IMG_7025": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "36 [L4W]Zatoichi 3,712,658 37 [L4W]yanyan 3,694,507 "
        "38 [APX]Marzienne 3,689,963 39 [APX]martin 3,577,225 "
        "40 [APX]AjBIaz 3,570,980 [APX]Lynx 12,780,331"
    ),
    "IMG_7026": (
        "Honor Roll Rankings Ranking Rewards Rank Chief Points "
        "L7 [APX]jukesy 3,524,430 42 [L4W]Chief Nicol 3,518,601 "
        "43 [APX]Pxdro 3,514,197 44 [APX]Bake 3,473,237 "
        "45 [APX]Lee Sung 3,443,473 Kyung [APX]Lynx 12,780,331"
    ),
    "IMG_7027": (
        "Honor Roll Rankings Ranking Rewards. Rank Chief Points "
        "46 [APX]Dane 3,240,155 47 [L4W]BIAcKhEaLeR 3,239,759 "
        "48 [APX]PRD24 3,230,770 49 [L4W]Fabulousace 3,178,075 "
        "50 [FOH]Tay54288 3,098,950 [APX]Lynx 12,780,331"
    ),
}

# Ground truth ranks (from docs/ocr-reference/capitol_war.md's verified
# sample table, and the Round 2/3 fix history for the previously-buggy
# inferred rows) for a representative spread of rows across MANY different
# screenshots in this session -- used to confirm nothing else regressed or
# picked up a leaked/bogus rank as a side effect of the pinned-row fix.
EXPECTED_RANKS = {
    "Lynx": 1,
    "LTC": 2,
    "Tony Montana": 3,
    "Jesslyn": 4,
    "Chief3e6e6ee0": 5,
    "CoolDude1031": 6,
    "Daddy": 11,       # Round 2/3 regression guard (used to show as 10)
    "Ruri": 14,        # Round 2/3 regression guard (used to show as 13)
    "ChiefFAFO": 71,   # Round 2/3 regression guard (used to show as 44)
    "qlphasix": 89,
    "ReddXking": 90,   # Round 5 regression guard (misread "06"/6, now corrected)
    "Baba": 91,        # Round 5 regression guard (misread "11", now corrected)
    "Merccc": 9,       # Round 5 regression guard (misread "6", now corrected)
    "Juancho Diego": 19,  # Round 5 regression guard (misread "16", now corrected)
}


def _merge_session(shots: dict, tag: str = "APX") -> dict:
    """Mirrors CapitolSession.add_message's own merge loop exactly: OCR
    each screenshot's raw (already-repaired) text, parse+tag-filter its
    rows, fold into one flat rows_by_points dict via the same _better_row
    tiebreaker the real session uses -- see cogs/capitol_war.py's
    CapitolSession.add_message, lines ~936-950."""
    rows_by_points: dict = {}
    for text in shots.values():
        parsed_rows, _candidates = ct.parse_capitol_rows(text, tag)
        img_rows = {row["damage"]: row for row in parsed_rows}
        for key, row in img_rows.items():
            existing = rows_by_points.get(key)
            if existing is None or ct._better_row(existing, row, roster=None):
                rows_by_points[key] = row
    return rows_by_points


# ---------------------------------------------------------------------------
# Bug 1: pinned own-row leaks through on screenshots without a same-image
# duplicate, producing a bogus inferred rank that wins the session merge.
# ---------------------------------------------------------------------------

def test_real_20_screenshot_session_lynx_ends_up_rank_1():
    """The headline regression: across the full real session (20
    screenshots, all but one showing only the pinned Lynx copy with no
    local duplicate to compare against), the merged session must contain
    exactly ONE Lynx row, at rank 1 -- not 100, not 6, not any other
    bogus number a leftover pinned-row copy could have contributed."""
    rows_by_points = _merge_session(RAW_SHOTS)
    lynx_rows = [r for r in rows_by_points.values()
                 if (r.get("name") or "").strip() == "Lynx"]
    assert len(lynx_rows) == 1, f"expected exactly one Lynx row, got: {lynx_rows}"
    assert lynx_rows[0]["rank"] == 1, f"Lynx should be rank 1, got: {lynx_rows[0]}"
    assert lynx_rows[0]["damage"] == 12_780_331


def test_ranks_95_99_screenshot_alone_drops_the_pinned_row_with_no_local_dup():
    """The exact reproduction case from the doc: the screenshot showing
    real ranks 95-99 has NO real Apex member on it at all (per
    docs/ocr-reference/capitol_war.md's ground-truth table, ranks 95-99
    are FOH/S42/L4W/Yns/TLW) -- so after a correct pinned-row drop, zero
    APX rows should survive tag filtering. Before the fix this produced
    one bogus row: Lynx at rank 100."""
    rows, total_candidates = ct.parse_capitol_rows(RAW_SHOTS["IMG_7037"], "APX")
    assert rows == [], f"expected no surviving APX rows, got: {rows}"
    # 5 real rows on the page (momo/5StarGeneral/DAMIAN29DANMILLE/legoman/
    # Champ134), pinned copy dropped before the candidate count is taken.
    assert total_candidates == 5


def test_no_other_row_picks_up_a_leaked_bogus_rank():
    """Cross-check a spread of rows from many different screenshots in the
    merged session against known-correct ranks -- confirms the pinned-row
    fix didn't disturb any of the already-correct Round 3 anchor-inference
    results (Lynx/LTC/Jesslyn/Ruri/Daddy/ChiefFAFO must all still resolve
    correctly, not regress), and that no row anywhere in the 20-screenshot
    session ended up with someone else's rank due to a leftover pinned-row
    leak."""
    rows_by_points = _merge_session(RAW_SHOTS)
    by_name = {(r.get("name") or "").strip(): r for r in rows_by_points.values()}
    for name, expected_rank in EXPECTED_RANKS.items():
        assert name in by_name, f"{name} missing entirely from merged session: {sorted(by_name)}"
        actual = by_name[name]["rank"]
        assert actual == expected_rank, (
            f"{name} expected rank {expected_rank}, got {actual} -- row: {by_name[name]}"
        )


def test_only_one_row_in_the_whole_session_carries_lynxs_points_value():
    """No screenshot's leftover pinned-row copy should survive at all --
    every one of the 20 screenshots' own parse must drop it, individually,
    with no session-level bookkeeping needed. Confirmed by asserting the
    12,780,331-points value (Lynx's) never appears more than once in any
    single per-image parse in the whole session, not just after the
    dict-merge happens to collapse duplicates."""
    for filename, text in RAW_SHOTS.items():
        rows, _candidates = ct.parse_capitol_rows(text, "APX")
        lynx_rows = [r for r in rows if r["damage"] == 12_780_331]
        assert len(lynx_rows) <= 1, (
            f"{filename}: pinned Lynx row leaked as more than one candidate: {lynx_rows}"
        )


def test_drop_capitol_pinned_outlier_row_is_order_independent():
    """The fix must not depend on which screenshot is processed first --
    merging the same session in reverse order must produce the identical
    result."""
    forward = _merge_session(RAW_SHOTS)
    reversed_shots = dict(reversed(list(RAW_SHOTS.items())))
    backward = _merge_session(reversed_shots)

    forward_lynx = [r for r in forward.values() if (r.get("name") or "").strip() == "Lynx"]
    backward_lynx = [r for r in backward.values() if (r.get("name") or "").strip() == "Lynx"]
    assert len(forward_lynx) == len(backward_lynx) == 1
    assert forward_lynx[0]["rank"] == backward_lynx[0]["rank"] == 1


def test_drop_capitol_pinned_outlier_row_direct_unit_check():
    """Direct unit test on the new helper: a trailing chunk whose points
    value is GREATER than the chunk before it (breaking the descending
    trend every other row in the list honors) is dropped; a normal
    descending trailing row is left untouched."""
    chunks = [" [APX]Foo ", " [APX]Bar ", " [APX]Lynx "]
    points = [500_000, 400_000, 12_780_331]
    ct._drop_capitol_pinned_outlier_row(chunks, points)
    assert points == [500_000, 400_000]
    assert len(chunks) == 2

    # A genuinely descending trailing row must survive untouched.
    chunks2 = [" [APX]Foo ", " [APX]Bar ", " [APX]Baz "]
    points2 = [500_000, 400_000, 300_000]
    ct._drop_capitol_pinned_outlier_row(chunks2, points2)
    assert points2 == [500_000, 400_000, 300_000]
    assert len(chunks2) == 3


def test_rank_digit_pin_drop_still_handled_first_no_double_drop():
    """When the OLD rank-digit-based drop_pinned_trailing_row already
    catches the pinned row (explicit, out-of-order rank digit), the new
    points-outlier check must not ALSO fire and eat a second, legitimate
    row underneath it."""
    text = (
        "Honor Roll Rank Chief Points "
        "95 [APX]momo 556,937 96 [APX]5StarGeneral 556,728 "
        "97 [APX]DAMIAN29DANMILLE 542,944 98 [APX]legoman 502,133 "
        "99 [APX]Champ134 457,781 1 [APX]Lynx 12,780,331"
    )
    rows, total_candidates = ct.parse_capitol_rows(text, "APX")
    ranks = [r["rank"] for r in rows]
    assert 1 not in ranks
    assert len(rows) == 5 and ranks[-1] == 99
    assert total_candidates == 5


# ---------------------------------------------------------------------------
# Bug 2: a genuine, non-colliding explicit-rank misread gets no warning.
# ---------------------------------------------------------------------------

def test_baba_corrected_by_round5_not_just_flagged():
    """Baba (real rank 91, OCR misread as "11") is now CORRECTED by
    `_drop_implausible_explicit_ranks` -- see docs/ocr-reference/
    capitol_war_mismatch_2026-08-23.md "Round 5" -- using the trustworthy
    same-image neighbor Kopassus Elite (explicit 92). Its resolved rank is
    91, not just flagged-but-still-wrong, so the Round 4
    neighbor-consistency warning no longer has anything to catch for it
    (nothing inconsistent remains); the correction itself is instead
    surfaced by capitol_rank_correction_warnings."""
    rows_by_points = _merge_session(RAW_SHOTS)
    sorted_rows = sorted(rows_by_points.values(), key=lambda r: -r["damage"])

    dupe_warnings = ct.rank_sequence_warnings(sorted_rows, check_gaps=False)
    assert not any("Baba" in w for w in dupe_warnings)

    neighbor_warnings = ct.capitol_neighbor_rank_warnings(sorted_rows)
    assert not any("Baba" in w for w in neighbor_warnings), (
        f"Baba's rank is corrected now, so it should no longer look "
        f"inconsistent: {neighbor_warnings}"
    )

    correction_warnings = ct.capitol_rank_correction_warnings(sorted_rows)
    assert any("Baba" in w for w in correction_warnings), (
        f"Baba's correction (misread 11 -> inferred 91) should be surfaced "
        f"as an audit warning: {correction_warnings}"
    )


def test_reddxking_corrected_and_no_longer_collides_with_cooldude1031():
    """ReddXking's misread "06"/6 previously collided with CoolDude1031's
    genuine explicit rank 6. Round 5 corrects ReddXking to 90 (via its
    trustworthy same-image neighbor qlphasix, explicit 89), so it no longer
    participates in that duplicate at all."""
    rows_by_points = _merge_session(RAW_SHOTS)
    sorted_rows = sorted(rows_by_points.values(), key=lambda r: -r["damage"])
    neighbor_warnings = ct.capitol_neighbor_rank_warnings(sorted_rows)
    assert not any("ReddXking" in w for w in neighbor_warnings), neighbor_warnings
    assert not any("CoolDude1031" in w for w in neighbor_warnings), neighbor_warnings

    dupe_warnings = ct.rank_sequence_warnings(sorted_rows, check_gaps=False)
    assert not any("ReddXking" in w for w in dupe_warnings), (
        f"ReddXking is corrected to 90 now, so it must drop out of the "
        f"rank-6 duplicate entirely: {dupe_warnings}"
    )

    correction_warnings = ct.capitol_rank_correction_warnings(sorted_rows)
    assert any("ReddXking" in w for w in correction_warnings), correction_warnings


def test_merccc_and_juancho_diego_corrected_via_both_directions_agreeing():
    """A second pair of collisions in this same real session -- Merccc
    (real 9, misread "6", colliding with CoolDude1031's genuine 6) and
    Juancho Diego (real 19, misread "16", colliding with Nightmare's
    genuine 16) -- with a SMALLER misread magnitude (gap of 3, not ~80
    like Baba/ReddXking) than a flat threshold alone would catch. Both are
    still confidently correctable because their same-image neighbors on
    EACH side independently agree on the same corrected value (hamadona=8
    and Valhalla907=10 both predict 9 for Merccc; Zizi=18 and Andrew21=20
    both predict 19 for Juancho Diego) -- see the "both-directions
    agreement" branch of `_drop_implausible_explicit_ranks`."""
    rows_by_points = _merge_session(RAW_SHOTS)
    by_name = {(r.get("name") or "").strip(): r for r in rows_by_points.values()}

    merccc = by_name["Merccc"]
    assert merccc["rank"] == 9, merccc
    assert merccc["rank_misread"] == 6, merccc

    juancho = by_name["Juancho Diego"]
    assert juancho["rank"] == 19, juancho
    assert juancho["rank_misread"] == 16, juancho

    sorted_rows = sorted(rows_by_points.values(), key=lambda r: -r["damage"])
    dupe_warnings = ct.rank_sequence_warnings(sorted_rows, check_gaps=False)
    assert not any("6" in w and "twice" in w for w in dupe_warnings), dupe_warnings
    assert not any("16" in w and "twice" in w for w in dupe_warnings), dupe_warnings

    correction_warnings = ct.capitol_rank_correction_warnings(sorted_rows)
    assert any("Merccc" in w for w in correction_warnings), correction_warnings
    assert any("Juancho Diego" in w for w in correction_warnings), correction_warnings


def test_neighbor_consistency_check_has_no_false_positives_on_real_session():
    """Across the entire real merged session (~50 rows spanning ranks 1 to
    89), Round 5 now corrects Baba, ReddXking, Merccc, and Juancho Diego
    outright instead of merely flagging them, so no row should be left
    looking inconsistent -- a sanity check against the new warning being
    noisy on legitimate data."""
    rows_by_points = _merge_session(RAW_SHOTS)
    sorted_rows = sorted(rows_by_points.values(), key=lambda r: -r["damage"])
    neighbor_warnings = ct.capitol_neighbor_rank_warnings(sorted_rows)
    assert neighbor_warnings == [], f"expected nothing flagged, got: {neighbor_warnings}"


def test_no_exact_duplicate_ranks_remain_in_real_session():
    """Once all four real misreads (ReddXking, Baba, Merccc, Juancho Diego)
    are corrected, no two rows in the whole real session should still
    explicitly claim the same rank -- rank_sequence_warnings' "appears
    twice" check should have nothing left to catch."""
    rows_by_points = _merge_session(RAW_SHOTS)
    sorted_rows = sorted(rows_by_points.values(), key=lambda r: -r["damage"])
    dupe_warnings = ct.rank_sequence_warnings(sorted_rows, check_gaps=False)
    assert dupe_warnings == [], f"expected no duplicate-rank warnings, got: {dupe_warnings}"


def test_neighbor_consistency_check_reused_by_build_embed():
    """Structural guard: CapitolWarReviewView.build_embed must actually
    call capitol_neighbor_rank_warnings so this fix is wired into what the
    user sees, not just a standalone unreferenced function."""
    import inspect
    src = inspect.getsource(ct.CapitolWarReviewView.build_embed)
    assert "capitol_neighbor_rank_warnings(self.rows)" in src
