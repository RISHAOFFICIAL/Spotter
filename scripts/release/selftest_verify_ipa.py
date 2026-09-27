#!/usr/bin/env python3
"""Self-test for scripts/release/verify_ipa.py -- HERMETIC: needs no build, no IPA, no network.

It builds tiny temporary IPAs (a zip with Payload/<app>.app/{Info.plist, main.jsbundle,
EXConstants.bundle/app.config}) in a temp dir, plants values in them, runs the real verifier as a
subprocess and asserts on its EXIT CODE and its VERDICT line.  Both outcomes are exercised:

  PASS cases (exit 0)
    * publishable      -- the newer `sb_publishable_...` key form, with the Hermes string-table
                          BLEED trap reproduced (the key immediately followed by the next literal's
                          tail), plus app.config buildNumber=17 against Info.plist CFBundleVersion=29
                          to prove the verifier does not conflate the two.
    * jwt              -- the older JWT anon-key form, to prove a future/past key FORMAT change
                          cannot produce the false failure this task exists to fix.

  FAIL cases (non-zero exit)
    * placeholder-key  -- right host, planted placeholder key.
    * devmock-shape    -- the measured dev-mock signature: supabase-js's own keyless
                          `sb_publishable_` constant present, NO project host, NO key body.
                          Shaped from the repo's real dev-mock bundle
                          (dist/_expo/static/js/ios/entry-*.hbc).
    * wrong-host       -- planted host that is not the configured one.
    * missing-literal  -- one product literal dropped: proves EVERY failed check, not just the
                          credential ones, changes the exit code.
    * not-an-ipa       -- a plain file: an unreadable artifact must never exit 0.

The product literals the verifier asserts are imported from the verifier itself, so a correct
fixture cannot drift from the check tables; the credential side is planted independently.
Each FAIL case also carries a "teeth" assertion that the plant really is in the fixture bytes, so
an empty fixture can never pass this test by accident.
"""

from __future__ import annotations

import base64
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from verify_ipa import (  # noqa: E402  (import after sys.path fix)
    ABSENT_LITERALS,
    DEFAULT_EXPECTED_HOST,
    PRESENT_LITERALS,
    hits,
)

VERIFIER = os.path.join(HERE, "verify_ipa.py")

GOOD_KEY = "sb_publishable_NCqAhtw2065wPcBNOTqcBg_v1nKdufW"
PLACEHOLDER_KEY = "sb_publishable_your_publishable_key_here_replace_me"
OTHER_HOST = "abcdefghijklmnopqrst.supabase.co"

#: supabase-js ships this prefix as a library constant -- measured present in EVERY build, real
#: or dev-mock.  A dev-mock fixture must contain it and must still fail.
LIBRARY_CONSTANT = "sb_publishable_"

_JWT_HEADER = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()).decode().rstrip("=")
_JWT_PAYLOAD = (
    base64.urlsafe_b64encode(
        json.dumps({"iss": "supabase", "ref": OTHER_HOST[:-len(".supabase.co")], "role": "anon"}).encode()
    )
    .decode()
    .rstrip("=")
)
_JWT_SIG = "U9vTQ2r8Sx1mJk4Lpz7YbNc3Wd6Ef0Gh2Qs5Tu8Vw4X"  # looks like a signature, is not one
GOOD_JWT = "%s.%s.%s" % (_JWT_HEADER, _JWT_PAYLOAD, _JWT_SIG)


def _bundle_bytes(extra_literals: list[str], drop: tuple[str, ...]) -> bytes:
    """A fake main.jsbundle carrying the product literals plus a planted string region."""
    parts: list[bytes] = [
        b"\x00\x00\x00\x00",  # a little binary noise so this is not obviously a text file
    ]
    for _cid, _label, lit in PRESENT_LITERALS:
        if lit in drop:
            continue
        parts.append(b"createNamespaceIfNotExist" + lit.encode("ascii") + b"\x00")
    for lit in extra_literals:
        parts.append(lit.encode("ascii") + b"\x00")
    # One literal is planted in UTF-16LE so the scanner's second encoding is exercised too.
    parts.append(PRESENT_LITERALS[2][2].encode("utf-16-le"))  # the push-copy sheet body
    return b"".join(parts)


