import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import DecimalJs from 'decimal.js';
// Keep kobo exact when aggregates exceed a single DECIMAL(20,2) row.
const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
type Decimal = DecimalJs;
import { createHash } from 'node:crypto';
import { Db } from '../common/db';
import { categories, Category } from '../classification/ontology';
import { CALCULATION_VERSION, Metric, MonthlyFacts } from './contracts';

export const expenseCategories = categories.filter(
  (c) =>
    ![
      'income',
      'gift_received',
      'loan_received',
      'repayment_received',
      'refund',
      'cash_withdrawal',
      'internal_transfer',
      'savings',
      'investments',
      'unknown',
      'transfer_unknown',
    ].includes(c),
);
const select = {
  id: true,
  date: true,
  amount: true,
  direction: true,
  category: true,
  status: true,
  validationIssues: true,
  linkedTransactionId: true,
  revision: true,
} satisfies Prisma.TransactionSelect;
export type FactRow = Prisma.TransactionGetPayload<{ select: typeof select }>;
export function usable(row: FactRow) {
  return (
    ['auto_classified', 'user_confirmed'].includes(row.status) &&
    !row.validationIssues.length &&
    categories.includes(row.category as Category) &&
    !['unknown', 'transfer_unknown'].includes(row.category) &&
    (row.direction === 'credit'
      ? [
          'income',
          'refund',
          'internal_transfer',
          'gift_received',
          'loan_received',
          'repayment_received',
        ].includes(row.category)
      : row.direction === 'debit' && !['income', 'refund'].includes(row.category))
  );
}
export function monthBounds(month: string) {
  const start = new Date(`${month}-01T00:00:00.000Z`);
  return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}
