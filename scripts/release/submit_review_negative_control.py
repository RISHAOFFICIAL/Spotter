#!/usr/bin/env python3
"""Offline negative controls for scripts/release/submit_review.py.

WHY THIS EXISTS
  The 2026-10-05 hardening added four things that only count if they FAIL on the broken state:
  a demo-pair verification gate, a week filter inside it, a "state UNKNOWN" network-fault message,
  and a dry run that writes nothing. A check that passes on the broken tree proves nothing, so each
  one needs a captured non-zero exit code against a state where it must refuse.

HOW IT WORKS — no network to Apple, no Supabase project, no real credentials
  * the REAL `probe_demo_pair()` runs, unmodified, against a local stub of the Supabase/PostgREST
    surface (auth/token, auth/settings, rpc/my_group, users, workouts — the workouts route applies
    the `logged_at=gte.<ts>` filter the probe sends, so the week filter is genuinely exercised);
  * the ASC transport (`Asc._http`) and the JWT signer are replaced with recorders, so the live
    code paths run end to end and NOTHING is ever sent to Apple. Every non-GET call is counted and
    reported, which is how "a refused pair writes nothing" is proven rather than asserted;
  * `submit_review.main()` is called with the real argv, and this harness exits with ITS exit code.

SCENARIOS
  pair-absent            demo@/demo2@ do not exist              -> refuse (1)
  pair-ungrouped         both exist, no shared group            -> refuse (1)
  pair-stale-week        both logged, but 8 days ago            -> refuse (1)   [the addendum-3 case]
  pair-one-seat-stale    demo@ fresh, demo2@ stale              -> refuse (1)
  pair-wrong-partner     group exists, partner is not demo2@    -> refuse (1)
  pair-ok                both logged within the hour            -> proceed (0), nothing written
  mutation-no-week-filter  pair-ok run twice: once as above, and once with the window widened a
                         week, which turns the SAME stale pair into a PASS — the proof that the
                         week filter, not luck, is what refuses pair-stale-week
  timeout-final-patch    good pair, Apple never answers the final PATCH -> exit 1 with the
                         "state is UNKNOWN / do not retry / read the version state first" message
  self-test              the in-script offline self-test
  --list                 print the scenarios

USAGE (from the repo root; each line prints its own raw exit code):
  python3 scripts/release/submit_review_negative_control.py pair-stale-week; echo "exit=$?"
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import submit_review as sr  # noqa: E402  (path set above on purpose)

REAL_BACKUP = "/home/team/shared/asc-review-detail-backup.json"
DEMO_ID = "11111111-1111-1111-1111-111111111111"
DEMO2_ID = "22222222-2222-2222-2222-222222222222"
OTHER_ID = "33333333-3333-3333-3333-333333333333"
GROUP_ID = "99999999-9999-9999-9999-999999999999"

ACCOUNTS = {
    sr.DEMO_EMAIL: {"id": DEMO_ID, "label": "demo"},
    sr.DEMO2_EMAIL: {"id": DEMO2_ID, "label": "demo2"},
}
DUO = {"group_id": GROUP_ID, "member_ids": [DEMO2_ID], "member_count": 1}
DETAIL_ATTRS = {
    "notes": "OLD NOTES", "demoAccountName": None, "demoAccountPassword": None,
    "demoAccountRequired": False, "contactEmail": "x@y.z",
    "contactFirstName": "A", "contactLastName": "B", "contactPhone": "1",
}


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


class Stub:
    """Controllable stand-in for the Supabase surface the probe talks to."""

    def __init__(self, name: str, accounts: dict, group: dict | None,
                 logs: list[dict], autoconfirm: bool = True) -> None:
        self.name = name
        self.accounts = accounts
        self.group = group
        self.logs = logs
        self.autoconfirm = autoconfirm
        self.requests: list[tuple[str, str]] = []
        self.week_filter: str | None = None

    def group_for(self, auth_header: str) -> dict:
        if not self.group:
            return {"group_id": None, "member_ids": [], "member_count": 0}
        return dict(self.group)


def build_stub(name: str) -> Stub:
    now = datetime.now(timezone.utc)
    fresh = _iso(now - timedelta(hours=1))     # inside this week, whatever today is
    stale = _iso(now - timedelta(days=8))      # last week (or the week before) — never current
    fresh_row = {"user_id": DEMO_ID, "logged_at": fresh}
    fresh_row2 = {"user_id": DEMO2_ID, "logged_at": fresh}
    stale_row = {"user_id": DEMO_ID, "logged_at": stale}
    stale_row2 = {"user_id": DEMO2_ID, "logged_at": stale}
    if name == "pair-absent":
        return Stub(name, {}, None, [])
    if name == "pair-ungrouped":
        return Stub(name, ACCOUNTS, None, [fresh_row, fresh_row2])
    if name == "pair-stale-week":
        return Stub(name, ACCOUNTS, DUO, [stale_row, stale_row2])
    if name == "pair-one-seat-stale":
        return Stub(name, ACCOUNTS, DUO, [fresh_row, stale_row2])
    if name == "pair-wrong-partner":
        return Stub(name, ACCOUNTS,
                    {"group_id": GROUP_ID, "member_ids": [OTHER_ID], "member_count": 1},
                    [fresh_row])
    if name == "pair-ok":
        return Stub(name, ACCOUNTS, DUO, [fresh_row, fresh_row2])
    raise SystemExit(f"unknown scenario {name!r} — try --list")


class StubServer:
    def __init__(self, stub: Stub) -> None:
        harness = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:  # keep the transcript clean
                pass

            def _reply(self, code: int, payload: object) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802
                path = urllib.parse.urlparse(self.path).path
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n).decode() or "{}") if n else {}
                stub.requests.append(("POST", self.path))
                if path == "/auth/v1/token":
                    acct = stub.accounts.get((body or {}).get("email"))
                    if not acct:
                        return self._reply(400, {"error_code": "invalid_credentials",
                                                 "error_description": "Invalid login credentials"})
                    return self._reply(200, {"access_token": "tok-" + acct["label"],
                                             "user": {"id": acct["id"], "email": body.get("email")}})
                if path == "/rest/v1/rpc/my_group":
                    return self._reply(200, stub.group_for(self.headers.get("Authorization", "")))
                return self._reply(404, {"message": "no route"})

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlparse(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                stub.requests.append(("GET", self.path))
                if parsed.path == "/auth/v1/settings":
                    return self._reply(200, {"mailer_autoconfirm": stub.autoconfirm})
                if parsed.path == "/rest/v1/users":
                    return self._reply(200, [{"week_start_day": "Mon"}])
                if parsed.path == "/rest/v1/workouts":
                    gte = (query.get("logged_at") or [None])[0]
                    stub.week_filter = gte
                    rows = list(stub.logs)
                    if gte and gte.startswith("gte."):
                        cut = _parse(gte[4:])
                        rows = [r for r in rows if _parse(r["logged_at"]) >= cut]
                    return self._reply(200, rows)
                return self._reply(404, {"message": "no route"})

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.port = self.server.server_address[1]
        self.thread.start()
        self.harness = harness

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class AscRecorder:
    """Stands in for Asc._http: records every call, answers the ASC reads, and can time out on the
    irreversible final PATCH. No request ever leaves this process."""

    def __init__(self, timeout_on_final_patch: bool = False) -> None:
        self.calls: list[tuple[str, str]] = []
        self.timeout = timeout_on_final_patch

    @property
    def writes(self) -> list[tuple[str, str]]:
        return [c for c in self.calls if c[0] != "GET"]

    def __call__(self, method: str, url: str, body: object, token: str) -> tuple[int, object]:
        self.calls.append((method, url))
        if method == "GET" and url.endswith("/appStoreReviewDetail"):
            return 200, {"data": {"id": sr.REVIEW_DETAIL_ID, "attributes": dict(DETAIL_ATTRS)}}
        if method == "GET" and "reviewSubmissions?" in url:
            return 200, {"data": []}
        if method == "GET" and "include=build" in url:
            return 200, {"data": {"id": sr.VERSION_ID, "attributes": {
                "appStoreState": "PREPARE_FOR_SUBMISSION",
                "appVersionState": "PREPARE_FOR_SUBMISSION"}},
                "included": [{"id": sr.EXPECTED_BUILD_ID, "attributes": {
                    "version": sr.EXPECTED_BUILD_NUMBER, "processingState": "VALID",
                    "expired": False, "expirationDate": "2026-12-28T07:06:18-08:00"}}]}
        if method == "POST" and url.endswith("/reviewSubmissions"):
            return 201, {"data": {"id": "SUB-FAKE", "attributes": {"state": "READY_FOR_REVIEW"}}}
        if method == "POST" and url.endswith("/reviewSubmissionItems"):
            return 201, {"data": {"id": "ITEM-FAKE", "attributes": {}}}
        if method == "PATCH" and "reviewSubmissions/" in url:
            if self.timeout:
                raise sr.TransportError(f"{method} {url} got no response: timed out")
            return 200, {"data": {"id": "SUB-FAKE", "attributes": {
                "state": "WAITING_FOR_REVIEW", "submittedDate": "2026-10-05T20:00:00-07:00"}}}
        if method == "PATCH" and "appStoreReviewDetails" in url:
            return 200, {"data": {"id": sr.REVIEW_DETAIL_ID, "attributes": dict(DETAIL_ATTRS)}}
        raise AssertionError(f"unexpected ASC call: {method} {url}")


def sha256_file(path: str) -> str:
    if not os.path.exists(path):
        return "ABSENT"
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def run_one(stub_name: str, argv: list[str], *, timeout_on_final_patch: bool = False,
            slack_mutation_hours: int | None = None) -> int:
    """Run the real main() against the stub. Returns the helper's own exit code."""
    stub = build_stub(stub_name)
    server = StubServer(stub)
    recorder = AscRecorder(timeout_on_final_patch=timeout_on_final_patch)
    scratch = tempfile.mkdtemp(prefix="submit-review-nc-")
    backup = os.path.join(scratch, "backup.json")
    argv = [a.replace("{BACKUP}", backup) for a in argv]

    real_backup_before = sha256_file(REAL_BACKUP)
    real_http, real_jwt, real_cfg, real_slack = (
        sr.Asc._http, sr.Asc._jwt, sr.supabase_config, sr.TZ_SLACK_HOURS)
    sr.Asc._http = recorder
    sr.Asc._jwt = lambda self: "harness-token"
    sr.supabase_config = lambda: (f"http://127.0.0.1:{server.port}", "harness-anon-key",
                                 "negative-control stub")
    if slack_mutation_hours is not None:
        sr.TZ_SLACK_HOURS = slack_mutation_hours
    print(f"\n===== scenario {stub_name}"
          f"{' (MUTATION: week window widened to ' + str(slack_mutation_hours) + 'h)' if slack_mutation_hours else ''}"
          f"{' (final PATCH has no answer)' if timeout_on_final_patch else ''} =====")
    print(f"[harness] argv = {' '.join(argv)}")
    print(f"[harness] real artifact sha256 BEFORE = {real_backup_before}  ({REAL_BACKUP})")
    try:
        code = sr.main(argv)
    finally:
        sr.Asc._http, sr.Asc._jwt, sr.supabase_config = real_http, real_jwt, real_cfg
        sr.TZ_SLACK_HOURS = real_slack
        server.stop()
    wrote = os.listdir(scratch)
    print(f"[harness] helper exit code = {code}")
    print(f"[harness] ASC calls seen: {len(recorder.calls)} total, {len(recorder.writes)} non-GET "
          f"({[c[0] + ' ' + c[1] for c in recorder.writes] or 'none'})")
    print(f"[harness] week filter the probe actually sent: "
          f"{stub.week_filter or 'NONE (no week filter in the query!)'}")
    print(f"[harness] files created under --backup ({backup}): {wrote or 'NONE'}")
    print(f"[harness] real artifact sha256 AFTER  = {sha256_file(REAL_BACKUP)}")
    shutil.rmtree(scratch, ignore_errors=True)
    return code


