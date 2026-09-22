'use strict';
/**
 * SPOTTER native-module audit — STATIC, from the JS source.
 *
 * Answers two questions about the app's first-render require graph:
 *   (1) which native modules does the JS request, in which file:line, and does
 *       that request RUN AT MODULE SCOPE (i.e. during bundle evaluation of the
 *       module, which is the Metro require-guard fatal path on device)?
 *   (2) which MODULE-SCOPE expressions touch a native-backed API whose value can
 *       be null/undefined on the device (Paths / FileSystem / Constants /
 *       Device / Font / ...), which survives even when the module is registered?
 *
 * Input: the `report.evaluated` file list from the device-parity harness
 * (`scripts/device-parity/load.cjs` prints it as one `###RESULT### <json>` line,
 * or via `run.cjs`). We parse the app's own sources with the TypeScript compiler
 * API, so scope is the real AST scope, not a regex guess.
 *
 * Usage:
 *   node scripts/native-module-audit/audit.cjs /tmp/dp/*.out [--json]
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..', '..');

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/**
 * Text of a member-expression chain head, so compiled JS (which writes
 * `expo_modules_core_1.requireNativeModule(...)`, not the TS source form) is
 * matched too.
 */
function chainText(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return chainText(node.expression) + '.' + node.name.text;
  if (ts.isCallExpression(node)) return chainText(node.expression || node.callee) + '()';
  return '';
}

const REQUEST_NAMES = new Set(['requireNativeModule', 'requireOptionalNativeModule']);
const TURBO_LOOKUPS = new Set(['get', 'getEnforcing', 'getEnforcingIfSupported']);

/** Native-module request call shapes we care about (TS source AND compiled JS). */
function requestOf(node) {
  if (ts.isCallExpression(node)) {
    // NB: the callee lives on `.expression` (TS 5.x); `.callee` is a legacy alias
    // that is undefined on some node shapes — using it silently threw per file.
    const callee = node.expression || node.callee;
    const arg0 = node.arguments[0];
    const literal = arg0 && ts.isStringLiteralLike(arg0) ? arg0.text : null;
    if (ts.isIdentifier(callee)) {
      if (REQUEST_NAMES.has(callee.text)) return { kind: callee.text, name: literal };
      return null;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const prop = callee.name.text;
      const head = chainText(callee.expression);
      if (REQUEST_NAMES.has(prop)) return { kind: head + '.' + prop, name: literal };
      if (TURBO_LOOKUPS.has(prop) && /TurboModule/i.test(head)) {
        return { kind: head + '.' + prop, name: literal };
      }
      if (TURBO_LOOKUPS.has(prop) && literal && /turbo|native/i.test(prop)) {
        return { kind: head + '.' + prop, name: literal };
      }
      if (/NativeModules/.test(head)) {
        return { kind: head + '.' + prop, name: literal || prop };
      }
    }
    return null;
  }
  // `NativeModules.Foo` / `NativeModules['Foo']` read without a call (legacy modules)
  const target = ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node : null;
  if (target) {
    const head = chainText(target.expression);
    if (/(^|\.)NativeModules$/.test(head) || /NativeModules/.test(head)) {
      let name = null;
      if (ts.isPropertyAccessExpression(target)) name = target.name.text;
      else if (ts.isStringLiteralLike(target.argumentExpression)) name = target.argumentExpression.text;
      if (name) return { kind: head + '.<prop-read>', name };
    }
  }
  return null;
}

/** Native-backed APIs whose *value* (not existence) can be null on device. */
const VALUE_WATCH = /^(Paths|FileSystem|Constants|Device|Font|SplashScreen|Linking|Clipboard|Crypto|SecureStore|Notifications|Application|SystemUI|Image|NativeModulesProxy|Dimensions|Appearance|Insights)$/;

