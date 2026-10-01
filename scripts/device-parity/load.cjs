'use strict';
/**
 * Device-parity loader (child process). Loads ONE entry module under the parity
 * environment and prints a machine-readable result line plus human output.
 *
 * Usage:
 *   node scripts/device-parity/load.cjs --entry <abs file> [--dev] [--stub-mode real|smoke]
 *        [--env-file <path>] [--quiet]
 *
 * Exit code: 0 = entry module evaluated cleanly, 1 = it threw, 2 = harness error.
 * One child process per entry == one FRESH module registry per entry, so a throw
 * in one route cannot mask another (and vice versa).
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const { applyParityEnv } = require('./parity-env.cjs');
const { installResolver, EXPLICIT_STUBS } = require('./resolver.cjs');

function parseArgs(argv) {
  const out = { dev: false, stubMode: 'real', quiet: false, envFile: path.join(ROOT, '.env') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entry') out.entry = argv[++i];
    else if (a === '--dev') out.dev = true;
    else if (a === '--stub-mode') out.stubMode = argv[++i];
    else if (a === '--env-file') out.envFile = argv[++i];
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

// Captured BEFORE the parity environment is applied (the app sees a narrower
// process; the harness still needs the real one to exit and print).
const nodeProcess = process;

const args = parseArgs(process.argv.slice(2));
if (!args.entry) {
  console.error('load.cjs: --entry <file> is required');
  nodeProcess.exit(2);
}

const evalStack = [];
const evaluated = [];
const evaluatedSeen = new Set();
const report = {};

// --- parity environment ------------------------------------------------------
const envReport = applyParityEnv({ dev: args.dev, envFile: args.envFile });
// Never echo secret values: report only which names were inlined and their length.
envReport.inlined = Object.fromEntries(
  Object.entries(envReport.inlined).map(([k, v]) => [k, '<len ' + String(v).length + '>']),
);
report.env = envReport;

// --- require hooks: TS/TSX transpile + module-evaluation tracking -------------
const origExtensions = Object.assign({}, Module._extensions);
const origJs = Module._extensions['.js'];

function trackEval(filename, compileFn) {
  if (!evaluatedSeen.has(filename)) {
    evaluatedSeen.add(filename);
    evaluated.push(filename); // evaluation-START order == Metro's require order
  }
  evalStack.push(filename);
  try {
    return compileFn();
  } finally {
    evalStack.pop();
  }
}

function makeTsHandler(compilerOptions) {
  return function tsHandler(module, filename) {
    return trackEval(filename, () => {
      const source = fs.readFileSync(filename, 'utf8');
      const out = ts.transpileModule(source, {
        compilerOptions,
        fileName: filename,
      });
      module._compile(out.outputText, filename);
    });
  };
}

const tsOpts = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true,
  allowJs: true,
};

// EVERY .js/.ts/.tsx file goes through the same TypeScript -> CommonJS transform
// Metro's Babel pass would apply. Without this, Node's own loader treats a file
// with `import` syntax as ESM (and, on Node 22.18+, .ts files via its built-in
// type stripping), which is a different module system than the device runs: ESM
// resolution demands explicit extensions (Metro does not) and rejects Node's
// type-stripping for files under node_modules.
const jsTracked = function jsTracked(module, filename) {
  return trackEval(filename, () => {
    const source = fs.readFileSync(filename, 'utf8');
    const out = ts.transpileModule(source, { compilerOptions: tsOpts, fileName: filename });
    module._compile(out.outputText, filename);
  });
};

// Metro resolves platform extensions BEFORE the generic ones (.ios.js wins over
// .js) and Node tries extensions in Module._extensions key order, so the hook
// table is rebuilt in Metro's preference order for this iOS-only harness.
for (const key of Object.keys(Module._extensions)) delete Module._extensions[key];
Module._extensions['.ios.js'] = jsTracked;
Module._extensions['.native.js'] = jsTracked;
Module._extensions['.js'] = jsTracked;
Module._extensions['.ts'] = makeTsHandler(tsOpts);
Module._extensions['.tsx'] = makeTsHandler(tsOpts);
Module._extensions['.jsx'] = makeTsHandler(tsOpts);
for (const [key, handler] of Object.entries(origExtensions)) {
  if (!Module._extensions[key]) Module._extensions[key] = handler; // .json/.node/...
}

// --- resolution --------------------------------------------------------------
const { record } = installResolver({ stubMode: args.stubMode, passThrough: ['typescript'] });
report.resolution = record;

// --- load --------------------------------------------------------------------
let ok = true;
let failure = null;
const t0 = Date.now();
try {
  require(args.entry);
} catch (e) {
  ok = false;
  const evaluating = evalStack.length ? evalStack[evalStack.length - 1] : '(unknown module)';
  failure = {
    evaluating,
    message: e && e.message ? e.message : String(e),
    name: (e && e.name) || 'Error',
    code: e && e.code,
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 25).join('\n') : null,
    fatalReportedThroughErrorUtils: !!(e && e.__spotterFatalReport),
    tsDiagnostics: null,
  };
  // If the failure is a TypeScript transpile diagnostic, surface it explicitly:
  // a transpile failure is a harness/source problem, not a device-reproduced throw.
  const m = /^(.+\.(ts|tsx|js|jsx)):(\d+):/.exec(failure.message);
  if (m) failure.tsDiagnostics = m[0];
}
const ms = Date.now() - t0;

report.entry = args.entry;
report.dev = args.dev;
report.stubMode = args.stubMode;
report.ok = ok;
report.failure = failure;
report.elapsedMs = ms;
report.evaluatedCount = evaluated.length;
report.evaluated = evaluated.map((f) => path.relative(ROOT, f));

// Native-module requests recorded by the expo-modules-core parity stub.
try {
  const emc = require(EXPLICIT_STUBS['expo-modules-core']);
  report.nativeModuleRequests = emc.__parityReport();
} catch (e) {
  report.nativeModuleRequests = { error: String(e && e.message) };
}

if (!args.quiet) {
  const rel = (f) => (f && f.startsWith(ROOT) ? path.relative(ROOT, f) : f);
  console.log('[parity] entry           : ' + rel(args.entry));
  console.log('[parity] platform/dev    : ios / __DEV__=' + String(args.dev) + ' (release)');
  console.log('[parity] env applied     : ' + envReport.applied.length + ' changes');
  console.log('[parity] modules evaluated: ' + evaluated.length);
  console.log('[parity] stub-mode       : ' + args.stubMode);
  if (record.coreBuiltins.length) {
    console.log('[parity] node core builtins requested (not bundleable in RN):');
    for (const c of record.coreBuiltins) console.log('           ' + c.request + '  <- ' + rel(c.parentFile));
  }
  if (record.realLoadFailure.length) {
    console.log('[parity] real packages that failed to load in Node (fell back to a permissive stub):');
    for (const c of record.realLoadFailure) console.log('           ' + c.request + ': ' + c.message);
  }
  if (record.proxyForUnresolved.length) {
    console.log('[parity] unresolved specifiers (permissive stub):');
    for (const c of record.proxyForUnresolved) console.log('           ' + c.request + '  <- ' + rel(c.parentFile));
  }
  if (record.rnDeep.length) {
    console.log('[parity] deep react-native imports (served by the parity stub):');
    for (const c of record.rnDeep) console.log('           ' + c.request);
  }
  if (report.nativeModuleRequests && report.nativeModuleRequests.requested) {
    console.log('[parity] native modules requested during load: ' +
      report.nativeModuleRequests.requested.map((r) => r.name).join(', '));
  }
  if (envReport.guarded && envReport.guarded.length) {
    console.log('[parity] Hermes-absent APIs CALLED by app-graph code during load:');
    for (const gEntry of envReport.guarded) console.log('           ' + gEntry.what + '  <- ' + gEntry.caller);
  }
  if (!ok) {
    console.log('');
    console.log('################ RESULT: THROW ################');
    console.log('module being evaluated : ' + rel(failure.evaluating));
    console.log('error                  : ' + failure.name + ': ' + failure.message);
    if (failure.tsDiagnostics) console.log('looks like a transpile diagnostic at ' + failure.tsDiagnostics);
    console.log('stack:');
    console.log(failure.stack);
    console.log('##############################################');
  } else {
    console.log('################ RESULT: CLEAN ################');
    console.log('the entry module and its whole real require graph evaluated with no throw');
    console.log('##############################################');
  }
}

console.log('###RESULT### ' + JSON.stringify(report));
nodeProcess.exit(ok ? 0 : 1);
