"""Regression tests for the review/events screens' embed-field truncation
bug: `cogs/capitol_war.py` used to slice a page's rendered row text at
`value[:1010] + "\n…(truncated)"` whenever it exceeded Discord's 1024-char
per-field limit -- which a 25-row page of Capitol War rows (each line
carrying a fid, ~45-50 chars) reliably does well before 25 rows' worth of
text is reached. The page header would claim "Players 1-25 of 52" while
only ~20 rows actually rendered; the rest of that "page" was silently
dropped and never shown anywhere, since the pagination model believed that
page already covered rows 1-25.

Dataset here mirrors the real 52-row alliance from
docs/ocr-reference/capitol_war_mismatch_2026-08-23.md (same header text,
"Players 1-25 of 52", and the same real duplicate-rank collision: real rank
6 (CoolDude1031) colliding with a corrupted-to-6 rank (standing in for the
doc's ReddXking-really-rank-90 case)) -- synthesized directly as enriched
row dicts (same shape `CapitolWarReviewView._enrich_row` produces) rather
than replayed through OCR, since the pipeline itself already has its own
regression coverage in test_capitol_mismatch_2026_08_23.py. This file is
purely about the display/pagination layer.
"""
from __future__ import annotations

from harness import bt, ct

# Real names from the mismatch doc, in the same points-descending order,
# extended with synthetic filler rows out to 52 total -- the doc's own
# alliance size ("Players 1-25 of 52").
_REAL_NAMES_DESC = [
    "Lynx", "LTC", "Tony Montana", "Jesslyn", "Chief3e6e6ee0",
    "CoolDude1031",  # real rank 6
    "GhostNinety",   # corrupted-to-6 stand-in for the doc's ReddXking (real rank 90)
    "FrankSloup", "Valhalla907", "Daddy", "Baba", "WutZa", "Kazuha",
    "Ruri", "Amanises", "Nightmare", "Juancho Diego", "Zizi", "Andrew21",
]


def _build_roster(n: int) -> list[tuple[int, str]]:
    roster = []
    for i, name in enumerate(_REAL_NAMES_DESC, start=1):
        roster.append((67_600_000_000 + i, name))
    for i in range(len(_REAL_NAMES_DESC) + 1, n + 1):
        roster.append((67_600_000_000 + i, f"Player{i:03d}"))
    return roster


def _enrich(name, points, rank, roster, alliance_id=1):
    """Same shape as CapitolWarReviewView._enrich_row -- see
    test_capitol_collision_guard.py's identical helper."""
    candidates = ct.resolve_against_capitol_roster(name, roster, alliance_id)
    status = bt.classify_match(candidates)
    fid = nickname = None
    if status == 'auto':
        fid, nickname, _ = candidates[0]
    return {
        'name': name, 'damage': points, 'rank': rank, 'rank_explicit': True,
        'fid': fid, 'nickname': nickname, 'candidates': candidates, 'status': status,
    }


def _build_52_row_alliance():
    """52 rows, points-descending, real names + duplicate rank 6 up front,
    synthetic filler behind -- same overall shape as the real 52-row
    mismatch-doc alliance."""
    n = 52
    roster = _build_roster(n)
    rows = []
    points = 12_780_331
    for i, name in enumerate(_REAL_NAMES_DESC, start=1):
        rank = 6 if name in ("CoolDude1031", "GhostNinety") else i
        rows.append(_enrich(name, points, rank, roster))
        points -= 350_000
    for i in range(len(_REAL_NAMES_DESC) + 1, n + 1):
        rows.append(_enrich(f"Player{i:03d}", points, i, roster))
        points -= 120_000
    rows.sort(key=lambda r: -r['damage'])
    return rows, roster


def _make_view(rows):
    """Build a CapitolWarReviewView via __new__ (no live cog/Discord needed)
    -- same pattern test_capitol_mismatch_2026_08_23.py's _sort_rows test
    and test_capitol_collision_guard.py use, since build_embed only touches
    plain instance attributes."""
    view = ct.CapitolWarReviewView.__new__(ct.CapitolWarReviewView)
    view.rows = rows
    view.existing_event_id = None
    view.tag_note = None
    view.event_meta = {'date': '2026-08-23', 'event_time': None}
    view.alliance_name = "Apex"
    view.alliance_id = 1
    view.page = 0
    return view


def _all_field_text(embed) -> str:
    return "\n".join(f.value for f in embed.fields if f.value)


