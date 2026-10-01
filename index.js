/**
 * SPOTTER build 27 -- REPLAY probe (probe v4).
 * DIAGNOSTIC ONLY: never merged to master, never attached to App Store version 1.0
 * (which stays pointing at build 18). The clean release candidate is now build 27.
 *
 * WHY THIS BUILD EXISTS (what changed since build 25)
 *   Build 25 already captured every JS channel but its evidence was LOST if the process
 *   aborted before an Alert could be presented or a network POST could complete -- and the
 *   device reports "still crashing" with no crash submission and no app_diagnostics row, so
 *   build 25's capture never reached us. Build 26 makes the instrument survive the abort:
 *   every event is appended to a file in the app's Documents directory with a SYNCHRONOUS
 *   native write, and the NEXT launch replays that file (alert + POST). Evidence no longer
 *   depends on surviving.
 *
 * THE SYNCHRONOUS STORE (verified against the installed expo-file-system@57.0.6 source, NOT assumed)
 *   node_modules/expo-file-system/src/internal/NativeFileSystem.types.ts
 *     write(content: string | Uint8Array, options?: FileWriteOptions): void;   <- returns void
 *     textSync(): string;   exists: boolean;
 *   node_modules/expo-file-system/ios/FileSystemModule.swift
 *     Function("write") { ... options?.append ... }        <- Function (synchronous JSI), not AsyncFunction
 *     Property("exists"), Function("textSync")             <- synchronous
 *   node_modules/expo-file-system/ios/FileSystemFile.swift
 *     writeAppending(_:)  -> creates the file when absent, else FileHandle.seekToEndOfFile() + write
 *                            + closeFile() (flushed before the call returns)
 *   So File.write(str, { append: true }) is a genuinely synchronous, durable, on-device append --
 *   no promise, no async hop, and nothing for the abort to outrun. Files land in
 *   Paths.document (app Documents directory), file name 'boot-capture.jsonl', append-only and
 *   NEVER truncated (a per-boot write cap only stops writing; it never rewrites the file).
 *
 * ORDERING NOTE (deliberate deviation from the letter of the brief, for safety)
 *   The brief lists "require react-native" as stage (b). This entry requires react-native and
 *   installs the capture hook FIRST, because no durable store exists until a native module is
 *   required, and an unprotected first require is itself a candidate for the abort class being
 *   hunted (a module-scope throw during a require goes through Metro's require guard ->
 *   ErrorUtils.reportFatalError). Stages are still written in the brief's order (a..h); the
 *   pre-store timings are recorded in the stage-(a) row so nothing is hidden.
 *
 * MARKERS ARE PURE ASCII ON PURPOSE
 *   A release main.jsbundle is Hermes bytecode and Hermes stores a string as 8-bit ASCII only if
 *   EVERY character is ASCII -- one em dash and the literal becomes UTF-16LE, invisible to an
 *   ASCII grep. Count with /home/team/shared/bundle_count.py (ascii + utf16le).
 */
/* ================================================================================================
 * BUILD 27 -- PROBE v4: the replay self-reports WITHOUT booting the app graph.
 * Build 26 wrote a durable trail but replayed it by loading the real app, so a boot that aborts
 * instantly could die before the replay painted or the POST completed. Build 27 makes the FIRST
 * thing the entry does a decision (see section 9): read the durable store and classify the previous
 * boot as (1) none -> load the real app (that is the abort we want on disk), (2) INCOMPLETE -> show
 * a plain-RN replay screen and POST the trail, without requiring expo-router, supabase, fonts or
 * any app module, or (3) FINISHED -> load the real app plus a short alert.
 * The screen carries: app name, build, the verdict, the whole trail one marker per line, the POST
 * result, and a "Try the app anyway" button whose handler is the only place that loads the app.
 * DIAGNOSTIC ONLY: never merged to master, never attached to an App Store version (1.0 stays on 18).
 * ================================================================================================ */
/* eslint-disable */
'use strict';

var BUILD = '27';
var TAG = '[cap27]';
// One plain ASCII literal: the submit gate greps the built Hermes bundle for exactly this string.
var BANNER = '[cap27] SPOTTER build 27 replay probe';
var BANNER_OPENED = '[cap27] SPOTTER build 27 opened';
var BANNER_NOERR = '[cap27] NO ERROR CAPTURED';
var BANNER_PROBE = '[cap27] native module registry';
var BANNER_REPLAY = '[cap27] REPLAY previous boot';
var BANNER_REPLAY_SCREEN = '[cap27] REPLAY SCREEN did NOT need the app graph';
var BANNER_TRY_APP = '[cap27] TRY THE APP ANYWAY tapped';
// A boot is FINISHED only when it wrote one of these. h-module-probe-done closes a normal app boot;
// r-replay-complete closes a replay boot (which by design never loads the app graph). Anything else
// means that boot died inside the first-render window this probe is hunting.
var TERMINAL_STAGES = ['h-module-probe-done', 'r-replay-complete'];
var STORE_NAME = 'boot-capture.jsonl';
var APP_VERSION = '1.0.0';
var MAX_WRITE_LINES_PER_BOOT = 500;
var ALERT_STUCK_MS = 20000; // assume a displayed alert was dismissed if OK was never tapped

// -------------------------------------------------- 0. React Native first, then the capture hook
// Nothing can be captured before ErrorUtils exists, and nothing can be stored durably before a
// native module is required -- so react-native goes first and the hook goes on immediately.
var RN = require('react-native');
var React = require('react');

var T0 = Date.now();
var HOOK_INSTALLED_AT = null; // ms offsets recorded so the pre-store order stays on the record
var hookInstalled = false;
var ourHook = null;
var listenerInstalled = false;
var exceptionsManagerWrapped = false;
var captured = [];
var seen = {};
var forcePaint = null; // set by whichever root is rendering our capture view
// ---- build 27: boot-mode state ---------------------------------------------------------------
var REPLAY_ACTIVE = false;       // true when this launch showed the replay screen instead of the app
var captureProviderFor = null;   // 'app' exactly while the real app is being loaded (see the wrapper)
var capturedAppProvider = null;  // the app's own `main` component provider, captured at registration
var mainRegistrations = 0;       // how many times `main` was registered this launch
var appWrapperInstalled = false; // did the AppRegistry.registerComponent wrapper actually install?
var entryThrew = null;
var supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
var supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
var SESSION =
  BUILD + '-' + String(T0) + '-' + String(Math.floor(Math.random() * 1000000));

