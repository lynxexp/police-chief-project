"""
Vault Trap damage tracking. Records, views, and charts Vault Trap damage per
alliance, using naming (classes, functions, DB columns) that matches
Vault Trap terminology (VaultTrack, VaultSession, vault_hunts, etc.) and an
OCR text-parsing layer tuned to Vault Trap's actual mail format
(see docs/ocr-reference/vault_trap.md).
"""
import discord
from discord.ext import commands
from discord import app_commands
import asyncio
import aiohttp
import gc
import importlib.util
import io
import re
import os
import sqlite3
import time
import unicodedata
import logging
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, date, timedelta, timezone
from cogs.attendance import MATPLOTLIB_AVAILABLE
from .pimp_my_bot import theme, safe_edit_message, check_interaction_user
from .permission_handler import PermissionManager
from .alliance_member_operations import _post_alliance_log
import numpy as np

logger = logging.getLogger('bot')

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    Image = None
    PIL_AVAILABLE = False

try:
    from rapidfuzz import process as _rf_process, fuzz as _rf_fuzz, utils as _rf_utils
    RAPIDFUZZ_AVAILABLE = True
except ImportError:
    _rf_process = None
    _rf_fuzz = None
    _rf_utils = None
    RAPIDFUZZ_AVAILABLE = False
    logger.warning("rapidfuzz not installed — player-name resolution will fall back to manual entry only.")

from . import onnx_lifecycle

# RapidOCR setup. Engines are lazy-loaded per language via onnx_lifecycle and
# unloaded ~2 min after the last vault session finalises.
OCR_AVAILABLE = False
OCR_IMPORT_ERROR = None  # real reason OCR is off (e.g. missing libGL.so.1), for admin diagnostics

# Above ~1800px ONNXRuntime hits 'bad allocation' on the 2nd-3rd image. The
# inference arena scales with image area, so low-memory boxes shrink further to
# fit alongside the captcha model in ~512 MB.
MAX_OCR_DIM = 1280 if onnx_lifecycle.LOW_MEM_MODE else 1600

# onnxruntime threads per engine. -1 (its default) grabs one thread per core the
# host reports; small VPS plans over-report cores, so it spawns too many threads
# and OOMs / pegs CPU at 100%. 1 keeps low-RAM boxes alive; raise it for speed.
OCR_NUM_THREADS = 1

# Low-memory boxes are usually CPU-throttled too. Pause this long after each OCR
# pass so the event loop can send Discord heartbeats and breathe between the
# CPU-heavy passes (e.g. a multi-language fallback run), instead of starving them.
_LOW_MEM_OCR_PAUSE = 1.0

DEFAULT_OCR_LANG = "en"

# External OCR service. The bot can POST screenshots to a shared OCR box instead
# of running engines locally (any remote failure falls back to local for that
# image). The URL resolves as: bot config (UI modal) > OCR_REMOTE_URL env > local.
# There is no default/shared OCR service - operators who want to
# use a remote OCR box must opt in via the OCR_REMOTE_URL env var or the UI modal.
OCR_REMOTE_URL_DEFAULT = ""
OCR_REMOTE_URL_ENV = os.environ.get("OCR_REMOTE_URL", "").strip().rstrip("/")
# X-API-Key for the remote OCR service; only meaningful if OCR_REMOTE_URL is set.
OCR_REMOTE_TOKEN = os.environ.get("OCR_REMOTE_TOKEN", "").strip()
try:
    OCR_REMOTE_TIMEOUT = float(os.environ.get("OCR_REMOTE_TIMEOUT", "60"))
except ValueError:
    OCR_REMOTE_TIMEOUT = 60.0

_SETTINGS_DB = "db/settings.sqlite"
_remote_ocr_cache = (0.0, None)  # (monotonic expiry, URL string | "" | None)


def remote_ocr_setting():
    """Cached UI value for the external OCR URL: a URL string, '' (explicitly
    disabled), or None (not configured -> defer to env)."""
    global _remote_ocr_cache
    now = time.monotonic()
    exp, val = _remote_ocr_cache
    if now < exp:
        return val
    val = None
    try:
        with sqlite3.connect(_SETTINGS_DB, timeout=30.0) as conn:
            row = conn.execute(
                "SELECT setting_value FROM bot_global_settings WHERE setting_key=?",
                ("remote_ocr_url",),
            ).fetchone()
            if row:
                val = row[0]
    except Exception:
        val = None
    _remote_ocr_cache = (now + 10.0, val)
    return val


def remote_ocr_url():
    """External OCR base URL to use, or None for local OCR.
    Precedence: bot config (UI modal) > OCR_REMOTE_URL env > local."""
    val = remote_ocr_setting()
    if val is not None:
        return val or None  # '' = disabled (local); otherwise the configured URL
    return OCR_REMOTE_URL_ENV or None


def invalidate_remote_ocr_cache():
    """Drop the cached value so a UI change takes effect immediately."""
    global _remote_ocr_cache
    _remote_ocr_cache = (0.0, None)

if PIL_AVAILABLE:
    try:
        from rapidocr import RapidOCR, LangRec
        # rapidocr doesn't declare onnxruntime as a dep and only imports it when an
        # engine is built, so check now rather than failing on the first screenshot.
        if importlib.util.find_spec("onnxruntime") is None:
            raise ImportError("onnxruntime is not installed (RapidOCR's inference backend)")
        try:
            from rapidocr.utils.download_file import DownloadFile
            DownloadFile.check_is_atty = staticmethod(lambda: False)
        except Exception:
            pass
        OCR_AVAILABLE = True
        logger.info("Vault Trap OCR ready (engines load on demand per language).")
    except Exception as e:
        # log the real cause (e.g. OpenCV's missing libGL.so.1), not "not installed"
        OCR_IMPORT_ERROR = f"{type(e).__name__}: {e}"
        logger.warning(f"OCR disabled — could not import rapidocr: {OCR_IMPORT_ERROR}")
        print(f"[WARNING] OCR disabled — could not import rapidocr: {OCR_IMPORT_ERROR}")
    except Exception as e:
        logger.error(f"Failed to initialize RapidOCR: {e}")
        print(f"[ERROR] Failed to initialize RapidOCR: {e}")

os.makedirs("db", exist_ok=True)

VAULT_DB_PATH = "db/vault_data.sqlite"


def _ensure_vault_hunts_event_time(conn):
    """Idempotently add the optional event_time column to vault_hunts."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(vault_hunts)")]
    if "event_time" not in cols:
        conn.execute("ALTER TABLE vault_hunts ADD COLUMN event_time TEXT")
        conn.commit()


def init_vault_database():
    """Initialize vault_hunts + vault_player_damage tables."""
    with closing(sqlite3.connect(VAULT_DB_PATH, timeout=30.0)) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_hunts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alliance_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                trap_number INTEGER NOT NULL,
                rallies INTEGER,
                total_damage INTEGER,
                UNIQUE (alliance_id, date, trap_number)
            )
        """)
        _ensure_vault_hunts_event_time(conn)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_player_damage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hunt_id INTEGER NOT NULL REFERENCES vault_hunts(id) ON DELETE CASCADE,
                fid INTEGER,
                raw_name TEXT,
                resolved_nickname TEXT,
                damage INTEGER NOT NULL,
                rank INTEGER,
                match_score INTEGER
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_bpd_fid ON vault_player_damage(fid)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_bpd_hunt ON vault_player_damage(hunt_id)")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_ocr_lang_stats (
                alliance_id INTEGER NOT NULL,
                lang        TEXT    NOT NULL,
                role        TEXT    NOT NULL,
                runs        INTEGER NOT NULL DEFAULT 0,
                rows_filled INTEGER NOT NULL DEFAULT 0,
                last_run_at TEXT,
                PRIMARY KEY (alliance_id, lang, role)
            )
        """)
        # Learned OCR→player aliases: maps the normalized OCR text of a name the
        # bot can't read (decorated/homoglyph gamertags) to the player it belongs to,
        # so an admin only has to resolve it once.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_name_alias (
                alliance_id INTEGER NOT NULL,
                ocr_key     TEXT    NOT NULL,
                fid         INTEGER NOT NULL,
                raw_name    TEXT,
                updated_at  TEXT,
                PRIMARY KEY (alliance_id, ocr_key)
            )
        """)
        conn.commit()


init_vault_database()


_OCR_DIGIT_MAP = {
    'O': '0', 'o': '0', 'Q': '0',
    'I': '1', 'l': '1', '|': '1', '!': '1',
    'Z': '2',
    'S': '5',
    'B': '8',
    'g': '9',
}

_OCR_DIGIT_RUN = re.compile(
    rf"[\d,\.{re.escape(''.join(_OCR_DIGIT_MAP.keys()))}]{{3,}}"
)

# Chinese OCR sometimes emits full-width punctuation inside number runs.
_FULLWIDTH_PUNCT = str.maketrans({
    '，': ',', '．': '.', '：': ':', '；': ';',
})

# Korean OCR omits thousand separators; reinsert them on 9-12 digit runs
# (damage range; sidesteps 8-digit FIDs and date/time fragments).
_BARE_DAMAGE_RUN_RE = re.compile(r'(?<!\d)(\d{9,12})(?!\d)')


def _rejoin_spaced_thousands(m) -> str:
    s = m.group(0)
    sep = ',' if ',' in s else '.'
    return re.sub(r'[ \t]+', sep, s)


def repair_ocr_digits(text: str) -> str:
    text = text.translate(_FULLWIDTH_PUNCT)
    # OCR often reads a thousands separator as a space ('663,240 667'), which
    # truncates the value ~1000x at parse. Rejoin trailing 3-digit groups onto a
    # number that already has a real separator (so a leading rank isn't merged);
    # same-line only so a value never absorbs the next row.
    text = _SPACED_THOUSANDS_RE.sub(_rejoin_spaced_thousands, text)
    text = _BARE_DAMAGE_RUN_RE.sub(lambda m: f'{int(m.group(1)):,}', text)
    def _fix(match):
        run = match.group(0)
        digits = sum(c.isdigit() for c in run)
        if digits == 0 or (len(run) >= 6 and digits <= 1):
            return run
        return ''.join(_OCR_DIGIT_MAP.get(c, c) for c in run)
    return _OCR_DIGIT_RUN.sub(_fix, text)


_FORMATTED_NUMBER_RE = re.compile(r'\d{1,3}(?:[,\.]\d{3})+')
# A grouped number whose later separators OCR'd as spaces: '663,240 667'.
_SPACED_THOUSANDS_RE = re.compile(r'\d{1,3}(?:[,\.]\d{3})+(?:[ \t]+\d{3})+(?!\d)')
# Two capture groups: digit-at-end (`[Vault Trap # 1]`) or digit-at-start
# (Arabic visual-order: `[1 فخ الصيد]` → OCR `[1 ...]`).
_BRACKETED_TRAP_RE = re.compile(r'\[(?:[^\]\d][^\]]*?(\d+)|(\d+)[^\]]*?)\]')
# Headerless fallback for engines that drop `[`/`]` (japan, chinese_cht).
# Single digit only — keeps merged-rank junk like `狩獵陷阱21` from matching.
_HEADERLESS_TRAP_RE = re.compile(
    r'(?:Hunting\s*Trap|狩獵陷阱|狩猎陷阱|同盟罠|사냥\s*함정|사냥함정|Охота)\s*(\d)',
    re.IGNORECASE,
)
# Backup summary marker for when OCR ate the brackets (no `]` to rfind on).
# "Solo Damage Rewards" is Vault Trap's actual section header (see
# docs/ocr-reference/vault_trap.md); the alternate "Personal Damage Rewards"
# wording is kept alongside it since it's a harmless no-op against Police
# Chief OCR text.
_PERSONAL_REWARDS_RE = re.compile(
    r'Solo\s+Damage\s+Rewards|Personal\s+Damage\s+Rewards'
    r'|個人ダメージ報酬|个人伤害奖励|個人傷害獎勵|개인\s*피해\s*보상',
    re.IGNORECASE,
)
# Vault Trap's per-row leaderboard label ("Damage Points: {int}"), used to
# corroborate that OCR text is the Damage Rankings page even when there's no
# bracketed alliance tag to count (Vault Trap rows have none -- see
# _is_ranking_page below).
_DAMAGE_POINTS_ROW_RE = re.compile(r'Damage\s+Points\s*:', re.IGNORECASE)
# Vault Trap's column-header row ("Rank Damage Points"), which sits between
# the page title and the first player row on every screenshot. Unlike
# bracket-tagged mail-style rows -- where the per-row tag strip (below) isolates the
# name -- Vault Trap ranking rows have no tag to strip against, so without skipping
# past this header explicitly, the whole header sentence ends up glued onto
# rank 1's name (e.g. "Solo Damage Rewards Rank Damage Points LTC"), which
# is long enough to get rejected outright by the >8-token chunk filter
# further down, or -- if it survives that -- scores nowhere near any real
# roster member and either goes unmatched or (worse) falls through to the
# alias-fuzzy fallback, which can land on an unrelated member.
_RANK_COLUMN_HEADER_RE = re.compile(r'Rank\s+Damage\s+Points', re.IGNORECASE)
# Vault Trap's operation/wave number, from "In Vault Trap {N}, you earned...".
# Repurposes the `trap_number` field -- a legacy name with no matching
# Police Chief mechanic -- for the one
# numeric field the reference doc actually confirms exists in the mail text.
_VAULT_TRAP_WAVE_RE = re.compile(r'In\s+Vault\s+Trap\s+(\d+)', re.IGNORECASE)
# Ranking-page keyword. Police Chief's header is plural ("Damage Rankings");
# `s?` on the "damage"-prefixed alternative covers both it and the singular
# "Damage Ranking". The bare fallback stays singular-only
# ("ranking", not "rankings") because broadening it to also accept a bare
# plural risks matching a stray "Rankings" elsewhere in the OCR text, which
# could shift the parse start position -- a bare "damage rankings" doesn't
# risk that.
_RANKING_KW_RE = re.compile(r'(?i)\b(?:damage\s+rankings?|ranking)\b')
# Localized "Rallies: N" markers — preferred extraction when present.
_RALLIES_MARKER_RE = re.compile(
    r'(?:Rallies|Rally|集結回数|集結次數|集结次数|집결\s*횟수|الحشود|Сборы)'
    r'\s*[:：]?\s*(\d+)',
    re.IGNORECASE,
)
_BARE_SMALL_INT_RE = re.compile(r'(?<![\d,\.])\b\d{1,3}\b(?![\d,\.])')
# Ranking-page title, e.g. "Trap 2 Damage Rewards".
_REWARDS_TRAP_RE = re.compile(r'Trap\s*(\d)\s*Damage', re.IGNORECASE)
# Alliance tag: exactly 3 alphanumerics in brackets. Fixed in-game, so a name's
# own brackets won't match.
_ALLIANCE_TAG_RE = re.compile(r'\[[A-Za-z0-9]{3}\]')
# Trailing "Damage Points" label (\s* also catches a glued "DamagePoints").
_ROW_LABEL_SUFFIX_RE = re.compile(r'(?i)\s*(?:damage\s*points|damage|points)\s*:?\s*$')
# Leading <=3-char tokens (a bracket-less alliance tag or label leak) before a real 4+ char name.
# Only meaningful on mail-style rows, which carry a per-row alliance
# tag with no brackets to strip on (parse_player_rows only applies this when
# `not is_ranking`). Vault Trap's ranking page has no per-row tag at all, so
# applying this there mistakes a genuine short leading *word* of a real name
# -- e.g. "XXX" in "XXX TARGET" -- for tag/label noise and eats it.
_LEADING_SHORT_TOKEN_RE = re.compile(r'^(?:\S{1,3}\s+)+(?=\S{4,})')
_HUNT_DATE_RE = re.compile(r'\b(\d{4})-(\d{2})-(\d{2})')
_EXPIRES_MARKER_RE = re.compile(
    r'Expire[sd]?|期限|有効期限|만료|تنتهي|Истекает',
    re.IGNORECASE,
)


def extract_hunt_date(text: str) -> str | None:
    """Earliest valid YYYY-MM-DD that appears before any expiry marker.
    Returns None when only expiry-side dates exist."""
    expiry = _EXPIRES_MARKER_RE.search(text)
    scan_text = text[:expiry.start()] if expiry else text
    dates = []
    for y, m, d in _HUNT_DATE_RE.findall(scan_text):
        try:
            yi, mi, di = int(y), int(m), int(d)
        except ValueError:
            continue
        if 2020 <= yi <= 2099 and 1 <= mi <= 12 and 1 <= di <= 31:
            dates.append((yi, mi, di))
    if not dates:
        return None
    yi, mi, di = min(dates)
    return f"{yi:04d}-{mi:02d}-{di:02d}"


def _last_ranking_kw(text: str):
    """Last occurrence of the ranking-page keyword, or None. A personal-summary
    sentence can mention "(Damage) ranking" once in prose (e.g. "Damage
    ranking: 2, including 5,478,372,858 expert
    points.") before the actual
    list page header repeats the word right above the row list -- taking the
    LAST match lands on the real header instead of the prose mention (using
    the first match here previously misdirected the parse start into the
    summary sentence instead of the list)."""
    matches = list(_RANKING_KW_RE.finditer(text))
    return matches[-1] if matches else None


def _is_ranking_page(text: str, ranking_kw_match=None) -> bool:
    """True if `text` is the paginated Damage Rankings leaderboard rather than
    the Battle Overview / Solo Damage Rewards summary page. The previous
    format's rows carry a bracketed alliance tag per row (_ALLIANCE_TAG_RE) or a "Trap N Damage"
    page title (_REWARDS_TRAP_RE); Vault Trap's rows have neither (no visible
    alliance tag -- see docs/ocr-reference/vault_trap.md), so corroborate the
    "(Damage) Ranking(s)" keyword with a "Damage Points:" row label that
    follows it instead (searched only *after* the keyword, not anywhere in
    the text, so an earlier unrelated "Damage Points" mention can't falsely
    corroborate a stray "ranking" match earlier in the same text)."""
    if len(_ALLIANCE_TAG_RE.findall(text)) >= 3 or _REWARDS_TRAP_RE.search(text):
        return True
    kw = ranking_kw_match if ranking_kw_match is not None else _last_ranking_kw(text)
    return bool(kw) and bool(_DAMAGE_POINTS_ROW_RE.search(text, kw.end()))


def extract_vault_hunt_stats(text: str):
    """Returns (trap_number_str, rallies_str, total_damage_int). trap_number
    is repurposed for Vault Trap as the operation/wave number extracted from
    "In Vault Trap {N}, you earned..." (_VAULT_TRAP_WAVE_RE) -- see that
    regex's comment for why. The original bracket-based extraction stays as a
    fallback (harmless no-op against Police Chief OCR text, which has no
    brackets)."""
    wave_match = _VAULT_TRAP_WAVE_RE.search(text)
    title_match = _REWARDS_TRAP_RE.search(text)
    trap_match = _BRACKETED_TRAP_RE.search(text)
    if wave_match:
        trap_number = wave_match.group(1)
    elif title_match:
        trap_number = title_match.group(1)
    elif trap_match:
        trap_number = trap_match.group(1) or trap_match.group(2)
    else:
        m = _HEADERLESS_TRAP_RE.search(text)
        trap_number = m.group(1) if m else ""

    # Ranking pages have no alliance-total/rallies line — don't let max() take
    # the top player's damage as the total.
    if _is_ranking_page(text):
        return trap_number, "", 0

    # Total damage dwarfs any per-player damage, so max() works.
    number_runs = list(_FORMATTED_NUMBER_RE.finditer(text))
    if number_runs:
        total_damage = max(int(re.sub(r'[^\d]', '', m.group(0))) for m in number_runs)
    else:
        total_damage = 0

    marker = _RALLIES_MARKER_RE.search(text)
    if marker and marker.group(1) != "0":
        rallies = marker.group(1)
    else:
        pre_damage = text[:number_runs[0].start()] if number_runs else text
        candidates = [
            c for c in _BARE_SMALL_INT_RE.findall(pre_damage)
            if len(c) >= 2 and int(c) > 0
        ]
        rallies = candidates[-1] if candidates else ""

    return trap_number, rallies, total_damage


def find_ranking_section_start(text: str):
    """Index where the rank list starts, or None when the image is a
    summary (no rank list to parse — caller must skip row extraction)."""
    ranking_kw = _last_ranking_kw(text)
    # Ranking pages carry a tag per row, breaking the "after the last ]"
    # heuristic. Fallback engines often drop the brackets, so also detect the
    # page by its "Damage Ranking(s)" title and start at the ranking header.
    if ranking_kw and _is_ranking_page(text, ranking_kw):
        start = ranking_kw.end()
        # Skip past the "Rank Damage Points" column header too, when it
        # follows shortly after (it always does on Vault Trap's ranking
        # page) -- otherwise it gets glued onto rank 1's name. Bounded
        # proximity check so a coincidental later occurrence deep in the
        # row list can't wrongly swallow real rows.
        header = _RANK_COLUMN_HEADER_RE.search(text, start)
        if header and header.start() - start < 60:
            start = header.end()
        return start
    last_bracket = text.rfind(']')
    if last_bracket != -1:
        tail = text[last_bracket + 1:]
        if len(_FORMATTED_NUMBER_RE.findall(tail)) >= 3:
            return last_bracket + 1
        return None
    # A personal-rewards-only summary has no list; a ranking page shows that tab
    # label too, so only skip when no ranking list is present.
    if _PERSONAL_REWARDS_RE.search(text) and not ranking_kw:
        return None
    if ranking_kw:
        return ranking_kw.end()
    return 0


def _leading_rank(chunk: str):
    """The bare 1-2 digit rank badge at the start of a row chunk, or None."""
    m = re.match(r'\s*(\d{1,2})(?!\d)', chunk)
    return int(m.group(1)) if m else None


def drop_pinned_trailing_row(chunks: list, damages: list, is_ranking: bool) -> None:
    """Ranking panels pin the viewer's own row at the bottom out of rank
    order; drop it (mutating `chunks`/`damages` in place) when its rank
    confirms the break (unreadable rank stays). Not confirmed to happen in
    Vault Trap's UI, but harmless if it never fires there -- it only acts
    when two consecutive leading rank digits disagree with ascending order.

    Extracted as a free function (originally inline in `parse_player_rows`)
    so other ranking-page row parsers (e.g. Capitol War's Honor Roll, which
    has the exact same pinned-own-row mechanic -- see
    docs/ocr-reference/capitol_war.md) reuse this exact, already-proven
    dedup instead of re-deriving it -- see tests/test_vault_pinned_row.py."""
    if is_ranking and len(chunks) >= 2:
        last_rank, prev_rank = _leading_rank(chunks[-1]), _leading_rank(chunks[-2])
        if last_rank is not None and prev_rank is not None and last_rank <= prev_rank:
            chunks.pop()
            damages.pop()


def parse_player_rows(text: str, after_pos: int = None):
    """Parse the damage-ranking section into [(name, damage, rank), ...].
    Names keep OCR noise — fuzzy resolution happens in the UI layer."""
    if after_pos is None:
        after_pos = find_ranking_section_start(text)
    if after_pos is None:
        return []
    tail = text[after_pos:]
    matches = list(_FORMATTED_NUMBER_RE.finditer(tail))
    if not matches:
        return []

    chunks, damages = [], []
    prev_end = 0
    for m in matches:
        chunks.append(tail[prev_end:m.start()])
        damages.append(int(re.sub(r'[^\d]', '', m.group(0))))
        prev_end = m.end()

    # Drop the "[Vault Trap # N]" section header from the first chunk.
    chunks[0] = re.sub(r'^.*\][^A-Za-z]*', '', chunks[0], count=1)
    # Strip the "Damage Points" suffix; \s* also catches a glued "DamagePoints".
    for i, c in enumerate(chunks):
        chunks[i] = _ROW_LABEL_SUFFIX_RE.sub('', c).rstrip()

    # Strip the per-row alliance tag so rows aren't dropped by the bracket filter.
    for i, c in enumerate(chunks):
        c = _ALLIANCE_TAG_RE.sub(' ', c)
        # Fallback OCR garbles the ']' into a letter, gluing the 3-char tag onto a
        # non-Latin name ("[CATI旭東興業"). Strip [ + 3 tag chars + the garbled ].
        c = re.sub(r'^\s*\[[A-Za-z0-9]{3}[A-Za-z]?(?=[^\x00-\x7F])', '', c)
        chunks[i] = c

    is_ranking = _is_ranking_page(text)
    drop_pinned_trailing_row(chunks, damages, is_ranking)

    valid = [i for i, c in enumerate(chunks) if not re.search(r'[.?\[\]]', c)]
    if 0 in valid and len(chunks[0].split()) > 8:
        valid.remove(0)

    for _ in range(4):
        stripped = _strip_common_trailing_token([chunks[i] for i in valid])
        if stripped == [chunks[i] for i in valid]:
            break
        for idx, new_c in zip(valid, stripped):
            chunks[idx] = new_c

    def _name_token_count(c):
        return sum(1 for t in c.split() if not re.fullmatch(r'\d{1,2}', t))

    # On the mail, chunk[0] still carries header words before the first name;
    # trim leading tokens to match the others. Skip on ranking pages, where the
    # tag strip already isolated the name (trimming would eat a multi-word name
    # like "Numb Little Bug" down to its last token).
    if 0 in valid and len(valid) > 1 and not is_ranking:
        other_counts = [_name_token_count(chunks[i]) for i in valid if i != 0]
        target = max(min(c for c in other_counts if c) if any(other_counts) else 1, 1)
        first_tokens = chunks[0].split()
        while _name_token_count(' '.join(first_tokens)) > target:
            first_tokens.pop(0)
        chunks[0] = ' '.join(first_tokens)

    rows = []
    for i in valid:
        chunk = chunks[i]
        rank = None
        rank_m = re.search(r'(?<!\S)(\d{1,2})(?!\S)', chunk)
        if rank_m:
            rank = int(rank_m.group(1))
            chunk = (chunk[:rank_m.start()] + ' ' + chunk[rank_m.end():])
        name = re.sub(r'\s+', ' ', chunk).strip()
        # Strip leading ≤3-char tokens (label leak from previous row's
        # "Damage Points:") when followed by a real 4+ char name. Only on
        # non-ranking (mail-format) rows -- Vault Trap's ranking-page rows
        # have no bracket-less tag to leak, so a short first *word* of a
        # real name (e.g. "XXX" in "XXX TARGET") would otherwise be wrongly
        # treated as tag/label noise and stripped.
        if not is_ranking:
            name = _LEADING_SHORT_TOKEN_RE.sub('', name)
        # Blank when chunk is mostly non-letters (status-bar leak).
        if sum(c.isalpha() for c in name) < 3:
            name = ''
        # `rank_explicit` marks a rank digit OCR actually found in this chunk,
        # as opposed to one filled in below by the top-3 sequential-guess
        # fallback -- callers doing rank-sequence validation (gaps/duplicates)
        # should only trust explicit reads, not synthesized guesses.
        rows.append({'name': name, 'damage': damages[i], 'rank': rank,
                     'rank_explicit': rank is not None})

    # Judgment call (Vault Trap has no confirmed digit-badge for its top 3):
    # ranks 1-3 render as medal badges rather than plain digits on the Damage
    # Rankings page (docs/ocr-reference/vault_trap.md), so OCR finds no
    # standalone rank digit for those rows and `rank` stays None above. Rows
    # are already in on-screen (damage-descending) order, so infer a missing
    # rank as one past the last known rank, starting from 1. A misread digit
    # elsewhere in the sequence can drift this -- accepted as reasonable OCR
    # noise tolerance rather than a hard guarantee.
    if is_ranking:
        expected = 1
        for row in rows:
            if row['rank'] is None:
                row['rank'] = expected
            expected = row['rank'] + 1
    return rows


def _better_row(existing, candidate, roster=None) -> bool:
    """Cross-image merge tiebreaker for rows sharing a damage value.
    Order: name presence > roster score > rank info > name length."""
    e_name = existing.get('name') or ''
    c_name = candidate.get('name') or ''
    if not e_name and c_name:
        return True
    if e_name and not c_name:
        return False

    if roster and e_name and c_name:
        e_cands = match_roster(e_name, roster)
        c_cands = match_roster(c_name, roster)
        e_score = e_cands[0][2] if e_cands else 0
        c_score = c_cands[0][2] if c_cands else 0
        if c_score != e_score:
            return c_score > e_score

    if existing.get('rank') is None and candidate.get('rank') is not None:
        return True
    if existing.get('rank') is not None and candidate.get('rank') is None:
        return False

    if e_name and c_name and len(c_name) > len(e_name) + 2:
        return True
    return False


MATCH_AUTO_CONFIRM = 90
MATCH_LIKELY_MIN = 80
MATCH_AMBIGUOUS_DELTA = 5
MATCH_HISTORY_PENALTY = 15  # subtracted from scores for opt-in historical names
MATCH_ALIAS_SCORE = 100      # confidence given to a learned-alias hit (admin-taught)
MATCH_ALIAS_FUZZY_MIN = 92   # min similarity to reuse a stored alias key when OCR drifts
# WRatio's partial-ratio component scores a confident match whenever a
# short/garbled string happens to align well against a *substring* of a
# longer one (or vice versa) -- exactly what alias_lookup's fuzzy pass wants
# for genuine single-screenshot OCR drift on an *already-taught* key, but it
# also means a long, structurally unrelated string (e.g. leaked page-header
# text ahead of a name) can score ≥MATCH_ALIAS_FUZZY_MIN against a short,
# coincidentally-overlapping stored key. A stored alias's WRatio hit must
# also clear this bar on a corroborating scorer, `fuzz.token_sort_ratio`
# (no partial-ratio leniency), or it's rejected. Deliberately NOT applied to
# match_roster's own WRatio match against real roster names -- real garbled
# OCR names in production regularly need long-vs-short partial-ratio
# leniency to resolve at all (e.g. a decorated name half-buried in noise
# scores ~55 on token_sort_ratio while still being the unambiguously correct
# match), so tightening it there rejects real matches without actually
# preventing the false ones, which fail well below MATCH_LIKELY_MIN anyway
# once the row text itself is clean (see the parse_player_rows fixes above).
MATCH_COROBORATION_MIN = 55


# Default initialised above (DEFAULT_OCR_LANG) before RapidOCR import.
OCR_LANGUAGES = [
    ("en",          "Latin only (default — English/French/German/etc, fastest)"),
    ("ch",          "Multilingual (Latin + Simplified Chinese)"),
    ("japan",       "Japanese"),
    ("korean",      "Korean"),
    ("chinese_cht", "Traditional Chinese"),
    ("latin",       "Latin Extended"),
    ("arabic",      "Arabic"),
    ("cyrillic",    "Cyrillic (Russian, etc.)"),
    ("devanagari",  "Devanagari (Hindi, etc.)"),
]
OCR_LANG_CODES = {code for code, _label in OCR_LANGUAGES}
OCR_LANG_LABEL = dict(OCR_LANGUAGES)

# Useful fallback runs per image — skipped/rejected ones don't count.
MAX_FALLBACK_ATTEMPTS = 4
# Serialize OCR on low-mem boxes so two inference spikes can't overlap.
MAX_CONCURRENT_OCR = 1 if onnx_lifecycle.LOW_MEM_MODE else 2

_ocr_semaphore: asyncio.Semaphore | None = None


def _get_ocr_semaphore() -> asyncio.Semaphore:
    # Lazy: no asyncio loop at import time.
    global _ocr_semaphore
    if _ocr_semaphore is None:
        _ocr_semaphore = asyncio.Semaphore(MAX_CONCURRENT_OCR)
    return _ocr_semaphore

# Latin-only recognition models.
_LATIN_ONLY_LANGS = {"en", "latin"}

# Unicode ranges each language's recognition model is supposed to produce.
_LANG_UNICODE_RANGES = {
    "arabic":      [(0x0600, 0x06FF), (0x0750, 0x077F)],
    "cyrillic":    [(0x0400, 0x04FF), (0x0500, 0x052F)],
    "devanagari":  [(0x0900, 0x097F)],
    "japan":       [(0x3040, 0x309F), (0x30A0, 0x30FF), (0x4E00, 0x9FFF)],
    "korean":      [(0xAC00, 0xD7A3), (0x1100, 0x11FF)],
    "chinese_cht": [(0x4E00, 0x9FFF), (0x3400, 0x4DBF)],
}


def _output_matches_lang_script(text: str, lang: str) -> bool:
    """True when `text` has any char in `lang`'s expected Unicode range.
    Latin/`ch` engines aren't filtered (no range to check against)."""
    ranges = _LANG_UNICODE_RANGES.get(lang)
    if not ranges:
        return True
    return any(any(lo <= ord(c) <= hi for lo, hi in ranges) for c in text)


_RTL_RANGES = [(0x0590, 0x08FF), (0xFB1D, 0xFDFF), (0xFE70, 0xFEFF)]
_RTL_LANGS = {"arabic"}


def _has_rtl(text: str) -> bool:
    return any(any(lo <= ord(c) <= hi for lo, hi in _RTL_RANGES) for c in text)


def _extract_script_substrings_with_pos(text: str, lang: str, *, min_script_chars: int = 2) -> list:
    """Like `_extract_script_substrings` but returns `(substring, start_pos)`
    tuples so callers can position-align substrings to row anchors.
    """
    ranges = _LANG_UNICODE_RANGES.get(lang)
    if not ranges:
        return []

    def _in_script(c):
        return any(lo <= ord(c) <= hi for lo, hi in ranges)

    char_class = ''.join(f'\\u{lo:04X}-\\u{hi:04X}' for lo, hi in ranges)
    pattern = re.compile(f'[{char_class}\\s]+', re.UNICODE)
    out, seen = [], set()
    for m in pattern.finditer(text):
        s = m.group(0).strip()
        if not s:
            continue
        if sum(1 for c in s if _in_script(c)) < min_script_chars:
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append((s, m.start()))
    return out


def _reverse_for_rtl(text: str, lang: str) -> str:
    """Arabic OCR emits chars in visual order, reversing the logical order
    relative to API-stored roster nicknames. Reverse the full string to
    recover logical (and word) order so fuzzy match against the roster
    works. Non-RTL languages pass through unchanged.
    """
    if lang in _RTL_LANGS and text:
        return text[::-1]
    return text


try:
    import arabic_reshaper as _arabic_reshaper
    from bidi.algorithm import get_display as _bidi_get_display
    _RESHAPE_AVAILABLE = True
except ImportError:
    _arabic_reshaper = None
    _bidi_get_display = None
    _RESHAPE_AVAILABLE = False
    logger.warning("arabic-reshaper / python-bidi not installed — RTL names will render in logical order.")


def _ltr_line(text) -> str:
    """Prepend LRM so Discord left-aligns lines containing RTL chars."""
    if not text:
        return text or ""
    return "‎" + text if _has_rtl(text) else text


def _isolate_rtl(text: str) -> str:
    """Wrap RTL chars in FSI…PDI so they can't reorder surrounding tokens."""
    if not text or not _has_rtl(text):
        return text or ""
    return f"⁨{text}⁩"


def _reshape_for_chart(text) -> str:
    """Shape Arabic for matplotlib (which doesn't run bidi itself).
    Discord uses `_ltr_line` instead — it shapes Arabic natively."""
    if not text or not _RESHAPE_AVAILABLE:
        return text or ""
    if not _has_rtl(text):
        return text
    try:
        return _bidi_get_display(_arabic_reshaper.reshape(text))
    except Exception:
        return text


# Per-language LazyOnnxModel registry. Engines load on demand and unload after
# the configured grace period (set in onnx_lifecycle).
_OCR_MODELS: dict[str, "onnx_lifecycle.LazyOnnxModel"] = {}

# Short labels shown in the Bot Health dashboard. Kept compact so they fit
# in the narrow column-layout fields without wrapping.
_OCR_LANG_DISPLAY = {
    "en": "EN",
    "ch": "CH",
    "japan": "JA",
    "korean": "KO",
    "chinese_cht": "ZH-Hant",
    "latin": "Latin",
    "arabic": "AR",
    "cyrillic": "CY",
    "devanagari": "DV",
}

# Per-language footprint, measured empirically on Windows with onnxruntime.
# `ram` is resident memory growth when the engine is loaded; `disk` is the
# on-disk model size. Both are approximate.
_OCR_LANG_FOOTPRINT_MB = {
    "en":          {"ram": 35, "disk": 7},
    "ch":          {"ram": 28, "disk": 15},
    "japan":       {"ram": 26, "disk": 9},
    "korean":      {"ram": 47, "disk": 23},
    "chinese_cht": {"ram": 33, "disk": 11},
    "latin":       {"ram": 27, "disk": 9},
    "arabic":      {"ram": 31, "disk": 7},
    "cyrillic":    {"ram": 20, "disk": 9},
    "devanagari": {"ram": 30, "disk": 7},
}


def get_ocr_model(lang: str):
    """Return the LazyOnnxModel for `lang`, falling back to the default if the
    code is unknown. Returns None when RapidOCR isn't available at all."""
    if not OCR_AVAILABLE:
        return None
    if lang not in OCR_LANG_CODES:
        lang = DEFAULT_OCR_LANG
    cached = _OCR_MODELS.get(lang)
    if cached is not None:
        return cached

    label = _OCR_LANG_DISPLAY.get(lang, lang)

    def _factory(lang_code=lang):
        return RapidOCR(params={
            "Rec.lang_type": LangRec(lang_code),
            "EngineConfig.onnxruntime.intra_op_num_threads": OCR_NUM_THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": OCR_NUM_THREADS,
        })

    model = onnx_lifecycle.get_or_create(
        name=f'vault_track:{lang}',
        display_name=f'Vault Trap OCR ({label})',
        factory=_factory,
    )
    _OCR_MODELS[lang] = model
    return model


