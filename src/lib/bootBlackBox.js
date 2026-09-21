/**
 * SPOTTER boot black box — DIAGNOSTIC BUILD ONLY (build 20, branch diag/boot-error-black-box).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * Builds 16, 17 and 18 all abort 0.24-0.33 s after launch on a real iPhone. Apple's
 * TestFlight crash logs (builds 16/17, plus the owner's build-18 paste) all end in the
 * same release-mode React Native fatal path for an UNCAUGHT JAVASCRIPT ERROR:
 *
 *   native handleJSError(jsError, isFatal = true)          ReactCommon/cxxreact/ErrorUtils.h
 *     -> global ErrorUtils.reportFatalError(err)           @react-native/js-polyfills/error-guard.js
 *        -> the ErrorUtils *global handler*                <=== THIS MODULE REPLACES IT
 *           -> ExceptionsManager.handleException(err, true) react-native/Libraries/Core/ExceptionsManager.js
 *              -> reportException -> NativeExceptionsManager.reportException(...)
 *                 -> -[RCTExceptionsManager reportFatal:] -> RCTFatal -> SIGABRT
 *
 * So the JavaScript does start, something throws during bundle evaluation, and React
 * Native kills the process. The error TEXT is not in the crash report — the app has to
 * tell us. This module captures the uncaught error, keeps the process alive and prints
 * the message on screen.
 *
 * ---------------------------------------------------------------------------
 * REMOVAL (must happen before App Review)
 *   delete src/lib/bootBlackBox.js and index.js; set package.json "main" back to
 *   "expo-router/entry". Nothing else in the app imports this file.
 *
 * ---------------------------------------------------------------------------
 * HARD RULES (this code runs before every other module, so it cannot itself fail):
 *  - ZERO top-level require/import. react-native and AsyncStorage are required LAZILY,
 *    inside try/catch, only while reporting an error. A missing native module must never
 *    be able to kill the black box.
 *  - Never write to a React Native read-only global. RN defines its RN$* globals with
 *    Object.defineProperty(global, name, {value}) — i.e. writable:false, configurable:false
 *    (ReactCommon/react/utils/jsi-utils.cpp) — so a strict-mode assignment to one throws a
 *    TypeError. That is a real defect we found while writing this file: build 18 shipped
 *    `g.RN$handleException = ...` unguarded at src/lib/diagnostics.ts:156, evaluated at
 *    src/app/_layout.tsx module scope. Here we only PROBE such globals and record the
 *    result (see probeReadOnlyGlobal) — never assign.
 *  - Every step is try/caught: a failing Alert or AsyncStorage write must never take the
 *    process down, because the whole point of this build is to stay alive.
 */

/**
 * DIAGNOSTIC BUILD ONLY — must be false, or this module deleted, before App Review.
 * true  = capture the uncaught JS error, DO NOT re-invoke the previous handler, so the
 *         process survives long enough to show the message on screen.
 * false = stock React Native behaviour (previous handler runs -> fatal abort).
 */
var SWALLOW_BOOT_ERRORS = true;

var STORAGE_KEY = '@spotter/boot_error';
var STORAGE_CAP = 20;
var ALERT_TITLE = 'SPOTTER boot error';
var ALERT_LIMIT = 3; // never stack an endless queue of modal alerts
var STACK_LINES = 14;

var state = {
  phase: 'blackbox-module-loaded',
  installed: false,
  alertsShown: 0,
  errors: [],
  lastError: null,
  probes: {},
  handlers: {},
};

/** The value every screen/console reads. Kept on the global so it survives module churn. */
try {
  globalThis.__spotterBoot = state;
} catch (e) {
  /* nothing we can do, and nothing that should stop boot */
}

function safeString(value) {
  try {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    return String(value);
  } catch (e) {
    return '[unprintable ' + typeof value + ']';
  }
}

/** Turn anything thrown (Error, string, native-ish object) into flat reportable fields. */
function normaliseError(error) {
  var name = 'Error';
  var message = '';
  var stack = '';
  try {
    if (error && typeof error === 'object') {
      name = safeString(error.name || (error.constructor && error.constructor.name) || 'Error');
      message = safeString(error.message);
      stack = safeString(error.stack);
    } else {
      message = safeString(error);
    }
  } catch (e) {
    message = message || '[failed to read the thrown error]';
  }
  // Some native errors expose message only through the prototype getter; try once more.
  if (!message) {
    try {
      message = safeString(Object.prototype.toString.call(error));
    } catch (e) {
      message = '(no message)';
    }
  }
  return { name: name, message: message, stack: stack };
}