function toMsg(error) {
  try {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return String(error);
  } catch (e) {
    return '(message unreadable)';
  }
}

function toStack(error) {
  try {
    if (error && typeof error === 'object' && error.stack) return String(error.stack);
    return '(no stack)';
  } catch (e) {
    return '(stack unreadable)';
  }
}

function iso() {
  try {
    return new Date().toISOString();
  } catch (e) {
    return '(no clock)';
  }
}

function now() {
  return Date.now() - T0; // ms since the first line of this entry
}

/** Evaluate a description WITHOUT ever letting the description become the failure. */
function safeStr(fn) {
  try {
    return String(fn());
  } catch (e) {
    return 'unavailable: ' + toMsg(e);
  }
}

// --------------------------------------------------------------- 1. the synchronous store
// One file, append-only, one JSON object per line. Every read/write is wrapped: the store must
// never be able to become the failure it is meant to observe.
var storeFile = null;
var storeReady = false;
var storeError = null;
var storeUri = null;
var storeWrites = 0;
var storeWriteError = null;
var storeReadError = null;
var storeMem = [];

function storeInit() {
  try {
    var FS = require('expo-file-system');
    if (!FS || typeof FS.File !== 'function' || !FS.Paths) {
      throw new Error('expo-file-system exports missing (File/Paths)');
    }
    var f = new FS.File(FS.Paths.document, STORE_NAME);
    storeUri = f.uri;
    storeFile = f;
    storeReady = true;
  } catch (e) {
    storeError = toMsg(e) + ' || ' + toStack(e).split('\n').slice(0, 3).join(' | ');
    storeReady = false;
  }
}

/** Append one JSON object to the durable store (SYNCHRONOUS native write). Never throws. */
function storeLine(obj) {
  var line;
  try {
    line = JSON.stringify(obj);
  } catch (e) {
    line = '{"kind":"unserialisable"}';
  }
  try {
    if (storeMem.length < 400) storeMem.push(line);
  } catch (e) {
    /* memory cap */
  }
  try {
    console.log(TAG + ' ' + line);
  } catch (e) {
    /* console only */
  }
  if (!storeReady || !storeFile) return false;
  if (storeWrites >= MAX_WRITE_LINES_PER_BOOT) return false; // stop writing; NEVER truncate
  try {
    // File.write -> Function("write") -> FileSystemFile.write(_:append:) : synchronous, flushed.
    storeFile.write(line + '\n', { append: true });
    storeWrites++;
    return true;
  } catch (e) {
    if (!storeWriteError) storeWriteError = toMsg(e);
    return false;
  }
}

/** Read the whole store synchronously. Returns null only if the store is unusable. */
function storeReadAll() {
  if (!storeReady || !storeFile) return null;
  try {
    if (!storeFile.exists) return '';
    return String(storeFile.textSync());
  } catch (e) {
    storeReadError = toMsg(e);
    return null;
  }
}

function storeState() {
  return (
    'store_ready=' +
    storeReady +
    ' file=' +
    STORE_NAME +
    ' uri=' +
    storeUri +
    ' writes=' +
    storeWrites +
    ' store_error=' +
    storeError +
    ' store_write_error=' +
    storeWriteError
  );
}

// ------------------------------------------------------------------- 2. post / alert plumbing
function postDiag(kind, message, stack, extra) {
  try {
    if (!supabaseUrl || !supabaseKey) return false;
    var body = {
      message: String(kind + ' ' + message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 6000) : null,
      app_version: APP_VERSION,
      build_number: BUILD,
      ts: iso(),
    };
    if (extra) body.message = String(body.message + ' || ' + extra).slice(0, 2000);
    fetch(supabaseUrl.replace(/\/+$/, '') + '/rest/v1/app_diagnostics', {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    }).catch(function () {
      /* observability must never surface */
    });
    return true;
  } catch (e) {
    return false;
  }
}

// Alert.chunk: RCTAlertController presents on the top-most view controller and does NOT queue, so
// two Alerts fired close together lose the second one. Every alert in this probe goes through one
// serial queue with an OK-driven advance and a stuck-timeout fallback.
var alertQueue = [];
var alertBusy = false;
var alertShownAt = 0;
var alertPumpScheduled = false;

function pumpAlerts() {
  alertPumpScheduled = false;
  try {
    if (alertBusy) {
      if (Date.now() - alertShownAt < ALERT_STUCK_MS) {
        scheduleAlertPump(ALERT_STUCK_MS); // still on screen: come back when we may assume it is gone
        return;
      }
      alertBusy = false; // assume the owner dismissed it (or never saw it)
    }
    if (!alertQueue.length) return;
    var item = alertQueue.shift();
    alertBusy = true;
    alertShownAt = Date.now();
    storeLine({ t: iso(), ms: now(), kind: 'alert', session: SESSION, build: BUILD, title: item.title });
    RN.Alert.alert(
      item.title,
      String(item.body).slice(0, 1800),
      [
        {
          text: 'OK',
          onPress: function () {
            alertBusy = false;
            alertShownAt = 0;
            setTimeout(pumpAlerts, 700);
          },
        },
      ],
      { cancelable: false },
    );
  } catch (e) {
    alertBusy = false;
  }
}

function scheduleAlertPump(delay) {
  if (alertPumpScheduled) return;
  alertPumpScheduled = true;
  try {
    setTimeout(pumpAlerts, delay || 1200);
  } catch (e) {
    alertPumpScheduled = false;
  }
}

