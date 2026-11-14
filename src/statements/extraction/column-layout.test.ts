
import { describe, expect, it } from 'vitest';
import type { LayoutLine } from './detector';
import { parseTableLines } from './table-parser';

function makeLine(
  y: number,
  values: Array<[number, string]>,
): LayoutLine {
  return {
    page: 0,
    y,
    text: values.map(([, text]) => text).join(' '),
    items: values.map(([x, text]) => ({
      text,
      x,
      y,
      width: 80,
      height: 10,
    })),
  };
}

describe('MoneyLens universal amount layouts', () => {
  it('supports a signed amount column', () => {
    const lines = [
      makeLine(700, [
        [40, 'Date'],
        [160, 'Narration'],
        [460, 'Amount (NGN)'],
        [700, 'Balance'],
      ]),
      makeLine(680, [
        [40, '2026-10-01'],
        [160, 'POS PURCHASE'],
        [460, '-2500.00'],
        [700, '97500.00'],
      ]),
      makeLine(660, [
        [40, '2026-10-02'],
        [160, 'SALARY'],
        [460, '+10000.00'],
        [700, '107500.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[0].amount).toBe('2500.00');
    expect(result.rows[1].direction).toBe('credit');
    expect(result.rows[1].amount).toBe('10000.00');
  });

  it('supports amount and DR/CR indicator', () => {
    const lines = [
      makeLine(700, [
        [40, 'Date'],
        [160, 'Narration'],
        [460, 'Amount (NGN)'],
        [570, 'DR/CR'],
        [700, 'Balance'],
      ]),
      makeLine(680, [
        [40, '2026-10-01'],
        [160, 'PURCHASE'],
        [460, '200.00'],
        [570, 'DR'],
        [700, '99800.00'],
      ]),
      makeLine(660, [
        [40, '2026-10-02'],
        [160, 'REFUND'],
        [460, '300.00'],
        [570, 'CR'],
        [700, '100100.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[1].direction).toBe('credit');
  });

  it('rejects an amount without direction evidence', () => {
    const lines = [
      makeLine(700, [
        [40, 'Date'],
        [160, 'Narration'],
        [460, 'Amount (NGN)'],
        [700, 'Balance'],
      ]),
      makeLine(680, [
        [40, '2026-10-01'],
        [160, 'TRANSFER'],
        [460, '5000.00'],
        [700, '95000.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.rows).toHaveLength(0);
    expect(result.issues.some(
      issue => issue.code === 'AMBIGUOUS_TRANSACTION_DIRECTION',
    )).toBe(true);
  });
});