function scopeOf(node) {
  let n = node.parent;
  let innerFn = null;
  while (n) {
    if (ts.isClassStaticBlockDeclaration(n)) {
      return { scope: 'class-static-block', fn: null };
    }
    if (FUNCTION_LIKE.has(n.kind)) {
      if (!innerFn) innerFn = n;
    }
    if (ts.isSourceFile(n)) break;
    n = n.parent;
  }
  if (!innerFn) return { scope: 'MODULE', fn: null };
  // A function invoked immediately (IIFE) runs at module scope when the outer
  // function itself is module-scope.
  const p = innerFn.parent;
  if (p && ts.isParenthesizedExpression(p) && p.parent && ts.isCallExpression(p.parent) &&
      p.parent.expression === p) {
    return scopeOf(innerFn);
  }
  let name = '(anonymous)';
  if (innerFn.name && ts.isIdentifier(innerFn.name)) name = innerFn.name.text;
  else if (innerFn.parent && ts.isPropertyAssignment(innerFn.parent) &&
           ts.isIdentifier(innerFn.parent.name)) name = String(innerFn.parent.name.text);
  else if (innerFn.parent && ts.isVariableDeclaration(innerFn.parent) &&
           ts.isIdentifier(innerFn.parent.name)) name = String(innerFn.parent.name.text);
  return { scope: 'function', fn: name };
}

