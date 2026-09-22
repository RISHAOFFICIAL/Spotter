#!/usr/bin/env node
/*
 * stack-children-guard — the offline check that would have caught the build-18
 * launch crash (P0) before it ever reached a device.
 *
 * WHAT IT DOES
 *  1. Loads expo-router's REAL
 *     node_modules/expo-router/build/layouts/stack-utils/mapProtectedScreen.js
 *     (the file whose `else` branch stringifies an unrecognised child) with only
 *     its leaf dependencies stubbed.
 *  2. Executes the REAL src/app/_layout.tsx (transpiled to CJS) for each of the
 *     three auth states and captures the children the layout actually hands to
 *     <Stack>. Components are invoked with a tiny element walker — no reconciler,
 *     no native modules, so this runs in plain Node.
 *  3. Feeds those children to the real mapProtectedScreen and asserts:
 *       (i)  the OLD shape (a fragment child) THROWS
 *            "TypeError: Cannot convert a Symbol value to a string"
 *       (ii) the shape the fixed layout produces does NOT throw, and maps to the
 *            expected screen names, in order, for all three auth states.
 *  4. Statically asserts src/app/_layout.tsx no longer passes a fragment (or any
 *     non-screen) child inside <Stack>.
 *  5. Unit-checks the root error boundary: it derives state from the error,
 *     reports it through the first-party diagnostics path, renders the message
 *     on screen, and exposes a working Retry.
 *
 * WHY THIS EXISTS: the smoke suite runs with Platform.OS='web' and every native
 * module stubbed, and the parity harness only evaluated modules — neither ever
 * RENDERED a <Stack>, so the throwing line was never executed offline and green
 * CI was no evidence about it. This check executes that line.
 *
 * RUN:  node scripts/smoke/stack-children-guard.cjs      (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const React = require('react');

const ROOT = path.resolve(__dirname, '..', '..');
const LAYOUT = path.join(ROOT, 'src', 'app', '_layout.tsx');
const BOUNDARY = path.join(ROOT, 'src', 'components', 'RootErrorBoundary.tsx');
const MAP_PROTECTED = path.join(
  ROOT,
  'node_modules',
  'expo-router',
  'build',
  'layouts',
  'stack-utils',
  'mapProtectedScreen.js',
);
const CHILDREN_UTIL = path.join(ROOT, 'node_modules', 'expo-router', 'build', 'utils', 'children.js');

// --------------------------------------------------------------------------
// tiny reporter
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

// --------------------------------------------------------------------------
// module loading helpers
// --------------------------------------------------------------------------
/** Evaluate a CJS source file with a caller-supplied `require`. */
function evalCjs(file, requireImpl) {
  const src = fs.readFileSync(file, 'utf8');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${file}`);
  fn(requireImpl, mod, mod.exports, path.dirname(file), file);
  return mod.exports;
}

/** Evaluate an already-transpiled CommonJS source string with a caller-supplied `require`. */
function evalSource(src, requireImpl, label) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${label || 'inline'}`);
  fn(requireImpl, mod, mod.exports, ROOT, label || 'inline');
  return mod.exports;
}

/** TypeScript -> CommonJS (JSX via the automatic runtime). */
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

// Component identities shared by BOTH halves of the proof: the layout's
// <Stack.Screen> must be the very same object mapProtectedScreen compares
// against, otherwise the mapping would be a false negative.
const StackScreen = function StackScreen() {
  return null;
};
const Protected = function Protected() {
  return null;
};
const Screen = function Screen() {
  return null;
};
const StackHeaderComponent = function StackHeaderComponent() {
  return null;
};

// --------------------------------------------------------------------------
// 1. the real mapProtectedScreen (real file, only leaf deps stubbed)
// --------------------------------------------------------------------------
const realChildrenUtil = evalCjs(CHILDREN_UTIL, (id) => {
  if (id === 'react') return React;
  throw new Error(`unstubbed require inside expo-router/utils/children: ${id}`);
});

const mapProtectedScreen = evalCjs(MAP_PROTECTED, (id) => {
  const deps = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    './StackScreen': { StackScreen, appendScreenStackPropsToOptions: (options) => options ?? {} },
    './StackHeaderComponent': { StackHeaderComponent },
    '../../utils/children': realChildrenUtil,
    '../../views/Protected': { Protected },
    '../../views/Screen': { Screen },
  };
  if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
  throw new Error(`unstubbed require inside mapProtectedScreen: ${id}`);
}).mapProtectedScreen;

