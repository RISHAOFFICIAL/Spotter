#!/usr/bin/env python3
"""Release verifier for a SPOTTER iOS build (.ipa).

WHY THIS EXISTS
---------------
Build 29 was verified from its IPA by an earlier `/tmp/b29_verify.sh` that printed

    VERDICT: AT LEAST ONE LITERAL CHECK FAILED

on a build that was in fact correct, and still exited 0.  Two defects:

  1. It asserted a JWT-SHAPED anon key (`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9`) while this
     project uses the newer `sb_publishable_...` key form -> a FALSE failure.
  2. It EXITED 0 even when its own verdict line said a literal check failed -> a gate that
     cannot fail.  A chained `VERIFY_EXIT=0` therefore proved nothing.

This script asserts the PROPERTY that matters -- the shipped bundle carries the real,
non-placeholder Supabase credentials the repo is configured with -- in a form that survives a
future change of key format, and it makes every FAILED check change the process exit code.

WHAT IS ASSERTED (properties, not shapes)
-----------------------------------------
Real-mode credentials, all read out of the shipped `main.jsbundle`:
  * `real_project_host_present`   -- the expected Supabase project host is inlined in the bundle.
  * `publishable_key_real`        -- a key-SHAPED literal with a real body is inlined.  BOTH
                                    families are accepted: `sb_publishable_<body>` and the older
                                    JWT form `eyJ....eyJ....<sig>`.  A body that is a known
                                    placeholder token, or that is the keyless library constant
                                    (supabase-js ships `sb_publishable_` as a string), does not
                                    count.  Nothing here depends on the JWT header bytes, so a
                                    future key-format change cannot repeat the false failure.
  * `key_matches_repo_config`     -- when the expected key is known (--expect-key, else the
                                    repo `.env`), the EXACT literal must be embedded.  This is
                                    the strongest available assertion and is format-free.
  * `configured_key_not_placeholder` -- the expected key itself is not empty / a placeholder.
  * `devmock_marker_absent`       -- no placeholder or empty-env credential marker is embedded
                                    (i.e. nothing that would silently push the app into DEV MOCK).
                                    NOTE: the mock module's own labels ("DEV DEMO - LOCAL MOCK",
                                    "spotter.devmock:v1:") are NOT usable as dev-mock markers --
                                    they are in EVERY build, because src/lib/supabase.ts imports
                                    the mock unconditionally.  Asserting their absence would be a
                                    permanent false failure.  The dev-mock CONDITION is caught by
                                    the two checks above (a dev-mock build inlines empty strings,
                                    so it has neither a project host nor a key body), which the
                                    self-test proves against a fixture shaped from the repo's own
                                    measured dev-mock bundle (dist/_expo/static/js/ios/entry-*.hbc).
  * `jwt_payload_is_project_anon_key` -- only when a JWT-shaped candidate is present: its payload
                                    must decode and name the expected ref or the anon role.

Build facts, read from the IPA's `Info.plist` -- which is authoritative:
  * `CFBundleVersion` (= the EAS remote build number) and `CFBundleShortVersionString`.
  * `--expect-cfbundleversion` / `--expect-short-version` turn those into hard checks.
  * The embedded `app.config` `ios.buildNumber` is printed as INFORMATIONAL ONLY and is never
    compared to `CFBundleVersion`: EAS's remote counter is authoritative for builds and
    `app.json`'s `ios.buildNumber` is intentionally stale.  Do not "fix" the app config to make
    that line agree.

Product literals (the original script's tables) -- what the shipped JS is supposed to say and
not say, plus the build-hygiene probe markers from WORKFLOW.md.

EXIT CODES (this is the point of the rewrite)
---------------------------------------------
  0  every check PASSed (SKIPs are allowed and are reported)
  1  at least one check FAILED  -> the verdict line says so
  2  the artifact could not be read (no such file, not a zip, no Payload/*.app, missing members)
  3  the verifier itself crashed (never silently 0)
The verdict line and the exit code are always printed, and the script exits with the code it
printed -- never after a pipe, so `... ; echo "EXIT=$?"` reports the real thing.

HERMETIC: this script reads only the IPA, the optional expectation flags and the optional
`--env-file`.  It never reads `EXPO_PUBLIC_*` from the environment (a leaked env var must not be
able to change a release verdict).

Run the self-test (no IPA needed):  python3 scripts/release/selftest_verify_ipa.py
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import plistlib
import re
import sys
import zipfile

# ---------------------------------------------------------------------------------------------
# Expectation tables (imported by the self-test so a fixture can plant a correct build).
# ---------------------------------------------------------------------------------------------

#: The project this app must be shipping against, used only when nothing better is available.
DEFAULT_EXPECTED_HOST = "juxddhghhkvtmxcwvlpa.supabase.co"

#: Literals that only a not-yet-really-configured bundle may carry.
PLACEHOLDER_MARKERS = (
    "EXPO_PUBLIC_SUPABASE_ANON_KEY=",
    "EXPO_PUBLIC_SUPABASE_URL=",
    "your-anon-key",
    "your_anon_key",
    "anon-key-here",
    "your-publishable-key",
    "your-project.supabase.co",
    "placeholder-anon-key",
    "changeme",
)

#: Prefixes that make a key body obviously a stand-in rather than a credential.
PLACEHOLDER_KEY_BODY_PREFIXES = (
    "your",
    "xxx",
    "placeholder",
    "example",
    "test",
    "dummy",
    "changeme",
    "here",
    "anon",
)

#: Product literals that MUST be in the shipped bundle: (check id, label, literal).
PRESENT_LITERALS = (
    ("open-settings-control", "#39 Open Settings control", "Open Settings"),
    ("no-skip-first-screen", "#39 no-Skip first screen (welcome copy)", "Let's go"),
    (
        "push-copy-sheet-body",
        "#40 new sheet body",
        "A nudge if an invite you sent is still waiting",
    ),
    ("push-copy-caption", "#40 new caption", "Not sending yet"),
    ("push-copy-profile-line", "#40 new profile line", "Missed week starts off."),
    ("onboarding-write-order", "#37 onboarding write order (users first)", "memberships"),
    ("app-version-module", "#41 one version definition module", "appVersion"),
)

#: Literals that must NOT be in the shipped bundle (retired copy + build-hygiene probe markers).
ABSENT_LITERALS = (
    ("retired-caption-1", "#40 retired caption", "When your partner logs a workout."),
    ("retired-caption-2", "#40 retired caption", "When someone you invited pairs up."),
    ("retired-profile-line", "#40 retired profile line", "Off until you turn them on."),
    ("retired-sheet-promise", "#40 retired sheet promise", "and when your invite is accepted"),
    ("retired-dispatch-claim", "#40 retired dispatch claim", "In real mode the send still happens"),
    ("mis-stamped-version", "#41 the mis-stamped version", "1.1.0"),
    ("probe-marker-cap24", "probe marker", "[cap24"),
    ("probe-marker-cap25", "probe marker", "[cap25"),
    ("probe-marker-cap26", "probe marker", "[cap26"),
    ("probe-marker-cap27", "probe marker", "[cap27"),
    ("probe-marker-staged24", "probe marker", "[staged24"),
    ("probe-marker-probe23", "probe marker", "[probe23"),
    ("probe-marker-boot-capture", "probe marker", "boot-capture.jsonl"),
    ("probe-marker-r-replay", "probe marker", "r-replay-shown"),
)

# ---------------------------------------------------------------------------------------------
# A key-SHAPED literal, both families.  Deliberately body-first-anchored: Hermes packs its string
# table, so a match can bleed into the neighbouring literal ("...v1nKdufW" + "aiting ...").  A
# body must therefore start with an alphanumeric -- which also rejects supabase-js's keyless
# `sb_publishable_` constant, whose next bytes are `_fbBatchedBridgeConfig...` in every build.
# ---------------------------------------------------------------------------------------------
KEY_TOKEN_RE = re.compile(
    r"(?:sb_publishable_[A-Za-z0-9][A-Za-z0-9_\-]{19,}"  # new form, real body
    r"|eyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{20,})"  # older JWT form
)
HOST_RE = re.compile(r"[a-z0-9][a-z0-9\-]{15,}\.supabase\.co")

PASS, FAIL, WARN, SKIP = "PASS", "FAIL", "WARN", "SKIP"


class ArtifactError(Exception):
    """The IPA could not be read / does not look like an app bundle."""


class Results:
    """Collects checks and prints each one as it is decided, in order."""

    def __init__(self) -> None:
        self.checks: list[tuple[str, str, str, str]] = []
        self._width = 52

    def add(self, cid: str, label: str, status: str, detail: str = "") -> None:
        self.checks.append((cid, label, status, detail))
        print("   %-4s %-*s %s" % (status, self._width, label, detail))

    def count(self, status: str) -> int:
        return sum(1 for c in self.checks if c[2] == status)

    def failures(self) -> list[tuple[str, str, str, str]]:
        return [c for c in self.checks if c[2] == FAIL]


def hits(blob: bytes, needle: str) -> int:
    """Occurrences of a literal in the shipped JS, scanning ASCII and UTF-16LE."""
    total = 0
    for enc in ("ascii", "utf-16-le"):
        try:
            total += blob.count(needle.encode(enc))
        except Exception:
            pass
    return total


def first_index(blob: bytes, needle: str) -> tuple[int, str]:
    for enc in ("utf-16-le", "ascii"):
        try:
            i = blob.find(needle.encode(enc))
        except Exception:
            i = -1
        if i >= 0:
            return i, enc
    return -1, "-"


def resolve_expectations(args: argparse.Namespace) -> tuple[str, str | None, str]:
    """Return (expected_host, expected_key_or_None, provenance_string)."""
    host = args.expect_host
    key = args.expect_key
    provenance: list[str] = []

    env_path = None
    if not args.no_env_file:
        env_path = args.env_file
        if env_path is None:
            repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            candidate = os.path.join(repo_root, ".env")
            env_path = candidate if os.path.isfile(candidate) else None
    if env_path and os.path.isfile(env_path):
        values: dict[str, str] = {}
        with open(env_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                values[k.strip()] = v.strip()
        url = values.get("EXPO_PUBLIC_SUPABASE_URL", "")
        if not host and url:
            host = url.replace("https://", "").replace("http://", "").rstrip("/")
            provenance.append("host<-%s" % env_path)
        if not key and values.get("EXPO_PUBLIC_SUPABASE_ANON_KEY"):
            key = values["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
            provenance.append("key<-%s" % env_path)
    if not host:
        host = DEFAULT_EXPECTED_HOST
        provenance.append("host<-builtin default")
    if args.expect_host:
        provenance.append("host<-flag")
    if args.expect_key:
        provenance.append("key<-flag")
    return host, key, ", ".join(provenance) if provenance else "(none)"


def read_members(ipa_path: str) -> tuple[dict[str, bytes], list[str]]:
    """Extract the members the checks need from the IPA. Raises ArtifactError if unreadable."""
    if not os.path.isfile(ipa_path):
        raise ArtifactError("no such file: %s" % ipa_path)
    if not zipfile.is_zipfile(ipa_path):
        raise ArtifactError("not a zip/ipa: %s" % ipa_path)
    members: dict[str, bytes] = {}
    with zipfile.ZipFile(ipa_path) as zf:
        names = zf.namelist()
        apps = sorted(
            {
                n.split("/")[1]
                for n in names
                if n.startswith("Payload/") and len(n.split("/")) > 2 and n.split("/")[1].endswith(".app")
            }
        )
        if not apps:
            raise ArtifactError("no Payload/*.app inside the ipa")
        prefix = "Payload/%s/" % apps[0]
        wanted = {
            "info_plist": prefix + "Info.plist",
            "app_config": prefix + "EXConstants.bundle/app.config",
            "bundle": prefix + "main.jsbundle",
        }
        for key, name in wanted.items():
            try:
                members[key] = zf.read(name)
            except KeyError:
                members[key] = b""
        members["_app_name"] = apps[0].encode()
    return members, names


def verify(ipa_path: str, expected_host: str, expected_key: str | None, results: Results) -> None:
    members, names = read_members(ipa_path)

    print("== artifact")
    size = os.path.getsize(ipa_path)
    with open(ipa_path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    print("  ipa            : %s" % ipa_path)
    print("  bytes          : %d" % size)
    print("  sha256         : %s" % digest)
    print("  app            : %s" % members["_app_name"].decode())
    print("  members scanned: Info.plist, EXConstants.bundle/app.config, main.jsbundle")
    print("  expected host  : %s" % expected_host)
    print("  expected key   : %s" % ("(supplied)" if expected_key else "(unknown - flag not given)"))

    # ---- structure ------------------------------------------------------------------------
    print()
    print("== 1. structure")
    results.add("payload-app", "Payload/*.app present", PASS, members["_app_name"].decode())
    for cid, label, blob in (
        ("member-info-plist", "Info.plist present", members["info_plist"]),
        ("member-app-config", "EXConstants app.config present", members["app_config"]),
        ("member-bundle", "main.jsbundle present", members["bundle"]),
    ):
        if blob:
            results.add(cid, label, PASS, "%d bytes" % len(blob))
        else:
            results.add(cid, label, FAIL, "MISSING from the ipa")
    if not members["bundle"]:
        raise ArtifactError("main.jsbundle is missing - nothing to verify")

    bundle = members["bundle"]

    # ---- build facts ----------------------------------------------------------------------
    print()
    print("== 2. build facts (Info.plist is authoritative; app.config is informational)")
    plist: dict = {}
    try:
        plist = plistlib.loads(members["info_plist"])
    except Exception as exc:  # pragma: no cover - corrupt plist is an artifact error
        raise ArtifactError("Info.plist is unreadable: %s" % exc)
    for k in (
        "CFBundleIdentifier",
        "CFBundleVersion",
        "CFBundleShortVersionString",
        "UIDeviceFamily",
        "MinimumOSVersion",
        "ITSAppUsesNonExemptEncryption",
    ):
        print("  %-34s %s" % (k + ":", plist.get(k)))
    cbv = plist.get("CFBundleVersion")
    csv = plist.get("CFBundleShortVersionString")
    if cbv not in (None, ""):
        results.add("cfbundleversion-present", "CFBundleVersion present", PASS, str(cbv))
    else:
        results.add("cfbundleversion-present", "CFBundleVersion present", FAIL, "empty")
    if csv not in (None, ""):
        results.add("short-version-present", "CFBundleShortVersionString present", PASS, str(csv))
    else:
        results.add("short-version-present", "CFBundleShortVersionString present", FAIL, "empty")

    app_config = {}
    try:
        app_config = json.loads(members["app_config"].decode("utf-8"))
    except Exception as exc:
        print("  !! cannot read the embedded app.config: %s" % exc)
    expo = app_config.get("expo") or app_config or {}
    ios = expo.get("ios") or {}
    print(
        "  app.config version / ios.buildNumber (INFORMATIONAL ONLY, never asserted equal to"
        " CFBundleVersion): %s / %s"
        % (expo.get("version"), ios.get("buildNumber"))
    )
    print("  app.config ios.bundleIdentifier: %s" % ios.get("bundleIdentifier"))
    print(
        "  NB: EAS's remote build counter is authoritative for builds; app.json's ios.buildNumber"
        " is intentionally stale. CFBundleVersion %s is what ships." % cbv
    )

    # ---- REAL-mode credentials: the property, not a shape --------------------------------
    print()
    print("== 3. REAL mode credentials (property checks, both key families accepted)")
    host_present = hits(bundle, expected_host)
    if host_present:
        off, enc = first_index(bundle, expected_host)
        results.add(
            "real-project-host-present",
            "real Supabase project host inlined",
            PASS,
            "%s n=%d first_at=%d[%s]" % (expected_host, host_present, off, enc),
        )
    else:
        results.add(
            "real-project-host-present",
            "real Supabase project host inlined",
            FAIL,
            "MISS: %r n=0 -- bundle looks DEV-MOCK/empty (a dev-mock build inlines an empty URL)"
            % expected_host,
        )

    # Report any other supabase host found -- informational, never a failure on its own (a
    # future library doc-string must not be able to fail a release).
    ascii_view = bundle.decode("latin-1")
    other_hosts = sorted({h for h in HOST_RE.findall(ascii_view) if h != expected_host})

    candidates = sorted(set(KEY_TOKEN_RE.findall(ascii_view)))
    rejected: list[str] = []
    real: list[str] = []
    for cand in candidates:
        body = cand[len("sb_publishable_") :] if cand.startswith("sb_publishable_") else cand
        if cand.startswith("sb_publishable_") and body.lower().startswith(PLACEHOLDER_KEY_BODY_PREFIXES):
            rejected.append("%s (placeholder body)" % cand)
            continue
        real.append(cand)
    if real:
        results.add(
            "publishable-key-real",
            "non-placeholder publishable key inlined (any format)",
            PASS,
            "n=%d e.g. %s" % (len(real), real[0][:46]),
        )
    else:
        detail = "no key-shaped literal with a real body"
        if candidates:
            detail += "; rejected %s" % ", ".join(rejected)
        results.add(
            "publishable-key-real",
            "non-placeholder publishable key inlined (any format)",
            FAIL,
            detail
            + " -- a dev-mock build inlines an empty key; supabase-js's own `sb_publishable_`"
            " constant is NOT a key",
        )
    for cand in candidates:
        print("  candidate      : %s" % cand[:60])
    for bad in rejected:
        print("  rejected       : %s" % bad)
    if other_hosts:
        print("  WARN: other supabase hosts in the bundle (informational): %s" % other_hosts)

    if expected_key:
        n = hits(bundle, expected_key)
        if n:
            off, enc = first_index(bundle, expected_key)
            results.add(
                "key-matches-repo-config",
                "embedded key == configured key",
                PASS,
                "n=%d first_at=%d[%s]" % (n, off, enc),
            )
        else:
            results.add(
                "key-matches-repo-config",
                "embedded key == configured key",
                FAIL,
                "the configured key is NOT in the bundle (configured %s...)" % expected_key[:20],
            )
        key_body = expected_key[len("sb_publishable_") :] if expected_key.startswith("sb_publishable_") else expected_key
        looks_ok = (
            len(expected_key) >= 30
            and (expected_key.startswith("sb_publishable_") or expected_key.startswith("eyJ"))
            and not key_body.lower().startswith(PLACEHOLDER_KEY_BODY_PREFIXES)
        )
        results.add(
            "configured-key-not-placeholder",
            "configured key is a real credential",
            PASS if looks_ok else FAIL,
            "length=%d" % len(expected_key) if looks_ok else "looks like a placeholder: %s..." % expected_key[:24],
        )
    else:
        results.add(
            "key-matches-repo-config",
            "embedded key == configured key",
            SKIP,
            "no --expect-key and no readable .env: the format-free equality assertion is unavailable",
        )
        results.add(
            "configured-key-not-placeholder",
            "configured key is a real credential",
            SKIP,
            "no configured key available to inspect",
        )

    placeholder_hits = [(m, hits(bundle, m)) for m in PLACEHOLDER_MARKERS]
    offenders = [(m, n) for m, n in placeholder_hits if n]
    if offenders:
        results.add(
            "devmock-marker-absent",
            "no placeholder/empty-env credential marker embedded",
            FAIL,
            "; ".join("%r n=%d" % (m, n) for m, n in offenders),
        )
    else:
        results.add(
            "devmock-marker-absent",
            "no placeholder/empty-env credential marker embedded",
            PASS,
            "%d markers checked, none present" % len(PLACEHOLDER_MARKERS),
        )

    jwt_candidates = [c for c in candidates if c.startswith("eyJ")]
    if jwt_candidates:
        cand = jwt_candidates[0]
        try:
            payload = cand.split(".")[1]
            pad = "=" * (-len(payload) % 4)
            claims = json.loads(base64.urlsafe_b64decode(payload + pad).decode("utf-8", "replace"))
            ref = str(claims.get("ref", ""))
            role = str(claims.get("role", ""))
            ok = (ref and ref + ".supabase.co" == expected_host) or role in ("anon", "authenticated")
            results.add(
                "jwt-payload-is-project-anon-key",
                "JWT-form key decodes to this project / anon role",
                PASS if ok else FAIL,
                "ref=%r role=%r" % (ref, role),
            )
        except Exception as exc:
            results.add(
                "jwt-payload-is-project-anon-key",
                "JWT-form key decodes to this project / anon role",
                WARN,
                "payload not decodable (%s) - not treated as a failure" % exc,
            )
    else:
        results.add(
            "jwt-payload-is-project-anon-key",
            "JWT-form key decodes to this project / anon role",
            SKIP,
            "no JWT-shaped key in this build (newer sb_publishable_ form in use)",
        )

    # ---- product literals -----------------------------------------------------------------
    print()
    print("== 4. product literals in the shipped bundle (ASCII and UTF-16LE both scanned)")
    print("  -- must be PRESENT --")
    for cid, label, lit in PRESENT_LITERALS:
        n = hits(bundle, lit)
        off, enc = first_index(bundle, lit)
        status = PASS if n else FAIL
        results.add(cid, label, status, "%r n=%d first_at=%d[%s]" % (lit[:46], n, off, enc))
    print("  -- must be ABSENT --")
    for cid, label, lit in ABSENT_LITERALS:
        n = hits(bundle, lit)
        off, enc = first_index(bundle, lit)
        status = PASS if n == 0 else FAIL
        results.add(cid, label, status, "%r n=%d first_at=%d[%s]" % (lit[:46], n, off, enc))
    control = "zzz-not-in-any-bundle-9999"
    print("  scanner control %r hits=%d (must be 0)" % (control, hits(bundle, control)))
    return plist


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Verify a SPOTTER release IPA (credentials property + build facts + literals)."
    )
    ap.add_argument("ipa", help="path to the .ipa to verify")
    ap.add_argument("--expect-host", help="expected Supabase project host (default: repo .env, else builtin)")
    ap.add_argument("--expect-key", help="expected publishable key literal (default: repo .env)")
    ap.add_argument("--env-file", help="path to the .env that supplied the build's credentials")
    ap.add_argument("--no-env-file", action="store_true", help="do not read any .env")
    ap.add_argument("--expect-cfbundleversion", help="hard-assert Info.plist CFBundleVersion")
    ap.add_argument("--expect-short-version", help="hard-assert Info.plist CFBundleShortVersionString")
    args = ap.parse_args(argv)

    expected_host, expected_key, provenance = resolve_expectations(args)
    print("== verify start")
    print("  expectations   : %s" % provenance)
    print()

    results = Results()
    try:
        plist = verify(args.ipa, expected_host, expected_key, results)
        if args.expect_cfbundleversion or args.expect_short_version:
            if args.expect_cfbundleversion:
                got = str(plist.get("CFBundleVersion"))
                results.add(
                    "cfbundleversion-matches",
                    "CFBundleVersion == --expect-cfbundleversion",
                    PASS if got == args.expect_cfbundleversion else FAIL,
                    "got %s want %s" % (got, args.expect_cfbundleversion),
                )
            if args.expect_short_version:
                got = str(plist.get("CFBundleShortVersionString"))
                results.add(
                    "short-version-matches",
                    "CFBundleShortVersionString == --expect-short-version",
                    PASS if got == args.expect_short_version else FAIL,
                    "got %s want %s" % (got, args.expect_short_version),
                )
    except ArtifactError as exc:
        print()
        print("ARTIFACT ERROR: %s" % exc)
        print()
        print("CHECKS: %d passed, %d failed, %d warned, %d skipped" % (
            results.count(PASS), results.count(FAIL), results.count(WARN), results.count(SKIP)))
        print("VERDICT: AT LEAST ONE LITERAL CHECK FAILED (artifact unreadable)")
        print("VERIFY_EXIT_CODE: 2")
        return 2
    except Exception:  # pragma: no cover - a crashing gate must never look like a pass
        import traceback

        traceback.print_exc()
        print()
        print("VERDICT: AT LEAST ONE LITERAL CHECK FAILED (verifier crashed)")
        print("VERIFY_EXIT_CODE: 3")
        return 3

    print()
    failures = results.failures()
    print(
        "CHECKS: %d passed, %d failed, %d warned, %d skipped"
        % (results.count(PASS), results.count(FAIL), results.count(WARN), results.count(SKIP))
    )
    if failures:
        for cid, label, _status, detail in failures:
            print("  FAILED %-28s %s -- %s" % (cid, label, detail))
        print("VERDICT: AT LEAST ONE LITERAL CHECK FAILED")
        code = 1
    else:
        print("VERDICT: ALL LITERAL CHECKS PASS")
        code = 0
    print("VERIFY_EXIT_CODE: %d" % code)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
