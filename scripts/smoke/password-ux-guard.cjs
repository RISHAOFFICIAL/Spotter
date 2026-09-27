#!/usr/bin/env node
/**
 * password-ux-guard — the owner-reported signup password defect (2026-09-26),
 * gated offline against the REAL components.
 *
 * THE DEFECT (owner's words): "The password when creating the account isn't
 * verified, nor is there a way to show the password to make sure it was typed
 * correctly." Verified in source before fixing: WelcomeStep.tsx rendered ONE
 * masked field (`secureTextEntry` as a bare attribute, no state) and called
 * authenticate(email, password) once — no confirm field, no reveal affordance
 * anywhere in src/. A first-run typo therefore created an account the user
 * could not sign back into, with no way to check before submitting.
 *
 * TWO SCREENS CARRIED IT, so this ONE guard renders BOTH (2026-09-26, second
 * pass): src/features/onboarding/WelcomeStep.tsx (fixed by PR #42) and
 * src/features/invites/EnterCodeScreen.tsx — the pre-auth "Join & create
 * account" path an invited reviewer walks, and the screen App Store frame 07
 * depicts. Same defect, same fix, same glyph vocabulary; a guard that covered
 * only the first screen would have declared the class closed one screen early.
 *
 * WHAT THIS GUARD PROVES (all against the real sources rendered in plain Node
 * with leaf stubs — the rn-ui-tree-guard approach, see
 * skills/rn-ui-tree-guard-offline):
 *   - the reveal control exists on every password field, is a 48pt (>=44pt)
 *     button, and its accessibility label follows the state;
 *   - tapping it really flips that field's secureTextEntry (read back from the
 *     re-rendered element — not asserted in a comment);
 *   - CREATE mode (the default on both screens) renders a "Confirm password"
 *     field; SIGN-IN mode does not, and still has one password field with a
 *     reveal control;
 *   - a mismatch BLOCKS the submit: the message is RENDERED in the app's danger
 *     colour AND authenticate() is never reached (counting spy + counting
 *     Supabase client both at zero), and the CTA is not left spinning. On
 *     EnterCodeScreen it must also never reach accept_invite or the onboarding
 *     commit — a blocked submit does nothing at all;
 *   - a match calls authenticate() exactly once, with the typed credentials,
 *     then advances (WelcomeStep: onDone(); EnterCodeScreen: exactly one
 *     accept_invite and a replace onto the group feed);
 *   - the landing state (before "Get started") is byte-for-byte the same text
 *     as master's, so the App Store frame cut from that screen cannot go stale.
 *
 * NEGATIVE CONTROL (run it, do not trust it): this file is committed on the fix
 * branch, so put master's unfixed components back and run the SAME guard —
 *   mkdir -p /tmp/pre-fix && git worktree add /tmp/pre-fix master   # or a plain
 *   cp of master's tree                                               # checkout
 *   SPOTTER_GUARD_ROOT=/tmp/pre-fix node scripts/smoke/password-ux-guard.cjs
 *   (equivalently, in a dirty tree: git checkout master -- <the two files>)
 * It must FAIL there on real behaviour on BOTH screens — no reveal control, no
 * confirm field, a mismatch reaching authenticate() — not on a missing string.
 * The measured pre-fix numbers are recorded in
 * /home/team/shared/enter-code-password-ux-2026-09-26.md.
 *
 * SPOTTER_GUARD_DUMP=1 prints the landing-state text baseline and exits — that
 * is how the frozen baseline below was captured (from master's component).
 *
 * Every check prints exactly one PASS/FAIL line, so the runner can count them:
 *   node scripts/smoke/password-ux-guard.cjs        (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const React = require('react');

// The app reads these at module scope to decide real vs dev-mock mode. Set them
// BEFORE any app module is evaluated so src/lib/supabase.ts builds a real client
// (which the stub below supplies) instead of the dev mock.
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://password-ux-guard.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'password-ux-guard-anon-key';

const ROOT = path.resolve(process.env.SPOTTER_GUARD_ROOT || path.join(__dirname, '..', '..'));
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
// fixtures — the REAL WelcomeStep, with a counting auth module underneath it
// --------------------------------------------------------------------------
const MISMATCH_COPY = "Those passwords don't match — try again.";
const CTA_LABEL = 'Get started';
const SIGN_IN_ROW = 'Already have an account? Sign in';
const CREATE_ROW = 'New here? Create an account';
const SHOW_PW = 'Show password';
const HIDE_PW = 'Hide password';
const SHOW_CF = 'Show confirm password';
const HIDE_CF = 'Hide confirm password';
const WELCOME_REL = path.join('src', 'features', 'onboarding', 'WelcomeStep.tsx');

// Captured with SPOTTER_GUARD_DUMP=1 against MASTER's component (the pre-fix
// file), so the check below means "the screen before the form opens is
// unchanged" — the App Store frame of this screen is cut from that state.
const LANDING_BASELINE =
  "SPOTTER | Start on your own. Bring your crew in anytime. | Set a weekly goal and log with photo proof \u2014 your ring starts filling today, solo or with a group. | \u2713 | Your photos are sealed to your account. Only you and your group can ever see them. | Free. No subscription required. | Have an invite code? | One account keeps your photos sealed to you. | Get started";

const AUTH_CALLS = []; // [email, password] per authenticate() call
const CLIENT = { signIn: 0, signUp: 0 };
const COUNTING_AUTH = {
  getSession: async () => ({ data: { session: FAKE.session } }),
  signInWithPassword: async () => {
    CLIENT.signIn += 1;
    return { error: FAKE.signInError };
  },
  signUp: async () => {
    CLIENT.signUp += 1;
    return { error: FAKE.signUpError };
  },
  signOut: async () => ({ error: null }),
};
let DONE_CALLS = 0;

let FIXTURE = null;
function fixture() {
  if (FIXTURE) return FIXTURE;
  const base = Object.assign(nativeStubs(), libStubs(), {
    '@supabase/supabase-js': { createClient: () => ({ auth: COUNTING_AUTH, from: fakeQuery }) },
  });
  // The REAL src/lib/supabase.ts (REAL mode: the env vars above are set), so the
  // component's single submit path is exercised end to end — signInWithPassword
  // then signUp then getSession — with only the network layer replaced.
  const supabaseMod = makeLoader(base).loadFile(path.join(ROOT, 'src', 'lib', 'supabase.ts'));
  const realAuthenticate = supabaseMod.authenticate;
  supabaseMod.authenticate = async (email, password) => {
    AUTH_CALLS.push([email, password]);
    return realAuthenticate(email, password);
  };
  const loader = makeLoader(
    Object.assign({}, base, {
      '@/lib/supabase': supabaseMod,
      // InviteRow generates a share code on mount (network + native Share): it is
      // not the subject here, so it is stubbed the way auth-gate-guard does.
      '@/features/invites/InviteRow': { InviteRow: makeSpy('InviteRow') },
    }),
  );
  FIXTURE = {
    WelcomeStep: loader.loadFile(path.join(ROOT, WELCOME_REL)).WelcomeStep,
    colors: loader.loadFile(path.join(ROOT, 'src', 'theme', 'tokens.ts')).colors,
  };
  return FIXTURE;
}

/**
 * Mount the REAL WelcomeStep. The auth form lives in the `footer` PROP, but the
 * real OnboardingScreen renders `{footer}` inside its own children
 * (OnboardingScreen.tsx styles.actions), so the form IS reachable by walking the
 * rendered tree — the checks below only pass if it stays that way, which is the
 * guard on the shell/screen wiring as well.
 */
