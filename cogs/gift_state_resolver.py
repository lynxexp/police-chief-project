"""Member "state" (kid = kingdom/server ID) bookkeeping.

Police Chief has no per-player gift-code redemption API, so `verify_add_state`
below cannot confirm anything and always returns unverified, falling
back to the alliance's known home state.

Everything else here is plain local bookkeeping (majority-vote alliance
binding, per-member state storage, mismatch flags) used across alliance
registration/member-management flows - not exclusive to gift codes - so it
stays.
"""
import asyncio
import sqlite3
from datetime import datetime


# --- Alliance -> state binding (majority vote over members' known kid) --------------

BIND_THRESHOLD = 0.6        # a state must hold this share of known-kid members to bind
BIND_MIN_KNOWN = 3          # and at least this many members must have a known kid


def _state_distribution(alliance_id):
    """[(kid, count), ...] most-common first, for members with a known kid."""
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        return conn.execute(
            "SELECT kid, COUNT(*) FROM users WHERE alliance = ? AND kid IS NOT NULL "
            "GROUP BY kid ORDER BY COUNT(*) DESC", (str(alliance_id),)).fetchall()


def compute_alliance_binding(alliance_id, *, threshold=BIND_THRESHOLD, min_known=BIND_MIN_KNOWN):
    """Majority state among an alliance's members with a known kid.
    Returns (kid, share, known_count), or None when too few knowns / no clear winner."""
    rows = _state_distribution(alliance_id)
    if not rows:
        return None
    known = sum(c for _, c in rows)
    top_kid, top_count = rows[0]
    share = top_count / known
    # A unanimous small alliance is still a confident bind even below min_known.
    if (known < min_known and share < 1.0) or share < threshold:
        return None
    return (top_kid, share, known)


def apply_alliance_binding(alliance_id, kid):
    """Write the alliance's bound state to alliance_list.kid."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        conn.execute("UPDATE alliance_list SET kid = ? WHERE alliance_id = ?", (kid, alliance_id))
        conn.commit()


def get_alliance_kid(alliance_id):
    """The alliance's currently-bound state, or None."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        row = conn.execute(
            "SELECT kid FROM alliance_list WHERE alliance_id = ?", (alliance_id,)).fetchone()
    return row[0] if row and row[0] is not None else None


def is_multistate(alliance_id):
    """True if the alliance is flagged multistate (members span many states - never bound)."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        row = conn.execute(
            "SELECT multistate FROM alliance_list WHERE alliance_id = ?", (alliance_id,)).fetchone()
    return bool(row and row[0])


def set_multistate(alliance_id, on):
    """Flag/unflag an alliance as multistate. Flagging clears any home state and lock."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        if on:
            conn.execute(
                "UPDATE alliance_list SET multistate = 1, kid = NULL, state_locked = 0 WHERE alliance_id = ?",
                (alliance_id,))
        else:
            conn.execute("UPDATE alliance_list SET multistate = 0 WHERE alliance_id = ?", (alliance_id,))
        conn.commit()


def is_state_locked(alliance_id):
    """True if the alliance is explicitly state-locked (rejects out-of-state adds)."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        row = conn.execute(
            "SELECT COALESCE(state_locked, 0) FROM alliance_list WHERE alliance_id = ?",
            (alliance_id,)).fetchone()
    return bool(row and row[0])


def set_state_locked(alliance_id, on):
    """Turn the deliberate state-lock on/off. Locking requires a home state already set."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        conn.execute("UPDATE alliance_list SET state_locked = ? WHERE alliance_id = ?",
                     (1 if on else 0, alliance_id))
        conn.commit()


