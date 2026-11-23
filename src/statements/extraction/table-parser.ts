
import { explicitRowIdentifiers } from './row-identifiers';
import type { LayoutLine } from './detector';
import {
  normalizeStatementDate,
  type DateOrder,
} from './date-normalizer';

type Column =
  | 'reference'
  | 'date'
  | 'description'
  | 'debit'
  | 'credit'
  | 'amount'
  | 'indicator'
  | 'balance';

type Direction = 'debit' | 'credit';

export interface ParsedTransaction {
  accountIdentifier?: string | null;
  recipientIdentifier?: string | null;
  date: string;
  description: string;
  amount: string;
  direction: Direction;
  currency: 'NGN';
  balance: string | null;
  reference: string | null;
  page: number;
  row: number;
}

export interface ParseIssue {
  page: number;
  lineY: number;
  code: string;
}

export interface ContinuationEvidence {
  page: number;
  row: number;
  lineY: number;
  kind: 'description' | 'reference';
}

const aliases: Record<Column, RegExp> = {
  reference:
    /^(ref|reference|transaction id|transaction reference)$/,
  date:
    /^(date|full date|transaction date|value date|posting date)$/,
  description:
    /^(description|memo|narration|transaction narration|details|particulars)$/,
  debit:
    /^(debit|withdrawal|withdrawals|dr)$/,
  credit:
    /^(credit|deposit|deposits|cr)$/,
  amount:
    /^(amount|transaction amount|value)$/,
  indicator:
    /^(dr\/cr|cr\/dr|transaction type|debit\/credit indicator)$/,
  balance:
    /^(balance|running balance|closing balance|available balance)$/,
};

function normalizeHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:ngn|naira)\b\s*$/i, '')
    .replace(/[()₦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const explicitCurrency =
  /\b(?:account\s+|statement\s+)?currency\s*[:=]?\s*(NGN|Nigerian Naira|Naira|₦|[A-Z]{3})\s*$/i;

const nairaCurrency =
  /^(?:NGN|Nigerian Naira|Naira|₦)$/i;

const nairaUnits =
  /\b(?:NGN|naira)\b|₦/i;

const foreignUnits =
  /\b(?:USD|EUR|GBP|CAD|AUD|ZAR|GHS|KES)\b|[$€£]/i;

const footerText =
  /^(?:total\b|sub-?total\b|opening balance\b|closing balance\b|end of statement\b|statement summary\b|account summary\b|page\s+\d+\b)/i;

export function detectHeader(line: LayoutLine) {
  const found: Partial<Record<Column, number>> = {};

  for (let i = 0; i < line.items.length; i++) {
    const item = line.items[i];
    const text = normalizeHeader(item.text);

    for (const column of Object.keys(aliases) as Column[]) {
      if (!aliases[column].test(text)) {
        continue;
      }

      let x = item.x;

      if (
        column === 'description' &&
        text === 'narration' &&
        i > 0 &&
        normalizeHeader(line.items[i - 1].text) === 'transaction'
      ) {
        x = line.items[i - 1].x;
      }

      found[column] ??= x;
    }
  }

  const hasSeparateColumns =
    found.debit !== undefined ||
    found.credit !== undefined;

  const hasSingleAmount =
    found.amount !== undefined;

  if (
    found.date === undefined ||
    found.description === undefined ||
    (!hasSeparateColumns && !hasSingleAmount)
  ) {
    return null;
  }

  return Object.entries(found)
    .map(([column, x]) => ({
      column: column as Column,
      x,
    }))
    .sort((a, b) => a.x - b.x);
}

function extractCells(
  line: LayoutLine,
  headers: { column: Column; x: number }[],
  onAmbiguous?: () => void,
): Partial<Record<Column, string>> {
  const cells: Partial<Record<Column, string>> = {};

  for (const item of line.items) {
    const firstHeader = headers[0];

    if (
      firstHeader?.column === 'date' &&
      item.x + item.width < firstHeader.x - 4 &&
      /^\d{1,5}$/.test(item.text.trim())
    ) {
      // Ignore an unlabelled serial-number cell
      // physically to the left of the Date column.
      continue;
    }

    const alignedColumn = headers.find((header, i) => {
      if (Math.abs(item.x - header.x) <= 2) {
        return true;
      }

      const next = headers[i + 1];

      return (
        header.column === 'description' &&
        !!next &&
        item.x >= header.x &&
        item.x < (header.x + next.x) / 2 &&
        item.x + item.width <= next.x
      );
    });

    if (alignedColumn) {
      const column = alignedColumn.column;

      cells[column] = [
        cells[column],
        item.text,
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

      continue;
    }

    const centerX = item.x + item.width / 2;

    const isMoney =
      /^[+-]?(?:₦\s*)?\d[\d,]*(?:\.\d{1,2})?$/.test(
        item.text.trim(),
      );

    if (isMoney) {
      for (let i = 0; i < headers.length - 1; i++) {
        const left = headers[i];
        const right = headers[i + 1];

        const isDebitCreditBoundary =
          (left.column === 'debit' &&
            right.column === 'credit') ||
          (left.column === 'credit' &&
            right.column === 'debit');

        if (!isDebitCreditBoundary) {
          continue;
        }

        const boundary = (left.x + right.x) / 2;

        if (Math.abs(centerX - boundary) <= 8) {
          onAmbiguous?.();
        }
      }
    }

    let index = 0;

    for (let i = 0; i < headers.length - 1; i++) {
      const boundary =
        (headers[i].x + headers[i + 1].x) / 2;

      if (centerX >= boundary) {
        index = i + 1;
      }
    }

    const column = headers[index].column;

    cells[column] = [
      cells[column],
      item.text,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  return cells;
}

function parseMoney(value?: string): string | null {
  if (!value?.trim()) {
    return null;
  }

  const cleaned = value
    .trim()
    .replace(/^(?:NGN|₦|N)\s*(?=[+-]?\d)/i, '')
    .replace(/[,\s]/g, '')
    .trim();

  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    return null;
  }

  return cleaned;
}

function parseDebitAmount(
  value?: string,
): string | null {
  const parsed = parseMoney(value);

  if (parsed === null) {
    return null;
  }

  // Negative debit values represent withdrawal magnitude.
  const magnitude = parsed.startsWith('-')
    ? parsed.slice(1)
    : parsed;

  if (Number(magnitude) <= 0) {
    return null;
  }

  return magnitude;
}

function parseIndicator(
  value?: string,
): Direction | null {
  const indicator = value?.trim().toUpperCase();

  if (
    ['DR', 'DEBIT', 'D'].includes(indicator ?? '')
  ) {
    return 'debit';
  }

  if (
    ['CR', 'CREDIT', 'C'].includes(indicator ?? '')
  ) {
    return 'credit';
  }

  return null;
}

export function parseTableLines(
  lines: LayoutLine[],
  options: {
    dateOrder?: DateOrder;
    originalLines?: LayoutLine[];
  } = {},
) {
  const rows: ParsedTransaction[] = [];
  const issues: ParseIssue[] = [];
  const rowCounters = new Map<number, number>();

  let currentPage = -1;

  let headers: ReturnType<typeof detectHeader> = null;

  let currencyConfirmed = false;
  let detectedHeaders = 0;

  const continuations: ContinuationEvidence[] = [];

  let lastParsedRow: {
    index: number;
    lastY: number;
  } | null = null;

  const sortedLines = [...lines].sort(
    (a, b) => a.page - b.page || b.y - a.y,
  );

  const sourceLines = [
    ...(options.originalLines ?? []),
    ...sortedLines,
  ];

  const pagesWithHeaders = new Set<number>();

  for (const line of sortedLines) {
    if (
      !pagesWithHeaders.has(line.page) &&
      detectHeader(line)
    ) {
      pagesWithHeaders.add(line.page);
    }
  }

  const currencyLabels = sourceLines.flatMap(
    ({ text }) => {
      const currency = explicitCurrency.exec(text)?.[1];
      return currency ? [currency] : [];
    },
  );

  const sourceHeaders = sourceLines.filter(
    (line) =>
      (nairaUnits.test(line.text) ||
        foreignUnits.test(line.text)) &&
      detectHeader(line),
  );

  const conflictingCurrency =
    currencyLabels.some(
      (currency) => !nairaCurrency.test(currency),
    ) ||
    sourceHeaders.some(({ text }) =>
      foreignUnits.test(text),
    );

  const statementIsNaira =
    !conflictingCurrency &&
    (
      currencyLabels.some((currency) =>
        nairaCurrency.test(currency),
      ) ||
      sourceHeaders.some(({ text }) =>
        nairaUnits.test(text),
      )
    );

  for (const line of sortedLines) {
    // Handle new page.
    if (line.page !== currentPage) {
      if (
        line.page !== currentPage + 1 ||
        pagesWithHeaders.has(line.page)
      ) {
        headers = null;
        currencyConfirmed = false;
      }

      currentPage = line.page;
      lastParsedRow = null;
    }

    const detected = detectHeader(line);

    if (detected) {
      headers = detected;

      currencyConfirmed =
        !conflictingCurrency &&
        (
          statementIsNaira ||
          nairaUnits.test(line.text)
        );

      detectedHeaders++;
      lastParsedRow = null;
      continue;
    }

    if (!headers) {
      continue;
    }

    const descriptionIndex = headers.findIndex(
      ({ column }) => column === 'description',
    );

    const descriptionHeader =
      headers[descriptionIndex];

    const nextHeader =
      headers[descriptionIndex + 1];

    const dateHeader = headers.find(
      ({ column }) => column === 'date',
    )!;

    // Detect AM/PM fragments separated from timestamps.
    const meridiemItem = line.items.find(
      (item) =>
        Math.abs(item.x - dateHeader.x) <= 2 &&
        /^(am|pm)$/i.test(item.text.trim()),
    );

    const narrationItems = line.items.filter(
      (item) => item !== meridiemItem,
    );

    const isAlignedNarration =
      narrationItems.length > 0 &&
      Math.abs(
        narrationItems[0].x - descriptionHeader.x,
      ) <= 2 &&
      narrationItems.every(
        (item) =>
          !nextHeader ||
          item.x + item.width <= nextHeader.x,
      );

    const gap = lastParsedRow
      ? lastParsedRow.lastY - line.y
      : 0;

    if (
      lastParsedRow &&
      isAlignedNarration &&
      gap > 0 &&
      gap <= 18
    ) {
      const previous = rows[lastParsedRow.index];

      const text = narrationItems
        .map(({ text }) => text)
        .join(' ')
        .trim();

      if (
        !/^REF(?:ERENCE)?\s*[:#]/i.test(text) &&
        !footerText.test(text)
      ) {
        const description =
          `${previous.description} ${text}`
            .replace(/\s+/g, ' ')
            .trim();

        if (description.length <= 2000) {
          previous.description = description;
          lastParsedRow.lastY = line.y;
          continue;
        }
      }
    }

    let ambiguousAmountColumn = false;

    const cells = extractCells(
      line,
      headers,
      () => {
        ambiguousAmountColumn = true;
      },
    );

    if (ambiguousAmountColumn) {
      issues.push({
        page: line.page,
        lineY: line.y,
        code: 'AMBIGUOUS_AMOUNT_COLUMN',
      });

      lastParsedRow = null;
      continue;
    }

    let rawDate = cells.date?.trim() ?? '';
    const descrip = cells.description?.trim() ?? '';

    const hasOtherValues = [
      cells.debit,
      cells.credit,
      cells.amount,
      cells.indicator,
      cells.balance,
      cells.reference,
    ].some((value) => Boolean(value?.trim()));

    // Handle standalone AM/PM lines.
    if (
      /^(AM|PM)$/i.test(rawDate) &&
      !hasOtherValues
    ) {
      const previous =
        lastParsedRow !== null
          ? rows[lastParsedRow.index]
          : null;

      const gap =
        lastParsedRow !== null
          ? lastParsedRow.lastY - line.y
          : -1;

      if (
        previous &&
        previous.page === line.page &&
        gap > 0 &&
        gap <= 18
      ) {
        rawDate = '';

        if (!descrip) {
          lastParsedRow!.lastY = line.y;
          continue;
        }
      } else {
        issues.push({
          page: line.page,
          lineY: line.y,
          code: 'ORPHAN_DATE_MERIDIEM',
        });

        lastParsedRow = null;
        continue;
      }
    }

    const looksLikeFooter =
      footerText.test(descrip);

    // Detect multiline descriptions or references.
    if (
      !rawDate &&
      descrip &&
      !hasOtherValues &&
      !looksLikeFooter &&
      lastParsedRow
    ) {
      const gap =
        lastParsedRow.lastY - line.y;

      if (gap > 0 && gap <= 18) {
        const previous =
          rows[lastParsedRow.index];

        if (previous.page === line.page) {
          const referenceMatch =
            /^REF(?:ERENCE)?\s*[:#]\s*(.+)$/i.exec(
              descrip,
            );

          const kind = referenceMatch
            ? 'reference'
            : 'description';

          if (referenceMatch) {
            const reference =
              referenceMatch[1].trim();

            if (
              previous.reference ||
              reference.length > 200
            ) {
              issues.push({
                page: line.page,
                lineY: line.y,
                code:
                  'AMBIGUOUS_CONTINUATION_REFERENCE',
              });

              lastParsedRow = null;
              continue;
            }

            previous.reference = reference;
          } else {
            const merged = [
              previous.description,
              descrip,
            ]
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();

            if (merged.length > 2000) {
              issues.push({
                page: line.page,
                lineY: line.y,
                code:
                  'CONTINUATION_DESCRIPTION_TOO_LONG',
              });

              lastParsedRow = null;
              continue;
            }

            previous.description = merged;
          }

          continuations.push({
            page: line.page,
            row: previous.row,
            lineY: line.y,
            kind,
          });

          lastParsedRow.lastY = line.y;
          continue;
        }
      }
    }

    const hasFinancialCell = [
      cells.debit,
      cells.credit,
      cells.amount,
      cells.balance,
    ].some(
      (cell) => parseMoney(cell) !== null,
    );

    if (
      !/\d/.test(rawDate) &&
      !hasFinancialCell &&
      !meridiemItem &&
      nextHeader &&
      line.items.some(
        (item) =>
          item.x < nextHeader.x &&
          item.x + item.width > nextHeader.x,
      )
    ) {
      lastParsedRow = null;
      continue;
    }

    // Normalize the statement date.
    const normalizedDate =
      normalizeStatementDate(
        rawDate,
        options.dateOrder,
      );

    const description =
      cells.description?.trim() ?? '';

    const balance =
      parseMoney(cells.balance);

    let problem: string | null = null;
    let amount: string | null = null;
    let direction: Direction | null = null;

    if (!normalizedDate) {
      problem =
        'UNRECOGNIZED_OR_AMBIGUOUS_DATE';
    } else if (!description) {
      problem = 'MISSING_DESCRIPTION';
    } else if (!currencyConfirmed) {
      problem = 'UNKNOWN_CURRENCY';
    } else if (
      cells.balance?.trim() &&
      balance === null
    ) {
      problem = 'INVALID_BALANCE';
    }

    const hasSeparateColumns = headers.some(
      (h) =>
        h.column === 'debit' ||
        h.column === 'credit',
    );

    // Parse separate debit and credit columns.
    if (!problem && hasSeparateColumns) {
      const debitPresent =
        Boolean(cells.debit?.trim());

      const creditPresent =
        Boolean(cells.credit?.trim());

      const debit =
        parseDebitAmount(cells.debit);

      const credit =
        parseMoney(cells.credit);

      if (debitPresent === creditPresent) {
        problem =
          'AMBIGUOUS_TRANSACTION_DIRECTION';
      } else {
        const selected = debitPresent
          ? debit
          : credit;

        if (
          selected === null ||
          Number(selected) <= 0
        ) {
          problem = 'INVALID_AMOUNT';
        } else {
          amount = selected;
          direction = debitPresent
            ? 'debit'
            : 'credit';
        }
      }
    }

    // Parse single signed amount column.
    if (!problem && !hasSeparateColumns) {
      const rawAmount =
        cells.amount?.trim() ?? '';

      const signed =
        parseMoney(rawAmount);

      const marker =
        parseIndicator(cells.indicator);

      if (
        !signed ||
        Number(signed) === 0
      ) {
        problem = 'INVALID_AMOUNT';
      } else {
        const negative =
          signed.startsWith('-');

        const positive =
          signed.startsWith('+');

        const hasIndicator =
          Boolean(cells.indicator?.trim());

        if (
          hasIndicator &&
          !marker
        ) {
          problem =
            'UNKNOWN_DIRECTION_INDICATOR';
        } else if (
          marker &&
          (
            (negative && marker === 'credit') ||
            (positive && marker === 'debit')
          )
        ) {
          problem =
            'CONFLICTING_DIRECTION_SIGN';
        } else if (marker) {
          direction = marker;
        } else if (negative) {
          direction = 'debit';
        } else if (positive) {
          direction = 'credit';
        } else {
          problem =
            'AMBIGUOUS_TRANSACTION_DIRECTION';
        }

        amount =
          signed.replace(/^[+-]/, '');
      }
    }

    // =========================================
    // NEW: PRIVACY-SAFE DATE FAILURE DIAGNOSTIC
    // =========================================
    if (
      problem ||
      !normalizedDate ||
      !amount ||
      !direction
    ) {
      if (
        process.env.EXTRACT_DATE_DEBUG === '1' &&
        problem ===
          'UNRECOGNIZED_OR_AMBIGUOUS_DATE' &&
        [5, 13].includes(line.page)
      ) {
        const mask = (
          value?: string,
        ): string =>
          (value ?? '')
            .replace(/\d/g, '#')
            .replace(/[A-Za-z]/g, 'X')
            .slice(0, 100);

        console.warn(
          '[DATE PARSING FAILURE]',
          {
            page: line.page + 1,
            y: Math.round(line.y),

            datePattern: mask(rawDate),

            configuredDateOrder:
              options.dateOrder ??
              'unspecified',

            dateValidDMY:
              normalizeStatementDate(
                rawDate,
                'DMY',
              ) !== null,

            dateValidMDY:
              normalizeStatementDate(
                rawDate,
                'MDY',
              ) !== null,

            standaloneMeridiem:
              /^(AM|PM)$/i.test(rawDate),

            hasDescription:
              Boolean(
                cells.description?.trim(),
              ),

            hasDebit:
              Boolean(cells.debit?.trim()),

            hasCredit:
              Boolean(cells.credit?.trim()),

            hasBalance:
              Boolean(cells.balance?.trim()),

            hasReference:
              Boolean(cells.reference?.trim()),

            itemCount:
              line.items.length,
          },
        );
      }

      // Preserve existing validation failure.
      issues.push({
        page: line.page,
        lineY: line.y,
        code:
          problem ??
          'INVALID_TRANSACTION',
      });

      lastParsedRow = null;
      continue;
    }

    // Build a validated transaction row.
    const rowIndex =
      rowCounters.get(line.page) ?? 0;

    rowCounters.set(
      line.page,
      rowIndex + 1,
    );

    rows.push({
      date: normalizedDate,
      description,
      amount,
      direction,
      currency: 'NGN',
      balance,
      reference:
        cells.reference?.trim() || null,
      page: line.page,
      row: rowIndex,
    });

    lastParsedRow = {
      index: rows.length - 1,
      lastY: line.y,
    };
  }

  if (!detectedHeaders) {
    issues.push({
      page: 0,
      lineY: 0,
      code: 'NO_SUPPORTED_TABLE_HEADER',
    });
  }

  return {
    rows: rows.map((row) => ({
      ...row,
      ...explicitRowIdentifiers(
        row.description,
      ),
    })),
    issues,
    continuations,
  };
}
