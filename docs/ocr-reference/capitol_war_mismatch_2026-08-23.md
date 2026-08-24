# Capitol War OCR mismatch — real failure case (2026-08-23)

Real 19-screenshot Capitol War session (the same screenshots documented in
`capitol_war.md`), raw OCR text pulled from `log/bot.txt`, compared against the bot's
actual review-screen output. This is a **ground-truth regression fixture**.

## The bug, concretely (from the actual review screen the user saw)

```
Players 1-25 of 52                              Alliance Total Points: 222,385,901
#1  ✅ Lynx · 67612758451 — 12,780,331
#2  ✅ LTC · 67612754142 — 11,792,466
#3  〰 Tony Montana · 67613183787 — 11,119,046
#4  ✅ Jesslyn · 67613180706 — 8,833,752
#5  ✅ Chief3e6e6ee0 · 67613172108 — 8,620,267
#6  ✅ CoolDude1031 · 67613189181 — 7,842,127
#6  ✅ Merccc · 67612754019 — 6,578,892      <- duplicate #6, real rank should be ~9
#6  ✅ ReddXking · 67613176862 — 626,162     <- duplicate #6, real rank is 90 (!)
#7  ✅ FrankSloup · 67612758900 — 7,128,968
#10 〰 Valhalla907 · 67612738805 — 6,569,772
#10 ✅ Daddy · 67612746950 — 6,451,998
#11 〰 Baba · 67612751098 — 598,307          <- rank 11 but points ~600K, real rank is 91
#12 ✅ WutZa · 67612752866 — 6,408,943
#13 ✅ Kazuha Nakamura · 67612754797 — 5,877,477
#13 ✅ Ruri · 67613184960 — 5,846,802        <- duplicate #13, real rank should be ~14
#15 ✅ Amanises · 67612738148 — 5,786,355
#16 ✅ Nightmare · 67613174243 — 5,337,431
#16 ❌ Juancho Diego — no match — 4,941,456  <- duplicate #16, real rank should be ~19
#18 ❌ Zizi — no match — 5,076,417
#20 ❌ Andrew21 — no match — 4,937,814
#22 ✅ 'ap · ...                             <- name truncated/garbled
```

**The list is displayed sorted by the OCR'd rank number.** Since rank digits are short
(1-2 characters) and far more prone to OCR misreads than the long comma-grouped points
values, a single bad digit read completely scrambles both the rank LABEL (colliding
with a real different row at that number) and the DISPLAY ORDER (a rank-90 row sorts
next to rank-6 rows, landing a 626K-point entry between two ~7M-point entries).

## Raw OCR text (from log/bot.txt, `[en]` pass, all 19 screenshots) — proves these are
genuine OCR misreads of the rank digit specifically, not a name/points extraction bug