function queueAlert(title, body) {
  try {
    alertQueue.push({ title: title, body: body });
  } catch (e) {
    return;
  }
  scheduleAlertPump(200);
}

// ------------------------------------------------------- 3. capture-first on every JS channel
function captureText(entry) {
  var stackLines = String(entry.stack || '').split('\n').slice(0, 12).join('\n');
  return (
    BANNER +
    '\nbuild: ' +
    BUILD +
    '\nlayer: ' +
    entry.layer +
    '   fatal: ' +
    (entry.fatal ? 'yes' : 'no') +
    '\nmessage: ' +
    entry.message +
    '\n--- stack (first 12 lines) ---\n' +
    stackLines
  );
}

function capturedFatal() {
  for (var i = 0; i < captured.length; i++) if (captured[i].fatal) return true;
  return false;
}

/**
 * Record + surface one uncaught error. NEVER throws, and it writes to the durable store BEFORE it
 * alerts or POSTs -- so even if the process dies at the next instruction the evidence is on disk.
 */
function report(layer, error, isFatal) {
  try {
    var message = toMsg(error);
    var stack = toStack(error);
    var key = message.slice(0, 200); // dedupe across channels: the first (most specific) layer wins
    if (seen[key]) return;
    seen[key] = true;
    var entry = { layer: layer, message: message, stack: stack, fatal: !!isFatal, at: iso() };
    captured.push(entry);
    // 1. DURABLE, SYNCHRONOUS, FIRST.
    storeLine({
      t: iso(),
      ms: now(),
      kind: 'capture',
      session: SESSION,
      build: BUILD,
      layer: layer,
      fatal: !!isFatal,
      message: String(message).slice(0, 1500),
      stack: String(stack).split('\n').slice(0, 25).join('\n').slice(0, 4000),
    });
    // 2. network (best effort, may never finish -- that is fine now).
    postDiag(TAG + ' CAPTURED ' + layer, message, stack, 'fatal=' + (isFatal ? 'yes' : 'no'));
    // 3. the owner-visible alert, serialized, titled with the build number.
    queueAlert('SPOTTER boot capture (build 27)', captureText(entry));
    // 4. paint only for a FATAL capture: a late non-fatal error must not cover the app's screen.
    if (isFatal && forcePaint) {
      try {
        forcePaint();
      } catch (e) {
        /* painting is best effort */
      }
    }
  } catch (e) {
    /* never throw from the capture path */
  }
}

/** Channel 1: ErrorUtils.setGlobalHandler (upstream of ExceptionsManager.handleException). */
function installErrorUtilsHook() {
  try {
    var EU = globalThis.ErrorUtils;
    if (EU && typeof EU.setGlobalHandler === 'function') {
      var prev = typeof EU.getGlobalHandler === 'function' ? EU.getGlobalHandler() : null;
      ourHook = function (error, isFatal) {
        report('[ErrorUtils]', error, isFatal);
        // A FATAL is deliberately NOT delegated to React Native: delegating is what aborts the
        // process (reportException -> reportFatal -> RCTFatal -> SIGABRT) before anything can be
        // shown or posted. Non-fatal errors keep the previous behaviour.
        if (!isFatal) {
          try {
            if (prev) prev(error, isFatal);
          } catch (e) {
            /* keep the original behaviour best-effort */
          }
        }
      };
      EU.setGlobalHandler(ourHook);
      hookInstalled = true;
      HOOK_INSTALLED_AT = now();
    }
  } catch (e) {
    /* the other channels still capture */
  }
}

/**
 * Channel 2: RN 0.86 hands an uncaught REACT render/commit/effect error to React's root option
 * onUncaughtError, which calls `ExceptionsManager.handleException(error, true)` DIRECTLY -- it does
 * not pass through ErrorUtils. That is the one surviving crash class, so wrap the object method
 * (Libraries/Core/ExceptionsManager.js exports a plain, writable object literal; the call site does
 * a property lookup at call time, so a wrapper is honoured). Non-fatal errors are delegated as
 * before; a FATAL is captured and NOT delegated, so the process stays alive to record it.
 */
function installExceptionsManagerHook() {
  try {
    var mod = require('react-native/Libraries/Core/ExceptionsManager');
    var EM = mod && (mod.default || mod);
    if (EM && typeof EM.handleException === 'function') {
      var orig = EM.handleException;
      if (!orig.__cap27) {
        var wrapped = function (error, isFatal) {
          report('[ExceptionsManager]', error, isFatal);
          if (!isFatal) {
            try {
              return orig.apply(EM, arguments);
            } catch (e) {
              /* keep the original behaviour best-effort */
            }
          }
          return undefined;
        };
        wrapped.__cap27 = true;
        EM.handleException = wrapped;
        exceptionsManagerWrapped = true;
      }
    }
  } catch (e) {
    /* the other channels still capture */
  }
}

/**
 * Channel 3: RN$registerExceptionListener -- RN 0.86 exposes it as a CALLABLE read-only global
 * (unlike RN$handleException, which defineReadOnlyGlobal makes unwritable; see the app's guard in
 * src/lib/diagnostics.ts). Calling it is legal; assigning to it is not.
 */
function installRnListener() {
  try {
    if (typeof globalThis.RN$registerExceptionListener === 'function') {
      globalThis.RN$registerExceptionListener(function (error) {
        report('[RN$listener]', error, true);
      });
      listenerInstalled = true;
    }
  } catch (e) {
    /* optional channel */
  }
}

installErrorUtilsHook();
installExceptionsManagerHook();
installRnListener();

// ------------------------------------------------------------------------ 4. staged boot trail
function mark(stage, extra) {
  try {
    storeLine({
      t: iso(),
      ms: now(),
      kind: 'stage',
      stage: stage,
      session: SESSION,
      build: BUILD,
      extra: extra === undefined ? null : extra,
    });
  } catch (e) {
    /* a marker must never be the failure it reports */
  }
}

// The store is the only thing that can be durable, so it is initialised before stage (a) exists.
storeInit();

