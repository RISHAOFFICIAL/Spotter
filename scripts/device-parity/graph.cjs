'use strict';
/**
 * Static import-graph extraction for the device-parity harness.
 *
 * WHY: expo-router's default import mode is 'sync'
 * (node_modules/expo-router/build/import-mode/index.js:3
 *   exports.default = process.env.EXPO_ROUTER_IMPORT_MODE || 'sync')
 * and it loads a route module with a SYNCHRONOUS require while that screen
 * renders (node_modules/expo-router/build/useScreens.js:218
 *   const res = value.loadRoute();  -> getRoutesCore.js:239 contextModule(filePath)),
 * which itself runs inside the first render. So "the files evaluated during the
 * first render" == the transitive import closure of src/app/_layout.tsx plus the
 * route expo-router mounts first. This module computes that closure per entry so
 * the harness knows exactly what it must load and the report can state it.
 *
 * Extraction uses the TypeScript compiler's own scanner (ts.preProcessFile), not
 * a regex, so it sees every static `import`/`export ... from`/`require('literal')`.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function depsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const info = ts.preProcessFile(source, true, true);
  const specs = new Set();
  for (const f of info.importedFiles) specs.add(f.fileName);
  for (const f of info.referencedFiles) specs.add(f.fileName);
  for (const f of info.typeReferenceDirectives) specs.add(f.fileName);
  return Array.from(specs);
}

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('@/assets/')) return null;
  let base;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // third-party: resolved at load time, not statically
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.ios.ts',
    base + '.ios.tsx',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Transitive closure over the app's own source files, in evaluation order. */
function appGraph(entry) {
  const seen = new Set();
  const order = [];
  // depth-first pre-order traversal (approximates Metro's require order)
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    order.push(path.relative(ROOT, file));
    for (const spec of depsOf(file)) {
      const resolved = resolveSpec(spec, file);
      if (resolved) visit(resolved);
    }
  };
  visit(entry);
  return order;
}

module.exports = { appGraph, depsOf, resolveSpec, ROOT };