```
IMG_6982.PNG: '... Rank Chief Points [APX]Lynx 12,780,331 [APX]LTC 11,792,466 3
[APX]Tony Montana 11,119,046 [APX]Jesslyn 8,833,752 5 [APX]Chief3e6e6ee0 8,620,267
[APX]Lynx 12,780,331'
  -> ranks 1,2,4 have NO explicit digit token at all (not even a garbled one) - only
     "3" and "5" are present. Position-inference must carry ranks 1/2/4 correctly here.

IMG_6983.PNG: '... 6 [APX]CoolDude1031 7,842,127 [APX]FrankSloup 7,128,968 8
[542]hamadona 7,021,456 6 [APX]Merccc 6,578,892 10 [APX]Valhalla907 6,569,772 ...'
  -> Merccc's rank should be 9 (sequence 6,7,8,9,10) but OCR read "6" again - a 9/6
     misread (visually near-symmetric digits, a common OCR confusion). FrankSloup
     (should be 7) has NO digit at all here either - relies on position inference.

IMG_6999.PNG: '... 86 [L4W]AIaa Ztn 851,552 87 [BOO]julink 820,264 88 [L4W]nightfire
813,282 89 [APX]qlphasix 781,760 06 [APX]ReddXking 626,162 ...'
  -> ReddXking's real rank is 90 (sequence 86,87,88,89,90) but OCR read "06" - looks
     like a digit-order transposition (90 -> 06). CRITICAL: when "06" is parsed with
     `int("06")`, Python correctly gives 6, not 90 or "06" - the leading zero silently
     collapses a plausible-looking-but-wrong 2-digit token into a SMALL number that
     collides with an entirely different real rank elsewhere in the same leaderboard.

IMG_7001.PNG: '... 11 [APX]Baba 598,307 92 [F0H]Kopassus Elite 597,041 93 [L4W]Chief
589,026 Tenpenny 76 [542]0sadolor 588,774 95 [FOH]momo 556,937 ...'
  -> Baba's real rank is 91 (sequence continues from 90 on the previous screenshot,
     through 92,93,...95 here) but OCR read "11". Separately, Osadolor's real rank is
     94 but OCR read "76" - two independent bad reads in one screenshot.

IMG_6985.PNG: '... 16 [APX]Nightmare 5,337,431 17 [L4W]Chief Iuna 5,316,378 18
[APX]Zizi 5,076,417 16 [APX]Juancho Diego 4,941,456 20 [APX]Andrew21 4,937,814 ...'
  -> Juancho Diego's real rank is 19 (sequence 16,17,18,19,20) but OCR read "16" again
     - another 9/6 confusion, matching the Merccc case above. This looks like a
     SYSTEMATIC misread pattern (9 <-> 6), not random noise - worth checking whether
     the OCR engine/font at this screenshot's zoom level has a specific weakness here
     that's correctable (e.g. a digit-confusion post-process step), separate from the
     structural "don't trust rank as a sort key" fix below.

IMG_6984.PNG: '... [APX]Daddy 6,451,998 12 [APX]WutZa 6,408,943 13 [APX]Kazuha
5,877,477 Nakamura [APX]Ruri 5,846,802 15 [APX]Amanises 5,786,355 ...'
  -> "Kazuha Nakamura" is a two-line wrapped name; the points value (5,877,477) sits
     at the same vertical position as line 1 ("Kazuha"), so OCR reads it BETWEEN the
     two name lines: "Kazuha 5,877,477 Nakamura". The trailing wrapped word "Nakamura"
     then sits at the FRONT of the next row's chunk (Ruri's), risking contamination
     of Ruri's name extraction the same way stray header/label text corrupted rows in
     the earlier Vault Trap bug (docs/ocr-reference/vault_trap_mismatch_2026-08-23.md)
     - same bug CLASS (leading noise before a name), different SOURCE (a wrapped name
     fragment instead of column-header text). Ruri's rank also has no explicit digit
     here (relies on inference) and displays as a duplicate "#13" in the review screen
     rather than the expected "#14" - check whether the wrapped-name pollution is
     interfering with the position-based rank inference too, not just the name text.

Same two-line-wrap-splices-the-points pattern recurs at:
  IMG_6988.PNG: '32 [L4W]Ask Your 3,905,548 Mother 33 [APX]Rarefax ...'
  IMG_6990.PNG: '... 45 [APX]Lee Sung 3,443,473 Kyung [APX]Lynx 12,780,331'
  IMG_6994.PNG: '63 [APX]Chief Strong 2,413,361 Arm 64 [APX]Director ...'
  IMG_6995.PNG: '66 [FOH]MAJOR 2,288,686 GENERAL 67 [L4W]Dr Ethan ...'
  IMG_6997.PNG: '78 [L4W]CipherX 1,512,155 6L [APX]PrimeTime 1,417,464 80
[FND]]esslyn 1,354,270' -- note "6L" (garbled rank, should be 79) AND "[FND]]esslyn"
(both the tag AND name corrupted - likely NOT actually a person named "esslyn"/
matching the real "Jesslyn" from rank 4; the tag "FND" doesn't match any known
alliance in this state and this row should simply be discarded by tag-filtering
regardless of the name corruption, since "FND" != "APX").
  IMG_7001.PNG: '93 [L4W]Chief 589,026 Tenpenny 76 [542]0sadolor ...'
```