def build_fixture(
    workdir: str,
    name: str,
    *,
    host: str | None,
    key: str | None,
    extra_literals: list[str] | None = None,
    drop: tuple[str, ...] = (),
    library_constant: bool = False,
) -> str:
    """Write a minimal .ipa-shaped zip and return its path.

    The layout mimics the real build: an `app.config` whose ios.buildNumber is the intentionally
    stale `17` while the Info.plist says CFBundleVersion 29.
    """
    path = os.path.join(workdir, name + ".ipa")
    app = "Payload/SPOTTER.app/"
    literals = list(extra_literals or [])
    if library_constant:
        literals.append(LIBRARY_CONSTANT)
    if key:
        literals.append(key)
    if host:
        literals.append(host)
    bundle = _bundle_bytes(literals, drop)

    info = {
        "CFBundleIdentifier": "app.spotter.mvp",
        "CFBundleVersion": "29",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleName": "SPOTTER",
        "CFBundleDisplayName": "SPOTTER",
        "UIDeviceFamily": [1],
        "MinimumOSVersion": "16.4",
        "ITSAppUsesNonExemptEncryption": False,
    }
    app_config = {
        "expo": {
            "name": "SPOTTER",
            "slug": "spotter",
            "version": "1.0.0",
            "ios": {
                "buildNumber": "17",  # intentionally stale: EAS's remote counter is authoritative
                "bundleIdentifier": "app.spotter.mvp",
                "supportsTablet": False,
            },
        }
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(app + "Info.plist", plistlib.dumps(info))
        zf.writestr(app + "EXConstants.bundle/app.config", json.dumps(app_config))
        zf.writestr(app + "main.jsbundle", bundle)
        zf.writestr(app + "SPOTTER", b"\xcf\xfa\xed\xfe dummy macho placeholder")
    return path


def bundle_bytes_of(ipa: str) -> bytes:
    """The planted main.jsbundle out of a fixture (the zip is deflated, so raw bytes won't do)."""
    with zipfile.ZipFile(ipa) as zf:
        for n in zf.namelist():
            if n.endswith("main.jsbundle"):
                return zf.read(n)
    return b""


def run_verifier(ipa: str, host: str, key: str, extra: list[str] | None = None) -> tuple[int, str]:
    cmd = [
        sys.executable,
        VERIFIER,
        ipa,
        "--no-env-file",  # hermetic: never let the repo's .env or the environment decide
        "--expect-host",
        host,
        "--expect-key",
        key,
        "--expect-cfbundleversion",
        "29",
        "--expect-short-version",
        "1.0.0",
    ] + list(extra or [])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    keep = "--keep" in sys.argv[1:]
    workdir = tempfile.mkdtemp(prefix="spotter-verify-selftest-")
    cases: list[tuple[str, bool, int, str]] = []  # (name, ok, exit code, note)
    try:
        print("== self-test of %s" % VERIFIER)
        print("   fixtures in %s" % workdir)
        print("   HERMETIC: no real IPA, no network, no .env (--no-env-file on every run)")
        print()

        # --- PASS 1: the newer key form, with the string-table bleed trap planted -------------
        bleed = GOOD_KEY + "aiting on the first one"  # what build 29's table actually looks like
        ipa = build_fixture(workdir, "pass-publishable", host=DEFAULT_EXPECTED_HOST, key=bleed)
        code, out = run_verifier(ipa, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        planted = hits(bundle_bytes_of(ipa), GOOD_KEY) > 0
        ok = (
            code == 0
            and "VERDICT: ALL LITERAL CHECKS PASS" in out
            and "VERIFY_EXIT_CODE: 0" in out
            and "AT LEAST ONE LITERAL CHECK FAILED" not in out
            and planted
        )
        cases.append(("pass-publishable (bleed trap planted)", ok, code, "planted=%s" % planted))

        # --- PASS 2: the older JWT form, to prove a format change cannot break the verifier ---
        ipa = build_fixture(workdir, "pass-jwt", host=OTHER_HOST, key=GOOD_JWT)
        code, out = run_verifier(ipa, OTHER_HOST, GOOD_JWT)
        ok = (
            code == 0
            and "VERDICT: ALL LITERAL CHECKS PASS" in out
            and "PASS JWT-form key decodes to this project" in out
        )
        cases.append(("pass-jwt (both key families accepted)", ok, code, ""))

        # --- FAIL 1: placeholder key ----------------------------------------------------------
        ipa = build_fixture(workdir, "fail-placeholder-key", host=DEFAULT_EXPECTED_HOST, key=PLACEHOLDER_KEY)
        code, out = run_verifier(ipa, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        planted = hits(bundle_bytes_of(ipa), PLACEHOLDER_KEY) > 0
        ok = (
            code != 0
            and "VERDICT: AT LEAST ONE LITERAL CHECK FAILED" in out
            and "ALL LITERAL CHECKS PASS" not in out
            and "embedded key == configured key" in out
            and planted
        )
        cases.append(("fail-placeholder-key", ok, code, "planted=%s" % planted))

        # --- FAIL 2: dev-mock shape (measured signature: library constant, no host, no key) ---
        ipa = build_fixture(workdir, "fail-devmock-shape", host=None, key=None, library_constant=True)
        code, out = run_verifier(ipa, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        teeth = hits(bundle_bytes_of(ipa), LIBRARY_CONSTANT) > 0
        ok = (
            code != 0
            and "VERDICT: AT LEAST ONE LITERAL CHECK FAILED" in out
            and "real Supabase project host inlined" in out
            and "non-placeholder publishable key inlined" in out
            and teeth
        )
        cases.append(("fail-devmock-shape (supabase-js constant is not a key)", ok, code, ""))

        # --- FAIL 3: wrong host ---------------------------------------------------------------
        ipa = build_fixture(workdir, "fail-wrong-host", host=OTHER_HOST, key=GOOD_KEY)
        code, out = run_verifier(ipa, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        ok = code != 0 and "real Supabase project host inlined" in out and "AT LEAST ONE" in out
        cases.append(("fail-wrong-host", ok, code, ""))

        # --- FAIL 4: one product literal missing (every check gates the exit code) ------------
        dropped = PRESENT_LITERALS[0][2]
        ipa = build_fixture(
            workdir, "fail-missing-literal", host=DEFAULT_EXPECTED_HOST, key=GOOD_KEY, drop=(dropped,)
        )
        code, out = run_verifier(ipa, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        ok = code != 0 and "ALL LITERAL CHECKS PASS" not in out and "FAILED open-settings-control" in out
        cases.append(("fail-missing-literal (%r dropped)" % dropped, ok, code, ""))

        # --- FAIL 5: not an IPA at all --------------------------------------------------------
        junk = os.path.join(workdir, "not-an-ipa.ipa")
        with open(junk, "w") as fh:
            fh.write("this is not a zip\n")
        code, out = run_verifier(junk, DEFAULT_EXPECTED_HOST, GOOD_KEY)
        ok = code != 0 and "ARTIFACT ERROR" in out and "VERIFY_EXIT_CODE: 2" in out
        cases.append(("fail-not-an-ipa (artifact unreadable)", ok, code, ""))

        print()
        print("== results")
        bad = 0
        for name, ok, code, note in cases:
            print("   %-6s %-56s exit=%d %s" % ("OK" if ok else "BROKEN", name, code, note))
            if not ok:
                bad += 1
        print()
        print("SELFTEST: %d/%d cases behaved as required" % (len(cases) - bad, len(cases)))
        if bad:
            print("SELF-TEST FAILED: the verifier did not behave as required")
            for name, ok, code, _note in cases:
                if not ok:
                    print("  -- rerun this case for the full output:")
                    print("     %s %s <fixture>.ipa --no-env-file --expect-host H --expect-key K" % (sys.executable, VERIFIER))
                    print("     case: %s (exit=%d)" % (name, code))
            return 1
        print("SELF-TEST PASSED")
        return 0
    finally:
        if keep:
            # --keep: leave the fixtures on disk so a case can be re-run by hand, e.g.
            #   python3 scripts/release/verify_ipa.py <dir>/fail-devmock-shape.ipa \
            #       --no-env-file --expect-host H --expect-key K ; echo "EXIT=$?"
            print("fixtures kept in %s" % workdir)
        else:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
