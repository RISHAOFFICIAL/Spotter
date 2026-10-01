/**
 * BUILD 24 — STAGED-REQUIRE CAPTURE PROBE.  DIAGNOSTIC ONLY.
 * Branch probe/staged-require. NEVER merge, NEVER ship, NEVER attach to an App Store version.
 *
 * WHY THIS SHAPE
 * --------------
 * Builds 20 and 21 hooked error *reporting* (`ErrorUtils.setGlobalHandler`, the RN New-Architecture
 * exception hook (RN + dollar + "handleException"), an Alert, a boot-time POST) and captured
 * nothing: the abort lands ~0.25 s in and the error is
 * reported from JS through `NativeExceptionsManager.reportException` on the JS workloop thread.
 * Reporting cannot see it in time.
 *
 * But an error thrown while a module factory is being evaluated propagates SYNCHRONOUSLY out of
 * `require()`, and the CALLER can catch it. Caught means the process does NOT abort, so it lives
 * long enough to (a) POST every line to `app_diagnostics` and (b) paint every line on screen.
 * Both channels carry the error text; neither depends on the ~0.25 s window.
 *
 * WHY THIS FILE IS PLAIN COMMONJS WITH NO `import`
 * ------------------------------------------------
 * Babel's ESM -> CJS transform HOISTS `import` declarations above every statement, so an imported
 * module would be evaluated before any `try`/`catch` in this file could protect it. Explicit
 * `require()` calls inside the stage closures are what make the throw catchable.
 *
 * WHY THE STAGES ARE UNROLLED INSTEAD OF A LOOP OVER AN ARRAY OF NAMES
 * -------------------------------------------------------------------
 * Metro resolves a dependency only from a `require('literal')`. `require(stageName)` with a
 * variable would not be collected into the bundle and would throw "Requiring unknown module" at
 * runtime instead of telling us anything about the app. So every stage below is a literal require
 * inside its own closure — one stage, one try/catch, one recorded line.
 *
 * READING THE RESULT
 * ------------------
 *   * a `FAIL` line names the module AND prints the message + stack  -> that is the fault
 *   * every line `OK` and this screen renders                        -> the fault is after module
 *                                                                      evaluation (registration,
 *                                                                      render, native init/config)
 *   * app still aborts with nothing on screen                        -> the fault is upstream of all
 *                                                                      JS (native init / autolinking)
 */

// --------------------------------------------------------------------------- diagnostics channel
var TAG = '[staged24] ';
var DIAG_URL = 'https://juxddhghhkvtmxcwvlpa.supabase.co/rest/v1/app_diagnostics';
var DIAG_KEY = 'sb_publishable_NCqAhtw2065wPcBNOTqcBg_v1nKdufW';
var APP_VERSION = '1.0.0';
var BUILD_NUMBER = '24';
// Literal that the capture gates look for in the emitted bundle (a "BOOT"-style marker for this
// diagnostic screen). Must survive minification, so it is a plain string constant.
var SCREEN_HEADER = '[staged24] BOOT — staged-require capture probe (build 24)';

var results = []; // what the screen shows, in the order things happened
var fails = 0; // how many stages threw

function shortErr(e) {
  try {
    if (e === null) return 'threw null';
    if (e === undefined) return 'threw undefined';
    if (e.message) return String(e.message);
    return String(e);
  } catch (x) {
    return '<unprintable error>';
  }
}

function shortStack(e) {
  try {
    return e && e.stack ? String(e.stack).slice(0, 1500) : '';
  } catch (x) {
    return '';
  }
}

/**
 * Best-effort, never-awaited, never-throwing POST of one line to the app's own first-party
 * diagnostics table (insert-only RLS, anon key). If the network call never lands, nothing is lost:
 * the same line is on the screen. This channel must never be able to become the failure.
 */
