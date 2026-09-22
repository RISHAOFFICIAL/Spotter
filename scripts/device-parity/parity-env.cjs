'use strict';
/**
 * Device-parity global environment.
 *
 * Applies the differences between "Node 22 running our TS sources" (what the old
 * smoke harness did) and "Hermes 0.86 + React Native 0.86 InitializeCore + Expo
 * winter runtime, release build, iOS" (what the phone does).
 *
 * Every KEEP/DELETE decision below carries the file+line evidence it was derived
 * from; the same table is printed by `node scripts/device-parity/run.cjs --list`.
 * The evidence is RN's own polyfill chain
 * (react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js ->
 * Libraries/Core/setUp*.js) and Expo's winter runtime
 * (expo/src/winter/index.ts + runtime.native.ts) -- NOT memory.
 *
 * NOTE ON CONFIDENCE: `medium` items are engine-level APIs that no RN/Expo
 * polyfill installs; Node has them for free, Hermes is not known here to have
 * them (the shipped hermesvm.framework binary contains no such builtin name).
 * If a finding involves a medium-confidence deletion the report says so, because
 * a wrongly deleted global can produce a finding that is not real on device.
 */

const fs = require('fs');
const path = require('path');

const INSTALLED_BY_RN =
  'react-native/Libraries/Core/setUp*.js via src/private/setup/setUpDefaultReactNativeEnvironment.js';
const INSTALLED_BY_EXPO = 'expo/src/winter/runtime.native.ts (installed by expo before the app entry)';