def _ocr_image_with_engine(image_bytes: bytes, engine) -> str:
    """Sync OCR call against an already-loaded engine. Returns space-joined
    text or "". Pulled out so async callers can dispatch via to_thread."""
    if engine is None or not image_bytes:
        return ""
    with Image.open(io.BytesIO(image_bytes)) as src:
        image = src.convert('RGB')
    try:
        if max(image.size) > MAX_OCR_DIM:
            image.thumbnail((MAX_OCR_DIM, MAX_OCR_DIM), Image.LANCZOS)
        result = engine(np.array(image))
    finally:
        image.close()
    if not result:
        return ""
    if hasattr(result, 'txts') and result.txts:
        return " ".join(result.txts)
    if hasattr(result, '__iter__'):
        texts = [str(item[1]) for item in result
                 if isinstance(item, (list, tuple)) and len(item) >= 2]
        return " ".join(texts) if texts else str(result)
    return str(result)


async def _maybe_breathe():
    """On low-memory (usually CPU-throttled) boxes, yield briefly so the event
    loop can send Discord heartbeats between CPU-heavy OCR passes."""
    if onnx_lifecycle.LOW_MEM_MODE:
        await asyncio.sleep(_LOW_MEM_OCR_PAUSE)


_remote_ocr_session: "aiohttp.ClientSession | None" = None


def _get_remote_session() -> "aiohttp.ClientSession":
    """Lazily create the shared aiohttp session used for external OCR posts."""
    global _remote_ocr_session
    if _remote_ocr_session is None or _remote_ocr_session.closed:
        _remote_ocr_session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=OCR_REMOTE_TIMEOUT)
        )
    return _remote_ocr_session


async def close_remote_ocr_session() -> None:
    """Close the shared external-OCR session. Called from the cog's unload."""
    global _remote_ocr_session
    if _remote_ocr_session is not None and not _remote_ocr_session.closed:
        await _remote_ocr_session.close()
    _remote_ocr_session = None


async def _remote_ocr_post(path: str, image_bytes: bytes, lang: str):
    """POST an image to the external OCR service. Returns parsed JSON, or None on
    any failure so the caller falls back to the local engine."""
    base = remote_ocr_url()
    if not base:
        return None
    headers = {"X-API-Key": OCR_REMOTE_TOKEN}
    try:
        form = aiohttp.FormData()
        form.add_field("lang", lang)
        form.add_field("image", image_bytes, filename="image",
                       content_type="application/octet-stream")
        async with _get_remote_session().post(f"{base}{path}", data=form, headers=headers) as resp:
            if resp.status != 200:
                logger.warning(f"External OCR {path} HTTP {resp.status}; using local OCR.")
                return None
            return await resp.json()
    except Exception as e:
        logger.warning(f"External OCR {path} failed ({e}); using local OCR.")
        return None


async def _remote_ocr_text(image_bytes: bytes, lang: str):
    """Remote /ocr -> space-joined text, or None to fall back to local."""
    data = await _remote_ocr_post("/ocr", image_bytes, lang)
    if data is None:
        return None
    text = data.get("text")
    return text if isinstance(text, str) else ""


async def _remote_ocr_boxed(image_bytes: bytes, lang: str):
    """Remote /ocr/boxes -> [(text, box), ...], or None to fall back to local."""
    data = await _remote_ocr_post("/ocr/boxes", image_bytes, lang)
    if data is None:
        return None
    results = data.get("results")
    if not isinstance(results, list):
        return []
    return [(item["text"], item.get("box")) for item in results
            if isinstance(item, dict) and isinstance(item.get("text"), str)]


async def ocr_bytes(image_bytes: bytes, lang: str = DEFAULT_OCR_LANG, *, session=None) -> str:
    """OCR `image_bytes` → space-joined text, or "" on failure.

    If `session` is given, the engine is acquired via the session (warm reuse
    across multiple OCR calls in one vault session). Otherwise this falls back
    to a one-shot acquire/release covered by the lifecycle grace period."""
    if not image_bytes:
        return ""
    if remote_ocr_url():
        remote = await _remote_ocr_text(image_bytes, lang)
        if remote is not None:
            return remote
    if not OCR_AVAILABLE:
        return ""
    model = get_ocr_model(lang)
    if model is None:
        return ""
    if session is not None:
        engine = await session._ensure_engine(lang)
        if engine is None:
            return ""
        result = await asyncio.to_thread(_ocr_image_with_engine, image_bytes, engine)
    else:
        async with model.use() as engine:
            result = await asyncio.to_thread(_ocr_image_with_engine, image_bytes, engine)
    await _maybe_breathe()
    return result


def _ocr_image_with_engine_boxed(image_bytes, engine) -> list:
    """Sync OCR call that preserves bounding boxes. Returns [(text, box), ...]
    where box is a list of 4 [x, y] corner coords. Empty list on failure or
    when the engine returned an unrecognised result format."""
    if engine is None or not image_bytes:
        return []
    with Image.open(io.BytesIO(image_bytes)) as src:
        image = src.convert('RGB')
    try:
        if max(image.size) > MAX_OCR_DIM:
            image.thumbnail((MAX_OCR_DIM, MAX_OCR_DIM), Image.LANCZOS)
        result = engine(np.array(image))
    finally:
        image.close()
    if not result:
        return []
    # Newer RapidOCR returns an object with .txts and .boxes parallel lists.
    if hasattr(result, 'txts') and hasattr(result, 'boxes') and result.txts:
        return list(zip([str(t) for t in result.txts], list(result.boxes)))
    # Older iterable API: (box, text) or (box, text, score) per item.
    if hasattr(result, '__iter__'):
        out = []
        for item in result:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                out.append((str(item[1]), item[0]))
        return out
    return []


def _box_y_bounds(box):
    """(y_top, y_bottom, y_center, x_left) for a 4-corner box, or None."""
    try:
        pts = list(box)
        if len(pts) < 4:
            return None
        ys = [float(p[1]) for p in pts]
        xs = [float(p[0]) for p in pts]
    except (TypeError, ValueError, IndexError):
        return None
    y_top, y_bottom = min(ys), max(ys)
    return y_top, y_bottom, (y_top + y_bottom) / 2.0, min(xs)


