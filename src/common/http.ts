import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  PipeTransform,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import { ZodType } from 'zod';

export class RetryableServiceUnavailableException extends ServiceUnavailableException {
  constructor(
    code: string,
    readonly retryAfterSeconds: number,
    readonly rateLimitSource?: 'local' | 'mistral',
  ) {
    super(code);
  }
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent || response.destroyed) return;
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (error instanceof RetryableServiceUnavailableException) {
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
      if (error.rateLimitSource) {
        response.setHeader('X-RateLimit-Source', error.rateLimitSource);
      }
    }
    // Never serialize provider, validation, database, or upload exception objects.
    const code =
      error instanceof HttpException && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : status === 400
          ? 'INVALID_REQUEST'
          : status === 413
            ? 'UPLOAD_TOO_LARGE'
            : status === 401
              ? 'UNAUTHORIZED'
              : 'REQUEST_FAILED';
    response.status(status).json({ statusCode: status, code });
  }
}
@Injectable()
export class SchemaPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('INVALID_REQUEST');
    return parsed.data;
  }
}
