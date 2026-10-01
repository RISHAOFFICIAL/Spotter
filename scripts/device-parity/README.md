# Device-parity startup harness (diagnostic-only, test infrastructure)

Offline instrument for the device-only first-render crash. It loads the **real**
module graph of each launch state's first route under an environment that matches
the phone (iOS, release, Hermes-absent globals) instead of the old smoke harness
(`Platform.OS === 'web'`, every native module replaced by a JS stub, dev mode).

Nothing here is on the app's runtime path: no file under `src/` is touched.

## Run it

```bash
cd /home/team/shared/app
node scripts/device-parity/run.cjs                 # all four first-render entries
node scripts/device-parity/run.cjs --entry "src/app/_layout.tsx"
node scripts/device-parity/run.cjs --stub-mode smoke   # A/B: the old smoke stubs
node scripts/device-parity/run.cjs --graph         # the derived first-render require set
node scripts/device-parity/run.cjs --list          # the keep/delete evidence table
node scripts/device-parity/load.cjs --entry "$PWD/src/app/_layout.tsx"   # one entry, verbose
```

Exit code 0 = every entry loaded clean, 1 = a throw (or a driver parse failure),
2 = harness misuse. One **child process per entry** = a fresh module registry per
entry, so a throw in one route cannot mask another.

## Why these four entries (the real first-render require set)

expo-router's default import mode is **sync** —
`expo-router/build/import-mode/index.js:3  exports.default = process.env.EXPO_ROUTER_IMPORT_MODE || 'sync'`
— and its route-loading code requires a screen's module **synchronously while that
screen renders**: `expo-router/build/useScreens.js:218  const res = value.loadRoute();`
→ `getRoutesCore.js:239  routeModule = contextModule(filePath)`. So the app graph is
evaluated inside the first render, and each launch state has its own first route
(`src/app/_layout.tsx` gates on auth state):

| entry | when |
| --- | --- |
| `src/app/_layout.tsx` | always mounted first |
| `src/app/(auth)/welcome.tsx` | `!session` |
| `src/app/(onboarding)/index.tsx` | `session && !profile` |
| `src/app/(home)/(tabs)/index.tsx` | `session && profile` |

`--graph` prints the app-source require closure of each entry (computed with
`ts.preProcessFile`, not a regex).

## What "device parity" means here

* `Platform.OS === 'ios'` with an iOS-shaped `Platform.constants`
  (`stubs/react-native.js`); the old harness had `OS === 'web'`, which silently sent
  `src/lib/supabase.ts:76` (`Platform.OS === 'web' ? webStorageAdapter() : secureStoreAdapter`)
  down the web branch that the phone never takes.
* `__DEV__ = false`, `process.env` narrowed to the release build's inlined values
  (`NODE_ENV=production`, `EXPO_OS=ios`, the `EXPO_PUBLIC_*` values Metro inlines from
  `.env`), `RN$Bridgeless = true`, `window === self === global`,
  `navigator = {product:'ReactNative'}`, `ErrorUtils`, `__turboModuleProxy`.
* Node globals Hermes does not have are **guarded**, not just deleted (see below).
* Every `.js/.ts/.tsx` file is transpiled to CommonJS with TypeScript, like Metro's
  Babel pass, instead of letting Node run it as ESM (Node's ESM resolution demands
  explicit extensions, which Metro does not, and Node 22.18+ type-stripping refuses
  files under `node_modules`).
* Module resolution is Metro-flavoured: `.ios.js`/`.native.js` extension order
  (`Module._extensions` key order), `--conditions=react-native --conditions=browser`,
  and Node core builtins resolved to an installed npm package of the same name when
  one exists (that is what Metro would bundle).