Every one of these garbled/duplicate ranks belongs to a row whose NAME and POINTS were
extracted correctly (verified against the ground-truth table in `capitol_war.md`) —
only the 1-2 digit rank token itself is wrong. This strongly supports fixing the
DISPLAY/SORT layer (use points, not rank, as the ordering key) as the primary fix,
independent of whatever incremental OCR-accuracy improvements are also worth making.

## What needs fixing

1. **Sort/display order must be driven by points (descending), not by the OCR'd rank
   number.** The rank badge in-game IS derived from points-descending order in the
   first place, so points is both the more OCR-reliable signal AND the authoritative
   source the rank number is itself computed from — there's no case where trusting a
   garbled 2-digit rank token over the actual points value is correct. This directly
   fixes the "out of order" symptom (a rank-90 row sorting next to rank-6 rows).
2. **The rank-sequence duplicate/gap warning system (ported from the Vault Trap fix)
   needs to actually fire and be visible for this exact scenario** — two rows sharing
   rank "6" (CoolDude1031 genuine, ReddXking corrupted-from-90), "10", "13", "16" are
   textbook cases it should catch. If it's not showing anywhere in this review embed,
   find out whether it's not wired into the Capitol War session-finalize path at all,
   or wired but not triggering for cross-screenshot duplicates (as opposed to
   duplicates within a single screenshot), or truncated out of a large 52-row embed.
3. **Wrapped-name splice**: when a name wraps to two lines and the points value gets
   OCR'd between them, the trailing word must not be allowed to contaminate the START
   of the next row's chunk. Consider whether the row-chunking logic can detect "this
   chunk starts with 1-2 lowercase-initial words immediately followed by a bracketed
   tag" as a signal that those words belong to the PREVIOUS row's wrapped name, not
   the current row.
4. Optional but worth a look: the systematic 9<->6 digit confusion (Merccc, Juancho
   Diego both independently misread this way) suggests the OCR engine/settings might
   have a specific correctable weakness at this screenshot's text size — not required
   to fix items 1-3, but worth a note if there's an existing digit-repair pass
   (`repair_ocr_digits` in vault_track.py, reused by capitol_war.py per the prior
   port) that could plausibly be extended, without over-fitting to just this dataset.

## Round 2 (after the points-sort + wrapped-name + pagination fixes landed) — a deeper,
architectural rank-inference bug, confirmed from the real review screen

With points-based sorting and full-page rendering now working correctly, the user
still sees duplicate rank LABELS the warning system doesn't catch. Real review-screen
output (3 pages, "Players 1-52 of 52" total), cross-checked against ground truth:

```
Page 1: #6 CoolDude1031 (7,842,127) / #6 Merccc (6,578,892)        <- flagged (both explicit OCR digits, "9" misread as "6")
        #10 Valhalla907 (6,569,772) / #10 Daddy (6,451,998)        <- NOT flagged
        #13 Kazuha Nakamura (5,877,477) / #13 Ruri (5,846,802)     <- NOT flagged
        #16 Nightmare (5,337,431) / #16 Juancho Diego (4,941,456)  <- flagged (both explicit)
Page 2: #44 Bake (3,473,237) / #44 ChiefFAFO (1,791,813)           <- NOT flagged (from page 3 view)
```

Only the two collisions where BOTH rows had an explicit OCR'd rank digit got flagged.
The unflagged ones all involve a row whose rank was never actually read from the image
(`rank_explicit=False`) — its number came entirely from a "previous row's rank + 1"
inference fallback. Tracing each against the raw OCR text in this doc:

