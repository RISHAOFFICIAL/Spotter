#!/usr/bin/env node
/*
 * signout-feed-labels-guard — the offline gate for the two app-source changes
 * batched for the next build (2026-10-05):
 *
 *   A. THE OWNER'S SIGN-OUT DIRECTIVE — "so the owner can switch accounts
 *      without deleting and reinstalling". Until now the ONLY `signOut()` call
 *      in the app sat inside the SUCCESSFUL account-deletion handler, so the
 *      only way to change accounts was to delete the app.
 *   B. THE FEED CAPTION BUG — FeedCard hardcoded 'YOU' / 'YOUR SPOT' on every
 *      log's thumbnails, so a CO-MEMBER's card claimed to be you while the
 *      author name next to it correctly showed the co-member's name.
 *
 * WHY THIS GUARD RENDERS INSTEAD OF GREPPING: both defects are ELEMENT-TREE
 * facts. "A control exists and is wired" and "this string is not in the card"
 * cannot be decided by reading source text — a string can be present but never
 * rendered, a handler can be attached to a control that is not a button, and a
 * label can be built from a helper at render time. So this guard MOUNTS the REAL
 * `src/features/profile/ProfileScreen.tsx` and the REAL
 * `src/features/home/FeedCard.tsx` in plain Node (leaf stubs only, a mini
 * hooks runtime, no reconciler, no Metro, no device) and asserts on the tree
 * that actually ships — the same technique as
 * scripts/smoke/auth-gate-guard.cjs and scripts/smoke/bottom-bar-guard.cjs.
 * Static source checks are used ONLY where the check is about a declaration
 * (e.g. "the delete handler's copy is unchanged"), never where it is about
 * behaviour.
 *
 * WHAT IT PROVES
 *   A1  the Profile surface renders a clearly labelled Sign out control, wired
 *       to a handler, under a section header that is NOT the DANGER ZONE block
 *       (the two can never be confused: neither is inside the other's section),
 *       and its ink is text.primary — volt is a fill, never an ink (PR #49);
 *   A2  nothing happens on the tap: the session is cleared only after a
 *       confirmation step, and the confirmation offers a real Cancel that
 *       leaves the account signed in;
 *   A3  confirming calls the auth `signOut` exactly once and then returns to the
 *       route the app's own session gate sends a signed-out user to
 *       (RequireSession.SIGNED_OUT_ROUTE — one name for one destination);
 *   A4  HONEST FAILURE, both shapes: a `signOut` that throws, and a `signOut`
 *       that resolves while the stored session SURVIVES (the offline case: the
 *       app cannot tell "cleared" from "cleared locally but the write failed").
 *       Neither may be a silent no-op: the failure is rendered, the control is
 *       re-enabled, and the user is NOT navigated away as if it had worked.
 *       The control is then retryable — a second attempt really runs again;
 *   A5  IN-FLIGHT SAFETY: a write that is still pending when the user signs out
 *       (the miss-note Save) resolves AFTER the screen is gone and must not
 *       write state onto the torn-down screen and must not throw. The harness
 *       models the real teardown (the root Gate swaps the Stack when the
 *       session clears, unmounting this screen) and treats a post-unmount
 *       state write as a defect even though React 19 no-ops it — a silent no-op
 *       is exactly how this class of bug hides on a device;
 *   A6  the DELETE-ACCOUNT flow is unchanged: its control, its confirm copy, its
 *       single-tap guard, the one `deleteAccount()` + one `signOut()` + the
 *       welcome replacement, and the volt-ink-free success-message line the
 *       bottom-bar guard pins. Sign-out must not have been wired through it;
 *   B1  a co-member's FeedCard does NOT render 'YOU' or 'YOUR SPOT' anywhere,
 *       still renders the author's name and both thumbnails, and carries the
 *       viewer-relative labels the app's own helper derives;
 *   B2  the OWNER's own card still renders 'YOU' / 'YOUR SPOT' (the fix must
 *       remove the false claim, not the true one);
 *   B3  static: FeedCard.tsx carries no hardcoded 'YOU' literal — the labels
 *       come from src/lib/workouts.ts, the module the feed's own helpers live
 *       in.
 *
 * NEGATIVE CONTROLS (run it, do not trust it)
 *   - In-file: the pre-fix FeedCard shape (hardcoded 'YOU' for every log) is
 *     handed to the SAME analyser the passing checks use, and must be reported
 *     as claiming YOU. A gate that cannot fail is not a gate.
 *   - End-to-end: this file is committed on the fix branch together with the
 *     fix, so the pre-fix FAIL was captured by running this guard BEFORE the
 *     source changes, directly and without a pipe:
 *       node scripts/smoke/signout-feed-labels-guard.cjs ; echo "exit $?"
 *     Raw output is recorded in
 *     /home/team/shared/signout-feed-labels-2026-10-05.md.
 *
 * NOT covered here (stated so a green run is not read as more than it is):
 * anything needing a real device — the native alert actually appearing, the tap
 * targets, and the fact that the next account's Home does not briefy show the
 * previous account's data. The last one is proved here only to the extent that
 * this screen's own torn-down state cannot be written; the Gate swap, RLS
 * scoping and the fresh fetch are TestFlight checks.
 *
 * RUN:  node scripts/smoke/signout-feed-labels-guard.cjs     (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const React = require('react');

// --------------------------------------------------------------------------
// ENV SANITISATION — above every require of an app module. src/lib/supabase.ts
// decides DEV MOCK vs REAL at module load from these two vars; a shell that
// happens to have them exported must not change this guard's verdict. Same
// precedent (and same reason) as app-version-guard.cjs:76-84 and
// bottom-bar-guard.cjs:81-82. Do NOT remove in a cleanup pass.
// --------------------------------------------------------------------------
delete process.env.EXPO_PUBLIC_SUPABASE_URL;
delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_SRC = path.join(ROOT, 'src', 'features', 'profile', 'ProfileScreen.tsx');
const FEED_CARD_SRC = path.join(ROOT, 'src', 'features', 'home', 'FeedCard.tsx');
const WORKOUTS_LIB = path.join(ROOT, 'src', 'lib', 'workouts.ts');
const SECTIONS = ['ACCOUNT', 'SIGN OUT', 'GROUP', 'PROMISES', 'NOTIFICATIONS', 'DANGER ZONE'];

// --------------------------------------------------------------------------
// reporter — one PASS/FAIL line per check (run_smoke.py counts them)
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function oneLine(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s*\n\s*/g, ' | ')
    .slice(0, 500);
}
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${oneLine(detail)}` : ''}`);
}

