import {
  type PlainDate,
  comparePlainDate,
  daysBetween,
} from '../time/plainDate';
import {
  type ChargeSettlement,
} from './allocation';
import { type DebtDisplayStatus, type ScheduleStatus, type SettlementStatus } from './types';

/** Days before the due date at which a debt starts reading as "due soon". */
export const DEFAULT_DUE_SOON_DAYS = 3;

export interface DebtStatus {
  readonly settlement: SettlementStatus;
  readonly schedule: ScheduleStatus;
  /** The single status a badge renders. */
  readonly display: DebtDisplayStatus;
  /** Negative when the due date has passed. Null when there is no due date. */
  readonly daysUntilDue: number | null;
  readonly daysOverdue: number;
  readonly isOverdue: boolean;
}

export interface ResolveDebtStatusInput {
  readonly settlement: SettlementStatus;
  readonly dueAt: PlainDate | null;
  readonly today: PlainDate;
  readonly dueSoonDays?: number;
}

/**
 * Reduces a debt to the status the UI shows.
 *
 * `today` must be the merchant's calendar day (see `merchantToday`), not the
 * device's. A phone whose clock is in another timezone must not make a debt
 * look overdue a day early.
 *
 * A fully settled or reversed debt is never overdue, regardless of its due date.
 */
export function resolveDebtStatus(input: ResolveDebtStatusInput): DebtStatus {
  const { settlement, dueAt, today, dueSoonDays = DEFAULT_DUE_SOON_DAYS } = input;

  const settled = settlement === 'PAID' || settlement === 'REVERSED';

  const daysUntilDue = dueAt ? daysBetween(today, dueAt) : null;

  let schedule: ScheduleStatus;
  if (!dueAt) {
    schedule = 'NO_DUE_DATE';
  } else {
    const comparison = comparePlainDate(dueAt, today);
    if (comparison < 0) schedule = 'OVERDUE';
    else if (comparison === 0) schedule = 'DUE_TODAY';
    else if ((daysUntilDue ?? 0) <= dueSoonDays) schedule = 'DUE_SOON';
    else schedule = 'UPCOMING';
  }

  const isOverdue = !settled && schedule === 'OVERDUE';
  const daysOverdue = isOverdue && daysUntilDue !== null ? -daysUntilDue : 0;

  let display: DebtDisplayStatus;
  if (settlement === 'REVERSED') display = 'REVERSED';
  else if (settlement === 'PAID') display = 'PAID';
  else if (schedule === 'OVERDUE') display = 'OVERDUE';
  else if (schedule === 'DUE_TODAY') display = 'DUE_TODAY';
  else if (schedule === 'DUE_SOON') display = 'DUE_SOON';
  else if (settlement === 'PARTIALLY_PAID') display = 'PARTIALLY_PAID';
  else if (schedule === 'UPCOMING') display = 'UPCOMING';
  else display = 'NO_DUE_DATE';

  return { settlement, schedule, display, daysUntilDue, daysOverdue, isOverdue };
}

export function statusForCharge(
  charge: ChargeSettlement,
  today: PlainDate,
  dueSoonDays: number = DEFAULT_DUE_SOON_DAYS,
): DebtStatus {
  return resolveDebtStatus({
    settlement: charge.settlement,
    dueAt: charge.dueAt,
    today,
    dueSoonDays,
  });
}

/**
 * True when a status needs merchant attention today. Drives the dashboard's
 * "needs action" grouping and the badge on the reminders tab.
 */
export function needsAttention(status: DebtStatus): boolean {
  return status.display === 'OVERDUE' || status.display === 'DUE_TODAY';
}

/** Severity ordering, so a customer list can sort by urgency. */
export function statusSeverity(status: DebtDisplayStatus): number {
  switch (status) {
    case 'OVERDUE':
      return 100;
    case 'DUE_TODAY':
      return 90;
    case 'DUE_SOON':
      return 80;
    case 'PARTIALLY_PAID':
      return 50;
    case 'UPCOMING':
      return 40;
    case 'NO_DUE_DATE':
      return 30;
    case 'PAID':
      return 10;
    case 'REVERSED':
      return 0;
    default: {
      const exhaustive: never = status;
      return Number(exhaustive);
    }
  }
}
