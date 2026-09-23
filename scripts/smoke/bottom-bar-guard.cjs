#!/usr/bin/env node
/*
 * bottom-bar-guard — the offline check that a bottom-bar control can never be
 * DEAD again, and that the slot split still puts the camera at screen centre.
 *
 * WHY IT EXISTS: the owner tapped two bottom-bar buttons and nothing happened.
 * The bar shipped: a bare <View> glyph in the Calendar position with no handler
 * at all, a list glyph wired to the SAME onHome as the Home slot (so tapping it
 * re-rendered the screen the user was already on), and HomeScreen passing
 * `onHome={() => {}}`. Every one of those is a *render* fact, and nothing we ran
 * offline rendered the bar — the real-mode smoke and the dev-mode suite both
 * exercise lib logic, not the bar's element tree. This guard renders the REAL
 * BottomBar (and the REAL CameraButton) with only leaf stubs and asserts, on the
 * tree that actually ships, that:
 *
 *  1. every slot that draws a glyph or carries an a11y label has a callable
 *     handler (a slot that looks like a button IS a button);
 *  2. every control's handler does something REAL and DISTINCT — the Home slot
 *     calls the onHome the screen passed, slot 2 pushes the Promises route, the
 *     Profile slot pushes the Profile route, the camera slot calls onCamera, and
 *     no two slots share one action (the old "Feed" slot was a second Home);
 *  3. the a11y set is exactly Home / Promises / <camera> / Profile — no "Feed",
 *     no "Calendar", no unlabelled control, every side slot role=button with
 *     hitSlop ≥ 6;
 *  4. the inert slots draw nothing AND cannot be tapped (pointerEvents none);
 *  5. the pairing flag changes ONLY slot 2 (solo users get the blank spacer, not
 *     a screen telling them to use a Profile section that does not exist);
 *  6. the 2-left / 2-right split flanking the flex:1 camera slot is intact, so
 *     the camera's centre is screen centre — the frozen geometry the shipped
 *     screenshots depend on (deleting the Calendar slot without a spacer moves
 *     it +28pt, which is the trap this check exists to catch);
 *  7. HomeScreen really wires the Home slot to the feed (ScrollView ref +
 *     scrollTo({y:0})) and never passes a no-op, and passes `inGroup` through.
 *
 * A NEGATIVE CONTROL runs the same analysis functions over the OLD bar shape and
 * requires them to FAIL it — a gate that cannot fail is not a gate.
 *
 * NOT covered here (stated so no one reads more into a green run): anything that
 * needs a real layout engine. The numbers are source-derived, not measured — the
 * guard proves the slot arithmetic and the styles it composes from, not the
 * pixels a device renders. Tap-through on a device and the glyphs' optical
 * position are TestFlight checks (spec §5).
 *
 * RUN:  node scripts/smoke/bottom-bar-guard.cjs          (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');
const React = require('react');

const ROOT = path.resolve(__dirname, '..', '..');
const BAR_SRC = path.join(ROOT, 'src', 'features', 'home', 'BottomBar.tsx');
const HOME_SRC = path.join(ROOT, 'src', 'features', 'home', 'HomeScreen.tsx');
const COMPILE = path.join(ROOT, 'scripts', 'smoke', 'compile.cjs');
const COMPILED = path.join(ROOT, 'scripts', 'smoke', '.compiled');
const PROMISES_ROUTE = path.join(ROOT, 'src', 'app', '(promises)', 'index.tsx');
const PROFILE_ROUTE = path.join(ROOT, 'src', 'app', '(profile)', 'index.tsx');

// --------------------------------------------------------------------------
// tiny reporter (one PASS/FAIL line per check — run_smoke.py counts them)
// --------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function check(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}

console.log('=== bottom-bar-guard: every visible control does something real ===');

// --------------------------------------------------------------------------
// 1. the shared compile step (the same one the other offline suites run) — the
//    guard uses it to read the ledger screen's own title constant, so the bar's
//    label and the destination screen are proven to be one name for one thing.
// --------------------------------------------------------------------------
const compile = spawnSync(process.execPath, [COMPILE], { encoding: 'utf8' });
check(
  'harness: the shared lib compile step (scripts/smoke/compile.cjs) succeeds',
  compile.status === 0,
  (compile.stdout || '').trim().split('\n').pop() || (compile.stderr || '').trim().split('\n')[0] || `exit ${compile.status}`,
);

let promisesLib = null;
try {
  // Same require-map mechanism the other offline suites use: the compiled lib
  // modules resolve their RN/native imports to the harness stubs.
  const { map } = require(path.join(COMPILED, '_deps.json'));
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (Object.prototype.hasOwnProperty.call(map, request)) return path.resolve(ROOT, 'scripts', map[request]);
    return origResolve.call(this, request, ...args);
  };
  promisesLib = require(path.join(COMPILED, 'promises.js'));
} catch (error) {
  promisesLib = null;
}

// --------------------------------------------------------------------------
// 2. load the REAL BottomBar.tsx + CameraButton.tsx with leaf stubs only
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

const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
let pushes = [];
let homeCalls = 0;
let cameraCalls = 0;
const ROUTER = {
  push: (href) => pushes.push(href),
  replace: (href) => pushes.push(href),
  back: () => pushes.push('<-back'),
};
const RN = {
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles) => styles },
};
/** Ionicons is a leaf: it renders a host element named "Ionicons" carrying the
 * glyph name, so the walker can read which glyph a slot draws. */
