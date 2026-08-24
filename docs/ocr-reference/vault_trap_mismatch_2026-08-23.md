# Vault Trap 1 OCR mismatch — real failure case (2026-08-23)

User-supplied screenshots of the actual in-game "Damage Rankings" list (5 screenshots,
ranks 1-23, scrolled/paginated) vs. the bot's parsed output for the same hunt. This is a
**ground-truth regression fixture** — use it to verify any OCR/matching fix actually
resolves these specific failures, not just "looks better."

## Ground truth (from screenshots, rank → name → damage)

| Rank | Name | Damage |
|------|------|--------|
| 1 | LTC | 456,573,942 |
| 2 | Lynx | 442,334,158 |
| 3 | CP3ECLIPSE | 356,456,164 |
| 4 | Jesslyn | 290,733,904 |
| 5 | Bake | 285,505,636 |
| 6 | Marzienne | 267,601,701 |
| 7 | CoolDude1031 | 249,721,984 |
| 8 | Nightmare | 234,879,872 |
| 9 | ChiefFAFO | 199,905,503 |
| 10 | XXX TARGET | 161,815,129 |
| 11 | applejojo | 158,489,321 |
| 12 | John McLane | 140,919,058 |
| 13 | misChief | 101,055,966 |
| 14 | Verena Scythe | 76,049,339 |
| 15 | RayuMaximusZA | 74,155,672 |
| 16 | Ruri | 72,386,915 |
| 17 | Jason | 70,795,649 |
| 18 | Kimy | 64,386,914 |
| 19 | CND | 45,701,298 |
| 20 | Pxdro | 21,003,978 |
| 21 | Kazuha Nakamura | 6,133,764 |
| 22 | tripleH | 4,665,970 |
| 23 | C4man | 1,136,152 |

23 rows total. Rank badges 1-3 are medal icons (no digit glyph); ranks 4+ render as plain
numerals in a grey square tile.

## What the bot actually produced (review screen, "Players (22)")

```
#1  WutZa · 67612752866 — 456,573,942
#2  Lynx · 67612758451 — 442,334,158
#3  CP3ECLIPSE · 67613181899 — 356,456,164
#4  Jesslyn · 67613180706 — 290,733,904
#5  Bake · 67613180966 — 285,505,636
#6  Marzienne · 67613172439 — 267,601,701
#7  CoolDude1031 · 67613189181 — 249,721,984
#8  Nightmare · 67613174243 — 234,879,872
#9  ChiefFAFO · 67612753237 — 199,905,503
#10 applejojo · 67613172529 — 158,489,321
#11 John McLane · 67613192779 — 140,919,058
#12 misChief · 67612756959 — 101,055,966
#13 ReddXking · 67613176862 — 76,049,339
#14 ReddXking (100%) - taken by another row — 74,155,672
#15 Ruri · 67613184960 — 72,386,915
#16 Jason · 67613183207 — 70,795,649
#17 Kimy · 67612761127 — 64,386,914
#18 CND · 67613174197 — 45,701,298
#19 Pxdro · 67612745207 — 21,003,978
#20 'Kazuha Nak[...] (truncated, presumably Kazuha Nakamura)
...
1 row(s) without a confirmed player will be saved as unmatched.
```
Only 22 players total (should be 23) — `tripleH` and `C4man` weren't checked yet since the
list was truncated in the screenshot, but the count is confirmed short by 1 regardless of
what's past the truncation, since rank 10 (XXX TARGET) is provably absent below.

## Diagnosed failures, matched by damage value (the reliable anchor — damage numbers are
unique per row and easy to verify OCR got right, since they're pure digits)

1. **Rank 1 (LTC, 456,573,942) matched to the wrong real person, "WutZa".**
   `WutZa` is a genuine roster member (real fid `67612752866`) but was never in this hunt
   — the OCR text for LTC's row must have been misread into something that scored a
   confident (≥90, auto-accept) fuzzy match against WutZa's name instead of LTC's. LTC's
   own name never appears anywhere in the output. This is the most dangerous class of bug:
   a **wrong but plausible** match sails through silently with no review flag, because the
   matcher was confident about the wrong answer.

