"""Regression fixture for docs/ocr-reference/vault_trap_mismatch_2026-08-23.md.

Real Vault Trap 1 "Damage Rankings" hunt (23 ranked rows) that produced three
confirmed bugs in production: rank 1 (LTC) silently mismatched to an
unrelated roster member ("WutZa"), rank 10 ("XXX TARGET") dropped entirely
(22 rows instead of 23, no warning), and two different unregistered
participants (rank 14 "Verena Scythe", rank 15 "RayuMaximusZA") both
fuzzy-matched to the same unrelated roster member ("ReddXking").

The raw OCR strings below are pulled verbatim from the reference doc, which
in turn pulled them directly from `log/bot.txt` for the real screenshots --
this is the actual RapidOCR output, not a synthetic approximation. Feeding
it through the real `parse_player_rows` / roster-matching / row-resolution
pipeline and asserting the correct outcome is exactly the regression guard
the bug report asked for.
"""
from __future__ import annotations

from harness import bt, load_roster

ALLIANCE_ID = 4242

# Verbatim raw OCR text per screenshot, from the reference doc's "Raw OCR
# text (pulled directly from log/bot.txt...)" section.
RAW_SCREENSHOTS = [
    # ranks 1-5
    "Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank "
    "Damage Points LTC DamagePoints:456,573,942 Lynx Damage "
    "Points:442,334,158 CP3ECLIPSE 3 DamagePoints:356,456,164 Jesslyn "
    "DamagePoints:290,733,904 Bake 5 Damaae Points:285.505.636",
    # ranks 5-8 (overlaps row 5, Bake)
    "Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank "
    "Damage Points Bake 5 Damage Points:285,505,636 Marzienne 6 "
    "Damage Points:267,601,701 CoolDude1031 7 BE Damage Points:249,721,984 "
    "Nightmare 8 Damage Points:234,879,872 ChiefFAFO "
    "Damage Points:199,905,503",
    # ranks 10-14
    "Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank "
    "Damage Points XXX TARGET 10 Damage Points:161,815,129 applejojo 11 "
    "Damage Points:158,489,321 John McLane 12 Damage Points:140,919,058 "
    "misChief 13 Damage Points:101,055,966 Verena Scythe 14 "
    "Damaqe Points:76.049.339",
    # ranks 15-19 (CND's rank misread as "16" not "19" on this screenshot)
    "Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank "
    "Damage Points RayuMaximusZA 15 Damage Points:74,155,672 Ruri 16 "
    "Damage Points:72,386,915 Jason 17 Damage Points:70,795,649 Kimy 18 "
    "Damage Points:64,386,914 CND 16 Damage Points:45,701,298",
    # ranks 19-23 (overlaps row 19, CND, with correct rank this time)
    "Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank "
    "Damage Points CND 19 Damage Points:45,701,298 Pxdro 20 "
    "Damage Points:21,003,978 Kazuha Nakamura 21 Damage Points:6,133,764 "
    "tripleH 22 Damage Points:4,665,970 C4man 23 Damage Points:1,136,152",
]

# Ground truth: rank -> (name, damage). From the reference doc's screenshots.
GROUND_TRUTH = {
    1: ("LTC", 456_573_942),
    2: ("Lynx", 442_334_158),
    3: ("CP3ECLIPSE", 356_456_164),
    4: ("Jesslyn", 290_733_904),
    5: ("Bake", 285_505_636),
    6: ("Marzienne", 267_601_701),
    7: ("CoolDude1031", 249_721_984),
    8: ("Nightmare", 234_879_872),
    9: ("ChiefFAFO", 199_905_503),
    10: ("XXX TARGET", 161_815_129),
    11: ("applejojo", 158_489_321),
    12: ("John McLane", 140_919_058),
    13: ("misChief", 101_055_966),
    14: ("Verena Scythe", 76_049_339),
    15: ("RayuMaximusZA", 74_155_672),
    16: ("Ruri", 72_386_915),
    17: ("Jason", 70_795_649),
    18: ("Kimy", 64_386_914),
    19: ("CND", 45_701_298),
    20: ("Pxdro", 21_003_978),
    21: ("Kazuha Nakamura", 6_133_764),
    22: ("tripleH", 4_665_970),
    23: ("C4man", 1_136_152),
}

