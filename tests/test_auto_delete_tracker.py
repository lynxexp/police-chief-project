"""Regression tests for VaultAutoDeleteTracker / CapitolAutoDeleteTracker.

Both trackers used to only delete a session's source screenshots if the
review was actually Submitted (`any_submitted`) -- a Cancel or a timeout
left the screenshots in the channel indefinitely. Checking the real bot's
log/bot.txt showed this in practice: virtually every real Capitol War
session during manual testing ended in "skipped (no submissions)" (the
admin looked at the parsed rows without ever clicking Submit), so the
uploaded screenshots never got cleaned up even with auto-delete enabled --
defeating the whole point of the feature (the user didn't want screenshots
"lasting forever" in the channel). Fixed by deleting once the review is
fully resolved -- Submit, Cancel, OR timeout -- rather than gating on
whether anything was submitted.

Discord message deletion is stubbed with a plain async-`delete()` fake
object rather than pulling in a full discord.py mock -- the tracker only
ever calls `msg.delete()` and catches discord.NotFound/discord.Forbidden/
Exception around it, so that's all a fake needs to support. No
pytest-asyncio plugin is configured anywhere in this repo (every other
test here is synchronous), so async tracker methods are driven with a
bare `asyncio.run(...)` per test rather than adding that dependency."""
from __future__ import annotations

import asyncio

import discord

from harness import bt, ct


class FakeMessage:
    def __init__(self, mid=1, *, raise_exc=None):
        self.id = mid
        self.deleted = False
        self._raise_exc = raise_exc

    async def delete(self):
        if self._raise_exc is not None:
            raise self._raise_exc
        self.deleted = True


class _NotFoundStub(discord.NotFound):
    def __init__(self):  # bypass HTTPException's real ctor -- args unused here
        pass


class _ForbiddenStub(discord.Forbidden):
    def __init__(self):
        pass


# ---------------------------------------------------------------------------
# Both trackers are structurally identical; run every case against both.
# ---------------------------------------------------------------------------
TRACKERS = [
    ("VaultAutoDeleteTracker", bt.VaultAutoDeleteTracker),
    ("CapitolAutoDeleteTracker", ct.CapitolAutoDeleteTracker),
]


def test_deletes_on_cancel_with_no_submission():
    """The headline fix: a review that's Cancelled (or times out) without
    ever being Submitted must still delete its source screenshots, as long
    as auto-delete is enabled -- this used to be silently skipped."""
    for name, cls in TRACKERS:
        msg = FakeMessage()
        tracker = cls([msg], True)
        tracker.register()
        asyncio.run(tracker.on_cancel())
        assert msg.deleted, f"{name}: message should be deleted after a cancel-only session"


def test_deletes_on_submit():
    """Existing, already-working path: a submitted review still deletes
    its source screenshots."""
    for name, cls in TRACKERS:
        msg = FakeMessage()
        tracker = cls([msg], True)
        tracker.register()
        asyncio.run(tracker.on_submit())
        assert msg.deleted, f"{name}: message should be deleted after a submitted session"


def test_skips_entirely_when_disabled():
    """Auto-delete off in alliance settings -- no deletion attempted at
    all, submit or not."""
    for name, cls in TRACKERS:
        msg = FakeMessage()
        tracker = cls([msg], False)
        tracker.register()
        asyncio.run(tracker.on_submit())
        assert not msg.deleted, f"{name}: message must not be deleted when disabled"


def test_waits_for_all_pending_views_before_deleting():
    """If a session spawned more than one outstanding review view
    (`register()` called more than once), deletion must wait until every
    one of them has resolved -- not fire after just the first."""
    for name, cls in TRACKERS:
        msg = FakeMessage()
        tracker = cls([msg], True)
        tracker.register()
        tracker.register()
        asyncio.run(tracker.on_cancel())
        assert not msg.deleted, f"{name}: must not delete while a second view is still pending"
        asyncio.run(tracker.on_submit())
        assert msg.deleted, f"{name}: must delete once the last pending view resolves"


def test_not_found_and_forbidden_are_swallowed_without_crashing():
    """A message already deleted by someone else (NotFound) or the bot
    lacking Manage Messages (Forbidden) must not raise out of the
    tracker -- both are expected, logged-and-continue outcomes."""
    for name, cls in TRACKERS:
        gone = FakeMessage(1, raise_exc=_NotFoundStub())
        blocked = FakeMessage(2, raise_exc=_ForbiddenStub())
        ok = FakeMessage(3)
        tracker = cls([gone, blocked, ok], True)
        tracker.register()
        asyncio.run(tracker.on_submit())  # must not raise
        assert ok.deleted, f"{name}: the one deletable message should still be deleted"


def test_multiple_source_messages_all_deleted():
    """A multi-screenshot session (several source messages) deletes every
    one of them, not just the first."""
    for name, cls in TRACKERS:
        msgs = [FakeMessage(i) for i in range(4)]
        tracker = cls(msgs, True)
        tracker.register()
        asyncio.run(tracker.on_cancel())
        assert all(m.deleted for m in msgs), f"{name}: all source messages should be deleted"
