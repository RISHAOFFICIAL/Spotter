#!/usr/bin/env bash
#
# prelaunch-check.sh — SPOTTER 1.0 internal pre-launch review (OFFLINE by default).
#
# Runs the offline review chain in order and writes a timestamped artifact to
# /home/team/shared/review-artifacts/<YYYY-MM-DD-HHMM>-<branch>-<sha>.md, so a
# review leaves a file behind even if the session dies.
#
# Live steps (run_smoke.py + debris dry-run) are OPT-IN behind --live and still
# require the service-role key (process env `ServiceRoleSupabase`, never the repo
# .env). The default run never touches the backend or App Store Connect.
#
# Companion runbook: /home/team/shared/prelaunch-review-workflow-2026-09-23.md
#
# Usage:
#   bash scripts/review/prelaunch-check.sh          # offline only
#   bash scripts/review/prelaunch-check.sh --live   # + live suite + debris dry-run
#
# Exit code: 0 only if every step passed (and, under --live, the live run + dry
# inventory passed); otherwise 1.
#
# NOTE (memory): this box is ~4 GB with often <400 MB available and the website
# dev server resident. tsc can be OOM-killed (exit 137) if another session is
# working. Exit 137 is a machine-condition signal, NOT a type error — re-run when
# the box is idle. Output is captured to temp files (not shell variables) so the
# runner itself never holds a large buffer in memory.

set -uo pipefail

APP_DIR="${APP_DIR:-/home/team/shared/app}"
OUT_DIR="${OUT_DIR:-/home/team/shared/review-artifacts}"
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

cd "$APP_DIR" 2>/dev/null || { echo "cannot cd $APP_DIR" >&2; exit 2; }
mkdir -p "$OUT_DIR"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/ ' '__')"
SHA="$(git rev-parse --short HEAD 2>/dev/null)"
TREE="${BRANCH:-untracked}-${SHA:-nosha}"
STAMP="$(date +%Y-%m-%d-%H%M)"
ART="$OUT_DIR/$STAMP-$TREE.md"
TMPD="$(mktemp -d)"

FAILED=0
NL=$'\n'
SUMMARY_LINES=""

step() {
  # step <label> <expect> <cmd...>
  local label="$1" expect="$2"; shift 2
  local outfile="$TMPD/out"; : > "$outfile"
  local rc sum line
  "$@" > "$outfile" 2>&1; rc=$?
  sum="$(grep -E 'SUMMARY:|ALL [0-9]+ STEPS|^\[compile\]|^HTTP' "$outfile" | tail -1)"
  [ -z "$sum" ] && sum="(no summary line; see output)"
  [ "$rc" -eq 137 ] && sum="$sum  [exit 137 = SIGKILL/OOM — re-run when the box is idle]"
  printf '| %-28s | exit %s | %s | %s |\n' "$label" "$rc" "$expect" "$sum" >> "$ART"
  {
    printf '## %s\n' "$label"
    printf 'exit=%s expected=%s\n\n```\n' "$rc" "$expect"
    cat "$outfile"
    printf '\n```\n\n'
  } >> "$ART"
  # PASS/FAIL decision: exit 0 AND the expected summary substring. A shrunken or
  # missing gate is itself a FAIL (never a silent skip).
  local pass=0
  case "$label" in
    *tsc*|*compile*)        [ "$rc" -eq 0 ] && pass=1 ;;
    *stack-children*)       printf '%s' "$sum" | grep -q '19 PASS / 0 FAIL' && pass=1 ;;
    *promise-rollover*)     printf '%s' "$sum" | grep -q '21 PASS / 0 FAIL' && pass=1 ;;
    *bottom-bar*)           printf '%s' "$sum" | grep -q '33 PASS / 0 FAIL' && pass=1 ;;
    *onboarding-order*)     printf '%s' "$sum" | grep -q '15 PASS / 0 FAIL' && pass=1 ;;
    *smoke-test*)           printf '%s' "$sum" | grep -q 'ALL 26 STEPS PASSED' && pass=1 ;;
    *)                      [ "$rc" -eq 0 ] && pass=1 ;;
  esac
  if [ "$pass" -eq 1 ]; then
    SUMMARY_LINES="${SUMMARY_LINES}${NL}  PASS  $label"
  else
    SUMMARY_LINES="${SUMMARY_LINES}${NL}  FAIL  $label"
    FAILED=1
  fi
}

