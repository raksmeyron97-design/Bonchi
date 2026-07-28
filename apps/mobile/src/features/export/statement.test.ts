import { type LedgerTransaction } from '@bonchi/domain';
import {
  buildStatement,
  escapeCsvField,
  statementToCsv,
  statementToHtml,
  toCsvRow,
} from './statement';

const CUSTOMER = 'customer-1';

function debt(id: string, amountMinor: number, occurredAt: string, dueAt?: string): LedgerTransaction {
  return {
    id,
    customerId: CUSTOMER,
    transactionType: 'DEBT',
    currency: 'KHR',
    amountMinor,
    occurredAt,
    dueAt: (dueAt as never) ?? null,
  };
}

function payment(id: string, amountMinor: number, occurredAt: string): LedgerTransaction {
  return {
    id,
    customerId: CUSTOMER,
    transactionType: 'PAYMENT',
    currency: 'KHR',
    amountMinor,
    occurredAt,
  };
}

const BASE = {
  shopName: 'ហាងម្ដាយថាន',
  customerName: 'សុខ ដារា',
  currency: 'KHR' as const,
  generatedAt: '2026-07-27T03:00:00.000Z',
};

describe('escapeCsvField', () => {
  it('leaves ordinary values alone', () => {
    expect(escapeCsvField('rice')).toBe('rice');
    expect(escapeCsvField(50_000)).toBe('50000');
  });

  it('quotes a value containing a comma', () => {
    // A merchant note with a comma must not shift every later column.
    expect(escapeCsvField('rice, sugar')).toBe('"rice, sugar"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvField('the "good" rice')).toBe('"the ""good"" rice"');
  });

  it('quotes a value containing a newline', () => {
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('renders null and undefined as empty', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('builds a row', () => {
    expect(toCsvRow(['a', 'b,c', null, 1])).toBe('a,"b,c",,1');
  });
});

describe('buildStatement', () => {
  it('runs a balance down the page', () => {
    const statement = buildStatement({
      ...BASE,
      transactions: [
        debt('d1', 200_000, '2026-07-01T03:00:00Z', '2026-08-01'),
        payment('p1', 50_000, '2026-07-10T03:00:00Z'),
      ],
    });

    expect(statement.lines).toHaveLength(2);
    expect(statement.lines[0]?.debitMinor).toBe(200_000);
    expect(statement.lines[0]?.runningBalanceMinor).toBe(200_000);
    expect(statement.lines[1]?.creditMinor).toBe(50_000);
    expect(statement.lines[1]?.runningBalanceMinor).toBe(150_000);
    expect(statement.closingBalanceMinor).toBe(150_000);
  });

  it('covers only one currency', () => {
    const statement = buildStatement({
      ...BASE,
      transactions: [
        debt('d1', 100_000, '2026-07-01T03:00:00Z'),
        { ...debt('d2', 2_000, '2026-07-02T03:00:00Z'), currency: 'USD' },
      ],
    });
    // A statement mixing riel and dollars would imply an exchange rate.
    expect(statement.lines).toHaveLength(1);
    expect(statement.closingBalanceMinor).toBe(100_000);
  });

  it('shows a reversed transaction but does not let it move the balance', () => {
    const original = debt('d1', 500_000, '2026-07-01T03:00:00Z');
    const statement = buildStatement({
      ...BASE,
      transactions: [
        original,
        {
          id: 'r1',
          customerId: CUSTOMER,
          transactionType: 'REVERSAL',
          currency: 'KHR',
          amountMinor: 500_000,
          occurredAt: '2026-07-01T04:00:00Z',
          reversalOfTransactionId: 'd1',
        },
        debt('d2', 50_000, '2026-07-01T05:00:00Z'),
      ],
    });

    // Both the mistake and its correction are visible — a statement the customer
    // can check must show what happened.
    expect(statement.lines).toHaveLength(3);
    expect(statement.lines[0]?.isReversed).toBe(true);
    expect(statement.lines[0]?.debitMinor).toBeNull();
    expect(statement.closingBalanceMinor).toBe(50_000);
  });

  it('orders lines chronologically with a deterministic tie-break', () => {
    const statement = buildStatement({
      ...BASE,
      transactions: [
        debt('d-b', 10_000, '2026-07-01T03:00:00Z'),
        debt('d-a', 20_000, '2026-07-01T03:00:00Z'),
      ],
    });
    expect(statement.lines[0]?.debitMinor).toBe(20_000);
  });

  it('handles a customer with no activity', () => {
    const statement = buildStatement({ ...BASE, transactions: [] });
    expect(statement.lines).toHaveLength(0);
    expect(statement.closingBalanceMinor).toBe(0);
  });
});

describe('statementToCsv', () => {
  const statement = buildStatement({
    ...BASE,
    transactions: [
      debt('d1', 200_000, '2026-07-01T03:00:00Z', '2026-08-01'),
      payment('p1', 50_000, '2026-07-10T03:00:00Z'),
    ],
  });

  it('emits a header and one row per line', () => {
    const csv = statementToCsv(statement, { locale: 'km', includeBom: false });
    const rows = csv.split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Date');
    expect(rows[0]).toContain('Balance (KHR)');
  });

  it('writes amounts as plain numbers a spreadsheet can add up', () => {
    const csv = statementToCsv(statement, { locale: 'km', includeBom: false });
    // Not "50,000៛" — a formatted string would arrive as text.
    expect(csv).toContain('200000');
    expect(csv).toContain('150000');
    expect(csv).not.toContain('៛');
  });

  it('writes USD with two decimals', () => {
    const usd = buildStatement({
      ...BASE,
      currency: 'USD',
      transactions: [{ ...debt('d1', 1_250, '2026-07-01T03:00:00Z'), currency: 'USD' }],
    });
    expect(statementToCsv(usd, { locale: 'en', includeBom: false })).toContain('12.50');
  });

  it('includes a BOM by default so Excel reads Khmer correctly', () => {
    expect(statementToCsv(statement, { locale: 'km' }).charCodeAt(0)).toBe(0xfeff);
    expect(statementToCsv(statement, { locale: 'km', includeBom: false }).charCodeAt(0)).not.toBe(
      0xfeff,
    );
  });

  it('uses CRLF line endings, as RFC 4180 specifies', () => {
    expect(statementToCsv(statement, { locale: 'km', includeBom: false })).toContain('\r\n');
  });
});

describe('statementToHtml', () => {
  const labels = {
    title: 'របាយការណ៍អតិថិជន',
    period: 'រយៈពេល',
    closingBalance: 'សមតុល្យនៅសល់',
    generatedAt: 'បង្កើតនៅ 27 កក្កដា 2026',
    shopContact: 'ទំនាក់ទំនងហាង',
    columnDate: 'កាលបរិច្ឆេទ',
    columnDescription: 'ការពិពណ៌នា',
    columnDebt: 'ឱ្យជំពាក់',
    columnPayment: 'បានទទួល',
    columnBalance: 'នៅសល់',
    columnDueDate: 'ថ្ងៃកំណត់សង',
    reversed: 'បានលុបចោល',
  };

  const statement = buildStatement({
    ...BASE,
    shopPhone: '012 345 678',
    transactions: [
      debt('d1', 200_000, '2026-07-01T03:00:00Z', '2026-08-01'),
      payment('p1', 50_000, '2026-07-10T03:00:00Z'),
    ],
  });

  it('renders shop, customer and balance', () => {
    const html = statementToHtml(statement, labels, 'km');
    expect(html).toContain('ហាងម្ដាយថាន');
    expect(html).toContain('សុខ ដារា');
    expect(html).toContain('150,000៛');
    expect(html).toContain('012 345 678');
  });

  it('is self-contained, so it renders offline', () => {
    const html = statementToHtml(statement, labels, 'km');
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('<style>');
  });

  it('escapes HTML in merchant-supplied text', () => {
    const hostile = buildStatement({
      ...BASE,
      customerName: '<script>alert(1)</script>',
      transactions: [debt('d1', 1_000, '2026-07-01T03:00:00Z')],
    });
    const html = statementToHtml(hostile, labels, 'km');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('gives Khmer text generous line height so glyphs are not clipped', () => {
    const html = statementToHtml(statement, labels, 'km');
    expect(html).toMatch(/line-height:\s*1\.[5-9]/);
  });
});