function currentMonth(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}
@Injectable()
export class FinancialFacts {
  constructor(@Inject(Db) private readonly db: Db) {}
  async build(userId: string, month: string, now = new Date()): Promise<MonthlyFacts> {
    const { start, end } = monthBounds(month);
    // Repeatable read keeps classifications, linked refunds and monthly settings consistent.
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.transaction.findMany({
          where: { userId, date: { gte: start, lt: end } },
          select,
          orderBy: { id: 'asc' },
        });
        const context = await tx.monthlyFinancialContext.findUnique({
          where: { userId_month: { userId, month } },
        });
        const incomplete = await tx.statement.count({
          where: {
            userId,
            status: { not: 'extracted' },
            transactions: { some: { date: { gte: start, lt: end } } },
          },
        });
        const unknownPeriodImports = await tx.statement.count({
          where: { userId, status: { not: 'extracted' }, transactions: { none: {} } },
        });
        const linkedIds = [
          ...new Set(
            rows
              .filter(
                (r) =>
                  usable(r) &&
                  r.direction === 'credit' &&
                  r.category === 'refund' &&
                  r.linkedTransactionId,
              )
              .map((r) => r.linkedTransactionId!),
          ),
        ];
        const originals = linkedIds.length
          ? await tx.transaction.findMany({ where: { userId, id: { in: linkedIds } }, select })
          : [];
        const allLinkedRefunds = linkedIds.length
          ? await tx.transaction.findMany({
              where: {
                userId,
                linkedTransactionId: { in: linkedIds },
                direction: 'credit',
                category: 'refund',
                status: { in: ['auto_classified', 'user_confirmed'] },
              },
              select,
            })
          : [];
        return calculateFacts(
          month,
          rows,
          context
            ? {
                takeHomeIncome: context.takeHomeIncome?.toFixed(2) ?? null,
                savingsTarget: context.savingsTarget?.toFixed(2) ?? null,
                spendingCoverageConfirmed: context.spendingCoverageConfirmed,
              }
            : null,
          originals,
          allLinkedRefunds,
          incomplete,
          unknownPeriodImports,
          now,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
export interface ContextValues {
  takeHomeIncome: string | null;
  savingsTarget: string | null;
  spendingCoverageConfirmed: boolean;
}
export function calculateFacts(
  month: string,
  rows: FactRow[],
  context: ContextValues | null,
  originals: FactRow[] = [],
  allLinkedRefunds: FactRow[] = [],
  incomplete = 0,
  unknownPeriodImports = 0,
  now = new Date(),
): MonthlyFacts {
  const metrics: Record<string, Metric> = {};
  const put = (id: string, value: DecimalJs.Value, kind: Metric['kind'], label: string) => {
    metrics[id] = { value: new Decimal(value).toFixed(kind === 'count' ? 0 : 2), kind, label };
  };
  const totals = {
    observedIncome: new Decimal(0),
    grossExpenses: new Decimal(0),
    samePeriodRefunds: new Decimal(0),
    priorPeriodRefunds: new Decimal(0),
    unlinkedRefunds: new Decimal(0),
    savings: new Decimal(0),
    investments: new Decimal(0),
    cash: new Decimal(0),
    internal: new Decimal(0),
    unclassifiedDebits: new Decimal(0),
    unclassifiedCredits: new Decimal(0),
    otherCredits: new Decimal(0),
    gifts: new Decimal(0),
    loans: new Decimal(0),
    repayments: new Decimal(0),
  };
  const gross: Partial<Record<Category, Decimal>> = {};
  const refunds: Partial<Record<Category, Decimal>> = {};
  let accepted = 0,
    possibleDuplicates = 0,
    extractionIssues = 0,
    refundIssues = 0;
  const { start, end } = monthBounds(month);
  for (const row of rows) {
    const amount = new Decimal(row.amount.toString());
    if (row.validationIssues.some((i) => i.includes('DUPLICATE'))) possibleDuplicates++;
    if (row.validationIssues.length) extractionIssues++;
    if (!usable(row)) {
      if (row.direction === 'debit')
        totals.unclassifiedDebits = totals.unclassifiedDebits.plus(amount);
      else totals.unclassifiedCredits = totals.unclassifiedCredits.plus(amount);
      continue;
    }
    accepted++;
    if (row.direction === 'credit') {
      if (row.category === 'income') totals.observedIncome = totals.observedIncome.plus(amount);
      else if (row.category === 'refund') {
        const original = originals.find((r) => r.id === row.linkedTransactionId);
        const all = allLinkedRefunds.filter(
          (r) => r.linkedTransactionId === row.linkedTransactionId,
        );
        const refunded = all.reduce((sum, r) => sum.plus(r.amount.toString()), new Decimal(0));
        const valid =
          original &&
          usable(original) &&
          original.direction === 'debit' &&
          expenseCategories.includes(original.category as Category) &&
          refunded.lte(original.amount.toString()) &&
          all.every(usable);
        if (valid) {
          if (original.date >= start && original.date < end) {
            totals.samePeriodRefunds = totals.samePeriodRefunds.plus(amount);
            const cat = original.category as Category;
            refunds[cat] = (refunds[cat] ?? new Decimal(0)).plus(amount);
          } else totals.priorPeriodRefunds = totals.priorPeriodRefunds.plus(amount);
        } else {
          totals.unlinkedRefunds = totals.unlinkedRefunds.plus(amount);
          refundIssues++;
        }
      } else if (row.category === 'internal_transfer')
        totals.internal = totals.internal.plus(amount);
      else if (row.category === 'gift_received') totals.gifts = totals.gifts.plus(amount);
      else if (row.category === 'loan_received') totals.loans = totals.loans.plus(amount);
      else if (row.category === 'repayment_received')
        totals.repayments = totals.repayments.plus(amount);
      else totals.otherCredits = totals.otherCredits.plus(amount);
    } else if (expenseCategories.includes(row.category as Category)) {
      totals.grossExpenses = totals.grossExpenses.plus(amount);
      const category = row.category as Category;
      gross[category] = (gross[category] ?? new Decimal(0)).plus(amount);
    } else if (row.category === 'savings') totals.savings = totals.savings.plus(amount);
    else if (row.category === 'investments') totals.investments = totals.investments.plus(amount);
    else if (row.category === 'cash_withdrawal') totals.cash = totals.cash.plus(amount);
    else if (row.category === 'internal_transfer') totals.internal = totals.internal.plus(amount);
    else totals.unclassifiedDebits = totals.unclassifiedDebits.plus(amount);
  }
  const netExpenses = totals.grossExpenses.minus(totals.samePeriodRefunds);
  const income =
    context?.takeHomeIncome != null
      ? new Decimal(context.takeHomeIncome)
      : totals.observedIncome.gt(0)
        ? totals.observedIncome
        : null;
  const target = context?.savingsTarget != null ? new Decimal(context.savingsTarget) : null;
  const remainingTarget = target ? Decimal.max(target.minus(totals.savings), 0) : null;
  const room = income
    ? income.minus(netExpenses).minus(totals.savings).minus(totals.investments)
    : null;
  const shortfall =
    remainingTarget && room
      ? remainingTarget.eq(0)
        ? new Decimal(0)
        : Decimal.max(remainingTarget.minus(room), 0)
      : null;
  put('extraction_review_records', extractionIssues, 'count', 'Records needing validation review');
  put(
    'possible_duplicates',
    possibleDuplicates,
    'count',
    'Possible duplicate records needing review',
  );
  put('refund_review_records', refundIssues, 'count', 'Refund records needing reconciliation');
  put('incomplete_imports', incomplete, 'count', 'Incomplete imports associated with this month');
  put('records', rows.length, 'count', 'Recorded transactions');
  put('classified_records', accepted, 'count', 'Usable classified transactions');
  put(
    'observed_income',
    totals.observedIncome,
    'money',
    'Observed classified income, not added to reported income',
  );
  if (context?.takeHomeIncome != null)
    put(
      'reported_income',
      context.takeHomeIncome,
      'money',
      'User-reported monthly take-home income',
    );
  if (income) put('income_basis', income, 'money', 'Income basis for conditional comparisons');
  put('gross_expenses', totals.grossExpenses, 'money', 'Known gross expense debits');
  put(
    'linked_expense_refunds',
    totals.samePeriodRefunds,
    'money',
    'Refunds linked to expenses in this month',
  );
  put('net_expenses', netExpenses, 'money', 'Known expenses after validated same-month refunds');
  put(
    'prior_period_refunds',
    totals.priorPeriodRefunds,
    'money',
    'Linked refunds for earlier-period expenses; not deducted from this month expenses',
  );
  put(
    'unreconciled_refunds',
    totals.unlinkedRefunds,
    'money',
    'Refund credits needing reconciliation',
  );
  put(
    'savings_contributions',
    totals.savings,
    'money',
    'Recorded savings contributions, not total savings balance',
  );
  put('investment_contributions', totals.investments, 'money', 'Recorded investment contributions');
  put('cash_withdrawals', totals.cash, 'money', 'Cash movements with unknown final use');
  put(
    'internal_movements',
    totals.internal,
    'money',
    'Internal transfer legs, not expenses or income',
  );
  put(
    'unclassified_debits',
    totals.unclassifiedDebits,
    'money',
    'Debits with unresolved purpose or validation issues',
  );
  put(
    'unclassified_credits',
    totals.unclassifiedCredits,
    'money',
    'Credits with unresolved purpose or validation issues',
  );
  put(
    'gifts_received',
    totals.gifts,
    'money',
    'Gifts and support received, separate from earnings',
  );
  put('loans_received', totals.loans, 'money', 'Borrowed money, not earnings');
  put(
    'repayments_received',
    totals.repayments,
    'money',
    'Repayments and reimbursements, not netted against expenses',
  );
  put('other_credits', totals.otherCredits, 'money', 'Other credits not assumed to be income');
  if (target) put('savings_target', target, 'money', 'User-stated savings contribution target');
  if (remainingTarget)
    put(
      'remaining_savings_target',
      remainingTarget,
      'money',
      'Savings target not yet represented by recorded contributions',
    );
  if (room) {
    put(
      'remaining_after_known_allocations',
      room,
      'money',
      'Income less known net expenses, savings and investments, before unrecorded or unresolved uses; not actual savings',
    );
    put(
      'known_allocation_deficit',
      Decimal.max(room.negated(), 0),
      'money',
      'Known allocations exceeding income basis',
    );
  }
  if (shortfall)
    put(
      'savings_funding_gap',
      shortfall,
      'money',
      'Conditional gap to fund the remaining target after known allocations; not proof of savings elsewhere',
    );
  for (const category of expenseCategories) {
    const amount = (gross[category] ?? new Decimal(0)).minus(refunds[category] ?? 0);
    put(
      `expenses.${category}`,
      amount,
      'money',
      `Known net ${category.replace(/_/g, ' ')} expenses`,
    );
    if (income?.gt(0))
      put(
        `income_share.${category}`,
        amount.div(income).times(100),
        'percent',
        `${category} as a share of income basis`,
      );
  }
  const thisMonth = currentMonth(now);
  const partialMonth = month === thisMonth;
  const futureMonth = month > thisMonth;
  const limitations: string[] = [];
  const questions: string[] = [];
  if (!rows.length) {
    limitations.push('No transactions are available for this month.');
    questions.push('Can you add records for the selected month?');
  }
  if (!context?.spendingCoverageConfirmed) {
    limitations.push('Account and spending coverage has not been confirmed by the user.');
    questions.push(
      'Do these records cover all your spending for this month, including other accounts and cash?',
    );
  }
  if (partialMonth)
    limitations.push(
      'This calendar month is still in progress; figures are observations to date, not a month-end forecast.',
    );
  if (futureMonth)
    limitations.push('This period is in the future; do not describe plans as observed spending.');
  if (rows.length !== accepted)
    limitations.push(
      'Some transactions are unresolved or fail validation; they cannot be assigned to known spending categories.',
    );
  if (totals.cash.gt(0))
    limitations.push(
      'Cash withdrawals are cash movements; their final spending purpose is unknown.',
    );
  if (incomplete)
    limitations.push('Some imports containing transactions in this month need extraction review.');
  if (unknownPeriodImports)
    limitations.push(
      'Incomplete imports with no dated rows may contain additional records; their period is unknown.',
    );
  if (possibleDuplicates)
    limitations.push(
      'Possible duplicate records require review and are excluded from accepted category totals.',
    );
  if (refundIssues)
    limitations.push(
      'Some refund links are missing, invalid, or exceed the original expense; these refunds are not netted.',
    );
  if (!context || context.takeHomeIncome === null) {
    limitations.push(
      'Monthly take-home income is not confirmed; observed credits may be incomplete.',
    );
    questions.push('What was your take-home income for this month?');
  }
  if (income?.eq(0))
    limitations.push('The income basis is zero; income-share percentages cannot be calculated.');
  if (target === null) questions.push('How much did you aim to contribute to savings this month?');
  limitations.push(
    'Recorded savings contributions do not establish the balance of savings held elsewhere.',
  );
  const complete =
    rows.length > 0 &&
    accepted === rows.length &&
    !!context?.spendingCoverageConfirmed &&
    context.takeHomeIncome !== null &&
    !partialMonth &&
    !futureMonth &&
    !incomplete &&
    !unknownPeriodImports &&
    !refundIssues &&
    !possibleDuplicates &&
    !totals.cash.gt(0) &&
    totals.otherCredits.eq(0);
  const dataVersion = createHash('sha256')
    .update(
      JSON.stringify({
        month,
        rows: rows.map((r) => ({
          id: r.id,
          revision: r.revision,
          amount: r.amount.toString(),
          category: r.category,
          status: r.status,
          issues: r.validationIssues,
          link: r.linkedTransactionId,
        })),
        context,
        originals,
        allLinkedRefunds,
        incomplete,
        unknownPeriodImports,
        partialMonth,
        futureMonth,
      }),
    )
    .digest('hex');
  return {
    month,
    currency: 'NGN',
    asOf: now.toISOString(),
    calculationVersion: CALCULATION_VERSION,
    dataVersion,
    incomeSource:
      context?.takeHomeIncome != null
        ? 'user_reported'
        : income
          ? 'observed_classified'
          : 'unknown',
    goalStatus:
      target === null ? 'not_provided' : totals.savings.gte(target) ? 'met' : 'not_met_in_records',
    coverage: {
      records: rows.length,
      classifiedRecords: accepted,
      classificationCoverage: rows.length ? accepted / rows.length : 0,
      spendingCoverageConfirmed: context?.spendingCoverageConfirmed ?? false,
      partialMonth,
      futureMonth,
      complete,
    },
    metrics,
    limitations,
    questions,
  };
}
