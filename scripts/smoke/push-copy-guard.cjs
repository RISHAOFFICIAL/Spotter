#!/usr/bin/env node
/*
 * push-copy-guard — the offline check that the app never again PROMISES a push
 * the backend cannot send.
 *
 * WHY IT EXISTS: the app told users "Know when {partner} logs, and when your
 * invite is accepted" (NotificationsSheet) and "When your partner logs a
 * workout." (the Profile "Partner logged" toggle). Both are CROSS-USER types and
 * neither can ever deliver in a real build: resolveRealTarget
 * (src/lib/pushDispatch.ts:219-225) returns expoPushToken: null for any
 * recipient other than the current user — it does not even attempt the read,
 * because push_devices is own-row RLS (schema.sql). A null token becomes the
 * suppression reason 'no_device' (:553-555). The two OWN-DEVICE types
 * (pending_invite, missed_week) DO deliver, so this guard also protects their
 * claims from being weakened. Evidence:
 * /home/team/shared/push-reachability-verified-2026-09-23.md.
 *
 * WHAT IT ASSERTS (fixed count, one PASS/FAIL line per check):
 *  A. it renders the REAL NotificationsSheet (leaf stubs only), reads the text
 *     off the element tree, and requires the exact honest sentence — so the
 *     claim is gated on what SHIPS, not on a regex over the file;
 *  B. it reads NOTIFICATION_META from the COMPILED lib (the same module the
 *     Profile screen renders) and gates all four labels/captions;
 *  C. it sweeps every .ts/.tsx under src/ for the retired phrasings — comments
 *     included, because a doc comment that re-quotes the old promise is how
 *     this claim would come back;
 *  D. a NEGATIVE CONTROL runs the SAME analyser over the retired strings and
 *     requires it to FAIL them, and the same static sweep over the pre-fix
 *     source text. A gate that cannot fail is not a gate.
 *
 * NOT covered (stated so a green run is not read as more than it is): this is
 * TEXT on the element tree, not pixels — nothing here proves a device renders
 * it, and nothing here changes push behaviour. The dispatch path is asserted
 * only in its COMMENT (the code is deliberately untouched).
 *
 * RUN:  node scripts/smoke/push-copy-guard.cjs        (exit 1 on any FAIL)
 * COUNT: FIXED_CHECKS table lines + 1 self-check line = 19 PASS/FAIL lines, the
 *        number scripts/real-mode-smoke/run_smoke.py pins as PUSH_COPY_GUARD_CHECKS
 *        (a missing, silent or shrunken guard is itself a FAIL there).
 * WIRED: scripts/real-mode-smoke/run_smoke.py flow 0e
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');
const React = require('react');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const SHEET_SRC = path.join(SRC, 'features', 'invites', 'NotificationsSheet.tsx');
const PREFS_SRC = path.join(SRC, 'lib', 'notificationPrefs.ts');
const DISPATCH_SRC = path.join(SRC, 'lib', 'pushDispatch.ts');
const PROFILE_SRC = path.join(SRC, 'features', 'profile', 'ProfileScreen.tsx');
const COMPILE = path.join(ROOT, 'scripts', 'smoke', 'compile.cjs');
const COMPILED = path.join(ROOT, 'scripts', 'smoke', '.compiled');
const FIXED_CHECKS = 18;

// ---------------------------------------------------------------------------
// the claim set. ONE analyser, used by the shipped tree AND the negative control.
// Each entry is a user-facing promise that the backend cannot keep today.
// ---------------------------------------------------------------------------
const FORBIDDEN_CLAIMS = [
  { id: 'partner-log promise ("know when … logs")', re: /know when [^.?!]{0,40}logs/i },
  { id: 'partner-log promise ("when your partner logs")', re: /when your partner logs/i },
  { id: 'invite-accepted promise ("invite is accepted")', re: /invite is accepted/i },
  { id: 'invite-accepted promise ("you invited pairs up")', re: /when someone you invited pairs up/i },
  { id: 'generic promise ("we\'ll/you\'ll tell you know when")', re: /(?:we|you)'?ll (?:tell|let) you know (?:when|once)/i },
  { id: 'generic promise ("notify you when")', re: /notify you when/i },
  { id: 'generic promise ("you\'ll know when")', re: /you'?ll know (?:when|the moment)/i },
];
/** The retired dispatch comment: it claimed a cross-user send that does not happen. */
const RETIRED_DISPATCH_CLAIM = /in real mode the send still happens/i;

const norm = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

