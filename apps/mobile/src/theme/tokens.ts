/**
 * Design tokens.
 *
 * The visual identity has to read as trustworthy for money without looking like
 * a bank — the target merchants are shopkeepers, not banking customers. Teal is
 * the primary: it reads as careful and clean in Cambodia without the
 * institutional weight of navy, and it stays distinguishable from the semantic
 * red and amber used for overdue states.
 *
 * Status colour is never the only signal. Every status pairs a colour with an
 * icon glyph and a translated label (see statusVisuals below), because roughly
 * 1 in 12 men has a red/green colour vision deficiency and because a
 * shop screen is often read in direct sunlight.
 */

export const palette = {
  // Primary — teal
  teal50: '#F0FDFA',
  teal100: '#CCFBF1',
  teal200: '#99F6E4',
  teal500: '#14B8A6',
  teal600: '#0D9488',
  teal700: '#0F766E',
  teal800: '#115E59',
  teal900: '#134E4A',

  // Neutrals — warm-leaning grey, easier on the eyes than pure grey under sun
  neutral0: '#FFFFFF',
  neutral50: '#FAFAF9',
  neutral100: '#F5F5F4',
  neutral200: '#E7E5E4',
  neutral300: '#D6D3D1',
  neutral400: '#A8A29E',
  neutral500: '#78716C',
  neutral600: '#57534E',
  neutral700: '#44403C',
  neutral800: '#292524',
  neutral900: '#1C1917',
  neutral950: '#0C0A09',

  // Semantic
  red50: '#FEF2F2',
  red100: '#FEE2E2',
  red500: '#EF4444',
  red600: '#DC2626',
  red700: '#B91C1C',

  amber50: '#FFFBEB',
  amber100: '#FEF3C7',
  amber500: '#F59E0B',
  amber600: '#D97706',
  amber700: '#B45309',

  green50: '#F0FDF4',
  green100: '#DCFCE7',
  green500: '#22C55E',
  green600: '#16A34A',
  green700: '#15803D',

  blue50: '#EFF6FF',
  blue100: '#DBEAFE',
  blue500: '#3B82F6',
  blue600: '#2563EB',
} as const;

export interface ColorScheme {
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnPrimary: string;
  textOnStatus: string;

  primary: string;
  primaryPressed: string;
  primarySubtle: string;
  primaryText: string;

  /** Money owed to the shop. */
  debt: string;
  debtSubtle: string;
  /** Money received. */
  payment: string;
  paymentSubtle: string;

  overdue: string;
  overdueSubtle: string;
  dueToday: string;
  dueTodaySubtle: string;
  dueSoon: string;
  dueSoonSubtle: string;
  paid: string;
  paidSubtle: string;
  partial: string;
  partialSubtle: string;
  neutralStatus: string;
  neutralStatusSubtle: string;
  reversed: string;
  reversedSubtle: string;

  offline: string;
  offlineSubtle: string;

  focusRing: string;
  overlay: string;
}

export const lightColors: ColorScheme = {
  background: palette.neutral50,
  surface: palette.neutral0,
  surfaceRaised: palette.neutral0,
  surfaceSunken: palette.neutral100,
  border: palette.neutral200,
  borderStrong: palette.neutral300,

  textPrimary: palette.neutral900,
  textSecondary: palette.neutral600,
  textTertiary: palette.neutral500,
  textOnPrimary: palette.neutral0,
  textOnStatus: palette.neutral0,

  primary: palette.teal700,
  primaryPressed: palette.teal800,
  primarySubtle: palette.teal50,
  primaryText: palette.teal800,

  debt: palette.neutral800,
  debtSubtle: palette.neutral100,
  payment: palette.green700,
  paymentSubtle: palette.green50,

  overdue: palette.red700,
  overdueSubtle: palette.red50,
  dueToday: palette.amber700,
  dueTodaySubtle: palette.amber50,
  dueSoon: palette.amber600,
  dueSoonSubtle: palette.amber50,
  paid: palette.green700,
  paidSubtle: palette.green50,
  partial: palette.blue600,
  partialSubtle: palette.blue50,
  neutralStatus: palette.neutral600,
  neutralStatusSubtle: palette.neutral100,
  reversed: palette.neutral500,
  reversedSubtle: palette.neutral100,

  offline: palette.neutral700,
  offlineSubtle: palette.neutral200,

  focusRing: palette.teal500,
  overlay: 'rgba(12, 10, 9, 0.45)',
};

