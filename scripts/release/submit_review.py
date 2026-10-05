#!/usr/bin/env python3
"""Prepare — and only on an explicit flag, perform — the App Store submission of SPOTTER 1.0.

WHAT THIS DOES
  * prints, before anything is sent, the exact HTTP request it is about to make;
  * `--pair-check`            read-only: verifies the demo pair (see below) and exits;
  * `--set-demo-credentials`  writes the reviewer demo account + the appended reviewer notes
                              onto the EXISTING appStoreReviewDetails resource (never creates a
                              second one), preserving the current notes verbatim;
  * `--submit-for-review`     runs the three Review Submissions calls that put version 1.0 into
                              App Review (create -> add item -> submitted:true). Needs `--yes`.
  * `--verify`                re-reads everything and prints the post-submission checks;
  * `--backup PATH` / `--restore`  make the one reversible write recoverable.

DRY RUN IS THE DEFAULT. With no action flag this script performs zero writes and exits 0.
A DRY RUN WRITES NOTHING AT ALL — no backup file, no notes file, no temp state (2026-10-05 hardening).

THE DEMO PAIR IS VERIFIED BEFORE IT IS ASSERTED (2026-10-05 hardening).
  The appended reviewer paragraph says the demo account sits in a two-person group with demo2@.
  That used to be an assertion the script never checked. It is now read back through the app's OWN
  client path against the live Supabase project — the project's anon key plus a password grant for
  both seats, then `my_group()`, the demo account's own `users` row, and the same week-filtered
  `workouts` read the feed does (read-only; no service-role key is needed or used). If the accounts
  are absent, ungrouped, not exactly that duo, or have no log IN THE CURRENT WEEK, the script
  REFUSES with a non-zero exit and writes nothing — before the notes PATCH and again before the
  final `submitted:true`. There is deliberately NO bypass flag: the note asserts the pair, so the
  pair has to be true. The feed is week-scoped and the week starts Monday, so every check carries a
  week filter — a "≥2 workout rows" check passes on a pair that logged LAST week and rots at the
  Monday boundary.

FAILURE PATHS SAY THE TRUE NEXT ACTION (2026-10-05 hardening).
  A network fault (timeout, connection reset) on any call — including the irreversible final
  `PATCH {"submitted":true}` — is reported as what it is: the server state is UNKNOWN, do not
  retry, read the state first with `--verify`. It no longer surfaces as a raw traceback, and the
  old "nothing was submitted, cancel" advice for a timeout was wrong and is gone. After a PARTIAL
  failure the recovery is: cancel the orphan submission in App Store Connect, then run
  `--submit-for-review --yes` ALONE (never with `--set-demo-credentials`).

HARD RULE ENFORCED IN CODE: this script never touches listing content. Any non-GET request whose
path mentions localizations, screenshots, app info, age rating, availability, pricing or builds is
refused (see FORBIDDEN_PATH_PARTS) — the build attached to the version is never re-selected.

USAGE
  python3 scripts/release/submit_review.py                       # dry run, prints everything
  python3 scripts/release/submit_review.py --verify               # read-only status report
  python3 scripts/release/submit_review.py --pair-check           # read-only demo-pair check
  python3 scripts/release/submit_review.py --set-demo-credentials
  python3 scripts/release/submit_review.py --set-demo-credentials --submit-for-review --yes
  python3 scripts/release/submit_review.py --self-test            # offline, no network

  After a partial failure (check the state first if the fault was a network fault):
    python3 scripts/release/submit_review.py --verify
    # cancel the orphan submission in App Store Connect, then:
    python3 scripts/release/submit_review.py --submit-for-review --yes

Offline negative controls for all three refusal classes + the dry-run-writes-nothing proof:
  python3 scripts/release/submit_review_negative_control.py --list

The ASC key is passed explicitly and ambient ASC_API_KEY_ID is IGNORED on purpose: this box exports
a stale key id (6C8894PDYD) that returns 401 from every call.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
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
DEMO2_EMAIL = "demo2@spotterworkout.com"
DEMO2_PASSWORD = DEMO_PASSWORD  # the recipe creates both seats with the same password
DEFAULT_BACKUP = "/home/team/shared/asc-review-detail-backup.json"

# Appended to the reviewer notes. The existing notes are NEVER edited, reflowed or replaced: the new
# text is concatenated after the live text. Keep this string frozen — the runbook quotes it verbatim.
#
# 2026-10-05 (runbook addendum 3) — REWRITTEN SO IT CANNOT EXPIRE. The old paragraph asserted "both
# seats have logged a live-camera workout, so Home shows the partner's log in the feed and the
# weekly ring has progress"; the feed is week-scoped, so that sentence became false the moment the
# week rolled over and the reviewer would open an empty app while our own note claimed otherwise.
# The paragraph now (a) explains that the feed and ring show the current week only, (b) tells the
# reviewer to LOG A WORKOUT THEMSELVES — which lands in the feed and moves the ring in whatever week
# review actually happens, so the app proves itself with no expiry, (c) keeps the partner's log
# explicitly a same-week statement and never the sole evidence of function, and (d) says nothing
# about switching accounts, because build 30 has no in-app sign-out (and preflight refuses any other
# build id, so "this version has no sign-out" cannot silently go stale). Every factual claim in it —
# the credentials, the two-person group, the no-sign-out, the current-week scope — is verified
# before this text is written, or the script refuses.
APPEND = (
    "\n\nDemo account for review: sign in with demo@spotterworkout.com and the password "
    "SpotterDemo2026! \u2014 this version has no sign-out, so please use this account instead of "
    "creating your own. It is already in a two-person group with demo2@spotterworkout.com. The feed "
    "and the weekly ring show the current week only (Monday to Sunday), so the quickest way to see "
    "everything work is to log a workout yourself: tap the big camera button, take a front-camera "
    "selfie and a rear-camera shot of your surroundings, add one caption \u2014 the log appears in "
    "the shared feed and fills your ring right away. Your ring counts only your own logs, and any "
    "partner's log you see in the feed is this week's. The same credentials are filled into the "
    "Demo Account fields above."
)
# sha256 of the notes text as it stood on 2026-10-05 (1614 chars) — reported, warned about, never
# required: if somebody edits the notes first, the append still works, we just say so.
KNOWN_NOTES_SHA256 = "e8e364e6555f8a35bfa7edb4b958627aefec23ed253f58e23a3db599bb0beda5"
KNOWN_NOTES_CHARS = 1614

# What the notes become once APPEND is concatenated onto that 1614-char base — purely informational
# (do_verify and --pair-report print it beside the live values), regenerated 2026-10-05 for the
# rewritten paragraph. Not a gate: the live text is the source of truth.
EXPECTED_NOTES_CHARS = KNOWN_NOTES_CHARS + len(APPEND)  # 2363
EXPECTED_NOTES_SHA256 = "3fcfd3a8f18c0cbcfb7a5785cd850177b4f63665e325f9fb6d44b28c7c5533ce"

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
# Demo-pair verification — the appended paragraph asserts the pair, so the pair is READ BACK
# through the app's own client path before anything is written. Read-only: the project anon key
# (the same key the app ships) plus a password grant for each seat, then the app's own reads. No
# service-role key exists for this project by design and none is needed.
# --------------------------------------------------------------------------------------------- #
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SUPABASE_TIMEOUT = 30

# Week math — mirrors src/lib/workouts.ts:188 weekStartFor() (JS getDay(): Sun=0; (getDay()+6)%7 is
# the Monday-first index Python calls weekday()) and src/lib/settings.ts DEFAULT_WEEK_START ('Mon').
WEEK_DAY_INDEX = {"Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6}

# The app decides "this week" from the DEVICE's local clock, and the reviewer's device timezone is
# unknown, so the boundary is widened by the full ±14 h span of real UTC offsets: a log counts as
# current-week when it is at or after (this week's start − 14 h). That can never admit a log from a
# previous week's pair (those are ~7 days old), which is the failure addendum 3 is about, while it
# still accepts a legitimately-fresh log from a device anywhere on earth.
TZ_SLACK_HOURS = 14


class SupabaseFault(RuntimeError):
    """The demo pair could not be read at all (network/transport) — never a verdict about the pair."""


def supabase_config() -> tuple[str, str, str]:
    """(url, anon_key, source) — the repo's own .env first, then the ambient Expo env vars.

    The .env the app itself uses is the authority; ambient EXPO_PUBLIC_* values are only a fallback
    so the script still works from a checkout without one.
    """
    url = key = ""
    env_path = os.path.join(REPO_ROOT, ".env")
    if os.path.exists(env_path):
        with open(env_path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("EXPO_PUBLIC_SUPABASE_URL="):
                    url = line.split("=", 1)[1].strip()
                elif line.startswith("EXPO_PUBLIC_SUPABASE_ANON_KEY="):
                    key = line.split("=", 1)[1].strip()
        if url and key:
            return url, key, env_path
    url = url or os.environ.get("EXPO_PUBLIC_SUPABASE_URL", "")
    key = key or os.environ.get("EXPO_PUBLIC_SUPABASE_ANON_KEY", "")
    return url, key, "environment"


def _sb_request(method: str, url: str, path: str, anon_key: str, body: Any = None,
                token: str | None = None) -> tuple[int, Any]:
    """One Supabase/PostgREST call. HTTP errors come back as (status, payload); transport faults
    raise SupabaseFault so a network problem is never mistaken for a verdict about the data."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url + path, data=data, method=method)
    req.add_header("apikey", anon_key)
    req.add_header("Authorization", "Bearer " + (token or anon_key))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=SUPABASE_TIMEOUT) as resp:
            text = resp.read().decode()
            return resp.status, (json.loads(text) if text else {})
    except urllib.error.HTTPError as exc:
        text = exc.read().decode()
        try:
            return exc.code, json.loads(text)
        except ValueError:
            return exc.code, {"raw": text}
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        raise SupabaseFault(f"{method} {path} failed: {exc}") from exc


