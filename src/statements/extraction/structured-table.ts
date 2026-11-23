import Decimal from 'decimal.js';
import { normalizeStatementDate, type DateOrder } from './date-normalizer';
import type { ParsedTransaction, ParseIssue } from './table-parser';
import { explicitRowIdentifiers } from './row-identifiers';

/** The OCR service has already identified cells; no page-coordinate rules here. */
export interface StructuredPage {
  index: number;
  blank?: boolean;
  items: { text: string }[];
  tables?: { rows: string[][] }[];
  tableCoverageComplete?: boolean;
}

type Column =
  'date' | 'description' | 'debit' | 'credit' | 'amount' | 'indicator' | 'balance' | 'reference';
const headers: Record<Column, RegExp> = {
  date: /^(transaction date|posting date|date|full date|value date)$/,
  description:
    /^(description|narration|transaction narration|transaction details|details|memo|particulars)$/,
  debit: /^(debit|withdrawals?|money out|paid out|dr)( amount)?$/,
  credit: /^(credit|deposits?|money in|paid in|cr)( amount)?$/,
  amount: /^(transaction amount|amount|value)$/,
  indicator: /^(dr cr|cr dr|debit credit|transaction type|type|direction)$/,
  balance: /^(running balance|closing balance|balance|available balance)$/,
  reference: /^(ref|reference|transaction id|transaction reference)$/,
};
const cleanHeader = (text: string) =>
  text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(ngn|naira)\b/g, '')
    .replace(/[₦:/_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const empty = (text: string) => !text.trim() || /^[-–—]+$/.test(text.trim());
function money(text: string, balanceSuffix = false) {
  if (empty(text)) return null;
  const suffix = /(?:\d|\s)(DR|CR)$/i.exec(text.trim())?.[1].toUpperCase();
  const value = text
    .normalize('NFKC')
    .replace(/[−–—]/g, '-')
    .trim()
    .replace(/^(NGN|₦|N)\s*/i, '')
    .replace(/,/g, '')
    .replace(/\s*(?:DR|CR)$/i, '')
    .replace(/\s+/g, '');
  if (!/^[+-]?\d{1,18}(\.\d{1,2})?$/.test(value)) return null;
  if (balanceSuffix && suffix) {
    if ((suffix === 'CR' && new Decimal(value).lt(0)) || (suffix === 'DR' && /^\+/.test(value)))
      return null;
    return new Decimal(value)
      .abs()
      .times(suffix === 'DR' ? -1 : 1)
      .toFixed(2);
  }
  return new Decimal(value).toFixed(2);
}
function headerMap(cells: string[]) {
  const result: Partial<Record<Column, number>> = {};
  for (const [index, text] of cells.entries()) {
    for (const field of Object.keys(headers) as Column[])
      if (headers[field].test(cleanHeader(text))) {
        // Prefer transaction date over an additional value-date column.
        if (field === 'date' && result.date !== undefined && cleanHeader(text) === 'value date')
          continue;
        result[field] = index;
      }
  }
  return result.date !== undefined &&
    result.description !== undefined &&
    (result.amount !== undefined || result.debit !== undefined || result.credit !== undefined)
    ? result
    : null;
}

export function normalizeStructuredTables(pages: StructuredPage[], dateOrder: DateOrder = 'DMY') {
  const rows: ParsedTransaction[] = [];
  const issues: ParseIssue[] = [];
  let tableCount = 0;
  let complete = true;
  let inherited: { columns: Partial<Record<Column, number>>; width: number } | null = null;
  const documentText = pages.flatMap((page) => page.items.map((item) => item.text)).join(' ');
  const currencyConfirmed =
    /\bNGN\b|₦|\bNAIRA\b/i.test(documentText) ||
    pages.some((page) =>
      page.tables?.some((table) =>
        table.rows.some((cells) => cells.some((cell) => /\bNGN\b|₦|\bNAIRA\b/i.test(cell))),
      ),
    );
  const foreignCurrency = /\b(?:USD|EUR|GBP|CAD|AUD|ZAR|GHS|KES)\b|[$€£]/.test(documentText);
  for (const page of pages) {
    let pageRow = 0;
    if (!page.tableCoverageComplete) complete = false;
    for (const table of page.tables ?? []) {
      tableCount++;
      let columns: Partial<Record<Column, number>> | null = null;
      let previous: ParsedTransaction | null = null;
      const firstHeader = table.rows.findIndex((cells) => headerMap(cells));
      if (
        firstHeader < 0 &&
        inherited &&
        table.rows.every((cells) => cells.length === inherited!.width)
      ) {
        columns = inherited.columns;
      }
      for (const [index, cells] of table.rows.entries()) {
        const found = headerMap(cells);
        if (found) {
          columns = found;
          inherited = { columns: found, width: cells.length };
          previous = null;
          continue;
        }
        if (cells.every(empty)) continue;
        if (!columns) {
          // Non-transaction summary tables are allowed. A table with dates and
          // amounts but no understood header is incomplete, never silently lost.
          if (
            cells.some((cell) => normalizeStatementDate(cell, dateOrder)) &&
            cells.some((cell) => money(cell) !== null)
          ) {
            complete = false;
            issues.push({
              page: page.index,
              lineY: index,
              code: 'UNSUPPORTED_TRANSACTION_COLUMNS',
            });
          }
          continue;
        }
        const cell = (field: Column) =>
          columns![field] === undefined ? '' : (cells[columns![field]!] ?? '');
        const rawDate = cell('date').trim();
        const description = cell('description').replace(/\s+/g, ' ').trim();
        const monetary = ['debit', 'credit', 'amount', 'balance'].map((field) =>
          cell(field as Column),
        );
        const financialContent = monetary.some((value) => !empty(value));
        // Headers and footers carry no transaction date. Summary money values
        // are not transactions; an actual dated row is always validated below.
        const label = cells.join(' ').trim();
        if (
          !normalizeStatementDate(rawDate, dateOrder) &&
          /^(?:total\b|sub ?total\b|opening balance\b|closing balance\b|balance brought forward\b|balance carried forward\b|page\s+\d+\b)/i.test(
            label,
          )
        )
          continue;
        if (!rawDate && !financialContent) {
          if (description && previous)
            previous.description = `${previous.description} ${description}`.trim();
          continue;
        }
        const date = normalizeStatementDate(rawDate, dateOrder);
        let problem = !date
          ? 'INVALID_TRANSACTION_DATE'
          : !description
            ? 'MISSING_DESCRIPTION'
            : !currencyConfirmed || foreignCurrency
              ? 'UNKNOWN_CURRENCY'
              : null;
        let amount: string | null = null;
        let direction: 'debit' | 'credit' | null = null;
        if (columns.debit !== undefined || columns.credit !== undefined) {
          const debit = money(cell('debit'));
          const credit = money(cell('credit'));
          const debitPresent = debit !== null && new Decimal(debit).abs().gt(0);
          const creditPresent = credit !== null && new Decimal(credit).abs().gt(0);
          if (creditPresent && new Decimal(credit!).lt(0)) problem ??= 'CONFLICTING_DIRECTION_SIGN';
          if (
            (!empty(cell('debit')) && debit === null) ||
            (!empty(cell('credit')) && credit === null)
          )
            problem ??= 'INVALID_AMOUNT';
          else if (debitPresent === creditPresent) problem ??= 'AMBIGUOUS_TRANSACTION_DIRECTION';
          else {
            direction = debitPresent ? 'debit' : 'credit';
            amount = new Decimal((debitPresent ? debit : credit)!).abs().toFixed(2);
          }
        } else {
          const raw = cell('amount').trim();
          amount = money(raw);
          const suffix = /(?:\d|\s)(DR|CR)$/i.exec(raw)?.[1].toUpperCase();
          const columnMarker = cell('indicator')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z]/g, '');
          const marker = columnMarker || suffix || '';
          if (
            suffix &&
            columnMarker &&
            !(
              (suffix === 'DR' &&
                ['DR', 'DEBIT', 'WITHDRAWAL', 'MONEYOUT'].includes(columnMarker)) ||
              (suffix === 'CR' && ['CR', 'CREDIT', 'DEPOSIT', 'MONEYIN'].includes(columnMarker))
            )
          )
            problem ??= 'CONFLICTING_DIRECTION_SIGN';
          if (['DR', 'DEBIT', 'WITHDRAWAL', 'MONEYOUT'].includes(marker)) direction = 'debit';
          else if (['CR', 'CREDIT', 'DEPOSIT', 'MONEYIN'].includes(marker)) direction = 'credit';
          else if (marker) problem ??= 'AMBIGUOUS_TRANSACTION_DIRECTION';
          if (amount !== null) {
            const negative = new Decimal(amount).lt(0);
            if ((direction === 'credit' && negative) || (direction === 'debit' && /^\+/.test(raw)))
              problem ??= 'CONFLICTING_DIRECTION_SIGN';
            if (!direction && !marker)
              direction = negative ? 'debit' : /^\+/.test(raw) ? 'credit' : null;
            amount = new Decimal(amount).abs().toFixed(2);
          }
          if (!amount || new Decimal(amount).lte(0)) problem ??= 'INVALID_AMOUNT';
          if (!direction) problem ??= 'AMBIGUOUS_TRANSACTION_DIRECTION';
        }
        const balance = money(cell('balance'), true);
        if (!empty(cell('balance')) && balance === null) problem ??= 'INVALID_BALANCE';
        if (problem || !date || !amount || !direction) {
          issues.push({ page: page.index, lineY: index, code: problem ?? 'INVALID_TRANSACTION' });
          complete = false;
          previous = null;
          continue;
        }
        previous = {
          date,
          description,
          amount,
          direction,
          currency: 'NGN',
          balance,
          reference: cell('reference').trim() || null,
          page: page.index,
          row: pageRow++,
          ...explicitRowIdentifiers(description),
        };
        rows.push(previous);
      }
    }
  }
  return { rows, issues, complete: complete && tableCount > 0, tableCount };
}