/** Every forbidden promise present in one string (deduped by id). */
function promiseViolations(text) {
  const t = String(text == null ? '' : text);
  const seen = new Map();
  for (const claim of FORBIDDEN_CLAIMS) {
    const match = t.match(claim.re);
    if (match && !seen.has(claim.id)) seen.set(claim.id, match[0]);
  }
  return [...seen.entries()].map(([id, hit]) => ({ id, hit }));
}

/** The static half: forbidden promise phrasings + the retired dispatch comment. */
function sweepSource(text) {
  return {
    promises: promiseViolations(text),
    staleDispatchClaim: RETIRED_DISPATCH_CLAIM.test(String(text || '')),
  };
}

/** The analysis a copy set (sheet text, or the pre-fix strings) must pass. */
function analyseCopy(strings, expectedSentences) {
  const joined = norm(strings.join(' \u0001 '));
  const violations = [];
  for (const text of strings) {
    for (const v of promiseViolations(text)) {
      if (!violations.some((seen) => seen.id === v.id)) violations.push(v);
    }
  }
  const missing = (expectedSentences || []).filter((sentence) => !joined.includes(norm(sentence)));
  return { ok: violations.length === 0 && missing.length === 0, violations, missing, joined };
}

// ---------------------------------------------------------------------------
// the copy this branch ships (single source of truth for the checks AND for the
// negative control, which feeds the RETIRED strings through the same analyser)
// ---------------------------------------------------------------------------
const CROSS_USER_CAPTION = 'Not sending yet — your setting is saved.';
const SHEET_BODY = (name) =>
  `A nudge if an invite you sent is still waiting, and a missed-week alert you can switch on — that\u2019s everything we send today. ${name}\u2019s workouts show up in your feed, and you control every type in Profile later.`;

const RETIRED = {
  sheetBody: (name) =>
    `Know when ${name} logs, and when your invite is accepted — nothing else. You stay in control of every type in Profile later.`,
  captions: {
    invite_accepted: 'When someone you invited pairs up.',
    partner_logged: 'When your partner logs a workout.',
  },
  sourceSample: [
    "          Know when {partnerFirstName ?? 'your partner'} logs, and when your invite is accepted — nothing else. You stay in control of every type in Profile later.",
    "    caption: 'When someone you invited pairs up.',",
    "    caption: 'When your partner logs a workout.',",
    ' *       accepts any token) but the row insert is rejected by RLS',
    ' *       evaluates it (their open) and CANNOT write the inviter\'s row under',
    ' *       own-row RLS. In real mode the send still happens (the Expo API',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// tiny reporter — exactly one PASS/FAIL line per check (run_smoke.py counts them)
// ---------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function report(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}
const checks = [];
const check = (name, run) => checks.push({ name, run });

console.log('=== push-copy-guard: no promise of a push that cannot be sent ===');

// ---------------------------------------------------------------------------
// harness: the shared compile step (needed for the compiled NOTIFICATION_META)
// and the real sheet rendered with leaf stubs
// ---------------------------------------------------------------------------
const compileRun = spawnSync(process.execPath, [COMPILE], { encoding: 'utf8' });
const compileOk = compileRun.status === 0;
check('harness: the shared lib compile step (scripts/smoke/compile.cjs) succeeds', () => ({
  ok: compileOk,
  detail: (compileRun.stdout || '').trim().split('\n').pop() || (compileRun.stderr || '').trim().split('\n')[0] || `exit ${compileRun.status}`,
}));

/** Deep stub: any property/method access yields another deep stub (stringifies to
 * the key name). Used only if the REAL theme modules cannot be loaded. */
function deepStub() {
  const target = function stub() {};
  return new Proxy(target, {
    get: (_t, prop) => {
      if (prop === 'then' || prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return undefined;
      return deepStub();
    },
    apply: () => deepStub(),
  });
}

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

/** Load a module with a caller-supplied require map (the pattern the other
 * offline guards use). Returns { module } or { error }. */
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
      if (/\.(png|jpe?g|svg|ttf|json)$/i.test(id)) return {};
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      if (id.startsWith('@/')) return load(path.join(ROOT, 'src', id.slice(2)));
      const rel = path.resolve(path.dirname(fromFile), id);
      if (fs.existsSync(rel) || ['.ts', '.tsx', '.js'].some((e) => fs.existsSync(rel + e))) return load(rel);
      throw new Error(`unstubbed require from ${path.relative(ROOT, fromFile)}: ${id}`);
    };
  }
  return load(file);
}

const RN = {
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  Modal: 'Modal',
  StyleSheet: { create: (styles) => styles },
  ScrollView: 'ScrollView',
  Switch: 'Switch',
};
const Glyph = (props) => React.createElement('Ionicons', props);
const NOOP_ASYNC = async () => {};