/** Readable stack: drop the noise, keep the first frames, hard-cap the length. */
function formatStack(stack) {
  if (!stack) return '(no stack)';
  var lines = String(stack).split('\n');
  var kept = lines.slice(0, STACK_LINES).map(function (line) {
    return line.replace(/\s+$/, '').replace(/^\s{4,}/, '  ');
  });
  if (lines.length > STACK_LINES) kept.push('  ... +' + (lines.length - STACK_LINES) + ' more frames');
  return kept.join('\n');
}

/**
 * React Native defines its RN$* globals via Object.defineProperty(global, name, {value})
 * (ReactCommon/react/utils/jsi-utils.cpp), which makes them non-writable AND
 * non-configurable. Strict-mode assignment to one throws. This only inspects.
 */
function probeReadOnlyGlobal(name) {
  try {
    var descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor) {
      state.probes[name] = 'absent';
      return 'absent';
    }
    var summary =
      'value=' +
      typeof descriptor.value +
      ' writable=' +
      String(descriptor.writable) +
      ' configurable=' +
      String(descriptor.configurable);
    state.probes[name] = summary;
    return summary;
  } catch (e) {
    state.probes[name] = 'probe-failed';
    return 'probe-failed';
  }
}

/** Called from the root entry between boot steps, so a thrown error carries its phase. */
function setBootPhase(phase) {
  try {
    state.phase = String(phase);
  } catch (e) {
    /* ignore */
  }
  return state.phase;
}

function buildEntry(error, isFatal, source) {
  var flat = normaliseError(error);
  var entry = {
    name: flat.name,
    message: flat.message,
    stack: flat.stack,
    isFatal: !!isFatal,
    source: safeString(source || 'global-handler'),
    phase: state.phase,
    timestamp: new Date().toISOString(),
  };
  return entry;
}

function rememberEntry(entry) {
  try {
    state.lastError = entry;
    state.errors.push(entry);
    if (state.errors.length > STORAGE_CAP) {
      state.errors.splice(0, state.errors.length - STORAGE_CAP);
    }
  } catch (e) {
    /* ignore */
  }
  return entry;
}

/** (b) best-effort persistence to AsyncStorage — capped list, key @spotter/boot_error. */
function persistEntries() {
  return new Promise(function (resolve) {
    var AsyncStorage;
    try {
      AsyncStorage = require('@react-native-async-storage/async-storage');
      AsyncStorage = AsyncStorage && (AsyncStorage.default || AsyncStorage);
    } catch (e) {
      return resolve('unavailable');
    }
    if (!AsyncStorage || typeof AsyncStorage.getItem !== 'function') return resolve('unavailable');
    var payload = JSON.stringify(state.errors.slice(-STORAGE_CAP));
    try {
      AsyncStorage.getItem(STORAGE_KEY)
        .then(function (existing) {
          var list = [];
          try {
            list = existing ? JSON.parse(existing) : [];
            if (!Array.isArray(list)) list = [];
          } catch (e) {
            list = [];
          }
          list = list.concat(state.errors);
          if (list.length > STORAGE_CAP) list = list.slice(list.length - STORAGE_CAP);
          return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        })
        .then(function () {
          resolve('ok');
        })
        .catch(function () {
          // Falling back to the pre-read snapshot keeps the last error on disk even if
          // the read half of the read-modify-write failed.
          try {
            AsyncStorage.setItem(STORAGE_KEY, payload).then(
              function () {
                resolve('ok-partial');
              },
              function () {
                resolve('failed');
              }
            );
          } catch (e) {
            resolve('failed');
          }
        });
    } catch (e) {
      resolve('failed');
    }
  });
}

function alertBody(entry, persistedNote) {
  var lines = [];
  lines.push('phase: ' + entry.phase);
  lines.push(entry.name + ': ' + entry.message);
  lines.push('');
  lines.push('isFatal: ' + String(entry.isFatal) + '   source: ' + entry.source);
  lines.push('at ' + entry.timestamp + '   (build 20, diagnostic)');
  lines.push('');
  lines.push('stack:');
  lines.push(formatStack(entry.stack));
  lines.push('');
  lines.push('[probe] RN$handleException ' + (state.probes['RN$handleException'] || 'not-probed'));
  lines.push('[probe] ErrorUtils global handler wrapped: ' + String(state.handlers.errorUtils === true));
  lines.push('[persist] ' + persistedNote);
  var body = lines.join('\n');
  return body.length > 2200 ? body.slice(0, 2200) + '\n…(truncated)' : body;
}

