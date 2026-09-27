#!/usr/bin/env node
/**
 * Transpile the app's src/lib TS modules to CommonJS so the smoke test can
 * exercise the REAL app logic (devMock, invites, workoutStore, supabase facade)
 * under Node — no Metro, no RN runtime. Type-system-only imports (database.types)
 * are elided by TypeScript transpileModule automatically.
 *
 * HARNESS INTEGRITY (2026-09-27) — why this script now cleans its output first:
 * `.compiled/` is gitignored, so it PERSISTS across commits in a working tree.
 * This script used to only mkdir + write, never remove. If a module was deleted
 * from `src/` (and from FILES below), its previously compiled `.js` stayed on
 * disk and a guard that requires that path kept loading it — a gate that could
 * no longer fail for the right reason, and one that reported the OLD bytes as
 * the current tree. Two changes close it:
 *   1. clean(): remove the generated directory before writing anything, so a
 *      guard can only ever run against bytes compiled in this run;
 *   2. the post-condition below: assert the directory contains EXACTLY the files
 *      this run just wrote — no orphans, no missing artifacts — and exit non-zero
 *      if it does not.
 * The `_deps.json` require-map is generated inside the output directory, so
 * cleaning the directory also removes the stale manifest.
 * Only `scripts/smoke/.compiled/` (generated, gitignored) is ever deleted: the
 * path is re-derived and validated in clean() before anything is removed.
 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const SMOKE_DIR = path.join(ROOT, 'scripts', 'smoke');
const OUT = path.join(SMOKE_DIR, '.compiled');
const FILES = [
  'src/lib/mock.ts',
  // src/lib/appVersion.ts is a REAL app module (analytics.ts and
  // pushRegistration.ts both import the constant it defines, and supabase.ts
  // imports analytics) — it must be compiled here or every compiled consumer
  // fails to resolve './appVersion'. That is why this list is 19, not 18.
  'src/lib/appVersion.ts',
  'src/lib/analytics.ts',
  'src/lib/weeklyResults.ts',
  'src/lib/invites.ts',
  'src/lib/supabase.ts',
  'src/lib/workouts.ts',
  'src/lib/settings.ts',
  'src/lib/storage.ts',
  'src/lib/workoutStore.ts',
  'src/lib/naming.ts',
  'src/lib/missPromise.ts',
  'src/lib/promises.ts',
  'src/lib/promiseRollover.ts',
  'src/lib/notificationPrefs.ts',
  'src/lib/notifications.ts',
  'src/lib/pushRegistration.ts',
  'src/lib/pushDispatch.ts',
  'src/lib/weekRecap.ts',
];
const DEP_MANIFEST = '_deps.json';
function stripUnused(moduleMap) {
  const used = new Set();
  for (const root of FILES) {
    const src = fs.readFileSync(path.join(ROOT, root), 'utf8');
    for (const m of Object.keys(moduleMap)) {
      if (src.includes(`from '${m}'`) || src.includes(`from "${m}"`)) used.add(m);
    }
  }
  return Object.fromEntries(Object.entries(moduleMap).filter(([m]) => used.has(m)));
}
const depMap = stripUnused(require('./deps.json'));

/**
 * Remove the generated output directory so nothing older than this run can be
 * required by a guard afterwards. Idempotent (a missing directory is fine) and
 * independent of git state, so it is safe on a dirty tree and in a scratch copy.
 *
 * Safety: the path is re-derived from __dirname and validated before deletion —
 * it must resolve to exactly `<repo>/scripts/smoke/.compiled`. If it does not,
 * this script refuses to delete anything and exits non-zero.
 */
function cleanOutput() {
  const resolved = path.resolve(OUT);
  const expected = path.resolve(path.join(SMOKE_DIR, '.compiled'));
  const insideSmokeDir = resolved.startsWith(path.resolve(SMOKE_DIR) + path.sep);
  if (resolved !== expected || path.basename(resolved) !== '.compiled' || !insideSmokeDir) {
    console.error(`[compile] REFUSING to clean unexpected output path: ${resolved} (expected ${expected})`);
    process.exit(1);
  }
  const existed = fs.existsSync(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
  if (fs.existsSync(resolved)) {
    console.error(`[compile] could not remove stale output directory: ${resolved}`);
    process.exit(1);
  }
  return existed;
}
function compile() {
  const hadStaleOutput = cleanOutput();
  fs.mkdirSync(OUT, { recursive: true });
  const written = [];
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: rel,
    });
    const name = rel.replace(/^src\/lib\//, '').replace(/\.ts$/, '.js');
    fs.writeFileSync(path.join(OUT, name), out.outputText);
    written.push(name);
  }
  // Require-map file the runner uses to resolve bare imports to harness stubs.
  fs.writeFileSync(
    path.join(OUT, DEP_MANIFEST),
    JSON.stringify({ map: depMap, files: FILES.map((f) => f.replace(/^src\/lib\//, '').replace(/\.ts$/, '.js')) }, null, 2),
  );
  written.push(DEP_MANIFEST);
  // Post-condition: the directory is EXACTLY what this run just wrote. An extra
  // file is an orphan from an earlier tree (the defect this guards against); a
  // missing file means a guard would load something else or crash. Either way the
  // harness is not trustworthy, so fail loudly instead of letting a guard decide.
  const present = fs.readdirSync(OUT).sort();
  const expected = [...written].sort();
  const missing = expected.filter((n) => !present.includes(n));
  const extra = present.filter((n) => !expected.includes(n));
  if (missing.length > 0 || extra.length > 0) {
    console.error(
      `[compile] output directory is not exactly this run's output — missing=[${missing.join(', ')}] orphaned=[${extra.join(', ')}]`,
    );
    process.exit(1);
  }
  console.log(
    `[compile] ${hadStaleOutput ? 'cleaned stale output, ' : ''}${FILES.length} modules -> ${OUT}`,
  );
}
compile();
