import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { normalizeStructuredTables, type StructuredPage } from './structured-table';
import { Config } from '../../common/config';
import { Privacy } from '../../common/privacy';
import { OcrClient } from '../ocr';
import { PaddleOcrClient } from '../paddle-ocr';
import { StatementExtractor } from './statement-extractor';

const tablePage = (rows: string[][], index = 0): StructuredPage => ({
  index,
  items: [{ text: 'Account currency: NGN', ...{ x: 0, y: 0, width: 1, height: 1 } }],
  tables: [{ rows }],
  tableCoverageComplete: true,
});
const data = [
  ['Date', 'Description', 'Debit (NGN)', 'Credit (NGN)', 'Balance'],
  ['01/10/2026 10:01 AM', 'Airtel recharge', '100.00', '0.00', '900.00'],
  ['02/10/2026', 'Incoming payment', '-', '50.00', '950.00'],
];

describe('OCR-produced tables mapped without page-coordinate parsing', () => {
  it('maps reordered columns, zero placeholders and wrapped narration', () => {
    const result = normalizeStructuredTables([
      tablePage([
        ['Description', 'Credit NGN', 'Date', 'Balance', 'Debit NGN'],
        ['Airtel\nrecharge', '0.00', '01/10/2026', '900.00', '100.00'],
        ['Incoming payment', '50.00', '02/10/2026', '950.00', '-'],
        ['Closing balance', '', '', '950.00', ''],
      ]),
    ]);
    expect(result.complete).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.rows.map((row) => [row.description, row.amount, row.direction])).toEqual([
      ['Airtel recharge', '100.00', 'debit'],
      ['Incoming payment', '50.00', 'credit'],
    ]);
  });
  it('carries headers across matching continuation tables and resets on changed headers', () => {
    const result = normalizeStructuredTables([
      tablePage(data),
      tablePage([['03/10/2026', 'School fees', '200.00', '', '750.00']], 1),
      tablePage(
        [
          ['Date', 'Narration', 'Amount NGN', 'DR/CR', 'Balance'],
          ['04/10/2026', 'Purchase', '50.00', 'DR', '700.00'],
        ],
        2,
      ),
    ]);
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.at(-1)?.direction).toBe('debit');
  });
  it('ignores summary rows and safely joins a narration-only continuation', () => {
    const result = normalizeStructuredTables([
      tablePage([
        ...data,
        ['', 'with more narration', '', '', ''],
        ['Total credits', '', '', '50.00', ''],
      ]),
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].description).toBe('Incoming payment with more narration');
  });
  it.each([
    ['32/10/2026', 'Payment', '100.00', '', '900.00'],
    ['01/10/2026', 'Payment', '100.00', '50.00', '900.00'],
    ['01/10/2026', 'Payment', 'INVALID', '', '900.00'],
    ['01/10/2026', 'Payment', '100.00', '', 'INVALID'],
    ['01/10/2026', 'Payment', '', '-50.00', '950.00'],
  ])('keeps invalid financial facts unresolved: %s', (...row) => {
    const result = normalizeStructuredTables([tablePage([data[0], row])]);
    expect(result.complete).toBe(false);
    expect(result.issues).toHaveLength(1);
  });
  it('supports explicit DR/CR amount and overdraft balance notation', () => {
    const result = normalizeStructuredTables([
      tablePage([
        ['Date', 'Narration', 'Amount NGN', 'Balance'],
        ['01/10/2026', 'Debit', '100.00 DR', '100.00 DR'],
        ['02/10/2026', 'Credit', '150.00 CR', '50.00 CR'],
      ]),
    ]);
    expect(result.complete).toBe(true);
    expect(result.rows.map((row) => [row.amount, row.direction, row.balance])).toEqual([
      ['100.00', 'debit', '-100.00'],
      ['150.00', 'credit', '50.00'],
    ]);
  });
  it('does not infer direction from balance changes or silently discard unknown tables', () => {
    const unsigned = normalizeStructuredTables([
      tablePage([
        ['Date', 'Description', 'Amount NGN', 'Balance'],
        ['01/10/2026', 'Payment', '100.00', '900.00'],
      ]),
    ]);
    expect(unsigned.complete).toBe(false);
    const unknown = normalizeStructuredTables([
      tablePage([
        ['When', 'Something', 'Unknown field'],
        ['01/10/2026', 'Payment', '100.00'],
      ]),
    ]);
    expect(unknown.complete).toBe(false);
  });
  it('accepts a complete reconciled scanned statement through the structured contract', async () => {
    const config = new Config();
    config.values.PADDLE_OCR_URL = 'http://ocr.test';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-token-with-at-least-32-characters';
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const fetch = vi.fn(() => Response.json({ contractVersion: 2, pages: [tablePage(data)] }));
    vi.stubGlobal('fetch', fetch);
    try {
      const extractor = new StatementExtractor(
        config,
        new OcrClient(config, new Privacy(config)),
        new PaddleOcrClient(config),
      );
      const result = await extractor.extract(
        Buffer.from(await pdf.save()),
        new AbortController().signal,
        'DMY',
      );
      expect(result.source).toBe('paddleocr');
      expect(result.rows).toHaveLength(2);
      expect(result.review.automaticAcceptanceEligible).toBe(true);
      expect(result.diagnostics.reconciliation.checkedPairs).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('rejects a missing structured page or incomplete model-cell coverage', async () => {
    const config = new Config();
    config.values.PADDLE_OCR_URL = 'http://ocr.test';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-token-with-at-least-32-characters';
    const client = new PaddleOcrClient(config);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Response.json({ contractVersion: 2, pages: [tablePage(data)] })),
    );
    try {
      await expect(
        client.read(Buffer.from('%PDF-'), 2, new AbortController().signal),
      ).rejects.toThrow('INVALID_PADDLE_OCR_PAGE_COVERAGE');
    } finally {
      vi.unstubAllGlobals();
    }
    const result = normalizeStructuredTables([
      { ...tablePage(data), tableCoverageComplete: false },
    ]);
    expect(result.complete).toBe(false);
  });
});