function Glyph(props) {
  return React.createElement('Ionicons', props);
}

function loadModule(file, stubs) {
  const cache = new Map();
  function load(f) {
    const resolved = path.extname(f) ? f : ['.tsx', '.ts', '.js'].map((e) => f + e).find((cand) => fs.existsSync(cand));
    if (!resolved || !fs.existsSync(resolved)) throw new Error(`cannot resolve module: ${f}`);
    if (cache.has(resolved)) return cache.get(resolved);
    const src = resolved.endsWith('.js') ? fs.readFileSync(resolved, 'utf8') : transpile(resolved);
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('require', 'module', 'exports', '__dirname', '__filename', `${src}\n//# sourceURL=${resolved}`);
    fn(makeRequire(resolved), mod, mod.exports, path.dirname(resolved), resolved);
    cache.set(resolved, mod.exports);
    return mod.exports;
  }
  function makeRequire(fromFile) {
    return (id) => {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      if (id.startsWith('@/')) return load(path.join(ROOT, 'src', id.slice(2)));
      const rel = path.resolve(path.dirname(fromFile), id);
      if (fs.existsSync(rel) || ['.ts', '.tsx', '.js'].some((e) => fs.existsSync(rel + e))) return load(rel);
      throw new Error(`unstubbed require from ${path.relative(ROOT, fromFile)}: ${id}`);
    };
  }
  return load(file);
}

const tokens = loadModule(path.join(ROOT, 'src', 'theme', 'tokens.ts'), {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
});

let bar = null;
let harnessError = null;
try {
  bar = loadModule(BAR_SRC, {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': RN,
    'react-native-safe-area-context': { useSafeAreaInsets: () => INSETS },
    'expo-router': { useRouter: () => ROUTER },
    '@expo/vector-icons': { Ionicons: Glyph },
    '@/theme/tokens': tokens,
  }).BottomBar;
  // The real CameraButton loads through the bar's own relative import — proved
  // by the camera-slot checks below, which see its real Pressable + label.
} catch (error) {
  harnessError = error;
}
check(
  'harness: the real BottomBar + CameraButton render with only leaf stubs (RN, router, icons, tokens)',
  typeof bar === 'function',
  harnessError ? `${harnessError.name}: ${harnessError.message}` : typeof bar,
);

check(
  'harness: the bar label, the ledger screen title and the pushed route are ONE name for one thing',
  !!promisesLib &&
    promisesLib.PROMISES_SCREEN_TITLE === 'Promises' &&
    fs.existsSync(PROMISES_ROUTE) &&
    fs.existsSync(PROFILE_ROUTE),
  promisesLib ? `title=${JSON.stringify(promisesLib.PROMISES_SCREEN_TITLE)} promisesRoute=${fs.existsSync(PROMISES_ROUTE)} profileRoute=${fs.existsSync(PROFILE_ROUTE)}` : 'promises.js did not compile',
);

