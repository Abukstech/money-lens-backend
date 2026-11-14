import {
  Inject,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  BadRequestException,
  RequestTimeoutException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import busboy from 'busboy';
import { Observable, finalize } from 'rxjs';
import { Config } from '../common/config';
import { Capacity } from '../common/concurrency';
export type UploadRequest = Request & {
  documentBuffer?: Buffer;
  processingSignal: AbortSignal;
  processingDeadlineAt: number;
};

// The parser never receives a filesystem destination and rejects all form fields.
export async function readUpload(
  req: Request,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let document: Buffer | undefined;
    let seen = false;
    let settled = false;
    let parser: ReturnType<typeof busboy>;
    const cleanup = () => {
      req.unpipe(parser);
      signal.removeEventListener('abort', abort);
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };
    const detachRequestListeners = () => {
      req.off('error', failed);
      req.off('close', detachRequestListeners);
    };
    const failed = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      document?.fill(0);
      queueMicrotask(() => parser.destroy());
      req.resume();
      reject(
        error instanceof PayloadTooLargeException
          ? error
          : signal.aborted
            ? new RequestTimeoutException('EXTRACTION_CANCELLED')
            : new BadRequestException('INVALID_UPLOAD'),
      );
    };
    const abort = () => failed();
    try {
      parser = busboy({
        headers: req.headers,
        limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 2, headerPairs: 100 },
      });
    } catch {
      reject(new BadRequestException('INVALID_UPLOAD'));
      return;
    }
    parser.on('file', (name, stream) => {
      // Destroying an unfinished parser can emit an error on any file stream.
      stream.on('error', failed);
      if (name !== 'document' || seen) {
        stream.resume();
        failed();
        return;
      }
      seen = true;
      stream.on('data', (chunk: Buffer) => {
        if (!settled) chunks.push(chunk);
        else chunk.fill(0);
      });
      stream.on('limit', () => failed(new PayloadTooLargeException('UPLOAD_TOO_LARGE')));
      stream.on('end', () => {
        if (!settled) {
          document = Buffer.concat(chunks);
          for (const chunk of chunks) chunk.fill(0);
          chunks.length = 0;
        }
      });
    });
    parser.on('field', () => failed());
    parser.on('filesLimit', () => failed());
    parser.on('fieldsLimit', () => failed());
    parser.on('partsLimit', () => failed());
    parser.on('error', failed);
    parser.on('close', () => {
      if (settled) return;
      if (!document?.length) {
        failed();
        return;
      }
      settled = true;
      cleanup();
      detachRequestListeners();
      resolve(document);
    });
    // Keep handling request errors while a rejected upload drains or disconnects.
    req.on('error', failed);
    req.once('close', detachRequestListeners);
    signal.addEventListener('abort', abort, { once: true });
    req.pipe(parser);
  });
}
@Injectable()
export class MemoryUpload implements NestInterceptor {
  private readonly capacity: Capacity;
  constructor(@Inject(Config) private readonly config: Config) {
    this.capacity = new Capacity(config.values.OCR_CONCURRENCY);
  }
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const release = this.capacity.acquire();
    const req = context.switchToHttp().getRequest<UploadRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const controller = new AbortController();
    req.processingSignal = controller.signal;
    const abort = () => controller.abort();
    const closed = () => {
      if (!res.writableEnded) abort();
    };
    req.on('aborted', abort);
    res.on('close', closed);
    const deadlineMs = this.config.values.OCR_DEADLINE_MS;
    req.processingDeadlineAt = Date.now() + deadlineMs;
    const timer = setTimeout(abort, deadlineMs);
    const clean = () => {
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', closed);
      if (req.documentBuffer) {
        req.documentBuffer.fill(0);
        delete req.documentBuffer;
      }
      req.body = undefined;
      release();
    };
    try {
      req.documentBuffer = await readUpload(
        req,
        this.config.values.UPLOAD_MAX_MB * 1024 * 1024,
        controller.signal,
      );
      return next.handle().pipe(finalize(clean));
    } catch (error) {
      clean();
      throw error;
    }
  }
}
