#!/usr/bin/env node
/**
 * password-ux-guard — the password entry UX on BOTH signup screens, at the
 * owner's FINAL shape (2026-09-27), gated offline against the REAL components.
 *
 * THE DEFECT (owner's words, first report): "The password when creating the
 * account isn't verified, nor is there a way to show the password to make sure
 * it was typed correctly." Verified in source before fixing: WelcomeStep.tsx
 * rendered ONE masked field (`secureTextEntry` as a bare attribute, no state)
 * and called authenticate(email, password) once — no reveal affordance anywhere
 * in src/, no visible requirement, nothing said until the server answered.
 *
 * THE OWNER'S FINAL, CLARIFIED SHAPE (2026-09-27 — it supersedes the interim
 * "add a Confirm password field" treatment PRs #42/#43 shipped):
 *   1. NO confirm-password field on either screen — removed, not hidden;
 *   2. exactly ONE password field per screen, with a show/hide eye toggle;
 *   3. that toggle carries VoiceOver labels that follow the state
 *      ("Show password" / "Hide password") and is a real >=44pt touch target;
 *   4. the password REQUIREMENT is visible, and it is the rule the auth backend
 *      actually enforces — PASSWORD_MIN_LENGTH in src/lib/supabase.ts (6, and
 *      the live project answers 422 weak_password "Password should be at least
 *      6 characters." for a 3-character signup, measured 2026-09-27). The copy
 *      is DERIVED from that constant, never retyped;
 *   5. entry-time validation is rendered at the point of entry (never a
 *      silently discarded state) and a short password BLOCKS the submit before
 *      authenticate() is reached.
 *
 * TWO SCREENS CARRY IT, so this ONE guard renders BOTH:
 * src/features/onboarding/WelcomeStep.tsx and src/features/invites/
 * EnterCodeScreen.tsx (the pre-auth "Join & create account" path an invited
 * reviewer walks, and the screen App Store frame 07 depicts). Both render the
 * ONE shared row src/features/auth/PasswordField.tsx, so they cannot drift.
 *
 * WHAT THIS GUARD PROVES (all against the real sources rendered in plain Node
 * with leaf stubs — the rn-ui-tree-guard approach, see
 * skills/rn-ui-tree-guard-offline):
 *   - NO confirm field anywhere: not rendered on either screen, not named in
 *     either source, and not a string anywhere under src/;
 *   - exactly ONE password entry control per screen (counted as masked
 *     TextInputs, so a second field cannot arrive unlabelled), one password row;
 *   - the toggle is a 48pt (>=44pt) button, is the ONLY password toggle on the
 *     screen, announces "Show password" while the field is masked and
 *     "Hide password" once revealed (state-following, read back from the
 *     re-rendered element — not asserted in a comment), and really flips that
 *     field's secureTextEntry both ways;
 *   - the requirement copy is rendered AND derived from PASSWORD_MIN_LENGTH:
 *     the scenario swap below changes the constant the enforcer uses and the
 *     rendered copy, the inline threshold and the blocking threshold all move
 *     with it on BOTH screens;
 *   - entry-time validation: typing 3 characters renders "Too short — 3 of 6
 *     characters." in the app's danger colour at the point of entry; it clears
 *     at 6 and is absent while the field is empty;
 *   - a too-short submit BLOCKS: authenticate() is never reached (counting spy
 *     + counting Supabase client both at zero), the message is RENDERED, and
 *     on EnterCodeScreen accept_invite, the onboarding commit and router.replace
 *     are never reached either;
 *   - a good submit calls authenticate() exactly once, with the typed
 *     credentials, then advances (WelcomeStep: onDone(); EnterCodeScreen:
 *     exactly one accept_invite and a replace onto the group feed);
 *   - the landing state (before "Get started") is byte-for-byte the same text
 *     as master's, so the App Store frame cut from that screen cannot go stale.
 *
 * NEGATIVE CONTROL (run it, do not trust it): this file is committed on the fix
 * branch, so point it at the PRE-FIX tree — the branch tip before this change,
 * which is the shape that carries the Confirm field:
 *   git worktree add --detach /tmp/pre-fix <branch-tip-before-this-commit>
 *   SPOTTER_GUARD_ROOT=/tmp/pre-fix node scripts/smoke/password-ux-guard.cjs
 * It must exit NON-ZERO there on real behaviour on BOTH screens — a confirm
 * field rendered, no requirement copy, no entry-time validation — not on a
 * missing string. The measured pre-fix numbers (a NON-ZERO exit) and the
 * post-change run (exit 0) are pasted in
 * /home/team/shared/password-ux-final-2026-09-27.md.
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
// The constants under test. SHOW_PW / HIDE_PW are the owner's requested
// VoiceOver labels; REQUIREMENT / TOO_SHORT are the copy the components must
// render, which they derive from PASSWORD_MIN_LENGTH (the rule this app and the
// live backend both enforce — see the header).
const CTA_LABEL = 'Get started';
const SIGN_IN_ROW = 'Already have an account? Sign in';
const CREATE_ROW = 'New here? Create an account';
const SHOW_PW = 'Show password';
const HIDE_PW = 'Hide password';
const MIN_LENGTH = 6; // PASSWORD_MIN_LENGTH, asserted against the compiled module below
const REQUIREMENT_COPY = `At least ${MIN_LENGTH} characters.`;
const TOO_SHORT_COPY = `Password must be at least ${MIN_LENGTH} characters.`;
function issueCopy(n, min = MIN_LENGTH) {
  return `Too short — ${n} of ${min} characters.`;
}
const WELCOME_REL = path.join('src', 'features', 'onboarding', 'WelcomeStep.tsx');
const PASSWORD_FIELD_REL = path.join('src', 'features', 'auth', 'PasswordField.tsx');
const AUTH_REL = path.join('src', 'lib', 'supabase.ts');

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

const FIXTURES = new Map();
/**
 * Build a WelcomeStep fixture (cached per rule value).
 *
 * `minOverride` swaps PASSWORD_MIN_LENGTH on the compiled auth module BEFORE
 * the screen modules are evaluated — the scenario swap the derivation check
 * uses: "what would the screens show if the rule the enforcer applies were
 * different?". Each override gets its OWN loader cache, so the fixtures cannot
 * contaminate each other and nothing has to be restored afterwards.
 */
