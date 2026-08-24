"""State resolver: local kid (server) bookkeeping.

Police Chief has no redemption API to probe for a player's true state, so the
old probe-based discovery (classify_probe/_candidate_kids/_window_kids/
resolve_state/_reference_center/_make_session/_probe) is gone entirely. What's
left is plain local bookkeeping: majority-vote alliance binding, per-member
state storage/backfill, mismatch flags, and a `verify_add_state` that can no
longer confirm anything and always reports unverified.
"""
import asyncio
import logging
import sqlite3
import types

import cogs.gift_state_resolver as res


def _cog():
    return types.SimpleNamespace(logger=logging.getLogger("test"))


# --- add-time verification (verify_add_state) -------------------------------------
# No probe API exists anymore, so this can only ever fall back to the
# alliance's known home state, unverified.

def test_verify_add_state_returns_bound_alliance_kid_unverified(monkeypatch):
    monkeypatch.setattr(res, "get_alliance_kid", lambda aid: 700)
    assert asyncio.run(res.verify_add_state(_cog(), 111, 5)) == (700, False)


def test_verify_add_state_unbound_alliance_returns_none(monkeypatch):
    monkeypatch.setattr(res, "get_alliance_kid", lambda aid: None)
    assert asyncio.run(res.verify_add_state(_cog(), 111, 5)) == (None, False)


# --- alliance binding + backfill --------------------------------------------------

def _two_dbs(monkeypatch, users_rows, alliance_rows):
    """In-memory users.sqlite + alliance.sqlite. sqlite3's context manager commits but
    does NOT close, so the same in-memory conn survives repeated `with connect(...)`."""
    users = sqlite3.connect(":memory:")
    users.execute("CREATE TABLE users (fid INTEGER, alliance TEXT, kid INTEGER, state_mismatch_at TEXT)")
    users.executemany("INSERT INTO users (fid, alliance, kid) VALUES (?, ?, ?)", users_rows)
    users.commit()
    alliance = sqlite3.connect(":memory:")
    alliance.execute("CREATE TABLE alliance_list (alliance_id INTEGER, name TEXT, kid INTEGER, multistate INTEGER DEFAULT 0, state_locked INTEGER DEFAULT 0)")
    alliance.executemany("INSERT INTO alliance_list (alliance_id, name, kid) VALUES (?, ?, ?)", alliance_rows)
    alliance.commit()
    real = sqlite3.connect

    def fake_connect(path, *a, **k):
        if str(path).endswith("users.sqlite"):
            return users
        if str(path).endswith("alliance.sqlite"):
            return alliance
        return real(path, *a, **k)

    monkeypatch.setattr(res.sqlite3, "connect", fake_connect)
    return users, alliance


def test_compute_binding_clear_majority(monkeypatch):
    _two_dbs(monkeypatch, [(1, '5', 245), (2, '5', 245), (3, '5', 245), (4, '5', 312)], [])
    kid, share, known = res.compute_alliance_binding(5)
    assert kid == 245 and known == 4 and share == 0.75


def test_compute_binding_no_winner(monkeypatch):
    _two_dbs(monkeypatch, [(1, '6', 1), (2, '6', 2), (3, '6', 3), (4, '6', 4)], [])
    assert res.compute_alliance_binding(6) is None


def test_compute_binding_unanimous_small(monkeypatch):
    _two_dbs(monkeypatch, [(1, '7', 9), (2, '7', 9)], [])   # 2 members, both kid 9
    assert res.compute_alliance_binding(7) == (9, 1.0, 2)


def test_compute_binding_no_known_kids(monkeypatch):
    _two_dbs(monkeypatch, [(1, '8', None), (2, '8', None)], [])
    assert res.compute_alliance_binding(8) is None


def test_bind_all_only_unbound(monkeypatch):
    _two_dbs(monkeypatch,
             [(1, '5', 245), (2, '5', 245), (3, '5', 245)],
             [(5, 'A', None), (6, 'B', 999)])   # 5 unbound, 6 already bound
    applied = res.bind_all_alliances()
    assert [r["alliance_id"] for r in applied] == [5]
    assert res.get_alliance_kid(5) == 245
    assert res.get_alliance_kid(6) == 999   # left alone


def test_assign_alliance_kid_updates_db(monkeypatch):
    users, _ = _two_dbs(monkeypatch,
                        [(1, '5', None), (2, '5', None), (3, '6', None)],
                        [(5, 'A', 700), (6, 'B', None)])
    assert res.assign_alliance_kid_to_missing() == [1, 2]   # returns the fids it stated
    kids = dict(users.execute("SELECT fid, kid FROM users").fetchall())
    assert kids == {1: 700, 2: 700, 3: None}   # alliance 6 unbound -> stays NULL


