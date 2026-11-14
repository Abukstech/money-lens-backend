
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { readPdf } from './pdf-reader';
import { detectLines } from './detector';
import { parseTableLines } from './table-parser';
import { verifyExtractionCoverage } from './coverage';
import { reconcileTransactions } from './reconcile';

const pdfPath =
  `${process.env.HOME}/Downloads/` +
  'MoneyLens_Test_Statement_Refreshed_2026-11-08.pdf';

function convertToDMY(text: string): string {
  return text.replace(
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (_, year, month, day) => `${day}/${month}/${year}`,
  );
}

describe('MoneyLens DMY integration', () => {
  it('extracts and reconciles transactions with DD/MM/YYYY dates', async () => {
    const buffer = await readFile(pdfPath);

    const pages = await readPdf(
      buffer,
      new AbortController().signal,
    );

    const originalLines = detectLines(pages);

    // Simulate a statement using DD/MM/YYYY.
    const dmyLines = originalLines.map(line => ({
      ...line,
      text: convertToDMY(line.text),
      items: line.items.map(item => ({
        ...item,
        text: convertToDMY(item.text),
      })),
    }));

    const parsed = parseTableLines(dmyLines, {
      dateOrder: 'DMY',
    });

    const coverage = verifyExtractionCoverage(
      dmyLines,
      parsed.rows,
      pages.length,
      { dateOrder: 'DMY' },
    );

    const reconciliation = reconcileTransactions(
      parsed.rows,
    );

    expect(parsed.rows).toHaveLength(30);
    expect(parsed.issues).toHaveLength(0);

    expect(parsed.rows[0].date).toBe('2026-10-01');
    expect(parsed.rows[29].date).toBe('2026-10-28');

    expect(coverage.complete).toBe(true);
    expect(reconciliation.reconciled).toBe(true);

    // Without a known date convention, ambiguous
    // dates must not be silently accepted.
    const ambiguous = parseTableLines(dmyLines);

    expect(ambiguous.rows.length).toBeLessThan(30);
    expect(ambiguous.issues.length).toBeGreaterThan(0);
  });
});
