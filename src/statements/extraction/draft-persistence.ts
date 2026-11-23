import { RequestTimeoutException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

import { extractStatement } from './engine';
import { sanitizeNarration } from '../../common/privacy';
import { extractedRow } from '../ocr';
import {
  calculateDocumentHash,
  calculateDraftRevision,
  type DraftTransaction,
} from './draft-revision';

export interface CreateExtractionDraftInput {
  pdf: Buffer;
  signal: AbortSignal;
  hashIdentifier?: (kind: string, value: string) => string;

  // These values must eventually come from
  // authenticated, authorized backend context.
  accountScopeId: string;
  createdByUserId: string;
}

export async function createExtractionDraft(
  prisma: PrismaClient,
  input: CreateExtractionDraftInput,
  extract: typeof extractStatement = extractStatement,
) {
  if (!input.accountScopeId.trim()) {
    throw new Error('Account scope is required');
  }

  if (!input.createdByUserId.trim()) {
    throw new Error('Authenticated user is required');
  }

  if (input.pdf.length === 0) {
    throw new Error('PDF cannot be empty');
  }

  if (input.signal.aborted) {
    throw new RequestTimeoutException('EXTRACTION_CANCELLED');
  }

  // 1. Run the existing extraction engine.
  const extracted = await extract(input.pdf, input.signal);

  // 2. Normalize values for stable revision hashing.
  const rows: DraftTransaction[] = extracted.rows
    .map((row) => extractedRow.safeParse(row))
    .flatMap((result) => (result.success ? [result.data] : []))
    .map((row) => ({
      date: row.date,
      description: sanitizeNarration(row.description),
      amount: row.amount,
      direction: row.direction,
      currency: row.currency,
      balance: row.balance ?? null,
      reference: row.reference == null ? null : sanitizeNarration(row.reference),
      accountIdentifier: null,
      recipientIdentifier: null,
      accountHash:
        row.accountIdentifier && input.hashIdentifier
          ? input.hashIdentifier('account', row.accountIdentifier)
          : null,
      recipientHash:
        row.recipientIdentifier && input.hashIdentifier
          ? input.hashIdentifier('recipient', row.recipientIdentifier)
          : null,
      page: row.page,
      row: row.row,
    }));

  // 3. Generate a document-bound draft revision.
  const documentHash = calculateDocumentHash(input.pdf);

  const revision = calculateDraftRevision(documentHash, rows);

  // 4. Determine the initial database state.
  const status = extracted.review.decision === 'candidate_pass' ? 'VALIDATED' : 'NEEDS_REVIEW';

  const evidence = extracted.diagnostics.extractionEvidence;

  // 5. Atomically save the draft and its rows.
  // Prisma nested writes succeed or fail together.
  if (input.signal.aborted) throw new RequestTimeoutException('EXTRACTION_CANCELLED');
  const saved = await prisma.statementExtractionDraft.create({
    data: {
      accountScopeId: input.accountScopeId,
      createdByUserId: input.createdByUserId,

      documentHash,
      revision,

      status,
      reviewDecision: extracted.review.decision,
      reviewReasons: extracted.review.reasons,

      extractionEvidence: {
        totalPages: evidence.totalPages,
        pagesWithText: evidence.pagesWithText,
        transactionCount: evidence.transactionCount,
        invalidRowCount: evidence.invalidRowCount,
        parserIssueCount: evidence.parserIssueCount,
        continuationCount: evidence.continuationCount,
        coverageComplete: evidence.coverageComplete,
        reconciled: evidence.reconciled,
        checkedPairs: evidence.checkedPairs,
      },

      rows: {
        create: rows.map((row, position) => ({
          position,
          date: row.date,
          description: row.description,

          amount: new Prisma.Decimal(row.amount),
          direction: row.direction,
          currency: row.currency,

          balance: row.balance == null ? null : new Prisma.Decimal(row.balance),

          reference: row.reference,
          accountIdentifier: row.accountIdentifier,
          recipientIdentifier: row.recipientIdentifier,
          accountHash: row.accountHash,
          recipientHash: row.recipientHash,

          page: row.page,
          row: row.row,
        })),
      },
    },

    select: {
      id: true,
      status: true,
      reviewDecision: true,
      revision: true,
      rows: {
        select: {
          id: true,
        },
      },
    },
  });

  return {
    id: saved.id,
    status: saved.status,
    reviewDecision: saved.reviewDecision,
    revision: saved.revision,
    transactionCount: saved.rows.length,
    reviewReasons: extracted.review.reasons,
  };
}
