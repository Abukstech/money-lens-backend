
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
      x,
      y,
      text,
      width: 80,
      height: 10,
    })),
  };
}

const header = makeLine(700, [
  [40, 'Date'],
  [160, 'Narration'],
  [460, 'Debit (NGN)'],
  [570, 'Credit (NGN)'],
  [700, 'Balance'],
]);

const firstTransaction = makeLine(680, [
  [40, '2026-10-15'],
  [160, 'NIP TRANSFER TO ADEBAYO'],
  [460, '25000.00'],
  [700, '175000.00'],
]);

describe('MoneyLens multiline narration support', () => {
  it('merges narration and reference continuation lines', () => {
    const lines = [
      header,
      firstTransaction,

      makeLine(667, [
        [180, 'TUNDE FOR HOUSE RENT'],
      ]),

      makeLine(655, [
        [180, 'REF: NIP202610150001'],
      ]),

      makeLine(630, [
        [40, '2026-10-16'],
        [160, 'REFUND'],
        [570, '5000.00'],
        [700, '180000.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.continuations).toHaveLength(2);

    expect(result.rows[0].description).toBe(
      'NIP TRANSFER TO ADEBAYO TUNDE FOR HOUSE RENT',
    );

    expect(result.rows[0].reference).toBe(
      'NIP202610150001',
    );

    expect(result.rows[0].amount).toBe('25000.00');
    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[1].direction).toBe('credit');
  });

  it('does not merge an undated line containing an amount', () => {
    const lines = [
      header,
      firstTransaction,
      makeLine(667, [
        [160, 'UNKNOWN PAYMENT'],
        [460, '3000.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.continuations).toHaveLength(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('does not merge a statement footer', () => {
    const lines = [
      header,
      firstTransaction,
      makeLine(667, [
        [160, 'TOTAL DEBITS'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.continuations).toHaveLength(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects distant continuation text', () => {
    const lines = [
      header,
      firstTransaction,
      makeLine(640, [
        [180, 'UNRELATED TEXT'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.continuations).toHaveLength(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
