#!/usr/bin/env node
/*
 * jsx-escape-guard — the gate for the class of defect the lead found by
 * EXECUTION on 2026-10-05, and the regression pin for the five sites that
 * shipped it inside build 30 (the binary attached to App Store version 1.0).
 *
 * THE DEFECT
 * A `\uXXXX` escape written where escapes are NOT processed — JSX TEXT, or a
 * BARE JSX ATTRIBUTE (`attr="..."`) — is not an escape. It is eleven ordinary
 * characters, and the user reads the backslash:
 *
 *     <Text>You\u2019ll see</Text>   renders   You\u2019ll see
 *     <Button label="How\u2019d it go?" />    renders   How\u2019d it go?
 *
 * The SAME escape inside a real JS string ('You\u2019re in'), a template
 * literal (`Join ${n}\u2019s group`) or a JSX EXPRESSION attribute
 * (label={'...'} / label={`...`}) IS processed, and every one of those in this
 * repo is correct. Build 30 shipped five broken sites: four on the join screen
 * (`src/features/invites/EnterCodeScreen.tsx`, JSX text + one bare attribute)
 * and the log sheet's caption placeholder (`src/features/logging/LogSheet.tsx`).
 *
 * WHY A SOURCE GREP CANNOT BE THE CHECK (the trap this guard exists for)
 * `src/` carries 41 occurrences of `\u2019`. A grep for the escape cannot tell a
 * broken one from a correct one — they are the same eleven characters in the
 * source. That is exactly how an earlier audit concluded "no leaked escape"
 * while five of them were on screen and inside the submitted binary. So the
 * PRIMARY check here is not a grep of the .tsx source: this guard compiles the
 * JSX with the repo's own TypeScript (`jsx: React`) and inspects the EMITTED
 * JavaScript, where the two cases have provably different shapes:
 *
 *     correct : 'You\u2019re in.'          -> ONE backslash (a live escape)
 *     broken  : "You\\u2019ll see"         -> TWO backslashes (an escaped
 *               backslash), i.e. the runtime string literally contains the six
 *               characters \ u 2 0 1 9 and the screen shows them.
 *
 * The emitted shape is pinned on a control probe BEFORE any file in `src/` is
 * judged, in-process (checks 1-2) and through the real `tsc --jsx react` CLI
 * byte-for-byte (check 5). Only then is the tree scanned (check 6). The AST walk
 * that names the file:line sites is a SECOND, independent pass over the same
 * files; the two must agree count-for-count (check 7), so a site the walk cannot
 * see is still a FAIL rather than a silent pass.
 *
 * IT MUST BE ABLE TO FAIL (a guard that passes on the broken tree proves nothing)
 * Check 3 feeds this same detector the verbatim pre-fix source of the five
 * sites that shipped in build 30 and requires it to name them — 7 escapes on 5
 * lines, the exact line:count map, and 7 literal escapes in the emitted JS.
 * Check 4 runs the opposite direction on the same text with only the escapes
 * replaced by the real characters: the guard must stay silent on the fix it
 * asks for. Checks 1-2 do the same thing on a synthetic probe: the identical
 * character sequence inside a JS string / template literal / JSX expression
 * attribute must NOT be flagged. Those four controls are why a green run below
 * says something; to watch the whole guard fail on the defect, run it against
 * the pre-fix tree (stash the fix) and read the offender list — it names every
 * site as `path:line:col [jsx-text|jsx-attr-literal]`. The pre-fix run is on
 * disk: /home/team/shared/jsx-escape-prefix-failure-2026-10-05.log.
 *
 * WHAT IT DOES NOT COVER (stated so nobody reads more into a green run)
 *   • `.ts` files: JSX text cannot exist in them, and an escape in a `.ts`
 *     string is processed. The file set is every `.tsx`/`.jsx` under `src/`.
 *   • Escape families other than the 4-hex `\uXXXX` form (e.g. ES6's braced
 *     `\u{1F600}`, which is not legal in JSX text either but has never appeared
 *     here).
 *   • It does not RENDER anything: it gates how an escape is treated, not the
 *     pixels. There is no simulator on this box; screen-level checks are
 *     TestFlight. A correct escape that reaches a text node by some other route
 *     is outside this guard.
 *   • It reads no generated artifact and writes outside its own temp dir: the
 *     JSX is compiled from the current source in this run, so there is nothing
 *     stale to be fresh about (see compile-freshness-guard).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// Every PASS/FAIL line this guard prints, pinned: a guard whose checks can
// silently shrink is not a gate (run_smoke.py pins these counts for the guards
// it spawns; this one is pinned in-process as well, last check).
const PINNED_CHECKS = 11;

// Non-vacuity floors for the sweep, deliberately below the tree as measured on
// 2026-10-05 (34 files, 1155 JSX text nodes, 288 bare string-literal
// attributes). If a refactor halves these, the sweep must complain rather than
// pass quietly.
const MIN_FILES = 30;
const MIN_JSX_TEXT_NODES = 1000;
const MIN_BARE_ATTRS = 250;

let TS;
try {
  TS = require('typescript');
} catch (error) {
  // Without the repo's own compiler the primary technique cannot run. Refuse
  // loudly instead of degrading to a source grep.
  console.error(
    `[jsx-escape-guard] cannot load the repo's typescript (${error.code || error.message}) — ` +
      'this guard will not fall back to a source-only check',
  );
  process.exit(2);
}

let passes = 0;
let fails = 0;
const resultLines = [];

function check(name, ok, detail) {
  resultLines.push(`  ${ok ? 'PASS' : 'FAIL'}  ${name} :: ${detail}`);
  if (ok) passes += 1;
  else fails += 1;
}

// ---------------------------------------------------------------------------
// The two escape shapes, and the scanner.
//
// ESCAPE_RE   — the 4-hex escape as it appears in SOURCE (one backslash + uXXXX).
// DOUBLED_RE  — the same sequence as it appears in EMITTED JavaScript after JSX
//               text/attribute stringification: TWO backslashes + uXXXX. This is
//               the fingerprint of the defect.
// ANY_RE      — one backslash + uXXXX. It matches a live escape, and it also
//               matches the second backslash of a doubled pair (once), so
//               `any - doubled` is the count of escapes the compiler processed.
// ---------------------------------------------------------------------------
const ESCAPE_RE = /\\u[0-9a-fA-F]{4}/g;
const DOUBLED_RE = /\\\\u[0-9a-fA-F]{4}/g;
const ANY_RE = /\\u[0-9a-fA-F]{4}/g;

function countMatches(text, source) {
  return (text.match(new RegExp(source, 'g')) || []).length;
}

/**
 * Walk a source text and return every `\uXXXX` that sits in JSX TEXT or in a
 * BARE JSX ATTRIBUTE (an attribute whose value is a plain string literal, i.e.
 * `label="..."` — NOT `label={'...'}` / `label={`...`}`, which are JSX
 * expressions and are processed).
 */
