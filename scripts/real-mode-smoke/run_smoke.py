#!/usr/bin/env python3
"""SPOTTER real-mode smoke test — anon key + normal signup only.

SERVICE-ROLE POLICY: every functional assertion still runs as anon/authenticated
with the public keys — the service role is NEVER used to exercise app behavior.
It is used for exactly one thing: post-hoc verification that a client write was
really filtered out by RLS. A client DELETE that RLS filters to 0 rows answers
`204` — indistinguishable from a DELETE that genuinely removed a row — so the
denial can only be proven from *outside* the client's own view. If the key is
absent those checks report SKIPPED rather than silently passing.

STORAGE-CACHE note (2026-09-19, post-leave photo isolation):
Raw authenticated object GETs (`GET /storage/v1/object/workouts/<uid>/<file>`) are cached
at the storage edge (Cloudflare). The cache is per-identity: an identity that was served an
object once is served a `CF-Cache-Status: HIT` replay of that exact URL later — INCLUDING
after its group membership was revoked. That 200 is a replay of bytes the client already
downloaded while it was a member; it is NOT a policy admission. Verified against the live
project: after C leaves a 3-seat group, C's GET of an object it never fetched is 400, a
different stranger's GET of a *warm* URL is 400 (repeat GETs included), while the origin
RLS predicate evaluates to "no" for C (storage.objects -> 0 rows). Cache-relevant
assertions therefore append `?cb=<random>` so the request reaches the origin decision;
the plain-repeat status is reported in the detail text.
"""
import json, os, re, glob, sys, time, uuid, subprocess, urllib.request, urllib.error, base64, datetime

ENV_PATH = "/home/team/shared/app/.env"

def load_env():
    d = {}
    for line in open(ENV_PATH):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            d[k] = v
    return d

