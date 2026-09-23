#!/usr/bin/env node
/*
 * auth-gate-guard — the offline gate for the three App-Review first-run defects
 * found by the cold-reviewer audit (2026-09-23).
 *
 * WHAT IT PROVES (mechanically, by rendering the REAL files in plain Node —
 * no reconciler, no Metro, no device):
 *
 *  R1  A session-less state cannot present onboarding or Home. The real route
 *      files are mounted with `useAuth()` returning no session and the tree is
 *      inspected: each must render <Redirect href="/(auth)/welcome"> and must
 *      NOT invoke the screen component behind it. With a session the same
 *      routes must still render (no over-blocking). A hand-built UNGUARDED route
 *      runs through the identical analysis and must be reported as unguarded —
 *      the negative control for this half.
 *      Why the gate is INSIDE the screen: expo-router's `StackClient` calls
 *      `withLayoutContext` with two arguments, so `useOnlyUserDefinedScreens`
 *      defaults false and `useScreens.js` registers every filesystem route —
 *      _layout.tsx's conditional <Stack.Screen> list chooses ORDER, it gates
 *      nothing. _layout.tsx is therefore untouched here and still passes its own
 *      keyed-array assertion below plus the full 19-check stack-children-guard.
 *      Also: the Welcome screen's "Skip for now" (which used to run the
 *      authenticated path) is gone, and no control on it can advance a user
 *      with no account.
 *
 *  R2  A failed onboarding write reaches the UI. The real
 *      (onboarding)/index.tsx is mounted, the real tap chain is driven
 *      (practice Next -> goal Next -> "Let's go"), and the REAL
 *      commitOnboarding runs against a fake Supabase auth client whose session
 *      store returns null — the exact live 'No session found. Please sign in
 *      again.' path. The real OnboardingScreen must render that string above
 *      the CTA, and the CTA must be in its loading state while the commit is in
 *      flight. A second case drives a real write failure (the FK violation
 *      text). A hand-built PRE-FIX shape (res.error discarded, primaryLoading
 *      never passed) runs through the same analysis and must be reported as
 *      silent — the negative control for this half.
 *      Also: authenticate() must not report success when signUp came back with
 *      no session (Supabase "Confirm email" ON).
 *
 *  R3  Both camera-denial surfaces offer a control that really opens iOS
 *      Settings (Linking.openSettings), and the LogSheet copy that pointed at
 *      Settings is actually rendered.
 *
 *  R4  app.json no longer advertises a Face ID prompt the app cannot show.
 *
 * NEGATIVE CONTROL (run it, do not trust it): this file is committed on the fix
 * branch, so restore the unfixed sources and run it there —
 *   git checkout master -- src app.json && node scripts/smoke/auth-gate-guard.cjs
 * It must FAIL. Raw output is recorded in
 * /home/team/shared/review-artifacts/2026-09-23-first-run-defects-fix.md.
 *
 * Every check prints exactly one PASS/FAIL line, so the runner can count them:
 *   node scripts/smoke/auth-gate-guard.cjs        (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const React = require('react');

// The app reads these at module scope to decide real vs dev-mock mode. Set them
// BEFORE any app module is evaluated so src/lib/supabase.ts builds a real client
// (which the stub below supplies) instead of the dev mock.
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://auth-gate-guard.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'auth-gate-guard-anon-key';

const ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'src', 'app');

// --------------------------------------------------------------------------
// reporter — one line per check, always, whatever happens
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
// test doubles (mutable; reset per case)
// --------------------------------------------------------------------------
const INVOKED = [];
const ROUTER = {
  replaced: [],
  pushed: [],
  replace(href) {
    ROUTER.replaced.push(href);
  },
  push(href) {
    ROUTER.pushed.push(href);
  },
  back() {},
};
let LINKING_CALLS = 0;
const LINKING = {
  openSettings: () => {
    LINKING_CALLS += 1;
    return Promise.resolve();
  },
  canOpenURL: () => Promise.resolve(true),
};
const AUTH = { session: null };
const CAM = {
  state: { granted: false, canAskAgain: true, status: 'undetermined' },
  requestResult: { granted: false, canAskAgain: false, status: 'denied' },
};
let CAMERA_REQUESTS = 0;

// The fake Supabase project: `session` is the stored auth session (null =
// signed out / never confirmed), `signInError`/`signUpError` steer
// authenticate(), `tables` steers PostgREST reads and writes.
const FAKE = { session: null, signInError: null, signUpError: null, tables: {} };

function fakeQuery(table) {
  const result = () =>
    Object.prototype.hasOwnProperty.call(FAKE.tables, table) ? FAKE.tables[table] : { data: null, error: null };
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: () => chain,
    upsert: () => chain,
    delete: () => chain,
    maybeSingle: async () => result(),
    single: async () => result(),
  };
  return chain;
}

const FAKE_AUTH = {
  getSession: async () => ({ data: { session: FAKE.session } }),
  signInWithPassword: async () => ({ error: FAKE.signInError }),
  signUp: async () => ({ error: FAKE.signUpError }),
  signOut: async () => ({ error: null }),
};

const SESSION_ROW = { user: { id: 'u1', email: 'reviewer@example.com', created_at: '2026-09-23T00:00:00Z' } };
const NO_SESSION_ERROR = 'No session found. Please sign in again.';
const SETTINGS_DENIED_COPY = 'Allow it in Settings to log with photo proof.';
const CAMERA_OFF_COPY = 'Camera access is off.';
const FK_ERROR =
  'insert or update on table "groups" violates foreign key constraint "groups_creator_id_fkey"';

// --------------------------------------------------------------------------
// mini render runtime: hooks + full-tree re-render, no reconciler
// --------------------------------------------------------------------------
const STORES = new Map();
let CURRENT_STORE = null;
let FLUSH_QUEUE = [];
let PENDING_RERENDER = null;

function storeFor(key) {
  let store = STORES.get(key);
  if (!store) {
    store = { key, hooks: [], cursor: 0, effects: [], effectsRan: false, rerender: () => {} };
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

/**
 * The 'react' module the app's components see: real React element helpers, but
 * OUR hooks. A component rendered by `expand()` calls useState/useRef/... from
 * this object, which is what lets a plain function call behave like a render.
 */
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
    // <>…</> has a Symbol type: walk through it (its children are real children).
    return React.cloneElement(node, {}, expandChildren(props.children, pathStr));
  }
  if (typeof type === 'function') {
    const name = nameOf(type);
    if (type.prototype && type.prototype.isReactComponent) {
      INVOKED.push(name);
      const instance = new type(props);
      instance.props = props;
      if (!instance.state) instance.state = {};
      return expand(instance.render(), `${pathStr}|${name}out`);
    }
    INVOKED.push(name);
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
  for (const store of queue) {
    if (store.effectsRan) continue;
    store.effectsRan = true;
    const fns = store.effects.slice();
    store.effects = [];
    for (const fn of fns) fn();
  }
}