// --------------------------------------------------------------------------
// 2. execute the real layout
// --------------------------------------------------------------------------
// Stack stand-in: a component identity whose .Screen is the shared screen
// identity (so `<Stack.Screen>` compiles to an element mapProtectedScreen maps).
const STACK_CALLS = [];
function StackLike(props) {
  STACK_CALLS.push(props);
  return null;
}
StackLike.Screen = StackScreen;

const DIAGNOSTIC_EVENTS = [];
const RN_STUB = {
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles) => styles },
};

function loadLayout(authValue) {
  const stubs = {
    'expo-router': { Stack: StackLike, Protected },
    'expo-status-bar': { StatusBar: () => null },
    'react-native': RN_STUB,
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    '@/features/auth/AuthProvider': {
      AuthProvider: (props) => props.children ?? null,
      SplashLoading: () => null,
      useAuth: () => authValue,
    },
    '@/lib/diagnostics': {
      installGlobalErrorHandlers: () => undefined,
      reportCrash: (message, stack) => DIAGNOSTIC_EVENTS.push({ message, stack }),
    },
  };
  const cache = new Map();

  function loadFile(file) {
    if (cache.has(file)) return cache.get(file);
    const resolved = path.extname(file)
      ? file
      : ['.tsx', '.ts', '.js'].map((e) => file + e).find((f) => fs.existsSync(f));
    if (!resolved) throw new Error(`cannot resolve module: ${file}`);
    const src = resolved.endsWith('.js') ? fs.readFileSync(resolved, 'utf8') : transpile(resolved);
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${resolved}`);
    fn(makeRequire(resolved), mod, mod.exports, path.dirname(resolved), resolved);
    if (process.env.GUARD_DEBUG) {
      console.error('[load]', resolved, '->', Object.keys(mod.exports).slice(0, 8).join(','));
    }
    // Cache/return module.exports, not the module wrapper: a CJS `require()`
    // hands back exports, and every loaded module below relies on that.
    cache.set(file, mod.exports);
    cache.set(resolved, mod.exports);
    return mod.exports;
  }

  function makeRequire(fromFile) {
    return (id) => {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      // '@/features/auth/AuthProvider' -> <root>/src/features/auth/AuthProvider
      if (id.startsWith('@/')) {
        if (process.env.GUARD_DEBUG) console.error('[req]', fromFile, '->', id);
        return loadFile(path.join(ROOT, 'src', id.slice(2)));
      }
      // relative imports inside the loaded source files
      const asFile = path.resolve(path.dirname(fromFile), id);
      if (fs.existsSync(asFile) || ['.ts', '.tsx'].some((e) => fs.existsSync(asFile + e))) {
        return loadFile(asFile);
      }
      throw new Error(`unstubbed require from ${fromFile}: ${id}`);
    };
  }

  return loadFile(LAYOUT);
}

// --------------------------------------------------------------------------
// 3. element walker: invoke function/class components, capture the <Stack> call
// --------------------------------------------------------------------------
function walkStackCalls(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child) => walkStackCalls(child, visit));
    return;
  }
  if (typeof node !== 'object' || !React.isValidElement(node)) return;
  const { type, props } = node;
  if (type === StackLike) {
    visit(props);
    return;
  }
  if (type === React.Fragment) {
    walkStackCalls(props.children, visit);
    return;
  }
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props);
      instance.props = props;
      if (!instance.state) instance.state = {};
      walkStackCalls(instance.render(), visit);
      return;
    }
    walkStackCalls(type(props), visit);
  }
}

function stackChildrenFor(authValue) {
  STACK_CALLS.length = 0;
  const layout = loadLayout(authValue);
  walkStackCalls(layout.default(), (props) => STACK_CALLS.push(props));
  if (STACK_CALLS.length !== 1) {
    throw new Error(`expected exactly one <Stack> render, saw ${STACK_CALLS.length}`);
  }
  return STACK_CALLS[0].children;
}

/** Loads src/components/RootErrorBoundary.tsx with the same stub set. */
function loadBoundary() {
  const stubs = {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': RN_STUB,
    '@/lib/diagnostics': {
      installGlobalErrorHandlers: () => undefined,
      reportCrash: (message, stack) => DIAGNOSTIC_EVENTS.push({ message, stack }),
    },
    '@/theme/tokens': evalSource(
      transpile(path.join(ROOT, 'src', 'theme', 'tokens.ts')),
      (id) => {
        throw new Error(`unstubbed require in tokens.ts: ${id}`);
      },
      'tokens.ts',
    ),
  };
  const src = transpile(BOUNDARY);
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${BOUNDARY}`);
  fn(
    (id) => {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      throw new Error(`unstubbed require in RootErrorBoundary: ${id}`);
    },
    mod,
    mod.exports,
    path.dirname(BOUNDARY),
    BOUNDARY,
  );
  return mod.exports;
}

