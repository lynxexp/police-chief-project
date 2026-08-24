"""
Capitol War point tracking. Records, views, and charts Capitol War "Honor
Roll" points per alliance. Structurally a sibling of Vault Trap tracking
(cogs/vault_track.py) -- same OCR pipeline, same fuzzy roster-matching, same
review/edit UI patterns -- ported to a state-wide ranking screen instead of
an in-mail per-alliance one. See docs/ocr-reference/capitol_war.md for the
verified screenshot format this was built against.

The one fundamentally new problem Vault Trap never had: Capitol War's Honor
Roll lists the WHOLE STATE, every alliance's members interleaved, each name
prefixed with a 3-character bracketed tag (e.g. "[APX]Lynx"). Rows whose tag
doesn't match this alliance's own configured tag are discarded before they
are ever compared against the roster -- see `parse_capitol_rows` below.

Genuinely game-agnostic logic (fuzzy matching, chart rendering, the OCR
engine dispatch, the collision guard, rank-sequence warnings, pinned-own-row
dedup, and the whole "resolve a typed ID/name against the roster, offer to
add an unknown one" flow) is imported directly from `cogs.vault_track`
rather than re-derived -- see that module for the underlying algorithms.
Only what's genuinely different (schema, terminology, the state-wide tag
filter, and the UI screens that are tightly bound to Vault Trap's own
tables) gets its own implementation here.
"""
import discord
from discord.ext import commands
from discord import app_commands
import asyncio
import gc
import logging
import re
import sqlite3
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, date, timedelta, timezone

from .pimp_my_bot import theme, safe_edit_message, check_interaction_user
from .permission_handler import PermissionManager
from .alliance_member_operations import _post_alliance_log
from . import onnx_lifecycle

from .vault_track import (
    # Matching -- fully game-agnostic, reused as-is.
    match_roster, classify_match, resolve_against_roster, _fold,
    MATCH_AUTO_CONFIRM, MATCH_LIKELY_MIN, MATCH_AMBIGUOUS_DELTA,
    name_match_score, is_row_unfilled, learn_alias,
    resolve_unique_assignments, rank_sequence_warnings,
    get_alliance_roster, get_match_roster, auto_link_unmatched_rows_by_name,
    # Row-parsing sub-pieces proven against real OCR mismatches -- reused,
    # not re-derived (see docs/ocr-reference/vault_trap_mismatch_2026-08-23.md).
    _FORMATTED_NUMBER_RE, _ALLIANCE_TAG_RE, _ROW_LABEL_SUFFIX_RE,
    drop_pinned_trailing_row, _strip_common_trailing_token, _better_row,
    # Number/text formatting -- generic.
    vault_damage as parse_points, format_damage_for_embed,
    # Embed-field pagination: spill a page's row lines across multiple
    # fields instead of truncating one at Discord's 1024-char cap -- see
    # docs/ocr-reference/capitol_war_mismatch_2026-08-23.md.
    add_paginated_field,
    # Player-entry resolution flow (digit-ID vs name, cross-alliance ID
    # guard, unknown-ID add-confirm handoff) -- reused wholesale.
    _resolve_player, _parse_damage_rank, _strip_name_quotes,
    _resolve_and_apply, _offer_add_by_id, PlayerAddConfirmView,
    # Chart rendering -- generic, just pass ylabel="Points".
    _render_damage_chart,
    # RTL-safe text helpers used throughout Vault Trap's embeds.
    _isolate_rtl, _ltr_line, _reshape_for_chart,
    # OCR engine dispatch machinery -- mirrored exactly, not reinvented.
    OCR_AVAILABLE, DEFAULT_OCR_LANG, OCR_LANG_CODES, get_ocr_model,
    ocr_bytes_with_boxes, _get_ocr_semaphore, _output_matches_lang_script,
    _RTL_LANGS, _reverse_for_rtl, _LATIN_ONLY_LANGS, MAX_FALLBACK_ATTEMPTS,
    repair_ocr_digits, record_ocr_lang_run, auto_managed_fallbacks,
    merge_fallback_rows_by_damage, merge_fallback_rows_by_boxes,
    fill_unfilled_by_position,
    # Reusable UI: the time-range preset pickers are pure date-math + a
    # callback into whatever view/modal-holding object is handed to them, so
    # they're reused unmodified as long as CapitolWarView / CapitolCompareView
    # expose the same small attribute contract those classes expect.
    VaultTimeRangeView, DateRangeModal,
    VaultCompareTimeRangeView, VaultCompareDateRangeModal,
    build_alliance_options,
    # Row-status display icons/labels (auto/likely/ambiguous/manual/collision/
    # none) -- fully generic, same statuses classify_match ever produces.
    _STATUS_ICONS, _STATUS_LABELS,
    _normalize_event_time, _format_delta_pct,
    # Channel-listener session machinery -- VaultSession's engine-lifecycle
    # and timer methods (_ensure_engine/_release_all_engines/restart_timer/
    # _timer_run/stop_timer) touch nothing but `self` and module-generic
    # globals (onnx_lifecycle, get_ocr_model, asyncio), so CapitolSession
    # below reuses them directly as class-level method assignments instead
    # of re-deriving them. finalize()/cancel() are NOT reused this way --
    # those close over vault_track's own `_active_sessions` module dict, so
    # CapitolSession defines its own pointed at `_active_capitol_sessions`.
    VaultSession, _ack_component,
)

logger = logging.getLogger('bot')

try:
    from rapidfuzz import fuzz as _rf_fuzz  # noqa: F401 -- availability check only
    RAPIDFUZZ_AVAILABLE = True
except ImportError:
    RAPIDFUZZ_AVAILABLE = False

from cogs.attendance import MATPLOTLIB_AVAILABLE  # noqa: F401 -- re-export not needed, kept for parity


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

CAPITOL_DB_PATH = "db/capitol_war.sqlite"