function scanSource(fileName, text) {
  const sf = TS.createSourceFile(fileName, text, TS.ScriptTarget.Latest, true, TS.ScriptKind.TSX);
  const sites = [];
  let jsxTextNodes = 0;
  let bareAttrLiterals = 0;

  const collect = (raw, kind, node) => {
    const base = node.getStart(sf);
    const re = new RegExp(ESCAPE_RE.source, 'g');
    let m;
    while ((m = re.exec(raw)) !== null) {
      const pos = sf.getLineAndCharacterOfPosition(base + m.index);
      sites.push({ line: pos.line + 1, col: pos.character + 1, kind, escape: m[0] });
    }
  };

  const visit = (node) => {
    if (TS.isJsxText(node)) {
      jsxTextNodes += 1;
      collect(node.getText(sf), 'jsx-text', node);
    } else if (TS.isJsxAttribute(node) && node.initializer && TS.isStringLiteral(node.initializer)) {
      bareAttrLiterals += 1;
      collect(node.initializer.getText(sf), 'jsx-attr-literal', node.initializer);
    }
    TS.forEachChild(node, visit);
  };
  visit(sf);
  return { sites, jsxTextNodes, bareAttrLiterals };
}

/** Compile one source text the way the app is built (jsx: React) and return the JS. */
function emitJsx(fileName, text) {
  return TS.transpileModule(text, {
    fileName,
    compilerOptions: {
      jsx: TS.JsxEmit.React,
      target: TS.ScriptTarget.ES2019,
      module: TS.ModuleKind.ESNext,
    },
  }).outputText;
}

/** The two counts that make the emitted JavaScript speak. */
function emittedEscapes(emitted) {
  const doubled = countMatches(emitted, DOUBLED_RE.source);
  const any = countMatches(emitted, ANY_RE.source);
  return { doubled, singles: any - doubled };
}

function discover() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(p);
      } else if (/\.(tsx|jsx)$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out.sort();
}

