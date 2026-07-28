import {
  type CurrencyCode,
  type LedgerTransaction,
  merchantToday,
} from '@bonchi/domain';
// Type-only: erased at compile time, so these never trigger the runtime module
// load. The modules themselves are required lazily inside the function below.
import type * as ExpoPrint from 'expo-print';
import type * as ExpoSharing from 'expo-sharing';
import type * as ExpoFileSystem from 'expo-file-system';
import { type Locale } from '@bonchi/localization';
import { type SqlDatabase } from '../../db/client';
import {
  SqlCustomerRepository,
  SqlTransactionRepository,
  toDomainTransaction,
} from '../../db/repositories';
import {
  type StatementHtmlLabels,
  buildStatement,
  statementToHtml,
} from './statement';

/**
 * Giving a customer their statement.
 *
 * `statement.ts` could already build the data and render the HTML, but nothing
 * turned that into a file a merchant could actually hand over — the feature
 * existed only in the test suite. This is the path from "customer asks what they
 * owe" to a PDF in their messaging app.
 *
 * Everything happens on device from local rows, so it works with no signal. The
 * merchant chooses where it goes: the OS share sheet is the last step, and
 * nothing is transmitted anywhere by this module.
 */

/**
 * Control characters, which must never reach a file name.
 *
 * Spaces are deliberately left alone by both patterns; they are collapsed to a
 * dash further down so the name stays readable.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/g;

/** Path separators and the Windows-reserved set. Removed outright. */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Longest customer-name portion, in characters.
 *
 * Filesystems cap names in BYTES, and Khmer is three bytes per character in
 * UTF-8 — a 90-character Khmer name is 270 bytes and exceeds the 255-byte limit
 * on its own. Sixty characters leaves headroom for the currency and date.
 */
const MAX_NAME_CHARS = 60;

/**
 * Builds the file name the customer will see.
 *
 * The merchant's own script is kept rather than transliterated: a shop owner
 * looking through their sent files should see the customer's name as they wrote
 * it. Only the characters that genuinely break a file path are removed.
 */
export function statementFileName(
  customerName: string,
  currency: CurrencyCode,
  onDate: string,
): string {
  const cleaned = customerName
    // Control characters become a space rather than vanishing: a merchant who
    // pressed enter mid-name meant a word break, so "Sok<newline>Dara" should
    // read "Sok-Dara", not "SokDara".
    .replace(CONTROL_CHARS, ' ')
    .replace(UNSAFE_FILENAME_CHARS, '')
    // A leading dot would hide the file on Android and iOS alike.
    .replace(/^\.+/, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, MAX_NAME_CHARS);

  // A name of only slashes and dots leaves nothing usable. "statement" is not a
  // good name, but a file the merchant cannot share is worse.
  const name = cleaned.length > 0 ? cleaned : 'statement';

  return `${name}-${currency}-${onDate}.pdf`;
}

export type ShareStatementOutcome =
  | { readonly status: 'SHARED'; readonly fileName: string }
  /** Nothing in this currency to put on a statement. */
  | { readonly status: 'NO_TRANSACTIONS' }
  /** The device has no way to share a file. */
  | { readonly status: 'SHARING_UNAVAILABLE'; readonly fileName: string; readonly uri: string };

export interface ShareStatementInput {
  readonly database: SqlDatabase;
  readonly customerId: string;
  readonly shopId: string;
  readonly currency: CurrencyCode;
  readonly locale: Locale;
  readonly timeZone: string;
  readonly labels: StatementHtmlLabels;
}

interface ShopRow {
  name: string;
  phone: string | null;
  address: string | null;
}

/**
 * Which currencies this customer has any history in.
 *
 * A statement covers one currency — mixing riel and dollars would need an
 * exchange rate the merchant never agreed to — so the caller has to know whether
 * to ask.
 */
export async function statementCurrencies(
  database: SqlDatabase,
  customerId: string,
): Promise<CurrencyCode[]> {
  const rows = await database.all<{ currency: CurrencyCode }>(
    `SELECT DISTINCT currency FROM transactions WHERE customer_id = ? ORDER BY currency`,
    [customerId],
  );
  return rows.map((row) => row.currency);
}

/**
 * Renders a customer's statement to a PDF and opens the share sheet.
 *
 * The PDF lands in the cache directory: a statement is a transient artefact the
 * merchant sends immediately, not something to accumulate on a phone that is
 * usually short of storage.
 */
export async function shareCustomerStatement(
  input: ShareStatementInput,
): Promise<ShareStatementOutcome> {
  // Required lazily. These are native modules, and this file is imported by the
  // customer detail screen — a module that throws at import time takes the whole
  // route down with an error that points nowhere near the cause.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Print = require('expo-print') as typeof ExpoPrint;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Sharing = require('expo-sharing') as typeof ExpoSharing;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { File, Paths } = require('expo-file-system') as typeof ExpoFileSystem;

  const customers = new SqlCustomerRepository(input.database);
  const transactionRepo = new SqlTransactionRepository(input.database);

  const [customer, rows, shop] = await Promise.all([
    customers.findById(input.customerId),
    transactionRepo.allForCustomer(input.customerId),
    input.database.first<ShopRow>(`SELECT name, phone, address FROM shops WHERE id = ?`, [
      input.shopId,
    ]),
  ]);

  if (!customer) return { status: 'NO_TRANSACTIONS' };

  const history: LedgerTransaction[] = rows.map(toDomainTransaction);
  const inCurrency = history.filter((entry) => entry.currency === input.currency);
  if (inCurrency.length === 0) return { status: 'NO_TRANSACTIONS' };

  const generatedAt = new Date();

  const statement = buildStatement({
    transactions: history,
    currency: input.currency,
    // The shop row is missing only if onboarding never completed. An empty name
    // is preferable to refusing the merchant their statement.
    shopName: shop?.name ?? '',
    shopPhone: shop?.phone ?? null,
    shopAddress: shop?.address ?? null,
    customerName: customer.name,
    customerPhone: customer.phone,
    customerCode: customer.customer_code,
    generatedAt: generatedAt.toISOString(),
  });

  const html = statementToHtml(statement, input.labels, input.locale);

  // Named for the merchant's day, not UTC: a statement produced at 8am in Phnom
  // Penh must not be dated yesterday.
  const fileName = statementFileName(
    customer.name,
    input.currency,
    merchantToday(generatedAt, input.timeZone),
  );

  const printed = await Print.printToFileAsync({ html });

  // expo-print names the file from a random id. Renaming it means the customer
  // receives "Sok Dara-KHR-2026-07-28.pdf" rather than "8f3a1c....pdf".
  const target = new File(Paths.cache, fileName);
  if (target.exists) target.delete();
  await new File(printed.uri).move(target);

  if (!(await Sharing.isAvailableAsync())) {
    return { status: 'SHARING_UNAVAILABLE', fileName, uri: target.uri };
  }

  await Sharing.shareAsync(target.uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: input.labels.title,
  });

  return { status: 'SHARED', fileName };
}