let themeModules = null;
try {
  const reactStubs = { react: React, 'react/jsx-runtime': require('react/jsx-runtime') };
  const tokens = loadModule(path.join(SRC, 'theme', 'tokens.ts'), reactStubs);
  let typography = {};
  try {
    typography = loadModule(path.join(SRC, 'theme', 'typography.ts'), reactStubs);
  } catch {
    typography = {};
  }
  themeModules = { tokens, typography };
} catch {
  themeModules = null;
}
const TOKENS = themeModules && themeModules.tokens ? themeModules.tokens : deepStub();
const TYPOGRAPHY = themeModules && themeModules.typography && themeModules.typography.textStyles ? themeModules.typography : deepStub();

let sheetError = null;
let Sheet = null;
try {
  Sheet = loadModule(SHEET_SRC, {
    react: React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': RN,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) },
    '@expo/vector-icons': { Ionicons: Glyph },
    '@/theme/tokens': TOKENS,
    '@/theme/typography': TYPOGRAPHY,
    // A LEAF stub (stated honestly): this guard is about copy, and loading the
    // real notifications lib would drag expo-notifications into the harness.
    '@/lib/notifications': {
      markNotificationExplained: NOOP_ASYNC,
      dismissNotificationAsk: NOOP_ASYNC,
      requestNotificationPermission: async () => 'granted',
      refreshPushRegistrationIfGranted: NOOP_ASYNC,
    },
  }).NotificationsSheet;
} catch (error) {
  sheetError = error;
}
check('harness: the real NotificationsSheet loads and renders with leaf stubs only (RN, icons, safe-area, theme, lib)', () => ({
  ok: typeof Sheet === 'function',
  detail: sheetError ? `${sheetError.name}: ${sheetError.message}` : `theme=${themeModules ? 'real' : 'stub'} sheet=${typeof Sheet}`,
}));

// ---------------------------------------------------------------------------
// element-tree helpers (string components + function components, fragments,
// arrays — the shapes React.Children.toArray would flatten)
// ---------------------------------------------------------------------------
function collectElements(root, out = []) {
  const rec = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach(rec);
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') return;
    if (!React.isValidElement(node)) return;
    let el = node;
    let guard = 0;
    while (React.isValidElement(el) && typeof el.type === 'function' && guard < 20) {
      el = el.type(el.props);
      guard += 1;
    }
    if (!React.isValidElement(el)) {
      rec(el);
      return;
    }
    if (el.type === React.Fragment) {
      rec(el.props.children);
      return;
    }
    out.push(el);
    rec(el.props.children);
  };
  rec(root);
  return out;
}
/** All string content inside one element, concatenated in render order. */
function textOf(el) {
  let text = '';
  const rec = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (Array.isArray(node)) {
      node.forEach(rec);
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      text += String(node);
      return;
    }
    if (!React.isValidElement(node)) return;
    let inner = node;
    let guard = 0;
    while (React.isValidElement(inner) && typeof inner.type === 'function' && guard < 20) {
      inner = inner.type(inner.props);
      guard += 1;
    }
    if (React.isValidElement(inner)) rec(inner.props.children);
  };
  rec(el.props.children);
  return text;
}
function renderSheetText(partnerFirstName) {
  const tree = Sheet({ visible: true, partnerFirstName, onDone: () => {} });
  return collectElements(tree)
    .filter((el) => el.type === 'Text')
    .map(textOf)
    .filter((text) => text.trim().length > 0);
}

// ---------------------------------------------------------------------------
// A–B: the shipped sheet copy
// ---------------------------------------------------------------------------
let sheetTexts = [];
let sheetRenderError = null;
try {
  sheetTexts = renderSheetText('Alex');
} catch (error) {
  sheetRenderError = error;
}
const sheetAnalysis = sheetRenderError ? { ok: false, violations: [], missing: [SHEET_BODY('Alex')], joined: '' } : analyseCopy(sheetTexts, [SHEET_BODY('Alex')]);
check('sheet: the rendered body is the exact honest sentence (named partner), not the retired one', () => ({
  ok: sheetAnalysis.ok,
  detail: sheetRenderError
    ? `${sheetRenderError.name}: ${sheetRenderError.message}`
    : `missing=${JSON.stringify(sheetAnalysis.missing)} violations=${sheetAnalysis.violations.length} text=${JSON.stringify(sheetAnalysis.joined.slice(0, 90))}…`,
}));
check('sheet: no forbidden push promise appears anywhere in its rendered text', () => ({
  ok: !sheetRenderError && sheetAnalysis.violations.length === 0,
  detail: `violations=${JSON.stringify(sheetAnalysis.violations)}`,
}));

