import type { LayoutLine } from './detector';
import { detectHeader, type ParsedTransaction } from './table-parser';
import { signedMoney } from '../../transactions/contracts';
import { normalizeStatementDate, type DateOrder } from './date-normalizer';

export interface CoverageIssue {
  page: number;
  code: string;
  expected?: number;
  actual?: number;
}
const DATE_PATTERN =
  /\b(?:\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}|\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{4}|\d{1,2}[\s/-]+[A-Za-z]{3,9}[\s,/-]+\d{4})\b/;

function hasSourceAmounts(line: LayoutLine, row: ParsedTransaction) {
  const values = line.items.flatMap((item) => {
    const text = item.text
      .trim()
      .replace(/^(?:NGN|₦)\s*/i, '')
      .replace(/,/g, '');
    const amount = signedMoney.safeParse(text.replace(/^\+/, ''));
    return amount.success ? [{ value: amount.data, signed: /^[+-]/.test(text) }] : [];
  });

  // An explicit signed source amount verifies direction too. Only distinct
  // cells can establish the transaction amount and running balance.
  const amountIndex = values.findIndex(
    ({ value, signed }) =>
      signed && value === (row.direction === 'debit' ? `-${row.amount}` : row.amount),
  );
  return (
    amountIndex >= 0 &&
    row.balance !== null &&
    values.some(({ value }, index) => index !== amountIndex && value === row.balance)
  );
}

export function verifyExtractionCoverage(
  lines: LayoutLine[],
  rows: ParsedTransaction[],
  totalPages: number,
  options: { dateOrder?: DateOrder; verifySourceAmounts?: boolean } = {},
) {
  const issues: CoverageIssue[] = [];
  let totalCandidates = 0;

  for (let page = 0; page < totalPages; page++) {
    const pageLines = lines.filter((line) => line.page === page).sort((a, b) => b.y - a.y);
    const headerIndex = pageLines.findIndex((line) => detectHeader(line));
    const tableLines = pageLines.slice(headerIndex + 1);

    // Independently identify possible transaction lines
    // from the original PDF text.
    const candidates = tableLines
      .map((line) => ({
        line,
        date: line.text.match(DATE_PATTERN)?.[0] ?? null,
      }))
      .filter((candidate) => candidate.date !== null);

    const parsedRows = rows.filter((row) => row.page === page).sort((a, b) => a.row - b.row);

    totalCandidates += candidates.length;

    if (candidates.length === 0) {
      issues.push({
        page,
        code: 'NO_TRANSACTION_CANDIDATES',
      });
      continue;
    }

    if (candidates.length !== parsedRows.length) {
      issues.push({
        page,
        code: 'TRANSACTION_COVERAGE_MISMATCH',
        expected: candidates.length,
        actual: parsedRows.length,
      });
      continue;
    }

    // Verify that parsed dates correspond to the
    // original candidate lines in document order.
    for (let i = 0; i < candidates.length; i++) {
      const sourceDate = candidates[i].date;

      const normalizedDate = sourceDate
        ? normalizeStatementDate(sourceDate, options.dateOrder)
        : null;

      if (!normalizedDate) {
        issues.push({
          page,
          code: 'UNRESOLVED_SOURCE_DATE',
        });
        break;
      }

      const row = parsedRows[i];
      if (normalizedDate !== row.date) {
        issues.push({
          page,
          code: 'TRANSACTION_DATE_MAPPING_MISMATCH',
        });
        break;
      }

      if (
        options.verifySourceAmounts &&
        (row.row !== i || !hasSourceAmounts(candidates[i].line, row))
      ) {
        issues.push({ page, code: 'TRANSACTION_AMOUNTS_UNVERIFIED' });
        break;
      }
    }
  }

  return {
    totalCandidates,
    totalParsed: rows.length,
    issues,
    complete: totalPages > 0 && issues.length === 0,
  };
}
