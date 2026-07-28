import { describe, expect, it } from 'vitest';
import { uuidV4 } from '@bonchi/domain';
import { currenciesForUsage, normalizeCambodianPhone } from './primitives';
import {
  MAX_ATTACHMENT_BYTES,
  attachmentUploadSchema,
  createCustomerSchema,
  exportRequestSchema,
  ledgerWriteSchema,
  notificationPreferencesSchema,
  onboardingSchema,
  recordDebtSchema,
  recordPaymentSchema,
  reverseTransactionSchema,
  sanitizeFileName,
  setPinSchema,
} from './schemas';
import {
  EnvironmentValidationError,
  adminServerEnvSchema,
  mobileEnvSchema,
  parseEnv,
} from './env';

const ID = uuidV4();

describe('createCustomerSchema', () => {
  it('needs only a name', () => {
    const result = createCustomerSchema.safeParse({ id: ID, name: 'សុខ ដារា' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('សុខ ដារា');
      expect(result.data.phone).toBeNull();
      expect(result.data.telegram).toBeNull();
      expect(result.data.address).toBeNull();
      expect(result.data.note).toBeNull();
    }
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(createCustomerSchema.safeParse({ id: ID, name: '' }).success).toBe(false);
    expect(createCustomerSchema.safeParse({ id: ID, name: '   ' }).success).toBe(false);
  });

  it('trims the name', () => {
    const result = createCustomerSchema.safeParse({ id: ID, name: '  Sok Dara  ' });
    expect(result.success && result.data.name).toBe('Sok Dara');
  });

  it('treats a field the merchant tapped into and left empty as absent', () => {
    const result = createCustomerSchema.safeParse({ id: ID, name: 'Sok Dara', note: '   ', address: '' });
    expect(result.success && result.data.note).toBeNull();
    expect(result.success && result.data.address).toBeNull();
  });

  it('normalizes a Telegram handle', () => {
    const result = createCustomerSchema.safeParse({ id: ID, name: 'Sok Dara', telegram: '@sok_dara' });
    expect(result.success && result.data.telegram).toBe('sok_dara');
  });

  it('rejects an invalid Telegram handle', () => {
    expect(createCustomerSchema.safeParse({ id: ID, name: 'x', telegram: 'ab' }).success).toBe(false);
  });

  it('rejects an id that is not a uuid', () => {
    expect(createCustomerSchema.safeParse({ id: 'abc', name: 'Sok Dara' }).success).toBe(false);
  });

  it('reports translation keys, never English prose', () => {
    const result = createCustomerSchema.safeParse({ id: ID, name: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('validation.customerName.required');
    }
  });

  it('rejects an over-long name', () => {
    expect(createCustomerSchema.safeParse({ id: ID, name: 'x'.repeat(121) }).success).toBe(false);
  });
});

describe('normalizeCambodianPhone', () => {
  it('normalizes the forms merchants type', () => {
    expect(normalizeCambodianPhone('012 345 678')).toBe('+85512345678');
    expect(normalizeCambodianPhone('012-345-678')).toBe('+85512345678');
    expect(normalizeCambodianPhone('+855 12 345 678')).toBe('+85512345678');
    expect(normalizeCambodianPhone('85512345678')).toBe('+85512345678');
    expect(normalizeCambodianPhone('(012) 345 678')).toBe('+85512345678');
  });

  it('handles nine-digit national numbers', () => {
    expect(normalizeCambodianPhone('092 345 6789')).toBe('+855923456789');
  });

  it('returns null rather than corrupting something it cannot parse', () => {
    expect(normalizeCambodianPhone('')).toBeNull();
    expect(normalizeCambodianPhone('12')).toBeNull();
    expect(normalizeCambodianPhone('not a phone')).toBeNull();
  });
});

describe('recordDebtSchema', () => {
  const base = {
    id: ID,
    customerId: uuidV4(),
    transactionType: 'DEBT' as const,
    amountMinor: 50_000,
    currency: 'KHR' as const,
    occurredAt: '2026-07-27T03:00:00.000Z',
  };

  it('accepts the minimum a merchant must supply', () => {
    const result = recordDebtSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dueAt).toBeNull();
      expect(result.data.attachmentIds).toEqual([]);
    }
  });

  it('accepts a due date', () => {
    const result = recordDebtSchema.safeParse({ ...base, dueAt: '2026-08-10' });
    expect(result.success && result.data.dueAt).toBe('2026-08-10');
  });

  it('rejects an impossible due date', () => {
    expect(recordDebtSchema.safeParse({ ...base, dueAt: '2026-02-30' }).success).toBe(false);
    expect(recordDebtSchema.safeParse({ ...base, dueAt: '10/08/2026' }).success).toBe(false);
  });

  it('rejects a zero, negative or fractional amount', () => {
    expect(recordDebtSchema.safeParse({ ...base, amountMinor: 0 }).success).toBe(false);
    expect(recordDebtSchema.safeParse({ ...base, amountMinor: -100 }).success).toBe(false);
    expect(recordDebtSchema.safeParse({ ...base, amountMinor: 12.5 }).success).toBe(false);
  });

  it('rejects an absurd amount', () => {
    expect(recordDebtSchema.safeParse({ ...base, amountMinor: 1e15 }).success).toBe(false);
  });

  it('rejects an unsupported currency', () => {
    expect(recordDebtSchema.safeParse({ ...base, currency: 'EUR' }).success).toBe(false);
  });

  it('caps attachments', () => {
    const ids = Array.from({ length: 11 }, () => uuidV4());
    expect(recordDebtSchema.safeParse({ ...base, attachmentIds: ids }).success).toBe(false);
  });

  it('never accepts an organizationId from the client', () => {
    const result = recordDebtSchema.safeParse({ ...base, organizationId: 'someone-elses-org' });
    expect(result.success).toBe(true);
    // Mass-assignment guard: the extra key is dropped, not honoured.
    expect(result.success && 'organizationId' in result.data).toBe(false);
  });
});