// (a) entry start
mark(
  'a-entry-start',
  'store: ' +
    storeState() +
    ' | rn_required_at_ms=' +
    0 +
    ' hook_installed_at_ms=' +
    HOOK_INSTALLED_AT +
    ' em_wrapped=' +
    exceptionsManagerWrapped +
    ' listener=' +
    listenerInstalled +
    ' errorutils_pre_existing=' +
    !!globalThis.ErrorUtils,
);

// (b) after require('react-native')
mark(
  'b-rn-required',
  'rn_version=' +
    safeStr(function () {
      return RN.Platform && RN.Platform.constants && RN.Platform.constants.reactNativeVersion
        ? JSON.stringify(RN.Platform.constants.reactNativeVersion)
        : '(none)';
    }) +
    ' os=' +
    safeStr(function () {
      return RN.Platform.OS;
    }) +
    ' dev=' +
    safeStr(function () {
      return typeof __DEV__ === 'undefined' ? 'undef' : __DEV__;
    }),
);

// (c) after the ErrorUtils hook is installed
mark(
  'c-errorutils-hook',
  'hook_installed=' +
    hookInstalled +
    ' our_hook_on_top=' +
    safeStr(function () {
      return globalThis.ErrorUtils && globalThis.ErrorUtils.getGlobalHandler
        ? globalThis.ErrorUtils.getGlobalHandler() === ourHook
        : 'unknown';
    }) +
    ' exceptions_manager_wrapped=' +
    exceptionsManagerWrapped,
);

// (d) after RN$registerExceptionListener is registered
mark('d-rn-listener', 'listener_installed=' + listenerInstalled);

// --------------------------------------------------------- 5. replay of the PREVIOUS boot
function describeLine(o) {
  if (o.kind === 'stage') return 'stage ' + o.stage + ' @' + o.ms + 'ms' + (o.extra ? '  ' + o.extra : '');
  if (o.kind === 'capture') return 'CAPTURE [' + o.layer + '] fatal=' + o.fatal + ' :: ' + o.message;
  if (o.kind === 'alert') return 'alert shown: ' + o.title;
  return 'kind=' + o.kind + ' ' + JSON.stringify(o).slice(0, 200);
}

function replay() {
  var raw = storeReadAll();
  var info = {
    store_readable: raw !== null,
    sessions_seen: 0,
    prev_session: null,
    prev_build: null,
    prev_last_stage: null,
    prev_stage_count: 0,
    prev_captures: 0,
    prev_age_ms: null,
    incomplete: null,
    trail: [],
  };
  try {
    if (raw === null) {
      storeLine({ t: iso(), ms: now(), kind: 'replay', session: SESSION, build: BUILD, note: 'store unreadable', error: storeReadError + ' | ' + storeState() });
      return info;
    }
    var rows = [];
    var parts = String(raw).split('\n');
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (!s) continue;
      try {
        var o = JSON.parse(s);
        if (o && o.session) rows.push(o);
      } catch (e) {
        /* a torn last line after an abort: ignore it, the next line is still readable */
      }
    }
    var sessions = [];
    for (var j = 0; j < rows.length; j++) {
      if (sessions.indexOf(rows[j].session) === -1) sessions.push(rows[j].session);
    }
    info.sessions_seen = sessions.length;
    var prev = null;
    for (var k = sessions.length - 1; k >= 0; k--) {
      if (sessions[k] !== SESSION) {
        prev = sessions[k];
        break;
      }
    }
    if (!prev) {
      storeLine({ t: iso(), ms: now(), kind: 'replay', session: SESSION, build: BUILD, note: 'first boot with this store', sessions_seen: sessions.length });
      return info;
    }
    info.prev_session = prev;
    var prevRows = [];
    for (var m = 0; m < rows.length; m++) if (rows[m].session === prev) prevRows.push(rows[m]);
    info.prev_build = prevRows.length ? prevRows[0].build : null;
    info.prev_stage_count = 0;
    for (var n = 0; n < prevRows.length; n++) {
      var r = prevRows[n];
      if (r.kind === 'stage') {
        info.prev_stage_count++;
        info.prev_last_stage = r.stage;
      }
      if (r.kind === 'capture') info.prev_captures++;
      info.trail.push(describeLine(r));
    }
    var lastTs = prevRows.length ? prevRows[prevRows.length - 1].t : null;
    try {
      info.prev_age_ms = lastTs ? Date.now() - new Date(lastTs).getTime() : null;
    } catch (e) {
      info.prev_age_ms = null;
    }
    // A session is COMPLETE only when it wrote one of the terminal markers (see TERMINAL_STAGES).
    info.prev_terminal = null;
    for (var n2 = 0; n2 < prevRows.length; n2++) {
      var r2 = prevRows[n2];
      if (r2.kind === 'stage' && TERMINAL_STAGES.indexOf(r2.stage) !== -1) info.prev_terminal = r2.stage;
    }
    info.incomplete = info.prev_terminal === null;
    // A boot that died before ANY of our JS ran leaves no row at all: report the gap between how
    // many sessions the store has seen and how many of them produced a full trail.
    var complete = 0;
    for (var p = 0; p < sessions.length; p++) {
      var any = false;
      for (var q = 0; q < rows.length; q++) {
        if (
          rows[q].session === sessions[p] &&
          rows[q].kind === 'stage' &&
          TERMINAL_STAGES.indexOf(rows[q].stage) !== -1
        )
          any = true;
      }
      if (any) complete++;
    }
    info.complete_sessions = complete;
    return info;
  } catch (e) {
    storeLine({ t: iso(), ms: now(), kind: 'replay', session: SESSION, build: BUILD, note: 'replay threw', error: toMsg(e) + ' ' + toStack(e) });
    return info;
  } finally {
    /* nothing */
  }
}