def week_start_utc(now: datetime, week_start_day: str) -> datetime:
    """This week's start (UTC midnight) for a week_start_day label — the same arithmetic the app
    uses, minus the device's local timezone, which the widened window below accounts for."""
    day = WEEK_DAY_INDEX.get(week_start_day, 1)
    d = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    delta = d.weekday() - ((day + 6) % 7)
    if delta < 0:
        delta += 7
    return d - timedelta(days=delta)


def probe_demo_pair(now: datetime | None = None) -> dict[str, Any]:
    """Read the demo pair's real state. Returns facts + a list of problems; never raises for a
    verdict, only SupabaseFault when the read itself failed."""
    now = now or datetime.now(timezone.utc)
    url, key, source = supabase_config()
    state: dict[str, Any] = {"ok": False, "problems": [], "facts": {}, "source": source, "url": url}
    facts = state["facts"]
    problems = state["problems"]

    if not url or not key:
        problems.append("no Supabase URL/anon key (looked in the repo .env, then the environment)")
        return state

    status, body = _sb_request("GET", url, "/auth/v1/settings", key)
    facts["mailer_autoconfirm"] = body.get("mailer_autoconfirm") if isinstance(body, dict) else None
    if status != 200:
        problems.append(f"could not read /auth/v1/settings (HTTP {status})")
    elif facts["mailer_autoconfirm"] is not True:
        # The notes we preserve verbatim say "sign-up needs no email confirmation" and the reviewer
        # is handed a password sign-in: both are false if confirmation is on.
        problems.append("mailer_autoconfirm is not true — the notes' 'no email confirmation' claim "
                        "and the demo password sign-in would both be false")

    tokens: dict[str, str] = {}
    for label, email in (("demo", DEMO_EMAIL), ("demo2", DEMO2_EMAIL)):
        status, body = _sb_request("POST", url, "/auth/v1/token?grant_type=password", key,
                                   {"email": email, "password": DEMO_PASSWORD})
        if status != 200:
            code = ""
            if isinstance(body, dict):
                code = body.get("error_code") or body.get("error") or body.get("error_description") or ""
            problems.append(f"{email} password sign-in failed (HTTP {status}{': ' + str(code) if code else ''}) "
                            f"— that account does not exist yet or its password is not the one the notes give")
            continue
        tokens[label] = body.get("access_token", "")
        facts[f"{label}_user_id"] = (body.get("user") or {}).get("id")

    demo_id = facts.get("demo_user_id")
    demo2_id = facts.get("demo2_user_id")
    if not demo_id or not demo2_id:
        return state

    status, body = _sb_request("POST", url, "/rest/v1/rpc/my_group", key, {}, tokens["demo"])
    if status != 200:
        problems.append(f"my_group() refused for {DEMO_EMAIL} (HTTP {status}) — cannot verify the "
                        f"group at all")
        return state
    gid = body.get("group_id") if isinstance(body, dict) else None
    co_members = list((body or {}).get("member_ids") or []) if isinstance(body, dict) else []
    facts["group_id"] = gid
    facts["co_member_ids"] = co_members
    if not gid:
        problems.append(f"{DEMO_EMAIL} is not in a shared group (my_group() returned null) — the "
                        f"two accounts exist but they are not paired")
        return state
    # The paragraph names demo2@ as the partner and says TWO-person group: a trio or a different
    # partner makes that sentence false even though a group exists.
    if co_members != [demo2_id]:
        problems.append(f"the group is not the demo duo: co-members are {co_members or []}, expected "
                        f"exactly ['{demo2_id}'] ({DEMO2_EMAIL})")

    status, body = _sb_request("GET", url, f"/rest/v1/users?select=week_start_day&id=eq.{demo_id}",
                               key, token=tokens["demo"])
    week_day = "Mon"
    if status == 200 and isinstance(body, list) and body:
        week_day = body[0].get("week_start_day") or "Mon"
    else:
        problems.append(f"could not read {DEMO_EMAIL}'s own users row (HTTP {status}) — the week "
                        f"boundary cannot be established (which is why an app user's own settings "
                        f"row must exist before review)")
    window_start = week_start_utc(now, week_day) - timedelta(hours=TZ_SLACK_HOURS)
    facts["week_start_day"] = week_day
    facts["week_window_start"] = window_start.isoformat()

    query = (f"/rest/v1/workouts?select=user_id,logged_at&user_id=in.({demo_id},{demo2_id})"
             f"&logged_at=gte.{urllib.parse.quote(window_start.isoformat())}&limit=200")
    status, rows = _sb_request("GET", url, query, key, token=tokens["demo"])
    if status != 200 or not isinstance(rows, list):
        problems.append(f"could not read this week's workouts as {DEMO_EMAIL} (HTTP {status})")
        return state
    # This IS the feed's own read, run as the demo account (RLS: own rows + co-member rows of a
    # shared group, exactly the app's `.in('user_id', allUserIds)`), so a partner row appearing here
    # is proof the reviewer will see it — and a partner row NOT appearing here means they won't.
    own = [r for r in rows if r.get("user_id") == demo_id]
    partner = [r for r in rows if r.get("user_id") == demo2_id]
    facts["demo_week_logs"] = len(own)
    facts["demo2_week_logs"] = len(partner)
    if not own:
        problems.append(f"{DEMO_EMAIL} has no workout in the current week — log one from that seat")
    if not partner:
        problems.append(f"{DEMO2_EMAIL} has no workout visible to {DEMO_EMAIL} in the current week "
                        f"— log one from that seat (this is the stale-week failure: rows from a "
                        f"previous week do not count)")
    state["ok"] = not problems
    return state


