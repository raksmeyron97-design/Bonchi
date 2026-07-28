// Test environment shims for native modules the app touches at import time.
//
// Each mock here stands in for a device capability that does not exist in Jest.
// The logic that matters — money, balances, sync-state transitions — is pure and
// lives in @bonchi/domain, so these mocks stay deliberately thin.

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key);
    }),
    isAvailableAsync: jest.fn(async () => true),
    __store: store,
  };
});

jest.mock('expo-crypto', () => ({
  getRandomBytes: (length) => {
    // Deterministic in tests; the real module is cryptographically secure.
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (index * 37 + 11) % 256;
    }
    return bytes;
  },
  digestStringAsync: jest.fn(async (_algorithm, value) => `digest:${value}`),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => () => {}),
  fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true, type: 'wifi' })),
}));

jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  setNotificationHandler: jest.fn(),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'km', languageTag: 'km-KH' }],
  getCalendars: () => [{ timeZone: 'Asia/Phnom_Penh' }],
}));

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '0.1.0',
  nativeBuildVersion: '1',
}));
