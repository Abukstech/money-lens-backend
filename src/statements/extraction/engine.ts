import { normalizeStructuredTables, type StructuredPage } from './structured-table';
import { readPdf, type PdfTextItem } from './pdf-reader';
import { detectLines } from './detector';
import { parseTableLines, type ParsedTransaction } from './table-parser';
import { reconcileTransactions } from './reconcile';
import { verifyExtractionCoverage } from './coverage';
import { extractedRow } from '../ocr';
import type { DateOrder } from './date-normalizer';
import { evaluateExtractionEvidence, type ExtractionEvidence } from './review-policy';

type ExtractionOptions = { dateOrder?: DateOrder };

export async function extractStatement(
  buffer: Buffer,
  signal: AbortSignal,
  options: ExtractionOptions = {},
) {
  return (await prepareStatement(buffer, signal, options)).extractLocal();
}

export async function prepareStatement(
  buffer: Buffer,
  signal: AbortSignal,
  options: ExtractionOptions = {},
) {
  const pages = await readPdf(buffer, signal);
  signal.throwIfAborted();
  const lines = detectLines(pages);
  const pagesWithText = pages.filter((page) => page.hasText).length;
  let localResult: ReturnType<typeof evaluate> | undefined;

  function evaluate(
    rows: ParsedTransaction[],
    invalidRows: number,
    local?: ReturnType<typeof parseTableLines>,
    requireSourceAmounts = !local,
    matchedLocalSource = false,
  ) {
    const parserIssues = local?.issues ?? [];
    const continuations = local?.continuations ?? [];
    const coverage = verifyExtractionCoverage(lines, rows, pages.length, {
      ...options,
      verifySourceAmounts: requireSourceAmounts && !matchedLocalSource,
    });
    const reconciliation = reconcileTransactions(rows);
    const evidence: ExtractionEvidence = {
      totalPages: pages.length,
      pagesWithText,
      transactionCount: rows.length,
      invalidRowCount: invalidRows,
      parserIssueCount: parserIssues.length,
      continuationCount: continuations.length,
      coverageComplete: coverage.complete,
      reconciled: reconciliation.reconciled,
      checkedPairs: reconciliation.checkedPairs,
    };
    const review = evaluateExtractionEvidence(evidence);

    return {
      status: review.decision,
      rows,
      review,
      diagnostics: {
        totalPages: evidence.totalPages,
        extractedRows: rows.length,
        invalidRows,
        hasUnreadablePages: pagesWithText < pages.length,
        continuationCount: continuations.length,
        continuations,
        parserIssues,
        coverage,
        reconciliation,
        reviewReasons: review.reasons,
        extractionEvidence: evidence,
      },
    };
  }

  function extractLocal() {
    if (!localResult) {
      const parsed = parseTableLines(lines, options);
      localResult = evaluate(
        parsed.rows,
        parsed.rows.filter((row) => !extractedRow.safeParse(row).success).length,
        parsed,
      );
    }
    return localResult;
  }

  return {
    totalPages: pages.length,
    extractLocal,
    extractStructured(recognized: StructuredPage[]) {
      const parsed = normalizeStructuredTables(recognized, options.dateOrder);
      const reconciliation = reconcileTransactions(parsed.rows);
      const issues = recognized
        .filter((page) => !page.tableCoverageComplete)
        .map((page) => ({ page: page.index, code: 'TABLE_CONTENT_UNVERIFIED' }));
      if (!parsed.complete && !issues.length)
        issues.push({ page: parsed.issues[0]?.page ?? 0, code: 'TABLE_COVERAGE_INCOMPLETE' });
      const coverage = {
        totalCandidates: parsed.rows.length + parsed.issues.length,
        totalParsed: parsed.rows.length,
        issues,
        complete: parsed.complete,
      };
      const evidence: ExtractionEvidence = {
        totalPages: pages.length,
        pagesWithText: recognized.filter(
          (page) => page.blank || page.items.length || page.tables?.length,
        ).length,
        transactionCount: parsed.rows.length,
        invalidRowCount: parsed.rows.filter((row) => !extractedRow.safeParse(row).success).length,
        parserIssueCount: parsed.issues.length,
        continuationCount: 0,
        coverageComplete: coverage.complete,
        reconciled: reconciliation.reconciled,
        checkedPairs: reconciliation.checkedPairs,
      };
      const review = evaluateExtractionEvidence(evidence);
      return {
        status: review.decision,
        rows: parsed.rows,
        review,
        diagnostics: {
          totalPages: evidence.totalPages,
          extractedRows: parsed.rows.length,
          invalidRows: evidence.invalidRowCount,
          hasUnreadablePages: evidence.pagesWithText < pages.length,
          continuationCount: 0,
          continuations: [],
          parserIssues: parsed.issues,
          coverage,
          reconciliation,
          reviewReasons: review.reasons,
          extractionEvidence: evidence,
        },
      };
    },
    extractRecognized(recognized: { index: number; items: PdfTextItem[] }[]) {
      const recognizedLines = detectLines(
        pages.map((page, index) => ({
          ...page,
          items: recognized[index].items,
        })),
        5,
      );
      const parsed = parseTableLines(recognizedLines, { ...options, originalLines: lines });
      const checked = parsed.rows.map((row) => extractedRow.safeParse(row));
      const rows = checked.flatMap((result) =>
        result.success
          ? [
              {
                ...result.data,
                balance: result.data.balance ?? null,
                reference: result.data.reference ?? null,
              },
            ]
          : [],
      );
      // A verified text-layer table can corroborate an unsigned amount in
      // separate credit/debit columns or a balance split across PDF text items.
      const source = extractLocal();
      const matchedLocalSource =
        source.review.automaticAcceptanceEligible &&
        rows.length === source.rows.length &&
        rows.every((row, index) => {
          const original = extractedRow.parse(source.rows[index]);
          return (
            row.page === original.page &&
            row.row === original.row &&
            row.date === original.date &&
            row.direction === original.direction &&
            row.amount === original.amount &&
            row.balance === (original.balance ?? null) &&
            row.description.replace(/\s+/g, ' ').trim() ===
              original.description.replace(/\s+/g, ' ').trim() &&
            row.reference === (original.reference ?? null)
          );
        });
      return evaluate(rows, checked.length - rows.length, parsed, true, matchedLocalSource);
    },
    evaluate,
  };
}
