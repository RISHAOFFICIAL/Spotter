/**
 * SPOTTER build 25 -- RENDER-LEVEL capture entry.
 * DIAGNOSTIC ONLY: never merged to master, never attached to App Store version 1.0.
 *
 * WHY THIS BUILD EXISTS
 *   All three device crash logs we hold (builds 16, 17, 18) abort on React Native's
 *   JS-INITIATED fatal path (reportException: -> reportFatal: -> RCTFatal -> SIGABRT) and none
 *   of them carries the C++ path's "[runtime not ready]" message. RN only reaches that JS path
 *   once the runtime is ready, and the runtime is marked ready AFTER the bundle has finished
 *   evaluating. So the uncaught throw is POST-LOAD -- first render, a mount effect, or provider
 *   startup -- not module scope. Build 24 (a staged-require probe) can only see module-scope
 *   throws, which is why it is the wrong instrument for this fault.
 *
 * WHY THE OLD REPORTERS CAPTURED NOTHING
 *   Builds 20/21 wrapped ErrorUtils.setGlobalHandler and then DELEGATED the fatal back to React
 *   Native, so RN aborted the process ~0.25 s later and no alert or POST could ever complete.
 *   This entry captures and then does NOT delegate a fatal: the process survives long enough to
 *   alert, POST and paint. The app's own src/lib/diagnostics.ts hook (installed later, when the
 *   root layout module evaluates) wraps OURS and delegates to it, so the chain still ends here.
 *
 * MARKERS ARE PURE ASCII ON PURPOSE
 *   A release main.jsbundle is Hermes bytecode and Hermes stores a string as 8-bit ASCII only if
 *   EVERY character is ASCII -- one em dash and the whole literal becomes UTF-16LE, invisible to
 *   an ASCII grep. That false negative blocked build 24's first submit gate; count with
 *   /home/team/shared/bundle_count.py (ascii + utf16le) and keep gate literals ASCII.
 */
/* eslint-disable */
'use strict';

var BUILD = '25';
var TAG = '[cap25]';
// One plain ASCII literal: the submit gate greps the built Hermes bundle for exactly this string.
var BANNER = '[cap25] SPOTTER build 25 render-level capture entry';
var APP_VERSION = '1.0.0';

// ---------------------------------------------------------------- 1. React Native core first
var RN = require('react-native'); // so ErrorUtils exists before anything else can throw
if (!globalThis.ErrorUtils) {
  try {
    require('react-native/Libraries/Core/InitializeCore');
  } catch (e) {
    /* recorded below in the entry-loaded report */
  }
}
var React = require('react');

var captured = []; // { layer, message, stack, fatal, at }
var seen = {};
var forcePaint = null; // set by whichever root is rendering our capture view
var hookInstalled = false;
var ourHook = null;
var supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
var supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

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

function showAlert(title, body) {
  try {
    RN.Alert.alert(title, String(body).slice(0, 1800), [{ text: 'OK' }]);
  } catch (e) {
    /* the painted view is the fallback */
  }
}

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

/** Record + surface one uncaught error. Never throws. */
function report(layer, error, isFatal) {
  try {
    var message = toMsg(error);
    var stack = toStack(error);
    var key = layer + '|' + message;
    if (seen[key]) return;
    seen[key] = true;
    var entry = { layer: layer, message: message, stack: stack, fatal: !!isFatal, at: iso() };
    captured.push(entry);
    var text = captureText(entry);
    postDiag(TAG + ' CAPTURED ' + layer, message, stack, 'fatal=' + (isFatal ? 'yes' : 'no'));
    showAlert('SPOTTER boot capture (build 25)', text);
    // Paint only for a FATAL capture: a late non-fatal error must not cover the app's screen.
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

// -------------------------------------------------- 2. capture hook, before any app module
function installCaptureHook() {
  var g = globalThis;
  try {
    var EU = g.ErrorUtils;
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
    }
  } catch (e) {
    /* fall through to the RN$ listener below */
  }
  // Second, independent channel: RN 0.86 exposes RN$registerExceptionListener as a CALLABLE
  // read-only global (unlike RN$handleException, which defineReadOnlyGlobal makes unwritable --
  // see src/lib/diagnostics.ts). Calling it is legal; assigning to it is not.
  try {
    if (typeof g.RN$registerExceptionListener === 'function') {
      g.RN$registerExceptionListener(function (error) {
        report('[RN$listener]', error, true);
      });
    }
  } catch (e) {
    /* optional channel */
  }
}
installCaptureHook();

// ------------------------------------------------- 3. paint into the view tree if it is alive
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
class Cap25Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
    this.forceUpdate = this.forceUpdate.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { err: error };
  }
  componentDidCatch(error) {
    report('[render-boundary]', error, true);
  }
  componentDidMount() {
    forcePaint = this.forceUpdate;
  }
  componentWillUnmount() {
    if (forcePaint === this.forceUpdate) forcePaint = null;
  }
  render() {
    if (this.state.err || capturedFatal()) return React.createElement(CaptureView, null);
    return this.props.children;
  }
}