function fixture(minOverride = MIN_LENGTH) {
  const key = `welcome:${minOverride}`;
  if (FIXTURES.has(key)) return FIXTURES.get(key);
  const base = Object.assign(nativeStubs(), libStubs(), {
    '@supabase/supabase-js': { createClient: () => ({ auth: COUNTING_AUTH, from: fakeQuery }) },
  });
  // The REAL src/lib/supabase.ts (REAL mode: the env vars above are set), so the
  // component's single submit path is exercised end to end — signInWithPassword
  // then signUp then getSession — with only the network layer replaced.
  const supabaseMod = makeLoader(base).loadFile(path.join(ROOT, 'src', 'lib', 'supabase.ts'));
  supabaseMod.PASSWORD_MIN_LENGTH = minOverride;
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
  const built = {
    WelcomeStep: loader.loadFile(path.join(ROOT, WELCOME_REL)).WelcomeStep,
    colors: loader.loadFile(path.join(ROOT, 'src', 'theme', 'tokens.ts')).colors,
    // The compiled auth module itself: its PASSWORD_MIN_LENGTH is the rule this
    // app enforces, and the screens' requirement/validation copy is derived
    // from it.
    supabaseMod,
    minLength: minOverride,
  };
  FIXTURES.set(key, built);
  return built;
}

/**
 * Mount the REAL WelcomeStep. The auth form lives in the `footer` PROP, but the
 * real OnboardingScreen renders `{footer}` inside its own children
 * (OnboardingScreen.tsx styles.actions), so the form IS reachable by walking the
 * rendered tree — the checks below only pass if it stays that way, which is the
 * guard on the shell/screen wiring as well.
 */
