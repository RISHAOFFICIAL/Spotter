#!/usr/bin/env python3
"""Provision the App Review demo pair server-side (runbook "path D") — DRY RUN BY DEFAULT.

WHY THIS EXISTS
  The reviewer-notes paragraph the submission helper appends asserts that
  demo@spotterworkout.com sits in a two-person group with demo2@spotterworkout.com. Verified by
  direct production reads on 2026-10-05: those two accounts have NEVER existed (zero rows in
  auth.users), so at some point in the submission week both accounts AND their pairing have to be
  created. Doing it by hand on a phone costs a second device or a seat switch (build 30 has no
  in-app sign-out); doing it here costs nothing but the owner's real workout logs — the one thing
  that must not be fabricated, and the one thing this script deliberately does NOT create.

WHAT IT DOES (and what it never does)
  * creates demo@ and demo2@ as ALREADY EMAIL-CONFIRMED auth users through the Supabase Auth admin
    API, so the reviewer can sign in immediately (no confirmation mail, no pending state);
  * onboards each seat exactly the way the APP onboards itself (users row -> personal group ->
    membership), because `groups.creator_id` and `memberships.user_id` are FKs to public.users and
    nothing mirrors auth.users -> public.users (settings.ts:61-80 says the same thing);
  * pairs them through the app's OWN invite path: an `invites` row created by the inviter, then
    `join_group(token)` called by the joiner — the same two calls src/lib/invites.ts makes;
  * READS BACK the result (one group, exactly the two demo seats) and reports how many current-week
    logs each seat has — which will be ZERO until the owner records them.

  It never creates a workout, never uploads a photo, never touches the listing, EAS, App Store
  Connect, storage, or any row belonging to anybody who is not one of the two demo accounts.

TRANSPORTS — both behind a small interface so both can be stubbed
  A) SupabaseAdminAuth — the service_role admin surface:
       GET  {SUPABASE_URL}/auth/v1/admin/users        (preflight + "who already exists")
       POST {SUPABASE_URL}/auth/v1/admin/users        (create an email-confirmed user)
       GET  {SUPABASE_URL}/rest/v1/<table>            (service_role reads: RLS bypassed, read-only)
  B) GroupFormation — the app's own path (mirrored from supabase/schema.sql + src/lib/*.ts):
       POST {SUPABASE_URL}/auth/v1/token?grant_type=password   -> seat session (what the app does
            at sign-in; the app never uses a service key for its own writes)
       POST {SUPABASE_URL}/rest/v1/users?on_conflict=id        (src/lib/settings.ts:75-80)  upsert
       GET  {SUPABASE_URL}/rest/v1/groups?select=id&creator_id=eq.<uid>   (settings.ts:86-89)
       POST {SUPABASE_URL}/rest/v1/groups                     (settings.ts:93-96)  {name:'Personal'}
       POST {SUPABASE_URL}/rest/v1/memberships?on_conflict=group_id,user_id
                                                              (settings.ts:106-114) {weekly_goal, role:'admin'}
       POST {SUPABASE_URL}/rest/v1/invites?on_conflict=token   (src/lib/invites.ts:145-148)
       POST {SUPABASE_URL}/rest/v1/rpc/join_group              (src/lib/invites.ts:316 -> schema.sql:619)
  Both transports take `send=` (default `http_send`) and resolve it at CONSTRUCTION time, so a
  harness can replace the module-level `http_send` and no byte leaves the process.

THE EXACT CALLS, IN ORDER, AND THE IDS THEY THREAD  (apply mode, from scratch)
   1. GET  /auth/v1/admin/users?page=1&per_page=200      service_role   -> who exists (preflight)
   2. (service reads of memberships / invites when a demo account already exists — conflict checks)
   3. POST /auth/v1/admin/users  {email, password, email_confirm:true}   x2
        -> auth_id(demo), auth_id(demo2).  THE PUBLIC id each seat depends on: public.users.id
           (= auth.users.id), then groups.creator_id, memberships.user_id, invites.inviter_id.
   4. POST /auth/v1/token?grant_type=password   (demo@)  -> access_token(demo)  [session, not data]
   5. POST /rest/v1/users?on_conflict=id        (demo@)  body {id: auth_id(demo), name, week_start_day, timezone}
   6. GET  /rest/v1/groups?select=id&creator_id=eq.auth_id(demo)   (demo@)
   7. POST /rest/v1/groups  {name:'Personal', creator_id: auth_id(demo)} -> personal_group_id(demo)
   8. POST /rest/v1/memberships?on_conflict=group_id,user_id  {user_id, group_id: personal_group_id, weekly_goal:3, role:'admin'}
   9-12. the same four steps for demo2@
  13. POST /rest/v1/invites?on_conflict=token  (demo@)  {inviter_id: auth_id(demo), token: <8 chars>}
  14. POST /rest/v1/rpc/join_group  {p_token: <same 8 chars>}  (demo2@)
        -> schema.sql:647-668: the inviter is still solo, so join_group CREATES the group
           "{Demo} & {Demo2}" (creator = demo@, inviter seated with their own goal copied) and then
           seats demo2@ with weekly_goal 3. That single RPC is the whole pairing — one two-person
           group, no third party, no new table, no new policy.
  15. verify (service reads): exactly one shared group, exactly the two demo seats in it; plus the
      current-week log count per seat (informational — the owner's step).

THE INVITE TOKEN comes from the APP's alphabet (`INVITE_CODE_ALPHABET` in src/lib/invites.ts:
  A-Z minus I/L/O plus 2-9) and the token column / RPC name / capacity function are read out of
  supabase/schema.sql at run time — the script refuses to guess the app's contract, and fails loudly
  if the schema stops matching what it mirrors.

DRY RUN IS THE DEFAULT. With no flags it prints every request it WILL make (method, path, headers
  with values masked, body with passwords/tokens masked/g) and exits 0 having sent NOTHING — not a
  read, not a write, no file on disk. `--preflight` is the read-only check (GETs only) that says
  whether provisioning is safe to run; it never writes.

HOW TO TURN WRITES ON (two independent locks, neither trippable by accident):
    python3 scripts/release/provision_demo_pair.py --preflight                 # read-only
    SPOTTER_DEMO_PAIR_APPLY=I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION \
      python3 scripts/release/provision_demo_pair.py --apply                   # LIVE
  BOTH the literal flag and the exact opt-in env value are required. Either one alone is inert: with
  no --apply it is a dry run, and with --apply but no opt-in value it refuses (exit 13) BEFORE the
  first request. `--dry-run` forces a dry run even alongside --apply.

REFUSALS (each with its own exit code; none of them writes anything)
  10  the credential is missing, malformed, not a service_role key, or rejected by the preflight
      (missing/malformed/not-service_role send ZERO requests — they are decided locally)
  11  a demo account already exists in a conflicting shape: exactly one of the two, an unconfirmed
      account, or a demo account already seated in a shared group with somebody who is not the
      other demo seat
  12  the run would touch a row that is not one of the two demo users (an invite token already owned
      by a third party, a session that resolves to a foreign uid, or any id that fails the
      assert-demo-target invariant before it reaches a request body)
  13  --apply without the env opt-in value (zero requests sent)
  14  a transport fault / unexpected HTTP status (the remote state is then UNKNOWN — re-run
      --preflight before retrying anything)
  Exit 2 is an argparse usage error and is also used when the repo's own contract checks fail
  (schema.sql no longer defines join_group, the app's invite alphabet moved, or this script's
  credentials no longer match the ones scripts/release/submit_review.py writes into the review note).

OUTPUT HYGIENE IS STRUCTURAL, not a habit
  Every line the script prints goes through a redactor that masks (a) any known secret — the
  service_role key, the anon key, the demo password, any access token, any invite token — (b) every
  JWT-shaped string, (c) every uuid, and (d) every email other than the two demo addresses. A uuid
  or a stranger's address cannot reach the terminal even by accident.

WHAT THIS SCRIPT DOES NOT DO
  It does not create the owner's workout logs. `submit_review.py --pair-check` demands a log in the
  CURRENT week from EACH seat, so after this script runs the owner still has to produce them (and
  re-run --pair-check in the same week as the submission). Nothing here bypasses that gate.

USAGE
  python3 scripts/release/provision_demo_pair.py                    # dry run: print the plan
  python3 scripts/release/provision_demo_pair.py --preflight        # read-only go/no-go
  python3 scripts/release/provision_demo_pair.py --self-test        # offline, no network
  python3 scripts/release/provision_demo_pair_negative_control.py --list
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

# --------------------------------------------------------------------------------------------- #
# Paths and the app contract this script mirrors.
# --------------------------------------------------------------------------------------------- #
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(_SCRIPT_DIR))
SCHEMA_PATH = os.path.join(REPO_ROOT, "supabase", "schema.sql")
INVITES_TS_PATH = os.path.join(REPO_ROOT, "src", "lib", "invites.ts")
SUBMIT_REVIEW_PATH = os.path.join(_SCRIPT_DIR, "submit_review.py")

SUPABASE_TIMEOUT = 20

DEMO_EMAIL = "demo@spotterworkout.com"
DEMO2_EMAIL = "demo2@spotterworkout.com"
DEMO_PASSWORD = "SpotterDemo2026!"        # must equal submit_review.DEMO_PASSWORD (checked)
DEMO_NAME = "Demo"                        # users.name; split_part(name,' ',1) is the group label
DEMO2_NAME = "Demo2"
WEEK_START_DAY = "Mon"
TIMEZONE = "UTC"
WEEKLY_GOAL = 3                           # the app's DEFAULT_WEEKLY_GOAL (settings.ts:19)

APPLY_OPT_IN_ENV = "SPOTTER_DEMO_PAIR_APPLY"
APPLY_OPT_IN_VALUE = "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION"

# Exit codes — distinct per refusal class so a runbook step can branch on them.
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_CREDENTIAL = 10
EXIT_CONFLICT = 11
EXIT_FOREIGN = 12
EXIT_APPLY_GUARD = 13
EXIT_REMOTE = 14

SERVICE_KEY_ENV = ("ServiceRoleSupabase", "SERVICE_ROLE_SUPABASE", "SUPABASE_SERVICE_ROLE_KEY")


class Refusal(Exception):
    """A guard fired. `code` is the process exit code; `message` is printed (through the redactor)."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RemoteFault(RuntimeError):
    """No answer at all from the server — never a verdict about the data."""


