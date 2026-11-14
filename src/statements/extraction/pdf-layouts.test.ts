import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, type PDFPage, type PDFFont } from 'pdf-lib';

import { extractStatement } from './engine';

interface Cell {
  x: number;
  text: string;
}

function drawCells(page: PDFPage, font: PDFFont, y: number, cells: Cell[]) {
  for (const cell of cells) {
    page.drawText(cell.text, {
      x: cell.x,
      y,
      size: 10,
      font,
    });
  }
}

// Fixture 1: two-page signed-amount statement
async function createSignedAmountPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const transactions = [
    ['01/10/2026', 'POS PURCHASE', '-2500.00', '97500.00'],
    ['02/10/2026', 'SALARY PAYMENT', '+10000.00', '107500.00'],
    ['03/10/2026', 'TRANSPORT', '-3500.00', '104000.00'],
    ['04/10/2026', 'POS REFUND', '+1000.00', '105000.00'],
    ['05/10/2026', 'UTILITY BILL', '-5000.00', '100000.00'],
  ];

  const groups = [transactions.slice(0, 3), transactions.slice(3)];

  for (const group of groups) {
    const page = pdf.addPage([842, 595]);

    page.drawText('SYNTHETIC BANK STATEMENT', {
      x: 45,
      y: 550,
      font,
      size: 14,
    });

    // Repeated header, with different geometry
    // from the original MoneyLens PDF.
    drawCells(page, font, 500, [
      { x: 45, text: 'Date' },
      { x: 220, text: 'Narration' },
      { x: 520, text: 'Amount (NGN)' },
      { x: 700, text: 'Balance' },
    ]);

    group.forEach((row, index) => {
      drawCells(page, font, 470 - index * 28, [
        { x: 45, text: row[0] },
        { x: 220, text: row[1] },
        { x: 520, text: row[2] },
        { x: 700, text: row[3] },
      ]);
    });
  }

  return Buffer.from(await pdf.save());
}

// Fixture 2: different column order with DR/CR
async function createIndicatorPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([842, 595]);

  drawCells(page, font, 500, [
    { x: 40, text: 'Date' },
    { x: 180, text: 'Amount (NGN)' },
    { x: 330, text: 'Narration' },
    { x: 620, text: 'DR/CR' },
    { x: 740, text: 'Balance' },
  ]);

  drawCells(page, font, 470, [
    { x: 40, text: '2026-10-06' },
    { x: 180, text: '200.00' },
    { x: 330, text: 'POS PAYMENT' },
    { x: 620, text: 'DR' },
    { x: 740, text: '99800.00' },
  ]);

  drawCells(page, font, 440, [
    { x: 40, text: '2026-10-07' },
    { x: 180, text: '500.00' },
    { x: 330, text: 'REFUND' },
    { x: 620, text: 'CR' },
    { x: 740, text: '100300.00' },
  ]);

  return Buffer.from(await pdf.save());
}