function replayReport(info) {
  var lines = [];
  lines.push('build ' + BUILD + ' replay of the previous boot');
  if (info.prev_session === null) {
    lines.push(
      'PREVIOUS BOOT: none recorded on this device (first launch with the boot store). sessions_seen=' +
        info.sessions_seen +
        '  store_readable=' +
        info.store_readable,
    );
    return { lines: lines, incomplete: false, hasReport: false };
  }
  lines.push(
    'PREVIOUS BOOT (build ' +
      info.prev_build +
      '): ' +
      (info.incomplete
        ? 'previous boot did NOT finish - it never wrote the marker that closes its stage set, so it died first'
        : 'previous boot finished (it wrote ' + info.prev_terminal + ')'),
  );
  lines.push(
    'last stage: ' +
      info.prev_last_stage +
      '   stages recorded: ' +
      info.prev_stage_count +
      '   captures: ' +
      info.prev_captures +
      '   last row ~' +
      (info.prev_age_ms === null ? '?' : Math.round(info.prev_age_ms / 1000) + 's ago'),
  );
  lines.push(
    'sessions the store has seen: ' +
      info.sessions_seen +
      '   sessions that completed: ' +
      info.complete_sessions +
      '   (a gap means a launch died before any of our JS ran)',
  );
  lines.push('');
  lines.push('--- the whole recorded trail of that boot ---');
  var trail = info.trail.length ? info.trail : ['(no rows)'];
  for (var i = 0; i < trail.length; i++) lines.push(trail[i]);
  return { lines: lines, incomplete: true, hasReport: info.incomplete || info.prev_captures > 0 };
}

// ------------------------------------------------- 6. paint into the view tree if it is alive
/** Big, selectable, unmistakable capture screen (light theme: black on white). */
function CaptureView() {
  var text = captured.length
    ? captured.map(captureText).join('\n\n====================\n\n')
    : BANNER + '\nbuild: ' + BUILD + '\nno error captured';
  return React.createElement(
    RN.ScrollView,
    { style: { flex: 1, backgroundColor: '#FFFFFF' }, contentContainerStyle: { padding: 18 } },
    React.createElement(
      RN.Text,
      {
        selectable: true,
        style: { color: '#000000', fontSize: 15, lineHeight: 21, fontFamily: 'Courier' },
      },
      text,
    ),
  );
}

/** Top-of-tree error boundary: catches first-render and mount-effect throws and shows the text. */
class Cap27Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
    this.forceUpdate = this.forceUpdate.bind(this);
    this.onBoundaryMount = this.onBoundaryMount.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { err: error };
  }
  componentDidCatch(error) {
    report('[render-boundary]', error, true);
  }
  onBoundaryMount() {
    forcePaint = this.forceUpdate;
    markTreeRendered('root=app-boundary (the app component tree mounted)');
  }
  componentDidMount() {
    this.onBoundaryMount();
  }
  componentWillUnmount() {
    if (forcePaint === this.forceUpdate) forcePaint = null;
  }
  render() {
    // In replay mode a capture must NOT replace the replay screen: the screen carries the whole
    // previous-boot trail, which is the entire point of this build. Its own children still throw
    // through to this boundary.
    if (this.state.err) return React.createElement(CaptureView, null);
    if (!REPLAY_ACTIVE && capturedFatal()) return React.createElement(CaptureView, null);
    return this.props.children;
  }
}

/** Fallback root, used only when the app never registered itself (module-scope throw). */
class Cap27DiagRoot extends React.Component {
  componentDidMount() {
    forcePaint = this.forceUpdate.bind(this);
    markTreeRendered('root=probe-diagnostic-root (the APP never registered a root)');
  }
  render() {
    return React.createElement(CaptureView, null);
  }
}

function registerDiagRoot() {
  try {
    RN.AppRegistry.registerComponent('main', function () {
      return Cap27DiagRoot;
    });
    storeLine({ t: iso(), ms: now(), kind: 'stage', stage: 'f-diag-root-registered', session: SESSION, build: BUILD, extra: 'the app registered no root, so the probe root took over' });
    postDiag(TAG + ' diag root registered under main', 'build 27 diagnostic root', null, storeState());
  } catch (e) {
    postDiag(TAG + ' diag root registration FAILED', toMsg(e), toStack(e), null);
  }
}

// Wrap AppRegistry.registerComponent BEFORE anything registers a root. Two reasons:
//   (1) the app's own root gets an error boundary above it -- a first-render throw is then captured
//       and painted instead of killing the process with no evidence;
//   (2) the app's own `main` provider is CAPTURED, which is what "Try the app anyway" renders in
//       place of the replay screen -- no second renderApplication, no re-registration race.
try {
  var origRegister = RN.AppRegistry.registerComponent;
  if (typeof origRegister === 'function' && !origRegister.__cap27) {
    var wrappedRegister = function (appKey, componentProvider, section) {
      if (appKey === 'main') {
        mainRegistrations = mainRegistrations + 1;
        if (captureProviderFor === 'app') capturedAppProvider = componentProvider;
      }
      storeLine({ t: iso(), ms: now(), kind: 'stage', stage: 'f-root-register-call', session: SESSION, build: BUILD, extra: 'appKey=' + appKey + ' capture=' + (captureProviderFor === 'app') });
      var wrappedProvider = function () {
        var App = typeof componentProvider === 'function' ? componentProvider() : componentProvider;
        return function Cap27Root(props) {
          // props (rootTag, initialProps) are FORWARDED: the app's root component expects them, and
          // dropping them would be a new fault of our own making.
          return React.createElement(Cap27Boundary, null, typeof App === 'function' ? React.createElement(App, props) : App);
        };
      };
      try {
        return origRegister.call(RN.AppRegistry, appKey, wrappedProvider, section);
      } catch (e) {
        return origRegister.call(RN.AppRegistry, appKey, componentProvider, section);
      }
    };
    wrappedRegister.__cap27 = true;
    RN.AppRegistry.registerComponent = wrappedRegister;
    // Does the export let us replace the method at all? (React Native re-exports it through a
    // getter in the Metro bundle; if the assignment is refused this stays false, and the probe
    // still works because it registers its own root through the original function.)
    appWrapperInstalled = RN.AppRegistry.registerComponent === wrappedRegister;
  }
} catch (e) {
  /* the ErrorUtils hook still captures */
}