# --------------------------------------------------------------------------------------------- #
# Output hygiene. Every print goes through here.
# --------------------------------------------------------------------------------------------- #
class Redactor:
    def __init__(self) -> None:
        self._secrets: list[str] = []

    def add(self, value: str | None) -> None:
        # Only real credentials are worth masking wholesale (a short string like "anon" would
        # otherwise be scrubbed out of ordinary prose). Real keys/passwords are much longer.
        if value and len(value) >= 12 and value not in self._secrets:
            self._secrets.append(value)

    def add_secret(self, value: str | None) -> None:
        """Register a value of ANY length (an invite token is 8 characters) that must never be
        printed — including inside a request path, which is printed verbatim."""
        if value and value not in self._secrets:
            self._secrets.append(value)

    def scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, f"<redacted:{len(secret)} chars>")
        # A JWT-shaped string (three dot-separated base64url runs) can never be printed, even one
        # this process has never seen — belt and braces under the secret list above.
        text = re.sub(r"eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]*", "<redacted-jwt>", text)
        # No uuid ever reaches the terminal (the lead's rule: ids stay out of output).
        text = re.sub(
            r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
            "<uuid>", text)
        # The only addresses allowed in output are the two demo ones.
        text = re.sub(
            r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
            lambda m: m.group(0) if m.group(0) in (DEMO_EMAIL, DEMO2_EMAIL) else "<other-email>",
            text)
        return text


REDACTOR = Redactor()


def out(message: str = "") -> None:
    print(REDACTOR.scrub(message))


def err(message: str = "") -> None:
    print(REDACTOR.scrub(message), file=sys.stderr)


# --------------------------------------------------------------------------------------------- #
# Config — the one seam the harness moves to point at a local stub.
# --------------------------------------------------------------------------------------------- #
def _dotenv() -> dict[str, str]:
    values: dict[str, str] = {}
    path = os.path.join(REPO_ROOT, ".env")
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    values[k.strip()] = v.strip()
    return values


def supabase_config() -> tuple[str, str, str]:
    """(url, anon_key, service_role_key). The repo's .env is authoritative for URL + anon key (that
    is what the APP ships); the service_role key is NEVER read from a file, only from the
    environment, because it must not exist in the repo."""
    env = _dotenv()
    url = env.get("EXPO_PUBLIC_SUPABASE_URL") or os.environ.get("EXPO_PUBLIC_SUPABASE_URL", "")
    anon = env.get("EXPO_PUBLIC_SUPABASE_ANON_KEY") or os.environ.get("EXPO_PUBLIC_SUPABASE_ANON_KEY", "")
    service = ""
    for name in SERVICE_KEY_ENV:
        service = service or os.environ.get(name, "")
    return url, anon, service


def jwt_claims(token: str) -> dict[str, Any]:
    """Decode (never verify) a JWT's payload. Used to prove the service key really is one."""
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    except Exception:
        return {}


# --------------------------------------------------------------------------------------------- #
# HTTP — the default sender. HTTP errors are ANSWERS; transport faults raise RemoteFault.
# --------------------------------------------------------------------------------------------- #
def http_send(method: str, url: str, headers: dict[str, str], body: bytes | None,
              timeout: float = SUPABASE_TIMEOUT) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    for key, value in headers.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as exc:
        raise RemoteFault(f"{method} {url} got no response: {exc}") from exc


# --------------------------------------------------------------------------------------------- #
# The plan / call log. Every request the script makes (or would make) is recorded here.
# --------------------------------------------------------------------------------------------- #
_SENSITIVE_BODY_KEYS = {"password", "access_token", "refresh_token", "apikey", "authorization"}
_CAPABILITY_BODY_KEYS = {"token", "p_token"}


