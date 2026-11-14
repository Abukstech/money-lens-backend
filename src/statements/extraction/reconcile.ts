
import Decimal from 'decimal.js';
import type { ParsedTransaction } from './table-parser';

type Order = 'ascending' | 'descending' | 'undetermined' | 'mixed';

export interface ReconciliationIssue {
  code: string;
  page: number;
  row: number;
  expected?: string;
  actual?: string;
}

function signedAmount(row: ParsedTransaction): Decimal {
  const amount = new Decimal(row.amount);
  return row.direction === 'debit' ? amount.negated() : amount;
}

function detectOrder(rows: ParsedTransaction[]): Order {
  let order: Order = 'undetermined';

  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date === rows[i - 1].date) continue;

    const nextOrder =
      rows[i].date > rows[i - 1].date
        ? 'ascending'
        : 'descending';

    if (order !== 'undetermined' && order !== nextOrder) {
      return 'mixed';
    }

    order = nextOrder;
  }

  return order;
}

export function reconcileTransactions(rows: ParsedTransaction[]) {
  const issues: ReconciliationIssue[] = [];
  const order = detectOrder(rows);

  let totalDebits = new Decimal(0);
  let totalCredits = new Decimal(0);
  let checkedPairs = 0;

  for (const row of rows) {
    const amount = new Decimal(row.amount);

    if (amount.lte(0)) {
      issues.push({
        code: 'INVALID_AMOUNT',
        page: row.page,
        row: row.row,
      });
    }

    if (row.direction === 'debit') {
      totalDebits = totalDebits.plus(amount);
    } else {
      totalCredits = totalCredits.plus(amount);
    }
  }

  if (order === 'mixed' || order === 'undetermined') {
    issues.push({
      code: 'TRANSACTION_ORDER_UNVERIFIED',
      page: rows[0]?.page ?? 0,
      row: rows[0]?.row ?? 0,
    });
  } else {
    for (let i = 1; i < rows.length; i++) {
      const earlier =
        order === 'ascending' ? rows[i - 1] : rows[i];

      const later =
        order === 'ascending' ? rows[i] : rows[i - 1];

      if (earlier.balance == null || later.balance == null) {
        issues.push({
          code: 'BALANCE_NOT_VERIFIABLE',
          page: later.page,
          row: later.row,
        });
        continue;
      }

      const actual = new Decimal(later.balance)
        .minus(earlier.balance);

      const expected = signedAmount(later);

      checkedPairs++;

      if (!actual.equals(expected)) {
        issues.push({
          code: 'BALANCE_RECONCILIATION_MISMATCH',
          page: later.page,
          row: later.row,
          expected: expected.toFixed(2),
          actual: actual.toFixed(2),
        });
      }
    }
  }

  const oldest =
    order === 'ascending'
      ? rows[0]
      : order === 'descending'
        ? rows[rows.length - 1]
        : undefined;

  const newest =
    order === 'ascending'
      ? rows[rows.length - 1]
      : order === 'descending'
        ? rows[0]
        : undefined;

  const inferredOpeningBalance =
    oldest?.balance != null
      ? new Decimal(oldest.balance)
          .minus(signedAmount(oldest))
          .toFixed(2)
      : null;

  return {
    transactionCount: rows.length,
    order,
    totalDebits: totalDebits.toFixed(2),
    totalCredits: totalCredits.toFixed(2),
    inferredOpeningBalance,
    closingBalance: newest?.balance ?? null,
    checkedPairs,
    issues,
    reconciled:
  rows.length > 1 &&
  checkedPairs === rows.length - 1 &&
  issues.length === 0 &&
  order !== 'undetermined' &&
  order !== 'mixed',
  };
}
