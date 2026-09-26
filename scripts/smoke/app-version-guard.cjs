#!/usr/bin/env node
/*
 * app-version-guard — the offline check that the version a build STAMPS onto
 * its own data is the version it declares.
 *
 * WHY IT EXISTS (2026-09-26): app.json declared "1.0.0" while the code stamped
 * a hardcoded '1.1.0' into every row it wrote — `analytics_events.app_version`
 * (src/lib/analytics.ts:185, from the literal at :102) and
 * `push_devices.app_version` (src/lib/pushRegistration.ts:77 and :94). Build 29
 * would have shipped that: every event and push row of the 1.0.0 launch
 * build reading 1.1.0, so version-segmented retention data is unattributable
 * and a real future 1.1.0 is indistinguishable from launch. The value is now
 * DERIVED from app.json's declared version (Expo resolves it into
 * `Constants.expoConfig.version`, the same read src/lib/diagnostics.ts has
 * always used) through the single definition in src/lib/appVersion.ts.
 *
 * WHAT IT ASSERTS (FIXED count, one PASS/FAIL line per check):
 *  S1-S4  the src/ tree: no version-shaped string literal anywhere under src/,
 *         both stamp sites use the shared constant, and the one definition
 *         module cannot throw (optional chaining inside try/catch + an honest
 *         non-version-shaped fallback);
 *  S5-S6  app.json's declared version is well-formed, and the OFFLINE HARNESS
 *         mirrors it rather than carrying its own stale copy (the stub held
 *         '1.1.0' — that is how a harness hides this defect class);
 *  H1-H2  the shared compile step ran, and the compiled lib really resolves to
 *         DEV MOCK — so this guard can never write to the live project;
 *  D1-D6  BEHAVIOUR, through the compiled modules: the app_version actually
 *         reaching an emitted event row, and a dev-mock push_devices row, EQUALS
 *         app.json's declared version; both FOLLOW the embedded config (proved
 *         with a sentinel version, so a baked literal cannot pass); a build with
 *         no embedded config at all still loads, does not throw, and stamps
 *         something that is not version-shaped; and both stamp sites resolve the
 *         same single version module;
 *  N1-N4  NEGATIVE CONTROLS — the same sweep must fail a planted literal, the
 *         exact pre-fix master lines, and a literal equal to the CURRENT
 *         declared version (a correct-but-hardcoded number is the next drift);
 *         and the same stamp-equality assertion must REJECT a module stamping a
 *         hardcoded version (the pre-fix analytics source, reconstructed and
 *         compiled by this app's own compile settings, then driven for real).
 *         A gate that cannot fail is not a gate.
 *
 * VERSION-SHAPED STRINGS IN THIS FILE ('1.1.0' as the pre-fix value, the
 * sentinel '9.9.9') are test INPUTS that live under scripts/, deliberately: the
 * S1 sweep forbids them under src/, which is where a stamped value could ship.
 *
 * NOT COVERED (stated so a green run is not read as more than it is): this
 * proves the value a DEV-MOCK row carries; it cannot see what an EAS-built
 * binary stamps, because the offline harness supplies expo-constants. The
 * release-mode answer rests on `Constants.expoConfig.version` being the
 * build's own declared version — the read src/lib/diagnostics.ts already ships.
 *
 * RUN:  node scripts/smoke/app-version-guard.cjs        (exit 1 on any FAIL)
 * COUNT: FIXED_CHECKS table lines + 1 self-check line = 19 PASS/FAIL lines, the
 *        number scripts/real-mode-smoke/run_smoke.py pins as
 *        APP_VERSION_GUARD_CHECKS (a missing, silent or shrunken guard is
 *        itself a FAIL there).
 * WIRED: scripts/real-mode-smoke/run_smoke.py flow 0f
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const APP_JSON = path.join(ROOT, 'app.json');
const ANALYTICS_SRC = path.join(SRC, 'lib', 'analytics.ts');
const PUSH_SRC = path.join(SRC, 'lib', 'pushRegistration.ts');
const VERSION_SRC = path.join(SRC, 'lib', 'appVersion.ts');
const COMPILE = path.join(ROOT, 'scripts', 'smoke', 'compile.cjs');
const COMPILED = path.join(ROOT, 'scripts', 'smoke', '.compiled');
const FIXED_CHECKS = 18;

// ---------------------------------------------------------------------------
// This guard must NEVER touch the live project. run_smoke.py hands its own
// environment (live EXPO_PUBLIC_* vars) to every subprocess it spawns, and
// src/lib/supabase.ts decides DEV vs REAL from those two vars at module load —
// so they are removed here, before any compiled module is required, and H2
// asserts the resulting mode is DEV MOCK instead of trusting this line.
// ---------------------------------------------------------------------------
delete process.env.EXPO_PUBLIC_SUPABASE_URL;
delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

let passes = 0;
let fails = 0;
function report(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}
const checks = [];
const check = (name, run) => checks.push({ name, run });

console.log('=== app-version-guard: the stamped version is the declared version ===');

// ---------------------------------------------------------------------------
// the declared version under test, read from the app's own config
// ---------------------------------------------------------------------------
const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
const DECLARED = appJson.expo.version;
const SENTINEL = '9.9.9'; // version-shaped test INPUT (scripts/, never src/)
const PRE_FIX = '1.1.0'; // the value hardcoded on master @ 250ca88 (test INPUT)

// ---------------------------------------------------------------------------
// ONE analyser, shared by the shipped tree and every negative control.
// A version-shaped string literal is a quoted `N.N.N` — the shape that shipped
// as a stamped value.
// ---------------------------------------------------------------------------
const VERSION_LITERAL = /(['"`])(\d+\.\d+\.\d+)\1/g;
function sweepVersionLiterals(text) {
  const hits = [];
  String(text == null ? '' : text)
    .split('\n')
    .forEach((line, i) => {
      VERSION_LITERAL.lastIndex = 0;
      let m;
      while ((m = VERSION_LITERAL.exec(line)) !== null) hits.push({ line: i + 1, literal: m[2], text: line.trim() });
    });
  return hits;
}
/** THE assertion of this guard: does the value that reached a row match app.json? */
function stampMatchesDeclared(stamp, declared) {
  return typeof stamp === 'string' && stamp === declared;
}

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// harness: shared compile step (the dynamic half runs the COMPILED modules) and
// a require map that lets the compiled lib resolve to the offline stubs
// ---------------------------------------------------------------------------
const compileRun = spawnSync(process.execPath, [COMPILE], { cwd: ROOT, encoding: 'utf8' });
const deps = require(path.join(COMPILED, '_deps.json')).map;
const Module = require('module');
const origResolve = Module._resolveFilename;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'appver-guard-'));
let shimPath = null;
const appVersionResolutions = new Set();
Module._resolveFilename = function (request, ...args) {
  if (request === 'expo-constants' && shimPath) return shimPath;
  if (Object.prototype.hasOwnProperty.call(deps, request)) return path.resolve(ROOT, 'scripts', deps[request]);
  const resolved = origResolve.call(this, request, ...args);
  if (request === './appVersion') appVersionResolutions.add(resolved);
  return resolved;
};
/** Drop every cached copy of the compiled lib + the shims: each scenario must
 *  load the modules fresh, against its own expo-constants. */
function bustRequireCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(COMPILED) || key.startsWith(TMP)) delete require.cache[key];
  }
}
function shim(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, body);
  return p;
}
const SHIM_DECLARED = shim(
  'ec-declared.js',
  `module.exports = { default: { expoConfig: { version: ${JSON.stringify(DECLARED)} } }, expoConfig: { version: ${JSON.stringify(DECLARED)} } };\n`,
);
const SHIM_SENTINEL = shim(
  'ec-sentinel.js',
  `module.exports = { default: { expoConfig: { version: ${JSON.stringify(SENTINEL)} } }, expoConfig: { version: ${JSON.stringify(SENTINEL)} } };\n`,
);
const SHIM_ABSENT = shim('ec-absent.js', 'module.exports = {};\n');

/** Drive the REAL compiled analytics module and read the app_version it put on
 *  an emitted row. Throws are the caller's failure (track() must never throw). */
async function emittedEventStamp(constantsShim) {
  shimPath = constantsShim;
  bustRequireCache();
  const analytics = require(path.join(COMPILED, 'analytics.js'));
  analytics.clearDevEventBuffer();
  await analytics.track('app_opened');
  const buffer = analytics.getDevEventBuffer();
  return { rows: buffer.length, stamp: buffer.length ? buffer[buffer.length - 1].app_version : null };
}
/** Drive the REAL compiled pushRegistration dev path and read the app_version it
 *  wrote onto the device row (captured at the devMock boundary). */