describe('recordPaymentSchema', () => {
  const base = {
    id: ID,
    customerId: uuidV4(),
    transactionType: 'PAYMENT' as const,
    amountMinor: 20_000,
    currency: 'KHR' as const,
    occurredAt: '2026-07-27T03:00:00.000Z',
    paymentMethod: 'CASH' as const,
  };

  it('accepts a cash payment with no allocations', () => {
    const result = recordPaymentSchema.safeParse(base);
    expect(result.success && result.data.allocations).toEqual([]);
  });

  it('accepts explicit allocations', () => {
    const debtId = uuidV4();
    const result = recordPaymentSchema.safeParse({
      ...base,
      allocations: [{ debtTransactionId: debtId, amountMinor: 20_000 }],
    });
    expect(result.success && result.data.allocations[0]?.debtTransactionId).toBe(debtId);
  });

  it('accepts every payment method', () => {
    for (const paymentMethod of ['CASH', 'BANK_TRANSFER', 'KHQR', 'OTHER'] as const) {
      expect(recordPaymentSchema.safeParse({ ...base, paymentMethod }).success).toBe(true);
    }
  });

  it('rejects an unknown payment method', () => {
    expect(recordPaymentSchema.safeParse({ ...base, paymentMethod: 'CRYPTO' }).success).toBe(false);
  });
});

describe('ledgerWriteSchema', () => {
  const common = {
    id: ID,
    customerId: uuidV4(),
    amountMinor: 1_000,
    currency: 'USD' as const,
    occurredAt: '2026-07-27T03:00:00.000Z',
  };

  it('routes on transaction type', () => {
    expect(ledgerWriteSchema.safeParse({ ...common, transactionType: 'DEBT' }).success).toBe(true);
    expect(
      ledgerWriteSchema.safeParse({ ...common, transactionType: 'PAYMENT', paymentMethod: 'CASH' })
        .success,
    ).toBe(true);
    expect(
      ledgerWriteSchema.safeParse({
        ...common,
        transactionType: 'ADJUSTMENT',
        adjustmentDirection: 'DECREASE',
        reason: 'Agreed discount',
      }).success,
    ).toBe(true);
  });

  it('requires a reason on an adjustment', () => {
    expect(
      ledgerWriteSchema.safeParse({
        ...common,
        transactionType: 'ADJUSTMENT',
        adjustmentDirection: 'DECREASE',
      }).success,
    ).toBe(false);
  });

  it('rejects a REVERSAL through the ordinary write path', () => {
    // Reversals go through reverseTransactionSchema so a target and reason are mandatory.
    expect(ledgerWriteSchema.safeParse({ ...common, transactionType: 'REVERSAL' }).success).toBe(false);
  });
});

