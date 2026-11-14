
import { describe, expect, it } from 'vitest';
import type { LayoutLine } from './detector';
import { parseTableLines } from './table-parser';
import { reconcileTransactions } from './reconcile';

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

const lines: LayoutLine[] = [
  makeLine(700, [
    [40, 'Date'],
    [160, 'Narration'],
    [480, 'Debit (NGN)'],
    [620, 'Credit (NGN)'],
  ]),
  makeLine(680, [
    [40, '2026-10-15'],
    [160, 'POS PURCHASE'],
    [480, '2500.00'],
  ]),
  makeLine(660, [
    [40, '2026-10-16'],
    [160, 'SALARY PAYMENT'],
    [620, '150000.00'],
  ]),
  makeLine(640, [
    [40, '2026-10-17'],
    [160, 'TRANSFER'],
    [480, '25000.00'],
  ]),
];

describe('MoneyLens statements without balances', () => {
  it('extracts transactions without running balances', () => {
    const result = parseTableLines(lines);

    expect(result.rows).toHaveLength(3);
    expect(result.issues).toHaveLength(0);

    expect(result.rows[0].balance).toBeNull();
    expect(result.rows[0].amount).toBe('2500.00');
    expect(result.rows[0].direction).toBe('debit');

    expect(result.rows[1].amount).toBe('150000.00');
    expect(result.rows[1].direction).toBe('credit');

    expect(result.rows[2].amount).toBe('25000.00');
    expect(result.rows[2].direction).toBe('debit');
  });

  it('calculates totals but does not claim reconciliation', () => {
    const parsed = parseTableLines(lines);
    const result = reconcileTransactions(parsed.rows);

    expect(result.totalDebits).toBe('27500.00');
    expect(result.totalCredits).toBe('150000.00');

    expect(result.checkedPairs).toBe(0);
    expect(result.reconciled).toBe(false);

    expect(result.issues.some(
      issue => issue.code === 'BALANCE_NOT_VERIFIABLE',
    )).toBe(true);
  });

  it('does not reconcile a single transaction', () => {
    const parsed = parseTableLines(lines);
    const result = reconcileTransactions(parsed.rows.slice(0, 1));

    expect(result.reconciled).toBe(false);
  });
});