def init_capitol_database():
    """Initialize capitol_war_events + capitol_war_points tables.

    Unlike vault_hunts, there's no trap_number/wave-number concept here
    (confirmed absent from all 19 reference screenshots -- see
    docs/ocr-reference/capitol_war.md) -- one event per date per alliance,
    hence the simpler UNIQUE (alliance_id, date). Unlike vault_hunts.
    total_damage (parsed off an in-mail alliance-total line), Capitol War's
    screen has no equivalent alliance-total figure anywhere -- any "alliance
    total" display is computed by summing this event's own
    capitol_war_points.points rows instead (see CapitolDataSubmit)."""
    with closing(sqlite3.connect(CAPITOL_DB_PATH, timeout=30.0)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS capitol_war_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alliance_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                event_time TEXT,
                UNIQUE (alliance_id, date)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS capitol_war_points (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES capitol_war_events(id),
                fid INTEGER,
                raw_name TEXT,
                resolved_nickname TEXT,
                points INTEGER NOT NULL,
                rank INTEGER,
                match_score INTEGER
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_cwp_fid ON capitol_war_points(fid)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_cwp_event ON capitol_war_points(event_id)")
        # Same learned-alias mechanism as Vault Trap (OCR text -> fid), scoped
        # to this DB/table -- an alliance's decorated gamertags are the same
        # regardless of which event type read them, but keeping a separate
        # table (rather than sharing vault_name_alias) avoids any coupling to
        # vault_track's schema lifecycle.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS capitol_name_alias (
                alliance_id INTEGER NOT NULL,
                ocr_key     TEXT    NOT NULL,
                fid         INTEGER NOT NULL,
                raw_name    TEXT,
                updated_at  TEXT,
                PRIMARY KEY (alliance_id, ocr_key)
            )
        """)
        conn.commit()


init_capitol_database()


def _ensure_alliance_tag_column():
    """Defensive migration guard: main.py's create_tables() adds alliance_list.tag
    on every startup, but this cog can in principle load before that (cog import
    order), so make sure the column exists before any tag lookup below runs."""
    try:
        with closing(sqlite3.connect("db/alliance.sqlite", timeout=30.0)) as conn:
            cols = [r[1] for r in conn.execute("PRAGMA table_info(alliance_list)")]
            if "tag" not in cols:
                conn.execute("ALTER TABLE alliance_list ADD COLUMN tag TEXT")
                conn.commit()
    except Exception as e:
        logger.warning(f"Capitol War: could not verify alliance_list.tag column: {e}")


_ensure_alliance_tag_column()


# ---------------------------------------------------------------------------
# Learned-alias helpers (capitol_name_alias) -- mirrors vault_track's
# learn_alias/alias_lookup exactly, just pointed at this cog's own table, so
# resolve_against_roster's alias fallback works the same way here.
# ---------------------------------------------------------------------------

MATCH_ALIAS_SCORE = 100
MATCH_ALIAS_FUZZY_MIN = 92
MATCH_COROBORATION_MIN = 55


def learn_capitol_alias(alliance_id, raw_name, fid) -> None:
    if not alliance_id or not fid or not raw_name:
        return
    key = _fold(raw_name)
    if len(key) < 2:
        return
    try:
        with sqlite3.connect(CAPITOL_DB_PATH, timeout=30.0) as conn:
            conn.execute("""
                INSERT INTO capitol_name_alias (alliance_id, ocr_key, fid, raw_name, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(alliance_id, ocr_key) DO UPDATE SET
                    fid = excluded.fid,
                    raw_name = excluded.raw_name,
                    updated_at = excluded.updated_at
            """, (int(alliance_id), key, int(fid), raw_name))
    except Exception as e:
        logger.warning(f"Capitol War OCR: could not learn alias for {raw_name!r}: {e}")


def capitol_alias_lookup(alliance_id, detected_name, roster):
    if not alliance_id or not detected_name:
        return None
    key = _fold(detected_name)
    if len(key) < 2:
        return None
    roster_fids = {e[0]: e[-1] for e in roster}
    try:
        with sqlite3.connect(CAPITOL_DB_PATH, timeout=30.0) as conn:
            rows = conn.execute(
                "SELECT ocr_key, fid FROM capitol_name_alias WHERE alliance_id = ?",
                (int(alliance_id),)).fetchall()
    except Exception as e:
        logger.warning(f"Capitol War OCR: alias lookup failed: {e}")
        return None
    for ocr_key, fid in rows:
        if ocr_key == key and fid in roster_fids:
            return fid, roster_fids[fid]
    if RAPIDFUZZ_AVAILABLE and rows:
        from rapidfuzz import process as _rf_process
        keys = [r[0] for r in rows]
        m = _rf_process.extractOne(
            key, keys, scorer=_rf_fuzz.WRatio, score_cutoff=MATCH_ALIAS_FUZZY_MIN)
        if m and _rf_fuzz.token_sort_ratio(key, m[0]) >= MATCH_COROBORATION_MIN:
            fid = rows[m[2]][1]
            if fid in roster_fids:
                return fid, roster_fids[fid]
    return None


def resolve_against_capitol_roster(detected_name, roster, alliance_id=None):
    """Same shape as vault_track.resolve_against_roster, pointed at this
    cog's own learned-alias table."""
    candidates = match_roster(detected_name, roster)
    if alliance_id is None or classify_match(candidates) == 'auto':
        return candidates
    alias = capitol_alias_lookup(alliance_id, detected_name, roster)
    if not alias:
        return candidates
    fid, display = alias
    return [(fid, display, MATCH_ALIAS_SCORE)]


# ---------------------------------------------------------------------------
# Row parsing / tag filtering
# ---------------------------------------------------------------------------
# Row dicts here deliberately reuse the key name "damage" for the points
# value (never shown to users -- display code always says "Points"). This
# is what lets merge_fallback_rows_by_damage/by_boxes, fill_unfilled_by_
# position, and _better_row (all imported from vault_track, all keyed on
# row['damage']) work against Capitol War rows without any changes to that
# shared code.

_HONOR_ROLL_RE = re.compile(r'Honor\s+Roll', re.IGNORECASE)
_CAPITOL_HEADER_RE = re.compile(r'Rank\s+Chief\s+Points', re.IGNORECASE)
# A two-line wrapped name (e.g. "Kazuha Nakamura") splices the points value
# BETWEEN its two lines, since the points column sits at the same vertical
# position as line 1 of the name: OCR reads "Kazuha 5,877,477 Nakamura". The
# trailing wrapped word then lands at the very FRONT of the NEXT row's
# chunk, ahead of that row's own bracket tag (e.g. "Nakamura [APX]Ruri"),
# corrupting its name into "Nakamura Ruri" unless stripped. 1-2 word tokens
# (never pure digits, so a genuine rank number is never eaten) sitting
# before an (optional rank digit, then) bracket tag are never a real name
# fragment of THIS row -- every chunk here already carries a confirmed tag
# (required to survive the tag filter above), so nothing legitimate can
# precede it. See docs/ocr-reference/capitol_war_mismatch_2026-08-23.md.
_LEADING_WRAP_LEAK_RE = re.compile(
    r'^\s*(?:[^\s\[\]\d]+\s+){1,2}(?=(?:\d{1,2}\s+)?\[[A-Za-z0-9]{3}\])'
)


def find_capitol_section_start(text: str):
    """Index where the Honor Roll's row list starts. Mirrors vault_track's
    find_ranking_section_start structurally, but Capitol War's screen always
    carries its own fixed column header ("Rank | Chief | Points") rather than
    Vault Trap's "Damage Rankings" keyword + separate "Damage Points:" per-row
    corroboration -- so that header is the primary signal here, with the
    "Honor Roll" page title as a fallback and position 0 as the last resort."""
    header = _CAPITOL_HEADER_RE.search(text)
    if header:
        return header.end()
    title = _HONOR_ROLL_RE.search(text)
    if title:
        return title.end()
    return 0


_RANK_DIGIT_RE = re.compile(r'(?<!\S)(\d{1,2})(?!\S)')


def _drop_capitol_pinned_outlier_row(chunks: list, points_vals: list) -> None:
    """Capitol-War-specific companion to `drop_pinned_trailing_row`, for the
    pinned own-row case that mechanism can't see at all: it compares the
    last two chunks' LEADING RANK DIGITS, but the pinned row (e.g.
    `[APX]Lynx 12,780,331`) almost never carries an explicit digit anywhere
    in the real data (confirmed across all 19 screenshots in
    docs/ocr-reference/capitol_war_mismatch_2026-08-23.md, "Round 4") -- with
    nothing to compare, that check simply never fires except on the one
    screenshot where the account's own TRUE row happens to also be present
    (an easy same-image duplicate). On every other screenshot the pinned
    copy survives untouched, then picks up a bogus rank from that image's
    own local anchor context via `_infer_capitol_ranks` -- e.g. landing at
    rank 100 right after a real rank-99 row.

    The signal that DOES generalize to every screenshot, with no session
    state and no dependency on which image gets processed first or whether
    the real row is even present in this session at all: every screenshot's
    row list is inherently points-descending BEFORE the pinned row is glued
    onto the end (rank IS points-descending order, by game design -- see
    docs/ocr-reference/capitol_war.md). The pinned own-row is the one entry
    the game places out of that order, appended after whatever rank range
    the page happens to show. So if the trailing chunk's points value is
    GREATER than the chunk immediately before it -- breaking the descending
    trend every other row in the list honors -- it's not a real row at that
    position; drop it before rank-inference ever gets a chance to assign it
    a specific-looking-but-wrong number.

    Deliberately conservative: only ever inspects/drops the single trailing
    chunk, and only compares it against its immediate predecessor (exactly
    the two chunks `_infer_capitol_ranks` would otherwise anchor it from),
    so a screenshot with no pinned-row anomaly is left untouched."""
    if len(chunks) < 2:
        return
    if points_vals[-1] > points_vals[-2]:
        chunks.pop()
        points_vals.pop()


_RANK_NEIGHBOR_THRESHOLD = 20


def _drop_implausible_explicit_ranks(explicit: list, *, threshold: int = _RANK_NEIGHBOR_THRESHOLD) -> tuple[list, list]:
    """Validate every originally-explicit rank against its nearest OTHER
    explicit neighbors (by chunk-index distance, excluding itself) -- the
    same adjacency invariant the rest of `_infer_capitol_ranks` relies on.
    A value found implausible is discarded: treated exactly like a digit
    OCR never found at all, so the normal forward/backward anchor
    inference below fills it back in from the trustworthy neighbors
    instead of keeping the misread digit. See docs/ocr-reference/
    capitol_war_mismatch_2026-08-23.md, "Round 5".

    Two independent kinds of evidence are checked, since they catch
    different-sized misreads with different confidence:

    1. **Both-directions agreement** (any deviation counts): when there's
       a trustworthy explicit anchor on EACH side, and both independently
       predict the exact same value, that agreement is strong evidence on
       its own, regardless of how small the deviation from the actual
       explicit digit is -- e.g. Merccc's real rank 9 misread as "6"
       (gap of only 3) is still confidently caught, because hamadona's
       explicit 8 (one chunk earlier -> 9) and Valhalla907's explicit 10
       (one chunk later -> 9) agree exactly. A silently-dropped row
       between either pair (the one scenario that could make an adjacent
       reading legitimately "off" with no digit misread at all -- see
       Vault Trap's "XXX TARGET" case in
       docs/ocr-reference/vault_trap_mismatch_2026-08-23.md) would break
       this agreement rather than preserve it, which is exactly why
       agreement is trusted even at small magnitudes.
    2. **Single-direction magnitude** (only a WILD deviation counts): when
       only one side has a trustworthy anchor (or the two sides disagree
       with each other), there's nothing to corroborate a small deviation
       against -- it could be a genuine misread, OR a dropped/extra row
       nearby throwing off that one direction's arithmetic. Only an
       overwhelming gap (e.g. ReddXking's real 90 misread as "06" sitting
       right after qlphasix's genuine 89, or Baba's real 91 misread as
       "11" sitting right before Kopassus Elite's genuine 92) is trusted
       here, matching `capitol_neighbor_rank_warnings`' own threshold.

    Every originally-explicit value is validated against the ORIGINAL
    explicit set only, in one non-cascading pass -- a value is never
    compared against another value this same pass already discarded, so
    one bad digit can't chain into wrongly discarding a neighbor that was
    actually fine, and a stretch with no trustworthy anchor at all just
    leaves its explicit value(s) alone rather than guessing further.

    Returns (corrected_explicit, misread) -- `misread` holds the original
    (now-discarded) value at each corrected index, None everywhere else,
    purely for surfacing an audit warning to the admin; it plays no part
    in rank computation itself."""
    n = len(explicit)
    corrected = list(explicit)
    misread: list = [None] * n
    for i, val in enumerate(explicit):
        if val is None:
            continue
        prev = next(
            ((j, explicit[j]) for j in range(i - 1, -1, -1) if explicit[j] is not None),
            None,
        )
        nxt = next(
            ((j, explicit[j]) for j in range(i + 1, n) if explicit[j] is not None),
            None,
        )
        pred_prev = (prev[1] + (i - prev[0])) if prev is not None else None
        pred_next = (nxt[1] - (nxt[0] - i)) if nxt is not None else None

        if pred_prev is not None and pred_next is not None and pred_prev == pred_next:
            if pred_prev != val:
                corrected[i] = None
                misread[i] = val
            continue

        candidates = [p for p in (pred_prev, pred_next) if p is not None]
        if not candidates:
            continue
        predicted = min(candidates, key=lambda p: abs(val - p))
        if abs(val - predicted) > threshold:
            corrected[i] = None
            misread[i] = val
    return corrected, misread


def _infer_capitol_ranks(chunks: list) -> tuple[list, list, list]:
    """Determine (rank, rank_explicit, rank_misread) for every chunk in the
    FULL, unfiltered per-screenshot row list -- i.e. BEFORE alliance-tag
    filtering removes any rows from the sequence. Mutates `chunks` in
    place, stripping out each explicit rank digit it finds so later
    cleanup steps (wrap-leak strip, tag-bracket strip, name assembly)
    never see it as a stray token.

    Every explicit rank is read directly from that row's own chunk text,
    with the same regex Vault Trap's parse_player_rows uses to find its
    own rank digits, then validated by `_drop_implausible_explicit_ranks`
    (an explicit-but-wildly-wrong digit is discarded, not trusted). Rows
    with no (trusted) explicit digit are inferred from the NEAREST chunk --
    by index distance, in EITHER direction -- that has a known rank
    (explicit, or already resolved by this same process), offsetting by
    the index distance between them.

    This is safe here specifically because it runs on the FULL unfiltered
    list: nothing has been dropped yet, so adjacency in chunk order really
    is adjacency in true rank order -- the same "previous row + 1"
    assumption Vault Trap's own top-3 inference relies on, generalized to
    look both directions since a Capitol War screenshot can start anywhere
    in the state-wide list (e.g. "ranks 46-50"), so there's no safe "start
    at 1" fallback the way Vault Trap has. Running this same inference
    AFTER tag-filtering (as the pre-"Round 3" code briefly did, and its
    predecessor's buggy "previous *kept* row + 1" version did before that)
    is exactly the bug this avoids: most of the ranks between two
    consecutive *kept* rows legitimately belong to other alliances and
    were correctly discarded, so "previous kept row + 1" was never a valid
    assumption once filtering had happened -- see
    docs/ocr-reference/capitol_war_mismatch_2026-08-23.md ("Round 2" /
    "Round 3").

    A chunk with no explicit digit anywhere else in the same image to
    anchor from comes back with rank=None -- the correct, honest fallback,
    not a guess."""
    n = len(chunks)
    explicit: list = [None] * n
    for i, c in enumerate(chunks):
        m = _RANK_DIGIT_RE.search(c)
        if not m:
            continue
        explicit[i] = int(m.group(1))
        chunks[i] = c[:m.start()] + ' ' + c[m.end():]

    explicit, rank_misread = _drop_implausible_explicit_ranks(explicit)
    rank_explicit = [v is not None for v in explicit]

    # Forward pass: for each non-explicit index, the nearest EARLIER anchor
    # -- (inferred value, distance).
    fwd: list = [None] * n
    last_idx = last_rank = None
    for i in range(n):
        if explicit[i] is not None:
            last_idx, last_rank = i, explicit[i]
        elif last_idx is not None:
            fwd[i] = (last_rank + (i - last_idx), i - last_idx)

    # Backward pass: for each non-explicit index, the nearest LATER anchor.
    bwd: list = [None] * n
    next_idx = next_rank = None
    for i in range(n - 1, -1, -1):
        if explicit[i] is not None:
            next_idx, next_rank = i, explicit[i]
        elif next_idx is not None:
            bwd[i] = (next_rank - (next_idx - i), next_idx - i)

    ranks = list(explicit)
    for i in range(n):
        if ranks[i] is not None:
            continue
        f, b = fwd[i], bwd[i]
        if f is not None and b is not None:
            ranks[i] = f[0] if f[1] <= b[1] else b[0]
        elif f is not None:
            ranks[i] = f[0]
        elif b is not None:
            ranks[i] = b[0]
        # else: no anchor anywhere in this image -- stays None.

    return ranks, rank_explicit, rank_misread


def capitol_neighbor_rank_warnings(rows: list, *, threshold: int = _RANK_NEIGHBOR_THRESHOLD) -> list[str]:
    """Flag an EXPLICIT rank that's wildly inconsistent with its nearer
    points-sorted neighbor's explicit rank -- catches a genuine digit
    misread that doesn't collide with any other row's rank, so
    `rank_sequence_warnings`' duplicate-only check has nothing to catch
    (see docs/ocr-reference/capitol_war_mismatch_2026-08-23.md, "Round 4,
    second issue": Baba's real rank 91 misread as "11" gets no warning at
    all, since nothing else in the data happens to also claim rank 11).

    `rows` must already be points-sorted descending (the same order
    `self.rows` is displayed in via `_sort_rows`) -- "neighbor" here means
    points-adjacent, which is what rank is supposed to broadly track, not
    list-index-adjacent by coincidence.

    Rows whose explicit rank is itself part of an exact duplicate (already
    covered by `rank_sequence_warnings`'s "Rank N appears twice" message)
    are excluded on BOTH sides: not flagged again here (avoids two warnings
    for the one row), and skipped when looking for a neighbor to compare
    AGAINST -- a neighbor whose own rank is already known-corrupted would
    make an equally-wrong row look plausible by comparison (concretely: in
    the real dataset, Baba's immediate points-neighbor is ReddXking, whose
    rank was independently misread as "6"; comparing Baba's wrong "11" to
    ReddXking's wrong "6" gives a deceptively small gap and would mask the
    exact anomaly this is meant to surface -- walking past it to the next
    reliable neighbor is what actually reproduces the doc's example)."""
    counts: dict = {}
    for r in rows:
        if r.get('rank_explicit') and r.get('rank') is not None:
            counts[r['rank']] = counts.get(r['rank'], 0) + 1
    dup_ranks = {rank for rank, n in counts.items() if n > 1}

    def reliable(row):
        return (row.get('rank_explicit') and row.get('rank') is not None
                and row['rank'] not in dup_ranks)

    n = len(rows)
    warnings = []
    for i, row in enumerate(rows):
        if not reliable(row):
            continue
        prev_rank = next(
            (rows[j]['rank'] for j in range(i - 1, -1, -1) if reliable(rows[j])), None
        )
        next_rank = next(
            (rows[j]['rank'] for j in range(i + 1, n) if reliable(rows[j])), None
        )
        candidates = [r for r in (prev_rank, next_rank) if r is not None]
        if not candidates:
            continue
        nearest_gap = min(abs(row['rank'] - r) for r in candidates)
        if nearest_gap > threshold:
            name = (row.get('name') or '').strip() or '(unnamed row)'
            warnings.append(
                f"Rank {row['rank']} for {name} looks inconsistent with nearby "
                f"points-sorted rows — may be a misread digit"
            )
    return warnings


def capitol_rank_correction_warnings(rows: list) -> list[str]:
    """Surface every row where `_drop_implausible_explicit_ranks` discarded
    a misread explicit digit and re-inferred a corrected rank from
    trustworthy neighbors instead (see docs/ocr-reference/
    capitol_war_mismatch_2026-08-23.md, "Round 5") -- purely an audit trail
    so an admin can see a number was silently rewritten and double check
    it, not something that affects matching/sorting (both already rely on
    points, never on this rank label -- see `_sort_rows`)."""
    warnings = []
    for row in rows:
        misread = row.get('rank_misread')
        if misread is None:
            continue
        name = (row.get('name') or '').strip() or '(unnamed row)'
        corrected = row.get('rank')
        warnings.append(
            f"Rank corrected from misread {misread} to inferred "
            f"{corrected} for {name}"
        )
    return warnings


def parse_capitol_rows(text: str, alliance_tag: str | None, after_pos: int = None):
    """Parse the Honor Roll's row list into [(name, points, rank), ...],
    filtering out every row whose bracketed alliance tag doesn't match
    `alliance_tag` (case-insensitive) BEFORE any row is handed to roster
    matching -- a `[L4W]` row must never be scored against an `[APX]`
    roster, both for correctness and to avoid a coincidental cross-alliance
    name collision (see docs/ocr-reference/capitol_war.md).

    Rank determination (explicit-digit read + same-image position
    inference, see `_infer_capitol_ranks`) runs on the FULL, unfiltered
    row list BEFORE tag filtering -- adjacency only means rank-adjacency
    on that full list, not on the tag-filtered subset (see
    docs/ocr-reference/capitol_war_mismatch_2026-08-23.md, "Round 3").

    Returns (rows, total_candidates): `rows` is the tag-filtered, cleaned
    list (same shape as vault_track.parse_player_rows' output);
    `total_candidates` is how many row-shaped chunks were found before tag
    filtering, so callers can report "Filtered to N of M rows for [TAG]"."""
    if after_pos is None:
        after_pos = find_capitol_section_start(text)
    tail = text[after_pos:]
    matches = list(_FORMATTED_NUMBER_RE.finditer(tail))
    if not matches:
        return [], 0

    chunks, points_vals = [], []
    prev_end = 0
    for m in matches:
        chunks.append(tail[prev_end:m.start()])
        points_vals.append(int(re.sub(r'[^\d]', '', m.group(0))))
        prev_end = m.end()

    # Strip the "Points" (or "Damage Points") column-label leak; the same
    # regex already covers a bare "Points" suffix.
    for i, c in enumerate(chunks):
        chunks[i] = _ROW_LABEL_SUFFIX_RE.sub('', c).rstrip()

    # Pinned own-row dedup -- reused exactly (see docs/ocr-reference/
    # capitol_war.md's "Pinned own-row" section and
    # tests/test_vault_pinned_row.py, which this mechanism was proven
    # against). The leading rank digit this checks sits before the bracket
    # tag regardless of tag content, so this runs before tag extraction.
    # Only catches the case where the pinned row DOES carry an explicit
    # rank digit that visibly breaks ascending order against the row before
    # it -- see _drop_capitol_pinned_outlier_row below for the (much more
    # common in real data) no-digit-at-all case this misses entirely.
    _before_pin_drop = len(chunks)
    drop_pinned_trailing_row(chunks, points_vals, is_ranking=True)
    if len(chunks) == _before_pin_drop:
        # Nothing dropped above -- try the points-outlier signal instead
        # (see docs/ocr-reference/capitol_war_mismatch_2026-08-23.md,
        # "Round 4"). Skipped when the rank-digit check already fired, so a
        # screenshot never loses two trailing rows to two different pinned-
        # row heuristics stacking on top of each other.
        _drop_capitol_pinned_outlier_row(chunks, points_vals)

    total_candidates = len(chunks)

    # --- Rank determination, on the FULL unfiltered list, BEFORE tag
    # filtering removes any row from the sequence (see _infer_capitol_ranks
    # and docs/ocr-reference/capitol_war_mismatch_2026-08-23.md "Round 3").
    # Mutates `chunks` in place, stripping each explicit digit it finds.
    ranks, ranks_explicit, ranks_misread = _infer_capitol_ranks(chunks)

    # --- Tag extraction + filtering, BEFORE any name cleanup or matching ---
    tag_norm = (alliance_tag or "").strip().upper()
    kept_chunks, kept_points, kept_ranks, kept_ranks_explicit, kept_ranks_misread = [], [], [], [], []
    for c, pts, rank, rank_explicit, rank_misread in zip(
            chunks, points_vals, ranks, ranks_explicit, ranks_misread):
        m = _ALLIANCE_TAG_RE.search(c)
        if not m:
            continue  # no confirmable tag -- discard rather than risk it
        row_tag = m.group(0)[1:-1].upper()
        if tag_norm and row_tag != tag_norm:
            continue
        kept_chunks.append(c)
        kept_points.append(pts)
        kept_ranks.append(rank)
        kept_ranks_explicit.append(rank_explicit)
        kept_ranks_misread.append(rank_misread)

    # Strip a wrapped-name's trailing word leaking off the FRONT of this
    # chunk (see _LEADING_WRAP_LEAK_RE above) -- must run before the tag
    # bracket itself gets stripped below, since the heuristic keys off the
    # bracket still being present.
    for i, c in enumerate(kept_chunks):
        kept_chunks[i] = _LEADING_WRAP_LEAK_RE.sub('', c, count=1)

    # From here on, mirror parse_player_rows' proven cleaning steps on the
    # already tag-confirmed rows only.
    for i, c in enumerate(kept_chunks):
        c = _ALLIANCE_TAG_RE.sub(' ', c)
        # Fallback OCR garbles ']' into a letter, gluing the tag onto a
        # non-Latin name -- same fix as parse_player_rows.
        c = re.sub(r'^\s*\[[A-Za-z0-9]{3}[A-Za-z]?(?=[^\x00-\x7F])', '', c)
        kept_chunks[i] = c

    valid = [i for i, c in enumerate(kept_chunks) if not re.search(r'[.?\[\]]', c)]
    if 0 in valid and len(kept_chunks[0].split()) > 8:
        valid.remove(0)

    for _ in range(4):
        stripped = _strip_common_trailing_token([kept_chunks[i] for i in valid])
        if stripped == [kept_chunks[i] for i in valid]:
            break
        for idx, new_c in zip(valid, stripped):
            kept_chunks[idx] = new_c

    rows = []
    for i in valid:
        chunk = kept_chunks[i]
        # Rank (explicit or same-image-inferred) was already determined
        # above, on the FULL unfiltered list, before tag filtering --
        # nothing left to extract here; the digit itself (when present) was
        # already stripped out of the chunk text by _infer_capitol_ranks.
        # Note: _LEADING_SHORT_TOKEN_RE (vault's bracket-less-tag-leak strip)
        # is deliberately NOT applied here -- every row here already carried
        # a real bracketed tag (required to survive the filter above), so
        # there's no bracket-less tag leak for it to guard against, and
        # applying it anyway risks eating a genuine short leading name token
        # (e.g. "XXX" in "XXX TARGET" -- see the Vault Trap mismatch doc).
        name = re.sub(r'\s+', ' ', chunk).strip()
        if sum(c.isalpha() for c in name) < 3:
            name = ''
        rows.append({'name': name, 'damage': kept_points[i], 'rank': kept_ranks[i],
                     'rank_explicit': kept_ranks_explicit[i],
                     'rank_misread': kept_ranks_misread[i]})

    return rows, total_candidates


# ---------------------------------------------------------------------------
# OCR ingestion. Two entry points share this function: /capitol_add (one-shot,
# up to 5 attachments, no `session`/`progress_callback`) and the channel-
# listener's CapitolSession (accumulates screenshots over a sliding timeout,
# passes both so OCR engines stay warm across the whole session and the
# collecting embed can show live per-image progress -- see CapitolSession
# below). The engine dispatch itself -- primary + fallback-language OCR,
# box-aligned and damage-keyed fallback merge, script-position anchoring --
# mirrors vault_track._ocr_attachment_to_result exactly via the imported
# helpers; only the row parser (parse_capitol_rows) and the absence of a
# trap/rallies/total-damage extraction step differ.
# ---------------------------------------------------------------------------

@dataclass
class CapitolImageResult:
    ok: bool = False
    date: str = ""
    rows: dict = field(default_factory=dict)  # keyed by points value
    candidates_seen: int = 0  # row-shaped chunks found before tag filtering


async def ocr_attachment_to_capitol_result(image_bytes: bytes, primary_lang: str,
                                           fallback_langs: list, *, filename: str = "",
                                           roster: list | None = None,
                                           alliance_id: int | None = None,
                                           alliance_tag: str | None = None,
                                           progress_callback=None,
                                           session=None) -> CapitolImageResult:
    """OCR one Honor Roll screenshot (primary + fallbacks) -> CapitolImageResult,
    with rows already tag-filtered to `alliance_tag`. Mirrors vault_track.
    VaultTrack._ocr_attachment_to_result's structure and fallback-merge logic,
    reusing its proven sub-pieces directly; this version has no trap/rallies/
    total-damage extraction (Capitol War has none of those fields -- see
    docs/ocr-reference/capitol_war.md).

    `progress_callback(phase, lang)` is awaited per OCR phase, and `session`
    (a CapitolSession) is threaded into ocr_bytes_with_boxes so its OCR
    engines are acquired once and reused across the whole session instead of
    per image -- both optional and unused by /capitol_add's one-shot call
    site, which passes neither."""
    result = CapitolImageResult()
    if progress_callback:
        await progress_callback('ocr', primary_lang)
    try:
        async with _get_ocr_semaphore():
            primary_boxed = await ocr_bytes_with_boxes(image_bytes, primary_lang, session=session)
        extracted_text = ' '.join(t for t, _b in primary_boxed)
    except Exception as e:
        logger.error(f"Capitol War OCR error ({primary_lang}) on {filename}: {e}")
        return result
    if not extracted_text.strip():
        return result

    result.ok = True
    repaired = repair_ocr_digits(extracted_text)
    logger.info(f"Capitol War OCR [{primary_lang}] ({filename}): {extracted_text!r} → {repaired!r}")

    parsed_rows, candidates_seen = parse_capitol_rows(repaired, alliance_tag)
    result.candidates_seen = candidates_seen
    img_rows = {row['damage']: row for row in parsed_rows}

    primary_filled = sum(1 for r in img_rows.values() if not is_row_unfilled(r, roster))
    record_ocr_lang_run(alliance_id, primary_lang, 'primary', primary_filled)

    fallback_langs = [lang for lang in (fallback_langs or []) if lang != primary_lang]
    if fallback_langs and any(is_row_unfilled(r, roster) for r in img_rows.values()):
        seen_repaired_texts = {repaired}
        attempts = 0
        for fb_lang in fallback_langs:
            if attempts >= MAX_FALLBACK_ATTEMPTS:
                logger.info(
                    f"Capitol War OCR: fallback budget hit ({MAX_FALLBACK_ATTEMPTS} "
                    f"useful runs), stopping early on {filename}"
                )
                break
            if not any(is_row_unfilled(r, roster) for r in img_rows.values()):
                break
            if progress_callback:
                await progress_callback('fallback', fb_lang)
            try:
                async with _get_ocr_semaphore():
                    fb_boxed = await ocr_bytes_with_boxes(image_bytes, fb_lang, session=session)
                fb_text = ' '.join(t for t, _b in fb_boxed)
            except Exception as e:
                logger.warning(f"Capitol War OCR fallback {fb_lang} failed: {e}")
                continue
            if not fb_text.strip():
                continue
            fb_repaired = repair_ocr_digits(fb_text)
            if fb_repaired in seen_repaired_texts:
                record_ocr_lang_run(alliance_id, fb_lang, 'fallback', 0)
                continue
            seen_repaired_texts.add(fb_repaired)
            logger.info(f"Capitol War OCR fallback [{fb_lang}] ({filename}): {fb_repaired!r}")
            if not _output_matches_lang_script(fb_repaired, fb_lang):
                record_ocr_lang_run(alliance_id, fb_lang, 'fallback', 0)
                continue
            attempts += 1
            pre_scores = {dmg: name_match_score(r.get('name') or '', roster)
                          for dmg, r in img_rows.items()}
            fb_rows, _fb_candidates = parse_capitol_rows(fb_repaired, alliance_tag)
            if fb_lang in _RTL_LANGS:
                for fr in fb_rows:
                    if fr.get('name'):
                        fr['name'] = _reverse_for_rtl(fr['name'], fb_lang)
            filled = merge_fallback_rows_by_damage(img_rows, fb_rows, roster, fb_lang)
            if not filled:
                filled = merge_fallback_rows_by_boxes(
                    img_rows, primary_boxed, fb_boxed, roster, fb_lang
                )
            if not filled and fb_lang not in _LATIN_ONLY_LANGS:
                fill_unfilled_by_position(img_rows, fb_repaired, fb_lang, filename, roster)
            rows_improved = sum(
                1 for dmg, r in img_rows.items()
                if name_match_score(r.get('name') or '', roster) > pre_scores.get(dmg, 0)
            )
            record_ocr_lang_run(alliance_id, fb_lang, 'fallback', rows_improved)

    result.rows = img_rows
    return result


def validate_capitol_submission(date_str) -> list[str]:
    """Header validation for a Capitol War event. Much smaller than Vault
    Trap's validate_vault_submission -- there's no trap_number/rallies/
    total_damage to validate, since none of those fields exist for Capitol
    War (see docs/ocr-reference/capitol_war.md)."""
    errors = []
    try:
        datetime.strptime(str(date_str), "%Y-%m-%d")
    except Exception:
        errors.append("Date must be in YYYY-MM-DD format.")
    return errors


# ---------------------------------------------------------------------------
# Channel-listener session -- the primary ingestion path. An admin points a
# channel at Capitol War (CapitolChannelSetupView below); members just post
# Honor Roll screenshots into it over time, and CapitolSession batches
# everything one user posts within a sliding timeout into a single event,
# same UX as Vault Trap's VaultSession. /capitol_add (above) stays as a
# secondary, one-shot path for manual/direct-attachment use -- it needs none
# of this (see its own docstring).
#
# CapitolSession deliberately does NOT port EventGroup/is_compatible's
# trap-conflict-splitting: Capitol War has no trap-number/rallies field to
# split on and is one-event-per-alliance-per-date (see init_capitol_database's
# docstring), so there's nothing for that machinery to guard against. Instead
# every row from every screenshot in the session folds into one flat
# `rows_by_points` dict, resolved through the same `_better_row` tie-breaker
# /capitol_add already uses for its own up-to-5-attachment merge.
# ---------------------------------------------------------------------------

class CapitolAutoDeleteTracker:
    """Deletes source screenshots once every review view spawned from them
    has been actioned -- Submit, Cancel, OR timeout all count as
    "actioned"; the channel shouldn't keep the raw screenshots around just
    because an admin backed out or a session lapsed, since the whole point
    is not leaving them in the channel forever (this was previously gated
    on `any_submitted`, which meant a cancelled or timed-out review kept
    its screenshots indefinitely; every real Capitol War session in a day
    of manual re-testing ended that way, which is what prompted this
    change). A small mirror of vault_track.VaultAutoDeleteTracker (not a
    raw reuse) purely so its log lines say "Capitol War", not "Vault
    Trap" -- same rationale as learn_capitol_alias mirroring learn_alias
    elsewhere in this file."""

    def __init__(self, source_messages, enabled: bool):
        self.source_messages = list(source_messages)
        self.enabled = enabled
        self.pending = 0
        logger.info(
            f"Capitol War auto-delete tracker: enabled={enabled}, "
            f"source_messages={len(self.source_messages)}"
        )

    def register(self):
        self.pending += 1

    async def on_submit(self):
        self.pending -= 1
        await self._maybe_delete()

    async def on_cancel(self):
        self.pending -= 1
        await self._maybe_delete()

    async def _maybe_delete(self):
        if not self.enabled:
            logger.info("Capitol War auto-delete: skipped (disabled in alliance settings)")
            return
        if self.pending != 0:
            return
        deleted = not_found = forbidden = other_failed = 0
        for msg in self.source_messages:
            try:
                await msg.delete()
                deleted += 1
            except discord.NotFound:
                not_found += 1
            except discord.Forbidden:
                forbidden += 1
            except Exception as e:
                other_failed += 1
                logger.warning(
                    f"Capitol War auto-delete: unexpected failure deleting "
                    f"message {msg.id}: {e}"
                )
        if forbidden:
            logger.warning(
                f"Capitol War auto-delete: {forbidden} message(s) blocked — "
                f"bot needs **Manage Messages** on the Capitol War channel."
            )
        logger.info(
            f"Capitol War auto-delete: total={len(self.source_messages)}, "
            f"deleted={deleted}, already_gone={not_found}, "
            f"forbidden={forbidden}, errors={other_failed}"
        )


class CapitolSession:
    """Per-(channel, user) session: accumulates Honor Roll screenshots
    within a sliding timeout, flat-merges their rows by points value, then
    hands off to CapitolWarReviewView. Mirrors vault_track.VaultSession's
    lifecycle; see the module-level note above for why the merge itself is
    flat (rows_by_points) instead of EventGroup-clustered."""

    def __init__(self, *, cog, channel_id: int, user_id: int, alliance_id: int,
                 alliance_name: str, alliance_tag: str | None, roster,
                 primary_lang: str, fallback_langs: list,
                 timeout_min: int, auto_delete: bool):
        self.cog = cog
        self.channel_id = channel_id
        self.user_id = user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.tag = alliance_tag
        self.roster = roster
        self.primary_lang = primary_lang
        self.fallback_langs = fallback_langs
        self.timeout_min = timeout_min
        self.auto_delete = auto_delete

        self.rows_by_points: dict = {}
        self.candidates_seen = 0
        self.kept_seen = 0
        self.source_messages: list[discord.Message] = []
        self.lock = asyncio.Lock()
        # Set without the lock so Cancel lands mid-batch.
        self.cancel_requested = False
        self.timer_task: asyncio.Task | None = None
        self.progress_msg: discord.Message | None = None
        self.session_view: discord.ui.View | None = None
        self.processed_images = 0
        self.known_total_images = 0
        self.any_ocr_success = False
        self.finalized = False
        # In-flight OCR state (None when idle).
        self.current_image_idx: int | None = None
        self.current_image_total: int | None = None
        self.current_phase: str | None = None
        self.current_lang: str | None = None
        # OCR engines acquired by this session (released at finalize/cancel).
        self._engine_handles: dict = {}
        self._engine_cache: dict = {}

    # Reused verbatim from VaultSession -- see the import block's note on why
    # these (and not finalize/cancel) are safe to share as class-level method
    # assignments: they only ever touch `self` and module-generic globals.
    _ensure_engine = VaultSession._ensure_engine
    _release_all_engines = VaultSession._release_all_engines
    restart_timer = VaultSession.restart_timer
    _timer_run = VaultSession._timer_run
    stop_timer = VaultSession.stop_timer

    # --- Crash resume: snapshot merged rows after each image, restore on restart ---
    def _snapshot_key(self) -> str:
        return f"capitol:{self.channel_id}:{self.user_id}"

    def snapshot_payload(self) -> dict:
        return {
            'channel_id': self.channel_id, 'user_id': self.user_id,
            'alliance_id': self.alliance_id, 'alliance_name': self.alliance_name,
            'alliance_tag': self.tag,
            'primary_lang': self.primary_lang, 'fallback_langs': self.fallback_langs,
            'timeout_min': self.timeout_min, 'auto_delete': self.auto_delete,
            'processed_images': self.processed_images,
            'known_total_images': self.known_total_images,
            'any_ocr_success': self.any_ocr_success,
            'candidates_seen': self.candidates_seen,
            'kept_seen': self.kept_seen,
            'rows_by_points': {str(k): v for k, v in self.rows_by_points.items()},
        }

    def restore_events(self, payload: dict) -> None:
        self.processed_images = payload.get('processed_images', 0)
        self.known_total_images = payload.get('known_total_images', 0)
        self.any_ocr_success = payload.get('any_ocr_success', False)
        self.candidates_seen = payload.get('candidates_seen', 0)
        self.kept_seen = payload.get('kept_seen', 0)
        rows = {}
        for k, v in (payload.get('rows_by_points') or {}).items():
            try:
                k = int(k)
            except (TypeError, ValueError):
                pass
            rows[k] = v
        self.rows_by_points = rows

    def save_snapshot(self) -> None:
        if self.finalized:
            # In-flight batches must not re-create a deleted snapshot (phantom recovery).
            return
        from . import ocr_resume
        ocr_resume.save(self._snapshot_key(), 'capitol', self.snapshot_payload())

    def delete_snapshot(self) -> None:
        from . import ocr_resume
        ocr_resume.delete(self._snapshot_key())

    async def resume(self) -> None:
        """Re-post the progress message for a session recovered after a restart."""
        channel = self.cog.bot.get_channel(self.channel_id)
        if channel is None:
            return
        embed = discord.Embed(
            title=f"{theme.searchIcon} Recovered your Capitol War upload",
            description=(
                f"{theme.upperDivider}\n"
                f"The bot restarted mid-upload. **{len(self.rows_by_points)}** parsed "
                f"row(s) kept.\n"
                f"Click **Done Uploading** to review and submit, or re-upload any "
                f"screenshots that weren't processed yet.\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1,
        )
        self.session_view = CapitolSessionView(self)
        self.progress_msg = await channel.send(embed=embed, view=self.session_view)
        self.restart_timer()

    def build_progress_embed(self) -> discord.Embed:
        title = f"{theme.searchIcon} Capitol War — collecting"

        if self.processed_images == 0 and self.current_image_idx is None:
            summary = f"{theme.processingIcon} Processing first screenshot…"
        elif not self.rows_by_points and self.current_image_idx is None:
            summary = (
                f"{theme.warnIcon} **{self.processed_images}** screenshot(s) processed, "
                f"no readable data extracted yet."
            )
        else:
            total_points = sum(r['damage'] for r in self.rows_by_points.values())
            n_players = len(self.rows_by_points)
            summary = (
                f"**{self.processed_images}** screenshot{'s' if self.processed_images != 1 else ''} "
                f"processed · **{n_players}** player{'s' if n_players != 1 else ''} found\n"
                f"Alliance Total: {format_damage_for_embed(total_points)}"
            )

        if self.current_image_idx is not None:
            bar = VaultSession._progress_bar(self.current_image_idx, self.current_image_total or 1)
            phase_label = "fallback OCR" if self.current_phase == 'fallback' else "running OCR"
            lang_label = VaultSession._short_lang_label(self.current_lang)
            lang_part = f" ({lang_label})" if lang_label else ""
            status_line = (
                f"\n\n{bar} **{self.current_image_idx}/{self.current_image_total}** · "
                f"{theme.processingIcon} {phase_label}{lang_part}…"
            )
            footer_line = (
                f"\n\n{theme.hourglassIcon} You can click **Done Uploading** anytime. "
                f"It will wait for current screenshots to finish before opening the review."
            )
        else:
            status_line = ""
            footer_line = (
                f"\n\n{theme.hourglassIcon} Waiting up to **{self.timeout_min} min** "
                f"for more screenshots…"
            )

        description = (
            f"{theme.upperDivider}\n"
            f"{summary}"
            f"{status_line}"
            f"{footer_line}\n"
            f"{theme.lowerDivider}"
        )
        embed = discord.Embed(title=title, description=description, color=theme.emColor1)
        if onnx_lifecycle.LOW_MEM_MODE and self.current_image_idx is not None:
            embed.set_footer(text="Please wait, this can take a while...")
        return embed

    async def render_progress(self):
        if not self.progress_msg:
            return
        try:
            await self.progress_msg.edit(
                embed=self.build_progress_embed(),
                view=self.session_view,
            )
        except Exception:
            pass

    async def add_message(self, message: discord.Message, image_attachments: list):
        self.known_total_images += len(image_attachments)
        if self.current_image_idx is not None:
            self.current_image_total = self.known_total_images
            await self.render_progress()

        async with self.lock:
            if self.finalized:
                return
            self.source_messages.append(message)

            async def _phase_callback(phase: str, lang: str):
                self.current_phase = phase
                self.current_lang = lang
                await self.render_progress()

            for attachment in image_attachments:
                if self.cancel_requested:
                    logger.info("Capitol War OCR: batch stopped early, session cancelled by the user")
                    return
                self.current_image_idx = self.processed_images + 1
                self.current_image_total = self.known_total_images
                self.current_phase = 'ocr'
                self.current_lang = self.primary_lang
                await self.render_progress()
                try:
                    image_bytes = await attachment.read()
                except Exception as e:
                    logger.error(f"Capitol War OCR read error on {attachment.filename}: {e}")
                    continue
                result = await ocr_attachment_to_capitol_result(
                    image_bytes, self.primary_lang, self.fallback_langs,
                    filename=attachment.filename, roster=self.roster,
                    alliance_id=self.alliance_id, alliance_tag=self.tag,
                    progress_callback=_phase_callback, session=self,
                )
                self.processed_images += 1
                if result.ok:
                    self.any_ocr_success = True
                    self.candidates_seen += result.candidates_seen
                    self.kept_seen += len(result.rows)
                    for key, row in result.rows.items():
                        existing = self.rows_by_points.get(key)
                        if existing is None or _better_row(existing, row, roster=self.roster):
                            self.rows_by_points[key] = row
                await self.render_progress()
                self.save_snapshot()
                if onnx_lifecycle.LOW_MEM_MODE:
                    gc.collect()

            self.current_image_idx = None
            self.current_image_total = None
            self.current_phase = None
            self.current_lang = None
            await self.render_progress()
            self.restart_timer()

    async def finalize(self, *, timed_out: bool = False):
        async with self.lock:
            if self.finalized:
                return
            self.finalized = True
            self.stop_timer()
            _active_capitol_sessions.pop((self.channel_id, self.user_id), None)
        try:
            await self.cog._finalize_capitol_session(self, timed_out=timed_out)
            # Delete the crash-resume snapshot only on success so a restart can recover after errors.
            self.delete_snapshot()
        finally:
            await self._release_all_engines()

    async def cancel(self):
        self.cancel_requested = True
        async with self.lock:
            if self.finalized:
                return
            self.finalized = True
            self.stop_timer()
            _active_capitol_sessions.pop((self.channel_id, self.user_id), None)
            self.delete_snapshot()
        await self._release_all_engines()
        if self.progress_msg:
            embed = discord.Embed(
                description=f"{theme.deniedIcon} Capitol War collection cancelled.",
                color=theme.emColor2,
            )
            try:
                await self.progress_msg.edit(embed=embed, view=None)
            except Exception:
                pass


_active_capitol_sessions: dict = {}


async def _retire_stale_capitol_recovery(interaction: discord.Interaction) -> None:
    """Retire a recovery message whose session is gone so its button isn't left dead."""
    embed = discord.Embed(
        description=f"{theme.hourglassIcon} This Capitol War upload recovery has expired. Nothing to submit.",
        color=theme.emColor2,
    )
    try:
        await interaction.response.edit_message(embed=embed, view=None)
    except Exception:
        try:
            await interaction.response.defer()
        except Exception:
            pass


class CapitolSessionButton(discord.ui.DynamicItem[discord.ui.Button],
                           template=r'capitolsess:(?P<action>done|cancel):(?P<channel>[0-9]+):(?P<user>[0-9]+)'):
    """Done/Cancel button with the session key in its custom_id, so clicks
    survive a restart. A distinct 'capitolsess:' prefix (vs. Vault Trap's
    'vaultsess:') keeps the two DynamicItem template registrations from ever
    colliding."""

    def __init__(self, action: str, channel_id: int, user_id: int):
        self.action = action
        self.channel_id = channel_id
        self.user_id = user_id
        if action == 'done':
            label, emoji, style = "Done Uploading", f"{theme.verifiedIcon}", discord.ButtonStyle.success
        else:
            label, emoji, style = "Cancel", f"{theme.deniedIcon}", discord.ButtonStyle.secondary
        super().__init__(discord.ui.Button(
            label=label, emoji=emoji, style=style,
            custom_id=f"capitolsess:{action}:{channel_id}:{user_id}",
        ))

    @classmethod
    async def from_custom_id(cls, interaction, item, match):
        return cls(match['action'], int(match['channel']), int(match['user']))

    async def callback(self, interaction: discord.Interaction):
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Only the user who started this session can finalize it.",
                ephemeral=True,
            )
            return
        session = _active_capitol_sessions.get((self.channel_id, self.user_id))
        if session is None:
            await _retire_stale_capitol_recovery(interaction)
            return
        if not await _ack_component(interaction):
            return
        if self.action == 'done':
            asyncio.create_task(session.finalize(timed_out=False))
        else:
            asyncio.create_task(session.cancel())


class CapitolSessionView(discord.ui.View):
    """Done/Cancel buttons; DynamicItem-based so they keep working after a restart."""

    def __init__(self, session: "CapitolSession"):
        super().__init__(timeout=None)
        self.session = session
        self.add_item(CapitolSessionButton('done', session.channel_id, session.user_id))
        self.add_item(CapitolSessionButton('cancel', session.channel_id, session.user_id))


# ---------------------------------------------------------------------------
# CapitolWarReviewView -- pre-save review/edit of OCR'd (or manually-entered)
# event rows. Structurally mirrors VaultHuntReviewView, reusing the
# collision guard (resolve_unique_assignments) and rank-sequence warnings
# (rank_sequence_warnings) imported from vault_track rather than
# re-implementing them -- see docs/ocr-reference/
# vault_trap_mismatch_2026-08-23.md for why those two mechanisms exist.
#
# Naming note: the shared helpers `_write_match_to_row`/`_fid_in_hunt`/
# `_resolve_and_apply` (imported from vault_track) dispatch on
# `getattr(view, "hunt_id", None)` to tell a live pre-save review (no DB
# event yet) from a saved/edit view (has one) -- that attribute name is a
# leftover from Vault Trap's own vocabulary, kept as-is deliberately so this
# view can reuse those functions completely unmodified. This class never
# sets `hunt_id` (it stays absent), so every match resolves in-memory until
# Submit persists it -- exactly like VaultHuntReviewView.
# ---------------------------------------------------------------------------

class CapitolWarReviewView(discord.ui.View):
    """Review/edit OCR-extracted (or manually-entered) Capitol War rows;
    submit persists to capitol_war_events/capitol_war_points."""

    ROWS_PER_PAGE = 25

    def __init__(self, cog, data_submit, *, event_meta, rows, roster, tag_note,
                 alliance_id, alliance_name, original_user_id,
                 existing_event_id=None, existing_rows=None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.data_submit = data_submit
        self.event_meta = event_meta
        self.roster = roster
        self.tag_note = tag_note  # "Filtered to N of M rows for [TAG]" or None
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.original_user_id = original_user_id
        self.existing_event_id = existing_event_id
        self.message = None
        self.page = 0

        self.rows = [self._enrich_row(r)
                     for r in self._merge_existing_rows(rows, existing_rows or [])]
        resolve_unique_assignments(self.rows, self.roster)
        self._sort_rows()
        self._build_components()

    def _enrich_row(self, raw_row):
        candidates = resolve_against_capitol_roster(
            raw_row.get('name') or '', self.roster, self.alliance_id)
        status = classify_match(candidates)
        fid = nickname = None
        if status == 'auto':
            fid, nickname, _ = candidates[0]
        return {
            'name': raw_row.get('name') or '',
            'damage': int(raw_row.get('damage') or 0),  # points -- see module docstring
            'rank': raw_row.get('rank'),
            'rank_explicit': bool(raw_row.get('rank_explicit')),
            'rank_misread': raw_row.get('rank_misread'),
            'fid': fid,
            'nickname': nickname,
            'candidates': candidates,
            'status': status,
        }

    def _merge_existing_rows(self, new_rows, old_rows):
        """Keep the better-matching name per row when re-uploading for a date
        already on record. Mirrors VaultHuntReviewView._merge_existing_rows."""
        if not old_rows:
            return list(new_rows)
        used = set()
        by_dmg, by_rank = {}, {}
        for o in old_rows:
            by_dmg.setdefault(int(o['damage']), []).append(o)
            if o.get('rank') is not None:
                by_rank.setdefault(o['rank'], []).append(o)

        def take(pool):
            for o in pool:
                if id(o) not in used:
                    used.add(id(o))
                    return o
            return None

        def score(name):
            cands = resolve_against_capitol_roster(name or '', self.roster, self.alliance_id)
            return cands[0][2] if cands else 0

        merged = []
        for n in new_rows:
            old = take(by_dmg.get(int(n.get('damage') or 0), []))
            if old is None and n.get('rank') is not None:
                old = take(by_rank.get(n['rank'], []))
            row = dict(n)
            if old is not None and score(old['name']) > score(n.get('name')):
                row['name'] = old['name']
            merged.append(row)
        for o in old_rows:
            if id(o) not in used:
                merged.append({'name': o['name'], 'damage': o['damage'], 'rank': o.get('rank'),
                                'rank_explicit': bool(o.get('rank_explicit')),
                                'rank_misread': o.get('rank_misread')})
        return merged

    def _sort_rows(self):
        # Points-descending, NOT the OCR'd rank -- rank is a short 1-2 digit
        # token, far more prone to a single-digit misread than the long
        # comma-grouped points value (e.g. a rank of 90 misread as "06"
        # collapses to 6 via int("06"), which would otherwise sort a
        # 626K-point row next to two ~7M-point rows). The in-game rank badge
        # is itself derived from a points-descending sort in the first
        # place, so points is both the more reliable signal AND the actual
        # source of truth rank is computed from -- see
        # docs/ocr-reference/capitol_war_mismatch_2026-08-23.md. `rank` is
        # still kept on the row (display label / rank_sequence_warnings),
        # just never trusted for ordering.
        self.rows.sort(key=lambda r: -r['damage'])

    def _total_pages(self):
        return max(1, -(-len(self.rows) // self.ROWS_PER_PAGE))

    def build_embed(self):
        parts = []
        if self.existing_event_id is not None:
            parts.append(
                f"{theme.editListIcon} **Editing this alliance's existing Capitol War "
                f"event for {self.event_meta.get('date')}.** "
                f"Submitting overwrites that record; matches from the previous "
                f"submission are kept where the new screenshots came up blank."
            )
        if self.tag_note:
            parts.append(f"{theme.infoIcon} {self.tag_note}")
        unreadable_rows = sum(
            1 for r in self.rows
            if sum(c.isalpha() for c in (r.get('name') or '')) < 3
        )
        if self.rows and unreadable_rows / len(self.rows) >= 0.25:
            parts.append(
                f"{theme.warnIcon} *Many rows didn't match cleanly. "
                f"If this happens often, your OCR language may not fit your "
                f"alliance's player names — adjust Vault Trap Tracking's OCR "
                f"Languages setting (shared across both trackers).*"
            )
        # check_gaps=False: Capitol War rows are a tag-filtered SUBSET of a
        # state-wide ranking (only this alliance's rows survive), so the
        # gap half of rank_sequence_warnings (built for Vault Trap's own
        # single-alliance, contiguous ranking page) would flag every other
        # alliance's rank number as "missing" -- dozens of false positives
        # burying the real duplicate-rank signal. See
        # docs/ocr-reference/capitol_war_mismatch_2026-08-23.md.
        rank_warnings = rank_sequence_warnings(self.rows, check_gaps=False)
        # Neighbor-consistency check: catches a genuine explicit-digit
        # misread that doesn't collide with another row's rank (e.g. Baba's
        # real 91 misread as "11"), which the duplicate-only check above
        # has nothing to catch -- see capitol_neighbor_rank_warnings and
        # docs/ocr-reference/capitol_war_mismatch_2026-08-23.md "Round 4,
        # second issue". self.rows is already points-sorted by _sort_rows
        # (called before build_embed), so "neighbor" means points-adjacent.
        rank_warnings = rank_warnings + capitol_neighbor_rank_warnings(self.rows)
        # Audit trail for rows where an implausible explicit digit was
        # discarded and re-inferred from trustworthy neighbors instead of
        # merely flagged -- see _drop_implausible_explicit_ranks and
        # docs/ocr-reference/capitol_war_mismatch_2026-08-23.md "Round 5".
        rank_warnings = rank_warnings + capitol_rank_correction_warnings(self.rows)
        if rank_warnings:
            shown = rank_warnings[:6]
            lines = "\n".join(f"{theme.warnIcon} {w}" for w in shown)
            if len(rank_warnings) > len(shown):
                lines += f"\n{theme.warnIcon} …and {len(rank_warnings) - len(shown)} more"
            parts.append(lines)
        parts.append(
            "*Select a player to edit in the drop-down; "
            "clear the name to delete the row.*"
        )
        action_lines = [
            f"{theme.addIcon} **Add Player**\n"
            f"└ Add a missed player row manually.",
            f"{theme.editListIcon} **Edit Event**\n"
            f"└ Update the date or time.",
            f"{theme.verifiedIcon} **Submit**\n"
            f"└ Save this event, including unmatched rows you can fix later.",
        ]
        parts.append("\n".join(action_lines))
        embed = discord.Embed(
            title=(f"{theme.editListIcon} Edit Capitol War Event"
                   if self.existing_event_id is not None
                   else f"{theme.chartIcon} Review Capitol War Event"),
            description="\n\n".join(parts),
            color=theme.emColor1,
        )
        embed.add_field(name="Alliance", value=self.alliance_name or f"ID {self.alliance_id}", inline=False)
        embed.add_field(name="Date", value=self.event_meta['date'], inline=True)
        if self.event_meta.get('event_time'):
            embed.add_field(name="Time (UTC)", value=self.event_meta['event_time'], inline=True)
        embed.add_field(
            name="Alliance Total Points",
            value=format_damage_for_embed(sum(r['damage'] for r in self.rows)) if self.rows else "-",
            inline=True,
        )

        if not self.rows:
            embed.add_field(name="Players", value="*No player rows detected. Use Add Player to add manually.*", inline=False)
            return embed

        start = self.page * self.ROWS_PER_PAGE
        end = min(start + self.ROWS_PER_PAGE, len(self.rows))
        lines = []
        for i, r in enumerate(self.rows[start:end], start=start):
            rank_str = f"**#{r['rank']}**" if r['rank'] is not None else "**?**"
            icon = _STATUS_ICONS.get(r['status'], '')
            status = r['status']
            if status == 'auto':
                player = f"`{_isolate_rtl(r['nickname'])}` · `{r['fid']}`"
            elif status == 'likely':
                score = r.get('match_score')
                score_str = f" ({score}%)" if score is not None else ""
                player = f"`{_isolate_rtl(r['nickname'])}`{score_str} · `{r['fid']}`"
            elif status == 'ambiguous':
                tops = " / ".join(
                    f"`{_isolate_rtl(c[1])}` (`{c[0]}`, {c[2]}%)"
                    for c in r['candidates'][:2]
                )
                player = f"{tops}"
            elif status == 'manual':
                player = f"`{_isolate_rtl(r['nickname'])}` · `{r['fid']}`"
            elif status == 'collision':
                top_fid, top_nick, score = r['candidates'][0]
                player = (f"`{_isolate_rtl(top_nick)}` ({score}%) · `{top_fid}` — "
                          f"also another row's top guess, needs manual review")
            else:
                cands = r.get('candidates') or []
                if cands:
                    top_fid, top_nick, score = cands[0]
                    player = f"`{_isolate_rtl(top_nick)}` ({score}%) · taken by another row"
                else:
                    name = r['name'] or "unreadable"
                    player = f"`{_isolate_rtl(name)}` — no match"
            lines.append(_ltr_line(f"{rank_str} {icon} {player} — `{format_damage_for_embed(r['damage'])}`"))

        total_pages = self._total_pages()
        header = (
            f"Players {start + 1}-{end} of {len(self.rows)}"
            if total_pages > 1 else f"Players ({len(self.rows)})"
        )
        # Discord field value limit is 1024 chars per field -- spill into
        # extra fields (chunk_lines_for_fields) rather than truncating, so
        # every row this page's header promises actually renders.
        add_paginated_field(embed, header, lines)

        unresolved = sum(1 for r in self.rows if r['status'] in ('none', 'ambiguous', 'collision'))
        if unresolved:
            embed.set_footer(
                text=f"{unresolved} row(s) without a confirmed player will be saved "
                     f"as unmatched. Resolve them now or later from Capitol War Records."
            )
        return embed

    def _build_components(self):
        self.clear_items()

        if self.rows:
            start = self.page * self.ROWS_PER_PAGE
            end = min(start + self.ROWS_PER_PAGE, len(self.rows))
            options = []
            for i, r in enumerate(self.rows[start:end], start=start):
                rank_part = f"#{r['rank']}" if r['rank'] is not None else "?"
                name_part = r['nickname'] or r['name'] or "(unreadable)"
                fid_part = f" · {r['fid']}" if r.get('fid') else ""
                label = _ltr_line(f"{rank_part} {name_part}{fid_part}")[:100]
                status_label = _STATUS_LABELS.get(r['status'], r['status'])
                desc = f"{format_damage_for_embed(r['damage'])} · {status_label}"[:100]
                options.append(discord.SelectOption(label=label, value=str(i), description=desc))
            select = discord.ui.Select(placeholder="Edit a row…", options=options, row=0)
            select.callback = self._on_row_selected
            self.add_item(select)

        row1 = [
            ("Add Player", theme.addIcon, discord.ButtonStyle.success, self._on_add_row),
            ("Edit Event", theme.editListIcon, discord.ButtonStyle.primary, self._on_edit_header),
        ]
        for label, emoji, style, cb in row1:
            btn = discord.ui.Button(label=label, emoji=emoji, style=style, row=1)
            btn.callback = cb
            self.add_item(btn)

        row2 = [
            ("Submit", theme.verifiedIcon, discord.ButtonStyle.success, self._on_submit),
            ("Cancel", theme.deniedIcon, discord.ButtonStyle.secondary, self._on_cancel),
        ]
        for label, emoji, style, cb in row2:
            btn = discord.ui.Button(label=label, emoji=emoji, style=style, row=2)
            btn.callback = cb
            self.add_item(btn)

        total_pages = self._total_pages()
        if total_pages > 1:
            prev_btn = discord.ui.Button(
                label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary,
                row=3, disabled=(self.page == 0),
            )
            prev_btn.callback = self._on_prev
            self.add_item(prev_btn)
            page_label = discord.ui.Button(
                label=f"Page {self.page + 1}/{total_pages}",
                style=discord.ButtonStyle.secondary,
                row=3, disabled=True,
            )
            self.add_item(page_label)
            next_btn = discord.ui.Button(
                label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary,
                row=3, disabled=(self.page >= total_pages - 1),
            )
            next_btn.callback = self._on_next
            self.add_item(next_btn)

    async def refresh(self, interaction):
        resolve_unique_assignments(self.rows, self.roster)
        self._sort_rows()
        total_pages = self._total_pages()
        if self.page >= total_pages:
            self.page = total_pages - 1
        self._build_components()
        embed = self.build_embed()
        if interaction.response.is_done():
            await interaction.edit_original_response(embed=embed, view=self)
        else:
            await interaction.response.edit_message(embed=embed, view=self)

    async def reapply_to_message(self, message):
        resolve_unique_assignments(self.rows, self.roster)
        self._sort_rows()
        total_pages = self._total_pages()
        if self.page >= total_pages:
            self.page = total_pages - 1
        self._build_components()
        try:
            await message.edit(embed=self.build_embed(), view=self)
        except discord.HTTPException:
            pass

    # ---------- button callbacks ----------

    async def _on_row_selected(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        idx = int(interaction.data['values'][0])
        if idx >= len(self.rows):
            await interaction.response.send_message(
                f"{theme.deniedIcon} That row no longer exists. Please try again.",
                ephemeral=True,
            )
            return
        await interaction.response.send_modal(EditCapitolRowModal(self, idx))

    async def _on_edit_header(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(EditCapitolHeaderModal(self))

    async def _on_add_row(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(AddCapitolRowModal(self))

    async def _on_submit(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        errors = validate_capitol_submission(self.event_meta['date'])
        if errors:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Cannot submit: " + "; ".join(errors),
                ephemeral=True,
            )
            return
        seen_fids = set()
        for r in self.rows:
            if r['fid'] is None:
                continue
            if r['fid'] in seen_fids:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} ID `{r['fid']}` is assigned to more than one row. "
                    f"Resolve the duplicate before submitting.",
                    ephemeral=True,
                )
                return
            seen_fids.add(r['fid'])

        try:
            submitted = await self.data_submit.process_full_submission(
                interaction,
                event_meta=self.event_meta,
                player_rows=self.rows,
                alliance_id=self.alliance_id,
                alliance_name=self.alliance_name,
                existing_event_id=self.existing_event_id,
            )
            if submitted:
                self.stop()
        except Exception as e:
            logger.error(f"Error in capitol review submit: {e}")
            print(f"[ERROR] Error in capitol review submit: {e}")
            try:
                await interaction.followup.send(
                    f"{theme.deniedIcon} Error during submission: {e}", ephemeral=True
                )
            except Exception:
                pass
            self.stop()

    async def _on_cancel(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        embed = discord.Embed(
            description=f"{theme.deniedIcon} Capitol War review canceled.",
            color=theme.emColor2,
        )
        await interaction.response.edit_message(content=None, embed=embed, view=None)
        self.stop()

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True
        if self.message is not None:
            embed = discord.Embed(
                title=f"{theme.hourglassIcon} Capitol War Review Expired",
                description=(
                    f"This review timed out after 2 hours of inactivity and "
                    f"can no longer be submitted. Run `/capitol_add` again to "
                    f"start a new review."
                ),
                color=theme.emColor2,
            )
            try:
                await self.message.edit(content=None, embed=embed, view=None)
            except Exception as e:
                logger.warning(f"Capitol War: could not edit timed-out review message: {e}")

    async def _on_prev(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if self.page > 0:
            self.page -= 1
        await self.refresh(interaction)

    async def _on_next(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if self.page < self._total_pages() - 1:
            self.page += 1
        await self.refresh(interaction)


class EditCapitolHeaderModal(discord.ui.Modal):
    """Edit the event-level header fields (date / time). No trap/rallies/
    total-damage fields exist for Capitol War -- mirrors EditHeaderModal
    minus everything that doesn't apply."""

    def __init__(self, review_view: CapitolWarReviewView):
        super().__init__(title="Edit Capitol War Event")
        self.review_view = review_view
        meta = review_view.event_meta
        self.date_input = discord.ui.TextInput(
            label="Date (YYYY-MM-DD)", default=meta['date'] or "", max_length=10,
        )
        self.time_input = discord.ui.TextInput(
            label="Time (UTC, optional) - HH:MM",
            default=meta.get('event_time') or "",
            required=False, max_length=5,
        )
        self.add_item(self.date_input)
        self.add_item(self.time_input)

    async def on_submit(self, interaction):
        try:
            dt = datetime.strptime(self.date_input.value.strip(), "%Y-%m-%d")
            date_norm = dt.strftime("%Y-%m-%d")
        except Exception:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Date must be YYYY-MM-DD.", ephemeral=True,
            )
            return
        try:
            event_time = _normalize_event_time(self.time_input.value)
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Time must be HH:MM (24-hour UTC), or blank.",
                ephemeral=True,
            )
            return
        self.review_view.event_meta = {'date': date_norm, 'event_time': event_time}
        await self.review_view.refresh(interaction)


class EditCapitolRowModal(discord.ui.Modal):
    """Edit a single player row. Blank player field deletes the row."""

    def __init__(self, review_view: CapitolWarReviewView, row_idx: int):
        row = review_view.rows[row_idx]
        title = f"Edit Row {row_idx + 1}"
        if row.get('fid'):
            title += f" · ID {row['fid']}"
        super().__init__(title=title[:45])
        self.review_view = review_view
        self.row_idx = row_idx
        current_player = row['nickname'] or row['name'] or ''
        self.player_input = discord.ui.TextInput(
            label="Player (ID or name — blank to delete)",
            default=current_player, required=False, max_length=80,
        )
        self.points_input = discord.ui.TextInput(
            label="Points", default=format_damage_for_embed(row['damage']),
            required=True, max_length=30,
        )
        self.rank_input = discord.ui.TextInput(
            label="Rank (optional)",
            default=str(row['rank']) if row['rank'] is not None else "",
            required=False, max_length=3,
        )
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)",
            required=False, max_length=80,
        )
        self.add_item(self.player_input)
        self.add_item(self.points_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction):
        if self.row_idx >= len(self.review_view.rows):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Row no longer exists.", ephemeral=True,
            )
            return
        if not self.player_input.value.strip():
            del self.review_view.rows[self.row_idx]
            await self.review_view.refresh(interaction)
            return
        points, rank, err = _parse_damage_rank(self.points_input.value, self.rank_input.value)
        if err:
            await interaction.response.send_message(f"{theme.deniedIcon} {err}", ephemeral=True)
            return
        edit_row = self.review_view.rows[self.row_idx]
        await _resolve_and_apply(
            interaction, self.review_view, row_id=self.row_idx,
            text=self.player_input.value, damage=points, rank=rank,
            raw_name=edit_row.get('name'),
            current_fid=edit_row.get('fid'),
            current_name=edit_row.get('nickname') or edit_row.get('name'),
            new_name=self.new_name_input.value,
            entity_label="event", row_label="Capitol War row",
        )


class AddCapitolRowModal(discord.ui.Modal):
    """Add a new player row manually (e.g. for rows OCR missed entirely)."""

    def __init__(self, review_view: CapitolWarReviewView):
        super().__init__(title="Add Player Row")
        self.review_view = review_view
        self.player_input = discord.ui.TextInput(
            label="Player (ID or name)", required=True, max_length=80,
        )
        self.points_input = discord.ui.TextInput(
            label="Points", required=True, max_length=30,
        )
        self.rank_input = discord.ui.TextInput(
            label="Rank (optional)", required=False, max_length=3,
        )
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)",
            required=False, max_length=80,
        )
        self.add_item(self.player_input)
        self.add_item(self.points_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction):
        text = self.player_input.value.strip()
        if not text:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Player is required.", ephemeral=True)
            return
        points, rank, err = _parse_damage_rank(self.points_input.value, self.rank_input.value)
        if err:
            await interaction.response.send_message(f"{theme.deniedIcon} {err}", ephemeral=True)
            return
        await _resolve_and_apply(
            interaction, self.review_view, row_id=None,
            text=text, damage=points, rank=rank, raw_name=text,
            new_name=self.new_name_input.value,
            entity_label="event", row_label="Capitol War row",
        )


# ---------------------------------------------------------------------------
# CapitolDataSubmit -- persistence + chart-embed rendering. Structurally
# mirrors vault_track.DataSubmit's process_full_submission/process_view, but
# genuinely needs its own version: no trap_number axis, no rallies/total-
# damage fields to persist, and "alliance total" is computed by summing this
# event's own points rows (there's nothing to parse for it -- see
# docs/ocr-reference/capitol_war.md) instead of pulled from OCR text. No
# attendance-system integration either (out of scope for this feature).
# ---------------------------------------------------------------------------

class CapitolDataSubmit:
    def __init__(self, alliance_conn, capitol_conn):
        self.alliance_conn = alliance_conn
        self.alliance_cursor = alliance_conn.cursor()
        self.capitol_conn = capitol_conn
        self.capitol_cursor = capitol_conn.cursor()

    def _load_existing_event(self, alliance_id, date):
        """(event_id, rows) for a prior submission on this date, else (None, [])."""
        if isinstance(date, datetime):
            date = date.strftime("%Y-%m-%d")
        self.capitol_cursor.execute(
            "SELECT id FROM capitol_war_events WHERE alliance_id=? AND date=?",
            (alliance_id, date),
        )
        row = self.capitol_cursor.fetchone()
        if not row:
            return None, []
        self.capitol_cursor.execute(
            "SELECT raw_name, resolved_nickname, points, rank "
            "FROM capitol_war_points WHERE event_id=?",
            (row[0],),
        )
        rows = [{'name': r[0] or r[1] or '', 'damage': r[2], 'rank': r[3]}
                for r in self.capitol_cursor.fetchall()]
        return row[0], rows

    async def process_full_submission(self, interaction, *, event_meta, player_rows,
                                      alliance_id=None, alliance_name=None,
                                      existing_event_id=None):
        """Persist a reviewed Capitol War event: event row + every player
        row. Rows with `fid is None` are saved with NULL fid so the raw
        OCR'd name and points are preserved for later resolution. Returns
        True once the event is persisted."""
        if not interaction.response.is_done():
            await interaction.response.defer()

        date = event_meta['date']
        event_time = event_meta.get('event_time')
        if isinstance(date, datetime):
            date = date.strftime("%Y-%m-%d")
        if alliance_name is None:
            self.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
            arow = self.alliance_cursor.fetchone()
            alliance_name = arow[0] if arow else f"Alliance ID: {alliance_id}"

        matched = unmatched = 0
        edited = False
        try:
            if existing_event_id is not None:
                self.capitol_cursor.execute(
                    "SELECT id FROM capitol_war_events WHERE alliance_id=? AND date=?",
                    (alliance_id, date),
                )
                existing = self.capitol_cursor.fetchone()
                if existing:
                    event_id = existing[0]
                    self.capitol_cursor.execute(
                        "UPDATE capitol_war_events SET event_time=? WHERE id=?",
                        (event_time, event_id),
                    )
                    self.capitol_cursor.execute(
                        "DELETE FROM capitol_war_points WHERE event_id=?", (event_id,)
                    )
                    edited = True
            if not edited:
                try:
                    self.capitol_cursor.execute(
                        "INSERT INTO capitol_war_events (alliance_id, date, event_time) "
                        "VALUES (?, ?, ?)",
                        (alliance_id, date, event_time),
                    )
                    event_id = self.capitol_cursor.lastrowid
                except sqlite3.IntegrityError:
                    self.capitol_conn.rollback()
                    await interaction.followup.send(
                        f"{theme.warnIcon} This alliance already submitted a Capitol War "
                        f"event for that date.",
                        ephemeral=True,
                    )
                    return False

            learned: list[tuple] = []
            if player_rows:
                for r in player_rows:
                    fid = r.get('fid')
                    score = r.get('match_score')
                    if score is None and r.get('candidates'):
                        score = r['candidates'][0][2]
                    self.capitol_cursor.execute(
                        "INSERT INTO capitol_war_points "
                        "(event_id, fid, raw_name, resolved_nickname, points, rank, match_score) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (event_id, fid, r.get('name'), r.get('nickname'),
                         int(r['damage']), r.get('rank'), score),
                    )
                    if fid:
                        matched += 1
                        if r.get('name'):
                            learned.append((r['name'], fid))
                    else:
                        unmatched += 1
            self.capitol_conn.commit()
        except Exception:
            self.capitol_conn.rollback()
            raise

        # Audit trail: post to the alliance's configured Activity Log
        # channel (same channel/setting alliance_member_operations.py's
        # member-roster actions already use -- see /settings -> alliance ->
        # Set Log Channel) so admins can see who submitted what without
        # digging through log/bot.txt on disk. Only fires for an actually
        # persisted submission (past the commit above), not every
        # screenshot upload or cancelled session -- _post_alliance_log is
        # itself a no-op if no log channel is configured, and swallows its
        # own errors, so this can never fail the submission it's logging.
        log_desc = (
            f"**Alliance:** {alliance_name}\n"
            f"**Submitted by:** {interaction.user.mention} (`{interaction.user.id}`)\n"
            f"**Date:** {date}\n"
            f"**Players:** {matched} matched"
        )
        if unmatched:
            log_desc += f", {unmatched} unmatched"
        if edited:
            log_desc += "\n*(updated an existing submission)*"
        await _post_alliance_log(
            interaction.client, alliance_id,
            discord.Embed(
                title=f"{theme.chartIcon} Capitol War Submitted",
                description=log_desc,
                color=theme.emColor2,
            ),
        )

        for name, fid in learned:
            try:
                learn_capitol_alias(alliance_id, name, fid)
            except Exception as e:
                logger.warning(f"Capitol War OCR: post-commit learn_alias failed for {name!r}: {e}")

        title_suffix = "Updated Submission" if edited else "Latest Submission"
        if player_rows:
            title_suffix += f" · {matched} player(s)"
            if unmatched:
                title_suffix += f" · {unmatched} unmatched"

        self.capitol_cursor.execute(
            "SELECT e.date, COALESCE(SUM(p.points), 0) "
            "FROM capitol_war_events e LEFT JOIN capitol_war_points p ON p.event_id = e.id "
            "WHERE e.alliance_id = ? GROUP BY e.id ORDER BY e.date ASC",
            (alliance_id,),
        )
        rows = self.capitol_cursor.fetchall()
        dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in rows]
        totals = [int(r[1] or 0) for r in rows]

        try:
            file = _render_damage_chart(
                dates, totals, title=f"{alliance_name} · Capitol War Points", ylabel="Points",
            )
        except Exception as e:
            logger.error(f"Failed to generate Capitol War chart: {e}")
            file = None

        alliance_total = sum(int(r['damage']) for r in (player_rows or []))
        embed = discord.Embed(
            title=f"{theme.chartIcon} {alliance_name} · Capitol War · {title_suffix}",
            color=theme.emColor1,
        )
        embed.add_field(name="Date", value=date, inline=True)
        embed.add_field(name="Alliance Total Points", value=format_damage_for_embed(alliance_total), inline=True)
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        if unmatched:
            embed.set_footer(
                text=f"{matched} matched · {unmatched} saved as unmatched. "
                     f"Resolve from Capitol War Records when ready."
            )

        try:
            await interaction.edit_original_response(
                embeds=[embed], attachments=[file] if file else [], view=None,
            )
        except discord.NotFound:
            try:
                if file:
                    await interaction.followup.send(embeds=[embed], file=file)
                else:
                    await interaction.followup.send(embeds=[embed])
            except Exception as e:
                logger.error(f"Failed to send Capitol War submission result: {e}")
        except Exception as e:
            logger.error(f"Failed to edit Capitol War submission message: {e}")
        return True

    async def process_view(self, *, alliance_id: int, from_date: str | None = None,
                           to_date: str | None = None, alliance_name: str | None = None):
        """Generate a view embed + chart of this alliance's total points per
        event date."""
        if alliance_name is None:
            self.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
            row = self.alliance_cursor.fetchone()
            alliance_name = row[0] if row else f"Alliance ID: {alliance_id}"

        self.capitol_cursor.execute(
            "SELECT e.date, COALESCE(SUM(p.points), 0) "
            "FROM capitol_war_events e LEFT JOIN capitol_war_points p ON p.event_id = e.id "
            "WHERE e.alliance_id = ? GROUP BY e.id ORDER BY e.date ASC",
            (alliance_id,),
        )
        rows = self.capitol_cursor.fetchall()
        if not rows:
            return None, None

        if not from_date:
            from_date = rows[0][0]
        if not to_date:
            to_date = rows[-1][0]
        try:
            from_dt = datetime.strptime(from_date, "%Y-%m-%d").date()
            to_dt = datetime.strptime(to_date, "%Y-%m-%d").date()
        except ValueError:
            return None, None
        if from_dt > to_dt:
            return None, None

        filtered_rows = [
            r for r in rows
            if from_dt <= datetime.strptime(r[0], "%Y-%m-%d").date() <= to_dt
        ]
        if not filtered_rows:
            return None, None

        dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in filtered_rows]
        totals = [int(r[1] or 0) for r in filtered_rows]

        try:
            file = await asyncio.to_thread(
                _render_damage_chart, dates, totals,
                title=f"{alliance_name} · Capitol War Points", ylabel="Points",
            )
        except Exception as e:
            logger.error(f"Capitol War chart render failed: {e}")
            return None, None

        embed = discord.Embed(
            title=f"{theme.chartIcon} {alliance_name} · Capitol War · View Points",
            color=theme.emColor1,
        )
        embed.add_field(name="Range", value=f"{from_date} → {to_date}", inline=True)
        embed.add_field(name="Latest Total", value=format_damage_for_embed(totals[-1]), inline=True)
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        return embed, file


