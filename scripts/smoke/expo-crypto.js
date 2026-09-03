/** Deterministic-ish crypto for the Node harness (expo-crypto API subset). */
let counter = 0;
module.exports = {
  randomUUID() {
    counter += 1;
    return `smoke-${Date.now().toString(36)}-${counter}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  },
  getRandomBytes(len) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  },
};