def test_set_user_kid(monkeypatch):
    users, _ = _two_dbs(monkeypatch, [(1, '5', None)], [])
    res.set_user_kid(1, 312)
    assert users.execute("SELECT kid FROM users WHERE fid=1").fetchone()[0] == 312


def test_fids_missing_state(monkeypatch):
    _two_dbs(monkeypatch, [(1, '5', None), (2, '5', 245), (3, '', None), (4, None, None)], [])
    assert res.fids_missing_state() == [1]


# --- multistate flag (public/mixed alliances that must never bind to one state) ----

def test_state_lock_is_separate_from_home_state(monkeypatch):
    _, alliance = _two_dbs(monkeypatch, [], [(5, 'A', 700)])
    assert res.is_state_locked(5) is False          # kid set, but not locked
    res.set_state_locked(5, True)
    assert res.is_state_locked(5) is True
    assert alliance.execute("SELECT kid FROM alliance_list WHERE alliance_id=5").fetchone()[0] == 700  # home state kept
    res.set_state_locked(5, False)
    assert res.is_state_locked(5) is False


def test_auto_bind_does_not_lock(monkeypatch):
    _two_dbs(monkeypatch,
             [(1, '5', 245), (2, '5', 245), (3, '5', 245)],
             [(5, 'A', None)])
    res.bind_all_alliances()
    assert res.get_alliance_kid(5) == 245           # home state set
    assert res.is_state_locked(5) is False          # but NOT locked


def test_set_and_read_multistate(monkeypatch):
    _, alliance = _two_dbs(monkeypatch, [], [(5, 'A', 700)])
    assert res.is_multistate(5) is False
    res.set_multistate(5, True)
    assert res.is_multistate(5) is True
    assert alliance.execute("SELECT kid FROM alliance_list WHERE alliance_id=5").fetchone()[0] is None  # bind cleared
    res.set_multistate(5, False)
    assert res.is_multistate(5) is False


def test_bind_all_skips_multistate(monkeypatch):
    users, alliance = _two_dbs(monkeypatch,
                               [(1, '5', 245), (2, '5', 245), (3, '5', 245)],
                               [(5, 'A', None)])
    alliance.execute("UPDATE alliance_list SET multistate = 1 WHERE alliance_id = 5")
    alliance.commit()
    applied = res.bind_all_alliances()
    assert applied == []                       # multistate alliance never bound
    assert res.get_alliance_kid(5) is None


def test_survey_reports_multistate(monkeypatch):
    _, alliance = _two_dbs(monkeypatch, [(1, '5', 245), (2, '5', 245)], [(5, 'A', None)])
    alliance.execute("UPDATE alliance_list SET multistate = 1 WHERE alliance_id = 5")
    alliance.commit()
    row = res.survey_alliance_bindings()[0]
    assert row["multistate"] is True and row["proposed_kid"] is None   # no bind proposed


def test_looks_multistate_true_when_split(monkeypatch):
    _two_dbs(monkeypatch, [(1,'5',1),(2,'5',1),(3,'5',1),(4,'5',2),(5,'5',2),(6,'5',2)], [])
    assert res.looks_multistate(5) is True    # 50/50, both states >= 2 members


def test_looks_multistate_false_with_majority(monkeypatch):
    _two_dbs(monkeypatch, [(1,'5',1),(2,'5',1),(3,'5',1),(4,'5',2)], [])
    assert res.looks_multistate(5) is False   # 75% majority -> binds instead


def test_looks_multistate_false_when_sparse(monkeypatch):
    _two_dbs(monkeypatch, [(1,'5',1),(2,'5',2),(3,'5',3)], [])
    assert res.looks_multistate(5) is False   # no state has >= 2 members (just noise)


def test_auto_flag_multistate(monkeypatch):
    _two_dbs(monkeypatch,
             [(1,'5',1),(2,'5',1),(3,'5',2),(4,'5',2),      # alliance 5: even split -> multistate
              (5,'6',9),(6,'6',9),(7,'6',9)],               # alliance 6: majority -> not flagged
             [(5,'Mixed',None),(6,'Single',None)])
    flagged = res.auto_flag_multistate()
    assert [r["alliance_id"] for r in flagged] == [5]
    assert res.is_multistate(5) is True and res.is_multistate(6) is False


def test_assign_skips_multistate_members(monkeypatch):
    users, alliance = _two_dbs(monkeypatch, [(1, '5', None), (2, '6', None)],
                               [(5, 'A', 700), (6, 'B', 800)])
    alliance.execute("UPDATE alliance_list SET multistate = 1, kid = NULL WHERE alliance_id = 6")
    alliance.commit()
    assert res.assign_alliance_kid_to_missing() == [1]   # only alliance 5's member
    kids = dict(users.execute("SELECT fid, kid FROM users").fetchall())
    assert kids == {1: 700, 2: None}