SCENARIOS: dict[str, dict] = {
    "pair-absent": {"stub": "pair-absent", "expect": 1,
                    "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "pair-ungrouped": {"stub": "pair-ungrouped", "expect": 1,
                       "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "pair-stale-week": {"stub": "pair-stale-week", "expect": 1,
                        "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "pair-one-seat-stale": {"stub": "pair-one-seat-stale", "expect": 1,
                            "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "pair-wrong-partner": {"stub": "pair-wrong-partner", "expect": 1,
                           "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "pair-ok": {"stub": "pair-ok", "expect": 0,
                "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"]},
    "mutation-no-week-filter": {"stub": "pair-stale-week", "expect": 0,
                                "argv": ["--set-demo-credentials", "--backup", "{BACKUP}", "--dry-run"],
                                "slack": 24 * 8},
    "timeout-final-patch": {"stub": "pair-ok", "expect": 1,
                            "argv": ["--submit-for-review", "--yes"], "timeout": True},
    "self-test": {"stub": "pair-ok", "expect": 0, "argv": ["--self-test"]},
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", nargs="?", help="scenario name (see --list)")
    ap.add_argument("--list", action="store_true", help="list scenarios")
    args = ap.parse_args(argv)

    if args.list or not args.scenario:
        for name, spec in SCENARIOS.items():
            print(f"{name:26s} expected exit {spec['expect']}   "
                  f"{' '.join(spec['argv'])}")
        return 0

    spec = SCENARIOS.get(args.scenario)
    if not spec:
        raise SystemExit(f"unknown scenario {args.scenario!r} — try --list")

    if args.scenario == "self-test":
        print("\n===== scenario self-test =====")
        code = sr.self_test()
        print(f"[harness] helper exit code = {code}   (expected {spec['expect']})")
        return code

    code = run_one(spec["stub"], list(spec["argv"]),
                   timeout_on_final_patch=bool(spec.get("timeout")),
                   slack_mutation_hours=spec.get("slack"))
    print(f"[harness] EXPECTED exit {spec['expect']} — "
          f"{'OK' if code == spec['expect'] else 'MISMATCH'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
