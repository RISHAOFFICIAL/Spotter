'use strict';
/**
 * Device-parity stand-in for `expo-modules-core`.
 *
 * The real implementation resolves a native module through the Expo module
 * registry (`globalThis.expo.modules`) and THROWS when the module is not
 * registered:
 *     requireNativeModule('X')  -> Error: Cannot find native module 'X'
 *     requireOptionalNativeModule('X') -> null
 * expo-font/src/ExpoFontLoader.ts calls requireNativeModule at MODULE SCOPE, and
 * @expo/vector-icons -> expo-font is reached during the first render, so this is
 * exactly the kind of throw the device crash logs point at.
 *
 * Registration state comes from the shipped app's own binaries
 * (stubs/device-native-modules.json). Every request is recorded so the report can
 * show which native module names the JS graph asks for during load.
 */

const fs = require('fs');
const path = require('path');
const { universalStub } = require('./generic.cjs');

const DEVICE_MODULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'device-native-modules.json'), 'utf8'),
);
const REGISTERED = new Set([
  ...DEVICE_MODULES.registered,
  ...Object.keys(DEVICE_MODULES.flagged || {}),
]);

const requested = [];
const missing = [];

function record(name, via) {
  if (!requested.some((r) => r.name === name && r.via === via)) requested.push({ name, via });
}

function requireNativeModule(name) {
  record(name, 'requireNativeModule');
  if (!REGISTERED.has(name)) {
    missing.push(name);
    const err = new Error("Cannot find native module '" + name + "'");
    err.code = 'ERR_NATIVE_MODULE_NOT_FOUND';
    throw err;
  }
  return universalStub('NativeModule(' + name + ')');
}

function requireOptionalNativeModule(name) {
  record(name, 'requireOptionalNativeModule');
  return REGISTERED.has(name) ? universalStub('NativeModule(' + name + ')') : null;
}

// Expo's runtime registry: the native side injects `globalThis.expo.modules`.
const expoGlobal = (globalThis.expo = globalThis.expo || {});
expoGlobal.modules = expoGlobal.modules || {};
for (const name of REGISTERED) {
  if (!(name in expoGlobal.modules)) expoGlobal.modules[name] = universalStub('expo.modules.' + name);
}
if (!expoGlobal.EventEmitter) expoGlobal.EventEmitter = universalStub('expo.EventEmitter');

class CodedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
class UnavailabilityError extends Error {
  constructor(moduleName, propertyName) {
    super(moduleName + '.' + propertyName + ' is not available on this platform.');
    this.code = 'ERR_UNAVAILABLE';
  }
}

const NativeModule = function NativeModule() {};

const api = {
  NativeModule,
  SharedObject: function SharedObject() {},
  SharedRef: function SharedRef() {},
  CodedError,
  UnavailabilityError,
  Platform: { OS: 'ios', select: (o) => o.ios },
  requireNativeModule,
  requireOptionalNativeModule,
  requireNativeView: () => universalStub('requireNativeView'),
  requireNativeViewManager: () => universalStub('requireNativeViewManager'),
  EventEmitter: function EventEmitter() {
    return { addListener: () => ({ remove() {} }), emit() {}, removeAllListeners() {} };
  },
  NativeModulesProxy: universalStub('NativeModulesProxy'),
  uuid: universalStub('uuid'),
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  __parityReport: () => ({ requested: requested.slice(), missing: missing.slice() }),
  __esModule: true,
};

module.exports = new Proxy(api, {
  get(t, prop) {
    if (prop in t) return t[prop];
    if (typeof prop === 'symbol') return undefined;
    if (prop === 'default') return module.exports;
    return universalStub('expo-modules-core.' + String(prop));
  },
  has() {
    return true;
  },
});
