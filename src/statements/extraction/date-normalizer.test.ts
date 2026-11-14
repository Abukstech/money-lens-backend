
import { describe, expect, it } from 'vitest';
import { normalizeStatementDate } from './date-normalizer';

describe('MoneyLens date normalization', () => {
  it('accepts ISO dates', () => {
    expect(normalizeStatementDate('2026-10-15'))
      .toBe('2026-10-15');
  });

  it('accepts unambiguous Nigerian date formats', () => {
    expect(normalizeStatementDate('15/10/2026'))
      .toBe('2026-10-15');

    expect(normalizeStatementDate('15-10-2026'))
      .toBe('2026-10-15');
  });

  it('accepts month names', () => {
    expect(normalizeStatementDate('15 Oct 2026'))
      .toBe('2026-10-15');
  });

  it('requires a convention for ambiguous dates', () => {
    expect(normalizeStatementDate('03/04/2026'))
      .toBeNull();

    expect(normalizeStatementDate('03/04/2026', 'DMY'))
      .toBe('2026-04-03');
  });

  it('rejects invalid dates', () => {
    expect(normalizeStatementDate('31/02/2026'))
      .toBeNull();

    expect(normalizeStatementDate('invalid'))
      .toBeNull();
  });
});