// --------------------------------------------------------------------------
// 4. the checks
// --------------------------------------------------------------------------
console.log('=== stack-children-guard: expo-router Stack child safety (build 28 P0) ===');
console.log(`layout: ${path.relative(ROOT, LAYOUT)}`);
console.log(`router: ${path.relative(ROOT, MAP_PROTECTED)}`);

const EXPECTED = {
  'no session': ['(auth)/welcome', '(accept)/index', '(invite)/index'],
  'session, not onboarded': ['(onboarding)/index', '(accept)/index', '(invite)/index'],
  'session, onboarded': [
    '(home)/(tabs)/index',
    '(profile)/index',
    '(promises)/index',
    '(accept)/index',
    '(invite)/index',
  ],
};
const AUTH_STATES = [
  ['no session', { session: null, profile: null, isLoading: false }],
  ['session, not onboarded', { session: { user: { id: 'u' } }, profile: null, isLoading: false }],
  ['session, onboarded', { session: { user: { id: 'u' } }, profile: { id: 'u' }, isLoading: false }],
];

// --- (i) OLD SHAPE THROWS --------------------------------------------------
const oldScreens = [
  React.createElement(StackScreen, { key: 'welcome', name: '(auth)/welcome' }),
  React.createElement(StackScreen, { key: 'accept', name: '(accept)/index' }),
];
let oldError = null;
let oldWarn = null;
const realWarn = console.warn;
console.warn = (message) => {
  oldWarn = String(message);
};
try {
  mapProtectedScreen({ children: React.createElement(React.Fragment, null, oldScreens) });
} catch (error) {
  oldError = error;
}
console.warn = realWarn;

check(
  'OLD shape (fragment child of <Stack>) THROWS on the real mapProtectedScreen',
  oldError instanceof TypeError && /Cannot convert a Symbol value to a string/.test(oldError.message),
  oldError ? `${oldError.name}: ${oldError.message}` : 'no throw — the premise of the fix changed',
);
check(
  'the throw happens while BUILDING the "Unknown child element passed to Stack" warning',
  oldWarn === null,
  `console.warn never ran (its template literal throws first): console.warn = ${JSON.stringify(oldWarn)}`,
);

// --- (ii) NEW SHAPE (what the fixed layout really produces) DOES NOT THROW --
for (const [label, authValue] of AUTH_STATES) {
  const expected = EXPECTED[label];
  let derived = null;
  let directChildren = null;
  try {
    const children = stackChildrenFor(authValue);
    directChildren = React.Children.toArray(children);
    derived = mapProtectedScreen({ children }).children.map((child) => child.props.name);
  } catch (error) {
    if (process.env.GUARD_DEBUG) console.error('[stack]', error.stack);
    const frame = (error.stack || '')
      .split('\n')
      .find((l) => /_layout|inline/.test(l));
    check(
      `NEW shape [${label}]: real mapProtectedScreen does not throw`,
      false,
      `${error.name}: ${error.message}${frame ? ` @${frame.trim()}` : ''}`,
    );
    continue;
  }
  check(
    `NEW shape [${label}]: mapProtectedScreen does not throw`,
    true,
    `mapped ${derived.length} screens`,
  );
  check(
    `NEW shape [${label}]: every direct child of <Stack> is a screen definition`,
    directChildren.every((child) => child.type === StackScreen),
    `children=${directChildren.length}, non-screen=${directChildren.filter((c) => c.type !== StackScreen).length}`,
  );
  check(
    `NEW shape [${label}]: maps to the expected ${expected.length} screens in order`,
    JSON.stringify(derived) === JSON.stringify(expected),
    `mapped=${JSON.stringify(derived)}`,
  );
}