# ---------------------------------------------------------------------------
# Channel-listener hand-off: CapitolSessionReviewView adds auto-delete-
# tracker notification on top of CapitolWarReviewView, WITHOUT changing
# CapitolWarReviewView itself -- /capitol_add's review has no source
# screenshots to delete and needs none of this, so it keeps constructing
# CapitolWarReviewView directly.
#
# Submit is handled via _TrackerAwareDataSubmit (a thin wrapper passed in as
# `data_submit`) rather than an override, since CapitolWarReviewView's
# `_on_submit` already gates tracker-worthy success behind
# `self.data_submit.process_full_submission(...)` returning True -- wrapping
# that call reuses that exact gating instead of re-deriving it. Cancel and
# timeout have no such hook (neither touches data_submit), so those two are
# overridden directly.
# ---------------------------------------------------------------------------

class _TrackerAwareDataSubmit:
    """Wraps CapitolDataSubmit so a successful submit also notifies a
    CapitolAutoDeleteTracker, without CapitolWarReviewView needing to know
    trackers exist at all. Every other attribute passes through untouched."""

    def __init__(self, data_submit, tracker: CapitolAutoDeleteTracker):
        self._data_submit = data_submit
        self._tracker = tracker

    def __getattr__(self, name):
        return getattr(self._data_submit, name)

    async def process_full_submission(self, *args, **kwargs):
        submitted = await self._data_submit.process_full_submission(*args, **kwargs)
        if submitted and self._tracker:
            try:
                await self._tracker.on_submit()
            except Exception as e:
                logger.warning(f"Capitol War auto-delete tracker (on_submit) raised: {e}")
        return submitted


