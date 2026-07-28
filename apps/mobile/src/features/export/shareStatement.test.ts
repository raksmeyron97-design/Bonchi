import { statementFileName } from './shareStatement';

/**
 * A customer's name goes straight into a file name, and a customer's name is
 * free text the merchant typed. Every case here is something a real shop owner
 * could plausibly enter.
 */

describe('statementFileName', () => {
  it('keeps a Khmer name in Khmer', () => {
    // Transliterating would leave the merchant unable to recognise their own
    // sent files.
    expect(statementFileName('សុខ ដារា', 'KHR', '2026-07-28')).toBe(
      'សុខ-ដារា-KHR-2026-07-28.pdf',
    );
  });

  it('collapses spaces to dashes', () => {
    expect(statementFileName('Sok  Dara', 'USD', '2026-07-28')).toBe('Sok-Dara-USD-2026-07-28.pdf');
  });

  it('strips path separators so the name cannot escape the directory', () => {
    // Separators go first, then the leading dots, leaving nothing that can
    // traverse out of the cache directory.
    expect(statementFileName('../../etc/passwd', 'KHR', '2026-07-28')).toBe(
      'etcpasswd-KHR-2026-07-28.pdf',
    );
  });

  it('strips characters that break share targets', () => {
    expect(statementFileName('A:B*C?D"E<F>G|H', 'KHR', '2026-07-28')).toBe(
      'ABCDEFGH-KHR-2026-07-28.pdf',
    );
  });

  it('removes a leading dot so the file is not hidden', () => {
    expect(statementFileName('.hidden', 'KHR', '2026-07-28')).toBe('hidden-KHR-2026-07-28.pdf');
  });

  it('strips control characters pasted into a name', () => {
    expect(statementFileName('Sok\nDara\tSrey', 'KHR', '2026-07-28')).toBe(
      'Sok-Dara-Srey-KHR-2026-07-28.pdf',
    );
  });

  it('falls back to a usable name when nothing survives', () => {
    // A file the merchant cannot share is worse than a generic name.
    expect(statementFileName('///', 'KHR', '2026-07-28')).toBe('statement-KHR-2026-07-28.pdf');
    expect(statementFileName('   ', 'KHR', '2026-07-28')).toBe('statement-KHR-2026-07-28.pdf');
  });

  it('keeps a long Khmer name inside the filesystem byte limit', () => {
    // Khmer is three bytes per character in UTF-8, so the 255-byte cap arrives
    // three times sooner than a character count suggests.
    const longName = 'ស'.repeat(200);
    const fileName = statementFileName(longName, 'KHR', '2026-07-28');

    expect(Buffer.byteLength(fileName, 'utf8')).toBeLessThan(255);
  });

  it('separates the two currencies into different files', () => {
    const khr = statementFileName('សុខ ដារា', 'KHR', '2026-07-28');
    const usd = statementFileName('សុខ ដារា', 'USD', '2026-07-28');

    // A customer owing both gets two statements; one must not overwrite the other.
    expect(khr).not.toBe(usd);
  });
});