function mountWelcome() {
  const { WelcomeStep } = fixture();
  DONE_CALLS = 0;
  AUTH_CALLS.length = 0;
  CLIENT.signIn = 0;
  CLIENT.signUp = 0;
  FAKE.session = null;
  FAKE.signInError = null;
  FAKE.signUpError = null;
  STORES.clear();
  const store = storeFor('root');
  const props = {
    onDone: () => {
      DONE_CALLS += 1;
    },
  };
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
        out = WelcomeStep(props);
      } finally {
        CURRENT_STORE = previous;
      }
      api.renders += 1;
      api.raw = out;
      api.tree = expand(out, 'root');
      flushEffects();
      return api;
    },
  };
  return api.render();
}

// --------------------------------------------------------------------------
// fixtures #2 — EnterCodeScreen: the pre-auth "Join & create account" path
// --------------------------------------------------------------------------
// Same defect, second screen (2026-09-26). Everything below renders the REAL
// src/features/invites/EnterCodeScreen.tsx. Only three things are stubbed so the
// screen can be walked to its create-account stage without a network: the auth
// session (useAuth), the invite calls (lookupInvite/acceptInvite) and the
// onboarding commit. authenticate() itself is the REAL src/lib/supabase one,
// wrapped in a counting spy — that is the assertion that matters.
const EC_REL = path.join('src', 'features', 'invites', 'EnterCodeScreen.tsx');
const EC_CODE_FIELD = 'Invite code';
const EC_LOOKUP_LABEL = 'Look up code';
const EC_CTA_CREATE = 'Join & create account';
const EC_CTA_SIGN_IN = 'Sign in & join';

const EC = {
  session: null,
  refreshCalls: 0,
  lookup: null,
  lookupCalls: [],
  acceptCalls: [],
  commitCalls: [],
};

