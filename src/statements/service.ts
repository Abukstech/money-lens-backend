import {
  Inject,
  ConsoleLogger,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  RequestTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { Db } from '../common/db';
import { Config } from '../common/config';
import { Privacy, sanitizeNarration } from '../common/privacy';
import { Transactions } from '../transactions/service';
import { RetryableServiceUnavailableException } from '../common/http';
import { StatementExtractor } from './extraction/statement-extractor';

export function detectMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return 'image/jpeg';
  return null;
}
@Injectable()
export class Statements {
  private readonly logger = new ConsoleLogger(Statements.name);

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
    @Inject(Privacy) private readonly privacy: Privacy,
    @Inject(StatementExtractor) private readonly extractor: StatementExtractor,
    @Inject(Transactions) private readonly transactions: Transactions,
  ) {}

  async extract(
    userId: string,
    buffer: Buffer,
    signal: AbortSignal,
    retry = false,
    deadlineAt?: number,
  ) {
    const mime = detectMime(buffer);
    if (!mime) throw new BadRequestException('UNSUPPORTED_DOCUMENT');
    if (mime !== 'application/pdf') {
      throw new BadRequestException('PDF_ONLY_SUPPORTED');
    }
    if (buffer.length > this.config.values.UPLOAD_MAX_MB * 1024 * 1024)
      throw new BadRequestException('UPLOAD_TOO_LARGE');
    signal.throwIfAborted();
    const fingerprint = this.privacy.hash(userId, 'document', buffer);
    const leaseToken = randomUUID();
    const now = new Date();
    let statement = await this.db.statement.findUnique({
      where: { userId_fingerprint: { userId, fingerprint } },
    });
    if (
      statement &&
      (statement.status === 'extracted' ||
        (statement.status === 'needs_review' &&
          !(retry && statement.errorCode === 'INVALID_ROWS_REUPLOAD_REQUIRED')))
    )
      return this.result(userId, statement.id);
    if (!statement) {
      try {
        statement = await this.db.statement.create({
          data: { userId, fingerprint, status: 'failed' },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ConflictException('IMPORT_IN_PROGRESS');
        throw e;
      }
    }
    const claimed = await this.db.statement.updateMany({
      where: {
        id: statement.id,
        userId,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        status: { in: ['failed', 'extracting', 'needs_review'] },
      },
      data: {
        status: 'extracting',
        errorCode: null,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + this.config.values.OCR_DEADLINE_MS + 30000),
      },
    });
    if (claimed.count !== 1) throw new ConflictException('IMPORT_IN_PROGRESS');
    try {
      const extracted = await this.extractor.extract(buffer, signal, 'DMY', deadlineAt);
      signal.throwIfAborted();

      if (!extracted.review.automaticAcceptanceEligible || extracted.rows.length === 0) {
        const code = 'AUTOMATED_EXTRACTION_VALIDATION_FAILED';
        const { coverage, reconciliation, parserIssues, extractionEvidence } =
          extracted.diagnostics;
        this.logger.warn({
          code,
          source: extracted.source,
          reasons: extracted.review.reasons,
          evidence: extractionEvidence,
          coverageIssues: coverage.issues.slice(0, 25).map(({ page, code }) => ({ page, code })),
          parserIssues: parserIssues.slice(0, 25).map(({ page, code }) => ({ page, code })),
          reconciliationIssues: reconciliation.issues
            .slice(0, 25)
            .map(({ page, row, code }) => ({ page, row, code })),
        });
        throw new BadRequestException(code);
      }

      const rows = extracted.rows.map((row) => ({
        ...row,
        accountIdentifier: null as string | null,
        recipientIdentifier: null as string | null,
      }));

      await this.db.$transaction(
        async (tx) => {
          signal.throwIfAborted();
          const claimed = await tx.statement.updateMany({
            where: { id: statement.id, userId, leaseToken },
            data: {
              status: 'extracted',
              errorCode: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          if (claimed.count !== 1) throw new ConflictException('IMPORT_LEASE_EXPIRED');

          const descending =
            rows.some((r, i) => i > 0 && r.date !== rows[i - 1].date) &&
            rows.find((r, i) => i > 0 && r.date !== rows[i - 1].date)!.date < rows[0].date;
          for (let i = 0; i < rows.length; i++) {
            signal.throwIfAborted();
            const row = rows[i];
            const issues: string[] = [];
            if (!row.description.trim()) issues.push('MISSING_NARRATION');
            // A row's running balance can verify direction and amount, never repair them by inference.
            if (i > 0 && row.balance != null && rows[i - 1].balance != null) {
              const delta = new Decimal(row.balance).minus(rows[i - 1].balance!);
              const basis = descending ? rows[i - 1] : row;
              const expected = new Decimal(basis.amount)
                .times(basis.direction === 'debit' ? -1 : 1)
                .times(descending ? -1 : 1);
              if (!delta.equals(expected)) issues.push('BALANCE_RECONCILIATION_MISMATCH');
            }
            const accountHash = row.accountIdentifier
              ? this.privacy.hash(userId, 'account', row.accountIdentifier)
              : null;
            const referenceHash = row.reference
              ? this.privacy.hash(userId, 'reference', row.reference)
              : null;
            if (issues.length > 0) {
              throw new BadRequestException('POST_EXTRACTION_INTEGRITY_FAILED');
            }
            if (
              accountHash &&
              referenceHash &&
              (await tx.transaction.findFirst({
                where: {
                  userId,
                  accountHash,
                  referenceHash,
                  date: new Date(row.date),
                  amount: row.amount,
                  direction: row.direction,
                  statementId: { not: statement.id },
                },
              }))
            ) {
              issues.push('POSSIBLE_DUPLICATE_REVIEW');
            }
            const t = await tx.transaction.upsert({
              where: {
                userId_sourceRow: { userId, sourceRow: `${statement.id}:${row.page}:${row.row}` },
              },
              update: {},
              create: {
                userId,
                statementId: statement.id,
                sourceRow: `${statement.id}:${row.page}:${row.row}`,
                date: new Date(row.date),
                description: sanitizeNarration(row.description),
                amount: row.amount,
                direction: row.direction,
                currency: row.currency,
                balance: row.balance ?? null,
                referenceHash,
                accountHash,
                recipientHash: row.recipientIdentifier
                  ? this.privacy.hash(userId, 'recipient', row.recipientIdentifier)
                  : null,
                page: row.page,
                row: row.row,
                validationIssues: issues,
              },
            });
            if (t.status !== 'user_confirmed') await this.transactions.enqueue(tx, t);
          }
          signal.throwIfAborted();
        },
        { timeout: 20000 },
      );

      return this.result(userId, statement.id);
    } catch (error) {
      const timedOut = signal.aborted || error instanceof RequestTimeoutException;
      const code = timedOut
        ? 'EXTRACTION_CANCELLED'
        : error instanceof BadRequestException ||
            error instanceof RetryableServiceUnavailableException
          ? error.message
          : 'EXTRACTION_FAILED';

      try {
        await this.db.statement.updateMany({
          where: { id: statement.id, userId, leaseToken },
          data: { status: 'failed', errorCode: code, leaseToken: null, leaseExpiresAt: null },
        });
      } catch {
        this.logger.error('EXTRACTION_LEASE_CLEANUP_FAILED');
      }

      if (timedOut) throw new RequestTimeoutException('EXTRACTION_CANCELLED');
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(code);
      throw new ServiceUnavailableException('EXTRACTION_FAILED_REUPLOAD_REQUIRED');
    }
  }
  async result(userId: string, id: string) {
    const s = await this.db.statement.findFirst({
      where: { id, userId },
      select: { id: true, status: true, errorCode: true, createdAt: true, updatedAt: true },
    });
    if (!s) throw new NotFoundException('STATEMENT_NOT_FOUND');
    const transactions = await this.db.transaction.findMany({
      where: { statementId: id, userId },
      select: { id: true, status: true },
      orderBy: { page: 'asc' },
    });
    return {
      ...s,
      transactionIds: transactions.map((t) => t.id),
      classificationStatus: transactions.some((t) => t.status === 'pending')
        ? 'queued'
        : 'processed',
      documentRetained: false,
    };
  }
  async rows(userId: string, id: string, cursor?: string) {
    await this.result(userId, id);
    const rows = await this.db.transaction.findMany({
      where: { statementId: id, userId, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: 101,
    });
    return {
      items: rows.slice(0, 100).map((t) => this.transactions.present(t)),
      nextCursor: rows.length > 100 ? rows[99].id : null,
    };
  }
  async classify(userId: string, id: string) {
    await this.result(userId, id);
    return this.db.$transaction(async (tx) => {
      const rows = await tx.transaction.findMany({
        where: { userId, statementId: id, status: { not: 'user_confirmed' } },
      });
      for (const t of rows)
        if (t.status !== 'user_confirmed') await this.transactions.enqueue(tx, t);
      return { statementId: id, queued: rows.length };
    });
  }
}
