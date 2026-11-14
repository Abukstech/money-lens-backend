import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { OcrClient } from '../src/statements/ocr';
import { PaddleOcrClient } from '../src/statements/paddle-ocr';
import { StatementExtractor } from '../src/statements/extraction/statement-extractor';

function setup() {
  const config = new Config();
  config.values.MISTRAL_OCR_ENABLED = true;
  config.values.MISTRAL_OCR_REQUESTS_PER_SECOND = 1000;
  config.values.MISTRAL_OCR_PAGES_PER_MINUTE = 100;
  const ocr = new OcrClient(config, new Privacy(config));
  return {
    config,
    ocr,
    extractor: new StatementExtractor(config, ocr, new PaddleOcrClient(config)),
  };
}

const transaction = {
  date: '2026-10-15',
  description: 'POS PURCHASE',
  amount: '12.50',
  direction: 'debit',
  currency: 'NGN',
  page: 0,
  row: 0,
};

function ocrResponse(pages: number[], transactions: unknown[] = []) {
  return Response.json({
    document_annotation: JSON.stringify({ transactions }),
    pages: pages.map((index) => ({ index, markdown: 'RAW_OCR_MARKER' })),
  });
}

function requestedPages(options: RequestInit): number[] {
  return JSON.parse(options.body as string).pages;
}

