import { ServiceUnavailableException } from '@nestjs/common';
export class Capacity {
  private active = 0;
  constructor(private readonly limit: number) {}
  acquire(): () => void {
    if (this.active >= this.limit)
      throw new ServiceUnavailableException('PROCESSING_CAPACITY_EXCEEDED');
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
export async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('ABORTED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