# fid for each name that IS on the roster (see fixtures/rosters/
# vault_trap_mismatch_2026_08_23.json); names not present here are
# deliberately unregistered participants for this hunt.
ROSTER_FID_BY_NAME = {
    "LTC": 70000001, "Lynx": 70000002, "CP3ECLIPSE": 70000003,
    "Jesslyn": 70000004, "Bake": 70000005, "Marzienne": 70000006,
    "CoolDude1031": 70000007, "Nightmare": 70000008, "ChiefFAFO": 70000009,
    "applejojo": 70000010, "John McLane": 70000011, "misChief": 70000012,
    "Ruri": 70000013, "Jason": 70000014, "Kimy": 70000015, "CND": 70000016,
    "Pxdro": 70000017,
}
WUTZA_FID = 67612752866
REDDXKING_FID = 70000019


def _run_pipeline(roster):
    """Real pipeline: repair -> parse -> cross-image merge -> enrich ->
    unique-assignment resolution (collision guard included), mirroring what
    VaultHuntReviewView.__init__ does with real screenshots."""
    event = bt.EventGroup()
    for raw in RAW_SCREENSHOTS:
        repaired = bt.repair_ocr_digits(raw)
        result = bt.ImageResult()
        result.ok = True
        result.rows = {r["damage"]: r for r in bt.parse_player_rows(repaired)}
        event.merge(result, roster=roster)
    merged_rows = list(event.merged_rows.values())

    view = object.__new__(bt.VaultHuntReviewView)
    view.roster = roster
    view.alliance_id = ALLIANCE_ID
    view.rows = [view._enrich_row(r) for r in merged_rows]
    view._resolve_unique_assignments()
    view._sort_rows()
    return view


def _row_by_damage(view, damage):
    for r in view.rows:
        if r["damage"] == damage:
            return r
    return None


def test_all_23_rows_present():
    """Every ground-truth row parses out -- rank 10 (XXX TARGET) must no
    longer vanish (previously 22 rows instead of 23, silently)."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    damages = {r["damage"] for r in view.rows}
    missing = [
        (rank, name, dmg) for rank, (name, dmg) in GROUND_TRUTH.items()
        if dmg not in damages
    ]
    assert not missing, f"rows missing from parsed output: {missing}"
    assert len(view.rows) == 23


def test_ltc_row1_matches_ltc_not_wutza():
    """Rank 1's row must resolve to the real LTC, not silently mismatch to
    the unrelated roster member WutZa."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    row = _row_by_damage(view, 456_573_942)
    assert row is not None
    assert row["name"].strip() == "LTC", f"name corrupted: {row['name']!r}"
    assert row["fid"] == ROSTER_FID_BY_NAME["LTC"]
    assert row["fid"] != WUTZA_FID
    assert row["status"] == "auto"


def test_xxx_target_row_parses_with_full_name():
    """Rank 10's row must survive parsing with its real (if unmatched) name,
    not be dropped or truncated to just 'TARGET'."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    row = _row_by_damage(view, 161_815_129)
    assert row is not None, "XXX TARGET's row was dropped entirely"
    assert row["name"].strip() == "XXX TARGET", f"name mangled: {row['name']!r}"
    # Not a roster member -- must not be force-linked to anyone.
    assert row["fid"] is None
    assert row["rank"] == 10
    assert row["rank_explicit"] is True


def test_verena_scythe_and_rayumaximusza_not_linked_to_reddxking():
    """Two different, real, unregistered participants must not both collapse
    onto the same unrelated roster member (ReddXking)."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    verena = _row_by_damage(view, 76_049_339)
    rayu = _row_by_damage(view, 74_155_672)
    assert verena is not None and rayu is not None
    assert verena["fid"] != REDDXKING_FID, (
        f"Verena Scythe wrongly linked to ReddXking: {verena}"
    )
    assert rayu["fid"] != REDDXKING_FID, (
        f"RayuMaximusZA wrongly linked to ReddXking: {rayu}"
    )
    # Neither is a roster member in this fixture -- correct outcome is
    # unmatched (available for "add as new player"), not linked to anyone.
    assert verena["fid"] is None
    assert rayu["fid"] is None