let EC_FIXTURE = null;
function ecFixture() {
  if (EC_FIXTURE) return EC_FIXTURE;
  const base = Object.assign(nativeStubs(), libStubs(), {
    '@supabase/supabase-js': { createClient: () => ({ auth: COUNTING_AUTH, from: fakeQuery }) },
    '@/features/auth/AuthProvider': {
      useAuth: () => ({
        session: EC.session,
        refresh: async () => {
          EC.refreshCalls += 1;
        },
      }),
    },
    // Mirrors src/lib/invites.ts (normalizeInviteCode is the same 3 calls);
    // these are not the subject here, they are the road to the form.
    '@/lib/invites': {
      normalizeInviteCode: (input) =>
        String(input || '')
          .trim()
          .replace(/^DEV-/i, '')
          .replace(/[^A-Z0-9]/gi, '')
          .toUpperCase(),
      lookupInvite: async (code) => {
        EC.lookupCalls.push(code);
        return EC.lookup;
      },
      acceptInvite: async (code) => {
        EC.acceptCalls.push(code);
        return { ok: true };
      },
      friendlyAcceptError: (message) => message,
    },
    '@/lib/settings': {
      commitOnboarding: async (opts) => {
        EC.commitCalls.push(opts);
        return { ok: true };
      },
      DEFAULT_WEEKLY_GOAL: 3,
      DEFAULT_WEEK_START: 1,
    },
  });
  const supabaseMod = makeLoader(base).loadFile(path.join(ROOT, 'src', 'lib', 'supabase.ts'));
  const realAuthenticate = supabaseMod.authenticate;
  supabaseMod.authenticate = async (email, password) => {
    AUTH_CALLS.push([email, password]);
    return realAuthenticate(email, password);
  };
  const loader = makeLoader(Object.assign({}, base, { '@/lib/supabase': supabaseMod }));
  EC_FIXTURE = {
    EnterCodeScreen: loader.loadFile(path.join(ROOT, EC_REL)).EnterCodeScreen,
    colors: loader.loadFile(path.join(ROOT, 'src', 'theme', 'tokens.ts')).colors,
  };
  return EC_FIXTURE;
}

/** Mount the REAL EnterCodeScreen with no session, every counter reset. */
function mountEnterCode() {
  const { EnterCodeScreen } = ecFixture();
  AUTH_CALLS.length = 0;
  CLIENT.signIn = 0;
  CLIENT.signUp = 0;
  FAKE.session = null;
  FAKE.signInError = null;
  FAKE.signUpError = null;
  ROUTER.replaced.length = 0;
  ROUTER.pushed.length = 0;
  EC.session = null;
  EC.refreshCalls = 0;
  EC.lookupCalls.length = 0;
  EC.acceptCalls.length = 0;
  EC.commitCalls.length = 0;
  EC.lookup = { found: true, inviterName: 'Alex', inviterHasLogs: true, memberCount: 1, hasGroup: true };
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
        out = EnterCodeScreen({});
      } finally {
        CURRENT_STORE = previous;
      }
      api.renders += 1;
      api.raw = out;
      api.tree = expand(out, 'root');
      flushEffects();
      return api;
    },
  };
  return api.render();
}

/**
 * Walk the real screen to the create-account stage: type a code, tap the
 * lookup, and land on the FOUND stage where the form lives. If any of that
 * stops working the throw is reported as a FAIL by the caller.
 */
async function enterFoundStage() {
  const m = mountEnterCode();
  type(m, EC_CODE_FIELD, 'K4M7-Q2PX');
  if (EC.lookupCalls.length > 0) throw new Error('the lookup ran before the button was tapped');
  await tapAsync(m, EC_LOOKUP_LABEL);
  assert(screenText(m).includes('Join Alex'), `the FOUND stage did not render: ${screenText(m)}`);
  assert(hasField(m, 'Email'), 'the create-account form did not render its Email field');
  return m;
}