// --------------------------------------------------------------------------
// the mutable test doubles (reset per case)
// --------------------------------------------------------------------------
const ROUTER = { replaced: [], pushed: [], replace(href) { ROUTER.replaced.push(href); }, push(href) { ROUTER.pushed.push(href); }, back() { ROUTER.backCalls += 1; }, backCalls: 0 };
const ALERTS = [];
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
let SIGN_OUT_CALLS = 0;
let DELETE_CALLS = 0;
let SIGN_OUT_IMPL = async () => undefined;      // the auth provider's signOut
let STORED_SESSION = null;                       // what getStoredSession() reports
let WEEKLY_CTX = {
  ok: true,
  context: { members: [{ id: 'u2', firstName: 'Rish', displayName: 'Rish' }], teamName: 'Team Us', groupCreatorId: 'u1' },
};
let SAVE_MISS_DEFERRED = [];                     // resolvers for a pending setMissNote
let SAVE_MISS_MODE = 'immediate';
const POST_UNMOUNT_WRITES = [];
const UNHANDLED = [];
function dbg(...args) {
  if (process.env.SIGNOUT_GUARD_DEBUG) console.error('[debug]', ...args);
}
process.on('unhandledRejection', (error) => {
  UNHANDLED.push((error && error.message) || String(error));
});

function resetCase() {
  ROUTER.replaced.length = 0;
  ROUTER.pushed.length = 0;
  ROUTER.backCalls = 0;
  ALERTS.length = 0;
  SIGN_OUT_CALLS = 0;
  DELETE_CALLS = 0;
  POST_UNMOUNT_WRITES.length = 0;
  UNHANDLED.length = 0;
  SIGN_OUT_IMPL = async () => undefined;
  STORED_SESSION = null;
  SAVE_MISS_DEFERRED = [];
  SAVE_MISS_MODE = 'immediate';
  WEEKLY_CTX = {
    ok: true,
    context: { members: [{ id: 'u2', firstName: 'Rish', displayName: 'Rish' }], teamName: 'Team Us', groupCreatorId: 'u1' },
  };
}

// --------------------------------------------------------------------------
// mini render runtime: hooks + full-tree re-render, no reconciler
// (same shape as auth-gate-guard.cjs — read that file's comments for why this
// is enough to catch a defect that is purely a tree fact)
// --------------------------------------------------------------------------
const STORES = new Map();
let CURRENT_STORE = null;
let FLUSH_QUEUE = [];
let PENDING_RERENDER = null;

function storeFor(key) {
  let store = STORES.get(key);
  if (!store) {
    store = { key, hooks: [], cleanups: [], cursor: 0, effects: [], effectsRan: false, unmounted: false, rerender: () => {} };
    STORES.set(key, store);
  }
  return store;
}
function useStore(what) {
  if (!CURRENT_STORE) throw new Error(`${what} called outside a render`);
  return CURRENT_STORE;
}

const Hooks = {
  useState(init) {
    const store = useStore('useState');
    const i = store.cursor++;
    if (!(i in store.hooks)) store.hooks[i] = typeof init === 'function' ? init() : init;
    const set = (value) => {
      if (store.unmounted) {
        // A state write onto a screen the Gate already tore down. React 19
        // silences this; the guard does not, because "nobody noticed" is how
        // this class of bug ships.
        POST_UNMOUNT_WRITES.push(store.key);
        throw new Error('setState after the screen was unmounted (signed out)');
      }
      const current = store.hooks[i];
      const next = typeof value === 'function' ? value(current) : value;
      if (Object.is(next, current)) return;
      store.hooks[i] = next;
      store.rerender();
    };
    return [store.hooks[i], set];
  },
  useRef(init) {
    const store = useStore('useRef');
    const i = store.cursor++;
    if (!(i in store.hooks)) store.hooks[i] = { current: init };
    return store.hooks[i];
  },
  useMemo(fn) {
    useStore('useMemo').cursor += 1;
    return fn();
  },
  useCallback(fn) {
    useStore('useCallback').cursor += 1;
    return fn;
  },
  useEffect(fn) {
    const store = useStore('useEffect');
    store.cursor += 1;
    if (!store.effectsRan) store.effects.push(fn);
  },
};
Hooks.useLayoutEffect = Hooks.useEffect;

function reactStub() {
  const stub = { __esModule: true };
  for (const key of Object.keys(React)) stub[key] = React[key];
  stub.default = stub;
  stub.useState = Hooks.useState;
  stub.useRef = Hooks.useRef;
  stub.useMemo = Hooks.useMemo;
  stub.useCallback = Hooks.useCallback;
  stub.useEffect = Hooks.useEffect;
  stub.useLayoutEffect = Hooks.useEffect;
  return stub;
}

function nameOf(type) {
  if (typeof type === 'string') return type;
  return (type && type.name) || 'anonymous';
}

function expandChildren(children, pathStr) {
  return React.Children.toArray(children).map((child, i) => expand(child, `${pathStr}.${i}`));
}

function expand(node, pathStr) {
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((child, i) => expand(child, `${pathStr}.${i}`));
  if (!React.isValidElement(node)) return node;
  const { type, props } = node;
  if (typeof type === 'string') {
    if (props.children === undefined) return node;
    return React.cloneElement(node, {}, expandChildren(props.children, pathStr));
  }
  if (type === React.Fragment) {
    return React.cloneElement(node, {}, expandChildren(props.children, pathStr));
  }
  if (typeof type === 'function') {
    const name = nameOf(type);
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props);
      instance.props = props;
      if (!instance.state) instance.state = {};
      return expand(instance.render(), `${pathStr}|${name}out`);
    }
    const store = storeFor(`${pathStr}|${name}`);
    store.rerender = () => {
      if (PENDING_RERENDER) PENDING_RERENDER();
    };
    const previous = CURRENT_STORE;
    CURRENT_STORE = store;
    store.cursor = 0;
    let out;
    try {
      out = type(props);
    } finally {
      CURRENT_STORE = previous;
    }
    FLUSH_QUEUE.push(store);
    return expand(out, `${pathStr}|${name}out`);
  }
  return node;
}