// --------------------------------------------------------------------------
// 3. element-tree helpers: instantiate components, collect descendants, styles
// --------------------------------------------------------------------------
function instantiate(el, depth = 0) {
  let cur = el;
  while (depth < 20 && React.isValidElement(cur) && typeof cur.type === 'function') {
    const next = cur.type(cur.props);
    cur = Array.isArray(next) ? next[0] : next;
    depth += 1;
  }
  return cur;
}
function children(el) {
  const node = instantiate(el);
  if (!React.isValidElement(node)) return [];
  return React.Children.toArray(node.props.children).map((child) => instantiate(child));
}
/** The instantiated element plus every descendant element, depth-first. */
function subtree(el, out = []) {
  const node = instantiate(el);
  if (!React.isValidElement(node)) return out;
  out.push(node);
  React.Children.toArray(node.props.children).forEach((child) => subtree(child, out));
  return out;
}
function styleOf(el) {
  const raw = instantiate(el).props.style;
  const parts = Array.isArray(raw) ? raw.flat(3) : [raw];
  const merged = {};
  for (const part of parts) {
    if (!part) continue;
    const resolved = typeof part === 'function' ? part({ pressed: false }) : part;
    if (resolved && typeof resolved === 'object') Object.assign(merged, resolved);
  }
  return merged;
}

/** The analysis the guard ships on. Returns, for one slot: what it draws, what
 * it can be tapped by, and what tapping it actually does. */