async function devPushDeviceStamp(constantsShim) {
  shimPath = constantsShim;
  bustRequireCache();
  const mock = require(path.join(COMPILED, 'mock.js'));
  const supabase = require(path.join(COMPILED, 'supabase.js'));
  const captured = [];
  const original = mock.devMock.upsertPushDevice;
  mock.devMock.upsertPushDevice = async (userId, device) => {
    captured.push(device);
    return original.call(mock.devMock, userId, device);
  };
  const auth = await supabase.authenticate('app-version-guard@spotter.test', 'pass1234');
  const push = require(path.join(COMPILED, 'pushRegistration.js'));
  const registered = await push.registerPushDevice();
  return {
    auth: !!(auth && auth.ok),
    registered,
    rows: captured.length,
    stamp: captured.length ? captured[captured.length - 1].app_version : null,
  };
}
/** The pre-fix module: this app's OWN analytics source with the defect put back,
 *  compiled with this app's own compiler options. Not a re-implementation — if
 *  either substitution misses, the driven stamp equals the declared version and
 *  N4 fails loudly instead of passing quietly. */
const analyticsSource = fs.readFileSync(ANALYTICS_SRC, 'utf8');
function prefixAnalyticsModule() {
  const importLine = "import { APP_VERSION } from './appVersion';\n";
  const constLine = "const APP_VERSION = '1.1.0';\n";
  // A tree that ALREADY stamps a hardcoded version (the pre-fix tree) is this
  // control's input as it stands.
  let text = analyticsSource;
  if (text.includes(importLine)) {
    text = text.split(importLine).join('');
    const anchor = "const SESSION_KEY = 'spotter.session_id:v1';\n";
    if (!text.includes(anchor)) return null;
    text = text.replace(anchor, anchor + constLine);
    text = text.replace('app_version: APP_VERSION,', "app_version: '1.1.0',");
  }
  const out = path.join(COMPILED, '_negcontrol-prefix-analytics.js');
  fs.writeFileSync(
    out,
    ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: 'src/lib/analytics.ts',
    }).outputText,
  );
  return out;
}
let prefixModulePath = null;

