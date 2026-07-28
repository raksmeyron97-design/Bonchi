import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Localization from 'expo-localization';
import {
  DEFAULT_LOCALE,
  type Locale,
  type Translator,
  createTranslator,
  resolveLocale,
} from '@bonchi/localization';
import { DEFAULT_TIMEZONE, resolveTimeZone } from '@bonchi/domain';
import { type Theme, darkTheme, lightTheme } from '../theme/tokens';
import { getDatabase } from '../db/client';
import { loadPersistedSession } from '../lib/session';

/**
 * Application-wide providers.
 *
 * Three things every screen needs: the active theme, the translator, and the
 * merchant's session context (which organization, which shop, which timezone).
 * They are separate contexts so a theme change does not re-render every screen
 * that only reads the locale.
 */

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const ThemeContext = createContext<Theme>(lightTheme);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

interface LocalizationValue {
  readonly locale: Locale;
  readonly t: Translator['t'];
  readonly tCount: Translator['tCount'];
  readonly translator: Translator;
  readonly setLocale: (locale: Locale) => void;
}

const LocalizationContext = createContext<LocalizationValue | null>(null);

export function useI18n(): LocalizationValue {
  const value = useContext(LocalizationContext);
  if (!value) {
    throw new Error('useI18n must be used inside <AppProviders>.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionContextValue {
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly shopId: string | null;
  readonly deviceId: string | null;
  readonly timeZone: string;
  readonly role: 'OWNER' | 'MANAGER' | 'CASHIER' | 'VIEWER';
  readonly isReady: boolean;
  readonly setSession: (session: Partial<SessionContextValue>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <AppProviders>.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Query client
// ---------------------------------------------------------------------------

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Reads come from SQLite, which is always available and always current
        // for this device. Nothing here should retry against a network.
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
      },
      mutations: {
        // Writes go to SQLite and the outbox; the sync engine owns retrying.
        retry: false,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AppProvidersProps {
  readonly children: React.ReactNode;
  /** Overrides for tests. */
  readonly initialLocale?: Locale;
  readonly initialSession?: Partial<SessionContextValue>;
}

export function AppProviders({
  children,
  initialLocale,
  initialSession,
}: AppProvidersProps): React.ReactElement {
  const colorScheme = useColorScheme();
  const [queryClient] = useState(createQueryClient);

  // Khmer is the default. A device set to Khmer gets Khmer; anything else
  // unsupported also gets Khmer, because the target user is Cambodian and an
  // English fallback would be the wrong guess.
  const [locale, setLocale] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    const deviceLocale = Localization.getLocales()[0]?.languageTag;
    return resolveLocale(deviceLocale ?? DEFAULT_LOCALE);
  });

  const [session, setSessionState] = useState<
    Omit<SessionContextValue, 'setSession' | 'isReady'> & { isReady: boolean }
  >(() => ({
    userId: initialSession?.userId ?? null,
    organizationId: initialSession?.organizationId ?? null,
    shopId: initialSession?.shopId ?? null,
    deviceId: initialSession?.deviceId ?? null,
    timeZone: resolveTimeZone(
      initialSession?.timeZone ?? Localization.getCalendars()[0]?.timeZone ?? DEFAULT_TIMEZONE,
    ),
    role: initialSession?.role ?? 'OWNER',
    isReady: initialSession?.isReady ?? false,
  }));

  const theme = useMemo<Theme>(
    () => (colorScheme === 'dark' ? darkTheme : lightTheme),
    [colorScheme],
  );

  const translator = useMemo(
    () =>
      createTranslator(locale, {
        onMissingKey: (key) => {
          if (__DEV__) {
            // Loud in development, silent in production: a missing string must
            // never crash a merchant mid-transaction.
            console.warn(`[i18n] missing translation key: ${key}`);
          }
        },
      }),
    [locale],
  );

  const setSession = useCallback((next: Partial<SessionContextValue>) => {
    setSessionState((current) => ({ ...current, ...next }));
  }, []);

  const localizationValue = useMemo<LocalizationValue>(
    () => ({
      locale,
      t: translator.t,
      tCount: translator.tCount,
      translator,
      setLocale,
    }),
    [locale, translator],
  );

  const sessionValue = useMemo<SessionContextValue>(
    () => ({ ...session, setSession }),
    [session, setSession],
  );

  // Hydrate identity from SQLite once, on mount.
  //
  // Screens read the session context, not app_state, so without this the context
  // stays empty even though SQLite holds the right values — and an empty deviceId
  // makes every idempotency key fail to build. Doing it here rather than in each
  // screen means there is exactly one place identity is loaded.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const database = await getDatabase();
      const persisted = await loadPersistedSession(database);
      if (cancelled) return;

      setSessionState((current) => ({
        ...current,
        userId: persisted.userId ?? current.userId,
        organizationId: persisted.organizationId ?? current.organizationId,
        shopId: persisted.shopId ?? current.shopId,
        // Always adopt the persisted device id: it is created on first run and
        // must never change for the life of the install.
        deviceId: persisted.deviceId,
        isReady: true,
      }));

      // A language the merchant chose explicitly outranks the device's setting.
      if (persisted.locale === 'km' || persisted.locale === 'en') {
        setLocale(persisted.locale);
      }
    })().catch((error: unknown) => {
      if (__DEV__) console.error('[session] could not hydrate from local storage', error);
      // Mark ready anyway: a screen blocked forever on hydration is worse than one
      // that renders and reports a specific failure when it tries to write.
      if (!cancelled) setSessionState((current) => ({ ...current, isReady: true }));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeContext.Provider value={theme}>
        <LocalizationContext.Provider value={localizationValue}>
          <SessionContext.Provider value={sessionValue}>{children}</SessionContext.Provider>
        </LocalizationContext.Provider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
}
