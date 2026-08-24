# Vault Trap Operation — screenshot reference (Police Chief)

Transcribed from user-supplied screenshots (in-game Mail screen) on 2026-08-20. This is
the Vault Trap Operation event mail, used for
`attendance_ocr_parsers.py` / `vault_track.py` OCR fingerprinting.

## Mail page 1 — Summary (title + personal + alliance overview)

Layout top to bottom:

```
Mail                                          [back arrow]    [X close]

[envelope icon]  Vault Trap Operation

[banner image with in-game date/time stamp, e.g. "2026-08-20 22:30:01"]

            Arrested!

Dear Chief: Congratulations! Your Alliance completed the Vault Trap Operation!

            Battle Overview

Rallies: 40
Alliance Total Damage: 4,099,015,688

            Solo Damage Rewards

In Vault Trap 1, you earned a total of 442,334,158 points based on the damage you
dealt. Your damage rank is 2. Here are your rewards!

[reward icon grid — 7 items, each an icon + a quantity label, e.g. "9", "100", "2",
"60.8K", "27.7M", "27.7M", "5.5M", "1.3M" — quantities are free-form K/M-suffixed
numbers, no fixed labels under the icons]

            [Claimed]  (button, greyed out once claimed)
```

Key fixed strings to fingerprint on (stable across runs, numbers vary):
- `"Vault Trap Operation"` — mail title, appears at top of both page 1 and page 2/3.
- `"Arrested!"` — banner label.
- `"Your Alliance completed the Vault Trap Operation!"` — confirmation line.
- `"Battle Overview"` — section header.
- `"Rallies: {int}"` — alliance-wide rally count.
- `"Alliance Total Damage: {int, comma-grouped}"` — alliance-wide damage total.
- `"Solo Damage Rewards"` — section header.
- `"In Vault Trap {N}, you earned a total of {int, comma-grouped} points based on the
  damage you dealt. Your damage rank is {int}. Here are your rewards!"` — the `{N}`
  is the operation/wave number (seen "1" here — may increment per sub-round if
  Vault Trap turns out to have a multi-wave structure, not yet confirmed); `{points}` = the player's own damage-based score
  (note: this is *not* the same number as their raw "Damage Points" in the rankings
  list below in this sample — 442,334,158 matches their rankings entry here, so in
  this case they're equal, but treat as two logically separate values in the parser
  since the copy explicitly says "points... based on the damage you dealt", implying
  a possible multiplier/scoring formula in general); `{rank}` = player's own numeric
  rank.
- `"Claimed"` — button state once rewards are collected (also likely reads
  "Claim"/"Unclaimed" before collection — only "Claimed" observed).

## Mail page 2/3 — Damage Rankings (paginated leaderboard)

Same mail (swipe via `< >` arrows at page 1's "Solo Damage Rewards" header takes you
here), header changes to:

```
[envelope icon]  Vault Trap Operation

            Damage Rankings

[rank]  [avatar]  {player_name}
                   Damage Points: {int, comma-grouped}
... (repeats, ~9-10 rows per page, paginated with < > arrows)
```

Observed 10 rows across 2 screenshots of the same leaderboard (rows 1-9 repeat between
the two, row 10 "ChiefFAFO" only in the first — rows can shift/reflow slightly, so
don't assume a fixed row count per page):

| Rank | Name | Damage Points |
|------|------|----------------|
| 1 | LTC | 456,573,942 |
| 2 | Lynx | 442,334,158 |
| 3 | CP3ECLIPSE | 356,456,164 |
| 4 | FrankSloup | 316,607,699 |
| 5 | Jesslyn | 290,733,904 |
| 6 | Bake | 285,505,636 |
| 7 | Marzienne | 267,601,701 |
| 8 | CoolDude1031 | 249,721,984 |
| 9 | Nightmare | 234,879,872 |
| 10 | ChiefFAFO | 199,905,503 |

Formatting notes:
- Ranks 1-3 render as circular medal badges (gold/silver/bronze), not plain digits —
  OCR may need to treat top-3 differently (icon detection or accept blank/garbled rank
  text for rows 1-3 and infer rank from row order instead of reading the badge).
  Ranks 4+ render as plain numerals.
- Each row: small circular avatar image (player-customized, not usable for name
  matching), then `{player_name}` on its own line, then `"Damage Points: {int}"` on
  the line below — this two-line-per-row structure matches
  vault_track's existing row-pair parsing approach, should be directly adaptable.
- Names can contain arbitrary characters (seen: plain alnum, and "CP3ECLIPSE" mixing
  digits into the name) — don't assume alpha-only when building the name regex/fuzzy
  match against the alliance roster.

## Fingerprint regex suggestions (for `attendance_ocr_parsers.py` `EVENT_TYPES` config,
mirroring the existing `foundry_battle`/`canyon_clash` entries)

```python
"vault_trap": EventTypeConfig(
    # ... existing fields (display name, legion_required, event_weekday, etc. — TBD,
    # we don't have confirmed weekday/cadence data yet, leave those None/admin-set)
    fingerprint_regex=r"Vault\s+Trap\s+Operation|Battle\s+Overview.*Rallies|Solo\s+Damage\s+Rewards",
    rankings_header_regex=r"Damage\s+Rankings",
    row_regex=r"(?P<name>.+)\s*\n\s*Damage\s+Points:\s*(?P<points>[\d,]+)",
    alliance_summary_regex=r"Rallies:\s*(?P<rallies>\d+)\s*Alliance\s+Total\s+Damage:\s*(?P<total_damage>[\d,]+)",
    personal_summary_regex=r"In\s+Vault\s+Trap\s+(?P<wave>\d+),\s*you\s+earned\s+a\s+total\s+of\s+(?P<points>[\d,]+)\s+points.*Your\s+damage\s+rank\s+is\s+(?P<rank>\d+)",
),
```

These are a starting point for the Phase 6 implementing agent to adapt against
`vault_track.py`'s actual OCR text-extraction quirks (line-break handling, OCR noise
tolerance, etc.) — not guaranteed to match RapidOCR's raw text output verbatim without
testing against real OCR runs.

## Still needed for full OCR coverage (not in this screenshot set)

No sample screenshots yet for: PD Development Event, Arms Race Event, Officer Program
Event, Hero Program Event, Alliance Faceoff, State Capitol Siege. Those remain
manual-entry-only (Phase 5) until screenshots are supplied.