// ---------------------------------------------------------------------------
// S1-S4: the src/ tree
// ---------------------------------------------------------------------------
const srcFiles = walkSourceFiles(SRC);
check('src sweep: no version-shaped string literal ("N.N.N", any quote style) anywhere under src/ — doc comments included', () => {
  const hits = [];
  for (const file of srcFiles) {
    for (const h of sweepVersionLiterals(fs.readFileSync(file, 'utf8'))) {
      hits.push(`${path.relative(ROOT, file)}:${h.line} '${h.literal}'`);
    }
  }
  return { ok: hits.length === 0, detail: `files=${srcFiles.length} literals=${JSON.stringify(hits)}` };
});
check('src: analytics.ts stamps the shared constant imported from ./appVersion (no local version const)', () => {
  const src = fs.readFileSync(ANALYTICS_SRC, 'utf8');
  return {
    ok:
      src.includes("import { APP_VERSION } from './appVersion';") &&
      /app_version:\s*APP_VERSION,/.test(src) &&
      !/const APP_VERSION\s*=/.test(src),
    detail: `import=${src.includes("from './appVersion'")} stamp=${/app_version:\s*APP_VERSION,/.test(src)} localConst=${/const APP_VERSION\s*=/.test(src)}`,
  };
});
check('src: pushRegistration.ts stamps the shared constant at BOTH sites (dev + real upsert)', () => {
  const src = fs.readFileSync(PUSH_SRC, 'utf8');
  const sites = (src.match(/app_version:\s*APP_VERSION,/g) || []).length;
  return {
    ok: src.includes("import { APP_VERSION } from './appVersion';") && sites === 2,
    detail: `import=${src.includes("from './appVersion'")} APP_VERSION sites=${sites} (expected 2)`,
  };
});
check('src: appVersion.ts is a never-throw read of the embedded config with an honest, non-version-shaped fallback', () => {
  const src = fs.existsSync(VERSION_SRC) ? fs.readFileSync(VERSION_SRC, 'utf8') : '';
  const shape = {
    optionalChaining: /Constants\?\.expoConfig\?\.version/.test(src),
    tryCatch: /try \{[\s\S]*?\} catch \{/.test(src),
    sentinel: /export const APP_VERSION_UNKNOWN = 'unknown';/.test(src),
    usedAsFallback: /\?\? APP_VERSION_UNKNOWN/.test(src),
    exportsStamp: /export const APP_VERSION: string =/.test(src),
  };
  return { ok: Object.values(shape).every(Boolean), detail: JSON.stringify(shape) };
});

// ---------------------------------------------------------------------------
// S5-S6: the declared version and the harness that stands in for it
// ---------------------------------------------------------------------------
check('app.json declares a well-formed version (the value under test)', () => ({
  ok: typeof DECLARED === 'string' && /^\d+\.\d+\.\d+$/.test(DECLARED),
  detail: `app.json expo.version=${JSON.stringify(DECLARED)}`,
}));
check('harness: the offline expo-constants stub mirrors app.json instead of carrying its own version', () => {
  let stub = null;
  let err = null;
  try {
    stub = require(path.join(ROOT, 'scripts', 'smoke', 'expo-constants.js'));
  } catch (error) {
    err = error;
  }
  const value = stub && stub.expoConfig ? stub.expoConfig.version : null;
  return {
    ok: value === DECLARED,
    detail: err ? `${err.name}: ${err.message}` : `stub expoConfig.version=${JSON.stringify(value)} app.json=${JSON.stringify(DECLARED)}`,
  };
});

// ---------------------------------------------------------------------------
// H1-H2: the compile step, and DEV MOCK (never a live write from this guard)
// ---------------------------------------------------------------------------
check('harness: the shared compile step rebuilt the compiled lib the dynamic checks run', () => ({
  ok: compileRun.status === 0 && fs.existsSync(path.join(COMPILED, 'analytics.js')),
  detail: `exit=${compileRun.status} stdout=${(compileRun.stdout || '').trim().split('\n').pop()}`,
}));
check('harness: the compiled lib resolves to DEV MOCK, so this guard cannot write to the live project', () => {
  const supabase = require(path.join(COMPILED, 'supabase.js'));
  return {
    ok: supabase.isDevMode === true && !supabase.supabase,
    detail: `isDevMode=${supabase.isDevMode} client=${supabase.supabase ? 'created' : 'null'}`,
  };
});

// ---------------------------------------------------------------------------
// D1-D6: the behaviour — what actually reaches a row
// ---------------------------------------------------------------------------
check("analytics: the app_version reaching an emitted event row EQUALS app.json's declared version", async () => {
  const r = await emittedEventStamp(SHIM_DECLARED);
  return {
    ok: stampMatchesDeclared(r.stamp, DECLARED),
    detail: `rows=${r.rows} app_version=${JSON.stringify(r.stamp)} declared=${JSON.stringify(DECLARED)}`,
  };
});
check('analytics: the stamp FOLLOWS the embedded config (sentinel version propagates — a baked literal cannot pass this)', async () => {
  const r = await emittedEventStamp(SHIM_SENTINEL);
  return {
    ok: stampMatchesDeclared(r.stamp, SENTINEL),
    detail: `expoConfig.version=${SENTINEL} → app_version=${JSON.stringify(r.stamp)}`,
  };
});
check('analytics: with no embedded config at all the module still loads, track() does not throw, and the stamp is not version-shaped', async () => {
  const r = await emittedEventStamp(SHIM_ABSENT);
  return {
    ok: r.rows === 1 && typeof r.stamp === 'string' && r.stamp.length > 0 && !/^\d+\.\d+\.\d+$/.test(r.stamp),
    detail: `rows=${r.rows} app_version=${JSON.stringify(r.stamp)} versionShaped=${/^\d+\.\d+\.\d+$/.test(String(r.stamp))}`,
  };
});
check("push: the dev-mock push_devices row's app_version EQUALS app.json's declared version", async () => {
  const r = await devPushDeviceStamp(SHIM_DECLARED);
  return {
    ok: r.registered === true && r.rows === 1 && stampMatchesDeclared(r.stamp, DECLARED),
    detail: `auth=${r.auth} registered=${r.registered} rows=${r.rows} app_version=${JSON.stringify(r.stamp)} declared=${JSON.stringify(DECLARED)}`,
  };
});
check('push: that same row FOLLOWS the embedded config too (both stamp sites share one derivation)', async () => {
  const r = await devPushDeviceStamp(SHIM_SENTINEL);
  return {
    ok: r.rows === 1 && stampMatchesDeclared(r.stamp, SENTINEL),
    detail: `expoConfig.version=${SENTINEL} → app_version=${JSON.stringify(r.stamp)}`,
  };
});
check('one source of truth: both stamp sites resolve the same single ./appVersion module', () => {
  shimPath = SHIM_DECLARED;
  bustRequireCache();
  appVersionResolutions.clear();
  require(path.join(COMPILED, 'analytics.js'));
  require(path.join(COMPILED, 'pushRegistration.js'));
  const found = [...appVersionResolutions];
  const expected = path.join(COMPILED, 'appVersion.js');
  return {
    ok: found.length === 1 && found[0] === expected,
    detail: `resolutions=${JSON.stringify(found.map((f) => path.relative(ROOT, f)))}`,
  };
});

// ---------------------------------------------------------------------------
// N1-N4: NEGATIVE CONTROLS — the same analysers, forced to fail
// ---------------------------------------------------------------------------
check('negative control: the SAME sweep flags a planted version literal (the analyser has teeth)', () => {
  const hits = sweepVersionLiterals("const VERSION = '2.3.4'; // planted");
  return { ok: hits.length === 1 && hits[0].literal === '2.3.4', detail: JSON.stringify(hits) };
});
check("negative control: the SAME sweep flags the EXACT pre-fix lines from master @ 250ca88", () => {
  // Verbatim from the pre-fix tree (analytics.ts:102, pushRegistration.ts:77 and :94).
  const preFixSource = [
    "const APP_VERSION = '1.1.0';",
    "      app_version: '1.1.0',",
    "        app_version: '1.1.0',",
  ].join('\n');
  const hits = sweepVersionLiterals(preFixSource);
  return {
    ok: hits.length === 3 && hits.every((h) => h.literal === PRE_FIX),
    detail: `hits=${hits.length} literals=${JSON.stringify(hits.map((h) => h.literal))}`,
  };
});
check('negative control: a literal EQUAL to the current declared version is still refused (a correct-but-hardcoded number is the next drift)', () => {
  const hits = sweepVersionLiterals(`const APP_VERSION = '${DECLARED}';`);
  return {
    ok: hits.length === 1 && hits[0].literal === DECLARED,
    detail: `planted=${JSON.stringify(DECLARED)} hits=${hits.length}`,
  };
});
check('negative control: a module stamping a hardcoded version is REJECTED by the same equality assertion (pre-fix source, compiled and driven)', async () => {
  prefixModulePath = prefixAnalyticsModule();
  if (!prefixModulePath) return { ok: false, detail: 'could not reconstruct the pre-fix analytics module from the current source' };
  shimPath = SHIM_DECLARED;
  bustRequireCache();
  const prefixAnalytics = require(prefixModulePath);
  prefixAnalytics.clearDevEventBuffer();
  await prefixAnalytics.track('app_opened');
  const buffer = prefixAnalytics.getDevEventBuffer();
  const stamp = buffer.length ? buffer[buffer.length - 1].app_version : null;
  return {
    ok: stamp === PRE_FIX && !stampMatchesDeclared(stamp, DECLARED),
    detail: `pre-fix module stamps ${JSON.stringify(stamp)} vs declared ${JSON.stringify(DECLARED)} → assertion ${stampMatchesDeclared(stamp, DECLARED) ? 'PASSES (control is toothless)' : 'FAILS (correct)'}`,
  };
});

// ---------------------------------------------------------------------------
// run the table — one line per check, always, even if a check throws
// ---------------------------------------------------------------------------
(async () => {
  try {
    for (const item of checks) {
      let result;
      try {
        result = await item.run();
      } catch (error) {
        result = { ok: false, detail: `${error.name}: ${error.message}` };
      }
      report(item.name, !!result.ok, result.detail);
    }
    if (checks.length !== FIXED_CHECKS) {
      report(`guard emitted its fixed ${FIXED_CHECKS} checks`, false, `emitted ${checks.length}`);
    } else {
      report(`guard emitted its fixed ${FIXED_CHECKS} checks`, true, `${checks.length} checks`);
    }
  } finally {
    for (const file of [prefixModulePath, SHIM_DECLARED, SHIM_SENTINEL, SHIM_ABSENT]) {
      if (file) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* residue here is a temp file, never the product */
        }
      }
    }
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* as above */
    }
  }
  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
