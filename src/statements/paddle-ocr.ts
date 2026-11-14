import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { Config } from '../common/config';
import { ProviderError, readJson } from '../common/provider-http';

const pageSchema = z.object({
  index: z.number().int().nonnegative(),
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(4000),
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      }),
    )
    .max(10000),
});
const responseSchema = z.object({ pages: z.array(pageSchema).max(40) });
const errorResponseSchema = z.object({
  detail: z.enum([
    'INVALID_PDF',
    'OCR_BUSY',
    'OCR_DEADLINE_EXCEEDED',
    'OCR_FAILED',
    'OCR_PAGE_DIMENSIONS',
    'OCR_PAGE_LIMIT',
    'OCR_UNAUTHORIZED',
    'OCR_UPLOAD_TIMEOUT',
    'OCR_UPLOAD_TOO_LARGE',
    'PDF_REQUIRED',
  ]),
});
const networkCode = z.enum([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

@Injectable()
export class PaddleOcrClient {
  constructor(@Inject(Config) private readonly config: Config) {}

  async read(pdf: Buffer, totalPages: number, signal: AbortSignal) {
    const { PADDLE_OCR_URL: url, PADDLE_OCR_TOKEN: token } = this.config.values;
    if (!url || !token) throw new ServiceUnavailableException('PADDLE_OCR_NOT_CONFIGURED');
    let response: Response;
    try {
      response = await fetch(new URL('/ocr', url), {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/pdf', Authorization: `Bearer ${token}` },
        body: new Uint8Array(pdf),
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      const cause = error instanceof Error ? error.cause : undefined;
      const code = networkCode.safeParse(
        cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined,
      );
      throw new ProviderError('PADDLE_OCR_UNAVAILABLE', false, undefined, undefined, code.data);
    }
    if (!response.ok) {
      const body = await readJson(response, signal, 4096).catch(() => undefined);
      signal.throwIfAborted();
      const parsed = errorResponseSchema.safeParse(body);
      throw new ProviderError(
        'PADDLE_OCR_REQUEST_FAILED',
        false,
        undefined,
        response.status,
        parsed.data?.detail,
      );
    }
    const parsed = responseSchema.safeParse(await readJson(response, signal));
    if (!parsed.success) throw new ProviderError('INVALID_PADDLE_OCR_RESPONSE');

    const pages = parsed.data.pages.sort((a, b) => a.index - b.index);
    if (pages.length !== totalPages || pages.some((page, index) => page.index !== index)) {
      throw new ProviderError('INVALID_PADDLE_OCR_PAGE_COVERAGE');
    }
    return pages;
  }
}
