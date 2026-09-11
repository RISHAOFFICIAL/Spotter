/** expo-notifications stub for the Node smoke harness. The DEV path of the
 * app never calls the OS APIs (notifications.ts returns a mocked grant before
 * it would touch expo-notifications), but pushRegistration.ts imports the
 * module at the top level, so the require must resolve. The stub surfaces the
 * API shape the lib uses so a REAL-mode test would still compile. */
const mock = {
  getPermissionsAsync: async () => ({ status: 'undetermined' }),
  requestPermissionsAsync: async () => ({ status: 'granted' }),
  getExpoPushTokenAsync: async () => ({ data: 'smoke-expo-token' }),
  setNotificationChannelAsync: async () => null,
  setNotificationHandler: async () => null,
};
module.exports = mock;