/** Mount `Component` as the root and re-render the whole tree on state change. */
function mountRoot(Component, props) {
  // One mount at a time: every store (root and children) starts clean, so a
  // component's state cannot leak from one check into the next.
  STORES.clear();
  const store = storeFor('root');
  const api = {
    raw: null,
    tree: null,
    renders: 0,
    render() {
      PENDING_RERENDER = () => api.render();
      store.rerender = () => api.render();
      INVOKED.length = 0;
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
      flushEffects();
      return api.tree;
    },
  };
  return api;
}

// --------------------------------------------------------------------------
// module loading (real .tsx/.ts sources, leaf deps stubbed)
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

function nameOf(type) {
  if (typeof type === 'string') return type;
  return (type && type.name) || 'anonymous';
}

/** A recording stand-in for a screen/component the gate must not mount. */
function makeSpy(name) {
  const fn = function spy(props) {
    INVOKED.push(name);
    return React.createElement(`Spy:${name}`, props);
  };
  Object.defineProperty(fn, 'name', { value: name });
  return fn;
}

const SOURCE_EXT = ['.tsx', '.ts', '.js'];

function nativeStubs() {
  const Glyph = (props) => React.createElement('Ionicons', props);
  const CameraStub = (props) => React.createElement('CameraView', props);
  const stub = {
    react: reactStub(),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': {
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ScrollView: 'ScrollView',
      TextInput: 'TextInput',
      Modal: 'Modal',
      Image: 'Image',
      ActivityIndicator: 'ActivityIndicator',
      KeyboardAvoidingView: 'KeyboardAvoidingView',
      SafeAreaView: 'SafeAreaView',
      Platform: { OS: 'ios', select: (o) => (o && o.ios) || undefined },
      StyleSheet: { create: (s) => s, flatten: (s) => s },
      Dimensions: { get: () => ({ width: 390, height: 844 }) },
      Linking: LINKING,
    },
    'react-native-safe-area-context': {
      SafeAreaView: 'SafeAreaView',
      useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    },
    'expo-router': {
      Redirect: (props) => React.createElement('Redirect', props),
      useRouter: () => ROUTER,
      Stack: makeSpy('Stack'),
      Tabs: makeSpy('Tabs'),
    },
    'expo-camera': {
      CameraView: CameraStub,
      useCameraPermissions: () => [CAM.state, requestCameraPermission],
    },
    'expo-image': { Image: (props) => React.createElement('ExpoImage', props) },
    'expo-file-system': {
      File: class FileStub {
        constructor(uri) {
          this.uri = uri;
        }
        delete() {}
      },
    },
    'expo-secure-store': {
      getItemAsync: async () => null,
      setItemAsync: async () => undefined,
      deleteItemAsync: async () => undefined,
    },
    '@expo/vector-icons': { Ionicons: Glyph },
    '@supabase/supabase-js': { createClient: () => ({ auth: FAKE_AUTH, from: fakeQuery }) },
  };
  return stub;
}

async function requestCameraPermission() {
  CAMERA_REQUESTS += 1;
  return CAM.requestResult;
}