def test_no_two_rows_share_a_confirmed_fid():
    """Structural invariant: whatever the matcher decides, two different
    rows must never end up auto/likely-confirmed to the same real fid."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    seen = {}
    for r in view.rows:
        if r["fid"] is None:
            continue
        assert r["fid"] not in seen, (
            f"fid {r['fid']} confirmed on two rows: "
            f"{seen[r['fid']]!r} and {r!r}"
        )
        seen[r["fid"]] = r


def test_rank_16_duplicate_is_flagged():
    """CND's rank misread as 16 on one screenshot (colliding with the real
    Ruri/rank-16 row) and correctly read as 19 on the overlapping next
    screenshot -- the cross-image merge has no reason to prefer either
    explicit reading over the other (both are equally well-formed), so
    whichever one is kept, the duplicate against Ruri's real rank-16 row
    must be surfaced rather than silently swallowed. This is the exact
    scenario from the reference doc."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    ruri = _row_by_damage(view, 72_386_915)
    cnd = _row_by_damage(view, 45_701_298)
    assert ruri is not None and cnd is not None
    assert ruri["rank"] == 16 and ruri["rank_explicit"] is True
    # CND's merged rank is whichever explicit reading the tiebreak kept
    # (16 or 19) -- both are real OCR output for the same row, so either is
    # an acceptable outcome here. What must NOT happen is the collision
    # disappearing silently.
    assert cnd["rank"] in (16, 19)
    warnings = view._rank_sequence_warnings()
    if cnd["rank"] == 16:
        assert any("16" in w and "twice" in w for w in warnings), (
            f"rank-16 duplicate (Ruri vs CND) should be flagged: {warnings}"
        )
    else:
        assert any("19" in w and "missing" in w for w in warnings), (
            f"rank 19 should show as missing if CND kept its rank-16 read: {warnings}"
        )


def test_rank_sequence_gaps_are_only_the_genuine_ocr_ones():
    """With XXX TARGET's row no longer dropped, rank 10 must not appear as a
    gap. Ranks 4 (Jesslyn) and 9 (ChiefFAFO) genuinely have no rank digit
    anywhere in the raw OCR text for this hunt (verified against the
    reference doc's raw text) -- that's real OCR limitation, not a parsing
    bug, so they're expected to still show as gaps. Rank 19 may also show as
    a gap depending on how the CND rank-16/19 merge tiebreak resolved (see
    test_rank_16_duplicate_is_flagged)."""
    roster = load_roster("vault_trap_mismatch_2026_08_23")
    view = _run_pipeline(roster)
    warnings = view._rank_sequence_warnings()
    gap_warnings = [w for w in warnings if "missing" in w]
    assert not any("Rank 10 " in w for w in gap_warnings), (
        f"rank 10 (XXX TARGET) must not be reported missing: {gap_warnings}"
    )
    gap_ranks = {int(w.split()[1]) for w in gap_warnings}
    assert gap_ranks <= {4, 9, 19}, (
        f"unexpected rank gaps beyond the known genuine-OCR ones: {gap_warnings}"
    )


def test_rank_sequence_warnings_detect_injected_gap_and_duplicate():
    """Direct unit check of _rank_sequence_warnings' own logic, independent
    of this fixture's specific data: a gap and a duplicate in the explicit
    ranks must both surface, and an inferred (non-explicit) rank must not
    mask a real gap."""
    view = object.__new__(bt.VaultHuntReviewView)
    view.rows = [
        {"rank": 1, "rank_explicit": False, "damage": 100},  # inferred, ignored
        {"rank": 9, "rank_explicit": True, "damage": 90},
        # rank 10 missing entirely
        {"rank": 11, "rank_explicit": True, "damage": 80},
        {"rank": 16, "rank_explicit": True, "damage": 70},
        {"rank": 16, "rank_explicit": True, "damage": 60},  # duplicate
    ]
    warnings = view._rank_sequence_warnings()
    assert any("10" in w and "missing" in w for w in warnings)
    assert any("16" in w and "twice" in w for w in warnings)
    # The inferred rank 1 must not be treated as part of the explicit
    # sequence (it would otherwise falsely "cover" ranks 1-8 as present).
    assert not any("appears to be missing" in w and "8" in w for w in warnings)
