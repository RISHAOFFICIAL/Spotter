'use strict';
/**
 * Generic permissive stand-in used by the device-parity loader.
 *
 * WHY: the device-parity harness wants to evaluate the REAL module graph of a
 * route (src/**, plus whatever third-party packages the device would evaluate)
 * without a React Native runtime. Packages that cannot be required in Node
 * (Flow-typed RN internals, native-backed expo packages) are replaced by this
 * stub. It is deliberately PERMISSIVE (property access and calls never throw) so
 * a stub gap does not masquerade as an app crash. Every value produced here is
 * tagged with STUB_TAG so the report can tell findings-on-stubs from findings in
 * the app's own code.
 *
 * FIDELITY LIMITS (documented, not hidden):
 *  - A call returns `null` (a stubbed component renders nothing; a stubbed hook
 *    that should return an object returns null instead -- app code that then
 *    reads a property of that result throws here but not on device).
 *  - Property access always yields another stub, so `typeof x` is 'function' for
 *    names where the device might have a plain object.
 *  - Truthiness is always true.
 */

const STUB_TAG = Symbol.for('spotter.device-parity.stub');

function universalStub(label) {
  const props = new Map();
  const target = function deviceParityStub() {
    return null;
  };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === STUB_TAG) return true;
      if (prop === Symbol.toStringTag) return 'Stub(' + label + ')';
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === Symbol.asyncIterator) return undefined;
      if (prop === 'then') return undefined; // never look thenable to await
      if (prop === 'default') return proxy;
      if (prop === '__esModule') return true;
      if (prop === 'valueOf') return () => 0;
      if (prop === 'toString') return () => '[stub ' + label + ']';
      if (prop === 'hasOwnProperty') return () => false;
      if (prop === 'isStub') return true;
      if (prop === 'prototype') return t.prototype;
      if (prop === 'constructor') return Object;
      if (typeof prop === 'symbol') return undefined;
      if (!props.has(prop)) props.set(prop, universalStub(label + '.' + String(prop)));
      return props.get(prop);
    },
    has() {
      return true;
    },
    set() {
      return true;
    },
    apply() {
      return null;
    },
    construct() {
      return universalStub(label + ' instance');
    },
  });
  return proxy;
}

function isStub(value) {
  if (value === null || value === undefined) return false;
  const kind = typeof value;
  if (kind !== 'object' && kind !== 'function') return false;
  try {
    return value[STUB_TAG] === true;
  } catch (e) {
    return false;
  }
}

module.exports = { universalStub, isStub, STUB_TAG };