def _boxed_rows(boxed_tokens, y_tol_ratio: float = 0.6):
    """Cluster [(text, box), ...] into rows by Y. Each row:
    {'y_center','y_top','y_bottom','tokens':[(text, x_left), ...]}."""
    items = []
    heights = []
    for text, box in boxed_tokens:
        b = _box_y_bounds(box)
        if b is None or not str(text).strip():
            continue
        y_top, y_bottom, y_center, x_left = b
        items.append((y_center, y_top, y_bottom, x_left, str(text)))
        heights.append(y_bottom - y_top)
    if not items:
        return []
    items.sort(key=lambda it: it[0])  # by y_center
    med_h = sorted(heights)[len(heights) // 2] or 1.0
    band = med_h * y_tol_ratio
    rows = []
    cur = None
    for y_center, y_top, y_bottom, x_left, text in items:
        if cur is not None and abs(y_center - cur["y_center"]) <= band:
            cur["_toks"].append((x_left, text))
            cur["y_top"] = min(cur["y_top"], y_top)
            cur["y_bottom"] = max(cur["y_bottom"], y_bottom)
            # running mean keeps the band centered as tokens accrete
            cur["y_center"] = (cur["y_top"] + cur["y_bottom"]) / 2.0
        else:
            cur = {"y_center": y_center, "y_top": y_top, "y_bottom": y_bottom,
                   "_toks": [(x_left, text)]}
            rows.append(cur)
    for r in rows:
        r["tokens"] = [(t, x) for x, t in sorted(r.pop("_toks"))]
    return rows


def _y_overlap(a, b) -> float:
    """Vertical overlap in pixels between two row dicts (0 if disjoint)."""
    return max(0.0, min(a["y_bottom"], b["y_bottom"]) - max(a["y_top"], b["y_top"]))


def _align_rows_by_y(primary_rows, fallback_rows):
    """Pair each primary row to its best Y-overlapping fallback row (each
    fallback used once). Returns [(p_row, fb_row|None), ...] in primary order."""
    used = set()
    pairs = []
    for p in primary_rows:
        best_i, best_ov = None, 0.0
        for i, f in enumerate(fallback_rows):
            if i in used:
                continue
            ov = _y_overlap(p, f)
            if ov > best_ov:
                best_i, best_ov = i, ov
        if best_i is None:
            pairs.append((p, None))
        else:
            used.add(best_i)
            pairs.append((p, fallback_rows[best_i]))
    return pairs


async def ocr_bytes_with_boxes(image_bytes: bytes, lang: str = DEFAULT_OCR_LANG,
                               *, session=None) -> list:
    """OCR returning [(text, box), ...]. Box is 4 corner coords. Empty list on failure."""
    if not image_bytes:
        return []
    if remote_ocr_url():
        remote = await _remote_ocr_boxed(image_bytes, lang)
        if remote is not None:
            return remote
    if not OCR_AVAILABLE:
        return []
    model = get_ocr_model(lang)
    if model is None:
        return []
    if session is not None:
        engine = await session._ensure_engine(lang)
        if engine is None:
            return []
        result = await asyncio.to_thread(_ocr_image_with_engine_boxed, image_bytes, engine)
    else:
        async with model.use() as engine:
            result = await asyncio.to_thread(_ocr_image_with_engine_boxed, image_bytes, engine)
    await _maybe_breathe()
    return result


async def ocr_rows_with_fallback(image_bytes: bytes, *, primary_lang: str,
                                 fallback_langs, parse, is_unfilled, merge,
                                 session=None, primary_text: str | None = None,
                                 progress_callback=None):
    """Generic primary+fallback OCR loop, shared across OCR features.

    Runs the primary engine, then — only if some parsed rows are still unread —
    retries each fallback-language engine, validating the output is actually in
    that script, de-duping identical passes, reversing RTL, and stopping on the
    budget or once everything's filled. The caller supplies the domain bits:
      parse(text) -> rows ; is_unfilled(row) -> bool ;
      merge(primary_rows, fallback_rows, fb_text, lang) -> mutate primary_rows.
    Returns (primary_rows, primary_text). Vault/attendance plug in their own
    parse/match/merge; the orchestration lives here once.
    """
    # Reuse a primary read the caller already has (Foundry/Canyon does a boxed
    # pass for the scoreboard) so the primary engine isn't run twice per image.
    if progress_callback and primary_text is None:
        await progress_callback('ocr', primary_lang)
    primary_boxed = None
    if primary_text is not None:
        text = primary_text
    else:
        primary_boxed = await ocr_bytes_with_boxes(image_bytes, lang=primary_lang, session=session)
        text = ' '.join(t for t, _b in primary_boxed)
    if not text.strip():
        return [], ""
    repaired = repair_ocr_digits(text)
    logger.info(f"OCR [{primary_lang}]: {repaired!r}")
    rows = parse(repaired)
    fallback_langs = [l for l in (fallback_langs or []) if l and l != primary_lang]
    if not fallback_langs or not any(is_unfilled(r) for r in rows):
        return rows, text

    seen = {repaired}
    attempts = 0
    for fb in fallback_langs:
        if attempts >= MAX_FALLBACK_ATTEMPTS or not any(is_unfilled(r) for r in rows):
            break
        if progress_callback:
            await progress_callback('fallback', fb)
        try:
            fb_boxed = await ocr_bytes_with_boxes(image_bytes, lang=fb, session=session)
            fb_text = ' '.join(t for t, _b in fb_boxed)
        except Exception as e:
            logger.warning(f"OCR fallback {fb} failed: {e}")
            continue
        if not fb_text.strip():
            continue
        fb_repaired = repair_ocr_digits(fb_text)
        if fb_repaired in seen:
            continue
        seen.add(fb_repaired)
        if not _output_matches_lang_script(fb_repaired, fb):
            logger.info(f"OCR fallback [{fb}] rejected: no {fb}-script chars")
            continue
        attempts += 1
        logger.info(f"OCR fallback [{fb}]: {fb_repaired!r}")
        fb_rows = parse(fb_repaired)
        if fb in _RTL_LANGS:
            for fr in fb_rows:
                if fr.get("name"):
                    fr["name"] = _reverse_for_rtl(fr["name"], fb)
        merge(rows, fb_rows, fb_repaired, fb, primary_boxed=primary_boxed, fb_boxed=fb_boxed)
    return rows, text


def detect_fallback_langs(names, *, primary: str = "en") -> list[str]:
    """Derive the OCR fallback engines an alliance needs from its member names.
    A member's screenshot name is their synced in-game name, so the roster's
    scripts predict exactly which non-Latin engines OCR will need. Greek and
    plain Latin need nothing (homoglyph folding handles decorated Latin)."""
    needed: set[str] = set()
    has_kana = has_hangul = has_han = False
    for name in names:
        for ch in name or "":
            cp = ord(ch)
            if 0x0400 <= cp <= 0x052F:
                needed.add("cyrillic")
            elif 0x0600 <= cp <= 0x077F:
                needed.add("arabic")
            elif 0x0900 <= cp <= 0x097F:
                needed.add("devanagari")
            elif 0xAC00 <= cp <= 0xD7A3 or 0x1100 <= cp <= 0x11FF:
                has_hangul = True
            elif 0x3040 <= cp <= 0x30FF:
                has_kana = True
            elif 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF:
                has_han = True
    if has_hangul:
        needed.add("korean")
    if has_kana:
        needed.add("japan")        # japan engine covers kana + han
    elif has_han:
        needed.add("ch")           # han-only → Simplified (+Latin); cht is a manual override
    needed.discard(primary)
    return sorted(needed)


def auto_managed_fallbacks(alliance_id, names, *, primary: str = "en",
                           db_path: str = "db/alliance.sqlite") -> list[str]:
    """Auto-manage on → derive fallback langs from member names, persisting them
    when the set changes (so the UI/dashboard stay accurate without writing every
    upload). Auto-manage off → the admin's manual fallbacks, untouched. Shared by
    vault + attendance so an alliance's languages are managed in one place."""
    try:
        with sqlite3.connect(db_path, timeout=30.0) as conn:
            row = conn.execute(
                "SELECT vault_ocr_auto_manage, vault_ocr_fallback_langs "
                "FROM alliancesettings WHERE alliance_id = ?", (alliance_id,)).fetchone()
            if not row:
                return []
            auto_manage = row[0] if row[0] is not None else 1
            stored = [c.strip() for c in (row[1] or "").split(",")
                      if c.strip() in OCR_LANG_CODES and c.strip() != primary]
            if not auto_manage:
                return stored
            detected = detect_fallback_langs(names, primary=primary)
            if set(detected) != set(stored):
                conn.execute(
                    "UPDATE alliancesettings SET vault_ocr_fallback_langs = ? "
                    "WHERE alliance_id = ?", (",".join(detected), alliance_id))
                conn.commit()
            return detected
    except Exception as e:
        logger.warning(f"auto_managed_fallbacks failed (alliance {alliance_id}): {e}")
        return []


_SCRIPT_TAGS = (
    ('LATIN',       'latin'),
    ('ARABIC',      'arabic'),
    ('HEBREW',      'arabic'),
    ('CJK',         'cjk'),
    ('HIRAGANA',    'cjk'),
    ('KATAKANA',    'cjk'),
    ('HANGUL',      'cjk'),
    ('CYRILLIC',    'cyrillic'),
    ('GREEK',       'greek'),
    ('DEVANAGARI',  'devanagari'),
    ('THAI',        'thai'),
)


def _script_of(c: str) -> str | None:
    if not c.isalpha():
        return None
    if ord(c) < 0x80:
        return 'latin'
    name = unicodedata.name(c, '')
    for marker, tag in _SCRIPT_TAGS:
        if marker in name:
            return tag
    return 'other'


def _strip_minority_script(name: str, threshold: float = 0.85) -> str:
    """Drop alpha chars from non-dominant scripts when one script holds
    ≥threshold of the alpha mass. Preserves names that are pure or
    legitimately mixed."""
    if not name:
        return name
    counts: dict[str, int] = {}
    for c in name:
        s = _script_of(c)
        if s and s != 'other':
            counts[s] = counts.get(s, 0) + 1
    if len(counts) < 2:
        return name
    total = sum(counts.values())
    dom = max(counts, key=counts.get)
    if counts[dom] / total < threshold:
        return name
    return ''.join(c for c in name if _script_of(c) in (None, dom, 'other'))


# Homoglyph folding. Decorated gamertags swap Latin letters for Greek/Cyrillic
# lookalikes (ROγAL, ĎƐΔΗ). NFKD already handles accents/superscripts/fullwidth;
# this table covers cross-script lookalikes NFKD leaves alone. Comparison only —
# never shown to users.
_CONFUSABLES = {
    # Greek → Latin
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K',
    'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'Δ': 'A', 'Θ': 'O', 'Φ': 'O', 'Ɛ': 'E',
    'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i',
    'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o', 'π': 'n', 'ρ': 'p', 'σ': 'o',
    'τ': 't', 'υ': 'u', 'χ': 'x',
    # Cyrillic → Latin
    'А': 'A', 'В': 'B', 'Е': 'E', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'К': 'K',
    'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y',
    'Ү': 'Y', 'Х': 'X', 'Ԛ': 'Q', 'Ԝ': 'W',
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
    'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i',
    'ј': 'j',
}
_CONFUSABLE_TABLE = {ord(k): v for k, v in _CONFUSABLES.items()}


def _skeleton(s: str) -> str:
    """Fold a name to a Latin-ish skeleton: decompose (NFKD), drop combining
    marks, then map Greek/Cyrillic lookalikes to Latin. For matching only."""
    if not s:
        return s or ""
    decomposed = unicodedata.normalize('NFKD', s)
    no_marks = ''.join(c for c in decomposed if not unicodedata.combining(c))
    return no_marks.translate(_CONFUSABLE_TABLE)


def _fold(s: str) -> str:
    """Canonical comparison/alias-key form: skeleton, lowercased, alnum-only,
    whitespace-collapsed. Doubles as the fuzzy-match processor and the alias key."""
    sk = _skeleton(s or "")
    if RAPIDFUZZ_AVAILABLE:
        return _rf_utils.default_process(sk)
    return re.sub(r'[^a-z0-9]+', ' ', sk.lower()).strip()


def _name_at_date(changes, date_str, current_nick):
    """The name a player had on `date_str`, from their ascending
    (old, new, change_date) history. Falls back to current_nick."""
    if not changes:
        return current_nick
    d = (date_str or "")[:10]
    active = None
    for _old_n, new_n, change_date in changes:
        if (change_date or "")[:10] <= d:
            active = new_n  # name became new_n at/before the date
        else:
            break
    if active is not None:
        return active
    return changes[0][0] or current_nick  # all changes after date → earliest old name


def _roster_parts(entry):
    """A roster entry as (fid, match_name, penalty, display). Accepts the plain
    (fid, nick) 2-tuple or the date-aware (fid, match_name, penalty, display)."""
    fid, match_name = entry[0], entry[1]
    penalty = entry[2] if len(entry) > 2 else 0
    display = entry[3] if len(entry) > 3 else entry[1]
    return fid, match_name, penalty, display


def match_roster(detected_name: str, roster):
    """Top fuzzy matches as [(fid, display_nick, score_0_100), ...], best per fid.

    Roster entries are `(fid, name)` or `(fid, match_name, penalty, display)`;
    the 4-tuple matches against `match_name`, subtracts `penalty`, and returns
    `display` — so historical/date-aware aliases can participate without
    outranking current names. Names with fewer than 3 alpha chars require
    case-insensitive exact equality (else WRatio's partial-ratio lets "G" hit
    100% on anything).
    """
    if not detected_name or not roster or not RAPIDFUZZ_AVAILABLE:
        return []

    best: dict = {}
    if sum(c.isalpha() for c in detected_name) < 3:
        normalized = _fold(detected_name)
        for entry in roster:
            fid, match_name, penalty, display = _roster_parts(entry)
            if _fold(match_name or '') == normalized:
                score = 100 - penalty
                if fid not in best or score > best[fid][2]:
                    best[fid] = (fid, display, score)
        return sorted(best.values(), key=lambda c: -c[2])[:5]

    cleaned = _strip_minority_script(detected_name)
    names = [(_roster_parts(e)[1] or "") for e in roster]
    results = _rf_process.extract(
        cleaned, names,
        scorer=_rf_fuzz.WRatio,
        processor=_fold,
        limit=None, score_cutoff=MATCH_LIKELY_MIN,
    )
    detected_fold = _fold(detected_name)
    for _match_str, score, idx in results:
        fid, match_name, penalty, display = _roster_parts(roster[idx])
        # A 1-2 char roster nickname needs exact equality to match
        if sum(c.isalpha() for c in (match_name or '')) < 3 and _fold(match_name or '') != detected_fold:
            continue
        adj = int(score) - penalty
        if adj < MATCH_LIKELY_MIN:
            continue
        if fid not in best or adj > best[fid][2]:
            best[fid] = (fid, display, adj)
    return sorted(best.values(), key=lambda c: -c[2])[:5]


def classify_match(candidates):
    """Given the output of match_roster, return a status tag for the row.

    'auto'      — best score ≥ AUTO_CONFIRM and not ambiguous
    'likely'    — best score ≥ LIKELY_MIN but below AUTO_CONFIRM
    'ambiguous' — two or more candidates within AMBIGUOUS_DELTA points
    'none'      — no candidates above LIKELY_MIN
    """
    if not candidates:
        return 'none'
    best = candidates[0][2]
    if len(candidates) > 1 and best - candidates[1][2] < MATCH_AMBIGUOUS_DELTA:
        return 'ambiguous'
    return 'auto' if best >= MATCH_AUTO_CONFIRM else 'likely'


def name_match_score(name: str, roster) -> int:
    """Best fuzzy-match score 0-100. Empty name → 0; empty roster → 100."""
    if not name:
        return 0
    if not roster:
        return 100
    cands = match_roster(name, roster)
    return cands[0][2] if cands else 0


def is_row_unfilled(row, roster) -> bool:
    """True when no roster fuzzy-match >= MATCH_LIKELY_MIN."""
    return name_match_score(row.get('name') or '', roster) < MATCH_LIKELY_MIN


def learn_alias(alliance_id, raw_name, fid) -> None:
    """Remember that this alliance's OCR text `raw_name` resolves to `fid`, so a
    decorated name only has to be matched by hand once. No-op for blank/short keys."""
    if not alliance_id or not fid or not raw_name:
        return
    key = _fold(raw_name)
    if len(key) < 2:  # too little signal to key on reliably
        return
    try:
        with sqlite3.connect(VAULT_DB_PATH, timeout=30.0) as conn:
            conn.execute("""
                INSERT INTO vault_name_alias (alliance_id, ocr_key, fid, raw_name, updated_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(alliance_id, ocr_key) DO UPDATE SET
                    fid = excluded.fid,
                    raw_name = excluded.raw_name,
                    updated_at = excluded.updated_at
            """, (int(alliance_id), key, int(fid), raw_name))
    except Exception as e:
        logger.warning(f"Vault Trap OCR: could not learn alias for {raw_name!r}: {e}")


def alias_lookup(alliance_id, detected_name, roster):
    """A learned alias for `detected_name` → (fid, display), or None.
    Exact key first, then a fuzzy pass over this alliance's keys (OCR can drift
    slightly between screenshots). Only returns members still on the roster."""
    if not alliance_id or not detected_name:
        return None
    key = _fold(detected_name)
    if len(key) < 2:
        return None
    roster_fids = {e[0]: e[-1] for e in roster}
    try:
        with sqlite3.connect(VAULT_DB_PATH, timeout=30.0) as conn:
            rows = conn.execute(
                "SELECT ocr_key, fid FROM vault_name_alias WHERE alliance_id = ?",
                (int(alliance_id),)).fetchall()
    except Exception as e:
        logger.warning(f"Vault Trap OCR: alias lookup failed: {e}")
        return None
    for ocr_key, fid in rows:
        if ocr_key == key and fid in roster_fids:
            return fid, roster_fids[fid]
    if RAPIDFUZZ_AVAILABLE and rows:
        keys = [r[0] for r in rows]
        m = _rf_process.extractOne(
            key, keys, scorer=_rf_fuzz.WRatio, score_cutoff=MATCH_ALIAS_FUZZY_MIN)
        # Same WRatio partial-ratio footgun as match_roster: a long garbled
        # string (e.g. leaked page-header text ahead of a real name) can
        # score ≥MATCH_ALIAS_FUZZY_MIN against a short, unrelated stored key
        # purely on substring alignment. Require plain corroboration too.
        if m and _rf_fuzz.token_sort_ratio(key, m[0]) >= MATCH_COROBORATION_MIN:
            fid = rows[m[2]][1]
            if fid in roster_fids:
                return fid, roster_fids[fid]
    return None


def resolve_against_roster(detected_name, roster, alliance_id=None):
    """match_roster, plus a learned-alias fallback. A strong unique direct match
    always wins (collision guard); the alias only fills in when the read alone
    isn't confident. Returns match_roster-shaped candidates."""
    candidates = match_roster(detected_name, roster)
    if alliance_id is None or classify_match(candidates) == 'auto':
        return candidates
    alias = alias_lookup(alliance_id, detected_name, roster)
    if not alias:
        return candidates
    fid, display = alias
    return [(fid, display, MATCH_ALIAS_SCORE)]


def record_ocr_lang_run(alliance_id: int, lang: str, role: str,
                        rows_filled: int) -> None:
    """Bump the (alliance, lang, role) effectiveness counter."""
    if not alliance_id or not lang:
        return
    try:
        with sqlite3.connect(VAULT_DB_PATH, timeout=30.0) as conn:
            conn.execute("""
                INSERT INTO vault_ocr_lang_stats
                    (alliance_id, lang, role, runs, rows_filled, last_run_at)
                VALUES (?, ?, ?, 1, ?, datetime('now'))
                ON CONFLICT(alliance_id, lang, role) DO UPDATE SET
                    runs        = runs + 1,
                    rows_filled = rows_filled + excluded.rows_filled,
                    last_run_at = excluded.last_run_at
            """, (alliance_id, lang, role, rows_filled))
    except Exception as e:
        logger.warning(f"Vault Trap OCR: could not record lang stats ({lang}/{role}): {e}")


def get_ocr_lang_stats(alliance_id: int) -> list[dict]:
    """Per-language effectiveness rows, most-used first."""
    try:
        with sqlite3.connect(VAULT_DB_PATH, timeout=30.0) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("""
                SELECT lang, role, runs, rows_filled, last_run_at
                FROM vault_ocr_lang_stats
                WHERE alliance_id = ?
                ORDER BY runs DESC, lang
            """, (alliance_id,)).fetchall()
            return [dict(r) for r in rows]
    except Exception as e:
        logger.warning(f"Vault Trap OCR: could not read lang stats: {e}")
        return []


def _format_last_used(last_run_at: str | None) -> str:
    """UTC `YYYY-MM-DD HH:MM:SS` → 'today' / 'yesterday' / 'N days ago'."""
    if not last_run_at:
        return "never"
    try:
        last_d = datetime.strptime(last_run_at[:19], "%Y-%m-%d %H:%M:%S").date()
    except (ValueError, TypeError):
        return last_run_at[:10] or "never"
    today = datetime.now(timezone.utc).date()
    delta = (today - last_d).days
    if delta <= 0:
        return "today"
    if delta == 1:
        return "yesterday"
    return f"{delta} days ago"


def _collect_claimed_fids(img_rows: dict, roster: list | None) -> set:
    """Roster fids already auto-confirmed by a row in img_rows."""
    claimed: set = set()
    if roster:
        for r in img_rows.values():
            cands = match_roster(r.get('name') or '', roster)
            if cands and cands[0][2] >= MATCH_AUTO_CONFIRM:
                claimed.add(cands[0][0])
    return claimed


def _row_name_from_tokens(tokens) -> str:
    """Join a row's name tokens, dropping the damage number, its label, and any
    bare number (rank badge or garbled unformatted damage). Keeps OCR noise for
    later fuzzy resolution."""
    parts = []
    for text, _x in tokens:
        t = text.strip()
        if not t:
            continue
        if _FORMATTED_NUMBER_RE.search(t):        # the damage number (+ glued label)
            continue
        if re.fullmatch(r'[\d,\.]+', t):          # bare number: rank badge or garbled damage
            continue
        parts.append(t)
    name = ' '.join(parts)
    name = _ALLIANCE_TAG_RE.sub(' ', name)        # drop clean [xyz] tag if present
    name = re.sub(r'\s+', ' ', name).strip()
    # Match parse_player_rows cleaning: drop the "Damage Points" label and a
    # bracket-less tag leak, so box-align names resolve as well as parser names.
    name = _ROW_LABEL_SUFFIX_RE.sub('', name).rstrip()
    name = _LEADING_SHORT_TOKEN_RE.sub('', name)
    return name.strip()


def _row_damage(tokens):
    """Parse the row's damage from its tokens, or None."""
    for text, _x in tokens:
        m = _FORMATTED_NUMBER_RE.search(text)
        if m:
            return int(re.sub(r'[^\d]', '', m.group(0)))
    return None


def merge_fallback_rows_by_boxes(img_rows, primary_boxed, fb_boxed, roster,
                                 fb_lang: str = "") -> bool:
    """Geometric merge: align primary rows to fallback rows by Y overlap and
    fill each unfilled img_rows[damage] with the aligned fallback name. Never
    uses the fallback's number. Returns True if any row was filled."""
    p_rows = _boxed_rows(primary_boxed)
    f_rows = _boxed_rows(fb_boxed)
    if not p_rows or not f_rows:
        return False
    filled = False
    for p_row, f_row in _align_rows_by_y(p_rows, f_rows):
        if f_row is None:
            continue
        damage = _row_damage(p_row["tokens"])
        existing = img_rows.get(damage) if damage is not None else None
        if not existing or not is_row_unfilled(existing, roster):
            continue
        name = _row_name_from_tokens(f_row["tokens"])
        if fb_lang in _RTL_LANGS and name:
            name = _reverse_for_rtl(name, fb_lang)
        if not name:
            continue
        if name_match_score(name, roster) > name_match_score(existing.get("name") or "", roster):
            existing["name"] = name
            filled = True
            if fb_lang:
                logger.info(f"Vault Trap OCR box-align [{fb_lang}] filled {name!r} for damage {damage}")
    return filled


def merge_fallback_rows_by_damage(img_rows: dict, fb_rows: list,
                                  roster: list | None,
                                  fb_lang: str = "") -> bool:
    """Fill img_rows from fb_rows by matching damage. Skips writes that
    would map a fid already claimed by a different row. Returns True if
    any row was filled."""
    filled = False
    claimed_fids = _collect_claimed_fids(img_rows, roster)
    for fr in fb_rows:
        existing = img_rows.get(fr['damage'])
        if not existing or not fr.get('name'):
            continue
        cands = match_roster(fr['name'], roster) if roster else []
        if cands and cands[0][2] >= MATCH_AUTO_CONFIRM and cands[0][0] in claimed_fids:
            existing_cands = match_roster(existing.get('name') or '', roster) if roster else []
            if not existing_cands or existing_cands[0][0] != cands[0][0]:
                continue
        if name_match_score(fr['name'], roster) > name_match_score(existing.get('name') or '', roster):
            existing['name'] = fr['name']
            filled = True
            if fb_lang:
                logger.info(
                    f"Vault Trap OCR fallback [{fb_lang}] filled "
                    f"{fr['name']!r} for damage {fr['damage']}"
                )
    return filled


def fill_unfilled_by_position(img_rows: dict, fb_text: str,
                              fb_lang: str, filename: str,
                              roster: list | None) -> None:
    """Anchor non-Latin (script) substrings to unfilled rows by their
    position in fb_text relative to the primary's Latin row names. Used
    when damage-keyed merge leaves nothing because the script-only OCR
    doesn't share clean damage values with the primary."""
    sorted_rows = sorted(img_rows.values(), key=lambda r: -r['damage'])

    # Walk in row order so repeated names get distinct anchor positions.
    anchors = []  # [(text_pos, sorted_row_idx)]
    fb_lower = fb_text.lower()
    search_start = 0
    for idx, row in enumerate(sorted_rows):
        name = (row.get('name') or '').strip()
        if not name:
            continue
        ascii_letters = ''.join(c for c in name if c.isalpha() and c.isascii())
        if len(ascii_letters) < 4:
            continue
        anchor_key = ascii_letters[:4].lower()
        pos = fb_lower.find(anchor_key, search_start)
        if pos != -1:
            anchors.append((pos, idx))
            search_start = pos + len(anchor_key)
    if not anchors:
        return
    anchors.sort()

    subs_with_pos = _extract_script_substrings_with_pos(fb_text, fb_lang)
    if not subs_with_pos:
        return

    # Per-substring noise filter (token appears 3+ times → drop it).
    from collections import Counter
    token_counts: Counter = Counter()
    for s, _pos in subs_with_pos:
        for tok in set(s.split()):
            if len(tok) >= 2:
                token_counts[tok] += 1
    noise = sorted(
        (tok for tok, count in token_counts.items() if count >= 3),
        key=len, reverse=True,
    )

    def _strip_noise(s: str) -> str:
        for nt in noise:
            s = s.replace(nt, ' ')
        return ' '.join(s.split()).strip()

    # Build (pos, cleaned_substring) keeping only non-empty post-strip.
    clean_with_pos = []
    for s, p in subs_with_pos:
        cs = _strip_noise(s)
        if cs:
            clean_with_pos.append((p, cs))
    if not clean_with_pos:
        return

    claimed_fids = _collect_claimed_fids(img_rows, roster)

    for row_idx, row in enumerate(sorted_rows):
        if not is_row_unfilled(row, roster):
            continue
        prev_pos = -1
        next_pos = len(fb_text)
        for a_pos, a_idx in anchors:
            if a_idx < row_idx and a_pos > prev_pos:
                prev_pos = a_pos
            elif a_idx > row_idx and a_pos < next_pos:
                next_pos = a_pos
        in_range = [cs for p, cs in clean_with_pos if prev_pos < p < next_pos]
        if not in_range:
            continue
        in_range.sort(key=len, reverse=True)
        best = None
        for cs in in_range:
            display_cs = _reverse_for_rtl(cs, fb_lang) if fb_lang in _RTL_LANGS else cs
            cands = match_roster(display_cs, roster) if roster else []
            if cands and cands[0][2] >= MATCH_AUTO_CONFIRM and cands[0][0] in claimed_fids:
                continue
            best = display_cs
            break
        if best is None:
            continue
        existing_score = name_match_score(row.get('name') or '', roster)
        new_score = name_match_score(best, roster)
        if new_score <= existing_score:
            continue
        row['name'] = best
        new_cands = match_roster(best, roster) if roster else []
        if new_cands and new_cands[0][2] >= MATCH_AUTO_CONFIRM:
            claimed_fids.add(new_cands[0][0])
        logger.info(
            f"Vault Trap OCR fallback [{fb_lang}] filled (by-position) "
            f"{best!r} for damage {row['damage']} ({filename})"
        )


def _strip_common_trailing_token(chunks):
    """If the same whitespace-separated token appears at the end of at
    least two chunks, strip that token from every chunk that ends with it.
    Used to peel off per-row labels without a hardcoded list.

    Purely-numeric tokens are excluded from "recurring" -- two different
    rows' trailing digits matching is far more likely to be a coincidental
    rank-badge collision (e.g. a misread rank landing on the same digit as
    another row's correct one) than a genuine repeated text label. Stripping
    it here would erase both rows' rank evidence and silently hide a
    duplicate-rank OCR error instead of leaving it for rank-sequence
    validation to catch.
    """
    if len(chunks) < 2:
        return chunks
    last_tokens = [c.split()[-1] for c in chunks if c.split()]
    counts = {}
    for t in last_tokens:
        counts[t] = counts.get(t, 0) + 1
    recurring = {t for t, n in counts.items() if n >= 2 and not t.isdigit()}
    if not recurring:
        return chunks
    out = []
    for c in chunks:
        parts = c.split()
        if parts and parts[-1] in recurring:
            parts = parts[:-1]
        out.append(' '.join(parts))
    return out


def vault_damage(raw) -> int:
    """Clean vault score from different language formats."""
    if not raw:
        return 0
    clean = re.sub(r"[^\d]", "", str(raw))
    return int(clean) if clean else 0


def format_damage_for_embed(value) -> str:
    """Formats integer with commas for embed display."""
    try:
        cleaned = re.sub(r"[^\d]", "", str(value))
        if not cleaned:
            return "0"
        return f"{int(cleaned):,}"
    except Exception:
        return "0"


def chunk_lines_for_fields(lines: list, max_chars: int = 1024) -> list:
    """Group `lines` into the fewest \n-joined chunks that each stay within
    a Discord embed field's 1024-char value limit, so a page of rows the
    header already promised to show (e.g. "Players 1-25 of 52") never gets
    silently cut off mid-page the way a single `value[:1010]` slice used to
    -- see docs/ocr-reference/capitol_war_mismatch_2026-08-23.md for the
    real alliance where that first surfaced (Capitol War rows run ~45-50
    chars each with fids in them, and 'ambiguous'-status rows showing two
    full candidate names can run well past 100 -- both push 20-25 rows over
    1024 chars long before 25 rows' worth of lines is reached, so a fixed
    "rows per chunk" guess isn't safe; this measures the real rendered
    length of each line instead).

    A single line longer than max_chars on its own (pathological -- e.g. an
    extreme unmatched name) is hard-clipped so it can never blow the budget
    by itself; that is the only place this function trims anything, and it
    trims one line, never a whole page.

    Returns a non-empty list of value strings, one per embed field the
    caller should add -- see `add_paginated_field` for the matching
    field-adding half (first field keeps the real header name, the rest use
    the same "\\u200b" empty-name convention already used for continuation
    fields in pimp_my_bot_editor.py).
    """
    if not lines:
        return [""]
    chunks = []
    current: list = []
    current_len = 0
    for line in lines:
        if len(line) > max_chars:
            line = line[:max_chars - 1] + "…"
        extra = len(line) + (1 if current else 0)  # +1 for the joining "\n"
        if current and current_len + extra > max_chars:
            chunks.append("\n".join(current))
            current = [line]
            current_len = len(line)
        else:
            current.append(line)
            current_len += extra
    if current:
        chunks.append("\n".join(current))
    return chunks


def add_paginated_field(embed: discord.Embed, header: str, lines: list, *, max_chars: int = 1024) -> None:
    """Add `lines` to `embed` as one field named `header`, spilling into as
    many additional (visually-unlabeled) fields as the real rendered content
    needs so nothing on the page is ever silently truncated. See
    `chunk_lines_for_fields` for why a fixed rows-per-field count isn't
    safe here."""
    for i, value in enumerate(chunk_lines_for_fields(lines, max_chars=max_chars)):
        embed.add_field(name=header if i == 0 else "​", value=value or "​", inline=False)


def validate_vault_submission(date_str, trap_number, rallies, total_damage):
    """Validate vault submission fields and return list of errors."""
    errors = []

    try:
        datetime.strptime(str(date_str), "%Y-%m-%d")
    except Exception:
        errors.append("Date must be in YYYY-MM-DD format.")

    try:
        trap_number = int(trap_number)
        # `trap_number` is repurposed for Vault Trap as the operation/wave
        # number (see _VAULT_TRAP_WAVE_RE) rather than a per-day dual-slot
        # value, and Police Chief's valid range isn't confirmed yet (the
        # reference doc only observed "1") -- so this only rejects non-positive
        # values instead of guessing a hard cap.
        if trap_number <= 0:
            errors.append("Vault Trap operation number must be a positive number.")
    except Exception:
        errors.append("Vault Trap operation number must be a whole number.")

    if rallies not in (None, ""):
        try:
            rallies = int(rallies)
            if rallies <= 0:
                errors.append("Rallies must be a number greater than 0.")
        except Exception:
            errors.append("Rallies must be a whole number.")

    try:
        total_damage = int(total_damage)
        if total_damage <= 0:
            errors.append("Total damage must be a number greater than 0.")
    except Exception:
        errors.append("Total damage must be a whole number.")

    return errors


# ---------------------------------------------------------------------------
# Session model — multi-screenshot vault hunt collection
# ---------------------------------------------------------------------------


@dataclass
class ImageResult:
    """Output of OCR'ing a single screenshot, before clustering into events."""
    ok: bool = False
    trap: str = ""
    rallies: str = ""
    total_damage: int = 0
    date: str = ""
    rows: dict = field(default_factory=dict)


@dataclass
class EventGroup:
    """One vault event accumulated from one or more compatible screenshots."""
    trap_value: str = ""
    rallies_value: str = ""
    damage_int: int = 0
    date_value: str = ""
    merged_rows: dict = field(default_factory=dict)
    image_count: int = 0

    def merge(self, result: ImageResult, roster: list | None = None):
        if not self.trap_value and result.trap:
            self.trap_value = result.trap
        if not self.rallies_value and result.rallies:
            self.rallies_value = result.rallies
        if not self.date_value and result.date:
            self.date_value = result.date
        if result.total_damage > self.damage_int:
            self.damage_int = result.total_damage
        for row in result.rows.values():
            key = row['damage']
            existing = self.merged_rows.get(key)
            if existing is None or _better_row(existing, row, roster=roster):
                self.merged_rows[key] = row
        self.image_count += 1

    def is_compatible(self, result: ImageResult, roster: list) -> bool:
        if self.trap_value and result.trap and self.trap_value != result.trap:
            logger.info(
                f"Vault Trap cluster: split — trap conflict "
                f"(event={self.trap_value!r}, new={result.trap!r})"
            )
            return False
        has_agreement = has_conflict = False
        details = []
        for new_dmg, new_row in result.rows.items():
            existing_row = self.merged_rows.get(new_dmg)
            if not existing_row:
                continue
            status = _row_pair_status(existing_row, new_row, roster)
            details.append(
                f"  dmg={new_dmg} existing={existing_row.get('name')!r} "
                f"new={new_row.get('name')!r} → {status}"
            )
            if status == 'same':
                has_agreement = True
            elif status == 'different':
                has_conflict = True
        if has_agreement:
            decision = True
        else:
            decision = not has_conflict
        if details:
            logger.info(
                f"Vault Trap cluster: is_compatible={decision} "
                f"(agree={has_agreement} conflict={has_conflict})\n"
                + "\n".join(details)
            )
        else:
            logger.info(
                f"Vault Trap cluster: is_compatible={decision} (no shared damages)"
            )
        return decision


def _row_pair_status(row_a: dict, row_b: dict, roster: list) -> str:
    """Compare two rows sharing a damage value: 'same' / 'different' /
    'unknown' (when either name lacks a confident roster match)."""
    name_a = (row_a.get('name') or '').strip()
    name_b = (row_b.get('name') or '').strip()
    if not name_a or not name_b or not roster:
        return 'unknown'
    cand_a = match_roster(name_a, roster)
    cand_b = match_roster(name_b, roster)
    if not cand_a or not cand_b:
        return 'unknown'
    fid_a, _, score_a = cand_a[0]
    fid_b, _, score_b = cand_b[0]
    if score_a < MATCH_AUTO_CONFIRM or score_b < MATCH_AUTO_CONFIRM:
        return 'unknown'
    return 'same' if fid_a == fid_b else 'different'


class VaultAutoDeleteTracker:
    """Deletes source screenshots once every review view spawned from them
    has been actioned -- Submit, Cancel, OR timeout all count as
    "actioned"; the channel shouldn't keep the raw screenshots around just
    because an admin backed out or a session lapsed, since the whole point
    is not leaving them in the channel forever (see docs/ocr-reference --
    this was previously gated on `any_submitted`, which meant a cancelled
    or timed-out review kept its screenshots indefinitely; every real
    Capitol War session in a day of manual re-testing ended that way,
    which is what prompted this change)."""
    def __init__(self, source_messages, enabled: bool):
        self.source_messages = list(source_messages)
        self.enabled = enabled
        self.pending = 0
        logger.info(
            f"Vault Trap auto-delete tracker: enabled={enabled}, "
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
            logger.info("Vault Trap auto-delete: skipped (disabled in alliance settings)")
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
                    f"Vault Trap auto-delete: unexpected failure deleting "
                    f"message {msg.id}: {e}"
                )
        if forbidden:
            logger.warning(
                f"Vault Trap auto-delete: {forbidden} message(s) blocked — "
                f"bot needs **Manage Messages** on the vault channel."
            )
        logger.info(
            f"Vault Trap auto-delete: total={len(self.source_messages)}, "
            f"deleted={deleted}, already_gone={not_found}, "
            f"forbidden={forbidden}, errors={other_failed}"
        )


class VaultSession:
    """Per-(channel, user) session: accumulates screenshots within a
    sliding timeout, finalises into one review."""

    def __init__(self, *, cog, channel_id: int, user_id: int, alliance_id: int,
                 alliance_name: str, roster, primary_lang: str, fallback_langs: list,
                 timeout_min: int, auto_delete: bool):
        self.cog = cog
        self.channel_id = channel_id
        self.user_id = user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.roster = roster
        self.primary_lang = primary_lang
        self.fallback_langs = fallback_langs
        self.timeout_min = timeout_min
        self.auto_delete = auto_delete

        self.events: list[EventGroup] = []
        self.source_messages: list[discord.Message] = []
        self.lock = asyncio.Lock()
        # Set without the lock so Cancel lands mid-batch.
        self.cancel_requested = False
        self.timer_task: asyncio.Task | None = None
        self.progress_msg: discord.Message | None = None
        self.session_view: discord.ui.View | None = None
        self.processed_images = 0
        self.known_total_images = 0  # All images uploaded so far, even ones queued behind the lock
        self.any_ocr_success = False
        self.finalized = False
        # In-flight OCR state (None when idle).
        self.current_image_idx: int | None = None
        self.current_image_total: int | None = None
        self.current_phase: str | None = None  # 'ocr' or 'fallback'
        self.current_lang: str | None = None
        # OCR engines acquired by this session (released at finalize/cancel).
        self._engine_handles: dict[str, "onnx_lifecycle.LazyOnnxModel"] = {}
        self._engine_cache: dict[str, object] = {}

    async def _ensure_engine(self, lang: str):
        """Lazy per-session engine acquire. First call for `lang` loads the
        model and keeps it warm for the rest of the session; subsequent calls
        return the cached engine.

        On low-memory boxes only ONE engine stays resident: switching to a new
        language evicts whatever we already hold first. That makes en→cyrillic→ch
        fallbacks reload per language (slower) but keeps peak RAM to a single
        engine plus the pinned captcha model, which a 512 MB container survives."""
        cached = self._engine_cache.get(lang)
        if cached is not None:
            return cached
        if onnx_lifecycle.LOW_MEM_MODE and self._engine_cache:
            await self._release_all_engines()
        model = get_ocr_model(lang)
        if model is None:
            return None
        engine = await model.acquire()
        self._engine_handles[lang] = model
        self._engine_cache[lang] = engine
        return engine

    async def _release_all_engines(self):
        for handle in self._engine_handles.values():
            try:
                await handle.release()
            except Exception as e:
                logger.warning(f"Vault Trap OCR: engine release error: {e}")
        self._engine_handles.clear()
        self._engine_cache.clear()

    # --- Crash resume: snapshot parsed events after each image, restore on restart ---
    def _snapshot_key(self) -> str:
        return f"vault:{self.channel_id}:{self.user_id}"

    def snapshot_payload(self) -> dict:
        return {
            'channel_id': self.channel_id, 'user_id': self.user_id,
            'alliance_id': self.alliance_id, 'alliance_name': self.alliance_name,
            'primary_lang': self.primary_lang, 'fallback_langs': self.fallback_langs,
            'timeout_min': self.timeout_min, 'auto_delete': self.auto_delete,
            'processed_images': self.processed_images,
            'known_total_images': self.known_total_images,
            'any_ocr_success': self.any_ocr_success,
            'events': [{
                'trap_value': e.trap_value, 'rallies_value': e.rallies_value,
                'damage_int': e.damage_int, 'date_value': e.date_value,
                'image_count': e.image_count,
                'merged_rows': {str(k): v for k, v in e.merged_rows.items()},
            } for e in self.events],
        }

    def restore_events(self, payload: dict) -> None:
        self.processed_images = payload.get('processed_images', 0)
        self.known_total_images = payload.get('known_total_images', 0)
        self.any_ocr_success = payload.get('any_ocr_success', False)
        self.events = []
        for ed in payload.get('events', []):
            e = EventGroup()
            e.trap_value = ed.get('trap_value', '')
            e.rallies_value = ed.get('rallies_value', '')
            e.damage_int = ed.get('damage_int', 0)
            e.date_value = ed.get('date_value', '')
            e.image_count = ed.get('image_count', 0)
            mr = {}
            for k, v in (ed.get('merged_rows') or {}).items():
                try:
                    k = int(k)
                except (TypeError, ValueError):
                    pass
                mr[k] = v
            e.merged_rows = mr
            self.events.append(e)

    def save_snapshot(self) -> None:
        if self.finalized:
            # In-flight batches must not re-create a deleted snapshot (phantom recovery).
            return
        from . import ocr_resume
        ocr_resume.save(self._snapshot_key(), 'vault', self.snapshot_payload())

    def delete_snapshot(self) -> None:
        from . import ocr_resume
        ocr_resume.delete(self._snapshot_key())

    async def resume(self) -> None:
        """Re-post the progress message for a vault session recovered after a restart."""
        channel = self.cog.bot.get_channel(self.channel_id)
        if channel is None:
            return
        kept = sum(len(e.merged_rows) for e in self.events)
        embed = discord.Embed(
            title=f"{theme.searchIcon} Recovered your vault upload",
            description=(
                f"{theme.upperDivider}\n"
                f"The bot restarted mid-upload. **{kept}** parsed row(s) kept across "
                f"**{len(self.events)}** event(s).\n"
                f"Click **Done Uploading** to review and submit, or re-upload any screenshots "
                f"that weren't processed yet.\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1,
        )
        self.session_view = VaultSessionView(self)
        self.progress_msg = await channel.send(embed=embed, view=self.session_view)
        self.restart_timer()

    def cluster(self, result: ImageResult) -> EventGroup:
        for event in self.events:
            if event.is_compatible(result, self.roster):
                event.merge(result, roster=self.roster)
                return event
        new_event = EventGroup()
        new_event.merge(result, roster=self.roster)
        self.events.append(new_event)
        return new_event

    def restart_timer(self):
        if self.timer_task and not self.timer_task.done():
            self.timer_task.cancel()
        self.timer_task = asyncio.create_task(self._timer_run())

    async def _timer_run(self):
        try:
            await asyncio.sleep(self.timeout_min * 60)
        except asyncio.CancelledError:
            return
        if not self.finalized:
            await self.finalize(timed_out=True)

    def stop_timer(self):
        task = self.timer_task
        self.timer_task = None
        # Never self-cancel: the timeout path runs stop_timer from _timer_run and would kill finalize.
        if task and not task.done() and task is not asyncio.current_task():
            task.cancel()

    def build_progress_embed(self) -> discord.Embed:
        title = f"{theme.searchIcon} Vault Trap — collecting"

        if self.processed_images == 0 and self.current_image_idx is None:
            summary = f"{theme.processingIcon} Processing first screenshot…"
        elif not self.events and self.current_image_idx is None:
            summary = (
                f"{theme.warnIcon} **{self.processed_images}** screenshot(s) processed, "
                f"no readable data extracted yet."
            )
        elif len(self.events) <= 1:
            event = self.events[0] if self.events else None
            if event:
                trap = f"Trap {event.trap_value}" if event.trap_value else "Trap unknown"
                total = format_damage_for_embed(event.damage_int) if event.damage_int else "—"
                n_players = len(event.merged_rows)
                summary = (
                    f"**{self.processed_images}** screenshot{'s' if self.processed_images != 1 else ''} "
                    f"processed · **{n_players}** player{'s' if n_players != 1 else ''} found\n"
                    f"{trap} · {total} total"
                )
            else:
                summary = f"**{self.processed_images}** screenshots processed"
        else:
            lines = [
                f"**{self.processed_images}** screenshots → "
                f"{theme.warnIcon} **{len(self.events)}** events detected:"
            ]
            for i, ev in enumerate(self.events, start=1):
                trap = f"Trap {ev.trap_value}" if ev.trap_value else "Trap ?"
                total = format_damage_for_embed(ev.damage_int) if ev.damage_int else "—"
                lines.append(
                    f"• Event {i}: {trap} · {len(ev.merged_rows)} players · {total}"
                )
            summary = "\n".join(lines)

        if self.current_image_idx is not None:
            bar = self._progress_bar(self.current_image_idx, self.current_image_total or 1)
            phase_label = "fallback OCR" if self.current_phase == 'fallback' else "running OCR"
            lang_label = self._short_lang_label(self.current_lang)
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

    @staticmethod
    def _progress_bar(current: int, total: int) -> str:
        width = max(min(total, 12), 6)
        filled = max(0, min(width, round(current / total * width))) if total else 0
        return "▰" * filled + "▱" * (width - filled)

    @staticmethod
    def _short_lang_label(lang: str | None) -> str:
        if not lang:
            return ""
        label = OCR_LANG_LABEL.get(lang, lang)
        return label.split("(")[0].strip().split(" only")[0]

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
        # Bump total before the lock so the progress shows new uploads
        # immediately instead of after the current batch.
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
                    logger.info("Vault Trap OCR: batch stopped early, session cancelled by the user")
                    return
                self.current_image_idx = self.processed_images + 1
                self.current_image_total = self.known_total_images
                self.current_phase = 'ocr'
                self.current_lang = self.primary_lang
                await self.render_progress()
                try:
                    image_bytes = await attachment.read()
                except Exception as e:
                    logger.error(f"Vault Trap OCR read error on {attachment.filename}: {e}")
                    continue
                result = await self.cog._ocr_attachment_to_result(
                    image_bytes,
                    self.primary_lang,
                    self.fallback_langs,
                    filename=attachment.filename,
                    roster=self.roster,
                    alliance_id=self.alliance_id,
                    progress_callback=_phase_callback,
                    session=self,
                )
                self.processed_images += 1
                if result.ok:
                    self.any_ocr_success = True
                    self.cluster(result)
                await self.render_progress()
                self.save_snapshot()
                if onnx_lifecycle.LOW_MEM_MODE:
                    # Reclaim the decoded image + OCR buffers before the next
                    # image so peak RSS doesn't ratchet up on a 512 MB box.
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
            _active_sessions.pop((self.channel_id, self.user_id), None)
        try:
            await self.cog._finalize_session(self, timed_out=timed_out)
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
            _active_sessions.pop((self.channel_id, self.user_id), None)
            self.delete_snapshot()
        await self._release_all_engines()
        if self.progress_msg:
            embed = discord.Embed(
                description=f"{theme.deniedIcon} Vault Trap collection cancelled.",
                color=theme.emColor2,
            )
            try:
                await self.progress_msg.edit(embed=embed, view=None)
            except Exception:
                pass


_active_sessions: dict = {}


async def _ack_component(interaction: discord.Interaction) -> bool:
    """Defer a component interaction so the click is acknowledged."""
    if interaction.response.is_done():
        return True
    try:
        await interaction.response.defer()
        return True
    except discord.NotFound:
        logger.warning("Vault Trap session button: interaction expired before defer")
        return False
    except Exception as e:
        logger.warning(f"Vault Trap session button: defer failed ({e!r})")
        return False


async def _retire_stale_recovery(interaction: discord.Interaction) -> None:
    """Retire a recovery message whose session is gone so its button isn't left dead."""
    embed = discord.Embed(
        description=f"{theme.hourglassIcon} This vault upload recovery has expired. Nothing to submit.",
        color=theme.emColor2,
    )
    try:
        await interaction.response.edit_message(embed=embed, view=None)
    except Exception:
        try:
            await interaction.response.defer()
        except Exception:
            pass


class VaultSessionButton(discord.ui.DynamicItem[discord.ui.Button],
                        template=r'vaultsess:(?P<action>done|cancel):(?P<channel>[0-9]+):(?P<user>[0-9]+)'):
    """Done/Cancel button with the session key in its custom_id, so clicks survive a restart."""

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
            custom_id=f"vaultsess:{action}:{channel_id}:{user_id}",
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
        session = _active_sessions.get((self.channel_id, self.user_id))
        if session is None:
            await _retire_stale_recovery(interaction)
            return
        if not await _ack_component(interaction):
            return
        if self.action == 'done':
            asyncio.create_task(session.finalize(timed_out=False))
        else:
            asyncio.create_task(session.cancel())


class VaultSessionView(discord.ui.View):
    """Done/Cancel buttons; DynamicItem-based so they keep working after a restart."""

    def __init__(self, session: "VaultSession"):
        super().__init__(timeout=None)
        self.session = session
        self.add_item(VaultSessionButton('done', session.channel_id, session.user_id))
        self.add_item(VaultSessionButton('cancel', session.channel_id, session.user_id))


# ---------------------------------------------------------------------------
# vault_data_embed — chart generation
# ---------------------------------------------------------------------------

def vault_data_embed(
    *,
    alliance_id: int,
    alliance_name: str,
    trap_number: int,
    dates: list[datetime],
    rallies_list: list[int],
    total_damages: list[int],
    title_suffix: str | None = None,
    damage_range_days: int | None = None
):
    first_date = min(dates)
    last_date = max(dates)

    last_rallies = rallies_list[-1]
    last_damage = total_damages[-1]

    avg_rallies = int(sum(rallies_list) / len(rallies_list))
    avg_damage = int(sum(total_damages) / len(total_damages))

    rallies_diff = last_rallies - avg_rallies
    damage_diff = last_damage - avg_damage

    title = f"{alliance_name} Vault Trap {trap_number}"
    if title_suffix:
        title += f" - {title_suffix}"

    embed = discord.Embed(title=title, color=theme.emColor1)

    embed.add_field(
        name="Date Range",
        value=f"{first_date:%Y-%m-%d} → {last_date:%Y-%m-%d}",
        inline=False
    )
    embed.add_field(name="Average Rallies", value=str(avg_rallies), inline=False)
    embed.add_field(name="Average Total Damage", value=f"{avg_damage:,}", inline=False)
    embed.add_field(name="Last Vault Trap Rallies", value=str(last_rallies), inline=True)
    embed.add_field(name="Last Vault Trap Damage", value=f"{last_damage:,}", inline=True)
    embed.add_field(name="Difference in Rallies", value=f"{rallies_diff:+d}", inline=True)
    embed.add_field(name="Difference in Damage", value=f"{damage_diff:+,}", inline=True)

    if damage_range_days and damage_range_days > 0:
        embed.set_footer(text=f"Showing last {damage_range_days} days of damage")
    else:
        embed.set_footer(text="Showing all historical damage records")

    image_file = _render_damage_chart(
        dates, total_damages,
        title=f"{alliance_name} Total Damage Over Time - Vault Trap {trap_number}",
        ylabel="Total Damage",
    )
    if image_file is not None:
        embed.set_image(url="attachment://plot.png")
    return embed, image_file


def vault_data_embed_combined(
    *,
    alliance_id: int,
    alliance_name: str,
    trap_series: list[tuple[int, list[datetime], list[int], list[int]]],
    title_suffix: str | None = None,
    damage_range_days: int | None = None,
):
    """Combined-trap embed: `trap_series` is a list of
    `(trap_number, dates, rallies_list, total_damages)` for each trap that
    had data in the range. Renders a 2-line chart with a legend."""
    title = f"{alliance_name} All Vault Trap Operations"
    if title_suffix:
        title += f" - {title_suffix}"

    embed = discord.Embed(title=title, color=theme.emColor1)

    all_dates = [d for _, dates, _, _ in trap_series for d in dates]
    embed.add_field(
        name="Date Range",
        value=f"{min(all_dates):%Y-%m-%d} → {max(all_dates):%Y-%m-%d}",
        inline=False,
    )

    for trap, dates, rallies_list, total_damages in trap_series:
        avg_rallies = int(sum(rallies_list) / len(rallies_list))
        avg_damage = int(sum(total_damages) / len(total_damages))
        embed.add_field(
            name=f"Trap {trap} — {len(dates)} hunt{'s' if len(dates) != 1 else ''}",
            value=(
                f"Avg rallies: **{avg_rallies}**\n"
                f"Avg damage: **{avg_damage:,}**\n"
                f"Last damage: **{total_damages[-1]:,}**"
            ),
            inline=True,
        )

    if damage_range_days and damage_range_days > 0:
        embed.set_footer(text=f"Showing last {damage_range_days} days of damage")
    else:
        embed.set_footer(text="Showing all historical damage records")

    series = [
        (f"Trap {trap}", dates, total_damages)
        for trap, dates, _, total_damages in trap_series
    ]
    image_file = _render_damage_chart(
        None, None,
        title=f"{alliance_name} Total Damage Over Time — All Vault Trap Operations",
        ylabel="Total Damage",
        series=series,
    )
    if image_file is not None:
        embed.set_image(url="attachment://plot.png")
    return embed, image_file


def _format_damage_axis(x, _pos):
    """matplotlib FuncFormatter for damage values: 12,300,000,000 -> '12.3B'."""
    try:
        x = float(x)
    except Exception:
        return str(x)
    for divisor, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if x >= divisor:
            val = x / divisor
            return f"{int(val)}{suffix}" if val.is_integer() else f"{val:.1f}{suffix}"
    return f"{int(x)}"


def _render_damage_chart(dates, values, *, title, ylabel="Damage", series=None):
    """discord.File('plot.png') with the styled line chart, or None on
    failure. Pass `series=[(label, dates, values), ...]` for multi-line;
    legacy single-line callers keep the `dates, values` positional form."""
    if not MATPLOTLIB_AVAILABLE:
        return None
    if series is None:
        if not dates:
            return None
        series = [(None, dates, values)]
    if not any(s[1] for s in series):
        return None
    import matplotlib
    matplotlib.use('Agg', force=False)  # non-interactive backend; avoids Tkinter (fatal off the main thread on Windows)
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    from matplotlib.ticker import MaxNLocator, FuncFormatter
    fig = None
    try:
        plt.style.use("fivethirtyeight")
        fig = plt.figure(figsize=(10, 7), facecolor="#1a1a2d")
        for label, s_dates, s_values in series:
            if not s_dates:
                continue
            plt.plot(s_dates, s_values, marker='o', linewidth=3, label=label)
        ax = plt.gca()
        ax.set_facecolor("#1a1a2d")
        for spine in ax.spines.values():
            spine.set_visible(False)
        plt.title(
            title, color="#99c2ff", fontfamily="sans-serif",
            fontweight="bold", fontsize=16, loc="left", pad=30,
        )
        plt.ylabel(ylabel, color="white", fontsize=12, fontweight="bold", labelpad=15)
        plt.yticks(color="white")
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
        ax.xaxis.set_major_locator(MaxNLocator(nbins=15))
        plt.xticks(rotation=45, color="white")
        ax.yaxis.set_major_formatter(FuncFormatter(_format_damage_axis))
        if len(series) > 1 and any(label for label, _, _ in series):
            legend = plt.legend(loc="upper left", facecolor="#1a1a2d", edgecolor="none")
            for text in legend.get_texts():
                text.set_color("white")
        plt.tight_layout()
        buffer = io.BytesIO()
        plt.savefig(buffer, format="png", dpi=200, transparent=True)
        buffer.seek(0)
        return discord.File(buffer, filename="plot.png")
    except Exception as e:
        logger.error(f"Failed to generate chart: {e}")
        print(f"[ERROR] Failed to generate chart: {e}")
        return None
    finally:
        if fig is not None:
            plt.close(fig)


def vault_player_history_embed(*, alliance_name: str, fid: int, nickname: str,
                               trap_number: int | None,
                               rows: list):
    """Build an embed + chart for a single player's vault hunt history.

    `rows` is an iterable of tuples `(date_str, damage, rank)` ordered by
    date ascending. Returns (embed, discord.File|None).
    """
    discord_nick = _ltr_line(nickname)
    chart_nick = _reshape_for_chart(nickname)
    if not rows:
        embed = discord.Embed(
            title=f"{discord_nick} · Vault Trap History",
            description=f"No damage records for ID `{fid}` in {alliance_name}"
                        + (f" for Vault Trap {trap_number}" if trap_number else "") + ".",
            color=theme.emColor2,
        )
        return embed, None

    dates = [datetime.strptime(d, "%Y-%m-%d") for d, _, _ in rows]
    damages = [int(dmg) for _, dmg, _ in rows]
    ranks = [int(r) if r is not None else None for _, _, r in rows]

    total_hunts = len(rows)
    total_dmg = sum(damages)
    avg_dmg = int(total_dmg / total_hunts)
    max_dmg = max(damages)
    best_rank = min((r for r in ranks if r is not None), default=None)
    last_date, last_dmg, last_rank = dates[-1], damages[-1], ranks[-1]

    title = f"{discord_nick} · Vault Trap History"
    if trap_number:
        title += f" · Vault Trap {trap_number}"

    embed = discord.Embed(title=title, color=theme.emColor1)
    embed.add_field(name="Alliance", value=alliance_name, inline=True)
    embed.add_field(name="ID", value=str(fid), inline=True)
    embed.add_field(name="Hunts Attended", value=str(total_hunts), inline=True)
    embed.add_field(name="Average Damage", value=f"{avg_dmg:,}", inline=True)
    embed.add_field(name="Best Damage", value=f"{max_dmg:,}", inline=True)
    embed.add_field(
        name="Best Rank",
        value=f"#{best_rank}" if best_rank is not None else "—",
        inline=True,
    )
    embed.add_field(
        name="Most Recent",
        value=f"{last_date:%Y-%m-%d} — `{last_dmg:,}`"
              + (f" (#{last_rank})" if last_rank else ""),
        inline=False,
    )

    title = f"{chart_nick} — Damage over time" + (f" · Vault Trap {trap_number}" if trap_number else "")
    image_file = _render_damage_chart(dates, damages, title=title)
    if image_file is not None:
        embed.set_image(url="attachment://plot.png")
    return embed, image_file


# ---------------------------------------------------------------------------
# Vault Trap channel info message — pinned "what to upload" helper
# ---------------------------------------------------------------------------

# Substrings that identify a bot-authored info message across versions.
# Only exact matches count as "ours", so unrelated pins are never touched.
# Kept both the current and pre-port fingerprint so an old pinned message from
# before this rename still self-heals instead of lingering as an orphan.
_VAULT_INFO_FINGERPRINTS = (
    "Upload your Vault Trap results here",
    "Upload your Vault Trap results here",  # pre-port (original game's Bear Trap) wording
)


def render_vault_info_message() -> str:
    """The pinned helper text for a Vault Trap score channel — what to upload."""
    return "\n".join([
        f"{theme.importIcon} **Upload your Vault Trap results here**",
        "",
        f"{theme.listIcon} **What to upload**",
        f"{theme.upperDivider}",
        "• The **Vault Trap Operation mail**, the one headed **\"Battle Overview\"** "
        "with **Rallies** and **Alliance Total Damage**, followed by the "
        "**Solo Damage Rewards** section.",
        "• The **Damage Rankings** pages of the same mail (swipe with the "
        "**< >** arrows past \"Solo Damage Rewards\"), to add everyone below "
        "the mail's top ranks.",
        f"{theme.lowerDivider}",
        "",
        f"{theme.infoIcon} **Tips**",
        "• Post the **summary mail plus a few ranking pages** together to capture every participant.",
        "• Set your in-game language to **English** for the best results.",
        "• The bot reads each upload automatically and posts the parsed damage here.",
    ])


# ---------------------------------------------------------------------------
# VaultTrack cog
# ---------------------------------------------------------------------------

def get_alliance_roster(users_cursor, alliance_id, active_only: bool = True):
    """Return [(fid, nickname), ...] for members of the given alliance.
    `active_only` (default True) excludes deactivated members — OCR
    fuzzy-matching and the ambiguity guard should only ever match against
    current members (decision #2); pass False to include everyone
    (e.g. VaultCompareView's "Select All Total").

    Extracted as a free function (originally `VaultTrack.get_alliance_roster`)
    so any tracker with its own `users_cursor` -- same `users` table, just a
    separate sqlite3 cursor object -- can reuse it directly. `VaultTrack.
    get_alliance_roster` below is now a thin wrapper for backward
    compatibility with existing call sites."""
    sql = "SELECT fid, nickname FROM users WHERE alliance = ?"
    if active_only:
        sql += " AND is_active = 1"
    users_cursor.execute(sql, (str(alliance_id),))
    return [(int(fid), nick or "") for (fid, nick) in users_cursor.fetchall()]


async def auto_link_unmatched_rows_by_name(cursor, conn, *, alliance_id: int, fid: int,
                                           nickname: str, get_roster, player_table: str,
                                           event_table: str, event_fk_col: str) -> int:
    """Link an alliance's fid=NULL rows (in `player_table`) whose raw_name
    strongly and unambiguously matches `nickname` to the new `fid`.

    Meant to be called right after a new roster member is created (self
    -registration or admin add), so OCR rows the matcher previously couldn't
    place flow into the fid-keyed history/leaderboard views automatically
    instead of sitting unmatched forever.

    Uses the same fuzzy scorer as the OCR pipeline (match_roster, which is
    WRatio + the _fold processor) scored against the alliance's full current
    roster plus the new member, so the new member's score is measured on
    equal footing with everyone else — that's what makes the ambiguity guard
    below meaningful.

    Only links a raw_name when:
      - the new member's score against it is >= MATCH_AUTO_CONFIRM, AND
      - no *other* current roster member also scores >= MATCH_AUTO_CONFIRM
        or within MATCH_AMBIGUOUS_DELTA points of the new member's score.
    Anything short of that is left with fid=NULL for the existing manual
    Re-match/edit tools to resolve — intentionally conservative so two
    different people with similar names never get silently merged.

    Extracted as a free function (originally `VaultTrack.
    auto_link_unmatched_by_name`), parameterized by table/column names and a
    `get_roster(alliance_id)` callable, so any tracker sharing this exact
    "resolve OCR leftovers against a freshly-added member" mechanic (e.g.
    Capitol War's capitol_war_points) reuses the same ambiguity-guarded
    matching instead of re-deriving it. `cursor`/`conn` are the tracker's own
    sqlite3 cursor/connection for its event-data DB. Returns the number of
    rows updated."""
    alliance_id = int(alliance_id)
    fid = int(fid)
    nickname = (nickname or "").strip()
    if not nickname:
        return 0

    def _work():
        cur = cursor
        cur.execute(
            f"SELECT DISTINCT t.raw_name FROM {player_table} t "
            f"JOIN {event_table} e ON e.id = t.{event_fk_col} "
            f"WHERE e.alliance_id = ? AND t.fid IS NULL "
            f"AND t.raw_name IS NOT NULL AND t.raw_name != ''",
            (alliance_id,))
        raw_names = [r[0] for r in cur.fetchall()]
        if not raw_names:
            return 0

        # Full current roster (minus the new member, who we add back below
        # under the freshly-registered nickname) — this is what the
        # ambiguity guard checks each raw_name against.
        other_members = [(f, n) for (f, n) in get_roster(alliance_id) if f != fid]
        mini_roster = other_members + [(fid, nickname)]

        total = 0
        for raw_name in raw_names:
            candidates = match_roster(raw_name, mini_roster)
            if not candidates:
                continue
            target = next((c for c in candidates if c[0] == fid), None)
            if not target or target[2] < MATCH_AUTO_CONFIRM:
                continue
            if any(c[0] != fid and
                   (c[2] >= MATCH_AUTO_CONFIRM or target[2] - c[2] < MATCH_AMBIGUOUS_DELTA)
                   for c in candidates):
                continue  # ambiguous vs. another roster member — leave for manual resolution
            cur.execute(
                f"UPDATE {player_table} SET fid = ?, resolved_nickname = ?, match_score = ? "
                f"WHERE fid IS NULL AND raw_name = ? AND {event_fk_col} IN "
                f"(SELECT id FROM {event_table} WHERE alliance_id = ?)",
                (fid, target[1], target[2], raw_name, alliance_id))
            total += cur.rowcount
        if total:
            conn.commit()
        return total

    return await asyncio.to_thread(_work)


def _fetch_current_members(users_cursor, alliance_id):
    """Roster source for get_match_roster (OCR fuzzy-matching). Active-only
    per decision #2 — a deactivated member's name in a new screenshot lands
    unmatched (like any unrecognized name) until they're reactivated."""
    users_cursor.execute(
        "SELECT fid, nickname FROM users WHERE alliance = ? AND is_active = 1",
        (str(alliance_id),))
    return users_cursor.fetchall()


def _fetch_name_history(changes_cursor, fids) -> dict:
    """{fid: [(old_nickname, new_nickname, change_date), ...] sorted asc}."""
    if not fids:
        return {}
    out: dict = {}
    placeholders = ",".join("?" * len(fids))
    try:
        changes_cursor.execute(
            f"SELECT fid, old_nickname, new_nickname, change_date "
            f"FROM nickname_changes WHERE fid IN ({placeholders}) "
            f"ORDER BY change_date ASC",
            [int(f) for f in fids])
        for fid, old_n, new_n, dt in changes_cursor.fetchall():
            out.setdefault(int(fid), []).append((old_n or "", new_n or "", dt or ""))
    except Exception as e:
        logger.warning(f"Name-history lookup failed: {e}")
    return out


def get_match_roster(users_cursor, changes_cursor, alliance_id, *,
                     as_of_date=None, include_history=False):
    """Roster for fuzzy matching, as match_roster entries.

    Always includes each member's current name (full weight, the reliable
    fallback when there's no sync/history). When `as_of_date` is given, also
    includes the name the player had on that date (full weight) so a renamed
    player matches their older screenshot. When `include_history`, also adds
    every other past name at a score penalty. Every entry resolves to the
    member's *current* nickname for display/storage.

    Extracted as a free function (originally `VaultTrack.get_match_roster`),
    parameterized by `users_cursor`/`changes_cursor` (both share the same
    `users`/`nickname_changes` tables across every tracker -- name history
    is alliance-member data, not Vault-Trap-specific) so Capitol War's
    manual-add flow gets this exact date-aware matching too."""
    current = {int(fid): (nick or "") for (fid, nick) in
               _fetch_current_members(users_cursor, alliance_id)}
    if not current:
        return []
    seen: set = set()
    entries: list = []

    def _add(fid, name, penalty):
        name = (name or "").strip()
        if not name:
            return
        key = (fid, name.lower())
        if key in seen:
            return
        seen.add(key)
        entries.append((fid, name, penalty, current[fid]))

    for fid, nick in current.items():
        _add(fid, nick, 0)

    if not (as_of_date or include_history):
        return entries

    history = _fetch_name_history(changes_cursor, list(current.keys()))
    for fid in current:
        changes = history.get(fid) or []
        if as_of_date and changes:
            _add(fid, _name_at_date(changes, as_of_date, current[fid]), 0)
        if include_history:
            for old_n, new_n, _d in changes:
                _add(fid, old_n, MATCH_HISTORY_PENALTY)
                _add(fid, new_n, MATCH_HISTORY_PENALTY)
    return entries


class VaultTrack(commands.Cog):
    def __init__(self, bot):
        self.bot = bot
        self._resume_done = False

        # Pre-register the default English engine so it's visible in the
        # Health dashboard from boot, even before any vault screenshot runs.
        # Other languages still register lazily on first use.
        if OCR_AVAILABLE:
            get_ocr_model(DEFAULT_OCR_LANG)

        # Persistent DB connections with WAL mode
        self.alliance_conn, self.alliance_cursor = self._open_db("db/alliance.sqlite")
        self.vault_conn, self.vault_cursor = self._open_db(VAULT_DB_PATH)
        self.users_conn, self.users_cursor = self._open_db("db/users.sqlite")
        self.changes_conn, self.changes_cursor = self._open_db("db/changes.sqlite")

        # Ensure required columns exist on alliancesettings
        self.alliance_cursor.execute("PRAGMA table_info(alliancesettings)")
        columns = [col[1] for col in self.alliance_cursor.fetchall()]

        new_columns = {
            "vault_score_channel": "INTEGER",
            "vault_keywords": "TEXT",
            "vault_damage_range": "INTEGER DEFAULT 0",
            "vault_admin_only_view": "INTEGER DEFAULT 0",
            "vault_admin_only_add": "INTEGER DEFAULT 0",
            "vault_ocr_lang": "TEXT DEFAULT 'en'",
            "vault_ocr_fallback_langs": "TEXT DEFAULT ''",
            "vault_ocr_autoprune": "INTEGER DEFAULT 0",
            "vault_ocr_auto_manage": "INTEGER DEFAULT 1",
            "vault_session_timeout_min": "INTEGER DEFAULT 15",
            "vault_auto_delete_screenshots": "INTEGER DEFAULT 1",
            "vault_match_all_history": "INTEGER DEFAULT 0",
            "vault_post_info_message": "INTEGER DEFAULT 1",
            "vault_pin_info_message": "INTEGER DEFAULT 1",
            "vault_info_message_id": "INTEGER",
        }
        for col_name, col_type in new_columns.items():
            if col_name not in columns:
                self.alliance_cursor.execute(
                    f"ALTER TABLE alliancesettings ADD COLUMN {col_name} {col_type}"
                )

        self.alliance_conn.commit()

        # Pre-register engines for languages configured by alliances that
        # actually have a vault channel — so the Bot Health dashboard reflects
        # only usable engines (registration is lazy; no weights load here).
        if OCR_AVAILABLE:
            try:
                self.alliance_cursor.execute(
                    "SELECT vault_ocr_lang, vault_ocr_fallback_langs FROM alliancesettings "
                    "WHERE vault_score_channel IS NOT NULL"
                )
                configured = set()
                for primary, fallbacks_raw in self.alliance_cursor.fetchall():
                    if primary and primary in OCR_LANG_CODES:
                        configured.add(primary)
                    if fallbacks_raw:
                        for f in fallbacks_raw.split(','):
                            f = f.strip()
                            if f in OCR_LANG_CODES:
                                configured.add(f)
                for lang in configured:
                    get_ocr_model(lang)
            except Exception as e:
                logger.warning(f"Could not pre-register configured OCR languages: {e}")

        # DataSubmit helper with shared connections
        self.data_submit = DataSubmit(self.alliance_conn, self.vault_conn)

    @staticmethod
    def _open_db(path):
        """Open a SQLite connection with the cog's standard WAL settings.
        Returns (connection, cursor)."""
        conn = sqlite3.connect(path, timeout=30.0, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.commit()
        return conn, conn.cursor()

    async def cog_unload(self):
        for session in list(_active_sessions.values()):
            session.stop_timer()
            session.finalized = True
        _active_sessions.clear()
        for attr in ('alliance_conn', 'vault_conn', 'users_conn', 'changes_conn'):
            conn = getattr(self, attr, None)
            if conn is not None:
                conn.close()
        await close_remote_ocr_session()

    def get_alliance_roster(self, alliance_id, active_only: bool = True):
        return get_alliance_roster(self.users_cursor, alliance_id, active_only=active_only)

    def get_match_roster(self, alliance_id, *, as_of_date=None, include_history=False):
        # getattr, not self.changes_cursor directly: history lookup is only
        # ever touched when as_of_date/include_history is given (see the
        # free function's early return), so a duck-typed stand-in that only
        # provides users_cursor (e.g. a test double) still works for the
        # common no-history call shape.
        return get_match_roster(self.users_cursor, getattr(self, 'changes_cursor', None), alliance_id,
                                as_of_date=as_of_date, include_history=include_history)

    async def auto_link_unmatched_by_name(self, alliance_id: int, fid: int, nickname: str) -> int:
        """Link this alliance's fid=NULL vault_player_damage rows whose raw_name
        strongly and unambiguously matches `nickname` to the new `fid`. See
        `auto_link_unmatched_rows_by_name` (module level) for the full
        docstring — this is now a thin wrapper binding it to vault_hunts/
        vault_player_damage so existing call sites are unaffected."""
        return await auto_link_unmatched_rows_by_name(
            self.vault_cursor, self.vault_conn,
            alliance_id=alliance_id, fid=fid, nickname=nickname,
            get_roster=self.get_alliance_roster,
            player_table="vault_player_damage", event_table="vault_hunts",
            event_fk_col="hunt_id",
        )

    def get_ocr_language_settings(self, alliance_id):
        """Return (primary_lang, [fallback_langs]) for the alliance."""
        self.alliance_cursor.execute(
            "SELECT vault_ocr_lang, vault_ocr_fallback_langs FROM alliancesettings "
            "WHERE alliance_id = ?",
            (alliance_id,),
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return DEFAULT_OCR_LANG, []
        primary = (row[0] or DEFAULT_OCR_LANG).strip()
        if primary not in OCR_LANG_CODES:
            primary = DEFAULT_OCR_LANG
        fb_raw = (row[1] or '').strip()
        fallbacks = [c.strip() for c in fb_raw.split(',') if c.strip() in OCR_LANG_CODES and c.strip() != primary]
        return primary, fallbacks

    def set_ocr_language_settings(self, alliance_id, primary=None, fallbacks=None):
        """Persist new OCR-language settings. None values keep existing."""
        updates = []
        params = []
        if primary is not None:
            if primary not in OCR_LANG_CODES:
                raise ValueError(f"Unknown OCR language code: {primary}")
            updates.append("vault_ocr_lang = ?")
            params.append(primary)
        if fallbacks is not None:
            cleaned = [c for c in fallbacks if c in OCR_LANG_CODES]
            updates.append("vault_ocr_fallback_langs = ?")
            params.append(",".join(cleaned))
        if not updates:
            return
        params.append(alliance_id)
        self.alliance_cursor.execute(
            f"UPDATE alliancesettings SET {', '.join(updates)} WHERE alliance_id = ?",
            params,
        )
        self.alliance_conn.commit()

    def get_ocr_auto_manage(self, alliance_id) -> bool:
        """When on, the bot derives fallback OCR languages from the roster."""
        self.alliance_cursor.execute(
            "SELECT vault_ocr_auto_manage FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,),
        )
        row = self.alliance_cursor.fetchone()
        # Default on when unset (new system; opt-out via the toggle).
        return bool(row[0]) if row and row[0] is not None else True

    def set_ocr_auto_manage(self, alliance_id, enabled: bool) -> None:
        self.alliance_cursor.execute(
            "UPDATE alliancesettings SET vault_ocr_auto_manage = ? WHERE alliance_id = ?",
            (1 if enabled else 0, alliance_id),
        )
        self.alliance_conn.commit()

    # -------------------------------------------------------------------
    # Settings helpers (column-based, not JSON)
    # -------------------------------------------------------------------

    def get_vault_settings(self, alliance_id: int) -> dict:
        """Return vault settings dict from individual columns."""
        self.alliance_cursor.execute(
            "SELECT vault_score_channel, vault_keywords, vault_damage_range, "
            "vault_admin_only_view, vault_admin_only_add, "
            "vault_session_timeout_min, vault_auto_delete_screenshots, "
            "vault_match_all_history, vault_post_info_message, "
            "vault_pin_info_message, vault_info_message_id "
            "FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,)
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return {
                "channel_id": None,
                "keywords": [],
                "damage_range": 0,
                "admin_only_view": 0,
                "admin_only_add": 0,
                "session_timeout_min": 15,
                "auto_delete_screenshots": 1,
                "match_all_history": 0,
                "post_info_message": 1,
                "pin_info_message": 1,
                "info_message_id": None,
            }
        return {
            "channel_id": row[0],
            "keywords": [kw.strip() for kw in row[1].split(",") if kw.strip()] if row[1] else [],
            "damage_range": row[2] or 0,
            "admin_only_view": row[3] or 0,
            "admin_only_add": row[4] or 0,
            "session_timeout_min": row[5] if row[5] is not None else 15,
            "auto_delete_screenshots": row[6] if row[6] is not None else 1,
            "match_all_history": row[7] or 0,
            "post_info_message": row[8] if row[8] is not None else 1,
            "pin_info_message": row[9] if row[9] is not None else 1,
            "info_message_id": row[10],
        }

    def update_vault_setting(self, alliance_id: int, column: str, value):
        """Update a single vault setting column."""
        allowed = {"vault_score_channel", "vault_keywords", "vault_damage_range",
                    "vault_admin_only_view", "vault_admin_only_add",
                    "vault_session_timeout_min", "vault_auto_delete_screenshots",
                    "vault_match_all_history", "vault_post_info_message",
                    "vault_pin_info_message", "vault_info_message_id"}
        if column not in allowed:
            return
        self.alliance_cursor.execute(
            f"UPDATE alliancesettings SET {column} = ? WHERE alliance_id = ?",
            (value, alliance_id)
        )
        self.alliance_conn.commit()

    # -------------------------------------------------------------------
    # Channel info message ("what to upload" pinned helper)
    # -------------------------------------------------------------------

    def _looks_like_vault_info_message(self, msg: discord.Message) -> bool:
        """True if this is a bot-authored vault info message (any version)."""
        if msg.author.id != self.bot.user.id:
            return False
        content = msg.content or ""
        return any(fp in content for fp in _VAULT_INFO_FINGERPRINTS)

    async def _find_vault_info_messages(self, channel) -> list:
        """Bot-authored info messages sitting pinned in the channel (current or
        stale). Pinned-only, where every version of the message has lived."""
        try:
            pins = await channel.pins()
        except (discord.Forbidden, discord.HTTPException):
            return []
        return [m for m in pins if self._looks_like_vault_info_message(m)]

    async def refresh_vault_info_message(self, alliance_id: int) -> None:
        """Post/edit/pin (or remove) the vault channel's info message to match
        the alliance's post/pin settings. Self-heals duplicates and stale pins."""
        settings = self.get_vault_settings(alliance_id)
        channel_id = settings.get("channel_id")
        if not channel_id:
            return
        channel = self.bot.get_channel(channel_id)
        if channel is None:
            return

        ours = await self._find_vault_info_messages(channel)
        tracked_id = settings.get("info_message_id")
        if tracked_id and not any(m.id == tracked_id for m in ours):
            try:
                tracked_msg = await channel.fetch_message(tracked_id)
                if self._looks_like_vault_info_message(tracked_msg):
                    ours.append(tracked_msg)
            except (discord.NotFound, discord.Forbidden):
                pass

        # Toggled off → remove every one we found and clear the stored id.
        if not settings.get("post_info_message"):
            for m in ours:
                try:
                    await m.delete()
                except (discord.NotFound, discord.Forbidden):
                    pass
            if tracked_id:
                self.update_vault_setting(alliance_id, "vault_info_message_id", None)
            return

        content = render_vault_info_message()

        # Keep exactly one — prefer the tracked one, else the most recent.
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
                logger.warning(f"VaultTrack: cannot post info message in channel {channel_id}")
                return
            self.update_vault_setting(alliance_id, "vault_info_message_id", keep.id)
        else:
            try:
                await keep.edit(content=content)
            except discord.Forbidden:
                return
            if keep.id != tracked_id:
                self.update_vault_setting(alliance_id, "vault_info_message_id", keep.id)

        if settings.get("pin_info_message"):
            try:
                if not keep.pinned:
                    await keep.pin(reason="Vault Trap score channel info message")
            except discord.Forbidden:
                pass
        else:
            try:
                if keep.pinned:
                    await keep.unpin(reason="Vault Trap info message pin toggled off")
            except discord.Forbidden:
                pass

    async def get_keywords_for_channel(self, channel_id: int) -> list:
        """Return keywords list for the alliance that has this vault channel."""
        def _query():
            cur = self.alliance_conn.cursor()
            cur.execute(
                "SELECT vault_keywords FROM alliancesettings WHERE vault_score_channel = ?",
                (channel_id,)
            )
            return cur.fetchone()
        result = await asyncio.to_thread(_query)
        if result and result[0]:
            return [kw.strip() for kw in result[0].split(",") if kw.strip()]
        return []

    # -------------------------------------------------------------------
    # Permission check
    # -------------------------------------------------------------------

    async def check_vault_permission(self, interaction: discord.Interaction, alliance_id: int, action: str) -> bool:
        """
        Check if user has permission for an action on vault data.
        Actions: "view", "add", "manage"
        """
        if action == "manage":
            if self.can_manage_vault(interaction, alliance_id):
                return True
            await interaction.response.send_message(
                f"{theme.deniedIcon} You don't have permission to manage settings for this alliance.",
                ephemeral=True
            )
            return False

        settings = self.get_vault_settings(alliance_id)
        key = "admin_only_add" if action == "add" else "admin_only_view"
        only_admin = settings.get(key, 0)

        if not only_admin or self.can_manage_vault(interaction, alliance_id):
            return True

        await interaction.response.send_message(
            f"{theme.deniedIcon} You don't have permission to {action} vault damage for this alliance.",
            ephemeral=True
        )
        return False

    def can_manage_vault(self, interaction: discord.Interaction, alliance_id: int) -> bool:
        """Pure predicate (no message sent) — can this user manage this alliance's
        vault data? Used to gray/hide edit controls instead of denial ephemerals."""
        return PermissionManager.can_manage_alliance(
            interaction.user.id, interaction.guild_id if interaction.guild else 0, alliance_id)

    async def _resolve_alliance_param(self, interaction: discord.Interaction, alliance: str | None) -> int | None:
        """Resolve the `alliance` slash-command option to an alliance_id.

        The option itself is optional now: when the admin manages exactly one
        alliance, omitting it auto-selects that alliance (same shortcut as the
        picker menus). If they manage more than one, or aren't an admin, they
        still have to name one explicitly. Sends the appropriate error message
        and returns None on failure — the caller should just `return`.
        """
        if alliance:
            try:
                return int(alliance)
            except ValueError:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Invalid alliance selected.", ephemeral=True
                )
                return None

        is_admin, is_global = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please specify an alliance.", ephemeral=True
            )
            return None

        guild_id = interaction.guild_id if interaction.guild else 0
        if is_global:
            # get_admin_alliance_ids returns ([], True) for global admins — "all
            # alliances" — so resolve the real list the same way the vault setup
            # hint check does (see _needs_vault_setup_hint above).
            rows = self.alliance_cursor.execute("SELECT alliance_id FROM alliance_list").fetchall()
            alliance_ids = [row[0] for row in rows]
        else:
            alliance_ids, _ = PermissionManager.get_admin_alliance_ids(interaction.user.id, guild_id)

        if not alliance_ids:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No alliances found for your permissions.", ephemeral=True
            )
            return None
        if len(alliance_ids) > 1:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You manage multiple alliances — please specify which one with the `alliance` option.",
                ephemeral=True
            )
            return None
        return alliance_ids[0]

    # -------------------------------------------------------------------
    # Autocomplete helpers
    # -------------------------------------------------------------------

    async def alliance_autocomplete(self, interaction: discord.Interaction, current: str):
        def _query():
            cur = self.alliance_conn.cursor()
            cur.execute(
                "SELECT alliance_id, name FROM alliance_list WHERE name LIKE ? ORDER BY name LIMIT 20",
                (f"%{current}%",)
            )
            return cur.fetchall()
        rows = await asyncio.to_thread(_query)
        return [
            discord.app_commands.Choice(name=row[1], value=str(row[0]))
            for row in rows
        ]

    async def trap_number_autocomplete(self, interaction: discord.Interaction, current: str):
        return [
            discord.app_commands.Choice(name="1", value=1),
            discord.app_commands.Choice(name="2", value=2),
        ]

    async def player_autocomplete(self, interaction: discord.Interaction, current: str):
        """Suggest player FIDs from the alliance already picked in the
        `alliance` parameter. Returns a choice value of the FID as a string.
        """
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
                (str(alliance_id), f"%{current}%"),
            )
            return cur.fetchall()
        rows = await asyncio.to_thread(_query)
        # Deliberately not active-only: /vault_player_history looks up one
        # specific player's history, former members included — just labelled
        # so admins can tell at a glance.
        return [
            discord.app_commands.Choice(
                name=f"{nick} ({fid})" + ("" if is_active else " (inactive)"),
                value=str(fid),
            )
            for fid, nick, is_active in rows
        ]

    # -------------------------------------------------------------------
    # on_message — OCR processing
    # -------------------------------------------------------------------

    @commands.Cog.listener()
    async def on_ready(self):
        """Restore vault sessions interrupted by a crash/restart, pre-loaded with parsed events."""
        if self._resume_done:
            return
        self._resume_done = True
        from . import ocr_resume
        for key, payload in ocr_resume.load_all('vault'):
            try:
                aid = payload.get('alliance_id')
                if self.bot.get_channel(payload.get('channel_id')) is None or aid is None:
                    ocr_resume.delete(key)
                    continue
                _today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                _hist = bool(self.get_vault_settings(aid).get("match_all_history"))
                roster = self.get_match_roster(aid, as_of_date=_today, include_history=_hist)
                session = VaultSession(
                    cog=self, channel_id=payload['channel_id'], user_id=payload['user_id'],
                    alliance_id=aid, alliance_name=payload.get('alliance_name', ''),
                    roster=roster, primary_lang=payload.get('primary_lang', 'en'),
                    fallback_langs=payload.get('fallback_langs', []),
                    timeout_min=payload.get('timeout_min', 15),
                    auto_delete=payload.get('auto_delete', True))
                session.restore_events(payload)
                _active_sessions[(payload['channel_id'], payload['user_id'])] = session
                await session.resume()
            except Exception as e:
                logger.error(f"VaultTrack: failed to resume session: {e}")
                ocr_resume.delete(key)

        # Reviews posted before this process started have a Submit button
        # that can no longer respond -- discord.py Views are in-memory only
        # (see VaultHuntReviewView.save_pending_checkpoint's doc comment).
        # Rather than leave a dead-looking button for someone to click into
        # a silent failure, mark it clearly expired, same wording as a
        # normal in-process timeout.
        for key, payload in ocr_resume.load_all('vault_review'):
            ocr_resume.delete(key)
            try:
                channel = self.bot.get_channel(payload.get('channel_id'))
                if channel is None:
                    continue
                message = await channel.fetch_message(payload['message_id'])
                embed = discord.Embed(
                    title=f"{theme.hourglassIcon} Vault Trap Review Interrupted",
                    description=(
                        f"The bot restarted before this could be submitted, and "
                        f"the Submit button no longer works. Upload the "
                        f"screenshots again to start a new review."
                    ),
                    color=theme.emColor2,
                )
                await message.edit(content=None, embed=embed, view=None)
            except discord.NotFound:
                pass  # message already deleted -- nothing to warn about
            except Exception as e:
                logger.warning(f"VaultTrack: could not mark interrupted review as expired: {e}")

    @commands.Cog.listener()
    async def on_message(self, message):
        if message.author.bot:
            return
        if not message.content.strip() and not message.attachments:
            return

        # Check if channel is a vault_score_channel and get keywords + alliance_id
        self.alliance_cursor.execute(
            "SELECT alliance_id, vault_keywords FROM alliancesettings WHERE vault_score_channel = ?",
            (message.channel.id,)
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return
        alliance_id, keywords_raw = row

        keywords = [kw.strip() for kw in keywords_raw.split(",") if kw.strip()] if keywords_raw else []
        if keywords and not any(kw.lower() in message.content.lower() for kw in keywords):
            return

        await self.process_vault_hunt_data(message, alliance_id=int(alliance_id))

    async def _enforce_upload_permission(self, message, alliance_id: int) -> bool:
        """Gate the channel-listener screenshot-upload path behind the same
        "Add Permission" toggle /settings already exposes for
        /vault_damage_add (admin_only_add) -- previously only the manual
        slash command respected it; posting a screenshot directly in the
        tracking channel bypassed it entirely, leaving Discord's own
        channel permissions as the only thing standing between a
        non-admin and triggering OCR ingestion. Reuses
        PermissionManager.can_manage_alliance, the exact "alliance admin
        or higher, for this specific alliance" check the toggle's own UI
        already describes as "Admins only" vs "Everyone"."""
        settings = self.get_vault_settings(alliance_id)
        if not settings.get("admin_only_add"):
            return True
        guild_id = message.guild.id if message.guild else 0
        if PermissionManager.can_manage_alliance(message.author.id, guild_id, alliance_id):
            return True
        try:
            await message.channel.send(
                f"{theme.lockIcon} {message.author.mention} Only alliance admins can upload "
                f"Vault Trap screenshots here.",
                delete_after=10,
            )
        except Exception as e:
            logger.warning(f"Vault Trap: could not post upload-denied notice: {e}")
        return False

    async def process_vault_hunt_data(self, message, *, alliance_id=None):
        """Route a screenshot upload into the per-(channel, user) session."""
        image_attachments = [
            a for a in message.attachments
            if any(a.filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg'])
        ]
        if not image_attachments:
            return

        key = (message.channel.id, message.author.id)
        session = _active_sessions.get(key)

        if alliance_id is None:
            if session is not None:
                alliance_id = session.alliance_id
            else:
                self.alliance_cursor.execute(
                    "SELECT alliance_id FROM alliancesettings WHERE vault_score_channel = ?",
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
            # Fresh upload: the event date isn't known until review, so resolve
            # names as of today (≈ current). The opt-in history flag still applies.
            _today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            _hist = bool(self.get_vault_settings(alliance_id).get("match_all_history"))
            roster = self.get_match_roster(
                alliance_id, as_of_date=_today, include_history=_hist)
            primary_lang, _stored_fb = self.get_ocr_language_settings(alliance_id)
            # Auto-manage on → fallbacks derived from roster names (persist-on-change);
            # off → the stored manual fallbacks. auto_managed_fallbacks handles both.
            roster_names = [e[-1] for e in roster if len(e) >= 2]
            fallback_langs = auto_managed_fallbacks(
                alliance_id, roster_names, primary=primary_lang)
            fallback_langs = sorted(fallback_langs, key=lambda l: l in _LATIN_ONLY_LANGS)
            timeout_min, auto_delete = self.get_session_settings(alliance_id)

            session = VaultSession(
                cog=self,
                channel_id=message.channel.id,
                user_id=message.author.id,
                alliance_id=alliance_id,
                alliance_name=alliance_name,
                roster=roster,
                primary_lang=primary_lang,
                fallback_langs=fallback_langs,
                timeout_min=timeout_min,
                auto_delete=auto_delete,
            )
            _active_sessions[key] = session

            try:
                session.session_view = VaultSessionView(session)
                session.progress_msg = await message.channel.send(
                    embed=session.build_progress_embed(),
                    view=session.session_view,
                )
            except Exception as e:
                logger.warning(f"Vault Trap: could not post collecting message: {e}")

        await session.add_message(message, image_attachments)

    def get_session_settings(self, alliance_id: int) -> tuple[int, bool]:
        """Return (timeout_min, auto_delete_screenshots) for the alliance."""
        self.alliance_cursor.execute(
            "SELECT vault_session_timeout_min, vault_auto_delete_screenshots "
            "FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,),
        )
        row = self.alliance_cursor.fetchone()
        if not row:
            return 15, True
        timeout = row[0] if row[0] is not None else 15
        auto_delete = bool(row[1]) if row[1] is not None else True
        return int(timeout), auto_delete

    async def _ocr_attachment_to_result(self, image_bytes: bytes, primary_lang: str,
                                        fallback_langs: list, *, filename: str = "",
                                        roster: list | None = None,
                                        alliance_id: int | None = None,
                                        progress_callback=None,
                                        session=None) -> ImageResult:
        """OCR one screenshot (primary + fallbacks) → ImageResult.
        `progress_callback(phase, lang)` is awaited per OCR phase. When called
        with `session`, OCR engines are reused across all calls for that
        session; otherwise each call uses its own short acquire/release."""
        result = ImageResult()
        if progress_callback:
            await progress_callback('ocr', primary_lang)
        try:
            async with _get_ocr_semaphore():
                primary_boxed = await ocr_bytes_with_boxes(image_bytes, primary_lang, session=session)
            extracted_text = ' '.join(t for t, _b in primary_boxed)
        except Exception as e:
            logger.error(f"Vault Trap OCR error ({primary_lang}) on {filename}: {e}")
            return result
        if not extracted_text.strip():
            return result

        result.ok = True
        repaired = repair_ocr_digits(extracted_text)
        logger.info(
            f"Vault Trap OCR [{primary_lang}] ({filename}): {extracted_text!r} → {repaired!r}"
        )

        trap, rallies, damage = extract_vault_hunt_stats(repaired)
        result.trap = trap
        result.rallies = rallies
        result.total_damage = damage
        result.date = extract_hunt_date(repaired) or ""

        img_rows = {row['damage']: row for row in parse_player_rows(repaired)}

        def _score_snapshot():
            return {dmg: name_match_score(r.get('name') or '', roster)
                    for dmg, r in img_rows.items()}
        primary_filled = sum(1 for r in img_rows.values()
                             if not is_row_unfilled(r, roster))
        record_ocr_lang_run(alliance_id, primary_lang, 'primary', primary_filled)

        # Stale DB rows can list the current primary as a fallback.
        fallback_langs = [lang for lang in fallback_langs if lang != primary_lang]
        if fallback_langs and any(is_row_unfilled(r, roster) for r in img_rows.values()):
            seen_repaired_texts = {repaired}
            attempts = 0
            for fb_lang in fallback_langs:
                if attempts >= MAX_FALLBACK_ATTEMPTS:
                    logger.info(
                        f"Vault Trap OCR: fallback budget hit ({MAX_FALLBACK_ATTEMPTS} "
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
                    logger.warning(f"Vault Trap OCR fallback {fb_lang} failed: {e}")
                    continue
                if not fb_text.strip():
                    continue
                fb_repaired = repair_ocr_digits(fb_text)
                if fb_repaired in seen_repaired_texts:
                    logger.info(
                        f"Vault Trap OCR fallback [{fb_lang}] skipped: identical "
                        f"output to a previous pass"
                    )
                    record_ocr_lang_run(alliance_id, fb_lang, 'fallback', 0)
                    continue
                seen_repaired_texts.add(fb_repaired)
                logger.info(
                    f"Vault Trap OCR fallback [{fb_lang}] ({filename}): {fb_repaired!r}"
                )
                if not _output_matches_lang_script(fb_repaired, fb_lang):
                    logger.info(
                        f"Vault Trap OCR fallback [{fb_lang}] rejected: "
                        f"output contains no {fb_lang}-script characters"
                    )
                    record_ocr_lang_run(alliance_id, fb_lang, 'fallback', 0)
                    continue
                attempts += 1
                pre_scores = _score_snapshot()
                fb_rows = parse_player_rows(fb_repaired)
                if fb_lang in _RTL_LANGS:
                    for fr in fb_rows:
                        if fr.get('name'):
                            fr['name'] = _reverse_for_rtl(fr['name'], fb_lang)
                filled = merge_fallback_rows_by_damage(
                    img_rows, fb_rows, roster, fb_lang
                )
                if not filled:
                    filled = merge_fallback_rows_by_boxes(
                        img_rows, primary_boxed, fb_boxed, roster, fb_lang
                    )
                # Last resort: text-position anchor, only when cheap-merge and box-align both missed.
                if not filled and fb_lang not in _LATIN_ONLY_LANGS:
                    fill_unfilled_by_position(
                        img_rows, fb_repaired, fb_lang, filename, roster
                    )
                rows_improved = sum(
                    1 for dmg, r in img_rows.items()
                    if name_match_score(r.get('name') or '', roster) > pre_scores.get(dmg, 0)
                )
                record_ocr_lang_run(alliance_id, fb_lang, 'fallback', rows_improved)

        result.rows = img_rows
        return result

    async def _finalize_session(self, session: VaultSession, *, timed_out: bool):
        """Build the review for the largest detected event in the session."""
        if not session.events:
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

        tracker = VaultAutoDeleteTracker(session.source_messages, session.auto_delete)
        today_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        primary_event = max(
            session.events,
            key=lambda ev: (ev.image_count, len(ev.merged_rows)),
        )
        dropped_events = [ev for ev in session.events if ev is not primary_event]
        dropped_screenshots = sum(ev.image_count for ev in dropped_events)

        merged_rows = dict(primary_event.merged_rows)
        merged_rows.pop(primary_event.damage_int, None)
        rows_sum = sum(r['damage'] for r in merged_rows.values())
        damage_int = primary_event.damage_int
        if rows_sum > damage_int:
            damage_int = rows_sum
        for i, row in enumerate(sorted(merged_rows.values(), key=lambda r: -r['damage'])):
            row['rank'] = i + 1

        hunt_meta = {
            'date': primary_event.date_value or today_date,
            'trap_number': int(primary_event.trap_value)
                if primary_event.trap_value and primary_event.trap_value.isdigit() else None,
            'rallies': int(primary_event.rallies_value)
                if primary_event.rallies_value and primary_event.rallies_value.isdigit() else None,
            'total_damage': damage_int or 0,
            'event_time': None,
        }
        sorted_rows = sorted(
            merged_rows.values(),
            key=lambda r: (r['rank'] if r['rank'] is not None else 999, -r['damage']),
        )
        existing_hunt_id, existing_rows = self.data_submit._load_existing_hunt(
            session.alliance_id, hunt_meta['date'], hunt_meta['trap_number'])
        review = VaultHuntReviewView(
            cog=self,
            data_submit=self.data_submit,
            hunt_meta=hunt_meta,
            rows=sorted_rows,
            roster=session.roster,
            alliance_id=session.alliance_id,
            alliance_name=session.alliance_name,
            original_user_id=session.user_id,
            auto_delete_tracker=tracker,
            source_messages=session.source_messages,
            existing_hunt_id=existing_hunt_id,
            existing_rows=existing_rows,
        )
        tracker.register()

        embed = review.build_embed()
        prefixes = []
        if timed_out:
            prefixes.append(
                f"{theme.hourglassIcon} **Session timed out after "
                f"{session.timeout_min} min**. Review and Submit when ready."
            )
        if dropped_screenshots:
            prefixes.append(
                f"{theme.warnIcon} **{dropped_screenshots} screenshot"
                f"{'s' if dropped_screenshots != 1 else ''} didn't fit this "
                f"event and were ignored.** If they were from a different "
                f"hunt (different trap, rallies, or alliance total), upload "
                f"them as a separate batch."
            )
        if prefixes:
            embed.description = "\n".join(prefixes) + "\n\n" + (embed.description or "")
        if not session.any_ocr_success:
            embed.title = f"{theme.warnIcon} OCR could not read the image(s): add rows manually"

        channel = self.bot.get_channel(session.channel_id)
        if session.progress_msg is not None:
            try:
                await session.progress_msg.edit(embed=embed, view=review)
                review.message = session.progress_msg
                review.save_pending_checkpoint()
                return
            except Exception as e:
                logger.warning(f"Vault Trap: could not edit progress into review: {e}")
        if channel:
            try:
                review.message = await channel.send(embed=embed, view=review)
                review.save_pending_checkpoint()
            except Exception as e:
                logger.warning(f"Vault Trap: could not send review: {e}")

    # -------------------------------------------------------------------
    # Slash commands
    # -------------------------------------------------------------------

    @app_commands.command(name="vault_damage_add",
                          description="Create a Vault Trap entry manually and add players in the review editor")
    @app_commands.autocomplete(alliance=alliance_autocomplete, trap_number=trap_number_autocomplete)
    @app_commands.describe(
        trap_number="Vault Trap operation/wave number",
        alliance="Alliance name (optional if you only manage one)",
        rallies="Number of rallies (optional; can be set in the editor)",
        total_damage="Total alliance damage (optional; can be set in the editor)",
        date="UTC date (YYYY-MM-DD). Defaults to today."
    )
    async def vault_damage_add(self, interaction: discord.Interaction, trap_number: int,
                              alliance: str | None = None,
                              rallies: int | None = None, total_damage: int | None = None,
                              date: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return

        allowed = await self.check_vault_permission(interaction, alliance_id, "add")
        if not allowed:
            return

        if trap_number not in (1, 2):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Vault Trap operation number must be a positive number.", ephemeral=True
            )
            return

        if not date:
            date = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?",
            (alliance_id,)
        )
        row = self.alliance_cursor.fetchone()
        alliance_name = row[0] if row else f"Alliance ID: {alliance_id}"

        # Open the same review editor used after a screenshot upload, but with no
        # rows — the admin adds players by ID/name via Add Player, then Submits.
        _hist = bool(self.get_vault_settings(alliance_id).get("match_all_history"))
        roster = self.get_match_roster(
            alliance_id, as_of_date=date, include_history=_hist)

        hunt_meta = {
            'date': date,
            'trap_number': int(trap_number),
            'rallies': int(rallies) if rallies else None,
            'total_damage': int(total_damage) if total_damage else 0,
            'event_time': None,
        }

        review = VaultHuntReviewView(
            cog=self,
            data_submit=self.data_submit,
            hunt_meta=hunt_meta,
            rows=[],
            roster=roster,
            alliance_id=alliance_id,
            alliance_name=alliance_name,
            original_user_id=interaction.user.id,
        )
        await interaction.response.send_message(embed=review.build_embed(), view=review)
        review.message = await interaction.original_response()
        review.save_pending_checkpoint()

    @app_commands.command(name="vault_damage_view", description="View Vault Trap damage for an alliance")
    @app_commands.autocomplete(alliance=alliance_autocomplete, trap_number=trap_number_autocomplete)
    @app_commands.describe(
        trap_number="Vault Trap operation/wave number",
        alliance="Select an alliance (optional if you only manage one)",
        from_date="Optional — leave blank, Time Range presets/custom range come after",
        to_date="Optional — leave blank, Time Range presets/custom range come after"
    )
    async def vault_damage_view(self, interaction: discord.Interaction, trap_number: int,
                               alliance: str | None = None,
                               from_date: str | None = None, to_date: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return

        allowed = await self.check_vault_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        # Reject bad free-text dates before deferring, or the interaction hangs on "thinking".
        try:
            parsed_from = datetime.strptime(from_date, "%Y-%m-%d").date() if from_date else None
            parsed_to = datetime.strptime(to_date, "%Y-%m-%d").date() if to_date else None
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date - use YYYY-MM-DD (e.g. 2026-07-13).",
                ephemeral=True
            )
            return

        await interaction.response.defer()

        view = VaultDamageView(
            data_submit=self.data_submit,
            cog=self,
            original_user_id=interaction.user.id,
            alliance_id=alliance_id,
            trap_number=trap_number,
            from_date=parsed_from,
            to_date=parsed_to
        )

        embed, file = await self.data_submit.process_view(
            alliance_id=alliance_id,
            trap_number=trap_number,
            from_date=from_date,
            to_date=to_date,
        )

        if not embed:
            await interaction.followup.send(
                f"{theme.deniedIcon} No data found for the selected parameters.", ephemeral=True
            )
            return

        # file=None is not discord.py's MISSING sentinel and crashes the send.
        if file:
            await interaction.followup.send(embed=embed, file=file, view=view)
        else:
            await interaction.followup.send(embed=embed, view=view)

    @app_commands.command(name="vault_player_history", description="Show a player's Vault Trap damage history")
    @app_commands.autocomplete(alliance=alliance_autocomplete,
                               player=player_autocomplete,
                               trap_number=trap_number_autocomplete)
    @app_commands.describe(
        player="Player (pick from the suggestions or enter an ID)",
        alliance="Alliance the player belongs to (optional if you only manage one)",
        trap_number="Filter by operation/wave number (optional; shows all if omitted)",
    )
    async def vault_player_history(self, interaction: discord.Interaction,
                                  player: str, alliance: str | None = None,
                                  trap_number: int | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return

        allowed = await self.check_vault_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        try:
            fid = int(player)
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid player — must be an ID.", ephemeral=True
            )
            return

        await interaction.response.defer()

        self.users_cursor.execute(
            "SELECT nickname FROM users WHERE fid = ?", (fid,)
        )
        nick_row = self.users_cursor.fetchone()
        nickname = nick_row[0] if nick_row else f"ID {fid}"

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
        )
        an_row = self.alliance_cursor.fetchone()
        alliance_name = an_row[0] if an_row else f"Alliance {alliance_id}"

        query = (
            "SELECT h.date, bpd.damage, bpd.rank "
            "FROM vault_player_damage bpd "
            "JOIN vault_hunts h ON h.id = bpd.hunt_id "
            "WHERE h.alliance_id = ? AND bpd.fid = ?"
        )
        params = [alliance_id, fid]
        if trap_number:
            query += " AND h.trap_number = ?"
            params.append(trap_number)
        query += " ORDER BY h.date ASC"
        rows = self.vault_cursor.execute(query, params).fetchall()

        embed, image_file = vault_player_history_embed(
            alliance_name=alliance_name, fid=fid, nickname=nickname,
            trap_number=trap_number, rows=rows,
        )
        # file=None is not discord.py's MISSING sentinel and crashes the send.
        if image_file:
            await interaction.followup.send(embed=embed, file=image_file)
        else:
            await interaction.followup.send(embed=embed)

    @app_commands.command(name="vault_compare",
                          description="Compare Vault Trap damage history across multiple players")
    @app_commands.autocomplete(alliance=alliance_autocomplete)
    @app_commands.describe(
        alliance="Select an alliance (optional if you only manage one)",
        from_date="Optional — leave blank, presets/custom range come after picking players",
        to_date="Optional — leave blank, presets/custom range come after picking players",
    )
    async def vault_compare(self, interaction: discord.Interaction, alliance: str | None = None,
                            from_date: str | None = None, to_date: str | None = None):
        alliance_id = await self._resolve_alliance_param(interaction, alliance)
        if alliance_id is None:
            return

        allowed = await self.check_vault_permission(interaction, alliance_id, "view")
        if not allowed:
            return

        # Reject bad free-text dates before building the view (same convention
        # as /vault_damage_view — invalid dates fail fast instead of just
        # silently matching nothing).
        try:
            if from_date:
                datetime.strptime(from_date, "%Y-%m-%d")
            if to_date:
                datetime.strptime(to_date, "%Y-%m-%d")
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date - use YYYY-MM-DD (e.g. 2026-07-13).",
                ephemeral=True
            )
            return

        self.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
        )
        an_row = self.alliance_cursor.fetchone()
        alliance_name = an_row[0] if an_row else f"Alliance {alliance_id}"

        view = VaultCompareView(
            cog=self, original_user_id=interaction.user.id, alliance_id=alliance_id,
            alliance_name=alliance_name, from_date=from_date, to_date=to_date,
        )
        if not view.roster:
            await interaction.response.send_message(
                f"{theme.deniedIcon} No roster members found for {alliance_name}.",
                ephemeral=True
            )
            return
        await interaction.response.send_message(embed=view.build_picker_embed(), view=view)

    # -------------------------------------------------------------------
    # Main menu entry point
    # -------------------------------------------------------------------

    def _needs_vault_setup_hint(self, user_id: int, guild_id: int) -> bool:
        """True iff none of the user's accessible alliances has a vault channel
        configured yet. Used to hide the 'new here?' hint once any in-scope
        alliance is set up — see show_vault_track_menu."""
        is_admin, is_global = PermissionManager.is_admin(user_id)
        if not is_admin:
            return False
        try:
            if is_global:
                row = self.alliance_cursor.execute(
                    "SELECT 1 FROM alliancesettings "
                    "WHERE vault_score_channel IS NOT NULL LIMIT 1"
                ).fetchone()
                return row is None

            alliance_ids, _ = PermissionManager.get_admin_alliance_ids(user_id, guild_id)
            if not alliance_ids:
                return True
            placeholders = ','.join('?' * len(alliance_ids))
            row = self.alliance_cursor.execute(
                f"SELECT 1 FROM alliancesettings "
                f"WHERE alliance_id IN ({placeholders}) "
                f"AND vault_score_channel IS NOT NULL LIMIT 1",
                alliance_ids,
            ).fetchone()
            return row is None
        except Exception as e:
            logger.warning(f"Vault Trap setup hint check failed: {e}")
            return False

    async def show_vault_track_menu(self, interaction: discord.Interaction):
        """Display the vault damage tracking main menu."""
        try:
            view = VaultMenuView(cog=self, original_user_id=interaction.user.id)

            setup_hint = ""
            if self._needs_vault_setup_hint(
                interaction.user.id,
                interaction.guild_id if interaction.guild else 0,
            ):
                setup_hint = (
                    f"{theme.warnIcon} **New here?** Click **Vault Trap Channel "
                    f"Setup** below to pick a channel for an ally. Until "
                    f"that's done, the bot won't process any screenshots.\n\n"
                )

            embed = discord.Embed(
                title=f"{theme.chartIcon} Vault Trap Damage Tracking",
                description=(
                    f"Track your alliance's Vault Trap damage by uploading in-game screenshots.\n\n"
                    f"{setup_hint}"
                    f"**Available Operations**\n"
                    f"{theme.upperDivider}\n"
                    f"{theme.chartIcon} **Vault Trap Damage**\n"
                    f"└ Damage charts, top players, and per-hunt player breakdowns\n\n"
                    f"{theme.editListIcon} **Vault Trap Channel Setup**\n"
                    f"└ Pick the channel, keywords, OCR engines and chart range\n\n"
                    f"{theme.settingsIcon} **Settings**\n"
                    f"└ Session timeout, auto-delete, and permissions\n"
                    f"{theme.lowerDivider}"
                ),
                color=theme.emColor1
            )

            await safe_edit_message(interaction, embed=embed, view=view, content=None, clear_attachments=True)

        except Exception as e:
            logger.error(f"Error in show_vault_track_menu: {e}")
            print(f"[ERROR] Error in show_vault_track_menu: {e}")
            try:
                if not interaction.response.is_done():
                    await interaction.response.send_message(
                        f"{theme.deniedIcon} Failed to load Vault Trap Tracking menu.", ephemeral=True
                    )
            except Exception:
                pass


