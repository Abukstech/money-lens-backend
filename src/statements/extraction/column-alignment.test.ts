
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

describe('MoneyLens right-aligned financial columns', () => {

  // TEST 1: Correct credit/debit classification
  it('does not mistake a credit for a debit', () => {
    const lines = [
      makeLine(700, [
        [40, 'Date'],
        [160, 'Narration'],
        [450, 'Debit (NGN)'],
        [570, 'Credit (NGN)'],
        [700, 'Balance'],
      ]),
      makeLine(680, [
        [40, '2026-10-01'],
        [160, 'POS PURCHASE'],
        [450, '5000.00'],
        [700, '95000.00'],
      ]),
      makeLine(660, [
        [40, '2026-10-02'],
        [160, 'SALARY PAYMENT'],
        [500, '150000.00'],
        [700, '245000.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.rows).toHaveLength(2);

    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[0].amount).toBe('5000.00');

    expect(result.rows[1].direction).toBe('credit');
    expect(result.rows[1].amount).toBe('150000.00');
  });

  // TEST 2: Detect ambiguous debit/credit placement
  it('flags amounts positioned between debit and credit', () => {
    const lines = [
      makeLine(700, [
        [40, 'Date'],
        [160, 'Narration'],
        [450, 'Debit (NGN)'],
        [570, 'Credit (NGN)'],
        [700, 'Balance'],
      ]),
      makeLine(680, [
        [40, '2026-10-01'],
        [160, 'POS PURCHASE'],
        [450, '5000.00'],
        [700, '95000.00'],
      ]),
      makeLine(660, [
        [40, '2026-10-02'],
        [160, 'UNKNOWN TRANSFER'],
        // Text center = 510, exactly at the boundary
        [470, '150000.00'],
        [700, '245000.00'],
      ]),
    ];

    const result = parseTableLines(lines);

    expect(result.rows).toHaveLength(1);

    expect(
      result.issues.some(
        issue => issue.code === 'AMBIGUOUS_AMOUNT_COLUMN',
      ),
    ).toBe(true);
  });

});
