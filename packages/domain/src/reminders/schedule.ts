import {
  type PlainDate,
  addDays,
  comparePlainDate,
  zonedDateTimeToUtc,
} from '../time/plainDate';

/**
 * Reminder scheduling.
 *
 * Reminders are notifications to the MERCHANT — "Sok Dara's 50,000៛ is due
 * tomorrow" — not messages sent to customers. Nothing is ever delivered to a
 * customer without the merchant explicitly sharing it (see templates.ts).
 */

export const REMINDER_KINDS = ['DAY_BEFORE', 'ON_DUE_DATE', 'OVERDUE_FOLLOW_UP', 'CUSTOM'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export interface ReminderPreferences {
  readonly dayBeforeEnabled: boolean;
  readonly onDueDateEnabled: boolean;
  readonly overdueFollowUpEnabled: boolean;
  /** Local hour (0-23) at which reminders fire in the organization timezone. */
  readonly reminderHour: number;
  readonly reminderMinute: number;
  /** Days after the due date to follow up on an unpaid debt. */
  readonly overdueFollowUpDays: readonly number[];
}

export const DEFAULT_REMINDER_PREFERENCES: ReminderPreferences = Object.freeze({
  dayBeforeEnabled: true,
  onDueDateEnabled: true,
  overdueFollowUpEnabled: true,
  // 08:00 local: shops are opening and the merchant can act on it the same day.
  reminderHour: 8,
  reminderMinute: 0,
  overdueFollowUpDays: Object.freeze([1, 7]),
});

export interface ScheduledReminder {
  readonly kind: ReminderKind;
  readonly transactionId: string;
  /** The merchant-local day the reminder belongs to. */
  readonly onDate: PlainDate;
  /** The exact UTC instant to hand to the OS scheduler. */
  readonly fireAt: Date;
}

export interface BuildReminderScheduleInput {
  readonly transactionId: string;
  readonly dueAt: PlainDate | null;
  readonly timeZone: string;
  readonly preferences?: ReminderPreferences;
  /** Reminders already in the past are not scheduled. */
  readonly now: Date;
  readonly customDate?: PlainDate | null;
}

/**
 * Builds the notification schedule for one debt.
 *
 * A debt with no due date gets no reminders — there is nothing to remind about,
 * and inventing a date would be the app nagging on the merchant's behalf.
 * Reminders already in the past are skipped rather than fired immediately, which
 * is what a naive scheduler does when a merchant back-dates a debt.
 */
export function buildReminderSchedule(input: BuildReminderScheduleInput): ScheduledReminder[] {
  const {
    transactionId,
    dueAt,
    timeZone,
    preferences = DEFAULT_REMINDER_PREFERENCES,
    now,
    customDate,
  } = input;

  const reminders: ScheduledReminder[] = [];

  const push = (kind: ReminderKind, onDate: PlainDate): void => {
    const fireAt = zonedDateTimeToUtc(
      onDate,
      { hour: preferences.reminderHour, minute: preferences.reminderMinute },
      timeZone,
    );
    if (fireAt.getTime() <= now.getTime()) return;
    reminders.push({ kind, transactionId, onDate, fireAt });
  };

  if (customDate) push('CUSTOM', customDate);

  if (dueAt) {
    if (preferences.dayBeforeEnabled) push('DAY_BEFORE', addDays(dueAt, -1));
    if (preferences.onDueDateEnabled) push('ON_DUE_DATE', dueAt);
    if (preferences.overdueFollowUpEnabled) {
      for (const offset of preferences.overdueFollowUpDays) {
        if (offset <= 0) continue;
        push('OVERDUE_FOLLOW_UP', addDays(dueAt, offset));
      }
    }
  }

  reminders.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return reminders;
}

/**
 * Reminders that must be cancelled.
 *
 * Called whenever a debt reaches zero or is reversed. A merchant being reminded
 * to chase money the customer already paid is the fastest way to lose their
 * trust in the app, so this is treated as part of the payment write path rather
 * than as cleanup.
 */
export function remindersToCancel(
  scheduled: readonly ScheduledReminder[],
  settledTransactionIds: readonly string[],
): ScheduledReminder[] {
  const settled = new Set(settledTransactionIds);
  return scheduled.filter((reminder) => settled.has(reminder.transactionId));
}

/** Reminders whose day has already passed and which the OS will never fire. */
export function staleReminders(
  scheduled: readonly ScheduledReminder[],
  today: PlainDate,
): ScheduledReminder[] {
  return scheduled.filter((reminder) => comparePlainDate(reminder.onDate, today) < 0);
}

export function isValidReminderHour(hour: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour <= 23;
}

export function isValidReminderMinute(minute: number): boolean {
  return Number.isInteger(minute) && minute >= 0 && minute <= 59;
}