def survey_alliance_bindings(*, threshold=BIND_THRESHOLD, min_known=BIND_MIN_KNOWN):
    """Per alliance: proposed binding + confidence, without writing anything.
    Returns [{alliance_id, name, current_kid, multistate, proposed_kid, share, known}]."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        alliances = conn.execute(
            "SELECT alliance_id, name, kid, COALESCE(multistate, 0), COALESCE(state_locked, 0) "
            "FROM alliance_list").fetchall()
    report = []
    for alliance_id, name, current_kid, multistate, state_locked in alliances:
        binding = None if multistate else compute_alliance_binding(
            alliance_id, threshold=threshold, min_known=min_known)
        report.append({
            "alliance_id": alliance_id, "name": name, "current_kid": current_kid,
            "multistate": bool(multistate), "state_locked": bool(state_locked),
            "proposed_kid": binding[0] if binding else None,
            "share": binding[1] if binding else None,
            "known": binding[2] if binding else 0,
        })
    return report


def bind_all_alliances(*, threshold=BIND_THRESHOLD, min_known=BIND_MIN_KNOWN, only_unbound=True):
    """Apply the majority-vote binding to every alliance with a confident winner.
    Skips multistate alliances. only_unbound=True skips already-bound ones. Returns applied list."""
    applied = []
    for row in survey_alliance_bindings(threshold=threshold, min_known=min_known):
        if row["multistate"] or row["proposed_kid"] is None:
            continue
        if only_unbound and row["current_kid"] is not None:
            continue
        apply_alliance_binding(row["alliance_id"], row["proposed_kid"])
        applied.append(row)
    return applied


MULTISTATE_MIN_STATES = 2       # genuine multi-state = at least this many states...
MULTISTATE_MIN_PER_STATE = 2    # ...each holding at least this many members


def looks_multistate(alliance_id, *, threshold=BIND_THRESHOLD,
                     min_states=MULTISTATE_MIN_STATES, min_per=MULTISTATE_MIN_PER_STATE):
    """True if the alliance genuinely spans states: no majority reaches `threshold` AND
    at least `min_states` states each hold `min_per`+ members. A few stray migrants in an
    otherwise single-state alliance do NOT trip this (that alliance still binds)."""
    dist = _state_distribution(alliance_id)
    if not dist:
        return False
    known = sum(c for _, c in dist)
    if dist[0][1] / known >= threshold:      # a clear majority -> bind, not multistate
        return False
    strong = [k for k, c in dist if c >= min_per]
    return len(strong) >= min_states


def auto_flag_multistate():
    """Flag currently-unbound alliances that genuinely span states (so they migrate to
    multistate instead of mis-binding). Existing members keep redeeming via their own kid.
    Returns the flagged rows."""
    flagged = []
    for row in survey_alliance_bindings():
        if row["multistate"] or row["current_kid"] is not None:
            continue
        if looks_multistate(row["alliance_id"]):
            set_multistate(row["alliance_id"], True)
            flagged.append(row)
    return flagged


# --- Member state backfill ----------------------------------------------------------

def set_user_kid(fid, kid, *, conn=None):
    """Set a member's state and clear any wrong-state flag.
    Pass `conn` to join the caller's transaction (not committed here)."""
    sql = "UPDATE users SET kid = ?, state_mismatch_at = NULL WHERE fid = ?"
    if conn is not None:
        conn.execute(sql, (kid, fid))
        return
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as own:
        own.execute(sql, (kid, fid))
        own.commit()


# --- Wrong-state flag (set when redemption gets a 40020 for a member) ----------------

def flag_state_mismatch(fid):
    """Mark that the state on file for `fid` was rejected by the game."""
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        conn.execute("UPDATE users SET state_mismatch_at = ? WHERE fid = ?",
                     (datetime.now().isoformat(timespec='seconds'), fid))
        conn.commit()


def clear_state_mismatch(fid):
    """Drop the wrong-state flag without touching the stored state."""
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        conn.execute("UPDATE users SET state_mismatch_at = NULL WHERE fid = ?", (fid,))
        conn.commit()


def fids_with_state_mismatch():
    """[(fid, nickname, kid, alliance, flagged_at), ...] for members the game rejected."""
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        return conn.execute(
            "SELECT fid, nickname, kid, alliance, state_mismatch_at FROM users "
            "WHERE state_mismatch_at IS NOT NULL ORDER BY state_mismatch_at DESC"
        ).fetchall()


def fids_missing_state():
    """Members with no state on file (redemption can't run for them)."""
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        return [r[0] for r in conn.execute(
            "SELECT fid FROM users WHERE kid IS NULL AND alliance IS NOT NULL AND alliance != ''"
        ).fetchall()]


def _alliance_bindings_by_str_id():
    """{str(alliance_id): kid} for every bound, non-multistate alliance."""
    with sqlite3.connect('db/alliance.sqlite', timeout=30.0) as conn:
        return {str(aid): kid for aid, kid in conn.execute(
            "SELECT alliance_id, kid FROM alliance_list "
            "WHERE kid IS NOT NULL AND COALESCE(multistate, 0) = 0").fetchall()}


def assign_alliance_kid_to_missing():
    """No-API backfill: stateless members inherit their alliance's state.
    Returns the fids updated - they were skipped by every redemption until now."""
    bindings = _alliance_bindings_by_str_id()
    if not bindings:
        return []
    with sqlite3.connect('db/users.sqlite', timeout=30.0) as conn:
        rows = conn.execute(
            "SELECT fid, alliance FROM users WHERE kid IS NULL AND alliance IS NOT NULL AND alliance != ''"
        ).fetchall()
        updated = []
        for fid, alliance in rows:
            kid = bindings.get(str(alliance))
            if kid is not None:
                set_user_kid(fid, kid, conn=conn)
                updated.append(fid)
        conn.commit()
    return updated


async def verify_add_state(cog, fid, alliance_id):
    """Best-effort state for a member not yet in `users`.

    Police Chief has no per-player gift-code API to probe, so nothing can be
    confirmed: this just falls back
    straight to the alliance's known home state (unverified) - the same value
    `assign_alliance_kid_to_missing` would eventually backfill anyway. `cog` and
    `fid` are accepted (and `fid` unused) purely to keep the existing call sites
    in alliance_registration.py / alliance_member_operations.py / etc unchanged.

    Returns (kid, verified) - verified is always False now.
    """
    alliance_kid = await asyncio.to_thread(get_alliance_kid, alliance_id)
    return alliance_kid, False