function makeLoader(extraStubs) {
  const cache = new Map();
  function resolveFile(file) {
    if (path.extname(file)) return fs.existsSync(file) ? file : null;
    for (const ext of SOURCE_EXT) {
      if (fs.existsSync(file + ext)) return file + ext;
    }
    return null;
  }
  function loadFile(file) {
    const resolved = resolveFile(file);
    if (!resolved) throw new Error(`cannot resolve module: ${file}`);
    if (cache.has(resolved)) return cache.get(resolved);
    // Binary assets (require('@/assets/x.png')): nothing here inspects them.
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

  const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|ttf|otf|mp3|m4a|mp4|wav)$/i;

  function makeRequire(fromFile) {
    return (id) => {
      if (Object.prototype.hasOwnProperty.call(extraStubs, id)) return extraStubs[id];
      // Bundled images/fonts (require('@/assets/x.png')): nothing here inspects them.
      if (ASSET_RE.test(id)) return {};
      if (id.startsWith('@/')) return loadFile(path.join(ROOT, 'src', id.slice(2)));
      const resolved = resolveFile(path.resolve(path.dirname(fromFile), id));
      if (resolved) return loadFile(resolved);
      throw new Error(`unstubbed require from ${fromFile}: ${id}`);
    };
  }
  return { loadFile };
}

/** Shared lib stubs so the real src/lib modules never reach the network. */
function libStubs() {
  return {
    './mock': { devMock: { createUser: async () => SESSION_ROW.user, getProfile: async () => null } },
    '@/lib/mock': { devMock: { createUser: async () => SESSION_ROW.user, getProfile: async () => null } },
    './analytics': { track: async () => undefined, consumeIsFirstOpen: async () => true },
    '@/lib/analytics': { track: async () => undefined, consumeIsFirstOpen: async () => true },
    './database.types': {},
  };
}

