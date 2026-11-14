import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { calculateFacts, FactRow, monthBounds } from '../src/insights/facts';
import { simulateCategoryCut } from '../src/insights/scenarios';
import { contextInput, monthSchema, scenarioInput } from '../src/insights/contracts';
const now = new Date('2026-10-25T12:00:00Z');
const context = {
  takeHomeIncome: '500000.00',
  savingsTarget: '50000.00',
  spendingCoverageConfirmed: true,
};
function row(
  id: string,
  category: string,
  amount: string,
  overrides: Partial<FactRow> = {},
): FactRow {
  return {
    id,
    date: new Date('2026-09-15'),
    category,
    amount: new Prisma.Decimal(amount),
    direction: 'debit',
    status: 'user_confirmed',
    validationIssues: [],
    linkedTransactionId: null,
    revision: 1,
    ...overrides,
  };
}
const base = [row('essential', 'housing', '380000'), row('dining', 'dining', '100000')];
describe('month context and exact calculations', () => {
  it('validates months, missing context, and NGN precision', () => {
    expect(monthSchema.safeParse('2026-13').success).toBe(false);
    expect(monthSchema.safeParse('2026-9').success).toBe(false);
    expect(
      contextInput.parse({
        takeHomeIncome: null,
        savingsTarget: null,
        spendingCoverageConfirmed: false,
      }).currency,
    ).toBe('NGN');
    expect(contextInput.safeParse({ ...context, currency: 'USD' }).success).toBe(false);
    expect(contextInput.safeParse({ ...context, takeHomeIncome: '1.001' }).success).toBe(false);
    expect(monthBounds('2024-02').end.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });
  it('calculates the example without calling remaining funds actual savings', () => {
    const f = calculateFacts('2026-09', base, context, [], [], 0, 0, now);
    expect(f.metrics.net_expenses.value).toBe('480000.00');
    expect(f.metrics.remaining_after_known_allocations.value).toBe('20000.00');
    expect(f.metrics.savings_funding_gap.value).toBe('30000.00');
    expect(f.metrics.savings_contributions.value).toBe('0.00');
    expect(f.coverage.complete).toBe(true);
  });
  it('keeps kobo exact when totals exceed individual database precision', () => {
    const facts = calculateFacts(
      '2026-09',
      [row('a', 'dining', '999999999999999999.99'), row('b', 'dining', '999999999999999999.99')],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(facts.metrics.net_expenses.value).toBe('1999999999999999999.98');
    const scenario = simulateCategoryCut(
      facts,
      { category: 'dining', reductionPercent: '50', reductionAmount: null },
      'large',
    );
    expect(scenario.metrics['scenarios.large.reduction'].value).toBe('999999999999999999.99');
  });
  it('never adds observed income to user-reported income', () => {
    const f = calculateFacts(
      '2026-09',
      [...base, row('income', 'income', '400000', { direction: 'credit' })],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(f.metrics.observed_income.value).toBe('400000.00');
    expect(f.metrics.income_basis.value).toBe('500000.00');
    expect(f.incomeSource).toBe('user_reported');
  });
  it('recognizes existing savings goal achievement even if known allocations exceed income', () => {
    const f = calculateFacts(
      '2026-09',
      [...base, row('saving', 'savings', '50000')],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(f.goalStatus).toBe('met');
    expect(f.metrics.remaining_savings_target.value).toBe('0.00');
    expect(f.metrics.savings_funding_gap.value).toBe('0.00');
    expect(f.metrics.known_allocation_deficit.value).toBe('30000.00');
  });
  it('does not count investments or owned transfers as consumption', () => {
    const f = calculateFacts(
      '2026-09',
      [
        row('dining', 'dining', '100000'),
        row('save', 'savings', '50000'),
        row('invest', 'investments', '20000'),
        row('internal-out', 'internal_transfer', '80000'),
        row('internal-in', 'internal_transfer', '80000', { direction: 'credit' }),
      ],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(f.metrics.net_expenses.value).toBe('100000.00');
    expect(f.metrics.investment_contributions.value).toBe('20000.00');
    expect(f.metrics.remaining_after_known_allocations.value).toBe('330000.00');
  });
  it('keeps unresolved debits, credits, cash and duplicate evidence separate', () => {
    const f = calculateFacts(
      '2026-09',
      [
        row('pending', 'groceries', '60000', { status: 'requires_user_tagging' }),
        row('duplicate', 'shopping', '4000', { validationIssues: ['POSSIBLE_DUPLICATE_REVIEW'] }),
        row('credit', 'unknown', '70000', { direction: 'credit', status: 'pending' }),
        row('cash', 'cash_withdrawal', '5000'),
      ],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(f.metrics.net_expenses.value).toBe('0.00');
    expect(f.metrics.unclassified_debits.value).toBe('64000.00');
    expect(f.metrics.unclassified_credits.value).toBe('70000.00');
    expect(f.metrics.cash_withdrawals.value).toBe('5000.00');
    expect(f.metrics.possible_duplicates.value).toBe('1');
    expect(f.coverage.complete).toBe(false);
  });
  it('does not divide by zero or fabricate an income basis', () => {
    const zero = calculateFacts(
      '2026-09',
      base,
      { ...context, takeHomeIncome: '0.00' },
      [],
      [],
      0,
      0,
      now,
    );
    expect(zero.metrics.income_basis.value).toBe('0.00');
    expect(zero.metrics['income_share.dining']).toBeUndefined();
    const missing = calculateFacts('2026-09', base, null, [], [], 0, 0, now);
    expect(missing.metrics.income_basis).toBeUndefined();
    expect(missing.metrics.savings_funding_gap).toBeUndefined();
    expect(missing.questions).toContain('What was your take-home income for this month?');
  });
  it('handles decimal fractions without floating point accumulation', () => {
    const f = calculateFacts(
      '2026-09',
      [row('a', 'dining', '0.10'), row('b', 'dining', '0.20')],
      context,
      [],
      [],
      0,
      0,
      now,
    );
    expect(f.metrics.net_expenses.value).toBe('0.30');
  });
  it('flags ongoing/future periods, incomplete imports and unconfirmed coverage', () => {
    const partial = calculateFacts('2026-10', base, context, [], [], 1, 1, now);
    expect(partial.coverage.partialMonth).toBe(true);
    expect(partial.coverage.complete).toBe(false);
    expect(calculateFacts('2026-11', [], context, [], [], 0, 0, now).coverage.futureMonth).toBe(
      true,
    );
    expect(
      calculateFacts(
        '2026-09',
        base,
        { ...context, spendingCoverageConfirmed: false },
        [],
        [],
        0,
        0,
        now,
      ).coverage.complete,
    ).toBe(false);
    expect(calculateFacts('2026-09', [], context, [], [], 0, 0, now).questions).toContain(
      'Can you add records for the selected month?',
    );
  });
});
describe('refund reconciliation', () => {
  it('nets same-month linked refunds once and does not treat credits as income', () => {
    const original = row('purchase', 'shopping', '12000');
    const refund = row('refund', 'refund', '12000', {
      direction: 'credit',
      linkedTransactionId: 'purchase',
    });
    const f = calculateFacts(
      '2026-09',
      [original, refund],
      context,
      [original],
      [refund],
      0,
      0,
      now,
    );
    expect(f.metrics.net_expenses.value).toBe('0.00');
    expect(f.metrics.observed_income.value).toBe('0.00');
    expect(f.metrics['expenses.shopping'].value).toBe('0.00');
  });
  it('keeps earlier-period refunds out of current-month category netting', () => {
    const original = row('purchase', 'shopping', '12000', { date: new Date('2026-08-15') });
    const refund = row('refund', 'refund', '12000', {
      direction: 'credit',
      linkedTransactionId: 'purchase',
    });
    const f = calculateFacts('2026-09', [refund], context, [original], [refund], 0, 0, now);
    expect(f.metrics.prior_period_refunds.value).toBe('12000.00');
    expect(f.metrics.linked_expense_refunds.value).toBe('0.00');
  });
  it('does not net missing, foreign or over-refunded links', () => {
    const original = row('purchase', 'shopping', '12000');
    const refund = row('refund', 'refund', '12000', {
      direction: 'credit',
      linkedTransactionId: 'purchase',
    });
    const second = { ...refund, id: 'duplicate-credit' };
    const over = calculateFacts(
      '2026-09',
      [original, refund, second],
      context,
      [original],
      [refund, second],
      0,
      0,
      now,
    );
    expect(over.metrics.net_expenses.value).toBe('12000.00');
    expect(over.metrics.unreconciled_refunds.value).toBe('24000.00');
    expect(over.coverage.complete).toBe(false);
    expect(
      calculateFacts('2026-09', [refund], context, [], [refund], 0, 0, now).metrics
        .unreconciled_refunds.value,
    ).toBe('12000.00');
  });
});
describe('read-only scenarios', () => {
  const f = calculateFacts('2026-09', base, context, [], [], 0, 0, now);
  it('computes the proposed dining cut without changing the facts', () => {
    const before = JSON.stringify(f);
    const scenario = simulateCategoryCut(
      f,
      { category: 'dining', reductionPercent: null, reductionAmount: '30000' },
      'cut_1',
    );
    expect(scenario.metrics['scenarios.cut_1.reduction'].value).toBe('30000.00');
    expect(scenario.metrics['scenarios.cut_1.remaining_funding_gap'].value).toBe('0.00');
    expect(JSON.stringify(f)).toBe(before);
  });
  it('calculates arbitrary percentages and rounds to kobo', () => {
    const scenario = simulateCategoryCut(
      f,
      { category: 'dining', reductionPercent: '17.35', reductionAmount: null },
      'cut_1',
    );
    expect(scenario.metrics['scenarios.cut_1.reduction'].value).toBe('17350.00');
  });
  for (const input of [
    { category: 'savings', reductionPercent: '20', reductionAmount: null },
    { category: 'dining', reductionPercent: '101', reductionAmount: null },
    { category: 'dining', reductionPercent: null, reductionAmount: '100000.01' },
    { category: 'dining', reductionPercent: null, reductionAmount: null },
    { category: 'dining', reductionPercent: '20', reductionAmount: '10' },
  ])
    it(`rejects invalid scenario ${JSON.stringify(input)}`, () =>
      expect(() => simulateCategoryCut(f, input, 'cut_1')).toThrow('INVALID_SCENARIO'));
  it('requires exactly one reduction input', () =>
    expect(
      scenarioInput.safeParse({ category: 'dining', reductionPercent: null, reductionAmount: null })
        .success,
    ).toBe(false));
});