/** Fallback root, used only when the app never registered itself (module-scope throw). */
class Cap25DiagRoot extends React.Component {
  componentDidMount() {
    forcePaint = this.forceUpdate.bind(this);
  }
  render() {
    return React.createElement(CaptureView, null);
  }
}

function registerDiagRoot() {
  try {
    RN.AppRegistry.registerComponent('main', function () {
      return Cap25DiagRoot;
    });
    postDiag(TAG + ' diag root registered under main', 'build 25 diagnostic root', null, null);
  } catch (e) {
    postDiag(TAG + ' diag root registration FAILED', toMsg(e), toStack(e), null);
  }
}

// Wrap AppRegistry.registerComponent BEFORE the app graph loads, so the app's own root gets an
// error boundary above it: a first-render throw is then painted instead of killing the screen.
try {
  var origRegister = RN.AppRegistry.registerComponent;
  if (typeof origRegister === 'function' && !origRegister.__cap25) {
    var wrappedRegister = function (appKey, componentProvider, section) {
      var wrappedProvider = function () {
        var App = typeof componentProvider === 'function' ? componentProvider() : componentProvider;
        var node = typeof App === 'function' ? React.createElement(App, null) : App;
        return function Cap25Root() {
          return React.createElement(Cap25Boundary, null, node);
        };
      };
      try {
        return origRegister.call(RN.AppRegistry, appKey, wrappedProvider, section);
      } catch (e) {
        return origRegister.call(RN.AppRegistry, appKey, componentProvider, section);
      }
    };
    wrappedRegister.__cap25 = true;
    RN.AppRegistry.registerComponent = wrappedRegister;
  }
} catch (e) {
  /* the ErrorUtils hook still captures */
}

// ------------------------------------------------------ 4. the REAL app mounts (not a probe)
var entryThrew = null;
try {
  require('expo-router/entry');
} catch (e) {
  entryThrew = e;
  report('[entry-require]', e, true);
}

// ------------------------------------------------- 5. post-load state + native module probe
function appKeys() {
  try {
    return RN.AppRegistry.getAppKeys ? RN.AppRegistry.getAppKeys() : [];
  } catch (e) {
    return [];
  }
}

function chainState() {
  var top = null;
  try {
    top = globalThis.ErrorUtils && globalThis.ErrorUtils.getGlobalHandler
      ? globalThis.ErrorUtils.getGlobalHandler()
      : null;
  } catch (e) {
    /* reported as unknown */
  }
  var oursOnTop = top === ourHook;
  return (
    'hook_installed=' +
    hookInstalled +
    ' our_hook_on_top=' +
    oursOnTop +
    (oursOnTop
      ? ' (app hook not yet installed)'
      : ' (the app hook wrapped ours and delegates to it -> chain ends in ours)') +
    ' entry_threw=' +
    !!entryThrew
  );
}

function moduleProbe() {
  // Cheap, decisive on-device answer to "does the app register every module the JS asks for?".
  // The offline binary diff of build 22 flagged ExpoFontLoader / ExpoApplication / ExpoBadgeModule
  // as JS-referenced but with no literal anywhere in the IPA -- this probe settles it at runtime.
  var suspects = [
    'ExpoFontLoader',
    'ExpoFontUtils',
    'ExpoApplication',
    'ExpoBadgeModule',
    'ExpoGo',
    'EXDevLauncher',
    'ExpoSecureStore',
    'ExpoCrypto',
    'ExpoDevice',
    'FileSystem',
    'ExpoCamera',
    'ExpoImageManipulator',
    'ExpoClipboard',
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
  var state = chainState();
  postDiag(TAG + ' entry loaded ok (' + appKeys().join(',') + ')', 'build ' + BUILD + ' app JS graph loaded', null, state);
  if (entryThrew && appKeys().indexOf('main') === -1) registerDiagRoot();
  var delay = typeof setTimeout === 'function' ? 4000 : 0;
  var finish = function () {
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
    postDiag(TAG + ' native module registry', 'missing=[' + probe.missing.join(',') + ']', null, summary.slice(0, 1800));
    if (!captured.length) {
      postDiag(TAG + ' NO ERROR CAPTURED', 'build 25 opened and the app tree mounted with no uncaught error', null, state);
      showAlert(
        'SPOTTER build 25 opened',
        'Build 25 opened with NO startup error captured.\n\nNative modules registered: ' +
          probe.registry.length +
          '\nMissing (JS asks, app cannot provide): ' +
          (probe.missing.length ? probe.missing.join(', ') : 'none') +
          '\n\nThe result was sent automatically. Tap OK to use the app.',
      );
    }
  };
  if (delay) setTimeout(finish, delay);
  else finish();
}

try {
  afterLoad();
} catch (e) {
  report('[after-load]', e, true);
}