class CapitolSessionReviewView(CapitolWarReviewView):
    """CapitolWarReviewView plus auto-delete-tracker notification on Cancel
    and timeout, used only by the channel-listener's finalize hand-off (see
    CapitolWar._finalize_capitol_session). A subclass, not a change to
    CapitolWarReviewView -- see the section docstring above."""

    def __init__(self, *args, auto_delete_tracker: CapitolAutoDeleteTracker | None = None, **kwargs):
        self._auto_delete_tracker = auto_delete_tracker
        self._tracker_notified = False
        super().__init__(*args, **kwargs)

    async def _notify_tracker_cancel(self):
        if self._auto_delete_tracker and not self._tracker_notified:
            self._tracker_notified = True
            try:
                await self._auto_delete_tracker.on_cancel()
            except Exception as e:
                logger.warning(f"Capitol War auto-delete tracker (on_cancel) raised: {e}")

    async def _on_cancel(self, interaction):
        await super()._on_cancel(interaction)
        await self._notify_tracker_cancel()

    async def on_timeout(self):
        await super().on_timeout()
        await self._notify_tracker_cancel()


# ---------------------------------------------------------------------------
# Capitol War channel info message -- pinned "what to upload" helper.
# Mirrors vault_track's own _VAULT_INFO_FINGERPRINTS / render_vault_info_
# message (see that module) with Capitol-flavored wording; the cog-method
# half (_looks_like_capitol_info_message / refresh_capitol_info_message)
# lives on CapitolWar below, same split as vault_track uses.
# ---------------------------------------------------------------------------

_CAPITOL_INFO_FINGERPRINTS = (
    "Upload your Capitol War Honor Roll here",
)


def render_capitol_info_message() -> str:
    """The pinned helper text for a Capitol War score channel -- what to upload."""
    return "\n".join([
        f"{theme.importIcon} **Upload your Capitol War Honor Roll here**",
        "",
        f"{theme.listIcon} **What to upload**",
        f"{theme.upperDivider}",
        "• The **Honor Roll** ranking screen (state-wide, every alliance's "
        "members interleaved) -- as many pages as it takes to cover this "
        "alliance's members.",
        f"{theme.lowerDivider}",
        "",
        f"{theme.infoIcon} **Tips**",
        "• This alliance needs a **tag** set (Alliance Management → Set Tag) "
        "before the bot can tell which rows belong to it.",
        "• Set your in-game language to **English** for the best results.",
        "• The bot reads each upload automatically and posts the parsed points here.",
    ])


# ---------------------------------------------------------------------------
# CapitolChannelSetupView -- per-alliance setup: where to listen, what to
# listen for. Mirrors vault_track.VaultChannelSetupView's structure, minus
# Character Recognition (Capitol War intentionally shares Vault Trap
# Tracking's OCR language settings -- see CapitolWar._ocr_language_settings
# -- rather than duplicating that picker) and Damage Range (no lookback-
# window setting exists for Capitol War charts; CapitolWarView's own Time
# Range picker already covers that role).
# ---------------------------------------------------------------------------

class CapitolChannelSetupView(discord.ui.View):
    def __init__(self, cog, original_user_id):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id: int | None = None
        self._build_components()

    def _build_components(self):
        self.clear_items()
        opts = build_alliance_options(self.cog.alliance_conn)
        for opt in opts:
            opt.default = (int(opt.value) == (self.alliance_id or 0))
        self.add_item(CapitolAllianceSelect(self, opts, action="manage"))

        has_alliance = self.alliance_id is not None

        channel_btn = discord.ui.Button(label="Change Channel", style=discord.ButtonStyle.primary, emoji=theme.announceIcon, row=1, disabled=not has_alliance)
        channel_btn.callback = self._change_channel_callback
        self.add_item(channel_btn)

        keywords_btn = discord.ui.Button(label="Keywords", style=discord.ButtonStyle.primary, emoji=theme.editListIcon, row=1, disabled=not has_alliance)
        keywords_btn.callback = self._manage_keywords_callback
        self.add_item(keywords_btn)

        back_btn = discord.ui.Button(label="Back", style=discord.ButtonStyle.secondary, emoji=theme.backIcon, row=2)
        back_btn.callback = self._back_callback
        self.add_item(back_btn)

    def _build_embed(self) -> discord.Embed:
        embed = discord.Embed(
            title=f"{theme.editListIcon} Capitol War Channel Setup",
            description=(
                f"Per-alliance setup for screenshot collection: which channel "
                f"to watch and which messages to process.\n\n"
                f"**Available Operations**\n"
                f"{theme.upperDivider}\n"
                f"{theme.announceIcon} **Change Channel**\n"
                f"└ Which channel the bot watches for Capitol War Honor Roll "
                f"screenshot uploads (**required**)\n\n"
                f"{theme.editListIcon} **Keywords**\n"
                f"└ Words required in the message text to trigger processing; "
                f"use this if folks upload other images in the same channel; "
                f"blank = accept all (default)\n"
                f"{theme.lowerDivider}\n\n"
                f"{theme.infoIcon} OCR character recognition is shared with "
                f"**Vault Trap Tracking**'s settings — configure it there."
            ),
            color=theme.emColor1,
        )

        if self.alliance_id is not None:
            settings = self.cog.get_capitol_settings(self.alliance_id)
            channel = (
                f"<#{settings['channel_id']}>" if settings.get('channel_id')
                else "**Not set** — required"
            )
            keywords = ", ".join(settings["keywords"]) if settings["keywords"] else "None"
            tag = self.cog.get_alliance_tag(self.alliance_id) or "**Not set** — required for tag filtering"
            embed.add_field(
                name="Current Setup",
                value=(
                    f"{theme.upperDivider}\n"
                    f"**Channel:** {channel}\n"
                    f"**Keywords:** {keywords}\n"
                    f"**Alliance Tag:** {tag}\n"
                    f"{theme.lowerDivider}"
                ),
                inline=False,
            )
        return embed

    async def on_alliance_selected(self, interaction: discord.Interaction):
        self._build_components()
        await interaction.response.edit_message(embed=self._build_embed(), view=self)

    async def _change_channel_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        view = CapitolChannelSelectView(
            cog=self.cog, alliance_id=self.alliance_id,
            parent_view=self, parent_message=interaction.message,
        )
        await interaction.response.send_message(
            "Select the Capitol War channel for this alliance:",
            view=view, ephemeral=True,
        )

    async def _manage_keywords_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_capitol_settings(self.alliance_id)
        current_keywords = ", ".join(settings["keywords"])
        await interaction.response.send_modal(
            CapitolKeywordsModal(current_keywords, self.cog, self.alliance_id, self)
        )

    async def _back_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_capitol_menu(interaction)


class CapitolChannelSelectView(discord.ui.View):
    def __init__(self, cog, alliance_id: int, parent_view, parent_message: discord.Message = None):
        super().__init__(timeout=180)
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view
        self.parent_message = parent_message
        self.add_item(CapitolChannelSelect(self))


class CapitolChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent_view: CapitolChannelSelectView):
        super().__init__(
            placeholder="Select a channel...",
            min_values=1,
            max_values=1,
            channel_types=[discord.ChannelType.text, discord.ChannelType.news]
        )
        self.parent_view = parent_view

    async def callback(self, interaction: discord.Interaction):
        try:
            selected_channel = self.values[0]
            channel_id = selected_channel.id

            # Reservation check: refuse if this channel already serves another
            # alliance for Vault Trap Tracking, Capitol War Tracking, or
            # Screenshot Upload.
            from .attendance_ocr_setup import (
                find_conflicting_channel_owner, format_channel_conflict,
            )
            conflict = find_conflicting_channel_owner(
                channel_id, self.parent_view.alliance_id
            )
            if conflict is not None:
                await interaction.response.edit_message(
                    content=f"{theme.deniedIcon} " + format_channel_conflict(
                        conflict, selected_channel.mention
                    ),
                    view=None,
                )
                return

            self.parent_view.cog.update_capitol_setting(
                self.parent_view.alliance_id,
                "capitol_score_channel",
                channel_id
            )

            # Post/refresh the "what to upload" info message in the new channel.
            try:
                await self.parent_view.cog.refresh_capitol_info_message(self.parent_view.alliance_id)
            except Exception as e:
                logger.warning(f"Could not refresh Capitol War info message: {e}")

            await interaction.response.edit_message(
                content=f"{theme.verifiedIcon} Capitol War channel set to {selected_channel.mention}",
                view=None
            )

            # Refresh parent settings embed on the original message
            try:
                parent_msg = self.parent_view.parent_message
                if parent_msg:
                    settings_view = self.parent_view.parent_view
                    embed = settings_view._build_embed()
                    await parent_msg.edit(embed=embed, view=settings_view)
            except Exception as e:
                logger.warning(f"Could not refresh parent settings embed: {e}")

        except Exception as e:
            logger.error(f"CapitolChannelSelect callback error: {e}")
            print(f"[ERROR] CapitolChannelSelect callback error: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save channel.", ephemeral=True
            )


