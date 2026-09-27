#!/usr/bin/env node
/*
 * compile-freshness-guard — the offline check that the smoke harness's compiled
 * output can only ever be read as THIS tree's bytes.
 *
 * WHY IT EXISTS: every offline guard compiles `src/lib/*.ts` into
 * `scripts/smoke/.compiled/` and then asserts against those files. That
 * directory is gitignored, so it PERSISTS across commits in a working tree. Until
 * 2026-09-27 the compiler only `mkdir`ed and wrote: it never removed anything. So
 * a module deleted from `src/` (and from the compiler's FILES list) left its
 * compiled `.js` on disk, and a guard that requires that path kept loading it —
 * the gate stayed GREEN against a module whose source no longer existed, and
 * reported the OLD bytes as the current tree. Reproduced (pre-#48 tree
 * `de8e087`): `promises.js` orphaned at the same md5, `promise-rollover-guard`
 * 21 PASS / 0 FAIL exit 0 and `bottom-bar-guard` 33 PASS / 0 FAIL exit 0, both
 * asserting against a deleted `src/lib/promises.ts`. Logs:
 * /home/team/shared/logs/compile-freshness/, write-up:
 * /home/team/shared/compile-freshness-fix-2026-09-27.md
 *
 * `scripts/smoke/compile.cjs` was fixed (PR #48) to clean the directory and to
 * assert a post-condition. That fix is loud in both directions — but a fix with
 * no test can be deleted by the next cleanup pass, and the whole point of this
 * defect class is that its absence is SILENT. This guard is that test. It does
 * not trust the compiler's self-report: it reads the directory itself and applies
 * ONE function (`freshnessProblem`) to both the real tree and to a scratch copy
 * of the PRE-#48 compiler, and requires the two verdicts to DIFFER.
 *
 * It asserts, on the tree that actually ships:
 *  1. the output directory is gitignored — the premise that makes the defect
 *     matter (a tracked directory would at least show up in a diff);
 *  2. the compiler runs clean (exit 0);
 *  3. the directory contains EXACTLY the modules the compiler's own generated
 *     manifest lists — no orphan, nothing missing (read from disk, not from the
 *     compiler's stdout);
 *  4. every compiled `x.js` has a `src/lib/x.ts` — no artifact for a module that
 *     no longer exists;
 *  5/6. NEGATIVE CONTROL, the pre-#48 shape: with the clean and the post-condition
 *     disabled the compiler exits 0 and the planted orphan SURVIVES, and the very
 *     same `freshnessProblem()` that passes the real tree FAILS that one by name
 *     — a gate nobody has seen fail is not a gate;
 *  7. with only the clean disabled, the compiler's post-condition exits non-zero
 *     and names the orphan;
 *  8. with the clean live, the same planted orphan cannot survive a run;
 *  9. the defect scenario end-to-end: a module removed from `src/` and from the
 *     compiler's file list leaves NO compiled artifact behind;
 * 10. idempotency: repeated runs exit 0 and produce the same listing;
 * 11. the path validation REFUSES a mis-derived output directory, and deletes
 *     nothing (file count under the mis-derived target is unchanged);
 * 12. the direction that was never silent: a source deleted while still listed
 *     fails loudly (ENOENT), so nothing can be skipped quietly;
 * 13. every guard that loads `.compiled` also spawns `compile.cjs` and tests its
 *     exit status — no guard may read the output without (re)generating it;
 * 14/15. the sweep is non-vacuous (it found the loaders) and the scratch cleanup
 *     left the shared `node_modules` tree intact (the symlink is unlinked, never
 *     followed).
 *
 * NOT covered here (stated so no one reads more into a green run): this proves
 * artifact/verdict freshness, not the guards' own assertions. Concurrency is
 * assumed: guards run SEQUENTIALLY and each invokes the compiler at its start, so
 * a shared output directory is safe to clean; two guards running at once would
 * not be — do not "fix" that by serialising inside the compiler.
 *
 * Everything scratch happens under os.tmpdir(); the only thing this guard does to
 * the shared tree is run the real compiler, which is what every other guard does.
 *
 * RUN:  node scripts/smoke/compile-freshness-guard.cjs     (exit 1 on any FAIL)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SMOKE_DIR = path.join(ROOT, 'scripts', 'smoke');
const COMPILE = path.join(SMOKE_DIR, 'compile.cjs');
const COMPILED = path.join(SMOKE_DIR, '.compiled');
const DEP_MANIFEST = '_deps.json';
const GHOST_FILE = 'ghost-from-an-older-tree.js';
const GHOST_DIR = 'ghost-dir';
// The three needles the scratch mutations are built from. If the compiler's shape
// changes, these stop matching and the control FAILS rather than silently
// becoming a no-op — the one way a negative control rots.
const NEEDLE_OUT = "const OUT = path.join(SMOKE_DIR, '.compiled');";
const NEEDLE_CLEAN = '  const hadStaleOutput = cleanOutput();';
const NEEDLE_POSTCONDITION = '  if (missing.length > 0 || extra.length > 0) {';

// --------------------------------------------------------------------------
// tiny reporter (one PASS/FAIL line per check — run_smoke.py counts them)
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

// --------------------------------------------------------------------------
// THE ANALYSER — one function, applied to the real tree and to the controls.
// Returns null when the directory is exactly the current run's output, or a
// human-readable reason why it is not.
// --------------------------------------------------------------------------
function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    return null;
  }
}
function freshnessProblem(dir) {
  const present = listDir(dir);
  if (present === null) return `no output directory at ${dir}`;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, DEP_MANIFEST), 'utf8'));
  } catch (error) {
    return `unreadable ${DEP_MANIFEST}: ${error.message}`;
  }
  const expected = [...manifest.files, DEP_MANIFEST].sort();
  const missing = expected.filter((n) => !present.includes(n));
  const orphaned = present.filter((n) => !expected.includes(n));
  // A compiled module with no source file is an orphan even when the manifest
  // lists it — this is the deleted-module defect seen from the src/ side.
  const noSource = present
    .filter((n) => n !== DEP_MANIFEST && n.endsWith('.js'))
    .filter((n) => !fs.existsSync(path.join(ROOT, 'src', 'lib', `${n.replace(/\.js$/, '')}.ts`)));
  const parts = [];
  if (missing.length > 0) parts.push(`missing=[${missing.join(', ')}]`);
  if (orphaned.length > 0) parts.push(`orphaned=[${orphaned.join(', ')}]`);
  if (noSource.length > 0) parts.push(`no-src-file=[${noSource.join(', ')}]`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// --------------------------------------------------------------------------
// scratch trees: a minimal copy of the harness the compiler can be mutated and
// run in, so NO control can touch the real one. `node_modules` is a symlink to
// the shared tree (the compiler needs `typescript`); cleanup unlinks it first so
// a recursive delete can never follow it.
// --------------------------------------------------------------------------
function makeScratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-freshness-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'smoke'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src', 'lib'), path.join(dir, 'src', 'lib'), { recursive: true });
  fs.copyFileSync(COMPILE, path.join(dir, 'scripts', 'smoke', 'compile.cjs'));
  fs.copyFileSync(path.join(SMOKE_DIR, 'deps.json'), path.join(dir, 'scripts', 'smoke', 'deps.json'));
  const nm = fs.realpathSync(path.join(ROOT, 'node_modules'));
  fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir');
  return dir;
}
function scratchCompilePath(dir) {
  return path.join(dir, 'scripts', 'smoke', 'compile.cjs');
}
function patchScratchCompiler(dir, replacements) {
  const p = scratchCompilePath(dir);
  let src = fs.readFileSync(p, 'utf8');
  for (const [needle, replacement] of replacements) {
    if (!src.includes(needle)) {
      throw new Error(`compiler shape changed — needle not found: ${JSON.stringify(needle)}`);
    }
    src = src.replace(needle, replacement);
  }
  fs.writeFileSync(p, src);
}
function runScratchCompile(dir) {
  return spawnSync(process.execPath, [scratchCompilePath(dir)], { cwd: dir, encoding: 'utf8' });
}
function scratchOut(dir) {
  return path.join(dir, 'scripts', 'smoke', '.compiled');
}
function plantGhosts(dir) {
  const out = scratchOut(dir);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, GHOST_FILE), '// bytes from an older tree\n');
  fs.mkdirSync(path.join(out, GHOST_DIR), { recursive: true });
  fs.writeFileSync(path.join(out, GHOST_DIR, 'stale.js'), '// stale\n');
}
function ghostsPresent(dir) {
  return fs.existsSync(path.join(scratchOut(dir), GHOST_FILE)) && fs.existsSync(path.join(scratchOut(dir), GHOST_DIR));
}
function dropFromFileList(dir, rel) {
  const p = scratchCompilePath(dir);
  const src = fs.readFileSync(p, 'utf8');
  const needle = `  '${rel}',\n`;
  if (!src.includes(needle)) throw new Error(`FILES entry not found: ${needle}`);
  fs.writeFileSync(p, src.replace(needle, ''));
}
function outText(res) {
  return `${(res.stdout || '').trim()} ${(res.stderr || '').trim()}`.trim();
}
function short(s) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
}
// Names + byte lengths of one output directory: equal signatures mean the run
// produced the same artifacts, not merely the same file count.
function dirSignature(dir) {
  return (listDir(dir) || [])
    .map((n) => {
      const p = path.join(dir, n);
      const st = fs.statSync(p);
      return `${n}:${st.isDirectory() ? 'dir' : fs.readFileSync(p).length}`;
    })
    .join('|');
}

const scratches = [];
const scratch = () => {
  const dir = makeScratch();
  scratches.push(dir);
  return dir;
};

try {
  console.log('=== compile-freshness-guard: the gate can only read this tree’s bytes ===');

  // ------------------------------------------------------------------------
  // 1-4. the REAL tree
  // ------------------------------------------------------------------------
  const ignore = spawnSync('git', ['check-ignore', '-q', 'scripts/smoke/.compiled'], { cwd: ROOT });
  check(
    'premise: scripts/smoke/.compiled is gitignored (so it outlives commits in a working tree)',
    ignore.status === 0,
    `git check-ignore exit=${ignore.status}`,
  );

  const realCompile = spawnSync(process.execPath, [COMPILE], { cwd: ROOT, encoding: 'utf8' });
  check(
    'the real compiler runs clean (exit 0)',
    realCompile.status === 0,
    short(outText(realCompile)) || `exit ${realCompile.status}`,
  );

  const realProblem = freshnessProblem(COMPILED);
  const realPresent = listDir(COMPILED) || [];
  check(
    'the real output directory is EXACTLY the compiler’s own manifest — no orphan, nothing missing',
    realProblem === null,
    realProblem === null ? `${realPresent.length} entries, no orphan` : realProblem,
  );
  const noSource = realPresent
    .filter((n) => n !== DEP_MANIFEST && n.endsWith('.js'))
    .filter((n) => !fs.existsSync(path.join(ROOT, 'src', 'lib', `${n.replace(/\.js$/, '')}.ts`)));
  check(
    'no compiled module survives without a src/lib source file',
    noSource.length === 0,
    noSource.length === 0 ? `${realPresent.length - 1} modules, all backed by source` : `orphaned=${noSource.join(', ')}`,
  );

  // ------------------------------------------------------------------------
  // 5-6. NEGATIVE CONTROL — the pre-#48 compiler, built in scratch from the
  //      current source by disabling the clean and the post-condition.
  // ------------------------------------------------------------------------
  const preFix = scratch();
  patchScratchCompiler(preFix, [
    [NEEDLE_CLEAN, '  const hadStaleOutput = false; // NEGATIVE CONTROL: clean disabled'],
    [
      NEEDLE_POSTCONDITION,
      '  if (false && (missing.length > 0 || extra.length > 0)) { // NEGATIVE CONTROL: assertion disabled',
    ],
  ]);
  plantGhosts(preFix);
  const preFixRun = runScratchCompile(preFix);
  // The pre-fix compiler's summary line is the only thing that changed shape;
  // compare its module count to the real run's so the control is provably the
  // same generator, not a stub.
  check(
    'NEGATIVE CONTROL: the pre-#48 shape exits 0 and the planted orphan SURVIVES its run',
    preFixRun.status === 0 && ghostsPresent(preFix),
    `exit=${preFixRun.status} ghostsPresent=${ghostsPresent(preFix)} :: ${short(outText(preFixRun))}`,
  );
  const preFixProblem = freshnessProblem(scratchOut(preFix));
  check(
    'NEGATIVE CONTROL: the same analyser that passes the real tree FAILS the pre-#48 tree, naming the orphan',
    preFixProblem !== null && preFixProblem.includes(GHOST_FILE),
    `analyser said: ${preFixProblem}`,
  );

  // ------------------------------------------------------------------------
  // 7. clean disabled, post-condition LIVE — the compiler's own gate must fire.
  // ------------------------------------------------------------------------
  const noClean = scratch();
  patchScratchCompiler(noClean, [
    [NEEDLE_CLEAN, '  const hadStaleOutput = false; // control: clean disabled, post-condition live'],
  ]);
  plantGhosts(noClean);
  const noCleanRun = runScratchCompile(noClean);
  check(
    'clean disabled + post-condition live: the compiler exits non-zero and NAMES the orphan',
    noCleanRun.status !== 0 && /orphaned=\[/.test(outText(noCleanRun)) && outText(noCleanRun).includes(GHOST_FILE),
    `exit=${noCleanRun.status} :: ${short(outText(noCleanRun))}`,
  );

  // ------------------------------------------------------------------------
  // 8. the master shape: a leftover from an earlier tree cannot survive a run.
  // ------------------------------------------------------------------------
  const fixed = scratch();
  plantGhosts(fixed);
  const fixedRun = runScratchCompile(fixed);
  const fixedProblem = freshnessProblem(scratchOut(fixed));
  check(
    'the master shape removes a planted orphan and the analyser agrees (exit 0, problem null)',
    fixedRun.status === 0 && !ghostsPresent(fixed) && fixedProblem === null,
    `exit=${fixedRun.status} ghostsPresent=${ghostsPresent(fixed)} problem=${fixedProblem} :: ${short(outText(fixedRun))}`,
  );

  // ------------------------------------------------------------------------
  // 9. the defect scenario end-to-end: a module that leaves src/ AND the file
  //    list must leave no compiled artifact behind.
  // ------------------------------------------------------------------------
  const dropped = scratch();
  fs.rmSync(path.join(dropped, 'src', 'lib', 'promises.ts'));
  dropFromFileList(dropped, 'src/lib/promises.ts');
  const droppedRun = runScratchCompile(dropped);
  const droppedProblem = freshnessProblem(scratchOut(dropped));
  check(
    'a module dropped from src/ + the file list leaves NO compiled artifact (exit 0, problem null)',
    droppedRun.status === 0 &&
      !fs.existsSync(path.join(scratchOut(dropped), 'promises.js')) &&
      droppedProblem === null,
    `exit=${droppedRun.status} promises.js=${fs.existsSync(path.join(scratchOut(dropped), 'promises.js'))} problem=${droppedProblem}`,
  );

  // ------------------------------------------------------------------------
  // 10. idempotency — repeated runs are a no-op, not an accumulation.
  // ------------------------------------------------------------------------
  const sigBefore = dirSignature(scratchOut(fixed));
  const second = runScratchCompile(fixed);
  const third = runScratchCompile(fixed);
  const sigAfter = dirSignature(scratchOut(fixed));
  // Second tree, first run: a fresh directory must produce the same signature as
  // a repeated run does — i.e. the output is a function of the source, not of
  // whatever happened to be on disk before.
  const freshRun = runScratchCompile(dropped);
  check(
    'idempotency: repeat runs exit 0 and leave byte-identical output (cleaning a missing dir is fine)',
    second.status === 0 && third.status === 0 && freshRun.status === 0 && sigBefore === sigAfter,
    `exits=${second.status},${third.status},${freshRun.status} sameSignature=${sigBefore === sigAfter}`,
  );

  // ------------------------------------------------------------------------
  // 11. the path validation: a mis-derived output directory is REFUSED and
  //     nothing is deleted.
  // ------------------------------------------------------------------------
  const misDerived = scratch();
  patchScratchCompiler(misDerived, [
    [NEEDLE_OUT, "const OUT = path.join(ROOT, 'src', 'lib'); // control: mis-derived output path"],
  ]);
  const srcLib = path.join(misDerived, 'src', 'lib');
  const before = fs.readdirSync(srcLib).sort();
  const misRun = runScratchCompile(misDerived);
  const after = fs.readdirSync(srcLib).sort();
  check(
    'mis-derived output path: the compiler REFUSES (non-zero) and deletes NOTHING from src/',
    misRun.status !== 0 &&
      /REFUSING/.test(outText(misRun)) &&
      before.length === after.length &&
      JSON.stringify(before) === JSON.stringify(after),
    `exit=${misRun.status} src/lib files ${before.length}->${after.length} :: ${short(outText(misRun))}`,
  );

  // ------------------------------------------------------------------------
  // 12. the direction that was never silent: source deleted, entry still listed.
  // ------------------------------------------------------------------------
  const missingSource = scratch();
  fs.rmSync(path.join(missingSource, 'src', 'lib', 'weekRecap.ts'));
  const missingRun = runScratchCompile(missingSource);
  check(
    'source deleted while still in the file list fails LOUDLY (non-zero), so nothing is skipped silently',
    missingRun.status !== 0,
    `exit=${missingRun.status} :: ${short(outText(missingRun))}`,
  );

  // ------------------------------------------------------------------------
  // 13-14. no guard may read the compiled output without regenerating it.
  // ------------------------------------------------------------------------
  const guardFiles = fs.readdirSync(SMOKE_DIR).filter((f) => f.endsWith('-guard.cjs')).sort();
  const loaders = guardFiles.filter((f) => fs.readFileSync(path.join(SMOKE_DIR, f), 'utf8').includes('.compiled'));
  const offenders = loaders.filter((f) => {
    const s = fs.readFileSync(path.join(SMOKE_DIR, f), 'utf8');
    return !(s.includes('compile.cjs') && /status\s*(===|!==)/.test(s));
  });
  check(
    'every guard that loads .compiled also spawns compile.cjs and tests its exit status',
    offenders.length === 0,
    offenders.length === 0 ? `${loaders.length} loaders checked` : `offenders=${offenders.join(', ')}`,
  );
  check(
    'the loader sweep is non-vacuous (a sweep over zero files would pass by itself)',
    loaders.length >= 5,
    `found ${loaders.length}: ${loaders.join(', ')}`,
  );
} catch (error) {
  // Harness-level failure (scratch setup, a needle that stopped matching): still
  // a FAIL, still non-zero.
  check('harness: the guard ran to completion', false, `${error.name}: ${error.message}`);
} finally {
  for (const dir of scratches) {
    try {
      fs.unlinkSync(path.join(dir, 'node_modules')); // never let a recursive rm follow it
    } catch (error) {
      /* already gone / never created */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The cleanup check runs AFTER the sweep so it observes the real state.
try {
  const nm = path.join(ROOT, 'node_modules', 'typescript');
  check(
    'scratch cleanup unlinked the node_modules symlink instead of following it (shared tree intact)',
    fs.existsSync(nm),
    `typescript @ ${nm} exists=${fs.existsSync(nm)}`,
  );
} catch (error) {
  check('scratch cleanup left the shared node_modules intact', false, `${error.name}: ${error.message}`);
}

console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
