/**
 * SPOTTER boot black box — DIAGNOSTIC BUILD ONLY (builds 20-21, branch diag/boot-error-black-box).
 *
 * BUILD 21 ADDITIONS (all three make ONE install reveal more layers):
 *  - every captured error is shown: alerts are chained (each new error queues its own alert,
 *    the queue drains when the owner taps OK) and every body carries the full captured list;
 *  - if `require('expo-router/entry')` throws, renderFallbackApp() registers a bare
 *    react-native root view listing every captured error, so we do not depend on Alert timing;
 *  - the first error is also appended to the first-party `app_diagnostics` table over a raw
 *    fetch (insert-only RLS), so the error text is readable from our side instead of only on
 *    the owner's screen.
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
var ALERT_LIMIT = 6; // never stack an endless queue of modal alerts
var ALERT_BODY_MAX = 3000; // the all-errors list sits above the stack, so truncation is safe
var ALERT_STALL_MS = 60000; // if an alert can never be presented, unblock the queue
var STACK_LINES = 14;
var POST_TIMEOUT_MS = 4000;

var state = {
  phase: 'blackbox-module-loaded',
  installed: false,
  alertsShown: 0,
  alertsQueued: 0,
  errors: [],
  lastError: null,
  probes: {},
  handlers: {},
  diagnosticPost: 'not-attempted',
  fallback: null,
  fallbackRegistered: false,
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

/** Hard-cap any string we are about to put in an alert or send over the wire. */
function truncate(value, max) {
  var s = safeString(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + '…(+' + (s.length - max) + ' chars)';
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

/**
 * Body for one alert. `index` is the 1-based ordinal of the alert being shown.
 *
 * The ALL-ERRORS list comes BEFORE the (long, truncatable) stack on purpose: several errors
 * can be captured during one boot, the body is capped, and the owner may only ever read this
 * once — so the list of every error must survive truncation.
 */
function alertBody(entry, persistedNote, index) {
  var total = state.errors.length;
  var lines = [];
  lines.push('alert ' + index + ' of ' + total + ' captured error(s)');
  lines.push('phase: ' + entry.phase);
  lines.push(entry.name + ': ' + truncate(entry.message, 600));
  lines.push('isFatal: ' + String(entry.isFatal) + '   source: ' + entry.source);
  lines.push('at ' + entry.timestamp + '   (build 21, diagnostic)');
  lines.push('');
  lines.push('--- ALL ' + total + ' captured error(s) ---');
  for (var i = 0; i < total; i++) {
    var e = state.errors[i];
    lines.push(
      i + 1 + '. [' + e.phase + '] ' + e.name + ': ' + truncate(e.message, 150),
    );
  }
  lines.push('--- stack of this error ---');
  lines.push(formatStack(entry.stack));
  lines.push('');
  lines.push('[probe] RN$handleException ' + (state.probes['RN$handleException'] || 'not-probed'));
  lines.push('[probe] ErrorUtils global handler wrapped: ' + String(state.handlers.errorUtils === true));
  lines.push('[persist] ' + persistedNote);
  lines.push('[report] ' + state.diagnosticPost);
  var body = lines.join('\n');
  return body.length > ALERT_BODY_MAX ? body.slice(0, ALERT_BODY_MAX) + '\n…(truncated)' : body;
}

/**
 * (d) Show it on screen — ALERTS ARE CHAINED. Each captured error queues its own alert and the
 * queue drains when the owner taps OK (or when an alert's onDismiss fires), so seeing error #2
 * does not depend on error #1's timing. Every body also lists all captured errors, so a single
 * alert is already a complete report. Everything is inside try/catch: a failing Alert can never
 * kill the process, and a queue that never gets a callback is released on a timer.
 */
var alertQueue = [];
var alertBusy = false;

function enqueueAlert(entry, persistedNote) {
  try {
    if (state.alertsQueued >= ALERT_LIMIT) return false;
    state.alertsQueued += 1;
    alertQueue.push({ entry: entry, note: persistedNote });
    return drainAlertQueue();
  } catch (e) {
    return false;
  }
}

function drainAlertQueue() {
  if (alertBusy) return false;
  var item;
  try {
    item = alertQueue.shift();
  } catch (e) {
    return false;
  }
  if (!item) return false;
  alertBusy = true;
  var index = state.alertsShown + 1;
  var released = false;
  var release = function release() {
    if (released) return;
    released = true;
    alertBusy = false;
    state.alertsShown = index;
    // Let the current alert finish dismissing before the next one is presented.
    try {
      setTimeout(function () {
        drainAlertQueue();
      }, 250);
    } catch (e) {
      /* if timers are gone, the queue simply stops draining — the list is in every body */
    }
  };
  try {
    var RN = require('react-native');
    var Alert = RN && RN.Alert;
    var body = alertBody(item.entry, item.note, index);
    if (!Alert || typeof Alert.alert !== 'function') {
      try {
        console.error(ALERT_TITLE, body);
      } catch (e) {
        /* ignore */
      }
      release();
      return false;
    }
    Alert.alert(ALERT_TITLE, body, [{ text: 'OK', onPress: release }], {
      cancelable: false,
      onDismiss: release,
    });
    // Some boot failures abort the UI before an alert can be presented, in which case neither
    // callback ever fires. Release the queue anyway so a later error still reaches the screen.
    setTimeout(release, ALERT_STALL_MS);
    return true;
  } catch (e) {
    release();
    return false;
  }
}

/**
 * BEST-EFFORT SERVER-SIDE CHANNEL (build 21 measurement improvement).
 *
 * The alert is only readable by the person holding the phone, and the AsyncStorage list is
 * unreadable from our side, so we also append the captured error to the existing first-party
 * `app_diagnostics` table (insert-only RLS for anon+authenticated —
 * supabase/migrations/2026-09-19-app-diagnostics.sql, policy also in supabase/schema.sql).
 *
 * A raw `fetch` is deliberate: requiring supabase-js (or any app module) from the black box
 * would re-enter the very module graph that is allowed to be broken. The EXPO_PUBLIC_* values
 * are inlined as string literals at build time by babel-preset-expo
 * (node_modules/babel-preset-expo/build/configs/expo.js:47 -> plugins/inline-env-vars.js),
 * so `process.env.X` below becomes a literal in the release bundle; if it ever is not inlined,
 * the ReferenceError is caught and the channel simply reports 'no-config'.
 * No PII: the error text, the phase, the build number and a timestamp.
 */
function readSupabaseConfig() {
  try {
    var url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    var key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return null;
    return { url: safeString(url).replace(/\/+$/, ''), key: safeString(key) };
  } catch (e) {
    return null;
  }
}

function readAppVersion() {
  try {
    var Constants = require('expo-constants');
    Constants = Constants && (Constants.default || Constants);
    var cfg = Constants && Constants.expoConfig;
    if (cfg && cfg.version) return safeString(cfg.version);
  } catch (e) {
    /* expo-constants is a convenience here, never a requirement */
  }
  return 'unknown';
}

/** Fire-and-forget append of one captured error; never throws, never blocks boot. */
function postDiagnostics(entry) {
  try {
    var cfg = readSupabaseConfig();
    if (!cfg) {
      state.diagnosticPost = 'no-config';
      return state.diagnosticPost;
    }
    if (typeof fetch !== 'function') {
      state.diagnosticPost = 'no-fetch';
      return state.diagnosticPost;
    }
    var all = [];
    for (var i = 0; i < state.errors.length; i++) {
      all.push('[' + state.errors[i].phase + '] ' + truncate(state.errors[i].message, 200));
    }
    var payload = [
      {
        message:
          '[boot-blackbox] ' +
          entry.name +
          ': ' +
          truncate(entry.message, 900) +
          ' | phase=' +
          entry.phase +
          ' | source=' +
          entry.source +
          ' | captured=' +
          state.errors.length +
          (all.length > 1 ? ' | all=' + truncate(all.join(' || '), 1500) : ''),
        stack: truncate(entry.stack || '', 4000) || null,
        app_version: readAppVersion(),
        build_number: '21',
        ts: entry.timestamp,
      },
    ];
    var controller = null;
    try {
      controller = typeof AbortController === 'function' ? new AbortController() : null;
    } catch (e) {
      controller = null;
    }
    if (controller) {
      try {
        setTimeout(function () {
          try {
            controller.abort();
          } catch (e) {
            /* ignore */
          }
        }, POST_TIMEOUT_MS);
      } catch (e) {
        /* ignore */
      }
    }
    var request = fetch(cfg.url + '/rest/v1/app_diagnostics', {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: 'Bearer ' + cfg.key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    state.diagnosticPost = 'sent';
    if (request && typeof request.then === 'function') {
      request.then(
        function (response) {
          state.diagnosticPost = 'http ' + (response && response.status);
        },
        function (error) {
          state.diagnosticPost = 'failed: ' + truncate((error && error.message) || error, 80);
        },
      );
    }
  } catch (e) {
    state.diagnosticPost = 'threw: ' + truncate((e && e.message) || e, 80);
  }
  return state.diagnosticPost;
}

/**
 * Capture + report one error through every channel available:
 *   (a) keep it on the global (state.lastError / state.errors)
 *   (b) persist the capped list to AsyncStorage
 *   (c) best-effort console.error
 *   (d) show it with Alert.alert('SPOTTER boot error', ...) — chained, one alert per error
 *   (e) best-effort append to app_diagnostics so the text is readable off-device
 * Returns the entry so callers can log/quote it.
 */
function reportError(error, isFatal, source) {
  var entry = rememberEntry(buildEntry(error, isFatal, source));
  try {
    postDiagnostics(entry);
  } catch (e) {
    /* the server-side channel must never affect boot */
  }
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
    enqueueAlert(entry, persisted);
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

/** One readable block per captured error, used by the fallback view and the console dump. */
function describeAll() {
  var lines = [];
  var entries = state.errors || [];
  lines.push('phase=' + state.phase + '  captured=' + entries.length);
  for (var i = 0; i < entries.length; i++) {
    lines.push(
      i + 1 + '. [' + entries[i].phase + '] ' + entries[i].name + ': ' + entries[i].message
    );
    lines.push(formatStack(entries[i].stack));
  }
  if (!entries.length) lines.push('(no error captured, but the router never loaded)');
  return lines.join('\n');
}

/**
 * MINIMAL FALLBACK VIEW (build 21).
 *
 * If `require('expo-router/entry')` throws, React never mounts and NO screen renders — so an
 * Alert may never be presented and we would depend on Alert timing to learn anything. index.js
 * calls this from its catch: it registers a root component built from plain react-native
 * <Text> that lists EVERY captured error, so the install shows the evidence on its own.
 *
 * Only `react` and `react-native` are required, lazily, inside try/catch: no router, no app
 * modules, no boot-black-box-adjacent imports. Best-effort — a failure here changes nothing.
 */
function renderFallbackApp() {
  try {
    var React = require('react');
    var RN = require('react-native');
    var AppRegistry = RN && RN.AppRegistry;
    if (
      !React ||
      !RN ||
      !AppRegistry ||
      typeof AppRegistry.registerComponent !== 'function' ||
      !RN.View ||
      !RN.Text ||
      !RN.ScrollView ||
      !RN.StyleSheet
    ) {
      state.fallback = 'react-native unavailable';
      return false;
    }
    var styles = RN.StyleSheet.create({
      screen: { flex: 1, backgroundColor: '#F4F5EE' },
      content: { padding: 20, paddingTop: 60 },
      title: { color: '#000000', fontSize: 20, fontWeight: '700', marginBottom: 8 },
      sub: { color: '#000000', fontSize: 13, marginBottom: 16 },
      entry: {
        color: '#000000',
        fontSize: 12,
        marginBottom: 14,
        fontFamily: 'Courier',
      },
    });
    function FallbackScreen() {
      var entries = state.errors || [];
      var children = [
        React.createElement(
          RN.Text,
          { key: 'title', style: styles.title },
          'SPOTTER could not start (build 21 diagnostic)'
        ),
        React.createElement(
          RN.Text,
          { key: 'sub', style: styles.sub },
          ALERT_TITLE +
            ' — ' +
            entries.length +
            ' error(s) captured, phase ' +
            state.phase +
            (state.fallback ? ', fallback: ' + state.fallback : '')
        ),
      ];
      for (var i = 0; i < entries.length; i++) {
        children.push(
          React.createElement(
            RN.Text,
            { key: 'entry-' + i, style: styles.entry },
            i + 1 + '. [' + entries[i].phase + '] ' + entries[i].name + ': ' + entries[i].message + '\n' + formatStack(entries[i].stack)
          )
        );
      }
      if (!entries.length) {
        children.push(
          React.createElement(
            RN.Text,
            { key: 'entry-none', style: styles.entry },
            '(no error captured, but the router never loaded)'
          )
        );
      }
      return React.createElement(
        RN.ScrollView,
        { style: styles.screen, contentContainerStyle: styles.content },
        React.createElement(RN.View, null, children)
      );
    }
    AppRegistry.registerComponent('main', function () {
      return FallbackScreen;
    });
    state.fallbackRegistered = true;
    try {
      console.error('[spotter-blackbox] fallback view registered\n' + describeAll());
    } catch (e) {
      /* ignore */
    }
    return true;
  } catch (e) {
    state.fallback = 'register failed: ' + truncate((e && e.message) || e, 120);
    return false;
  }
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
  describeAll: describeAll,
  renderFallbackApp: renderFallbackApp,
};

// Side-effect install: merely requiring this module arms the black box, so the install
// happens at this module's scope — before index.js evaluates anything else.
try {
  installBootBlackBox();
} catch (e) {
  /* the require that pulled us in must still succeed */
}