def print_pair_report(state: dict[str, Any]) -> None:
    f = state.get("facts", {}) or {}
    print(f"[demo pair] supabase {state.get('url') or '(none configured)'} "
          f"(config from {state.get('source')})")
    print(f"[demo pair] mailer_autoconfirm={f.get('mailer_autoconfirm')}")
    print(f"[demo pair] {DEMO_EMAIL} user_id={f.get('demo_user_id')} · "
          f"{DEMO2_EMAIL} user_id={f.get('demo2_user_id')}")
    print(f"[demo pair] group={f.get('group_id')} co-members={f.get('co_member_ids')} "
          f"week_start_day={f.get('week_start_day')}")
    print(f"[demo pair] current-week logs visible to {DEMO_EMAIL}: own={f.get('demo_week_logs')} "
          f"partner={f.get('demo2_week_logs')} (week window from "
          f"{f.get('week_window_start')}, {TZ_SLACK_HOURS}h slack)")
    for p in state.get("problems", []):
        print(f"[demo pair]   !! {p}")
    print("[demo pair] VERIFIED — the paragraph we append may assert this pair"
          if state.get("ok") else
          "[demo pair] NOT VERIFIED — the script will refuse to write the paragraph")


def require_demo_pair(probe: Callable[[], dict[str, Any]] | None = None) -> dict[str, Any]:
    """Verify-and-refuse. Resolved at CALL time so an offline harness can substitute the probe."""
    probe = probe or probe_demo_pair
    try:
        state = probe()
    except SupabaseFault as exc:
        raise SystemExit(
            f"REFUSING: the demo pair could not be read, so the appended paragraph's claim about it "
            f"cannot be verified — {exc}. Nothing was written. Re-run when the project is "
            f"reachable (or use the runbook's UI path)."
        )
    print_pair_report(state)
    if not state.get("ok"):
        raise SystemExit(
            "REFUSING: the demo pair is not verified as the reviewer paragraph describes it "
            "(absent account, ungrouped, wrong partner, or no log in the CURRENT week). Nothing was "
            "written to Apple. Fix the pair (owner-phone-session-2026-10-05.md part 2), re-check "
            "with `--pair-check`, and run again."
        )
    return state