// ---------------------------------------------------------------------------
// The control probe. Same characters, six placements: three the compiler
// processes, three it does not. Nothing here is part of the app.
// ---------------------------------------------------------------------------
const PROBE_LINES = [
  'declare const T: any;', // 1
  'declare const React: any;', // 2
  'declare const n: string;', // 3
  "export const GOOD = 'You\\u2019re in.';", // 4  JS string        -> processed
  'export const TMPL = `Join ${n}\\u2019s group`;', // 5  template literal -> processed
  "export const EXPR = <T label={'How\\u2019d it go?'} />;", // 6  JSX expression   -> processed
  'export const BADTEXT = <T>You\\u2019ll see each other\\u2019s logs</T>;', // 7  JSX text  -> BROKEN
  'export const BADATTR = <T label="How\\u2019d it go?" />;', // 8  bare attr  -> BROKEN
  '',
];
const PROBE = PROBE_LINES.join('\n');
// Exactly what the detector must find in the probe: line 7 twice, line 8 once.
const PROBE_EXPECTED = [
  { line: 7, kind: 'jsx-text' },
  { line: 7, kind: 'jsx-text' },
  { line: 8, kind: 'jsx-attr-literal' },
];
// And exactly what it must not: the three processed placements on lines 4-6.
const PROBE_PROCESSED_LINES = [4, 5, 6];

// ---------------------------------------------------------------------------
// The pre-fix fixture: the verbatim source of the five sites that shipped in
// build 30, so this guard can be shown to catch the defect it was written for
// even after the fix lands. Line numbers are this fixture's own.
// ---------------------------------------------------------------------------
const PREFIX_LINES = [
  'declare const T: any;', // 1
  'declare const React: any;', // 2
  'export const Join = () => (', // 3
  '  <T>', // 4
  '    <T>Enter the code they shared. You\\u2019ll see each other\\u2019s photo-proof logs after you join.</T>', // 5  (2)
  '    <T label="Just look around — I\\u2019ll join later" />', // 6  (1)
  '    <T>Everyone in the group sees each other\\u2019s photo-proof logs. Your weekly ring counts only your workouts — theirs counts only theirs.</T>', // 7  (1)
  '    <T>Photos stay sealed per person — group members see each other\\u2019s, never anyone else\\u2019s.</T>', // 8  (2)
  '    <T placeholder="How\\u2019d it go?" />', // 9  (1)
  "    <T>{'You\\u2019re in.'}</T>", // 10 processed (JSX expression) -> must stay clean
  '  </T>', // 11
  ');', // 12
  '',
];
const PREFIX = PREFIX_LINES.join('\n');
const PREFIX_EXPECTED = new Map([
  [5, 2],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 1],
]);
// The fixed form of the SAME fixture, derived so that the only difference
// between the two texts is the fix itself: the raw escape replaced by the real
// character. Used as the false-positive control — the guard must not flag the
// fix it is asking for.
const RAW_ESCAPE = '\\u2019';
const REAL_APOSTROPHE = '\u2019';
const FIXED_FIXTURE = PREFIX.split(RAW_ESCAPE).join(REAL_APOSTROPHE);

// ---------------------------------------------------------------------------
// The five fixed sites, pinned by content. If a later edit reintroduces the
// escape, or drops the apostrophe while "tidying", this fails by name.
// ---------------------------------------------------------------------------
const FIXED_SITES = [
  {
    file: 'src/features/invites/EnterCodeScreen.tsx',
    need: 'Enter the code they shared. You\u2019ll see each other\u2019s photo-proof logs after you join.',
  },
  {
    file: 'src/features/invites/EnterCodeScreen.tsx',
    need: 'label="Just look around — I\u2019ll join later"',
  },
  {
    file: 'src/features/invites/EnterCodeScreen.tsx',
    need:
      'Everyone in the group sees each other\u2019s photo-proof logs. Your weekly ring counts only your workouts — theirs counts only theirs.',
  },
  {
    file: 'src/features/invites/EnterCodeScreen.tsx',
    need: 'Photos stay sealed per person — group members see each other\u2019s, never anyone else\u2019s.',
  },
  {
    file: 'src/features/logging/LogSheet.tsx',
    need: 'placeholder="How\u2019d it go?"',
  },
];

// ---------------------------------------------------------------------------

const byLine = (sites) => {
  const m = new Map();
  for (const s of sites) m.set(s.line, (m.get(s.line) || 0) + 1);
  return m;
};
const describe = (sites) =>
  sites.map((s) => `line ${s.line}:${s.col} [${s.kind}] ${s.escape}`).join(', ');