/** Every element of the rendered screen, following `children` (footer included). */
function deepEls(node) {
  const out = [];
  (function rec(n) {
    if (n === null || n === undefined || typeof n === 'boolean') return;
    if (Array.isArray(n)) {
      n.forEach(rec);
      return;
    }
    if (!React.isValidElement(n)) return;
    out.push(n);
    rec(n.props.children);
    if (n.props.footer) rec(n.props.footer);
  })(node);
  return out;
}
function els(m) {
  return deepEls(m.tree);
}
function norm(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}
function byLabel(m, label) {
  return els(m).filter((e) => e.props.accessibilityLabel === label);
}
function control(m, label) {
  const hit = byLabel(m, label).find((e) => typeof e.props.onPress === 'function');
  if (!hit) throw new Error(`no control labelled "${label}" is rendered`);
  return hit;
}
function tap(m, label) {
  control(m, label).props.onPress();
  return m.render();
}
async function tapAsync(m, label) {
  tap(m, label);
  await flushMicrotasks();
  return m.render();
}
function field(m, label) {
  const hit = byLabel(m, label).find((e) => e.type === 'TextInput');
  if (!hit) throw new Error(`no TextInput labelled "${label}" is rendered`);
  return hit;
}
function hasField(m, label) {
  return byLabel(m, label).some((e) => e.type === 'TextInput');
}
function type(m, label, value) {
  field(m, label).props.onChangeText(value);
  return m.render();
}
function styleOf(el) {
  const raw = el.props.style;
  const arr = Array.isArray(raw) ? raw.flat(3) : [raw];
  return Object.assign({}, ...arr.filter((s) => s && typeof s === 'object'));
}
function screenText(m) {
  return norm(joinText(m.tree));
}
function dangerColor() {
  return fixture().colors.text.danger.hex;
}
/** The rendered error line: exact copy AND the app's danger colour (visible). */
function errorLines(m, copy) {
  return els(m).filter(
    (e) => e.type === 'Text' && norm(joinText(e)) === norm(copy) && styleOf(e).color === dangerColor(),
  );
}
function ctaIsLoading(m, label = CTA_LABEL) {
  return deepEls(control(m, label)).some((e) => e.type === 'ActivityIndicator');
}
/** Labels of the password-reveal controls, in render order. */
function revealLabels(m) {
  return els(m)
    .filter((e) => [SHOW_PW, HIDE_PW, SHOW_CF, HIDE_CF].includes(e.props.accessibilityLabel))
    .map((e) => e.props.accessibilityLabel);
}
function revealControl(m, maskedLabel) {
  return control(m, maskedLabel);
}
/**
 * The ONE analyser used for the real tree, the pre-fix control and the frozen
 * check — so a "fix" cannot pass by moving the problem.
 */
function analysePasswordUx(node) {
  const list = deepEls(node);
  const pw = list.find((e) => e.type === 'TextInput' && e.props.accessibilityLabel === 'Password');
  const cf = list.find((e) => e.type === 'TextInput' && e.props.accessibilityLabel === 'Confirm password');
  const revealPw = list.find(
    (e) => [SHOW_PW, HIDE_PW].includes(e.props.accessibilityLabel) && typeof e.props.onPress === 'function',
  );
  const revealCf = list.find(
    (e) => [SHOW_CF, HIDE_CF].includes(e.props.accessibilityLabel) && typeof e.props.onPress === 'function',
  );
  return {
    hasPasswordField: !!pw,
    secureTextEntry: pw ? pw.props.secureTextEntry : null,
    hasConfirmField: !!cf,
    confirmSecureTextEntry: cf ? cf.props.secureTextEntry : null,
    hasRevealForPassword: !!revealPw,
    hasRevealForConfirm: !!revealCf,
  };
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, what) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// SPOTTER_GUARD_DUMP=1 — re-derive the landing-state baseline (and check the
// same number against another tree, e.g. a master worktree via SPOTTER_GUARD_ROOT).
if (process.env.SPOTTER_GUARD_DUMP === '1') {
  const m = mountWelcome();
  console.log(JSON.stringify({ root: ROOT, landing: screenText(m) }, null, 2));
  process.exit(0);
}

