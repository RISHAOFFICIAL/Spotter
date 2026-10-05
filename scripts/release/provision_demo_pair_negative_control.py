#!/usr/bin/env python3
"""Offline negative controls for scripts/release/provision_demo_pair.py.

WHY THIS EXISTS
  provision_demo_pair.py is allowed to touch the LIVE project only in the submission week with the
  owner's go — and the owner was in the app the night this was written. So every safety claim it
  makes has to be proven WITHOUT the live project:
    (a) the dry run sends ZERO write requests;
    (b) each refusal exits with its own non-zero code and zero write requests;
    (c) the apply guard is load-bearing — a deliberately weakened copy of the SAME script DOES write;
    (d) the happy path issues exactly the intended sequence, and nothing else.

HOW IT WORKS (no live project, no real credentials, nothing leaves the process)
  * the REAL `main()` of provision_demo_pair runs, unmodified (except in the mutation controls),
    against a LOCAL HTTP STUB that re-implements the app's server side: the Auth admin surface, the
    PostgREST tables with the schema's own RLS shape (users/groups/memberships/invites are own-row,
    checked against the caller's JWT `sub`, so a run that used the service key where the APP uses
    the seat's own session is caught), and `join_group` with schema.sql:619-676 semantics including
    the capacity of 3 and the hardcoded joiner goal. The stub applies the `logged_at=gte.<ts>` week
    filter the script sends, so the week arithmetic genuinely runs.
  * only `pdp.supabase_config` is moved (to point at 127.0.0.1) — plus `pdp.http_send` in one
    scenario that proves the transport seam is never even called in a dry run.
  * `os.environ` is patched per scenario for the opt-in value and restored afterwards.
  * the script's stdout+stderr are CAPTURED and scanned for every secret in play (service key, anon
    key, demo password, the run's invite token) and for every uuid in the fixture — nothing may
    appear. The captured text is then printed here, so the refusal messages land in the evidence.
  * exit codes are captured DIRECTLY from `main()`'s return value — never through a pipe.

SCENARIOS  (see --list for the machine-readable table)
  dry-run / dry-run-sender-recorder   -> exit 0, ZERO requests, plan printed
  preflight-clean                     -> exit 0, reads only, ZERO writes
  preflight-401                       -> exit 10, ZERO writes
  missing-credential / anon-key-as-service -> exit 10, LITERALLY ZERO requests
  conflict-half-pair / -unconfirmed / -third-party -> exit 11, ZERO writes
  foreign-invite-token / foreign-session           -> exit 12, ZERO writes
  apply-without-optin                 -> exit 13, LITERALLY ZERO requests
  env-only-no-apply                   -> exit 0, ZERO requests (the env var alone is inert)
  apply-happy-path                    -> exit 0, EXACTLY the intended non-GET sequence
  apply-repeat-is-idempotent          -> exit 0, ZERO writes on an already-provisioned pair
  contract-broken                     -> exit 2, ZERO requests
  MUTATION-no-apply-guard / -no-env-optin -> the weakened copy WRITES (the guard is load-bearing)
  MUTATION-no-week-filter             -> the stale log IS counted, so the week filter is what
                                         excluded it in the unmutated run
  self-test                           -> the in-script offline self-test

USAGE (from the repo root; each line prints its own raw exit code)
  python3 scripts/release/provision_demo_pair_negative_control.py --list
  python3 scripts/release/provision_demo_pair_negative_control.py dry-run; echo "exit=$?"
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import http.server
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import provision_demo_pair as pdp  # noqa: E402  (path set above on purpose)

# --------------------------------------------------------------------------------------------- #
# Fixtures.
# --------------------------------------------------------------------------------------------- #
def uuidish(number: int) -> str:
    return f"{number:08d}-1111-4111-8111-{number:012d}"


DEMO_ID = uuidish(101)
DEMO2_ID = uuidish(102)
OTHER_ID = uuidish(103)
OTHER2_ID = uuidish(104)
OTHER3_ID = uuidish(105)
PERSONAL_DEMO = uuidish(201)
PERSONAL_DEMO2 = uuidish(202)
SHARED_GROUP = uuidish(301)
CREATED_DEMO_ID = uuidish(501)   # the id the stub hands back for a newly created demo@
CREATED_DEMO2_ID = uuidish(502)


def _b64(obj: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")


def make_jwt(sub: str, role: str) -> str:
    return f"eyJhbGciOiJIUzI1NiJ9.{_b64({'sub': sub, 'role': role})}.negative-control-signature"


SERVICE_KEY = make_jwt(uuidish(1), "service_role")
ANON_KEY = make_jwt(uuidish(2), "anon")
OPT_IN = {pdp.APPLY_OPT_IN_ENV: pdp.APPLY_OPT_IN_VALUE}
PASSWORD = pdp.DEMO_PASSWORD


def _stale_iso() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")


class State:
    """The live side of the app, as far as this script can see it."""

    def __init__(self) -> None:
        self.users: dict[str, dict] = {}          # email -> row
        self.groups: dict[str, dict] = {}         # id -> row
        self.memberships: list[dict] = []
        self.invites: list[dict] = []
        self.workouts: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.admin_status = 200
        self.foreign_session_for: str | None = None
        self.invite_token_owner: str | None = None
        self.stale_log_for_created_demo = False
        self.week_filter_seen: str | None = None
        self.invites_created: list[str] = []
        self.memberships_written: list[tuple[str, str]] = []
        self._seq = 500

    # -- fixtures ------------------------------------------------------------------------------ #
    def add_user(self, email: str, uid: str, *, confirmed: bool = True,
                 password: str = PASSWORD) -> None:
        self.users[email] = {"id": uid, "email": email, "password": password,
                             "email_confirmed_at": ("2026-10-05T00:00:00Z" if confirmed else None)}

    def add_group(self, gid: str, name: str, creator: str) -> None:
        self.groups[gid] = {"id": gid, "name": name, "creator_id": creator}

    def seat(self, gid: str, uid: str, goal: int = 3, role: str = "admin") -> None:
        self.memberships.append({"group_id": gid, "user_id": uid, "weekly_goal": goal,
                                 "role": role})

    def members_of(self, gid: str) -> list[dict]:
        return [m for m in self.memberships if m["group_id"] == gid]

    # -- request log --------------------------------------------------------------------------- #
    def kind(self, method: str, path: str) -> str:
        if method == "GET":
            return "read"
        if path.startswith("/auth/v1/token"):
            return "auth"
        return "write"

    def counts(self) -> dict[str, int]:
        tally = {"read": 0, "auth": 0, "write": 0}
        for method, path in self.requests:
            tally[self.kind(method, path)] += 1
        return tally

    def non_get(self) -> list[list[str]]:
        return [[m, p] for m, p in self.requests if m != "GET"]

    def invite_tokens(self) -> list[str]:
        return [i["token"] for i in self.invites]

    def next_id(self) -> str:
        self._seq += 1
        return uuidish(self._seq)


def build_state(scenario: str) -> State:
    state = State()
    # Every scenario starts with the live footprint's shape: accounts that are NOT the demo pair
    # (the script must never touch them).
    state.add_user("owner@example.invalid", OTHER_ID)
    state.add_user("second@example.invalid", OTHER2_ID)
    state.add_user("third@example.invalid", OTHER3_ID)

    def seed_pair_existing(paired: bool) -> None:
        state.add_user(pdp.DEMO_EMAIL, DEMO_ID)
        state.add_user(pdp.DEMO2_EMAIL, DEMO2_ID)
        state.add_group(PERSONAL_DEMO, "Personal", DEMO_ID)
        state.seat(PERSONAL_DEMO, DEMO_ID)
        state.add_group(PERSONAL_DEMO2, "Personal", DEMO2_ID)
        state.seat(PERSONAL_DEMO2, DEMO2_ID)
        if paired:
            state.add_group(SHARED_GROUP, "Demo & Demo2", DEMO_ID)
            state.seat(SHARED_GROUP, DEMO_ID, goal=3, role="admin")
            state.seat(SHARED_GROUP, DEMO2_ID, goal=3, role="member")
            state.invites.append({"id": uuidish(601), "inviter_id": DEMO_ID,
                                  "token": "ABCDEFGH", "status": "pending"})

    if scenario == "conflict-half-pair":
        state.add_user(pdp.DEMO_EMAIL, DEMO_ID)
        state.add_group(PERSONAL_DEMO, "Personal", DEMO_ID)
        state.seat(PERSONAL_DEMO, DEMO_ID)

    if scenario == "conflict-unconfirmed":
        state.add_user(pdp.DEMO_EMAIL, DEMO_ID, confirmed=False)
        state.add_user(pdp.DEMO2_EMAIL, DEMO2_ID)

    if scenario == "conflict-third-party":
        state.add_user(pdp.DEMO_EMAIL, DEMO_ID)
        state.add_user(pdp.DEMO2_EMAIL, DEMO2_ID)
        state.add_group(SHARED_GROUP, "Someone & Demo", DEMO_ID)
        state.seat(SHARED_GROUP, DEMO_ID)
        state.seat(SHARED_GROUP, OTHER_ID, role="member")

    if scenario in ("foreign-invite-token", "foreign-session"):
        seed_pair_existing(paired=False)
    if scenario == "foreign-invite-token":
        state.invite_token_owner = OTHER_ID
    if scenario == "foreign-session":
        state.foreign_session_for = pdp.DEMO_EMAIL
    if scenario == "apply-repeat-is-idempotent":
        seed_pair_existing(paired=True)
    if scenario == "preflight-401":
        state.admin_status = 401
    if scenario in ("apply-happy-path", "MUTATION-no-env-optin", "MUTATION-no-week-filter"):
        # A log from LAST week for the demo seat the run creates: the verify step must NOT count it.
        # MUTATION-no-week-filter drops the filter and the same row IS counted — which is how the
        # filter is shown to be load-bearing rather than decorative.
        state.stale_log_for_created_demo = True
    return state


# --------------------------------------------------------------------------------------------- #
# The stub server.
# --------------------------------------------------------------------------------------------- #
class StubServer:
    def __init__(self, state: State) -> None:
        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                pass

            # -- plumbing --------------------------------------------------------------------- #
            def _body(self) -> dict:
                length = int(self.headers.get("Content-Length") or 0)
                if not length:
                    return {}
                return json.loads(self.rfile.read(length).decode() or "{}")

            def _reply(self, code: int, payload: object) -> None:
                body = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _bearer(self) -> str:
                raw = self.headers.get("Authorization", "")
                return raw[7:] if raw.startswith("Bearer ") else ""

            def _caller(self) -> tuple[str | None, bool]:
                """(uid, is_service_role). A user JWT carries its own `sub`, and the stub enforces
                the schema's own-row RLS against it — so a run that used the service key where the
                APP uses the seat's own session is caught right here."""
                token = self._bearer()
                if token == SERVICE_KEY:
                    return None, True
                claims = pdp.jwt_claims(token)
                return (str(claims.get("sub") or "") or None), False

            def _query(self) -> dict[str, list[str]]:
                return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

            def _eq(self, field: str) -> str | None:
                raw = (self._query().get(field) or [None])[0]
                return raw[3:] if raw and raw.startswith("eq.") else None

            # -- GET -------------------------------------------------------------------------- #
            def do_GET(self) -> None:  # noqa: N802
                # A stub bug must look like a SERVER error, never like a transport fault: an
                # unhandled exception here would close the socket and the script would report a
                # network fault instead of the real reason. (This is how the unencoded `+00:00`
                # week boundary was found: it produced a diagnosable 500, not a phantom timeout.)
                try:
                    self._route_get()
                except Exception as exc:  # noqa: BLE001
                    self._reply(500, {"message": f"{type(exc).__name__}: {exc}"})

            def _route_get(self) -> None:
                path = urllib.parse.urlparse(self.path).path
                state.requests.append(("GET", self.path))
                if path == "/auth/v1/admin/users":
                    if state.admin_status != 200:
                        return self._reply(state.admin_status, {"msg": "invalid claim: bad jwt"})
                    return self._reply(200, {"users": [
                        {"id": u["id"], "email": u["email"],
                         "email_confirmed_at": u["email_confirmed_at"]}
                        for u in state.users.values()], "aud": "authenticated"})
                if path == "/rest/v1/memberships":
                    uid, gid = self._eq("user_id"), self._eq("group_id")
                    rows = [m for m in state.memberships
                            if (uid is None or m["user_id"] == uid)
                            and (gid is None or m["group_id"] == gid)]
                    return self._reply(200, rows)
                if path == "/rest/v1/invites":
                    if state.invite_token_owner:
                        return self._reply(200, [{"inviter_id": state.invite_token_owner}])
                    token = self._eq("token")
                    rows = [i for i in state.invites if token is None or i["token"] == token]
                    return self._reply(200, [{"inviter_id": i["inviter_id"]} for i in rows])
                if path == "/rest/v1/groups":
                    creator = self._eq("creator_id")
                    return self._reply(200, [{"id": g["id"]} for g in state.groups.values()
                                             if creator is None or g["creator_id"] == creator])
                if path == "/rest/v1/workouts":
                    uid = self._eq("user_id")
                    gte = (self._query().get("logged_at") or [None])[0]
                    cut = None
                    if gte and gte.startswith("gte."):
                        cut = datetime.fromisoformat(gte[4:].replace("Z", "+00:00"))
                        state.week_filter_seen = gte
                    rows = []
                    for w in state.workouts:
                        if uid is not None and w["user_id"] != uid:
                            continue
                        when = datetime.fromisoformat(w["logged_at"].replace("Z", "+00:00"))
                        if cut is not None and when < cut:
                            continue
                        rows.append({"id": w["id"]})
                    return self._reply(200, rows)
                return self._reply(404, {"message": "no route"})

            # -- POST ------------------------------------------------------------------------- #
            def do_POST(self) -> None:  # noqa: N802
                try:
                    self._route_post()
                except Exception as exc:  # noqa: BLE001
                    self._reply(500, {"message": f"{type(exc).__name__}: {exc}"})

            def _route_post(self) -> None:
                path = urllib.parse.urlparse(self.path).path
                body = self._body()
                state.requests.append(("POST", self.path))
                if path == "/auth/v1/admin/users":
                    return self._create_user(body)
                if path == "/auth/v1/token":
                    return self._token(body)
                if path == "/rest/v1/rpc/join_group":
                    return self._join_group(body)
                return self._table_write(path, body)

            # -- auth ------------------------------------------------------------------------- #
            def _create_user(self, body: dict) -> None:
                email = str(body.get("email") or "")
                if email in state.users:
                    return self._reply(422, {"code": 422, "msg": "User already registered"})
                if not body.get("email_confirm"):
                    return self._reply(400, {"msg": "email_confirm must be true"})
                uid = CREATED_DEMO_ID if email == pdp.DEMO_EMAIL else CREATED_DEMO2_ID
                state.add_user(email, uid, confirmed=True, password=str(body.get("password") or ""))
                if state.stale_log_for_created_demo and email == pdp.DEMO_EMAIL:
                    state.workouts.append({"id": state.next_id(), "user_id": uid,
                                           "logged_at": _stale_iso()})
                return self._reply(200, {"id": uid, "email": email,
                                         "email_confirmed_at": "2026-10-05T00:00:00Z"})

            def _token(self, body: dict) -> None:
                email = str(body.get("email") or "")
                user = state.users.get(email)
                if not user or body.get("password") != user["password"]:
                    return self._reply(400, {"error_code": "invalid_credentials",
                                             "error_description": "Invalid login credentials"})
                uid = OTHER_ID if state.foreign_session_for == email else user["id"]
                return self._reply(200, {"access_token": make_jwt(uid, "authenticated"),
                                         "user": {"id": uid, "email": email}})

            # -- the app's own pairing path (schema.sql:619-676) -------------------------------- #
            def _join_group(self, body: dict) -> None:
                uid, service = self._caller()
                if service or not uid:
                    return self._reply(401, {"message": "auth required"})
                token = str(body.get("p_token") or "")
                invite = next((i for i in state.invites if i["token"] == token), None)
                if invite is None:
                    return self._reply(400, {"message": "code not found"})
                if invite["status"] != "pending":
                    return self._reply(400, {"message": "already accepted"})
                if invite["inviter_id"] == uid:
                    return self._reply(400, {"message": "you cannot accept your own invite"})
                gid = None
                for membership in state.memberships:
                    if membership["user_id"] == invite["inviter_id"] \
                            and len(state.members_of(membership["group_id"])) >= 2:
                        gid = membership["group_id"]
                if gid is None:
                    inviter = next((u for u in state.users.values()
                                    if u["id"] == invite["inviter_id"]), None)
                    joiner = next((u for u in state.users.values() if u["id"] == uid), None)
                    first = inviter["email"].split("@")[0] if inviter else "Partner"
                    first2 = joiner["email"].split("@")[0] if joiner else "You"
                    gid = state.next_id()
                    state.add_group(gid, f"{first} & {first2}", invite["inviter_id"])
                    goals = [m["weekly_goal"] for m in state.memberships
                             if m["user_id"] == invite["inviter_id"]]
                    state.seat(gid, invite["inviter_id"], goal=(goals[-1] if goals else 3))
                members = state.members_of(gid)
                cnt = len(members)
                if any(m["user_id"] == uid for m in members):
                    return self._reply(400, {"message": "you are already in this group"})
                if cnt >= 3:
                    return self._reply(400, {"message": "this group is full"})
                state.seat(gid, uid, goal=3, role="member")
                return self._reply(200, {"ok": True, "group_id": gid, "member_count": cnt + 1,
                                         "inviter_name": "Demo"})

            # -- PostgREST table writes, under the schema's own-row RLS ------------------------- #
            def _table_write(self, path: str, body: dict) -> None:
                uid, service = self._caller()
                if service:
                    return self._reply(403, {"message": "the app never writes with the service key"})
                table = path.rsplit("/", 1)[-1]
                if table == "users":
                    if uid != body.get("id"):
                        return self._reply(403, {"message": "new row violates row-level security "
                                                            "policy (users_insert_own)"})
                    return self._reply(201, [body])
                if table == "groups":
                    if uid != body.get("creator_id"):
                        return self._reply(403, {"message": "new row violates row-level security "
                                                            "policy (groups_insert_own)"})
                    gid = state.next_id()
                    state.add_group(gid, str(body.get("name") or "Personal"), uid)
                    return self._reply(201, [{"id": gid}])
                if table == "memberships":
                    if uid != body.get("user_id"):
                        return self._reply(403, {"message": "new row violates row-level security "
                                                            "policy (memberships_insert_own)"})
                    group = state.groups.get(str(body.get("group_id") or ""))
                    if group is None or group["creator_id"] != uid:
                        return self._reply(403, {"message": "membership insert requires owning "
                                                            "the group"})
                    for m in state.memberships:
                        if m["group_id"] == body["group_id"] and m["user_id"] == body["user_id"]:
                            m.update({"weekly_goal": body["weekly_goal"], "role": body["role"]})
                            state.memberships_written.append((m["group_id"], m["user_id"]))
                            return self._reply(200, [m])
                    state.seat(str(body["group_id"]), str(body["user_id"]),
                               goal=int(body["weekly_goal"]), role=str(body["role"]))
                    state.memberships_written.append((body["group_id"], body["user_id"]))
                    return self._reply(201, [body])
                if table == "invites":
                    if uid != body.get("inviter_id"):
                        return self._reply(403, {"message": "new row violates row-level security "
                                                            "policy (invites_insert_own)"})
                    for i in state.invites:
                        if i["token"] == body.get("token"):
                            return self._reply(200, [i])
                    row = {"id": state.next_id(), "inviter_id": uid, "token": body["token"],
                           "status": "pending"}
                    state.invites.append(row)
                    state.invites_created.append(row["token"])
                    return self._reply(201, [row])
                return self._reply(404, {"message": "no route"})

        self.state = state
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


