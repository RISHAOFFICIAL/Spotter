/**
 * In-memory AsyncStorage for the Node smoke harness (mirrors the RN API
 * surface the app uses: getItem/setItem/removeItem/getAllKeys). Keys are
 * namespaced with the test's store prefix so each run starts clean.
 */
const store = new Map();
let prefix = 'default';
module.exports = {
  setPrefix(p) {
    prefix = p;
  },
  clearAll() {
    store.clear();
  },
  getItem: async (key) => (store.has(prefix + ':' + key) ? store.get(prefix + ':' + key) : null),
  setItem: async (key, value) => {
    store.set(prefix + ':' + key, String(value));
  },
  removeItem: async (key) => {
    store.delete(prefix + ':' + key);
  },
  getAllKeys: async () => {
    const keys = [];
    for (const k of store.keys()) {
      if (k.startsWith(prefix + ':')) keys.push(k.slice(prefix.length + 1));
    }
    return keys;
  },
  _raw: store,
};