function fileOf(node) {
  let n = node;
  while (n && !ts.isSourceFile(n)) n = n.parent;
  return n ? n.fileName : '(unknown)';
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Is this node inside the *try* block of a try/catch (i.e. a throw is caught)? */
function inTry(node) {
  let prev = node;
  let n = node.parent;
  while (n) {
    if (ts.isTryStatement(n)) {
      if (n.tryBlock === prev) return true;
    }
    if (ts.isSourceFile(n)) break;
    prev = n;
    n = n.parent;
  }
  return false;
}

function analyse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const requests = [];
  const valueUses = [];
  const visit = (node) => {
    const req = requestOf(node);
    if (req) {
      const s = scopeOf(node);
      requests.push({
        name: req.name,
        kind: req.kind,
        file: path.relative(ROOT, file),
        line: lineOf(sf, node),
        scope: s.scope === 'MODULE' ? 'MODULE' : s.scope + ':' + s.fn,
        try: inTry(node),
        text: text.split('\n')[lineOf(sf, node) - 1].trim().slice(0, 140),
      });
    }
    // module-scope member access on a native-backed value. Matches both the TS
    // source form (`Paths.document`) and compiled JS
    // (`expo_file_system_1.Paths.document`): the object of the access is a
    // watch-listed identifier, or a member access whose last segment is one.
    if (ts.isPropertyAccessExpression(node)) {
      const obj = node.expression;
      const objName = ts.isIdentifier(obj)
        ? obj.text
        : (ts.isPropertyAccessExpression(obj) ? obj.name.text : '');
      if (VALUE_WATCH.test(objName)) {
        const s = scopeOf(node);
        if (s.scope === 'MODULE') {
          valueUses.push({
            object: objName,
            prop: node.name.text,
            file: path.relative(ROOT, file),
            line: lineOf(sf, node),
            text: text.split('\n')[lineOf(sf, node) - 1].trim().slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { requests, valueUses };
}

function evaluatedFromDump(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith('###RESULT### '));
  if (!line) return null;
  const json = JSON.parse(line.slice('###RESULT### '.length));
  return json;
}

function main() {
  const argv = process.argv.slice(2);
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dirs.push(argv[++i]);
  }
  const args = argv.filter((a) => !a.startsWith('--') && !dirs.includes(a));
  const asJson = process.argv.includes('--json');
  const dumps = args.filter((a) => fs.existsSync(a));
  const perEntry = {};
  const files = new Set();
  for (const d of dumps) {
    const json = evaluatedFromDump(d);
    if (!json) continue;
    perEntry[path.basename(d)] = { entry: json.entry, ok: json.ok, count: json.evaluatedCount };
    for (const f of json.evaluated || []) files.add(f);
  }
  const all = [];
  const values = [];
  const byFile = {};
  const parseErrors = [];
  if (dirs.length) {
    // --dir <path>: scan every JS/TS file under the path (used for react-native's
    // own JS, which the parity harness serves from a stub and therefore never
    // evaluates — but which does ship in the real bundle).
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(p);
        } else if (/\.(js|ts|tsx|jsx)$/.test(e.name)) {
          files.add(path.relative(ROOT, p));
        }
      }
    };
    for (const d of dirs) walk(path.resolve(d));
  }
  for (const rel of [...files].sort()) {
    const abs = path.join(ROOT, rel);
    if (!/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(rel)) continue;
    if (!fs.existsSync(abs)) continue;
    let res;
    try {
      res = analyse(abs);
    } catch (e) {
      parseErrors.push(rel + ': ' + String(e && e.message) + ' @ ' +
        String(e && e.stack ? e.stack.split('\n')[1] : '').trim());
      res = { requests: [], valueUses: [] };
    }
    for (const r of res.requests) {
      all.push(r);
      (byFile[r.file] = byFile[r.file] || []).push(r);
    }
    for (const v of res.valueUses) values.push(v);
  }
  if (asJson) {
    console.log(JSON.stringify({ perEntry, filesParsed: files.size, requests: all, moduleScopeValueUses: values }, null, 1));
    return;
  }
  console.log('== device-parity dumps parsed ==');
  for (const [k, v] of Object.entries(perEntry)) {
    console.log('  ' + k + '  entry=' + v.entry + ' ok=' + v.ok + ' modules=' + v.count);
  }
  console.log('  files in union: ' + files.size + '   per-file parse errors: ' + parseErrors.length);
  for (const e of parseErrors.slice(0, 10)) console.log('    !! ' + e);
  console.log('');
  const uniq = new Map();
  for (const r of all) {
    const key = r.name + '|' + r.file + ':' + r.line;
    if (!uniq.has(key)) uniq.set(key, r);
  }
  const rows = [...uniq.values()].sort((a, b) =>
    (a.scope === 'MODULE' ? 0 : 1) - (b.scope === 'MODULE' ? 0 : 1) ||
    String(a.name).localeCompare(String(b.name)) ||
    a.file.localeCompare(b.file));
  console.log('== native-module requests (unique file:line), MODULE scope first ==');
  console.log('  scope                    throwing? try?  kind                                  name                              where');
  for (const r of rows) {
    const throwing = /requireNativeModule$|getEnforcing$|\.requireNativeModule$/.test(r.kind) ? 'THROWS ' : 'null   ';
    console.log(
      '  ' + String(r.scope).padEnd(24) + ' ' + throwing + ' ' + (r.try ? 'try ' : '    ') + '  ' +
      String(r.kind).padEnd(36) + ' ' + String(r.name).padEnd(32) + ' ' + r.file + ':' + r.line);
  }
  console.log('');
  console.log('== DECISIVE CLASS: module-scope + throwing lookup + NOT inside try/catch ==');
  const decisive = rows.filter((r) => r.scope === 'MODULE' && !r.try &&
    /requireNativeModule$|getEnforcing$|\.requireNativeModule$/.test(r.kind));
  if (!decisive.length) {
    console.log('  (none)');
  } else {
    for (const r of decisive) {
      console.log('  ' + String(r.name).padEnd(34) + ' ' + r.file + ':' + r.line + '   :: ' + r.text);
    }
  }
  console.log('');
  console.log('== module-scope member reads on native-backed values ==');
  for (const v of values) {
    console.log('  ' + (v.object + '.' + v.prop).padEnd(34) + ' ' + v.file + ':' + v.line + '   ' + v.text);
  }
  const modScopeNames = [...new Set(rows.filter((r) => r.scope === 'MODULE').map((r) => r.name))].sort();
  console.log('');
  console.log('== MODULE-SCOPE module names requested (' + modScopeNames.length + ') ==');
  console.log('  ' + modScopeNames.join(', '));
  const nonModule = [...new Set(rows.filter((r) => r.scope !== 'MODULE').map((r) => r.name))].sort();
  console.log('');
  console.log('== function-scope-only names (' + nonModule.length + ') ==');
  console.log('  ' + nonModule.join(', '));
}
if (require.main === module) {
  main();
}
module.exports = { analyse, requestOf, scopeOf, chainText };