function flushEffects() {
  const queue = FLUSH_QUEUE.slice();
  FLUSH_QUEUE = [];
  if (process.env.SIGNOUT_GUARD_DEBUG) console.error(`[debug] flushEffects queue=${queue.length} keys=${queue.map((s) => s.key).join(',')} pending=${queue.filter((s) => !s.effectsRan).length}`);
  for (const store of queue) {
    if (store.effectsRan) continue;
    store.effectsRan = true;
    const fns = store.effects.slice();
    store.effects = [];
    for (const fn of fns) {
      const cleanup = fn();
      // React runs an effect's returned cleanup on unmount — and the app's own
      // "still mounted?" flag is set false THERE. A harness that unmounts
      // without running cleanups would fail the app for a guard's own omission.
      if (typeof cleanup === 'function') store.cleanups.push(cleanup);
    }
  }
}

/** Mount `Component` as the root; `unmount()` models the Gate swapping the
 *  Stack when the session clears (the screen really does go away). */
function mountRoot(Component, props) {
  STORES.clear();
  const store = storeFor('root');
  const api = {
    raw: null,
    tree: null,
    renders: 0,
    unmounted: false,
    render() {
      PENDING_RERENDER = () => api.render();
      store.rerender = () => api.render();
      FLUSH_QUEUE = [];
      const previous = CURRENT_STORE;
      CURRENT_STORE = store;
      store.cursor = 0;
      let out;
      try {
        out = Component(props);
      } finally {
        CURRENT_STORE = previous;
      }
      api.renders += 1;
      api.raw = out;
      api.tree = expand(out, 'root');
      // The ROOT component is invoked above, not by expand(), so its own store
      // is not in the queue — and the screen under test IS the root here. Its
      // effects (the real ProfileScreen's load effect) must run like any other.
      FLUSH_QUEUE.push(store);
      flushEffects();
      return api.tree;
    },
    unmount() {
      // Faithful teardown: React runs each effect's cleanup first (which is
      // where the app's own "still mounted?" flag goes false), and only THEN is
      // the component gone. Any state write from here on is the defect this
      // guard exists to catch.
      for (const s of STORES.values()) {
        const fns = s.cleanups.splice(0);
        for (const fn of fns.reverse()) fn();
      }
      api.unmounted = true;
      for (const s of STORES.values()) s.unmounted = true;
    },
  };
  return api;
}

// --------------------------------------------------------------------------
// module loading: REAL .tsx/.ts sources, leaf deps stubbed
// --------------------------------------------------------------------------
function transpile(file) {
  const src = fs.readFileSync(file, 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: file,
  }).outputText;
}

function flattenStyle(style) {
  const out = {};
  const add = (value) => {
    if (!value) return;
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === 'object') Object.assign(out, value);
  };
  add(style);
  return out;
}

function RNStub() {
  return {
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    TextInput: 'TextInput',
    Modal: 'Modal',
    Switch: 'Switch',
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    SafeAreaView: 'SafeAreaView',
    KeyboardAvoidingView: 'KeyboardAvoidingView',
    Platform: { OS: 'ios', select: (o) => (o && o.ios) || undefined },
    StyleSheet: { create: (s) => s, flatten: flattenStyle },
    Dimensions: { get: () => ({ width: 390, height: 844 }) },
    Linking: { openSettings: () => Promise.resolve() },
    Alert: {
      alert: (...args) => {
        ALERTS.push(args);
      },
    },
  };
}

/** The app's own auth surface, faked at its boundary: `signOut` is the only
 *  thing the screen may call, and it is countable. */
const AUTH_SESSION = { user: { id: 'u1', email: 'owner@spotterworkout.com', createdAt: '2026-10-05T00:00:00Z' } };

function appStubs() {
  return {
    react: reactStub(),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': RNStub(),
    'react-native-safe-area-context': {
      SafeAreaView: 'SafeAreaView',
      useSafeAreaInsets: () => INSETS,
    },
    'expo-router': {
      useRouter: () => ROUTER,
      Redirect: (props) => React.createElement('Redirect', props),
      Stack: (props) => React.createElement('Stack', props),
      Tabs: (props) => React.createElement('Tabs', props),
    },
    'expo-image': { Image: (props) => React.createElement('ExpoImage', props) },
    '@expo/vector-icons': { Ionicons: (props) => React.createElement('Ionicons', props) },
    '@/features/auth/AuthProvider': {
      useAuth: () => ({
        session: AUTH_SESSION,
        profile: { id: 'u1', email: AUTH_SESSION.user.email, name: 'Owner' },
        isLoading: false,
        isDevMode: false,
        refresh: async () => undefined,
        signOut: async () => {
          SIGN_OUT_CALLS += 1;
          return SIGN_OUT_IMPL();
        },
      }),
      AuthProvider: (props) => props.children,
      SplashLoading: () => null,
    },
    // Only the session READ is faked; the screen is allowed to ask "is the
    // session actually gone?" after calling signOut.
    '@/lib/supabase': {
      getStoredSession: async () => STORED_SESSION,
      isDevMode: false,
      supabase: null,
    },
    '@/lib/workoutStore': {
      fetchWeeklyContext: async () => {
        dbg('fetchWeeklyContext called');
        return WEEKLY_CTX;
      },
      removeWorkout: async () => ({ ok: true }),
      logWorkout: async () => ({ ok: false }),
    },
    '@/lib/accountDeletion': {
      deleteAccount: async () => {
        DELETE_CALLS += 1;
        return { ok: true, message: 'Account deleted. Sorry to see you go.' };
      },
    },
    '@/lib/invites': { leaveGroup: async () => ({ ok: true }) },
    '@/lib/naming': {
      getPetNames: async () => ({}),
      setPetNameFor: async () => undefined,
      setTeamName: async () => ({ ok: true }),
    },
    '@/lib/missPromise': {
      getMissPromise: async () => null,
      getMissWitnessId: async () => null,
      setMissNote: async () => {
        if (SAVE_MISS_MODE === 'defer') {
          await new Promise((resolve) => SAVE_MISS_DEFERRED.push(resolve));
        }
        return { ok: true, witnessId: null };
      },
      MISS_PROMISE_MAX: 80,
    },
    '@/lib/promises': {
      getOpenPromiseCount: async () => 0,
      PROFILE_PROMISES_CAPTION: 'Kept, open, and let-go promises with your group.',
      PROFILE_MISS_CAPTION: 'Only the person you pick sees this, and only if you miss the week.',
      MISSSET_TO_ROW_LABEL: 'To: {Name}',
      SOLO_PAIR_UP_FIRST: 'Pair up first — promises are between you and someone in your group.',
      visibleOnlyToLine: () => 'Visible to you and them only.',
    },
    '@/lib/notificationPrefs': {
      getNotificationPrefs: async () => ({ missed_week: false, partner_logged: true, weekly_recap: true, invite_accepted: true }),
      setNotificationPref: async () => ({ ok: true }),
      NOTIFICATION_TYPES: ['missed_week', 'partner_logged', 'weekly_recap', 'invite_accepted'],
      NOTIFICATION_META: {
        missed_week: { label: 'Missed week', caption: 'A nudge if you are behind.' },
        partner_logged: { label: 'Partner logged', caption: 'When someone in your group logs.' },
        weekly_recap: { label: 'Weekly recap', caption: 'Your week in one line.' },
        invite_accepted: { label: 'Invite accepted', caption: 'When your code is used.' },
      },
    },
  };
}

