import { Share } from 'react-native';
// Type-only: erased at compile time, so it never triggers the runtime module load
// that throws inside Expo Go. The actual module is required lazily below.
import type * as ExpoNotifications from 'expo-notifications';
import {
  DEFAULT_REMINDER_PREFERENCES,
  type PlainDate,
  type ReminderPreferences,
  buildReminderSchedule,
  composeReminderMessage,
  uuidV4,
} from '@bonchi/domain';
import { type Locale } from '@bonchi/localization';
import { type SqlDatabase } from '../../db/client';
import { type BalanceRecord } from '../../db/repositories';

/**
 * Reminders.
 *
 * Two distinct things, deliberately kept apart:
 *
 *  1. NOTIFICATIONS to the merchant — "Sok Dara's 50,000៛ is due tomorrow".
 *     Scheduled locally so they fire with no signal.
 *
 *  2. MESSAGES to a customer — composed here, but only ever handed to the OS
 *     share sheet. Nothing is sent automatically, ever. The merchant reads the
 *     text, edits it if they want, and chooses whether and how to send it.
 *
 * Notification permission is requested contextually, the first time a merchant
 * enables reminders — never at launch, when the request has no context and gets
 * denied out of reflex.
 *
 * `expo-notifications` is loaded LAZILY rather than imported at module scope.
 * Importing it eagerly throws inside Expo Go on Android (push support was removed
 * from Expo Go in SDK 53), and because this module is imported by the customer
 * detail and settings screens, that failure cascaded into those routes losing
 * their default export — an error that points nowhere near the real cause.
 *
 * Loading on demand also means a screen that never schedules a reminder does not
 * touch the native module at all, and an environment without notification support
 * degrades to "no reminders" instead of crashing. That is the same path a merchant
 * who denies the permission already takes, so it is a state the app understands.
 */

type NotificationsModule = typeof ExpoNotifications;

let notificationsModule: NotificationsModule | null | undefined;

/**
 * Returns the notifications module, or null where it is unavailable
 * (Expo Go on Android, or any build without the native module).
 */
function getNotifications(): NotificationsModule | null {
  if (notificationsModule !== undefined) return notificationsModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    notificationsModule = require('expo-notifications') as NotificationsModule;
  } catch (error) {
    if (__DEV__) {
      console.warn(
        '[reminders] expo-notifications is unavailable; reminders are disabled. ' +
          'This is expected in Expo Go on Android — use a development build to test them.',
        error,
      );
    }
    notificationsModule = null;
  }
  return notificationsModule;
}

/** True when this build can schedule local notifications at all. */
export function areNotificationsSupported(): boolean {
  return getNotifications() !== null;
}

export type PermissionOutcome = 'GRANTED' | 'DENIED' | 'BLOCKED';

export async function requestNotificationPermission(): Promise<PermissionOutcome> {
  const Notifications = getNotifications();
  // No native module: treat it as permanently unavailable so the UI offers the
  // settings route rather than a prompt that can never appear.
  if (!Notifications) return 'BLOCKED';

  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return 'GRANTED';

  // Already denied and the OS will not ask again: send them to system settings
  // rather than showing a prompt that cannot appear.
  if (current.status === 'denied' && !current.canAskAgain) return 'BLOCKED';

  const requested = await Notifications.requestPermissionsAsync();
  if (requested.status === 'granted') return 'GRANTED';
  return requested.canAskAgain ? 'DENIED' : 'BLOCKED';
}

export async function hasNotificationPermission(): Promise<boolean> {
  const Notifications = getNotifications();
  if (!Notifications) return false;
  const current = await Notifications.getPermissionsAsync();
  return current.status === 'granted';
}

export interface ScheduleRemindersInput {
  readonly database: SqlDatabase;
  readonly organizationId: string;
  readonly shopId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly transactionId: string;
  readonly dueAt: PlainDate | null;
  readonly timeZone: string;
  readonly preferences?: ReminderPreferences;
  /** Controls how much detail appears on the lock screen. */
  readonly lockScreenDetail?: 'FULL' | 'HIDE_CUSTOMER_AND_AMOUNT' | 'NONE';
  readonly amountLabel: string;
}

/**
 * Schedules the reminder set for one debt.
 *
 * Lock-screen content defaults to hiding the customer and the amount: a debt
 * notification is readable by anyone who picks up the phone, and a merchant's
 * customers should not be exposed to whoever glances at their screen.
 */