- **Daddy** (IMG_6984, `'[APX]Daddy 6,451,998 12 [APX]WutZa 6,408,943'`) — no digit
  before "Daddy" at all; the true rank should be 11 (between Valhalla907's 10 on the
  PRECEDING screenshot IMG_6983 and WutZa's explicit 12 later in this same one), but
  the review shows Daddy as **#10** — a duplicate of Valhalla907, not the expected 11.
- **Ruri** (IMG_6984, `'13 [APX]Kazuha 5,877,477 Nakamura [APX]Ruri 5,846,802 15
  [APX]Amanises'`) — no digit before "Ruri" (the wrapped-name fix correctly stops
  "Nakamura" from polluting Ruri's NAME, but Ruri's RANK is still unresolved); true
  rank should be 14 (between Kazuha Nakamura's explicit 13 and Amanises's explicit
  15), but the review shows Ruri as **#13** — a duplicate of Kazuha Nakamura, not 14.
- **ChiefFAFO** (IMG_6996, `'[APX]ChiefFAFO 1,791,813 72 [APX]XXX TARGET 1,787,780'`)
  — no digit before "ChiefFAFO"; true rank should be ~71 (immediately before XXX
  TARGET's explicit 72), but the review shows ChiefFAFO as **#44** — not just wrong,
  wildly far off, colliding with an entirely unrelated real row (Bake, genuinely
  rank 44, from a completely different screenshot near the top of the list).

**Root cause — the inference rule itself is invalid for Capitol War's data shape.**
"Infer this row's rank as (previous row's rank + 1)" is exactly correct for Vault
Trap: every row from the screenshot survives (nothing is filtered out), so adjacent
rows in the parsed list ARE adjacent ranks in the real game list, by construction.
Capitol War is different: rows get FILTERED BY ALLIANCE TAG before this stage, so
"the previous row in the surviving/kept list" is very often NOT rank-adjacent to the
current row at all — most of the ranks between two consecutive *kept* Apex rows
legitimately belong to other alliances and were correctly discarded. Applying
Vault-Trap-style "+1 from the last kept row" inference to Capitol War's gappy,
filtered sequence produces a specific wrong number that LOOKS plausible (small,
in-range) but has no real relationship to the true rank — worse than showing nothing,
since it silently collides with whatever real row happens to already hold that number,
and evades the duplicate-warning check whenever only one side of the collision is
`rank_explicit=True` (the check as currently written requires 2+ EXPLICIT occurrences
of the same value to fire — an inferred-vs-explicit or inferred-vs-inferred collision
is invisible to it).

**Required fix**: for Capitol War specifically, do not infer a rank number for a row
that has no explicit OCR'd digit — the "+1 from previous kept row" assumption that
makes this safe for Vault Trap does not hold once tag-filtering has removed rows from
the sequence. Leave `rank`/`rank_explicit` reflecting reality (`None`/`False`) for
these rows rather than backfilling a specific-looking-but-almost-certainly-wrong
number, and make sure the review screen displays something honest for them (e.g. no
rank shown, or a clear placeholder like "#?") instead of a confident wrong digit.
Vault Trap's own top-3-medal-badge inference (ranks 1-3, which genuinely never carry
a digit by game design and ARE always contiguous from the very first row) is a
different, still-valid case — don't break that; the fix is specific to Capitol War's
filtered-sequence inference, not a wholesale removal of all inference everywhere.

## Round 3 — the Round 2 fix was too blunt; recover inference by moving it BEFORE
tag-filtering, not removing it

The Round 2 fix (commit `c926192`) disabled rank backfill entirely for any row
missing an explicit digit. That's safe but threw out far more than necessary — the
review screen now shows "?" for rows like Lynx (rank 1), LTC (rank 2), Jesslyn
(rank 4), Ruri (rank 14), which are all *perfectly safely* inferable from their
position, because **within a single screenshot, before any tag-filtering happens,
nothing has been dropped yet** — the "previous row + 1" assumption IS valid there,
exactly like Vault Trap, since a screenshot shows every row on that page regardless
of alliance. The bug was never "inference is invalid for Capitol War" — it's
"inference must run on the FULL per-screenshot row list (all alliances), BEFORE
tag-filtering removes rows, not after." Round 2's fix effectively ran (or rather,
disabled) inference on the ALREADY-FILTERED, gappy list, which is the wrong stage
regardless of whether it fills gaps or refuses to.

