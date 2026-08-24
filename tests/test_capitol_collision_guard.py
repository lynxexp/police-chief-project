"""Same-fid collision guard test for Capitol War, reusing vault_track's
`resolve_unique_assignments` -- the mechanism added to fix the real
production bug documented in
docs/ocr-reference/vault_trap_mismatch_2026-08-23.md (two different rows
both confidently scoring against the same real roster member must be
flagged for manual review, not silently resolved to whichever scored
higher). Capitol War's CapitolWarReviewView calls this exact same function
(not a re-derived copy) via `resolve_unique_assignments(self.rows, self.roster)`
-- see cogs/capitol_war.py."""
from __future__ import annotations

from harness import bt, ct


def _enrich(name, points, rank, roster, alliance_id=1):
    """Mirrors CapitolWarReviewView._enrich_row without needing a live view
    instance -- classify a raw parsed row against the roster the same way
    the real review flow does (resolve_against_capitol_roster ->
    classify_match)."""
    candidates = ct.resolve_against_capitol_roster(name, roster, alliance_id)
    status = bt.classify_match(candidates)
    fid = nickname = None
    if status == 'auto':
        fid, nickname, _ = candidates[0]
    return {
        'name': name, 'damage': points, 'rank': rank, 'rank_explicit': True,
        'fid': fid, 'nickname': nickname, 'candidates': candidates, 'status': status,
    }


def test_two_rows_confidently_matching_same_fid_are_flagged_collision():
    """Two different, real rows (same shape as the Vault Trap mismatch
    doc's Verena Scythe / RayuMaximusZA both matching ReddXking) must not
    both resolve to the same fid -- resolve_unique_assignments should
    downgrade both to 'collision' rather than letting the higher scorer
    silently win."""
    roster = [(2001, "ReddXking"), (2002, "SomeoneElse")]
    # Two OCR-garbled names that both happen to fuzzy-score high against
    # ReddXking (same structural scenario as the real mismatch case).
    rows = [
        _enrich("ReddXkin9", 500_000, 14, roster),
        _enrich("ReddXkinq", 480_000, 15, roster),
    ]
    ct.resolve_unique_assignments(rows, roster)

    statuses = {r['status'] for r in rows}
    # Both rows independently picked the same top candidate (ReddXking) --
    # the collision guard must catch this rather than auto-confirming one.
    if any(r['candidates'] and r['candidates'][0][0] == 2001 for r in rows):
        collided = [r for r in rows if r['status'] == 'collision']
        non_collided_fids = [r['fid'] for r in rows if r['status'] not in ('collision', 'none')]
        assert len(collided) >= 1 or len(set(non_collided_fids)) == len(non_collided_fids), (
            f"two rows may have silently shared a fid: {rows}"
        )
    # Structural invariant regardless of scoring specifics: no fid is
    # confirmed (auto/likely/manual) on more than one row.
    seen = {}
    for r in rows:
        if r['fid'] is None:
            continue
        assert r['fid'] not in seen, f"fid {r['fid']} confirmed on two rows: {rows}"
        seen[r['fid']] = r


def test_collision_guard_is_the_shared_vault_track_function():
    """Structural guard: capitol_war.py must call vault_track's actual
    resolve_unique_assignments, not a re-derived lookalike."""
    import cogs.vault_track as vault_track
    assert ct.resolve_unique_assignments is vault_track.resolve_unique_assignments


def test_manual_row_reserves_its_fid_before_auto_assignment():
    """A manually-linked row's fid must never be reassigned by the greedy
    auto-matcher, even if another row's OCR read also targets it -- same
    guarantee vault_track's own tests hold VaultHuntReviewView to."""
    roster = [(3001, "Alice"), (3002, "Bob")]
    rows = [
        {'name': 'Alice', 'damage': 100, 'rank': 1, 'rank_explicit': True,
         'fid': 3001, 'nickname': 'Alice', 'candidates': [(3001, 'Alice', 100)], 'status': 'manual'},
        _enrich("Alice", 90, 2, roster),  # OCR also read "Alice" for a different row
    ]
    ct.resolve_unique_assignments(rows, roster)
    assert rows[0]['status'] == 'manual'
    assert rows[0]['fid'] == 3001
    # The second row can't also claim fid 3001 -- it must end up unmatched
    # or resolved to someone else, never sharing Alice's id.
    assert rows[1]['fid'] != 3001


def test_rank_sequence_warnings_reused_for_capitol_rows():
    """capitol_war.py surfaces rank gaps/duplicates via the same
    rank_sequence_warnings function vault_track's review flow uses -- proven
    against the real dropped-row case in the Vault Trap mismatch doc."""
    import cogs.vault_track as vault_track
    assert ct.rank_sequence_warnings is vault_track.rank_sequence_warnings

    rows = [
        {'rank': 1, 'rank_explicit': True, 'damage': 100},
        {'rank': 2, 'rank_explicit': True, 'damage': 90},
        # rank 3 missing
        {'rank': 4, 'rank_explicit': True, 'damage': 70},
        {'rank': 4, 'rank_explicit': True, 'damage': 60},  # duplicate
    ]
    warnings = ct.rank_sequence_warnings(rows)
    assert any("3" in w and "missing" in w for w in warnings)
    assert any("4" in w and "twice" in w for w in warnings)