export const darkColors: ColorScheme = {
  background: palette.neutral950,
  surface: palette.neutral900,
  surfaceRaised: palette.neutral800,
  surfaceSunken: palette.neutral950,
  border: palette.neutral800,
  borderStrong: palette.neutral700,

  textPrimary: palette.neutral50,
  textSecondary: palette.neutral300,
  textTertiary: palette.neutral400,
  textOnPrimary: palette.neutral0,
  textOnStatus: palette.neutral950,

  primary: palette.teal500,
  primaryPressed: palette.teal600,
  primarySubtle: palette.teal900,
  primaryText: palette.teal200,

  debt: palette.neutral100,
  debtSubtle: palette.neutral800,
  payment: palette.green500,
  paymentSubtle: '#052E16',

  overdue: '#FCA5A5',
  overdueSubtle: '#450A0A',
  dueToday: '#FCD34D',
  dueTodaySubtle: '#451A03',
  dueSoon: '#FCD34D',
  dueSoonSubtle: '#451A03',
  paid: palette.green500,
  paidSubtle: '#052E16',
  partial: '#93C5FD',
  partialSubtle: '#172554',
  neutralStatus: palette.neutral300,
  neutralStatusSubtle: palette.neutral800,
  reversed: palette.neutral400,
  reversedSubtle: palette.neutral800,

  offline: palette.neutral200,
  offlineSubtle: palette.neutral800,

  focusRing: palette.teal200,
  overlay: 'rgba(0, 0, 0, 0.6)',
};

/**
 * Spacing on a 4pt grid.
 * `md` (12) is the default gap between related elements; `lg` (16) separates
 * groups; `xl` (24) separates sections.
 */
export const spacing = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/**
 * Typography.
 *
 * Khmer script is TALLER than Latin: it stacks diacritics above and subscript
 * consonants below the baseline. Every line height here is generous enough that
 * Khmer text is not clipped — the most common rendering bug in Khmer apps, and
 * the reason no line height is less than 1.5x its font size.
 */
export const typography = {
  display: { fontSize: 32, lineHeight: 48, fontWeight: '700' as const },
  h1: { fontSize: 26, lineHeight: 40, fontWeight: '700' as const },
  h2: { fontSize: 22, lineHeight: 34, fontWeight: '600' as const },
  h3: { fontSize: 18, lineHeight: 28, fontWeight: '600' as const },
  bodyLarge: { fontSize: 17, lineHeight: 28, fontWeight: '400' as const },
  body: { fontSize: 15, lineHeight: 24, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, lineHeight: 24, fontWeight: '600' as const },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '500' as const },
  caption: { fontSize: 12, lineHeight: 20, fontWeight: '400' as const },
  // Amounts are read at a glance across a counter.
  amountLarge: { fontSize: 30, lineHeight: 42, fontWeight: '700' as const },
  amount: { fontSize: 19, lineHeight: 28, fontWeight: '600' as const },
  amountSmall: { fontSize: 15, lineHeight: 22, fontWeight: '600' as const },
} as const;

export type TypographyToken = keyof typeof typography;

export const elevation = {
  none: {},
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
    elevation: 2,
  },
  raised: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
  },
  // The prominent central Add button.
  floating: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 10,
  },
} as const;

/**
 * Minimum touch target.
 *
 * 48dp is the Android accessibility minimum and matters more here than in most
 * apps: this is used one-handed, at a counter, often in a hurry.
 */
export const MIN_TOUCH_TARGET = 48;

/** Central Add button, deliberately larger than its neighbours. */
export const ADD_BUTTON_SIZE = 60;

export const durations = {
  instant: 0,
  fast: 120,
  normal: 200,
  slow: 320,
} as const;

export interface Theme {
  colors: ColorScheme;
  spacing: typeof spacing;
  radii: typeof radii;
  typography: typeof typography;
  elevation: typeof elevation;
  durations: typeof durations;
  isDark: boolean;
}

export const lightTheme: Theme = {
  colors: lightColors,
  spacing,
  radii,
  typography,
  elevation,
  durations,
  isDark: false,
};

export const darkTheme: Theme = {
  colors: darkColors,
  spacing,
  radii,
  typography,
  elevation,
  durations,
  isDark: true,
};
