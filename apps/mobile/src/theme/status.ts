import { type DebtDisplayStatus } from '@bonchi/domain';
import { type MessageKey } from '@bonchi/localization';
import { type ColorScheme } from './tokens';

/**
 * Status presentation.
 *
 * Each status carries three independent signals — colour, glyph and translated
 * label — so it is legible to someone who cannot distinguish the colours, and
 * under sunlight where subtle hues wash out. Nothing in the UI may render a
 * status using `foreground` alone.
 */
export interface StatusVisual {
  readonly labelKey: MessageKey;
  /** Text glyph, not an icon font: renders identically everywhere and costs nothing. */
  readonly glyph: string;
  readonly foreground: keyof ColorScheme;
  readonly background: keyof ColorScheme;
}

const VISUALS: Readonly<Record<DebtDisplayStatus, StatusVisual>> = Object.freeze({
  OVERDUE: {
    labelKey: 'status.overdue',
    glyph: '!',
    foreground: 'overdue',
    background: 'overdueSubtle',
  },
  DUE_TODAY: {
    labelKey: 'status.dueToday',
    glyph: '●',
    foreground: 'dueToday',
    background: 'dueTodaySubtle',
  },
  DUE_SOON: {
    labelKey: 'status.dueSoon',
    glyph: '◗',
    foreground: 'dueSoon',
    background: 'dueSoonSubtle',
  },
  PARTIALLY_PAID: {
    labelKey: 'status.partiallyPaid',
    glyph: '◐',
    foreground: 'partial',
    background: 'partialSubtle',
  },
  UPCOMING: {
    labelKey: 'status.upcoming',
    glyph: '○',
    foreground: 'neutralStatus',
    background: 'neutralStatusSubtle',
  },
  NO_DUE_DATE: {
    labelKey: 'status.noDueDate',
    glyph: '–',
    foreground: 'neutralStatus',
    background: 'neutralStatusSubtle',
  },
  PAID: {
    labelKey: 'status.paid',
    glyph: '✓',
    foreground: 'paid',
    background: 'paidSubtle',
  },
  REVERSED: {
    labelKey: 'status.reversed',
    glyph: '⊘',
    foreground: 'reversed',
    background: 'reversedSubtle',
  },
});

export function statusVisual(status: DebtDisplayStatus): StatusVisual {
  return VISUALS[status] ?? VISUALS.NO_DUE_DATE;
}

/** Every status has a distinct glyph — asserted by the theme test. */
export function allStatusVisuals(): Readonly<Record<DebtDisplayStatus, StatusVisual>> {
  return VISUALS;
}
