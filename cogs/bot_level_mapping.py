"""Shared game-data constants used across cogs.

Single source of truth for the Chief's Office (Police Chief's HQ building)
level, so cogs reference one place instead of each duplicating it.

Police Chief's Chief's Office is a plain integer level, 1-45, with no known
sub-tier display format, so formatting is just "Lv. N". Function names/signatures keep
"furnace" naming so existing callers across cogs/ don't need to change.
"""

MAX_CHIEF_OFFICE_LEVEL = 45

# Kept as a dict (not a plain range) for backward compatibility with callers
# that do LEVEL_MAPPING.get(level, ...) or iterate it expecting name lookups.
LEVEL_MAPPING = {lv: f"Lv. {lv}" for lv in range(1, MAX_CHIEF_OFFICE_LEVEL + 1)}

MAX_STATE = 99999           # ~4 digits today; 5 leaves headroom without accepting junk


def format_furnace_level(raw) -> str:
    """Display string for a Chief's Office level, e.g. 12 -> 'Lv. 12'."""
    try:
        lv = int(raw)
    except (TypeError, ValueError):
        return str(raw)
    return LEVEL_MAPPING.get(lv, f"Lv. {lv}")


def parse_furnace_level(text):
    """Chief's Office level (1-45) from a plain number or a 'Lv. N' string, else None."""
    if text is None:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    if raw.isdigit():
        lv = int(raw)
        return lv if 0 <= lv <= MAX_CHIEF_OFFICE_LEVEL else None
    squashed = "".join(c for c in raw.upper() if c.isalnum())
    if squashed.startswith("LV"):
        digits = squashed[2:]
        if digits.isdigit() and int(digits) <= MAX_CHIEF_OFFICE_LEVEL:
            return int(digits)
    if squashed.startswith("LEVEL"):
        digits = squashed[len("LEVEL"):]
        if digits.isdigit() and int(digits) <= MAX_CHIEF_OFFICE_LEVEL:
            return int(digits)
    return None


def parse_state(text):
    """A typed state as an int in 1..MAX_STATE, or None."""
    raw = str(text).strip() if text is not None else ""
    return int(raw) if raw.isdigit() and 1 <= int(raw) <= MAX_STATE else None