// --- static source assertions ---------------------------------------------
const layoutSource = fs.readFileSync(LAYOUT, 'utf8');
const openTag = layoutSource.indexOf('<Stack\n');
const openEnd = openTag === -1 ? -1 : layoutSource.indexOf('>', openTag);
const closeTag = layoutSource.indexOf('</Stack>');
const between = openTag !== -1 && openEnd !== -1 && closeTag > openEnd ? layoutSource.slice(openEnd + 1, closeTag) : '';
check(
  'src/app/_layout.tsx: no fragment child inside <Stack>',
  between.length > 0 && !between.includes('<>') && !between.includes('</>') && !between.includes('Fragment'),
  `children expression = ${JSON.stringify(between.trim())}`,
);
check(
  'src/app/_layout.tsx: every Stack.Screen is keyed (array children need stable keys)',
  (layoutSource.match(/<Stack\.Screen\s/g) || []).length ===
    (layoutSource.match(/<Stack\.Screen\s+key=/g) || []).length,
  `Stack.Screen=${(layoutSource.match(/<Stack\.Screen\s/g) || []).length}, keyed=${
    (layoutSource.match(/<Stack\.Screen\s+key=/g) || []).length
  }`,
);
check(
  'src/app/_layout.tsx: router content is wrapped in RootErrorBoundary',
  /<RootErrorBoundary>/.test(layoutSource) && /from '@\/components\/RootErrorBoundary'/.test(layoutSource),
  'import + JSX present',
);

// --- error boundary behaviour ---------------------------------------------
try {
  const Boundary = loadBoundary().RootErrorBoundary;
  check(
    'RootErrorBoundary: exports a class component',
    typeof Boundary === 'function' && !!Boundary.prototype.isReactComponent,
    typeof Boundary,
  );

  const boom = new TypeError('Cannot convert a Symbol value to a string');
  const derived = Boundary.getDerivedStateFromError(boom);
  check(
    'RootErrorBoundary: getDerivedStateFromError captures the message',
    !!derived && derived.message === boom.message,
    JSON.stringify(derived),
  );

  const instance = new Boundary({ children: null });
  instance.state = Object.assign({}, instance.state, derived);
  const before = DIAGNOSTIC_EVENTS.length;
  instance.componentDidCatch(boom, { componentStack: '\n    at Gate' });
  const reported = DIAGNOSTIC_EVENTS.slice(before).find((e) => /\[render-boundary\]/.test(e.message || ''));
  check(
    'RootErrorBoundary: reports the fault through first-party diagnostics (not swallowed)',
    !!reported && reported.message.includes(boom.message) && /componentStack/.test(reported.stack || ''),
    reported ? JSON.stringify(reported.message) : 'nothing reported',
  );

  const texts = [];
  (function collectText(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) return node.forEach(collectText);
    if (typeof node !== 'object' || !React.isValidElement(node)) return;
    if (typeof node.type === 'string' && typeof node.props.children === 'string') texts.push(node.props.children);
    collectText(node.props.children);
  })(instance.render());
  const rendered = texts.join(' | ');
  check(
    'RootErrorBoundary: renders a labelled recovery screen with the error message on screen',
    rendered.includes('Something went wrong') && rendered.includes(boom.message) && rendered.includes('Try again'),
    rendered,
  );

  let retried = null;
  instance.setState = (updater) => {
    retried = typeof updater === 'function' ? updater(instance.state) : updater;
  };
  const retryElement = (function findPressable(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = findPressable(child);
        if (hit) return hit;
      }
      return null;
    }
    if (typeof node !== 'object' || !React.isValidElement(node)) return null;
    if (typeof node.props?.onPress === 'function') return node;
    return findPressable(node.props.children);
  })(instance.render());
  if (retryElement) retryElement.props.onPress();
  check(
    'RootErrorBoundary: Retry clears the error and bumps the remount key',
    !!retried && retried.message === null && retried.attempt === 1,
    JSON.stringify(retried),
  );
} catch (error) {
  if (process.env.GUARD_DEBUG) console.error('[stack]', error.stack);
  const frame = (error.stack || '').split('\n').find((l) => /RootErrorBoundary|tokens/.test(l));
  check(
    'RootErrorBoundary: harness could load and exercise the boundary',
    false,
    `${error.name}: ${error.message}${frame ? ` @${frame.trim()}` : ''}`,
  );
}

console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
