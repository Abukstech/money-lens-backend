import { delay } from '../common/concurrency';
import { RetryableServiceUnavailableException } from '../common/http';
import { ProviderError } from '../common/provider-http';

const minuteMs = 60_000;

export class OcrRateLimiter {
  private readonly starts: { at: number; pages: number }[] = [];
  private readonly waiters = new Set<() => void>();
  private active = false;
  private pagesUsed = 0;
  private lastStart = -Infinity;
  private cooldownUntil = 0;
  private consecutiveLimits = 0;

  async run<T>(
    options: {
      pages: number;
      pagesPerMinute: number;
      requestsPerSecond: number;
      signal: AbortSignal;
      deadlineAt: number;
    },
    send: () => Promise<T>,
  ): Promise<T> {
    const reservation = await this.acquire(options);

    try {
      const result = await send();
      this.consecutiveLimits = 0;
      return result;
    } catch (error) {
      if (error instanceof ProviderError && error.status === 429) {
        // A rejected request did not process pages. Keep request pacing and
        // the provider cooldown, but free the page reservation for the retry.
        const index = this.starts.indexOf(reservation);
        if (index >= 0) {
          this.starts.splice(index, 1);
          this.pagesUsed -= reservation.pages;
        }
        const backoff = 1000 * 2 ** Math.min(this.consecutiveLimits, 4) + Math.random() * 250;
        this.consecutiveLimits++;
        this.cooldownUntil = Date.now() + (error.retryAfterMs ?? backoff);
      }
      throw error;
    } finally {
      this.active = false;
      for (const wake of this.waiters) wake();
      this.waiters.clear();
    }
  }

  rateLimited(
    options: { pages: number; pagesPerMinute: number; requestsPerSecond: number },
    source?: 'local' | 'mistral',
  ) {
    const now = Date.now();
    const startAt = this.nextStart(options, now);
    return new RetryableServiceUnavailableException(
      'OCR_RATE_LIMITED',
      Math.max(1, Math.ceil((startAt - now) / 1000)),
      source ?? (this.cooldownUntil > now && this.cooldownUntil === startAt ? 'mistral' : 'local'),
    );
  }

  private nextStart(
    {
      pages,
      pagesPerMinute,
      requestsPerSecond,
    }: {
      pages: number;
      pagesPerMinute: number;
      requestsPerSecond: number;
    },
    now: number,
  ) {
    while (this.starts.length && this.starts[0].at + minuteMs <= now) {
      this.pagesUsed -= this.starts.shift()!.pages;
    }
    let overage = this.pagesUsed + pages - pagesPerMinute;
    let pageLimitUntil = 0;
    for (const start of this.starts) {
      if (overage <= 0) break;
      pageLimitUntil = start.at + minuteMs;
      overage -= start.pages;
    }
    return Math.max(this.cooldownUntil, pageLimitUntil, this.lastStart + 1000 / requestsPerSecond);
  }

  private async acquire(options: {
    pages: number;
    pagesPerMinute: number;
    requestsPerSecond: number;
    signal: AbortSignal;
    deadlineAt: number;
  }) {
    const { pages, signal, deadlineAt } = options;
    while (true) {
      signal.throwIfAborted();
      const now = Date.now();
      const startAt = this.nextStart(options, now);
      if (startAt > now && startAt >= deadlineAt) throw this.rateLimited(options);
      if (now >= deadlineAt) throw new Error('EXTRACTION_CANCELLED');

      if (this.active) {
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const abort = () => {
            this.waiters.delete(wake);
            reject(signal.reason);
          };
          this.waiters.add(wake);
          signal.addEventListener('abort', abort, { once: true });
        });
      } else if (startAt > now) {
        await delay(Math.ceil(startAt - now), signal);
      } else {
        this.active = true;
        this.lastStart = now;
        this.pagesUsed += pages;
        const reservation = { at: now, pages };
        this.starts.push(reservation);
        return reservation;
      }
    }
  }
}