export async function scheduleRemindersForDebt(
  input: ScheduleRemindersInput,
): Promise<number> {
  if (!input.dueAt) return 0;
  const Notifications = getNotifications();
  if (!Notifications) return 0;
  if (!(await hasNotificationPermission())) return 0;

  const schedule = buildReminderSchedule({
    transactionId: input.transactionId,
    dueAt: input.dueAt,
    timeZone: input.timeZone,
    preferences: input.preferences ?? DEFAULT_REMINDER_PREFERENCES,
    now: new Date(),
  });

  const detail = input.lockScreenDetail ?? 'HIDE_CUSTOMER_AND_AMOUNT';
  let scheduled = 0;

  for (const reminder of schedule) {
    const { title, body } = notificationContent(detail, input.customerName, input.amountLabel);

    const osId = await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        // The payload carries only ids, never names or amounts: notification
        // data is readable by other processes on some Android builds.
        data: { transactionId: input.transactionId, customerId: input.customerId },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: reminder.fireAt,
      },
    });

    await input.database.run(
      `INSERT INTO reminders (
         id, organization_id, shop_id, customer_id, transaction_id, kind,
         on_date, fire_at, os_notification_id, sync_state, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(transaction_id, kind, on_date) DO NOTHING`,
      [
        uuidV4(),
        input.organizationId,
        input.shopId,
        input.customerId,
        input.transactionId,
        reminder.kind,
        reminder.onDate,
        reminder.fireAt.toISOString(),
        osId,
        'PENDING',
        new Date().toISOString(),
      ],
    );

    scheduled += 1;
  }

  return scheduled;
}

function notificationContent(
  detail: 'FULL' | 'HIDE_CUSTOMER_AND_AMOUNT' | 'NONE',
  customerName: string,
  amountLabel: string,
): { title: string; body: string } {
  switch (detail) {
    case 'FULL':
      return { title: customerName, body: amountLabel };
    case 'HIDE_CUSTOMER_AND_AMOUNT':
      // Enough to prompt the merchant to open the app, nothing a bystander can use.
      return { title: 'Bonchi', body: 'មានការទូទាត់ត្រូវពិនិត្យ' };
    case 'NONE':
    default:
      return { title: 'Bonchi', body: '' };
  }
}

/**
 * Cancels every reminder for a settled debt.
 *
 * Called from the payment write path rather than left to a cleanup job: being
 * nagged about money already received is the fastest way to lose a merchant's
 * trust in the app.
 */
export async function cancelRemindersForTransaction(
  database: SqlDatabase,
  transactionId: string,
  reason: 'SETTLED' | 'REVERSED' | 'MERCHANT_DISABLED',
): Promise<void> {
  const Notifications = getNotifications();

  const rows = await database.all<{ id: string; os_notification_id: string | null }>(
    `SELECT id, os_notification_id FROM reminders
     WHERE transaction_id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
    [transactionId],
  );

  for (const row of rows) {
    if (Notifications && row.os_notification_id) {
      await Notifications.cancelScheduledNotificationAsync(row.os_notification_id).catch(() => {
        // A notification the OS has already dropped is not an error.
      });
    }
  }

  // The reminder rows are still marked cancelled even when the native module is
  // absent: the local record must match what the merchant asked for, regardless of
  // whether an OS notification was ever scheduled.

  await database.run(
    `UPDATE reminders SET cancelled_at = ?, cancelled_reason = ?
     WHERE transaction_id = ? AND cancelled_at IS NULL AND fired_at IS NULL`,
    [new Date().toISOString(), reason, transactionId],
  );
}

export interface ShareReminderInput {
  readonly locale: Locale;
  readonly customerName: string;
  readonly shopName: string;
  readonly balances: readonly BalanceRecord[];
  readonly merchantPhone?: string | null;
}

/**
 * Composes a reminder and opens the share sheet.
 *
 * Returns the text so the caller can show it for editing first. Nothing is sent
 * by this function or by anything downstream of it — the merchant picks the app
 * and presses send themselves.
 */
export async function composeAndShareReminder(input: ShareReminderInput): Promise<string | null> {
  const outstanding = input.balances.find((balance) => balance.outstanding_minor > 0);
  if (!outstanding) return null;

  const message = composeReminderMessage({
    locale: input.locale,
    customerName: input.customerName,
    shopName: input.shopName,
    outstandingMinor: outstanding.outstanding_minor,
    currency: outstanding.currency,
    dueDate: (outstanding.earliest_overdue_at ?? outstanding.next_due_at) as PlainDate | null,
    merchantPhone: input.merchantPhone ?? null,
  });

  await Share.share({ message });
  return message;
}

/** Foreground presentation. Reminders are informational, never alarms. */
export function configureNotificationHandler(): void {
  const Notifications = getNotifications();
  if (!Notifications) return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}