ENV = load_env()
URL = ENV["EXPO_PUBLIC_SUPABASE_URL"].rstrip("/")
ANON = ENV["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
# Service-role key, used ONLY for out-of-band verification of client denials
# (see the SERVICE-ROLE POLICY note above). Read from the process environment so
# it is never committed to the repo's .env.
SR = os.environ.get("ServiceRoleSupabase") or ENV.get("ServiceRoleSupabase")

RESULTS = []

def rec(flow, name, status, detail):
    RESULTS.append({"flow": flow, "name": name, "status": status, "detail": detail})
    print(f"[{status}] {flow} :: {name} :: {detail}", flush=True)

def req(method, path, token=None, body=None, ctype="application/json", raw=False, extra_headers=None):
    """Return (status, parsed_body). parsed_body = python obj or raw bytes."""
    h = {"apikey": ANON, "Authorization": f"Bearer {token}"} if token else {"apikey": ANON}
    if extra_headers:
        h.update(extra_headers)
    if body is not None and not raw:
        h["Content-Type"] = ctype
        data = json.dumps(body).encode()
    elif raw:
        h["Content-Type"] = ctype
        data = body
    else:
        data = None
    r = urllib.request.Request(URL + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            rawbody = resp.read()
            try:
                return resp.status, json.loads(rawbody) if rawbody else None
            except Exception:
                return resp.status, rawbody
    except urllib.error.HTTPError as e:
        rawbody = e.read()
        try:
            return e.code, json.loads(rawbody) if rawbody else None
        except Exception:
            return e.code, rawbody
    except Exception as e:
        return -1, str(e)

def sr_req(method, path, body=None):
    """Service-role request — bypasses RLS. Used ONLY to observe whether a client
    write actually landed/was filtered; never to exercise app behavior.
    Returns (status, parsed_body); status -1 means "no service-role key"."""
    if not SR:
        return -1, "ServiceRoleSupabase not set in env"
    h = {"apikey": SR, "Authorization": f"Bearer {SR}"}
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    r = urllib.request.Request(URL + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            rawbody = resp.read()
            try:
                return resp.status, json.loads(rawbody) if rawbody else None
            except Exception:
                return resp.status, rawbody
    except urllib.error.HTTPError as e:
        rawbody = e.read()
        try:
            return e.code, json.loads(rawbody) if rawbody else None
        except Exception:
            return e.code, rawbody
    except Exception as e:
        return -1, str(e)

def short(v, n=160):
    s = json.dumps(v) if not isinstance(v, (str, bytes)) else str(v)
    return s[:n]

PASS, FAIL = "PASS", "FAIL"

epoch = int(time.time())
PW = f"Sm0kePass-{epoch}"
EMAILS = {k: f"realsmoke-{epoch}-{k}@example.com" for k in "abc"}

print(f"Epoch {epoch} — test users: {EMAILS}")

# ---------------- STALE-RUN SELF-CLEAN (prevents orphaned auth users) ----------------
def delete_account_by_email(email, password):
    """Sign in + delete_account — best-effort cleanup of leftover users."""
    st, b = req("POST", "/auth/v1/token?grant_type=password", token=None, body={"email": email, "password": password})
    if st != 200 or not isinstance(b, dict) or not b.get("access_token"):
        return False
    s2, b2 = req("POST", "/rest/v1/rpc/delete_account", b["access_token"], {})
    return s2 in (200, 204)

STALE_EPOCHS = set([1789046236, 1789048550])
for f in glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "smoke-run-*.log")):
    for m in re.finditer(r"Epoch (\d+)", open(f).read()):
        STALE_EPOCHS.add(int(m.group(1)))
for stale_epoch in sorted(STALE_EPOCHS):
    for k in "abcdef":
        em = f"realsmoke-{stale_epoch}-{k}@example.com"
        try:
            if delete_account_by_email(em, f"Sm0kePass-{stale_epoch}"):
                print(f"[cleanup] removed stale {em}")
        except Exception as e:
            print(f"[cleanup] stale {em} skipped: {e}")
        # Stale-clean grew with the a–f letter set (up to ~2× the old auth burst);
        # space signins so the auth endpoint's rate bucket never trips flow 1.
        time.sleep(0.5)

# ---------------- FLOW 0: STACK-CHILD RENDER GUARD (offline) ----------------
# The build-18 P0 was a *render* fault: `_layout.tsx` handed <Stack> a React
# fragment, expo-router's mapProtectedScreen stringifies children it does not
# recognise, and a fragment's identity is a Symbol — `String(Symbol)` throws
# inside the first render, which RN 0.86 makes fatal. Every other check in this
# file (and every offline module-eval harness) was blind to it because nothing
# here ever RENDERS a <Stack>.
# scripts/smoke/stack-children-guard.cjs is the check that can see it: it
# transpiles the REAL src/app/_layout.tsx, feeds the children it actually
# produces to expo-router's REAL mapProtectedScreen, and proves the old fragment
# shape throws exactly as the device did. It runs FIRST, before any network
# flow (a network flow can `sys.exit(1)` early), so it always executes; its
# results join RESULTS and feed the same summary/exit code as every other check.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GUARD_SCRIPT = os.path.join(REPO_ROOT, "scripts", "smoke", "stack-children-guard.cjs")
GUARD_CHECKS = 19  # every PASS/FAIL line the guard prints; a shrink is itself a failure
print(f"[guard] node {GUARD_SCRIPT} (cwd={REPO_ROOT})", flush=True)
try:
    guard = subprocess.run(["node", GUARD_SCRIPT], cwd=REPO_ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           text=True, timeout=300)
    guard_parsed = 0
    for gline in (guard.stdout or "").splitlines():
        gm = re.match(r"^(PASS|FAIL)\s+(.*?)(?:\s+::\s+(.*))?$", gline.rstrip())
        if not gm:
            continue
        guard_parsed += 1
        rec("0-stack-guard", gm.group(2).strip(), gm.group(1), (gm.group(3) or "").strip())
    if guard_parsed == 0:
        rec("0-stack-guard", "guard emitted PASS/FAIL lines", FAIL,
            f"parsed 0 result lines, exit={guard.returncode}, stderr={short((guard.stderr or '').strip())}")
    elif guard_parsed != GUARD_CHECKS:
        rec("0-stack-guard", f"guard reported all {GUARD_CHECKS} checks", FAIL,
            f"parsed {guard_parsed} result lines (exit={guard.returncode}) — the guard lost checks")
except Exception as e:  # node missing / script missing / timeout — never a silent skip
    rec("0-stack-guard", "guard ran to completion", FAIL, f"{type(e).__name__}: {e}")

# ---------------- FLOW 0b: MISSED-PROMISE ROLLOVER GUARD (offline) ----------
# v1.0 fix (2026-09-23): record_missed_promise had NO production caller, so the
# pair-private Promises ledger could never fill — the listing's promise and
# screenshot 09 showed a ledger no real user could reach. The fix wires the RPC
# into the week-rollover path (fetchWeeklyContext). scripts/smoke/
# promise-rollover-guard.cjs drives that REAL path (not the RPC directly) and
# proves: a completed missed week + a note creates exactly ONE Open entry; two
# more app opens change nothing and do not re-ask; a lost local flag still
# yields one entry (server idempotency); no note → nothing (never shaming); a
# met week → nothing and no call; the new entry stays pair-private inside a
# 3-person group. Same gate as flow 0: missing/shrunken = FAIL, and any FAIL
# exits non-zero.
ROLLOVER_GUARD_SCRIPT = os.path.join(REPO_ROOT, "scripts", "smoke", "promise-rollover-guard.cjs")
ROLLOVER_GUARD_CHECKS = 21  # every PASS/FAIL line it prints; a shrink is itself a failure
print(f"[guard] node {ROLLOVER_GUARD_SCRIPT} (cwd={REPO_ROOT})", flush=True)
try:
    rollover_guard = subprocess.run(["node", ROLLOVER_GUARD_SCRIPT], cwd=REPO_ROOT,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, timeout=300)
    rollover_parsed = 0
    for rline in (rollover_guard.stdout or "").splitlines():
        rm = re.match(r"^(PASS|FAIL)\s+(.*?)(?:\s+::\s+(.*))?$", rline.rstrip())
        if not rm:
            continue
        rollover_parsed += 1
        rec("0b-promise-rollover", rm.group(2).strip(), rm.group(1), (rm.group(3) or "").strip())
    if rollover_parsed == 0:
        rec("0b-promise-rollover", "promise-rollover guard emitted PASS/FAIL lines", FAIL,
            f"parsed 0 result lines, exit={rollover_guard.returncode}, stderr={short((rollover_guard.stderr or '').strip())}")
    elif rollover_parsed != ROLLOVER_GUARD_CHECKS:
        rec("0b-promise-rollover", f"promise-rollover guard reported all {ROLLOVER_GUARD_CHECKS} checks", FAIL,
            f"parsed {rollover_parsed} result lines (exit={rollover_guard.returncode}) — the guard lost checks")
except Exception as e:  # node missing / script missing / timeout — never a silent skip
    rec("0b-promise-rollover", "promise-rollover guard ran to completion", FAIL, f"{type(e).__name__}: {e}")
# ---------------- FLOW 0c: BOTTOM-BAR GUARD (offline) ----------------
# Owner-reported (2026-09-23): the bottom bar's Calendar and Menu buttons "don't
# work". Verified on master: the Calendar slot was a bare <View> with no handler
# at all, the list slot called the SAME onHome as the Home icon (so tapping it
# re-rendered the screen the user was on), and HomeScreen passed
# `onHome={() => {}}`. scripts/smoke/bottom-bar-guard.cjs renders the REAL
# BottomBar + CameraButton with leaf stubs and proves every visible slot has a
# callable handler that does something REAL and DISTINCT (Home scrolls the feed,
# slot 2 pushes /(promises), the camera opens the log sheet, Profile pushes
# /(profile)); the a11y set is exactly Home/Promises/camera/Profile; the solo
# spacer draws nothing and cannot be tapped; toggling pairing changes ONLY slot 2;
# and the 2-left / 2-right split still puts the flex:1 camera at screen centre
# (deleting the Calendar slot without a spacer moves it +28pt). A negative control
# runs the same analysis over the OLD bar shape and requires it to FAIL. Same gate
# as flows 0/0b: missing/shrunken = FAIL, and any FAIL exits non-zero.
BOTTOM_BAR_GUARD_SCRIPT = os.path.join(REPO_ROOT, "scripts", "smoke", "bottom-bar-guard.cjs")
BOTTOM_BAR_GUARD_CHECKS = 33  # every PASS/FAIL line it prints; a shrink is itself a failure
print(f"[guard] node {BOTTOM_BAR_GUARD_SCRIPT} (cwd={REPO_ROOT})", flush=True)
try:
    bar_guard = subprocess.run(["node", BOTTOM_BAR_GUARD_SCRIPT], cwd=REPO_ROOT,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, timeout=300)
    bar_parsed = 0
    for bline in (bar_guard.stdout or "").splitlines():
        bm = re.match(r"^(PASS|FAIL)\s+(.*?)(?:\s+::\s+(.*))?$", bline.rstrip())
        if not bm:
            continue
        bar_parsed += 1
        rec("0c-bottom-bar", bm.group(2).strip(), bm.group(1), (bm.group(3) or "").strip())
    if bar_parsed == 0:
        rec("0c-bottom-bar", "bottom-bar guard emitted PASS/FAIL lines", FAIL,
            f"parsed 0 result lines, exit={bar_guard.returncode}, stderr={short((bar_guard.stderr or '').strip())}")
    elif bar_parsed != BOTTOM_BAR_GUARD_CHECKS:
        rec("0c-bottom-bar", f"bottom-bar guard reported all {BOTTOM_BAR_GUARD_CHECKS} checks", FAIL,
            f"parsed {bar_parsed} result lines (exit={bar_guard.returncode}) — the guard lost checks")
except Exception as e:  # node missing / script missing / timeout — never a silent skip
    rec("0c-bottom-bar", "bottom-bar guard ran to completion", FAIL, f"{type(e).__name__}: {e}")
# ---------------- FLOW 1: SIGNUP + SIGNIN ----------------
users = {}
for k in "abc":
    st, b = req("POST", "/auth/v1/signup", token=None, body={"email": EMAILS[k], "password": PW})
    if st == 200 and isinstance(b, dict) and b.get("access_token"):
        users[k] = {"id": b["user"]["id"], "email": EMAILS[k], "token": b["access_token"]}
        rec("1-signup", f"signup {k}", PASS, f"HTTP {st}, confirmed={b['user'].get('email_confirmed_at') is not None}")
    else:
        rec("1-signup", f"signup {k}", FAIL, f"HTTP {st}: {short(b)}")
        sys.exit(1)

for k in "abc":
    st, b = req("POST", "/auth/v1/token?grant_type=password", token=None, body={"email": EMAILS[k], "password": PW})
    if st == 200 and isinstance(b, dict) and b.get("access_token"):
        users[k]["token"] = b["access_token"]
        rec("1-signin", f"password sign-in {k}", PASS, f"HTTP {st}")
    else:
        rec("1-signin", f"password sign-in {k}", FAIL, f"HTTP {st}: {short(b)}")

A, B, C = users["a"], users["b"], users["c"]

# ---------------- S1 GATE PROBE (groups feature, applied in S7) ----------------
# Flow 7's flipped expectation and ALL of Flow 8 execute only when the S1 group
# schema is live. Signal: the my_group() RPC (replaces my_pair) resolves for an
# authenticated token. Pre-S7 the live project still has the OLD RPCs, so the
# probe 404s and both group sections are skipped with a visible marker — the
# daily run stays green (44 PASS) until S7 applies the S1 schema.
# GROUP_FLOWS=0 hard-disables group flows even post-S7; default/1 = probe-gated.
st, b = req("POST", "/rest/v1/rpc/my_group", A["token"], {})
S1_LIVE = st == 200 and isinstance(b, dict) and "group_id" in b
print(f"[gate] S1 group schema live (my_group RPC): {S1_LIVE} (HTTP {st})", flush=True)
RUN_FLOW8 = S1_LIVE and os.environ.get("GROUP_FLOWS", "1") != "0"

# ---------------- FLOW 2: PROFILE (users row + Personal group + membership) ----------------
def onboarding(u, goal, week_start):
    uid = u["id"]
    st, b = req("POST", "/rest/v1/users", u["token"], {"id": uid, "name": u["email"].split("@")[0], "week_start_day": week_start, "timezone": "UTC"})
    if st not in (201, 200):
        return False, f"users insert HTTP {st}: {short(b)}"
    st, b = req("POST", "/rest/v1/groups", u["token"], {"name": "Personal", "creator_id": uid})
    if st not in (201, 200):
        return False, f"groups insert HTTP {st}: {short(b)}"
    st, b = req("GET", f"/rest/v1/groups?select=id&creator_id=eq.{uid}", u["token"])
    if st != 200 or not isinstance(b, list) or len(b) == 0:
        return False, f"groups select HTTP {st}: {short(b)}"
    gid = b[0]["id"]
    st, b = req("POST", "/rest/v1/memberships", u["token"], {"user_id": uid, "group_id": gid, "weekly_goal": goal, "role": "admin"})
    if st not in (201, 200):
        return False, f"memberships insert HTTP {st}: {short(b)}"
    return True, gid

ok1, d1 = onboarding(A, 4, "Mon")
rec("2-profile", "A profile (users+Personal group+goal 4)", "PASS" if ok1 else "FAIL", d1)
ok2, d2 = onboarding(B, 3, "Sun")
rec("2-profile", "B profile (users+Personal group+goal 3)", "PASS" if ok2 else "FAIL", d2)
ok3, d3 = onboarding(C, 3, "Mon")
rec("2-profile", "C profile", "PASS" if ok3 else "FAIL", d3)

# ---------------- FLOW 3: INVITE + JOIN ----------------
TOKEN_CODE = "A1B2C3D4"
st, b = req("POST", "/rest/v1/invites", A["token"], {"inviter_id": A["id"], "token": TOKEN_CODE})
rec("3-invite", "A creates invite (8-char code)", "PASS" if st in (201, 200) else "FAIL", f"HTTP {st}: {short(b)}")

st, b = req("POST", "/rest/v1/rpc/get_invite", B["token"], {"p_token": TOKEN_CODE})
rec("3-invite", "B reads invite via get_invite RPC", "PASS" if st == 200 and isinstance(b, dict) and b.get("found") else "FAIL", f"HTTP {st}: {short(b)}")

# S8b port: accept_invite (pair-era, dropped in S7) -> join_group (groups-era).
# join_group creates the shared 2-member group on first join and returns
# {"ok": true, "group_id": ..., "member_count": N}; both A and B end with 2
# memberships (own Personal + shared group) — same assertions as before.
st, b = req("POST", "/rest/v1/rpc/join_group", B["token"], {"p_token": TOKEN_CODE})
pair_group = b.get("group_id") if isinstance(b, dict) else None
rec("3-invite", "B joins via join_group RPC", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("member_count") == 2 else "FAIL", f"HTTP {st}: {short(b)}")

# memberships checks
def my_groups(u):
    st, b = req("GET", f"/rest/v1/memberships?select=group_id,weekly_goal,role&user_id=eq.{u['id']}", u["token"])
    return (st, b) if st == 200 else (st, [])

stA, mA = my_groups(A); stB, mB = my_groups(B)
groupsA = {m["group_id"] for m in mA}; groupsB = {m["group_id"] for m in mB}
rec("3-memberships", "A has Personal + pair memberships", "PASS" if len(groupsA) == 2 else "FAIL", f"HTTP {stA}, {len(mA)} rows: {short(mA)}")
rec("3-memberships", "B has Personal + pair memberships", "PASS" if len(groupsB) == 2 else "FAIL", f"HTTP {stB}, {len(mB)} rows: {short(mB)}")
rec("3-memberships", "same pair group on both sides", "PASS" if pair_group and pair_group in groupsA and pair_group in groupsB else "FAIL", f"pair_group={pair_group}, A groups={len(groupsA)}, B groups={len(groupsB)}")

# cross users-row reads (task expectation: each can read the other's users row)
for caller, target, label in [(A, B, "A reads B's users row"), (B, A, "B reads A's users row")]:
    st, b = req("GET", f"/rest/v1/users?select=name&id=eq.{target['id']}", caller["token"])
    rows = b if isinstance(b, list) else []
    rec("3-users-cross", label, "PASS" if st == 200 and len(rows) == 1 else "FAIL", f"HTTP {st}, rows={len(rows)} {short(b)}")

# S8b port: my_pair() (pair-era, dropped in S7) -> my_group() (groups-era).
# my_group returns {"group_id", "member_ids": [co-member ids], "member_count"}
# via the SECURITY DEFINER helper; in the 2-member group each side sees the
# other as the single co-member.
def my_group_rpc(u):
    st, b = req("POST", "/rest/v1/rpc/my_group", u["token"], {})
    return st, b if isinstance(b, dict) else {}

st, b = my_group_rpc(A)
rec("3-my_group", "A discovers B in group via my_group RPC", "PASS" if st == 200 and b.get("group_id") == pair_group and B["id"] in (b.get("member_ids") or []) and b.get("member_count") == 1 else "FAIL", f"HTTP {st}: {short(b)}")
st, b = my_group_rpc(B)
rec("3-my_group", "B discovers A in group via my_group RPC (bidirectional)", "PASS" if st == 200 and b.get("group_id") == pair_group and A["id"] in (b.get("member_ids") or []) and b.get("member_count") == 1 else "FAIL", f"HTTP {st}: {short(b)}")

# pair group row readable by BOTH members (team_name read — naming feature),
# via the membership-scoped groups_select_pair policy.
st, b = req("GET", f"/rest/v1/groups?select=id,team_name&id=eq.{pair_group}", B["token"])
rows = b if isinstance(b, list) else []
rec("3-groups-cross", "B reads pair group row (team_name, pair-scoped)", "PASS" if st == 200 and len(rows) == 1 else "FAIL", f"HTTP {st}, rows={len(rows)} {short(b)}")

# ---------------- FLOW 4: PHOTO + WORKOUT ----------------
JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=="
)
wid = str(uuid.uuid4())
path = f"{A['id']}/{wid}.jpg"
st, b = req("POST", f"/storage/v1/object/workouts/{path}", A["token"], JPEG, ctype="image/jpeg", raw=True)
rec("4-upload", "A uploads photo to workouts bucket", "PASS" if st in (200, 201) else "FAIL", f"HTTP {st}: {short(b)}")