function makeLoader(stubs) {
  const cache = new Map();
  const SOURCE_EXT = ['.tsx', '.ts', '.js'];
  function resolveFile(file) {
    if (path.extname(file)) return fs.existsSync(file) ? file : null;
    for (const ext of SOURCE_EXT) if (fs.existsSync(file + ext)) return file + ext;
    return null;
  }
  function loadFile(file) {
    const resolved = resolveFile(file);
    if (!resolved) throw new Error(`cannot resolve module: ${file}`);
    if (cache.has(resolved)) return cache.get(resolved);
    if (!SOURCE_EXT.includes(path.extname(resolved))) {
      cache.set(resolved, {});
      return {};
    }
    const src = transpile(resolved);
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${resolved}`);
    fn(makeRequire(resolved), mod, mod.exports, path.dirname(resolved), resolved);
    cache.set(resolved, mod.exports);
    return mod.exports;
  }
  const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ttf|otf|mp3|m4a|mp4|wav|json)$/i;
  function makeRequire(fromFile) {
    return (id) => {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      if (ASSET_RE.test(id)) return {};
      if (id.startsWith('@/')) return loadFile(path.join(ROOT, 'src', id.slice(2)));
      const resolved = resolveFile(path.resolve(path.dirname(fromFile), id));
      if (resolved) return loadFile(resolved);
      throw new Error(`unstubbed require from ${path.relative(ROOT, fromFile)}: ${id}`);
    };
  }
  return { loadFile };
}

const memo = {};
function once(key, factory) {
  if (!(key in memo)) {
    try {
      memo[key] = { ok: true, value: factory() };
    } catch (error) {
      memo[key] = { ok: false, error: `${error.name}: ${error.message}` };
    }
  }
  const entry = memo[key];
  if (!entry.ok) throw new Error(entry.error);
  return entry.value;
}

// --------------------------------------------------------------------------
// THE GUARD'S OWN EXPECTATIONS, and why they are written down here
//
// The UI checks below must be able to FAIL FOR THE RIGHT REASON on the pre-fix
// tree — and on that tree the copy constants and the label helper do not exist
// yet, so a guard that sourced every expected string from those modules would
// report "module missing" for every check and prove nothing about behaviour.
// So the expectations live here, and TWO SEPARATE CONTRACT CHECKS hold the
// shipped modules to them: if the product copy or the derived labels are ever
// changed on purpose, the guard fails until this file is updated with the new
// copy — which is the point of a gate.
// --------------------------------------------------------------------------
const EXPECTED_COPY = {
  SIGN_OUT_CONTROL_LABEL: 'Sign out',
  SIGN_OUT_CAPTION: 'You can sign back in anytime. Nothing is deleted.',
  SIGN_OUT_CONFIRM_TITLE: 'Sign out?',
  SIGN_OUT_CONFIRM_BODY: 'You can sign back in anytime with your email and password.',
  SIGN_OUT_CONFIRM_ACTION: 'Sign out',
  SIGN_OUT_CANCEL_ACTION: 'Cancel',
  SIGN_OUT_FAILED_MESSAGE: 'Couldn\u2019t sign out. Try again.',
};
const EXPECTED_FEED_LABELS = {
  mine: { self: 'YOU', spot: 'YOUR SPOT' },
  coMember: { self: 'THEM', spot: 'THEIR SPOT' },
};

/** The real ProfileScreen, stubbing only its leaf boundaries. */
function profileLoader() {
  return once('profile', () => {
    const loader = makeLoader(appStubs());
    return {
      ProfileScreen: loader.loadFile(PROFILE_SRC).ProfileScreen,
      tokens: loader.loadFile(path.join(ROOT, 'src', 'theme', 'tokens.ts')),
    };
  });
}

/** The real FeedCard + the feed's own lib helpers. */
function feedLoader() {
  return once('feed', () => {
    const loader = makeLoader(appStubs());
    return {
      FeedCard: loader.loadFile(FEED_CARD_SRC).FeedCard,
      workouts: loader.loadFile(WORKOUTS_LIB),
    };
  });
}

/** The shipped copy modules / route constant — read from source, never retyped
 *  beyond the expectations above (the contract checks compare the two). */
function contractLoader() {
  return once('contract', () => {
    const loader = makeLoader(appStubs());
    return {
      accountCopy: loader.loadFile(path.join(ROOT, 'src', 'lib', 'accountCopy.ts')),
      RequireSession: loader.loadFile(path.join(ROOT, 'src', 'features', 'auth', 'RequireSession.tsx')),
    };
  });
}

// --------------------------------------------------------------------------
// tree helpers
// --------------------------------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!React.isValidElement(node)) return;
  visit(node);
  walk(node.props.children, visit);
}

function textList(node) {
  const out = [];
  (function walkText(n) {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walkText);
      return;
    }
    if (!React.isValidElement(n)) return;
    walkText(n.props.children);
  })(node);
  return out;
}

function joinText(node) {
  return textList(node).join(' | ');
}

/** Document-ordered items: every element and every text node, in render order.
 *  This is how "which section is this control in?" is decided — the platform's
 *  own notion of document order, not a guess from style names. */
function documentOrder(tree) {
  const items = [];
  let index = 0;
  (function visit(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      items.push({ kind: 'text', text: String(node), index: index++ });
      return;
    }
    if (!React.isValidElement(node)) return;
    items.push({ kind: 'el', el: node, index: index++ });
    visit(node.props.children);
  })(tree);
  return items;
}

function sectionOfControl(order, controlIndex) {
  let section = null;
  for (const item of order) {
    if (item.index >= controlIndex) break;
    if (item.kind === 'text' && SECTIONS.includes(item.text.trim())) section = item.text.trim();
  }
  return section;
}

function findByLabel(node, label) {
  let hit = null;
  walk(node, (el) => {
    if (!hit && el.props && el.props.accessibilityLabel === label) hit = el;
  });
  return hit;
}

function findText(node, text) {
  let hit = null;
  walk(node, (el) => {
    if (!hit && el.type === 'Text' && joinText(el) === text) hit = el;
  });
  return hit;
}

function findPressables(node) {
  const out = [];
  walk(node, (el) => {
    if (el.props && typeof el.props.onPress === 'function') out.push(el);
  });
  return out;
}

function flushMicrotasks(rounds = 6) {
  let chain = Promise.resolve();
  for (let i = 0; i < rounds; i += 1) chain = chain.then(() => new Promise((r) => setTimeout(r, 0)));
  return chain;
}

/**
 * Source with comments removed. The static checks below ask what the code DOES,
 * and every fix here carries a comment quoting the retired code and the retired
 * label — a check that reads raw text would fail on the explanation of the fix.
 * (Block and line comments; the app has no strings containing '//'.)
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// --------------------------------------------------------------------------
// the analysis functions — used for BOTH the real trees and the negative control
// --------------------------------------------------------------------------

/** Mount the REAL ProfileScreen and hand back the mount + its tree. */
async function mountProfile() {
  const { ProfileScreen } = profileLoader();
  const mounted = mountRoot(ProfileScreen, {});
  mounted.render();
  await flushMicrotasks();
  mounted.render();
  if (process.env.SIGNOUT_GUARD_DEBUG) {
    console.error(`[debug] renders=${mounted.renders} unhandled=${JSON.stringify(UNHANDLED)} weeklyTexts=${joinText(mounted.tree).slice(0, 120)}`);
  }
  return mounted;
}

/** The confirm button the app raised through the iOS-standard alert, by label. */
function alertButton(label) {
  const alert = ALERTS[ALERTS.length - 1];
  if (!alert) return null;
  const buttons = alert[2] || [];
  return buttons.find((b) => b && b.text === label) || null;
}

function lastAlert() {
  const alert = ALERTS[ALERTS.length - 1];
  if (!alert) return null;
  return { title: alert[0], message: alert[1], buttons: alert[2] || [] };
}

/**
 * The core feed analysis: does this card claim the viewer took the log?
 * `labelSource(log, session)` returns the two thumb captions the component would
 * use — passed in so the SAME analysis can be pointed at the pre-fix shape.
 */
function feedCardFacts(log) {
  const { FeedCard } = feedLoader();
  const mounted = mountRoot(FeedCard, { log, now: new Date('2026-10-05T12:00:00Z') });
  const tree = mounted.render();
  const texts = textList(tree);
  const thumbs = [];
  walk(tree, (el) => {
    // Exactly the two thumb controls (the full-screen viewer's tab controls
    // carry the same captions but are labelled "… (1 of 2)" etc.).
    const a11y = el.props && el.props.accessibilityLabel;
    if (el.type === 'Pressable' && (a11y === 'View photo' || a11y === 'View environment photo')) {
      const label = el.props.children.find((child) => React.isValidElement(child) && child.type === 'Text');
      thumbs.push({ a11y, label: label ? joinText(label) : null });
    }
  });
  return {
    texts,
    thumbs,
    claimsYou: texts.includes('YOU'),
    claimsYourSpot: texts.includes('YOUR SPOT'),
    authorShown: texts.includes(log.authorName),
    text: texts.join(' / '),
  };
}

/** The pre-fix shape, for the in-file negative control: labels hardcoded. */
function preFixFacts(log) {
  const mounted = mountRoot(function PreFixFeedCard() {
    return React.createElement(
      'View',
      null,
      [log.photoUri ? 'YOU' : null, log.photoEnvUri ? 'YOUR SPOT' : null].filter(Boolean).map((label, i) =>
        React.createElement('Text', { key: i }, label),
      ),
    );
  }, {});
  const tree = mounted.render();
  const texts = textList(tree);
  return { texts, claimsYou: texts.includes('YOU') };
}

const CO_MEMBER_LOG = {
  id: 'w2',
  userId: 'u2',
  photoPath: 'u2/w2.jpg',
  photoEnv: 'u2/w2-env.jpg',
  loggedAt: '2026-10-05T09:30:00Z',
  workoutType: 'Run',
  caption: 'Morning loop',
  authorName: 'Rish',
  photoUri: 'https://example.invalid/u2/w2.jpg',
  photoEnvUri: 'https://example.invalid/u2/w2-env.jpg',
};

const OWN_LOG = {
  ...CO_MEMBER_LOG,
  id: 'w1',
  userId: 'u1',
  authorName: 'Owner',
  photoPath: 'u1/w1.jpg',
  photoEnv: 'u1/w1-env.jpg',
  photoUri: 'https://example.invalid/u1/w1.jpg',
  photoEnvUri: 'https://example.invalid/u1/w1-env.jpg',
};

// --------------------------------------------------------------------------
// the checks — a FIXED list; every entry prints exactly one line
// --------------------------------------------------------------------------
const CHECKS = [
  {
    name: 'contract: the shipped sign-out copy is EXACTLY the copy this gate asserts',
    run() {
      const { accountCopy } = contractLoader();
      const wrong = Object.entries(EXPECTED_COPY).filter(([key, value]) => accountCopy[key] !== value);
      const missing = Object.entries(EXPECTED_COPY)
        .filter(([key]) => typeof accountCopy[key] !== 'string')
        .map(([key]) => key);
      return {
        ok: wrong.length === 0 && missing.length === 0,
        detail:
          wrong.length || missing.length
            ? `mismatch=${wrong.map(([k, v]) => `${k}: expected ${JSON.stringify(v)} got ${JSON.stringify(accountCopy[k])}`).join(' | ')} missing=[${missing.join(',')}]`
            : `${Object.keys(EXPECTED_COPY).length} strings match src/lib/accountCopy.ts`,
      };
    },
  },
  {
    name: 'contract: the app has ONE signed-out destination, and it is /(auth)/welcome',
    run() {
      const { RequireSession } = contractLoader();
      return {
        ok: RequireSession.SIGNED_OUT_ROUTE === '/(auth)/welcome',
        detail: `RequireSession.SIGNED_OUT_ROUTE=${RequireSession.SIGNED_OUT_ROUTE}`,
      };
    },
  },
  {
    name: 'contract: the shipped feed labels are EXACTLY the viewer-relative labels this gate asserts',
    run() {
      const { workouts } = feedLoader();
      const mine = workouts.feedThumbLabels(true);
      const theirs = workouts.feedThumbLabels(false);
      return {
        ok:
          mine.self === EXPECTED_FEED_LABELS.mine.self &&
          mine.spot === EXPECTED_FEED_LABELS.mine.spot &&
          theirs.self === EXPECTED_FEED_LABELS.coMember.self &&
          theirs.spot === EXPECTED_FEED_LABELS.coMember.spot,
        detail: `mine=${JSON.stringify(mine)} coMember=${JSON.stringify(theirs)} expected=${JSON.stringify(EXPECTED_FEED_LABELS)}`,
      };
    },
  },

  // ---------------------------- A. SIGN OUT --------------------------------
  {
    name: 'A1 ui: the Profile surface renders a labelled Sign out control, wired to a handler',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      return {
        ok: !!control && typeof control.props.onPress === 'function',
        detail: control
          ? `label=${copy.SIGN_OUT_CONTROL_LABEL} role=${control.props.accessibilityRole} handler=${typeof control.props.onPress}`
          : `no control with accessibilityLabel "${copy.SIGN_OUT_CONTROL_LABEL}"; texts=${joinText(mounted.tree).slice(0, 240)}`,
      };
    },
  },
  {
    name: 'A1 ui: the Sign out control is NOT in the DANGER ZONE block (neither can be mistaken for the other)',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const order = documentOrder(mounted.tree);
      const signOut = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      const del = findByLabel(mounted.tree, 'Delete account');
      if (!signOut || !del) {
        return { ok: false, detail: `signOut=${!!signOut} delete=${!!del}` };
      }
      const signOutAt = order.findIndex((i) => i.kind === 'el' && i.el === signOut);
      const delAt = order.findIndex((i) => i.kind === 'el' && i.el === del);
      const signOutSection = sectionOfControl(order, order[signOutAt].index);
      const delSection = sectionOfControl(order, order[delAt].index);
      return {
        ok: signOutSection !== 'DANGER ZONE' && delSection === 'DANGER ZONE' && signOutAt < delAt,
        detail: `signOut section=${signOutSection} at ${signOutAt} | delete section=${delSection} at ${delAt}`,
      };
    },
  },
  {
    name: 'A1 ink: the Sign out label is text.primary — volt is a fill, never an ink (PR #49)',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const { tokens } = profileLoader();
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control' };
      const label = walkFind(control, (el) => el.type === 'Text' && joinText(el) === copy.SIGN_OUT_CONTROL_LABEL);
      const color = label ? flattenStyle(label.props.style).color : undefined;
      return {
        ok: color === tokens.colors.text.primary.hex,
        detail: `ink=${color} expected=${tokens.colors.text.primary.hex} (volt=${tokens.colors.brand.primary.hex} must never be an ink)`,
      };
    },
  },
  {
    name: 'A2 ui: the tap does NOT sign out — a confirmation step comes first, with a real Cancel',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: `no Sign out control; texts=${joinText(mounted.tree).slice(0, 200)}` };
      control.props.onPress();
      const alert = lastAlert();
      const cancel = alertButton(copy.SIGN_OUT_CANCEL_ACTION);
      const confirm = alertButton(copy.SIGN_OUT_CONFIRM_ACTION);
      return {
        ok:
          SIGN_OUT_CALLS === 0 &&
          ROUTER.replaced.length === 0 &&
          !!alert &&
          alert.title === copy.SIGN_OUT_CONFIRM_TITLE &&
          !!cancel &&
          !!confirm,
        detail: `signOutCalls=${SIGN_OUT_CALLS} routed=${JSON.stringify(ROUTER.replaced)} alert=${alert ? JSON.stringify(alert.title) : null} cancel=${!!cancel} confirm=${!!confirm}`,
      };
    },
  },
  {
    name: 'A2 ui: Cancel leaves the account signed in (no signOut, no navigation)',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control' };
      control.props.onPress();
      const cancel = alertButton(copy.SIGN_OUT_CANCEL_ACTION);
      if (cancel && typeof cancel.onPress === 'function') await cancel.onPress();
      await flushMicrotasks();
      return {
        ok: SIGN_OUT_CALLS === 0 && ROUTER.replaced.length === 0,
        detail: `cancelHasHandler=${!!(cancel && typeof cancel.onPress === 'function')} signOutCalls=${SIGN_OUT_CALLS} routed=${JSON.stringify(ROUTER.replaced)}`,
      };
    },
  },
  {
    name: 'A3 behaviour: confirming calls the auth signOut exactly once, then goes to the signed-out route',
    run: async () => {
      resetCase();
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control' };
      control.props.onPress();
      const confirm = alertButton(copy.SIGN_OUT_CONFIRM_ACTION);
      if (!confirm || typeof confirm.onPress !== 'function') return { ok: false, detail: 'no confirm action' };
      await confirm.onPress();
      await flushMicrotasks();
      mounted.unmount();
      const expected = contractLoader().RequireSession.SIGNED_OUT_ROUTE;
      return {
        ok: SIGN_OUT_CALLS === 1 && ROUTER.replaced.length === 1 && ROUTER.replaced[0] === expected,
        detail: `signOutCalls=${SIGN_OUT_CALLS} routed=${JSON.stringify(ROUTER.replaced)} expected=${expected}`,
      };
    },
  },
  {
    name: 'A4 honesty: a signOut that THROWS is surfaced, re-enabled and never navigates away',
    run: async () => {
      resetCase();
      SIGN_OUT_IMPL = async () => {
        throw new Error('Network request failed');
      };
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control to press' };
      control.props.onPress();
      const confirm = alertButton(copy.SIGN_OUT_CONFIRM_ACTION);
      await confirm.onPress();
      await flushMicrotasks();
      const tree = mounted.render();
      const texts = textList(tree);
      const after = findByLabel(tree, copy.SIGN_OUT_CONTROL_LABEL);
      return {
        ok: texts.includes(copy.SIGN_OUT_FAILED_MESSAGE) && !!after && after.props.disabled !== true && ROUTER.replaced.length === 0,
        detail: `message=${texts.includes(copy.SIGN_OUT_FAILED_MESSAGE)} controlBack=${!!after} disabled=${after && after.props.disabled} routed=${JSON.stringify(ROUTER.replaced)}`,
      };
    },
  },
  {
    name: 'A4 honesty: a signOut that "succeeds" while the session SURVIVES (offline) is NOT a silent no-op',
    run: async () => {
      resetCase();
      STORED_SESSION = { user: { id: 'u1', email: 'owner@spotterworkout.com', createdAt: '2026-10-05T00:00:00Z' }, isDevMode: false };
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control to press' };
      control.props.onPress();
      const confirm = alertButton(copy.SIGN_OUT_CONFIRM_ACTION);
      await confirm.onPress();
      await flushMicrotasks();
      const texts = textList(mounted.render());
      return {
        ok: texts.includes(copy.SIGN_OUT_FAILED_MESSAGE) && ROUTER.replaced.length === 0,
        detail: `message=${texts.includes(copy.SIGN_OUT_FAILED_MESSAGE)} routed=${JSON.stringify(ROUTER.replaced)} signOutCalls=${SIGN_OUT_CALLS}`,
      };
    },
  },
  {
    name: 'A4 retry: after a failed sign-out the control really runs again and a later success navigates',
    run: async () => {
      resetCase();
      SIGN_OUT_IMPL = async () => {
        throw new Error('Network request failed');
      };
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      const first = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!first) return { ok: false, detail: 'no Sign out control to press' };
      first.props.onPress();
      await alertButton(copy.SIGN_OUT_CONFIRM_ACTION).onPress();
      await flushMicrotasks();
      SIGN_OUT_IMPL = async () => undefined;
      const second = findByLabel(mounted.render(), copy.SIGN_OUT_CONTROL_LABEL);
      if (!second || typeof second.props.onPress !== 'function') return { ok: false, detail: 'control not retryable' };
      second.props.onPress();
      await alertButton(copy.SIGN_OUT_CONFIRM_ACTION).onPress();
      await flushMicrotasks();
      return {
        ok: SIGN_OUT_CALLS === 2 && ROUTER.replaced.length === 1 && ROUTER.replaced[0] === contractLoader().RequireSession.SIGNED_OUT_ROUTE,
        detail: `signOutCalls=${SIGN_OUT_CALLS} routed=${JSON.stringify(ROUTER.replaced)}`,
      };
    },
  },
  {
    name: 'A5 in-flight: a pending write that lands AFTER sign-out tears the screen down must not write state',
    run: async () => {
      resetCase();
      SAVE_MISS_MODE = 'defer';
      const copy = EXPECTED_COPY;
      const mounted = await mountProfile();
      // The miss-note "Save" is the TextButton in the group card: a pressable
      // rendered as "Save" with NO accessibilityLabel (the naming Save is an
      // AppButton and carries one), so it is unambiguous.
      const save = findPressables(mounted.tree).find((el) => joinText(el) === 'Save' && el.props.accessibilityLabel === undefined);
      if (!save) return { ok: false, detail: `no miss-note Save control; texts=${joinText(mounted.tree).slice(0, 200)}` };
      save.props.onPress(); // the write is now in flight
      await flushMicrotasks(2);
      const control = findByLabel(mounted.tree, copy.SIGN_OUT_CONTROL_LABEL);
      if (!control) return { ok: false, detail: 'no Sign out control to press' };
      control.props.onPress();
      await alertButton(copy.SIGN_OUT_CONFIRM_ACTION).onPress();
      await flushMicrotasks();
      mounted.unmount(); // the Gate swaps the Stack: this screen is gone
      const pending = SAVE_MISS_DEFERRED.length;
      SAVE_MISS_DEFERRED.forEach((resolve) => resolve());
      await flushMicrotasks(8);
      return {
        ok: pending === 1 && POST_UNMOUNT_WRITES.length === 0 && UNHANDLED.length === 0,
        detail: `pendingWrite=${pending} postUnmountStateWrites=${POST_UNMOUNT_WRITES.length} unhandledRejections=${JSON.stringify(UNHANDLED)}`,
      };
    },
  },

  // -------------------- A6. the delete flow is untouched -------------------
  {
    name: 'A6 ui: Delete account still opens its OWN confirm screen, and only that confirm deletes',
    run: async () => {
      resetCase();
      const mounted = await mountProfile();
      const del = findByLabel(mounted.tree, 'Delete account');
      if (!del) return { ok: false, detail: 'no Delete account control' };
      del.props.onPress();
      const tree = mounted.render();
      const texts = textList(tree);
      const confirm = findPressables(tree).find((el) => joinText(el) === 'Delete my account');
      return {
        ok:
          DELETE_CALLS === 0 &&
          SIGN_OUT_CALLS === 0 &&
          !!confirm &&
          texts.includes('Delete your account?') &&
          texts.includes("This permanently deletes your account, your photo logs and the photos you uploaded. This can't be undone."),
        detail: `deleteCalls=${DELETE_CALLS} signOutCalls=${SIGN_OUT_CALLS} confirmButton=${!!confirm} confirmTitle=${texts.includes('Delete your account?')}`,
      };
    },
  },
  {
    name: 'A6 behaviour: Delete my account still deletes once, signs out once, then replaces to welcome',
    run: async () => {
      resetCase();
      const mounted = await mountProfile();
      findByLabel(mounted.tree, 'Delete account').props.onPress();
      const confirmBtn = findPressables(mounted.render()).find((el) => joinText(el) === 'Delete my account');
      if (!confirmBtn) return { ok: false, detail: 'no Delete my account button' };
      await confirmBtn.props.onPress();
      await flushMicrotasks();
      const texts = textList(mounted.render());
      return {
        ok:
          DELETE_CALLS === 1 &&
          SIGN_OUT_CALLS === 1 &&
          ROUTER.replaced.join(',') === '/(auth)/welcome' &&
          texts.includes('Account deleted. Sorry to see you go.'),
        detail: `deleteCalls=${DELETE_CALLS} signOutCalls=${SIGN_OUT_CALLS} routed=${JSON.stringify(ROUTER.replaced)} message=${texts.includes('Account deleted. Sorry to see you go.')}`,
      };
    },
  },
  {
    name: 'A6 static: the delete flow copy, its single-tap guard and the volt-free success line are unchanged',
    run() {
      const src = fs.readFileSync(PROFILE_SRC, 'utf8');
      const must = [
        /Delete your account\?/,
        /Permanently deletes your account, photo logs and photos\./,
        /This permanently deletes your account, your photo logs and the photos you uploaded\. This can't be undone\./,
        /accessibilityLabel="Delete account"/,
        /label="Delete my account"/,
        /router\.replace\('\/\(auth\)\/welcome'\)/,
        /color: done \? colors\.text\.secondary\.hex : colors\.text\.danger\.hex/,
      ];
      const missing = must.filter((re) => !re.test(src)).map(String);
      return { ok: missing.length === 0, detail: missing.length ? `missing=${missing.join(' | ')}` : 'all 7 declarations intact' };
    },
  },
  {
    name: 'A6 static: signOut() is awaited from exactly the two handlers (delete + sign out)',
    run() {
      const src = stripComments(fs.readFileSync(PROFILE_SRC, 'utf8'));
      const calls = (src.match(/await signOut\(\)/g) || []).length;
      const signsOutInDelete = /if \(res\.ok\)[\s\S]{0,400}?await signOut\(\)/.test(src);
      const signOutRoutes = /router\.replace\(SIGNED_OUT_ROUTE\)/.test(src);
      return {
        ok: calls === 2 && signsOutInDelete && signOutRoutes,
        detail: `await signOut() occurrences=${calls} (delete handler + sign-out handler) deleteHandlerStillSignsOut=${signsOutInDelete} signOutRoutesToSIGNED_OUT_ROUTE=${signOutRoutes}`,
      };
    },
  },

  // --------------------- B. the feed caption bug ---------------------------
  {
    name: "B1 ui: a co-member's FeedCard renders NO 'YOU' and NO 'YOUR SPOT'",
    run() {
      resetCase();
      const facts = feedCardFacts(CO_MEMBER_LOG);
      return {
        ok: !facts.claimsYou && !facts.claimsYourSpot && facts.authorShown,
        detail: `claimsYou=${facts.claimsYou} claimsYourSpot=${facts.claimsYourSpot} authorShown=${facts.authorShown} texts=${facts.text}`,
      };
    },
  },
  {
    name: "B1 ui: a co-member's card still shows both thumbs, the author name and the derived labels",
    run() {
      resetCase();
      const { workouts } = feedLoader();
      const facts = feedCardFacts(CO_MEMBER_LOG);
      const expected = workouts.feedThumbLabels(false);
      const labels = facts.thumbs.map((t) => t.label).join(',');
      return {
        ok:
          facts.thumbs.length === 2 &&
          labels === `${expected.self},${expected.spot}` &&
          facts.authorShown &&
          facts.text.includes(CO_MEMBER_LOG.caption),
        detail: `thumbs=${JSON.stringify(facts.thumbs)} expected=${JSON.stringify(expected)} authorShown=${facts.authorShown}`,
      };
    },
  },
  {
    name: "B1 a11y: both thumbs keep their accessibility labels ('View photo' / 'View environment photo')",
    run() {
      resetCase();
      const facts = feedCardFacts(CO_MEMBER_LOG);
      return {
        ok: facts.thumbs.some((t) => t.a11y === 'View photo') && facts.thumbs.some((t) => t.a11y === 'View environment photo'),
        detail: `a11y=[${facts.thumbs.map((t) => t.a11y).join(', ')}]`,
      };
    },
  },
  {
    name: "B2 ui: the viewer's OWN card still renders 'YOU' and 'YOUR SPOT' (the true claim survives)",
    run() {
      resetCase();
      const { workouts } = feedLoader();
      const facts = feedCardFacts(OWN_LOG);
      const expected = workouts.feedThumbLabels(true);
      return {
        ok: facts.claimsYou && facts.claimsYourSpot && expected.self === 'YOU' && expected.spot === 'YOUR SPOT',
        detail: `claimsYou=${facts.claimsYou} claimsYourSpot=${facts.claimsYourSpot} derived=${JSON.stringify(expected)}`,
      };
    },
  },
  {
    name: 'B3 static: FeedCard.tsx carries no hardcoded YOU / YOUR SPOT literal — the labels come from src/lib/workouts.ts',
    run() {
      const src = stripComments(fs.readFileSync(FEED_CARD_SRC, 'utf8'));
      const lib = fs.readFileSync(WORKOUTS_LIB, 'utf8');
      const hardcoded = /label: 'YOU'|label: 'YOUR SPOT'|label: "YOU"|label: "YOUR SPOT"/.test(src);
      const derived = /feedThumbLabels\(/.test(src);
      const libHasHelper = /export function feedThumbLabels/.test(lib) && /THEIR SPOT/.test(lib);
      return {
        ok: !hardcoded && derived && libHasHelper,
        detail: `hardcodedLabel=${hardcoded} usesHelper=${derived} libHasHelper=${libHasHelper}`,
      };
    },
  },
  {
    name: 'B3 static: the author name slot still renders log.authorName unchanged',
    run() {
      const src = fs.readFileSync(FEED_CARD_SRC, 'utf8');
      return { ok: /\{log\.authorName\}/.test(src), detail: `authorName rendered=${/\{log\.authorName\}/.test(src)}` };
    },
  },
  {
    name: 'negative control: the same feed analysis FAILS the pre-fix shape (a gate that cannot fail is not a gate)',
    run() {
      resetCase();
      const prefix = preFixFacts(CO_MEMBER_LOG);
      const fixed = feedCardFacts(CO_MEMBER_LOG);
      return {
        ok: prefix.claimsYou === true && fixed.claimsYou === false,
        detail: `preFixClaimsYou=${prefix.claimsYou} fixedClaimsYou=${fixed.claimsYou}`,
      };
    },
  },
];

/** depth-first find of the first element matching `pred`, without a global hit. */
function walkFind(node, pred) {
  if (!React.isValidElement(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = walkFind(child, pred);
        if (hit) return hit;
      }
    }
    return null;
  }
  if (pred(node)) return node;
  return walkFind(node.props.children, pred);
}

// --------------------------------------------------------------------------
// run
// --------------------------------------------------------------------------
console.log('=== signout-feed-labels-guard: sign out + viewer-relative feed labels ===');
console.log(`root: ${ROOT}`);
console.log(`checks: ${CHECKS.length}`);

async function runAll() {
  for (const entry of CHECKS) {
    let result;
    try {
      result = await entry.run();
      if (!result || typeof result !== 'object') result = { ok: !!result, detail: '' };
    } catch (error) {
      result = { ok: false, detail: `${error.name}: ${error.message}` };
    }
    check(entry.name, result.ok, result.detail);
  }
  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
}

runAll().catch((error) => {
  console.log(`FAIL  harness: the guard itself threw :: ${error.name}: ${error.message}`);
  console.log(`SUMMARY: ${passes} PASS / ${fails + 1} FAIL`);
  process.exit(1);
});