describe('reverseTransactionSchema', () => {
  it('requires a target and a reason', () => {
    const valid = reverseTransactionSchema.safeParse({
      id: ID,
      targetTransactionId: uuidV4(),
      occurredAt: '2026-07-27T03:00:00.000Z',
      reason: 'Wrong amount entered',
    });
    expect(valid.success).toBe(true);

    expect(
      reverseTransactionSchema.safeParse({
        id: ID,
        targetTransactionId: uuidV4(),
        occurredAt: '2026-07-27T03:00:00.000Z',
        reason: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('onboardingSchema', () => {
  it('accepts a minimal Cambodian shop and defaults to Khmer', () => {
    const result = onboardingSchema.safeParse({
      ownerName: 'សុខ ដារា',
      shopName: 'ហាងម្ដាយថាន',
      businessCategory: 'GROCERY',
      currencyUsage: 'BOTH',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBe('km');
      expect(result.data.timeZone).toBe('Asia/Phnom_Penh');
      expect(result.data.phone).toBeNull();
    }
  });

  it('rejects an unusable timezone', () => {
    expect(
      onboardingSchema.safeParse({
        ownerName: 'A',
        shopName: 'B',
        businessCategory: 'GROCERY',
        currencyUsage: 'BOTH',
        timeZone: 'Not/AZone',
      }).success,
    ).toBe(false);
  });

  it('maps currency usage to the currencies a shop may transact in', () => {
    expect(currenciesForUsage('KHR_ONLY')).toEqual(['KHR']);
    expect(currenciesForUsage('USD_ONLY')).toEqual(['USD']);
    expect(currenciesForUsage('BOTH')).toEqual(['KHR', 'USD']);
  });
});

describe('notificationPreferencesSchema', () => {
  it('hides amounts on the lock screen by default', () => {
    const result = notificationPreferencesSchema.safeParse({
      dayBeforeEnabled: true,
      onDueDateEnabled: true,
      overdueFollowUpEnabled: true,
      reminderHour: 8,
      reminderMinute: 0,
    });
    expect(result.success && result.data.lockScreenDetail).toBe('HIDE_CUSTOMER_AND_AMOUNT');
  });

  it('rejects an impossible reminder time', () => {
    const base = {
      dayBeforeEnabled: true,
      onDueDateEnabled: true,
      overdueFollowUpEnabled: true,
      reminderMinute: 0,
    };
    expect(notificationPreferencesSchema.safeParse({ ...base, reminderHour: 24 }).success).toBe(false);
    expect(notificationPreferencesSchema.safeParse({ ...base, reminderHour: -1 }).success).toBe(false);
  });
});

describe('exportRequestSchema', () => {
  it('accepts a valid range', () => {
    expect(
      exportRequestSchema.safeParse({
        format: 'CSV',
        report: 'OUTSTANDING_BY_CUSTOMER',
        fromDate: '2026-07-01',
        toDate: '2026-07-31',
      }).success,
    ).toBe(true);
  });

  it('rejects an inverted range', () => {
    const result = exportRequestSchema.safeParse({
      format: 'CSV',
      report: 'PAYMENTS_RECEIVED',
      fromDate: '2026-07-31',
      toDate: '2026-07-01',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('validation.dateRange.inverted');
    }
  });

  it('requires a customer for a customer statement', () => {
    expect(
      exportRequestSchema.safeParse({ format: 'PDF', report: 'CUSTOMER_STATEMENT' }).success,
    ).toBe(false);
    expect(
      exportRequestSchema.safeParse({
        format: 'PDF',
        report: 'CUSTOMER_STATEMENT',
        customerId: uuidV4(),
      }).success,
    ).toBe(true);
  });
});

describe('setPinSchema', () => {
  it('accepts a reasonable PIN', () => {
    expect(setPinSchema.safeParse({ pin: '4917', confirmPin: '4917' }).success).toBe(true);
  });

  it('rejects a mismatch', () => {
    const result = setPinSchema.safeParse({ pin: '4917', confirmPin: '4918' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('validation.pin.mismatch');
    }
  });

  it('rejects trivially guessable PINs', () => {
    expect(setPinSchema.safeParse({ pin: '1111', confirmPin: '1111' }).success).toBe(false);
    expect(setPinSchema.safeParse({ pin: '1234', confirmPin: '1234' }).success).toBe(false);
    expect(setPinSchema.safeParse({ pin: '4321', confirmPin: '4321' }).success).toBe(false);
  });

  it('rejects a non-numeric or wrong-length PIN', () => {
    expect(setPinSchema.safeParse({ pin: '12a4', confirmPin: '12a4' }).success).toBe(false);
    expect(setPinSchema.safeParse({ pin: '123', confirmPin: '123' }).success).toBe(false);
    expect(setPinSchema.safeParse({ pin: '123456789', confirmPin: '123456789' }).success).toBe(false);
  });
});

describe('attachment validation', () => {
  const base = {
    id: ID,
    mimeType: 'image/jpeg' as const,
    byteSize: 1024,
    kind: 'RECEIPT' as const,
    fileName: 'receipt.jpg',
  };

  it('accepts a photographed receipt', () => {
    expect(attachmentUploadSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a file type we will not serve', () => {
    expect(attachmentUploadSchema.safeParse({ ...base, mimeType: 'application/zip' }).success).toBe(
      false,
    );
    expect(
      attachmentUploadSchema.safeParse({ ...base, mimeType: 'text/html' }).success,
    ).toBe(false);
  });

  it('rejects a file over the size limit', () => {
    expect(
      attachmentUploadSchema.safeParse({ ...base, byteSize: MAX_ATTACHMENT_BYTES + 1 }).success,
    ).toBe(false);
  });

  it('sanitizes a hostile filename', () => {
    const result = attachmentUploadSchema.safeParse({ ...base, fileName: '../../etc/passwd' });
    expect(result.success && result.data.fileName).toBe('passwd');
  });

  it('strips traversal, directories and exotic characters', () => {
    expect(sanitizeFileName('../../secret.png')).toBe('secret.png');
    expect(sanitizeFileName('C:\\Windows\\evil.png')).toBe('evil.png');
    expect(sanitizeFileName('....//x.png')).toBe('x.png');
    expect(sanitizeFileName('my receipt (2).jpg')).toBe('my_receipt_2.jpg');
  });

  it('keeps the extension when the name is written in Khmer script', () => {
    // A Khmer-locale phone names photos in Khmer. The extension is the only hint
    // of the file's type and must survive sanitizing.
    expect(sanitizeFileName('រូបភាព.jpg')).toBe('file.jpg');
    expect(sanitizeFileName('បង្កាន់ដៃ_១.png')).toBe('file.png');
  });

  it('truncates a very long name but keeps its extension', () => {
    const result = sanitizeFileName(`${'a'.repeat(200)}.jpg`);
    expect(result.endsWith('.jpg')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(111);
  });

  it('falls back to a generic name rather than refusing the upload', () => {
    // The storage path comes from the attachment UUID, so the filename is
    // cosmetic; blocking a receipt over it would be the wrong trade.
    expect(sanitizeFileName('///')).toBe('file');
    expect(attachmentUploadSchema.safeParse({ ...base, fileName: '///' }).success).toBe(true);
  });
});

describe('environment validation', () => {
  it('accepts a valid mobile environment', () => {
    const env = parseEnv(mobileEnvSchema, {
      EXPO_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(40),
      EXPO_PUBLIC_APP_ENV: 'local',
    });
    expect(env.EXPO_PUBLIC_APP_ENV).toBe('local');
  });

  it('fails loudly on a missing variable', () => {
    expect(() => parseEnv(mobileEnvSchema, {})).toThrow(EnvironmentValidationError);
  });

  it('names the offending variable in the error', () => {
    try {
      parseEnv(mobileEnvSchema, { EXPO_PUBLIC_SUPABASE_URL: 'not-a-url' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('EXPO_PUBLIC_SUPABASE_URL');
    }
  });

  it('has no field for the service-role key in any client schema', () => {
    // Structural guarantee: a client bundle cannot even name the privileged key.
    const mobileKeys = Object.keys(mobileEnvSchema.shape);
    expect(mobileKeys).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(Object.keys(adminServerEnvSchema.shape)).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