/** decision table: [name, decision, confidence, evidence] */
const DECISIONS = [
  // --- provided on device, so the harness must keep/provide them ------------
  ['Platform', 'keep', 'high', 'provided by the react-native iOS stub (Platform.ios.js shape)'],
  ['__DEV__', 'set false', 'high', 'release build: Metro replaces __DEV__ with false'],
  ['structuredClone', 'keep', 'high', INSTALLED_BY_EXPO + ': install("structuredClone", @ungap/structured-clone)'],
  ['URL', 'keep', 'high', INSTALLED_BY_EXPO + ' install("URL", ./url)'],
  ['URLSearchParams', 'keep', 'high', INSTALLED_BY_EXPO + ' install("URLSearchParams", ./url)'],
  ['TextDecoder', 'keep', 'high', INSTALLED_BY_EXPO + ' install("TextDecoder", ./TextDecoder)'],
  ['DOMException', 'keep', 'high', INSTALLED_BY_EXPO + ' install("DOMException", ./DOMException)'],
  ['fetch', 'keep', 'high', INSTALLED_BY_EXPO + ' install("fetch", ./fetch) + RN fetch polyfill'],
  ['Headers/Request/Response', 'keep', 'high', INSTALLED_BY_EXPO + ' expects globalThis.Headers from the RN fetch polyfill'],
  ['FormData', 'keep', 'high', INSTALLED_BY_EXPO + ' installFormDataPatch(FormData)'],
  ['AbortController/AbortSignal', 'keep', 'high', INSTALLED_BY_EXPO + ' installAbortSignalPatch(AbortSignal) + RN setUpXHR'],
  ['ReadableStream', 'keep', 'high', INSTALLED_BY_EXPO + ' comment: "ReadableStream is injected by Metro as a global"'],
  ['queueMicrotask', 'keep', 'high', 'RN setUpTimers.js:46 polyfillGlobal(queueMicrotask, NativeMicrotasks) (bridgeless)'],
  ['setImmediate/clearImmediate', 'keep', 'high', 'RN setUpTimers.js:55 immediateShim (bridgeless)'],
  ['requestIdleCallback/cancelIdleCallback', 'keep', 'high', 'RN setUpTimers.js:64 NativeIdleCallbacks (bridgeless)'],
  ['setTimeout/setInterval/clearTimeout/clearInterval', 'keep', 'high', 'RN setUpTimers.js (bridgeless: host timers)'],
  ['console', 'keep', 'high', '@react-native/js-polyfills/console'],
  ['process', 'replace (RN shape)', 'high', 'RN setUpGlobals.js:30 global.process = global.process || {}; .env = {} — Node process has argv/version etc. the device does not'],
  ['global.window/global.self', 'add', 'high', 'RN setUpGlobals.js:18-25 window = self = global'],
  ['navigator', 'replace', 'high', 'RN setUpNavigator.js:18 navigator = {product: "ReactNative"} — Node exposes a full userAgent navigator'],
  ['performance', 'keep', 'high', 'RN setUpPerformance.js'],
  ['WebSocket', 'keep', 'high', 'react-native/Libraries/WebSocket (RN global)'],
  ['Intl', 'keep', 'medium', 'Hermes on iOS ships Intl; the shipped hermesvm.framework binary contains Intl.* strings'],
  ['ErrorUtils', 'add', 'high', 'RN setUpErrorHandling.js installs global.ErrorUtils (used by src/lib/diagnostics.ts)'],
  ['__turboModuleProxy', 'add', 'high', 'bridgeless TurboModule host function (RN TurboModuleRegistry path)'],

  // --- NOT provided on device: the harness must remove Node's free copy -----
  ['Buffer', 'delete', 'high', 'Node-only API; Hermes has no Buffer. src/lib has its own guarded shim'],
  ['crypto', 'delete', 'medium', 'no RN/Expo install of a global crypto; expo-crypto is a native module. Node exposes WebCrypto'],
  ['crypto.getRandomValues', 'delete', 'medium', 'arrives with the Node crypto global above'],
  ['atob', 'delete', 'medium', 'no RN/Expo global install found (grep of Libraries/Core/setUp*.js and expo/src/winter)'],
  ['btoa', 'delete', 'medium', 'no RN/Expo global install found (grep of Libraries/Core/setUp*.js and expo/src/winter)'],
  ['TextEncoder', 'delete', 'medium', 'expo winter installs TextEncoderStream only; nothing installs a global TextEncoder (its own stream impl does `new TextEncoder()`)'],
  ['TextEncoderStream', 'delete', 'low', 'expo winter DOES install this; deleted only because its impl needs TransformStream/streams the harness lacks. FLAGGED: a finding touching this is suspect'],
  ['MessageChannel', 'delete', 'high', 'Node-only; no RN/Expo polyfill'],
  ['MessagePort', 'delete', 'high', 'Node-only; no RN/Expo polyfill'],
  ['BroadcastChannel', 'delete', 'high', 'Node-only; no RN/Expo polyfill'],
  ['Array.prototype.toSorted', 'delete', 'medium', 'ES2023; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Array.prototype.toReversed', 'delete', 'medium', 'ES2023; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Array.prototype.toSpliced', 'delete', 'medium', 'ES2023; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Array.prototype.with', 'delete', 'medium', 'ES2023; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Object.groupBy', 'delete', 'medium', 'ES2024; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Map.groupBy', 'delete', 'medium', 'ES2024; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['Promise.withResolvers', 'delete', 'medium', 'ES2024; no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['WeakRef', 'delete', 'medium', 'no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['FinalizationRegistry', 'delete', 'medium', 'no RN/Expo polyfill; name absent from the shipped hermesvm binary'],
  ['process.nextTick', 'keep-real-object', 'medium', 'RN setUpGlobals.js gives process = {} with only .env; the harness keeps the real process object (its own runtime needs it) and narrows process.env instead — see the note in applyParityEnv'],
];

function readEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function deletePath(globalObj, dotted) {
  const parts = dotted.split('.');
  let obj = globalObj;
  for (const p of parts.slice(0, -1)) {
    obj = obj[p];
    if (obj === null || obj === undefined) return false;
  }
  const last = parts[parts.length - 1];
  try {
    delete obj[last];
    return !(last in obj);
  } catch (e) {
    return false;
  }
}

/**
 * Hermes-absent PROTOTYPE methods cannot simply be deleted: Node's own runtime
 * needs some of them (deleting Array.prototype.toSorted makes Node's internal
 * `node:http` fail to compile with "methods.toSorted is not a function"). So they
 * are replaced by a guard that throws ONLY for callers inside the app graph
 * (src/**, node_modules) and delegates to Node's original for the harness's own
 * code and Node internals. That keeps the device-parity check without breaking
 * the harness.
 */
function guardPrototype(dotted, record) {
  const parts = dotted.split('.');
  let obj = globalThis;
  for (const p of parts.slice(0, -1)) {
    obj = obj[p];
    if (obj === null || obj === undefined) return false;
  }
  const last = parts[parts.length - 1];
  const holder = obj;
  const orig = holder[last];
  if (typeof orig !== 'function') return false;
  holder[last] = function guardedDeviceParity() {
    const stack = String(new Error().stack || '').split('\n');
    const caller = stack[1] || '';
    const harnessCaller =
      caller.includes('device-parity') ||
      caller.includes('node:internal') ||
      caller.includes('node:') ||
      caller.includes('/node_modules/typescript/') ||
      caller.includes('/node_modules/tslib/');
    if (harnessCaller) return orig.apply(this, arguments);
    record.push({ what: dotted, caller: caller.trim() });
    throw new TypeError(
      dotted +
        ' is not a function: device parity — Hermes 0.86/RN 0.86 provide no polyfill for it ' +
        '(see scripts/device-parity/README.md)',
    );
  };
  return true;
}

function installErrorUtils(record) {
  const g = globalThis;
  if (g.ErrorUtils && g.ErrorUtils.__parity) return;
  const defaultHandler = (e) => {
    throw e instanceof Error ? e : new Error(String(e));
  };
  let handler = defaultHandler;
  g.ErrorUtils = {
    __parity: true,
    setGlobalHandler(f) {
      handler = f;
    },
    getGlobalHandler() {
      return handler;
    },
    reportError(e, isFatal) {
      record.push({ what: 'ErrorUtils.reportError', isFatal: !!isFatal });
      return handler(e, isFatal);
    },
    // The device aborts the process here (RN$handleException -> RCTFatal). In the
    // harness we throw instead, so a fatal that reaches this point becomes a
    // reportable finding rather than an invisible abort.
    reportFatalError(e) {
      record.push({ what: 'ErrorUtils.reportFatalError', isFatal: true });
      const err = new Error(
        'FATAL reported through ErrorUtils.reportFatalError (device would abort here): ' +
          (e && e.message ? e.message : String(e)),
      );
      err.cause = e;
      err.__spotterFatalReport = true;
      throw err;
    },
    applyWithGuard(fn, context, args) {
      try {
        return fn.apply(context, args);
      } catch (e) {
        return handler(e, false);
      }
    },
    guard(fn) {
      return function () {
        return g.ErrorUtils.applyWithGuard(fn, this, arguments);
      };
    },
  };
}

function applyParityEnv(opts) {
  const o = opts || {};
  const applied = [];
  const skipped = [];
  const envFileVars = readEnvFile(o.envFile);
  const g = globalThis;

  g.__DEV__ = o.dev === true;
  applied.push('__DEV__ = ' + String(g.__DEV__));

  // Metro inlines EXPO_PUBLIC_* / EXPO_OS / NODE_ENV into the release bundle at
  // build time; the harness reads the same .env the release build was cut with and
  // presents a minimal env, like RN's `process = {}` (setUpGlobals.js:30).
  // The real process OBJECT is kept (harness runtime needs argv/execPath); its
  // env is narrowed to what the device would see. Documented fidelity gap: Node's
  // process.version/versions/argv/nextTick remain visible, so code that sniffs
  // "am I on Node?" sees a Node-ish process. Reported by run.cjs.
  const inlinedEnv = Object.assign({}, envFileVars);
  inlinedEnv.NODE_ENV = 'production';
  inlinedEnv.EXPO_OS = 'ios';
  process.env = Object.assign({}, inlinedEnv);
  applied.push('process.env narrowed to <' + Object.keys(inlinedEnv).join(',') + '>');

  g.window = g;
  g.self = g;
  applied.push('window = self = globalThis');
  // Node 22 exposes `navigator` as a getter-only accessor: redefine it.
  Object.defineProperty(g, 'navigator', {
    value: { product: 'ReactNative' },
    configurable: true,
    writable: true,
    enumerable: false,
  });
  applied.push("navigator = {product:'ReactNative'}");

  // Expo SDK 54+/RN 0.86 new architecture: bridgeless is on for this app
  // (Expo SDK 55+ ships new-architecture-only), which is what makes RN install
  // queueMicrotask / setImmediate / requestIdleCallback.
  g.RN$Bridgeless = true;
  g.RN$enableMicrotasksInReact = true;
  applied.push('RN$Bridgeless = true, RN$enableMicrotasksInReact = true');

  installErrorUtils(applied);
  applied.push('ErrorUtils installed (RN shape; reportFatalError throws instead of aborting)');

  g.__turboModuleProxy = (name) => {
    const rn = require('./stubs/react-native.js');
    return rn.TurboModuleRegistry.get(name);
  };
  applied.push('__turboModuleProxy installed (delegates to the parity TurboModuleRegistry)');

  const guarded = [];
  for (const [name, decision, confidence] of DECISIONS) {
    if (!decision.startsWith('delete')) continue;
    if (name.includes('.') && !name.startsWith('process.')) {
      // prototype/static member: guard instead of deleting (see guardPrototype)
      if (guardPrototype(name, guarded)) {
        applied.push('guarded ' + name + ' (throws only for app-graph callers; ' + confidence + ' confidence)');
      } else {
        skipped.push({ name, why: 'not present' });
      }
      continue;
    }
    const ok = deletePath(g, name);
    if (ok) applied.push('deleted ' + name + ' (' + confidence + ' confidence)');
    else skipped.push({ name, why: 'already absent' });
  }
  return { applied, skipped, guarded, decisions: DECISIONS, envFile: o.envFile, inlined: inlinedEnv };
}

module.exports = { applyParityEnv, DECISIONS };