// ------------------------------------------- 7. how the real app gets loaded (deferred, ONE call site)
// This is the ONLY literal require of the app entry in this file. It deliberately sits inside a
// function body: Metro still bundles expo-router (the normal path needs it), but on the replay path
// nothing here ever runs, so expo-router, supabase, fonts and every app module stay out of the
// initial module graph. That is the whole difference between build 26 and build 27.
function loadRealApp() {
  try {
    require('expo-router/entry');
    mark('e-router-required', 'expo-router/entry returned');
    return null;
  } catch (e) {
    entryThrew = e;
    mark('e-router-required', 'expo-router/entry THREW');
    report('[entry-require]', e, true);
    return e;
  }
}

// (f) after the root component registers
function appKeys() {
  try {
    return RN.AppRegistry.getAppKeys ? RN.AppRegistry.getAppKeys() : [];
  } catch (e) {
    return [];
  }
}

/** Which marker a mounted tree writes: g on a normal launch, r on a replay launch. */
function markTreeRendered(extra) {
  if (REPLAY_ACTIVE) mark('r-screen-rendered', extra);
  else mark('g-tree-rendered', extra);
}

// ---------------------------------------------------------------------------------------------
// CASES 1 and 3 of the brief: no previous trail at all, or a previous trail that FINISHED.
// Load the real app exactly as build 26 does. On case 1 this is the boot whose abort we want on
// disk -- it must NOT be short-circuited.
// ---------------------------------------------------------------------------------------------
function startAppMode(info) {
  if (info.mode === 'normal') {
    queueAlert(
      BANNER_REPLAY + ' (build 27)',
      'The previous boot FINISHED normally (it wrote ' +
        info.prev_terminal +
        ').\n\nNothing to replay -- the app is loading normally.\n\n' +
        'If it crashes now, open it again WITHOUT deleting it: the next launch puts the trail on screen.',
    );
  }
  captureProviderFor = 'app';
  var threw = loadRealApp();
  captureProviderFor = null;
  mark('f-root-registered', 'app_keys=[' + appKeys().join(',') + '] entry_threw=' + !!threw + ' captured_provider=' + !!capturedAppProvider);
  postDiag(
    TAG + ' boot mode=' + info.mode,
    'prev_build=' +
      info.prev_build +
      ' prev_last_stage=' +
      info.prev_last_stage +
      ' prev_terminal=' +
      info.prev_terminal +
      ' incomplete=' +
      info.incomplete +
      ' prev_captures=' +
      info.prev_captures +
      ' sessions_seen=' +
      info.sessions_seen +
      ' complete_sessions=' +
      info.complete_sessions,
    info.trail && info.trail.length ? info.trail.join('\n') : null,
    'store=' + storeState(),
  );
  if (threw && appKeys().indexOf('main') === -1) registerDiagRoot();
  // The app is a real app now: run build 26's post-load work (module registry probe, stage h, the
  // "opened" alert) exactly as before.
  var delay = typeof setTimeout === 'function' ? 4000 : 0;
  if (delay) setTimeout(afterLoad, delay);
  else afterLoad();
}

// ---------------------------------------------------------------------------------------------
// CASE 2 of the brief: a previous trail that did NOT finish -> REPLAY MODE.
// Nothing below requires expo-router, expo-router/entry, supabase, fonts or any app module: the
// screen is plain RN View/Text/ScrollView plus one Button, so it paints even when the app graph
// cannot boot at all.
// ---------------------------------------------------------------------------------------------
function screenText(st) {
  return String(st.head || '') + '\n\n--- what THIS launch did ---\n' + st.post + (st.note ? '\n' + st.note : '');
}

function makeReplayScreen(info, st) {
  class ReplayScreen extends React.Component {
    constructor(props) {
      super(props);
      this.state = { n: 0 };
      var self = this;
      st.refresh = function () {
        try {
          self.setState({ n: self.state.n + 1 });
        } catch (e) {
          /* the screen is static text; a failed refresh is not worth a crash */
        }
      };
    }
    componentDidMount() {
      markTreeRendered('root=replay-screen (plain RN View/Text/ScrollView only; no app module loaded)');
      postDiag(BANNER_REPLAY_SCREEN, 'the replay screen rendered on the device', null, 'prev_build=' + info.prev_build + ' last=' + info.prev_last_stage);
    }
    render() {
      var self = this;
      if (st.appEl) return st.appEl; // the owner tapped "Try the app anyway"
      return React.createElement(
        RN.ScrollView,
        { style: { flex: 1, backgroundColor: '#FFFFFF' }, contentContainerStyle: { padding: 16 } },
        React.createElement(
          RN.Text,
          { selectable: true, style: { color: '#000000', fontSize: 14, lineHeight: 20 } },
          screenText(st),
        ),
        React.createElement(RN.View, { style: { height: 18 } }),
        React.createElement(RN.Button, {
          title: 'Try the app anyway',
          onPress: function () {
            onTryApp(self.props, st);
          },
        }),
      );
    }
  }
  return ReplayScreen;
}

/** The button handler: the ONLY place (besides startAppMode) that loads the app graph, on demand. */
function onTryApp(rootProps, st) {
  try {
    mark('r-try-app-tapped', 'requiring expo-router/entry from the button handler only');
    postDiag(BANNER_TRY_APP, 'the owner tapped "Try the app anyway"', null, 'store=' + storeState());
    captureProviderFor = 'app';
    var before = mainRegistrations;
    var threw = loadRealApp();
    captureProviderFor = null;
    if (threw) {
      st.note = 'The app entry THREW: ' + toMsg(threw) + '\n(the capture text is in the trail above and on disk)';
    } else if (capturedAppProvider && mainRegistrations > before) {
      var App = typeof capturedAppProvider === 'function' ? capturedAppProvider() : capturedAppProvider;
      st.appEl = typeof App === 'function' ? React.createElement(App, rootProps || {}) : App;
      mark('r-app-rendered-in-place', 'the real app tree replaced the replay screen (no re-registration)');
      st.note = 'The real app tree is now mounted in place of this screen.';
    } else {
      // The wrapper did not capture a provider (or the app registered under another key): fall back
      // to the same call the native side makes, with the root tag the replay screen was given.
      var rt = rootProps && rootProps.rootTag ? rootProps.rootTag : 1;
      mark('r-app-run-application-fallback', 'no captured provider; AppRegistry.runApplication(rootTag=' + rt + ')');
      RN.AppRegistry.runApplication('main', { rootTag: rt, initialProps: {} });
      st.note = 'Called AppRegistry.runApplication(rootTag=' + rt + ') -- if the screen did not change, the app graph still booted.';
    }
  } catch (e) {
    st.note = 'try-app threw: ' + toMsg(e);
    report('[try-app]', e, true);
  }
  if (st.refresh) st.refresh();
}