def test_full_page_of_rows_renders_with_no_truncation_marker():
    """The core bug: a full 25-row page must render every row, with no
    `…(truncated)` marker ever appearing, even though 25 rows of Capitol
    War's `"**#N** icon `nickname` · `fid` — `points`"` lines comfortably
    exceeds the old single-field 1024-char budget."""
    rows, _roster = _build_52_row_alliance()
    assert len(rows) == 52
    view = _make_view(rows)
    embed = view.build_embed()

    combined = (embed.description or "") + "\n" + _all_field_text(embed)
    assert "truncated" not in combined.lower(), (
        "a legitimate row was silently truncated out of the embed"
    )

    # Sanity: with this codebase's real row-line format, 25 such lines
    # really do exceed one field's 1024-char cap -- prove the fixture
    # actually exercises the bug, not a no-op.
    page_rows = sorted(rows, key=lambda r: -r['damage'])[:25]
    raw_lines_len = sum(
        len(f"**#{r['rank']}** X `{r['nickname']}` · `{r['fid']}` — `{r['damage']:,}`") + 1
        for r in page_rows
    )
    assert raw_lines_len > 1024, (
        f"fixture doesn't actually stress the 1024-char limit ({raw_lines_len} chars)"
    )


def test_every_row_the_header_claims_is_actually_present():
    """"Players 1-25 of 52" must mean all 25 fids from that range are
    genuinely somewhere in the built embed -- not just the first ~20 before
    a silent cutoff."""
    rows, _roster = _build_52_row_alliance()
    view = _make_view(rows)
    embed = view.build_embed()

    header_field = next(f for f in embed.fields if f.name.startswith("Players "))
    assert header_field.name == f"Players 1-25 of {len(rows)}"

    combined = _all_field_text(embed)
    page_rows = sorted(rows, key=lambda r: -r['damage'])[:25]
    missing = [r['fid'] for r in page_rows if str(r['fid']) not in combined]
    assert not missing, f"rows dropped from the claimed 1-25 range: fids {missing}"


def test_player_rows_spill_into_multiple_fields_instead_of_truncating():
    """Structural check on the fix itself: the 25-row page's text is spread
    across more than one embed field (chunk_lines_for_fields), not squeezed
    -- and silently cut -- into a single 1024-char field."""
    rows, _roster = _build_52_row_alliance()
    view = _make_view(rows)
    embed = view.build_embed()

    player_fields = [
        f for f in embed.fields
        if f.name.startswith("Players ") or f.name == "​"
    ]
    assert len(player_fields) > 1, "expected the page to spill into 2+ fields"
    for f in player_fields:
        assert len(f.value) <= 1024, f"a field still exceeds Discord's limit: {len(f.value)} chars"

    # Discord's own hard caps must still hold.
    assert len(embed.fields) <= 25
    total_chars = len(embed.description or "") + sum(
        len(f.name) + len(f.value) for f in embed.fields
    ) + len(embed.title or "")
    assert total_chars <= 6000


def test_duplicate_rank_warning_is_visible_in_the_built_embed():
    """The real doc's core safety signal: two rows sharing an explicit rank
    (CoolDude1031's genuine 6, and a corrupted-to-6 row standing in for the
    doc's real rank-90 ReddXking) must produce a visible
    "Rank 6 appears twice" warning that actually survives into the built
    embed -- not just be present somewhere in rank_sequence_warnings'
    return value while getting silently dropped by some length limit
    upstream of the embed (e.g. the description's own 4096-char budget)."""
    rows, _roster = _build_52_row_alliance()
    view = _make_view(rows)

    warnings = ct.rank_sequence_warnings(rows, check_gaps=False)
    assert any("Rank 6 appears twice" in w for w in warnings), warnings

    embed = view.build_embed()
    combined = (embed.description or "") + "\n" + _all_field_text(embed)
    assert "Rank 6 appears twice" in combined, (
        f"duplicate-rank warning did not survive into the built embed: "
        f"description={embed.description!r}"
    )


def test_later_pages_reach_every_remaining_row():
    """Rows past the first page (26-50, then 51-52 -- 52 rows over
    ROWS_PER_PAGE=25 makes 3 pages) must all be reachable by paging
    forward; no page's claimed range may lose a row either."""
    rows, _roster = _build_52_row_alliance()
    ordered = sorted(rows, key=lambda r: -r['damage'])
    view = _make_view(rows)

    assert view._total_pages() == 3

    for page, (start, end) in enumerate([(0, 25), (25, 50), (50, 52)]):
        view.page = page
        embed = view.build_embed()
        header_field = next(f for f in embed.fields if f.name.startswith("Players "))
        assert header_field.name == f"Players {start + 1}-{end} of {len(rows)}"

        combined = (embed.description or "") + "\n" + _all_field_text(embed)
        assert "truncated" not in combined.lower(), f"truncated on page {page}"
        page_rows = ordered[start:end]
        missing = [r['fid'] for r in page_rows if str(r['fid']) not in combined]
        assert not missing, f"rows dropped from page {page} ({start + 1}-{end}): fids {missing}"