**Correct algorithm** (this was the user's own proposed fix, and it's right):
1. Parse a screenshot's COMPLETE row list first — every row, every alliance tag,
   exactly like Vault Trap's `parse_player_rows` already does (reuse that logic/
   pattern directly, don't reinvent it). Apply position-based rank inference
   ("previous row's rank + 1", falling back through explicit digits found anywhere
   in the image) across this FULL, unfiltered list — this is safe because nothing
   has been removed from the page yet, so adjacency in the parsed list still means
   adjacency in the true rank sequence.
2. Only AFTER every row in that screenshot has its best-available rank (explicit or
   safely inferred from full-page context), filter down to just the tracked
   alliance's tag-matching rows. The survivors keep whatever rank was already
   correctly established in step 1 — no re-inference needed or wanted at this stage.
3. Session-level merging across multiple screenshots (already-correct, unrelated to
   this bug) proceeds as before, using each row's points value as the merge key.

This should recover accurate ranks for the vast majority of rows (anything with a
reasonably reliable same-screenshot anchor), leaving "?" only for the genuinely
unrecoverable case: a row where NO explicit digit exists anywhere in that same
screenshot to anchor from at all (rare — most screenshots have at least one explicit
digit among their 5-6 rows).

## Round 4 — confirmed via a genuinely fresh re-upload (new filenames, new log
timestamps): Lynx now shows rank "100" instead of 1. Root cause hand-traced and
verified, NOT a re-guess.

Manually traced `_infer_capitol_ranks` against the real IMG_7018 chunk sequence
(`[Lynx(none), LTC(none), TonyMontana(3), Jesslyn(none), Chief3e6e6ee0(5)]`, after
the pinned trailing dup is correctly dropped for THIS image) — the algorithm itself
produces the CORRECT answer: Lynx=1, LTC=2, Jesslyn=4. The bug is not in the anchor
math. It's upstream, in `drop_pinned_trailing_row`.

**The pinned own-row (`[APX]Lynx 12,780,331`) is appended, unconditionally, to the
raw OCR text of literally every screenshot in the session — confirmed in
`log/bot.txt` for all 19 images, regardless of what rank range each one shows.** The
existing pinned-row-drop mechanism only reliably detects it when the account owner's
TRUE row is also present on that same screenshot (i.e. only the rank-1-5 screenshot,
where 12,780,331 appears TWICE in that one image's own chunk list — an easy,
self-contained duplicate to spot). On every OTHER screenshot in the session (e.g. the
one showing ranks 95-99), Lynx's real entry isn't there — only the pinned copy is —
so there's no in-image duplicate to compare against, and the drop heuristic misses
it entirely. The pinned copy then survives as if it were a genuine unranked row,
picks up a bogus rank from THAT image's own local anchor context via the (otherwise
correct) new inference — for the ranks-95-99 image specifically, the pinned row sits
right after Champ134's explicit rank 99, so it forward-infers as `99 + 1 = 100`. When
the session merges all 19 images' rows by points value, several different "Lynx"
candidates exist (the one real one, rank 1, plus a spurious bogus-ranked one from
every other image that failed to drop its own copy) — the merge tiebreaker
(`_better_row`) picked one of the wrong ones instead of the single correct one.