// --------------------------------------------------------------------------
// the checks — a fixed table, one PASS/FAIL line each, always
// --------------------------------------------------------------------------
const CHECKS = [
  {
    name: 'load: the REAL WelcomeStep renders from source with leaf deps stubbed',
    run() {
      const m = mountWelcome();
      assertEq(typeof fixture().WelcomeStep, 'function', 'WelcomeStep export');
      assert(m.renders === 1 && m.tree !== null, 'the screen did not render');
      assert(screenText(m).includes('SPOTTER'), 'the wordmark is not on the screen');
    },
  },
  {
    name: 'self-check: the same analyser reports the PRE-FIX shape as defective',
    run() {
      // A hand-built pre-fix password row: one masked field, nothing else.
      const PreFix = function PreFix() {
        return React.createElement(
          'View',
          null,
          React.createElement('TextInput', {
            accessibilityLabel: 'Password',
            secureTextEntry: true,
          }),
        );
      };
      const before = analysePasswordUx(expand(React.createElement(PreFix), 'prefix'));
      assertEq(before.hasRevealForPassword, false, 'pre-fix reveal control');
      assertEq(before.hasConfirmField, false, 'pre-fix confirm field');
      assertEq(before.secureTextEntry, true, 'pre-fix secureTextEntry');
    },
  },
  {
    name: 'landing state (before "Get started"): no password/confirm field, no reveal control, no mode switch',
    run() {
      const m = mountWelcome();
      const labels = els(m)
        .map((e) => e.props.accessibilityLabel)
        .filter(Boolean);
      assert(!labels.includes('Password'), 'a Password field renders before the form opens');
      assert(!labels.includes('Confirm password'), 'a Confirm password field renders before the form opens');
      assert(!labels.includes(SHOW_PW) && !labels.includes(HIDE_PW), 'a reveal control renders before the form opens');
      assert(
        !labels.includes(SIGN_IN_ROW) && !labels.includes(CREATE_ROW),
        'the mode switch renders before the form opens',
      );
    },
  },
  {
    name: 'landing state text is IDENTICAL to master (the App Store frame cannot go stale)',
    run() {
      const m = mountWelcome();
      if (LANDING_BASELINE.startsWith('__LANDING')) {
        throw new Error('baseline not captured — run SPOTTER_GUARD_DUMP=1 against master');
      }
      assertEq(screenText(m), norm(LANDING_BASELINE), 'landing-state text');
    },
  },
  {
    name: 'create mode is the default: opening the form renders a Confirm password field',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      const a = analysePasswordUx(m.tree);
      assert(a.hasPasswordField, 'no password field after opening the form');
      assert(a.hasConfirmField, 'the default mode is not create (no confirm field)');
    },
  },
  {
    name: 'create mode: the password field is masked (secureTextEntry true)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry');
    },
  },
  {
    name: 'create mode: the password field has a reveal control, 48pt (>=44pt) button, labelled',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      const el = revealControl(m, SHOW_PW);
      assertEq(el.props.accessibilityRole, 'button', 'reveal accessibilityRole');
      const s = styleOf(el);
      assert(s.width >= 44 && s.height >= 44, `reveal hit target is ${s.width}x${s.height}, want >=44x44`);
      assertEq(el.props.accessibilityLabel, SHOW_PW, 'reveal label while masked');
    },
  },
  {
    name: 'create mode: tapping reveal FLIPS the password field to secureTextEntry false',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, false, 'password secureTextEntry after reveal');
      assert(m.renders >= 3, `the reveal tap did not re-render (renders=${m.renders})`);
    },
  },
  {
    name: 'create mode: revealed, the control announces "Hide password"',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      assertEq(control(m, HIDE_PW).props.accessibilityLabel, HIDE_PW, 'reveal label while revealed');
      assert(!byLabel(m, SHOW_PW).some((e) => typeof e.props.onPress === 'function'), 'the Show label survived');
    },
  },
  {
    name: 'create mode: tapping reveal again returns the field to masked (round trip)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      tap(m, HIDE_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry after hiding again');
    },
  },
  {
    name: 'create mode: the confirm field is masked, has its own 48pt reveal control',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assertEq(field(m, 'Confirm password').props.secureTextEntry, true, 'confirm secureTextEntry');
      const el = revealControl(m, SHOW_CF);
      const s = styleOf(el);
      assert(s.width >= 44 && s.height >= 44, `confirm reveal hit target is ${s.width}x${s.height}`);
      assertEq(el.props.accessibilityRole, 'button', 'confirm reveal accessibilityRole');
    },
  },
  {
    name: 'create mode: the confirm reveal flips ONLY the confirm field',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_CF);
      assertEq(field(m, 'Confirm password').props.secureTextEntry, false, 'confirm secureTextEntry after reveal');
      assertEq(field(m, 'Password').props.secureTextEntry, true, 'the password field moved with it');
      assertEq(revealLabels(m).join(','), [SHOW_PW, HIDE_CF].join(','), 'reveal labels after the confirm tap');
    },
  },
  {
    name: 'mismatch: submit renders the mismatch message UNDER the fields in the danger colour',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter23');
      return tapAsync(m, CTA_LABEL).then((mm) => {
        const hits = errorLines(mm, MISMATCH_COPY);
        assert(hits.length === 1, `rendered mismatch lines = ${hits.length}, want exactly 1`);
        assert(screenText(mm).includes(MISMATCH_COPY), 'the mismatch copy is not in the rendered screen text');
      });
    },
  },
  {
    name: 'mismatch: authenticate() is NEVER reached (spy 0, Supabase client 0) and onDone is not called',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter23');
      return tapAsync(m, CTA_LABEL).then(() => {
        assertEq(AUTH_CALLS.length, 0, 'authenticate() calls');
        assertEq(CLIENT.signIn + CLIENT.signUp, 0, 'Supabase auth attempts');
        assertEq(DONE_CALLS, 0, 'onDone() calls');
      });
    },
  },
  {
    name: 'mismatch: the CTA is not left spinning (no loading state, label still drawn)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter23');
      return tapAsync(m, CTA_LABEL).then((mm) => {
        assertEq(ctaIsLoading(mm), false, 'the CTA is in its loading state after a blocked submit');
        assert(norm(joinText(control(mm, CTA_LABEL))).includes(CTA_LABEL), 'the CTA label disappeared');
      });
    },
  },
  {
    name: 'match: submit calls authenticate() EXACTLY once, with the typed credentials, then advances',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter22');
      return tapAsync(m, CTA_LABEL).then(() => {
        assertEq(AUTH_CALLS.length, 1, 'authenticate() calls');
        assertEq(JSON.stringify(AUTH_CALLS[0]), JSON.stringify(['reviewer@example.com', 'hunter22']), 'args');
        assertEq(DONE_CALLS, 1, 'onDone() calls');
      });
    },
  },
  {
    name: 'match: the REAL single submit path ran once (signIn attempted once, no sign-up fallback)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter22');
      return tapAsync(m, CTA_LABEL).then(() => {
        assertEq(CLIENT.signIn, 1, 'signInWithPassword calls');
        assertEq(CLIENT.signUp, 0, 'signUp calls');
      });
    },
  },
  {
    name: 'match: a real auth failure is RENDERED and does not advance',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      type(m, 'Confirm password', 'hunter22');
      FAKE.signInError = { message: 'Invalid login credentials' };
      FAKE.signUpError = { message: 'User already registered' };
      return tapAsync(m, CTA_LABEL).then((mm) => {
        assert(errorLines(mm, 'User already registered').length === 1, 'the failure is not rendered in danger colour');
        assertEq(DONE_CALLS, 0, 'onDone() calls after a failure');
        assertEq(ctaIsLoading(mm), false, 'the CTA is stuck loading after a failure');
      });
    },
  },
  {
    name: 'sign-in mode: the mode switch exists and switching removes the confirm field',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assert(control(m, SIGN_IN_ROW), 'no sign-in mode switch');
      tap(m, SIGN_IN_ROW);
      assert(!hasField(m, 'Confirm password'), 'the confirm field survives into sign-in mode');
      assert(control(m, CREATE_ROW), 'no way back to create mode');
      const a = analysePasswordUx(m.tree);
      assert(a.hasPasswordField, 'sign-in mode lost its password field');
      assertEq(a.hasConfirmField, false, 'sign-in mode confirm field');
    },
  },
  {
    name: 'sign-in mode: the single password field keeps its reveal control',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SIGN_IN_ROW);
      assertEq(revealLabels(m).join(','), SHOW_PW, 'reveal controls in sign-in mode');
      tap(m, SHOW_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, false, 'sign-in reveal did not flip the field');
    },
  },
  {
    name: 'sign-in mode: submit has no confirm gate (calls authenticate() once and advances)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SIGN_IN_ROW);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'hunter22');
      return tapAsync(m, CTA_LABEL).then(() => {
        assertEq(AUTH_CALLS.length, 1, 'authenticate() calls in sign-in mode');
        assertEq(DONE_CALLS, 1, 'onDone() calls in sign-in mode');
      });
    },
  },
  {
    name: 'static: the masked state is STATE-DERIVED (no bare secureTextEntry attribute)',
    run() {
      const src = fs.readFileSync(path.join(ROOT, WELCOME_REL), 'utf8');
      const braced = (src.match(/secureTextEntry=\{!\w+\}/g) || []).length;
      assertEq(braced, 2, 'state-derived secureTextEntry sites (password + confirm)');
      assert(!/^\s*secureTextEntry\s*$/m.test(src), 'a bare secureTextEntry attribute is back');
    },
  },
  {
    name: 'static: authenticate() is still the ONE submit path (no direct Supabase call)',
    run() {
      const src = fs.readFileSync(path.join(ROOT, WELCOME_REL), 'utf8');
      assert(src.includes("import('@/lib/supabase')"), 'the component no longer imports the shared auth module');
      assert(!/signInWithPassword|signUp\(|getSession\(/.test(src), 'the component calls Supabase auth directly');
    },
  },
  // ------------------------------------------------------------------
  // EnterCodeScreen — the SECOND screen that carried the same defect
  // (the pre-auth "Join & create account" path). Same assertions, same table.
  // ------------------------------------------------------------------
  {
    name: 'enter-code: load — the REAL EnterCodeScreen renders from source with leaf deps stubbed',
    run() {
      const m = mountEnterCode();
      assertEq(typeof ecFixture().EnterCodeScreen, 'function', 'EnterCodeScreen export');
      assert(m.renders === 1 && m.tree !== null, 'the screen did not render');
      assert(screenText(m).includes('Join a group'), 'the enter-code stage is not on screen');
      assert(hasField(m, EC_CODE_FIELD), 'the invite-code field is missing');
      assertEq(EC.lookupCalls.length, 0, 'lookupInvite calls before the button was tapped');
    },
  },
  {
    name: 'enter-code: looking up a code reaches the FOUND stage with the create-account form',
    run() {
      return enterFoundStage().then((m) => {
        assertEq(EC.lookupCalls.length, 1, 'lookupInvite calls');
        assertEq(EC.lookupCalls[0], 'K4M7Q2PX', 'the normalized code handed to lookupInvite');
        assert(control(m, EC_CTA_CREATE), 'no "Join & create account" CTA on the FOUND stage');
      });
    },
  },
  {
    name: 'enter-code: create mode is the default — the FOUND stage renders a Confirm password field',
    run() {
      return enterFoundStage().then((m) => {
        const a = analysePasswordUx(m.tree);
        assert(a.hasPasswordField, 'no password field after reaching the FOUND stage');
        assert(a.hasConfirmField, 'the default mode is not create (no confirm field)');
      });
    },
  },
  {
    name: 'enter-code: create mode — the password field is masked (secureTextEntry true)',
    run() {
      return enterFoundStage().then((m) => {
        assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry');
      });
    },
  },
  {
    name: 'enter-code: create mode — the password field has a reveal control, 48pt (>=44pt), labelled',
    run() {
      return enterFoundStage().then((m) => {
        const el = revealControl(m, SHOW_PW);
        assertEq(el.props.accessibilityRole, 'button', 'reveal accessibilityRole');
        const s = styleOf(el);
        assert(s.width >= 44 && s.height >= 44, `reveal hit target is ${s.width}x${s.height}, want >=44x44`);
        assertEq(el.props.accessibilityLabel, SHOW_PW, 'reveal label while masked');
      });
    },
  },
  {
    name: 'enter-code: create mode — tapping reveal FLIPS the password field to secureTextEntry false',
    run() {
      return enterFoundStage().then((m) => {
        const before = m.renders;
        tap(m, SHOW_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, false, 'password secureTextEntry after reveal');
        assert(m.renders > before, `the reveal tap did not re-render (renders=${m.renders})`);
      });
    },
  },
  {
    name: 'enter-code: create mode — revealed, the control announces "Hide password"',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SHOW_PW);
        assertEq(control(m, HIDE_PW).props.accessibilityLabel, HIDE_PW, 'reveal label while revealed');
        assert(!byLabel(m, SHOW_PW).some((e) => typeof e.props.onPress === 'function'), 'the Show label survived');
      });
    },
  },
  {
    name: 'enter-code: create mode — tapping reveal again returns the field to masked (round trip)',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SHOW_PW);
        tap(m, HIDE_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry after hiding again');
      });
    },
  },
  {
    name: 'enter-code: create mode — the confirm field is masked, with its own 48pt reveal control',
    run() {
      return enterFoundStage().then((m) => {
        assertEq(field(m, 'Confirm password').props.secureTextEntry, true, 'confirm secureTextEntry');
        const el = revealControl(m, SHOW_CF);
        const s = styleOf(el);
        assert(s.width >= 44 && s.height >= 44, `confirm reveal hit target is ${s.width}x${s.height}`);
        assertEq(el.props.accessibilityRole, 'button', 'confirm reveal accessibilityRole');
      });
    },
  },
  {
    name: 'enter-code: create mode — the confirm reveal flips ONLY the confirm field',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SHOW_CF);
        assertEq(field(m, 'Confirm password').props.secureTextEntry, false, 'confirm secureTextEntry after reveal');
        assertEq(field(m, 'Password').props.secureTextEntry, true, 'the password field moved with it');
        assertEq(revealLabels(m).join(','), [SHOW_PW, HIDE_CF].join(','), 'reveal labels after the confirm tap');
      });
    },
  },
  {
    name: 'enter-code: mismatch — exactly ONE message renders, in the app danger colour',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        type(m, 'Confirm password', 'hunter23');
        return tapAsync(m, EC_CTA_CREATE).then((mm) => {
          const hits = errorLines(mm, MISMATCH_COPY);
          assertEq(hits.length, 1, 'rendered mismatch lines, want exactly 1');
          assert(screenText(mm).includes(MISMATCH_COPY), 'the mismatch copy is not in the rendered screen text');
        });
      });
    },
  },
  {
    name: 'enter-code: mismatch — authenticate() is NEVER reached and nothing else runs either',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        type(m, 'Confirm password', 'hunter23');
        return tapAsync(m, EC_CTA_CREATE).then(() => {
          assertEq(AUTH_CALLS.length, 0, 'authenticate() calls');
          assertEq(CLIENT.signIn + CLIENT.signUp, 0, 'Supabase auth attempts');
          assertEq(EC.acceptCalls.length, 0, 'accept_invite calls');
          assertEq(EC.commitCalls.length, 0, 'onboarding commits');
          assertEq(ROUTER.replaced.length, 0, 'router.replace calls');
        });
      });
    },
  },
  {
    name: 'enter-code: mismatch — the CTA is not left spinning (no loading state, label still drawn)',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        type(m, 'Confirm password', 'hunter23');
        return tapAsync(m, EC_CTA_CREATE).then((mm) => {
          assertEq(ctaIsLoading(mm, EC_CTA_CREATE), false, 'the CTA is in its loading state after a blocked submit');
          assert(norm(joinText(control(mm, EC_CTA_CREATE))).includes(EC_CTA_CREATE), 'the CTA label disappeared');
        });
      });
    },
  },
  {
    name: 'enter-code: match — authenticate() EXACTLY once, then the invite is accepted once and the app advances',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        type(m, 'Confirm password', 'hunter22');
        return tapAsync(m, EC_CTA_CREATE).then(() => {
          assertEq(AUTH_CALLS.length, 1, 'authenticate() calls');
          assertEq(JSON.stringify(AUTH_CALLS[0]), JSON.stringify(['reviewer@example.com', 'hunter22']), 'args');
          assertEq(CLIENT.signIn, 1, 'signInWithPassword calls (the REAL single submit path)');
          assertEq(CLIENT.signUp, 0, 'signUp calls');
          assertEq(EC.commitCalls.length, 1, 'onboarding commits');
          assertEq(EC.acceptCalls.length, 1, 'accept_invite calls');
          assertEq(EC.acceptCalls[0], 'K4M7Q2PX', 'the code accept_invite was called with');
          assertEq(EC.refreshCalls, 2, 'session refreshes (once after auth, once after the accept)');
          assertEq(ROUTER.replaced.length, 1, 'router.replace calls');
          assertEq(ROUTER.replaced[0] && ROUTER.replaced[0].pathname, '/(home)/(tabs)', 'the replace target');
        });
      });
    },
  },
  {
    name: 'enter-code: sign-in mode — the switch exists, switching removes the confirm field, message cleared',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        type(m, 'Confirm password', 'hunter23');
        return tapAsync(m, EC_CTA_CREATE).then((mm) => {
          assert(control(mm, SIGN_IN_ROW), 'no sign-in mode switch');
          tap(mm, SIGN_IN_ROW);
          assert(!hasField(mm, 'Confirm password'), 'the confirm field survives into sign-in mode');
          assert(control(mm, CREATE_ROW), 'no way back to create mode');
          assert(control(mm, EC_CTA_SIGN_IN), 'sign-in mode kept the create-account CTA label');
          assert(!screenText(mm).includes(MISMATCH_COPY), 'the create-mode message survived the mode switch');
          const a = analysePasswordUx(mm.tree);
          assert(a.hasPasswordField, 'sign-in mode lost its password field');
          assertEq(a.hasConfirmField, false, 'sign-in mode confirm field');
        });
      });
    },
  },
  {
    name: 'enter-code: sign-in mode — reveal survives, and submit has no confirm gate',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SIGN_IN_ROW);
        assertEq(revealLabels(m).join(','), SHOW_PW, 'reveal controls in sign-in mode');
        tap(m, SHOW_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, false, 'the sign-in reveal did not flip the field');
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
        return tapAsync(m, EC_CTA_SIGN_IN).then(() => {
          assertEq(AUTH_CALLS.length, 1, 'authenticate() calls in sign-in mode');
          assertEq(EC.acceptCalls.length, 1, 'accept_invite calls in sign-in mode');
          assertEq(ROUTER.replaced.length, 1, 'router.replace calls in sign-in mode');
        });
      });
    },
  },
  {
    name: 'enter-code static: the masked state is STATE-DERIVED (no bare secureTextEntry attribute)',
    run() {
      const src = fs.readFileSync(path.join(ROOT, EC_REL), 'utf8');
      const braced = (src.match(/secureTextEntry=\{!\w+\}/g) || []).length;
      assertEq(braced, 2, 'state-derived secureTextEntry sites (password + confirm)');
      assert(!/^\s*secureTextEntry\s*$/m.test(src), 'a bare secureTextEntry attribute is back');
    },
  },
  {
    name: 'enter-code static: authenticate() is still the ONE submit path (no direct Supabase call)',
    run() {
      const src = fs.readFileSync(path.join(ROOT, EC_REL), 'utf8');
      assert(src.includes("import('@/lib/supabase')"), 'the component no longer imports the shared auth module');
      assert(!/signInWithPassword|signUp\(|getSession\(/.test(src), 'the component calls Supabase auth directly');
    },
  },
  {
    name: 'both screens: one product — the reveal vocabulary and mismatch copy are IDENTICAL',
    run() {
      const welcome = fs.readFileSync(path.join(ROOT, WELCOME_REL), 'utf8');
      const enter = fs.readFileSync(path.join(ROOT, EC_REL), 'utf8');
      for (const s of [SHOW_PW, HIDE_PW, SHOW_CF, HIDE_CF, MISMATCH_COPY, SIGN_IN_ROW, CREATE_ROW]) {
        assert(welcome.includes(s), `WelcomeStep lost ${JSON.stringify(s)}`);
        assert(enter.includes(s), `EnterCodeScreen lost ${JSON.stringify(s)}`);
      }
    },
  },
];

(async function main() {
  for (const c of CHECKS) {
    try {
      await c.run();
      check(c.name, true);
    } catch (e) {
      check(c.name, false, e && e.message ? e.message : String(e));
    }
  }
  console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
  process.exit(fails === 0 ? 0 : 1);
})();
