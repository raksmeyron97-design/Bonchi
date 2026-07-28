import {
  type CurrencyCode,
  type LedgerTransaction,
  type PlainDate,
  allocate,
  formatMoney,
  money,
  toDecimalString,
} from '@bonchi/domain';
import { formatPlainDate, type Locale } from '@bonchi/localization';

/**
 * Customer statements and data export.
 *
 * Two output paths, both generated ON DEVICE from local data so they work with
 * no signal:
 *
 *   * A PDF statement, rendered from HTML through expo-print.
 *   * CSV, for a merchant who wants their records in a spreadsheet.
 *
 * Amounts in CSV are written as plain decimal strings from `toDecimalString`,
 * never as formatted display text — a spreadsheet must receive a number, not
 * "50,000៛".
 */

export interface StatementLine {
  readonly occurredAt: string;
  readonly kind: 'DEBT' | 'PAYMENT' | 'ADJUSTMENT' | 'REVERSAL' | 'OPENING_BALANCE';
  readonly description: string;
  readonly debitMinor: number | null;
  readonly creditMinor: number | null;
  readonly runningBalanceMinor: number;
  readonly dueAt: PlainDate | null;
  readonly isReversed: boolean;
}

export interface StatementData {
  readonly shopName: string;
  readonly shopPhone: string | null;
  readonly shopAddress: string | null;
  readonly customerName: string;
  readonly customerPhone: string | null;
  readonly customerCode: string | null;
  readonly currency: CurrencyCode;
  readonly periodFrom: PlainDate | null;
  readonly periodTo: PlainDate | null;
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
  readonly lines: readonly StatementLine[];
  readonly generatedAt: string;
}

export interface BuildStatementInput {
  readonly transactions: readonly LedgerTransaction[];
  readonly currency: CurrencyCode;
  readonly shopName: string;
  readonly shopPhone?: string | null;
  readonly shopAddress?: string | null;
  readonly customerName: string;
  readonly customerPhone?: string | null;
  readonly customerCode?: string | null;
  readonly periodFrom?: PlainDate | null;
  readonly periodTo?: PlainDate | null;
  readonly generatedAt?: string;
}

/**
 * Builds one currency's statement.
 *
 * Single-currency by design: a statement mixing riel and dollars would need an
 * exchange rate the merchant never agreed to. A customer owing both gets two
 * statements.
 */