function run() {
  // ---- 1-2. control: the detector fires on JSX text / bare attribute, and does
  //          not fire on the three placements that ARE processed.
  const probeSites = scanSource('probe.tsx', PROBE).sites;
  const probeShape = probeSites.map((s) => ({ line: s.line, kind: s.kind }));
  check(
    'control.broken — a raw \\uXXXX in JSX text and in a bare JSX attribute IS flagged (probe lines 7, 8)',
    JSON.stringify(probeShape) === JSON.stringify(PROBE_EXPECTED),
    `found ${probeSites.length}: ${describe(probeSites) || '(none)'}`,
  );
  const probeEmit = emittedEscapes(emitJsx('probe.tsx', PROBE));
  check(
    'control.distinction — the same escape in a JS string, a template literal and a JSX expression attribute is NOT flagged (probe lines 4-6)',
    probeSites.every((s) => !PROBE_PROCESSED_LINES.includes(s.line)) &&
      probeEmit.doubled === 3 &&
      probeEmit.singles === 3,
    `flagged lines ${[...new Set(probeSites.map((s) => s.line))].join(',')} | emitted: ` +
      `${probeEmit.doubled} literal (broken) vs ${probeEmit.singles} processed (correct)`,
  );

  // ---- 3. control: the defect as it SHIPPED. Verbatim build-30 source of the
  //          five broken sites, through the same detector, must be named.
  const preSites = scanSource('build30-prefix.tsx', PREFIX).sites;
  const preMap = byLine(preSites);
  const preEmit = emittedEscapes(emitJsx('build30-prefix.tsx', PREFIX));
  const preOk =
    preSites.length === 7 &&
    preEmit.doubled === 7 &&
    preMap.size === PREFIX_EXPECTED.size &&
    [...PREFIX_EXPECTED].every(([line, n]) => preMap.get(line) === n);
  check(
    'control.prefix — the verbatim pre-fix source of the five sites that shipped in build 30 IS flagged (7 escapes on 5 lines, 7 literal escapes in the emitted JS)',
    preOk,
    preOk
      ? `${preSites.length} escapes on ${preMap.size} lines: ${[...preMap].map(([l, n]) => `${l}x${n}`).join(', ')}; emitted literal=${preEmit.doubled}`
      : `expected 7 escapes as 5x2|1|1|2|1 with 7 literal in the emitted JS; found ${preSites.length} escape(s) ` +
          `on ${preMap.size} line(s) (${describe(preSites) || '(none)'}), emitted literal=${preEmit.doubled}`,
  );

  // ---- 4. the other direction, on the same text: with the raw escape replaced
  //          by the real character — the fix this guard asks for — the detector
  //          must stay SILENT on both passes. (A guard that flags its own fix is
  //          worse than none.)
  const fixedSites = scanSource('fixed-fixture.tsx', FIXED_FIXTURE).sites;
  const fixedEmit = emittedEscapes(emitJsx('fixed-fixture.tsx', FIXED_FIXTURE));
  check(
    'control.fixed — the same five sites with the real apostrophe produce ZERO sites and ZERO literal escapes (the guard does not flag the fix)',
    fixedSites.length === 0 && fixedEmit.doubled === 0,
    `sites=${fixedSites.length}${fixedSites.length ? ` (${describe(fixedSites)})` : ''} emitted literal=${fixedEmit.doubled}`,
  );

  // ---- 5. the technique itself, through the tool the lead proved it with: the
  //          real `tsc --jsx react` must emit the same bytes as the in-process
  //          printer this guard scans with. (A mismatch would mean the guard is
  //          judging a shape the app's build does not produce.)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jsx-escape-guard-'));
  let parity = { ok: false, detail: 'not attempted' };
  try {
    const probePath = path.join(scratch, 'probe.tsx');
    const outDir = path.join(scratch, 'out');
    fs.writeFileSync(probePath, PROBE);
    const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const runCli = spawnSync(
      process.execPath,
      [tscBin, '--jsx', 'react', '--target', 'es2019', '--module', 'esnext', '--outDir', outDir, probePath],
      { cwd: scratch, encoding: 'utf8' },
    );
    const emittedPath = path.join(outDir, 'probe.js');
    if (!fs.existsSync(emittedPath)) {
      parity = {
        ok: false,
        detail: `tsc emitted nothing (exit=${runCli.status}) :: ${(runCli.stdout || '').split('\n')[0]}`,
      };
    } else {
      const cliText = fs.readFileSync(emittedPath, 'utf8');
      const apiText = emitJsx('probe.tsx', PROBE);
      const cliEsc = emittedEscapes(cliText);
      const byteEqual = cliText === apiText;
      parity = {
        ok: byteEqual && cliEsc.doubled === 3,
        detail:
          `tsc ${TS.version} exit=${runCli.status} byte-identical=${byteEqual} ` +
          `cli literal/processed=${cliEsc.doubled}/${cliEsc.singles}`,
      };
    }
  } catch (error) {
    parity = { ok: false, detail: `${error.name}: ${error.message}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  check(
    'technique.parity — the repo\'s own `tsc --jsx react` emits byte-identical JavaScript to the in-process printer this guard scans with',
    parity.ok,
    parity.detail,
  );

  // ---- 6-8. the tree.
  const files = discover();
  const offenders = [];
  const disagreements = [];
  let jsxTextNodes = 0;
  let bareAttrLiterals = 0;
  let totalProcessed = 0;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const text = fs.readFileSync(abs, 'utf8');
    const { sites, jsxTextNodes: textNodes, bareAttrLiterals: attrs } = scanSource(abs, text);
    jsxTextNodes += textNodes;
    bareAttrLiterals += attrs;
    const emit = emittedEscapes(emitJsx(rel, text));
    totalProcessed += emit.singles;
    for (const s of sites) offenders.push(`${rel}:${s.line}:${s.col} [${s.kind}]`);
    if (emit.doubled !== sites.length) {
      disagreements.push(
        `${rel}: ${emit.doubled} literal escape(s) in the emitted JS vs ${sites.length} site(s) found by the AST walk`,
      );
    }
  }

  check(
    'tree.clean — no raw \\uXXXX sits in JSX text or a bare JSX attribute anywhere under src/',
    offenders.length === 0,
    offenders.length === 0
      ? `${files.length} file(s) scanned; 0 literal escape(s) in the emitted JS; ${totalProcessed} single-backslash ` +
          'escape(s) in the emitted JS (all processed at runtime — this count also includes the escapes the printer ' +
          'generates for non-ASCII characters such as — and ’)'
      : `${offenders.length} offender(s): ${offenders.join(' | ')}`,
  );
  check(
    'tree.emit-agreement — per file, the emitted JavaScript carries exactly as many literal escapes as the AST walk found (a site the walk cannot see is still a failure)',
    disagreements.length === 0,
    disagreements.length === 0
      ? 'AST walk and emitted JavaScript agree on every file'
      : disagreements.join(' | ') +
          ' — if no offender is listed above, the doubling came from outside JSX: a real JS string written with a doubled backslash, which also renders the backslash on screen',
  );
  check(
    'tree.coverage — every .tsx/.jsx under src/ was scanned, and the scan is non-vacuous',
    files.length >= MIN_FILES &&
      jsxTextNodes >= MIN_JSX_TEXT_NODES &&
      bareAttrLiterals >= MIN_BARE_ATTRS &&
      files.some((f) => f.endsWith('EnterCodeScreen.tsx')) &&
      files.some((f) => f.endsWith('LogSheet.tsx')),
    `${files.length} file(s) (floor ${MIN_FILES}), ${jsxTextNodes} JSX text node(s) (floor ${MIN_JSX_TEXT_NODES}), ` +
      `${bareAttrLiterals} bare attribute literal(s) (floor ${MIN_BARE_ATTRS})`,
  );

  // ---- 9. the five sites are FIXED, pinned by content.
  const missing = [];
  for (const site of FIXED_SITES) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(ROOT, site.file), 'utf8');
    } catch (error) {
      missing.push(`${site.file} unreadable`);
      continue;
    }
    if (!text.includes(site.need)) missing.push(`${site.file} :: ${JSON.stringify(site.need.slice(0, 48))}`);
  }
  check(
    'sites.fixed — the five formerly-broken sites render the real apostrophe (pinned by content)',
    missing.length === 0,
    missing.length === 0 ? `${FIXED_SITES.length} site(s) pinned` : `missing: ${missing.join(' | ')}`,
  );
}

// ---------------------------------------------------------------------------
let harnessError = null;
try {
  run();
} catch (error) {
  harnessError = error;
}
check(
  'harness: the guard ran to completion',
  harnessError === null,
  harnessError === null ? 'no exception' : `${harnessError.name}: ${harnessError.message}`,
);
// The pinned-count self-check runs last and includes itself in the tally, so a
// check that stops running fails here instead of disappearing.
check(
  `guard.pinned — exactly ${PINNED_CHECKS} checks ran`,
  passes + fails + 1 === PINNED_CHECKS,
  `${passes + fails + 1} of ${PINNED_CHECKS} (a lost check is a failure, not a quieter summary)`,
);

for (const line of resultLines) console.log(line);
console.log(`[jsx-escape-guard] ${passes} PASS / ${fails} FAIL (pinned=${PINNED_CHECKS})`);
process.exit(fails === 0 ? 0 : 1);