let fallback = { ok: false, detail: 'not rendered' };
try {
  const texts = renderSheetText(null);
  const analysis = analyseCopy(texts, [SHEET_BODY('Your partner')]);
  fallback = {
    ok: analysis.ok && !texts.some((t) => /your partner logs/i.test(t)),
    detail: `missing=${JSON.stringify(analysis.missing)} violations=${analysis.violations.length} text=${JSON.stringify(analysis.joined.slice(0, 80))}…`,
  };
} catch (error) {
  fallback = { ok: false, detail: `${error.name}: ${error.message}` };
}
check('sheet: the no-name fallback renders the same honest sentence with "Your partner" and is violation-free', () => fallback);

const joinedSheet = sheetAnalysis.joined;
check('sheet: the rest of the sheet is untouched — headline, Enable and Not now still render', () => ({
  ok:
    joinedSheet.includes('Pair accountability, on your phone') &&
    joinedSheet.includes('Enable notifications') &&
    joinedSheet.includes('Not now'),
  detail: JSON.stringify(joinedSheet.slice(0, 60)),
}));

// ---------------------------------------------------------------------------
// B: the compiled NOTIFICATION_META the Profile toggles render
// ---------------------------------------------------------------------------
let meta = null;
let metaError = null;
try {
  const { map } = require(path.join(COMPILED, '_deps.json'));
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (Object.prototype.hasOwnProperty.call(map, request)) return path.resolve(ROOT, 'scripts', map[request]);
    return origResolve.call(this, request, ...args);
  };
  meta = require(path.join(COMPILED, 'notificationPrefs.js')).NOTIFICATION_META;
} catch (error) {
  metaError = error;
}
const metaDetail = () => (metaError ? `${metaError.name}: ${metaError.message}` : JSON.stringify(meta));

check('prefs: the compiled "Partner logged" caption is the honest not-sending line', () => ({
  ok: !!meta && meta.partner_logged && meta.partner_logged.caption === CROSS_USER_CAPTION,
  detail: metaDetail(),
}));
check('prefs: the compiled "Invite accepted" caption is the honest not-sending line', () => ({
  ok: !!meta && meta.invite_accepted && meta.invite_accepted.caption === CROSS_USER_CAPTION,
  detail: metaDetail(),
}));
check('prefs: NO label or caption in NOTIFICATION_META promises an undeliverable alert', () => {
  if (!meta) return { ok: false, detail: metaDetail() };
  const offenders = [];
  for (const [type, entry] of Object.entries(meta)) {
    for (const field of ['label', 'caption']) {
      for (const v of promiseViolations(entry[field])) offenders.push(`${type}.${field}: ${v.id} ("${v.hit}")`);
    }
  }
  return { ok: offenders.length === 0, detail: `offenders=${JSON.stringify(offenders)}` };
});
check('prefs: the two OWN-DEVICE captions are intact and still truthful (invite nudge / missed week off by default)', () => ({
  ok:
    !!meta &&
    /nudge/i.test(meta.pending_invite.caption) &&
    /invite/i.test(meta.pending_invite.caption) &&
    /off until you turn it on/i.test(meta.missed_week.caption) &&
    meta.missed_week.label === 'Missed week',
  detail: meta ? JSON.stringify({ pending_invite: meta.pending_invite.caption, missed_week: meta.missed_week.caption }) : metaDetail(),
}));
check('prefs: the two cross-user rows say so positively (an empty or deleted caption is a FAIL, not a pass)', () => ({
  ok:
    !!meta &&
    /not sending yet/i.test(meta.partner_logged.caption) &&
    /not sending yet/i.test(meta.invite_accepted.caption) &&
    meta.partner_logged.label === 'Partner logged' &&
    meta.invite_accepted.label === 'Invite accepted',
  detail: metaDetail(),
}));

// ---------------------------------------------------------------------------
// C: the whole src/ tree — the claim cannot come back in code OR in a comment
// ---------------------------------------------------------------------------
function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const srcFiles = walkSourceFiles(SRC);
const srcHits = [];
for (const file of srcFiles) {
  const sweep = sweepSource(fs.readFileSync(file, 'utf8'));
  for (const v of sweep.promises) srcHits.push(`${path.relative(ROOT, file)}: ${v.id} ("${v.hit}")`);
}
check('src sweep: no .ts/.tsx under src/ contains a retired push-promise phrasing', () => ({
  ok: srcHits.length === 0,
  detail: `files=${srcFiles.length} hits=${JSON.stringify(srcHits)}`,
}));