async function makePdf(pages: number) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage();
  return Buffer.from(await pdf.save());
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Mistral statement extraction', () => {
  it('defaults to local extraction and sends each page once in order when enabled', async () => {
    const { config, extractor } = setup();
    vi.stubEnv('MISTRAL_OCR_ENABLED', undefined);
    vi.stubEnv('MISTRAL_OCR_FALLBACK_ENABLED', undefined);
    config.values.MISTRAL_OCR_ENABLED = new Config().values.MISTRAL_OCR_ENABLED;
    expect(config.values.MISTRAL_OCR_ENABLED).toBe(false);

    const file = await makePdf(22);
    const fetch = vi.fn().mockImplementation((_url, options: RequestInit) => {
      const pages = requestedPages(options);
      return ocrResponse(
        [...pages].reverse(),
        [...pages].reverse().map((page) => ({ ...transaction, page })),
      );
    });
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect((await extractor.extract(file, signal)).rows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    config.values.MISTRAL_OCR_ENABLED = true;
    const result = await extractor.extract(file, signal);
    expect(result.status).toBe('needs_review');
    expect(result.rows.map(({ page }) => page)).toEqual(Array.from({ length: 22 }, (_, i) => i));
    expect(fetch.mock.calls.map(([, options]) => requestedPages(options))).toEqual([
      Array.from({ length: 20 }, (_, i) => i),
      [20, 21],
    ]);
    expect(JSON.stringify(result)).not.toContain('RAW_OCR_MARKER');
  });

  it('prefers verified OCR rows on a PDF the local engine can also read', async () => {
    const { extractor } = setup();
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([810, 600]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const columns = [45, 220, 520, 700];
    const draw = (y: number, cells: string[]) => {
      cells.forEach((text, i) => page.drawText(text, { x: columns[i], y, size: 10, font }));
    };
    draw(500, ['Date', 'Narration', 'Amount (NGN)', 'Balance']);
    draw(470, ['15/10/2026', 'LOCAL PURCHASE', '-12.50', '100.00']);
    draw(442, ['16/10/2026', 'LOCAL CASH', '-12.50', '87.50']);
    const file = Buffer.from(await pdf.save());
    const fetch = vi
      .fn()
      .mockImplementationOnce(() =>
        ocrResponse(
          [0],
          [
            { ...transaction, balance: '100.00' },
            { ...transaction, date: '2026-10-16', balance: '87.50', row: 1 },
          ],
        ),
      )
      .mockImplementationOnce(() => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const primary = await extractor.extract(file, signal, 'DMY');
    expect(primary.status).toBe('candidate_pass');
    expect(primary.rows[0].description).toBe('POS PURCHASE');
    const fallback = await extractor.extract(file, signal, 'DMY');
    expect(fallback.status).toBe('candidate_pass');
    expect(fallback.rows[0].description).toBe('LOCAL PURCHASE');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses PaddleOCR instead of Mistral and keeps scan rows in review', async () => {
    const { config, extractor } = setup();
    config.values.PADDLE_OCR_URL = 'http://ocr.railway.internal:8080';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-test-token-with-at-least-32-characters';
    const x = [45, 220, 520, 700];
    const row = (y: number, cells: string[]) =>
      cells.map((text, i) => ({ text, x: x[i], y, width: 20, height: 10 }));
    const items = [
      ...row(500, ['Date', 'Narration', 'Amount (NGN)', 'Balance']),
      ...row(470, ['15/10/2026', 'POS PURCHASE', '-12.50', '100.00']),
      ...row(442, ['16/10/2026', 'POS CASH', '-12.50', '87.50']),
    ];
    const fetch = vi.fn((_url: URL, _options: RequestInit) =>
      Response.json({ pages: [{ index: 0, items }] }),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await extractor.extract(await makePdf(1), new AbortController().signal, 'DMY');
    expect(result.rows.map(({ description }) => description)).toEqual(['POS PURCHASE', 'POS CASH']);
    expect(result.review.decision).toBe('needs_review');
    expect(result.review.reasons).toContain('UNREADABLE_PAGES');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].pathname).toBe('/ocr');
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      'Content-Type': 'application/pdf',
      Authorization: `Bearer ${config.values.PADDLE_OCR_TOKEN}`,
    });
  });

  it('parses spaced dates from PaddleOCR using an explicit currency label in the PDF', async () => {
    const { config, extractor } = setup();
    config.values.PADDLE_OCR_URL = 'http://ocr.railway.internal:8080';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-test-token-with-at-least-32-characters';
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([810, 600]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText('Account Currency: NGN', { x: 45, y: 550, font });
    const columns = [45, 220, 520, 700];
    const row = (y: number, cells: string[]) =>
      cells.map((text, i) => ({ text, x: columns[i], y, width: 20, height: 10 }));
    const items = [
      ...row(500, ['Date', 'Narration', 'Amount', 'Balance']),
      ...row(470, ['15 / 10 / 2026 10 : 01 AM', 'POS PURCHASE', '-12.50', '100.00']),
      ...row(442, ['16 / 10 / 2026 10 : 01 AM', 'POS CASH', '-12.50', '87.50']),
    ];
    // Source rows provide independent date and amount evidence.
    for (const { text, x, y } of items.slice(4)) {
      page.drawText(text, { x, y, font, size: 10 });
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Response.json({ pages: [{ index: 0, items }] })),
    );
    const result = await extractor.extract(
      Buffer.from(await pdf.save()),
      new AbortController().signal,
      'DMY',
    );
    expect(result.source).toBe('paddleocr');
    expect(result.review.reasons).toEqual([]);
    expect(result.rows.map(({ date, currency }) => [date, currency])).toEqual([
      ['2026-10-15', 'NGN'],
      ['2026-10-16', 'NGN'],
    ]);
  });

  it('validates PaddleOCR rows against a reconciled PDF with separate credit and debit columns', async () => {
    const { config, extractor } = setup();
    config.values.PADDLE_OCR_URL = 'http://ocr.railway.internal:8080';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-test-token-with-at-least-32-characters';
    const pdf = await PDFDocument.create();
    const first = pdf.addPage([810, 600]);
    const second = pdf.addPage([810, 600]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const columnX = [45, 200, 420, 545, 700];
    const row = (y: number, values: string[]) =>
      values.flatMap((text, index) =>
        text ? [{ text, x: columnX[index], y, width: 20, height: 10 }] : [],
      );
    const tables = [
      [
        ...row(500, ['Date', 'Narration', 'Credit (NGN)', 'Debit (NGN)', 'Balance']),
        ...row(470, ['15/10/2026', 'Opening transfer', '100.00', '', '100.00']),
      ],
      row(470, ['16/10/2026', 'POS PURCHASE', '', '12.50', '87.50']),
    ];
    [first, second].forEach((page, index) => {
      for (const { text, x, y } of tables[index]) page.drawText(text, { x, y, font, size: 10 });
    });
    const result = { pages: tables.map((items, index) => ({ index, items })) };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Response.json(result)),
    );
    const file = Buffer.from(await pdf.save());
    const signal = new AbortController().signal;
    const extraction = await extractor.extract(file, signal, 'DMY');
    expect(extraction.source).toBe('paddleocr');
    expect(extraction.review.reasons).toEqual([]);

    // Keep OCR balances internally consistent while changing a source value.
    tables[0].find((item) => item.x === 700 && item.y === 470)!.text = '200.00';
    tables[1].find((item) => item.x === 700)!.text = '187.50';
    const fallback = await extractor.extract(file, signal, 'DMY');
    expect(fallback.source).toBe('local');
    expect(fallback.rows.at(-1)?.balance).toBe('87.50');
  });

  it('logs the PaddleOCR status and known failure code in the backend terminal', async () => {
    const { config, extractor } = setup();
    config.values.PADDLE_OCR_URL = 'http://127.0.0.1:18080';
    config.values.PADDLE_OCR_TOKEN = 'synthetic-test-token-with-at-least-32-characters';
    const stdout = vi.spyOn(process.stdout, 'write');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Response.json(
          { detail: 'OCR_PAGE_LIMIT', extra: 'PRIVATE_PAYLOAD_MARKER' },
          { status: 422 },
        ),
      ),
    );
    await expect(extractor.extract(await makePdf(1), new AbortController().signal)).rejects.toThrow(
      'EXTRACTION_FAILED_REUPLOAD_REQUIRED',
    );
    const output = JSON.stringify(stdout.mock.calls);
    expect(output).toContain('OCR_PAGE_LIMIT');
    expect(output).toContain('422');
    expect(output).not.toContain('PRIVATE_PAYLOAD_MARKER');
    expect(output).not.toContain(config.values.PADDLE_OCR_TOKEN);
  });

  it('rejects invalid and password-protected PDFs without sending either to Mistral', async () => {
    const { extractor } = setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(extractor.extract(Buffer.from('%PDF-1.4 damaged'), signal)).rejects.toThrow(
      'INVALID_PDF',
    );

    // A PDF with a standard encryption dictionary and a non-empty owner/user key.
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const encrypted = pdf.context.obj({
      Filter: PDFName.of('Standard'),
      V: PDFNumber.of(1),
      R: PDFNumber.of(2),
      O: PDFString.of('01234567890123456789012345678901'),
      U: PDFString.of('01234567890123456789012345678901'),
      P: PDFNumber.of(-4),
    });
    pdf.context.trailerInfo.Encrypt = pdf.context.register(encrypted);
    pdf.context.trailerInfo.ID = pdf.context.obj([
      PDFString.of('fixture'),
      PDFString.of('fixture'),
    ]);
    const file = Buffer.from(await pdf.save({ useObjectStreams: false }));
    await expect(extractor.extract(file, signal)).rejects.toThrow('PASSWORD_PROTECTED_PDF');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing page', [0], [], 'INVALID_OCR_PAGE_COVERAGE'],
    ['duplicate page', [0, 0], [], 'INVALID_OCR_PAGE_COVERAGE'],
    ['unexpected page', [0, 2], [], 'INVALID_OCR_PAGE_COVERAGE'],
    ['malformed page', [0, -1], [], 'INVALID_OCR_RESPONSE'],
    ['out-of-range row', [0, 1], [{ ...transaction, page: 2 }], 'INVALID_OCR_ROW_POSITION'],
    ['negative row', [0, 1], [{ ...transaction, row: -1 }], 'INVALID_OCR_ROW_POSITION'],
    ['duplicate row', [0, 1], [transaction, transaction], 'INVALID_OCR_ROW_POSITION'],
  ])('rejects %s', async (_label, pages, rows, code) => {
    const { ocr } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => ocrResponse(pages, rows)),
    );
    await expect(
      ocr.extract(Buffer.from('synthetic'), 'application/pdf', new AbortController().signal, 2),
    ).rejects.toThrow(code);
  });

  it('shares cooldown across callers, retries once, and keeps one request in flight', async () => {
    vi.useFakeTimers();
    const { ocr } = setup();
    let reply: (response: Response) => void = () => undefined;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            reply = resolve;
          }),
      )
      .mockImplementation(() => ocrResponse([0]));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const upload = () => ocr.extract(Buffer.from('synthetic'), 'application/pdf', signal);
    const first = upload();
    const second = upload();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    reply(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops after two 429s and returns a retry interval from the shared backoff', async () => {
    vi.useFakeTimers();
    const { ocr } = setup();
    const fetch = vi.fn(() => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    const result = ocr.extract(
      Buffer.from('synthetic'),
      'application/pdf',
      new AbortController().signal,
    );
    const failure = expect(result).rejects.toMatchObject({
      message: 'OCR_RATE_LIMITED',
      retryAfterSeconds: expect.any(Number),
      rateLimitSource: 'mistral',
    });
    await vi.advanceTimersByTimeAsync(1500);
    await failure;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a rejected chunk within the deadline even when it fills the local page budget', async () => {
    vi.useFakeTimers();
    const { config, ocr } = setup();
    config.values.MISTRAL_OCR_PAGES_PER_MINUTE = 2;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } }))
      .mockImplementationOnce(() => ocrResponse([0, 1]));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const result = ocr.extract(
      Buffer.from('synthetic'),
      'application/pdf',
      signal,
      2,
      Date.now() + 5000,
    );
    const success = expect(result).resolves.toEqual({ rows: [], rejectedRows: 0 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await success;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the configured page budget as the chunk size when it is smaller than 20', async () => {
    vi.useFakeTimers();
    const { config, ocr } = setup();
    config.values.MISTRAL_OCR_PAGES_PER_MINUTE = 2;
    const fetch = vi.fn((_url, options: RequestInit) => ocrResponse(requestedPages(options)));
    vi.stubGlobal('fetch', fetch);
    const result = ocr.extract(
      Buffer.from('synthetic'),
      'application/pdf',
      new AbortController().signal,
      3,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    expect(fetch.mock.calls.map(([, options]) => requestedPages(options))).toEqual([[0, 1], [2]]);
  });

  it('rejects a rolling page wait beyond the deadline and resumes once pages expire', async () => {
    vi.useFakeTimers();
    const { config, ocr } = setup();
    config.values.MISTRAL_OCR_PAGES_PER_MINUTE = 2;
    const fetch = vi.fn((_url, options: RequestInit) => ocrResponse(requestedPages(options)));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const upload = (pages: number) =>
      ocr.extract(Buffer.from('synthetic'), 'application/pdf', signal, pages, Date.now() + 1000);
    await upload(2);
    await expect(upload(1)).rejects.toMatchObject({
      message: 'OCR_RATE_LIMITED',
      retryAfterSeconds: 60,
      rateLimitSource: 'local',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await upload(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a queued upload without sending another request', async () => {
    const { ocr } = setup();
    let reply: (response: Response) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const file = Buffer.from('synthetic');
    const controller = new AbortController();
    const first = ocr.extract(file, 'application/pdf', new AbortController().signal);
    const second = ocr.extract(file, 'application/pdf', controller.signal);
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(1);
    reply(ocrResponse([0]));
    await first;
  });
});