function mountWelcome(fx = fixture()) {
  const { WelcomeStep } = fx;
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

const EC_FIXTURES = new Map();
function ecFixture(minOverride = MIN_LENGTH) {
  const key = `entercode:${minOverride}`;
  if (EC_FIXTURES.has(key)) return EC_FIXTURES.get(key);
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
  supabaseMod.PASSWORD_MIN_LENGTH = minOverride;
  const realAuthenticate = supabaseMod.authenticate;
  supabaseMod.authenticate = async (email, password) => {
    AUTH_CALLS.push([email, password]);
    return realAuthenticate(email, password);
  };
  const loader = makeLoader(Object.assign({}, base, { '@/lib/supabase': supabaseMod }));
  const built = {
    EnterCodeScreen: loader.loadFile(path.join(ROOT, EC_REL)).EnterCodeScreen,
    colors: loader.loadFile(path.join(ROOT, 'src', 'theme', 'tokens.ts')).colors,
    supabaseMod,
    minLength: minOverride,
  };
  EC_FIXTURES.set(key, built);
  return built;
}

/** Mount the REAL EnterCodeScreen with no session, every counter reset. */
function mountEnterCode(fx = ecFixture()) {
  const { EnterCodeScreen } = fx;
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
async function enterFoundStage(fx = ecFixture()) {
  const m = mountEnterCode(fx);
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
/** Labels of the password-reveal toggles, in render order (pressables only). */
function toggleLabels(m) {
  return els(m)
    .filter(
      (e) => typeof e.props.onPress === 'function' && /password/i.test(String(e.props.accessibilityLabel || '')),
    )
    .map((e) => e.props.accessibilityLabel);
}
function revealControl(m, maskedLabel) {
  return control(m, maskedLabel);
}
/** Every accessibility label on screen that names a confirm field, if any. */
function confirmLabels(m) {
  return els(m)
    .map((e) => e.props.accessibilityLabel)
    .filter((l) => /confirm/i.test(String(l || '')));
}
function textWithColor(m, copy, color) {
  return els(m).filter((e) => e.type === 'Text' && norm(joinText(e)) === norm(copy) && styleOf(e).color === color);
}
function mutedColor() {
  return fixture().colors.text.muted.hex;
}
/** The compiled PASSWORD_MIN_LENGTH the app itself enforces. */
function compiledMinLength() {
  return fixture().supabaseMod.PASSWORD_MIN_LENGTH;
}
/**
 * The ONE analyser used for the real trees, the pre-fix shape and the frozen
 * checks — so a "fix" cannot pass by moving the problem.
 */
function analysePasswordUx(node) {
  const list = deepEls(node);
  const byLabeled = (label) => list.filter((e) => e.type === 'TextInput' && e.props.accessibilityLabel === label);
  const pw = byLabeled('Password');
  // ONE password entry control means ONE masked TextInput, counted without
  // trusting a label: a second field cannot arrive unnamed and slip past.
  const masked = list.filter((e) => e.type === 'TextInput' && e.props.secureTextEntry === true);
  const confirm = list.filter((e) => e.type === 'TextInput' && /confirm/i.test(String(e.props.accessibilityLabel || '')));
  const revealPw = list.find(
    (e) => [SHOW_PW, HIDE_PW].includes(e.props.accessibilityLabel) && typeof e.props.onPress === 'function',
  );
  const passwordToggles = list.filter(
    (e) => typeof e.props.onPress === 'function' && /password/i.test(String(e.props.accessibilityLabel || '')),
  );
  return {
    passwordFieldCount: pw.length,
    hasPasswordField: pw.length > 0,
    secureTextEntry: pw.length ? pw[0].props.secureTextEntry : null,
    maskedInputCount: masked.length,
    confirmFieldCount: confirm.length,
    hasConfirmField: confirm.length > 0,
    hasRevealForPassword: !!revealPw,
    passwordToggleCount: passwordToggles.length,
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
/**
 * The vocabulary a second password entry field would be named with. Deliberately
 * NOT a bare /confirm/i: the word appears in unrelated prose ("Confirm your
 * email", "confirmOnboarding"), which would make the sweep prove nothing. The
 * structural half of the same claim is the masked-input count above.
 */
/**
 * The vocabulary a second password entry field would be named with. Deliberately
 * NOT a bare /confirm/i: the word appears in unrelated prose ("Confirm your
 * email", "confirmOnboarding"), which would make the sweep prove nothing. The
 * structural half of the same claim is the masked-input count above.
 */
const CONFIRM_FIELD_RE = /confirm[\s_-]*password|repeat[\s_-]*password|re-?enter\s+(your\s+)?password|verify\s*password/i;

/**
 * A source file with its comments removed, for the static checks: the screens
 * are ALLOWED to talk about the labels and the confirm field in prose (that is
 * how the reader learns why the shape is what it is) — what must not come back
 * is the code.
 */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

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
    name: 'self-check: the analyser reports the OLD confirm-field shape as defective',
    run() {
      // The pre-fix shape this guard must reject: a labelled password field, a
      // confirm field, and two toggles. Built by hand so the analyser is proved
      // to have teeth before it is pointed at the real screens.
      const Old = function Old() {
        const row = (label, show) =>
          React.createElement(
            'View',
            null,
            React.createElement('TextInput', { accessibilityLabel: label, secureTextEntry: true }),
            React.createElement('Pressable', { accessibilityLabel: show, onPress: () => undefined }),
          );
        return React.createElement('View', null, row('Password', 'Show password'), row('Confirm password', 'Show confirm password'));
      };
      const a = analysePasswordUx(expand(React.createElement(Old), 'old'));
      assertEq(a.maskedInputCount, 2, 'masked inputs in the old shape');
      assertEq(a.confirmFieldCount, 1, 'confirm fields in the old shape');
      assertEq(a.passwordToggleCount, 2, 'password toggles in the old shape');
    },
  },
  {
    name: 'landing state (before "Get started"): no password field, no toggle, no mode switch, no requirement',
    run() {
      const m = mountWelcome();
      const labels = els(m)
        .map((e) => e.props.accessibilityLabel)
        .filter(Boolean);
      assert(!labels.includes('Password'), 'a Password field renders before the form opens');
      assert(!labels.some((l) => /confirm/i.test(String(l))), 'a confirm control renders before the form opens');
      assert(!labels.includes(SHOW_PW) && !labels.includes(HIDE_PW), 'a toggle renders before the form opens');
      assert(
        !labels.includes(SIGN_IN_ROW) && !labels.includes(CREATE_ROW),
        'the mode switch renders before the form opens',
      );
      assert(!screenText(m).includes(REQUIREMENT_COPY), 'the requirement renders before the form opens');
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
    name: 'create mode is the default: the form opens with ONE password row and NO confirm field',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      const a = analysePasswordUx(m.tree);
      assert(a.hasPasswordField, 'no password field after opening the form');
      assertEq(a.passwordFieldCount, 1, 'TextInputs labelled "Password"');
      assertEq(a.maskedInputCount, 1, 'masked TextInputs on the screen (one password entry control)');
      assertEq(a.confirmFieldCount, 0, 'confirm fields rendered');
      assertEq(confirmLabels(m).length, 0, 'accessibility labels naming a confirm field');
    },
  },
  {
    name: 'create mode: the password field is masked and it is the only password toggle on screen',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry');
      assertEq(analysePasswordUx(m.tree).passwordToggleCount, 1, 'password toggles rendered');
      assertEq(toggleLabels(m).join(','), SHOW_PW, 'the toggle labels on the form');
    },
  },
  {
    name: 'create mode: the toggle is a 48pt (>=44pt) button labelled "Show password" while masked',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      const el = revealControl(m, SHOW_PW);
      assertEq(el.props.accessibilityRole, 'button', 'toggle accessibilityRole');
      const s = styleOf(el);
      assert(s.width >= 44 && s.height >= 44, `toggle hit target is ${s.width}x${s.height}, want >=44x44`);
      assertEq(el.props.accessibilityLabel, SHOW_PW, 'toggle label while masked');
    },
  },
  {
    name: 'create mode: tapping the toggle FLIPS the password field to secureTextEntry false',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, false, 'password secureTextEntry after reveal');
      assert(m.renders >= 3, `the toggle tap did not re-render (renders=${m.renders})`);
    },
  },
  {
    name: 'create mode: revealed, the SAME control announces "Hide password" (label follows the state)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      assertEq(control(m, HIDE_PW).props.accessibilityLabel, HIDE_PW, 'toggle label while revealed');
      assert(!byLabel(m, SHOW_PW).some((e) => typeof e.props.onPress === 'function'), 'the Show label survived');
      assertEq(toggleLabels(m).join(','), HIDE_PW, 'the toggle labels after revealing');
    },
  },
  {
    name: 'create mode: tapping the toggle again returns the field to masked (round trip)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SHOW_PW);
      tap(m, HIDE_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry after hiding again');
      assertEq(toggleLabels(m).join(','), SHOW_PW, 'the toggle labels after hiding again');
    },
  },
  {
    name: 'rule: the compiled PASSWORD_MIN_LENGTH the app enforces is what the copy is built from',
    run() {
      assertEq(compiledMinLength(), MIN_LENGTH, 'PASSWORD_MIN_LENGTH in src/lib/supabase.ts');
      const src = fs.readFileSync(path.join(ROOT, AUTH_REL), 'utf8');
      assert(src.includes(`export const PASSWORD_MIN_LENGTH = ${MIN_LENGTH}`), 'the constant is not declared as expected');
      assert(
        src.includes('password.length < PASSWORD_MIN_LENGTH'),
        'authenticate() no longer enforces PASSWORD_MIN_LENGTH (the copy would then be a guess)',
      );
      assert(!/password\.length < \d/.test(src), 'a bare length literal is back in authenticate()');
    },
  },
  {
    name: 'create mode: the requirement copy is RENDERED, at the point of entry, in the muted colour',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assert(screenText(m).includes(REQUIREMENT_COPY), `the requirement ${JSON.stringify(REQUIREMENT_COPY)} is not rendered`);
      assertEq(textWithColor(m, REQUIREMENT_COPY, mutedColor()).length, 1, 'requirement copy in the muted colour');
    },
  },
  {
    name: 'entry validation: an EMPTY field shows no complaint (nothing is said before the user types)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assert(!screenText(m).includes('Too short'), 'a complaint renders while the field is empty');
    },
  },
  {
    name: 'entry validation: typing 3 characters renders the short-password line at the point of entry',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Password', 'abc');
      assert(screenText(m).includes(issueCopy(3)), `the inline line ${JSON.stringify(issueCopy(3))} is not rendered`);
      assertEq(textWithColor(m, issueCopy(3), dangerColor()).length, 1, 'inline lines in the danger colour');
      assert(screenText(m).includes(REQUIREMENT_COPY), 'the requirement copy disappeared when the complaint appeared');
      // "at the point of entry": the line sits below the password field and
      // ABOVE any other input on the screen.
      const list = els(m);
      const pwIdx = list.findIndex((e) => e.type === 'TextInput' && e.props.accessibilityLabel === 'Password');
      const issueIdx = list.findIndex((e) => e.type === 'Text' && norm(joinText(e)) === norm(issueCopy(3)));
      const laterInputs = list
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => e.type === 'TextInput' && i > pwIdx)
        .map(({ i }) => i);
      assert(pwIdx >= 0 && issueIdx >= 0, 'the field or the inline line is missing');
      assert(pwIdx < issueIdx, 'the inline line renders ABOVE the password field');
      assert(
        laterInputs.every((i) => i > issueIdx),
        'another input renders between the password field and its inline line',
      );
    },
  },
  {
    name: 'entry validation: reaching the rule CLEARS the line (state follows the typed value)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Password', 'abc');
      assert(screenText(m).includes(issueCopy(3)), 'precondition: the line is not rendered for a short password');
      type(m, 'Password', 'abcdef');
      assert(!screenText(m).includes('Too short'), 'the short-password line survived a password that satisfies the rule');
      assert(screenText(m).includes(REQUIREMENT_COPY), 'the requirement copy disappeared');
    },
  },
  {
    name: 'blocked submit: a too-short password renders the message UNDER the field in the danger colour',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'abc');
      return tapAsync(m, CTA_LABEL).then((mm) => {
        assertEq(errorLines(mm, TOO_SHORT_COPY).length, 1, 'rendered short-password lines, want exactly 1');
        assert(screenText(mm).includes(TOO_SHORT_COPY), 'the short-password copy is not in the rendered screen text');
        assert(screenText(mm).includes(issueCopy(3)), 'the inline line vanished when the submit was blocked');
      });
    },
  },
  {
    name: 'blocked submit: authenticate() is NEVER reached (spy 0, Supabase client 0) and onDone is not called',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'abc');
      return tapAsync(m, CTA_LABEL).then(() => {
        assertEq(AUTH_CALLS.length, 0, 'authenticate() calls');
        assertEq(CLIENT.signIn + CLIENT.signUp, 0, 'Supabase auth attempts');
        assertEq(DONE_CALLS, 0, 'onDone() calls');
      });
    },
  },
  {
    name: 'blocked submit: the message is the SAME sentence the auth module returns for that input',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'abc');
      return tapAsync(m, CTA_LABEL)
        .then((mm) => {
          assertEq(errorLines(mm, TOO_SHORT_COPY).length, 1, 'the screen message');
          // The enforcer's own answer for the same input, from the REAL module.
          return fixture().supabaseMod.authenticate('reviewer@example.com', 'abc');
        })
        .then((res) => {
          assertEq(res.ok, false, 'authenticate() accepted a 3-character password');
          assertEq(res.error, TOO_SHORT_COPY, 'the auth module message vs the rendered message');
        });
    },
  },
  {
    name: 'blocked submit: the CTA is not left spinning (no loading state, label still drawn)',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'abc');
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
    name: 'sign-in mode: switching keeps ONE password row, no confirm field, and the same requirement',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      assert(control(m, SIGN_IN_ROW), 'no sign-in mode switch');
      tap(m, SIGN_IN_ROW);
      assert(control(m, CREATE_ROW), 'no way back to create mode');
      const a = analysePasswordUx(m.tree);
      assertEq(a.passwordFieldCount, 1, 'TextInputs labelled "Password" in sign-in mode');
      assertEq(a.maskedInputCount, 1, 'masked TextInputs in sign-in mode');
      assertEq(a.confirmFieldCount, 0, 'sign-in mode confirm field');
      assertEq(confirmLabels(m).length, 0, 'sign-in mode confirm labels');
      assert(screenText(m).includes(REQUIREMENT_COPY), 'sign-in mode lost the requirement copy');
    },
  },
  {
    name: 'sign-in mode: the toggle still follows the state, and a short password is still blocked',
    run() {
      const m = mountWelcome();
      tap(m, CTA_LABEL);
      tap(m, SIGN_IN_ROW);
      assertEq(toggleLabels(m).join(','), SHOW_PW, 'toggle labels in sign-in mode');
      tap(m, SHOW_PW);
      assertEq(field(m, 'Password').props.secureTextEntry, false, 'the sign-in toggle did not flip the field');
      assertEq(control(m, HIDE_PW).props.accessibilityLabel, HIDE_PW, 'sign-in toggle label while revealed');
      type(m, 'Email', 'reviewer@example.com');
      type(m, 'Password', 'abc');
      return tapAsync(m, CTA_LABEL).then((mm) => {
        assertEq(AUTH_CALLS.length, 0, 'authenticate() calls for a short password in sign-in mode');
        assertEq(errorLines(mm, TOO_SHORT_COPY).length, 1, 'the short-password message in sign-in mode');
      });
    },
  },
  {
    name: 'sign-in mode: a good password calls authenticate() once and advances',
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
    name: 'static: WelcomeStep has NO password markup of its own (it renders the shared row)',
    run() {
      const src = codeOnly(fs.readFileSync(path.join(ROOT, WELCOME_REL), 'utf8'));
      assert(src.includes('<PasswordField'), 'WelcomeStep does not render the shared PasswordField');
      assert(src.includes("from '@/features/auth/PasswordField'"), 'WelcomeStep imports the password row from elsewhere');
      assert(!/secureTextEntry/.test(src), 'the screen still owns secureTextEntry — the row can drift from the other screen');
      assert(!CONFIRM_FIELD_RE.test(src), 'the screen still names a confirm field');
      assert(!/['"`]Show password['"`]|['"`]Hide password['"`]/.test(src), 'the VoiceOver labels are retyped on the screen');
      assert(src.includes("import('@/lib/supabase')"), 'the component no longer imports the shared auth module');
      assert(!/signInWithPassword|signUp\(|getSession\(/.test(src), 'the component calls Supabase auth directly');
    },
  },
  // ------------------------------------------------------------------
  // EnterCodeScreen — the SECOND screen, the pre-auth "Join & create
  // account" path an invited reviewer walks. Same assertions, same table.
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
    name: 'enter-code: create mode is the default — ONE password row, NO confirm field',
    run() {
      return enterFoundStage().then((m) => {
        const a = analysePasswordUx(m.tree);
        assert(a.hasPasswordField, 'no password field after reaching the FOUND stage');
        assertEq(a.passwordFieldCount, 1, 'TextInputs labelled "Password"');
        assertEq(a.maskedInputCount, 1, 'masked TextInputs on the FOUND stage');
        assertEq(a.confirmFieldCount, 0, 'confirm fields rendered');
        assertEq(confirmLabels(m).length, 0, 'accessibility labels naming a confirm field');
      });
    },
  },
  {
    name: 'enter-code: create mode — the password field is masked, with one toggle labelled "Show password"',
    run() {
      return enterFoundStage().then((m) => {
        assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry');
        assertEq(toggleLabels(m).join(','), SHOW_PW, 'the toggle labels on the FOUND stage');
        const el = revealControl(m, SHOW_PW);
        assertEq(el.props.accessibilityRole, 'button', 'toggle accessibilityRole');
        const s = styleOf(el);
        assert(s.width >= 44 && s.height >= 44, `toggle hit target is ${s.width}x${s.height}, want >=44x44`);
      });
    },
  },
  {
    name: 'enter-code: create mode — tapping the toggle FLIPS the field, and the label follows the state',
    run() {
      return enterFoundStage().then((m) => {
        const before = m.renders;
        tap(m, SHOW_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, false, 'password secureTextEntry after reveal');
        assertEq(control(m, HIDE_PW).props.accessibilityLabel, HIDE_PW, 'toggle label while revealed');
        assert(!byLabel(m, SHOW_PW).some((e) => typeof e.props.onPress === 'function'), 'the Show label survived');
        assertEq(toggleLabels(m).join(','), HIDE_PW, 'the toggle labels after revealing');
        assert(m.renders > before, `the reveal tap did not re-render (renders=${m.renders})`);
      });
    },
  },
  {
    name: 'enter-code: create mode — tapping the toggle again returns the field to masked (round trip)',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SHOW_PW);
        tap(m, HIDE_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, true, 'password secureTextEntry after hiding again');
        assertEq(toggleLabels(m).join(','), SHOW_PW, 'the toggle labels after hiding again');
      });
    },
  },
  {
    name: 'enter-code: create mode — the requirement copy is RENDERED, at the point of entry, in the muted colour',
    run() {
      return enterFoundStage().then((m) => {
        assert(
          screenText(m).includes(REQUIREMENT_COPY),
          `the requirement ${JSON.stringify(REQUIREMENT_COPY)} is not rendered`,
        );
        assertEq(textWithColor(m, REQUIREMENT_COPY, mutedColor()).length, 1, 'requirement copy in the muted colour');
        assert(!screenText(m).includes('Too short'), 'a complaint renders while the field is empty');
      });
    },
  },
  {
    name: 'enter-code: entry validation — typing 3 characters renders the short-password line in danger colour',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Password', 'abc');
        assert(screenText(m).includes(issueCopy(3)), `the inline line ${JSON.stringify(issueCopy(3))} is not rendered`);
        assertEq(textWithColor(m, issueCopy(3), dangerColor()).length, 1, 'inline lines in the danger colour');
        const list = els(m);
        const pwIdx = list.findIndex((e) => e.type === 'TextInput' && e.props.accessibilityLabel === 'Password');
        const issueIdx = list.findIndex((e) => e.type === 'Text' && norm(joinText(e)) === norm(issueCopy(3)));
        assert(pwIdx >= 0 && pwIdx < issueIdx, 'the inline line does not render below the password field');
        type(m, 'Password', 'abcdef');
        assert(!screenText(m).includes('Too short'), 'the line survived a password that satisfies the rule');
        assert(screenText(m).includes(REQUIREMENT_COPY), 'the requirement copy disappeared');
      });
    },
  },
  {
    name: 'enter-code: blocked submit — a too-short password renders the message and reaches NOTHING',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'abc');
        return tapAsync(m, EC_CTA_CREATE).then((mm) => {
          assertEq(errorLines(mm, TOO_SHORT_COPY).length, 1, 'rendered short-password lines, want exactly 1');
          assertEq(AUTH_CALLS.length, 0, 'authenticate() calls');
          assertEq(CLIENT.signIn + CLIENT.signUp, 0, 'Supabase auth attempts');
          assertEq(EC.acceptCalls.length, 0, 'accept_invite calls');
          assertEq(EC.commitCalls.length, 0, 'onboarding commits');
          assertEq(ROUTER.replaced.length, 0, 'router.replace calls');
          assertEq(ctaIsLoading(mm, EC_CTA_CREATE), false, 'the CTA is left spinning after a blocked submit');
          assert(norm(joinText(control(mm, EC_CTA_CREATE))).includes(EC_CTA_CREATE), 'the CTA label disappeared');
        });
      });
    },
  },
  {
    name: 'enter-code: good submit — authenticate() EXACTLY once, then accept_invite once and the app advances',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'hunter22');
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
    name: 'enter-code: sign-in mode — one password row, no confirm field, message cleared',
    run() {
      return enterFoundStage().then((m) => {
        type(m, 'Email', 'reviewer@example.com');
        type(m, 'Password', 'abc');
        return tapAsync(m, EC_CTA_CREATE).then((mm) => {
          assert(control(mm, SIGN_IN_ROW), 'no sign-in mode switch');
          tap(mm, SIGN_IN_ROW);
          assert(control(mm, CREATE_ROW), 'no way back to create mode');
          assert(control(mm, EC_CTA_SIGN_IN), 'sign-in mode kept the create-account CTA label');
          assert(!screenText(mm).includes(TOO_SHORT_COPY), 'the create-mode message survived the mode switch');
          const a = analysePasswordUx(mm.tree);
          assertEq(a.passwordFieldCount, 1, 'TextInputs labelled "Password" in sign-in mode');
          assertEq(a.maskedInputCount, 1, 'masked TextInputs in sign-in mode');
          assertEq(a.confirmFieldCount, 0, 'sign-in mode confirm field');
          assert(screenText(mm).includes(REQUIREMENT_COPY), 'sign-in mode lost the requirement copy');
        });
      });
    },
  },
  {
    name: 'enter-code: sign-in mode — the toggle survives and a good password advances',
    run() {
      return enterFoundStage().then((m) => {
        tap(m, SIGN_IN_ROW);
        assertEq(toggleLabels(m).join(','), SHOW_PW, 'toggle labels in sign-in mode');
        tap(m, SHOW_PW);
        assertEq(field(m, 'Password').props.secureTextEntry, false, 'the sign-in toggle did not flip the field');
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
    name: 'static: EnterCodeScreen has NO password markup of its own (it renders the shared row)',
    run() {
      const src = codeOnly(fs.readFileSync(path.join(ROOT, EC_REL), 'utf8'));
      assert(src.includes('<PasswordField'), 'EnterCodeScreen does not render the shared PasswordField');
      assert(src.includes("from '@/features/auth/PasswordField'"), 'EnterCodeScreen imports the password row from elsewhere');
      assert(!/secureTextEntry/.test(src), 'the screen still owns secureTextEntry — the row can drift from the other screen');
      assert(!CONFIRM_FIELD_RE.test(src), 'the screen still names a confirm field');
      assert(!/['"`]Show password['"`]|['"`]Hide password['"`]/.test(src), 'the VoiceOver labels are retyped on the screen');
      assert(src.includes("import('@/lib/supabase')"), 'the component no longer imports the shared auth module');
      assert(!/signInWithPassword|signUp\(|getSession\(/.test(src), 'the component calls Supabase auth directly');
    },
  },
  // ------------------------------------------------------------------
  // the whole repo / both screens at once
  // ------------------------------------------------------------------
  {
    name: 'repo-wide: NO confirm-password string survives anywhere under src/',
    run() {
      const hits = [];
      (function walkDir(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            walkDir(abs);
          } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
            const src = fs.readFileSync(abs, 'utf8');
            if (CONFIRM_FIELD_RE.test(src)) hits.push(path.relative(ROOT, abs));
          }
        }
      })(path.join(ROOT, 'src'));
      assertEq(hits.join(', '), '', 'files under src/ that still name a confirm field');
    },
  },
  {
    name: 'both screens: ONE shared password row — the owner strings live in exactly one file',
    run() {
      const row = fs.readFileSync(path.join(ROOT, PASSWORD_FIELD_REL), 'utf8');
      assert(row.includes(`'${SHOW_PW}'`) && row.includes(`'${HIDE_PW}'`), 'PasswordField lost the VoiceOver labels');
      assert(row.includes('PASSWORD_MIN_LENGTH'), 'PasswordField no longer derives its copy from the enforced rule');
      const braced = (row.match(/secureTextEntry=\{!\w+\}/g) || []).length;
      assertEq(braced, 1, 'state-derived secureTextEntry sites in the shared row');
      assert(!/^\s*secureTextEntry\s*$/m.test(row), 'a bare secureTextEntry attribute is back');
    },
  },
  {
    name: 'derivation: a DIFFERENT enforced rule moves the copy, the inline line and the block on BOTH screens',
    run() {
      // A fixture built with the rule swapped BEFORE the screens are evaluated:
      // "what would the screens show if the enforced rule were 9?" Every value
      // below is computed from SWAP here — nothing is compared to a frozen
      // string — so this proves DERIVATION, not equality.
      const SWAP = 9;
      const requirement = `At least ${SWAP} characters.`;
      const tooShort = `Password must be at least ${SWAP} characters.`;
      const wfx = fixture(SWAP);
      assertEq(wfx.supabaseMod.PASSWORD_MIN_LENGTH, SWAP, 'the swapped rule on the compiled auth module');
      assertEq(wfx.supabaseMod.passwordTooShortMessage(), tooShort, 'the message the ENFORCER returns under the swap');
      const w = mountWelcome(wfx);
      tap(w, CTA_LABEL);
      assert(screenText(w).includes(requirement), `WelcomeStep did not follow the swapped rule: ${screenText(w)}`);
      assert(!screenText(w).includes(REQUIREMENT_COPY), 'WelcomeStep still renders the old requirement copy');
      type(w, 'Password', 'abcdefgh');
      assert(screenText(w).includes(issueCopy(8, SWAP)), 'WelcomeStep inline threshold did not follow the rule');
      type(w, 'Email', 'reviewer@example.com');
      return tapAsync(w, CTA_LABEL)
        .then((ww) => {
          assertEq(errorLines(ww, tooShort).length, 1, 'WelcomeStep block message under the swapped rule');
          assertEq(AUTH_CALLS.length, 0, 'WelcomeStep authenticate() calls with 8 characters under a 9-character rule');
        })
        .then(() => enterFoundStage(ecFixture(SWAP)))
        .then((e) => {
          assert(screenText(e).includes(requirement), 'EnterCodeScreen did not follow the swapped rule');
          assert(!screenText(e).includes(REQUIREMENT_COPY), 'EnterCodeScreen still renders the old requirement copy');
          type(e, 'Password', 'abcdefgh');
          assert(screenText(e).includes(issueCopy(8, SWAP)), 'EnterCodeScreen inline threshold did not follow the rule');
          type(e, 'Email', 'reviewer@example.com');
          return tapAsync(e, EC_CTA_CREATE);
        })
        .then((ee) => {
          assertEq(errorLines(ee, tooShort).length, 1, 'EnterCodeScreen block message under the swapped rule');
          assertEq(AUTH_CALLS.length, 0, 'EnterCodeScreen authenticate() calls under the swapped rule');
          assertEq(EC.acceptCalls.length, 0, 'accept_invite calls under the swapped rule');
          // The DEFAULT fixtures were never touched by the swap.
          assertEq(compiledMinLength(), MIN_LENGTH, 'the default fixture rule after the swap');
          const back = mountWelcome();
          tap(back, CTA_LABEL);
          assert(screenText(back).includes(REQUIREMENT_COPY), 'the shipped requirement copy');
          assert(!screenText(back).includes(requirement), 'the swapped copy leaked into the shipped screen');
          assertEq(fixture(MIN_LENGTH).supabaseMod.passwordTooShortMessage(), TOO_SHORT_COPY, 'the shipped message');
        });
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