# --------------------------------------------------------------------------------------------- #
# Running one scenario.
# --------------------------------------------------------------------------------------------- #
class Recorder:
    """Stands in for http_send: a dry run must never call it."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None,
                 timeout: float = 0) -> tuple[int, bytes]:
        self.calls.append((method, url))
        raise AssertionError("http_send was called — nothing should have been sent")


def _patched_module(needle: str, replacement: str) -> dict:
    """A copy of the REAL script with exactly one literal replaced — nothing else differs."""
    with open(pdp.__file__) as fh:
        source = fh.read()
    if source.count(needle) != 1:
        raise AssertionError(f"mutation anchor appears {source.count(needle)}x, not once: {needle!r}")
    patched = source.replace(needle, replacement)
    if patched == source:
        raise AssertionError("the mutation changed nothing — the guard would be vacuous")
    namespace: dict = {"__name__": "pdp_mutated", "__file__": pdp.__file__}
    exec(compile(patched, pdp.__file__, "exec"), namespace)  # noqa: S102 (deliberate)
    return namespace


def run_one(scenario: str, spec: dict, *, mutated: dict | None = None,
            schema_path: str | None = None) -> dict:
    """Run the real main() against the stub and return everything the assertions need."""
    state = build_state(scenario)
    server = StubServer(state)
    module = mutated or vars(pdp)
    url = f"http://127.0.0.1:{server.port}"
    argv = list(spec["argv"])
    env = dict(spec.get("env", {}))
    service_key = spec.get("service_key", SERVICE_KEY)

    saved_config = vars(pdp)["supabase_config"]
    saved_send = pdp.http_send
    saved_schema = pdp.SCHEMA_PATH
    saved_env = dict(os.environ)
    recorder = Recorder()
    vars(pdp)["supabase_config"] = lambda: (url, ANON_KEY, service_key)
    module["supabase_config"] = vars(pdp)["supabase_config"]
    pdp._CONTRACT_CACHE.clear()  # every scenario must re-read the repo contract
    if schema_path:
        pdp.SCHEMA_PATH = schema_path
    if spec.get("recorder"):
        pdp.http_send = recorder
        module["http_send"] = recorder
    os.environ.pop(pdp.APPLY_OPT_IN_ENV, None)
    for key, value in env.items():
        os.environ[key] = value

    capture = io.StringIO()
    print(f"\n===== scenario {scenario} =====")
    print(f"[harness] argv  = {argv or '(none — the default dry run)'}")
    print(f"[harness] env   = {env or '(no opt-in)'}")
    print(f"[harness] stub  = {url}  (loopback only; nothing leaves this process)")
    print(f"[harness] sender = {'RECORDER (http_send raises if called)' if spec.get('recorder') else 'real urllib -> the local stub'}")
    if mutated:
        print("[harness] running a MUTATED copy of the script (one guard deliberately weakened)")
    try:
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            code = module["main"](argv)
    finally:
        vars(pdp)["supabase_config"] = saved_config
        pdp.http_send = saved_send
        pdp.SCHEMA_PATH = saved_schema
        os.environ.clear()
        os.environ.update(saved_env)
        server.stop()

    text = capture.getvalue()
    counts = state.counts()
    non_get = state.non_get()
    print(f"[harness] script exit code = {code}   (captured directly, not through a pipe)")
    print(f"[harness] requests reaching the stub: {len(state.requests)} — "
          f"{counts['read']} read(s), {counts['auth']} auth/token POST(s), {counts['write']} WRITE(s)")
    print(f"[harness] every non-GET: {[f'{m} {p}' for m, p in non_get] or 'NONE'}")
    if spec.get("recorder"):
        print(f"[harness] http_send calls: {len(recorder.calls)} (a dry run must never call it)")
    for gid in state.groups:
        members = state.members_of(gid)
        if len(members) >= 2:
            ids = sorted(m["user_id"] for m in members)
            print(f"[harness] shared group {gid}: {len(members)} seats, ids == the two demo accounts: "
                  f"{ids == sorted([DEMO_ID, DEMO2_ID]) or ids == sorted([CREATED_DEMO_ID, CREATED_DEMO2_ID])}")
    print(f"[harness] invites rows created by the run: {len(state.invites_created)}")
    print(f"[harness] workouts rows for a demo seat in the fixture: "
          f"{len([w for w in state.workouts if w['user_id'] in (CREATED_DEMO_ID, CREATED_DEMO2_ID, DEMO_ID, DEMO2_ID)])}"
          " (all of them from LAST week)")
    print(f"[harness] week filter the script actually sent: {state.week_filter_seen or 'NONE'}")

    # ---- output hygiene: no secret, no id, no stranger's address ------------------------------ #
    problems: list[str] = []
    for label, secret in (("the service key", service_key), ("the anon key", ANON_KEY),
                          ("the demo password", PASSWORD)):
        if secret and len(secret) >= 8 and secret in text:
            problems.append(f"{label} appears in the script's output")
    for token in state.invite_tokens():
        if token in text:
            problems.append("a generated invite token appears in the script's output")
    for ident in (DEMO_ID, DEMO2_ID, CREATED_DEMO_ID, CREATED_DEMO2_ID, OTHER_ID, OTHER2_ID, OTHER3_ID):
        if ident in text:
            problems.append(f"a uuid ({ident}) appears in the script's output")
    for address in ("owner@example.invalid", "second@example.invalid", "third@example.invalid"):
        if address in text:
            problems.append(f"a stranger's address ({address}) appears in the script's output")
            break
    print(f"[harness] output hygiene: {'CLEAN' if not problems else 'PROBLEM — ' + '; '.join(problems)}")
    print("[harness] --- script output, verbatim (already redacted by the script) ---")
    for line in text.splitlines():
        print(f"[script] {line}")
    print("[harness] --- end script output ---")
    return {"code": code, "hygiene": problems, "text": text, "counts": counts,
            "non_get": non_get, "requests": len(state.requests),
            "recorder_calls": len(recorder.calls), "state": state}


# --------------------------------------------------------------------------------------------- #
# Scenario table and expectations.
# --------------------------------------------------------------------------------------------- #
EXPECTED_HAPPY_SEQUENCE = [
    ["POST", "/auth/v1/admin/users"],
    ["POST", "/auth/v1/admin/users"],
    ["POST", "/auth/v1/token?grant_type=password"],
    ["POST", "/rest/v1/users?on_conflict=id"],
    ["POST", "/rest/v1/groups?select=id"],
    ["POST", "/rest/v1/memberships?on_conflict=group_id,user_id"],
    ["POST", "/auth/v1/token?grant_type=password"],
    ["POST", "/rest/v1/users?on_conflict=id"],
    ["POST", "/rest/v1/groups?select=id"],
    ["POST", "/rest/v1/memberships?on_conflict=group_id,user_id"],
    ["POST", "/rest/v1/invites?on_conflict=token"],
    ["POST", "/rest/v1/rpc/join_group"],
]

SCENARIOS: dict[str, dict] = {
    "dry-run": {"expect": 0, "argv": [], "requests": 0, "writes": 0,
                "forbid_text": ["[call]", "LIVE —"]},
    "dry-run-sender-recorder": {"expect": 0, "argv": [], "requests": 0, "writes": 0,
                                "recorder": True, "recorder_calls": 0},
    "preflight-clean": {"expect": 0, "argv": ["--preflight"], "writes": 0,
                        "require_text": ["VERDICT: safe to provision", "wrote NOTHING"]},
    "preflight-401": {"expect": 10, "argv": ["--preflight"], "writes": 0,
                      "require_text": ["REFUSED (exit 10)", "was REFUSED"]},
    "missing-credential": {"expect": 10, "argv": [], "requests": 0, "writes": 0,
                           "service_key": "", "require_text": ["Zero requests sent"]},
    "anon-key-as-service": {"expect": 10, "argv": [], "requests": 0, "writes": 0,
                            "service_key": ANON_KEY,
                            "require_text": ["not 'service_role'", "Zero requests sent"]},
    "conflict-half-pair": {"expect": 11, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                           "require_text": ["CONFLICTING SHAPE", "only demo@spotterworkout.com exists"]},
    "conflict-unconfirmed": {"expect": 11, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                             "require_text": ["NOT email-confirmed"]},
    "conflict-third-party": {"expect": 11, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                             "require_text": ["already seated in a shared group"]},
    "foreign-invite-token": {"expect": 12, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                             "require_text": ["already belongs to a different account"]},
    "foreign-session": {"expect": 12, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                        "require_text": ["not one of the two demo seats"]},
    "apply-without-optin": {"expect": 13, "argv": ["--apply"], "requests": 0, "writes": 0,
                            "require_text": ["Two locks are required"]},
    "env-only-no-apply": {"expect": 0, "argv": [], "env": OPT_IN, "requests": 0, "writes": 0,
                          "require_text": ["DRY RUN"], "forbid_text": ["[call] "]},
    "apply-happy-path": {"expect": 0, "argv": ["--apply"], "env": OPT_IN, "writes": 10,
                         "exact_sequence": EXPECTED_HAPPY_SEQUENCE,
                         "require_text": ["[verify] demo: 0 live-camera log",
                                          "[verify] demo2: 0 live-camera log"]},
    "apply-repeat-is-idempotent": {"expect": 0, "argv": ["--apply"], "env": OPT_IN, "writes": 0,
                                   "require_text": ["already provisioned"]},
    "contract-broken": {"expect": 2, "argv": [], "requests": 0, "writes": 0,
                        "broken_schema": True,
                        "require_text": ["no longer matches the app path"]},
    "MUTATION-no-apply-guard": {"expect": 0, "argv": [], "env": OPT_IN, "writes_min": 1,
                                "mutate": (
        '    if not getattr(args, "apply", False):\n'
        '        return False, "no --apply flag (dry run by default)"',
        '    if False:  # MUTATION: the --apply requirement is gone\n'
        '        return False, "no --apply flag (dry run by default)"')},
    "MUTATION-no-env-optin": {"expect": 0, "argv": ["--apply"], "env": OPT_IN, "writes_min": 1,
                              "mutate": (
        "    if env.get(APPLY_OPT_IN_ENV) != APPLY_OPT_IN_VALUE:",
        "    if False:  # MUTATION: the env opt-in requirement is gone")},
    "MUTATION-no-week-filter": {"expect": 0, "argv": ["--apply"], "env": OPT_IN, "writes_min": 1,
                                "mutate": (
        '&logged_at=gte.{q(since)}', ''),
                                "require_text": ["[verify] demo: 1 live-camera log"]},
    "self-test": {"expect": 0, "argv": ["--self-test"], "requests": 0, "writes": 0,
                  "require_text": ["self-test — 29/29 checks passed"]},
}

STATIC_SCENARIOS = {"self-test"}


def write_broken_schema(directory: str) -> str:
    """A schema.sql that no longer defines join_group — the contract check must refuse."""
    path = os.path.join(directory, "schema.sql")
    with open(pdp.SCHEMA_PATH) as fh:
        source = fh.read()
    broken = source.replace("public.join_group(p_token text)", "public.join_squad(p_token text)")
    if broken == source:
        raise AssertionError("could not break the schema copy")
    with open(path, "w") as fh:
        fh.write(broken)
    return path


def check_expectations(spec: dict, result: dict) -> list[str]:
    failures: list[str] = []
    if result["code"] != spec["expect"]:
        failures.append(f"exit code {result['code']} != expected {spec['expect']}")
    if "writes" in spec and result["counts"]["write"] != spec["writes"]:
        failures.append(f"{result['counts']['write']} write(s) != expected {spec['writes']}")
    if "writes_min" in spec and result["counts"]["write"] < spec["writes_min"]:
        failures.append(f"{result['counts']['write']} write(s) < required {spec['writes_min']}")
    if "requests" in spec and result["requests"] != spec["requests"]:
        failures.append(f"{result['requests']} request(s) reached the stub != expected {spec['requests']}")
    if "recorder_calls" in spec and result["recorder_calls"] != spec["recorder_calls"]:
        failures.append(f"http_send was called {result['recorder_calls']}x")
    if "exact_sequence" in spec and result["non_get"] != spec["exact_sequence"]:
        failures.append("the non-GET sequence is not exactly the intended one")
    for needle in spec.get("require_text", []):
        if needle not in result["text"]:
            failures.append(f"missing from output: {needle!r}")
    for needle in spec.get("forbid_text", []):
        if needle in result["text"]:
            failures.append(f"must NOT appear in output: {needle!r}")
    failures.extend(result["hygiene"])
    return failures


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", nargs="?", help="scenario name (see --list)")
    ap.add_argument("--list", action="store_true", help="list scenarios and their expected exits")
    args = ap.parse_args(argv)

    if args.list or not args.scenario:
        for name, spec in SCENARIOS.items():
            print(f"{name:28s} expect exit {spec['expect']:3d}  "
                  f"{' '.join(spec['argv']) or '(default dry run)'}")
        return 0

    spec = SCENARIOS.get(args.scenario)
    if spec is None:
        raise SystemExit(f"unknown scenario {args.scenario!r} — try --list")

    scratch = tempfile.mkdtemp(prefix="provision-demo-nc-")
    schema_path = None
    mutated = None
    try:
        if spec.get("broken_schema"):
            schema_path = write_broken_schema(scratch)
        if spec.get("mutate"):
            needle, replacement = spec["mutate"]
            mutated = _patched_module(needle, replacement)
        result = run_one(args.scenario, spec, mutated=mutated, schema_path=schema_path)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    failures = check_expectations(spec, result)
    print(f"\n[harness] expected exit {spec['expect']}, got {result['code']} — "
          f"{'OK' if result['code'] == spec['expect'] else 'MISMATCH'}")
    for failure in failures:
        print(f"[harness]   FAILURE: {failure}")
    print(f"[harness] RESULT: {'PASS' if not failures else 'FAIL'}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
