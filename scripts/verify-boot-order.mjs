#!/usr/bin/env node
/**
 * verify-boot-order.mjs — proof, not assumption, that the build-20 boot order survives
 * Metro/babel: in the EMITTED bundle, index.js must reference the black box module
 * (src/lib/bootBlackBox.js) BEFORE it references the router (expo-router/entry).
 *
 * Why this matters: if babel/metro hoisted the router require above the install, the black
 * box would be armed too late to catch the error we are hunting, and build 20 would be a
 * wasted TestFlight cycle. `import` declarations ARE hoisted by the ESM->CJS transform,
 * which is why both index.js and the black box use explicit require() calls — this script
 * checks the emitted artifact rather than trusting that reasoning.
 *
 * Usage: node scripts/verify-boot-order.mjs <bundle.js>
 *   (best run against a DEV-mode bundle, where Metro keeps per-module verbose names:
 *    npx expo export:embed --platform ios --dev true --entry-file index.js \
 *        --bundle-output /tmp/b20dev/main.jsbundle --assets-dest /tmp/b20dev/assets )
 * Exit code 0 = order verified, 1 = not verified, 2 = usage problem.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/verify-boot-order.mjs <bundle.js>');
  process.exit(2);
}
const src = readFileSync(file, 'utf8');
let failed = false;
const ok = (m) => console.log('  OK   ' + m);
const bad = (m) => {
  console.log('  FAIL ' + m);
  failed = true;
};

// ---- 1. the reporter is really in the emitted bundle -------------------------------
const title = 'SPOTTER boot error';
const titleHits = src.split(title).length - 1;
titleHits > 0
  ? ok(`reporter string ${JSON.stringify(title)} present (${titleHits}x)`)
  : bad(`reporter string ${JSON.stringify(title)} MISSING`);
const phaseHits = src.split('requiring-router').length - 1;
phaseHits > 0 ? ok(`phase marker "requiring-router" present (${phaseHits}x)`) : bad('phase marker missing');
const installHits = src.split('blackbox-installed').length - 1;
installHits > 0 ? ok(`phase marker "blackbox-installed" present (${installHits}x)`) : bad('install marker missing');
const swallow = /SWALLOW_BOOT_ERRORS\s*=\s*true|=\s*!0[^;]*SWALLOW/.test(src) || src.includes('SWALLOW_BOOT_ERRORS');
swallow ? ok('SWALLOW_BOOT_ERRORS constant present in bundle') : bad('SWALLOW_BOOT_ERRORS absent');

// ---- 2. locate the modules by their Metro verbose names ---------------------------
const modules = [];
const header = /__d\(function[\s\S]*?,\s*(\d+)\s*,\s*\[([^\]]*)\]\s*,\s*"([^"]+)"\s*\)/g;
let m;
while ((m = header.exec(src)) !== null) {
  const deps = (m[2].match(/\d+|"[^"]+"/g) || []).map((d) => (d.startsWith('"') ? d : Number(d)));
  modules.push({ id: Number(m[1]), deps, name: m[3], bodyStart: m.index, headerEnd: header.lastIndex });
}
console.log(`  .. modules with verbose names found: ${modules.length}`);
if (modules.length === 0) {
  bad('no verbose module names in this bundle — build a --dev bundle for this check');
  console.log(JSON.stringify({ verified: false }));
  process.exit(1);
}

const indexMod = modules.find((x) => x.name === 'index.js' || /(^|\/)index\.js$/.test(x.name));
const blackMod = modules.find((x) => /bootBlackBox/.test(x.name));
const routerMod = modules.find((x) => /expo-router\/(entry|entry-classic)/.test(x.name));
if (!indexMod) bad('index.js module not found in bundle (is package.json main = index.js?)');
if (!blackMod) bad('bootBlackBox module not found in bundle');
if (!routerMod) bad('expo-router entry module not found in bundle');
if (!indexMod || !blackMod || !routerMod) {
  console.log(JSON.stringify({ verified: false }));
  process.exit(1);
}
ok(`index.js module id=${indexMod.id} deps=[${indexMod.deps.join(', ')}]`);
ok(`black box module id=${blackMod.id} (${blackMod.name})`);
ok(`router module id=${routerMod.id} (${routerMod.name})`);

const body = src.slice(indexMod.bodyStart, indexMod.headerEnd);
console.log('  ---- emitted index.js factory body (dependency references only) ----');
for (const line of body
  .split('\n')
  .filter((l) => /dependencyMap|require\(|__d\(|global\.__spotterBoot|setBootPhase/.test(l))
  .slice(0, 25)) {
  console.log('    ' + line.trim().slice(0, 160));
}
console.log('  ------------------------------------------------------------------');

const slotOf = (id) => indexMod.deps.findIndex((d) => d === id);
const refPattern = (slotOrId) =>
  new RegExp(
    `(?:_dependencyMap|dependencyMap|\\bd)\\[\s*${slotOrId}\s*\\]|\\(\\s*${slotOrId}\\s*\\)|\\(\\s*${slotOrId}\\s*,`,
  );
const firstRef = (id) => {
  const slot = slotOf(id);
  let at = -1;
  if (slot >= 0) at = body.search(refPattern(slot));
  if (at < 0) at = body.indexOf(String(id));
  return at;
};
const blackAt = firstRef(blackMod.id);
const routerAt = firstRef(routerMod.id);
console.log(`  .. first reference to black box at offset ${blackAt}, router at offset ${routerAt}`);
if (blackAt < 0) bad('index.js never references the black box module');
else if (routerAt < 0) bad('index.js never references the router module');
else if (blackAt < routerAt) ok('black box is referenced BEFORE the router in the emitted bundle');
else bad(`ROUTER REFERENCED FIRST — boot install would run too late (black=${blackAt} router=${routerAt})`);

console.log(JSON.stringify({ verified: !failed, indexModule: indexMod.name, blackAt, routerAt }));
process.exit(failed ? 1 : 0);