export function buildStatement(input: BuildStatementInput): StatementData {
  const scoped = input.transactions
    .filter((transaction) => transaction.currency === input.currency)
    .sort((a, b) =>
      a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt.localeCompare(b.occurredAt),
    );

  const reversedIds = new Set(
    scoped
      .filter((transaction) => transaction.reversalOfTransactionId)
      .map((transaction) => transaction.reversalOfTransactionId as string),
  );

  const lines: StatementLine[] = [];
  let running = 0;

  for (const transaction of scoped) {
    const isReversal = transaction.transactionType === 'REVERSAL';
    const isReversed = reversedIds.has(transaction.id);

    // A reversed transaction and its reversal both appear — a statement the
    // customer can check must show what happened, including corrections — but
    // neither moves the running balance.
    let debitMinor: number | null = null;
    let creditMinor: number | null = null;

    if (!isReversal && !isReversed) {
      if (
        transaction.transactionType === 'DEBT' ||
        transaction.transactionType === 'OPENING_BALANCE' ||
        (transaction.transactionType === 'ADJUSTMENT' &&
          transaction.adjustmentDirection === 'INCREASE')
      ) {
        debitMinor = transaction.amountMinor;
        running += transaction.amountMinor;
      } else {
        creditMinor = transaction.amountMinor;
        running -= transaction.amountMinor;
      }
    }

    lines.push({
      occurredAt: transaction.occurredAt,
      kind: transaction.transactionType,
      description: '',
      debitMinor,
      creditMinor,
      runningBalanceMinor: running,
      dueAt: transaction.dueAt ?? null,
      isReversed,
    });
  }

  const settlement = allocate(scoped, input.currency);

  return {
    shopName: input.shopName,
    shopPhone: input.shopPhone ?? null,
    shopAddress: input.shopAddress ?? null,
    customerName: input.customerName,
    customerPhone: input.customerPhone ?? null,
    customerCode: input.customerCode ?? null,
    currency: input.currency,
    periodFrom: input.periodFrom ?? null,
    periodTo: input.periodTo ?? null,
    openingBalanceMinor: 0,
    closingBalanceMinor: settlement.outstandingMinor,
    lines,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Escapes one CSV field per RFC 4180.
 *
 * A description containing a comma, a quote or a newline is entirely normal in a
 * merchant's notes, and getting this wrong produces a file that silently opens
 * with shifted columns — worse than an obvious failure.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsvRow(fields: readonly (string | number | null | undefined)[]): string {
  return fields.map(escapeCsvField).join(',');
}

export interface CsvExportOptions {
  readonly locale: Locale;
  /** Byte-order mark, so Excel opens Khmer text as UTF-8 rather than mojibake. */
  readonly includeBom?: boolean;
}

export function statementToCsv(
  statement: StatementData,
  options: CsvExportOptions = { locale: 'km' },
): string {
  const header = toCsvRow([
    'Date',
    'Type',
    'Description',
    'Due date',
    `Debt (${statement.currency})`,
    `Received (${statement.currency})`,
    `Balance (${statement.currency})`,
    'Status',
  ]);

  const rows = statement.lines.map((line) =>
    toCsvRow([
      line.occurredAt,
      line.kind,
      line.description,
      line.dueAt ?? '',
      // Plain decimal strings: a spreadsheet needs a number, not display text.
      line.debitMinor === null ? '' : toDecimalString(money(line.debitMinor, statement.currency)),
      line.creditMinor === null ? '' : toDecimalString(money(line.creditMinor, statement.currency)),
      toDecimalString(money(line.runningBalanceMinor, statement.currency)),
      line.isReversed ? 'REVERSED' : '',
    ]),
  );

  const body = [header, ...rows].join('\r\n');
  // Excel on Windows needs the BOM to read Khmer script correctly.
  return options.includeBom === false ? body : `\ufeff${body}`;
}

// ---------------------------------------------------------------------------
// PDF (HTML source for expo-print)
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface StatementHtmlLabels {
  readonly title: string;
  readonly period: string;
  readonly closingBalance: string;
  readonly generatedAt: string;
  readonly shopContact: string;
  readonly columnDate: string;
  readonly columnDescription: string;
  readonly columnDebt: string;
  readonly columnPayment: string;
  readonly columnBalance: string;
  readonly columnDueDate: string;
  readonly reversed: string;
}

/**
 * Renders the statement as self-contained HTML for expo-print.
 *
 * No external stylesheet or font: the document must render identically offline
 * and on a device with no network. Khmer text relies on the system font, with
 * generous line heights so stacked glyphs are not clipped in the PDF.
 */
export function statementToHtml(
  statement: StatementData,
  labels: StatementHtmlLabels,
  locale: Locale,
): string {
  const formatAmount = (amountMinor: number | null): string =>
    amountMinor === null ? '' : formatMoney(money(amountMinor, statement.currency), { locale });

  const rows = statement.lines
    .map(
      (line) => `
        <tr class="${line.isReversed ? 'reversed' : ''}">
          <td>${escapeHtml(line.occurredAt.slice(0, 10))}</td>
          <td>${escapeHtml(line.description || line.kind)}${
            line.isReversed ? ` <span class="tag">${escapeHtml(labels.reversed)}</span>` : ''
          }</td>
          <td>${escapeHtml(line.dueAt ? formatPlainDate(line.dueAt, locale, 'short') : '')}</td>
          <td class="num">${escapeHtml(formatAmount(line.debitMinor))}</td>
          <td class="num">${escapeHtml(formatAmount(line.creditMinor))}</td>
          <td class="num">${escapeHtml(formatAmount(line.runningBalanceMinor))}</td>
        </tr>`,
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Noto Sans Khmer", "Khmer OS", Roboto, sans-serif;
    color: #1C1917;
    padding: 24px;
    /* Khmer glyphs stack above and below the baseline; generous leading keeps
       them from clipping in the rendered PDF. */
    line-height: 1.8;
    font-size: 12px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #57534E; font-size: 11px; }
  .header { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
  .box { border: 1px solid #E7E5E4; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #E7E5E4; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; color: #57534E; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr.reversed td { color: #A8A29E; text-decoration: line-through; }
  .tag { font-size: 10px; color: #B91C1C; text-decoration: none; }
  .total { font-size: 18px; font-weight: 700; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escapeHtml(labels.title)}</h1>
      <div class="muted">${escapeHtml(statement.shopName)}</div>
      ${statement.shopPhone ? `<div class="muted">${escapeHtml(statement.shopPhone)}</div>` : ''}
      ${statement.shopAddress ? `<div class="muted">${escapeHtml(statement.shopAddress)}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div><strong>${escapeHtml(statement.customerName)}</strong></div>
      ${statement.customerPhone ? `<div class="muted">${escapeHtml(statement.customerPhone)}</div>` : ''}
      ${statement.customerCode ? `<div class="muted">${escapeHtml(statement.customerCode)}</div>` : ''}
      <div class="muted">${escapeHtml(labels.generatedAt)}</div>
    </div>
  </div>

  <div class="box">
    <div class="muted">${escapeHtml(labels.closingBalance)} (${escapeHtml(statement.currency)})</div>
    <div class="total">${escapeHtml(
      formatMoney(money(statement.closingBalanceMinor, statement.currency), { locale }),
    )}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th>${escapeHtml(labels.columnDate)}</th>
        <th>${escapeHtml(labels.columnDescription)}</th>
        <th>${escapeHtml(labels.columnDueDate)}</th>
        <th class="num">${escapeHtml(labels.columnDebt)}</th>
        <th class="num">${escapeHtml(labels.columnPayment)}</th>
        <th class="num">${escapeHtml(labels.columnBalance)}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}
