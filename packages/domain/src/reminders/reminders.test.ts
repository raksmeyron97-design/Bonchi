import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_PREFERENCES,
  buildReminderSchedule,
  isValidReminderHour,
  isValidReminderMinute,
  remindersToCancel,
  staleReminders,
} from './schedule';
import {
  REMINDER_TEMPLATES,
  assertTemplatesArePolite,
  composeReminderMessage,
  containsProhibitedLanguage,
  findReminderTemplate,
  formatDueDateForMessage,
} from './templates';

const TZ = 'Asia/Phnom_Penh';
const NOW = new Date('2026-07-27T03:00:00.000Z'); // 10:00 local on the 27th

describe('buildReminderSchedule', () => {
  it('schedules day-before, due-date and follow-up reminders', () => {
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
    });

    expect(reminders.map((reminder) => [reminder.kind, reminder.onDate])).toEqual([
      ['DAY_BEFORE', '2026-08-09'],
      ['ON_DUE_DATE', '2026-08-10'],
      ['OVERDUE_FOLLOW_UP', '2026-08-11'],
      ['OVERDUE_FOLLOW_UP', '2026-08-17'],
    ]);
  });

  it('fires at the configured local hour, expressed in UTC', () => {
    const [first] = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
    });
    // 08:00 in Phnom Penh on 9 August is 01:00Z the same day.
    expect(first?.fireAt.toISOString()).toBe('2026-08-09T01:00:00.000Z');
  });

  it('honours a custom reminder hour', () => {
    const [first] = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
      preferences: { ...DEFAULT_REMINDER_PREFERENCES, reminderHour: 18, reminderMinute: 30 },
    });
    expect(first?.fireAt.toISOString()).toBe('2026-08-09T11:30:00.000Z');
  });

  it('schedules nothing for a debt with no due date', () => {
    expect(
      buildReminderSchedule({ transactionId: 'd1', dueAt: null, timeZone: TZ, now: NOW }),
    ).toEqual([]);
  });

  it('skips reminders that are already in the past', () => {
    // Due yesterday: the day-before and due-date reminders can never fire.
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-07-26',
      timeZone: TZ,
      now: NOW,
    });
    expect(reminders.map((reminder) => reminder.onDate)).toEqual(['2026-08-02']);
  });

  it('skips a reminder whose local time today has already passed', () => {
    // 08:00 local today is behind us at 10:00 local.
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-07-28',
      timeZone: TZ,
      now: NOW,
    });
    expect(reminders.some((reminder) => reminder.onDate === '2026-07-27')).toBe(false);
    expect(reminders.some((reminder) => reminder.onDate === '2026-07-28')).toBe(true);
  });

  it('respects each preference toggle', () => {
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
      preferences: {
        ...DEFAULT_REMINDER_PREFERENCES,
        dayBeforeEnabled: false,
        overdueFollowUpEnabled: false,
      },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.kind).toBe('ON_DUE_DATE');
  });

  it('schedules a custom reminder date', () => {
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: null,
      timeZone: TZ,
      now: NOW,
      customDate: '2026-08-01',
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.kind).toBe('CUSTOM');
  });

  it('ignores non-positive follow-up offsets', () => {
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
      preferences: { ...DEFAULT_REMINDER_PREFERENCES, overdueFollowUpDays: [0, -3, 2] },
    });
    const followUps = reminders.filter((reminder) => reminder.kind === 'OVERDUE_FOLLOW_UP');
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.onDate).toBe('2026-08-12');
  });

  it('returns reminders in chronological order', () => {
    const reminders = buildReminderSchedule({
      transactionId: 'd1',
      dueAt: '2026-08-10',
      timeZone: TZ,
      now: NOW,
      customDate: '2026-08-20',
    });
    const times = reminders.map((reminder) => reminder.fireAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('validates reminder times', () => {
    expect(isValidReminderHour(0)).toBe(true);
    expect(isValidReminderHour(23)).toBe(true);
    expect(isValidReminderHour(24)).toBe(false);
    expect(isValidReminderHour(-1)).toBe(false);
    expect(isValidReminderHour(8.5)).toBe(false);
    expect(isValidReminderMinute(59)).toBe(true);
    expect(isValidReminderMinute(60)).toBe(false);
  });
});

describe('cancelling reminders', () => {
  const scheduled = buildReminderSchedule({
    transactionId: 'd1',
    dueAt: '2026-08-10',
    timeZone: TZ,
    now: NOW,
  });

  it('cancels every reminder for a debt that is now settled', () => {
    // Nothing is worse than the app nagging about money already received.
    expect(remindersToCancel(scheduled, ['d1'])).toHaveLength(scheduled.length);
  });

  it('leaves reminders for other debts alone', () => {
    expect(remindersToCancel(scheduled, ['other-debt'])).toEqual([]);
  });

  it('finds reminders whose day has passed', () => {
    expect(staleReminders(scheduled, '2026-08-12')).toHaveLength(3);
    expect(staleReminders(scheduled, '2026-08-01')).toEqual([]);
  });
});

describe('reminder templates', () => {
  it('ships the Khmer template from the product spec', () => {
    const template = findReminderTemplate('km', 'FRIENDLY', true);
    expect(template.body).toContain('សួស្តីបង/អូន');
    expect(template.body).toContain('ថ្ងៃកំណត់សង');
    expect(template.body).toContain('សូមអរគុណ');
  });

  it('composes a Khmer message with a real amount and date', () => {
    const message = composeReminderMessage({
      locale: 'km',
      customerName: 'សុខ ដារា',
      shopName: 'ហាងម្ដាយថាន',
      outstandingMinor: 50_000,
      currency: 'KHR',
      dueDate: '2026-08-10',
    });
    expect(message).toContain('50,000៛');
    expect(message).toContain('10 សីហា 2026');
    expect(message).toContain('ហាងម្ដាយថាន');
    expect(message).not.toContain('{');
  });

  it('composes an English message', () => {
    const message = composeReminderMessage({
      locale: 'en',
      customerName: 'Sok Dara',
      shopName: 'Mday Than Store',
      outstandingMinor: 1_250,
      currency: 'USD',
      dueDate: '2026-08-10',
    });
    expect(message).toContain('$12.50');
    expect(message).toContain('10 August 2026');
    expect(message).toContain('Sok Dara');
  });

  it('uses a no-due-date template when there is no due date', () => {
    const message = composeReminderMessage({
      locale: 'km',
      customerName: 'សុខ ដារា',
      shopName: 'ហាងម្ដាយថាន',
      outstandingMinor: 50_000,
      currency: 'KHR',
      dueDate: null,
    });
    expect(message).not.toContain('ថ្ងៃកំណត់សង');
    expect(message).not.toContain('{dueDate}');
  });

  it('drops the contact line when the merchant has no phone number', () => {
    const message = composeReminderMessage({
      locale: 'en',
      tone: 'NEUTRAL',
      customerName: 'Sok Dara',
      shopName: 'Mday Than Store',
      outstandingMinor: 1_250,
      currency: 'USD',
      dueDate: '2026-08-10',
      merchantPhone: null,
    });
    expect(message).not.toContain('{merchantPhone}');
    expect(message).toContain('Sok Dara');
  });

  it('includes the phone number when there is one', () => {
    const message = composeReminderMessage({
      locale: 'en',
      tone: 'NEUTRAL',
      customerName: 'Sok Dara',
      shopName: 'Mday Than Store',
      outstandingMinor: 1_250,
      currency: 'USD',
      dueDate: '2026-08-10',
      merchantPhone: '012 345 678',
    });
    expect(message).toContain('012 345 678');
  });

  it('never falls back across languages', () => {
    expect(findReminderTemplate('km', 'NEUTRAL', false).locale).toBe('km');
    expect(findReminderTemplate('en', 'NEUTRAL', false).locale).toBe('en');
  });

  it('keeps every shipped template polite', () => {
    expect(() => assertTemplatesArePolite()).not.toThrow();
    expect(REMINDER_TEMPLATES.length).toBeGreaterThan(0);
  });

  it('flags coercive language', () => {
    expect(containsProhibitedLanguage('We will call the police')).toBe(true);
    expect(containsProhibitedLanguage('We will take legal action')).toBe(true);
    expect(containsProhibitedLanguage('យើងនឹងទៅរកប៉ូលិស')).toBe(true);
    expect(containsProhibitedLanguage('Please drop by whenever convenient')).toBe(false);
  });

  it('formats dates in each language', () => {
    expect(formatDueDateForMessage('2026-08-10', { locale: 'km' })).toBe('10 សីហា 2026');
    expect(formatDueDateForMessage('2026-01-05', { locale: 'en' })).toBe('5 January 2026');
  });
});
