"""Coordinates the hand-over between two Tunnel 2 runs so the tunnel never goes dark.

The new run (successor) and the running one (predecessor) talk only through
the GitHub API, by watching each other's step states:

  successor                                predecessor
  ---------                                -----------
  find-predecessor
  "Wait for handover snapshot" ...  ---->  hold loop sees it (successor-waiting),
                                           snapshots its live database and saves
                                           it to the Actions cache
  ... sees "Save panel database" done <--
  restores that database, starts the
  panel and cloudflared
  "Wait for tunnel to register" done ----> wait-registered returns; it stops
                                           cloudflared and the panel

Both connectors serve the tunnel while the successor starts, so there is no
gap, and the successor starts from the predecessor's latest database.

Subcommands print their result on stdout; progress goes to stderr.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional

WORKFLOW_FILE = "tunnel2.yml"
STEP_WAIT_SNAPSHOT = "Wait for handover snapshot"
STEP_SAVE_DB = "Save panel database"
STEP_REGISTERED = "Wait for tunnel to register"


class HandoverError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class GitHubApi:
    def __init__(self, repo: str, token: str):
        if not repo or not token:
            raise HandoverError("ERR_HANDOVER_CONFIG", "GITHUB_REPOSITORY and GH_TOKEN must be set.")
        self.base = f"https://api.github.com/repos/{repo}"
        self.token = token

    def request(self, method: str, path: str) -> dict:
        req = urllib.request.Request(self.base + path, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
        except urllib.error.HTTPError as error:
            raise HandoverError("ERR_GITHUB_API", f"{method} {path} answered {error.code}.") from error
        except urllib.error.URLError as error:
            raise HandoverError("ERR_GITHUB_API", f"{method} {path} failed: {error.reason}.") from error
        return json.loads(body) if body else {}

    def active_runs(self, statuses: tuple = ("in_progress", "queued")) -> List[dict]:
        runs: List[dict] = []
        for status in statuses:
            data = self.request("GET", f"/actions/workflows/{WORKFLOW_FILE}/runs?status={status}&per_page=50")
            runs.extend(data.get("workflow_runs", []))
        return runs

    def run(self, run_id: int) -> dict:
        return self.request("GET", f"/actions/runs/{run_id}")

    def jobs(self, run_id: int) -> List[dict]:
        return self.request("GET", f"/actions/runs/{run_id}/jobs").get("jobs", [])

    def cancel(self, run_id: int) -> None:
        try:
            self.request("POST", f"/actions/runs/{run_id}/cancel")
        except HandoverError as error:
            # 409: the run already finished, which is what cancelling wants anyway.
            if "answered 409" not in str(error):
                raise


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S', time.gmtime())}] {message}", file=sys.stderr, flush=True)


def pick_predecessor(runs: List[dict], own_id: int) -> Optional[int]:
    """The newest run older than this one that is already serving (in progress)."""
    older = [r["id"] for r in runs if r["id"] < own_id and r.get("status") == "in_progress"]
    return max(older) if older else None


def stale_runs(runs: List[dict], own_id: int, predecessor: Optional[int]) -> List[int]:
    """Older runs other than the predecessor: superseded before they took over."""
    return sorted({r["id"] for r in runs if r["id"] < own_id and r["id"] != predecessor})


def step_of(jobs: List[dict], name: str) -> Optional[dict]:
    for job in jobs:
        for step in job.get("steps", []) or []:
            if step.get("name") == name:
                return step
    return None


def waiting_successor(runs: List[dict], own_id: int, jobs_of: Callable[[int], List[dict]]) -> Optional[int]:
    """The newest newer run that is waiting for this run's database snapshot."""
    for run_id in sorted((r["id"] for r in runs if r["id"] > own_id and r.get("status") == "in_progress"),
                         reverse=True):
        step = step_of(jobs_of(run_id), STEP_WAIT_SNAPSHOT)
        if step and step.get("status") == "in_progress":
            return run_id
    return None


def step_done(run: dict, jobs: List[dict], name: str) -> Dict[str, object]:
    """Whether `name` has finished in `run`, and whether it (and the run) succeeded."""
    step = step_of(jobs, name)
    if step and step.get("status") == "completed":
        return {"done": True, "ok": step.get("conclusion") in ("success", "skipped")}
    if run.get("status") == "completed":
        return {"done": True, "ok": False}
    return {"done": False, "ok": False}


