/** The lib layer imports Platform from react-native; the smoke harness runs
 * in Node with no actual React Native runtime, so this is a minimal stand-in
 * that satisfies the import surface used by src/lib (dev-mode only: the
 * real-mode branch of the app is not part of the dev-mock smoke flow). */
module.exports = {
  Platform: { OS: 'web', select: (obj) => obj.web ?? obj.default },
};