def _printable_body(body: Any) -> str:
    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out_map = {}
            for key, value in node.items():
                if key in _SENSITIVE_BODY_KEYS:
                    out_map[key] = "<redacted>"
                elif key in _CAPABILITY_BODY_KEYS:
                    out_map[key] = "<8-char invite code, redacted>"
                else:
                    out_map[key] = walk(value)
            return out_map
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node
    return json.dumps(walk(body), sort_keys=True)


def _printable_headers(headers: dict[str, str]) -> str:
    parts = []
    for key, value in sorted(headers.items()):
        if key.lower() in ("apikey", "authorization"):
            parts.append(f"{key}: <redacted:{len(value)} chars>")
        else:
            parts.append(f"{key}: {value}")
    return "; ".join(parts)


class Plan:
    """Records and prints every request. In dry-run mode this is the entire output of the run."""

    def __init__(self, dry_run: bool, quiet: bool = False) -> None:
        self.dry_run = dry_run
        self.quiet = quiet
        self.entries: list[tuple[str, str]] = []
        self.writes: list[tuple[str, str]] = []

    def kind(self, method: str, path: str) -> str:
        """read | session | write. A session POST (/auth/v1/token) establishes a session; it does
        not touch a row — the distinction is what makes "zero writes" a precise claim."""
        if method == "GET":
            return "read"
        if path.startswith("/auth/v1/token"):
            return "session"
        return "write"

    def record(self, method: str, path: str, headers: dict[str, str], body: Any) -> None:
        self.entries.append((method, path))
        if self.kind(method, path) == "write":
            self.writes.append((method, path))
        if self.quiet:
            return
        prefix = "[plan] would send" if self.dry_run else "[call]"
        out(f"{prefix} {method} {path}")
        out(f"         headers: {_printable_headers(headers)}")
        if body is not None:
            out(f"         body:    {_printable_body(body)}")