function realLoader(extraStubs) {
  const loader = makeLoader(Object.assign(nativeStubs(), libStubs(), extraStubs));
  return (rel) => loader.loadFile(path.join(ROOT, rel));
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

function findHosts(node, hostType) {
  const out = [];
  walk(node, (el) => {
    if (el.type === hostType) out.push(el);
  });
  return out;
}

function findByName(node, name) {
  let hit = null;
  walk(node, (el) => {
    if (!hit && typeof el.type === 'function' && nameOf(el.type) === name) hit = el;
  });
  return hit;
}

function findPressables(node) {
  const out = [];
  walk(node, (el) => {
    if (typeof el.props.onPress === 'function') out.push(el);
  });
  return out;
}

function findByLabel(node, label) {
  let hit = null;
  walk(node, (el) => {
    if (!hit && el.props.accessibilityLabel === label) hit = el;
  });
  return hit;
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// --------------------------------------------------------------------------
// analysis functions — used for BOTH the real routes and the negative controls
// --------------------------------------------------------------------------
function analyzeGate(Component, session) {
  AUTH.session = session;
  const mounted = mountRoot(Component, {});
  const tree = mounted.render();
  const redirects = findHosts(tree, 'Redirect');
  return {
    redirect: redirects.length ? redirects[0].props.href : null,
    invoked: INVOKED.slice(),
    texts: joinText(tree),
  };
}

/**
 * Drive the onboarding tap chain and report what the LAST step's commit
 * rendered: whether the commit's failure string reached the tree, and whether
 * the CTA rendered its loading state while the commit was in flight.
 */
async function analyzeCommitSurfacing(Component, pressChain, expectedError) {
  const mounted = mountRoot(Component, {});
  let tree = mounted.render();
  let pending = null;
  for (let i = 0; i < pressChain.length; i += 1) {
    const step = pressChain[i];
    const target = findByName(mounted.raw, step.name);
    if (!target) {
      return { errorReachedUi: false, loadingDuringCommit: false, missing: step.name, texts: joinText(tree) };
    }
    const fn = target.props[step.prop];
    if (typeof fn !== 'function') {
      return { errorReachedUi: false, loadingDuringCommit: false, missing: `${step.name}.${step.prop}`, texts: joinText(tree) };
    }
    const returned = fn();
    if (i === pressChain.length - 1) pending = returned;
    tree = mounted.render();
  }
  const primary = findHosts(mounted.tree, 'Pressable').find(
    (el) => el.props.accessibilityLabel === "Let's go" || el.props.accessibilityLabel === 'Let\u2019s go',
  );
  const loadingDuringCommit = !!primary && findHosts(primary, 'ActivityIndicator').length > 0;
  if (pending && typeof pending.then === 'function') await pending;
  tree = mounted.render();
  const rendered = joinText(tree);
  return {
    errorReachedUi: expectedError ? rendered.includes(expectedError) : false,
    loadingDuringCommit,
    texts: rendered,
  };
}

/** Mount a denial surface, optionally press a control (awaiting the result). */
async function analyzeDenialSurface(Component, props, drive) {
  const mounted = mountRoot(Component, props);
  mounted.render();
  if (!drive) {
    return { pressed: false, openSettings: !!findByLabel(mounted.tree, 'Open Settings'), texts: textList(mounted.tree), tree: mounted.tree };
  }
  const press = findPressables(mounted.tree).find((el) => el.props.accessibilityLabel === drive.press);
  if (!press) {
    return { pressed: false, openSettings: false, texts: textList(mounted.tree), tree: mounted.tree };
  }
  const returned = press.props.onPress();
  if (returned && typeof returned.then === 'function') await returned;
  else await flushMicrotasks();
  if (drive.after) drive.after();
  const tree = mounted.render();
  return { pressed: true, openSettings: !!findByLabel(tree, 'Open Settings'), texts: textList(tree), tree };
}

function pressOpenSettings(tree) {
  const control = findByLabel(tree, 'Open Settings');
  if (!control || typeof control.props.onPress !== 'function') return false;
  control.props.onPress();
  return true;
}

// --------------------------------------------------------------------------
// lazy module handles (each memoised; a failure fails only the checks needing it)
// --------------------------------------------------------------------------
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

const ROUTE_FILES = {
  onboarding: 'src/app/(onboarding)/index.tsx',
  home: 'src/app/(home)/(tabs)/index.tsx',
  profile: 'src/app/(profile)/index.tsx',
  promises: 'src/app/(promises)/index.tsx',
};

/** Route gate: the routes are REAL, the screens behind them are spies. */
function routeLoader() {
  return once('routes', () => {
    const load = realLoader({
      '@/features/auth/AuthProvider': {
        useAuth: () => ({
          session: AUTH.session,
          profile: AUTH.session ? { id: AUTH.session.user.id } : null,
          isLoading: false,
          isDevMode: false,
          refresh: async () => undefined,
          signOut: async () => undefined,
        }),
        AuthProvider: (props) => props.children,
        SplashLoading: () => null,
      },
      '@/features/home/HomeScreen': { __esModule: true, default: makeSpy('HomeScreen') },
      '@/features/profile/ProfileScreen': { ProfileScreen: makeSpy('ProfileScreen') },
      '@/features/promises/PromisesScreen': { PromisesScreen: makeSpy('PromisesScreen') },
      '@/features/onboarding/PracticeCamStep': { PracticeCamStep: makeSpy('PracticeCamStep') },
      '@/features/onboarding/GoalStep': { GoalStep: makeSpy('GoalStep') },
      '@/features/onboarding/WeekStartStep': { WeekStartStep: makeSpy('WeekStartStep') },
    });
    const routes = {};
    for (const [key, rel] of Object.entries(ROUTE_FILES)) {
      const mod = load(rel);
      if (typeof mod.default !== 'function') throw new Error(`${rel} has no default component export`);
      routes[key] = mod.default;
    }
    return { RequireSession: load('src/features/auth/RequireSession.tsx').RequireSession, routes };
  });
}

/** Commit surfacing: the route, the steps and the shell are all REAL. */
function commitLoader() {
  return once('commit', () => {
    const load = realLoader({
      '@/features/auth/AuthProvider': {
        useAuth: () => ({
          session: SESSION_ROW,
          profile: { id: SESSION_ROW.user.id },
          isLoading: false,
          isDevMode: false,
          refresh: async () => undefined,
          signOut: async () => undefined,
        }),
        AuthProvider: (props) => props.children,
        SplashLoading: () => null,
      },
      // Step 1 has no commit; a spy keeps this case on the final tap.
      '@/features/onboarding/PracticeCamStep': { PracticeCamStep: makeSpy('PracticeCamStep') },
    });
    return {
      onboarding: load(ROUTE_FILES.onboarding).default,
      WeekStartStep: load('src/features/onboarding/WeekStartStep.tsx').WeekStartStep,
      commitOnboarding: load('src/lib/settings.ts').commitOnboarding,
    };
  });
}

/** The real src/lib/supabase.ts in REAL mode, against the fake auth client. */
function supabaseReal() {
  return once('supabaseReal', () => realLoader({})('src/lib/supabase.ts'));
}

function welcomeLoader() {
  return once('welcome', () => {
    const load = realLoader({
      '@/features/auth/AuthProvider': {
        useAuth: () => ({ session: null, profile: null, isLoading: false, isDevMode: false }),
        SplashLoading: () => null,
      },
      '@/features/invites/InviteRow': { InviteRow: makeSpy('InviteRow') },
    });
    return { WelcomeStep: load('src/features/onboarding/WelcomeStep.tsx').WelcomeStep };
  });
}

function surfacesLoader() {
  return once('surfaces', () => {
    const load = realLoader({
      '@/features/home/WeeklyRing': { WeeklyRing: makeSpy('WeeklyRing') },
      '@/lib/promises': {
        LEDGER_FRAMING_LINE: 'Nothing gets saved or posted.',
        STAKES_PREVIEW_PAIR_LINE: 'Miss a week and your partner hears about it first.',
      },
      '@/lib/filters': {
        SELFIE_FILTER_HELPER: 'Color only. No reshaping, ever.',
        SELFIE_FILTER_IDS: ['none'],
        SELFIE_FILTER_PRESETS: { none: { label: 'None', previewTint: null, curve: [] } },
        filterA11yLabel: (id) => `Filter ${id}`,
      },
      '@/lib/workoutStore': { logWorkout: async () => ({ ok: false }) },
      '@/lib/selfieBake': { bakeSelfieFiltered: async () => ({ ok: false, error: 'no' }) },
      '@/lib/workouts': { WORKOUT_TYPES: [] },
    });
    return {
      PracticeCamStep: load('src/features/onboarding/PracticeCamStep.tsx').PracticeCamStep,
      LogSheet: load('src/features/logging/LogSheet.tsx').LogSheet,
    };
  });
}

function readJson(rel) {
  return once(`json:${rel}`, () => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
}

function routeFilesOnDisk() {
  return once('routeFiles', () => {
    const out = [];
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkDir(full);
        else if (entry.name.endsWith('.tsx')) out.push(full);
      }
    };
    walkDir(APP_DIR);
    return out.sort();
  });
}

const ALLOWED_SESSIONLESS = ['(auth)/welcome.tsx', '(accept)/index.tsx', '(invite)/index.tsx'];

function ungatedRoutes() {
  return routeFilesOnDisk()
    .filter((file) => !path.basename(file).startsWith('_layout'))
    .filter((file) => !ALLOWED_SESSIONLESS.includes(path.relative(APP_DIR, file)))
    .filter((file) => !fs.readFileSync(file, 'utf8').includes('<RequireSession>'))
    .map((file) => path.relative(ROOT, file));
}

const ONBOARDING_TAP_CHAIN = [
  { name: 'PracticeCamStep', prop: 'onNext' },
  { name: 'GoalStep', prop: 'onNext' },
  { name: 'WeekStartStep', prop: 'onFinish' },
];

// --------------------------------------------------------------------------
// the checks — a FIXED list; every entry prints exactly one line
// --------------------------------------------------------------------------
const CHECKS = [
  {
    name: 'R1 load: the four gated routes and RequireSession load from source',
    run() {
      const { RequireSession, routes } = routeLoader();
      return {
        ok: typeof RequireSession === 'function' && Object.keys(routes).length === 4,
        detail: `RequireSession=${typeof RequireSession} routes=[${Object.keys(routes).join(',')}]`,
      };
    },
  },
  {
    name: 'R1 gate: session-less (onboarding)/index redirects to /(auth)/welcome',
    run() {
      const result = analyzeGate(routeLoader().routes.onboarding, null);
      return {
        ok: result.redirect === '/(auth)/welcome',
        detail: `redirect=${JSON.stringify(result.redirect)} invoked=[${result.invoked.join(',')}]`,
      };
    },
  },
  {
    name: 'R1 gate: session-less (onboarding)/index mounts NO onboarding step',
    run() {
      const result = analyzeGate(routeLoader().routes.onboarding, null);
      const steps = ['PracticeCamStep', 'GoalStep', 'WeekStartStep'].filter((n) => result.invoked.includes(n));
      return { ok: steps.length === 0, detail: `mounted steps=[${steps.join(',')}]` };
    },
  },
  {
    name: 'R1 gate: session-less Home redirects to /(auth)/welcome',
    run() {
      const result = analyzeGate(routeLoader().routes.home, null);
      return { ok: result.redirect === '/(auth)/welcome', detail: `redirect=${JSON.stringify(result.redirect)}` };
    },
  },
  {
    name: 'R1 gate: session-less Home mounts NO HomeScreen',
    run() {
      const result = analyzeGate(routeLoader().routes.home, null);
      return { ok: !result.invoked.includes('HomeScreen'), detail: `invoked=[${result.invoked.join(',')}]` };
    },
  },
  {
    name: 'R1 gate: session-less Profile and Promises redirect too',
    run() {
      const profile = analyzeGate(routeLoader().routes.profile, null);
      const promises = analyzeGate(routeLoader().routes.promises, null);
      return {
        ok: profile.redirect === '/(auth)/welcome' && promises.redirect === '/(auth)/welcome',
        detail: `profile=${JSON.stringify(profile.redirect)} promises=${JSON.stringify(promises.redirect)}`,
      };
    },
  },
  {
    name: 'R1 gate: with a session the onboarding route still renders its first step',
    run() {
      const result = analyzeGate(routeLoader().routes.onboarding, SESSION_ROW);
      return {
        ok: result.redirect === null && result.invoked.includes('PracticeCamStep'),
        detail: `redirect=${JSON.stringify(result.redirect)} invoked=[${result.invoked.join(',')}]`,
      };
    },
  },
  {
    name: 'R1 gate: with a session Home still renders HomeScreen',
    run() {
      const result = analyzeGate(routeLoader().routes.home, SESSION_ROW);
      return {
        ok: result.redirect === null && result.invoked.includes('HomeScreen'),
        detail: `redirect=${JSON.stringify(result.redirect)} invoked=[${result.invoked.join(',')}]`,
      };
    },
  },
  {
    name: 'R1 static: every route outside (auth)/(accept)/(invite) is wrapped in RequireSession',
    run() {
      const ungated = ungatedRoutes();
      return { ok: ungated.length === 0, detail: ungated.length ? `ungated=[${ungated.join(',')}]` : 'all gated' };
    },
  },
  {
    name: 'R1 static: the Welcome step no longer wires a skip to the authenticated path',
    run() {
      const src = fs.readFileSync(path.join(ROOT, 'src/features/onboarding/WelcomeStep.tsx'), 'utf8');
      const passesSkip = /onSkip=/.test(src);
      const canSkipFalse = /canSkip=\{false\}/.test(src);
      return { ok: !passesSkip && canSkipFalse, detail: `onSkip prop=${passesSkip} canSkip={false}=${canSkipFalse}` };
    },
  },
  {
    name: 'R1 ui: Welcome renders no "Skip for now" and no control can leave it unauthenticated',
    run() {
      const { WelcomeStep } = welcomeLoader();
      let doneCalls = 0;
      const mounted = mountRoot(WelcomeStep, {
        onDone: () => {
          doneCalls += 1;
        },
      });
      const tree = mounted.render();
      const rendered = joinText(tree);
      const hasSkip = rendered.includes('Skip for now');
      const hasPrimary = rendered.includes('Get started');
      // Press everything on the screen with an empty form: nothing may advance.
      for (const control of findPressables(tree)) control.props.onPress();
      const after = mounted.render();
      const advanced = findHosts(after, 'Redirect').length > 0 || doneCalls > 0;
      return {
        ok: !hasSkip && hasPrimary && !advanced,
        detail: `hasSkip=${hasSkip} hasGetStarted=${hasPrimary} onDoneCalls=${doneCalls} advanced=${advanced}`,
      };
    },
  },
  {
    name: 'R1 negative control: the same gate analysis flags an UNGUARDED route',
    run() {
      const UnguardedRoute = function UnguardedRoute() {
        return React.createElement(makeSpy('HomeScreen'));
      };
      const control = analyzeGate(UnguardedRoute, null);
      const fixed = analyzeGate(routeLoader().routes.home, null);
      return {
        ok: control.redirect === null && control.invoked.includes('HomeScreen') && fixed.redirect === '/(auth)/welcome',
        detail: `unguarded: redirect=${JSON.stringify(control.redirect)} invoked=[${control.invoked.join(',')}] | fixed: redirect=${JSON.stringify(fixed.redirect)}`,
      };
    },
  },
  {
    name: 'R1: _layout.tsx still hands <Stack> only keyed Stack.Screen children',
    run() {
      const src = fs.readFileSync(path.join(ROOT, 'src/app/_layout.tsx'), 'utf8');
      const open = src.indexOf('<Stack\n');
      const openEnd = open === -1 ? -1 : src.indexOf('>', open);
      const close = src.indexOf('</Stack>');
      const children = open !== -1 && close > openEnd ? src.slice(openEnd + 1, close) : '';
      const screens = (src.match(/<Stack\.Screen\s/g) || []).length;
      const keyed = (src.match(/<Stack\.Screen\s+key=/g) || []).length;
      return {
        ok: children.trim() === '{screens}' && !children.includes('<>') && !children.includes('Fragment') && screens === keyed,
        detail: `children=${JSON.stringify(children.trim())} Stack.Screen=${screens} keyed=${keyed}`,
      };
    },
  },

  // ---------------- R2 ----------------
  {
    name: 'R2 driver: the REAL commitOnboarding reports the no-session failure',
    run() {
      const { commitOnboarding } = commitLoader();
      FAKE.session = null;
      FAKE.tables = {};
      return commitOnboarding({ weeklyGoal: 3, weekStart: 'Mon' }).then((res) => ({
        ok: res.ok === false && res.error === NO_SESSION_ERROR,
        detail: JSON.stringify(res),
      }));
    },
  },
  {
    name: 'R2 ui: that no-session failure is rendered above the CTA',
    run() {
      const { onboarding } = commitLoader();
      FAKE.session = null;
      FAKE.tables = {};
      return analyzeCommitSurfacing(onboarding, ONBOARDING_TAP_CHAIN, NO_SESSION_ERROR).then((r) => ({
        ok: r.errorReachedUi,
        detail: `reached=${r.errorReachedUi} texts=${r.texts}`,
      }));
    },
  },
  {
    name: 'R2 ui: "Let\'s go" is in its loading state while the commit is in flight',
    run() {
      const { onboarding } = commitLoader();
      FAKE.session = null;
      FAKE.tables = {};
      return analyzeCommitSurfacing(onboarding, ONBOARDING_TAP_CHAIN, NO_SESSION_ERROR).then((r) => ({
        ok: r.loadingDuringCommit,
        detail: `loading=${r.loadingDuringCommit}`,
      }));
    },
  },
  {
    name: 'R2 ui: a REAL write failure (FK violation) is rendered above the CTA',
    run() {
      const { onboarding } = commitLoader();
      FAKE.session = SESSION_ROW;
      FAKE.tables = { groups: { data: null, error: { message: FK_ERROR } } };
      return analyzeCommitSurfacing(onboarding, ONBOARDING_TAP_CHAIN, FK_ERROR).then((r) => ({
        ok: r.errorReachedUi,
        detail: `reached=${r.errorReachedUi} texts=${r.texts}`,
      }));
    },
  },
  {
    name: 'R2 negative control: the pre-fix shape (res.error discarded) stays silent',
    run() {
      const { WeekStartStep, commitOnboarding } = commitLoader();
      const PreFixRoute = function PreFixOnboardingRoute() {
        const finish = async () => {
          const res = await commitOnboarding({ weeklyGoal: 3, weekStart: 'Mon' });
          if (!res.ok) {
            return; // exactly master's (onboarding)/index.tsx:43-46
          }
          ROUTER.replace('/(home)/(tabs)');
        };
        return React.createElement(WeekStartStep, {
          value: 'Mon',
          onChange: () => undefined,
          onFinish: finish,
          onSkip: finish,
          onBack: () => undefined,
        });
      };
      FAKE.session = null;
      FAKE.tables = {};
      return analyzeCommitSurfacing(PreFixRoute, [{ name: 'WeekStartStep', prop: 'onFinish' }], NO_SESSION_ERROR).then(
        (r) => ({
          ok: r.errorReachedUi === false && r.loadingDuringCommit === false,
          detail: `silent=${!r.errorReachedUi} loading=${r.loadingDuringCommit}`,
        }),
      );
    },
  },
  {
    name: 'R2 static: the route renders res.error and passes the loading state',
    run() {
      const route = fs.readFileSync(path.join(ROOT, 'src/app/(onboarding)/index.tsx'), 'utf8');
      const setsError = /setError\(res\.error \?\?/.test(route);
      const rendersError = /error=\{error\}/.test(route);
      const loading = /loading=\{committing\}/.test(route);
      const screen = fs.readFileSync(path.join(ROOT, 'src/features/onboarding/OnboardingScreen.tsx'), 'utf8');
      const screenError = /error\?: string \| null/.test(screen) && /\{error \? \(/.test(screen);
      return {
        ok: setsError && rendersError && loading && screenError,
        detail: `setErrorFromResError=${setsError} error={error}=${rendersError} loading={committing}=${loading} shellRendersError=${screenError}`,
      };
    },
  },
  {
    name: 'R2 auth: a sign-up that returns NO session is not reported as success',
    run() {
      const { authenticate } = supabaseReal();
      FAKE.session = null;
      FAKE.signInError = { message: 'Invalid login credentials' };
      FAKE.signUpError = null;
      return authenticate('reviewer@example.com', 'hunter22').then((res) => ({
        ok: res.ok === false && /confirm/i.test(res.error || '') && (res.error || '').includes('reviewer@example.com'),
        detail: JSON.stringify(res),
      }));
    },
  },
  {
    name: 'R2 auth: a sign-up that returns a session still signs in',
    run() {
      const { authenticate } = supabaseReal();
      FAKE.session = SESSION_ROW;
      FAKE.signInError = { message: 'Invalid login credentials' };
      FAKE.signUpError = null;
      return authenticate('reviewer@example.com', 'hunter22').then((res) => ({
        ok: res.ok === true,
        detail: JSON.stringify(res),
      }));
    },
  },
  {
    name: 'R2 auth static: signUp is followed by a session check',
    run() {
      const src = fs.readFileSync(path.join(ROOT, 'src/lib/supabase.ts'), 'utf8');
      const signUp = src.indexOf('signUp({');
      const sessionCheck = src.indexOf('getSession()', signUp);
      return {
        ok: signUp !== -1 && sessionCheck > signUp && /afterSignUp\.session/.test(src),
        detail: `signUp@${signUp} getSession@${sessionCheck} afterSignUp.session=${/afterSignUp\.session/.test(src)}`,
      };
    },
  },

  // ---------------- R3 ----------------
  {
    name: 'R3: the practice-cam denied state offers the Open Settings control',
    run() {
      const { PracticeCamStep } = surfacesLoader();
      CAM.state = { granted: false, canAskAgain: false, status: 'denied' };
      const mounted = mountRoot(PracticeCamStep, { onNext: () => undefined, onSkip: () => undefined });
      const tree = mounted.render();
      const notNow = findPressables(tree).find((el) => joinText(el) === 'Not now');
      if (!notNow) return { ok: false, detail: `no "Not now" control; texts=${joinText(tree)}` };
      notNow.props.onPress();
      const after = mounted.render();
      return {
        ok: !!findByLabel(after, 'Open Settings'),
        detail: `control=${!!findByLabel(after, 'Open Settings')} texts=${joinText(after)}`,
      };
    },
  },
  {
    name: 'R3: the practice-cam control really opens Settings',
    run() {
      const { PracticeCamStep } = surfacesLoader();
      LINKING_CALLS = 0;
      CAM.state = { granted: false, canAskAgain: false, status: 'denied' };
      const mounted = mountRoot(PracticeCamStep, { onNext: () => undefined, onSkip: () => undefined });
      let tree = mounted.render();
      const notNow = findPressables(tree).find((el) => joinText(el) === 'Not now');
      if (notNow) notNow.props.onPress();
      tree = mounted.render();
      const pressed = pressOpenSettings(tree);
      return { ok: pressed && LINKING_CALLS === 1, detail: `pressed=${pressed} Linking.openSettings calls=${LINKING_CALLS}` };
    },
  },
  {
    name: 'R3: the LogSheet camera denial shows the Settings copy AND the control',
    run() {
      const { LogSheet } = surfacesLoader();
      CAM.state = { granted: false, canAskAgain: true, status: 'undetermined' };
      CAM.requestResult = { granted: false, canAskAgain: false, status: 'denied' };
      return analyzeDenialSurface(
        LogSheet,
        { visible: true, onClose: () => undefined, onLogged: () => undefined },
        {
          press: 'Take photo',
          after: () => {
            // What the OS does to useCameraPermissions after a refusal.
            CAM.state = CAM.requestResult;
          },
        },
      ).then((r) => {
        const texts = r.texts;
        const ok =
          r.pressed &&
          r.openSettings &&
          texts.includes(CAMERA_OFF_COPY) &&
          texts.includes(SETTINGS_DENIED_COPY);
        return {
          ok,
          detail: `pressed=${r.pressed} control=${r.openSettings} cameraOffCopy=${texts.includes(CAMERA_OFF_COPY)} settingsCopy=${texts.includes(SETTINGS_DENIED_COPY)} texts=${texts.join(' / ')}`,
        };
      });
    },
  },
  {
    name: 'R3: the LogSheet control really opens Settings',
    run() {
      const { LogSheet } = surfacesLoader();
      LINKING_CALLS = 0;
      CAM.state = { granted: false, canAskAgain: false, status: 'denied' };
      const mounted = mountRoot(LogSheet, { visible: true, onClose: () => undefined, onLogged: () => undefined });
      const tree = mounted.render();
      const pressed = pressOpenSettings(tree);
      return { ok: pressed && LINKING_CALLS === 1, detail: `pressed=${pressed} Linking.openSettings calls=${LINKING_CALLS}` };
    },
  },
  {
    name: 'R3 static: Linking.openSettings is called once, in the shared control, used by both surfaces',
    run() {
      const files = routeFilesOnDisk().concat([
        path.join(ROOT, 'src/components/OpenSettingsButton.tsx'),
        path.join(ROOT, 'src/features/onboarding/PracticeCamStep.tsx'),
        path.join(ROOT, 'src/features/logging/LogSheet.tsx'),
      ]);
      const callers = files.filter((f) => /Linking\.openSettings/.test(fs.readFileSync(f, 'utf8')));
      const control = fs.readFileSync(path.join(ROOT, 'src/components/OpenSettingsButton.tsx'), 'utf8');
      const practice = fs.readFileSync(path.join(ROOT, 'src/features/onboarding/PracticeCamStep.tsx'), 'utf8');
      const sheet = fs.readFileSync(path.join(ROOT, 'src/features/logging/LogSheet.tsx'), 'utf8');
      return {
        ok:
          callers.length === 1 &&
          path.basename(callers[0]) === 'OpenSettingsButton.tsx' &&
          /OpenSettingsButton/.test(practice) &&
          /OpenSettingsButton/.test(sheet) &&
          /OPEN_SETTINGS_LABEL = 'Open Settings'/.test(control),
        detail: `callers=[${callers.map((f) => path.relative(ROOT, f)).join(',')}] practice=${/OpenSettingsButton/.test(practice)} logSheet=${/OpenSettingsButton/.test(sheet)}`,
      };
    },
  },

  // ---------------- R4 ----------------
  {
    name: 'R4: app.json no longer advertises a Face ID prompt',
    run() {
      const raw = fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8');
      const app = readJson('app.json');
      const plugins = (app.expo && app.expo.plugins) || [];
      const secureStore = plugins.find((p) => Array.isArray(p) && p[0] === 'expo-secure-store');
      const faceID =
        raw.includes('faceIDPermission') ||
        (Array.isArray(secureStore) && !!secureStore[1] && 'faceIDPermission' in secureStore[1]);
      return { ok: !faceID, detail: `faceIDPermission present=${faceID}` };
    },
  },
  {
    name: 'R4: the camera usage string survives and no biometric module is claimed',
    run() {
      const app = readJson('app.json');
      const pkg = readJson('package.json');
      const camera =
        (app.expo && app.expo.ios && app.expo.ios.infoPlist && app.expo.ios.infoPlist.NSCameraUsageDescription) || '';
      const deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies));
      const biometric = deps.filter((d) => /local-authentication|biometric/.test(d));
      return {
        ok: camera.length > 0 && biometric.length === 0,
        detail: `NSCameraUsageDescription=${camera ? 'present' : 'MISSING'} biometric deps=[${biometric.join(',')}]`,
      };
    },
  },
];

// --------------------------------------------------------------------------
// run
// --------------------------------------------------------------------------
console.log('=== auth-gate-guard: first-run App Review gate (R1-R4) ===');
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