def wait_for_step(api: GitHubApi, run_id: int, name: str, timeout: int, interval: int) -> bool:
    """Polls until `name` finishes in `run_id`; returns whether it succeeded."""
    deadline = time.monotonic() + timeout
    while True:
        state = step_done(api.run(run_id), api.jobs(run_id), name)
        if state["done"]:
            return bool(state["ok"])
        if time.monotonic() >= deadline:
            raise HandoverError("ERR_HANDOVER_TIMEOUT", f'run {run_id} did not finish "{name}" within {timeout}s.')
        time.sleep(interval)


def wait_for_completion(api: GitHubApi, run_id: int, timeout: int, interval: int) -> None:
    deadline = time.monotonic() + timeout
    while api.run(run_id).get("status") != "completed":
        if time.monotonic() >= deadline:
            raise HandoverError("ERR_HANDOVER_TIMEOUT", f"run {run_id} did not complete within {timeout}s.")
        time.sleep(interval)


def cmd_find_predecessor(api: GitHubApi, own_id: int) -> str:
    runs = api.active_runs()
    predecessor = pick_predecessor(runs, own_id)
    for run_id in stale_runs(runs, own_id, predecessor):
        log(f"Cancelling superseded run {run_id}.")
        api.cancel(run_id)
    log(f"Predecessor: {predecessor or 'none'}.")
    return str(predecessor or "")


def cmd_wait_snapshot(api: GitHubApi, run_id: int, timeout: int, interval: int) -> str:
    """Waits for the predecessor's database snapshot. A predecessor that never
    answers (an older workflow version, or one stuck) is cancelled instead; its
    cleanup steps still save the database, at the cost of a short gap."""
    log(f"Waiting up to {timeout}s for run {run_id} to save its database.")
    try:
        ok = wait_for_step(api, run_id, STEP_SAVE_DB, timeout, interval)
        log(f'Run {run_id} finished "{STEP_SAVE_DB}" ({"ok" if ok else "failed or skipped"}).')
        return "snapshot" if ok else "no-snapshot"
    except HandoverError as error:
        log(f"{error} Cancelling run {run_id} and waiting for its cleanup.")
        api.cancel(run_id)
        wait_for_completion(api, run_id, timeout, interval)
        return "cancelled"


def cmd_successor_waiting(api: GitHubApi, own_id: int) -> str:
    # Polled every 20 s by the hold loop, so one listing call: a successor
    # waiting for the snapshot is always in progress.
    successor = waiting_successor(api.active_runs(("in_progress",)), own_id, api.jobs)
    return str(successor or "")


def cmd_wait_registered(api: GitHubApi, run_id: int, timeout: int, interval: int) -> str:
    log(f"Waiting up to {timeout}s for run {run_id} to register its tunnel connection.")
    ok = wait_for_step(api, run_id, STEP_REGISTERED, timeout, interval)
    if not ok:
        raise HandoverError("ERR_SUCCESSOR_FAILED", f"run {run_id} did not bring its tunnel up.")
    return "registered"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Tunnel 2 run hand-over")
    parser.add_argument("command", choices=["find-predecessor", "wait-snapshot", "successor-waiting", "wait-registered"])
    parser.add_argument("--run", type=int, help="the other run's id (wait-snapshot, wait-registered)")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--interval", type=int, default=5)
    args = parser.parse_args(argv)

    try:
        api = GitHubApi(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GH_TOKEN", ""))
        own_id = int(os.environ.get("GITHUB_RUN_ID", "0"))
        if args.command in ("wait-snapshot", "wait-registered") and not args.run:
            raise HandoverError("ERR_HANDOVER_ARGS", f"{args.command} needs --run.")
        if args.command == "find-predecessor":
            result = cmd_find_predecessor(api, own_id)
        elif args.command == "wait-snapshot":
            result = cmd_wait_snapshot(api, args.run, args.timeout, args.interval)
        elif args.command == "successor-waiting":
            result = cmd_successor_waiting(api, own_id)
        else:
            result = cmd_wait_registered(api, args.run, args.timeout, args.interval)
    except HandoverError as error:
        print(error, file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