2. **Rank 10 (XXX TARGET, 161,815,129) is missing entirely — dropped, not misread.**
   Every row below it shifted up by one damage-value position with no corresponding name
   confusion (rank 11 applejojo's real damage 158,489,321 appears correctly labeled
   `applejojo`), so this isn't a matching failure — the row-parser never produced a row for
   rank 10 at all. `XXX TARGET`'s icon is a bullseye/target emblem rather than a normal
   avatar photo, and the name itself contains a space and repeated characters ("XXX") —
   worth checking whether the icon-detection or name-extraction regex is discarding this
   row specifically because of its unusual glyph/whitespace shape. This single dropped row
   is why the bot reports "22" instead of "23."

3. **Two different real rows (rank 14 Verena Scythe/76,049,339, rank 15
   RayuMaximusZA/74,155,672) both matched to the same real roster member, "ReddXking."**
   Since a leaderboard can't legitimately have the same person appear twice, this is a
   strong, structural signal that both of these rows' OCR text was corrupted enough that
   neither should have been treated as a confident match — yet both independently scored
   high enough against `ReddXking` to trigger (one auto-linked, one flagged only as "taken
   by another row" rather than as itself being suspect).

## Raw OCR text (pulled directly from log/bot.txt, `[en]` pass, for the actual screenshots
that produced this hunt) — CONCLUSIVE evidence the OCR engine itself read every disputed
name correctly. The corruption happens downstream, in `parse_player_rows`'s chunk/name
extraction or in `match_roster`'s fuzzy matching — NOT in RapidOCR's text recognition.
Do not spend time trying to improve image preprocessing/OCR engine settings; the bug is in
this repo's own parsing/matching code.

```
Screenshot_2026-08-21_135701.png (ranks 1-5):
'Vault Trap 1 Damage Rewards X Damage Rankings Solo Damage Rewards Rank Damage Points
LTC DamagePoints:456,573,942 Lynx Damage Points:442,334,158 CP3ECLIPSE 3
DamagePoints:356,456,164 Jesslyn DamagePoints:290,733,904 Bake 5 Damaae Points:285.505.636'

Screenshot_2026-08-21_135706.png (ranks 5-8, overlaps row 5 with the above):
'... Rank Damage Points Bake 5 Damage Points:285,505,636 Marzienne 6
Damage Points:267,601,701 CoolDude1031 7 BE Damage Points:249,721,984 Nightmare 8
Damage Points:234,879,872 ChiefFAFO Damage Points:199,905,503'

Screenshot_2026-08-21_135714.png (ranks 10-14):
'... Rank Damage Points XXX TARGET 10 Damage Points:161,815,129 applejojo 11
Damage Points:158,489,321 John McLane 12 Damage Points:140,919,058 misChief 13
Damage Points:101,055,966 Verena Scythe 14 Damaqe Points:76.049.339'

Screenshot_2026-08-21_135721.png (ranks 15-19, note CND's rank misread as "16" not "19"):
'... Rank Damage Points RayuMaximusZA 15 Damage Points:74,155,672 Ruri 16
Damage Points:72,386,915 Jason 17 Damage Points:70,795,649 Kimy 18
Damage Points:64,386,914 CND 16 Damage Points:45,701,298'

Screenshot_2026-08-21_135726.png (ranks 19-23, overlaps row 19 with the above, correct rank this time):
'... Rank Damage Points CND 19 Damage Points:45,701,298 Pxdro 20
Damage Points:21,003,978 Kazuha Nakamura 21 Damage Points:6,133,764 tripleH 22
Damage Points:4,665,970 C4man 23 Damage Points:1,136,152'
```

Key observations from this raw text:
- **`LTC`**: name is exactly `LTC` (3 chars), immediately followed by `DamagePoints:` with
  **no space** between "Damage" and "Points" (unlike most other rows, which have a space:
  `Damage Points:`). LTC never appears anywhere in the bot's final output — it silently
  became "WutZa" instead. Note `CP3ECLIPSE` and `Jesslyn`'s rows in this SAME screenshot
  also have the no-space `DamagePoints:` variant and those matched correctly, so the
  no-space label alone doesn't explain it — the specific combination with a very short
  (3-char) name is the likely trigger (check `_LEADING_SHORT_TOKEN_RE`, which explicitly
  strips leading ≤3-char tokens before a 4+ char token — if it treats `LTC` itself as a
  strippable short token before `DamagePoints`, that would delete the name entirely,
  leaving `DamagePoints`/similar noise to fuzzy-match against the roster instead).
