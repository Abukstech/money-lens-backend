import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { OcrClient } from '../src/statements/ocr';
import { JevClient } from '../src/classification/jev';
import { categories } from '../src/classification/ontology';
import { providerRequest } from '../src/common/provider-http';
const config = new Config();
config.values.MISTRAL_OCR_REQUESTS_PER_SECOND = 1000;
config.values.MISTRAL_OCR_PAGES_PER_MINUTE = 30;
const privacy = new Privacy(config);
afterEach(() => vi.unstubAllGlobals());
const row = {
  date: '2026-10-15',
  description: 'POS SPAR',
  amount: '12.50',
  direction: 'debit',
  currency: 'NGN',
  page: 0,
  row: 0,
};
describe('provider contract and safe failure', () => {
  it('uses inline OCR and returns allowlisted rows only', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          document_annotation: JSON.stringify({
            transactions: [{ ...row, fullDocument: 'RAW_OCR_MARKER' }],
          }),
          pages: [{ index: 0, markdown: 'RAW_DOCUMENT_MARKER' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const result = await new OcrClient(config, privacy).extract(
      Buffer.from('%PDF-SYNTHETIC'),
      'application/pdf',
      AbortSignal.timeout(1000),
    );
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(fetch.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/ocr');
    expect(body.document.document_url).toMatch(/^data:application\/pdf;base64,/);
    expect(body.include_image_base64).toBe(false);
    expect(JSON.stringify(result)).not.toContain('MARKER');
    expect(result.rows[0].amount).toBe('12.50');
  });
  it('quarantines malformed rows without retaining them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            document_annotation: JSON.stringify({
              transactions: [row, { ...row, row: 1, amount: 'SECRET_INVALID_AMOUNT' }],
            }),
            pages: [{ index: 0 }],
          }),
        ),
      ),
    );
    const result = await new OcrClient(config, privacy).extract(
      Buffer.from('%PDF-X'),
      'application/pdf',
      AbortSignal.timeout(1000),
    );
    expect(result.rejectedRows).toBe(1);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects non-JSON output without echoing it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('SECRET_DOCUMENT')));
    await expect(
      providerRequest(
        'https://example.test',
        'key',
        {},
        { signal: AbortSignal.timeout(1000), attempts: 1 },
      ),
    ).rejects.toThrow('INVALID_PROVIDER_RESPONSE');
  });
  it('retries transient failure but not authentication failure', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await providerRequest(
      'https://example.test',
      'key',
      {},
      { signal: AbortSignal.timeout(2000), attempts: 2 },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockResolvedValue(new Response('SECRET', { status: 401 }));
    await expect(
      providerRequest(
        'https://example.test',
        'key',
        {},
        { signal: AbortSignal.timeout(1000), attempts: 2 },
      ),
    ).rejects.toThrow('PROVIDER_REJECTED_REQUEST');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('obeys an overall deadline', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '30' } })),
    );
    await expect(
      providerRequest(
        'https://example.test',
        'key',
        {},
        { signal: AbortSignal.timeout(30), attempts: 3 },
      ),
    ).rejects.toThrow('ABORTED');
  });
  it('validates the documented Jev choice response and usage', async () => {
    const c = new Config();
    c.values.JEV_API_KEY = 'synthetic-key';
    const probabilities = Object.fromEntries(categories.map((k) => [k, k === 'education' ? 1 : 0]));
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'synthetic-jev',
          answers: {
            category: { type: 'choice', choice: 'education', confidence: 0.95, probabilities },
          },
          usage: { input_tokens: 90, output_tokens: 1 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const answer = await new JevClient(c, new Privacy(c)).classify(
      {
        description: 'TUITION',
        direction: 'debit',
        currency: 'NGN',
        channel: null,
        isTransfer: false,
        isPossibleReversal: false,
        merchantEvidence: [],
        intermediaryNames: [],
      },
      () => undefined,
    );
    expect(answer.category).toBe('education');
    expect(answer.model).toBe('synthetic-jev');
    expect(answer.inputTokens).toBe(90);
    expect(JSON.parse(fetch.mock.calls[0][1].body).questions.category.type).toBe('choice');
  });
  it('rejects a fabricated model category', async () => {
    const c = new Config();
    c.values.JEV_API_KEY = 'synthetic-key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: 'fake',
            answers: {
              category: {
                type: 'choice',
                choice: 'wealthy',
                confidence: 1,
                probabilities: { wealthy: 1 },
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
      ),
    );
    await expect(
      new JevClient(c, new Privacy(c)).classify(
        {
          description: 'PAYMENT',
          direction: 'debit',
          currency: 'NGN',
          channel: null,
          isPossibleReversal: false,
          isTransfer: false,
          merchantEvidence: [],
          intermediaryNames: [],
        },
        () => undefined,
      ),
    ).rejects.toThrow();
  });
});
