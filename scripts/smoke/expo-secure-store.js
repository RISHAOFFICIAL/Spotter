/** In-memory SecureStore for the Node harness — mirrors expo-secure-store
 * getItemAsync/setItemAsync/deleteItemAsync. Shared with AsyncStorage
 * state so sessions written by the app's supabase.ts DEV path are readable
 * in the harness (and vice versa). */
const { getItem, setItem, removeItem } = require('./async-storage');
module.exports = {
  getItemAsync: (key) => getItem('sec:' + key),
  setItemAsync: (key, value) => setItem('sec:' + key, value),
  deleteItemAsync: (key) => removeItem('sec:' + key),
};