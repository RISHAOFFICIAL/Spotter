#!/usr/bin/env python3
"""Prepare — and only on an explicit flag, perform — the App Store submission of SPOTTER 1.0.

WHAT THIS DOES
  * prints, before anything is sent, the exact HTTP request it is about to make;
  * `--set-demo-credentials`  writes the reviewer demo account + the appended reviewer notes
                              onto the EXISTING appStoreReviewDetails resource (never creates a
                              second one), preserving the current notes verbatim;
  * `--submit-for-review`     runs the three Review Submissions calls that put version 1.0 into
                              App Review (create -> add item -> submitted:true). Needs `--yes`.
  * `--verify`                re-reads everything and prints the post-submission checks;
  * `--backup PATH` / `--restore`  make the one reversible write recoverable.

DRY RUN IS THE DEFAULT. With no action flag this script performs zero writes and exits 0.

HARD RULE ENFORCED IN CODE: this script never touches listing content. Any non-GET request whose
path mentions localizations, screenshots, app info, age rating, availability, pricing or builds is
refused (see FORBIDDEN_PATH_PARTS) — the build attached to the version is never re-selected.

USAGE
  python3 scripts/release/submit_review.py                       # dry run, prints everything
  python3 scripts/release/submit_review.py --verify               # read-only status report
  python3 scripts/release/submit_review.py --set-demo-credentials
  python3 scripts/release/submit_review.py --set-demo-credentials --submit-for-review --yes
  python3 scripts/release/submit_review.py --self-test            # offline, no network

The ASC key is passed explicitly and ambient ASC_API_KEY_ID is IGNORED on purpose: this box exports
a stale key id (6C8894PDYD) that returns 401 from every call.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable

# --------------------------------------------------------------------------------------------- #
# Constants — the 1.0 submission record, read live on 2026-10-05.
# --------------------------------------------------------------------------------------------- #
BASE = "https://api.appstoreconnect.apple.com/v1"

APP_ID = "6813088731"
VERSION_ID = "e928fff9-72d6-4566-8bd2-2d60e597a2bc"        # App Store version 1.0
REVIEW_DETAIL_ID = "2a95307f-98a7-4b49-82b6-d4860903f843"  # the existing appStoreReviewDetails row
EXPECTED_BUILD_ID = "5f86a3f5-c9ea-425e-a49a-5ebcf4d58b04"  # build 30, VALID, attached to 1.0
EXPECTED_BUILD_NUMBER = "30"

DEFAULT_KEY_ID = "FAZVL5B299"
DEFAULT_ISSUER_ID = "eb3be96f-9578-4ec7-93a0-89bf6bb8a777"
DEFAULT_KEY_PATH = "/home/team/.ios-creds/asc_api_key.p8"
DEAD_KEY_ID = "6C8894PDYD"

DEMO_EMAIL = "demo@spotterworkout.com"
DEMO_PASSWORD = "SpotterDemo2026!"
DEFAULT_BACKUP = "/home/team/shared/asc-review-detail-backup.json"

# Appended to the reviewer notes. The existing notes are NEVER edited, reflowed or replaced: the new
# text is concatenated after the live text. Keep this string frozen — the runbook quotes it verbatim.
APPEND = (
    "\n\nDemo account for review: sign in with demo@spotterworkout.com and the password "
    "SpotterDemo2026! \u2014 this version has no sign-out, so please use this account instead of "
    "creating your own. It is already in a two-person group with demo2@spotterworkout.com and both "
    "seats have logged a live-camera workout, so Home shows the partner's log in the feed and the "
    "weekly ring has progress. The same credentials are filled into the Demo Account fields above."
)
# sha256 of the notes text as it stood on 2026-10-05 (1614 chars) — reported, warned about, never
# required: if somebody edits the notes first, the append still works, we just say so.
KNOWN_NOTES_SHA256 = "e8e364e6555f8a35bfa7edb4b958627aefec23ed253f58e23a3db599bb0beda5"
KNOWN_NOTES_CHARS = 1614

# Any non-GET whose path contains one of these is refused: listing content is out of scope.
FORBIDDEN_PATH_PARTS = (
    "appStoreVersionLocalizations",
    "appInfoLocalizations",
    "appScreenshots",
    "appScreenshotSets",
    "appInfos",
    "ageRatingDeclarations",
    "appAvailability",
    "appPriceSchedules",
    "appPricePoints",
    "inAppPurchases",
    "betaAppReviewDetails",
    "builds",
    "relationships/build",
)

# --------------------------------------------------------------------------------------------- #
# ASC transport (mirrors /home/team/.ios-creds/asc_api.py — kept local so the script is runnable
# from the repo without importing a helper that lives outside it).
# --------------------------------------------------------------------------------------------- #
class Asc:
    def __init__(self, key_path: str, key_id: str, issuer_id: str, *, dry_run: bool,
                 send: Callable[..., tuple[int, Any]] | None = None) -> None:
        self.key_path = key_path
        self.key_id = key_id
        self.issuer_id = issuer_id
        self.dry_run = dry_run
        self._send = send or self._http
        self._planned: list[dict[str, Any]] = []

    # -- JWT --------------------------------------------------------------------------------- #
    @staticmethod
    def _b64u(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    def _jwt(self) -> str:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec, utils

        with open(self.key_path, "rb") as fh:
            key = serialization.load_pem_private_key(fh.read(), password=None)
        now = int(time.time())
        header = self._b64u(json.dumps({"alg": "ES256", "kid": self.key_id, "typ": "JWT"}).encode())
        payload = self._b64u(json.dumps({
            "iss": self.issuer_id, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1",
        }).encode())
        der = key.sign(f"{header}.{payload}".encode(), ec.ECDSA(hashes.SHA256()))
        r, s = utils.decode_dss_signature(der)
        return f"{header}.{payload}.{self._b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"

    def _http(self, method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + token)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode()
                return resp.status, (json.loads(text) if text else {})
        except urllib.error.HTTPError as exc:
            text = exc.read().decode()
            try:
                return exc.code, json.loads(text)
            except ValueError:
                return exc.code, {"raw": text}

    # -- guard ------------------------------------------------------------------------------- #
    @staticmethod
    def _guard(method: str, path: str) -> None:
        if method.upper() == "GET":
            return
        for part in FORBIDDEN_PATH_PARTS:
            if part.lower() in path.lower():
                raise SystemExit(
                    f"REFUSED: {method} {path} touches listing/asset/build content "
                    f"('{part}'). This script may only write appStoreReviewDetails and "
                    f"reviewSubmissions."
                )

    # -- call -------------------------------------------------------------------------------- #
    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        method = method.upper()
        url = path if path.startswith("http") else BASE + path
        self._guard(method, path)
        if method != "GET":
            print("\n--- REQUEST " + "-" * 68)
            print(f"{method} {url}")
            if body is not None:
                print("Content-Type: application/json")
                print(json.dumps(body, ensure_ascii=False, indent=2))
        if self.dry_run and method != "GET":
            self._planned.append({"method": method, "url": url, "body": body})
            print("--- DRY RUN: not sent. " + "-" * 50)
            return 0, {"dry_run": True}
        status, payload = self._send(method, url, body, self._jwt())
        if method != "GET":
            print(f"--- RESPONSE HTTP {status} " + "-" * 50)
            print(json.dumps(payload, ensure_ascii=False, indent=2)[:4000])
        return status, payload


# --------------------------------------------------------------------------------------------- #
# Reads
# --------------------------------------------------------------------------------------------- #
def read_review_detail(asc: Asc) -> dict[str, Any]:
    status, body = asc.call("GET", f"/appStoreVersions/{VERSION_ID}/appStoreReviewDetail")
    if status != 200 or not isinstance(body, dict) or body.get("data") is None:
        raise SystemExit(f"could not read appStoreReviewDetail (HTTP {status}) — stopping")
    data = body["data"]
    if data["id"] != REVIEW_DETAIL_ID:
        raise SystemExit(
            f"review detail id changed: expected {REVIEW_DETAIL_ID}, got {data['id']} — stopping"
        )
    return data["attributes"]


def read_submissions(asc: Asc) -> list[dict[str, Any]]:
    status, body = asc.call(
        "GET", f"/reviewSubmissions?filter[app]={APP_ID}&limit=50&include=items")
    if status != 200:
        raise SystemExit(f"could not list review submissions (HTTP {status})")
    return body.get("data", []) or []


# --------------------------------------------------------------------------------------------- #
# Actions
# --------------------------------------------------------------------------------------------- #
def build_notes(live: str) -> str:
    """Append the demo-account paragraph. The live text is preserved byte-for-byte."""
    if "Demo account for review:" in live:
        raise SystemExit("the demo-account paragraph is ALREADY in the notes — nothing to append")
    return live + APPEND


def demo_body(notes: str) -> dict[str, Any]:
    return {
        "data": {
            "type": "appStoreReviewDetails",
            "id": REVIEW_DETAIL_ID,
            "attributes": {
                "notes": notes,
                "demoAccountName": DEMO_EMAIL,
                "demoAccountPassword": DEMO_PASSWORD,
                "demoAccountRequired": True,
            },
        }
    }


def backup_payload(attrs: dict[str, Any]) -> dict[str, Any]:
    keys = ("notes", "demoAccountName", "demoAccountPassword", "demoAccountRequired",
            "contactFirstName", "contactLastName", "contactEmail", "contactPhone")
    return {
        "takenAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "appStoreReviewDetailId": REVIEW_DETAIL_ID,
        "versionId": VERSION_ID,
        "attributes": {k: attrs.get(k) for k in keys},
        "sha256": {k: sha256(attrs.get(k)) for k in keys},
    }


def sha256(value: Any) -> str:
    if value is None:
        return "null"
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode()).hexdigest()


def sha256_raw(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def do_set_demo_credentials(asc: Asc, backup_path: str) -> int:
    attrs = read_review_detail(asc)
    live = attrs.get("notes") or ""
    print(f"[review detail] id={REVIEW_DETAIL_ID}")
    print(f"[review detail] notes={len(live)} chars, sha256={sha256_raw(live)}")
    if len(live) != KNOWN_NOTES_CHARS or sha256_raw(live) != KNOWN_NOTES_SHA256:
        print("WARNING: the live notes are NOT the 1614-char text recorded on 2026-10-05. "
              "Appending anyway (the append only adds text), but re-read the result by hand.")
    print(f"[review detail] demoAccountName={attrs.get('demoAccountName')!r} "
          f"demoAccountRequired={attrs.get('demoAccountRequired')!r}")

    payload = backup_payload(attrs)
    with open(backup_path, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"[backup] wrote {backup_path}")

    notes = build_notes(live)
    if len(notes) != len(live) + len(APPEND):
        raise SystemExit("refusing: the new notes are not exactly the old notes plus the append")
    assert notes.startswith(live)
    print(f"[notes] after append: {len(notes)} chars, sha256={sha256_raw(notes)}")

    status, _ = asc.call("PATCH", f"/appStoreReviewDetails/{REVIEW_DETAIL_ID}", demo_body(notes))
    if asc.dry_run:
        print("\nDRY RUN — nothing was written to Apple.\n")
        return 0
    if status != 200:
        raise SystemExit(f"PATCH appStoreReviewDetails failed with HTTP {status}")

    after = read_review_detail(asc)
    ok = (
        after.get("notes") == notes
        and after.get("demoAccountName") == DEMO_EMAIL
        and after.get("demoAccountPassword") == DEMO_PASSWORD
        and after.get("demoAccountRequired") is True
        and after.get("contactEmail") == attrs.get("contactEmail")
        and all(after.get(k) == attrs.get(k)
                for k in ("contactFirstName", "contactLastName", "contactPhone"))
    )
    print(f"[verify] notes identical to what we sent: {after.get('notes') == notes}")
    print(f"[verify] demoAccountName={after.get('demoAccountName')!r} "
          f"demoAccountRequired={after.get('demoAccountRequired')!r}")
    if not ok:
        raise SystemExit("read-back does not match what we wrote — STOP and inspect")
    print("[verify] OK\n")
    return 0


def do_restore(asc: Asc, backup_path: str) -> int:
    if not os.path.exists(backup_path):
        raise SystemExit(f"no backup at {backup_path}")
    with open(backup_path) as fh:
        attrs = json.load(fh)["attributes"]
    body = {"data": {"type": "appStoreReviewDetails", "id": REVIEW_DETAIL_ID,
                     "attributes": {k: attrs.get(k) for k in
                                    ("notes", "demoAccountName", "demoAccountPassword",
                                     "demoAccountRequired")}}}
    status, _ = asc.call("PATCH", f"/appStoreReviewDetails/{REVIEW_DETAIL_ID}", body)
    if not asc.dry_run and status != 200:
        raise SystemExit(f"restore PATCH failed with HTTP {status}")
    print(f"[restore] {'dry run' if asc.dry_run else 'restored'} from {backup_path}")
    return 0


def preflight(asc: Asc) -> None:
    status, body = asc.call(
        "GET", f"/appStoreVersions/{VERSION_ID}?include=build")
    if status != 200:
        raise SystemExit(f"could not read version 1.0 (HTTP {status})")
    attrs = body["data"]["attributes"]
    state = attrs.get("appStoreState")
    print(f"[preflight] version 1.0 state = {state}")
    if state != "PREPARE_FOR_SUBMISSION":
        raise SystemExit(
            f"version 1.0 is '{state}', not PREPARE_FOR_SUBMISSION. If it is already "
            f"WAITING_FOR_REVIEW / IN_REVIEW, it is submitted — do not run this again."
        )
    included = body.get("included", []) or []
    build = included[0] if included else None
    if build is None or build["id"] != EXPECTED_BUILD_ID:
        raise SystemExit(
            f"the attached build is "
            f"{build['id'] if build else 'NONE'}, expected {EXPECTED_BUILD_ID} (build 30). "
            f"STOP: this script never re-attaches a build."
        )
    battrs = build["attributes"]
    print(f"[preflight] attached build {battrs.get('version')} "
          f"({build['id']}) processingState={battrs.get('processingState')} "
          f"expired={battrs.get('expired')} expires={battrs.get('expirationDate')}")
    if battrs.get("processingState") != "VALID" or battrs.get("expired"):
        raise SystemExit("the attached build is not VALID/unexpired — stopping")

    subs = read_submissions(asc)
    print(f"[preflight] existing review submissions for this app: {len(subs)}")
    if subs:
        raise SystemExit(
            "a review submission already exists for this app — inspect it before doing anything "
            f"({[s['id'] for s in subs]})"
        )


def do_submit_for_review(asc: Asc, assume_yes: bool) -> int:
    if not assume_yes:
        raise SystemExit(
            "--submit-for-review needs --yes as well: the final PATCH puts version 1.0 into App "
            "Review and cannot be undone from here."
        )
    preflight(asc)

    create = {"data": {"type": "reviewSubmissions",
                       "attributes": {"platform": "IOS"},
                       "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}}
    status, body = asc.call("POST", "/reviewSubmissions", create)
    if asc.dry_run:
        print("[dry run] would create a review submission and add version 1.0 to it, then PATCH "
              "submitted:true.\n")
        return 0
    if status not in (200, 201):
        raise SystemExit(f"POST /reviewSubmissions failed with HTTP {status}")
    submission_id = body["data"]["id"]
    print(f"[c1] review submission {submission_id} state={body['data']['attributes'].get('state')}")

    item = {"data": {"type": "reviewSubmissionItems",
                     "relationships": {
                         "reviewSubmission": {"data": {"type": "reviewSubmissions",
                                                       "id": submission_id}},
                         "appStoreVersion": {"data": {"type": "appStoreVersions",
                                                      "id": VERSION_ID}}}}}
    status, body = asc.call("POST", "/reviewSubmissionItems", item)
    if status not in (200, 201):
        raise SystemExit(
            f"POST /reviewSubmissionItems failed with HTTP {status}. The un-submitted review "
            f"submission {submission_id} can still be cancelled "
            f"(PATCH /reviewSubmissions/{submission_id} {{\"canceled\": true}})."
        )
    print(f"[c2] item {body['data']['id']} attached to {submission_id}")

    submit = {"data": {"type": "reviewSubmissions", "id": submission_id,
                       "attributes": {"submitted": True}}}
    status, body = asc.call("PATCH", f"/reviewSubmissions/{submission_id}", submit)
    if status != 200:
        raise SystemExit(
            f"PATCH submitted:true failed with HTTP {status}. Nothing was submitted; cancel "
            f"{submission_id} before retrying."
        )
    print(f"[c3] state={body['data']['attributes'].get('state')} "
          f"submittedDate={body['data']['attributes'].get('submittedDate')}")
    return 0


# --------------------------------------------------------------------------------------------- #
# Verification (section 6 of the runbook)
# --------------------------------------------------------------------------------------------- #
def do_verify(asc: Asc) -> int:
    status, body = asc.call("GET", f"/appStoreVersions/{VERSION_ID}?include=build")
    attrs = body["data"]["attributes"]
    included = body.get("included", []) or []
    build_id = included[0]["id"] if included else "NONE"
    print(f"version 1.0: appStoreState={attrs.get('appStoreState')} "
          f"appVersionState={attrs.get('appVersionState')} "
          f"attached build={build_id} "
          f"(build 30 = {EXPECTED_BUILD_ID})")

    rd = read_review_detail(asc)
    notes = rd.get("notes") or ""
    print(f"review detail: demoAccountName={rd.get('demoAccountName')!r} "
          f"demoAccountRequired={rd.get('demoAccountRequired')!r}")
    print(f"review detail: notes {len(notes)} chars, sha256={sha256_raw(notes)}, "
          f"endsWithAppend={notes.endswith(APPEND)}")
    print(f"              (runbook expects 2062 chars, "
          f"sha d8cada844dbd07390a6167b21d97b06e4ac8c3c1cd4abbd49092b56787bca8a0)")
    if rd.get("contactEmail") != "erishasmith0723@gmail.com":
        print("WARNING: review contact email changed since 2026-10-05")

    subs = read_submissions(asc)
    print(f"review submissions: {len(subs)}")
    for s in subs:
        a = s["attributes"]
        print(f"  {s['id']} state={a.get('state')} submittedDate={a.get('submittedDate')} "
              f"items={len(s.get('relationships', {}).get('items', {}).get('data', []) or [])}")
    return 0


# --------------------------------------------------------------------------------------------- #
# Offline self-test: proves the dry run sends nothing and the guard refuses listing writes.
# --------------------------------------------------------------------------------------------- #
def self_test() -> int:
    calls: list[tuple[str, str]] = []

    def fake_send(method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        calls.append((method, url))
        if url.endswith("/appStoreReviewDetail"):
            return 200, {"data": {"id": REVIEW_DETAIL_ID, "attributes": {
                "notes": "OLD", "demoAccountName": None, "demoAccountPassword": None,
                "demoAccountRequired": False, "contactEmail": "x@y.z",
                "contactFirstName": "A", "contactLastName": "B", "contactPhone": "1"}}}
        if "reviewSubmissions?" in url:
            return 200, {"data": []}
        raise AssertionError(f"unexpected non-GET in dry run: {method} {url}")

    asc = Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID, dry_run=True,
              send=fake_send)

    failures = []

    # 1. dry-run writes nothing
    do_set_demo_credentials(asc, "/tmp/selftest-backup.json")
    if [c for c in calls if c[0] != "GET"]:
        failures.append(f"dry run issued a write: {calls}")
    if asc._planned[0]["method"] != "PATCH":
        failures.append("dry run did not plan the PATCH")
    planned_body = asc._planned[0]["body"]["data"]["attributes"]
    if planned_body["notes"] != "OLD" + APPEND:
        failures.append("planned notes are not old + append")
    if not planned_body["notes"].startswith("OLD"):
        failures.append("planned notes do not preserve the live text")
    if planned_body["demoAccountName"] != DEMO_EMAIL:
        failures.append("planned demoAccountName is wrong")
    if planned_body["demoAccountRequired"] is not True:
        failures.append("planned demoAccountRequired is not True")

    # 2. the listing guard refuses every forbidden path
    for path in ("/appStoreVersionLocalizations/abc",
                 "/appInfos/abc",
                 "/ageRatingDeclarations/abc",
                 "/appScreenshots/abc",
                 "/apps/6813088731/appAvailabilityV2",
                 "/appPriceSchedules/abc",
                 "/appStoreVersions/e928fff9-72d6-4566-8bd2-2d60e597a2bc/relationships/build"):
        try:
            Asc._guard("PATCH", path)
            failures.append(f"guard did NOT refuse PATCH {path}")
        except SystemExit:
            pass
    for path in (f"/appStoreReviewDetails/{REVIEW_DETAIL_ID}", "/reviewSubmissions", "/reviewSubmissionItems"):
        Asc._guard("PATCH", path)  # must not raise

    # 3. submission requires --yes
    try:
        do_submit_for_review(Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID,
                                 dry_run=True, send=fake_send), assume_yes=False)
        failures.append("--submit-for-review ran without --yes")
    except SystemExit:
        pass

    # 4. appending twice is refused
    try:
        build_notes("OLD" + APPEND)
        failures.append("build_notes appended twice")
    except SystemExit:
        pass

    # 5. the append preserves the 1614-char text byte-for-byte
    if not APPEND.startswith("\n\n"):
        failures.append("APPEND must start with a blank line")
    if len(APPEND) != 448:
        failures.append(f"APPEND is {len(APPEND)} chars, runbook says 448")

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("SELF-TEST PASSED: 5 checks groups, dry run sent 0 writes, guard refused 7 listing paths")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set-demo-credentials", action="store_true",
                    help="PATCH the existing appStoreReviewDetails with the demo account + appended notes")
    ap.add_argument("--submit-for-review", action="store_true",
                    help="run the three Review Submissions calls that submit version 1.0")
    ap.add_argument("--yes", action="store_true", help="required acknowledgement for --submit-for-review")
    ap.add_argument("--restore", action="store_true", help="put the backed-up review-detail values back")
    ap.add_argument("--verify", action="store_true", help="read-only status report")
    ap.add_argument("--dry-run", action="store_true",
                    help="force dry run even when an action flag is given")
    ap.add_argument("--backup", default=DEFAULT_BACKUP, help=f"backup path (default {DEFAULT_BACKUP})")
    ap.add_argument("--key-file", default=DEFAULT_KEY_PATH)
    ap.add_argument("--key-id", default=DEFAULT_KEY_ID,
                    help="ASC key id (ambient ASC_API_KEY_ID is deliberately ignored)")
    ap.add_argument("--issuer-id", default=DEFAULT_ISSUER_ID)
    ap.add_argument("--self-test", action="store_true", help="offline checks, no network")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    if args.key_id == DEAD_KEY_ID:
        print(f"refusing to use the stale key id {DEAD_KEY_ID} (returns 401)", file=sys.stderr)
        return 2

    action = bool(args.set_demo_credentials or args.submit_for_review or args.restore)
    dry_run = (not action) or args.dry_run
    asc = Asc(args.key_file, args.key_id, args.issuer_id, dry_run=dry_run)

    print(f"SPOTTER 1.0 submission helper — app {APP_ID}, version {VERSION_ID}, "
          f"build {EXPECTED_BUILD_NUMBER}")
    print(f"mode: {'DRY RUN (nothing will be sent)' if dry_run else 'LIVE'}")

    try:
        if args.restore:
            return do_restore(asc, args.backup)
        if args.set_demo_credentials:
            do_set_demo_credentials(asc, args.backup)
        if args.submit_for_review:
            do_submit_for_review(asc, args.yes)
        if args.verify or not action or not dry_run:
            if not dry_run:
                print("\n--- verification (read-only) ---")
            return do_verify(asc)
        return 0
    except SystemExit as exc:
        if str(exc):
            print(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