class CapitolKeywordsModal(discord.ui.Modal):
    def __init__(self, current_keywords: str, cog, alliance_id: int,
                 parent_view):
        super().__init__(title="Manage Capitol War Keywords")
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view

        self.keywords_input = discord.ui.TextInput(
            label="Required words in the typed message text",
            style=discord.TextStyle.paragraph,
            default=current_keywords or "",
            placeholder="comma-separated, e.g. honor, roll. Blank = accept any upload.",
            required=False,
            max_length=400
        )
        self.add_item(self.keywords_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            keywords = self.keywords_input.value.strip()
            keyword_csv = ", ".join([kw.strip() for kw in keywords.split(",") if kw.strip()]) if keywords else None

            self.cog.update_capitol_setting(self.alliance_id, "capitol_keywords", keyword_csv)

            embed = self.parent_view._build_embed()
            embed.description += f"\n{theme.verifiedIcon} Keywords updated."
            await safe_edit_message(interaction, embed=embed, view=self.parent_view, content=None)

        except Exception as e:
            logger.error(f"CapitolKeywordsModal error: {e}")
            print(f"[ERROR] CapitolKeywordsModal error: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to update keywords.", ephemeral=True
            )


# ---------------------------------------------------------------------------
# CapitolSettingsView -- operational settings. Mirrors vault_track.
# VaultSettingsView's structure and button layout, minus Toggle Name History
# Match (no equivalent toggle currently exposed anywhere in this file to
# control -- /capitol_add always resolves rosters with include_history=False;
# see module notes).
# ---------------------------------------------------------------------------

class CapitolSettingsView(discord.ui.View):
    def __init__(self, cog, original_user_id, guild_id: int | None = None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id: int | None = None
        # Same shortcut as MainMenu.show_alliance_management (and
        # VaultSettingsView's mirror of it): an admin who only manages one
        # alliance shouldn't have to pick it from a dropdown before the
        # settings buttons even become clickable.
        if guild_id is not None:
            alliances, _ = PermissionManager.get_admin_alliances(original_user_id, guild_id)
            if len(alliances) == 1:
                self.alliance_id = alliances[0][0]
        self._build_components()

    def _build_components(self):
        self.clear_items()
        options = build_alliance_options(self.cog.alliance_conn)
        self.add_item(CapitolAllianceSelect(self, options, action="manage"))

        has_alliance = self.alliance_id is not None

        timeout_btn = discord.ui.Button(label="Session Timeout", style=discord.ButtonStyle.primary, emoji=theme.hourglassIcon, row=1, disabled=not has_alliance)
        timeout_btn.callback = self._session_timeout_callback
        self.add_item(timeout_btn)

        auto_delete_btn = discord.ui.Button(label="Toggle Auto-Delete", style=discord.ButtonStyle.primary, emoji=theme.trashIcon, row=1, disabled=not has_alliance)
        auto_delete_btn.callback = self._toggle_auto_delete_callback
        self.add_item(auto_delete_btn)

        add_perm_btn = discord.ui.Button(label="Toggle Add Permission", style=discord.ButtonStyle.primary, emoji=theme.lockIcon, row=1, disabled=not has_alliance)
        add_perm_btn.callback = self._toggle_add_callback
        self.add_item(add_perm_btn)

        view_perm_btn = discord.ui.Button(label="Toggle View Permission", style=discord.ButtonStyle.primary, emoji=theme.eyeIcon, row=1, disabled=not has_alliance)
        view_perm_btn.callback = self._toggle_view_callback
        self.add_item(view_perm_btn)

        info_btn = discord.ui.Button(label="Toggle Info Message", style=discord.ButtonStyle.primary, emoji=theme.documentIcon, row=2, disabled=not has_alliance)
        info_btn.callback = self._toggle_info_message_callback
        self.add_item(info_btn)

        pin_btn = discord.ui.Button(label="Toggle Pin Info", style=discord.ButtonStyle.primary, emoji=theme.pinIcon, row=2, disabled=not has_alliance)
        pin_btn.callback = self._toggle_pin_info_callback
        self.add_item(pin_btn)

        back_btn = discord.ui.Button(label="Back", style=discord.ButtonStyle.secondary, emoji=theme.backIcon, row=3)
        back_btn.callback = self._back_callback
        self.add_item(back_btn)

    def _build_embed(self) -> discord.Embed:
        embed = discord.Embed(
            title=f"{theme.settingsIcon} Capitol War Settings",
            description=(
                f"Operational settings: session pacing, cleanup, and who "
                f"can interact with the system.\n\n"
                f"**Available Settings**\n"
                f"{theme.upperDivider}\n"
                f"{theme.hourglassIcon} **Session Timeout**\n"
                f"└ Minutes to wait for more screenshots before finalising the event (1-60)\n\n"
                f"{theme.trashIcon} **Toggle Auto-Delete**\n"
                f"└ Delete uploaded screenshots after event submission\n\n"
                f"{theme.lockIcon} **Toggle Permissions**\n"
                f"└ Who can add events and view saved data\n\n"
                f"{theme.documentIcon} **Toggle Info Message / Pin Info**\n"
                f"└ Pinned helper in the Capitol War channel explaining what to upload\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1
        )

        if self.alliance_id:
            settings = self.cog.get_capitol_settings(self.alliance_id)
            view_text = "Admins only" if settings["admin_only_view"] else "Everyone"
            add_text = "Admins only" if settings["admin_only_add"] else "Everyone"
            timeout_min = settings["session_timeout_min"]
            auto_delete_text = "On" if settings["auto_delete_screenshots"] else "Off"
            if settings["post_info_message"] and settings["pin_info_message"]:
                info_text = "On (Pinned)"
            elif settings["post_info_message"]:
                info_text = "On"
            else:
                info_text = "Off"

            current_settings = (
                f"{theme.upperDivider}\n"
                f"**Session Timeout:** {timeout_min} min\n"
                f"**Auto-Delete Screenshots:** {auto_delete_text}\n"
                f"**Info Message:** {info_text}\n"
                f"**Add Permission:** {add_text}\n"
                f"**View Permission:** {view_text}\n"
                f"{theme.lowerDivider}"
            )
            embed.add_field(name="Current Settings", value=current_settings, inline=False)

        return embed

    async def on_alliance_selected(self, interaction: discord.Interaction):
        if not self.alliance_id:
            return
        self._build_components()
        embed = self._build_embed()
        await interaction.response.edit_message(content=None, view=self, embed=embed)

    async def _session_timeout_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_capitol_settings(self.alliance_id)
        await interaction.response.send_modal(
            CapitolSessionTimeoutModal(self.cog, self.alliance_id, settings["session_timeout_min"], self)
        )

    async def _toggle_auto_delete_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_capitol_settings(self.alliance_id)
        new_value = 0 if settings["auto_delete_screenshots"] else 1
        self.cog.update_capitol_setting(self.alliance_id, "capitol_auto_delete_screenshots", new_value)
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Auto-delete is now **{on_off}**."
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _toggle_info_message_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage"):
            return
        settings = self.cog.get_capitol_settings(self.alliance_id)
        new_value = 0 if settings["post_info_message"] else 1
        self.cog.update_capitol_setting(self.alliance_id, "capitol_post_info_message", new_value)
        note = await self._apply_info_refresh(settings["channel_id"])
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Info message is now **{on_off}**.{note}"
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _toggle_pin_info_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage"):
            return
        settings = self.cog.get_capitol_settings(self.alliance_id)
        new_value = 0 if settings["pin_info_message"] else 1
        self.cog.update_capitol_setting(self.alliance_id, "capitol_pin_info_message", new_value)
        note = await self._apply_info_refresh(settings["channel_id"])
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Pin info is now **{on_off}**.{note}"
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _apply_info_refresh(self, channel_id) -> str:
        if not channel_id:
            return " (set a Capitol War channel first to post it)"
        try:
            await self.cog.refresh_capitol_info_message(self.alliance_id)
        except Exception as e:
            logger.warning(f"Could not refresh Capitol War info message: {e}")
        return ""

    async def _toggle_add_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        await self._toggle_permission(interaction, "add")

    async def _toggle_view_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_capitol_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        await self._toggle_permission(interaction, "view")

    async def _toggle_permission(self, interaction: discord.Interaction, mode: str):
        settings = self.cog.get_capitol_settings(self.alliance_id)
        key = f"admin_only_{mode}"
        current = settings.get(key, 0)
        new_value = 0 if current else 1

        column = f"capitol_admin_only_{mode}"
        self.cog.update_capitol_setting(self.alliance_id, column, new_value)

        embed = self._build_embed()
        embed.description += f"\n{theme.verifiedIcon} {mode.capitalize()} permission updated."
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _back_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_capitol_menu(interaction)


class CapitolSessionTimeoutModal(discord.ui.Modal):
    def __init__(self, cog, alliance_id: int, current_timeout: int,
                 parent_view):
        super().__init__(title="Set Session Timeout")
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view

        self.timeout_input = discord.ui.TextInput(
            label="Minutes to wait for more screenshots (1-60)",
            placeholder="e.g. 15",
            default=str(current_timeout),
            required=True,
            max_length=3,
        )
        self.add_item(self.timeout_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            minutes = int(self.timeout_input.value.strip())
            if not (1 <= minutes <= 60):
                raise ValueError
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please enter a whole number between 1 and 60.",
                ephemeral=True,
            )
            return

        try:
            self.cog.update_capitol_setting(self.alliance_id, "capitol_session_timeout_min", minutes)
        except Exception as e:
            logger.error(f"Failed to update Capitol War session timeout: {e}")
            print(f"[ERROR] Failed to update Capitol War session timeout: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save session timeout.", ephemeral=True
            )
            return

        embed = self.parent_view._build_embed()
        embed.description += f"\n{theme.verifiedIcon} Session timeout set to {minutes} min."
        await safe_edit_message(interaction, embed=embed, view=self.parent_view, content=None)


# ---------------------------------------------------------------------------
# CapitolAllianceSelect -- reusable alliance dropdown, mirrors vault_track's
# AllianceSelect exactly except for the permission-check method name it
# calls on the cog (check_capitol_permission vs. check_vault_permission),
# which is the one thing that stopped that class from being reused directly.
# ---------------------------------------------------------------------------

class CapitolAllianceSelect(discord.ui.Select):
    def __init__(self, parent_view, options: list[discord.SelectOption], action: str):
        self.parent_view = parent_view
        self.action = action
        for opt in options:
            opt.default = (parent_view.alliance_id is not None and int(opt.value) == parent_view.alliance_id)
        super().__init__(
            placeholder="Select an alliance",
            min_values=1, max_values=1,
            options=options if options else [discord.SelectOption(label="No alliances", value="__none__")]
        )

    async def callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.parent_view.original_user_id):
            return
        try:
            new_alliance_id = int(self.values[0])
            allowed = await self.parent_view.cog.check_capitol_permission(
                interaction, new_alliance_id, self.action)
            if not allowed:
                return
            self.parent_view.alliance_id = new_alliance_id
            for opt in self.options:
                opt.default = (int(opt.value) == self.parent_view.alliance_id)
            if hasattr(self.parent_view, "on_alliance_selected"):
                await self.parent_view.on_alliance_selected(interaction)
            elif hasattr(self.parent_view, "try_redraw"):
                await self.parent_view.try_redraw(interaction)
        except Exception as e:
            logger.error(f"Error in CapitolAllianceSelect callback: {e}")
            try:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Error processing alliance selection.", ephemeral=True)
            except Exception:
                pass


def _capitol_viewer_embed() -> discord.Embed:
    return discord.Embed(
        title=f"{theme.chartIcon} Capitol War Points Viewer",
        description=(
            f"Pick an alliance to load its points chart.\n\n"
            f"**Controls**\n"
            f"{theme.upperDivider}\n"
            f"{theme.calendarIcon} **Time Range**\n"
            f"└ Set the chart date window (default: last 3 months)\n\n"
            f"{theme.medalIcon} **Top Players**\n"
            f"└ Leaderboard by total, events, or average points\n\n"
            f"{theme.documentIcon} **Events**\n"
            f"└ Browse and manage individual events and their players\n"
            f"{theme.lowerDivider}"
        ),
        color=theme.emColor1,
    )


class CapitolMenuView(discord.ui.View):
    """Capitol War's own main-menu screen, mirrors vault_track.VaultMenuView's
    button layout. Reached from the bot's main menu (see bot_main_menu.py's
    "Capitol War Tracking" button) and used as the Back-button destination
    for the chart/leaderboard views below (CapitolWar.show_capitol_menu)."""

    def __init__(self, cog, original_user_id):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id

    @discord.ui.button(label="Capitol War Points", style=discord.ButtonStyle.primary, emoji=theme.chartIcon, row=1)
    async def view_capitol_points(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        view = CapitolWarView(
            data_submit=self.cog.data_submit,
            cog=self.cog,
            original_user_id=self.original_user_id,
        )
        embed = _capitol_viewer_embed()
        await safe_edit_message(interaction, embed=embed, view=view, content=None, clear_attachments=True)

    @discord.ui.button(label="Capitol War Channel Setup", style=discord.ButtonStyle.success, emoji=theme.editListIcon, row=1)
    async def capitol_channel_setup(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        is_admin, _ = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You need admin permissions to set the Capitol War channel.",
                ephemeral=True
            )
            return
        view = CapitolChannelSetupView(cog=self.cog, original_user_id=self.original_user_id)
        await safe_edit_message(
            interaction, embed=view._build_embed(), view=view, content=None,
        )

    @discord.ui.button(label="Settings", style=discord.ButtonStyle.secondary, emoji=theme.settingsIcon, row=2)
    async def settings(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return

        is_admin, _ = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You need admin permissions to access Capitol War settings.",
                ephemeral=True
            )
            return

        view = CapitolSettingsView(
            cog=self.cog, original_user_id=self.original_user_id,
            guild_id=interaction.guild_id if interaction.guild else 0,
        )
        embed = view._build_embed()
        await safe_edit_message(interaction, embed=embed, view=view, content=None)

    @discord.ui.button(label="Main Menu", style=discord.ButtonStyle.secondary, emoji=theme.homeIcon, row=2)
    async def main_menu(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        main_menu_cog = self.cog.bot.get_cog("MainMenu")
        if main_menu_cog:
            await main_menu_cog.show_main_menu(interaction)
        else:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Main menu not available.", ephemeral=True
            )


# ---------------------------------------------------------------------------
# CapitolWarView -- alliance chart + nav. Mirrors VaultDamageView, minus the
# Vault Trap 1/2/Both trap-number axis (Capitol War has no equivalent -- one
# ranking snapshot per date, see docs/ocr-reference/capitol_war.md).
#
# Attribute contract kept deliberately identical to VaultDamageView's
# (preset / from_date / to_date as `date` objects / _apply_preset() /
# _build_components() / try_redraw() / original_user_id) so the Time Range
# picker reuses vault_track.VaultTimeRangeView and DateRangeModal completely
# unmodified instead of a near-duplicate class.
# ---------------------------------------------------------------------------

class CapitolWarView(discord.ui.View):
    PRESET_LABELS = {
        'this_month': 'This Month', 'last_month': 'Last Month',
        '3m': '3 Months', '1y': '1 Year', 'all': 'All Time',
    }

    def __init__(self, data_submit, *, cog, original_user_id,
                 alliance_id: int | None = None,
                 from_date: date | None = None, to_date: date | None = None):
        super().__init__(timeout=7200)
        self.data_submit = data_submit
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.from_date = from_date
        self.to_date = to_date
        if from_date is None and to_date is None:
            self.preset: str | None = '3m'
            self._apply_preset(self.preset)
        else:
            self.preset = None
        self._build_components()

    def _apply_preset(self, preset_name: str):
        today = datetime.now(timezone.utc).date()
        if preset_name == 'this_month':
            self.from_date = today.replace(day=1)
            self.to_date = today
        elif preset_name == 'last_month':
            first_of_this = today.replace(day=1)
            last_month_end = first_of_this - timedelta(days=1)
            self.from_date = last_month_end.replace(day=1)
            self.to_date = last_month_end
        elif preset_name == '3m':
            self.from_date = today - timedelta(days=90)
            self.to_date = today
        elif preset_name == '1y':
            self.from_date = today - timedelta(days=365)
            self.to_date = today
        elif preset_name == 'all':
            self.from_date = None
            self.to_date = None
        self.preset = preset_name

    def _build_components(self):
        self.clear_items()
        options = build_alliance_options(self.cog.alliance_conn)
        for opt in options:
            opt.default = (int(opt.value) == (self.alliance_id or 0))
        self.add_item(CapitolAllianceSelect(self, options, action="view"))

        has_alliance = self.alliance_id is not None
        range_btn = discord.ui.Button(
            label=f"Time Range: {self._range_label()}",
            emoji=theme.calendarIcon,
            style=discord.ButtonStyle.secondary, row=1,
        )
        range_btn.callback = self._on_time_range
        self.add_item(range_btn)

        leaderboard_btn = discord.ui.Button(
            label="Top Players", emoji=theme.medalIcon,
            style=discord.ButtonStyle.primary, row=2, disabled=not has_alliance,
        )
        leaderboard_btn.callback = self._on_leaderboard
        self.add_item(leaderboard_btn)

        events_btn = discord.ui.Button(
            label="Events", emoji=theme.documentIcon,
            style=discord.ButtonStyle.primary, row=2, disabled=not has_alliance,
        )
        events_btn.callback = self._on_events
        self.add_item(events_btn)

        back_btn = discord.ui.Button(
            label="Back", emoji=theme.backIcon,
            style=discord.ButtonStyle.secondary, row=2,
        )
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def _range_label(self) -> str:
        if self.preset and self.preset in self.PRESET_LABELS:
            return self.PRESET_LABELS[self.preset]
        return "Custom"

    async def _on_time_range(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        view = VaultTimeRangeView(self)
        await safe_edit_message(interaction, embed=view.build_embed(), view=view,
                                content=None, clear_attachments=True)

    async def _on_events(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not self.alliance_id:
            return
        view = CapitolEventsView(
            cog=self.cog, original_user_id=self.original_user_id,
            alliance_id=self.alliance_id, chart_view=self)
        await view.open(interaction)

    async def _on_leaderboard(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not self.alliance_id:
            await interaction.response.send_message(
                f"{theme.warnIcon} Pick an alliance first.", ephemeral=True)
            return
        if not await self.cog.check_capitol_permission(interaction, self.alliance_id, "view"):
            return
        self.cog.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (self.alliance_id,))
        arow = self.cog.alliance_cursor.fetchone()
        alliance_name = arow[0] if arow else f"Alliance ID: {self.alliance_id}"
        from_str = self.from_date.strftime("%Y-%m-%d") if self.from_date else None
        to_str = self.to_date.strftime("%Y-%m-%d") if self.to_date else None
        view = CapitolLeaderboardView(
            cog=self.cog, original_user_id=self.original_user_id,
            alliance_id=self.alliance_id, alliance_name=alliance_name,
            from_date=from_str, to_date=to_str, chart_view=self)
        await interaction.response.edit_message(embed=view.build_embed(), view=view, attachments=[])

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_capitol_menu(interaction)

    async def try_redraw(self, interaction: discord.Interaction):
        if not interaction.response.is_done():
            await interaction.response.defer()
        self._build_components()
        if not self.alliance_id:
            await interaction.edit_original_response(
                embed=_capitol_viewer_embed(), attachments=[], view=self)
            return
        from_str = self.from_date.strftime("%Y-%m-%d") if self.from_date else None
        to_str = self.to_date.strftime("%Y-%m-%d") if self.to_date else None
        embed, file = await self.data_submit.process_view(
            alliance_id=self.alliance_id, from_date=from_str, to_date=to_str)
        if not embed:
            empty = discord.Embed(
                title=f"{theme.warnIcon} No data for this range",
                description=(
                    "There are no recorded Capitol War events for this alliance in the "
                    "selected time range.\nTry a different preset or change the **Time Range**."
                ),
                color=theme.emColor2,
            )
            await interaction.edit_original_response(embed=empty, attachments=[], view=self)
            return
        await interaction.edit_original_response(
            embed=embed, attachments=[file] if file else [], view=self)


# ---------------------------------------------------------------------------
# CapitolEventsView -- unified Events browser, entered from the chart with an
# alliance pre-selected. Mirrors VaultDamageEditView structurally (pick an
# event -> its players show inline with a row-edit dropdown + Add Player),
# including the confirmed-delete flow. Genuinely needs its own version (not
# a generalization of VaultDamageEditView) since every method here is SQL
# against capitol_war_events/capitol_war_points, and there's no trap-number
# axis to thread through.
#
# `hunt_id` is exposed as a property (not "event_id_prop" or similar) purely
# so `_write_match_to_row`/`_fid_in_hunt` (imported from vault_track, which
# dispatch on `getattr(view, "hunt_id", None)`) recognize this as a "saved"
# view without any changes to that shared code -- see the note on
# CapitolWarReviewView above for the same convention.
# ---------------------------------------------------------------------------

class CapitolEventsView(discord.ui.View):
    PLAYER_PAGE = 20
    EVENT_PAGE = 25

    def __init__(self, cog, original_user_id, alliance_id=None, chart_view=None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.chart_view = chart_view
        self.alliance_id: int | None = alliance_id
        self.alliance_name: str | None = None
        self.can_manage = False
        self.roster: list = []
        self._records: list = []
        self.record_page = 0
        self.selected_record_id: int | None = None
        self.date: str | None = None
        self.event_time: str | None = None
        self.players: list = []
        self.page = 0
        self._note: str | None = None
        # Generalization hooks read by vault_track's _write_match_to_row/
        # _fid_in_hunt -- see class docstring.
        self.player_table = "capitol_war_points"
        self.event_fk_col = "event_id"
        self.value_col = "points"
        self.db_cursor = cog.capitol_cursor
        self.db_conn = cog.capitol_conn

    @property
    def hunt_id(self):
        return self.selected_record_id

    async def open(self, interaction: discord.Interaction):
        if self.alliance_id is not None:
            self.can_manage = self.cog.can_manage_capitol(interaction, self.alliance_id)
            self.roster = self.cog.get_alliance_roster(self.alliance_id)
            try:
                self.cog.alliance_cursor.execute(
                    "SELECT name FROM alliance_list WHERE alliance_id = ?", (self.alliance_id,))
                arow = self.cog.alliance_cursor.fetchone()
                self.alliance_name = arow[0] if arow else None
            except Exception as e:
                logger.warning(f"Capitol War events view: could not resolve alliance name: {e}")
                self.alliance_name = None
            self._load_records()
        self._build_components()
        await safe_edit_message(
            interaction, embed=self.build_record_embed(), view=self,
            content=None, clear_attachments=True)

    def _load_records(self):
        try:
            self._records = self.cog.capitol_cursor.execute(
                "SELECT id, date FROM capitol_war_events WHERE alliance_id = ? ORDER BY date DESC",
                (self.alliance_id,)).fetchall()
        except Exception as e:
            logger.error(f"Failed to fetch Capitol War records: {e}")
            self._records = []
        self.record_page = min(self.record_page, max(0, (len(self._records) - 1) // self.EVENT_PAGE))
        self._sync_record_page()

    def _sync_record_page(self):
        if self.selected_record_id is None:
            return
        idx = next((i for i, r in enumerate(self._records) if r[0] == self.selected_record_id), None)
        if idx is not None:
            self.record_page = idx // self.EVENT_PAGE

    def _total_record_pages(self) -> int:
        return max(1, -(-len(self._records) // self.EVENT_PAGE))

    def _load_players(self):
        if not self.selected_record_id:
            self.players = []
            return
        try:
            rows = self.cog.capitol_cursor.execute(
                "SELECT id, fid, raw_name, resolved_nickname, points, rank "
                "FROM capitol_war_points WHERE event_id = ? "
                # Points-descending, not rank -- same reasoning as
                # CapitolWarReviewView._sort_rows: a saved event's rank
                # column can carry the same short-token OCR misreads the
                # review screen does, so ordering by it here would surface
                # the identical "duplicating/out of order" symptom for
                # already-submitted records.
                "ORDER BY points DESC",
                (self.selected_record_id,)).fetchall()
        except Exception as e:
            logger.error(f"Failed to load Capitol War players: {e}")
            rows = []
        self.players = [
            {'id': r[0], 'fid': r[1], 'raw_name': r[2] or '', 'nickname': r[3],
             'damage': int(r[4]), 'rank': r[5]}
            for r in rows]
        self.page = min(self.page, max(0, (len(self.players) - 1) // self.PLAYER_PAGE))

    def _select_record(self, rid: int):
        self.selected_record_id = rid
        row = self.cog.capitol_cursor.execute(
            "SELECT date, event_time FROM capitol_war_events WHERE id = ?", (rid,)).fetchone()
        if row:
            self.date, self.event_time = row
        self.page = 0
        self._load_players()

    def _player_counts(self) -> tuple[int, int]:
        matched = sum(1 for p in self.players if p['fid'])
        return matched, len(self.players) - matched

    def _total_player_pages(self) -> int:
        return max(1, -(-len(self.players) // self.PLAYER_PAGE))

    def build_record_embed(self) -> discord.Embed:
        if not self.selected_record_id:
            desc = (
                "Pick an event from the dropdown to view its players."
                if self._records else
                ("*No Capitol War events recorded for this alliance yet.*" if self.alliance_id
                 else "Pick an alliance first.")
            )
            embed = discord.Embed(title=f"{theme.documentIcon} Events", description=desc, color=theme.emColor1)
            total_record_pages = self._total_record_pages()
            if self._records and total_record_pages > 1:
                embed.set_footer(text=f"page {self.record_page + 1}/{total_record_pages}")
            return embed

        parts = []
        if self._note:
            parts.append(self._note)
            self._note = None
        if self.can_manage and self.players:
            parts.append(
                "*Select a player to edit in the drop-down; "
                "clear the name to delete the row.*"
            )
        if self.can_manage:
            _, unmatched = self._player_counts()
            bits = [
                f"{theme.addIcon} **Add Player**\n"
                f"└ Manually add a player row to this event.",
                f"{theme.editListIcon} **Edit Event**\n"
                f"└ Update the date or time.",
            ]
            if unmatched:
                bits.append(
                    f"{theme.refreshIcon} **Re-match**\n"
                    f"└ Re-match against the current roster after adding new members."
                )
            bits.append(
                f"{theme.trashIcon} **Delete Event**\n"
                f"└ Permanently delete this event and all its rows."
            )
            parts.append("\n".join(bits))

        embed = discord.Embed(
            title=f"{theme.documentIcon} Capitol War",
            description="\n\n".join(parts) if parts else None,
            color=theme.emColor1,
        )
        embed.add_field(name="Alliance", value=self.alliance_name or f"ID {self.alliance_id}", inline=False)
        embed.add_field(name="Date", value=self.date or "-", inline=True)
        if self.event_time:
            embed.add_field(name="Time (UTC)", value=self.event_time, inline=True)
        embed.add_field(
            name="Alliance Total Points",
            value=format_damage_for_embed(sum(p['damage'] for p in self.players)) if self.players else "-",
            inline=True,
        )

        if not self.players:
            embed.add_field(name="Players", value="*No player rows on this event.*", inline=False)
            return embed

        start = self.page * self.PLAYER_PAGE
        end = min(start + self.PLAYER_PAGE, len(self.players))
        lines = []
        for p in self.players[start:end]:
            rank_str = f"**#{p['rank']}**" if p['rank'] is not None else "**?**"
            if p['fid']:
                who = f"`{_isolate_rtl(p['nickname'] or str(p['fid']))}` · `{p['fid']}`"
            else:
                who = f"{theme.warnIcon} `{_isolate_rtl(p['raw_name'] or '(unreadable)')}` — unmatched"
            lines.append(_ltr_line(f"{rank_str} {who} — `{format_damage_for_embed(p['damage'])}`"))

        total_pages = self._total_player_pages()
        field_name = (
            f"Players {start + 1}-{end} of {len(self.players)}"
            if total_pages > 1 else f"Players ({len(self.players)})"
        )
        add_paginated_field(embed, field_name, lines)

        matched, unmatched = self._player_counts()
        foot_bits = [f"{matched} matched"]
        if unmatched:
            foot_bits.append(f"{unmatched} unmatched")
        if total_pages > 1:
            foot_bits.append(f"players page {self.page + 1}/{total_pages}")
        total_record_pages = self._total_record_pages()
        if total_record_pages > 1:
            foot_bits.append(f"events page {self.record_page + 1}/{total_record_pages}")
        embed.set_footer(text=" · ".join(foot_bits))
        return embed

    def _build_components(self):
        self.clear_items()
        total_record_pages = self._total_record_pages()
        if self._records:
            rstart = self.record_page * self.EVENT_PAGE
            rend = min(rstart + self.EVENT_PAGE, len(self._records))
            placeholder = "Select an event"
            if total_record_pages > 1:
                placeholder += f" (page {self.record_page + 1}/{total_record_pages})"
            self.date_select = discord.ui.Select(
                placeholder=placeholder, row=0,
                options=[discord.SelectOption(
                    label=f"{dt}", value=str(rid),
                    default=(self.selected_record_id == rid))
                    for rid, dt in self._records[rstart:rend]])
        else:
            self.date_select = discord.ui.Select(
                placeholder=("No events for this alliance" if self.alliance_id else "No alliance selected"),
                disabled=True, row=0,
                options=[discord.SelectOption(label="—", value="__placeholder__")])
        self.date_select.callback = self.date_selected
        self.add_item(self.date_select)

        if total_record_pages > 1:
            rec_prev_btn = discord.ui.Button(label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary, row=1, disabled=(self.record_page == 0))
            rec_prev_btn.callback = self._on_record_prev
            rec_next_btn = discord.ui.Button(label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary, row=1,
                disabled=(self.record_page >= total_record_pages - 1))
            rec_next_btn.callback = self._on_record_next
            self.add_item(rec_prev_btn)
            self.add_item(rec_next_btn)

        has_event = bool(self.selected_record_id)
        if has_event and self.players and self.can_manage:
            start = self.page * self.PLAYER_PAGE
            end = min(start + self.PLAYER_PAGE, len(self.players))
            opts = []
            for i, p in enumerate(self.players[start:end], start=start):
                rank_part = f"#{p['rank']}" if p['rank'] is not None else "#?"
                who = p['nickname'] or p['raw_name'] or "(unreadable)"
                opts.append(discord.SelectOption(
                    label=_ltr_line(f"{rank_part} {who}")[:100], value=str(i),
                    description=format_damage_for_embed(p['damage'])[:100]))
            sel = discord.ui.Select(placeholder="Edit a player row…", options=opts, row=2)
            sel.callback = self._on_row_selected
            self.add_item(sel)

        if has_event and self.can_manage:
            add_btn = discord.ui.Button(label="Add Player", emoji=theme.addIcon,
                                        style=discord.ButtonStyle.success, row=3)
            add_btn.callback = self._on_add
            self.add_item(add_btn)
            edit_btn = discord.ui.Button(label="Edit Event", emoji=theme.editListIcon,
                                         style=discord.ButtonStyle.primary, row=3)
            edit_btn.callback = self._on_edit_event
            self.add_item(edit_btn)
            _, unmatched = self._player_counts()
            if unmatched:
                rematch_btn = discord.ui.Button(label="Re-match", emoji=theme.refreshIcon,
                                                style=discord.ButtonStyle.secondary, row=3)
                rematch_btn.callback = self._on_rematch
                self.add_item(rematch_btn)

        if has_event and self.can_manage:
            delete_btn = discord.ui.Button(label="Delete Event", emoji=theme.trashIcon,
                                           style=discord.ButtonStyle.danger, row=4)
            delete_btn.callback = self._on_delete
            self.add_item(delete_btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=4)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

        if has_event and self._total_player_pages() > 1:
            prev_btn = discord.ui.Button(label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary, row=4, disabled=(self.page == 0))
            prev_btn.callback = self._on_prev
            next_btn = discord.ui.Button(label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary, row=4,
                disabled=(self.page >= self._total_player_pages() - 1))
            next_btn.callback = self._on_next
            self.add_item(prev_btn)
            self.add_item(next_btn)

    async def date_selected(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        selected_value = self.date_select.values[0]
        if selected_value in ("__placeholder__", "__none__"):
            return
        self._select_record(int(selected_value))
        self._build_components()
        await interaction.response.edit_message(content=None, view=self, embed=self.build_record_embed())

    async def refresh(self, interaction: discord.Interaction):
        self._load_players()
        self._build_components()
        await safe_edit_message(interaction, embed=self.build_record_embed(), view=self, content=None)

    async def rerender(self, interaction: discord.Interaction):
        self._load_players()
        self._build_components()
        await safe_edit_message(interaction, embed=self.build_record_embed(), view=self, content=None)

    async def reapply_to_message(self, message):
        self._load_players()
        self._build_components()
        try:
            await message.edit(embed=self.build_record_embed(), view=self)
        except discord.HTTPException:
            pass

    async def _on_row_selected(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        idx = int(interaction.data['values'][0])
        if idx >= len(self.players):
            await interaction.response.send_message(
                f"{theme.deniedIcon} That row no longer exists.", ephemeral=True)
            return
        await interaction.response.send_modal(EditSavedCapitolPlayerModal(self, self.players[idx]))

    async def _on_add(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.selected_record_id and self.can_manage):
            return
        await interaction.response.send_modal(AddSavedCapitolPlayerModal(self))

    async def _on_prev(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = max(0, self.page - 1)
        self._build_components()
        await interaction.response.edit_message(view=self, embed=self.build_record_embed())

    async def _on_next(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = min(self._total_player_pages() - 1, self.page + 1)
        self._build_components()
        await interaction.response.edit_message(view=self, embed=self.build_record_embed())

    async def _on_record_prev(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.record_page = max(0, self.record_page - 1)
        self._build_components()
        await interaction.response.edit_message(view=self, embed=self.build_record_embed())

    async def _on_record_next(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.record_page = min(self._total_record_pages() - 1, self.record_page + 1)
        self._build_components()
        await interaction.response.edit_message(view=self, embed=self.build_record_embed())

    async def _on_edit_event(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.alliance_id and self.selected_record_id and self.can_manage):
            return
        await interaction.response.send_modal(RecordEditCapitolModal(self))

    def _do_rematch(self) -> int:
        self.roster = self.cog.get_alliance_roster(self.alliance_id)
        cur = self.cog.capitol_cursor
        cur.execute(
            "SELECT id, raw_name FROM capitol_war_points WHERE event_id = ? AND fid IS NULL",
            (self.selected_record_id,))
        unmatched_rows = [{'id': r[0], 'raw_name': r[1] or ''} for r in cur.fetchall()]
        if not unmatched_rows:
            return 0
        cur.execute(
            "SELECT fid FROM capitol_war_points WHERE event_id = ? AND fid IS NOT NULL",
            (self.selected_record_id,))
        assigned_fids = {row[0] for row in cur.fetchall()}

        candidates = []
        for idx, row in enumerate(unmatched_rows):
            for fid, nick, score in resolve_against_capitol_roster(
                    row['raw_name'], self.roster, self.alliance_id):
                candidates.append((score, idx, fid, nick))
        candidates.sort(key=lambda c: (-c[0], c[1]))

        assignments: dict = {}
        for score, idx, fid, nick in candidates:
            if score < MATCH_AUTO_CONFIRM or idx in assignments or fid in assigned_fids:
                continue
            assignments[idx] = (fid, nick, score)
            assigned_fids.add(fid)
        if not assignments:
            return 0
        for idx, (fid, nick, score) in assignments.items():
            cur.execute(
                "UPDATE capitol_war_points SET fid = ?, resolved_nickname = ?, match_score = ? WHERE id = ?",
                (fid, nick, score, unmatched_rows[idx]['id']))
        self.cog.capitol_conn.commit()
        return len(assignments)

    async def _on_rematch(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.alliance_id and self.selected_record_id and self.can_manage):
            return
        resolved = self._do_rematch()
        if resolved:
            self._note = f"{theme.verifiedIcon} Re-matched {resolved} row(s) against the roster."
        else:
            self._note = f"{theme.warnIcon} No new confident matches. Edit unmatched rows individually."
        await self.refresh(interaction)

    async def _on_delete(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.alliance_id and self.selected_record_id and self.can_manage):
            return
        try:
            row = self.cog.capitol_cursor.execute(
                "SELECT COUNT(*) FROM capitol_war_points WHERE event_id = ?",
                (self.selected_record_id,)).fetchone()
            player_count = row[0] if row else 0
        except Exception as e:
            logger.error(f"Failed to count Capitol War player rows before delete: {e}")
            player_count = len(self.players)

        embed = discord.Embed(
            title=f"{theme.warnIcon} Delete Event",
            description=(
                f"Are you sure you want to delete the **{self.date or '-'}** Capitol War "
                f"event for **{self.alliance_name or f'ID {self.alliance_id}'}**?\n\n"
                f"{theme.warnIcon} This permanently deletes:\n"
                f"- **{player_count}** player row(s)\n\n"
                f"This action cannot be undone."
            ),
            color=theme.emColor2,
        )
        await interaction.response.edit_message(
            content=None, embed=embed, view=CapitolDeleteEventConfirmView(self))

    async def _do_delete(self, interaction: discord.Interaction):
        """Actually performs the delete. Only reached via the Confirm button
        on CapitolDeleteEventConfirmView."""
        try:
            # FK cascade is off (pragma never set anywhere in this codebase),
            # so clear child rows explicitly -- mirrors VaultDamageEditView.
            self.cog.capitol_cursor.execute(
                "DELETE FROM capitol_war_points WHERE event_id = ?", (self.selected_record_id,))
            self.cog.capitol_cursor.execute(
                "DELETE FROM capitol_war_events WHERE id = ?", (self.selected_record_id,))
            self.cog.capitol_conn.commit()
        except Exception as e:
            logger.error(f"Failed to delete Capitol War event: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to delete event.", ephemeral=True)
            return
        self.selected_record_id = None
        self.date = self.event_time = None
        self.players = []
        self._load_records()
        self._build_components()
        await interaction.response.edit_message(content=None, view=self, embed=self.build_record_embed())

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if self.chart_view is not None:
            self.chart_view.alliance_id = self.alliance_id
            self.chart_view._build_components()
            await self.chart_view.try_redraw(interaction)
        else:
            await self.cog.show_capitol_menu(interaction)


class CapitolDeleteEventConfirmView(discord.ui.View):
    """Are-you-sure prompt before an event (and its player rows) is
    permanently deleted. Mirrors VaultDeleteHuntConfirmView exactly."""

    def __init__(self, parent_view: CapitolEventsView):
        super().__init__(timeout=7200)
        self.parent_view = parent_view

    @discord.ui.button(label="Confirm Delete", style=discord.ButtonStyle.danger, emoji=f"{theme.trashIcon}")
    async def confirm_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        pv = self.parent_view
        if not await check_interaction_user(interaction, pv.original_user_id):
            return
        if not (pv.alliance_id and pv.selected_record_id and pv.can_manage):
            return
        await pv._do_delete(interaction)

    @discord.ui.button(label="Cancel", style=discord.ButtonStyle.secondary, emoji=f"{theme.deniedIcon}")
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        pv = self.parent_view
        if not await check_interaction_user(interaction, pv.original_user_id):
            return
        pv._build_components()
        await interaction.response.edit_message(content=None, view=pv, embed=pv.build_record_embed())


class RecordEditCapitolModal(discord.ui.Modal):
    """Modal for editing an existing Capitol War event's date/time."""

    def __init__(self, parent_view: CapitolEventsView):
        super().__init__(title="Edit Capitol War Event")
        self.parent_view = parent_view
        self.date_input = discord.ui.TextInput(label="Date", default=parent_view.date or "")
        self.time_input = discord.ui.TextInput(
            label="Time (UTC, optional) - HH:MM", default=parent_view.event_time or "", required=False)
        self.add_item(self.date_input)
        self.add_item(self.time_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            dt = datetime.strptime(self.date_input.value, "%Y-%m-%d")
            new_date = dt.strftime("%Y-%m-%d")
        except Exception:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Date must be in YYYY-MM-DD format.", ephemeral=True)
            return
        try:
            new_time = _normalize_event_time(self.time_input.value)
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Time must be HH:MM (24-hour UTC), or blank.", ephemeral=True)
            return

        try:
            self.parent_view.cog.capitol_cursor.execute(
                "UPDATE capitol_war_events SET date = ?, event_time = ? WHERE id = ?",
                (new_date, new_time, self.parent_view.selected_record_id))
            self.parent_view.cog.capitol_conn.commit()
        except sqlite3.IntegrityError:
            self.parent_view.cog.capitol_conn.rollback()
            await interaction.response.send_message(
                f"{theme.warnIcon} This alliance already has a Capitol War event recorded for "
                f"that date. Pick a different date, or edit the other existing event instead.",
                ephemeral=True)
            return
        except Exception as e:
            logger.error(f"Failed to update Capitol War event: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save event.", ephemeral=True)
            return

        self.parent_view.date = new_date
        self.parent_view.event_time = new_time
        self.parent_view._load_records()
        self.parent_view._build_components()
        await interaction.response.edit_message(embed=self.parent_view.build_record_embed(), view=self.parent_view)


class EditSavedCapitolPlayerModal(discord.ui.Modal):
    """Edit a saved player row (player / points / rank). Blank player deletes it."""

    def __init__(self, parent_view: CapitolEventsView, row: dict):
        super().__init__(title=f"Edit Player · {format_damage_for_embed(row['damage'])}"[:45])
        self.parent_view = parent_view
        self.row = row
        self.player_input = discord.ui.TextInput(
            label="Player (ID or name — blank to delete)",
            default=(row['nickname'] or row['raw_name'] or ''), required=False, max_length=80)
        self.points_input = discord.ui.TextInput(
            label="Points", default=format_damage_for_embed(row['damage']), required=True, max_length=30)
        self.rank_input = discord.ui.TextInput(
            label="Rank (optional)",
            default=str(row['rank']) if row['rank'] is not None else "", required=False, max_length=3)
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)", required=False, max_length=80)
        self.add_item(self.player_input)
        self.add_item(self.points_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction: discord.Interaction):
        cur = self.parent_view.cog.capitol_cursor
        conn = self.parent_view.cog.capitol_conn
        if not self.player_input.value.strip():
            try:
                cur.execute("DELETE FROM capitol_war_points WHERE id = ?", (self.row['id'],))
                conn.commit()
            except Exception as e:
                conn.rollback()
                logger.error(f"Failed to delete Capitol War player row {self.row['id']}: {e}")
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Failed to delete row.", ephemeral=True)
                return
            await self.parent_view.refresh(interaction)
            return
        points = parse_points(self.points_input.value)
        if points <= 0:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid points value.", ephemeral=True)
            return
        rank = None
        rc = self.rank_input.value.strip()
        if rc:
            try:
                rank = int(rc)
            except ValueError:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Rank must be a whole number.", ephemeral=True)
                return
        await _resolve_and_apply(
            interaction, self.parent_view, row_id=self.row['id'],
            text=self.player_input.value, damage=points, rank=rank,
            raw_name=self.row.get('raw_name'),
            current_fid=self.row.get('fid'),
            current_name=self.row.get('nickname') or self.row.get('raw_name'),
            new_name=self.new_name_input.value,
            entity_label="event", row_label="Capitol War row",
        )


class AddSavedCapitolPlayerModal(discord.ui.Modal):
    """Add a player row to a saved event (for players OCR missed entirely)."""

    def __init__(self, parent_view: CapitolEventsView):
        super().__init__(title="Add Player")
        self.parent_view = parent_view
        self.player_input = discord.ui.TextInput(label="Player (ID or name)", required=True, max_length=80)
        self.points_input = discord.ui.TextInput(label="Points", required=True, max_length=30)
        self.rank_input = discord.ui.TextInput(label="Rank (optional)", required=False, max_length=3)
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)", required=False, max_length=80)
        self.add_item(self.player_input)
        self.add_item(self.points_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction: discord.Interaction):
        text = self.player_input.value.strip()
        if not text:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Player is required.", ephemeral=True)
            return
        points = parse_points(self.points_input.value)
        if points <= 0:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid points value.", ephemeral=True)
            return
        rank = None
        rc = self.rank_input.value.strip()
        if rc:
            try:
                rank = int(rc)
            except ValueError:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Rank must be a whole number.", ephemeral=True)
                return
        await _resolve_and_apply(
            interaction, self.parent_view, row_id=None,
            text=text, damage=points, rank=rank, raw_name=text,
            new_name=self.new_name_input.value,
            entity_label="event", row_label="Capitol War row",
        )


# ---------------------------------------------------------------------------
# Aggregate helpers -- mirror vault_track's _aggregate_leaderboard /
# _fetch_player_damage_series, but genuinely need their own version: no
# trap_number filter/axis, and the column is capitol_war_points.points.
# ---------------------------------------------------------------------------

def _aggregate_capitol_leaderboard(cur, *, alliance_id, from_date, to_date, active_fids=None):
    sql = (
        "SELECT cwp.fid, MAX(cwp.resolved_nickname), COUNT(*), "
        "SUM(cwp.points), AVG(cwp.points) "
        "FROM capitol_war_points cwp JOIN capitol_war_events cwe ON cwe.id = cwp.event_id "
        "WHERE cwe.alliance_id = ? AND cwp.fid IS NOT NULL"
    )
    params: list = [alliance_id]
    if from_date:
        sql += " AND cwe.date >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND cwe.date <= ?"
        params.append(to_date)
    if active_fids is not None:
        active_fids = list(active_fids)
        if not active_fids:
            return []
        placeholders = ",".join("?" * len(active_fids))
        sql += f" AND cwp.fid IN ({placeholders})"
        params.extend(active_fids)
    sql += " GROUP BY cwp.fid ORDER BY SUM(cwp.points) DESC"
    cur.execute(sql, params)
    return [
        {'fid': r[0], 'nickname': r[1] or str(r[0]), 'events': int(r[2]),
         'total': int(r[3]), 'avg': int(r[4])}
        for r in cur.fetchall()
    ]


def _fetch_capitol_points_series(cur, *, alliance_id, fid, from_date, to_date):
    sql = (
        "SELECT cwe.date, cwp.points, cwp.rank "
        "FROM capitol_war_points cwp JOIN capitol_war_events cwe ON cwe.id = cwp.event_id "
        "WHERE cwe.alliance_id = ? AND cwp.fid = ?"
    )
    params: list = [alliance_id, fid]
    if from_date:
        sql += " AND cwe.date >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND cwe.date <= ?"
        params.append(to_date)
    sql += " ORDER BY cwe.date ASC"
    cur.execute(sql, params)
    return cur.fetchall()


# ---------------------------------------------------------------------------
# CapitolLeaderboardView -- mirrors VaultLeaderboardView, minus the
# trap_number label.
# ---------------------------------------------------------------------------

class CapitolLeaderboardView(discord.ui.View):
    PAGE_SIZE = 15
    SORT_LABELS = {'total': 'Total Points', 'events': 'Events Attended', 'avg': 'Average Points'}

    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name,
                 from_date, to_date, chart_view=None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.from_date = from_date
        self.to_date = to_date
        self.chart_view = chart_view
        self.page = 0
        self.sort_mode = 'total'
        active_fids = {fid for fid, _ in cog.get_alliance_roster(alliance_id, active_only=True)}
        self.entries = _aggregate_capitol_leaderboard(
            cog.capitol_cursor, alliance_id=alliance_id,
            from_date=from_date, to_date=to_date, active_fids=active_fids)
        self._apply_sort()
        self._build_components()

    def _apply_sort(self):
        key = {'total': lambda e: e['total'], 'events': lambda e: e['events'],
               'avg': lambda e: e['avg']}[self.sort_mode]
        self.entries.sort(key=key, reverse=True)

    def _total_pages(self) -> int:
        return max(1, -(-len(self.entries) // self.PAGE_SIZE))

    def build_embed(self) -> discord.Embed:
        rng = f"{self.from_date} → {self.to_date}" if (self.from_date and self.to_date) else "All time"
        embed = discord.Embed(
            title=f"{theme.medalIcon} Top Players · {self.alliance_name} · Capitol War",
            color=theme.emColor1)
        if not self.entries:
            embed.description = "*No matched player points in this range.*"
            embed.set_footer(text=rng)
            return embed
        start = self.page * self.PAGE_SIZE
        end = min(start + self.PAGE_SIZE, len(self.entries))
        lines = []
        for i, e in enumerate(self.entries[start:end], start=start + 1):
            lines.append(_ltr_line(
                f"`#{i}` {_isolate_rtl(e['nickname'])} — `{format_damage_for_embed(e['total'])}` "
                f"· {e['events']} event(s) · avg `{format_damage_for_embed(e['avg'])}`"))
        embed.description = "\n".join(lines)
        foot = f"Sorted by {self.SORT_LABELS[self.sort_mode]} · {rng}"
        if self._total_pages() > 1:
            foot += f" · page {self.page + 1}/{self._total_pages()}"
        embed.set_footer(text=foot)
        return embed

    def _build_components(self):
        self.clear_items()
        if self.entries:
            start = self.page * self.PAGE_SIZE
            end = min(start + self.PAGE_SIZE, len(self.entries))
            opts = []
            for e in self.entries[start:end]:
                opts.append(discord.SelectOption(
                    label=_ltr_line(e['nickname'])[:100], value=str(e['fid']),
                    description=f"ID {e['fid']} · {format_damage_for_embed(e['total'])} total · {e['events']} events"[:100]))
            sel = discord.ui.Select(placeholder="View a player's history…", options=opts, row=0)
            sel.callback = self._on_player_selected
            self.add_item(sel)
        total_pages = self._total_pages()
        if total_pages > 1:
            prev_btn = discord.ui.Button(label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary, row=1, disabled=(self.page == 0))
            prev_btn.callback = self._on_prev
            page_lbl = discord.ui.Button(label=f"Page {self.page + 1}/{total_pages}",
                style=discord.ButtonStyle.secondary, row=1, disabled=True)
            next_btn = discord.ui.Button(label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary, row=1,
                disabled=(self.page >= total_pages - 1))
            next_btn.callback = self._on_next
            self.add_item(prev_btn)
            self.add_item(page_lbl)
            self.add_item(next_btn)
        for mode, label in (('total', "Sort: Total"), ('events', "Sort: Events"), ('avg', "Sort: Average")):
            btn = discord.ui.Button(
                label=label, row=2,
                style=(discord.ButtonStyle.success if self.sort_mode == mode
                       else discord.ButtonStyle.secondary))
            btn.callback = self._make_sort_cb(mode)
            self.add_item(btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=3)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def _make_sort_cb(self, mode):
        async def _cb(interaction: discord.Interaction):
            if not await check_interaction_user(interaction, self.original_user_id):
                return
            if self.sort_mode == mode:
                await interaction.response.defer()
                return
            self.sort_mode = mode
            self.page = 0
            self._apply_sort()
            self._build_components()
            await interaction.response.edit_message(embed=self.build_embed(), view=self)
        return _cb

    async def _on_player_selected(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        fid = int(interaction.data['values'][0])
        view = CapitolPlayerHistoryView(
            cog=self.cog, original_user_id=self.original_user_id,
            alliance_id=self.alliance_id, alliance_name=self.alliance_name,
            fid=fid, parent_view=self)
        await view.render(interaction)

    async def _on_prev(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = max(0, self.page - 1)
        self._build_components()
        await interaction.response.edit_message(embed=self.build_embed(), view=self)

    async def _on_next(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = min(self._total_pages() - 1, self.page + 1)
        self._build_components()
        await interaction.response.edit_message(embed=self.build_embed(), view=self)

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if self.chart_view is not None:
            await self.chart_view.try_redraw(interaction)
        else:
            await self.cog.show_capitol_menu(interaction)


# ---------------------------------------------------------------------------
# CapitolPlayerHistoryView -- mirrors PlayerHistoryView, minus the trap
# filter (Capitol War has one series only, no per-trap split).
# ---------------------------------------------------------------------------

class CapitolPlayerHistoryView(discord.ui.View):
    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name, fid, parent_view):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.fid = fid
        self.parent_view = parent_view
        self.nickname = str(fid)
        self.records: list = []
        self._load()
        self._build_components()

    def _load(self):
        cur = self.cog.capitol_cursor
        sql = ("SELECT cwe.date, cwp.points, cwp.rank, cwp.resolved_nickname "
               "FROM capitol_war_points cwp JOIN capitol_war_events cwe ON cwe.id = cwp.event_id "
               "WHERE cwp.fid = ? AND cwe.alliance_id = ? ORDER BY cwe.date ASC")
        cur.execute(sql, (self.fid, self.alliance_id))
        self.records = cur.fetchall()
        if self.records:
            self.nickname = self.records[-1][3] or str(self.fid)

    def _build_components(self):
        self.clear_items()
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=0)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def build(self):
        embed = discord.Embed(
            title=f"{theme.chartIcon} {_isolate_rtl(self.nickname)} · Capitol War History",
            color=theme.emColor1)
        if not self.records:
            embed.description = "*No recorded Capitol War events for this player.*"
            return embed, None
        lines = []
        prev = None
        for dt, pts, rank, _ in self.records:
            rank_str = f"#{rank}" if rank is not None else "#?"
            delta = ""
            if prev:
                pct = (pts - prev) / prev * 100.0 if prev else 0
                delta = f"  {_format_delta_pct(pct)}"
            prev = pts
            lines.append(_ltr_line(f"`{dt}` · {rank_str} — `{format_damage_for_embed(pts)}`{delta}"))
        embed.description = "\n".join(lines[-25:])
        values = [int(r[1]) for r in self.records]
        total = sum(values)
        avg = total // len(values)
        embed.set_footer(
            text=f"{len(self.records)} event(s) · total {format_damage_for_embed(total)} "
                 f"· avg {format_damage_for_embed(avg)}")
        dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in self.records]
        file = _render_damage_chart(
            dates, values, title=f"{self.nickname} Points Over Time", ylabel="Points")
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        return embed, file

    async def render(self, interaction: discord.Interaction):
        if not interaction.response.is_done():
            await interaction.response.defer()
        embed, file = await asyncio.to_thread(self.build)
        await interaction.edit_original_response(
            embed=embed, view=self, attachments=[file] if file else [])

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.parent_view._build_components()
        await interaction.response.edit_message(
            embed=self.parent_view.build_embed(), view=self.parent_view, attachments=[])


# ---------------------------------------------------------------------------
# CapitolCompareView -- multi-player points comparison (/capitol_compare).
# Mirrors VaultCompareView exactly (paginated multi-select, MAX_PLAYERS=8,
# Select All Active/Total with top-8 truncation, Time Range presets). The
# preset/date-range picker (VaultCompareTimeRangeView) and the custom-range
# modal (VaultCompareDateRangeModal) are imported and reused completely
# unmodified: VaultCompareTimeRangeView reads `type(self.compare).PRESETS`
# (generalized for exactly this reuse -- see vault_track.py) rather than a
# hardcoded class, and VaultCompareDateRangeModal only ever touches
# `compare_view.from_date/to_date/preset/_build_components/
# build_picker_embed`, none of which are Vault-Trap-specific.
# ---------------------------------------------------------------------------

class CapitolCompareView(discord.ui.View):
    PAGE_SIZE = 25
    MAX_PLAYERS = 8
    PRESETS = [('1w', '1 Week'), ('1m', '1 Month'), ('3m', '3 Months')]

    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name, from_date, to_date):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.from_date = from_date
        self.to_date = to_date
        self.preset: str | None = None
        self.page = 0
        self.selected_fids: list = []
        self.note = ""
        self.roster = sorted(
            cog.get_alliance_roster(alliance_id), key=lambda r: (r[1] or "").lower())
        self._nick_by_fid = {fid: nick for fid, nick in self.roster}
        self.max_page = max(0, (len(self.roster) - 1) // self.PAGE_SIZE) if self.roster else 0
        self._build_components()

    def _page_slice(self):
        start = self.page * self.PAGE_SIZE
        return self.roster[start:start + self.PAGE_SIZE]

    def _apply_preset(self, preset_name: str):
        today = datetime.now(timezone.utc).date()
        days = {'1w': 7, '1m': 30, '3m': 90}[preset_name]
        self.from_date = (today - timedelta(days=days)).strftime("%Y-%m-%d")
        self.to_date = today.strftime("%Y-%m-%d")
        self.preset = preset_name

    def _range_label(self) -> str:
        if self.preset:
            return dict(self.PRESETS).get(self.preset, "Custom")
        if self.from_date or self.to_date:
            return "Custom"
        return "All Time"

    def _build_components(self):
        self.clear_items()
        current = self._page_slice()
        if not current:
            select = discord.ui.Select(
                placeholder="No roster members found", row=0, disabled=True,
                options=[discord.SelectOption(label="No members", value="__none__")])
            self.add_item(select)
        else:
            options = [
                discord.SelectOption(
                    label=_ltr_line(nick or str(fid))[:100], value=str(fid),
                    description=f"ID {fid}", default=(fid in self.selected_fids))
                for fid, nick in current
            ]
            select = discord.ui.Select(
                placeholder=f"Pick players to compare… (page {self.page + 1}/{self.max_page + 1})",
                min_values=0, max_values=len(options), options=options, row=0)
            select.callback = self._on_select
            self.add_item(select)

        if self.max_page > 0:
            prev_btn = discord.ui.Button(label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary, row=1, disabled=(self.page == 0))
            prev_btn.callback = self._on_prev
            page_lbl = discord.ui.Button(label=f"Page {self.page + 1}/{self.max_page + 1}",
                style=discord.ButtonStyle.secondary, row=1, disabled=True)
            next_btn = discord.ui.Button(label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary, row=1, disabled=(self.page >= self.max_page))
            next_btn.callback = self._on_next
            self.add_item(prev_btn)
            self.add_item(page_lbl)
            self.add_item(next_btn)

        compare_btn = discord.ui.Button(
            label=f"Compare ({len(self.selected_fids)} selected)",
            style=discord.ButtonStyle.success, row=2,
            disabled=(len(self.selected_fids) < 2))
        compare_btn.callback = self._on_compare
        clear_btn = discord.ui.Button(
            label="Clear selection", style=discord.ButtonStyle.secondary, row=2,
            disabled=(not self.selected_fids))
        clear_btn.callback = self._on_clear
        self.add_item(compare_btn)
        self.add_item(clear_btn)

        range_btn = discord.ui.Button(
            label=f"Time Range: {self._range_label()}",
            emoji=theme.calendarIcon,
            style=discord.ButtonStyle.secondary, row=3,
        )
        range_btn.callback = self._on_time_range
        self.add_item(range_btn)

        select_all_active_btn = discord.ui.Button(
            label="Select All Active", emoji=theme.membersIcon,
            style=discord.ButtonStyle.secondary, row=4,
        )
        select_all_active_btn.callback = self._on_select_all_active
        self.add_item(select_all_active_btn)

        select_all_total_btn = discord.ui.Button(
            label="Select All Total", emoji=theme.totalIcon,
            style=discord.ButtonStyle.secondary, row=4,
        )
        select_all_total_btn.callback = self._on_select_all_total
        self.add_item(select_all_total_btn)

    async def _on_select_all_active(self, interaction: discord.Interaction):
        await self._select_all(interaction, active_only=True)

    async def _on_select_all_total(self, interaction: discord.Interaction):
        await self._select_all(interaction, active_only=False)

    async def _select_all(self, interaction: discord.Interaction, active_only: bool):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        candidates = self.cog.get_alliance_roster(self.alliance_id, active_only=active_only)
        self._nick_by_fid.update({fid: nick for fid, nick in candidates})

        if len(candidates) <= self.MAX_PLAYERS:
            self.selected_fids = [fid for fid, _ in candidates]
            self.note = ""
        else:
            cur = self.cog.capitol_cursor
            ranked = []
            for fid, _nick in candidates:
                rows = _fetch_capitol_points_series(
                    cur, alliance_id=self.alliance_id, fid=fid,
                    from_date=self.from_date, to_date=self.to_date)
                total = sum(int(r[1]) for r in rows) if rows else 0
                ranked.append((fid, total))
            ranked.sort(key=lambda x: x[1], reverse=True)
            self.selected_fids = [fid for fid, _ in ranked[:self.MAX_PLAYERS]]
            label = "active" if active_only else "total"
            self.note = (f"Selected the top {self.MAX_PLAYERS} of {len(candidates)} "
                        f"{label} members by points in this range.")

        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    async def _on_time_range(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        view = VaultCompareTimeRangeView(self)
        await interaction.response.edit_message(
            embed=view.build_embed(), view=view, attachments=[])

    def build_picker_embed(self) -> discord.Embed:
        rng = f"{self.from_date} → {self.to_date}" if (self.from_date and self.to_date) else "All time"
        names = ", ".join(
            _isolate_rtl(self._nick_by_fid.get(f, str(f))) for f in self.selected_fids
        ) or "*none yet*"
        embed = discord.Embed(
            title=f"{theme.chartIcon} Compare Players · {self.alliance_name}",
            description=(
                f"Pick **2–{self.MAX_PLAYERS}** players, then hit **Compare**.\n\n"
                f"**Selected:** {names}"
            ),
            color=theme.emColor1,
        )
        embed.set_footer(text=rng + (f" · {self.note}" if self.note else ""))
        return embed

    async def _on_select(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        page_fids = {fid for fid, _ in self._page_slice()}
        picked_now = {int(v) for v in interaction.data.get('values', [])}
        kept = [f for f in self.selected_fids if f not in page_fids or f in picked_now]
        for f in sorted(picked_now):
            if f not in kept:
                kept.append(f)
        if len(kept) > self.MAX_PLAYERS:
            kept = kept[:self.MAX_PLAYERS]
            self.note = f"Only the first {self.MAX_PLAYERS} selections are kept."
        else:
            self.note = ""
        self.selected_fids = kept
        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    async def _on_prev(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = max(0, self.page - 1)
        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    async def _on_next(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.page = min(self.max_page, self.page + 1)
        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    async def _on_clear(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.selected_fids = []
        self.note = ""
        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    async def _on_compare(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if len(self.selected_fids) < 2:
            await interaction.response.defer()
            return
        await interaction.response.defer()
        embed, file = await asyncio.to_thread(self.build_comparison)
        self._build_back_component()
        await interaction.edit_original_response(
            embed=embed, view=self, attachments=[file] if file else [])

    def _build_back_component(self):
        self.clear_items()
        back_btn = discord.ui.Button(label="Change players", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=0)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self._build_components()
        await interaction.response.edit_message(
            embed=self.build_picker_embed(), view=self, attachments=[])

    def build_comparison(self):
        cur = self.cog.capitol_cursor
        stats = []
        series = []
        for fid in self.selected_fids:
            rows = _fetch_capitol_points_series(
                cur, alliance_id=self.alliance_id, fid=fid,
                from_date=self.from_date, to_date=self.to_date)
            nick = self._nick_by_fid.get(fid, str(fid))
            if not rows:
                stats.append({'fid': fid, 'nickname': nick, 'events': 0, 'total': 0,
                             'avg': 0, 'best_rank': None})
                continue
            dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in rows]
            points = [int(r[1]) for r in rows]
            ranks = [int(r[2]) for r in rows if r[2] is not None]
            total = sum(points)
            events = len(points)
            stats.append({
                'fid': fid, 'nickname': nick, 'events': events, 'total': total,
                'avg': total // events if events else 0,
                'best_rank': min(ranks) if ranks else None,
            })
            series.append((_reshape_for_chart(nick), dates, points))

        rng = f"{self.from_date} → {self.to_date}" if (self.from_date and self.to_date) else "All time"
        embed = discord.Embed(
            title=f"{theme.chartIcon} Player Comparison · {self.alliance_name}",
            color=theme.emColor1,
        )
        lines = []
        for s in stats:
            best_rank = f"#{s['best_rank']}" if s['best_rank'] is not None else "—"
            lines.append(_ltr_line(
                f"**{_isolate_rtl(s['nickname'])}** — total `{format_damage_for_embed(s['total'])}` "
                f"· avg `{format_damage_for_embed(s['avg'])}` · {s['events']} event(s) · best rank {best_rank}"
            ))
        embed.description = "\n".join(lines) if lines else "*No data for the selected players.*"
        embed.set_footer(text=rng)

        file = _render_damage_chart(
            None, None, series=series,
            title=f"Points Comparison · {self.alliance_name}", ylabel="Points")
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        return embed, file


def capitol_player_history_embed(*, alliance_name: str, fid: int, nickname: str, rows: list):
    """Build an embed + chart for a single player's Capitol War history.
    `rows` is an iterable of `(date_str, points, rank)` ordered by date
    ascending. Mirrors vault_track.vault_player_history_embed, minus the
    trap_number filter Capitol War doesn't have. Returns (embed, discord.File|None)."""
    discord_nick = _ltr_line(nickname)
    chart_nick = _reshape_for_chart(nickname)
    if not rows:
        embed = discord.Embed(
            title=f"{discord_nick} · Capitol War History",
            description=f"No point records for ID `{fid}` in {alliance_name}.",
            color=theme.emColor2,
        )
        return embed, None

    dates = [datetime.strptime(d, "%Y-%m-%d") for d, _, _ in rows]
    points_vals = [int(p) for _, p, _ in rows]
    ranks = [int(r) if r is not None else None for _, _, r in rows]

    total_events = len(rows)
    total_pts = sum(points_vals)
    avg_pts = int(total_pts / total_events)
    max_pts = max(points_vals)
    best_rank = min((r for r in ranks if r is not None), default=None)
    last_date, last_pts, last_rank = dates[-1], points_vals[-1], ranks[-1]

    embed = discord.Embed(title=f"{discord_nick} · Capitol War History", color=theme.emColor1)
    embed.add_field(name="Alliance", value=alliance_name, inline=True)
    embed.add_field(name="ID", value=str(fid), inline=True)
    embed.add_field(name="Events Attended", value=str(total_events), inline=True)
    embed.add_field(name="Average Points", value=f"{avg_pts:,}", inline=True)
    embed.add_field(name="Best Points", value=f"{max_pts:,}", inline=True)
    embed.add_field(
        name="Best Rank", value=f"#{best_rank}" if best_rank is not None else "—", inline=True)
    embed.add_field(
        name="Most Recent",
        value=f"{last_date:%Y-%m-%d} — `{last_pts:,}`" + (f" (#{last_rank})" if last_rank else ""),
        inline=False,
    )

    title = f"{chart_nick} — Points over time"
    image_file = _render_damage_chart(dates, points_vals, title=title, ylabel="Points")
    if image_file is not None:
        embed.set_image(url="attachment://plot.png")
    return embed, image_file


# ---------------------------------------------------------------------------
# CapitolWar cog -- ties everything above together with slash commands.
# ---------------------------------------------------------------------------

class CapitolWar(commands.Cog):
    def __init__(self, bot):
        self.bot = bot

        self.alliance_conn, self.alliance_cursor = self._open_db("db/alliance.sqlite")
        self.capitol_conn, self.capitol_cursor = self._open_db(CAPITOL_DB_PATH)
        self.users_conn, self.users_cursor = self._open_db("db/users.sqlite")
        self.changes_conn, self.changes_cursor = self._open_db("db/changes.sqlite")

        # Ensure required columns exist on alliancesettings -- same migration-
        # guard pattern as VaultTrack.__init__ (mirrored, not reused, since it
        # runs against this cog's own alliance_cursor/alliance_conn).
        self.alliance_cursor.execute("PRAGMA table_info(alliancesettings)")
        existing_columns = [col[1] for col in self.alliance_cursor.fetchall()]
        new_columns = {
            "capitol_score_channel": "INTEGER",
            "capitol_keywords": "TEXT",
            "capitol_admin_only_view": "INTEGER DEFAULT 0",
            "capitol_admin_only_add": "INTEGER DEFAULT 0",
            # capitol_ocr_lang/fallback_langs/autoprune/auto_manage: added for
            # schema parity with vault_* but currently unread -- Capitol War
            # deliberately shares Vault Trap Tracking's OCR language settings
            # instead (see _ocr_language_settings below), same as how Vault
            # Trap's own vault_ocr_autoprune column is itself already an
            # unused reserved column in production.
            "capitol_ocr_lang": "TEXT DEFAULT 'en'",
            "capitol_ocr_fallback_langs": "TEXT DEFAULT ''",
            "capitol_ocr_autoprune": "INTEGER DEFAULT 0",
            "capitol_ocr_auto_manage": "INTEGER DEFAULT 1",
            "capitol_session_timeout_min": "INTEGER DEFAULT 15",
            "capitol_auto_delete_screenshots": "INTEGER DEFAULT 1",
            "capitol_post_info_message": "INTEGER DEFAULT 1",
            "capitol_pin_info_message": "INTEGER DEFAULT 1",
            "capitol_info_message_id": "INTEGER",
        }
        for col_name, col_type in new_columns.items():
            if col_name not in existing_columns:
                self.alliance_cursor.execute(
                    f"ALTER TABLE alliancesettings ADD COLUMN {col_name} {col_type}"
                )
        self.alliance_conn.commit()

        self.data_submit = CapitolDataSubmit(self.alliance_conn, self.capitol_conn)
        self._resume_done = False

    @staticmethod
    def _open_db(path):
        conn = sqlite3.connect(path, timeout=30.0, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.commit()
        return conn, conn.cursor()

    async def cog_unload(self):
        for session in list(_active_capitol_sessions.values()):
            session.stop_timer()
            session.finalized = True
        _active_capitol_sessions.clear()
        for attr in ('alliance_conn', 'capitol_conn', 'users_conn', 'changes_conn'):
            conn = getattr(self, attr, None)
            if conn is not None:
                conn.close()

    # -------------------------------------------------------------------
    # Roster / matching helpers -- thin wrappers around the free functions
    # imported from vault_track, so this cog's own users_cursor/
    # changes_cursor/capitol_cursor drive them (see get_alliance_roster's
    # and get_match_roster's docstrings in vault_track.py).
    # -------------------------------------------------------------------

    def get_alliance_roster(self, alliance_id, active_only: bool = True):
        return get_alliance_roster(self.users_cursor, alliance_id, active_only=active_only)

    def get_match_roster(self, alliance_id, *, as_of_date=None, include_history=False):
        return get_match_roster(self.users_cursor, self.changes_cursor, alliance_id,
                                as_of_date=as_of_date, include_history=include_history)

    async def auto_link_unmatched_by_name(self, alliance_id: int, fid: int, nickname: str) -> int:
        """Link this alliance's fid=NULL capitol_war_points rows whose
        raw_name strongly and unambiguously matches `nickname` to the new
        `fid`. Called from alliance_registration.py's /register and
        alliance_member_operations.py's add-member/CSV-import flow,
        alongside the existing Vault Trap auto-link call."""
        return await auto_link_unmatched_rows_by_name(
            self.capitol_cursor, self.capitol_conn,
            alliance_id=alliance_id, fid=fid, nickname=nickname,
            get_roster=self.get_alliance_roster,
            player_table="capitol_war_points", event_table="capitol_war_events",
            event_fk_col="event_id",
        )

    def get_alliance_tag(self, alliance_id) -> str | None:
        """This alliance's configured 3-char short tag (uppercase), or None
        if unset. Set via Alliance Management → Set Tag (cogs/alliance.py)."""
        try:
            self.alliance_cursor.execute(
                "SELECT tag FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
            row = self.alliance_cursor.fetchone()
            return (row[0] or "").strip().upper() or None if row else None
        except Exception as e:
            logger.warning(f"Capitol War: could not read alliance tag: {e}")
            return None

    # -------------------------------------------------------------------
    # Permissions -- "manage" (add/edit/delete) always requires alliance-
    # admin permission via PermissionManager; "view"/"add" respect the
    # capitol_admin_only_view/capitol_admin_only_add toggles (default off =
    # open), same three-action shape as VaultTrack.check_vault_permission.
    # -------------------------------------------------------------------

    async def check_capitol_permission(self, interaction: discord.Interaction, alliance_id: int, action: str) -> bool:
        if action == "manage":
            if self.can_manage_capitol(interaction, alliance_id):
                return True
            await interaction.response.send_message(
                f"{theme.deniedIcon} You don't have permission to manage Capitol War data for this alliance.",
                ephemeral=True,
            )
            return False

        settings = self.get_capitol_settings(alliance_id)
        key = "admin_only_add" if action == "add" else "admin_only_view"
        only_admin = settings.get(key, 0)
        if not only_admin or self.can_manage_capitol(interaction, alliance_id):
            return True
        await interaction.response.send_message(
            f"{theme.deniedIcon} You don't have permission to {action} Capitol War data for this alliance.",
            ephemeral=True,
        )
        return False

    def can_manage_capitol(self, interaction: discord.Interaction, alliance_id: int) -> bool:
        return PermissionManager.can_manage_alliance(
            interaction.user.id, interaction.guild_id if interaction.guild else 0, alliance_id)

    async def _resolve_alliance_param(self, interaction: discord.Interaction, alliance: str | None) -> int | None:
        """Same auto-skip-the-picker convention as VaultTrack._resolve_alliance_param:
        an admin managing exactly one alliance can omit the `alliance` option."""
        if alliance:
            try:
                return int(alliance)
            except ValueError:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Invalid alliance selected.", ephemeral=True)
                return None

        is_admin, is_global = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please specify an alliance.", ephemeral=True)
            return None

        guild_id = interaction.guild_id if interaction.guild else 0
        if is_global:
            rows = self.alliance_cursor.execute("SELECT alliance_id FROM alliance_list").fetchall()
            alliance_ids = [row[0] for row in rows]
        else:
            alliance_ids, _ = PermissionManager.get_admin_alliance_ids(interaction.user.id, guild_id)

        if not alliance_ids:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No alliances found for your permissions.", ephemeral=True)
            return None
        if len(alliance_ids) > 1:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You manage multiple alliances — please specify which one "
                f"with the `alliance` option.", ephemeral=True)
            return None
        return alliance_ids[0]

    async def alliance_autocomplete(self, interaction: discord.Interaction, current: str):
        def _query():
            cur = self.alliance_conn.cursor()
            cur.execute(
                "SELECT alliance_id, name FROM alliance_list WHERE name LIKE ? ORDER BY name LIMIT 20",
                (f"%{current}%",))
            return cur.fetchall()
        rows = await asyncio.to_thread(_query)
        return [discord.app_commands.Choice(name=row[1], value=str(row[0])) for row in rows]

    async def player_autocomplete(self, interaction: discord.Interaction, current: str):
        alliance_val = getattr(interaction.namespace, 'alliance', None)
        if not alliance_val:
            return []
        try:
            alliance_id = int(alliance_val)
        except (TypeError, ValueError):
            return []
        def _query():
            cur = self.users_conn.cursor()
            cur.execute(
                "SELECT fid, nickname, is_active FROM users WHERE alliance = ? "
                "AND nickname LIKE ? ORDER BY nickname LIMIT 25",
                (str(alliance_id), f"%{current}%"))
            return cur.fetchall()
        rows = await asyncio.to_thread(_query)
        return [
            discord.app_commands.Choice(
                name=f"{nick} ({fid})" + ("" if is_active else " (inactive)"), value=str(fid))
            for fid, nick, is_active in rows
        ]

    def _needs_capitol_setup_hint(self, user_id: int, guild_id: int) -> bool:
        """True iff none of the user's accessible alliances has a Capitol War
        channel configured yet. Mirrors VaultTrack._needs_vault_setup_hint."""
        is_admin, is_global = PermissionManager.is_admin(user_id)
        if not is_admin:
            return False
        try:
            if is_global:
                row = self.alliance_cursor.execute(
                    "SELECT 1 FROM alliancesettings "
                    "WHERE capitol_score_channel IS NOT NULL LIMIT 1"
                ).fetchone()
                return row is None

            alliance_ids, _ = PermissionManager.get_admin_alliance_ids(user_id, guild_id)
            if not alliance_ids:
                return True
            placeholders = ','.join('?' * len(alliance_ids))
            row = self.alliance_cursor.execute(
                f"SELECT 1 FROM alliancesettings "
                f"WHERE alliance_id IN ({placeholders}) "
                f"AND capitol_score_channel IS NOT NULL LIMIT 1",
                alliance_ids,
            ).fetchone()
            return row is None
        except Exception as e:
            logger.warning(f"Capitol War setup hint check failed: {e}")
            return False

    async def show_capitol_menu(self, interaction: discord.Interaction):
        """Capitol War's own main-menu screen (mirrors VaultTrack.
        show_vault_track_menu) -- also the Back-button fallback destination
        for the chart/leaderboard views below when there's no chart_view to
        return to."""
        try:
            view = CapitolMenuView(cog=self, original_user_id=interaction.user.id)

            setup_hint = ""
            if self._needs_capitol_setup_hint(
                interaction.user.id,
                interaction.guild_id if interaction.guild else 0,
            ):
                setup_hint = (
                    f"{theme.warnIcon} **New here?** Click **Capitol War Channel "
                    f"Setup** below to pick a channel for an ally so screenshots "
                    f"posted there are picked up automatically. Until that's "
                    f"done, `/capitol_add` still works for manual uploads.\n\n"
                )

            embed = discord.Embed(
                title=f"{theme.chartIcon} Capitol War Tracking",
                description=(
                    f"Track your alliance's Capitol War Honor Roll points by "
                    f"uploading in-game screenshots.\n\n"
                    f"{setup_hint}"
                    f"**Available Operations**\n"
                    f"{theme.upperDivider}\n"
                    f"{theme.chartIcon} **Capitol War Points**\n"
                    f"└ Points charts, top players, and per-event player breakdowns\n\n"
                    f"{theme.editListIcon} **Capitol War Channel Setup**\n"
                    f"└ Pick the channel and keywords for automatic screenshot uploads\n\n"
                    f"{theme.settingsIcon} **Settings**\n"
                    f"└ Session timeout, auto-delete, and permissions\n"
                    f"{theme.lowerDivider}"
                ),
                color=theme.emColor1
            )

            await safe_edit_message(interaction, embed=embed, view=view, content=None, clear_attachments=True)

        except Exception as e:
            logger.error(f"Error in show_capitol_menu: {e}")
            print(f"[ERROR] Error in show_capitol_menu: {e}")
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(
                        f"{theme.deniedIcon} Failed to load Capitol War Tracking menu.", ephemeral=True
                    )
            except Exception:
                pass

    # -------------------------------------------------------------------
    # Settings helpers (column-based, not JSON) -- mirrors VaultTrack.
    # get_vault_settings/update_vault_setting exactly, pointed at the
    # capitol_* columns.
    # -------------------------------------------------------------------

    def get_capitol_settings(self, alliance_id: int) -> dict:
        self.alliance_cursor.execute(
            "SELECT capitol_score_channel, capitol_keywords, "
            "capitol_admin_only_view, capitol_admin_only_add, "
            "capitol_session_timeout_min, capitol_auto_delete_screenshots, "
            "capitol_post_info_message, capitol_pin_info_message, "
            "capitol_info_message_id "
            "FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,)
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return {
                "channel_id": None,
                "keywords": [],
                "admin_only_view": 0,
                "admin_only_add": 0,
                "session_timeout_min": 15,
                "auto_delete_screenshots": 1,
                "post_info_message": 1,
                "pin_info_message": 1,
                "info_message_id": None,
            }
        return {
            "channel_id": row[0],
            "keywords": [kw.strip() for kw in row[1].split(",") if kw.strip()] if row[1] else [],
            "admin_only_view": row[2] or 0,
            "admin_only_add": row[3] or 0,
            "session_timeout_min": row[4] if row[4] is not None else 15,
            "auto_delete_screenshots": row[5] if row[5] is not None else 1,
            "post_info_message": row[6] if row[6] is not None else 1,
            "pin_info_message": row[7] if row[7] is not None else 1,
            "info_message_id": row[8],
        }

    def update_capitol_setting(self, alliance_id: int, column: str, value):
        allowed = {"capitol_score_channel", "capitol_keywords",
                    "capitol_admin_only_view", "capitol_admin_only_add",
                    "capitol_session_timeout_min", "capitol_auto_delete_screenshots",
                    "capitol_post_info_message", "capitol_pin_info_message",
                    "capitol_info_message_id"}
        if column not in allowed:
            return
        self.alliance_cursor.execute(
            f"UPDATE alliancesettings SET {column} = ? WHERE alliance_id = ?",
            (value, alliance_id)
        )
        self.alliance_conn.commit()

    def get_capitol_session_settings(self, alliance_id: int) -> tuple[int, bool]:
        """Return (timeout_min, auto_delete_screenshots) for the alliance."""
        self.alliance_cursor.execute(
            "SELECT capitol_session_timeout_min, capitol_auto_delete_screenshots "
            "FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,),
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return 15, True
        timeout = row[0] if row[0] is not None else 15
        auto_delete = bool(row[1]) if row[1] is not None else True
        return int(timeout), auto_delete

    def _ocr_language_settings(self, alliance_id, roster_names):
        """Primary/fallback OCR languages for this alliance. Reuses Vault
        Trap's per-alliance OCR-language setting (alliancesettings.
        vault_ocr_lang/vault_ocr_fallback_langs) if the VaultTrack cog is
        loaded -- it's an alliance-wide OCR preference for reading this
        alliance's own player names, not something specific to vault_hunts,
        so sharing it avoids asking admins to configure the same language
        twice. Falls back to English + roster-derived auto-fallbacks when
        VaultTrack isn't loaded."""
        vault_cog = self.bot.get_cog("VaultTrack")
        if vault_cog is not None:
            try:
                primary, fallbacks = vault_cog.get_ocr_language_settings(alliance_id)
                if not fallbacks:
                    fallbacks = auto_managed_fallbacks(alliance_id, roster_names, primary=primary)
                return primary, fallbacks
            except Exception as e:
                logger.warning(f"Capitol War: could not read shared OCR language settings: {e}")
        fallbacks = auto_managed_fallbacks(alliance_id, roster_names, primary=DEFAULT_OCR_LANG)
        return DEFAULT_OCR_LANG, fallbacks

    # -------------------------------------------------------------------
    # Channel info message ("what to upload" pinned helper) -- mirrors
    # VaultTrack's _looks_like_vault_info_message / _find_vault_info_messages
    # / refresh_vault_info_message exactly, pointed at the Capitol-flavored
    # fingerprints/renderer and capitol_* columns.
    # -------------------------------------------------------------------

    def _looks_like_capitol_info_message(self, msg: discord.Message) -> bool:
        if msg.author.id != self.bot.user.id:
            return False
        content = msg.content or ""
        return any(fp in content for fp in _CAPITOL_INFO_FINGERPRINTS)

    async def _find_capitol_info_messages(self, channel) -> list:
        try:
            pins = await channel.pins()
        except (discord.Forbidden, discord.HTTPException):
            return []
        return [m for m in pins if self._looks_like_capitol_info_message(m)]

    async def refresh_capitol_info_message(self, alliance_id: int) -> None:
        """Post/edit/pin (or remove) the Capitol War channel's info message to
        match the alliance's post/pin settings. Self-heals duplicates and
        stale pins."""
        settings = self.get_capitol_settings(alliance_id)
        channel_id = settings.get("channel_id")
        if not channel_id:
            return
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return

        ours = await self._find_capitol_info_messages(channel)
        tracked_id = settings.get("info_message_id")
        if tracked_id and not any(m.id == tracked_id for m in ours):
            try:
                tracked_msg = await channel.fetch_message(tracked_id)
                if self._looks_like_capitol_info_message(tracked_msg):
                    ours.append(tracked_msg)
            except (discord.NotFound, discord.Forbidden):
                pass

        if not settings.get("post_info_message"):
            for m in ours:
                try:
                    await m.delete()
                except (discord.NotFound, discord.Forbidden):
                    pass
            if tracked_id:
                self.update_capitol_setting(alliance_id, "capitol_info_message_id", None)
            return

        content = render_capitol_info_message()

        keep = None
        if tracked_id:
            keep = next((m for m in ours if m.id == tracked_id), None)
        if keep is None and ours:
            keep = max(ours, key=lambda m: m.created_at)
        for m in ours:
            if keep is None or m.id != keep.id:
                try:
                    await m.delete()
                except (discord.NotFound, discord.Forbidden):
                    pass

        if keep is None:
            try:
                keep = await channel.send(content)
            except discord.Forbidden:
                logger.warning(f"Capitol War: cannot post info message in channel {channel_id}")
                return
            self.update_capitol_setting(alliance_id, "capitol_info_message_id", keep.id)
        else:
            try:
                await keep.edit(content=content)
            except discord.Forbidden:
                return
            if keep.id != tracked_id:
                self.update_capitol_setting(alliance_id, "capitol_info_message_id", keep.id)

        if settings.get("pin_info_message"):
            try:
                if not keep.pinned:
                    await keep.pin(reason="Capitol War score channel info message")
            except discord.Forbidden:
                pass
        else:
            try:
                if keep.pinned:
                    await keep.unpin(reason="Capitol War info message pin toggled off")
            except discord.Forbidden:
                pass

    # -------------------------------------------------------------------
    # on_message / channel-listener session routing -- mirrors
    # VaultTrack.on_message / process_vault_hunt_data. Deliberately has no
    # admin/permission check on this path, same as Vault Trap's own
    # on_message (check_capitol_permission is never called from here, only
    # from interaction-based commands) -- see module notes.
    # -------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self):
        """Restore Capitol War sessions interrupted by a crash/restart,
        pre-loaded with whatever rows had already been merged before the
        restart. Mirrors VaultTrack.on_ready."""
        if self._resume_done:
            return
        self._resume_done = True
        from . import ocr_resume
        for key, payload in ocr_resume.load_all('capitol'):
            try:
                aid = payload.get('alliance_id')
                if self.bot.get_channel(payload.get('channel_id')) is None or aid is None:
                    ocr_resume.delete(key)
                    continue
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                roster = self.get_match_roster(aid, as_of_date=today, include_history=False)
                session = CapitolSession(
                    cog=self, channel_id=payload['channel_id'], user_id=payload['user_id'],
                    alliance_id=aid, alliance_name=payload.get('alliance_name', ''),
                    alliance_tag=payload.get('alliance_tag'),
                    roster=roster, primary_lang=payload.get('primary_lang', 'en'),
                    fallback_langs=payload.get('fallback_langs', []),
                    timeout_min=payload.get('timeout_min', 15),
                    auto_delete=payload.get('auto_delete', True))
                session.restore_events(payload)
                _active_capitol_sessions[(payload['channel_id'], payload['user_id'])] = session
                await session.resume()
            except Exception as e:
                logger.error(f"CapitolWar: failed to resume session: {e}")
                ocr_resume.delete(key)

    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return
        if not message.content.strip() and not message.attachments:
            return

        self.alliance_cursor.execute(
            "SELECT alliance_id, capitol_keywords FROM alliancesettings WHERE capitol_score_channel = ?",
            (message.channel.id,)
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return
        alliance_id, keywords_raw = row

        keywords = [kw.strip() for kw in keywords_raw.split(",") if kw.strip()] if keywords_raw else []
        if keywords and not any(kw.lower() in message.content.lower() for kw in keywords):
            return

        await self.process_capitol_war_data(message, alliance_id=int(alliance_id))

    async def _enforce_upload_permission(self, message, alliance_id: int) -> bool:
        """Gate the channel-listener screenshot-upload path behind the same
        "Add Permission" toggle /settings already exposes for
        /capitol_add (capitol_admin_only_add) -- previously only the
        manual slash command respected it; posting a screenshot directly
        in the tracking channel bypassed it entirely, leaving Discord's
        own channel permissions as the only thing standing between a
        non-admin and triggering OCR ingestion. Reuses
        PermissionManager.can_manage_alliance, the exact "alliance admin
        or higher, for this specific alliance" check the toggle's own UI
        already describes as "Admins only" vs "Everyone"."""
        settings = self.get_capitol_settings(alliance_id)
        if not settings.get("admin_only_add"):
            return True
        guild_id = message.guild.id if message.guild else 0
        if PermissionManager.can_manage_alliance(message.author.id, guild_id, alliance_id):
            return True
        try:
            await message.channel.send(
                f"{theme.lockIcon} {message.author.mention} Only alliance admins can upload "
                f"Capitol War screenshots here.",
                delete_after=10,
            )
        except Exception as e:
            logger.warning(f"Capitol War: could not post upload-denied notice: {e}")
        return False

    async def process_capitol_war_data(self, message, *, alliance_id=None):
        """Route a Honor Roll screenshot upload into the per-(channel, user)
        session. Mirrors VaultTrack.process_vault_hunt_data."""
        image_attachments = [
            a for a in message.attachments
            if any(a.filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.webp'])
        ]
        if not image_attachments:
            return

        key = (message.channel.id, message.author.id)
        session = _active_capitol_sessions.get(key)

        if alliance_id is None:
            if session is not None:
                alliance_id = session.alliance_id
            else:
                self.alliance_cursor.execute(
                    "SELECT alliance_id FROM alliancesettings WHERE capitol_score_channel = ?",
                    (message.channel.id,),
                )
                row = self.alliance_cursor.fetchone()
                if not row:
                    return
                alliance_id = int(row[0])

        if not await self._enforce_upload_permission(message, alliance_id):
            return

        if session is None:
            self.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
            )
            anrow = self.alliance_cursor.fetchone()
            alliance_name = anrow[0] if anrow else f"Alliance {alliance_id}"

            # Capitol War rows can't be tag-filtered without a configured tag
            # (see parse_capitol_rows) -- same guard /capitol_add applies
            # before running OCR, just surfaced as a channel message here
            # since there's no interaction to reply to.
            tag = self.get_alliance_tag(alliance_id)
            if not tag:
                try:
                    await message.channel.send(
                        f"{theme.warnIcon} {alliance_name} has no Capitol War tag set, so "
                        f"screenshot rows can't be filtered to just this alliance from the "
                        f"state-wide rankings. Set it first: Alliance Management → **Set "
                        f"Tag**, then upload again."
                    )
                except Exception as e:
                    logger.warning(f"Capitol War: could not post missing-tag warning: {e}")
                return

            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            roster = self.get_match_roster(alliance_id, as_of_date=today, include_history=False)
            roster_names = [e[-1] for e in roster if len(e) >= 2]
            primary_lang, fallback_langs = self._ocr_language_settings(alliance_id, roster_names)
            timeout_min, auto_delete = self.get_capitol_session_settings(alliance_id)

            session = CapitolSession(
                cog=self,
                channel_id=message.channel.id,
                user_id=message.author.id,
                alliance_id=alliance_id,
                alliance_name=alliance_name,
                alliance_tag=tag,
                roster=roster,
                primary_lang=primary_lang,
                fallback_langs=fallback_langs,
                timeout_min=timeout_min,
                auto_delete=auto_delete,
            )
            _active_capitol_sessions[key] = session

            try:
                session.session_view = CapitolSessionView(session)
                session.progress_msg = await message.channel.send(
                    embed=session.build_progress_embed(),
                    view=session.session_view,
                )
            except Exception as e:
                logger.warning(f"Capitol War: could not post collecting message: {e}")

        await session.add_message(message, image_attachments)

    async def _finalize_capitol_session(self, session: "CapitolSession", *, timed_out: bool):
        """Build the review for a finished channel-listener session -- the
        session's own hand-off into CapitolWarReviewView, parallel to
        capitol_add's (built from a session's accumulated rows_by_points
        instead of one command's up-to-5 attachments). Mirrors
        VaultTrack._finalize_session; skips the EventGroup-splitting
        "N screenshots didn't fit this event" note since CapitolSession has
        no such splitting (see module notes)."""
        if not session.any_ocr_success:
            if session.progress_msg:
                embed = discord.Embed(
                    title=f"{theme.warnIcon} OCR could not read any screenshot",
                    description="No data was extracted. Please upload clearer screenshots.",
                    color=theme.emColor2,
                )
                try:
                    await session.progress_msg.edit(embed=embed, view=None)
                except Exception:
                    pass
            return

        tracker = CapitolAutoDeleteTracker(session.source_messages, session.auto_delete)
        today_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Deliberately NOT inferring a rank for rows with no explicit OCR'd
        # digit here. A "previous row's rank + 1" (or positional-index)
        # guess is only valid when the parsed sequence is genuinely
        # rank-adjacent, which holds for Vault Trap (nothing filtered) but
        # NOT for Capitol War: rows are filtered by alliance tag before this
        # point, so most of the ranks between two consecutive kept rows
        # legitimately belong to other alliances and were correctly
        # discarded, not skipped-by-mistake. Backfilling a position-based
        # number here produces a plausible-looking but essentially arbitrary
        # wrong rank that silently collides with an unrelated real row (see
        # the "Daddy"/"Ruri"/"ChiefFAFO" cases in docs/ocr-reference/
        # capitol_war_mismatch_2026-08-23.md's "Round 2" section) and is
        # invisible to rank_sequence_warnings, which only compares explicit
        # reads. Leaving rank=None/rank_explicit=False here is honest, and
        # every display site already renders a "#?" placeholder for it.
        parsed_rows = list(session.rows_by_points.values())

        tag_note = None
        if session.candidates_seen:
            tag_note = f"Filtered to {session.kept_seen} of {session.candidates_seen} row(s) for [{session.tag}]."
        elif session.processed_images:
            tag_note = (
                f"{theme.warnIcon} No rows recognized from the screenshot(s) — the Honor "
                f"Roll's column header may not have been captured. Add rows manually if needed."
            )

        event_meta = {'date': today_date, 'event_time': None}
        existing_event_id, existing_rows = self.data_submit._load_existing_event(
            session.alliance_id, today_date)

        wrapped_submit = _TrackerAwareDataSubmit(self.data_submit, tracker)
        review = CapitolSessionReviewView(
            cog=self,
            data_submit=wrapped_submit,
            event_meta=event_meta,
            rows=parsed_rows,
            roster=session.roster,
            tag_note=tag_note,
            alliance_id=session.alliance_id,
            alliance_name=session.alliance_name,
            original_user_id=session.user_id,
            existing_event_id=existing_event_id,
            existing_rows=existing_rows,
            auto_delete_tracker=tracker,
        )
        tracker.register()

        embed = review.build_embed()
        if timed_out:
            prefix = (
                f"{theme.hourglassIcon} **Session timed out after "
                f"{session.timeout_min} min**. Review and Submit when ready."
            )
            embed.description = prefix + "\n\n" + (embed.description or "")
        if not session.any_ocr_success:
            embed.title = f"{theme.warnIcon} OCR could not read the image(s): add rows manually"

        channel = self.bot.get_channel(session.channel_id)
        if session.progress_msg is not None:
            try:
                await session.progress_msg.edit(embed=embed, view=review)
                review.message = session.progress_msg
                return
            except Exception as e:
                logger.warning(f"Capitol War: could not edit progress into review: {e}")
        if channel:
            try:
                review.message = await channel.send(embed=embed, view=review)
            except Exception as e:
                logger.warning(f"Capitol War: could not send review: {e}")

    def _ocr_language_settings(self, alliance_id, roster_names):
        """Primary/fallback OCR languages for this alliance. Reuses Vault
        Trap's per-alliance OCR-language setting (alliancesettings.
        vault_ocr_lang/vault_ocr_fallback_langs) if the VaultTrack cog is
        loaded -- it's an alliance-wide OCR preference for reading this
        alliance's own player names, not something specific to vault_hunts,
        so sharing it avoids asking admins to configure the same language
        twice. Falls back to English + roster-derived auto-fallbacks when
        VaultTrack isn't loaded."""
        vault_cog = self.bot.get_cog("VaultTrack")
        if vault_cog is not None:
            try:
                primary, fallbacks = vault_cog.get_ocr_language_settings(alliance_id)
                if not fallbacks:
                    fallbacks = auto_managed_fallbacks(alliance_id, roster_names, primary=primary)
                return primary, fallbacks
            except Exception as e:
                logger.warning(f"Capitol War: could not read shared OCR language settings: {e}")
        fallbacks = auto_managed_fallbacks(alliance_id, roster_names, primary=DEFAULT_OCR_LANG)
        return DEFAULT_OCR_LANG, fallbacks

    # -------------------------------------------------------------------
    # Slash commands
    # -------------------------------------------------------------------

    @app_commands.command(
        name="capitol_add",
        description="Record a Capitol War Honor Roll event, from screenshots or manual entry",
    )
    @app_commands.autocomplete(alliance=alliance_autocomplete)
    @app_commands.describe(
        alliance="Alliance name (optional if you only manage one)",
        date="UTC date (YYYY-MM-DD). Defaults to today.",
        attachment1="Honor Roll screenshot (optional -- add rows manually if omitted)",
        attachment2="Additional Honor Roll screenshot (optional, for a wider rank range)",
        attachment3="Additional Honor Roll screenshot (optional)",
        attachment4="Additional Honor Roll screenshot (optional)",
        attachment5="Additional Honor Roll screenshot (optional)",
    )
    async def capitol_add(self, interaction: discord.Interaction,
                          alliance: str | None = None, date: str | None = None,
                          attachment1: discord.Attachment | None = None,
                          attachment2: discord.Attachment | None = None,
                          attachment3: discord.Attachment | None = None,
                          attachment4: discord.Attachment | None = None,
                          attachment5: discord.Attachment | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return
        allowed = await self.check_capitol_permission(interaction, alliance_id, "manage")
        if not allowed:
            return

        if not date:
            date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        try:
            dt = datetime.strptime(date, "%Y-%m-%d")
            date = dt.strftime("%Y-%m-%d")
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date - use YYYY-MM-DD (e.g. 2026-07-13).",
                ephemeral=True)
            return

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
        arow = self.alliance_cursor.fetchone()
        alliance_name = arow[0] if arow else f"Alliance ID: {alliance_id}"

        attachments = [a for a in (attachment1, attachment2, attachment3, attachment4, attachment5)
                       if a is not None]

        roster = self.get_match_roster(alliance_id, as_of_date=date, include_history=False)

        tag = self.get_alliance_tag(alliance_id)
        if attachments and not tag:
            await interaction.response.send_message(
                f"{theme.warnIcon} {alliance_name} has no Capitol War tag set, so screenshot rows "
                f"can't be filtered to just this alliance from the state-wide rankings. "
                f"Set it first: Alliance Management → **Set Tag**, then try again.",
                ephemeral=True)
            return

        rows_by_points: dict = {}
        candidates_seen = 0
        kept_seen = 0
        if attachments:
            await interaction.response.defer()
            roster_names = [e[-1] for e in roster if len(e) >= 2]
            primary_lang, fallback_langs = self._ocr_language_settings(alliance_id, roster_names)
            ok_count = 0
            for att in attachments:
                if not (att.filename and any(
                        att.filename.lower().endswith(ext) for ext in ('.png', '.jpg', '.jpeg', '.webp'))):
                    continue
                try:
                    image_bytes = await att.read()
                except Exception as e:
                    logger.warning(f"Capitol War: read failed on {att.filename}: {e}")
                    continue
                result = await ocr_attachment_to_capitol_result(
                    image_bytes, primary_lang, fallback_langs,
                    filename=att.filename, roster=roster, alliance_id=alliance_id,
                    alliance_tag=tag,
                )
                if not result.ok:
                    continue
                ok_count += 1
                candidates_seen += result.candidates_seen
                kept_seen += len(result.rows)
                for key, row in result.rows.items():
                    existing = rows_by_points.get(key)
                    if existing is None or _better_row(existing, row, roster=roster):
                        rows_by_points[key] = row

            if ok_count == 0:
                await interaction.followup.send(
                    f"{theme.deniedIcon} OCR couldn't read any of the {len(attachments)} "
                    f"screenshot(s). Try clearer screenshots, or use Add Player to enter rows "
                    f"manually in the review that follows.",
                    ephemeral=True)

        # See the matching comment in _finalize_capitol_session: no
        # position/previous-row rank inference for Capitol War rows with no
        # explicit OCR'd digit -- that guess is only valid for an unfiltered
        # sequence (Vault Trap), not this tag-filtered one.
        parsed_rows = list(rows_by_points.values())

        tag_note = None
        if attachments:
            tag_note = (
                f"Filtered to {kept_seen} of {candidates_seen} row(s) for [{tag}]."
                if candidates_seen else
                f"{theme.warnIcon} No rows recognized from the screenshot(s) — the Honor Roll's "
                f"column header may not have been captured. Add rows manually if needed."
            )

        event_meta = {'date': date, 'event_time': None}
        existing_event_id, existing_rows = self.data_submit._load_existing_event(alliance_id, date)

        review = CapitolWarReviewView(
            cog=self, data_submit=self.data_submit, event_meta=event_meta,
            rows=parsed_rows, roster=roster, tag_note=tag_note,
            alliance_id=alliance_id, alliance_name=alliance_name,
            original_user_id=interaction.user.id,
            existing_event_id=existing_event_id, existing_rows=existing_rows,
        )
        if interaction.response.is_done():
            await interaction.followup.send(embed=review.build_embed(), view=review)
            review.message = await interaction.original_response()
        else:
            await interaction.response.send_message(embed=review.build_embed(), view=review)
            review.message = await interaction.original_response()

    @app_commands.command(name="capitol_view", description="View Capitol War points for an alliance")
    @app_commands.autocomplete(alliance=alliance_autocomplete)
    @app_commands.describe(
        alliance="Select an alliance (optional if you only manage one)",
        from_date="Optional — leave blank, Time Range presets/custom range come after",
        to_date="Optional — leave blank, Time Range presets/custom range come after",
    )
    async def capitol_view(self, interaction: discord.Interaction,
                           alliance: str | None = None,
                           from_date: str | None = None, to_date: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return
        allowed = await self.check_capitol_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        try:
            parsed_from = datetime.strptime(from_date, "%Y-%m-%d").date() if from_date else None
            parsed_to = datetime.strptime(to_date, "%Y-%m-%d").date() if to_date else None
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date - use YYYY-MM-DD (e.g. 2026-07-13).",
                ephemeral=True)
            return

        await interaction.response.defer()

        view = CapitolWarView(
            data_submit=self.data_submit, cog=self, original_user_id=interaction.user.id,
            alliance_id=alliance_id, from_date=parsed_from, to_date=parsed_to)

        embed, file = await self.data_submit.process_view(
            alliance_id=alliance_id, from_date=from_date, to_date=to_date)

        if not embed:
            await interaction.followup.send(
                f"{theme.deniedIcon} No data found for the selected parameters.", ephemeral=True)
            return

        if file:
            await interaction.followup.send(embed=embed, file=file, view=view)
        else:
            await interaction.followup.send(embed=embed, view=view)

    @app_commands.command(name="capitol_player_history", description="Show a player's Capitol War points history")
    @app_commands.autocomplete(alliance=alliance_autocomplete, player=player_autocomplete)
    @app_commands.describe(
        player="Player (pick from the suggestions or enter an ID)",
        alliance="Alliance the player belongs to (optional if you only manage one)",
    )
    async def capitol_player_history(self, interaction: discord.Interaction,
                                     player: str, alliance: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return
        allowed = await self.check_capitol_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        try:
            fid = int(player)
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid player — must be an ID.", ephemeral=True)
            return

        await interaction.response.defer()

        self.users_cursor.execute("SELECT nickname FROM users WHERE fid = ?", (fid,))
        nick_row = self.users_cursor.fetchone()
        nickname = nick_row[0] if nick_row else f"ID {fid}"

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
        an_row = self.alliance_cursor.fetchone()
        alliance_name = an_row[0] if an_row else f"Alliance {alliance_id}"

        rows = self.capitol_cursor.execute(
            "SELECT cwe.date, cwp.points, cwp.rank "
            "FROM capitol_war_points cwp JOIN capitol_war_events cwe ON cwe.id = cwp.event_id "
            "WHERE cwe.alliance_id = ? AND cwp.fid = ? ORDER BY cwe.date ASC",
            (alliance_id, fid)).fetchall()

        embed, image_file = capitol_player_history_embed(
            alliance_name=alliance_name, fid=fid, nickname=nickname, rows=rows)
        if image_file:
            await interaction.followup.send(embed=embed, file=image_file)
        else:
            await interaction.followup.send(embed=embed)

    @app_commands.command(
        name="capitol_compare",
        description="Compare Capitol War points history across multiple players",
    )
    @app_commands.autocomplete(alliance=alliance_autocomplete)
    @app_commands.describe(
        alliance="Select an alliance (optional if you only manage one)",
        from_date="Optional — leave blank, presets/custom range come after picking players",
        to_date="Optional — leave blank, presets/custom range come after picking players",
    )
    async def capitol_compare(self, interaction: discord.Interaction,
                              alliance: str | None = None,
                              from_date: str | None = None, to_date: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return
        allowed = await self.check_capitol_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        try:
            if from_date:
                datetime.strptime(from_date, "%Y-%m-%d")
            if to_date:
                datetime.strptime(to_date, "%Y-%m-%d")
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date - use YYYY-MM-DD (e.g. 2026-07-13).",
                ephemeral=True)
            return

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,))
        an_row = self.alliance_cursor.fetchone()
        alliance_name = an_row[0] if an_row else f"Alliance {alliance_id}"

        view = CapitolCompareView(
            cog=self, original_user_id=interaction.user.id, alliance_id=alliance_id,
            alliance_name=alliance_name, from_date=from_date, to_date=to_date,
        )
        if not view.roster:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No roster members found for {alliance_name}.",
                ephemeral=True)
            return
        await interaction.response.send_message(embed=view.build_picker_embed(), view=view)


async def setup(bot):
    # Route recovery-button clicks after a restart (messages from a prior process).
    try:
        bot.add_dynamic_items(CapitolSessionButton)
    except Exception as e:
        logger.warning(f"Capitol War session: could not register dynamic buttons: {e}")
    await bot.add_cog(CapitolWar(bot))
