'use strict';
/**
 * Module resolution + loading for the device-parity loader.
 *
 * Policy per request (deliberately "real first, stub only when there is no
 * alternative", so real package code -- including its module-scope side effects
 * such as expo-font's requireNativeModule('ExpoFontLoader') -- actually runs):
 *
 *   1. '@/' path alias        -> <repo>/src/**  (tsconfig paths) / <repo>/assets/**
 *   2. asset requests         -> permissive stub (+ recorded)
 *   3. 'react-native' | deep 'react-native/...' -> iOS parity stub (+ recorded)
 *   4. explicit stub map      -> that stub file (+ recorded)
 *   5. Node core builtin      -> an installed npm package of the same name if
 *                                there is one (what Metro would resolve), else a
 *                                permissive stub (+ recorded)
 *   6. anything else          -> the REAL module; if resolution or evaluation
 *                                fails, a permissive stub (+ recorded) -- EXCEPT
 *                                for app code (src/, scripts/), where the error is
 *                                rethrown, because swallowing it would turn a real
 *                                finding into a false "clean" report.
 *
 * Loading is done by filename (loadByPath), not by re-entering Module._load, so
 * nested requires inside a module are still resolved through this same policy
 * without recursion.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { universalStub } = require('./stubs/generic.cjs');

const STUBS_DIR = path.join(__dirname, 'stubs');
const ROOT = path.resolve(__dirname, '..', '..');

const EXPLICIT_STUBS = {
  'react-native': path.join(STUBS_DIR, 'react-native.js'),
  'expo-modules-core': path.join(STUBS_DIR, 'expo-modules-core.js'),
};

const ASSET_EXT = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ttf', '.otf', '.woff', '.woff2',
  '.mp4', '.mov', '.m4a', '.mp3', '.wav', '.pdf',
];

const APP_ROOTS = [path.join(ROOT, 'src') + path.sep, path.join(ROOT, 'scripts') + path.sep];

const record = {
  alias: [],
  assets: [],
  rnDeep: [],
  stubbed: [],
  coreBuiltins: [],
  realLoadFailure: [],
  proxyForUnresolved: [],
};

function loadByPath(filename, parent) {
  const cached = Module._cache[filename];
  if (cached) return cached.exports;
  const mod = new Module(filename, parent);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  Module._cache[filename] = mod;
  try {
    mod.load(filename);
  } catch (e) {
    delete Module._cache[filename];
    throw e;
  }
  return mod.exports;
}

function smokeStubPath(request) {
  const depsPath = path.join(ROOT, 'scripts', 'smoke', 'deps.json');
  if (!fs.existsSync(depsPath)) return null;
  const deps = JSON.parse(fs.readFileSync(depsPath, 'utf8'));
  const rel = deps[request];
  return rel ? path.join(ROOT, 'scripts', rel) : null;
}

function isCoreBuiltin(request) {
  if (request.startsWith('node:')) return true;
  if (request.startsWith('.') || request.startsWith('/')) return false;
  return (Module.builtinModules || []).includes(request);
}

function installResolver(opts) {
  const o = opts || {};
  const mode = o.stubMode || 'real';
  const passThrough = new Set(o.passThrough || []);
  const proxyCache = new Map();

  const cachedProxy = (key, label) => {
    if (!proxyCache.has(key)) proxyCache.set(key, universalStub(label || key));
    return proxyCache.get(key);
  };

  const traceFile = process.env.PARITY_TRACE;
  const trace = (line) => {
    if (traceFile) fs.appendFileSync(traceFile, line + '\n');
  };

  const origLoad = Module._load;
  const HARNESS_DIR = __dirname + path.sep;

  Module._load = function parityLoad(request, parent, isMain) {
    if (typeof request !== 'string') {
      // Not a normal CJS load (e.g. internal ESM bridge): delegate as Node does.
      return Module.prototype.require.call(parent || module, request);
    }
    const parentFile = parent && parent.filename ? parent.filename : '(entry)';

    // The harness's own modules (stubs, env, graph) load for real and unrecorded.
    if (parentFile.startsWith(HARNESS_DIR)) {
      return origLoad.call(this, request, parent, isMain);
    }

    const real = (reason) => {
      const resolved = Module._resolveFilename(request, parent, isMain);
      trace('REAL ' + request + ' -> ' + resolved + ' (' + reason + ')');
      try {
        return loadByPath(resolved, parent);
      } catch (e) {
        const appCode = APP_ROOTS.some((r) => resolved.startsWith(r));
        record.realLoadFailure.push({
          request,
          resolved,
          parentFile,
          appCode,
          message: e && e.message ? e.message : String(e),
          stackTop: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null,
        });
        if (appCode) throw e; // never swallow app-code failures
        return cachedProxy('failed:' + request, request);
      }
    };

    // 1. tsconfig path aliases
    if (request.startsWith('@/')) {
      const rest = request.slice(2);
      const base = rest.startsWith('assets/') ? path.join(ROOT, rest) : path.join(ROOT, 'src', rest);
      if (ASSET_EXT.includes(path.extname(base))) {
        record.assets.push({ request, parentFile });
        return cachedProxy('asset:' + request, 'asset(' + request + ')');
      }
      record.alias.push({ request, resolved: base, parentFile });
      trace('ALIAS ' + request + ' -> ' + base);
      const resolved = Module._resolveFilename(base, parent, isMain);
      try {
        return loadByPath(resolved, parent);
      } catch (e) {
        record.realLoadFailure.push({
          request,
          resolved,
          parentFile,
          appCode: true,
          message: e && e.message ? e.message : String(e),
          stackTop: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null,
        });
        throw e;
      }
    }

    // 2. asset requires
    if (ASSET_EXT.includes(path.extname(request))) {
      record.assets.push({ request, parentFile });
      return cachedProxy('asset:' + request, 'asset(' + request + ')');
    }

    // 3. react-native (deep internals included: Metro aliases those to the RN
    //    build, which is Flow-typed and cannot be required in Node)
    if (request === 'react-native') {
      trace('STUB react-native');
      return loadByPath(EXPLICIT_STUBS['react-native'], parent);
    }
    if (request.startsWith('react-native/')) {
      record.rnDeep.push({ request, parentFile });
      const rn = loadByPath(EXPLICIT_STUBS['react-native'], parent);
      const leaf = String(request).split('/').pop();
      if (rn && rn[leaf] !== undefined) return rn[leaf];
      return cachedProxy('rn:' + request, request);
    }

    // 4. explicit stub map (parity), or the smoke harness's stubs on request
    if (EXPLICIT_STUBS[request]) {
      trace('STUB ' + request);
      return loadByPath(EXPLICIT_STUBS[request], parent);
    }
    if (mode === 'smoke') {
      const smoke = smokeStubPath(request);
      if (smoke) {
        record.stubbed.push({ request, via: 'smoke-stub', parentFile });
        trace('STUB(smoke) ' + request);
        return loadByPath(smoke, parent);
      }
    }

    // 5. Node core builtin
    if (isCoreBuiltin(request) && !passThrough.has(request)) {
      const bare = request.startsWith('node:') ? request.slice(5) : request;
      const pkgPath = Module._findPath(bare, [path.join(ROOT, 'node_modules')]);
      if (pkgPath) {
        record.coreBuiltins.push({ request, parentFile, via: 'npm package ' + pkgPath });
        trace('CORE->pkg ' + request + ' -> ' + pkgPath);
        return loadByPath(pkgPath, parent);
      }
      record.coreBuiltins.push({ request, parentFile, via: 'unbundleable -> permissive stub' });
      return cachedProxy('core:' + request, 'node-core(' + request + ')');
    }

    // 6. real module first, permissive stub only if it cannot load
    let resolved = null;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch (e) {
      record.proxyForUnresolved.push({ request, parentFile, reason: 'unresolved: ' + e.code });
      trace('UNRESOLVED ' + request + ' (' + e.code + ')');
      return cachedProxy('unresolved:' + request, request);
    }
    return real('rule6');
  };

  return { record, loadByPath };
}

module.exports = { installResolver, EXPLICIT_STUBS, ROOT, loadByPath };
