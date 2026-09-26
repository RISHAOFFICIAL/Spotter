/**
 * Minimal expo-constants stub for the Node harness (app version only).
 *
 * `expoConfig.version` is read from the app's OWN app.json, exactly as Expo
 * resolves it into a build — a hardcoded version here would let this harness
 * drift from the number the app declares (it held a stale '1.1.0' while
 * app.json said 1.0.0, which is how the version-stamp defect stayed invisible
 * offline). scripts/smoke/app-version-guard.cjs asserts this mirror.
 */
const appJson = require('../../app.json');
const version = appJson.expo.version;
module.exports = {
  default: { expoConfig: { version }, appOwnership: 'expo' },
  expoConfig: { version },
};
