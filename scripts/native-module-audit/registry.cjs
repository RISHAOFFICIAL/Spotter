'use strict';
/**
 * SPOTTER native-module audit — AUTHORITATIVE registered-name registry, FROM SOURCE.
 *
 * Input: the JSON that the app's own autolinking produces, i.e.
 *   npx expo-modules-autolinking resolve --platform apple --json > autolink.json
 * (that is what `pod install` consumes for this app's pinned dependency set).
 *
 * For every pod autolinking resolves, this reads the pod's OWN iOS sources and
 * extracts the name the module registers under at runtime:
 *   * Swift (expo-modules):  ModuleDefinition { Name("ExpoFontLoader") }
 *   * ObjC (expo-modules):   EX_EXPORT_MODULE(Name)
 *   * ObjC (react-native):   RCT_EXPORT_MODULE(Name)   / RCT_EXPORT_MODULE()  (class-derived)
 *   * ObjC:                  + (NSString *)moduleName { return @"X"; }
 * No binary/byte scanning is involved: this is the source of truth the build
 * compiles.
 *
 * Usage: node scripts/native-module-audit/registry.cjs <autolink.json> [extraPkgDirs...]
 */
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', 'build', '.git', 'Pods', 'android']);
const SOURCE_EXT = /\.(swift|m|mm|h)$/;

function walk(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out, depth + 1);
    } else if (SOURCE_EXT.test(e.name)) {
      out.push(p);
    }
  }
}

const SWIFT_NAME = /Name\s*\(\s*"([^"]+)"\s*\)/g;
const EX_EXPORT = /EX_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/g;
const RCT_EXPORT = /RCT_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/g;
const MODULE_NAMED = /-\s*\(\s*NSString\s*\*+\s*\)\s*moduleName[\s\S]{0,200}?return\s+@?"([^"]+)"/g;

function registryForDirs(dirs) {
  const byName = new Map();
  for (const dir of dirs) {
    const files = [];
    walk(dir, files, 0);
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const add = (name, kind) => {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ name, kind, file: path.relative(process.cwd(), f) });
      };
      for (const m of text.matchAll(SWIFT_NAME)) add(m[1], 'Swift Name()');
      for (const m of text.matchAll(EX_EXPORT)) add(m[1] || '(class-derived)', 'EX_EXPORT_MODULE');
      for (const m of text.matchAll(RCT_EXPORT)) add(m[1] || '(class-derived)', 'RCT_EXPORT_MODULE');
      for (const m of text.matchAll(MODULE_NAMED)) add(m[1], 'moduleName');
    }
  }
  return byName;
}

function main() {
  const [autolinkFile, ...extra] = process.argv.slice(2);
  const json = JSON.parse(fs.readFileSync(autolinkFile, 'utf8'));
  const podDirs = [];
  for (const mod of json.modules || []) {
    for (const pod of mod.pods || []) {
      if (!pod.podspecDir) continue;
      const dirs = [path.join(pod.podspecDir, '..'), pod.podspecDir];
      podDirs.push({ pkg: mod.packageName, pod: pod.podName, dir: pod.podspecDir, classes: (mod.modules || []).map((m) => m.class) });
    }
  }
  console.log('== autolinking resolve input: ' + autolinkFile + ' ==');
  console.log('pods: ' + podDirs.map((p) => p.pod).join(', '));
  console.log('');
  const byName = registryForDirs(podDirs.map((p) => path.dirname(p.dir)));
  for (const extraDir of extra) {
    const m = registryForDirs([extraDir]);
    for (const [k, v] of m) {
      if (!byName.has(k)) byName.set(k, v);
      else byName.get(k).push(...v);
    }
  }
  const names = [...byName.keys()].filter((n) => !n.startsWith('(')).sort();
  console.log('== JS-visible native module names declared in the autolinked pod sources (' + names.length + ') ==');
  for (const n of names) {
    const where = byName.get(n).slice(0, 2).map((w) => w.kind + ' ' + w.file).join('  |  ');
    console.log('  ' + n.padEnd(40) + ' ' + where);
  }
  const classDerived = [...byName.keys()].filter((n) => n.startsWith('('));
  console.log('');
  console.log('class-derived (no explicit name) declarations found: ' + classDerived.length);
  console.log('');
  fs.writeFileSync('/tmp/registry-names.json', JSON.stringify(Object.fromEntries([...byName].map(([k, v]) => [k, v])), null, 1));
  console.log('wrote /tmp/registry-names.json');
}
main();
