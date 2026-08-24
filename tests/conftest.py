"""pytest bootstrap for the in-repo test suite.

Ensures the repo root (so `import cogs.*` resolves) and this tests dir (so
`from harness import ...` resolves) are importable no matter where pytest is
invoked from. Also skips suites whose target cog isn't present in the current
checkout, so the run never hard-errors on a version that lacks a feature.
"""
import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
for _p in (str(_REPO), str(_HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# main.py's top-level script guard treats a bare `import main` outside an
# active venv as "user double-clicked main.py", and either re-execs a venv
# setup (non-Windows) or sys.exit(0)s with setup instructions (Windows) —
# fine for real users, fatal for pytest collection (SystemExit during
# collection aborts the *entire* run, not just the one test file). pytest
# is itself a non-interactive/automated invocation, so treat it like CI:
# main.py's should_skip_venv() already treats CI-flavored env vars as "skip
# the interactive venv dance". Only set it if the caller hasn't opted into
# some other CI signal already.
os.environ.setdefault("CI", "1")

# Skip suites whose target module isn't in this checkout (e.g. the attendance
# OCR parsers may live on a different branch/version). Keeps `pytest tests`
# green here while the suites auto-run wherever the feature exists.
collect_ignore = []
_REQUIRES = {
    "test_attendance_ocr_layer1.py": "cogs/attendance_ocr_parsers.py",
    "test_attendance_ocr_layer2.py": "cogs/attendance_ocr_parsers.py",
    "test_attendance_ocr_alias.py": "cogs/attendance_ocr_parsers.py",
    "test_attendance_ocr_fallback.py": "cogs/attendance_ocr_parsers.py",
    "test_attendance_history.py": "cogs/attendance_history.py",
    "test_layer1_parser.py": "cogs/vault_track.py",
    "test_layer2_ocr.py": "cogs/vault_track.py",
    "test_vault_name_matching.py": "cogs/vault_track.py",
    "test_vault_persist_no_deadlock.py": "cogs/vault_track.py",
    "test_ocr_auto_manage.py": "cogs/vault_track.py",
}
for _test_file, _needed in _REQUIRES.items():
    if not (_REPO / _needed).exists():
        collect_ignore.append(_test_file)
