import { delay } from './concurrency';
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
    readonly status?: number,
    readonly upstreamCode?: string,
  ) {
    super(code);
    this.name = 'ProviderError';
  }
}
export async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = 8 * 1024 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('EMPTY_PROVIDER_RESPONSE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new ProviderError('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    chunks.length = 0;
  }
}
export async function providerRequest(
  url: string,
  key: string,
  body: object,
  options: {
    signal: AbortSignal;
    attempts: number;
    attemptTimeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
  },
): Promise<unknown> {
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    options.signal.throwIfAborted();
    const signal = options.attemptTimeoutMs
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.attemptTimeoutMs)])
      : options.signal;
    let failure: ProviderError;
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...options.headers,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return await readJson(response, signal, options.maxBytes);
      const retryAfter = response.headers.get('retry-after');
      const retryMs = retryAfter
        ? /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Math.max(0, Date.parse(retryAfter) - Date.now())
        : NaN;
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      failure = new ProviderError(
        'PROVIDER_REJECTED_REQUEST',
        status === 429 || status >= 500,
        Number.isFinite(retryMs) ? retryMs : undefined,
        status,
      );
    } catch (error) {
      failure =
        error instanceof ProviderError ? error : new ProviderError('PROVIDER_UNAVAILABLE', true);
    }
    if (!failure.retryable || attempt + 1 === options.attempts) throw failure;
    await delay(
      Math.max(failure.retryAfterMs ?? 0, 250 * 2 ** attempt + Math.random() * 100),
      options.signal,
    );
  }
  throw new ProviderError('PROVIDER_UNAVAILABLE');
}
