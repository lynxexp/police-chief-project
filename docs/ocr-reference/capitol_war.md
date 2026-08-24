# Capitol War — screenshot reference (Police Chief)

Transcribed from 19 user-supplied screenshots (in-game "Honor Roll" screen) on
2026-08-23. State-wide event: the whole state competes for control of the Capitol,
so results include every alliance in the state, not just the tracked one.

## Screen layout

```
[< Events]

            Honor Roll

[Rankings tab]  [Ranking Rewards tab]   <- Rankings tab shown in all 19 screenshots

Rank | Chief | Points

[rank tile] [avatar] [TAG]PlayerName    Points
... 5 rows per screenshot page, scrolled/paginated ...

[pinned own-row, always last, out of rank order]
1 [APX]Lynx  12,780,331  (!)
```

- Title is **"Honor Roll"**, not a mail — this is a live in-game ranking screen (Events
  tab), not a mail reward like Vault Trap. No "Total Alliance Damage"/rallies-style
  alliance summary line exists on this screen — only individual rows.
- Two tabs: **Rankings** (what all 19 screenshots show) and **Ranking Rewards**
  (personal reward tier list, not captured in this screenshot set — same relationship
  as Vault Trap's "Damage Rankings" vs "Solo Damage Rewards" tabs, just not provided
  here yet).
- Column header row: `Rank | Chief | Points` (not "Damage Points" — just "Points").
- **Every name is prefixed with the player's alliance tag in brackets**, e.g.
  `[APX]Lynx`, `[L4W]Chief Nicol`, `[BOO]julink`, `[S42]5StarGeneral`, `[FOH]momo`,
  `[Yns]legoman`, `[TLW]Champ134`. Tags are exactly 3 characters (matches the
  already-existing `_ALLIANCE_TAG_RE = r'\[[A-Za-z0-9]{3}\]'` in `vault_track.py`,
  built for this exact bracket format).
- Observed rank range: **1 through at least 99** in this screenshot set (far bigger
  than Vault Trap's ~23) — pages overlap by one row each when scrolling (e.g. rank 19
  appears as the last row of one screenshot and the first row of the next), same
  pagination/overlap pattern as Vault Trap.
- **Pinned own-row**: every single screenshot, regardless of which rank range it's
  showing, has an extra row at the very bottom showing the account's own entry —
  in this dataset literally `1 [APX]Lynx 12,780,331` on every page (this account's
  owner happens to be rank 1 overall, so it's not obviously "out of place," but
  structurally this is the same pinned/duplicate-row mechanism already handled for
  Vault Trap's ranking pages — `tests/test_vault_pinned_row.py`, whose fixtures use
  the same bracket-tagged ranking style, `[DOG]PinkyCosmoDog` etc.). **Reuse that
  exact dedup logic** — do not write new pinned-row handling from scratch.
- A small `(!)` info icon sits after the points value on the pinned row only.

## Sample rows (rank → tag → name → points), verified from screenshots

| Rank | Tag | Name | Points |
|------|-----|------|--------|
| 1 | APX | Lynx | 12,780,331 |
| 2 | APX | LTC | 11,792,466 |
| 3 | APX | Tony Montana | 11,119,046 |
| 4 | APX | Jesslyn | 8,833,752 |
| 5 | APX | Chief3e6e6ee0 | 8,620,267 |
| 41 | APX | jukesy | 3,524,430 |
| 42 | L4W | Chief Nicol | 3,518,601 |
| 43 | APX | Pxdro | 3,514,197 |
| 44 | APX | Bake | 3,473,237 |
| 45 | APX | Lee Sung Kyung | 3,443,473 |
| 86 | L4W | Alaa Ztn | 851,552 |
| 87 | BOO | julink | 820,264 |
| 88 | L4W | nightfire | 813,282 |
| 89 | APX | qlphasix | 781,760 |
| 90 | APX | ReddXking | 626,162 |
| 91 | APX | Baba | 598,307 |
| 92 | FOH | Kopassus Elite | 597,041 |
| 93 | L4W | Chief Tenpenny | 589,026 |
| 94 | S42 | Osadolor | 588,774 |
| 95 | FOH | momo | 556,937 |
| 96 | S42 | 5StarGeneral | 556,728 |
| 97 | L4W | DAMIAN29DANMILLE | 542,944 |
| 98 | Yns | legoman | 502,133 |
| 99 | TLW | Champ134 | 457,781 |

Note the mix: most rows near the top are `[APX]` (this alliance is doing well), but
plenty of `[L4W]`, `[BOO]`, `[FOH]`, `[S42]`, `[Yns]`, `[TLW]` rows are interleaved
throughout — confirms this is genuinely state-wide, not filtered by the game itself.
**Only `[APX]`-tagged rows are relevant for Apex's own tracking**; every other-tagged
row should be discarded before roster-matching even runs (don't waste match attempts
on rival alliances' rosters, and don't risk a coincidental name collision, e.g. if a
rival alliance happens to also have a "Lynx").

## What this means for the feature

1. **New alliance setting: a 3-character short tag** (e.g. Apex → `APX`), admin-settable
   per alliance (same pattern as the existing "Set State" action in Alliance
   Management), used to filter Capitol War rows down to just this alliance before
   matching. Case-insensitivity should probably be assumed (OCR casing may vary).
2. **Row filtering by tag happens BEFORE roster fuzzy-matching**, not after — a row
   tagged `[L4W]` should never even be compared against the Apex roster.
3. Terminology: the game calls it **"Points"**, not "Damage" — use that word in
   schema/UI for this event, matching the source screen rather than reusing Vault
   Trap's "damage" language verbatim.
4. No wave/operation-number concept is visible anywhere in this screenshot set (unlike
   Vault Trap's "Vault Trap 1"/"Vault Trap 2") — Capitol War appears to be one
   ranking snapshot per occurrence, dated, with no sub-operation numbering.
5. Pinned own-row dedup: reuse the exact existing logic already proven for Vault
   Trap's ranking pages (same bracket-tag format, same out-of-order trailing-row
   pattern) rather than reimplementing it.