function analyseSlot(el) {
  const nodes = subtree(el);
  const glyphs = nodes.filter((n) => n.type === 'Ionicons' && typeof n.props.name === 'string').map((n) => n.props.name);
  const texts = nodes
    .filter((n) => n.type === 'Text' && typeof n.props.children === 'string')
    .map((n) => n.props.children);
  const pressables = nodes.filter((n) => n.type === 'Pressable');
  const labelled = nodes.filter((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.length > 0);
  const handlers = pressables.filter((p) => typeof p.props.onPress === 'function');
  return {
    el,
    glyphs,
    texts,
    pressableCount: pressables.length,
    handlerCount: handlers.length,
    roleButtons: pressables.filter((p) => p.props.accessibilityRole === 'button').length,
    labels: labelled.map((n) => n.props.accessibilityLabel),
    hitSlops: pressables.map((p) => (typeof p.props.hitSlop === 'number' ? p.props.hitSlop : 0)),
    drawsSomething: glyphs.length > 0 || texts.length > 0 || labelled.length > 0,
    style: styleOf(el),
  };
}

/** Dead = it looks like a control (glyph, text or label) but nothing on it can
 * be tapped. This is the rule the shipped Calendar slot and the no-op Home slot
 * both violate. */
const isDead = (slot) => slot.drawsSomething && slot.handlerCount === 0;

/** What pressing this slot DOES — spies reset per call so two slots sharing one
 * action (the old list slot re-using onHome) is visible. */
function effectOf(slot) {
  pushes = [];
  homeCalls = 0;
  cameraCalls = 0;
  subtree(slot.el)
    .filter((n) => n.type === 'Pressable' && typeof n.props.onPress === 'function')
    .forEach((n) => n.props.onPress({}));
  return { pushes: [...pushes], homeCalls, cameraCalls };
}
const effectKey = (effect) => JSON.stringify(effect);

function renderBar(inGroup, weekCount = 0) {
  pushes = [];
  homeCalls = 0;
  cameraCalls = 0;
  const tree = instantiate(
    bar({
      onHome: () => {
        homeCalls += 1;
      },
      onCamera: () => {
        cameraCalls += 1;
      },
      inGroup,
      weekCount,
    }),
  );
  const slots = children(tree).map(analyseSlot);
  return { tree, slots, barStyle: styleOf(tree) };
}

let grouped = null;
let solo = null;
let renderError = null;
try {
  grouped = renderBar(true, 0);
  solo = renderBar(false, 0);
} catch (error) {
  renderError = error;
}
const renderable = !!grouped && !!solo;
check(
  'harness: the bar renders in BOTH modes (paired and solo) without throwing',
  renderable,
  renderError ? `${renderError.name}: ${renderError.message}` : renderable ? 'paired + solo' : 'no render',
);

// --------------------------------------------------------------------------
// 4. structure — the frozen 5-slot split (nothing added, nothing that moves the
//    camera: 2 slots left, flex:1 camera, 2 slots right)
// --------------------------------------------------------------------------
const slotSummary = (r) =>
  r
    ? r.slots.map((s, i) => `${i}:${s.style.width ?? (s.style.flex ? 'flex' : '?')}`).join(' ')
    : 'not rendered';

check(
  'paired: the bar is exactly 5 slots — 2 left / camera / 2 right (no 6th slot, no badge)',
  renderable && grouped.slots.length === 5,
  renderable ? `${grouped.slots.length} slots :: ${slotSummary(grouped)}` : 'not rendered',
);
check(
  'solo: the bar is still exactly 5 slots — the blank spacer keeps the count',
  renderable && solo.slots.length === 5,
  renderable ? `${solo.slots.length} slots :: ${slotSummary(solo)}` : 'not rendered',
);

// --------------------------------------------------------------------------
// 5. geometry — the camera must not move
// --------------------------------------------------------------------------
const LEFT = [0, 1];
const CAMERA = 2;
const RIGHT = [3, 4];
function splitIsCentred(r) {
  if (!r || r.slots.length !== 5) return { ok: false, why: 'not 5 slots' };
  const width = (i) => r.slots[i].style.width;
  const left = LEFT.reduce((sum, i) => sum + (width(i) || 0), 0);
  const right = RIGHT.reduce((sum, i) => sum + (width(i) || 0), 0);
  const cam = r.slots[CAMERA].style;
  const symmetricPadding =
    !r.barStyle.paddingHorizontal && !r.barStyle.paddingLeft && !r.barStyle.paddingRight;
  return {
    ok: left > 0 && left === right && cam.flex === 1 && symmetricPadding,
    why: `left=${left} right=${right} cameraFlex=${cam.flex} symmetricPadding=${symmetricPadding}`,
  };
}
const groupedCentre = splitIsCentred(grouped);
const soloCentre = splitIsCentred(solo);
check(
  'paired: 2×56pt left == 2×56pt right flanking the flex:1 camera slot → camera centre = screen centre',
  groupedCentre.ok,
  groupedCentre.why,
);
check(
  'solo: the same split holds with slot 2 blank (the spacer is not dropped when unpaired)',
  soloCentre.ok,
  soloCentre.why,
);
const barStyleKeys = renderable ? grouped.barStyle : {};
check(
  'frozen geometry: slot 56×40, camera slot flex:1 + marginTop:-8, bar paddingTop 8 (no reflow)',
  renderable &&
    grouped.slots[0].style.width === 56 &&
    grouped.slots[0].style.height === 40 &&
    grouped.slots[CAMERA].style.flex === 1 &&
    grouped.slots[CAMERA].style.marginTop === -8 &&
    barStyleKeys.paddingTop === 8,
  renderable
    ? `slot=${grouped.slots[0].style.width}×${grouped.slots[0].style.height} cameraFlex=${grouped.slots[CAMERA].style.flex} cameraMarginTop=${grouped.slots[CAMERA].style.marginTop} barPaddingTop=${barStyleKeys.paddingTop}`
    : 'not rendered',
);

const barSource = fs.existsSync(BAR_SRC) ? fs.readFileSync(BAR_SRC, 'utf8') : '';
check(
  'frozen geometry (static): no space-around/gap/fixed camera width and SLOT_WIDTH is still 56',
  /const SLOT_WIDTH = 56;/.test(barSource) &&
    !/space-around|space-evenly/.test(barSource) &&
    !/cameraSlot:[\s\S]{0,160}?\bwidth:/.test(barSource) &&
    !/gap:/.test(barSource),
  `SLOT_WIDTH56=${/const SLOT_WIDTH = 56;/.test(barSource)} spaceAround=${/space-around|space-evenly/.test(barSource)} fixedCameraWidth=${/cameraSlot:[\s\S]{0,160}?\bwidth:/.test(barSource)} gap=${/gap:/.test(barSource)}`,
);

// --------------------------------------------------------------------------
// 6. honesty — every visible control is real, distinct, labelled and reachable
// --------------------------------------------------------------------------
const groupedDead = renderable ? grouped.slots.filter(isDead) : [];
check(
  'paired: every slot that DRAWS something (glyph/text/label) can be tapped — no dead control',
  renderable && groupedDead.length === 0,
  renderable ? `dead=${groupedDead.length} ${JSON.stringify(groupedDead.map((s) => s.glyphs.concat(s.labels)))}` : 'not rendered',
);
const soloDead = renderable ? solo.slots.filter(isDead) : [];
check(
  'solo: no dead control either (the blank spacer draws nothing, so it cannot read as a button)',
  renderable && soloDead.length === 0,
  renderable ? `dead=${soloDead.length}` : 'not rendered',
);

const sideLabels = renderable ? [grouped.slots[0], grouped.slots[1], grouped.slots[4]].flatMap((s) => s.labels) : [];
const allLabels = renderable ? grouped.slots.flatMap((s) => s.labels) : [];
check(
  'a11y: the side slots are labelled exactly Home / Promises / Profile — never "Feed", never "Calendar"',
  renderable &&
    JSON.stringify(sideLabels) === JSON.stringify(['Home', 'Promises', 'Profile']) &&
    !allLabels.some((l) => /feed|calendar|history/i.test(l)),
  `labels=${JSON.stringify(allLabels)}`,
);
check(
  'a11y: VoiceOver walks Home → Promises → camera → Profile, and every control declares role=button',
  renderable &&
    JSON.stringify(allLabels) === JSON.stringify(['Home', 'Promises', 'Log a workout', 'Profile']) &&
    [0, 1, 4].every((i) => grouped.slots[i].roleButtons === 1) &&
    grouped.slots[CAMERA].roleButtons === 1,
  `labels=${JSON.stringify(allLabels)} roles=${JSON.stringify(grouped.slots.map((s) => s.roleButtons))}`,
);
check(
  'a11y: every pressable slot carries hitSlop ≥ 6 (the 56×40 slot is under the 44pt target without it)',
  renderable && [0, 1, 4].every((i) => grouped.slots[i].hitSlops.every((v) => v >= 6)),
  renderable ? `hitSlops=${JSON.stringify(grouped.slots.map((s) => s.hitSlops))}` : 'not rendered',
);

const pairedEffects = renderable ? grouped.slots.map(effectOf) : [];
const soloEffects = renderable ? solo.slots.map(effectOf) : [];
check(
  'action: the Home slot calls the onHome its screen passed (scroll-to-top), exactly once',
  renderable && pairedEffects[0].homeCalls === 1 && pairedEffects[0].pushes.length === 0,
  JSON.stringify(pairedEffects[0]),
);
check(
  'action: slot 2 pushes the Promises ledger — the muscle memory that produced the complaint lands somewhere real',
  renderable &&
    JSON.stringify(pairedEffects[1].pushes) === JSON.stringify(['/(promises)']) &&
    pairedEffects[1].homeCalls === 0,
  JSON.stringify(pairedEffects[1]),
);
check(
  'action: the Profile slot pushes the Profile route',
  renderable && JSON.stringify(pairedEffects[4].pushes) === JSON.stringify(['/(profile)']),
  JSON.stringify(pairedEffects[4]),
);
check(
  'action: the camera slot calls onCamera (the shipped, real CameraButton — not a stand-in)',
  renderable && pairedEffects[CAMERA].cameraCalls === 1 && grouped.slots[CAMERA].labels.length === 1,
  `${JSON.stringify(pairedEffects[CAMERA])} cameraLabel=${JSON.stringify(grouped.slots[CAMERA].labels)}`,
);
const effectKeys = pairedEffects.map(effectKey);
check(
  'action: no two slots share one action (the old "Feed" slot was a second Home)',
  renderable && new Set(effectKeys).size === effectKeys.length,
  JSON.stringify(effectKeys),
);
check(
  'inert: the blank slots draw nothing, carry no label/role and are pointerEvents="none" (they cannot swallow a tap)',
  renderable &&
    [3].every((i) => {
      const s = grouped.slots[i];
      return !s.drawsSomething && s.pressableCount === 0 && s.style.width === 56;
    }) &&
    subtree(grouped.slots[3].el).every((n) => n.props.pointerEvents === 'none') &&
    React.Children.toArray(instantiate(grouped.slots[3].el).props.children).length === 0,
  renderable ? `spacer=${JSON.stringify({ draws: grouped.slots[3].drawsSomething, pressables: grouped.slots[3].pressableCount, pointerEvents: instantiate(grouped.slots[3].el).props.pointerEvents })}` : 'not rendered',
);
check(
  'deleted: no calendar glyph and no calendar/history slot survives in either mode',
  renderable &&
    !grouped.slots.some((s) => s.glyphs.some((g) => /calendar|history/.test(g))) &&
    !solo.slots.some((s) => s.glyphs.some((g) => /calendar|history/.test(g))),
  renderable ? `glyphs=${JSON.stringify(grouped.slots.map((s) => s.glyphs))}` : 'not rendered',
);
check(
  'the ledger glyph is the ruled one (journal-outline), not receipts/list/swap/people',
  renderable && JSON.stringify(grouped.slots[1].glyphs) === JSON.stringify(['journal-outline']),
  renderable ? JSON.stringify(grouped.slots[1].glyphs) : 'not rendered',
);

// --------------------------------------------------------------------------
// 7. solo — the pairing flag changes ONLY slot 2
// --------------------------------------------------------------------------
const unchanged = (i) =>
  renderable &&
  instantiate(grouped.slots[i].el).type === instantiate(solo.slots[i].el).type &&
  JSON.stringify(grouped.slots[i].glyphs) === JSON.stringify(solo.slots[i].glyphs) &&
  JSON.stringify(grouped.slots[i].style) === JSON.stringify(solo.slots[i].style) &&
  JSON.stringify(grouped.slots[i].labels) === JSON.stringify(solo.slots[i].labels);
check(
  'solo: toggling the pairing flag changes ONLY slot 2 — slots 1, 4 and 5 are element-for-element identical (no reflow)',
  renderable && [0, 3, 4].every(unchanged),
  renderable ? `unchanged=${JSON.stringify([0, 3, 4].map(unchanged))}` : 'not rendered',
);
check(
  'solo: slot 2 renders the blank spacer — no glyph, no label, nothing tappable, and the ledger is unreachable',
  renderable &&
    solo.slots[1].glyphs.length === 0 &&
    solo.slots[1].labels.length === 0 &&
    solo.slots[1].handlerCount === 0 &&
    solo.slots[1].style.width === 56 &&
    soloEffects.every((e) => !e.pushes.includes('/(promises)')),
  renderable
    ? JSON.stringify({ glyphs: solo.slots[1].glyphs, labels: solo.slots[1].labels, handlers: solo.slots[1].handlerCount, width: solo.slots[1].style.width, soloPushes: soloEffects.map((e) => e.pushes) })
    : 'not rendered',
);

// --------------------------------------------------------------------------
// 8. NEGATIVE CONTROL — the same analysis must FAIL the shipped-old shape
// --------------------------------------------------------------------------
const OLD_CALENDAR_STYLE = { width: 56, height: 40, alignItems: 'center', justifyContent: 'center', opacity: 1 };
const oldSlot = (children, style = { width: 56, height: 40, alignItems: 'center', justifyContent: 'center' }) =>
  React.createElement('View', { style }, children);
const oldIcon = (name) => React.createElement(Glyph, { name, size: 24, color: '#000' });
const oldBar = React.createElement(
  'View',
  { style: { flexDirection: 'row', alignItems: 'center', paddingTop: 8 } },
  React.createElement('Pressable', { accessibilityRole: 'button', accessibilityLabel: 'Home', onPress: () => (homeCalls += 1), style: { width: 56, height: 40 } }, oldIcon('home')),
  React.createElement('Pressable', { accessibilityRole: 'button', accessibilityLabel: 'Feed', onPress: () => (homeCalls += 1), style: { width: 56, height: 40 } }, oldIcon('list')),
  React.createElement(
    'View',
    { style: { flex: 1, marginTop: -8 } },
    React.createElement(
      'Pressable',
      { accessibilityRole: 'button', accessibilityLabel: 'Log a workout', onPress: () => (cameraCalls += 1) },
      oldIcon('camera'),
    ),
  ),
  oldSlot(oldIcon('calendar-outline'), OLD_CALENDAR_STYLE),
  React.createElement('Pressable', { accessibilityRole: 'button', accessibilityLabel: 'Profile', onPress: () => pushes.push('/(profile)'), style: { width: 56, height: 40 } }, oldIcon('person-outline')),
);
const oldSlots = children(oldBar).map(analyseSlot);
const oldDead = oldSlots.filter(isDead);
check(
  'negative control: the OLD shape (bare Calendar glyph, no handler) IS reported dead by this guard',
  oldSlots.length === 5 && oldDead.length === 1 && oldDead[0].glyphs.includes('calendar-outline'),
  `slots=${oldSlots.length} dead=${JSON.stringify(oldDead.map((s) => s.glyphs))}`,
);
const oldEffects = oldSlots.map(effectOf);
check(
  'negative control: the OLD list slot (a second Home labelled "Feed") IS caught — duplicate action + wrong label',
  JSON.stringify(oldEffects[0]) === JSON.stringify(oldEffects[1]) &&
    oldEffects[0].homeCalls === 1 &&
    oldSlots[1].labels.includes('Feed'),
  `home=${JSON.stringify(oldEffects[0])} list=${JSON.stringify(oldEffects[1])} labels=${JSON.stringify(oldSlots.flatMap((s) => s.labels))}`,
);
const oldEffectKeys = oldEffects.map(effectKey);
check(
  'negative control: the OLD bar fails the shared-action rule and its label set is not the ruled one',
  new Set(oldEffectKeys).size !== oldEffectKeys.length &&
    JSON.stringify([oldSlots[0], oldSlots[1], oldSlots[4]].flatMap((s) => s.labels)) !== JSON.stringify(['Home', 'Promises', 'Profile']),
  `distinctEffects=${new Set(oldEffectKeys).size} of ${oldEffectKeys.length}`,
);

// --------------------------------------------------------------------------
// 9. the screen that mounts the bar — real wiring, not a promise
// --------------------------------------------------------------------------
const homeSource = fs.existsSync(HOME_SRC) ? fs.readFileSync(HOME_SRC, 'utf8') : '';
const homeMounted = (homeSource.match(/<BottomBar[\s\S]*?\/>/g) || []).join('\n');
check(
  'HomeScreen: the Home slot really scrolls the feed — a ScrollView ref plus scrollTo({y:0, animated:true})',
  /const scrollRef = useRef</.test(homeSource) && /ref=\{scrollRef\}/.test(homeSource) && /scrollRef\.current\?\.scrollTo\(\{\s*y:\s*0,\s*animated:\s*true\s*\}\)/.test(homeSource),
  `ref=${/const scrollRef = useRef/.test(homeSource)} attached=${/ref=\{scrollRef\}/.test(homeSource)} scrollTo=${/scrollRef\.current\?\.scrollTo\(/.test(homeSource)}`,
);
check(
  'HomeScreen: the no-op onHome is gone (`onHome={() => {}}` can never ship again)',
  !!homeMounted && !/onHome=\{\(\)\s*=>\s*\{\}\}/.test(homeSource) && /onHome=\{\(\)\s*=>\s*scrollRef/.test(homeMounted),
  JSON.stringify(homeMounted.replace(/\s+/g, ' ').slice(0, 160)),
);
check(
  'HomeScreen: the bar is told whether the user is paired (`inGroup={inGroup}`)',
  /inGroup=\{inGroup\}/.test(homeMounted),
  `mounted=${/inGroup=\{inGroup\}/.test(homeMounted)}`,
);
const barImporters = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name) && /features\/home\/BottomBar'|features\/home\/BottomBar"/.test(fs.readFileSync(full, 'utf8'))) {
      barImporters.push(path.relative(ROOT, full));
    }
  }
})(path.join(ROOT, 'src'));
check(
  'the bar belongs to HomeScreen only — the ledger/Profile screens stay pushed screens with no bar',
  barImporters.length === 1 && barImporters[0].endsWith(path.join('features', 'home', 'HomeScreen.tsx')),
  JSON.stringify(barImporters),
);
check(
  'the "WK START" pill is a status chip, not a dead dropdown (no chevron-down glyph on it)',
  !/name="chevron-down"/.test(homeSource),
  `chevronDownGlyph=${/name="chevron-down"/.test(homeSource)}`,
);

console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