function startReplayMode(info) {
  REPLAY_ACTIVE = true;
  var rep = replayReport(info);
  // (a) CAPTURE-FIRST: the markers go to disk BEFORE the screen, the POST or the alert can die.
  mark(
    'r-replay-shown',
    'replay screen is up and NO app module was required (prev_build=' +
      info.prev_build +
      ' prev_last_stage=' +
      info.prev_last_stage +
      ' markers=' +
      info.prev_stage_count +
      ' captures=' +
      info.prev_captures +
      ')',
  );
  storeLine({
    t: iso(),
    ms: now(),
    kind: 'replay_boot',
    session: SESSION,
    build: BUILD,
    mode: 'replay',
    prev_session: info.prev_session,
    prev_build: info.prev_build,
    prev_last_stage: info.prev_last_stage,
    prev_terminal: info.prev_terminal,
    prev_stages: info.prev_stage_count,
    prev_captures: info.prev_captures,
    prev_age_ms: info.prev_age_ms,
    sessions_seen: info.sessions_seen,
    complete_sessions: info.complete_sessions,
    store_readable: info.store_readable,
    router_required: false,
    app_wrapper_installed: appWrapperInstalled,
    trail: info.trail ? info.trail.slice(0, 120) : [],
  });
  mark('r-post-attempt', 'posting the previous boot trail to app_diagnostics (' + (info.trail ? info.trail.length : 0) + ' trail lines)');
  var st = {
    head: 'SPOTTER  -  build ' + BUILD + '  -  REPLAY MODE (the app was NOT loaded to show you this)\n\n' + rep.lines.join('\n'),
    post: 'POST to diagnostics: sending...',
    note: '',
    appEl: null,
    refresh: null,
  };
  // (c) the minimal plain-RN root, registered SYNCHRONOUSLY -- the native runApplication runs after
  // the bundle has finished evaluating, so this must happen at module scope.
  try {
    RN.AppRegistry.registerComponent('main', function () {
      return makeReplayScreen(info, st);
    });
    mark('r-root-registered', 'AppRegistry.registerComponent(main) -> plain RN ScrollView/Text/Button root');
  } catch (e) {
    mark('r-root-registered', 'FAILED: ' + toMsg(e));
    report('[replay-root]', e, true);
  }
  // (b) the POST of the previous boot's whole trail; its result lands on the screen via setState.
  postTrail(info, rep, st);
  // The replay boot has done everything it exists to do, so it is TERMINAL: the next launch must
  // classify it as a finished boot instead of replaying the replay.
  mark('r-replay-complete', 'screen registered and the trail POST fired');
  // The owner-visible alert, in case the root never paints.
  queueAlert(BANNER_REPLAY + ' (build 27)', rep.lines.join('\n'));
}

/** POST the previous boot's whole trail, then report the outcome on screen. Never throws. */
function postTrail(info, rep, st) {
  function done(result) {
    var ok = !!(result && result.ok);
    storeLine({
      t: iso(),
      ms: now(),
      kind: 'post_result',
      session: SESSION,
      build: BUILD,
      channel: 'replay_trail',
      ok: ok,
      status: result ? result.status : null,
      error: result && result.error ? String(result.error).slice(0, 300) : null,
    });
    st.post = ok
      ? 'POST to diagnostics: OK (HTTP ' + result.status + ') -- the team can read this trail'
      : 'POST to diagnostics: FAILED (' + ((result && (result.error || 'HTTP ' + result.status)) || 'unknown') + ') -- the trail is still on this screen and on disk';
    if (st.refresh) st.refresh();
  }
  if (!supabaseUrl || !supabaseKey) {
    done({ ok: false, error: 'no supabase url/key in this bundle' });
    return;
  }
  try {
    fetch(supabaseUrl.replace(/\/+$/, '') + '/rest/v1/app_diagnostics', {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: 'Bearer ' + supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        message: String(
          BANNER_REPLAY +
            ' build ' +
            info.prev_build +
            ' last_marker=' +
            info.prev_last_stage +
            ' markers=' +
            info.prev_stage_count +
            ' captures=' +
            info.prev_captures +
            ' sessions_seen=' +
            info.sessions_seen,
        ).slice(0, 2000),
        stack: rep.lines.join('\n').slice(0, 6000),
        app_version: APP_VERSION,
        build_number: BUILD,
        ts: iso(),
      }),
    }).then(
      function (res) {
        done({ ok: !!(res && res.ok), status: res ? res.status : 0 });
      },
      function (err) {
        done({ ok: false, error: toMsg(err) });
      },
    );
  } catch (e) {
    done({ ok: false, error: toMsg(e) });
  }
}

/** Read the store and classify the PREVIOUS boot into the brief's three cases. */
function classifyBoot() {
  var info = replay();
  if (info.prev_session === null) info.mode = 'fresh';
  else if (info.incomplete) info.mode = 'replay';
  else info.mode = 'normal';
  return info;
}