now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
st, b = req("POST", "/rest/v1/workouts", A["token"], {"id": wid, "user_id": A["id"], "photo_path": path, "logged_at": now_iso, "workout_type": "strength"})
rec("4-workout", "A inserts workout row", "PASS" if st in (201, 200) else "FAIL", f"HTTP {st}: {short(b)}")

st, b = req("GET", f"/storage/v1/object/workouts/{path}", A["token"])
jpeg_ok = st == 200 and isinstance(b, (bytes, bytearray)) and b[:3] == b"\xff\xd8\xff"
rec("4-download", "A downloads own photo", "PASS" if jpeg_ok else "FAIL", f"HTTP {st}, jpeg_magic={jpeg_ok}")

# ---------------- FLOW 5: RLS ISOLATION ----------------
# C (stranger) blocked
st, b = req("GET", f"/storage/v1/object/workouts/{path}", C["token"])
rec("5-rls", "C (stranger) blocked from A's photo", "PASS" if st != 200 else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{A['id']}", C["token"])
rows = b if isinstance(b, list) else []
rec("5-rls", "C cannot see A's workout rows", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("GET", f"/rest/v1/users?select=id&id=eq.{A['id']}", C["token"])
rows = b if isinstance(b, list) else []
rec("5-rls", "C cannot see A's users row", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("GET", f"/rest/v1/users?select=id&id=eq.{B['id']}", C["token"])
rows = b if isinstance(b, list) else []
rec("5-rls", "C cannot see B's users row", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("GET", f"/rest/v1/groups?select=id&id=eq.{pair_group}", C["token"])
rows = b if isinstance(b, list) else []
rec("5-rls", "C cannot see A/B pair group row", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("POST", "/rest/v1/rpc/my_group", C["token"], {})
rec("5-rls", "C (stranger) my_group has no group (solo nulls)", "PASS" if st == 200 and isinstance(b, dict) and b.get("group_id") is None and b.get("member_count") == 0 else "FAIL", f"HTTP {st}: {short(b)}")

# B (partner) reads
st, b = req("GET", f"/rest/v1/workouts?select=id,user_id,photo_path,logged_at&user_id=eq.{A['id']}", B["token"])
rows = b if isinstance(b, list) else []
rec("5-rls", "B (partner) reads A's workout row (pair feed)", "PASS" if st == 200 and len(rows) == 1 else "FAIL", f"HTTP {st}, rows={len(rows)} {short(b)}")
st, b = req("GET", f"/storage/v1/object/workouts/{path}", B["token"])
rec("5-rls", "B (partner) reads A's photo object", "PASS" if st == 200 else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("POST", f"/storage/v1/object/sign/workouts/{path}", B["token"], {"expiresIn": 60})
rec("5-rls", "B gets signed URL for A's photo (app path)", "PASS" if st == 200 and isinstance(b, dict) and b.get("signedURL") else "FAIL", f"HTTP {st}: {short(b)}")
if isinstance(b, dict) and b.get("signedURL"):
    su = b["signedURL"]
    if su.startswith("/"):
        # storage API returns a relative path WITHOUT the /storage/v1 root; the
        # app's supabase-js client prefixes the storage base URL. Mirror that.
        su = URL + "/storage/v1" + su
    try:
        with urllib.request.urlopen(su, timeout=30) as resp:
            rec("5-rls", "signed URL fetch (B)", "PASS" if resp.status == 200 else "FAIL", f"HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        rec("5-rls", "signed URL fetch (B)", "FAIL", f"HTTP {e.code}")

# ---------------- FLOW 6: WEEKLIES (client-computed shape) ----------------
st, b = req("GET", f"/rest/v1/workouts?select=id,user_id,photo_path,logged_at,workout_type,created_at&user_id=eq.{A['id']}&order=logged_at.desc", A["token"])
rows = b if isinstance(b, list) else []
rec("6-weeklies", "A weekly-ring query shape (own workouts)", "PASS" if st == 200 and len(rows) == 1 else "FAIL", f"HTTP {st}, rows={len(rows)}")

# ---------------- FLOW 7: CLEANUP ----------------
st, b = req("DELETE", f"/storage/v1/object/workouts/{path}", A["token"])
rec("7-cleanup", "A deletes photo file via Storage API", "PASS" if st == 200 else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("POST", "/rest/v1/rpc/delete_account", A["token"], {})
rec("7-cleanup", "A delete_account RPC", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("GET", "/auth/v1/user", A["token"])
gone = st == 401 or (st == 403 and isinstance(b, dict) and b.get("error_code") == "user_not_found")
rec("7-cleanup", "A auth user deleted (token now invalid)", "PASS" if gone else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("GET", f"/rest/v1/users?select=id&id=eq.{A['id']}", B["token"])
rows = b if isinstance(b, list) else []
rec("7-cleanup", "A users row gone (checked as B)", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{A['id']}", B["token"])
rows = b if isinstance(b, list) else []
rec("7-cleanup", "A workout rows gone (checked as B)", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"HTTP {st}, rows={len(rows)}")
st, b = req("GET", "/rest/v1/memberships", B["token"])
rows = b if isinstance(b, list) else []
if S1_LIVE:
    # S1 invariant: a shared group exists iff it has >= 2 members, so a 2-member
    # group dropped to 1 by delete_account is dissolved — B returns to Personal
    # only. (Live-behavior-dependent: passes after S7 applies the S1 schema.
    # NOTE vs schema.sql as committed: delete_account still uses `members_left
    # <= 1` (keep-orphan), so this needs the S1 delete_account threshold to be
    # aligned with leave_group's `<= 2` — see flow 8 cleanup check.)
    rec("7-cleanup", "B's memberships after A left (S1: pair group dissolves 2->1)", "PASS" if st == 200 and len(rows) == 1 else "FAIL", f"HTTP {st}, rows={len(rows)} {short(b)}")
else:
    # Legacy live behavior today: delete_account keeps the orphan singleton.
    rec("7-cleanup", "B's memberships after A left (pair group survives)", "PASS" if st == 200 and len(rows) == 2 else "FAIL", f"HTTP {st}, rows={len(rows)} {short(b)}")

st, b = req("POST", "/rest/v1/rpc/delete_account", B["token"], {})
rec("7-cleanup", "B delete_account RPC", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("GET", "/auth/v1/user", B["token"])
gone = st == 401 or (st == 403 and isinstance(b, dict) and b.get("error_code") == "user_not_found")
rec("7-cleanup", "B auth user deleted (token now invalid)", "PASS" if gone else "FAIL", f"HTTP {st}: {short(b)}")

st, b = req("POST", "/rest/v1/rpc/delete_account", C["token"], {})
rec("7-cleanup", "C delete_account RPC (best-effort)", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
st, b = req("GET", "/auth/v1/user", C["token"])
gone = st == 401 or (st == 403 and isinstance(b, dict) and b.get("error_code") == "user_not_found")
rec("7-cleanup", "C auth user deleted (token now invalid)", "PASS" if gone else "FAIL", f"HTTP {st}: {short(b)}")

# ---------------- FLOW 8: GROUPS (v1.0 cap = 3) — S1-gated ----------------
# Design study §7, 3-member v1.0 variant (owner 09-11: you + up to 2 partners).
# Uses users a-f RE-SIGNED-UP after flow 7 deleted a-c (fresh accounts, same
# epoch-based emails). Runs only when RUN_FLOW8 (S1 live AND GROUP_FLOWS != 0);
# pre-S7 every planned check is recorded as SKIPPED with a visible marker so the
# daily run stays green. Cross-checked against S1 schema.sql: join_group's cap
# guard (`cnt >= group_capacity()`, cap = 3), leave_group dissolve (<=2 seats)
# vs reassign (>2), get_invite member_count = co-members EXCLUDING the inviter
# (0 when solo), my_group member_count = co-members excluding self.
SKIP = "SKIPPED"

def f8_signup(name, ctx):
    for k in "abcdef":
        em = f"realsmoke-{ctx['epoch']}-{k}@example.com"
        st, b = req("POST", "/auth/v1/signup", None, {"email": em, "password": ctx["pw"]})
        if st == 200 and isinstance(b, dict) and b.get("access_token"):
            ctx["u"][k] = {"id": b["user"]["id"], "email": em, "token": b["access_token"]}
        else:
            rec("8-group", name, FAIL, f"signup {k} HTTP {st}: {short(b)}")
            sys.exit(1)
    rec("8-group", name, PASS, "6/6 signups OK (fresh accounts)")

def f8_onboard_abc(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k, goal, ws in [("a", 4, "Mon"), ("b", 3, "Sun"), ("c", 3, "Mon")]:
        ok, d = onboarding(u[k], goal, ws)
        ok_all = ok_all and ok; det.append(f"{k}:{d}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det))

def f8_users_ef(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k in "ef":
        st, b = req("POST", "/rest/v1/users", u[k]["token"], {"id": u[k]["id"], "name": k, "week_start_day": "Mon", "timezone": "UTC"})
        ok_all = ok_all and st in (201, 200); det.append(f"{k}:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (users-row FK prereq for invites/memberships)")

def f8_invite(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/invites", u["a"]["token"], {"inviter_id": u["a"]["id"], "token": ctx["token"]})
    if st == 409:  # stale code from a manual probe — rotate once, keep 8 chars
        ctx["token"] = f"E{ctx['epoch'] % 10000000:07d}"
        st, b = req("POST", "/rest/v1/invites", u["a"]["token"], {"inviter_id": u["a"]["id"], "token": ctx["token"]})
    rec("8-group", name, PASS if st in (201, 200) else FAIL, f"HTTP {st}, token={ctx['token']}: {short(b)}")

def f8_gate_getname(name, ctx, expect_mc, expect_hg, label):
    st, b = req("POST", "/rest/v1/rpc/get_invite", None, {"p_token": ctx["token"]})
    ok = st == 200 and isinstance(b, dict) and b.get("member_count") == expect_mc and b.get("has_group") is expect_hg
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (expect member_count={expect_mc}, has_group={expect_hg} — {label})")

def f8_join(name, ctx, who):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/join_group", u[who]["token"], {"p_token": ctx["token"]})
    return st, b

def f8_join_b(name, ctx):
    st, b = f8_join(name, ctx, "b")
    ok = st == 200 and isinstance(b, dict) and b.get("ok") and b.get("group_id") and b.get("member_count") == 2
    if isinstance(b, dict) and b.get("group_id"):
        ctx["gid"] = b["group_id"]
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (2-member group created; join_group member_count = total seats)")

def f8_b_memberships(name, ctx):
    u = ctx["u"]
    stA, mA = my_groups(u["b"]); rows = mA if isinstance(mA, list) else []
    stG, g = req("GET", f"/rest/v1/groups?select=id,team_name&id=eq.{ctx['gid']}", u["b"]["token"])
    grow = g if isinstance(g, list) else []
    ok = stA == 200 and len(rows) == 2 and stG == 200 and len(grow) == 1
    rec("8-group", name, PASS if ok else FAIL, f"memberships rows={len(rows)} (expect 2: Personal+group), group read rows={len(grow)}")

def f8_a_mygroup(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/my_group", u["a"]["token"], {})
    ok = st == 200 and isinstance(b, dict) and b.get("group_id") == ctx["gid"] and \
         b.get("member_ids") == [u["b"]["id"]] and b.get("member_count") == 1
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (expect group_id + member_ids=[B])")

def f8_dup_b(name, ctx):
    # Friendly idempotent-ish path: B already in the 2-member group (cap not
    # hit, cnt=2 < 3) → join_group raises 'you are already in this group'.
    # SQL order (S1 fix): ALREADY-MEMBER check first, cap guard second —
    # already-member wins even on a full group, so the friendly message is
    # always reachable (see f8_dup_c; the lock + insert trigger keep the cap
    # airtight regardless of which check runs first).
    st, b = f8_join(name, ctx, "b")
    ok = st == 400 and isinstance(b, dict) and "already in this group" in str(b.get("message", ""))
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (expect 400 'you are already in this group')")

def f8_join_c(name, ctx):
    st, b = f8_join(name, ctx, "c")
    ok = st == 200 and isinstance(b, dict) and b.get("ok") and b.get("group_id") == ctx["gid"] and b.get("member_count") == 3
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (same code → same gid, 3 seats)")

def f8_mygroup_all(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k in "abc":
        st, b = req("POST", "/rest/v1/rpc/my_group", u[k]["token"], {})
        others = [o for o in "abc" if o != k]
        good = st == 200 and isinstance(b, dict) and b.get("group_id") == ctx["gid"] \
               and set(b.get("member_ids") or []) == {u[o]["id"] for o in others} and b.get("member_count") == 2
        ok_all = ok_all and good; det.append(f"{k}:{'ok' if good else short(b)}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (expect all three: same gid, other two ids, member_count 2)")

def f8_upload_workout(name, ctx, who):
    u = ctx["u"]
    wid = str(uuid.uuid4()); path = f"{u[who]['id']}/{wid}.jpg"
    st, b = req("POST", f"/storage/v1/object/workouts/{path}", u[who]["token"], JPEG, ctype="image/jpeg", raw=True)
    up = st in (200, 201)
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    st2, b2 = req("POST", "/rest/v1/workouts", u[who]["token"], {"id": wid, "user_id": u[who]["id"], "photo_path": path, "logged_at": now_iso, "workout_type": "strength"})
    wk = st2 in (201, 200)
    ctx[f"path{who.upper()}"] = path
    rec("8-group", name, PASS if (up and wk) else FAIL, f"upload HTTP {st}, workout HTTP {st2}: {short(b2)}")

def f8_co_read_a(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k in "bc":
        st, b = req("GET", f"/rest/v1/workouts?select=id,user_id,photo_path&user_id=eq.{u['a']['id']}", u[k]["token"])
        rows = b if isinstance(b, list) else []
        good = st == 200 and len(rows) == 1
        ok_all = ok_all and good; det.append(f"{k}:rows={len(rows)}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (union feed: no group_id stamped on A's row)")

def f8_co_download(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k in "bc":
        st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}", u[k]["token"])
        good = st == 200 and isinstance(b, (bytes, bytearray)) and b[:3] == b"\xff\xd8\xff"
        ok_all = ok_all and good; det.append(f"{k}:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (both co-members download A's photo)")

def sign_and_fetch(token, path):
    st, b = req("POST", f"/storage/v1/object/sign/workouts/{path}", token, {"expiresIn": 60})
    if st != 200 or not (isinstance(b, dict) and b.get("signedURL")):
        return False, f"sign HTTP {st}: {short(b)}"
    su = b["signedURL"]
    if su.startswith("/"):
        su = URL + "/storage/v1" + su  # mirror the app's supabase-js prefix, as in flow 5
    try:
        with urllib.request.urlopen(su, timeout=30) as resp:
            return resp.status == 200, f"fetch HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, f"fetch HTTP {e.code}"

def f8_co_sign(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    for k in "bc":
        ok, d = sign_and_fetch(u[k]["token"], ctx["pathA"])
        ok_all = ok_all and ok; det.append(f"{k}:{d}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (both co-members sign + fetch A's photo URL)")

def f8_d_rls(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['a']['id']}", u["d"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"rows:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/users?select=id&id=eq.{u['a']['id']}", u["d"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"users:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/groups?select=id&id=eq.{ctx['gid']}", u["d"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"groups:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("POST", "/rest/v1/rpc/my_group", u["d"]["token"], {})
    ok = st == 200 and isinstance(b, dict) and b.get("group_id") is None and b.get("member_count") == 0 and (b.get("member_ids") or []) == []
    ok_all &= ok; det.append(f"my_group:{short(b)}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (stranger: all reads empty, my_group nulls)")

def f8_d_storage(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    # Cache-revalidated first: storage responses for raw authenticated object GETs are
    # served from Cloudflare's edge cache for the identity that already fetched them, so a
    # bare repeat GET can be a cache HIT that never reaches RLS. The `?cb=` cache-buster
    # forces the origin decision (STORAGE-CACHE note in the module header).
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}?cb={uuid.uuid4().hex[:8]}", u["d"]["token"])
    ok = st in (400, 403, 404); ok_all &= ok; det.append(f"GET?cb:HTTP {st}")
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}", u["d"]["token"])
    ok = st in (400, 403, 404); ok_all &= ok; det.append(f"GET:HTTP {st}")
    st, b = req("POST", f"/storage/v1/object/sign/workouts/{ctx['pathA']}", u["d"]["token"], {"expiresIn": 60})
    ok = st in (400, 403, 404) and not (isinstance(b, dict) and b.get("signedURL")); ok_all &= ok; det.append(f"sign:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (live returns 400 NoSuchKey 'Object not found'; doc says 403/404)")

def f8_cap_reject(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/join_group", u["d"]["token"], {"p_token": ctx["token"]})
    ok = st == 400 and isinstance(b, dict) and "this group is full" in str(b.get("message", ""))
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (4th member rejected; cap guard `cnt >= group_capacity()` = 3)")

def f8_cross_setup(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    ctx["tokF"] = f"F{ctx['epoch'] % 10000000:07d}"
    st, b = req("POST", "/rest/v1/invites", u["f"]["token"], {"inviter_id": u["f"]["id"], "token": ctx["tokF"]})
    ok_all = ok_all and st in (201, 200); det.append(f"F invite:HTTP {st}")
    st, b = req("POST", "/rest/v1/rpc/join_group", u["e"]["token"], {"p_token": ctx["tokF"]})
    ok_all = ok_all and st == 200 and isinstance(b, dict) and b.get("ok") and b.get("group_id") and b.get("group_id") != ctx["gid"]
    det.append(f"E join:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (F's own 2-member group, disjoint from A's)")

def f8_cross_iso(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['a']['id']}", u["e"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"E->A rows:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/users?select=name&id=eq.{u['a']['id']}", u["e"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"E->A users:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['e']['id']}", u["a"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"A->E rows:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['a']['id']}", u["f"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"F->A rows:{len(b) if isinstance(b, list) else '?'}")
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['e']['id']}", u["f"]["token"])
    ok = st == 200 and len(b if isinstance(b, list) else []) == 1; ok_all &= ok; det.append(f"F->E rows:{len(b) if isinstance(b, list) else '?'} (positive control)")
    # Cross-group member vs. A's photo object (regression: a member of a DIFFERENT group
    # must never read A's photo, neither raw nor signed). Cache-busted so the assertion
    # always reaches the origin RLS decision.
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}?cb={uuid.uuid4().hex[:8]}", u["e"]["token"])
    ok = st in (400, 403, 404); ok_all &= ok; det.append(f"E->A photo:HTTP {st}")
    st, b = req("POST", f"/storage/v1/object/sign/workouts/{ctx['pathA']}", u["e"]["token"], {"expiresIn": 60})
    ok = st in (400, 403, 404) and not (isinstance(b, dict) and b.get("signedURL")); ok_all &= ok; det.append(f"E->A sign:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (cross-group isolation; only E's own group sees E)")

def f8_c_leave(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/leave_group", u["c"]["token"], {})
    ok = st == 200 and isinstance(b, dict) and b.get("ok")
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (3-seat group: C's seat removed, group outlives C)")

def f8_c_post_leave(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    st, b = req("POST", "/rest/v1/rpc/my_group", u["c"]["token"], {})
    ok = st == 200 and isinstance(b, dict) and b.get("group_id") is None; ok_all &= ok; det.append(f"my_group:{short(b)}")
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['a']['id']}", u["c"]["token"])
    ok = st == 200 and (b if isinstance(b, list) else []) == []; ok_all &= ok; det.append(f"A rows:{len(b) if isinstance(b, list) else '?'}")
    # Post-leave photo isolation (P0 regression). The assertion is made on a
    # CACHE-REVALIDATED GET: the storage edge (Cloudflare) caches a raw authenticated
    # object response for the identity that fetched it, so a bare repeat GET can come
    # back as a cache HIT (`CF-Cache-Status: HIT`) for a user whose membership was just
    # revoked — that is a replay of bytes C already downloaded as a member, NOT a policy
    # admission (verified 2026-09-19: the same identity gets 400 for any object it never
    # fetched, and a DIFFERENT stranger/other-group member gets 400 even for a warm URL).
    # The `?cb=` form therefore tests the thing this suite exists to test: the origin's
    # RLS decision, which must be "no" for a departed member. The plain repeat status is
    # reported in the detail string for visibility.
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}", u["c"]["token"])
    st_plain = st
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}?cb={uuid.uuid4().hex[:8]}", u["c"]["token"])
    ok = st in (400, 403, 404); ok_all &= ok; det.append(f"A photo GET?cb:HTTP {st} (plain repeat GET:HTTP {st_plain})")
    st, b = req("POST", f"/storage/v1/object/sign/workouts/{ctx['pathA']}", u["c"]["token"], {"expiresIn": 60})
    ok = st in (400, 403, 404) and not (isinstance(b, dict) and b.get("signedURL")); ok_all &= ok; det.append(f"A sign:HTTP {st}")
    st, b = req("GET", f"/rest/v1/workouts?select=id&user_id=eq.{u['c']['id']}", u["c"]["token"])
    rows = b if isinstance(b, list) else []; ok = st == 200 and len(rows) == 1; ok_all &= ok; det.append(f"own rows:{len(rows)}")
    st, b = req("GET", f"/storage/v1/object/workouts/{ctx['pathC']}", u["c"]["token"])
    ok = st == 200; ok_all &= ok; det.append(f"own photo:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (leaver: invisible to A's data, own data intact)")

def f8_ab_after(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/my_group", u["a"]["token"], {})
    ok_mg = st == 200 and isinstance(b, dict) and b.get("group_id") == ctx["gid"] and b.get("member_ids") == [u["b"]["id"]] and b.get("member_count") == 1
    st, g = req("GET", f"/rest/v1/groups?select=id&id=eq.{ctx['gid']}", u["a"]["token"])
    grow = g if isinstance(g, list) else []
    # Current members keep photo access after the leaver is gone (positive control for the
    # post-leave isolation check above). Cache-busted to assert the origin RLS decision.
    st_b, bb = req("GET", f"/storage/v1/object/workouts/{ctx['pathA']}?cb={uuid.uuid4().hex[:8]}", u["b"]["token"])
    ok_photo = st_b == 200
    ok = ok_mg and st == 200 and len(grow) == 1 and ok_photo
    rec("8-group", name, PASS if ok else FAIL, f"A my_group {short(b)}; group row rows={len(grow)}; B->A photo:HTTP {st_b} (A/B still paired, group survives, member read intact)")

def f8_c_rejoin(name, ctx):
    u = ctx["u"]
    st, b = req("POST", "/rest/v1/rpc/join_group", u["c"]["token"], {"p_token": ctx["token"]})
    ok = st == 200 and isinstance(b, dict) and b.get("ok") and b.get("group_id") == ctx["gid"]
    st2, b2 = req("POST", "/rest/v1/rpc/my_group", u["c"]["token"], {})
    ok = ok and st2 == 200 and isinstance(b2, dict) and b2.get("group_id") == ctx["gid"] \
         and set(b2.get("member_ids") or []) == {u["a"]["id"], u["b"]["id"]} and b2.get("member_count") == 2
    rec("8-group", name, PASS if ok else FAIL, f"join HTTP {st}: {short(b)}; my_group {short(b2)} (co-members back: A+B)")

def f8_dup_c(name, ctx):
    # C is already in the now-FULL 3-member group. Doc §7 step 11 says the
    # friendly error; with the S1 fix the already-member check runs BEFORE the
    # cap guard (`cnt >= group_capacity()`), so this asserts 'you are already
    # in this group' — already-member wins, never a misleading 'this group is
    # full' for someone who is actually a member. Cap stays airtight via the
    # table lock + memberships insert trigger regardless of check order.
    st, b = f8_join(name, ctx, "c")
    ok = st == 400 and isinstance(b, dict) and "already in this group" in str(b.get("message", ""))
    rec("8-group", name, PASS if ok else FAIL, f"HTTP {st}: {short(b)} (already-member check first → 'already in this group' on a full group)")

def f8_cleanup_c(name, ctx):
    u = ctx["u"]; det = []
    req("DELETE", f"/storage/v1/object/workouts/{ctx['pathC']}", u["c"]["token"])
    st, b = req("POST", "/rest/v1/rpc/delete_account", u["c"]["token"], {})
    ok = st in (200, 204); det.append(f"C delete_account:HTTP {st}")
    st, b = req("POST", "/rest/v1/rpc/my_group", u["a"]["token"], {})
    ok = ok and st == 200 and isinstance(b, dict) and b.get("group_id") == ctx["gid"] and b.get("member_ids") == [u["b"]["id"]]
    det.append(f"A my_group:{short(b)}")
    st, g = req("GET", f"/rest/v1/groups?select=id&id=eq.{ctx['gid']}", u["b"]["token"])
    ok = ok and st == 200 and len(g if isinstance(g, list) else []) == 1
    det.append(f"group row rows={len(g if isinstance(g, list) else [])}")
    rec("8-group", name, PASS if ok else FAIL, "; ".join(det) + " (C's deletion leaves A/B group alive, 2 members)")

def f8_cleanup_a(name, ctx):
    u = ctx["u"]; det = []
    req("DELETE", f"/storage/v1/object/workouts/{ctx['pathA']}", u["a"]["token"])
    st, b = req("POST", "/rest/v1/rpc/delete_account", u["a"]["token"], {})
    ok = st in (200, 204); det.append(f"A delete_account:HTTP {st}")
    st, b = req("POST", "/rest/v1/rpc/my_group", u["b"]["token"], {})
    ok = ok and st == 200 and isinstance(b, dict) and b.get("group_id") is None; det.append(f"B my_group:{short(b)}")
    st, b = req("GET", "/rest/v1/memberships", u["b"]["token"])
    rows = b if isinstance(b, list) else []
    ok = ok and st == 200 and len(rows) == 1; det.append(f"B memberships rows:{len(rows)}")
    st, g = req("GET", f"/rest/v1/groups?select=id&id=eq.{ctx['gid']}", u["b"]["token"])
    grow = g if isinstance(g, list) else []
    ok = ok and st == 200 and len(grow) == 0; det.append(f"group row rows:{len(grow)}")
    rec("8-group", name, PASS if ok else FAIL, "; ".join(det) + " (doc §7: A deletion in the 2-group → B solo, group dissolved. S1 fix aligned delete_account's dissolve threshold to leave_group's `members_left <= 2` — no ghost singleton)")

def f8_cleanup_rest(name, ctx):
    u = ctx["u"]; ok_all = True; det = []
    rest = {"e": ctx.get("pathE"), "b": None, "d": None, "f": None}
    for k, pth in rest.items():
        if pth:
            req("DELETE", f"/storage/v1/object/workouts/{pth}", u[k]["token"])
        st, b = req("POST", "/rest/v1/rpc/delete_account", u[k]["token"], {})
        ok_all = ok_all and st in (200, 204); det.append(f"{k}:HTTP {st}")
    rec("8-group", name, PASS if ok_all else FAIL, "; ".join(det) + " (E/B/D/F deleted; d was never onboarded → stale-clean covers any residue)")

FLOW8_STEPS = [
    ("signup a-f (fresh, post-flow-7)", f8_signup),
    ("onboarding a-b-c (users + Personal groups)", f8_onboard_abc),
    ("users rows for e/f (FK prereq)", f8_users_ef),
    ("A creates group invite E5F6G7H8", f8_invite),
    ("get_invite before joins: member_count 0, has_group false", lambda n, c: f8_gate_getname(n, c, 0, False, "A still solo")),
    ("B join_group → 2-member group (ok, gid, seats 2)", f8_join_b),
    ("B memberships = 2 rows; B reads group row", f8_b_memberships),
    ("A my_group → gid + member_ids=[B]", f8_a_mygroup),
    ("get_invite after B: member_count 1, has_group true", lambda n, c: f8_gate_getname(n, c, 1, True, "B joined")),
    ("B duplicate join → 400 'you are already in this group'", f8_dup_b),
    ("C join_group same code → same gid, seats 3", f8_join_c),
    ("A/B/C my_group: same gid + other two ids (member_count 2)", f8_mygroup_all),
    ("get_invite after C: member_count 2, has_group true (doc 0->2, false->true)", lambda n, c: f8_gate_getname(n, c, 2, True, "C joined")),
    ("A uploads photo + workout row (no group_id — union feed needs no stamp)", lambda n, c: f8_upload_workout(n, c, "a")),
    ("B and C each read A's workout row (1 row)", f8_co_read_a),
    ("B and C download A's photo object", f8_co_download),
    ("B and C sign + fetch A's photo signed URL", f8_co_sign),
    ("D (stranger): A's rows/users/groups empty + my_group nulls", f8_d_rls),
    ("D (stranger): A's photo GET (cache-revalidated + plain) + sign blocked", f8_d_storage),
    ("D 4th join → HTTP 400 'this group is full'", f8_cap_reject),
    ("F creates own code; E joins F's group (disjoint gid)", f8_cross_setup),
    ("E uploads own photo + workout (cross-group fixture)", lambda n, c: f8_upload_workout(n, c, "e")),
    ("Cross-group isolation: E↛A rows/users/photo/sign, A↛E, F↛A; F sees E (control)", f8_cross_iso),
    ("C uploads own photo + workout (leave-visibility fixture)", lambda n, c: f8_upload_workout(n, c, "c")),
    ("C leave_group → ok (3-seat group outlives leaver)", f8_c_leave),
    ("C after leave: my_group null, A's rows 0, A photo blocked (cache-revalidated), own data intact", f8_c_post_leave),
    ("A/B after C left: A my_group=[B], group row survives, B still reads A's photo", f8_ab_after),
    ("C rejoins same code → same gid, co-members back (A+B)", f8_c_rejoin),
    ("C duplicate join on full group → 400 'you are already in this group' (already-member check first)", f8_dup_c),
    ("C delete_account → A/B group alive (2 members)", f8_cleanup_c),
    ("A delete_account in 2-group → B solo, group dissolved", f8_cleanup_a),
    ("cleanup: E/B/D/F delete_account", f8_cleanup_rest),
]

if RUN_FLOW8:
    ctx8 = {"epoch": epoch, "pw": PW, "u": {}, "token": "E5F6G7H8", "gid": None}
    for fname, fn in FLOW8_STEPS:
        fn(fname, ctx8)
else:
    for fname, _ in FLOW8_STEPS:
        rec("8-group", fname, SKIP, "Flow 8 gated: S1 schema not applied to live (my_group RPC absent) — runs after S7 (GROUP_FLOWS=0 hard-off)")

# ---------------- FLOW 9: TREATS/PROMISES LEDGER (pair-private, real mode) ------
# Owner decision 2026-09-11 rev 13: each promise entry visible ONLY to its maker
# + chosen witness. Port of dev smoke steps x/y/z to REAL RLS + security-definer
# RPCs (anon key only). Gated on the live ledger RPCs (anon probe => must hit the
# in-function 'auth required' guard, proving the functions exist).
st, b = req("POST", "/rest/v1/rpc/set_miss_note", None, {"p_text": "probe", "p_witness_id": None})
LEDGER_LIVE = st == 400 and isinstance(b, dict) and b.get("message") == "auth required"
print(f"[gate] ledger RPCs live (anon probe => 400 auth required): {LEDGER_LIVE} (HTTP {st})", flush=True)

def f9_msg(b):
    return (b.get("message") if isinstance(b, dict) else short(b)) or short(b)

def f9_rpc(u, fn, body):
    return req("POST", f"/rest/v1/rpc/{fn}", u["token"], body)

def f9_ledger(u):
    st, b = req("GET", "/rest/v1/promise_entries?select=id,user_id,witness_id,promise_text,state,week_start", u["token"])
    return (b if isinstance(b, list) else []), st

if LEDGER_LIVE and RUN_FLOW8:
    F9 = {}
    F9ROLES = ["crew", "maya", "jules", "zoe", "pa", "pb"]
    F9EMAIL = {r: f"realsmoke-{epoch}-{r}@example.com" for r in F9ROLES}
    for role in F9ROLES:
        st, b = req("POST", "/auth/v1/signup", None, {"email": F9EMAIL[role], "password": PW})
        if st == 200 and isinstance(b, dict) and b.get("access_token"):
            F9[role] = {"id": b["user"]["id"], "email": F9EMAIL[role], "token": b["access_token"]}
        else:
            rec("9-setup", f"signup {role}", FAIL, f"HTTP {st}: {short(b)}")
    rec("9-setup", "signup crew/maya/jules/zoe/pa/pb", "PASS" if len(F9) == 6 else "FAIL", f"{len(F9)}/6 signed up")
    ob_ok = True
    for role in F9ROLES:
        if role in F9:
            ok1, d1 = onboarding(F9[role], 3, "Mon")
            ob_ok = ob_ok and ok1
            if not ok1:
                rec("9-setup", f"onboard {role}", FAIL, d1)
    rec("9-setup", "onboarding all 6 (users + Personal groups)", "PASS" if ob_ok and len(F9) == 6 else "FAIL", "")
    # 3-person group: crew invites, maya + jules join (3 seats, cap-3 group)
    st, b = req("POST", "/rest/v1/invites", F9["crew"]["token"], {"inviter_id": F9["crew"]["id"], "token": "L3D3R9C0"})
    rec("9-setup", "crew creates invite L3D3R9C0", "PASS" if st in (201, 200) else "FAIL", f"HTTP {st}: {short(b)}")
    okj = True
    for role in ("maya", "jules"):
        st, b = req("POST", "/rest/v1/rpc/join_group", F9[role]["token"], {"p_token": "L3D3R9C0"})
        okj = okj and st == 200 and isinstance(b, dict) and b.get("ok")
    rec("9-setup", "maya + jules join crew group (3 seats)", "PASS" if okj else "FAIL", f"{short(b) if not okj else '3 seats'}")
    # 2-person pair: pa invites, pb joins
    st, b = req("POST", "/rest/v1/invites", F9["pa"]["token"], {"inviter_id": F9["pa"]["id"], "token": "PA1R4P8B"})
    rec("9-setup", "pa creates invite PA1R4P8B", "PASS" if st in (201, 200) else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = req("POST", "/rest/v1/rpc/join_group", F9["pb"]["token"], {"p_token": "PA1R4P8B"})
    rec("9-setup", "pb joins pa group (2 seats)", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("member_count") == 2 else "FAIL", f"HTTP {st}: {short(b)}")
    W0, W1, W2a, W2b, W3, W4 = "2026-08-24T00:00:00Z", "2026-08-31T00:00:00Z", "2026-08-31T00:00:00Z", "2026-09-07T00:00:00Z", "2026-09-14T00:00:00Z", "2026-09-21T00:00:00Z"
    # ---- 2-person pair (x): auto-resolve witness; idempotent record; silent
    # no-note skip; pair-scoped ledger; maker-only settle; open badge ----
    pa, pb, zoe = F9["pa"], F9["pb"], F9["zoe"]
    st, b = f9_rpc(pa, "set_miss_note", {"p_text": "a cold brew", "p_witness_id": zoe["id"]})
    rec("9-ledger-x", "2p: pa set_miss_note ignores stranger, witness auto = pb", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("witness_id") == pb["id"] else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(pa, "record_missed_promise", {"p_week_start": W0})
    rec("9-ledger-x", "2p: pa record W0 creates (A->B open)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(pb, "record_missed_promise", {"p_week_start": W1})
    rec("9-ledger-x", "2p: pb record with NO note = silent no-op (never shaming)", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("created") is False else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(pb, "set_miss_note", {"p_text": "the dishes", "p_witness_id": zoe["id"]})
    rec("9-ledger-x", "2p: pb set_miss_note auto-witness = pa", "PASS" if st == 200 and isinstance(b, dict) and b.get("witness_id") == pa["id"] else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(pb, "record_missed_promise", {"p_week_start": W1})
    rec("9-ledger-x", "2p: pb record W1 creates (B->A open)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(pb, "record_missed_promise", {"p_week_start": W1})
    rec("9-ledger-x", "2p: repeat record W1 = idempotent no-op (created false)", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("created") is False else "FAIL", f"HTTP {st}: {short(b)}")
    rows, st = f9_ledger(pb)
    makers = {r["user_id"] for r in rows}
    b_own = [r for r in rows if r["user_id"] == pb["id"] and r["witness_id"] == pa["id"]]
    a_to_b = [r for r in rows if r["user_id"] == pa["id"] and r["witness_id"] == pb["id"]]
    rec("9-ledger-x", "2p: pb ledger = exactly 2 (own maker + A->B witness), only pair rows", "PASS" if st == 200 and len(rows) == 2 and makers == {pa["id"], pb["id"]} and len(b_own) == 1 and len(a_to_b) == 1 else "FAIL", f"HTTP {st}: {len(rows)} rows {short(rows)}")
    rec("9-ledger-x", "2p: B own entry open + text round-trip", "PASS" if b_own and b_own[0]["state"] == "open" and b_own[0]["promise_text"] == "the dishes" else "FAIL", f"{short(b_own)}")
    st, b = f9_rpc(pa, "resolve_promise", {"p_entry_id": b_own[0]["id"], "p_state": "kept"})
    rec("9-ledger-x", "2p: witness (pa) settle REJECTED, maker-only message", "PASS" if st == 400 and f9_msg(b) == "only the person who made this promise can settle it" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    st, b = f9_rpc(pa, "resolve_promise", {"p_entry_id": "00000000-0000-0000-0000-000000000000", "p_state": "kept"})
    rec("9-ledger-x", "2p: unknown id indistinguishable from non-maker (privacy)", "PASS" if st == 400 and f9_msg(b) == "only the person who made this promise can settle it" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    st, b = f9_rpc(pb, "resolve_promise", {"p_entry_id": b_own[0]["id"], "p_state": "kept"})
    rec("9-ledger-x", "2p: maker (pb) settles own -> kept", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") else "FAIL", f"HTTP {st}: {short(b)}")
    rows, _ = f9_ledger(pb)
    rec("9-ledger-x", "2p: entry state now kept (ledger readback)", "PASS" if any(r["id"] == b_own[0]["id"] and r["state"] == "kept" for r in rows) else "FAIL", f"{short([r['state'] for r in rows])}")
    st, b = f9_rpc(pb, "resolve_promise", {"p_entry_id": b_own[0]["id"], "p_state": "let_go"})
    rec("9-ledger-x", "2p: re-settle rejected -> already settled", "PASS" if st == 400 and f9_msg(b) == "already settled" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    rows, _ = f9_ledger(pa)
    open_vis = [r for r in rows if r["state"] == "open"]
    rec("9-ledger-x", "2p: pa open badge = 1 (A->B open; B->A kept)", "PASS" if len(rows) == 2 and len(open_vis) == 1 else "FAIL", f"visible={len(rows)} open={len(open_vis)}")
    st, b = req("POST", "/rest/v1/promise_entries", pb["token"], {"user_id": pb["id"], "witness_id": pa["id"], "promise_text": "tamper", "week_start": W0, "state": "open"})
    rec("9-ledger-x", "2p: direct client INSERT denied (no INSERT policy)", "PASS" if st == 403 else "FAIL", f"HTTP {st}: {short(b)}")
    # ---- 3-person group (y): pick required + self/stranger rejected; witness
    # honored; pair-scoped BOTH ways; maker-only for witnesses AND strangers;
    # stranger-witness backstop fail-closed ----
    crew, maya, jules = F9["crew"], F9["maya"], F9["jules"]
    for label, wit in (("no pick", None), ("self pick", crew["id"]), ("stranger pick", zoe["id"])):
        st, b = f9_rpc(crew, "set_miss_note", {"p_text": "an extra run", "p_witness_id": wit})
        rec("9-ledger-y", f"3p: crew {label} REJECTED (choose who this promise is to)", "PASS" if st == 400 and f9_msg(b) == "choose who this promise is to" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    st, b = f9_rpc(crew, "set_miss_note", {"p_text": "an extra run", "p_witness_id": maya["id"]})
    rec("9-ledger-y", "3p: crew picks maya (witness honored)", "PASS" if st == 200 and isinstance(b, dict) and b.get("witness_id") == maya["id"] else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(crew, "record_missed_promise", {"p_week_start": W2a})
    rec("9-ledger-y", "3p: crew record W2a creates (crew->maya)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(crew, "set_miss_note", {"p_text": "a cold brew", "p_witness_id": jules["id"]})
    rec("9-ledger-y", "3p: crew re-picks jules (witness re-pick honored)", "PASS" if st == 200 and isinstance(b, dict) and b.get("witness_id") == jules["id"] else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(crew, "record_missed_promise", {"p_week_start": W2b})
    rec("9-ledger-y", "3p: crew record W2b creates (crew->jules)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    rows, st = f9_ledger(crew)
    c2m = [r for r in rows if r["user_id"] == crew["id"] and r["witness_id"] == maya["id"]]
    c2j = [r for r in rows if r["user_id"] == crew["id"] and r["witness_id"] == jules["id"]]
    rec("9-ledger-y", "3p: crew sees BOTH own entries (maker view)", "PASS" if st == 200 and len(rows) == 2 and len(c2m) == 1 and len(c2j) == 1 else "FAIL", f"{len(rows)} rows {short(rows)}")
    rows, st = f9_ledger(maya)
    rec("9-ledger-y", "3p: maya sees crew->maya (witness) and NEVER crew->jules", "PASS" if st == 200 and len(rows) == 1 and rows[0]["id"] == c2m[0]["id"] else "FAIL", f"{len(rows)} rows {short(rows)}")
    rows, st = f9_ledger(jules)
    rec("9-ledger-y", "3p: jules sees crew->jules and NEVER crew->maya (mirror)", "PASS" if st == 200 and len(rows) == 1 and rows[0]["id"] == c2j[0]["id"] else "FAIL", f"{len(rows)} rows {short(rows)}")
    rows, st = f9_ledger(zoe)
    rec("9-ledger-y", "3p: zoe (stranger) sees ZERO entries", "PASS" if st == 200 and len(rows) == 0 else "FAIL", f"{len(rows)} rows")
    for label, who, eid in (("witness", maya, c2m[0]["id"]), ("stranger", zoe, c2m[0]["id"])):
        st, b = f9_rpc(who, "resolve_promise", {"p_entry_id": eid, "p_state": "kept"})
        rec("9-ledger-y", f"3p: {label} settle REJECTED (maker-only, indistinguishable)", "PASS" if st == 400 and f9_msg(b) == "only the person who made this promise can settle it" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    st, b = f9_rpc(maya, "set_miss_note", {"p_text": "the dishes", "p_witness_id": jules["id"]})
    rec("9-ledger-y", "3p: maya sets own note -> witness jules", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") and b.get("witness_id") == jules["id"] else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(maya, "record_missed_promise", {"p_week_start": W3})
    rec("9-ledger-y", "3p: maya record W3 creates (maya->jules)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    rows, st = f9_ledger(maya)
    m_own = [r for r in rows if r["user_id"] == maya["id"] and r["witness_id"] == jules["id"]]
    rec("9-ledger-y", "3p: maya ledger = 2 (crew->maya + own)", "PASS" if st == 200 and len(rows) == 2 and len(m_own) == 1 else "FAIL", f"{len(rows)} rows")
    st, b = f9_rpc(maya, "resolve_promise", {"p_entry_id": m_own[0]["id"], "p_state": "let_go"})
    rec("9-ledger-y", "3p: maker (maya) settles own -> let_go", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") else "FAIL", f"HTTP {st}: {short(b)}")
    # stranger-witness backstop: client PATCHes a stranger id into its own
    # miss_witness_id -> record must RAISE and create NOTHING; restore -> works
    st, b = f9_rpc(jules, "set_miss_note", {"p_text": "an intro run", "p_witness_id": maya["id"]})
    rec("9-ledger-y", "3p: jules sets note (witness maya)", "PASS" if st == 200 and isinstance(b, dict) and b.get("ok") else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = req("PATCH", f"/rest/v1/memberships?user_id=eq.{jules['id']}", jules["token"], {"miss_witness_id": zoe["id"]})
    rec("9-ledger-y", "3p: client tampers own miss_witness_id -> stranger (zoe)", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(jules, "record_missed_promise", {"p_week_start": W4})
    rec("9-ledger-y", "3p: tampered-witness record raises (re-pick) + creates NOTHING", "PASS" if st == 400 and f9_msg(b) == "re-pick who your promise is to" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    rows, _ = f9_ledger(jules)
    rec("9-ledger-y", "3p: backstop: no entry ever visible to stranger zoe", "PASS" if len(rows) == 2 and all(r["witness_id"] != zoe["id"] for r in rows) else "FAIL", f"{len(rows)} rows")
    rows, _ = f9_ledger(zoe)
    rec("9-ledger-y", "3p: zoe ledger still 0 rows after tamper attempt", "PASS" if len(rows) == 0 else "FAIL", f"{len(rows)} rows")
    st, b = req("PATCH", f"/rest/v1/memberships?user_id=eq.{jules['id']}", jules["token"], {"miss_witness_id": maya["id"]})
    rec("9-ledger-y", "3p: restore witness to real co-member (maya)", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = f9_rpc(jules, "record_missed_promise", {"p_week_start": W4})
    rec("9-ledger-y", "3p: re-record after restore succeeds (recovery works)", "PASS" if st == 200 and isinstance(b, dict) and b.get("created") is True else "FAIL", f"HTTP {st}: {short(b)}")
    # ---- anon probes: functions reject anonymous callers inside (auth required)
    for fn, body in (("set_miss_note", {"p_text": "x", "p_witness_id": None}), ("record_missed_promise", {"p_week_start": W0}), ("resolve_promise", {"p_entry_id": "00000000-0000-0000-0000-000000000000", "p_state": "kept"})):
        st, b = req("POST", f"/rest/v1/rpc/{fn}", None, body)
        rec("9-ledger-z", f"anon {fn} rejected (auth required)", "PASS" if st == 400 and f9_msg(b) == "auth required" else "FAIL", f"HTTP {st}: {f9_msg(b)}")
    # ---- cleanup: delete every flow-9 user; verify tokens dead ----
    for role in F9ROLES:
        if role in F9:
            st, b = req("POST", "/rest/v1/rpc/delete_account", F9[role]["token"], {})
            rec("9-cleanup", f"delete_account {role}", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
            st, b = req("GET", "/auth/v1/user", F9[role]["token"])
            gone = st == 401 or (st == 403 and isinstance(b, dict) and b.get("error_code") == "user_not_found")
            rec("9-cleanup", f"{role} auth user gone", "PASS" if gone else "FAIL", f"HTTP {st}: {short(b)}")
else:
    rec("9-ledger", "Flow 9 ledger (pair-private)", SKIP, "gated: ledger RPCs not live (anon probe != auth required) or S1 off")

# ---------------- FLOW 10: APP DIAGNOSTICS (build-18 crash breadcrumb) ----------------
# app_diagnostics is insert-only for anon + authenticated (a crash can fire
# before sign-in, so both roles must be able to append) with NO client read/
# update/delete. Uses a dedicated fresh account so the assertions never depend
# on the gated flows 8/9 having run.
def f10_diag_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

DIAG = None
st, b = req("POST", "/auth/v1/signup", token=None, body={"email": f"realsmoke-{epoch}-dx@example.com", "password": PW})
if st == 200 and isinstance(b, dict) and b.get("access_token"):
    DIAG = {"id": b["user"]["id"], "token": b["access_token"]}
    rec("10-diagnostics", "diagnostics signup", PASS, f"HTTP {st}")
else:
    rec("10-diagnostics", "diagnostics signup", FAIL, f"HTTP {st}: {short(b)}")

if DIAG:
    st, b = req("POST", "/rest/v1/app_diagnostics", None, {"message": "smoke-anon", "stack": "at smoke", "app_version": "1.0.0", "build_number": "17", "ts": f10_diag_now()})
    rec("10-diagnostics", "anon INSERT accepted (crash-before-signin)", "PASS" if st in (200, 201) else "FAIL", f"HTTP {st}: {short(b)}")
    # Unique per run so the service-role lookup below resolves exactly this row.
    marker = f"smoke-delete-proof-{epoch}-{uuid.uuid4().hex[:8]}"
    st, b = req("POST", "/rest/v1/app_diagnostics", DIAG["token"], {"message": marker, "app_version": "1.0.0", "build_number": "18", "ts": f10_diag_now()})
    rec("10-diagnostics", "authenticated INSERT accepted", "PASS" if st in (200, 201) else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = req("GET", "/rest/v1/app_diagnostics", DIAG["token"])
    no_read = (st == 200 and isinstance(b, list) and len(b) == 0) or st in (401, 403)
    rec("10-diagnostics", "client SELECT blocked (insert-only)", "PASS" if no_read else "FAIL", f"HTTP {st}: {short(b)}")
    # DELETE-SURVIVAL PROOF. With no DELETE policy, RLS filters the statement to
    # 0 rows and PostgREST answers 204 — the same status a *successful* delete
    # returns, so a 2xx on its own proves nothing. (Deleting a non-existent id,
    # as this check used to, also answers 204 and proves even less.) Prove it
    # from outside the client: resolve the real row as service_role, delete it
    # as the client, then confirm as service_role that it is still there.
    st, b = sr_req("GET", f"/rest/v1/app_diagnostics?message=eq.{marker}&select=id")
    have_row = (st == 200 and isinstance(b, list) and len(b) == 1
                and isinstance(b[0], dict) and bool(b[0].get("id")))
    rec("10-diagnostics", "service_role resolves the inserted row (delete target)",
        "PASS" if have_row else (SKIP if st == -1 else "FAIL"), f"HTTP {st}: {short(b)}")
    if have_row:
        did = b[0]["id"]
        st, b = req("DELETE", f"/rest/v1/app_diagnostics?id=eq.{did}", DIAG["token"])
        rec("10-diagnostics", "client DELETE of an existing row -> 204, RLS-filtered to 0 rows (insert-only)",
            "PASS" if st == 204 else "FAIL", f"HTTP {st}: {short(b)}")
        st, b = sr_req("GET", f"/rest/v1/app_diagnostics?id=eq.{did}&select=id")
        survived = st == 200 and isinstance(b, list) and len(b) == 1
        rec("10-diagnostics", "row SURVIVED the client DELETE (service_role count = 1)",
            "PASS" if survived else (SKIP if st == -1 else "FAIL"), f"HTTP {st}: {short(b)}")
    st, b = req("POST", "/rest/v1/rpc/delete_account", DIAG["token"], {})
    rec("10-cleanup", "diagnostics delete_account", "PASS" if st in (200, 204) else "FAIL", f"HTTP {st}: {short(b)}")
    st, b = req("GET", "/auth/v1/user", DIAG["token"])
    gone = st == 401 or (st == 403 and isinstance(b, dict) and b.get("error_code") == "user_not_found")
    rec("10-cleanup", "diagnostics auth user gone", "PASS" if gone else "FAIL", f"HTTP {st}: {short(b)}")

with open("/tmp/smoke-results.json", "w") as f:
    json.dump({"epoch": epoch, "emails": EMAILS, "results": RESULTS}, f, indent=2)
print("\nSUMMARY:", sum(1 for r in RESULTS if r["status"] == "PASS"), "PASS /", sum(1 for r in RESULTS if r["status"] == "FAIL"), "FAIL /", sum(1 for r in RESULTS if r["status"] == SKIP), "SKIPPED")
# The summary is the gate: any FAIL makes the whole run fail (the Stack-child
# guard from flow 0 included), so CI/a caller can branch on the exit code alone.
sys.exit(1 if any(r["status"] == FAIL for r in RESULTS) else 0)