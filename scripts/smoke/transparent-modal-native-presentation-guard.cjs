#!/usr/bin/env node
/*
 * transparent-modal-native-presentation-guard — the offline check that a
 * transparent <Modal> is never DISMISSED on the same tick as a NATIVE
 * presentation (Share.share / requestNotificationPermission / Alert.alert).
 *
 * WHY IT EXISTS — the owner's build-29 freeze (found 2026-09-27).
 *   The owner: signed up 00:20:59Z, reached Home, tapped "Start a group" →
 *   "Send the code" (pair_action share_tapped 00:22:15Z), dismissed the iOS
 *   share sheet — and then EVERY control on the screen was dead (✕, "Start a
 *   group", camera, home, profile). Their screenshot shows Home rendered
 *   normally with NO dimming, and the session wrote ZERO app_diagnostics rows,
 *   so no JS fault was thrown. InviteSheet.tsx is a `transparent` <Modal> whose
 *   share handler was:
 *
 *       await Share.share({ message: inviteMessageTemplate(invite.displayCode) });
 *       onClose();                                  // <- same resolution tick
 *
 *   React state is correct (inviteOpen -> false) — which is precisely why an
 *   element-tree assertion passes and why there is no diagnostics row. The
 *   defect is a NATIVE/OS presentation race, not a React state defect: iOS is
 *   still tearing the share sheet down while the modal's native presentation
 *   unmounts, and the leftover invisible full-screen layer swallows touches.
 *   NotificationsSheet.tsx has the same shape around the OS notification
 *   permission dialog (no device evidence for it yet — same class, same fix).
 *
 * WHAT IT ASSERTS (one PASS/FAIL line per check, fixed count = 9):
 *   C1  the fix: InviteSheet's `share` handler no longer dismisses on the share
 *       tick — its close call is reachable only through a deferral.
 *   C2  the same fix in NotificationsSheet's `enable` handler.
 *   C3  the invariant swept over ALL of src/: no handler anywhere calls a
 *       native presentation and a close in the same synchronous block.
 *   C4  each fixed handler defers through BOTH
 *       `InteractionManager.runAfterInteractions` AND a bounded `setTimeout`
 *       fallback — a queue that never empties must not strand the sheet open.
 *   C5  the catch path still LEAVES THE SHEET OPEN (a throw must not close it —
 *       "no dead end" in both directions).
 *   C6  ✕ and scrim dismissal are still wired in both sheets (never stuck).
 *   N1  NEGATIVE CONTROL: the analyser is run over the EXACT pre-fix handler
 *       text taken from the build-29 commit (1ad8c3f, blob 91c6ada...) and MUST
 *       report the `Share.share` + `onClose()` violation.
 *   N2  NEGATIVE CONTROL: same for the pre-fix NotificationsSheet handler.
 *   N3  NEGATIVE CONTROL: a deferral-shaped sample must NOT be flagged, and a
 *       handler that closes without any native presentation must NOT be flagged
 *       (so a green run means the rules, not "this file mentions Share").
 *   S1  the guard emitted its fixed number of checks.
 *   A gate that passes on the broken tree proves nothing: N1/N2 are why this
 *   file ships with its fix rather than after it.
 *
 * WHAT "SAME TICK" MEANS (the operational definition, so this is not vibes):
 *   the SYNCHRONOUS continuation region of a function — its body with NESTED
 *   function-likes REMOVED. `await Share.share(...); onClose();` leaves both in
 *   one run-to-completion step: violation. `runAfterInteractions(() =>
 *   onClose())` or `setTimeout(onClose, N)` reaches the close through a deferral
 *   wrapper: not a violation. A close call also counts as deferred when it sits
 *   inside a locally-defined function that is PASSED to a deferral wrapper (the
 *   shipped shape: `closeOnce` handed to both wrappers).
 *
 * NOT COVERED (so a green run is not read as more than it is): this is SOURCE
 * STRUCTURE, not a device. Nothing here proves the freeze is gone on hardware —
 * only the owner's on-device walk of the next build can, and the PR says so. It
 * does not police Modal usage in general, only this ordering.
 *
 * RUN:  node scripts/smoke/transparent-modal-native-presentation-guard.cjs
 * EXIT: 0 = every check passed, 1 = at least one FAIL (never read through a pipe)
 * WIRED: standalone gate. It is deliberately NOT wired into
 *        scripts/real-mode-smoke/run_smoke.py — that file is untouched by this
 *        change, and adding a pinned guard count there is a separate review.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const INVITE_SHEET = path.join(SRC, 'features', 'invites', 'InviteSheet.tsx');
const NOTIF_SHEET = path.join(SRC, 'features', 'invites', 'NotificationsSheet.tsx');

// The native presentations. Each one puts an OS-owned full-screen layer on top
// of the app and resolves on the RUN LOOP, not on the JS tick that started it.
const NATIVE_PRESENTATION_CALLS = new Set([
  'Share.share',
  'requestNotificationPermission',
  'Alert.alert',
]);
// Calls that exist to dismiss the surface they live in.
const CLOSE_CALL_NAMES = new Set([
  'onClose',
  'onDone',
  'onDismiss',
  'close',
  'dismiss',
  'hide',
  'hideSheet',
  'setVisible',
  'setOpen',
  'setInviteOpen',
  'setSheetOpen',
]);
// Wrappers that push work past the interaction/presentation queue.
const DEFERRAL_WRAPPERS = ['runAfterInteractions', 'setTimeout', 'requestAnimationFrame', 'setInterval'];

const FIXED_CHECKS = 9;

// ---------------------------------------------------------------------------
// reporter — one line per check, always, whatever happens
// ---------------------------------------------------------------------------
let passes = 0;
let fails = 0;
function oneLine(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s*\n\s*/g, ' | ')
    .slice(0, 700);
}
function report(name, ok, detail) {
  if (ok) passes += 1;
  else fails += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${oneLine(detail)}` : ''}`);
}
function at(sf, node) {
  const p = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${path.relative(ROOT, sf.fileName)}:${p.line + 1}:${p.character + 1}`;
}

// ---------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------
function walk(node, fn) {
  fn(node);
  node.forEachChild((child) => walk(child, fn));
}
function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}
function calleeText(node, sf) {
  if (!ts.isCallExpression(node)) return null;
  return node.expression.getText(sf);
}
function nativePresentationOf(node, sf) {
  const text = calleeText(node, sf);
  return text && NATIVE_PRESENTATION_CALLS.has(text) ? text : null;
}
function closeNameOf(node, sf) {
  const text = calleeText(node, sf);
  if (!text || !ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression) && CLOSE_CALL_NAMES.has(text)) return text;
  if (text.startsWith('this.') && CLOSE_CALL_NAMES.has(text.slice(5))) return text;
  return null;
}
/**
 * The synchronous continuation region of a function: every node inside it that
 * is NOT inside a nested function-like. This is the set of statements that run
 * in ONE run-to-completion step after an awaited native call resolves.
 */
function syncRegion(fn) {
  const out = [];
  const body = fn.body;
  if (!body) return out;
  const visit = (node) => {
    if (isFunctionLike(node)) return; // a callback defers: its body is another step
    out.push(node);
    node.forEachChild(visit);
  };
  if (ts.isBlock(body)) body.forEachChild(visit);
  else visit(body); // arrow with an expression body
  return out;
}
/** Function nodes reached from a deferral wrapper inside `fn` (directly or by name). */
function deferredReceivers(fn, sf) {
  const localFns = new Map();
  walk(fn, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      localFns.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) localFns.set(node.name.text, node);
  });
  const receivers = new Set();
  walk(fn, (node) => {
    if (!ts.isCallExpression(node)) return;
    const text = node.expression.getText(sf);
    if (!DEFERRAL_WRAPPERS.some((w) => text === w || text.endsWith(`.${w}`))) return;
    for (const arg of node.arguments) {
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) receivers.add(arg);
      else if (ts.isIdentifier(arg) && localFns.has(arg.text)) receivers.add(localFns.get(arg.text));
    }
  });
  return receivers;
}
/** The name a reader would use: `const share = async () => {}` is called `share`. */
function functionName(node, sf) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.name && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (parent && ts.isJsxExpression(parent)) return '(jsx-handler)';
  return '(anonymous)';
}
function ancestorsWithin(node, fn) {
  const out = [];
  let parent = node.parent;
  while (parent && parent !== fn) {
    out.push(parent);
    parent = parent.parent;
  }
  return out;
}
function insideCatch(node, fn) {
  for (const ancestor of ancestorsWithin(node, fn)) {
    if (ts.isCatchClause(ancestor)) return true;
  }
  return false;
}
/** Does this file render a `<Modal ... transparent ...>`? */
function rendersTransparentModal(sf) {
  let found = false;
  walk(sf, (node) => {
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    if (node.tagName.getText(sf) !== 'Modal') return;
    const hasTransparent = node.attributes.properties.some(
      (attr) => ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'transparent',
    );
    if (hasTransparent) found = true;
  });
  return found;
}
/**
 * JSX `onPress` / `onRequestClose` attributes that reach `prop` — directly
 * (`onPress={onClose}`) or through a one-line arrow (`() => void notNow()`),
 * which is how the sheets actually wire ✕ and the scrim.
 */
function jsxHandlers(sf, prop) {
  const out = [];
  walk(sf, (node) => {
    if (!ts.isJsxAttribute(node)) return;
    const attrName = node.name.getText(sf);
    if (attrName !== 'onPress' && attrName !== 'onRequestClose') return;
    const init = node.initializer;
    if (!init || !ts.isJsxExpression(init) || !init.expression) return;
    const text = init.expression.getText(sf);
    if (text === prop || new RegExp(`\\b${prop}\\b`).test(text)) {
      out.push({ name: attrName, where: at(sf, node), expr: text });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// the analyser — one function-node at a time, on any source text
// ---------------------------------------------------------------------------
function analyseSource(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const result = {
    fileName,
    surface: rendersTransparentModal(sf),
    handlers: [], // one entry per function-like that mentions a native presentation
    violations: [],
  };
  walk(sf, (node) => {
    if (!isFunctionLike(node)) return;
    const region = syncRegion(node);
    const natives = region.filter((n) => ts.isCallExpression(n) && nativePresentationOf(n, sf));
    if (natives.length === 0) return;
    const regionCloses = region.filter((n) => ts.isCallExpression(n) && closeNameOf(n, sf));
    const receivers = deferredReceivers(node, sf);
    const allCloses = [];
    walk(node, (n) => {
      if (ts.isCallExpression(n) && closeNameOf(n, sf)) allCloses.push(n);
    });
    const deferredCloses = allCloses.filter((n) =>
      ancestorsWithin(n, node).some((ancestor) => receivers.has(ancestor)),
    );
    const text_ = node.getText(sf);
    const entry = {
      file: fileName,
      where: at(sf, node),
      natives: natives.map((n) => ({ call: nativePresentationOf(n, sf), at: at(sf, n) })),
      regionCloses: regionCloses.map((n) => ({ call: closeNameOf(n, sf), at: at(sf, n) })),
      deferredCloses: deferredCloses.map((n) => ({ call: closeNameOf(n, sf), at: at(sf, n), inCatch: insideCatch(n, node) })),
      hasRunAfterInteractions: /\brunAfterInteractions\s*\(/.test(text_),
      hasSetTimeout: /\bsetTimeout\s*\(/.test(text_),
      catchCloses: allCloses
        .filter((n) => insideCatch(n, node))
        .map((n) => ({ call: closeNameOf(n, sf), at: at(sf, n) })),
      name: functionName(node, sf),
    };
    entry.where = at(sf, node);
    result.handlers.push(entry);
    if (entry.regionCloses.length > 0) {
      result.violations.push({
        file: fileName,
        handler: entry.name,
        where: entry.where,
        natives: entry.natives,
        closes: entry.regionCloses,
      });
    }
  });
  return result;
}

function listSourceFiles(dir) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(item.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the EXACT pre-fix text, for the negative controls (build-29 commit 1ad8c3f,
// blob 91c6ada07cb64aa8bad49d15e1e0a5361d380b3a — do not tidy it)
// ---------------------------------------------------------------------------
const PRE_FIX_INVITE_SHEET = `
import React from 'react';
import { Modal, Pressable, Share, StyleSheet, Text, View } from 'react-native';
export function InviteSheet({ visible, onClose, invite }: any) {
  const share = async () => {
    if (!invite?.displayCode) return;
    try {
      // V1.1: share_tapped (intent — fires before the OS sheet resolves).
      void track('pair_action', { action: 'share_tapped' });
      await Share.share({ message: inviteMessageTemplate(invite.displayCode) });
      onClose();
    } catch {
      // Sheet dismissed — stay open; no dead end.
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} />
    </Modal>
  );
}
`;
const PRE_FIX_NOTIFICATIONS_SHEET = `
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
export function NotificationsSheet({ visible, onDone }: any) {
  const close = (enabled: boolean) => {
    onDone(enabled);
  };
  const enable = async () => {
    await markNotificationExplained();
    const granted = await requestNotificationPermission();
    await refreshPushRegistrationIfGranted();
    close(granted === 'granted');
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => void notNow()}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => void notNow()} />
    </Modal>
  );
}
`;
// A deferral-shaped handler: both wrappers, close only reachable through them.
const DEFERRED_SAMPLE = `
import React from 'react';
import { InteractionManager, Modal, Pressable, Share } from 'react-native';
export function Sheet({ visible, onClose, invite }: any) {
  const share = async () => {
    try {
      await Share.share({ message: 'x' });
      const closeOnce = () => { onClose(); };
      InteractionManager.runAfterInteractions(closeOnce);
      setTimeout(closeOnce, 600);
    } catch {}
  };
  return <Modal visible={visible} transparent><Pressable onPress={onClose} /></Modal>;
}
`;
// A handler that closes with NO native presentation at all — must not be flagged.
const NO_NATIVE_SAMPLE = `
import React from 'react';
import { Modal, Pressable } from 'react-native';
export function Sheet({ visible, onClose }: any) {
  const notNow = async () => {
    await dismissNotificationAsk();
    onClose();
  };
  return <Modal visible={visible} transparent><Pressable onPress={onClose} /></Modal>;
}
`;

// ---------------------------------------------------------------------------
// run the real src/ sweep once, and keep it for the assertions below
// ---------------------------------------------------------------------------
const files = listSourceFiles(SRC);
const analyses = files.map((f) => analyseSource(f, fs.readFileSync(f, 'utf8')));
const byFile = new Map(analyses.map((a) => [a.fileName, a]));
const invite = byFile.get(INVITE_SHEET);
const notif = byFile.get(NOTIF_SHEET);
const surfaces = analyses.filter((a) => a.surface).map((a) => path.relative(ROOT, a.fileName));
const allViolations = analyses.flatMap((a) => a.violations);
function violationsIn(analysis) {
  return analysis ? analysis.violations : [];
}
function handlerNamed(analysis, name) {
  return analysis ? analysis.handlers.find((h) => h.name === name) : undefined;
}

const checks = [];
function check(name, run) {
  checks.push({ name, run });
}

check('C1 InviteSheet.tsx: the share handler no longer dismisses on the share-sheet tick', () => {
  if (!invite) return { ok: false, detail: 'InviteSheet.tsx not analysed' };
  const share = handlerNamed(invite, 'share');
  const v = violationsIn(invite);
  return {
    ok: !!share && v.length === 0 && invite.surface,
    detail: `surface=${invite.surface} nativeCalls=${share ? JSON.stringify(share.natives.map((n) => n.call)) : 'handler "share" not found'} sameTickCloseCalls=${JSON.stringify(v)}`,
  };
});

check('C2 NotificationsSheet.tsx: the enable handler no longer dismisses on the OS permission dialog tick', () => {
  if (!notif) return { ok: false, detail: 'NotificationsSheet.tsx not analysed' };
  const enable = handlerNamed(notif, 'enable');
  const v = violationsIn(notif);
  return {
    ok: !!enable && v.length === 0 && notif.surface,
    detail: `surface=${notif.surface} nativeCalls=${enable ? JSON.stringify(enable.natives.map((n) => n.call)) : 'handler "enable" not found'} sameTickCloseCalls=${JSON.stringify(v)}`,
  };
});

check('C3 the invariant across src/: no handler anywhere presents natively and closes on the same tick', () => {
  return {
    ok: allViolations.length === 0,
    detail: `scanned=${files.length} transparentModalSurfaces=${surfaces.length} violations=${JSON.stringify(allViolations)}`,
  };
});

check('C4 both fixed handlers defer via runAfterInteractions AND a bounded setTimeout fallback', () => {
  const parts = [];
  let ok = true;
  for (const [label, analysis, handlerName] of [
    ['InviteSheet.share', invite, 'share'],
    ['NotificationsSheet.enable', notif, 'enable'],
  ]) {
    const h = handlerNamed(analysis, handlerName);
    if (!h) {
      ok = false;
      parts.push(`${label}: handler not found`);
      continue;
    }
    const good = h.hasRunAfterInteractions && h.hasSetTimeout && h.deferredCloses.length > 0;
    if (!good) ok = false;
    parts.push(
      `${label}: runAfterInteractions=${h.hasRunAfterInteractions} setTimeout=${h.hasSetTimeout} deferredCloseCalls=${h.deferredCloses.length}`,
    );
  }
  return { ok, detail: parts.join(' | ') };
});

check('C5 a throw still leaves the sheet OPEN (no close call inside a catch clause)', () => {
  const bad = [];
  for (const analysis of [invite, notif]) {
    if (!analysis) continue;
    for (const h of analysis.handlers) {
      for (const c of h.catchCloses) bad.push(`${path.relative(ROOT, analysis.fileName)} ${h.name} ${c.call}@${c.at}`);
    }
  }
  return { ok: bad.length === 0, detail: `catchCloses=${JSON.stringify(bad)}` };
});

check('C6 ✕ and scrim dismissal are still wired in both sheets', () => {
  const inviteHandlers = jsxHandlers(
    ts.createSourceFile(INVITE_SHEET, fs.readFileSync(INVITE_SHEET, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    'onClose',
  );
  const notifHandlers = jsxHandlers(
    ts.createSourceFile(NOTIF_SHEET, fs.readFileSync(NOTIF_SHEET, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    'notNow',
  );
  const ok =
    inviteHandlers.filter((h) => h.name === 'onPress').length >= 2 &&
    inviteHandlers.some((h) => h.name === 'onRequestClose') &&
    notifHandlers.filter((h) => h.name === 'onPress').length >= 2 &&
    notifHandlers.some((h) => h.name === 'onRequestClose');
  return {
    ok,
    detail: `InviteSheet=${JSON.stringify(inviteHandlers.map((h) => h.name))} NotificationsSheet=${JSON.stringify(notifHandlers.map((h) => h.name))}`,
  };
});

check('N1 negative control: the analyser REPORTS the pre-fix InviteSheet handler (Share.share then onClose)', () => {
  const a = analyseSource('neg/pre-fix-InviteSheet.tsx', PRE_FIX_INVITE_SHEET);
  const v = a.violations[0];
  return {
    ok: a.violations.length === 1 && v && v.natives.some((n) => n.call === 'Share.share') && v.closes.some((c) => c.call === 'onClose'),
    detail: JSON.stringify(a.violations),
  };
});

check('N2 negative control: the analyser REPORTS the pre-fix NotificationsSheet handler (permission then close)', () => {
  const a = analyseSource('neg/pre-fix-NotificationsSheet.tsx', PRE_FIX_NOTIFICATIONS_SHEET);
  const v = a.violations[0];
  return {
    ok:
      a.violations.length === 1 &&
      v &&
      v.natives.some((n) => n.call === 'requestNotificationPermission') &&
      v.closes.some((c) => c.call === 'close'),
    detail: JSON.stringify(a.violations),
  };
});

check('N3 negative control: a deferral-shaped handler and a no-native handler are NOT flagged', () => {
  const deferred = analyseSource('neg/deferred.tsx', DEFERRED_SAMPLE);
  const noNative = analyseSource('neg/no-native.tsx', NO_NATIVE_SAMPLE);
  return {
    ok: deferred.violations.length === 0 && noNative.violations.length === 0,
    detail: `deferredViolations=${JSON.stringify(deferred.violations)} noNativeViolations=${JSON.stringify(noNative.violations)}`,
  };
});

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
  report(`S1 guard emitted its fixed ${FIXED_CHECKS} checks`, false, `emitted ${checks.length}`);
} else {
  report(`S1 guard emitted its fixed ${FIXED_CHECKS} checks`, true, `${checks.length} checks`);
}
console.log(`SUMMARY: ${passes} PASS / ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