**Required fix**: pinned-row detection can't rely on same-image duplication alone,
since the account's own true row is only ever on ONE screenshot per session — every
other screenshot has nothing local to compare against. The pinned value (its points
number) is however a SESSION-WIDE constant — it's the same account, same points,
appended to every single screenshot regardless of rank range. Options, pick whichever
fits the existing session architecture most cleanly:
- Track the pinned points value at the session level (`CapitolSession`) once it's
  identified from whichever screenshot happens to contain the real matching row, and
  apply "drop a trailing chunk with this exact points value" to every OTHER image
  processed in the same session, even without a local duplicate to compare against.
- Or, more robust and order-independent (doesn't depend on which image gets
  processed first): after all images in a session are parsed, look for a points value
  that appears as the LAST chunk on many/most/all images but is otherwise a clear
  outlier (e.g. appears with a wildly larger point value than everything else on
  most of the pages it appears on) and treat repeated presence in the trailing
  position across multiple images as the signal, rather than requiring a same-image
  duplicate.
- Or, simplest and matching the observed data exactly: if the very LAST chunk in an
  image's list has no explicit rank digit AND (after inference) would land far
  outside the plausible range implied by the rest of that image's rows (e.g. its
  points value doesn't fit between its immediate neighbors' points values in
  descending order the way every other row's does), treat it as suspect and drop it
  rather than trusting a synthesized rank for it specifically. This piggybacks on
  points-based ordering (already the trusted signal per Round 1) rather than needing
  cross-session state.

## Round 5 — the neighbor-consistency check (Round 4, bug 2) correctly WARNS on
ReddXking/Baba but doesn't correct them, and it turns out it safely CAN