describe('MoneyLens alternate PDF layouts', () => {
  it('extracts a two-page signed-amount PDF', async () => {
    const buffer = await createSignedAmountPdf();

    const result = await extractStatement(buffer, new AbortController().signal, {
      dateOrder: 'DMY',
    });

    console.log('Signed PDF diagnostics:', result.diagnostics);

    expect(result.status).toBe('candidate_pass');
    expect(result.rows).toHaveLength(5);

    expect(result.rows.map((row) => row.direction)).toEqual([
      'debit',
      'credit',
      'debit',
      'credit',
      'debit',
    ]);

    expect(result.rows.map((row) => row.amount)).toEqual([
      '2500.00',
      '10000.00',
      '3500.00',
      '1000.00',
      '5000.00',
    ]);

    expect(result.rows[0].date).toBe('2026-10-01');
    expect(result.rows[4].date).toBe('2026-10-05');

    expect(result.diagnostics.coverage.complete).toBe(true);
    expect(result.diagnostics.reconciliation.reconciled).toBe(true);
    expect(result.diagnostics.reconciliation.checkedPairs).toBe(4);
    expect(result.diagnostics.reconciliation.closingBalance).toBe('100000.00');
  });

  it('extracts a reordered DR/CR PDF', async () => {
    const buffer = await createIndicatorPdf();

    const result = await extractStatement(buffer, new AbortController().signal);

    console.log('Indicator PDF diagnostics:', result.diagnostics);

    expect(result.status).toBe('candidate_pass');
    expect(result.rows).toHaveLength(2);

    expect(result.rows[0].direction).toBe('debit');
    expect(result.rows[0].amount).toBe('200.00');

    expect(result.rows[1].direction).toBe('credit');
    expect(result.rows[1].amount).toBe('500.00');

    expect(result.diagnostics.coverage.complete).toBe(true);
    expect(result.diagnostics.reconciliation.reconciled).toBe(true);
    expect(result.review.decision).toBe('candidate_pass');

    expect(result.review.automaticAcceptanceEligible).toBe(true);

    expect(result.review.reasons).toEqual([]);
  });

  it('requires review when a PDF has no running balances', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    const page = pdf.addPage([842, 595]);

    drawCells(page, font, 500, [
      { x: 40, text: 'Date' },
      { x: 170, text: 'Narration' },
      { x: 460, text: 'Debit (NGN)' },
      { x: 620, text: 'Credit (NGN)' },
    ]);

    drawCells(page, font, 470, [
      { x: 40, text: '2026-10-15' },
      { x: 170, text: 'POS PURCHASE' },
      { x: 460, text: '2500.00' },
    ]);

    drawCells(page, font, 440, [
      { x: 40, text: '2026-10-16' },
      { x: 170, text: 'SALARY PAYMENT' },
      { x: 620, text: '150000.00' },
    ]);

    const buffer = Buffer.from(await pdf.save());

    const result = await extractStatement(buffer, new AbortController().signal);

    expect(result.rows).toHaveLength(2);

    expect(result.status).toBe('needs_review');

    expect(result.review.decision).toBe('needs_review');

    expect(result.review.automaticAcceptanceEligible).toBe(false);

    expect(result.review.reasons).toContain('RECONCILIATION_NOT_CONFIRMED');
  });
});

it('validates a continued table with a first-page-only header and aligned wrapped narration', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([610, 790]);
  const second = pdf.addPage([610, 790]);
  const write = (page: PDFPage, y: number, cells: [number, string][]) =>
    drawCells(
      page,
      font,
      y,
      cells.map(([x, text]) => ({ x, text })),
    );

  write(first, 720, [[70, 'Statement generated 20 Nov 2026']]);
  write(first, 700, [
    [70, 'Full Date'],
    [145, 'Memo'],
    [350, 'Transaction ID'],
    [445, 'Credit (NGN)'],
    [490, 'Debit (NGN)'],
    [530, 'Balance'],
  ]);
  write(first, 680, [
    [50, '1'],
    [70, '16-11-2026 11:13'],
    [145, 'Transfer payment'],
    [350, 'REF001'],
    [445, '1,200.00'],
    [530, '2,000.00'],
  ]);
  write(first, 669, [
    [70, 'AM'],
    [145, 'continued memo'],
  ]);
  write(second, 740, [
    [50, '2'],
    [70, '15-11-2026 10:01'],
    [145, 'Card payment'],
    [350, 'REF002'],
    [490, '-200.00'],
    [530, '800.00'],
  ]);
  write(second, 700, [
    [
      100,
      'Contact support for details about your statement and recording your transaction history',
    ],
  ]);

  const result = await extractStatement(
    Buffer.from(await pdf.save()),
    new AbortController().signal,
    { dateOrder: 'DMY' },
  );
  expect(result.review.reasons).toEqual([]);
  expect(
    result.rows.map(({ page, description, direction }) => [page, description, direction]),
  ).toEqual([
    [0, 'Transfer payment continued memo', 'credit'],
    [1, 'Card payment', 'debit'],
  ]);
});