# ---------------------------------------------------------------------------
# VaultHuntReviewView — paginated per-row review with roster matching
# ---------------------------------------------------------------------------

_STATUS_ICONS = {
    'auto': '✅',
    'likely': '🟡',
    'ambiguous': '⚠',
    'none': '❌',
    'manual': '✏',
    'collision': '⚠',
}

_STATUS_LABELS = {
    'auto': 'auto match',
    'likely': 'likely match',
    'ambiguous': 'ambiguous match',
    'none': 'no match',
    'manual': 'manual entry',
    'collision': 'contested — needs review',
}


class RetryOcrLanguagePicker(discord.ui.View):
    """Ephemeral one-shot language selector shown when an admin clicks
    'Retry OCR' on a review. Picking a language drives the parent
    review's `_run_retry_ocr`."""

    def __init__(self, parent_review, current_primary):
        super().__init__(timeout=7200)
        self.parent_review = parent_review

        # Offer every configured engine except the one already in use as
        # primary — there's no point retrying with the same model.
        opts = [
            discord.SelectOption(label=label, value=code)
            for code, label in OCR_LANGUAGES if code != current_primary
        ]
        select = discord.ui.Select(placeholder="Pick an OCR engine…", options=opts)
        select.callback = self._on_pick
        self.add_item(select)

    async def _on_pick(self, interaction: discord.Interaction):
        new_primary = interaction.data['values'][0]
        await interaction.response.edit_message(
            content=(
                f"{theme.hourglassIcon} Re-running OCR with `{new_primary}`… "
                f"this can take a few seconds per screenshot."
            ),
            view=None,
        )
        await self.parent_review._run_retry_ocr(interaction, new_primary)


