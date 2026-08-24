"""Tag-filtering tests for Capitol War's state-wide Honor Roll parsing.

Capitol War's ranking screen lists the WHOLE STATE -- every alliance's
members interleaved, each name prefixed with a 3-character bracketed tag
(e.g. "[APX]Lynx"). `parse_capitol_rows` must discard every row whose tag
doesn't case-insensitively match the tracked alliance's own tag BEFORE that
row is ever handed to roster fuzzy-matching -- see
docs/ocr-reference/capitol_war.md and the module docstring of
cogs/capitol_war.py.

The raw-OCR-text-shaped fixture below uses the real sample rows from that
reference doc's table (rank/tag/name/points), mixing `[APX]` rows with
`[L4W]`/`[BOO]`/`[FOH]`/`[S42]`/`[Yns]`/`[TLW]` rows exactly as documented,
so this is a faithful reconstruction of what OCR would produce for that
screen -- not a synthetic worst-case."""
from __future__ import annotations

from harness import ct


# Verbatim from docs/ocr-reference/capitol_war.md's sample table (rank, tag,
# name, points), reconstructed as one raw-OCR-text-shaped screenshot the way
# the real Honor Roll screen would read (header once, then rows).
HONOR_ROLL_TEXT = (
    "Honor Roll Rankings tab Ranking Rewards tab Rank Chief Points "
    "1 [APX]Lynx 12,780,331 "
    "2 [APX]LTC 11,792,466 "
    "3 [APX]Tony Montana 11,119,046 "
    "4 [APX]Jesslyn 8,833,752 "
    "5 [APX]Chief3e6e6ee0 8,620,267 "
    "41 [APX]jukesy 3,524,430 "
    "42 [L4W]Chief Nicol 3,518,601 "
    "43 [APX]Pxdro 3,514,197 "
    "44 [APX]Bake 3,473,237 "
    "45 [APX]Lee Sung Kyung 3,443,473 "
    "86 [L4W]Alaa Ztn 851,552 "
    "87 [BOO]julink 820,264 "
    "88 [L4W]nightfire 813,282 "
    "89 [APX]qlphasix 781,760 "
    "90 [APX]ReddXking 626,162 "
    "91 [APX]Baba 598,307 "
    "92 [FOH]Kopassus Elite 597,041 "
    "93 [L4W]Chief Tenpenny 589,026 "
    "94 [S42]Osadolor 588,774 "
    "95 [FOH]momo 556,937 "
    "96 [S42]5StarGeneral 556,728 "
    "97 [L4W]DAMIAN29DANMILLE 542,944 "
    "98 [Yns]legoman 502,133 "
    "99 [TLW]Champ134 457,781"
)

# rank -> (tag, name, points) ground truth from the reference doc's table.
GROUND_TRUTH = {
    1: ("APX", "Lynx", 12_780_331),
    2: ("APX", "LTC", 11_792_466),
    3: ("APX", "Tony Montana", 11_119_046),
    4: ("APX", "Jesslyn", 8_833_752),
    5: ("APX", "Chief3e6e6ee0", 8_620_267),
    41: ("APX", "jukesy", 3_524_430),
    42: ("L4W", "Chief Nicol", 3_518_601),
    43: ("APX", "Pxdro", 3_514_197),
    44: ("APX", "Bake", 3_473_237),
    45: ("APX", "Lee Sung Kyung", 3_443_473),
    86: ("L4W", "Alaa Ztn", 851_552),
    87: ("BOO", "julink", 820_264),
    88: ("L4W", "nightfire", 813_282),
    89: ("APX", "qlphasix", 781_760),
    90: ("APX", "ReddXking", 626_162),
    91: ("APX", "Baba", 598_307),
    92: ("FOH", "Kopassus Elite", 597_041),
    93: ("L4W", "Chief Tenpenny", 589_026),
    94: ("S42", "Osadolor", 588_774),
    95: ("FOH", "momo", 556_937),
    96: ("S42", "5StarGeneral", 556_728),
    97: ("L4W", "DAMIAN29DANMILLE", 542_944),
    98: ("Yns", "legoman", 502_133),
    99: ("TLW", "Champ134", 457_781),
}