# --------------------------------------------------------------------------------------------- #
# ASC transport (mirrors /home/team/.ios-creds/asc_api.py — kept local so the script is runnable
# from the repo without importing a helper that lives outside it).
# --------------------------------------------------------------------------------------------- #
class TransportError(RuntimeError):
    """A request that got no HTTP answer at all: timeout, DNS/connection fault, reset.

    It is NOT a failure verdict. For a GET the caller can simply retry; for the irreversible
    `submitted:true` PATCH the server state is genuinely UNKNOWN and the only safe move is to read
    the state back. Kept separate from an HTTP error response (which the server did answer).
    """


class Asc:
    def __init__(self, key_path: str, key_id: str, issuer_id: str, *, dry_run: bool,
                 send: Callable[..., tuple[int, Any]] | None = None,
                 token: Callable[[], str] | None = None) -> None:
        self.key_path = key_path
        self.key_id = key_id
        self.issuer_id = issuer_id
        self.dry_run = dry_run
        self._send = send or self._http
        # Injected only by the offline checks, so they need no real .p8 and no network.
        self._token = token or self._jwt
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
            # The server ANSWERED — a definite verdict (403/409/…), handled by the caller.
            text = exc.read().decode()
            try:
                return exc.code, json.loads(text)
            except ValueError:
                return exc.code, {"raw": text}
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
            # No answer at all. Never let this surface as a raw traceback (the 2026-10-05 defect):
            # raise something the callers can phrase honestly, because whether the request was
            # applied is unknown.
            raise TransportError(f"{method} {url} got no response: {exc}") from exc

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
        status, payload = self._send(method, url, body, self._token())
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


def do_set_demo_credentials(asc: Asc, backup_path: str,
                            probe: Callable[[], dict[str, Any]] | None = None) -> int:
    # GATE 1 (before anything at all is written, and before the backup): the paragraph we are about
    # to append says the demo account is in a two-person group with demo2@. Read that back first —
    # the old code asserted it and never checked. Refusal here writes nothing, including no backup.
    require_demo_pair(probe)

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
    if asc.dry_run:
        # A dry run writes NOTHING — no backup file, no notes file, no temp state. The old code
        # wrote the backup here unconditionally, so a dry run clobbered the real backup.
        print(f"[backup] DRY RUN — would write {backup_path} (not written; a dry run writes nothing)")
    else:
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


