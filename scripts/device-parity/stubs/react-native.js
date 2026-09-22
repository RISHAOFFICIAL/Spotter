'use strict';
/**
 * Device-parity stand-in for `react-native` (Platform.OS === 'ios', release).
 *
 * The old smoke harness replaced react-native with a stub whose Platform.OS was
 * 'web', so every `Platform.OS === 'ios'` branch in the app took the web path and
 * real-mode never exercised the iOS branch of src/lib/supabase.ts
 * (`Platform.OS === 'web' ? webStorageAdapter() : secureStoreAdapter`).
 *
 * What is faithful here (evidence in README.md):
 *  - Platform.OS / Platform.Version / Platform.constants shaped like RN 0.86 on
 *    an iPhone (react-native/Libraries/Utilities/Platform.ios.js).
 *  - Platform.select() semantics (RN's implementation).
 *  - NativeModules / TurboModuleRegistry backed by the native-module registry
 *    read out of the built app binaries (stubs/device-native-modules.json): a
 *    name the shipped app registers resolves to a permissive stub, a name it does
 *    not register resolves like RN does (get -> null, getEnforcing -> throw).
 *
 * What is NOT faithful: component behaviour, layout, and any native API result.
 * Components render nothing; module methods are permissive stubs. See README.
 */

const fs = require('fs');
const path = require('path');
const { universalStub } = require('./generic.cjs');

const DEVICE_MODULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'device-native-modules.json'), 'utf8'),
);
// `flagged` names are treated as registered too (their literal is simply
// invisible to a byte scan); the harness must not manufacture a missing-module
// throw. See device-native-modules.json.
const REGISTERED = new Set([
  ...DEVICE_MODULES.registered,
  ...Object.keys(DEVICE_MODULES.flagged || {}),
]);

// --- Platform (react-native/Libraries/Utilities/Platform.ios.js shape) --------
const Platform = {
  __constants: null,
  OS: 'ios',
  Version: '18.5',
  isPad: false,
  isTV: false,
  isVision: false,
  isTesting: false,
  isMacCatalyst: false,
  constants: {
    forceTouchAvailable: false,
    interfaceIdiom: 'phone',
    isTesting: false,
    osVersion: '18.5',
    reactNativeVersion: { major: 0, minor: 86, patch: 3, prerelease: null },
    systemName: 'iOS',
  },
  select(spec) {
    if (spec == null) return spec;
    if (Object.prototype.hasOwnProperty.call(spec, 'ios')) return spec.ios;
    if (Object.prototype.hasOwnProperty.call(spec, 'native')) return spec.native;
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) return spec.default;
    return undefined;
  },
};

// --- Components: render nothing ----------------------------------------------
function component(name) {
  const C = function (props) {
    return props && props.children !== undefined ? props.children : null;
  };
  Object.defineProperty(C, 'name', { value: name, configurable: true });
  return C;
}

const COMPONENTS = [
  'View', 'Text', 'Image', 'ImageBackground', 'ScrollView', 'FlatList', 'SectionList',
  'VirtualizedList', 'Pressable', 'TouchableOpacity', 'TouchableHighlight',
  'TouchableWithoutFeedback', 'TouchableNativeFeedback', 'SafeAreaView',
  'KeyboardAvoidingView', 'Modal', 'Switch', 'ActivityIndicator', 'RefreshControl',
  'StatusBar', 'TextInput', 'Button', 'InputAccessoryView', 'RootTag', 'AccessibilityInfo',
];

const NativeModules = {};
for (const name of DEVICE_MODULES.registered) NativeModules[name] = universalStub('NativeModules.' + name);

const TurboModuleRegistry = {
  get(name) {
    return REGISTERED.has(name) ? universalStub('TurboModule.' + name) : null;
  },
  getEnforcing(name) {
    if (REGISTERED.has(name)) return universalStub('TurboModule.' + name);
    // RN's own wording (Libraries/TurboModule/TurboModuleRegistry.js)
    throw new Error(
      "TurboModuleRegistry.getEnforcing(...): '" +
        name +
        "' could not be found. Verify that a module by this name is registered in the native binary.",
    );
  },
};

const PlatformConstants = { getConstants: () => Platform.constants };

