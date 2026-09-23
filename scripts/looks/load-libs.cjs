'use strict';
/**
 * Loads the REAL src/lib TS modules into Node for the offline look proofs —
 * no Metro, no RN runtime, no device. Mirrors the trick the smoke suite
 * already uses (scripts/smoke/compile.cjs): TypeScript's own transpileModule,
 * evaluated with a tiny module registry so `./lookGrade` style imports resolve.
 *
 * Only modules that are genuinely RN-free can be loaded here:
 *   src/lib/lookGrade.ts   (pure maths, RN-free by design)
 *   src/lib/filters.ts     (pure + jpeg-js)
 *   src/lib/lookPreviews.ts(pure; derives from the two above)
 * src/lib/selfieBake.ts is NOT loadable (expo-file-system) and never loaded.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const cache = new Map();

function compile(absFile, relName) {
  const src = fs.readFileSync(absFile, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relName,
  });
  return out.outputText;
}

/**
 * Loads src/lib/<name>.ts (or an absolute path) as CommonJS. Relative requires
 * resolve to sibling src/lib modules; anything else goes to Node's real require
 * (jpeg-js).
 */
function load(nameOrPath, fromDir) {
  const abs = path.isAbsolute(nameOrPath)
    ? nameOrPath
    : path.resolve(fromDir || path.join(ROOT, 'src', 'lib'), `${nameOrPath}.ts`);
  if (cache.has(abs)) return cache.get(abs);
  if (!fs.existsSync(abs)) throw new Error(`load-libs: no such module ${abs}`);
  const mod = { exports: {} };
  cache.set(abs, mod.exports); // set before eval so cycles resolve to the partial exports
  const fn = new Function(
    'require',
    'module',
    'exports',
    '__filename',
    '__dirname',
    `${compile(abs, abs)}\n//# sourceURL=${abs}`,
  );
  const localRequire = (id) => {
    if (id.startsWith('./') || id.startsWith('../')) {
      return load(id, path.dirname(abs));
    }
    return require(id);
  };
  fn(localRequire, mod, mod.exports, abs, path.dirname(abs));
  cache.set(abs, mod.exports);
  return mod.exports;
}

module.exports = { ROOT, load };