def do_submit_for_review(asc: Asc, assume_yes: bool,
                         probe: Callable[[], dict[str, Any]] | None = None) -> int:
    if not assume_yes:
        raise SystemExit(
            "--submit-for-review needs --yes as well: the final PATCH puts version 1.0 into App "
            "Review and cannot be undone from here."
        )
    preflight(asc)

    # GATE 2: the reviewer note may have been written days ago, and the feed is week-scoped. Re-read
    # the pair IN THE CURRENT WEEK here, immediately before the irreversible PATCH — a pair that was
    # fresh when the notes were written can be a week stale by now (runbook addendum 3, rule 1).
    require_demo_pair(probe)

    create = {"data": {"type": "reviewSubmissions",
                       "attributes": {"platform": "IOS"},
                       "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}}
    try:
        status, body = asc.call("POST", "/reviewSubmissions", create)
    except TransportError as exc:
        # No submission id yet, but the POST may still have created one — state unknown.
        raise SystemExit(_unknown_state_note("C1 (create review submission)", str(exc), None))
    if asc.dry_run:
        print("[dry run] would create a review submission and add version 1.0 to it, then PATCH "
              "submitted:true.\n")
        return 0
    if status not in (200, 201):
        raise SystemExit(f"POST /reviewSubmissions was refused with HTTP {status} — no submission "
                         f"was created and nothing was submitted. Re-read the error, fix it, and "
                         f"run --submit-for-review --yes again.")
    submission_id = body["data"]["id"]
    print(f"[c1] review submission {submission_id} state={body['data']['attributes'].get('state')}")

    item = {"data": {"type": "reviewSubmissionItems",
                     "relationships": {
                         "reviewSubmission": {"data": {"type": "reviewSubmissions",
                                                       "id": submission_id}},
                         "appStoreVersion": {"data": {"type": "appStoreVersions",
                                                      "id": VERSION_ID}}}}}
    try:
        status, body = asc.call("POST", "/reviewSubmissionItems", item)
    except TransportError as exc:
        raise SystemExit(_unknown_state_note("C2 (attach version 1.0)", str(exc), submission_id))
    if status not in (200, 201):
        raise SystemExit(
            f"POST /reviewSubmissionItems was refused with HTTP {status} — version 1.0 was NOT "
            f"attached, so nothing was submitted. Read the error, then recover with the two steps "
            f"below (do NOT re-run the whole helper).\n"
            + _recovery_after_partial(f"review submission {submission_id} exists un-submitted")
        )
    print(f"[c2] item {body['data']['id']} attached to {submission_id}")

    submit = {"data": {"type": "reviewSubmissions", "id": submission_id,
                       "attributes": {"submitted": True}}}
    try:
        status, body = asc.call("PATCH", f"/reviewSubmissions/{submission_id}", submit)
    except TransportError as exc:
        # THE DEFECT THIS REPLACES: the old code let a timeout fall through as a traceback, and the
        # old message for an HTTP failure said "nothing was submitted, cancel" — which is FALSE
        # advice after a timeout. We do not know whether it was applied.
        raise SystemExit(_unknown_state_note("C3 (PATCH submitted:true — IRREVERSIBLE)",
                                             str(exc), submission_id))
    if status != 200:
        # The server DID answer and refused: nothing was submitted. The submission row still exists
        # un-submitted, and the recovery is not simply "run the same command again".
        raise SystemExit(
            f"PATCH submitted:true was refused with HTTP {status} — version 1.0 was NOT submitted.\n"
            + _recovery_after_partial(f"review submission {submission_id} exists un-submitted")
        )
    print(f"[c3] state={body['data']['attributes'].get('state')} "
          f"submittedDate={body['data']['attributes'].get('submittedDate')}")
    return 0


def _recovery_after_partial(what: str) -> str:
    """The true next action after a partial failure (runbook addendum 2, 'retry is not the one
    command'): cancel the orphan, then submit ALONE."""
    return (
        f"The state is KNOWN, not unknown: {what}.\n"
        f"  1. Cancel it in App Store Connect — SPOTTER → App Store → version 1.0 (an un-submitted\n"
        f"     review submission is also cancellable via PATCH /v1/reviewSubmissions/<id>\n"
        f"     with {{\"canceled\": true}}). Left in place, it blocks every retry: preflight refuses\n"
        f"     while a submission exists for this app.\n"
        f"  2. Then run the submit step on its own:\n"
        f"         python3 scripts/release/submit_review.py --submit-for-review --yes\n"
        f"     Do NOT add --set-demo-credentials: the reviewer paragraph is already in the notes\n"
        f"     and a second run refuses on the already-appended guard."
    )


def _unknown_state_note(step: str, detail: str, submission_id: str | None) -> str:
    """A request that got no answer. The server state is UNKNOWN — say so, and say how to read it."""
    return (
        f"\n*** NETWORK FAULT at {step}: {detail}\n"
        f"*** Apple never answered, so whether this call was applied is UNKNOWN — it may have\n"
        f"*** succeeded, partly succeeded, or done nothing at all.\n"
        f"*** DO NOT RETRY and DO NOT re-run this helper. Read the state first; that is read-only\n"
        f"*** and safe at any time:\n"
        f"***     python3 scripts/release/submit_review.py --verify\n"
        f"*** It prints version 1.0's appStoreState and every review submission for this app with\n"
        f"*** its state and submittedDate. Cross-check it in App Store Connect too (SPOTTER →\n"
        f"*** App Store → 1.0).\n"
        f"***   · version WAITING_FOR_REVIEW / IN_REVIEW, or a submission with a submittedDate:\n"
        f"***     it WAS submitted. Nothing further to do here — go to runbook section 6.\n"
        f"***   · a submission exists with state READY_FOR_REVIEW and no submittedDate" +
        (f" ({submission_id})" if submission_id else "") + ": it is an un-submitted\n"
        f"***     orphan. Cancel it, then run the submit step ALONE:\n"
        f"         python3 scripts/release/submit_review.py --submit-for-review --yes\n"
        f"***     (never with --set-demo-credentials).\n"
        f"***   · nothing exists and 1.0 is PREPARE_FOR_SUBMISSION: nothing happened; you may run\n"
        f"***     --submit-for-review --yes once from a healthy connection."
    )


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
    print(f"              (an append onto the 1614-char base text gives {EXPECTED_NOTES_CHARS} "
          f"chars, sha {EXPECTED_NOTES_SHA256})")
    if rd.get("contactEmail") != "erishasmith0723@gmail.com":
        print("WARNING: review contact email changed since 2026-10-05")

    subs = read_submissions(asc)
    print(f"review submissions: {len(subs)}")
    for s in subs:
        a = s["attributes"]
        print(f"  {s['id']} state={a.get('state')} submittedDate={a.get('submittedDate')} "
              f"items={len(s.get('relationships', {}).get('items', {}).get('data', []) or [])}")

    # Read-only demo-pair status — the same check the two gates run before writing anything, shown
    # here so it can be inspected at any time (it does not change this command's exit code).
    try:
        print_pair_report(probe_demo_pair())
    except SupabaseFault as exc:
        print(f"[demo pair] could not be read ({exc}) — the write gates would refuse")
    return 0


def do_pair_check() -> int:
    """--pair-check: the demo-pair gate on its own, read-only, non-zero exit when it fails."""
    state = require_demo_pair()
    logs = f"{state['facts'].get('demo_week_logs')}/{state['facts'].get('demo2_week_logs')}"
    print(f"\nPAIR CHECK OK — both seats have a log in the current week ({logs}).")
    return 0


# --------------------------------------------------------------------------------------------- #
# Offline self-test: proves the dry run sends nothing AND writes nothing, the guard refuses listing
# writes, the demo-pair gate refuses each broken state, and a network fault is never reported as a
# verdict. Never touches the network (the Supabase probe is injected; the ASC sender is injected).
# --------------------------------------------------------------------------------------------- #
TEST_DETAIL_ATTRS: dict[str, Any] = {
    "notes": "OLD", "demoAccountName": None, "demoAccountPassword": None,
    "demoAccountRequired": False, "contactEmail": "x@y.z",
    "contactFirstName": "A", "contactLastName": "B", "contactPhone": "1",
}


def pair_fixture(ok: bool, problem: str = "", **fact_overrides: Any) -> dict[str, Any]:
    """A state shaped exactly like probe_demo_pair()'s return value, for the offline checks."""
    facts: dict[str, Any] = {
        "mailer_autoconfirm": True, "demo_user_id": "d1", "demo2_user_id": "d2",
        "group_id": "g1", "co_member_ids": ["d2"], "week_start_day": "Mon",
        "week_window_start": "2026-10-04T10:00:00+00:00",
        "demo_week_logs": 1, "demo2_week_logs": 1,
    }
    facts.update(fact_overrides)
    return {"ok": ok, "problems": [] if ok else [problem or "fixture problem"],
            "facts": facts, "source": "fixture", "url": "https://fixture.invalid"}


def self_test() -> int:
    calls: list[tuple[str, str]] = []

    def fake_send(method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        calls.append((method, url))
        if url.endswith("/appStoreReviewDetail"):
            return 200, {"data": {"id": REVIEW_DETAIL_ID, "attributes": dict(TEST_DETAIL_ATTRS)}}
        if "reviewSubmissions?" in url:
            return 200, {"data": []}
        raise AssertionError(f"unexpected non-GET in dry run: {method} {url}")

    asc = Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID, dry_run=True,
              send=fake_send, token=lambda: "offline")

    failures = []

    # 1. dry-run writes nothing to Apple (and, since 2026-10-05, nothing to disk either)
    tmpdir = tempfile.mkdtemp(prefix="selftest-submit-review-")
    backup_path = os.path.join(tmpdir, "backup.json")
    do_set_demo_credentials(asc, backup_path, probe=lambda: pair_fixture(True))
    if [c for c in calls if c[0] != "GET"]:
        failures.append(f"dry run issued a write: {calls}")
    if os.listdir(tmpdir):
        failures.append(f"dry run wrote files: {os.listdir(tmpdir)}")
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
    # 1b. with a LIVE asc object the backup must be written — otherwise check 1 would pass for the
    # wrong reason (a guard that never writes proves nothing about a guard that refuses to write).
    stored = dict(TEST_DETAIL_ATTRS)

    def live_send(method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        live_calls.append((method, url))
        if method == "GET" and url.endswith("/appStoreReviewDetail"):
            return 200, {"data": {"id": REVIEW_DETAIL_ID, "attributes": dict(stored)}}
        if method == "PATCH" and "appStoreReviewDetails" in url:
            stored.update(body["data"]["attributes"])
            return 200, {"data": {"id": REVIEW_DETAIL_ID, "attributes": dict(stored)}}
        raise AssertionError(f"unexpected call in the live check: {method} {url}")

    live_calls: list[tuple[str, str]] = []
    live_asc = Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID, dry_run=False,
                   send=live_send, token=lambda: "offline")
    do_set_demo_credentials(live_asc, backup_path, probe=lambda: pair_fixture(True))
    if not os.path.exists(backup_path):
        failures.append("a live run did NOT write the backup (the dry-run proof would be vacuous)")
    else:
        os.remove(backup_path)
    if os.listdir(tmpdir):
        failures.append("backup file left behind after the live check")
    os.rmdir(tmpdir)

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
                                 dry_run=True, send=fake_send, token=lambda: "offline"),
                             assume_yes=False, probe=lambda: pair_fixture(True))
        failures.append("--submit-for-review ran without --yes")
    except SystemExit:
        pass

    # 4. appending twice is refused
    try:
        build_notes("OLD" + APPEND)
        failures.append("build_notes appended twice")
    except SystemExit:
        pass

    # 5. the append starts with a blank line and its length is pinned (an accidental edit to the
    # reviewer paragraph has to fail here, because the runbook quotes this text verbatim)
    if not APPEND.startswith("\n\n"):
        failures.append("APPEND must start with a blank line")
    if len(APPEND) != 749:
        failures.append(f"APPEND is {len(APPEND)} chars, expected 749")
    for banned in ("both seats have logged", "your partner's log is already", "sign out to"):
        if banned in APPEND.lower():
            failures.append(f"APPEND reinstates a week-fragile/account-switching claim: {banned!r}")
    if "log a workout yourself" not in APPEND:
        failures.append("APPEND must tell the reviewer to log a workout themselves")
    if "current week" not in APPEND:
        failures.append("APPEND must say the feed/ring are current-week scoped")

    # 6. the demo-pair gate refuses each broken state and accepts the good one. These are the three
    # refusal classes the runbook names (absent / ungrouped / stale-week) plus the wrong-partner case.
    broken = {
        "absent account (no user ids, sign-in failed)":
            pair_fixture(False, "demo@ password sign-in failed", demo_user_id=None, demo2_user_id=None,
                         group_id=None, co_member_ids=[], demo_week_logs=None, demo2_week_logs=None),
        "ungrouped (two accounts, no shared group)":
            pair_fixture(False, "not in a shared group", group_id=None, co_member_ids=[],
                         demo_week_logs=1, demo2_week_logs=0),
        "stale week (logs exist, but not in the current week)":
            pair_fixture(False, "no workout in the current week", demo_week_logs=0, demo2_week_logs=0),
        "partner stale (only one seat logged this week)":
            pair_fixture(False, "partner has no workout in the current week",
                         demo_week_logs=2, demo2_week_logs=0),
        "wrong partner (a co-member who is not demo2@)":
            pair_fixture(False, "not the demo duo", co_member_ids=["d9"]),
        "trio (not a two-person group)":
            pair_fixture(False, "not the demo duo", co_member_ids=["d2", "d9"]),
        "email confirmation ON":
            pair_fixture(False, "mailer_autoconfirm is not true", mailer_autoconfirm=False),
    }
    for label, state in broken.items():
        try:
            require_demo_pair(probe=lambda s=state: s)
            failures.append(f"the pair gate PASSED a broken state: {label}")
        except SystemExit:
            pass
    try:
        require_demo_pair(probe=lambda: pair_fixture(True))
    except SystemExit:
        failures.append("the pair gate refused a good state (it would never let a submission through)")

    # 6b. the gate must run BEFORE anything is written: a refused pair means no backup, no PATCH.
    before = list(asc._planned)
    refused_tmp = tempfile.mkdtemp(prefix="selftest-refused-")
    try:
        do_set_demo_credentials(asc, os.path.join(refused_tmp, "b.json"),
                                probe=lambda: pair_fixture(False, "stale week"))
        failures.append("a refused pair still ran do_set_demo_credentials")
    except SystemExit:
        pass
    if os.listdir(refused_tmp):
        failures.append(f"a refused pair still wrote {os.listdir(refused_tmp)}")
    if asc._planned != before:
        failures.append("a refused pair still planned a PATCH")
    os.rmdir(refused_tmp)

    # 7. a NETWORK FAULT on the final PATCH is reported as UNKNOWN state, never as "nothing was
    # submitted", and never as a traceback. The pre-fix code let a timeout escape as a traceback and
    # told the operator "nothing was submitted, cancel" — which is false after a timeout.
    def fault_send(method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        if method == "GET" and "appStoreVersions/" in url and "include=build" in url:
            return 200, {"data": {"id": VERSION_ID, "attributes": {
                "appStoreState": "PREPARE_FOR_SUBMISSION", "appVersionState": "PREPARE_FOR_SUBMISSION"}},
                "included": [{"id": EXPECTED_BUILD_ID, "attributes": {
                    "version": EXPECTED_BUILD_NUMBER, "processingState": "VALID", "expired": False,
                    "expirationDate": "2026-12-28T07:06:18-08:00"}}]}
        if method == "GET" and "reviewSubmissions?" in url:
            return 200, {"data": []}
        if method == "POST" and url.endswith("/reviewSubmissions"):
            return 201, {"data": {"id": "SUB-FAKE", "attributes": {"state": "READY_FOR_REVIEW"}}}
        if method == "POST" and url.endswith("/reviewSubmissionItems"):
            return 201, {"data": {"id": "ITEM-FAKE", "attributes": {}}}
        if method == "PATCH" and url.endswith("/reviewSubmissions/SUB-FAKE"):
            raise TransportError("PATCH .../reviewSubmissions/SUB-FAKE got no response: timed out")
        raise AssertionError(f"unexpected call in the fault test: {method} {url}")

    fault_asc = Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID, dry_run=False,
                    send=fault_send, token=lambda: "offline")
    timeout_msg = ""
    try:
        do_submit_for_review(fault_asc, assume_yes=True, probe=lambda: pair_fixture(True))
        failures.append("a network fault on the final PATCH did not stop the run")
    except SystemExit as exc:
        timeout_msg = str(exc)
    for needed in ("UNKNOWN", "DO NOT RETRY", "--verify", "READY_FOR_REVIEW",
                   "python3 scripts/release/submit_review.py --submit-for-review --yes"):
        if needed not in timeout_msg:
            failures.append(f"the timeout message is missing {needed!r}")
    for wrong in ("Nothing was submitted", "nothing was submitted"):
        if wrong in timeout_msg:
            failures.append(f"the timeout message still says {wrong!r} (the pre-fix wrong advice)")

    # 7b. an HTTP REFUSAL on C2/C3 is a known state, and its advice is the two real steps.
    def refuse_send(method: str, url: str, body: Any, token: str) -> tuple[int, Any]:
        if method == "PATCH" and "reviewSubmissions" in url:
            return 403, {"errors": [{"detail": "FORBIDDEN_ERROR"}]}
        return fault_send(method, url, body, token)

    refuse_msg = ""
    try:
        do_submit_for_review(
            Asc(DEFAULT_KEY_PATH, DEFAULT_KEY_ID, DEFAULT_ISSUER_ID, dry_run=False,
                send=refuse_send, token=lambda: "offline"), assume_yes=True,
            probe=lambda: pair_fixture(True))
        failures.append("an HTTP refusal on the final PATCH did not stop the run")
    except SystemExit as exc:
        refuse_msg = str(exc)
    for needed in ("was refused with HTTP 403", "Cancel it in App Store Connect",
                   "--submit-for-review --yes", "Do NOT add --set-demo-credentials"):
        if needed not in refuse_msg:
            failures.append(f"the partial-failure message is missing {needed!r}")
    if "UNKNOWN" in refuse_msg:
        failures.append("an answered HTTP refusal was reported as an unknown state")

    # 8. a Supabase transport fault refuses cleanly instead of dumping a traceback
    def fault_probe() -> dict[str, Any]:
        raise SupabaseFault("POST /auth/v1/token failed: timed out")
    try:
        require_demo_pair(probe=fault_probe)
        failures.append("a Supabase transport fault did not refuse")
    except SystemExit as exc:
        if "could not be read" not in str(exc):
            failures.append("the Supabase transport fault message is not honest about the cause")

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("SELF-TEST PASSED: 11 check groups — dry run sent 0 writes and wrote 0 files, guard "
          "refused 7 listing paths, pair gate refused 7 broken states and passed 1 good one, "
          "timeout reported as UNKNOWN state")
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
    ap.add_argument("--pair-check", action="store_true",
                    help="read-only: verify the demo pair is present, grouped and logged in the "
                         "current week (exits non-zero when it is not)")
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

    # --pair-check is read-only and needs no ASC key, so it runs before the transport is built.
    if args.pair_check:
        try:
            return do_pair_check()
        except SystemExit as exc:
            if str(exc):
                print(str(exc))
            return 1

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
    except TransportError as exc:
        # A call got no answer at all (the 2026-10-05 defect: this used to escape as a traceback).
        # Whether it was applied is unknown, so say that instead of pretending it failed.
        print(f"\nNETWORK FAULT: {exc}\nThe server state is UNKNOWN — the request may or may not "
              f"have been applied. Do not retry blindly: read the state first with\n"
              f"    python3 scripts/release/submit_review.py --verify")
        return 1
    except urllib.error.URLError as exc:
        print(f"\nNETWORK FAULT: {exc}\nThe server state is UNKNOWN — run --verify before retrying.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