function post(line, stack) {
  try {
    var p = fetch(DIAG_URL, {
      method: 'POST',
      headers: {
        apikey: DIAG_KEY,
        Authorization: 'Bearer ' + DIAG_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify([
        {
          message: (line.indexOf(TAG) === 0 ? line : TAG + line).slice(0, 4000),
          stack: String(stack || '').slice(0, 4000),
          app_version: APP_VERSION,
          build_number: BUILD_NUMBER,
          ts: new Date().toISOString(),
        },
      ]),
    });
    // Never awaited; swallow rejection so an unhandled rejection can never become fatal.
    if (p && typeof p.then === 'function') {
      p.then(undefined, function () {});
    }
  } catch (e) {
    /* the diagnostics channel must never be the failure */
  }
}

function record(line, stack) {
  var s;
  try {
    s = String(line);
  } catch (e) {
    s = '<unstringifiable line>';
  }
  try {
    results.push(stack ? s + '\n' + stack : s);
  } catch (e) {}
  try {
    if (typeof console !== 'undefined' && console && console.log) {
      console.log(TAG + s);
    }
  } catch (e) {}
  post(s, stack);
}

/**
 * One stage: evaluate a module in its own try/catch and record exactly one line.
 * The closure is what keeps `require('literal')` statically visible to Metro while still landing
 * inside the try/catch.
 */
function stage(name, fn) {
  try {
    fn();
    record('OK    ' + name);
  } catch (e) {
    fails++;
    record('FAIL  ' + name + ' :: ' + shortErr(e), shortStack(e));
  }
}

record('entry start ' + new Date().toISOString());

// ------------------------------------------------------------------------------- STAGE LIST
// Startup order, most-suspected LAST so the earlier stages still get to record.
// 1) the runtime foundations
stage('react', function () {
  require('react');
});
stage('react-native', function () {
  require('react-native');
});
stage('expo', function () {
  require('expo');
});
stage('expo-constants', function () {
  require('expo-constants');
});
// 2) the real entry point: this is what master's `main` runs, and it registers the REAL router
//    root with AppRegistry. Catching it here is the highest-value line in the list. The
//    diagnostic root is registered AFTER this, so it is the one the native side renders.
stage('expo-router', function () {
  require('expo-router');
});
stage('expo-router/entry', function () {
  require('expo-router/entry');
});
// 3) packages whose JS side does work at import time
stage('react-native-screens', function () {
  require('react-native-screens');
});
stage('react-native-safe-area-context', function () {
  require('react-native-safe-area-context');
});
stage('react-native-gesture-handler', function () {
  require('react-native-gesture-handler');
});
stage('expo-notifications', function () {
  require('expo-notifications');
});
stage('expo-camera', function () {
  require('expo-camera');
});
stage('expo-image-manipulator', function () {
  require('expo-image-manipulator');
});
stage('expo-secure-store', function () {
  require('expo-secure-store');
});
stage('expo-crypto', function () {
  require('expo-crypto');
});
stage('expo-device', function () {
  require('expo-device');
});
stage('@supabase/supabase-js', function () {
  require('@supabase/supabase-js');
});
// 4) other real dependencies the app imports (a failure here is informative; these are not
//    necessarily on the startup path, so a FAIL here is a clue, not automatically the cause)
stage('expo-status-bar', function () {
  require('expo-status-bar');
});
stage('expo-font', function () {
  require('expo-font');
});
stage('expo-splash-screen', function () {
  require('expo-splash-screen');
});
stage('expo-linking', function () {
  require('expo-linking');
});
stage('expo-image', function () {
  require('expo-image');
});
stage('@react-native-async-storage/async-storage', function () {
  require('@react-native-async-storage/async-storage');
});
stage('react-native-svg', function () {
  require('react-native-svg');
});
// 5) our own modules, in the order src/app/_layout.tsx pulls them in
stage('./src/lib/diagnostics', function () {
  require('./src/lib/diagnostics');
});
stage('./src/theme/tokens', function () {
  require('./src/theme/tokens');
});
stage('./src/features/auth/AuthProvider', function () {
  require('./src/features/auth/AuthProvider');
});
// 6) finally the real root layout module itself
stage('./src/app/_layout.tsx', function () {
  require('./src/app/_layout.tsx');
});

record('stages executed: fails=' + fails);

// ------------------------------------------------------------------- the diagnostic root
/** Large, selectable lines so a FAIL + its stack can be read off the screen with no network. */
function DiagnosticScreen() {
  var R = require('react');
  var RN = require('react-native');
  var e = R.createElement;
  var body = results.join('\n\n');
  return e(
    RN.View,
    {
      style: {
        flex: 1,
        backgroundColor: '#FFFFFF',
        paddingTop: 64,
        paddingBottom: 24,
        paddingHorizontal: 14,
      },
    },
    e(
      RN.Text,
      { style: { fontSize: 16, fontWeight: 'bold', color: '#000000', marginBottom: 6 } },
      SCREEN_HEADER
    ),
    e(
      RN.Text,
      { style: { fontSize: 13, fontWeight: 'bold', color: '#000000', marginBottom: 12 } },
      fails > 0 ? fails + ' STAGE(S) FAILED — scroll for the FAIL line' : 'all stages OK'
    ),
    e(
      RN.ScrollView,
      { style: { flex: 1 } },
      e(
        RN.Text,
        { selectable: true, style: { fontSize: 14, lineHeight: 19, color: '#000000' } },
        body
      )
    )
  );
}

// Register the diagnostic root. `expo-router/entry` (stage 6) already registered `main` with the
// REAL app, so this registration intentionally replaces it: the native side runs whatever `main`
// holds once the bundle has finished evaluating.
try {
  require('expo').registerRootComponent(DiagnosticScreen);
  record('registerRootComponent(diagnostic) OK');
} catch (e) {
  record('FAIL registerRootComponent(diagnostic) :: ' + shortErr(e), shortStack(e));
  try {
    require('react-native').AppRegistry.registerComponent('main', function () {
      return DiagnosticScreen;
    });
    record('AppRegistry.registerComponent(main) fallback OK');
  } catch (e2) {
    record('FAIL AppRegistry.registerComponent(main) fallback :: ' + shortErr(e2), shortStack(e2));
  }
}

try {
  var AppRegistry = require('react-native').AppRegistry;
  if (AppRegistry && typeof AppRegistry.getAppKeys === 'function') {
    record('registered app keys: ' + AppRegistry.getAppKeys().join(','));
  }
} catch (e) {
  record('FAIL reading AppRegistry.getAppKeys() :: ' + shortErr(e));
}

// Last line on the screen — the marker that the whole entry ran to the end. Written as a literal
// (tag included) so the capture gate can find it verbatim in the emitted bundle.
record('[staged24] done');