class RetryOcrPreviewView(discord.ui.View):
    def __init__(self, parent_review, new_primary_lang: str, proposal: dict):
        super().__init__(timeout=300)
        self.parent_review = parent_review
        self.new_primary_lang = new_primary_lang
        self.proposal = proposal

    @discord.ui.button(label="Apply Changes", style=discord.ButtonStyle.success,
                       emoji=theme.verifiedIcon)
    async def apply(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.parent_review.original_user_id):
            return
        applied = self.parent_review._apply_retry_proposal(self.proposal)
        if self.parent_review.message is not None:
            try:
                await self.parent_review.message.edit(
                    embed=self.parent_review.build_embed(),
                    view=self.parent_review,
                )
            except Exception as e:
                logger.warning(f"Vault Trap retry OCR apply: refresh failed: {e}")
        parts = []
        if applied['rows_added']:
            parts.append(
                f"**{applied['rows_added']}** new row"
                f"{'s' if applied['rows_added'] != 1 else ''}"
            )
        if applied['rows_upgraded']:
            parts.append(
                f"**{applied['rows_upgraded']}** match"
                f"{'es' if applied['rows_upgraded'] != 1 else ''} upgraded"
            )
        summary = " · ".join(parts) or "no rows changed"
        await interaction.response.edit_message(
            content=(
                f"{theme.verifiedIcon} Applied Re-OCR with "
                f"`{self.new_primary_lang}`: {summary}. Existing confirmed "
                f"rows left untouched."
            ),
            view=None,
        )

    @discord.ui.button(label="Discard", style=discord.ButtonStyle.danger,
                       emoji=theme.deniedIcon)
    async def discard(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.parent_review.original_user_id):
            return
        await interaction.response.edit_message(
            content=(
                f"{theme.infoIcon} Re-OCR with `{self.new_primary_lang}` "
                f"discarded. The review below is unchanged."
            ),
            view=None,
        )


def resolve_unique_assignments(rows: list, roster: list | None = None) -> None:
    """Greedy unique-fid assignment across `rows` (mutated in place). Manual
    entries reserve their fid first, then highest-score wins.

    Same-event collision guard: a leaderboard can't legitimately list the
    same real player twice, so if 2+ non-manual rows independently pick the
    SAME fid as their own #1 (best) candidate, that's strong evidence at
    least one of those reads is OCR-corrupted -- neither can be trusted
    blindly. Rather than letting the higher scorer silently win and
    footnoting the loser as "taken by another row" (implying the winner
    itself is fine), both are downgraded to 'collision' so an admin resolves
    them by hand instead of auto/likely-confirming either.

    Extracted as a free function (originally `VaultHuntReviewView.
    _resolve_unique_assignments`) so this exact algorithm -- proven against
    the real production mismatch in docs/ocr-reference/
    vault_trap_mismatch_2026-08-23.md -- is directly importable by any other
    ranking-page tracker (e.g. Capitol War) instead of being re-derived and
    risking the same collision bug it was written to catch. `roster` is
    accepted for signature symmetry with match_roster-style helpers but is
    not currently used (candidates are pre-computed on each row)."""
    assigned_fids: set = set()
    for row in rows:
        if row.get('status') == 'manual' and row.get('fid'):
            assigned_fids.add(row['fid'])
        else:
            row['fid'] = None
            row['nickname'] = None
            row['status'] = 'none'
            row['match_score'] = None

    top_fid_rows: dict = {}
    for row_idx, row in enumerate(rows):
        if row.get('status') == 'manual':
            continue
        cands = row.get('candidates') or []
        if cands:
            top_fid_rows.setdefault(cands[0][0], []).append(row_idx)
    collided_rows = {idx for idxs in top_fid_rows.values() if len(idxs) > 1 for idx in idxs}
    for idx in collided_rows:
        rows[idx]['status'] = 'collision'

    candidates = []
    for row_idx, row in enumerate(rows):
        if row.get('status') in ('manual', 'collision'):
            continue
        for fid, nick, score in row.get('candidates') or []:
            candidates.append((score, row_idx, fid, nick))
    candidates.sort(key=lambda c: (-c[0], c[1]))

    for score, row_idx, fid, nick in candidates:
        row = rows[row_idx]
        if row.get('fid') is not None or fid in assigned_fids:
            continue
        row['fid'] = fid
        row['nickname'] = nick
        row['status'] = 'auto' if score >= MATCH_AUTO_CONFIRM else 'likely'
        row['match_score'] = score
        assigned_fids.add(fid)

    # Second chance: a row whose every candidate fid was already claimed
    # re-matches against the unassigned roster, so duplicate-name rows each
    # land on a distinct id instead of going unmatched. Collision rows are
    # deliberately excluded -- rematching a suspect OCR read against
    # whatever's left could just as easily produce a second wrong match.
    for row in rows:
        if row.get('status') in ('manual', 'collision') or row.get('fid') is not None:
            continue
        if not row.get('candidates'):
            continue  # never matched anything — leave as a genuine no-match
        remaining = [e for e in (roster or []) if e[0] not in assigned_fids]
        alt = match_roster(row.get('name') or '', remaining)
        if not alt:
            continue
        fid, nick, score = alt[0]
        row['fid'] = fid
        row['nickname'] = nick
        row['status'] = 'auto' if score >= MATCH_AUTO_CONFIRM else 'likely'
        row['match_score'] = score
        assigned_fids.add(fid)


def rank_sequence_warnings(rows: list, *, check_gaps: bool = True) -> list[str]:
    """Gaps and duplicates among EXPLICIT rank digits (rank_explicit=True)
    -- the inferred top-3 medal-badge ranks are deliberately excluded, since
    those are a sequential guess rather than something OCR actually read,
    and would trivially mask real problems. A dropped row (like the real
    "XXX TARGET" rank-10 case this guards against) leaves a gap in the
    explicit sequence; a misread rank digit colliding with another row's
    correct one shows up as a duplicate. Returns a list of warning strings,
    or [] when the explicit ranks look contiguous and unique.

    `check_gaps` controls the "missing from these screenshots" half only --
    it assumes the explicit ranks are supposed to form one contiguous run,
    which holds for Vault Trap's own ranking page (one alliance's full
    ranked list) but NOT for a caller whose rows are a filtered SUBSET of a
    larger ranking (e.g. Capitol War's Honor Roll, which lists the whole
    state and keeps only one alliance's tagged rows -- most of the numbers
    between that alliance's min/max rank legitimately belong to other
    alliances and were correctly discarded, not "missing"; see
    docs/ocr-reference/capitol_war_mismatch_2026-08-23.md, where this
    produced dozens of false-positive gap warnings burying the real
    duplicate signal). The duplicate check has no such assumption and
    always runs. Default True keeps every existing caller's behavior
    unchanged.

    Extracted as a free function (originally `VaultHuntReviewView.
    _rank_sequence_warnings`) for reuse by other ranking-page trackers."""
    explicit_ranks = [r['rank'] for r in rows
                       if r.get('rank_explicit') and r.get('rank') is not None]
    if not explicit_ranks:
        return []
    counts: dict = {}
    for rank in explicit_ranks:
        counts[rank] = counts.get(rank, 0) + 1
    dupes = sorted(rank for rank, n in counts.items() if n > 1)
    warnings = [
        f"Rank {rank} appears twice — one of these ranks may be misread"
        for rank in dupes
    ]
    if check_gaps:
        present = set(explicit_ranks)
        missing = [r for r in range(min(present), max(present) + 1) if r not in present]
        warnings += [
            f"Rank {rank} appears to be missing from these screenshots"
            for rank in missing
        ]
    return warnings