- **`XXX TARGET`**: extracted cleanly, with its explicit rank digit `10` present and
  correctly spaced (`XXX TARGET 10 Damage Points:161,815,129`). This row is completely
  absent from the bot's final output (22 rows instead of 23) despite the raw text having
  everything needed to parse it correctly — trace `parse_player_rows`'s chunk-filtering
  steps (the `[.?\[\]]` chunk-rejection check, the `<3 alpha` blanking check, and
  `_LEADING_SHORT_TOKEN_RE`) against the literal chunk this row would produce to find which
  one is eating it. `XXX` is a 3-char all-caps token followed by a space then `TARGET`
  (6 chars) — another `_LEADING_SHORT_TOKEN_RE` collision candidate, same mechanism as the
  LTC theory above, but here it would strip `XXX ` and leave `TARGET` as the name instead
  of deleting the row outright, so if the row vanished entirely rather than being mislabeled
  `TARGET`, look for a *different* failure mode (e.g. rank-digit `10` immediately followed
  by `Damage` confusing the row split some other way) — don't assume it's the same bug as
  LTC's just because both involve short leading tokens.
- **`Verena Scythe`** (`Damaqe Points:76.049.339` — OCR typo'd "Damage"→"Damaqe", and used
  periods instead of commas as thousand-separators) and **`RayuMaximusZA`**
  (`Damage Points:74,155,672`, clean) both extracted with correct, unambiguous, distinct
  names — neither string bears any resemblance to `ReddXking` (a real different roster
  member). Both ended up assigned to `ReddXking` in the final output, which means
  `match_roster`/`resolve_against_roster` scored `ReddXking` as `MATCH_LIKELY_MIN`+ (80+)
  for both of these clearly-different names. Since neither `Verena Scythe` nor
  `RayuMaximusZA` are existing roster members (they read as new/unregistered
  participants), the correct behavior is for both rows to land as **unmatched** (available
  for the "add as new player" flow, now that that flow works — see recent commits), not
  silently mislinked to an unrelated real member. This points at `match_roster`'s
  `rapidfuzz.fuzz.WRatio` scoring being too permissive for short-vs-long / partial-token
  comparisons — investigate whether a stricter scorer (e.g. requiring both `WRatio` *and* a
  plain `ratio()`/`token_sort_ratio()` to individually clear a bar, not just the single
  lenient `WRatio` figure) would have correctly scored these below `MATCH_LIKELY_MIN`.

## Root-cause questions to investigate in code (not yet answered — for whoever picks this up)

- Is there a raw-OCR-text dump/log available per hunt/row that would show what RapidOCR
  actually extracted for rank 1, rank 10, and ranks 14-15 *before* fuzzy-matching, so we
  can tell whether this is a text-extraction bug (wrong substring grabbed, row
  misaligned/skipped) vs. a pure fuzzy-matching-threshold bug (correct-ish text, wrong
  roster pick)? Check for a debug/log path in the OCR pipeline before assuming which layer
  is at fault.
- Is `XXX TARGET`'s row being dropped at the OCR text-line-detection stage (RapidOCR never
  produced a text box for it) or at the row-regex-parsing stage (text was extracted but the
  parser's row pattern didn't match it, e.g. due to the space/repeated-X format)?
- Does the row parser currently use each row's **rank number** as a structural signal at
  all, or does it purely walk detected name/damage pairs in visual order and hope nothing
  drifts? The user explicitly wants rank enforced: rank and name must be extracted as one
  linked unit, and the full expected rank sequence (whatever ranks are visible in a given
  screenshot) should be validated as contiguous — a gap should surface as an explicit
  "rank N appears to be missing" warning rather than silently shrinking the row count.
- Should there be a same-hunt collision guard that fires *before* accepting a high-score
  auto-match — i.e. if two rows in the same hunt would both confidently resolve to the same
  fid, treat that as a red flag on both rows (drop both to "needs review") rather than
  silently accepting the first and merely footnoting the second as a conflict?