// ------------------------------------------------------ 8. globals + native module registry
function globalsProbe() {
  var out = [];
  var names = ['RN$handleException', 'RN$registerExceptionListener', 'RN$enableMicrotasksInReact', 'ErrorUtils', '__DEV__', 'expo'];
  for (var i = 0; i < names.length; i++) {
    try {
      var isDev = names[i] === '__DEV__';
      var g = isDev
        ? { value: typeof __DEV__ === 'undefined' ? 'undef' : __DEV__, writable: false, configurable: false }
        : Object.getOwnPropertyDescriptor(globalThis, names[i]);
      out.push(
        names[i] +
          ': ' +
          (g
            ? 'present writable=' + g.writable + ' configurable=' + g.configurable + ' type=' + typeof (g.value === undefined ? globalThis[names[i]] : g.value)
            : 'ABSENT'),
      );
    } catch (e) {
      out.push(names[i] + ': descriptor threw ' + toMsg(e));
    }
  }
  try {
    var ex = globalThis.expo;
    out.push('expo.modules keys = ' + (ex && ex.modules ? Object.keys(ex.modules).join(',') : '(none)'));
  } catch (e) {
    out.push('expo.modules keys threw ' + toMsg(e));
  }
  return out.join('\n');
}

function moduleProbe() {
  // On-device answer to "does the app register every module the JS asks for?". ExpoSecureStore and
  // ExpoClipboard are the current suspects; the rest is build 25's list, kept for continuity.
  var suspects = [
    'ExpoSecureStore',
    'ExpoClipboard',
    'ExpoFontLoader',
    'ExpoFontUtils',
    'ExpoApplication',
    'ExpoBadgeModule',
    'ExpoGo',
    'EXDevLauncher',
    'ExpoCrypto',
    'ExpoDevice',
    'FileSystem',
    'ExpoFileSystem',
    'ExpoCamera',
    'ExpoImageManipulator',
    'ExponentConstants',
    'ExpoNotificationsEmitter',
    'ExpoNotificationsHandlerModule',
    'ExpoPushTokenManager',
    'ExpoNotificationScheduler',
    'ExpoNotificationPermissionsModule',
    'ExpoBackgroundNotificationTasksModule',
  ];
  var have = [];
  var missing = [];
  var registry = [];
  try {
    var ex = globalThis.expo;
    if (ex && ex.modules) registry = Object.keys(ex.modules).sort();
  } catch (e) {
    /* { } */
  }
  try {
    var core = require('expo-modules-core');
    for (var i = 0; i < suspects.length; i++) {
      try {
        core.requireNativeModule(suspects[i]);
        have.push(suspects[i]);
      } catch (e) {
        missing.push(suspects[i]);
      }
    }
  } catch (e) {
    missing = ['expo-modules-core threw: ' + toMsg(e)];
  }
  return { have: have, missing: missing, registry: registry };
}

function afterLoad() {
  var probe = moduleProbe();
  var summary =
    'registered=' +
    probe.registry.length +
    ' [' +
    probe.registry.join(',') +
    '] have=' +
    probe.have.length +
    ' missing=[' +
    probe.missing.join(',') +
    ']';
  var globals = globalsProbe();
  // (h) the native-module registry probe has finished -- the last stage of the trail.
  mark('h-module-probe-done', 'probe: ' + summary + ' | globals: ' + globals.replace(/\n/g, ' ; '));
  storeLine({ t: iso(), ms: now(), kind: 'module_probe', session: SESSION, build: BUILD, registry: probe.registry, have: probe.have, missing: probe.missing, globals: globals, store: storeState() });
  postDiag(BANNER_PROBE, 'missing=[' + probe.missing.join(',') + ']', globals, summary.slice(0, 1800));
  if (!captured.length) {
    postDiag(BANNER_NOERR, 'build 27 opened and the app tree mounted with no uncaught error', null, storeState());
    storeLine({ t: iso(), ms: now(), kind: 'no_error_captured', session: SESSION, build: BUILD, store: storeState() });
    mark('i-opened-alert', 'showing the success alert');
    queueAlert(
      BANNER_OPENED,
      BANNER_OPENED +
        '\n\nNo startup error was captured in this boot.\n\n' +
        'Native modules registered: ' +
        probe.registry.length +
        '\nMissing (JS asks, app cannot provide): ' +
        (probe.missing.length ? probe.missing.join(', ') : 'none') +
        '\n\nDurable trail: ' +
        STORE_NAME +
        ' (' +
        storeWrites +
        ' rows written this boot)' +
        (storeReady ? '' : '  !! STORE NOT WRITABLE: ' + storeError) +
        '\n\nIf this build crashes, just open it again: the next launch replays the trail and sends it.',
    );
  }
}

// =============================================== 9. THE DECISION (the brief's step 2, at entry)
// It is made HERE, before ANY app-side require is evaluated: classifyBoot() reads the durable store
// (written by whoever booted last) and picks one of the three cases. startAppMode() is the only
// thing that can call loadRealApp(), and it is not on the replay path.
try {
  var BOOT = classifyBoot();
  mark(
    'k-boot-mode',
    'mode=' +
      BOOT.mode +
      ' prev_build=' +
      BOOT.prev_build +
      ' prev_last_stage=' +
      BOOT.prev_last_stage +
      ' prev_terminal=' +
      BOOT.prev_terminal +
      ' markers=' +
      BOOT.prev_stage_count +
      ' captures=' +
      BOOT.prev_captures +
      ' sessions_seen=' +
      BOOT.sessions_seen +
      ' complete_sessions=' +
      BOOT.complete_sessions +
      ' store_readable=' +
      BOOT.store_readable +
      ' app_wrapper_installed=' +
      appWrapperInstalled,
  );
  if (BOOT.mode === 'replay') startReplayMode(BOOT);
  else startAppMode(BOOT);
} catch (e) {
  // The decision itself must never be the failure: fall back to the real app, exactly as 26 did.
  report('[boot-mode]', e, true);
  try {
    mark('k-boot-mode', 'classification THREW -> loading the app anyway: ' + toMsg(e));
  } catch (e2) {
    /* nothing left to do */
  }
  captureProviderFor = 'app';
  loadRealApp();
  captureProviderFor = null;
}