APX_RANKS = sorted(r for r, (tag, _, _) in GROUND_TRUTH.items() if tag == "APX")
OTHER_RANKS = sorted(r for r, (tag, _, _) in GROUND_TRUTH.items() if tag != "APX")


def test_only_apx_rows_survive_tag_filtering():
    """Only [APX]-tagged rows should come out of parse_capitol_rows when
    filtering for the 'APX' alliance -- every other-tagged row (L4W, BOO,
    FOH, S42, Yns, TLW) must be discarded before matching, per the reference
    doc's explicit requirement."""
    rows, total_candidates = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "APX")
    assert total_candidates == len(GROUND_TRUTH), (
        f"expected {len(GROUND_TRUTH)} total row-candidates before tag "
        f"filtering, got {total_candidates}"
    )
    assert len(rows) == len(APX_RANKS), f"expected {len(APX_RANKS)} APX rows, got {len(rows)}: {rows}"

    kept_points = {r["damage"] for r in rows}
    for rank in APX_RANKS:
        _, name, points = GROUND_TRUTH[rank]
        assert points in kept_points, f"APX rank {rank} ({name}) missing from kept rows: {rows}"

    for rank in OTHER_RANKS:
        tag, name, points = GROUND_TRUTH[rank]
        assert points not in kept_points, (
            f"non-APX row rank {rank} ({tag} {name}) leaked into kept rows: {rows}"
        )


def test_apx_row_names_and_ranks_parsed_correctly():
    """Surviving APX rows keep their real name/points/rank, with the tag
    itself stripped from the name (never left dangling in the text shown to
    admins)."""
    rows, _ = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "APX")
    by_points = {r["damage"]: r for r in rows}

    lynx = by_points[12_780_331]
    assert lynx["name"].strip() == "Lynx"
    assert lynx["rank"] == 1
    assert lynx["rank_explicit"] is True
    assert "[" not in lynx["name"] and "]" not in lynx["name"]

    tony = by_points[11_119_046]
    assert tony["name"].strip() == "Tony Montana"
    assert tony["rank"] == 3


def test_tag_filter_is_case_insensitive():
    """In-game tags render in mixed case (e.g. "[Yns]") but represent one
    fixed 3-char code -- filtering must match regardless of stored/OCR'd
    case in either direction."""
    rows_lower, _ = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "apx")
    rows_mixed, _ = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "ApX")
    rows_upper, _ = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "APX")
    assert {r["damage"] for r in rows_lower} == {r["damage"] for r in rows_upper}
    assert {r["damage"] for r in rows_mixed} == {r["damage"] for r in rows_upper}

    # And a mixed-case tag IN THE TEXT (e.g. "[Yns]") is still matched
    # correctly when the configured tag is queried in a different case.
    yns_rows, _ = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "yns")
    assert len(yns_rows) == 1
    assert yns_rows[0]["name"].strip() == "legoman"


def test_filtering_for_a_different_alliance_keeps_only_that_tag():
    """Sanity check the filter isn't secretly hardcoded to APX -- asking for
    L4W's rows returns exactly L4W's rows, not APX's."""
    rows, total_candidates = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "L4W")
    assert total_candidates == len(GROUND_TRUTH)
    l4w_ranks = sorted(r for r, (tag, _, _) in GROUND_TRUTH.items() if tag == "L4W")
    assert len(rows) == len(l4w_ranks)
    kept_points = {r["damage"] for r in rows}
    for rank in l4w_ranks:
        _, name, points = GROUND_TRUTH[rank]
        assert points in kept_points, f"L4W rank {rank} ({name}) missing: {rows}"


def test_untagged_alliance_keeps_nothing_by_accident():
    """A row that survives tag-matching must have carried a real tag -- this
    isn't directly testable via a public untagged-row fixture (every row in
    the reference doc's table has a tag), but the safety invariant is that
    every returned row's original chunk contained a confirmed 3-char tag
    matching the query. This test locks in that requesting a tag which
    appears nowhere in the text returns zero rows, not a fallback to
    'everything'."""
    rows, total_candidates = ct.parse_capitol_rows(HONOR_ROLL_TEXT, "ZZZ")
    assert rows == []
    assert total_candidates == len(GROUND_TRUTH)
