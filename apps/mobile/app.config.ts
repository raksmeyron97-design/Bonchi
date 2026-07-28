import { type ExpoConfig } from 'expo/config';

/**
 * Expo configuration.
 *
 * Permission notes, because this app handles sensitive debt records:
 *
 *  - No CONTACTS permission is declared. Contact import is behind a feature flag
 *    and, when built, will use the system picker so only the one contact the
 *    merchant selects is ever read.
 *  - No location, SMS-read, microphone or call-log permissions. None of them are
 *    needed to keep a ledger, and each would be an invitation to misuse.
 *  - Notification permission is requested contextually, when the merchant enables
 *    reminders, never at first launch.
 */

const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV ?? 'local';
const IS_PRODUCTION = APP_ENV === 'production';

const config: ExpoConfig = {
  name: IS_PRODUCTION ? 'Bonchi' : `Bonchi (${APP_ENV})`,
  slug: 'bonchi',
  scheme: 'bonchi',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // Android-first: this is the platform the target merchants actually carry.
  primaryColor: '#0F766E',
  assetBundlePatterns: ['**/*'],

  android: {
    package: IS_PRODUCTION ? 'kh.bonchi.app' : `kh.bonchi.app.${APP_ENV}`,
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: '#0F766E',
    },
    // Deliberately minimal. Notifications are requested at runtime.
    permissions: ['android.permission.POST_NOTIFICATIONS', 'android.permission.USE_BIOMETRIC'],
    blockedPermissions: [
      'android.permission.READ_CONTACTS',
      'android.permission.WRITE_CONTACTS',
      'android.permission.READ_SMS',
      'android.permission.RECEIVE_SMS',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.RECORD_AUDIO',
      'android.permission.READ_CALL_LOG',
    ],
    // Low-end devices are the target. Do not opt into anything that raises the
    // minimum requirements.
    softwareKeyboardLayoutMode: 'pan',
  },

  ios: {
    bundleIdentifier: IS_PRODUCTION ? 'kh.bonchi.app' : `kh.bonchi.app.${APP_ENV}`,
    supportsTablet: true,
    infoPlist: {
      // Khmer text needs the full script; ensure no ASCII-only fallback.
      CFBundleAllowMixedLocalizations: true,
      NSFaceIDUsageDescription:
        'Bonchi uses Face ID to unlock your shop records so only you can open them.',
    },
  },

  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    [
      'expo-sqlite',
      {
        // The ledger is the app's operational store; enable the FTS module used by
        // offline customer search.
        enableFTS: true,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'Bonchi asks for photo access only when you choose to attach a receipt or product photo to a record.',
        cameraPermission:
          'Bonchi uses the camera only when you choose to photograph a receipt or product.',
      },
    ],
    [
      'expo-local-authentication',
      {
        faceIDPermission: 'Bonchi uses Face ID to unlock your shop records.',
      },
    ],
    [
      'expo-splash-screen',
      {
        backgroundColor: '#0F766E',
        resizeMode: 'contain',
      },
    ],
  ],

  experiments: {
    typedRoutes: true,
  },

  extra: {
    appEnv: APP_ENV,
    eas: {
      // Filled in by `eas init`. Documented in docs/deployment/mobile-release.md.
      projectId: process.env.EAS_PROJECT_ID ?? undefined,
    },
  },
};

export default config;