# --------------------------------------------------------------------------------------------- #
# Transport A — the Supabase Auth admin surface (service_role).
# --------------------------------------------------------------------------------------------- #
class SupabaseAdminAuth:
    """Service-role transport. `send` is injectable and resolved at construction."""

    def __init__(self, base_url: str, service_key: str, *, send: Callable[..., Any] | None = None,
                 dry_run: bool = True, plan: Plan | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_key = service_key
        self._send = send or http_send
        self.dry_run = dry_run
        self.plan = plan if plan is not None else Plan(dry_run)

    def _request(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        headers = {"apikey": self.service_key, "Authorization": "Bearer " + self.service_key}
        if body is not None:
            headers["Content-Type"] = "application/json"
        self.plan.record(method, path, headers, body)
        if self.dry_run:
            return 0, None
        status, raw = self._send(method, self.base_url + path, headers,
                                 json.dumps(body).encode() if body is not None else None)
        return status, _decode(raw)

    # -- reads --------------------------------------------------------------------------------- #
    def list_users(self) -> list[dict[str, Any]]:
        """Every auth user (service_role sees them all). Handles both GoTrue shapes: a bare list and
        the newer {"users": [...]} envelope."""
        status, payload = self._request("GET", "/auth/v1/admin/users?page=1&per_page=200")
        if status == 401 or status == 403:
            raise Refusal(EXIT_CREDENTIAL,
                          f"the service_role key was REFUSED by the auth admin API (HTTP {status}).\n"
                          "  The key is present but not accepted — check which project it belongs to\n"
                          "  and whether it is the anon key by mistake. Nothing was written.")
        if status == 0:
            return []
        if status != 200:
            raise Refusal(EXIT_REMOTE, f"GET /auth/v1/admin/users answered HTTP {status}: {_brief(payload)}")
        if isinstance(payload, dict):
            payload = payload.get("users", payload.get("data", []))
        if not isinstance(payload, list):
            raise Refusal(EXIT_REMOTE, "GET /auth/v1/admin/users returned an unexpected shape.")
        return [u for u in payload if isinstance(u, dict)]

    def select(self, table: str, query: str) -> list[dict[str, Any]]:
        """Read-only PostgREST select with the service key (RLS bypassed by design here — this is how
        the script learns whether a demo account is already seated somewhere without borrowing the
        account's own session). GET only; it is never given a write verb."""
        status, payload = self._request("GET", f"/rest/v1/{table}?{query}")
        if status == 0:
            return []
        if status != 200:
            raise Refusal(EXIT_REMOTE, f"GET /rest/v1/{table} answered HTTP {status}: {_brief(payload)}")
        return payload if isinstance(payload, list) else []

    # -- the one write this transport does ----------------------------------------------------- #
    def create_user(self, email: str, password: str) -> dict[str, Any]:
        if email not in (DEMO_EMAIL, DEMO2_EMAIL):
            raise Refusal(EXIT_FOREIGN, f"refusing to create an auth user that is not a demo seat: {email}")
        body = {"email": email, "password": password, "email_confirm": True}
        status, payload = self._request("POST", "/auth/v1/admin/users", body)
        if status == 0:  # dry run: nothing was sent, so hand back a clearly-fake placeholder id
            return {"id": DRY_RUN_ID, "email": email, "dry_run": True}
        if status in (200, 201):
            user = payload if isinstance(payload, dict) else {}
            if user.get("email") not in (None, email):
                raise Refusal(EXIT_FOREIGN,
                              "the auth admin API returned a user that is not the address we asked "
                              "for; refusing to continue.")
            return user
        if status == 422 or status == 409:
            raise Refusal(EXIT_CONFLICT,
                          f"the auth admin API refused to create {email} (HTTP {status}: "
                          f"{_brief(payload)}).\n"
                          "  That address already exists in a shape this script will not overwrite.\n"
                          "  Inspect it by hand; nothing was written.")
        raise Refusal(EXIT_REMOTE, f"POST /auth/v1/admin/users answered HTTP {status}: {_brief(payload)}")


# --------------------------------------------------------------------------------------------- #
# Transport B — the app's own invite/onboarding path (each seat's own session).
# --------------------------------------------------------------------------------------------- #
class GroupFormation:
    """Mirrors src/lib/settings.ts (onboarding) + src/lib/invites.ts (invite/accept) over PostgREST,
    using each SEAT's own access token — never the service key. `send` is injectable."""

    def __init__(self, base_url: str, anon_key: str, *, send: Callable[..., Any] | None = None,
                 dry_run: bool = True, plan: Plan | None = None,
                 token_factory: Callable[[], str] | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.anon_key = anon_key
        self._send = send or http_send
        self.dry_run = dry_run
        self.plan = plan if plan is not None else Plan(dry_run)
        self._token_factory = token_factory or make_invite_token

    def _request(self, method: str, path: str, body: Any = None,
                 access_token: str | None = None) -> tuple[int, Any]:
        token = access_token or self.anon_key
        headers = {"apikey": self.anon_key, "Authorization": "Bearer " + token}
        if method == "POST" and "on_conflict=" in path:
            # what supabase-js .upsert({...}, {onConflict}).select() sends
            headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        elif method == "POST" and "select=" in path:
            # what supabase-js .insert({...}).select('id') sends
            headers["Prefer"] = "return=representation"
        if body is not None:
            headers["Content-Type"] = "application/json"
        self.plan.record(method, path, headers, body)
        if self.dry_run:
            return 0, None
        status, raw = self._send(method, self.base_url + path, headers,
                                 json.dumps(body).encode() if body is not None else None)
        return status, _decode(raw)

    # -- sign in (the app's own auth call) ----------------------------------------------------- #
    def sign_in(self, email: str, password: str) -> tuple[str, str]:
        """POST /auth/v1/token?grant_type=password — returns (access_token, user_id)."""
        if email not in (DEMO_EMAIL, DEMO2_EMAIL):
            raise Refusal(EXIT_FOREIGN, f"refusing to sign in an account that is not a demo seat: {email}")
        status, payload = self._request("POST", "/auth/v1/token?grant_type=password",
                                        {"email": email, "password": password})
        if status == 0:
            return DRY_RUN_TOKEN, DRY_RUN_ID
        if status != 200:
            raise Refusal(EXIT_REMOTE,
                          f"sign-in for {email} answered HTTP {status}: {_brief(payload)}.\n"
                          "  Nothing has been written for this seat.")
        user = (payload or {}).get("user") or {}
        return str(payload.get("access_token") or ""), str(user.get("id") or "")

    # -- onboarding (settings.ts:75-114) -------------------------------------------------------- #
    def upsert_row(self, table: str, row: dict[str, Any], on_conflict: str,
                   access_token: str) -> list[dict[str, Any]]:
        status, payload = self._request("POST", f"/rest/v1/{table}?on_conflict={on_conflict}",
                                        row, access_token=access_token)
        if status == 0:
            return []
        if status not in (200, 201):
            raise Refusal(EXIT_REMOTE,
                          f"upsert into {table} answered HTTP {status}: {_brief(payload)}")
        return payload if isinstance(payload, list) else ([payload] if isinstance(payload, dict) else [])

    def insert_row(self, table: str, row: dict[str, Any], access_token: str,
                   path_suffix: str = "") -> list[dict[str, Any]]:
        suffix = ("?" + path_suffix) if path_suffix else ""
        status, payload = self._request("POST", f"/rest/v1/{table}{suffix}", row,
                                        access_token=access_token)
        if status == 0:
            return []
        if status not in (200, 201):
            raise Refusal(EXIT_REMOTE,
                          f"insert into {table} answered HTTP {status}: {_brief(payload)}")
        return payload if isinstance(payload, list) else ([payload] if isinstance(payload, dict) else [])

    def select_rows(self, table: str, query: str, access_token: str) -> list[dict[str, Any]]:
        status, payload = self._request("GET", f"/rest/v1/{table}?{query}",
                                        access_token=access_token)
        if status == 0:
            return []
        if status != 200:
            raise Refusal(EXIT_REMOTE, f"GET /rest/v1/{table} answered HTTP {status}: {_brief(payload)}")
        return payload if isinstance(payload, list) else []

    def rpc(self, function: str, payload: dict[str, Any], access_token: str) -> dict[str, Any]:
        status, body = self._request("POST", f"/rest/v1/rpc/{function}", payload,
                                     access_token=access_token)
        if status == 0:
            return {}
        if status not in (200, 201):
            raise Refusal(EXIT_REMOTE,
                          f"rpc {function} answered HTTP {status}: {_brief(body)}")
        return body if isinstance(body, dict) else {}

    # -- the app's invite + accept (invites.ts:145 / :316) -------------------------------------- #
    def create_invite(self, inviter_id: str, access_token: str,
                      token: str | None = None) -> tuple[str, str]:
        token = token or self._token_factory()
        rows = self.upsert_row("invites", {"inviter_id": inviter_id, "token": token},
                               "token", access_token)
        if rows:
            first = rows[0]
            if first.get("inviter_id") not in (None, inviter_id):
                raise Refusal(EXIT_FOREIGN,
                              "the invites upsert came back owned by a different user; refusing "
                              "to continue.")
        return token, (rows[0].get("id", "") if rows else DRY_RUN_ID)

    def join_group(self, token: str, access_token: str) -> dict[str, Any]:
        return self.rpc("join_group", {"p_token": token}, access_token)


# --------------------------------------------------------------------------------------------- #
# Small helpers.
# --------------------------------------------------------------------------------------------- #
DRY_RUN_ID = "<dry-run: id not created yet>"
DRY_RUN_TOKEN = "<dry-run: session not created>"


def q(value: str) -> str:
    """URL-encode a query VALUE. Load-bearing: a raw `+` in an ISO timestamp (the `+00:00` offset)
    is decoded by the server as a SPACE, so an unencoded week boundary reaches PostgREST as
    `gte.2026-10-05T00:00:00 00:00` and is rejected — found by the offline harness, not in
    production. supabase-js encodes for the app; this script has to do it by hand."""
    return urllib.parse.quote(str(value), safe="")


def _decode(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode())
    except ValueError:
        return {"raw": raw[:200].decode(errors="replace")}


def _brief(payload: Any) -> str:
    text = json.dumps(payload, sort_keys=True) if not isinstance(payload, str) else payload
    return text[:160]


def make_invite_token(alphabet: str = "") -> str:
    """8 characters from the APP's own alphabet (src/lib/invites.ts INVITE_CODE_ALPHABET).
    Every generated token is registered with the redactor immediately, because the token travels in
    a request path (`/rest/v1/invites?token=eq.<code>`) and paths are printed."""
    chars = alphabet or app_contract()["alphabet"]
    token = "".join(secrets.choice(chars) for _ in range(8))
    REDACTOR.add_secret(token)
    return token


# --------------------------------------------------------------------------------------------- #
# The repo contract. Read from the repo at run time — never guessed, never hardcoded twice.
# --------------------------------------------------------------------------------------------- #
_CONTRACT_CACHE: dict[str, Any] = {}


def app_contract(force: bool = False) -> dict[str, Any]:
    """What the APP actually does, read out of the repo. Raises exit 2 (usage) when the repo no
    longer matches what this script mirrors, so a silent drift cannot ship."""
    if _CONTRACT_CACHE and not force:
        return _CONTRACT_CACHE
    contract: dict[str, Any] = {}
    problems: list[str] = []

    if not os.path.exists(SCHEMA_PATH):
        problems.append(f"{SCHEMA_PATH} is missing")
        schema = ""
    else:
        with open(SCHEMA_PATH) as fh:
            schema = fh.read()
    if schema:
        if not re.search(r"create or replace function public\.join_group\(p_token text\)", schema):
            problems.append("supabase/schema.sql no longer defines public.join_group(p_token text)")
        if "token text not null unique" not in schema:
            problems.append("supabase/schema.sql no longer has invites.token unique")
        if "public.group_capacity()" not in schema:
            problems.append("supabase/schema.sql no longer defines group_capacity()")
        contract["rpc_join_group"] = "join_group"
        contract["invite_token_column"] = "token"

    alphabet = ""
    if not os.path.exists(INVITES_TS_PATH):
        problems.append(f"{INVITES_TS_PATH} is missing")
    else:
        with open(INVITES_TS_PATH) as fh:
            invites_ts = fh.read()
        match = re.search(r"INVITE_CODE_ALPHABET = '([^']+)'", invites_ts)
        if not match:
            problems.append("src/lib/invites.ts no longer declares INVITE_CODE_ALPHABET")
        else:
            alphabet = match.group(1)
            if any(ch in alphabet for ch in "01ILO"):
                problems.append("src/lib/invites.ts INVITE_CODE_ALPHABET contains an excluded glyph")
    if alphabet:
        contract["alphabet"] = alphabet

    if problems:
        raise Refusal(EXIT_USAGE,
                      "the repo no longer matches the app path this script mirrors:\n  - "
                      + "\n  - ".join(problems)
                      + "\n  Fix the contract in scripts/release/provision_demo_pair.py before running.")

    _CONTRACT_CACHE.update(contract)
    return contract


def review_note_contract() -> dict[str, Any]:
    """The credentials this script creates MUST be the ones submit_review.py writes into the review
    note, or the reviewer gets a password that does not work. Import the sibling helper and compare."""
    if os.path.dirname(SUBMIT_REVIEW_PATH) not in sys.path:
        sys.path.insert(0, os.path.dirname(SUBMIT_REVIEW_PATH))
    try:
        import submit_review  # noqa: PLC0415  (imported lazily on purpose)
    except Exception as exc:  # pragma: no cover - only when the file is missing/broken
        raise Refusal(EXIT_USAGE, f"cannot import scripts/release/submit_review.py: {exc}") from exc
    expect = {"email": DEMO_EMAIL, "email2": DEMO2_EMAIL, "password": DEMO_PASSWORD}
    found = {"email": getattr(submit_review, "DEMO_EMAIL", None),
             "email2": getattr(submit_review, "DEMO2_EMAIL", None),
             "password": getattr(submit_review, "DEMO_PASSWORD", None)}
    if found != expect:
        differences = [k for k in expect if expect[k] != found[k]]
        raise Refusal(EXIT_USAGE,
                      "this script's demo credentials no longer match the ones "
                      "scripts/release/submit_review.py writes into the review note "
                      f"(differing: {', '.join(differences)}). One of the two files must change; "
                      "until then a provisioned account could not be signed into with the "
                      "credentials the reviewer is given.")
    return found


def week_start_utc(now: datetime | None = None) -> datetime:
    """This Monday's 00:00 UTC — the app's week-scoped feed boundary under week_start_day 'Mon'
    (workoutStore.ts week window; submit_review.week_start_utc is the authoritative gate)."""
    now = now or datetime.now(timezone.utc)
    day = now.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    return day - timedelta(days=day.weekday())


# --------------------------------------------------------------------------------------------- #
# Credentials.
# --------------------------------------------------------------------------------------------- #
def require_config(*, want_service: bool = True) -> tuple[str, str, str]:
    """Local credential check. Missing / malformed / not-a-service-key refusals happen BEFORE any
    request is made, so those exits send literally zero requests."""
    url, anon, service = supabase_config()
    if not url:
        raise Refusal(EXIT_CREDENTIAL,
                      "no Supabase URL: set EXPO_PUBLIC_SUPABASE_URL in the repo .env (or the "
                      "environment). Zero requests sent.")
    if not url.startswith("https://"):
        host = url.split("//", 1)[-1].split("/")[0].split(":")[0]
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise Refusal(EXIT_CREDENTIAL,
                          f"refusing to talk to a plain-http host ({host!r}) — the project URL must "
                          "be https://. Zero requests sent.")
    if not anon:
        raise Refusal(EXIT_CREDENTIAL,
                      "no anon key: set EXPO_PUBLIC_SUPABASE_ANON_KEY in the repo .env (or the "
                      "environment). Zero requests sent.")
    if not want_service:
        return url, anon, service
    if not service:
        raise Refusal(EXIT_CREDENTIAL,
                      "no service_role key: export " + " or ".join(SERVICE_KEY_ENV) +
                      ". It is deliberately never read from a file. Zero requests sent.")
    claims = jwt_claims(service)
    if not claims:
        raise Refusal(EXIT_CREDENTIAL,
                      "the service_role value is not a JWT (no readable claims) — the admin API "
                      "would reject it. Zero requests sent.")
    role = str(claims.get("role") or "")
    if role != "service_role":
        raise Refusal(EXIT_CREDENTIAL,
                      f"that key's role claim is {role or 'missing'!r}, not 'service_role' — it is "
                      "the anon key or a user token. Zero requests sent.")
    REDACTOR.add(service)
    REDACTOR.add(anon)
    REDACTOR.add(DEMO_PASSWORD)
    return url, anon, service


# --------------------------------------------------------------------------------------------- #
# The preflight (read-only) — the go/no-go decision, and where three refusal classes live.
# --------------------------------------------------------------------------------------------- #
def preflight(auth: SupabaseAdminAuth, formation: GroupFormation) -> dict[str, Any]:
    """Reads only. Returns the state the apply step needs; raises Refusal on anything unsafe."""
    app_contract()
    review_note_contract()

    users = auth.list_users()
    by_email: dict[str, dict[str, Any]] = {}
    foreign = 0
    for user in users:
        email = str(user.get("email") or "")
        if email in (DEMO_EMAIL, DEMO2_EMAIL):
            by_email[email] = user
        else:
            foreign += 1

    demo = by_email.get(DEMO_EMAIL)
    demo2 = by_email.get(DEMO2_EMAIL)

    out(f"[preflight] auth users read: {len(users)} total, {len(by_email)} of them a demo seat, "
        f"{foreign} other account(s) (never printed, never touched)")

    if bool(demo) != bool(demo2):
        present = DEMO_EMAIL if demo else DEMO2_EMAIL
        raise Refusal(EXIT_CONFLICT,
                      f"CONFLICTING SHAPE: only {present} exists. A half-provisioned pair is exactly "
                      "what the reviewer note must never describe, and this script will not guess "
                      "which half is the mistake.\n"
                      "  Decide by hand (delete the orphan, or create the other seat) and re-run. "
                      "Nothing was written.")

    for email, user in ((DEMO_EMAIL, demo), (DEMO2_EMAIL, demo2)):
        if user and not user.get("email_confirmed_at"):
            raise Refusal(EXIT_CONFLICT,
                          f"CONFLICTING SHAPE: {email} exists but is NOT email-confirmed, so the "
                          "reviewer could not sign in with it.\n"
                          "  Confirm it by hand (or delete it and re-run this script). Nothing was "
                          "written.")

    # Where is each existing demo seat currently sitting? Service-role reads, GETs only.
    seats: dict[str, dict[str, Any]] = {}
    shared_group: str | None = None
    for email, user, label in ((DEMO_EMAIL, demo, "demo"), (DEMO2_EMAIL, demo2, "demo2")):
        if not user:
            continue
        # The identity check at this stage IS the email match above: this id was read from the row
        # whose email is exactly one of the two demo addresses, and nothing else is reachable here.
        uid = str(user.get("id") or "")
        if not uid:
            raise Refusal(EXIT_REMOTE, f"the auth row for {email} has no id — cannot proceed.")
        seats[label] = {"id": uid, "email": email}
        rows = auth.select("memberships", f"user_id=eq.{q(uid)}&select=group_id")
        for row in rows:
            group_id = str(row.get("group_id") or "")
            members = auth.select("memberships", f"group_id=eq.{q(group_id)}&select=user_id")
            ids = {str(m.get("user_id") or "") for m in members}
            if len(ids) >= 2:
                strangers = ids - {str(demo.get("id")) if demo else "", str(demo2.get("id")) if demo2 else ""}
                strangers = {s for s in strangers if s}
                if strangers:
                    raise Refusal(EXIT_CONFLICT,
                                  f"CONFLICTING SHAPE: {email} is already seated in a shared group "
                                  f"with {len(strangers)} account(s) that are not the other demo "
                                  "seat.\n"
                                  "  Pairing them would put the demo accounts in a real person's "
                                  "group. Nothing was written.")
                if ids == {str(demo.get("id")) if demo else "", str(demo2.get("id")) if demo2 else ""}:
                    shared_group = group_id

    # Would the invite token we are about to mint collide with somebody else's invite?
    token = formation._token_factory()  # noqa: SLF001 (the same generator apply will use)
    collision = auth.select("invites", f"token=eq.{q(token)}&select=inviter_id")
    for row in collision:
        owner = str(row.get("inviter_id") or "")
        if demo and owner and owner != str(demo.get("id")):
            raise Refusal(EXIT_FOREIGN,
                          "the generated invite code already belongs to a different account. "
                          "Refusing to reuse it (that would hand the joiner a stranger's code). "
                          "Nothing was written.")
    out(f"[preflight] invite code generated from the app's alphabet: {len(token)} chars, no "
        "collision with another account's invite")

    paired = shared_group is not None and bool(demo) and bool(demo2)
    state = {"demo": seats.get("demo", {}), "demo2": seats.get("demo2", {}),
             "paired": paired, "shared_group": shared_group,
             "needs_users": not demo, "invite_token": token}
    if paired:
        out("[preflight] VERDICT: the demo pair already exists and is paired — nothing to provision.")
    else:
        out("[preflight] VERDICT: safe to provision "
            f"({'creating both accounts' if state['needs_users'] else 'accounts exist, pairing only'}).")
    return state


def _assert_demo_target(label: str, ident: str, what: str) -> None:
    """The invariant behind exit 12: nothing but the two demo users may be addressed by a request.
    `label` is 'demo' or 'demo2' — the SEAT we believe we are acting for."""
    if label not in ("demo", "demo2"):
        raise Refusal(EXIT_FOREIGN, f"internal: unknown seat label {label!r}. Nothing was written.")
    if not ident or ident == DRY_RUN_ID:
        return
    if ident not in _DEMO_IDS.values():
        raise Refusal(EXIT_FOREIGN,
                      f"a request was about to act for {what}, whose id is not one of the two demo "
                      "seats. Refusing to touch it. Nothing was written for it.")
        # (the value is deliberately not printed — see the redactor)


_DEMO_IDS: dict[str, str] = {}


# --------------------------------------------------------------------------------------------- #
# Apply.
# --------------------------------------------------------------------------------------------- #
def onboard_seat(formation: GroupFormation, label: str, email: str, uid: str, name: str) -> str:
    """settings.ts:75-114, in the same order (users row FIRST — it is the FK target)."""
    token, session_uid = formation.sign_in(email, DEMO_PASSWORD)
    _assert_demo_target(label, session_uid, f"the session of {email}")
    if session_uid and session_uid != uid:
        raise Refusal(EXIT_FOREIGN,
                      f"signing in as {email} returned a different user id than the account we "
                      "resolved; refusing to continue. Nothing was written for this seat.")

    formation.upsert_row("users", {"id": uid, "name": name, "week_start_day": WEEK_START_DAY,
                                   "timezone": TIMEZONE}, "id", token)
    groups = formation.select_rows("groups", f"select=id&creator_id=eq.{q(uid)}", token)
    group_id = str(groups[0].get("id") or "") if groups else ""
    if not group_id:
        created = formation.insert_row("groups", {"name": "Personal", "creator_id": uid}, token,
                                       path_suffix="select=id")
        group_id = str(created[0].get("id") or "") if created else DRY_RUN_ID
    formation.upsert_row("memberships",
                         {"user_id": uid, "group_id": group_id, "weekly_goal": WEEKLY_GOAL,
                          "role": "admin"},
                         "group_id,user_id", token)
    return token


def apply_pair(state: dict[str, Any], auth: SupabaseAdminAuth,
               formation: GroupFormation) -> int:
    global _DEMO_IDS

    demo_uid = state["demo"].get("id", "")
    demo2_uid = state["demo2"].get("id", "")

    if state["needs_users"]:
        created = auth.create_user(DEMO_EMAIL, DEMO_PASSWORD)
        demo_uid = str(created.get("id") or "")
        _DEMO_IDS = {"demo": demo_uid}
        created2 = auth.create_user(DEMO2_EMAIL, DEMO_PASSWORD)
        demo2_uid = str(created2.get("id") or "")
        _DEMO_IDS = {"demo": demo_uid, "demo2": demo2_uid}
        out("[apply] both demo accounts created, already email-confirmed")
    else:
        _DEMO_IDS = {"demo": demo_uid, "demo2": demo2_uid}
        out("[apply] both demo accounts already exist — reusing them (no auth writes)")

    if state["paired"]:
        out("[apply] the pair already exists — skipping onboarding/invite/join")
    else:
        demo_token = onboard_seat(formation, "demo", DEMO_EMAIL, demo_uid, DEMO_NAME)
        demo2_token = onboard_seat(formation, "demo2", DEMO2_EMAIL, demo2_uid, DEMO2_NAME)
        # The SAME token the preflight checked for a collision — never a fresh one.
        invite_token, _invite_id = formation.create_invite(demo_uid, demo_token,
                                                           state.get("invite_token"))
        out("[apply] invite row created by the demo seat (its 8-char code is not printed)")

        # The joiner accepts with ITS OWN session — the app's own path, schema.sql:619.
        result = formation.join_group(invite_token, demo2_token)
        member_count = result.get("member_count")
        out(f"[apply] join_group returned ok={result.get('ok')} member_count={member_count}")
        if not result.get("ok"):
            raise Refusal(EXIT_REMOTE,
                          "join_group did not report ok — the pairing is NOT done. Nothing more "
                          "was written; re-run --preflight to see the current state.")

    return verify(state, auth)


def verify(state: dict[str, Any], auth: SupabaseAdminAuth) -> int:
    """Read-only post-check. Prints counts (never ids) and the owner's remaining step."""
    demo_uid = state["demo"].get("id", "") or _DEMO_IDS.get("demo", "")
    demo2_uid = state["demo2"].get("id", "") or _DEMO_IDS.get("demo2", "")
    if auth.dry_run:
        out("\n[verify] dry run — nothing was read back. Run --preflight for the real state.")
        return EXIT_OK

    rows = auth.select("memberships", f"user_id=eq.{demo_uid}&select=group_id")
    shared = []
    for row in rows:
        group_id = str(row.get("group_id") or "")
        members = auth.select("memberships", f"group_id=eq.{q(group_id)}&select=user_id")
        ids = {str(m.get("user_id") or "") for m in members}
        if len(ids) >= 2:
            shared.append(ids)
    pair_ok = any(ids == {demo_uid, demo2_uid} for ids in shared)
    out(f"\n[verify] shared groups holding the demo seat: {len(shared)} "
        f"(exactly one two-seat group with ONLY the two demo accounts: {pair_ok})")

    since = week_start_utc().strftime("%Y-%m-%dT%H:%M:%S+00:00")
    for label, uid in (("demo", demo_uid), ("demo2", demo2_uid)):
        logs = auth.select("workouts", f"user_id=eq.{q(uid)}&logged_at=gte.{q(since)}&select=id")
        out(f"[verify] {label}: {len(logs)} live-camera log(s) in the current week "
            "(the owner must produce these)")
    out("[verify] next: the owner records one real live-camera workout from EACH seat, then\n"
        "         python3 scripts/release/submit_review.py --pair-check")
    return EXIT_OK if pair_ok else EXIT_REMOTE


# --------------------------------------------------------------------------------------------- #
# The apply guard — two independent locks, checked before ANY request.
# --------------------------------------------------------------------------------------------- #
def apply_authorised(args: argparse.Namespace, env: dict[str, str]) -> tuple[bool, str]:
    if not getattr(args, "apply", False):
        return False, "no --apply flag (dry run by default)"
    if env.get(APPLY_OPT_IN_ENV) != APPLY_OPT_IN_VALUE:
        return False, (f"env opt-in missing: --apply also needs {APPLY_OPT_IN_ENV}="
                       f"{APPLY_OPT_IN_VALUE} in the environment")
    return True, ""


# --------------------------------------------------------------------------------------------- #
# Self-test — offline, no network, fixed check groups.
# --------------------------------------------------------------------------------------------- #
def self_test() -> int:
    checks: list[tuple[str, bool]] = []

    def check(name: str, condition: bool) -> None:
        checks.append((name, bool(condition)))

    # 1. repo contract
    contract = app_contract(force=True)
    check("contract: join_group mirrored", contract.get("rpc_join_group") == "join_group")
    check("contract: alphabet read from the app", contract.get("alphabet") == "ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    check("contract: review-note credentials agree", bool(review_note_contract()))

    # 2. token generation obeys the alphabet
    tokens = [make_invite_token() for _ in range(50)]
    check("token: 8 chars", all(len(t) == 8 for t in tokens))
    check("token: only the app's glyphs", all(set(t) <= set(contract["alphabet"]) for t in tokens))
    check("token: no excluded glyph", not any(set(t) & set("01ILO") for t in tokens))
    check("token: not all identical", len(set(tokens)) > 40)

    # 3. the apply guard
    ns = argparse.Namespace(apply=False)
    ok, why = apply_authorised(ns, {})
    check("guard: dry run without --apply", ok is False and "no --apply" in why)
    ok, why = apply_authorised(argparse.Namespace(apply=True), {})
    check("guard: --apply alone is inert", ok is False and APPLY_OPT_IN_ENV in why)
    ok, _ = apply_authorised(argparse.Namespace(apply=True), {APPLY_OPT_IN_ENV: "yes"})
    check("guard: wrong opt-in value refused", ok is False)
    ok, _ = apply_authorised(argparse.Namespace(apply=True), {APPLY_OPT_IN_ENV: APPLY_OPT_IN_VALUE})
    check("guard: both locks present", ok is True)

    # 4. the demo-target invariant (exit 12)
    global _DEMO_IDS
    saved = dict(_DEMO_IDS)
    _DEMO_IDS = {"demo": "11111111-1111-1111-1111-111111111111",
                 "demo2": "22222222-2222-2222-2222-222222222222"}
    refused = False
    try:
        _assert_demo_target("demo", "33333333-3333-3333-3333-333333333333", "a stranger")
    except Refusal as exc:
        refused = exc.code == EXIT_FOREIGN
    check("invariant: a foreign id is refused (exit 12)", refused)
    allowed = True
    try:
        _assert_demo_target("demo", _DEMO_IDS["demo"], "the demo seat")
        _assert_demo_target("demo2", _DEMO_IDS["demo2"], "the second demo seat")
        _assert_demo_target("demo", DRY_RUN_ID, "a placeholder in a dry run")
    except Refusal:
        allowed = False
    check("invariant: the two demo seats pass", allowed)
    _DEMO_IDS = saved

    # 5. credential refusals are local (zero requests)
    real_config = supabase_config
    try:
        globals()["supabase_config"] = lambda: ("https://x.supabase.co", "anon", "")
        missing = 0
        try:
            require_config()
        except Refusal as exc:
            missing = exc.code
        check("credential: missing service key -> exit 10", missing == EXIT_CREDENTIAL)

        globals()["supabase_config"] = lambda: ("https://x.supabase.co", "", "svc")
        noanon = 0
        try:
            require_config()
        except Refusal as exc:
            noanon = exc.code
        check("credential: missing anon key -> exit 10", noanon == EXIT_CREDENTIAL)

        globals()["supabase_config"] = lambda: ("http://example.com", "anon", "svc")
        plain = 0
        try:
            require_config()
        except Refusal as exc:
            plain = exc.code
        check("credential: plain http refused -> exit 10", plain == EXIT_CREDENTIAL)

        anon_key = "eyJhbGciOiJIUzI1NiJ9." + \
                   base64.urlsafe_b64encode(json.dumps({"role": "anon"}).encode()).decode().rstrip("=") + ".sig"
        globals()["supabase_config"] = lambda: ("https://x.supabase.co", "anon", anon_key)
        role = 0
        try:
            require_config()
        except Refusal as exc:
            role = exc.code
        check("credential: anon key as service key -> exit 10", role == EXIT_CREDENTIAL)

        service_key = "eyJhbGciOiJIUzI1NiJ9." + \
                      base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode()).decode().rstrip("=") + ".sig"
        globals()["supabase_config"] = lambda: ("https://x.supabase.co", "anon", service_key)
        accepted = True
        try:
            require_config()
        except Refusal:
            accepted = False
        check("credential: a real service_role key passes", accepted)
    finally:
        globals()["supabase_config"] = real_config

    # 6. the redactor
    REDACTOR.add("SuperSecretServiceRoleKey1234567890")
    scrubbed = REDACTOR.scrub(
        "key SuperSecretServiceRoleKey1234567890 pw " + DEMO_PASSWORD +
        " tok eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig "
        "id 11111111-1111-1111-1111-111111111111 mail someone@elsewhere.com")
    check("redactor: the key never prints", "SuperSecretServiceRoleKey1234567890" not in scrubbed)
    check("redactor: the password never prints", DEMO_PASSWORD not in scrubbed)
    check("redactor: no JWT survives", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0" not in scrubbed)
    check("redactor: no uuid survives", "11111111-1111-1111-1111-111111111111" not in scrubbed)
    check("redactor: a stranger's address is masked", "someone@elsewhere.com" not in scrubbed)
    check("redactor: the two demo addresses survive", REDACTOR.scrub(DEMO_EMAIL + " " + DEMO2_EMAIL)
          == DEMO_EMAIL + " " + DEMO2_EMAIL)

    # 7. dry-run transport sends nothing, and the week boundary is a Monday
    calls: list[tuple[str, str]] = []

    def never_send(method: str, url: str, headers: dict[str, str], body: bytes | None,
                   timeout: float = 0) -> tuple[int, bytes]:
        calls.append((method, url))
        raise AssertionError("a dry run must not touch the network")

    plan = Plan(dry_run=True, quiet=True)
    transport = SupabaseAdminAuth("https://stub.invalid", "svc", send=never_send, dry_run=True,
                                  plan=plan)
    transport.list_users()
    transport.create_user(DEMO_EMAIL, DEMO_PASSWORD)
    check("dry run: zero requests left the process", calls == [])
    check("dry run: the plan recorded both calls", [m for m, _ in plan.entries] == ["GET", "POST"])
    check("dry run: exactly one write planned", len(plan.writes) == 1)

    monday = week_start_utc(datetime(2026, 10, 5, 19, 42, tzinfo=timezone.utc))
    check("week: Monday 2026-10-05 maps to itself at 00:00",
          monday == datetime(2026, 10, 5, tzinfo=timezone.utc))
    sunday = week_start_utc(datetime(2026, 10, 11, 23, 59, tzinfo=timezone.utc))
    check("week: Sunday 2026-10-11 is still in the 10-05 week",
          sunday == datetime(2026, 10, 5, tzinfo=timezone.utc))

    failed = [name for name, ok in checks if not ok]
    out(f"provision_demo_pair self-test — {len(checks) - len(failed)}/{len(checks)} checks passed")
    for name, ok in checks:
        out(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if failed:
        out(f"\nFAILED: {len(failed)} check(s): {', '.join(failed)}")
        return 1
    return 0


# --------------------------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="actually provision (also needs the env opt-in — see the module docstring)")
    ap.add_argument("--preflight", action="store_true",
                    help="read-only: is it safe to provision? (GETs only, exits non-zero on a refusal)")
    ap.add_argument("--dry-run", action="store_true",
                    help="force a dry run even when --apply is given")
    ap.add_argument("--self-test", action="store_true", help="offline checks, no network")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    authorised, why = apply_authorised(args, dict(os.environ))
    apply_mode = authorised and not args.dry_run
    if args.apply and not authorised and not args.dry_run:
        err(f"REFUSING TO WRITE: {why}")
        err("  Two locks are required on purpose: --apply AND the env opt-in. Zero requests sent.")
        return EXIT_APPLY_GUARD

    # `--preflight` really reads (that is the point of it); it simply never issues a non-GET call.
    # Only the default plan run and an unauthorised --apply are transports-off.
    reading = apply_mode or args.preflight

    try:
        url, anon, service = require_config()
        plan = Plan(dry_run=not reading)
        auth = SupabaseAdminAuth(url, service, dry_run=not reading, plan=plan)
        formation = GroupFormation(url, anon, dry_run=not reading, plan=plan)

        out("SPOTTER App Review demo pair — provisioning helper (path D: accounts + pairing "
            "server-side)")
        out(f"project: {url}")
        out(f"seats:   {DEMO_EMAIL} + {DEMO2_EMAIL}  (the only addresses that may appear here)")
        out(f"mode:    {'LIVE — writes are ON (--apply + env opt-in)' if apply_mode else 'DRY RUN — nothing is sent, nothing is written'}")
        out("")

        if apply_mode:
            state = preflight(auth, formation)
            out("")
            if state["paired"] and not state["needs_users"]:
                code = verify(state, auth)
                out("\nalready provisioned — no write was needed.")
                return code
            return apply_pair(state, auth, formation)

        if args.preflight:
            state = preflight(auth, formation)
            out("")
            out(f"[preflight] accounts to create: {'demo@ + demo2@' if state['needs_users'] else 'none'}")
            out("[preflight] this run wrote NOTHING (it issued no write request at all).")
            return EXIT_OK

        # Default: print the whole plan without sending anything.
        out("[plan] the requests below are what --apply would make, in this order.")
        out("[plan] nothing is sent in a dry run; this run ends without a single request.\n")
        demo = {"id": DRY_RUN_ID, "name": DEMO_NAME}
        demo2 = {"id": DRY_RUN_ID, "name": DEMO2_NAME}
        auth.list_users()
        auth.create_user(DEMO_EMAIL, DEMO_PASSWORD)
        auth.create_user(DEMO2_EMAIL, DEMO_PASSWORD)
        demo_token = formation.sign_in(DEMO_EMAIL, DEMO_PASSWORD)[0]
        formation.upsert_row("users", {"id": demo["id"], "name": demo["name"],
                                       "week_start_day": WEEK_START_DAY, "timezone": TIMEZONE},
                             "id", demo_token)
        formation.select_rows("groups", f"select=id&creator_id=eq.{demo['id']}", demo_token)
        formation.insert_row("groups", {"name": "Personal", "creator_id": demo["id"]},
                             demo_token, path_suffix="select=id")
        formation.upsert_row("memberships",
                             {"user_id": demo["id"], "group_id": "<personal group id>",
                              "weekly_goal": WEEKLY_GOAL, "role": "admin"},
                             "group_id,user_id", demo_token)
        demo2_token = formation.sign_in(DEMO2_EMAIL, DEMO_PASSWORD)[0]
        formation.upsert_row("users", {"id": demo2["id"], "name": demo2["name"],
                                       "week_start_day": WEEK_START_DAY, "timezone": TIMEZONE},
                             "id", demo2_token)
        formation.select_rows("groups", f"select=id&creator_id=eq.{demo2['id']}", demo2_token)
        formation.insert_row("groups", {"name": "Personal", "creator_id": demo2["id"]},
                             demo2_token, path_suffix="select=id")
        formation.upsert_row("memberships",
                             {"user_id": demo2["id"], "group_id": "<personal group id>",
                              "weekly_goal": WEEKLY_GOAL, "role": "admin"},
                             "group_id,user_id", demo2_token)
        formation.create_invite(demo["id"], demo_token)
        formation.rpc("join_group", {"p_token": "<the same 8-char code>"}, demo2_token)
        out("")
        kinds = {"read": 0, "session": 0, "write": 0}
        for method, path in plan.entries:
            kinds[plan.kind(method, path)] += 1
        out(f"[plan] {len(plan.entries)} request(s): {kinds['read']} read(s), "
            f"{kinds['session']} session POST(s), {kinds['write']} WRITE(s). Actually sent: 0.")
        out("[plan] next: --preflight (read-only) to see the real current state, then --apply "
            "with the env opt-in.")
        out("[plan] the owner still owes one REAL live-camera log from each seat — this script "
            "never creates workouts.")
        return EXIT_OK
    except Refusal as exc:
        err(f"\nREFUSED (exit {exc.code}): {exc.message}")
        return exc.code
    except RemoteFault as exc:
        err(f"\nNETWORK FAULT: {exc}\nThe remote state is UNKNOWN — nothing further was attempted. "
            "Re-run --preflight (read-only) to see where things stand before retrying.")
        return EXIT_REMOTE


if __name__ == "__main__":
    sys.exit(main())