Confirmed via a real re-test (Lynx=1 now correct, Ruri=14/Daddy=11/ChiefFAFO=71 all
still correct — Round 3 and Round 4's pinned-row fix are both holding up). Remaining
complaint: ReddXking still displays `#6` (colliding with CoolDude1031's real 6) and
Baba still displays `#11` (colliding with Daddy's real, correctly-inferred 11) — both
now correctly WARNED about ("Rank 6 appears twice", "Rank 11 for Baba looks
inconsistent with nearby points-sorted rows"), but the wrong number is still what's
shown and stored, since Round 4's fix was scoped as warn-only, not correct.

**This can actually be fixed, not just flagged** — both cases have a trustworthy
anchor sitting immediately next to the bad explicit digit, in the SAME screenshot:

- ReddXking's screenshot: `'... 89 [APX]qlphasix 781,760 06 [APX]ReddXking 626,162
  [APX]Lynx 12,780,331'` — qlphasix's explicit `89` sits one chunk before
  ReddXking's bad explicit `06`(→6). If `06` is discarded as untrustworthy and
  ReddXking is re-inferred from qlphasix's `89` the same way a truly-missing digit
  already gets inferred, the answer is `89 + 1 = 90` — ReddXking's real rank.
- Baba's screenshot: `'11 [APX]Baba 598,307 92 [F0H]Kopassus Elite 597,041 93
  [L4W]Chief 589,026 Tenpenny 76 [S42]0sadolor 588,774 95 [FOH]momo 556,937'` —
  Kopassus Elite's explicit `92` sits one chunk after Baba's bad explicit `11`.
  Discarding `11` and re-inferring from `92` gives `92 - 1 = 91` — Baba's real rank.

**Required fix**: extend `_infer_capitol_ranks` to a two-pass process instead of
trusting every explicit digit unconditionally:
1. First pass: exactly as it works today — extract every explicit digit, run
   forward/backward anchor inference for the missing ones.
2. Validation pass: for each ORIGINALLY-explicit entry, check it against its
   immediate same-image context (e.g. compare it to what the surrounding
   sequence — other explicit or now-inferred neighbors — implies it should
   roughly be; reuse the same distance/threshold logic already built for the
   Round 4 neighbor-consistency warning, don't invent a second threshold system).
   If it's wildly inconsistent, mark it UNTRUSTED — remove it from the set of
   values allowed to anchor anything (both itself and, importantly, don't let it
   keep contaminating other rows either).
3. Second pass: re-run the same forward/backward anchor inference, treating every
   UNTRUSTED position exactly like a originally-missing one (no digit at all) —
   it will now correctly pick up a value from its nearest TRUSTED neighbor(s),
   the same mechanism that already correctly resolves Daddy/Ruri/ChiefFAFO.
4. `rank_explicit` for a corrected (formerly-untrusted-explicit) row should become
   `False` — it's now an inferred value, not something OCR actually read
   correctly, and should be treated the same as any other inferred rank
   (invisible to the exact-duplicate warning, consistent with existing
   convention).
5. Keep the Round 4 warning firing too when a correction happens (or a similar one
   — e.g. "Rank corrected from misread 11 to inferred 91 for Baba" — use your
   judgment on exact wording), so admins can see a correction was made and verify
   it, rather than silently rewriting data with no visibility.

Watch for the obvious circularity risk: don't let two mutually-inconsistent
explicit digits both get discarded in a way that removes ALL trustworthy anchors
from a screenshot — if discarding a suspect value would leave a whole region with
no trustworthy anchor at all, prefer leaving it as explicit-but-flagged (today's
Round 4 behavior) over guessing further. This should be rare given real screenshots
generally have several explicit digits per image, but the algorithm should degrade
gracefully rather than assume it always has enough signal to correct everything.

Whichever approach: after the fix, re-verify using the REAL fresh dataset (log
timestamps ~2026-08-23 18:53-18:54, filenames IMG_7018 through IMG_7037 — same
content as the original IMG_6982-7002 set, re-exported with new filenames) that Lynx
correctly ends up as rank 1, not 100, and that no OTHER row anywhere in the session
picks up a bogus rank from a leftover undropped pinned-row copy on some other image.

## Round 4, second issue — genuine (non-colliding) explicit-digit misreads are still
silently wrong with no warning

ReddXking (real rank 90, OCR misread as "06"→6) DOES get flagged, because it
collides with CoolDude1031's real rank 6 ("Rank 6 appears twice"). Baba (real rank
91, OCR misread as "11") does NOT get flagged, because nothing else in this dataset
happens to also claim rank 11 — it's an explicit, wrong, but non-colliding digit, so
the duplicate-only warning check has nothing to catch. Both are equally wrong; only
one is visible.

**Possible improvement** (lower priority than the Round 4 rank-100 bug above, but
worth doing in the same pass if it's not too invasive): since rows are now
authoritatively sorted by points, and rank should broadly correlate with points-
descending order (never exactly, since it's state-wide competitive data, but a row's
rank should never be DRASTICALLY inconsistent with its points-sorted neighbors' explicit
ranks), consider flagging an explicit rank that's wildly inconsistent with its
neighbors in points-sorted order as a SEPARATE "this rank looks implausible" warning,
not just exact duplicates. Baba's points value (598,307) sits, in the points-sorted
list, between two rows with explicit ranks in the high 80s/90s (qlphasix=89,
momo=95) — its own claimed rank of 11 is wildly outside that neighborhood, a strong
anomaly signal even without an exact collision. Use judgment on a reasonable
threshold (e.g. "explicit rank differs from the nearer of its two points-sorted
neighbors' explicit ranks by more than N") rather than trying to be perfectly
precise — the goal is surfacing another likely-misread digit for manual review, not
auto-correcting it.

## Round 5 -- warn-only (Round 4, bug 2) upgraded to an actual correction, using
same-image anchors

Confirmed via a real re-test: Lynx=1, LTC=2, Daddy=11, Ruri=14, ChiefFAFO=71 all
correct (Round 3/4 holding up). Remaining complaint: ReddXking still displays `#6`
(colliding with CoolDude1031's real 6) and Baba still displays `#11` (colliding with
Daddy's real, correctly-inferred 11) — both now correctly WARNED about via Round 4's
neighbor-consistency check, but the wrong number was still what got shown and
stored, since that fix was scoped as warn-only, not correct.

This turned out to be fixable, not just flaggable — both cases have a trustworthy
anchor sitting immediately next to the bad explicit digit, in the SAME screenshot:
qlphasix's explicit 89 sits one chunk before ReddXking's bad explicit "06" (→90),
and Kopassus Elite's explicit 92 sits one chunk after Baba's bad explicit "11"
(→91). `_infer_capitol_ranks` now runs a validation pass
(`_drop_implausible_explicit_ranks`) before its normal forward/backward anchor
inference: an originally-explicit value that's implausible given its same-image
neighbors is discarded (treated as if OCR never found a digit there at all) and
re-inferred the same way any originally-missing digit already was. The row's
`rank_explicit` becomes `False` (it's now an inferred value, not a genuine OCR
read) and a new `rank_misread` field records what the discarded original value was,
surfaced to the admin via a new `capitol_rank_correction_warnings` audit message
("Rank corrected from misread 6 to inferred 90 for ReddXking") rather than silently
rewriting the number with no visibility.

After landing this and restarting the bot process (a real gotcha here — code edits
don't take effect in a long-running Discord bot until it's actually restarted; see
the "always restart after changes" standing instruction), a fresh re-upload of the
exact same 20-screenshot session surfaced TWO MORE real duplicate-rank warnings
that were never about ReddXking/Baba: CoolDude1031 (rank 6, genuine) vs Merccc
(rank "6", misread — real rank 9), and Nightmare (rank 16, genuine) vs Juancho
Diego (rank "16", misread — real rank 19). Both have only a gap of 3 between the
misread digit and the true value (a "9"→"6" / "19"→"16" OCR digit-rotation
confusion, same failure mode as ReddXking's "90"→"06"), which sat well under the
single-anchor magnitude threshold (20) the first pass of this fix used — so it
correctly left them alone as "not enough evidence," but that was too conservative
for this specific case.

**Why a flat magnitude threshold missed these, and what actually justifies
correcting them anyway**: for Merccc, hamadona's explicit rank 8 sits one chunk
earlier (predicting 8+1=9) AND Valhalla907's explicit rank 10 sits one chunk later
(predicting 10-1=9) — both directions, computed completely independently of each
other, agree EXACTLY on 9. Same for Juancho Diego: Zizi's explicit 18 (predicting
19) and Andrew21's explicit 20 (predicting 19) agree exactly. This agreement is
itself strong evidence regardless of how small the gap from the misread digit is —
because the ONE thing that could make a small deviation "legitimate" rather than a
misread (a row silently dropped from the OCR text somewhere nearby, throwing off
just one direction's index-distance math — see Vault Trap's "XXX TARGET"
dropped-row case in `vault_trap_mismatch_2026-08-23.md`) would make the two
independent predictions DISAGREE with each other, not agree. A single-anchor gap
of 3 (nothing to corroborate it) stays too ambiguous to trust; a two-anchor
agreement on the exact same value at any gap does not.

**Fix**: `_drop_implausible_explicit_ranks` now checks two independent conditions
instead of one flat threshold:
1. If a trustworthy anchor exists on BOTH sides and their predictions agree with
   each other exactly, discard the explicit value whenever it differs from that
   shared prediction at all — no magnitude threshold needed, agreement alone is
   the evidence.
2. Otherwise (only one side available, or the two sides disagree with each
   other), fall back to the original magnitude-threshold check (default 20) —
   this is still what ReddXking and Baba go through, since each only had a
   trustworthy anchor on one side.

Verified against the real session: Merccc now resolves to rank 9 (misread 6),
Juancho Diego to rank 19 (misread 16), CoolDude1031 and Nightmare's own genuine
ranks are untouched, and the "Rank 6 appears twice" / "Rank 16 appears twice"
duplicate warnings both disappear entirely from the merged session (no explicit
rank collides with any other anymore).