const sheetSource = fs.existsSync(SHEET_SRC) ? fs.readFileSync(SHEET_SRC, 'utf8') : '';
const sheetSourceSweep = sweepSource(sheetSource);
check('src sweep: the sheet source (doc comment included) is clean — the retired sentence cannot return as a comment', () => ({
  ok: sheetSourceSweep.promises.length === 0 && /never send in a real build|no_device/i.test(sheetSource),
  detail: `hits=${JSON.stringify(sheetSourceSweep.promises.map((v) => v.id))} documentsNoDevice=${/no_device/i.test(sheetSource)}`,
}));

const dispatchSource = fs.existsSync(DISPATCH_SRC) ? fs.readFileSync(DISPATCH_SRC, 'utf8') : '';
const dispatchSweep = sweepSource(dispatchSource);
check('pushDispatch: the false "the send still happens" comment is gone and the no_device cause is documented', () => ({
  ok:
    !dispatchSweep.staleDispatchClaim &&
    dispatchSweep.promises.length === 0 &&
    /expoPushToken: null/.test(dispatchSource) &&
    /own-row RLS/.test(dispatchSource) &&
    /never (deliver|send)/i.test(dispatchSource),
  detail: `staleClaim=${dispatchSweep.staleDispatchClaim} promises=${JSON.stringify(dispatchSweep.promises.map((v) => v.id))} nullToken=${/expoPushToken: null/.test(dispatchSource)}`,
}));

const profileSource = fs.existsSync(PROFILE_SRC) ? fs.readFileSync(PROFILE_SRC, 'utf8') : '';
check('ProfileScreen: the notifications footer no longer says the switches start off (3 of 4 default ON)', () => ({
  ok: /You can change these anytime\. Missed week starts off\./.test(profileSource) && !/Off until you turn them on/.test(profileSource),
  detail: `hasNew=${/You can change these anytime/.test(profileSource)} hasOld=${/Off until you turn them on/.test(profileSource)}`,
}));

// ---------------------------------------------------------------------------
// D: NEGATIVE CONTROL — the same analyser must FAIL the retired copy
// ---------------------------------------------------------------------------
const retiredSheet = analyseCopy([RETIRED.sheetBody('Alex')], [SHEET_BODY('Alex')]);
check('negative control: the SAME analyser rejects the retired sheet sentence (know-when-logs + invite-is-accepted)', () => {
  const ids = retiredSheet.violations.map((v) => v.id);
  return {
    ok:
      !retiredSheet.ok &&
      ids.some((id) => /know when/.test(id)) &&
      ids.some((id) => /invite is accepted/.test(id)) &&
      retiredSheet.missing.length === 1,
    detail: `violations=${JSON.stringify(ids)} missingBody=${retiredSheet.missing.length}`,
  };
});
const retiredCaptions = analyseCopy(
  [RETIRED.captions.invite_accepted, RETIRED.captions.partner_logged],
  [CROSS_USER_CAPTION],
);
check('negative control: the SAME analyser rejects the retired captions (partner logs / pairs up) and the caption sentence gate', () => {
  const ids = retiredCaptions.violations.map((v) => v.id);
  return {
    ok:
      !retiredCaptions.ok &&
      ids.some((id) => /partner logs/.test(id)) &&
      ids.some((id) => /pairs up/.test(id)) &&
      retiredCaptions.missing.length === 1,
    detail: `violations=${JSON.stringify(ids)} missing=${JSON.stringify(retiredCaptions.missing)}`,
  };
});
const retiredSweep = sweepSource(RETIRED.sourceSample);
check('negative control: the same static sweep finds the retired claims in the pre-fix source text', () => ({
  ok: retiredSweep.promises.length >= 3 && retiredSweep.staleDispatchClaim,
  detail: `violations=${JSON.stringify(retiredSweep.promises.map((v) => v.id))} staleClaim=${retiredSweep.staleDispatchClaim}`,
}));

// ---------------------------------------------------------------------------
// run the table — one line per check, always, even if a check throws
// ---------------------------------------------------------------------------
for (const item of checks) {
  let result;
  try {
    result = item.run();
  } catch (error) {
    result = { ok: false, detail: `${error.name}: ${error.message}` };
  }
  report(item.name, !!result.ok, result.detail);
}

if (checks.length !== FIXED_CHECKS) {
  report(`guard emitted its fixed ${FIXED_CHECKS} checks`, false, `emitted ${checks.length}`);
} else {
  report(`guard emitted its fixed ${FIXED_CHECKS} checks`, true, `${checks.length} checks`);
}
console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