{
  printf '# SPOTTER pre-launch review — %s\n' "$STAMP"
  printf 'tree: %s @ %s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" "$SHA"
  printf 'mode: %s\n\n' "$([ $LIVE -eq 1 ] && echo 'OFFLINE + LIVE' || echo 'OFFLINE only')"
  printf '| step | exit | expected | summary |\n|---|---|---|---|\n'
} > "$ART"

# ---- offline chain -----------------------------------------------------------
step "tsc --noEmit"           "exit 0"              npx tsc --noEmit
step "compile.cjs"            "exit 0 (18 modules)" node scripts/smoke/compile.cjs
step "stack-children-guard"   "19 PASS / 0 FAIL"    node scripts/smoke/stack-children-guard.cjs
step "promise-rollover-guard" "21 PASS / 0 FAIL"    node scripts/smoke/promise-rollover-guard.cjs
step "bottom-bar-guard"       "33 PASS / 0 FAIL"    node scripts/smoke/bottom-bar-guard.cjs
if [ -f scripts/smoke/onboarding-order-guard.cjs ]; then
  step "onboarding-order-guard" "15 PASS / 0 FAIL" node scripts/smoke/onboarding-order-guard.cjs
else
  # Missing guard is itself a FAIL (never a silent skip) — see runbook §7.
  {
    printf '| %-28s | exit N/A | %s | %s |\n' "onboarding-order-guard" "15 PASS / 0 FAIL" "GUARD FILE MISSING on this branch"
    printf '## onboarding-order-guard\n\nexit=missing expected=15 PASS / 0 FAIL\n\n```\nscripts/smoke/onboarding-order-guard.cjs is NOT on this branch.\nIt lives on fix/onboarding-user-row-order (PR #37). A missing guard is a FAIL.\n```\n\n'
  } >> "$ART"
  SUMMARY_LINES="${SUMMARY_LINES}${NL}  FAIL  onboarding-order-guard (file missing — present only on PR #37 branch)"
  FAILED=1
fi
step "smoke-test.mjs"         "ALL 26 STEPS PASSED" node scripts/smoke-test.mjs

# ---- live (opt-in) -----------------------------------------------------------
if [ $LIVE -eq 1 ]; then
  if [ -n "${ServiceRoleSupabase:-}" ]; then
    step "run_smoke.py (live)" "0 FAIL, exit 0" python3 scripts/real-mode-smoke/run_smoke.py
    if [ -f /tmp/smoke-results.json ]; then
      cp /tmp/smoke-results.json "$OUT_DIR/$STAMP-$TREE-smoke-results.json"
      printf 'smoke-results: %s\n\n' "$OUT_DIR/$STAMP-$TREE-smoke-results.json" >> "$ART"
    fi
    step "debris dry-run" "inventory; check1/check2 + 9d1052ae left alone" bash /home/team/shared/cleanup-test-debris.sh
  else
    {
      printf '## live steps SKIPPED\n\n`ServiceRoleSupabase` not set in the environment — live suite and debris inventory cannot run.\n\n'
    } >> "$ART"
    SUMMARY_LINES="${SUMMARY_LINES}${NL}  SKIP  live suite (ServiceRoleSupabase not set)"
  fi
fi

{
  printf '\n## Result\n\n```%s\n```\n' "$SUMMARY_LINES"
  printf '\nverdict: %s\n' "$([ $FAILED -eq 0 ] && echo 'ALL PASS' || echo 'FAILURES PRESENT')"
} >> "$ART"

rm -rf "$TMPD"
echo "artifact: $ART"
printf '%s\n' "$SUMMARY_LINES" | sed 's/^/  /'
exit $FAILED