* Real packages load **for real** whenever they can, so their module-scope code runs
  (e.g. `expo-font`'s module-scope `requireNativeModule('ExpoFontLoader')`). Only if
  resolution or evaluation fails does a permissive stub replace them, and that is
  recorded in the report. **App code (`src/`, `scripts/`) is never silently
  stubbed** — a failure there is rethrown and reported.

### Keep/delete decisions (evidence, not memory)

Printed in full by `--list`; the evidence is RN's own polyfill chain
(`react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js` →
`Libraries/Core/setUp*.js`) and Expo's winter runtime
(`expo/src/winter/runtime.native.ts`), which runs before the app entry on device.

| decision | items | why |
| --- | --- | --- |
| keep | `structuredClone`, `URL`, `URLSearchParams`, `TextDecoder`, `DOMException`, `fetch`, `Headers/Request/Response`, `FormData`, `AbortController/AbortSignal`, `ReadableStream` | Expo winter installs each of these (`runtime.native.ts` lines 16–53) |
| keep | `queueMicrotask`, `setImmediate/clearImmediate`, `requestIdleCallback/cancelIdleCallback`, timers, `console`, `performance` | RN `setUpTimers.js` (bridgeless) / `@react-native/js-polyfills` |
| keep | `Intl` | Hermes on iOS ships it (medium confidence: inferred from the shipped `hermesvm.framework` binary) |
| replace | `process` (env narrowed), `navigator` | RN `setUpGlobals.js:30`, `setUpNavigator.js:18` |
| guarded | `Buffer`, `crypto`, `crypto.getRandomValues`, `atob`, `btoa`, `TextEncoder`, `TextEncoderStream`, `MessageChannel`, `MessagePort`, `BroadcastChannel`, `Array.prototype.toSorted/toReversed/toSpliced/with`, `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `WeakRef`, `FinalizationRegistry` | no RN/Expo polyfill installs them and Hermes 0.86 has no Node equivalents; ES2023/24 additions are not implemented by Hermes (medium confidence, name-absent from the shipped Hermes binary) |

**Methodological finding (important).** Simply *deleting* those Node globals breaks
the harness, not the app: with `Buffer` deleted, the first thing that touches
`fetch` makes Node's own `undici` fail — `ReferenceError: Buffer is not defined at
lib/dispatcher/client-h1.js (node:internal/deps/undici/undici:5974:21)` — and with
`Array.prototype.toSorted` deleted, Node's internal `node:http` fails to compile
(`TypeError: methods.toSorted is not a function at node:http:128`). Both are
Node-internal, i.e. **harness artifacts, not app findings**. The harness therefore
replaces them with accessors/method guards that delegate to Node's original for
Node internals and the harness's own code, and throw a device-like
`ReferenceError`/`TypeError` for callers in the app graph. A finding is only real if
its stack is in `src/**` or an app `node_modules` package.

## Result of the first full run (2026-09-22)

```
ENTRY [root-layout] src/app/_layout.tsx    => CLEAN   modules_evaluated=597
ENTRY [no-session] src/app/(auth)/welcome.tsx      child output: RESULT: CLEAN
ENTRY [session-not-onboarded] src/app/(onboarding)/index.tsx => CLEAN modules_evaluated=876
ENTRY [onboarded-home] src/app/(home)/(tabs)/index.tsx  child output: RESULT: CLEAN
SUMMARY: 2/4 entries loaded clean ... exit=1
```

All four children printed `RESULT: CLEAN` (no throw anywhere in the graph, with
~600–880 modules evaluated per entry, including the real `expo-router`,
`expo-camera`, `expo-notifications`, `expo-font`, `@supabase/supabase-js` and
`jpeg-js` code). The driver still exited 1 for two entries because its
`###RESULT###` JSON summary line failed to parse for them — an open driver bug
(`run.cjs` reports `modules_evaluated=undefined` and `parseError`); the underlying
load was clean. Fix that before trusting the driver's exit code.

Native-module names requested during load (against the shipped app's registry,
`stubs/device-native-modules.json`): ExponentConstants, ExpoUpdates, ExpoGo,
ExpoAsset, ExpoSplashScreen, ExpoLinking, ExpoGlassEffect, ExpoSecureStore,
**ExpoFontLoader**, ExpoFontUtils, ExpoClipboard, ExpoCrypto, ExpoCryptoAES,
ExpoDevice, ExpoPushTokenManager, ExpoApplication, Notifications, ExpoCamera,
ExpoObserve, ExpoImage, FileSystem. `ExpoGo` is the only one not in the device
registry (it is the Expo Go client, dev-only) — `requireNativeModule('ExpoGo')` is
inside a function, so it does not throw during load.

## Scope and limits (read before trusting a "clean")

Covered: module evaluation of the real first-render require set — Metro's
`guardedLoadModule` reporter (`metro-runtime/src/polyfills/require.js`, a throw in a
module factory during any `require`), which is one of the two reporters that can
produce the device crash signature.

**Not covered:** React render/commit/effect execution (the other reporter,
`ErrorHandler.onUncaughtError` → `ExceptionsManager.handleException(error, true)`).
There is no renderer here: RN's component/hook surface cannot be faithfully stubbed
and stubbing it would manufacture false throws. A first-render or mount-effect error
in the JSX/hook bodies is therefore invisible to this harness.

Other known gaps, all recorded in the report rather than hidden:
* native module *registration* is not reproduced — the stub layer is permissive by
  design, and `device-native-modules.json` marks the three names whose literals are
  ≤15 bytes (`ExpoFontLoader` 14, `ExpoApplication` 15, `ExpoBadgeModule` 15) as
  registered, because Swift stores such literals inline and a byte scan cannot see
  them. A missing-native-module crash cannot be reproduced here; that question
  belongs to the static binary check.
* packages that cannot load in Node fall back to permissive proxies (currently
  `@react-native-masked-view/masked-view`, `@react-native-async-storage/async-storage`),
  so their module-scope code is not exercised.
* Node's `process.version/argv/nextTick` stay visible (the harness's own runtime
  needs them), so code that sniffs "am I on Node?" sees a Node-ish process.
* `--delete-protoes` style global deletion is deliberately NOT used (see above).

## Files

| file | role |
| --- | --- |
| `run.cjs` | driver: entries, one child per entry, summary, exit code |
| `load.cjs` | child: parity env + require hooks + one entry load + report |
| `parity-env.cjs` | the KEEP/DELETE/GUARD table and its application |
| `resolver.cjs` | Metro-flavoured module policy + real-first loading |
| `graph.cjs` | static first-render require closure (`ts.preProcessFile`) |
| `stubs/react-native.js` | iOS Platform + components + device module registry |
| `stubs/expo-modules-core.js` | `requireNativeModule` with the device registry |
| `stubs/generic.cjs` | the permissive stand-in (tagged, never silently used for app code) |
| `stubs/device-native-modules.json` | the shipped app's native-module registry (evidence: build 22 IPA) |
