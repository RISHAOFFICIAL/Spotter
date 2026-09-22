'use strict';
/**
 * SPOTTER device-parity startup harness — DRIVER.
 *
 * Reproduces, offline, the environment the phone has when its first render runs:
 *   - Platform.OS === 'ios', __DEV__ === false (release), process.env inlined as
 *     Metro inlines it, Hermes-absent Node globals removed (parity-env.cjs);
 *   - the REAL module graph of each launch state's first route, loaded through
 *     expo-router's sync-require path (module graph printed by --graph);
 *   - a FRESH module registry per entry (one child process per entry).
 *
 * Usage:
 *   node scripts/device-parity/run.cjs                 # all four entries
 *   node scripts/device-parity/run.cjs --entry "src/app/_layout.tsx"
 *   node scripts/device-parity/run.cjs --stub-mode smoke   # A/B: old smoke stubs
 *   node scripts/device-parity/run.cjs --graph         # print the derived require set
 *   node scripts/device-parity/run.cjs --list          # print the keep/delete evidence table
 *
 * Exit code: 0 = every entry loaded clean, 1 = at least one entry threw.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { appGraph } = require('./graph.cjs');
const { DECISIONS } = require('./parity-env.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The first-render require set. expo-router (import mode 'sync', the default)
 * requires the root layout and the route it mounts first with a synchronous
 * require executed during render, so each of these is a separate "first render".
 */
const ENTRIES = [
  { id: 'root-layout', file: 'src/app/_layout.tsx', why: 'expo-router mounts the root layout first, always' },
  { id: 'no-session', file: 'src/app/(auth)/welcome.tsx', why: '!!session === false -> (auth)/welcome' },
  { id: 'session-not-onboarded', file: 'src/app/(onboarding)/index.tsx', why: 'session && !profile -> (onboarding)/index' },
  { id: 'onboarded-home', file: 'src/app/(home)/(tabs)/index.tsx', why: 'session && profile -> (home)/(tabs)/index' },
];

function parseArgs(argv) {
  const out = { stubMode: 'real', dev: false, entries: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry') out.entries = (out.entries || []).concat([argv[++i]]);
    else if (a === '--stub-mode') out.stubMode = argv[++i];
    else if (a === '--dev') out.dev = true;
    else if (a === '--graph') out.graph = true;
    else if (a === '--list') out.list = true;
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.list) {
  console.log('keep/delete decisions for the device-parity environment');
  console.log('(evidence files are in the installed react-native / expo packages)');
  console.log('');
  for (const [name, decision, confidence, evidence] of DECISIONS) {
    console.log(
      name.padEnd(28) + ' | ' + decision.padEnd(18) + ' | ' + confidence.padEnd(6) + ' | ' + evidence,
    );
  }
  process.exit(0);
}

const entries = args.entries
  ? args.entries.map((f) => ({ id: path.basename(f), file: f, why: 'explicit --entry' }))
  : ENTRIES;

if (args.graph) {
  console.log('expo-router import mode: sync (expo-router/build/import-mode/index.js:3 default "sync")');
  console.log('route modules are required synchronously during render (useScreens.js:218 -> getRoutesCore.js:239)');
  console.log('');
  for (const e of entries) {
    const g = appGraph(path.join(ROOT, e.file));
    console.log('== ' + e.id + '  (' + e.file + ')');
    console.log('   why first-render: ' + e.why);
    console.log('   app-source require closure: ' + g.length + ' modules');
    for (const f of g) console.log('     ' + f);
    console.log('');
  }
  process.exit(0);
}

const results = [];
for (const e of entries) {
  const entryAbs = path.join(ROOT, e.file);
  if (!fs.existsSync(entryAbs)) {
    console.log('!! entry missing: ' + e.file);
    results.push({ entry: e.file, ok: false, missing: true });
    continue;
  }
  const child = spawnSync(
    process.execPath,
    [
      '--conditions=react-native',
      '--conditions=browser',
      path.join(__dirname, 'load.cjs'),
      '--entry',
      entryAbs,
      '--stub-mode',
      args.stubMode,
      ...(args.dev ? ['--dev'] : []),
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = child.stdout || '';
  const stderr = child.stderr || '';
  const line = stdout.split('\n').find((l) => l.startsWith('###RESULT### '));
  let parsed = null;
  if (line) {
    try {
      parsed = JSON.parse(line.slice('###RESULT### '.length));
    } catch (err) {
      parsed = { parseError: String(err && err.message) };
    }
  }
  const rel = (f) => (f && f.startsWith(ROOT) ? path.relative(ROOT, f) : f);
  console.log('===========================================================');
  console.log('ENTRY [' + e.id + '] ' + e.file);
  console.log('why: ' + e.why);
  console.log('-----------------------------------------------------------');
  if (!args.quiet) console.log(stdout.replace(/###RESULT### .*\n?/, ''));
  if (stderr.trim()) console.log('[stderr]\n' + stderr);
  if (!parsed) {
    console.log('!! child produced no parsable result (exit ' + child.status + ')');
  } else {
    console.log(
      '=> ' + (parsed.ok ? 'CLEAN' : 'THROW') +
      '  modules_evaluated=' + parsed.evaluatedCount +
      '  elapsed_ms=' + parsed.elapsedMs +
      '  exit=' + child.status,
    );
    if (!parsed.ok && parsed.failure) {
      console.log('   module being evaluated: ' + rel(parsed.failure.evaluating));
      console.log('   error                  : ' + parsed.failure.name + ': ' + parsed.failure.message);
      if (parsed.failure.fatalReportedThroughErrorUtils) {
        console.log('   note: this reached ErrorUtils.reportFatalError == the device abort path');
      }
    }
  }
  results.push({ entry: e.file, id: e.id, ok: !!(parsed && parsed.ok), exit: child.status, parsed });
}

const failed = results.filter((r) => !r.ok);
console.log('===========================================================');
console.log(
  'SUMMARY: ' + (results.length - failed.length) + '/' + results.length + ' entries loaded clean under device parity' +
  ' (Platform.OS=ios, __DEV__=' + String(args.dev) + ', stub-mode=' + args.stubMode + ')',
);
if (failed.length) {
  console.log('FAILED entries: ' + failed.map((f) => f.id || f.entry).join(', '));
  process.exit(1);
}
console.log('RESULT: no throw in any first-render require graph (negative for the harness scope)');
process.exit(0);