const RN = {
  Platform,
  PlatformConstants,
  TurboModuleRegistry,
  NativeModules,
  NativeEventEmitter: function NativeEventEmitter() {
    return { addListener: () => ({ remove() {} }), removeAllListeners() {}, removeSubscription() {} };
  },
  DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit() {}, removeAllListeners() {} },
  NativeComponentRegistry: { get: (n) => component('Native(' + n + ')') },
  requireNativeComponent: (n) => component('Native(' + n + ')'),
  codegenNativeComponent: (n) => component('Native(' + n + ')'),
  codegenNativeCommands: () => universalStub('codegenNativeCommands'),
  StyleSheet: {
    create: (styles) => styles,
    flatten: (s) => (Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s || {}),
    compose: (a, b) => [a, b],
    absoluteFill: {},
    absoluteFillObject: {},
    hairlineWidth: 0.5,
  },
  PixelRatio: {
    get: () => 3,
    getFontScale: () => 1,
    getPixelSizeForLayoutSize: (n) => Math.round(n * 3),
    roundToNearestPixel: (n) => n,
  },
  Dimensions: {
    get: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    addEventListener: () => ({ remove() {} }),
    set: () => {},
  },
  useWindowDimensions: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
  useColorScheme: () => 'light',
  Appearance: {
    getColorScheme: () => 'light',
    addChangeListener: () => ({ remove() {} }),
    setColorScheme: () => {},
  },
  useAnimatedValue: (initial) => ({ _value: initial, setValue() {}, addListener() {}, removeListener() {} }),
  Animated: {
    Value: function Value(v) {
      return {
        _value: v,
        setValue() {},
        addListener() {},
        removeListener() {},
        interpolate() {
          return { _value: v };
        },
      };
    },
    timing: () => ({ start: (cb) => cb && cb({ finished: true }), stop() {} }),
    spring: () => ({ start: (cb) => cb && cb({ finished: true }), stop() {} }),
    parallel: () => ({ start: (cb) => cb && cb({ finished: true }), stop() {} }),
    sequence: () => ({ start: (cb) => cb && cb({ finished: true }), stop() {} }),
    loop: () => ({ start() {}, stop() {} }),
    createAnimatedComponent: (C) => C,
    View: component('Animated.View'),
    Text: component('Animated.Text'),
    Image: component('Animated.Image'),
    ScrollView: component('Animated.ScrollView'),
    add() {},
    event() {
      return () => {};
    },
  },
  Easing: universalStub('Easing'),
  InteractionManager: {
    runAfterInteractions: (cb) => {
      if (typeof cb === 'function') cb();
      return { cancel() {} };
    },
    createInteractionHandle: () => 1,
    clearInteractionHandle() {},
  },
  I18nManager: { isRTL: false, doLeftAndRightSwapInRTL: false, allowRTL() {}, forceRTL() {} },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
  Linking: {
    openURL: async () => true,
    canOpenURL: async () => true,
    getInitialURL: async () => null,
    addEventListener: () => ({ remove() {} }),
  },
  Alert: { alert() {}, prompt() {} },
  Share: { share: async () => ({ action: 'dismissedAction' }) },
  ActionSheetIOS: universalStub('ActionSheetIOS'),
  Vibration: { vibrate() {}, cancel() {} },
  BackHandler: { addEventListener: () => ({ remove() {} }), exitApp() {} },
  PermissionsAndroid: universalStub('PermissionsAndroid'),
  AccessibilityInfo: { isScreenReaderEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  AppRegistry: { registerComponent() {}, runApplication() {} },
  LogBox: { ignoreLogs() {}, ignoreAllLogs() {}, install() {}, uninstall() {} },
  DevSettings: { addMenuItem() {}, reload() {} },
  findNodeHandle: () => null,
  processColor: (c) => c,
  DynamicColorIOS: (c) => c,
  PlatformColor: (c) => c,
  useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
  UIManager: universalStub('UIManager'),
  PanResponder: universalStub('PanResponder'),
  NativeAppEventEmitter: { addListener: () => ({ remove() {} }) },
};

for (const name of COMPONENTS) RN[name] = component(name);

// Anything a real package reaches for that is not listed above resolves to a
// permissive stub instead of `undefined`, so a missing entry here cannot fake a
// crash. It is recorded by the loader as a react-native surface gap.
module.exports = new Proxy(RN, {
  get(t, prop) {
    if (prop in t) return t[prop];
    if (typeof prop === 'symbol') return undefined;
    if (prop === 'default') return module.exports;
    if (prop === '__esModule') return true;
    if (!t.__parityGaps) Object.defineProperty(t, '__parityGaps', { value: [], enumerable: false });
    if (!t.__parityGaps.includes(String(prop))) t.__parityGaps.push(String(prop));
    return universalStub('react-native.' + String(prop));
  },
});
