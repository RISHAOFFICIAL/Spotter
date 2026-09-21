/**
 * SPOTTER root entry — DIAGNOSTIC BUILD ONLY (build 20, branch diag/boot-error-black-box).
 *
 * package.json "main" points here instead of "expo-router/entry" for exactly one reason:
 * the boot black box must be installed BEFORE expo-router (and therefore every route
 * module, including src/app/_layout.tsx) is evaluated, so that an uncaught JavaScript
 * error thrown during that evaluation is captured and printed instead of aborting the
 * process. See src/lib/bootBlackBox.js for the full crash analysis.
 *
 * ORDER MATTERS AND IS DELIBERATE: this file uses explicit `require()` calls, never
 * `import` declarations. Babel's ESM->CJS transform hoists `import` statements to the top
 * of the module, which would let the router load first; plain `require()` calls keep their
 * statement order in the Metro bundle. `scripts/verify-boot-order.mjs` proves the emitted
 * bundle still has the black box require ahead of the router require.
 *
 * REMOVAL (before App Review): delete this file, delete src/lib/bootBlackBox.js and set
 * package.json "main" back to "expo-router/entry".
 */
var blackBox = require('./src/lib/bootBlackBox');

// Idempotent: the require above already armed the black box at its own module scope.
blackBox.installBootBlackBox();
blackBox.setBootPhase('requiring-router');

try {
  require('expo-router/entry');
  blackBox.setBootPhase('router-loaded');
} catch (error) {
  // A synchronous import-time throw used to be an instant SIGABRT (RN's fatal path).
  // Report it through the same channel as an uncaught error, and keep the process alive.
  blackBox.reportBootThrow(error, 'requiring-router');
}