/** (d) show it on screen — inside try/catch so a failing Alert cannot kill the process. */
function showAlert(entry, persistedNote) {
  if (state.alertsShown >= ALERT_LIMIT) return false;
  state.alertsShown += 1;
  try {
    var RN = require('react-native');
    var Alert = RN && RN.Alert;
    if (!Alert || typeof Alert.alert !== 'function') {
      // Last resort: still leave something readable in the device console.
      try {
        console.error(ALERT_TITLE, alertBody(entry, persistedNote));
      } catch (e) {
        /* ignore */
      }
      return false;
    }
    Alert.alert(ALERT_TITLE, alertBody(entry, persistedNote), [{ text: 'OK' }], {
      cancelable: false,
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Capture + report one error through every channel available:
 *   (a) keep it on the global (state.lastError / state.errors)
 *   (b) persist the capped list to AsyncStorage
 *   (c) best-effort console.error
 *   (d) show it with Alert.alert('SPOTTER boot error', ...)
 * Returns the entry so callers can log/quote it.
 */
function reportError(error, isFatal, source) {
  var entry = rememberEntry(buildEntry(error, isFatal, source));
  return persistEntries().then(function (persisted) {
    try {
      console.error(
        '[spotter-blackbox] phase=' +
          entry.phase +
          ' name=' +
          entry.name +
          ' message=' +
          entry.message +
          ' isFatal=' +
          String(entry.isFatal) +
          ' source=' +
          entry.source
      );
      console.error('[spotter-blackbox] stack=\n' + formatStack(entry.stack));
    } catch (e) {
      /* (c) is best-effort */
    }
    showAlert(entry, persisted);
    return entry;
  });
}

/** Public entry for a synchronous throw caught around the router require in index.js. */
function reportBootThrow(error, source) {
  try {
    reportError(error, true, source);
  } catch (e) {
    /* never let reporting throw */
  }
  return state.lastError;
}

/**
 * (1) Install-first boot module. Wraps ErrorUtils.setGlobalHandler, keeping a reference to
 * the previous handler. On an uncaught error we capture it and — while SWALLOW_BOOT_ERRORS
 * is true — we deliberately DO NOT re-invoke the previous handler, because doing so is
 * exactly what runs ExceptionsManager.handleException -> reportFatal -> RCTFatal -> SIGABRT.
 * Idempotent; safe to call twice (the module scope already calls it, index.js calls it again).
 */
function installBootBlackBox() {
  if (state.installed) return state;
  state.installed = true;
  setBootPhase('blackbox-installed');
  try {
    var ErrorUtils = globalThis.ErrorUtils;
    if (ErrorUtils && typeof ErrorUtils.setGlobalHandler === 'function') {
      var previousHandler = null;
      try {
        previousHandler =
          typeof ErrorUtils.getGlobalHandler === 'function' ? ErrorUtils.getGlobalHandler() : null;
      } catch (e) {
        previousHandler = null;
      }
      ErrorUtils.setGlobalHandler(function bootBlackBoxHandler(error, isFatal) {
        try {
          reportError(error, isFatal, 'errorutils-global-handler');
        } catch (e) {
          /* never let reporting throw */
        }
        if (!SWALLOW_BOOT_ERRORS) {
          try {
            if (typeof previousHandler === 'function') previousHandler(error, isFatal);
          } catch (e) {
            /* keep the original best-effort behaviour */
          }
        }
      });
      state.handlers.errorUtils = true;
    }
  } catch (e) {
    state.handlers.errorUtils = false;
  }
  // Diagnostic facts that make the alert self-explaining even before the message is read.
  probeReadOnlyGlobal('RN$handleException');
  probeReadOnlyGlobal('RN$Bridgeless');
  try {
    state.probes['RN$useAlwaysAvailableJSErrorHandling'] = safeString(
      globalThis.RN$useAlwaysAvailableJSErrorHandling
    );
  } catch (e) {
    /* ignore */
  }
  return state;
}

module.exports = {
  SWALLOW_BOOT_ERRORS: SWALLOW_BOOT_ERRORS,
  ALERT_TITLE: ALERT_TITLE,
  STORAGE_KEY: STORAGE_KEY,
  state: state,
  installBootBlackBox: installBootBlackBox,
  setBootPhase: setBootPhase,
  reportBootThrow: reportBootThrow,
  reportError: reportError,
  formatStack: formatStack,
};

// Side-effect install: merely requiring this module arms the black box, so the install
// happens at this module's scope — before index.js evaluates anything else.
try {
  installBootBlackBox();
} catch (e) {
  /* the require that pulled us in must still succeed */
}