class VaultHuntReviewView(discord.ui.View):
    """Review/edit OCR-extracted hunt data; submit persists to DB."""

    ROWS_PER_PAGE = 25

    def __init__(self, cog, data_submit, *, hunt_meta, rows, roster,
                 alliance_id, alliance_name, original_user_id,
                 auto_delete_tracker=None, source_messages=None,
                 existing_hunt_id=None, existing_rows=None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.data_submit = data_submit
        self.hunt_meta = hunt_meta
        self.roster = roster
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.original_user_id = original_user_id
        self.auto_delete_tracker = auto_delete_tracker
        # Used by Retry OCR to re-download attachments.
        self.source_messages = source_messages or []
        # Set when re-uploading a trap+date already on record (edit in place).
        self.existing_hunt_id = existing_hunt_id
        self.message = None
        self.page = 0
        self._tracker_resolved = False

        self.rows = [self._enrich_row(r)
                     for r in self._merge_existing_rows(rows, existing_rows or [])]
        self._resolve_unique_assignments()
        self._sort_rows()
        self._build_components()

    def _checkpoint_key(self) -> str | None:
        return f"vaultreview:{self.message.id}" if self.message is not None else None

    def save_pending_checkpoint(self):
        """Persists just enough to find and clearly expire this review's
        message after a restart -- NOT enough to reconstruct it. The
        Submit button only exists in this process's memory; a restart
        silently kills it (Discord shows the user a generic interaction
        failure with no explanation), so this is a safety net rather than
        real resume: on restart, VaultTrack.on_ready() edits the message
        to say what happened and asks for a re-upload, same wording
        on_timeout() already uses for the "went stale, start over" case.
        Cleared the moment this review resolves any other way (submit,
        cancel, or a normal in-process timeout)."""
        key = self._checkpoint_key()
        if key is None:
            return
        from . import ocr_resume
        ocr_resume.save(key, 'vault_review', {
            'channel_id': self.message.channel.id,
            'message_id': self.message.id,
        })

    def _clear_pending_checkpoint(self):
        key = self._checkpoint_key()
        if key is None:
            return
        from . import ocr_resume
        ocr_resume.delete(key)

    async def _notify_tracker_submit(self):
        # Cleanup must never break submit UX.
        if self.auto_delete_tracker and not self._tracker_resolved:
            self._tracker_resolved = True
            try:
                await self.auto_delete_tracker.on_submit()
            except Exception as e:
                logger.warning(f"Vault Trap auto-delete tracker (on_submit) raised: {e}")

    async def _notify_tracker_cancel(self):
        if self.auto_delete_tracker and not self._tracker_resolved:
            self._tracker_resolved = True
            try:
                await self.auto_delete_tracker.on_cancel()
            except Exception as e:
                logger.warning(f"Vault Trap auto-delete tracker (on_cancel) raised: {e}")

    def _enrich_row(self, raw_row):
        candidates = resolve_against_roster(
            raw_row.get('name') or '', self.roster, self.alliance_id)
        status = classify_match(candidates)
        fid = nickname = None
        if status == 'auto':
            fid, nickname, _ = candidates[0]
        return {
            'name': raw_row.get('name') or '',
            'damage': int(raw_row.get('damage') or 0),
            'rank': raw_row.get('rank'),
            # Only True when OCR found an actual rank digit in this row's own
            # chunk -- False for both a synthesized top-3 guess and a row
            # carried over from a previous submission (no OCR evidence this
            # time), so rank-sequence validation only trusts real reads.
            'rank_explicit': bool(raw_row.get('rank_explicit')),
            'fid': fid,
            'nickname': nickname,
            'candidates': candidates,
            'status': status,
        }

    def _merge_existing_rows(self, new_rows, old_rows):
        """Keep the better-matching name per row when re-uploading an existing trap+date."""
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
            cands = resolve_against_roster(name or '', self.roster, self.alliance_id)
            return cands[0][2] if cands else 0

        merged = []
        for n in new_rows:
            # Pair by exact damage first, then by rank so one misread digit doesn't add a row.
            old = take(by_dmg.get(int(n.get('damage') or 0), []))
            if old is None and n.get('rank') is not None:
                old = take(by_rank.get(n['rank'], []))
            row = dict(n)
            if old is not None and score(old['name']) > score(n.get('name')):
                row['name'] = old['name']
            merged.append(row)
        # Players only the previous submission had (the new upload missed them).
        for o in old_rows:
            if id(o) not in used:
                merged.append({'name': o['name'], 'damage': o['damage'], 'rank': o.get('rank'),
                                'rank_explicit': bool(o.get('rank_explicit'))})
        return merged

    def _resolve_unique_assignments(self):
        resolve_unique_assignments(self.rows, self.roster)

    def _sort_rows(self):
        self.rows.sort(
            key=lambda r: (r['rank'] if r['rank'] is not None else 999, -r['damage'])
        )

    def _lookup_nickname(self, fid):
        for entry in self.roster:
            f, _match_name, _penalty, display = _roster_parts(entry)
            if f == fid:
                return display
        return None

    def _total_pages(self):
        return max(1, -(-len(self.rows) // self.ROWS_PER_PAGE))

    def _rank_sequence_warnings(self):
        return rank_sequence_warnings(self.rows)

    def build_embed(self):
        # Warnings above, button descriptors below — mirrors the post-submit
        # hunt editor's layout. `none`-with-name = roster gap and `likely` =
        # OCR captured well enough; neither counts as "unreadable".
        parts = []
        if self.existing_hunt_id is not None:
            parts.append(
                f"{theme.editListIcon} **Editing this alliance's existing Trap "
                f"{self.hunt_meta.get('trap_number')} hunt for {self.hunt_meta.get('date')}.** "
                f"Submitting overwrites that record; matches from the previous "
                f"submission are kept where the new screenshots came up blank."
            )
        unreadable_rows = sum(
            1 for r in self.rows
            if sum(c.isalpha() for c in (r.get('name') or '')) < 3
        )
        if self.rows and unreadable_rows / len(self.rows) >= 0.25:
            parts.append(
                f"{theme.warnIcon} *Many rows didn't match cleanly. "
                f"If this happens often, your OCR language may not fit your "
                f"alliance's player names. Adjust under "
                f"**Settings → Vault Trap Tracking → OCR Languages**.*"
            )
        rank_warnings = self._rank_sequence_warnings()
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
            f"{theme.editListIcon} **Edit Hunt**\n"
            f"└ Update date, trap, rallies, or total damage.",
        ]
        if self.source_messages:
            action_lines.append(
                f"{theme.globeIcon} **Retry OCR**\n"
                f"└ Re-run OCR with a different engine to catch missed rows."
            )
        action_lines.append(
            f"{theme.verifiedIcon} **Submit**\n"
            f"└ Save this hunt, including unmatched rows you can fix later."
        )
        parts.append("\n".join(action_lines))
        embed = discord.Embed(
            title=(f"{theme.editListIcon} Edit Vault Trap"
                   if self.existing_hunt_id is not None
                   else f"{theme.chartIcon} Review Vault Trap"),
            description="\n\n".join(parts),
            color=theme.emColor1,
        )
        embed.add_field(name="Alliance", value=self.alliance_name or f"ID {self.alliance_id}", inline=False)
        embed.add_field(name="Date", value=self.hunt_meta['date'], inline=True)
        embed.add_field(
            name="Vault Trap #",
            value=str(self.hunt_meta['trap_number']) if self.hunt_meta['trap_number'] is not None else "-",
            inline=True,
        )
        embed.add_field(
            name="Rallies",
            value=str(self.hunt_meta['rallies']) if self.hunt_meta['rallies'] is not None else "-",
            inline=True,
        )
        # Time (when set) sits under Date; Total Alliance Damage sits to its right.
        if self.hunt_meta.get('event_time'):
            embed.add_field(name="Time (UTC)", value=self.hunt_meta['event_time'], inline=True)
        embed.add_field(
            name="Total Alliance Damage",
            value=format_damage_for_embed(self.hunt_meta['total_damage']) if self.hunt_meta['total_damage'] is not None else "-",
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
                # Show the actually-assigned id/nick (greedy may pick a non-top
                # candidate for duplicate names) so the embed matches the dropdown.
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
                # Best guess only -- deliberately not auto-assigned. Another
                # row in this same hunt independently picked the same fid as
                # its own top guess too, which usually means at least one of
                # the underlying OCR reads is corrupted.
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
                     f"as unmatched. Resolve them now or later from Vault Trap Damage Records."
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
            select = discord.ui.Select(
                placeholder="Edit a row…",
                options=options,
                row=0,
            )
            select.callback = self._on_row_selected
            self.add_item(select)

        # Retry OCR needs source_messages to re-download attachments.
        row1 = [
            ("Add Player", theme.addIcon, discord.ButtonStyle.success, self._on_add_row, False),
            ("Edit Hunt", theme.editListIcon, discord.ButtonStyle.primary, self._on_edit_header, False),
            ("Retry OCR", theme.globeIcon, discord.ButtonStyle.secondary, self._on_retry_ocr,
             not self.source_messages),
        ]
        for label, emoji, style, cb, disabled in row1:
            btn = discord.ui.Button(label=label, emoji=emoji, style=style, row=1, disabled=disabled)
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
        self._resolve_unique_assignments()
        self._sort_rows()
        # Clamp page after deletions
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
        """Re-render the review on its own message (for the ephemeral add-confirm)."""
        self._resolve_unique_assignments()
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
        await interaction.response.send_modal(EditRowModal(self, idx))

    async def _on_edit_header(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(EditHeaderModal(self))

    async def _on_add_row(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(AddRowModal(self))

    async def _on_submit(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        errors = validate_vault_submission(
            self.hunt_meta['date'], self.hunt_meta['trap_number'],
            self.hunt_meta['rallies'], self.hunt_meta['total_damage'],
        )
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
                hunt_meta=self.hunt_meta,
                player_rows=self.rows,
                alliance_id=self.alliance_id,
                alliance_name=self.alliance_name,
                existing_hunt_id=self.existing_hunt_id,
            )
            if submitted:
                await self._notify_tracker_submit()
                self._clear_pending_checkpoint()
                self.stop()  # resolve so a stale timeout can't deface the posted hunt
        except Exception as e:
            logger.error(f"Error in vault review submit: {e}")
            print(f"[ERROR] Error in vault review submit: {e}")
            try:
                await interaction.followup.send(
                    f"{theme.deniedIcon} Error during submission: {e}", ephemeral=True
                )
            except Exception:
                pass
            self._clear_pending_checkpoint()
            self.stop()  # resolve so a stale timeout can't later deface the message

    async def _on_cancel(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        embed = discord.Embed(
            description=f"{theme.deniedIcon} Vault Trap review canceled.",
            color=theme.emColor2,
        )
        await interaction.response.edit_message(content=None, embed=embed, view=None)
        await self._notify_tracker_cancel()
        self._clear_pending_checkpoint()
        self.stop()

    async def on_timeout(self):
        self._clear_pending_checkpoint()
        for item in self.children:
            item.disabled = True
        if self.message is not None:
            embed = discord.Embed(
                title=f"{theme.hourglassIcon} Vault Trap Review Expired",
                description=(
                    f"This review timed out after 2 hours of inactivity and "
                    f"can no longer be submitted. Upload the screenshots again "
                    f"to start a new review."
                ),
                color=theme.emColor2,
            )
            try:
                await self.message.edit(content=None, embed=embed, view=None)
            except Exception as e:
                logger.warning(f"Vault Trap: could not edit timed-out review message: {e}")
        await self._notify_tracker_cancel()

    async def _on_retry_ocr(self, interaction):
        """Send a single ephemeral with a language picker. The picked
        language drives `_run_retry_ocr`, which merges the new engine's
        results into the existing review (additive — never destructive)."""
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not self.source_messages:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Original screenshots aren't available for "
                f"this review (auto-deleted or external upload). Upload them "
                f"again to retry.",
                ephemeral=True,
            )
            return
        current_primary, _ = self.cog.get_ocr_language_settings(self.alliance_id)
        picker = RetryOcrLanguagePicker(self, current_primary)
        await interaction.response.send_message(
            content=(
                f"Pick an OCR engine to retry with. New rows the chosen "
                f"engine finds are **added or used to upgrade weak matches** "
                f"in the review below. Your existing confirmed rows stay "
                f"intact.\n"
                f"Your alliance's permanent OCR setting is not changed; "
                f"adjust it under **Settings → Vault Trap Tracking → OCR Languages** "
                f"if a different engine works better."
            ),
            view=picker,
            ephemeral=True,
        )

    async def _run_retry_ocr(self, interaction, new_primary_lang: str):
        """Re-OCR all sources with `new_primary_lang` and merge results
        additively. `auto`/`manual` rows untouched; weaker rows upgraded
        only if new score > existing AND >= MATCH_LIKELY_MIN."""
        attachments = []
        for msg in self.source_messages:
            try:
                refreshed = await msg.channel.fetch_message(msg.id)
            except Exception as e:
                logger.warning(f"Vault Trap retry OCR: source message {msg.id} unavailable: {e}")
                continue
            for att in refreshed.attachments:
                if att.filename and any(att.filename.lower().endswith(ext)
                                        for ext in ('.png', '.jpg', '.jpeg', '.webp')):
                    attachments.append(att)
        if not attachments:
            await interaction.edit_original_response(
                content=(
                    f"{theme.deniedIcon} No screenshots could be re-fetched "
                    f"from the original messages (likely deleted). Upload "
                    f"them again to retry."
                ),
                view=None,
            )
            return

        _, fallbacks = self.cog.get_ocr_language_settings(self.alliance_id)
        new_rows_by_damage: dict[int, dict] = {}
        new_trap = ""
        new_rallies = ""
        new_total = 0
        ok_count = 0
        for att in attachments:
            try:
                image_bytes = await att.read()
            except Exception as e:
                logger.warning(f"Vault Trap retry OCR: read failed on {att.filename}: {e}")
                continue
            result = await self.cog._ocr_attachment_to_result(
                image_bytes,
                new_primary_lang,
                fallbacks,
                filename=att.filename,
                roster=self.roster,
                alliance_id=self.alliance_id,
            )
            if not result.ok:
                continue
            ok_count += 1
            if result.trap and not new_trap:
                new_trap = result.trap
            if result.rallies and not new_rallies:
                new_rallies = result.rallies
            if result.total_damage > new_total:
                new_total = result.total_damage
            for dmg, row in result.rows.items():
                existing = new_rows_by_damage.get(dmg)
                if existing is None or _better_row(existing, row, roster=self.roster):
                    new_rows_by_damage[dmg] = row

        if ok_count == 0:
            await interaction.edit_original_response(
                content=(
                    f"{theme.deniedIcon} The `{new_primary_lang}` engine "
                    f"couldn't read any of the {len(attachments)} screenshot"
                    f"{'s' if len(attachments) != 1 else ''}. Existing "
                    f"review left unchanged. Try a different engine."
                ),
                view=None,
            )
            return

        # Strip the alliance-total damage so it doesn't merge as a row.
        new_rows_by_damage.pop(new_total, None)

        proposal = self._build_retry_proposal(
            new_rows_by_damage, new_trap, new_rallies, new_total,
        )
        if not (proposal['rows_to_add']
                or proposal['rows_to_upgrade']
                or proposal['hunt_meta_updates']):
            await interaction.edit_original_response(
                content=(
                    f"{theme.warnIcon} Re-OCR with `{new_primary_lang}` "
                    f"didn't add or improve any rows. Try a different engine "
                    f"or edit unmatched rows manually."
                ),
                view=None,
            )
            return
        preview = self._format_retry_proposal_preview(new_primary_lang, proposal)
        view = RetryOcrPreviewView(self, new_primary_lang, proposal)
        await interaction.edit_original_response(content=preview, view=view)

    def _build_retry_proposal(self, new_rows_by_damage, new_trap, new_rallies, new_total):
        strong_statuses = {'auto', 'manual'}
        existing_by_damage = {r['damage']: r for r in self.rows}
        rows_to_add = []
        rows_to_upgrade = []  # (idx_in_self_rows, new_row, existing_row)
        for dmg, new_row in new_rows_by_damage.items():
            existing = existing_by_damage.get(dmg)
            if existing is None:
                rows_to_add.append(new_row)
                continue
            if existing['status'] in strong_statuses:
                continue
            existing_score = name_match_score(existing.get('name') or '', self.roster)
            new_score = name_match_score(new_row.get('name') or '', self.roster)
            if new_score > existing_score and new_score >= MATCH_LIKELY_MIN:
                idx = self.rows.index(existing)
                rows_to_upgrade.append((idx, new_row, existing))
        hunt_meta_updates = {}
        if not self.hunt_meta.get('trap_number') and new_trap and new_trap.isdigit():
            hunt_meta_updates['trap_number'] = int(new_trap)
        if not self.hunt_meta.get('rallies') and new_rallies and new_rallies.isdigit():
            hunt_meta_updates['rallies'] = int(new_rallies)
        if not self.hunt_meta.get('total_damage') and new_total:
            hunt_meta_updates['total_damage'] = new_total
        return {
            'rows_to_add': rows_to_add,
            'rows_to_upgrade': rows_to_upgrade,
            'hunt_meta_updates': hunt_meta_updates,
        }

    def _apply_retry_proposal(self, proposal):
        # Upgrades first — captured indices into self.rows must still be valid.
        rows_upgraded = 0
        for idx, new_row, _existing in proposal['rows_to_upgrade']:
            existing = self.rows[idx]
            self.rows[idx] = self._enrich_row({
                **new_row,
                'rank': existing.get('rank'),
            })
            rows_upgraded += 1
        # Then append new rows.
        rows_added = 0
        for new_row in proposal['rows_to_add']:
            self.rows.append(self._enrich_row({**new_row, 'rank': None}))
            rows_added += 1
        # Hunt meta is additive (only fills empty fields).
        for key, value in proposal['hunt_meta_updates'].items():
            self.hunt_meta[key] = value
        for i, row in enumerate(sorted(self.rows, key=lambda r: -r['damage']), start=1):
            if row.get('rank') is None:
                row['rank'] = i
        self.page = 0
        self._resolve_unique_assignments()
        self._sort_rows()
        self._build_components()
        return {'rows_added': rows_added, 'rows_upgraded': rows_upgraded}

    def _format_retry_proposal_preview(self, new_primary_lang, proposal):
        n_add = len(proposal['rows_to_add'])
        n_up = len(proposal['rows_to_upgrade'])
        meta = proposal['hunt_meta_updates']
        lines = [
            f"{theme.infoIcon} **Re-OCR with `{new_primary_lang}` — preview**",
            "",
        ]
        if n_add:
            lines.append(
                f"{theme.addIcon} **{n_add}** new row"
                f"{'s' if n_add != 1 else ''}:"
            )
            for r in proposal['rows_to_add'][:5]:
                name = (r.get('name') or '').strip() or '(unreadable)'
                dmg = format_damage_for_embed(r.get('damage', 0))
                lines.append(f"  • `{name}` — `{dmg}`")
            if n_add > 5:
                lines.append(f"  …and {n_add - 5} more")
        if n_up:
            lines.append(
                f"{theme.refreshIcon} **{n_up}** match"
                f"{'es' if n_up != 1 else ''} upgraded:"
            )
            for _idx, new_row, old in proposal['rows_to_upgrade'][:3]:
                old_name = (old.get('name') or '').strip() or '(unreadable)'
                new_name = (new_row.get('name') or '').strip() or '(unreadable)'
                lines.append(f"  • `{old_name}` → `{new_name}`")
            if n_up > 3:
                lines.append(f"  …and {n_up - 3} more")
        if meta:
            bits = [f"{k}={v}" for k, v in meta.items()]
            lines.append(f"{theme.editListIcon} Hunt info: {', '.join(bits)}")
        lines.append("")
        lines.append("**Apply** these changes, or **Discard**?")
        return "\n".join(lines)

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


def _normalize_event_time(raw):
    """Blank -> None; a valid H:MM/HH:MM -> zero-padded 'HH:MM'; else ValueError."""
    s = (raw or "").strip()
    if not s:
        return None
    m = re.fullmatch(r'(\d{1,2}):(\d{2})', s)
    if not m:
        raise ValueError("time must be HH:MM")
    hh, mm = int(m.group(1)), int(m.group(2))
    if hh > 23 or mm > 59:
        raise ValueError("time out of range")
    return f"{hh:02d}:{mm:02d}"


def _vault_participants(player_rows):
    """Matched rows only (fid present) as attendance participants."""
    out = []
    for r in (player_rows or []):
        fid = r.get('fid')
        if not fid:
            continue
        out.append({'fid': fid,
                    'name': r.get('nickname') or r.get('name') or '',
                    'damage': int(r['damage'])})
    return out


class EditHeaderModal(discord.ui.Modal):
    """Edit the hunt-level header fields (date / trap / rallies / total / time)."""

    def __init__(self, review_view: VaultHuntReviewView):
        super().__init__(title="Edit Vault Trap Info")
        self.review_view = review_view
        meta = review_view.hunt_meta
        self.date_input = discord.ui.TextInput(
            label="Date (YYYY-MM-DD)", default=meta['date'] or "", max_length=10,
        )
        self.trap_input = discord.ui.TextInput(
            label="Vault Trap Operation #",
            default=str(meta['trap_number']) if meta['trap_number'] else "",
            max_length=2,
        )
        self.rallies_input = discord.ui.TextInput(
            label="Rallies",
            default=str(meta['rallies']) if meta['rallies'] else "",
            required=False, max_length=4,
        )
        self.total_input = discord.ui.TextInput(
            label="Total Damage",
            default=format_damage_for_embed(meta['total_damage']) if meta['total_damage'] else "",
            max_length=30,
        )
        self.time_input = discord.ui.TextInput(
            label="Time (UTC, optional) - HH:MM",
            default=meta.get('event_time') or "",
            required=False, max_length=5,
        )
        for item in (self.date_input, self.trap_input, self.rallies_input,
                     self.total_input, self.time_input):
            self.add_item(item)

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
            trap = int(self.trap_input.value)
        except Exception:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Vault Trap operation number must be a whole number.", ephemeral=True,
            )
            return
        rallies = None
        if self.rallies_input.value.strip():
            try:
                rallies = int(self.rallies_input.value)
            except Exception:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Rallies must be a whole number.", ephemeral=True,
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
        self.review_view.hunt_meta = {
            'date': date_norm,
            'trap_number': trap,
            'rallies': rallies,
            'total_damage': vault_damage(self.total_input.value),
            'event_time': event_time,
        }
        await self.review_view.refresh(interaction)


class EditRowModal(discord.ui.Modal):
    """Edit a single player row. Blank player field deletes the row."""

    def __init__(self, review_view: VaultHuntReviewView, row_idx: int):
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
        self.damage_input = discord.ui.TextInput(
            label="Damage", default=format_damage_for_embed(row['damage']),
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
        self.add_item(self.damage_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction):
        if self.row_idx >= len(self.review_view.rows):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Row no longer exists.", ephemeral=True,
            )
            return
        # Edit-only behaviour: blank player field deletes the row.
        if not self.player_input.value.strip():
            del self.review_view.rows[self.row_idx]
            await self.review_view.refresh(interaction)
            return
        damage, rank, err = _parse_damage_rank(self.damage_input.value, self.rank_input.value)
        if err:
            await interaction.response.send_message(f"{theme.deniedIcon} {err}", ephemeral=True)
            return
        # Shared resolver: roster match, or state-confirm + add-to-alliance for an unknown ID.
        edit_row = self.review_view.rows[self.row_idx]
        await _resolve_and_apply(
            interaction, self.review_view, row_id=self.row_idx,
            text=self.player_input.value, damage=damage, rank=rank,
            raw_name=edit_row.get('name'),
            current_fid=edit_row.get('fid'),
            current_name=edit_row.get('nickname') or edit_row.get('name'),
            new_name=self.new_name_input.value,
        )


class AddRowModal(discord.ui.Modal):
    """Add a new player row manually (e.g. for rows OCR missed entirely)."""

    def __init__(self, review_view: VaultHuntReviewView):
        super().__init__(title="Add Player Row")
        self.review_view = review_view
        self.player_input = discord.ui.TextInput(
            label="Player (ID or name)", required=True, max_length=80,
        )
        self.damage_input = discord.ui.TextInput(
            label="Damage", required=True, max_length=30,
        )
        self.rank_input = discord.ui.TextInput(
            label="Rank (optional)", required=False, max_length=3,
        )
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)",
            required=False, max_length=80,
        )
        self.add_item(self.player_input)
        self.add_item(self.damage_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction):
        text = self.player_input.value.strip()
        if not text:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Player is required.", ephemeral=True)
            return
        damage, rank, err = _parse_damage_rank(self.damage_input.value, self.rank_input.value)
        if err:
            await interaction.response.send_message(f"{theme.deniedIcon} {err}", ephemeral=True)
            return
        # Shared resolver: roster match, or state-confirm + add-to-alliance for an unknown ID.
        await _resolve_and_apply(
            interaction, self.review_view, row_id=None,
            text=text, damage=damage, rank=rank, raw_name=text,
            new_name=self.new_name_input.value,
        )


_QUOTE_PAIRS = (('"', '"'), ("'", "'"), ('“', '”'), ('‘', '’'))


def _strip_name_quotes(text):
    """(clean_text, forced_name). Quotes force name-not-ID resolution, so a
    digit-only username like "517" can be entered as a name."""
    t = (text or "").strip()
    for lo, hi in _QUOTE_PAIRS:
        if len(t) >= 2 and t[0] == lo and t[-1] == hi:
            return t[1:-1].strip(), True
    return t, False


def _resolve_player(text, roster, force_name=False):
    """Resolve `text` (FID-digits or a name) to (fid, nickname, candidates)
    against the roster. `force_name` resolves an all-digit string as a name.
    """
    if text.isdigit() and not force_name:
        fid = int(text)
        # roster entries may be (fid, nick) or (fid, match_name, penalty, display)
        for entry in roster:
            if entry[0] == fid:
                nick = entry[-1]
                return fid, nick, [(fid, nick, 100)]
        return None, None, []
    matches = match_roster(text, roster)
    if not matches:
        return None, None, []
    fid, nick, _ = matches[0]
    return fid, nick, matches


def _parse_damage_rank(damage_text, rank_text):
    """(damage, rank, error) — error is None on success. Player resolution is
    handled separately by `_resolve_and_apply` (roster + game-API add)."""
    try:
        damage = vault_damage(damage_text)
        if damage <= 0:
            raise ValueError()
    except Exception:
        return None, None, "Invalid damage value."
    rank = None
    rank_clean = (rank_text or '').strip()
    if rank_clean:
        try:
            rank = int(rank_clean)
        except ValueError:
            return None, None, "Rank must be a whole number."
    return damage, rank, None


# ---------------------------------------------------------------------------
# VaultMenuView — main navigation
# ---------------------------------------------------------------------------

def _vault_viewer_embed() -> discord.Embed:
    """The Vault Trap Damage Viewer landing embed — shown until an alliance is picked.
    Lists each control with a one-line description, matching the bot's menu style."""
    return discord.Embed(
        title=f"{theme.chartIcon} Vault Trap Damage Viewer",
        description=(
            f"Pick an alliance to load its damage chart.\n\n"
            f"**Controls**\n"
            f"{theme.upperDivider}\n"
            f"{theme.vaultTrapIcon} **Vault Trap 1 / Vault Trap 2 / All**\n"
            f"└ Choose which operation to chart\n\n"
            f"{theme.calendarIcon} **Time Range**\n"
            f"└ Set the chart date window (default: last 3 months)\n\n"
            f"{theme.medalIcon} **Top Players**\n"
            f"└ Leaderboard by total, hunts, or average damage\n\n"
            f"{theme.documentIcon} **Hunts**\n"
            f"└ Browse and manage individual hunts and their players\n"
            f"{theme.lowerDivider}"
        ),
        color=theme.emColor1,
    )


class VaultMenuView(discord.ui.View):
    def __init__(self, cog, original_user_id):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id

    @discord.ui.button(label="Vault Trap Damage", style=discord.ButtonStyle.primary, emoji=theme.chartIcon, row=1)
    async def view_vault_damage(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return

        view = VaultDamageView(
            data_submit=self.cog.data_submit,
            cog=self.cog,
            original_user_id=self.original_user_id,
        )

        embed = _vault_viewer_embed()

        await safe_edit_message(interaction, embed=embed, view=view, content=None, clear_attachments=True)

    @discord.ui.button(label="Vault Trap Channel Setup", style=discord.ButtonStyle.success, emoji=theme.editListIcon, row=1)
    async def vault_channel_setup(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        is_admin, _ = PermissionManager.is_admin(interaction.user.id)
        if not is_admin:
            await interaction.response.send_message(
                f"{theme.deniedIcon} You need admin permissions to set the vault channel.",
                ephemeral=True
            )
            return
        view = VaultChannelSetupView(cog=self.cog, original_user_id=self.original_user_id)
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
                f"{theme.deniedIcon} You need admin permissions to access vault settings.",
                ephemeral=True
            )
            return

        view = VaultSettingsView(
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
# AllianceSelect — reusable alliance dropdown
# ---------------------------------------------------------------------------

class AllianceSelect(discord.ui.Select):
    def __init__(self, parent_view, options: list[discord.SelectOption], action: str):
        self.parent_view = parent_view
        self.action = action
        for opt in options:
            opt.default = (parent_view.alliance_id is not None and int(opt.value) == parent_view.alliance_id)

        super().__init__(
            placeholder="Select an alliance",
            min_values=1,
            max_values=1,
            options=options if options else [discord.SelectOption(label="No alliances", value="__none__")]
        )

    async def callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.parent_view.original_user_id):
            return
        try:
            new_alliance_id = int(self.values[0])

            allowed = await self.parent_view.cog.check_vault_permission(
                interaction, new_alliance_id, self.action
            )
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
            logger.error(f"Error in AllianceSelect callback: {e}")
            print(f"[ERROR] Error in AllianceSelect callback: {e}")
            try:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Error processing alliance selection.", ephemeral=True
                )
            except Exception:
                pass


def build_alliance_options(alliance_conn) -> list[discord.SelectOption]:
    """Build alliance select options from DB."""
    cursor = alliance_conn.cursor()
    cursor.execute("SELECT alliance_id, name FROM alliance_list ORDER BY name ASC LIMIT 25")
    rows = cursor.fetchall()
    return [discord.SelectOption(label=name, value=str(aid)) for aid, name in rows]


# ---------------------------------------------------------------------------
# VaultDamageView — view damage graph with filters
# ---------------------------------------------------------------------------

class VaultDamageView(discord.ui.View):
    PRESET_LABELS = {
        'this_month': 'This Month',
        'last_month': 'Last Month',
        '3m':         '3 Months',
        '1y':         '1 Year',
        'all':        'All Time',
    }

    def __init__(self, data_submit, *, cog, original_user_id,
                 alliance_id: int | None = None, trap_number: int | None = None,
                 from_date: date | None = None, to_date: date | None = None):
        super().__init__(timeout=7200)
        self.data_submit = data_submit
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.trap_number = trap_number or 1
        self.from_date = from_date
        self.to_date = to_date
        # `preset = None` means custom range from the modal.
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
            # process_view treats None as 'first/last record for this
            # alliance+trap'.
            self.from_date = None
            self.to_date = None
        self.preset = preset_name

    def _build_components(self):
        self.clear_items()
        options = build_alliance_options(self.cog.alliance_conn)
        for opt in options:
            opt.default = (int(opt.value) == (self.alliance_id or 0))
        self.add_item(AllianceSelect(self, options, action="view"))

        trap_buttons = [
            (1, f"Vault Trap 1", theme.vaultTrapIcon),
            (2, f"Vault Trap 2", theme.vaultTrapIcon),
            ('both', "Both", theme.chartIcon),
        ]
        for trap, label, emoji in trap_buttons:
            btn = discord.ui.Button(
                label=label,
                emoji=emoji,
                style=(discord.ButtonStyle.success if self.trap_number == trap
                       else discord.ButtonStyle.secondary),
                row=1,
            )
            btn.callback = self._make_trap_cb(trap)
            self.add_item(btn)

        # Time Range sits on the trap row (row 1) to keep row 2 short.
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
            style=discord.ButtonStyle.primary, row=2,
            disabled=not has_alliance,
        )
        leaderboard_btn.callback = self._on_leaderboard
        self.add_item(leaderboard_btn)

        hunts_btn = discord.ui.Button(
            label="Hunts", emoji=theme.documentIcon,
            style=discord.ButtonStyle.primary, row=2,
            disabled=not has_alliance,
        )
        hunts_btn.callback = self._on_hunts
        self.add_item(hunts_btn)

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

    async def _on_hunts(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not self.alliance_id:
            return
        view = VaultDamageEditView(
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
        if not await self.cog.check_vault_permission(interaction, self.alliance_id, "view"):
            return
        self.cog.alliance_cursor.execute(
            "SELECT name FROM alliance_list WHERE alliance_id = ?", (self.alliance_id,))
        arow = self.cog.alliance_cursor.fetchone()
        alliance_name = arow[0] if arow else f"Alliance ID: {self.alliance_id}"
        from_str = self.from_date.strftime("%Y-%m-%d") if self.from_date else None
        to_str = self.to_date.strftime("%Y-%m-%d") if self.to_date else None
        view = VaultLeaderboardView(
            cog=self.cog, original_user_id=self.original_user_id,
            alliance_id=self.alliance_id, alliance_name=alliance_name,
            trap_number=self.trap_number, from_date=from_str, to_date=to_str,
            chart_view=self)
        await interaction.response.edit_message(
            embed=view.build_embed(), view=view, attachments=[])

    def _make_trap_cb(self, trap: int):
        async def _cb(interaction: discord.Interaction):
            if not await check_interaction_user(interaction, self.original_user_id):
                return
            if self.trap_number == trap:
                await interaction.response.defer()
                return
            self.trap_number = trap
            await self.try_redraw(interaction)
        return _cb

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_vault_track_menu(interaction)

    async def try_redraw(self, interaction: discord.Interaction):
        # Chart render (matplotlib) can exceed the 3s ack window — defer first.
        if not interaction.response.is_done():
            await interaction.response.defer()
        self._build_components()
        if not self.alliance_id:
            await interaction.edit_original_response(
                embed=_vault_viewer_embed(), attachments=[], view=self,
            )
            return
        from_str = self.from_date.strftime("%Y-%m-%d") if self.from_date else None
        to_str = self.to_date.strftime("%Y-%m-%d") if self.to_date else None
        embed, file = await self.data_submit.process_view(
            alliance_id=self.alliance_id,
            trap_number=self.trap_number,
            from_date=from_str,
            to_date=to_str,
        )
        if not embed:
            trap_label = "All Vault Trap operations" if self.trap_number == 'both' else f"Vault Trap {self.trap_number}"
            empty = discord.Embed(
                title=f"{theme.warnIcon} No data for this range",
                description=(
                    f"There are no recorded hunts for {trap_label} in the selected time range.\n"
                    f"Try a different preset or change the **Time Range**."
                ),
                color=theme.emColor2,
            )
            await interaction.edit_original_response(
                embed=empty, attachments=[], view=self,
            )
            return
        await interaction.edit_original_response(
            embed=embed, attachments=[file] if file else [], view=self,
        )


# ---------------------------------------------------------------------------
# VaultTimeRangeView — time-range picker subview for the chart
# ---------------------------------------------------------------------------

class VaultTimeRangeView(discord.ui.View):
    """Preset/custom range picker. Applies to the chart view and returns to it."""

    PRESETS = [('this_month', 'This Month'), ('last_month', 'Last Month'),
               ('3m', '3 Months'), ('1y', '1 Year'), ('all', 'All Time')]

    def __init__(self, chart_view: 'VaultDamageView'):
        super().__init__(timeout=7200)
        self.chart = chart_view
        self.original_user_id = chart_view.original_user_id
        self._build_components()

    def build_embed(self) -> discord.Embed:
        return discord.Embed(
            title=f"{theme.calendarIcon} Time Range",
            description=(
                "Pick the range for the damage chart (default is last 3 months).\n"
                f"{theme.upperDivider}\n"
                f"Choose a preset, or **Custom** for an exact date range.\n"
                f"{theme.lowerDivider}"),
            color=theme.emColor1)

    def _build_components(self):
        self.clear_items()
        for i, (preset, label) in enumerate(self.PRESETS):
            btn = discord.ui.Button(
                label=label, row=0 if i < 3 else 1,
                style=(discord.ButtonStyle.success if self.chart.preset == preset
                       else discord.ButtonStyle.secondary))
            btn.callback = self._make_preset_cb(preset)
            self.add_item(btn)
        custom_btn = discord.ui.Button(
            label="Custom", emoji=theme.editListIcon, row=1,
            style=(discord.ButtonStyle.success if self.chart.preset is None
                   else discord.ButtonStyle.secondary))
        custom_btn.callback = self._on_custom
        self.add_item(custom_btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=2)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def _make_preset_cb(self, preset):
        async def _cb(interaction: discord.Interaction):
            if not await check_interaction_user(interaction, self.original_user_id):
                return
            self.chart._apply_preset(preset)
            self.chart._build_components()
            await self.chart.try_redraw(interaction)
        return _cb

    async def _on_custom(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(DateRangeModal(self.chart))

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.chart._build_components()
        await self.chart.try_redraw(interaction)


# ---------------------------------------------------------------------------
# VaultDamageEditView — edit/delete records
# ---------------------------------------------------------------------------

class VaultDamageEditView(discord.ui.View):
    """Unified Hunts view, entered from the chart with an alliance pre-selected.
    Pick a hunt → its players show inline with a row-edit dropdown + Add Player.
    Edit controls appear only when the user can manage this alliance; otherwise
    it's a read-only browser."""

    PLAYER_PAGE = 20  # < 25 so the row-edit select never exceeds Discord's cap
    HUNT_PAGE = 25  # Discord Select option cap — same page size as before pagination existed

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
        self.trap_number: int | None = None
        self.rallies: int | None = None
        self.total_damage: int | None = None
        self.players: list = []
        self.page = 0
        self._note: str | None = None  # transient one-shot banner (e.g. re-match result)

    @property
    def hunt_id(self):
        return self.selected_record_id

    async def open(self, interaction: discord.Interaction):
        """Entry point from the chart view: load the alliance's hunts and show."""
        if self.alliance_id is not None:
            self.can_manage = self.cog.can_manage_vault(interaction, self.alliance_id)
            self.roster = self.cog.get_alliance_roster(self.alliance_id)
            try:
                self.cog.alliance_cursor.execute(
                    "SELECT name FROM alliance_list WHERE alliance_id = ?",
                    (self.alliance_id,))
                arow = self.cog.alliance_cursor.fetchone()
                self.alliance_name = arow[0] if arow else None
            except Exception as e:
                logger.warning(f"Vault Trap edit view: could not resolve alliance name: {e}")
                self.alliance_name = None
            self._load_records()
        self._build_components()
        await safe_edit_message(
            interaction, embed=self.build_record_embed(), view=self,
            content=None, clear_attachments=True)

    def _load_records(self):
        try:
            # No LIMIT here — paginated client-side (same pattern as self.players/
            # PLAYER_PAGE below) so hunts past the first page stay reachable.
            self._records = self.cog.vault_cursor.execute(
                "SELECT id, trap_number, date FROM vault_hunts WHERE alliance_id = ? "
                "ORDER BY date DESC",
                (self.alliance_id,)).fetchall()
        except Exception as e:
            logger.error(f"Failed to fetch records: {e}")
            print(f"[ERROR] Failed to fetch records: {e}")
            self._records = []
        self.record_page = min(self.record_page, max(0, (len(self._records) - 1) // self.HUNT_PAGE))
        self._sync_record_page()

    def _sync_record_page(self):
        """Land on the page containing the currently-selected hunt, if any
        (keeps the dropdown's `default=` selection visible after a delete-
        reload or an edit that shifted the hunt's sort position)."""
        if self.selected_record_id is None:
            return
        idx = next((i for i, r in enumerate(self._records) if r[0] == self.selected_record_id), None)
        if idx is not None:
            self.record_page = idx // self.HUNT_PAGE

    def _total_record_pages(self) -> int:
        return max(1, -(-len(self._records) // self.HUNT_PAGE))

    def _load_players(self):
        if not self.selected_record_id:
            self.players = []
            return
        try:
            rows = self.cog.vault_cursor.execute(
                "SELECT id, fid, raw_name, resolved_nickname, damage, rank "
                "FROM vault_player_damage WHERE hunt_id = ? "
                "ORDER BY CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank ASC, damage DESC",
                (self.selected_record_id,)).fetchall()
        except Exception as e:
            logger.error(f"Failed to load players: {e}")
            print(f"[ERROR] Failed to load players: {e}")
            rows = []
        self.players = [
            {'id': r[0], 'fid': r[1], 'raw_name': r[2] or '', 'nickname': r[3],
             'damage': int(r[4]), 'rank': r[5]}
            for r in rows]
        self.page = min(self.page, max(0, (len(self.players) - 1) // self.PLAYER_PAGE))

    def _select_record(self, rid: int):
        self.selected_record_id = rid
        row = self.cog.vault_cursor.execute(
            "SELECT date, trap_number, rallies, total_damage FROM vault_hunts WHERE id = ?",
            (rid,)).fetchone()
        if row:
            self.date, self.trap_number, self.rallies, self.total_damage = row
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
                "Pick a hunt from the dropdown to view its players."
                if self._records else
                ("*No hunts recorded for this alliance yet.*" if self.alliance_id
                 else "Pick an alliance first.")
            )
            embed = discord.Embed(title=f"{theme.documentIcon} Hunts", description=desc, color=theme.emColor1)
            total_record_pages = self._total_record_pages()
            if self._records and total_record_pages > 1:
                embed.set_footer(text=f"page {self.record_page + 1}/{total_record_pages}")
            return embed

        parts = []
        if self._note:
            parts.append(self._note)
            self._note = None  # one-shot
        if self.can_manage and self.players:
            parts.append(
                "*Select a player to edit in the drop-down; "
                "clear the name to delete the row.*"
            )
        if self.can_manage:
            _, unmatched = self._player_counts()
            bits = [
                f"{theme.addIcon} **Add Player**\n"
                f"└ Manually add a player row to this hunt.",
                f"{theme.editListIcon} **Edit Hunt**\n"
                f"└ Update date, trap, rallies, or total damage.",
            ]
            if unmatched:
                bits.append(
                    f"{theme.refreshIcon} **Re-match**\n"
                    f"└ Re-match against the current roster after adding new members."
                )
            bits.append(
                f"{theme.trashIcon} **Delete Hunt**\n"
                f"└ Permanently delete this hunt and all its rows."
            )
            parts.append("\n".join(bits))

        embed = discord.Embed(
            title=f"{theme.documentIcon} Vault Trap",
            description="\n\n".join(parts) if parts else None,
            color=theme.emColor1,
        )
        embed.add_field(
            name="Alliance",
            value=self.alliance_name or f"ID {self.alliance_id}",
            inline=False,
        )
        embed.add_field(name="Date", value=self.date or "-", inline=True)
        embed.add_field(
            name="Vault Trap #",
            value=str(self.trap_number) if self.trap_number is not None else "-",
            inline=True,
        )
        embed.add_field(
            name="Rallies",
            value=str(self.rallies) if self.rallies is not None else "-",
            inline=True,
        )
        embed.add_field(
            name="Total Alliance Damage",
            value=format_damage_for_embed(self.total_damage) if self.total_damage else "-",
            inline=False,
        )

        if not self.players:
            embed.add_field(name="Players", value="*No player rows on this hunt.*", inline=False)
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
            foot_bits.append(f"hunts page {self.record_page + 1}/{total_record_pages}")
        embed.set_footer(text=" · ".join(foot_bits))
        return embed

    def _build_components(self):
        self.clear_items()
        # Row 0: hunt picker (alliance is fixed from the chart — no alliance dropdown).
        total_record_pages = self._total_record_pages()
        if self._records:
            rstart = self.record_page * self.HUNT_PAGE
            rend = min(rstart + self.HUNT_PAGE, len(self._records))
            placeholder = "Select a hunt"
            if total_record_pages > 1:
                placeholder += f" (page {self.record_page + 1}/{total_record_pages})"
            self.date_trap_select = discord.ui.Select(
                placeholder=placeholder, row=0,
                options=[discord.SelectOption(
                    label=f"{dt} - Trap {trap}", value=str(rid),
                    default=(self.selected_record_id == rid))
                    for rid, trap, dt in self._records[rstart:rend]])
        else:
            self.date_trap_select = discord.ui.Select(
                placeholder=("No hunts for this alliance" if self.alliance_id else "No alliance selected"),
                disabled=True, row=0,
                options=[discord.SelectOption(label="—", value="__placeholder__")])
        self.date_trap_select.callback = self.date_trap_selected
        self.add_item(self.date_trap_select)

        # Row 1: hunt-list pagination — same Prev/Next convention as the player-list
        # pagination below, placed directly under the select it pages (see
        # VaultLeaderboardView for the same adjacency convention).
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

        has_hunt = bool(self.selected_record_id)
        # Row 2: row-edit dropdown (managers only).
        if has_hunt and self.players and self.can_manage:
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

        # Row 3: manage actions.
        if has_hunt and self.can_manage:
            add_btn = discord.ui.Button(label="Add Player", emoji=theme.addIcon,
                                        style=discord.ButtonStyle.success, row=3)
            add_btn.callback = self._on_add
            self.add_item(add_btn)
            edit_btn = discord.ui.Button(label="Edit Hunt", emoji=theme.editListIcon,
                                         style=discord.ButtonStyle.primary, row=3)
            edit_btn.callback = self._on_edit_hunt
            self.add_item(edit_btn)
            _, unmatched = self._player_counts()
            if unmatched:
                rematch_btn = discord.ui.Button(label="Re-match", emoji=theme.refreshIcon,
                                                style=discord.ButtonStyle.secondary, row=3)
                rematch_btn.callback = self._on_rematch
                self.add_item(rematch_btn)

        # Row 4: delete + back + player-list pagination (all rows 0-3 are spoken
        # for, so these share the last row — up to 4 buttons, well under Discord's
        # 5-per-row cap).
        if has_hunt and self.can_manage:
            delete_btn = discord.ui.Button(label="Delete Hunt", emoji=theme.trashIcon,
                                           style=discord.ButtonStyle.danger, row=4)
            delete_btn.callback = self._on_delete
            self.add_item(delete_btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=4)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

        if has_hunt and self._total_player_pages() > 1:
            prev_btn = discord.ui.Button(label="Prev", emoji=theme.prevIcon,
                style=discord.ButtonStyle.secondary, row=4, disabled=(self.page == 0))
            prev_btn.callback = self._on_prev
            next_btn = discord.ui.Button(label="Next", emoji=theme.nextIcon,
                style=discord.ButtonStyle.secondary, row=4,
                disabled=(self.page >= self._total_player_pages() - 1))
            next_btn.callback = self._on_next
            self.add_item(prev_btn)
            self.add_item(next_btn)

    async def date_trap_selected(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        selected_value = self.date_trap_select.values[0]
        if selected_value in ("__placeholder__", "__none__"):
            return
        self._select_record(int(selected_value))
        self._build_components()
        await interaction.response.edit_message(content=None, view=self, embed=self.build_record_embed())

    async def refresh(self, interaction: discord.Interaction):
        """Reload players for the current hunt and re-render (used by edit modals)."""
        self._load_players()
        self._build_components()
        await safe_edit_message(interaction, embed=self.build_record_embed(), view=self, content=None)

    async def rerender(self, interaction: discord.Interaction):
        """Re-show this view (used by child views returning via Back)."""
        self._load_players()
        self._build_components()
        await safe_edit_message(interaction, embed=self.build_record_embed(), view=self, content=None)

    async def reapply_to_message(self, message):
        """Re-render this view on its own message (for the ephemeral add-confirm)."""
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
        await interaction.response.send_modal(EditSavedPlayerModal(self, self.players[idx]))

    async def _on_add(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.selected_record_id and self.can_manage):
            return
        await interaction.response.send_modal(AddSavedPlayerModal(self))

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

    async def _on_edit_hunt(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not (self.alliance_id and self.selected_record_id and self.can_manage):
            return
        await interaction.response.send_modal(RecordEditModal(self))

    def _do_rematch(self) -> int:
        """Re-run the auto-matcher on this hunt's unmatched rows. Matches against
        the date-aware roster (names as of the hunt date) plus, if the alliance
        opted in, all historical names at a penalty. Persists only confident
        (>=MATCH_AUTO_CONFIRM) unique matches. Returns how many rows resolved."""
        _hist = bool(self.cog.get_vault_settings(self.alliance_id).get("match_all_history"))
        self.roster = self.cog.get_match_roster(
            self.alliance_id, as_of_date=self.date, include_history=_hist)
        cur = self.cog.vault_cursor
        cur.execute(
            "SELECT id, raw_name FROM vault_player_damage WHERE hunt_id = ? AND fid IS NULL",
            (self.selected_record_id,))
        unmatched_rows = [{'id': r[0], 'raw_name': r[1] or ''} for r in cur.fetchall()]
        if not unmatched_rows:
            return 0
        cur.execute(
            "SELECT fid FROM vault_player_damage WHERE hunt_id = ? AND fid IS NOT NULL",
            (self.selected_record_id,))
        assigned_fids = {row[0] for row in cur.fetchall()}

        candidates = []
        for idx, row in enumerate(unmatched_rows):
            for fid, nick, score in resolve_against_roster(
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
                "UPDATE vault_player_damage SET fid = ?, resolved_nickname = ?, match_score = ? WHERE id = ?",
                (fid, nick, score, unmatched_rows[idx]['id']))
        self.cog.vault_conn.commit()
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
            row = self.cog.vault_cursor.execute(
                "SELECT COUNT(*) FROM vault_player_damage WHERE hunt_id = ?",
                (self.selected_record_id,)).fetchone()
            player_count = row[0] if row else 0
        except Exception as e:
            logger.error(f"Failed to count player rows before delete: {e}")
            print(f"[ERROR] Failed to count player rows before delete: {e}")
            player_count = len(self.players)

        embed = discord.Embed(
            title=f"{theme.warnIcon} Delete Hunt",
            description=(
                f"Are you sure you want to delete the **{self.date or '-'} - "
                f"Trap {self.trap_number if self.trap_number is not None else '-'}** hunt "
                f"for **{self.alliance_name or f'ID {self.alliance_id}'}**?\n\n"
                f"{theme.warnIcon} This permanently deletes:\n"
                f"- Rallies: {self.rallies if self.rallies is not None else '-'}\n"
                f"- Total Alliance Damage: "
                f"{format_damage_for_embed(self.total_damage) if self.total_damage else '-'}\n"
                f"- **{player_count}** player row(s)\n\n"
                f"This action cannot be undone."
            ),
            color=theme.emColor2,
        )
        await interaction.response.edit_message(
            content=None, embed=embed, view=VaultDeleteHuntConfirmView(self))

    async def _do_delete(self, interaction: discord.Interaction):
        """Actually performs the delete. Only reached via the Confirm button
        on VaultDeleteHuntConfirmView."""
        try:
            # FK cascade is off (pragma never set), so clear child rows explicitly.
            self.cog.vault_cursor.execute(
                "DELETE FROM vault_player_damage WHERE hunt_id = ?", (self.selected_record_id,))
            self.cog.vault_cursor.execute(
                "DELETE FROM vault_hunts WHERE id = ?", (self.selected_record_id,))
            self.cog.vault_conn.commit()
        except Exception as e:
            logger.error(f"Failed to delete record: {e}")
            print(f"[ERROR] Failed to delete record: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to delete hunt.", ephemeral=True)
            return
        try:
            from .attendance_ocr_parsers import delete_vault_attendance_event
            delete_vault_attendance_event(hunt_id=self.selected_record_id)
        except Exception as e:
            logger.error(f"Vault Trap attendance delete failed: {e}")
            print(f"[ERROR] Vault Trap attendance delete failed: {e}")
        self.selected_record_id = None
        self.date = self.trap_number = self.rallies = self.total_damage = None
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
            await self.cog.show_vault_track_menu(interaction)


class VaultDeleteHuntConfirmView(discord.ui.View):
    """Are-you-sure prompt shown before a hunt (and its player rows) is
    permanently deleted. Mirrors MinisterMenu's DeleteAppointmentTypeConfirmView
    pattern: Confirm/Cancel buttons, Confirm performs the delete, Cancel
    returns to the hunt view unchanged."""

    def __init__(self, parent_view: VaultDamageEditView):
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


class RecordEditModal(discord.ui.Modal):
    """Modal for editing an existing vault damage record in the database."""

    def __init__(self, parent_view: VaultDamageEditView):
        super().__init__(title="Edit Vault Trap Record")
        self.parent_view = parent_view

        self.date_input = discord.ui.TextInput(
            label="Date", default=parent_view.date or ""
        )
        self.trap_number_input = discord.ui.TextInput(
            label="Vault Trap #", default=str(parent_view.trap_number or "")
        )
        self.rallies_input = discord.ui.TextInput(
            label="Rallies", default=str(parent_view.rallies or ""), required=False,
        )
        self.total_damage_input = discord.ui.TextInput(
            label="Total Damage",
            default=format_damage_for_embed(parent_view.total_damage) if parent_view.total_damage else ""
        )
        self.add_item(self.date_input)
        self.add_item(self.trap_number_input)
        self.add_item(self.rallies_input)
        self.add_item(self.total_damage_input)

    async def on_submit(self, interaction: discord.Interaction):
        # Validate
        try:
            dt = datetime.strptime(self.date_input.value, "%Y-%m-%d")
            new_date = dt.strftime("%Y-%m-%d")
        except Exception:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Date must be in YYYY-MM-DD format.", ephemeral=True
            )
            return

        try:
            new_trap = int(self.trap_number_input.value)
            if new_trap not in (1, 2):
                raise ValueError
        except Exception:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Vault Trap operation number must be a positive number.", ephemeral=True
            )
            return

        new_rallies = None
        if self.rallies_input.value.strip():
            try:
                new_rallies = int(self.rallies_input.value)
                if new_rallies <= 0:
                    raise ValueError
            except Exception:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Rallies must be a whole number greater than 0.", ephemeral=True
                )
                return

        new_damage = vault_damage(self.total_damage_input.value)
        if new_damage <= 0:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Total Damage must be greater than 0.", ephemeral=True
            )
            return

        # Save to DB
        try:
            self.parent_view.cog.vault_cursor.execute(
                "UPDATE vault_hunts SET date = ?, trap_number = ?, rallies = ?, total_damage = ? WHERE id = ?",
                (new_date, new_trap, new_rallies, new_damage, self.parent_view.selected_record_id)
            )
            self.parent_view.cog.vault_conn.commit()
        except sqlite3.IntegrityError:
            self.parent_view.cog.vault_conn.rollback()
            await interaction.response.send_message(
                f"{theme.warnIcon} This alliance already has a hunt recorded for that date and trap "
                f"number. Pick a different date/trap number, or edit the other existing hunt instead.",
                ephemeral=True
            )
            return
        except Exception as e:
            logger.error(f"Failed to update record: {e}")
            print(f"[ERROR] Failed to update record: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save record.", ephemeral=True
            )
            return

        self.parent_view.date = new_date
        self.parent_view.trap_number = new_trap
        self.parent_view.rallies = new_rallies
        self.parent_view.total_damage = new_damage
        # Reload so the hunt dropdown label reflects an edited date/trap.
        self.parent_view._load_records()
        self.parent_view._build_components()

        embed = self.parent_view.build_record_embed()

        await interaction.response.edit_message(embed=embed, view=self.parent_view)


# ---------------------------------------------------------------------------
# Player-damage helpers: per-hunt breakdown, same-trap deltas, aggregates
# ---------------------------------------------------------------------------

def _previous_same_trap_hunt_id(cur, alliance_id, trap_number, date):
    """ID of the most recent prior hunt of the SAME trap for this alliance, or
    None. The UNIQUE(alliance_id, date, trap) constraint means `date <` is
    enough — there's never a same-trap tie on the same date."""
    cur.execute(
        "SELECT id FROM vault_hunts "
        "WHERE alliance_id = ? AND trap_number = ? AND date < ? "
        "ORDER BY date DESC LIMIT 1",
        (alliance_id, trap_number, date),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _compute_player_deltas(cur, *, alliance_id, hunt_id, trap_number, date):
    """Matched players of `hunt_id`, each with a %-change vs their damage in
    the most recent prior SAME-trap hunt. Players absent from that baseline get
    pct=None (new/returning) — we never compare across traps or reach further
    back than the immediately-previous same-trap hunt. Returns (players, prev_id)."""
    cur.execute(
        "SELECT fid, resolved_nickname, damage, rank FROM vault_player_damage "
        "WHERE hunt_id = ? AND fid IS NOT NULL",
        (hunt_id,),
    )
    players = [
        {'fid': r[0], 'nickname': r[1] or str(r[0]), 'damage': int(r[2]), 'rank': r[3]}
        for r in cur.fetchall()
    ]
    prev_id = _previous_same_trap_hunt_id(cur, alliance_id, trap_number, date)
    prev_by_fid = {}
    if prev_id is not None:
        cur.execute(
            "SELECT fid, damage FROM vault_player_damage "
            "WHERE hunt_id = ? AND fid IS NOT NULL",
            (prev_id,),
        )
        prev_by_fid = {r[0]: int(r[1]) for r in cur.fetchall()}
    for p in players:
        base = prev_by_fid.get(p['fid'])
        p['prev_damage'] = base
        p['pct'] = ((p['damage'] - base) / base * 100.0) if base else None
    players.sort(key=lambda p: (p['rank'] if p['rank'] is not None else 1 << 30, -p['damage']))
    return players, prev_id


def _format_delta_pct(pct) -> str:
    """Render a same-trap %-change badge, or a new/returning marker."""
    if pct is None:
        return f"{theme.newIcon}"
    if pct > 0:
        return f"{theme.upIcon} +{pct:.0f}%"
    if pct < 0:
        return f"{theme.downIcon} {pct:.0f}%"
    return f"{theme.forwardIcon} 0%"


def _build_player_breakdown_embed(*, alliance_name, trap_number, players, has_baseline):
    """Channel-post embed listing each matched player's damage + same-trap delta."""
    embed = discord.Embed(
        title=f"{theme.membersIcon} {alliance_name} · Vault Trap {trap_number} · Player Damage",
        color=theme.emColor1,
    )
    lines = []
    for p in players:
        rank_str = f"`#{p['rank']}`" if p['rank'] is not None else "`#?`"
        nick = _isolate_rtl(p['nickname'])
        dmg = format_damage_for_embed(p['damage'])
        line = f"{rank_str} {nick} — `{dmg}`"
        if has_baseline:
            line += f"  {_format_delta_pct(p['pct'])}"
        lines.append(_ltr_line(line))
    desc = "\n".join(lines)
    if len(desc) > 4000:
        desc = desc[:3990] + "\n…(truncated)"
    embed.description = desc or "*No matched players in this hunt.*"
    if has_baseline:
        embed.set_footer(text=f"Change vs the previous Vault Trap {trap_number} · {theme.newIcon} = new/returning this operation")
    else:
        embed.set_footer(text=f"No earlier Vault Trap {trap_number} to compare against yet.")
    return embed


def _aggregate_leaderboard(cur, *, alliance_id, trap_number, from_date, to_date,
                           active_fids=None):
    """Sum/avg damage per matched player over a window. `trap_number` may be
    1, 2, or 'both'. Returns rows: (fid, nickname, hunts, total, avg).

    `active_fids`: when given (a set/list of fids), only those are included —
    the leaderboard is active-members-only by default (decision #3); pass the
    alliance's currently-active roster fids. None means no filtering (all
    matched players, active or not)."""
    sql = (
        "SELECT bpd.fid, MAX(bpd.resolved_nickname), COUNT(*), "
        "SUM(bpd.damage), AVG(bpd.damage) "
        "FROM vault_player_damage bpd JOIN vault_hunts bh ON bh.id = bpd.hunt_id "
        "WHERE bh.alliance_id = ? AND bpd.fid IS NOT NULL"
    )
    params: list = [alliance_id]
    if trap_number != 'both':
        sql += " AND bh.trap_number = ?"
        params.append(int(trap_number))
    if from_date:
        sql += " AND bh.date >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND bh.date <= ?"
        params.append(to_date)
    if active_fids is not None:
        active_fids = list(active_fids)
        if not active_fids:
            return []
        placeholders = ",".join("?" * len(active_fids))
        sql += f" AND bpd.fid IN ({placeholders})"
        params.extend(active_fids)
    sql += " GROUP BY bpd.fid ORDER BY SUM(bpd.damage) DESC"
    cur.execute(sql, params)
    return [
        {'fid': r[0], 'nickname': r[1] or str(r[0]), 'hunts': int(r[2]),
         'total': int(r[3]), 'avg': int(r[4])}
        for r in cur.fetchall()
    ]


def _fetch_player_damage_series(cur, *, alliance_id, fid, from_date, to_date):
    """(date, damage, rank) rows for one player in an alliance, ordered by date
    ascending. Same alliance-scoping and from_date/to_date filtering as
    /vault_damage_view and /vault_player_history."""
    sql = (
        "SELECT bh.date, bpd.damage, bpd.rank "
        "FROM vault_player_damage bpd JOIN vault_hunts bh ON bh.id = bpd.hunt_id "
        "WHERE bh.alliance_id = ? AND bpd.fid = ?"
    )
    params: list = [alliance_id, fid]
    if from_date:
        sql += " AND bh.date >= ?"
        params.append(from_date)
    if to_date:
        sql += " AND bh.date <= ?"
        params.append(to_date)
    sql += " ORDER BY bh.date ASC"
    cur.execute(sql, params)
    return cur.fetchall()

# ---------------------------------------------------------------------------
# Shared player-entry resolution: match to roster, swap an existing match,
# or confirm an unknown ID against the alliance's state and offer to add them.
# ---------------------------------------------------------------------------

def _write_match_to_row(view, *, row_id, fid, nick, damage, rank, raw_name=None):
    """Persist a player match. If another row in the hunt already holds this fid,
    that row is freed back to unmatched first (the match 'moves' to this row).
    row_id=None inserts a new row instead of updating. When `raw_name` is given,
    the OCR text → fid mapping is learned so it auto-matches next time.
    The live pre-save review (no hunt_id) applies the match in-memory, not the DB.

    The saved/DB branch targets `vault_player_damage`/`hunt_id` by default, but
    reads `view.player_table` / `view.event_fk_col` / `view.db_cursor` /
    `view.db_conn` when the view sets them -- letting a structurally-identical
    tracker (e.g. Capitol War's capitol_war_points/event_id) reuse this exact
    match-resolution logic (digit-ID vs. name, cross-row fid handoff, alias
    learning) against its own table without copying it."""
    if getattr(view, "hunt_id", None) is None:
        rows = view.rows
        for i, r in enumerate(rows):  # free any other row holding this fid
            if i != row_id and r.get("fid") == fid:
                r.update({"fid": None, "nickname": None, "status": "none"})
        match = {"fid": fid, "nickname": nick, "damage": damage, "rank": rank,
                 "candidates": [(fid, nick, 100)], "status": "manual"}
        if row_id is not None and row_id < len(rows):
            rows[row_id].update(match)
        else:
            rows.append({"name": nick, **match})
        if raw_name:
            learn_alias(view.alliance_id, raw_name, fid)
        return True

    player_table = getattr(view, "player_table", "vault_player_damage")
    event_fk_col = getattr(view, "event_fk_col", "hunt_id")
    value_col = getattr(view, "value_col", "damage")
    cur = getattr(view, "db_cursor", None) or view.cog.vault_cursor
    conn = getattr(view, "db_conn", None) or view.cog.vault_conn
    try:
        # Free any other row in this hunt currently holding the fid.
        cur.execute(
            f"UPDATE {player_table} SET fid=NULL, resolved_nickname=NULL, match_score=NULL "
            f"WHERE {event_fk_col}=? AND fid=? AND id != ?",
            (view.hunt_id, fid, row_id if row_id is not None else -1))
        if row_id is not None:
            cur.execute(
                f"UPDATE {player_table} SET fid=?, resolved_nickname=?, {value_col}=?, rank=?, match_score=? "
                f"WHERE id=?",
                (fid, nick, damage, rank, 100, row_id))
        else:
            cur.execute(
                f"INSERT INTO {player_table} "
                f"({event_fk_col}, fid, raw_name, resolved_nickname, {value_col}, rank, match_score) "
                f"VALUES (?, ?, ?, ?, ?, ?, ?)",
                (view.hunt_id, fid, nick, nick, damage, rank, 100))
        conn.commit()
        if raw_name:
            learn_alias(view.alliance_id, raw_name, fid)
        return True
    except Exception as e:
        conn.rollback()
        logger.error(f"Failed to write player match: {e}")
        print(f"[ERROR] Failed to write player match: {e}")
        return False


def _fid_in_hunt(view, fid) -> bool:
    """True if any row of the current hunt already holds this fid. See
    `_write_match_to_row` for the `player_table`/`event_fk_col`/`db_cursor`
    generalization this shares."""
    if getattr(view, "hunt_id", None) is None:  # live pre-save review — in-memory rows
        return any(r.get("fid") == fid for r in getattr(view, "rows", []))
    player_table = getattr(view, "player_table", "vault_player_damage")
    event_fk_col = getattr(view, "event_fk_col", "hunt_id")
    cur = getattr(view, "db_cursor", None) or view.cog.vault_cursor
    row = cur.execute(
        f"SELECT 1 FROM {player_table} WHERE {event_fk_col}=? AND fid=? LIMIT 1",
        (view.hunt_id, fid)).fetchone()
    return row is not None


async def _resolve_and_apply(interaction, view, *, row_id, text, damage, rank, raw_name,
                             current_fid=None, current_name=None, new_name=None,
                             entity_label="hunt", row_label="vault row"):
    """Resolve `text` (a roster name or an ID) and apply it to the target row.
    Known members match immediately (moving the match off any other row). An
    unknown ID is confirmed against the alliance's state and offered for
    confirmation + add-to-alliance. `view` must expose cog, alliance_id, hunt_id,
    roster, original_user_id, and an async refresh(). `new_name`, if given, is
    only used when `text` resolves to a brand-new fid (not a link to an
    existing roster member) — it lets the admin set the real name up front
    instead of getting a 'Player <fid>' placeholder to rename later.

    `entity_label`/`row_label` are display-only words ("hunt"/"vault row" by
    default) so a structurally-identical tracker (e.g. Capitol War's
    "event"/"Capitol War row") can reuse this whole resolution flow --
    digit-ID vs. name handling, the cross-alliance-ID guard, the unknown-ID
    add-confirm handoff -- without copying it just to change two words in
    the user-facing messages."""
    raw = (text or "").strip()
    # Unchanged edit of a matched row: keep the player, just update damage/rank.
    if row_id is not None and current_fid is not None and raw == (current_name or "").strip():
        if _write_match_to_row(view, row_id=row_id, fid=current_fid, nick=current_name,
                               damage=damage, rank=rank):
            await view.refresh(interaction)
        else:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to update row.", ephemeral=True)
        return

    text, forced_name = _strip_name_quotes(raw)
    if not text:
        await interaction.response.send_message(
            f"{theme.deniedIcon} Enter an ID or name.", ephemeral=True)
        return

    if text.isdigit() and not forced_name:
        fid = int(text)
        # Adding a brand-new row for someone already in the hunt would orphan
        # their existing row — reject it (editing an existing row swaps instead).
        if row_id is None and _fid_in_hunt(view, fid):
            await interaction.response.send_message(
                f"{theme.deniedIcon} ID `{fid}` is already in this {entity_label}.", ephemeral=True)
            return
        # roster entries may be 2- or 4-tuples; fid first, display nick last
        roster_nick = next((e[-1] for e in view.roster if e[0] == fid), None)
        if roster_nick is not None:
            if _write_match_to_row(view, row_id=row_id, fid=fid, nick=roster_nick,
                                   damage=damage, rank=rank, raw_name=raw_name):
                await view.refresh(interaction)
            else:
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Failed to update row.", ephemeral=True)
            return
        # Not a current member of this alliance — is the ID known elsewhere?
        other = view.cog.users_cursor.execute(
            "SELECT nickname, alliance FROM users WHERE fid = ?", (fid,)).fetchone()
        if other and other[1] and str(other[1]) != str(view.alliance_id):
            arow = view.cog.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?", (other[1],)).fetchone()
            other_alliance = f"**{arow[0]}**" if arow else f"ID `{other[1]}`"
            await interaction.response.send_message(
                f"{theme.deniedIcon} ID `{fid}` (`{other[0]}`) is already in alliance {other_alliance}. "
                f"Move them here first via Manage Members → Transfer.",
                ephemeral=True)
            return
        await _offer_add_by_id(interaction, view, row_id=row_id, fid=fid,
                               damage=damage, rank=rank, raw_name=raw_name,
                               new_name=new_name, row_label=row_label)
        return

    # Name entered — fuzzy-match the roster only (can't API-lookup by name).
    fid, nick, _ = _resolve_player(text, view.roster, force_name=forced_name)
    if fid is None:
        await interaction.response.send_message(
            f"{theme.deniedIcon} No roster match for `{text}`. Enter the player's **ID** "
            f"(and optionally their name in the field below it) to add them.", ephemeral=True)
        return
    if row_id is None and _fid_in_hunt(view, fid):
        await interaction.response.send_message(
            f"{theme.deniedIcon} `{nick}` (ID {fid}) is already in this {entity_label}.", ephemeral=True)
        return
    if _write_match_to_row(view, row_id=row_id, fid=fid, nick=nick, damage=damage,
                           rank=rank, raw_name=raw_name):
        await view.refresh(interaction)
    else:
        await interaction.response.send_message(
            f"{theme.deniedIcon} Failed to update row.", ephemeral=True)


async def _offer_add_by_id(interaction, view, *, row_id, fid, damage, rank, raw_name, new_name=None,
                           row_label="vault row"):
    """Show a confirm card for adding an unknown fid straight from the review screen.
    Police Chief has no API left to verify a typed ID actually belongs to the alliance's
    state (see gift_state_resolver.verify_add_state's docstring) — that used to gate this
    behind an always-failing probe, silently redirecting admins to add the member
    elsewhere first. Since there's nothing left to verify against, trust the admin's typed
    ID (same trust level as the CSV-import/manual-add flows, which never verified either)
    and assign the alliance's known home state directly. Names can't be looked up from
    just an ID, so the member is added as 'Player <fid>' pending a rename.

    `row_label` is forwarded to `PlayerAddConfirmView` for its confirm-card
    wording (see `_resolve_and_apply`)."""
    await interaction.response.defer()
    from . import gift_state_resolver
    alliance_kid = await asyncio.to_thread(gift_state_resolver.get_alliance_kid, view.alliance_id)
    if alliance_kid is None:
        await interaction.followup.send(
            f"{theme.warnIcon} This alliance has no state set, so I can't add ID `{fid}` without one. "
            f"Set its state first (Alliance Management → Set State), then try again.",
            ephemeral=True)
        return
    parent_message = await interaction.original_response()  # the review/editor message to refresh on confirm
    confirm = PlayerAddConfirmView(
        view=view, parent_message=parent_message, row_id=row_id, fid=fid, kid=alliance_kid,
        damage=damage, rank=rank, raw_name=raw_name, new_name=new_name, row_label=row_label)
    await interaction.followup.send(embed=confirm.build_embed(), view=confirm, ephemeral=True)


class PlayerAddConfirmView(discord.ui.View):
    """Confirm adding a typed-in fid to the alliance and matching the row. The fid was
    confirmed in the alliance's state by a single probe; names can't be looked up by ID
    alone, so the member is added as 'Player <fid>' unless a real name was supplied
    alongside the ID (the modal's optional 'New Player Name' field)."""

    def __init__(self, *, view, parent_message, row_id, fid, kid, damage, rank, raw_name,
                 new_name=None, row_label="vault row"):
        super().__init__(timeout=120)
        self.parent = view
        self.parent_message = parent_message
        self.original_user_id = view.original_user_id
        self.row_id = row_id
        self.fid = fid
        self.kid = kid
        self.damage = damage
        self.rank = rank
        self.raw_name = raw_name or ""
        self.new_name = (new_name or "").strip()
        self.row_label = row_label
        confirm_btn = discord.ui.Button(label="Confirm & Add", emoji=theme.verifiedIcon,
                                        style=discord.ButtonStyle.success)
        confirm_btn.callback = self._on_confirm
        cancel_btn = discord.ui.Button(label="Cancel", emoji=theme.deniedIcon,
                                       style=discord.ButtonStyle.secondary)
        cancel_btn.callback = self._on_cancel
        self.add_item(confirm_btn)
        self.add_item(cancel_btn)

    def _nickname(self):
        return self.new_name or f"Player {self.fid}"

    def build_embed(self) -> discord.Embed:
        if self.new_name:
            name_line = f"**{theme.userIcon} Name:** `{self.new_name}`"
        else:
            name_line = (f"**{theme.userIcon} Name:** `Player {self.fid}` - names can't be "
                        f"looked up, rename later if needed")
        return discord.Embed(
            title=f"{theme.userIcon} Add Player to Alliance?",
            description=(
                f"{theme.upperDivider}\n"
                f"**{theme.fidIcon} ID:** `{self.fid}`\n"
                f"**{theme.globeIcon} State:** `{self.kid}` (confirmed)\n"
                f"{name_line}\n"
                f"{theme.lowerDivider}\n"
                f"This will add them to **this alliance** and match the {self.row_label}."),
            color=theme.emColor1)

    async def _on_confirm(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        cog = self.parent.cog
        nick = self._nickname()
        try:
            cog.users_conn.execute(
                "INSERT OR REPLACE INTO users (fid, nickname, chief_office_lv, kid, alliance) "
                "VALUES (?, ?, ?, ?, ?)",
                (self.fid, nick, 0, str(self.kid), str(self.parent.alliance_id)))
            cog.users_conn.commit()
        except Exception as e:
            logger.error(f"Failed to add user {self.fid}: {e}")
            print(f"[ERROR] Failed to add user {self.fid}: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to add the player to the alliance.", ephemeral=True)
            return
        # Refresh the roster cache so the new member resolves immediately.
        self.parent.roster = cog.get_alliance_roster(self.parent.alliance_id)
        if not _write_match_to_row(self.parent, row_id=self.row_id, fid=self.fid,
                                   nick=nick, damage=self.damage, rank=self.rank,
                                   raw_name=self.raw_name):
            await interaction.response.send_message(
                f"{theme.deniedIcon} Player added, but matching the row failed.", ephemeral=True)
            return
        await self.parent.reapply_to_message(self.parent_message)  # refresh review in place
        await interaction.response.edit_message(
            embed=discord.Embed(
                description=f"{theme.verifiedIcon} Added **{_isolate_rtl(nick)}** and matched the row.",
                color=theme.emColor3),
            view=None)

    async def _on_cancel(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.edit_message(
            embed=discord.Embed(description=f"{theme.deniedIcon} Cancelled. No player added.",
                                color=theme.emColor2),
            view=None)


class EditSavedPlayerModal(discord.ui.Modal):
    """Edit a saved player row (player / damage / rank). Blank player deletes it."""

    def __init__(self, parent_view: 'VaultDamageEditView', row: dict):
        super().__init__(title=f"Edit Player · {format_damage_for_embed(row['damage'])}"[:45])
        self.parent_view = parent_view
        self.row = row
        self.player_input = discord.ui.TextInput(
            label="Player (ID or name — blank to delete)",
            default=(row['nickname'] or row['raw_name'] or ''), required=False, max_length=80)
        self.damage_input = discord.ui.TextInput(
            label="Damage", default=format_damage_for_embed(row['damage']),
            required=True, max_length=30)
        self.rank_input = discord.ui.TextInput(
            label="Rank (optional)",
            default=str(row['rank']) if row['rank'] is not None else "",
            required=False, max_length=3)
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)",
            required=False, max_length=80)
        self.add_item(self.player_input)
        self.add_item(self.damage_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction: discord.Interaction):
        cur = self.parent_view.cog.vault_cursor
        conn = self.parent_view.cog.vault_conn
        if not self.player_input.value.strip():
            try:
                cur.execute("DELETE FROM vault_player_damage WHERE id = ?", (self.row['id'],))
                conn.commit()
            except Exception as e:
                conn.rollback()
                logger.error(f"Failed to delete player row {self.row['id']}: {e}")
                await interaction.response.send_message(
                    f"{theme.deniedIcon} Failed to delete row.", ephemeral=True)
                return
            await self.parent_view.refresh(interaction)
            return
        damage = vault_damage(self.damage_input.value)
        if damage <= 0:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid damage value.", ephemeral=True)
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
            text=self.player_input.value, damage=damage, rank=rank,
            raw_name=self.row.get('raw_name'),
            current_fid=self.row.get('fid'),
            current_name=self.row.get('nickname') or self.row.get('raw_name'),
            new_name=self.new_name_input.value)


class AddSavedPlayerModal(discord.ui.Modal):
    """Add a player row to a saved hunt (for players OCR missed entirely)."""

    def __init__(self, parent_view: 'VaultDamageEditView'):
        super().__init__(title="Add Player")
        self.parent_view = parent_view
        self.player_input = discord.ui.TextInput(label="Player (ID or name)", required=True, max_length=80)
        self.damage_input = discord.ui.TextInput(label="Damage", required=True, max_length=30)
        self.rank_input = discord.ui.TextInput(label="Rank (optional)", required=False, max_length=3)
        self.new_name_input = discord.ui.TextInput(
            label="New Player Name (only if adding, not linking)",
            required=False, max_length=80)
        self.add_item(self.player_input)
        self.add_item(self.damage_input)
        self.add_item(self.rank_input)
        self.add_item(self.new_name_input)

    async def on_submit(self, interaction: discord.Interaction):
        text = self.player_input.value.strip()
        if not text:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Player is required.", ephemeral=True)
            return
        damage = vault_damage(self.damage_input.value)
        if damage <= 0:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid damage value.", ephemeral=True)
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
            text=text, damage=damage, rank=rank, raw_name=text,
            new_name=self.new_name_input.value)


# ---------------------------------------------------------------------------
# VaultLeaderboardView — top players by summed damage over a window
# ---------------------------------------------------------------------------

class VaultLeaderboardView(discord.ui.View):
    PAGE_SIZE = 15
    SORT_LABELS = {'total': 'Total Damage', 'hunts': 'Hunts Attended', 'avg': 'Average Damage'}

    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name,
                 trap_number, from_date, to_date, chart_view=None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.trap_number = trap_number
        self.from_date = from_date
        self.to_date = to_date
        self.chart_view = chart_view
        self.page = 0
        self.sort_mode = 'total'
        # Default leaderboard scope is active-members-only (decision #3);
        # deactivated members' history stays reachable via direct lookups
        # (player history, "All Total" compare) but drops out of this view.
        active_fids = {fid for fid, _ in cog.get_alliance_roster(alliance_id, active_only=True)}
        self.entries = _aggregate_leaderboard(
            cog.vault_cursor, alliance_id=alliance_id, trap_number=trap_number,
            from_date=from_date, to_date=to_date, active_fids=active_fids)
        self._apply_sort()
        self._build_components()

    def _apply_sort(self):
        key = {'total': lambda e: e['total'], 'hunts': lambda e: e['hunts'],
               'avg': lambda e: e['avg']}[self.sort_mode]
        self.entries.sort(key=key, reverse=True)

    def _total_pages(self) -> int:
        return max(1, -(-len(self.entries) // self.PAGE_SIZE))

    def build_embed(self) -> discord.Embed:
        trap_label = "All Vault Trap operations" if self.trap_number == 'both' else f"Vault Trap {self.trap_number}"
        rng = f"{self.from_date} → {self.to_date}" if (self.from_date and self.to_date) else "All time"
        embed = discord.Embed(
            title=f"{theme.medalIcon} Top Players · {self.alliance_name} · {trap_label}",
            color=theme.emColor1)
        if not self.entries:
            embed.description = "*No matched player damage in this range.*"
            embed.set_footer(text=rng)
            return embed
        start = self.page * self.PAGE_SIZE
        end = min(start + self.PAGE_SIZE, len(self.entries))
        lines = []
        for i, e in enumerate(self.entries[start:end], start=start + 1):
            lines.append(_ltr_line(
                f"`#{i}` {_isolate_rtl(e['nickname'])} — `{format_damage_for_embed(e['total'])}` "
                f"· {e['hunts']} hunt(s) · avg `{format_damage_for_embed(e['avg'])}`"))
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
                # IDs live here (not in the main list) so duplicate-name players
                # are still distinguishable when drilling into history.
                opts.append(discord.SelectOption(
                    label=_ltr_line(e['nickname'])[:100], value=str(e['fid']),
                    description=f"ID {e['fid']} · {format_damage_for_embed(e['total'])} total · {e['hunts']} hunts"[:100]))
            sel = discord.ui.Select(placeholder="View a player's history…", options=opts, row=0)
            sel.callback = self._on_player_selected
            self.add_item(sel)
        # Row 1: pagination right below the dropdown (Prev · Page X/Y · Next).
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
        # Row 2: sort toggles — active mode highlighted.
        for mode, label in (('total', "Sort: Total"), ('hunts', "Sort: Hunts"), ('avg', "Sort: Average")):
            btn = discord.ui.Button(
                label=label, row=2,
                style=(discord.ButtonStyle.success if self.sort_mode == mode
                       else discord.ButtonStyle.secondary))
            btn.callback = self._make_sort_cb(mode)
            self.add_item(btn)
        # Row 3: Back (kept apart from pagination to avoid confusion).
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
        view = PlayerHistoryView(
            cog=self.cog, original_user_id=self.original_user_id,
            alliance_id=self.alliance_id, alliance_name=self.alliance_name,
            fid=fid, trap_number=self.trap_number, parent_view=self)
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
        # Return to the exact chart view we came from (preserves trap + range,
        # including All Time, which a rebuilt view would otherwise reset to 3m).
        if self.chart_view is not None:
            await self.chart_view.try_redraw(interaction)
        else:
            await self.cog.show_vault_track_menu(interaction)


# ---------------------------------------------------------------------------
# PlayerHistoryView — one player's damage history + personal chart
# ---------------------------------------------------------------------------

class PlayerHistoryView(discord.ui.View):
    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name, fid,
                 trap_number, parent_view):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.fid = fid
        # History defaults to a single trap; 'both' overlays the two series.
        self.trap_number = trap_number if trap_number in (1, 2, '1', '2') else 'both'
        self.parent_view = parent_view
        self.nickname = str(fid)
        self.records: list = []
        self._load()
        self._build_components()

    def _load(self):
        cur = self.cog.vault_cursor
        sql = ("SELECT bh.date, bh.trap_number, bpd.damage, bpd.rank, bpd.resolved_nickname "
               "FROM vault_player_damage bpd JOIN vault_hunts bh ON bh.id = bpd.hunt_id "
               "WHERE bpd.fid = ? AND bh.alliance_id = ?")
        params: list = [self.fid, self.alliance_id]
        if self.trap_number != 'both':
            sql += " AND bh.trap_number = ?"
            params.append(int(self.trap_number))
        sql += " ORDER BY bh.date ASC"
        cur.execute(sql, params)
        self.records = cur.fetchall()
        if self.records:
            self.nickname = self.records[-1][4] or str(self.fid)

    def _build_components(self):
        self.clear_items()
        for trap, label in ((1, "Vault Trap 1"), (2, "Vault Trap 2"), ('both', "All")):
            btn = discord.ui.Button(
                label=label, row=0,
                style=(discord.ButtonStyle.success if self.trap_number == trap
                       else discord.ButtonStyle.secondary))
            btn.callback = self._make_trap_cb(trap)
            self.add_item(btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=1)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def build(self):
        trap_label = "All Vault Trap operations" if self.trap_number == 'both' else f"Vault Trap {self.trap_number}"
        embed = discord.Embed(
            title=f"{theme.chartIcon} {_isolate_rtl(self.nickname)} · {trap_label} History",
            color=theme.emColor1)
        if not self.records:
            embed.description = "*No recorded hunts for this player in this filter.*"
            return embed, None
        # Same-trap delta within the listing.
        lines = []
        last_by_trap: dict = {}
        for dt, trap, dmg, rank, _ in self.records:
            rank_str = f"#{rank}" if rank is not None else "#?"
            prev = last_by_trap.get(trap)
            delta = ""
            if prev:
                pct = (dmg - prev) / prev * 100.0 if prev else 0
                delta = f"  {_format_delta_pct(pct)}"
            last_by_trap[trap] = dmg
            lines.append(_ltr_line(
                f"`{dt}` · Trap {trap} - {rank_str} — `{format_damage_for_embed(dmg)}`{delta}"))
        embed.description = "\n".join(lines[-25:])
        values = [int(r[2]) for r in self.records]
        total = sum(values)
        avg = total // len(values)
        embed.set_footer(
            text=f"{len(self.records)} hunt(s) · total {format_damage_for_embed(total)} "
                 f"· avg {format_damage_for_embed(avg)}")
        # Chart: one series per trap when 'both', else a single line.
        if self.trap_number == 'both':
            series = []
            for t in (1, 2):
                pts = [(datetime.strptime(r[0], "%Y-%m-%d"), int(r[2]))
                       for r in self.records if r[1] == t]
                if pts:
                    series.append((f"Trap {t}", [p[0] for p in pts], [p[1] for p in pts]))
            file = _render_damage_chart(
                None, None, series=series,
                title=f"{self.nickname} Damage Over Time", ylabel="Damage")
        else:
            dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in self.records]
            file = _render_damage_chart(
                dates, values, title=f"{self.nickname} Damage Over Time", ylabel="Damage")
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        return embed, file

    def _make_trap_cb(self, trap):
        async def _cb(interaction: discord.Interaction):
            if not await check_interaction_user(interaction, self.original_user_id):
                return
            if self.trap_number == trap:
                await interaction.response.defer()
                return
            self.trap_number = trap
            self._load()
            self._build_components()
            await self.render(interaction)
        return _cb

    async def render(self, interaction: discord.Interaction):
        # Chart render can exceed the 3s ack window and blocks the loop — defer + off-thread.
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
# VaultCompareView — multi-player damage comparison (/vault_compare)
# ---------------------------------------------------------------------------

class VaultCompareView(discord.ui.View):
    """Roster picker (paginated, mirrors the Select+Prev/Next pattern used by
    VaultLeaderboardView and FilteredUserSelectView elsewhere) followed by a
    stats summary + overlaid line chart once 2+ players are picked.

    Capped at 8 players (MAX_PLAYERS): past that the chart legend and the
    stats list both stop being readable in a Discord embed, and 8 already
    comfortably covers "compare a squad/top cluster" use cases. PAGE_SIZE=25
    is Discord's hard limit on options per select component, not a design
    choice — selections persist across pages via `selected_fids`.
    """
    PAGE_SIZE = 25
    MAX_PLAYERS = 8
    PRESETS = [('1w', '1 Week'), ('1m', '1 Month'), ('3m', '3 Months')]

    def __init__(self, *, cog, original_user_id, alliance_id, alliance_name,
                 from_date, to_date):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id = alliance_id
        self.alliance_name = alliance_name
        self.from_date = from_date
        self.to_date = to_date
        # `preset` tracks which quick-range button (if any) is active, purely
        # for highlighting it in VaultCompareTimeRangeView — None covers both
        # "no range" and "an exact from_date/to_date typed into the command".
        self.preset: str | None = None
        self.page = 0
        self.selected_fids: list = []  # preserves pick order across pages
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
        """Select All Active / Select All Total: picks the whole candidate set
        (active-only or everyone, including deactivated members) when it fits
        within MAX_PLAYERS, otherwise ranks by total damage in the current
        date range and keeps the top MAX_PLAYERS (mirrors the truncation note
        pattern already used by `_on_select`)."""
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        candidates = self.cog.get_alliance_roster(self.alliance_id, active_only=active_only)
        # So names resolve correctly even for deactivated members pulled in by
        # "Select All Total" that aren't on the (active-only) picker roster.
        self._nick_by_fid.update({fid: nick for fid, nick in candidates})

        if len(candidates) <= self.MAX_PLAYERS:
            self.selected_fids = [fid for fid, _ in candidates]
            self.note = ""
        else:
            cur = self.cog.vault_cursor
            ranked = []
            for fid, _nick in candidates:
                rows = _fetch_player_damage_series(
                    cur, alliance_id=self.alliance_id, fid=fid,
                    from_date=self.from_date, to_date=self.to_date)
                total = sum(int(r[1]) for r in rows) if rows else 0
                ranked.append((fid, total))
            ranked.sort(key=lambda x: x[1], reverse=True)
            self.selected_fids = [fid for fid, _ in ranked[:self.MAX_PLAYERS]]
            label = "active" if active_only else "total"
            self.note = (f"Selected the top {self.MAX_PLAYERS} of {len(candidates)} "
                        f"{label} members by damage in this range.")

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
        # Merge this page's picks into the running selection: keep anything
        # not on this page untouched, drop anything on this page that's no
        # longer checked, and append newly-checked ones in id order.
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
        # Chart render can exceed the 3s ack window and blocks the loop — defer + off-thread.
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
        """Stats summary + overlaid line chart for the currently selected
        players. Run off-thread (chart rendering is blocking)."""
        cur = self.cog.vault_cursor
        stats = []
        series = []
        for fid in self.selected_fids:
            rows = _fetch_player_damage_series(
                cur, alliance_id=self.alliance_id, fid=fid,
                from_date=self.from_date, to_date=self.to_date)
            nick = self._nick_by_fid.get(fid, str(fid))
            if not rows:
                stats.append({'fid': fid, 'nickname': nick, 'hunts': 0, 'total': 0,
                             'avg': 0, 'best_rank': None})
                continue
            dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in rows]
            damages = [int(r[1]) for r in rows]
            ranks = [int(r[2]) for r in rows if r[2] is not None]
            total = sum(damages)
            hunts = len(damages)
            stats.append({
                'fid': fid, 'nickname': nick, 'hunts': hunts, 'total': total,
                'avg': total // hunts if hunts else 0,
                'best_rank': min(ranks) if ranks else None,
            })
            series.append((_reshape_for_chart(nick), dates, damages))

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
                f"· avg `{format_damage_for_embed(s['avg'])}` · {s['hunts']} hunt(s) · best rank {best_rank}"
            ))
        embed.description = "\n".join(lines) if lines else "*No data for the selected players.*"
        embed.set_footer(text=rng)

        file = _render_damage_chart(
            None, None, series=series,
            title=f"Damage Comparison · {self.alliance_name}", ylabel="Damage")
        if file is not None:
            embed.set_image(url="attachment://plot.png")
        return embed, file


class VaultCompareTimeRangeView(discord.ui.View):
    """Preset/custom range picker for /vault_compare. Applies to the compare
    view's picker screen and returns to it (mirrors VaultTimeRangeView, but
    scoped to the 1 Week/1 Month/3 Months presets requested for comparisons
    rather than VaultDamageView's calendar-month-based set)."""

    def __init__(self, compare_view: 'VaultCompareView'):
        super().__init__(timeout=7200)
        self.compare = compare_view
        self.original_user_id = compare_view.original_user_id
        self._build_components()

    def build_embed(self) -> discord.Embed:
        return discord.Embed(
            title=f"{theme.calendarIcon} Time Range",
            description=(
                "Pick the range to compare (default is all time).\n"
                f"{theme.upperDivider}\n"
                "Choose a preset, or **Custom** for an exact date range.\n"
                f"{theme.lowerDivider}"),
            color=theme.emColor1)

    def _build_components(self):
        self.clear_items()
        # type(self.compare) rather than the hardcoded VaultCompareView lets a
        # structurally-identical compare view (e.g. Capitol War's) reuse this
        # whole class unmodified, as long as it defines the same PRESETS shape.
        for preset, label in type(self.compare).PRESETS:
            btn = discord.ui.Button(
                label=label, row=0,
                style=(discord.ButtonStyle.success if self.compare.preset == preset
                       else discord.ButtonStyle.secondary))
            btn.callback = self._make_preset_cb(preset)
            self.add_item(btn)
        custom_btn = discord.ui.Button(
            label="Custom", emoji=theme.editListIcon, row=0,
            style=(discord.ButtonStyle.success
                   if self.compare.preset is None
                   and (self.compare.from_date or self.compare.to_date)
                   else discord.ButtonStyle.secondary))
        custom_btn.callback = self._on_custom
        self.add_item(custom_btn)
        all_time_btn = discord.ui.Button(
            label="All Time", row=1,
            style=(discord.ButtonStyle.success
                   if self.compare.preset is None
                   and not self.compare.from_date and not self.compare.to_date
                   else discord.ButtonStyle.secondary))
        all_time_btn.callback = self._on_all_time
        self.add_item(all_time_btn)
        back_btn = discord.ui.Button(label="Back", emoji=theme.backIcon,
                                     style=discord.ButtonStyle.secondary, row=1)
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    def _make_preset_cb(self, preset):
        async def _cb(interaction: discord.Interaction):
            if not await check_interaction_user(interaction, self.original_user_id):
                return
            self.compare._apply_preset(preset)
            self.compare._build_components()
            await interaction.response.edit_message(
                embed=self.compare.build_picker_embed(), view=self.compare, attachments=[])
        return _cb

    async def _on_all_time(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.compare.from_date = None
        self.compare.to_date = None
        self.compare.preset = None
        self.compare._build_components()
        await interaction.response.edit_message(
            embed=self.compare.build_picker_embed(), view=self.compare, attachments=[])

    async def _on_custom(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await interaction.response.send_modal(VaultCompareDateRangeModal(self.compare))

    async def _on_back(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.compare._build_components()
        await interaction.response.edit_message(
            embed=self.compare.build_picker_embed(), view=self.compare, attachments=[])


class VaultCompareDateRangeModal(discord.ui.Modal, title="Select Date Range"):
    from_date = discord.ui.TextInput(
        label="From Date (YYYY-MM-DD)", required=False, placeholder="2026-01-01"
    )
    to_date = discord.ui.TextInput(
        label="To Date (YYYY-MM-DD)", required=False, placeholder="2026-01-31"
    )

    def __init__(self, compare_view: 'VaultCompareView'):
        super().__init__()
        self.compare_view = compare_view
        if self.compare_view.from_date:
            self.from_date.default = self.compare_view.from_date
        if self.compare_view.to_date:
            self.to_date.default = self.compare_view.to_date

    async def on_submit(self, interaction: discord.Interaction):
        try:
            if self.from_date.value:
                datetime.strptime(self.from_date.value, "%Y-%m-%d")
            if self.to_date.value:
                datetime.strptime(self.to_date.value, "%Y-%m-%d")
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date format. Use YYYY-MM-DD.", ephemeral=True
            )
            return
        self.compare_view.from_date = self.from_date.value or None
        self.compare_view.to_date = self.to_date.value or None
        self.compare_view.preset = None
        self.compare_view._build_components()
        await interaction.response.edit_message(
            embed=self.compare_view.build_picker_embed(), view=self.compare_view, attachments=[])


# ---------------------------------------------------------------------------
# VaultSettingsView — settings management
# ---------------------------------------------------------------------------

class VaultSettingsView(discord.ui.View):
    def __init__(self, cog, original_user_id, guild_id: int | None = None):
        super().__init__(timeout=7200)
        self.cog = cog
        self.original_user_id = original_user_id
        self.alliance_id: int | None = None
        # Same shortcut as MainMenu.show_alliance_management: an admin who
        # only manages one alliance shouldn't have to pick it from a
        # dropdown before the settings buttons even become clickable.
        # Multi-alliance admins are unaffected -- the dropdown still shows
        # and starts unselected exactly as before.
        if guild_id is not None:
            alliances, _ = PermissionManager.get_admin_alliances(original_user_id, guild_id)
            if len(alliances) == 1:
                self.alliance_id = alliances[0][0]
        self._build_components()

    def _build_components(self):
        self.clear_items()
        options = build_alliance_options(self.cog.alliance_conn)
        self.add_item(AllianceSelect(self, options, action="manage"))

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

        # History toggle sits to the left of Back on row 2 — it doesn't belong
        # in the row-1 "Toggle X" cluster (it's an opt-in matching tweak, not a
        # session/permission knob), but it also doesn't warrant its own row.
        history_btn = discord.ui.Button(label="Toggle Name History Match", style=discord.ButtonStyle.primary, emoji=theme.listIcon, row=2, disabled=not has_alliance)
        history_btn.callback = self._toggle_history_callback
        self.add_item(history_btn)

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
            title=f"{theme.settingsIcon} Vault Trap Settings",
            description=(
                f"Operational settings: session pacing, cleanup, who "
                f"can interact with the system and more. \n\n"
                f"**Available Settings**\n"
                f"{theme.upperDivider}\n"
                f"{theme.hourglassIcon} **Session Timeout**\n"
                f"└ Minutes to wait for more screenshots before finalising the event (1-60)\n\n"
                f"{theme.trashIcon} **Toggle Auto-Delete**\n"
                f"└ Delete uploaded screenshots after event submission\n\n"
                f"{theme.lockIcon} **Toggle Permissions**\n"
                f"└ Who can add hunts and view saved data\n\n"
                f"{theme.listIcon} **Toggle Full Name History Match**\n"
                f"└ Whether to match players by all their past names\n"
                f"└ Their current & event-date names are always matched\n\n"
                f"{theme.documentIcon} **Toggle Info Message / Pin Info**\n"
                f"└ Pinned helper in the vault channel explaining which mail to upload\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1
        )

        if self.alliance_id:
            settings = self.cog.get_vault_settings(self.alliance_id)
            view_text = "Admins only" if settings["admin_only_view"] else "Everyone"
            add_text = "Admins only" if settings["admin_only_add"] else "Everyone"
            timeout_min = settings["session_timeout_min"]
            auto_delete_text = "On" if settings["auto_delete_screenshots"] else "Off"
            history_text = "On" if settings["match_all_history"] else "Off"
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
                f"**Full Name History Match:** {history_text}\n"
                f"**Info Message:** {info_text}\n"
                f"**Add Permission:** {add_text}\n"
                f"**View Permission:** {view_text}\n"
                f"{theme.lowerDivider}"
            )
            embed.add_field(name="Current Settings", value=current_settings, inline=False)

        return embed

    async def on_alliance_selected(self, interaction: discord.Interaction):
        """Called by AllianceSelect when an alliance is picked."""
        if not self.alliance_id:
            return
        self._build_components()
        embed = self._build_embed()
        await interaction.response.edit_message(content=None, view=self, embed=embed)

    async def _session_timeout_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        await interaction.response.send_modal(
            SessionTimeoutModal(self.cog, self.alliance_id, settings["session_timeout_min"], self)
        )

    async def _toggle_auto_delete_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        new_value = 0 if settings["auto_delete_screenshots"] else 1
        self.cog.update_vault_setting(self.alliance_id, "vault_auto_delete_screenshots", new_value)
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Auto-delete is now **{on_off}**."
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _toggle_history_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        new_value = 0 if settings["match_all_history"] else 1
        self.cog.update_vault_setting(self.alliance_id, "vault_match_all_history", new_value)
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Full Name History Match is now **{on_off}**."
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _toggle_info_message_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not await self.cog.check_vault_permission(interaction, self.alliance_id, "manage"):
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        new_value = 0 if settings["post_info_message"] else 1
        self.cog.update_vault_setting(self.alliance_id, "vault_post_info_message", new_value)
        note = await self._apply_info_refresh(settings["channel_id"])
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Info message is now **{on_off}**.{note}"
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _toggle_pin_info_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        if not await self.cog.check_vault_permission(interaction, self.alliance_id, "manage"):
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        new_value = 0 if settings["pin_info_message"] else 1
        self.cog.update_vault_setting(self.alliance_id, "vault_pin_info_message", new_value)
        note = await self._apply_info_refresh(settings["channel_id"])
        embed = self._build_embed()
        on_off = "On" if new_value else "Off"
        embed.description += f"\n{theme.verifiedIcon} Pin info is now **{on_off}**.{note}"
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _apply_info_refresh(self, channel_id) -> str:
        """Refresh the channel's info message; return a short note if no channel
        is configured yet (so the toggle still saves but the admin knows why
        nothing was posted)."""
        if not channel_id:
            return " (set a vault channel first to post it)"
        try:
            await self.cog.refresh_vault_info_message(self.alliance_id)
        except Exception as e:
            logger.warning(f"Could not refresh vault info message: {e}")
        return ""

    async def _toggle_add_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        await self._toggle_permission(interaction, "add")

    async def _toggle_view_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        await self._toggle_permission(interaction, "view")

    async def _toggle_permission(self, interaction: discord.Interaction, mode: str):
        settings = self.cog.get_vault_settings(self.alliance_id)
        key = f"admin_only_{mode}"
        current = settings.get(key, 0)
        new_value = 0 if current else 1

        column = f"vault_admin_only_{mode}"
        self.cog.update_vault_setting(self.alliance_id, column, new_value)

        embed = self._build_embed()
        embed.description += f"\n{theme.verifiedIcon} {mode.capitalize()} permission updated."
        await safe_edit_message(interaction, embed=embed, view=self, content=None)

    async def _back_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_vault_track_menu(interaction)


# ---------------------------------------------------------------------------
# OCR language configuration
# ---------------------------------------------------------------------------

class VaultOcrLanguagesView(discord.ui.View):
    """Per-alliance OCR language picker — a single primary engine plus
    any number of fallback engines to retry with when a row's name came
    back unreadable from the primary pass. Settings persist as soon as
    the admin changes a dropdown.
    """

    def __init__(self, cog, alliance_id, original_user_id, parent_view):
        super().__init__(timeout=7200)
        self.cog = cog
        self.alliance_id = alliance_id
        self.original_user_id = original_user_id
        self.parent = parent_view
        self._build()

    def _build(self):
        self.clear_items()
        primary, fallbacks = self.cog.get_ocr_language_settings(self.alliance_id)
        auto_manage = self.cog.get_ocr_auto_manage(self.alliance_id)

        def _cost_description(code: str) -> str:
            fp = _OCR_LANG_FOOTPRINT_MB.get(code)
            if not fp:
                return None
            return f"~{fp['ram']} MB RAM · ~{fp['disk']} MB disk"

        primary_opts = [
            discord.SelectOption(
                label=label, value=code,
                description=_cost_description(code),
                default=(code == primary),
            )
            for code, label in OCR_LANGUAGES
        ]
        primary_select = discord.ui.Select(
            placeholder="Primary OCR language",
            options=primary_opts, min_values=1, max_values=1, row=0,
        )
        primary_select.callback = self._on_primary_change
        self.add_item(primary_select)

        fb_opts = [
            discord.SelectOption(
                label=label, value=code,
                description=_cost_description(code),
                default=(code in fallbacks),
            )
            for code, label in OCR_LANGUAGES if code != primary
        ]
        if fb_opts:
            fb_select = discord.ui.Select(
                placeholder=("Fallbacks auto-managed from your roster"
                             if auto_manage
                             else "Fallback languages (optional, pick any number)"),
                options=fb_opts,
                min_values=0, max_values=len(fb_opts), row=1,
                disabled=auto_manage,  # bot-managed → read-only; toggle off to edit
            )
            fb_select.callback = self._on_fallbacks_change
            self.add_item(fb_select)

        manage_btn = discord.ui.Button(
            label=f"Auto-manage: {'On' if auto_manage else 'Off'}",
            emoji=theme.cleanIcon,
            style=discord.ButtonStyle.success if auto_manage else discord.ButtonStyle.secondary,
            row=2,
        )
        manage_btn.callback = self._on_auto_manage_toggle
        self.add_item(manage_btn)

        back = discord.ui.Button(
            label="Back", style=discord.ButtonStyle.secondary,
            emoji=theme.backIcon, row=2,
        )
        back.callback = self._on_back
        self.add_item(back)

    def _build_embed(self):
        primary, fallbacks = self.cog.get_ocr_language_settings(self.alliance_id)
        primary_label = OCR_LANG_LABEL.get(primary, primary)
        fb_labels = [OCR_LANG_LABEL.get(c, c) for c in fallbacks]

        description = (
            f"Pick which OCR models read player names off screenshots. Each "
            f"model handles a specific script. Memory and disk cost per "
            f"language are shown in the dropdowns.\n\n"
            f"{theme.upperDivider}\n"
            f"**Primary:** {primary_label}\n"
            f"└ Runs first on every screenshot.\n\n"
            f"**Fallbacks:** {', '.join(fb_labels) if fb_labels else '*(none)*'}\n"
            f"└ Re-OCR rows the primary couldn't read (mixed-script alliances).\n\n"
            f"{theme.cleanIcon} **Auto-manage**\n"
            f"└ On: the bot picks fallback engines automatically from your "
            f"members' name scripts. Cyrillic, Arabic, etc. are enabled only when a "
            f"member actually uses them, and dropped when they leave. Turn off to "
            f"choose fallbacks manually.\n"
            f"{theme.lowerDivider}\n"
        )
        description += self._build_effectiveness_section(primary, fallbacks)
        return discord.Embed(
            title=f"{theme.globeIcon} Character Recognition",
            description=description,
            color=theme.emColor1,
        )

    def _build_effectiveness_section(self, primary: str, fallbacks: list) -> str:
        """Per-language stats grouped into Primary / Fallback sections."""
        stats = get_ocr_lang_stats(self.alliance_id)
        if not stats:
            return (
                f"\n{theme.upperDivider}\n"
                f"**Effectiveness**: *no OCR runs recorded yet for this "
                f"alliance. Stats appear here after a few hunts.*\n"
                f"{theme.lowerDivider}"
            )

        configured = {primary, *fallbacks}
        primary_stats = sorted(
            (s for s in stats if s['role'] == 'primary'),
            key=lambda s: -s['runs'],
        )
        fallback_stats = sorted(
            (s for s in stats if s['role'] == 'fallback'),
            key=lambda s: -s['runs'],
        )

        def _fmt_row(s, is_fallback: bool) -> str:
            runs = s['runs']
            filled = s['rows_filled']
            in_use = s['lang'] in configured
            if is_fallback and in_use and runs >= 5 and filled == 0:
                marker = theme.warnIcon
            elif filled > 0:
                marker = theme.verifiedIcon
            else:
                marker = "  "  # two-space pad keeps columns aligned
            last_used = _format_last_used(s.get('last_run_at'))
            return (
                f"{marker} `{s['lang']:<11}` "
                f"runs `{runs:>3}` · filled `{filled:>3}` · "
                f"last used {last_used}"
            )

        lines = [f"\n{theme.upperDivider}"]
        if primary_stats:
            lines.append("**Primary engines** *(run on every screenshot)*")
            for s in primary_stats:
                lines.append(_fmt_row(s, is_fallback=False))
        if fallback_stats:
            if primary_stats:
                lines.append("")  # visual separator
            lines.append("**Fallback engines**")
            for s in fallback_stats:
                lines.append(_fmt_row(s, is_fallback=True))
            stale = [s for s in fallback_stats
                     if s['lang'] in configured
                     and s['runs'] >= 5 and s['rows_filled'] == 0]
            # Only actionable in manual mode — auto-manage already drops langs no
            # member uses.
            if stale and not self.cog.get_ocr_auto_manage(self.alliance_id):
                names = ", ".join(f"`{s['lang']}`" for s in stale)
                lines.append(
                    f"\n{theme.warnIcon} *Consider removing: {names} — "
                    f"5+ runs without filling a row.*"
                )

        # Engines configured but not yet recorded (fresh install / new fallback).
        recorded_keys = {(s['lang'], s['role']) for s in stats}
        pending = []
        if (primary, 'primary') not in recorded_keys:
            pending.append(primary)
        for fb in fallbacks:
            if (fb, 'fallback') not in recorded_keys and fb != primary:
                pending.append(fb)
        if pending:
            labels = ", ".join(f"`{c}`" for c in pending)
            lines.append(f"\n*(configured but no runs yet: {labels})*")

        lines.append(theme.lowerDivider)
        return "\n".join(lines)

    async def _on_primary_change(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        new_primary = interaction.data['values'][0]
        try:
            self.cog.set_ocr_language_settings(self.alliance_id, primary=new_primary)
        except ValueError as e:
            await interaction.response.send_message(
                f"{theme.deniedIcon} {e}", ephemeral=True
            )
            return
        self._build()
        await interaction.response.edit_message(embed=self._build_embed(), view=self)

    async def _on_fallbacks_change(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        selected = list(interaction.data.get('values') or [])
        self.cog.set_ocr_language_settings(self.alliance_id, fallbacks=selected)
        self._build()
        await interaction.response.edit_message(embed=self._build_embed(), view=self)

    async def _on_auto_manage_toggle(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        new_value = not self.cog.get_ocr_auto_manage(self.alliance_id)
        self.cog.set_ocr_auto_manage(self.alliance_id, new_value)
        self._build()
        await interaction.response.edit_message(embed=self._build_embed(), view=self)

    async def _on_back(self, interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        self.parent._build_components()
        await interaction.response.edit_message(
            embed=self.parent._build_embed(), view=self.parent,
        )


# ---------------------------------------------------------------------------
# Supporting views and modals
# ---------------------------------------------------------------------------

class DateRangeModal(discord.ui.Modal, title="Select Date Range"):
    from_date = discord.ui.TextInput(
        label="From Date (YYYY-MM-DD)", required=False, placeholder="2026-01-01"
    )
    to_date = discord.ui.TextInput(
        label="To Date (YYYY-MM-DD)", required=False, placeholder="2026-01-31"
    )

    def __init__(self, parent_view: VaultDamageView):
        super().__init__()
        self.parent_view = parent_view
        if self.parent_view.from_date:
            self.from_date.default = self.parent_view.from_date.strftime("%Y-%m-%d")
        if self.parent_view.to_date:
            self.to_date.default = self.parent_view.to_date.strftime("%Y-%m-%d")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            if self.from_date.value:
                self.parent_view.from_date = datetime.strptime(self.from_date.value, "%Y-%m-%d").date()
            if self.to_date.value:
                self.parent_view.to_date = datetime.strptime(self.to_date.value, "%Y-%m-%d").date()
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Invalid date format. Use YYYY-MM-DD.", ephemeral=True
            )
            return

        # User chose dates manually — drop the active preset so no button
        # is highlighted as 'current'.
        self.parent_view.preset = None
        await self.parent_view.try_redraw(interaction)


class VaultChannelSetupView(discord.ui.View):
    """Per-alliance vault setup: where to listen, what to listen for, and
    how to read the screenshots. Operational settings live in
    `VaultSettingsView`."""

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
        self.add_item(AllianceSelect(self, opts, action="manage"))

        has_alliance = self.alliance_id is not None

        channel_btn = discord.ui.Button(label="Change Channel", style=discord.ButtonStyle.primary, emoji=theme.announceIcon, row=2, disabled=not has_alliance)
        channel_btn.callback = self._change_channel_callback
        self.add_item(channel_btn)

        ocr_btn = discord.ui.Button(label="Character Recognition", style=discord.ButtonStyle.primary, emoji=theme.globeIcon, row=2, disabled=not has_alliance)
        ocr_btn.callback = self._ocr_languages_callback
        self.add_item(ocr_btn)

        keywords_btn = discord.ui.Button(label="Keywords", style=discord.ButtonStyle.primary, emoji=theme.editListIcon, row=2, disabled=not has_alliance)
        keywords_btn.callback = self._manage_keywords_callback
        self.add_item(keywords_btn)

        range_btn = discord.ui.Button(label="Damage Range", style=discord.ButtonStyle.primary, emoji=theme.chartIcon, row=2, disabled=not has_alliance)
        range_btn.callback = self._set_range_callback
        self.add_item(range_btn)

        back_btn = discord.ui.Button(label="Back", style=discord.ButtonStyle.secondary, emoji=theme.backIcon, row=3)
        back_btn.callback = self._back_callback
        self.add_item(back_btn)

    def _build_embed(self) -> discord.Embed:
        embed = discord.Embed(
            title=f"{theme.editListIcon} Vault Trap Channel Setup",
            description=(
                f"Per-alliance setup for screenshot collection: which "
                f"channel to watch, which messages to process, and how to "
                f"read them.\n\n"
                f"**Available Operations**\n"
                f"{theme.upperDivider}\n"
                f"{theme.announceIcon} **Change Channel**\n"
                f"└ Which channel the bot watches for Vault Trap screenshot uploads "
                f"(**required**)\n\n"
                f"{theme.globeIcon} **Character Recognition**\n"
                f"└ Pick the characters the bot should recognize in player "
                f"names; adjust based on what your names use\n\n"
                f"{theme.editListIcon} **Keywords**\n"
                f"└ Words required in the message text to trigger processing; "
                f"use this if folks upload other images in the same channel; "
                f"blank = accept all (default)\n\n"
                f"{theme.chartIcon} **Damage Range**\n"
                f"└ Default lookback for the auto-posted summary chart "
                f"after each hunt; `0` = full history (default)\n"
                f"{theme.lowerDivider}"
            ),
            color=theme.emColor1,
        )

        if self.alliance_id is not None:
            settings = self.cog.get_vault_settings(self.alliance_id)
            channel = (
                f"<#{settings['channel_id']}>" if settings.get('channel_id')
                else "**Not set** — required"
            )
            keywords = ", ".join(settings["keywords"]) if settings["keywords"] else "None"
            damage_range = settings["damage_range"]
            primary, fallbacks = self.cog.get_ocr_language_settings(self.alliance_id)
            primary_label = OCR_LANG_LABEL.get(primary, primary)
            fb_labels = [OCR_LANG_LABEL.get(c, c) for c in fallbacks]
            ocr_summary = primary_label + (
                f" · fallbacks: {', '.join(fb_labels)}" if fb_labels else ""
            )
            embed.add_field(
                name="Current Setup",
                value=(
                    f"{theme.upperDivider}\n"
                    f"**Channel:** {channel}\n"
                    f"**Keywords:** {keywords}\n"
                    f"**Damage Range:** {damage_range} day(s)"
                    f"{' (full history)' if damage_range == 0 else ''}\n"
                    f"**OCR:** {ocr_summary}\n"
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
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        view = VaultChannelSelectView(
            cog=self.cog, alliance_id=self.alliance_id,
            parent_view=self, parent_message=interaction.message,
        )
        await interaction.response.send_message(
            "Select the vault score channel for this alliance:",
            view=view, ephemeral=True,
        )

    async def _manage_keywords_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        current_keywords = ", ".join(settings["keywords"])
        await interaction.response.send_modal(
            KeywordsModal(current_keywords, self.cog, self.alliance_id, self)
        )

    async def _set_range_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        settings = self.cog.get_vault_settings(self.alliance_id)
        await interaction.response.send_modal(
            DamageRangeModal(self.cog, self.alliance_id, settings["damage_range"], self)
        )

    async def _ocr_languages_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        allowed = await self.cog.check_vault_permission(interaction, self.alliance_id, "manage")
        if not allowed:
            return
        view = VaultOcrLanguagesView(self.cog, self.alliance_id, self.original_user_id, self)
        await interaction.response.edit_message(embed=view._build_embed(), view=view)

    async def _back_callback(self, interaction: discord.Interaction):
        if not await check_interaction_user(interaction, self.original_user_id):
            return
        await self.cog.show_vault_track_menu(interaction)


class VaultChannelSelectView(discord.ui.View):
    def __init__(self, cog, alliance_id: int, parent_view, parent_message: discord.Message = None):
        super().__init__(timeout=180)
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view
        self.parent_message = parent_message
        self.add_item(VaultChannelSelect(self))


class VaultChannelSelect(discord.ui.ChannelSelect):
    def __init__(self, parent_view: VaultChannelSelectView):
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
            # alliance for Vault Trap Tracking or Screenshot Upload.
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

            self.parent_view.cog.update_vault_setting(
                self.parent_view.alliance_id,
                "vault_score_channel",
                channel_id
            )

            # Post/refresh the "what to upload" info message in the new channel.
            try:
                await self.parent_view.cog.refresh_vault_info_message(self.parent_view.alliance_id)
            except Exception as e:
                logger.warning(f"Could not refresh vault info message: {e}")

            await interaction.response.edit_message(
                content=f"{theme.verifiedIcon} Vault Trap score channel set to {selected_channel.mention}",
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
            logger.error(f"VaultChannelSelect callback error: {e}")
            print(f"[ERROR] VaultChannelSelect callback error: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save channel.", ephemeral=True
            )


class KeywordsModal(discord.ui.Modal):
    def __init__(self, current_keywords: str, cog, alliance_id: int,
                 parent_view):
        super().__init__(title="Manage Vault Trap Keywords")
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view

        self.keywords_input = discord.ui.TextInput(
            label="Required words in the typed message text",
            style=discord.TextStyle.paragraph,
            default=current_keywords or "",
            placeholder="comma-separated, e.g. vault, damage. Blank = accept any upload.",
            required=False,
            max_length=400
        )
        self.add_item(self.keywords_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            keywords = self.keywords_input.value.strip()
            keyword_csv = ", ".join([kw.strip() for kw in keywords.split(",") if kw.strip()]) if keywords else None

            self.cog.update_vault_setting(self.alliance_id, "vault_keywords", keyword_csv)

            embed = self.parent_view._build_embed()
            embed.description += f"\n{theme.verifiedIcon} Keywords updated."
            await safe_edit_message(interaction, embed=embed, view=self.parent_view, content=None)

        except Exception as e:
            logger.error(f"KeywordsModal error: {e}")
            print(f"[ERROR] KeywordsModal error: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to update keywords.", ephemeral=True
            )


class DamageRangeModal(discord.ui.Modal):
    def __init__(self, cog, alliance_id: int, current_range: int,
                 parent_view):
        super().__init__(title="Set Damage History Range")
        self.cog = cog
        self.alliance_id = alliance_id
        self.parent_view = parent_view

        self.range_input = discord.ui.TextInput(
            label="Number of days (0 = full history)",
            placeholder="Enter number of days",
            default=str(current_range),
            required=True,
            max_length=5
        )
        self.add_item(self.range_input)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            days = int(self.range_input.value.strip())
            if days < 0:
                raise ValueError
        except ValueError:
            await interaction.response.send_message(
                f"{theme.deniedIcon} Please enter a non-negative whole number.", ephemeral=True
            )
            return

        try:
            self.cog.update_vault_setting(self.alliance_id, "vault_damage_range", days)
        except Exception as e:
            logger.error(f"Failed to update damage range: {e}")
            print(f"[ERROR] Failed to update damage range: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save damage range.", ephemeral=True
            )
            return

        embed = self.parent_view._build_embed()
        embed.description += f"\n{theme.verifiedIcon} Damage range set to {days} days."
        await safe_edit_message(interaction, embed=embed, view=self.parent_view, content=None)


class SessionTimeoutModal(discord.ui.Modal):
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
            self.cog.update_vault_setting(self.alliance_id, "vault_session_timeout_min", minutes)
        except Exception as e:
            logger.error(f"Failed to update session timeout: {e}")
            print(f"[ERROR] Failed to update session timeout: {e}")
            await interaction.response.send_message(
                f"{theme.deniedIcon} Failed to save session timeout.", ephemeral=True
            )
            return

        embed = self.parent_view._build_embed()
        embed.description += f"\n{theme.verifiedIcon} Session timeout set to {minutes} min."
        await safe_edit_message(interaction, embed=embed, view=self.parent_view, content=None)


# ---------------------------------------------------------------------------
# DataSubmit — handles data insertion and view generation
# ---------------------------------------------------------------------------

class DataSubmit:
    def __init__(self, alliance_conn, vault_conn):
        self.alliance_conn = alliance_conn
        self.alliance_cursor = alliance_conn.cursor()
        self.vault_conn = vault_conn
        self.vault_cursor = vault_conn.cursor()

    def _load_existing_hunt(self, alliance_id, date, trap_number):
        """Return (hunt_id, rows) for a prior submission of this trap+date, else (None, [])."""
        if trap_number is None:
            return None, []
        if isinstance(date, datetime):
            date = date.strftime("%Y-%m-%d")
        self.vault_cursor.execute(
            "SELECT id FROM vault_hunts WHERE alliance_id=? AND date=? AND trap_number=?",
            (alliance_id, date, int(trap_number)),
        )
        row = self.vault_cursor.fetchone()
        if not row:
            return None, []
        self.vault_cursor.execute(
            "SELECT raw_name, resolved_nickname, damage, rank "
            "FROM vault_player_damage WHERE hunt_id=?",
            (row[0],),
        )
        rows = [{'name': r[0] or r[1] or '', 'damage': r[2], 'rank': r[3]}
                for r in self.vault_cursor.fetchall()]
        return row[0], rows

    async def process_full_submission(self, interaction, *, hunt_meta, player_rows,
                                      alliance_id=None, alliance_name=None,
                                      existing_hunt_id=None):
        """Persist a reviewed vault hunt: hunt summary + every player row.
        Rows with `fid is None` are saved with NULL fid so the raw OCR'd
        name and damage are preserved for later resolution from the
        records UI. Returns True once the hunt is persisted."""
        return await self._persist_hunt_and_render(
            interaction,
            date=hunt_meta['date'],
            trap_number=hunt_meta['trap_number'],
            rallies=hunt_meta.get('rallies'),
            total_damage=hunt_meta.get('total_damage') or 0,
            event_time=hunt_meta.get('event_time'),
            player_rows=player_rows,
            alliance_id=alliance_id, alliance_name=alliance_name,
            existing_hunt_id=existing_hunt_id,
        )

    async def _persist_hunt_and_render(self, interaction, *, date, trap_number, rallies,
                                       total_damage, event_time=None, player_rows=None,
                                       alliance_id=None, alliance_name=None,
                                       existing_hunt_id=None):
        """Insert one hunt row (and any provided player rows), then build
        and send the standard per-trap chart embed."""
        if not interaction.response.is_done():
            await interaction.response.defer()

        # Resolve alliance from channel when not passed in.
        if alliance_id is None:
            self.alliance_cursor.execute(
                "SELECT alliance_id FROM alliancesettings WHERE vault_score_channel = ?",
                (interaction.channel.id,),
            )
            row = self.alliance_cursor.fetchone()
            if not row:
                await interaction.followup.send(
                    f"{theme.deniedIcon} This channel is not configured as a vault score channel.",
                    ephemeral=True,
                )
                return False
            alliance_id = int(row[0])
        if alliance_name is None:
            self.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?", (alliance_id,)
            )
            arow = self.alliance_cursor.fetchone()
            alliance_name = arow[0] if arow else f"Alliance ID: {alliance_id}"

        if isinstance(date, datetime):
            date = date.strftime("%Y-%m-%d")
        trap_number = int(trap_number)
        rallies = int(rallies) if rallies is not None else None
        total_damage = int(total_damage)

        # Single transaction so a mid-loop failure rolls the hunt back instead of leaving it orphaned.
        matched = unmatched = 0
        edited = False
        try:
            if existing_hunt_id is not None:
                # Re-resolve by the current header (date/trap may have changed in review).
                self.vault_cursor.execute(
                    "SELECT id FROM vault_hunts WHERE alliance_id=? AND date=? AND trap_number=?",
                    (alliance_id, date, trap_number),
                )
                existing = self.vault_cursor.fetchone()
                if existing:
                    # Edit in place: keep the hunt record, refresh summary + rows.
                    hunt_id = existing[0]
                    self.vault_cursor.execute(
                        "UPDATE vault_hunts SET rallies=?, total_damage=?, event_time=? WHERE id=?",
                        (rallies, total_damage, event_time, hunt_id),
                    )
                    self.vault_cursor.execute(
                        "DELETE FROM vault_player_damage WHERE hunt_id=?", (hunt_id,)
                    )
                    edited = True
            if not edited:
                try:
                    self.vault_cursor.execute(
                        "INSERT INTO vault_hunts (alliance_id, date, trap_number, rallies, total_damage, event_time) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (alliance_id, date, trap_number, rallies, total_damage, event_time),
                    )
                    hunt_id = self.vault_cursor.lastrowid
                except sqlite3.IntegrityError:
                    self.vault_conn.rollback()
                    await interaction.followup.send(
                        f"{theme.warnIcon} This alliance already submitted this trap for that date.",
                        ephemeral=True,
                    )
                    return False

            learned: list[tuple] = []  # (name, fid) — learned AFTER commit
            if player_rows:
                for r in player_rows:
                    fid = r.get('fid')
                    # The assigned fid's own score, not the top candidate's —
                    # they differ when greedy picks a non-top match for dupes.
                    score = r.get('match_score')
                    if score is None and r.get('candidates'):
                        score = r['candidates'][0][2]
                    self.vault_cursor.execute(
                        "INSERT INTO vault_player_damage "
                        "(hunt_id, fid, raw_name, resolved_nickname, damage, rank, match_score) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (hunt_id, fid, r.get('name'), r.get('nickname'),
                         int(r['damage']), r.get('rank'), score),
                    )
                    if fid:
                        matched += 1
                        if r.get('name'):
                            learned.append((r['name'], fid))
                    else:
                        unmatched += 1
            self.vault_conn.commit()
        except Exception:
            self.vault_conn.rollback()
            raise

        # Audit trail: post to the alliance's configured Activity Log
        # channel (same channel/setting alliance_member_operations.py's
        # member-roster actions already use — see /settings -> alliance ->
        # Set Log Channel) so admins can see who submitted what without
        # digging through log/bot.txt on disk. Only fires for an actually
        # persisted submission (past the commit above), not every
        # screenshot upload or cancelled session -- _post_alliance_log is
        # itself a no-op if no log channel is configured, and swallows its
        # own errors, so this can never fail the submission it's logging.
        log_desc = (
            f"**Alliance:** {alliance_name}\n"
            f"**Submitted by:** {interaction.user.mention} (`{interaction.user.id}`)\n"
            f"**Date:** {date} · **Trap:** {trap_number}\n"
            f"**Players:** {matched} matched"
        )
        if unmatched:
            log_desc += f", {unmatched} unmatched"
        if edited:
            log_desc += "\n*(updated an existing submission)*"
        await _post_alliance_log(
            interaction.client, alliance_id,
            discord.Embed(
                title=f"{theme.vaultTrapIcon} Vault Trap Submitted",
                description=log_desc,
                color=theme.emColor2,
            ),
        )

        # Learn aliases only AFTER the hunt is committed.
        for name, fid in learned:
            try:
                learn_alias(alliance_id, name, fid)
            except Exception as e:
                logger.warning(f"Vault Trap OCR: post-commit learn_alias failed for {name!r}: {e}")

        # Mirror the saved hunt into an attendance event. Best-effort: a sync
        # failure must never roll back the saved hunt.
        if player_rows is not None:
            try:
                from .attendance_ocr_parsers import sync_vault_attendance_event
                sync_vault_attendance_event(
                    alliance_id=alliance_id, hunt_id=hunt_id, date=date,
                    trap_number=trap_number, event_time=event_time,
                    alliance_name=alliance_name,
                    participants=_vault_participants(player_rows),
                )
            except Exception as e:
                logger.error(f"Vault Trap attendance sync failed for hunt {hunt_id}: {e}")
                print(f"[ERROR] Vault Trap attendance sync failed for hunt {hunt_id}: {e}")

        title_suffix = "Updated Submission" if edited else "Latest Submission"
        if player_rows:
            title_suffix += f" · {matched} player(s)"
            if unmatched:
                title_suffix += f" · {unmatched} unmatched"

        # Pull damage-range setting + per-trap history for the chart.
        self.alliance_cursor.execute(
            "SELECT vault_damage_range FROM alliancesettings WHERE alliance_id = ?",
            (alliance_id,),
        )
        range_row = self.alliance_cursor.fetchone()
        damage_range_days = range_row[0] if range_row and range_row[0] else 0

        self.vault_cursor.execute(
            "SELECT date, rallies, total_damage FROM vault_hunts "
            "WHERE alliance_id = ? AND trap_number = ? ORDER BY date ASC",
            (alliance_id, trap_number),
        )
        rows = self.vault_cursor.fetchall()
        if damage_range_days > 0:
            today = datetime.now(timezone.utc).date()
            range_start = today - timedelta(days=damage_range_days)
            filtered_rows = [
                r for r in rows
                if datetime.strptime(r[0], "%Y-%m-%d").date() >= range_start
            ] or rows
        else:
            filtered_rows = rows

        dates = [datetime.strptime(r[0], "%Y-%m-%d") for r in filtered_rows]
        rallies_list = [int(r[1]) if r[1] else 0 for r in filtered_rows]
        total_damages = [int(r[2]) if r[2] else 0 for r in filtered_rows]

        try:
            embed, image_file = vault_data_embed(
                alliance_id=alliance_id, alliance_name=alliance_name,
                trap_number=trap_number, dates=dates,
                rallies_list=rallies_list, total_damages=total_damages,
                title_suffix=title_suffix,
                damage_range_days=damage_range_days,
            )
        except Exception as e:
            logger.error(f"Failed to generate submission embed: {e}")
            print(f"[ERROR] Failed to generate submission embed: {e}")
            saved_total = matched + unmatched
            msg = (f"{theme.deniedIcon} Data saved ({saved_total} player rows) but chart generation failed."
                   if saved_total else f"{theme.deniedIcon} Error generating graph.")
            await interaction.followup.send(msg, ephemeral=True)
            return True  # hunt persisted; resolved even if the chart failed

        if unmatched:
            embed.set_footer(
                text=f"{matched} matched · {unmatched} saved as unmatched. "
                     f"Resolve from Vault Trap Damage Records when ready."
            )

        # Build the per-player breakdown alongside the chart so both ride in a
        # single message (two embeds + the chart attachment). Previously this
        # posted as a separate follow-up, which split the submission across two
        # messages and made the chart-vs-breakdown relationship harder to read.
        breakdown_embed = None
        if matched:
            try:
                players, prev_id = _compute_player_deltas(
                    self.vault_cursor, alliance_id=alliance_id, hunt_id=hunt_id,
                    trap_number=trap_number, date=date,
                )
                if players:
                    breakdown_embed = _build_player_breakdown_embed(
                        alliance_name=alliance_name, trap_number=trap_number,
                        players=players, has_baseline=prev_id is not None,
                    )
            except Exception as e:
                logger.error(f"Failed to build player breakdown: {e}")
                print(f"[ERROR] Failed to build player breakdown: {e}")
        embeds = [embed] + ([breakdown_embed] if breakdown_embed else [])

        try:
            await interaction.edit_original_response(
                embeds=embeds,
                attachments=[image_file] if image_file else [], view=None,
            )
        except discord.NotFound:
            # Original response unavailable (e.g. OCR flow used channel.send).
            try:
                if image_file:
                    await interaction.followup.send(embeds=embeds, file=image_file)
                else:
                    await interaction.followup.send(embeds=embeds)
            except Exception as e:
                logger.error(f"Failed to send submission result: {e}")
                print(f"[ERROR] Failed to send submission result: {e}")
        except Exception as e:
            logger.error(f"Failed to edit submission message: {e}")
            print(f"[ERROR] Failed to edit submission message: {e}")
        return True

    async def process_view(self, *, alliance_id: int, trap_number,
                           from_date: str | None = None, to_date: str | None = None,
                           alliance_name: str | None = None):
        """Generate a view embed and chart. `trap_number` is 1, 2, or 'both'."""
        if alliance_name is None:
            self.alliance_cursor.execute(
                "SELECT name FROM alliance_list WHERE alliance_id = ?",
                (alliance_id,)
            )
            row = self.alliance_cursor.fetchone()
            alliance_name = row[0] if row else f"Alliance ID: {alliance_id}"

        if trap_number == 'both':
            return await self._process_view_combined(
                alliance_id=alliance_id, alliance_name=alliance_name,
                from_date=from_date, to_date=to_date,
            )

        self.vault_cursor.execute(
            "SELECT date, rallies, total_damage FROM vault_hunts "
            "WHERE alliance_id = ? AND trap_number = ? ORDER BY date ASC",
            (alliance_id, trap_number)
        )
        rows = self.vault_cursor.fetchall()

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
        rallies_list = [int(r[1]) if r[1] else 0 for r in filtered_rows]
        total_damages = [int(r[2]) if r[2] else 0 for r in filtered_rows]

        try:
            embed, file = await asyncio.to_thread(
                vault_data_embed,
                alliance_id=alliance_id,
                alliance_name=alliance_name,
                trap_number=trap_number,
                dates=dates,
                rallies_list=rallies_list,
                total_damages=total_damages,
                title_suffix="View Damage",
                damage_range_days=None
            )
        except Exception as e:
            logger.error(f"vault_data_embed failed: {e}")
            print(f"[ERROR] vault_data_embed failed: {e}")
            return None, None

        return embed, file

    async def _process_view_combined(self, *, alliance_id, alliance_name,
                                     from_date, to_date):
        """Both-traps render: pull each trap's series, drop empty ones,
        defer to combined embed builder."""
        try:
            from_dt = datetime.strptime(from_date, "%Y-%m-%d").date() if from_date else None
            to_dt = datetime.strptime(to_date, "%Y-%m-%d").date() if to_date else None
        except ValueError:
            return None, None
        if from_dt and to_dt and from_dt > to_dt:
            return None, None

        trap_series = []
        for trap in (1, 2):
            self.vault_cursor.execute(
                "SELECT date, rallies, total_damage FROM vault_hunts "
                "WHERE alliance_id = ? AND trap_number = ? ORDER BY date ASC",
                (alliance_id, trap),
            )
            rows = self.vault_cursor.fetchall()
            if not rows:
                continue
            filtered = [
                r for r in rows
                if (not from_dt or datetime.strptime(r[0], "%Y-%m-%d").date() >= from_dt)
                and (not to_dt or datetime.strptime(r[0], "%Y-%m-%d").date() <= to_dt)
            ]
            if not filtered:
                continue
            trap_series.append((
                trap,
                [datetime.strptime(r[0], "%Y-%m-%d") for r in filtered],
                [int(r[1]) if r[1] else 0 for r in filtered],
                [int(r[2]) if r[2] else 0 for r in filtered],
            ))

        if not trap_series:
            return None, None

        try:
            embed, file = await asyncio.to_thread(
                vault_data_embed_combined,
                alliance_id=alliance_id,
                alliance_name=alliance_name,
                trap_series=trap_series,
                title_suffix="View Damage",
            )
        except Exception as e:
            logger.error(f"vault_data_embed_combined failed: {e}")
            print(f"[ERROR] vault_data_embed_combined failed: {e}")
            return None, None
        return embed, file


# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

async def setup(bot):
    # Route recovery-button clicks after a restart (messages from a prior process).
    try:
        bot.add_dynamic_items(VaultSessionButton)
    except Exception as e:
        logger.warning(f"Vault Trap session: could not register dynamic buttons: {e}")
    await bot.add_cog(VaultTrack(bot))
