import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import handover  # noqa: E402
from handover import (  # noqa: E402
    STEP_REGISTERED, STEP_SAVE_DB, STEP_WAIT_SNAPSHOT, HandoverError,
    pick_predecessor, stale_runs, step_done, waiting_successor,
)


def run(run_id, status="in_progress"):
    return {"id": run_id, "status": status}


def jobs_with(name, status, conclusion=None):
    return [{"steps": [{"name": "Other", "status": "completed", "conclusion": "success"},
                       {"name": name, "status": status, "conclusion": conclusion}]}]


class FakeApi:
    """Plays back run and job states per call, and records cancellations."""

    def __init__(self, runs=None, run_states=None, job_states=None):
        self.runs = runs or []
        self.run_states = run_states or {}
        self.job_states = job_states or {}
        self.cancelled = []

    def active_runs(self, statuses=("in_progress", "queued")):
        return [r for r in self.runs if r["status"] in statuses]

    def run(self, run_id):
        states = self.run_states[run_id]
        return states.pop(0) if len(states) > 1 else states[0]

    def jobs(self, run_id):
        states = self.job_states.get(run_id, [[]])
        return states.pop(0) if len(states) > 1 else states[0]

    def cancel(self, run_id):
        self.cancelled.append(run_id)


class SelectionTest(unittest.TestCase):
    def test_predecessor_is_newest_older_in_progress_run(self):
        runs = [run(5), run(8), run(9, "queued"), run(12), run(20)]
        self.assertEqual(pick_predecessor(runs, 12), 8)
        self.assertIsNone(pick_predecessor([run(30)], 12))

    def test_stale_runs_are_older_runs_except_predecessor(self):
        runs = [run(5), run(8), run(9, "queued"), run(12), run(20)]
        self.assertEqual(stale_runs(runs, 12, 8), [5, 9])
        self.assertEqual(stale_runs([], 12, None), [])

    def test_waiting_successor_needs_the_wait_step_in_progress(self):
        runs = [run(10), run(11), run(12)]
        jobs = {
            11: jobs_with(STEP_WAIT_SNAPSHOT, "in_progress"),
            12: jobs_with(STEP_WAIT_SNAPSHOT, "queued"),
        }
        self.assertEqual(waiting_successor(runs, 10, jobs.get), 11)
        self.assertIsNone(waiting_successor(runs, 12, jobs.get))

    def test_step_done(self):
        self.assertEqual(step_done(run(1), jobs_with(STEP_SAVE_DB, "in_progress"), STEP_SAVE_DB),
                         {"done": False, "ok": False})
        self.assertEqual(step_done(run(1), jobs_with(STEP_SAVE_DB, "completed", "success"), STEP_SAVE_DB),
                         {"done": True, "ok": True})
        self.assertEqual(step_done(run(1), jobs_with(STEP_SAVE_DB, "completed", "skipped"), STEP_SAVE_DB),
                         {"done": True, "ok": True})
        self.assertEqual(step_done(run(1, "completed"), [], STEP_SAVE_DB), {"done": True, "ok": False})


class CommandTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(handover.time, "sleep")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_find_predecessor_cancels_stale_runs(self):
        api = FakeApi(runs=[run(5), run(8), run(9, "queued"), run(12)])
        self.assertEqual(handover.cmd_find_predecessor(api, 12), "8")
        self.assertEqual(api.cancelled, [5, 9])

    def test_wait_snapshot_returns_once_saved(self):
        api = FakeApi(
            run_states={8: [run(8)]},
            job_states={8: [jobs_with(STEP_SAVE_DB, "pending"), jobs_with(STEP_SAVE_DB, "completed", "success")]},
        )
        self.assertEqual(handover.cmd_wait_snapshot(api, 8, timeout=60, interval=1), "snapshot")
        self.assertEqual(api.cancelled, [])

    def test_wait_snapshot_cancels_a_silent_predecessor(self):
        api = FakeApi(
            run_states={8: [run(8), run(8), run(8, "completed")]},
            job_states={8: [jobs_with(STEP_SAVE_DB, "pending")]},
        )
        with mock.patch.object(handover.time, "monotonic", side_effect=[0, 0, 100, 100, 100, 100]):
            self.assertEqual(handover.cmd_wait_snapshot(api, 8, timeout=60, interval=1), "cancelled")
        self.assertEqual(api.cancelled, [8])

    def test_successor_waiting_ignores_queued_runs(self):
        api = FakeApi(runs=[run(10), run(11), run(12, "queued")],
                      job_states={11: [jobs_with(STEP_WAIT_SNAPSHOT, "in_progress")]})
        self.assertEqual(handover.cmd_successor_waiting(api, 10), "11")
        self.assertEqual(handover.cmd_successor_waiting(api, 11), "")

    def test_wait_registered_fails_when_successor_dies(self):
        api = FakeApi(run_states={20: [run(20, "completed")]},
                      job_states={20: [jobs_with(STEP_REGISTERED, "completed", "failure")]})
        with self.assertRaises(HandoverError) as ctx:
            handover.cmd_wait_registered(api, 20, timeout=60, interval=1)
        self.assertEqual(ctx.exception.code, "ERR_SUCCESSOR_FAILED")

    def test_wait_registered_succeeds(self):
        api = FakeApi(run_states={20: [run(20)]},
                      job_states={20: [jobs_with(STEP_REGISTERED, "in_progress"),
                                       jobs_with(STEP_REGISTERED, "completed", "success")]})
        self.assertEqual(handover.cmd_wait_registered(api, 20, timeout=60, interval=1), "registered")


if __name__ == "__main__":
    unittest.main()
