import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { Db } from '../../common/db';
import { sanitizeNarration } from '../../common/privacy';
import { normalizeStatementDate } from './date-normalizer';
import { calculateDraftRevision } from './draft-revision';

const amountPattern = /^(?:0|[1-9]\d{0,17})\.\d{2}$/;

const balancePattern = /^-?(?:0|[1-9]\d{0,17})\.\d{2}$/;

const correctionSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),

    date: z
      .string()
      .refine((value) => normalizeStatementDate(value) === value, 'Use a valid YYYY-MM-DD date')
      .optional(),

    description: z.string().trim().min(1).max(2000).optional(),

    amount: z
      .string()
      .regex(amountPattern)
      .refine((value) => new Prisma.Decimal(value).gt(0), 'Amount must be positive')
      .optional(),

    direction: z.enum(['debit', 'credit']).optional(),

    balance: z.union([z.string().regex(balancePattern), z.null()]).optional(),

    reference: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    'At least one transaction field must change',
  );

export interface CorrectDraftRowInput {
  draftId: string;
  rowId: string;
  userId: string;
  accountScopeId: string;
  payload: unknown;
}

export async function correctExtractionDraftRow(prisma: Db, input: CorrectDraftRowInput) {
  const parsed = correctionSchema.safeParse(input.payload);

  if (!parsed.success) {
    throw new BadRequestException({
      message: 'Invalid transaction correction',
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { expectedRevision, ...changes } = parsed.data;
  if (changes.description !== undefined)
    changes.description = sanitizeNarration(changes.description);
  if (typeof changes.reference === 'string')
    changes.reference = sanitizeNarration(changes.reference);

  if (!input.userId.trim() || !input.accountScopeId.trim()) {
    throw new BadRequestException('Invalid actor context');
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const draft = await tx.statementExtractionDraft.findFirst({
          where: {
            id: input.draftId,
            accountScopeId: input.accountScopeId,
            createdByUserId: input.userId,
          },
          include: {
            rows: {
              orderBy: { position: 'asc' },
            },
          },
        });

        if (!draft) {
          throw new NotFoundException('Extraction draft not found');
        }

        if (draft.status === 'RELEASED') {
          throw new ConflictException('Released drafts cannot be edited');
        }

        if (draft.revision !== expectedRevision) {
          throw new ConflictException('Draft has changed. Reload before editing.');
        }

        const target = draft.rows.find((row) => row.id === input.rowId);

        if (!target) {
          throw new NotFoundException('Transaction row not found');
        }

        // Build the complete proposed row collection.
        // The revision covers every transaction, not
        // only the currently edited row.
        const revisedRows = draft.rows.map((row) => {
          const editing = row.id === target.id;

          return {
            date: editing && changes.date !== undefined ? changes.date : row.date,

            description:
              editing && changes.description !== undefined ? changes.description : row.description,

            amount:
              editing && changes.amount !== undefined ? changes.amount : row.amount.toFixed(2),

            direction:
              editing && changes.direction !== undefined ? changes.direction : row.direction,

            currency: row.currency,

            balance:
              editing && changes.balance !== undefined
                ? changes.balance
                : (row.balance?.toFixed(2) ?? null),

            reference:
              editing && changes.reference !== undefined ? changes.reference : row.reference,

            accountIdentifier: row.accountIdentifier,
            recipientIdentifier: row.recipientIdentifier,
            accountHash:
              editing && (changes.description !== undefined || changes.direction !== undefined)
                ? null
                : row.accountHash,
            recipientHash:
              editing && (changes.description !== undefined || changes.direction !== undefined)
                ? null
                : row.recipientHash,
            page: row.page,
            row: row.row,
          };
        });

        const newRevision = calculateDraftRevision(draft.documentHash, revisedRows);

        if (newRevision === draft.revision) {
          throw new BadRequestException('No transaction values changed');
        }

        const existingReasons = Array.isArray(draft.reviewReasons)
          ? draft.reviewReasons.filter((value): value is string => typeof value === 'string')
          : [];

        const reviewReasons = [
          ...new Set([...existingReasons, 'MANUAL_CORRECTION_PENDING_REVALIDATION']),
        ];

        const previousEvidence = draft.extractionEvidence;

        if (
          previousEvidence === null ||
          typeof previousEvidence !== 'object' ||
          Array.isArray(previousEvidence)
        ) {
          throw new ConflictException('Draft extraction evidence is invalid');
        }

        // The original verification no longer applies
        // to the modified transaction collection.
        const updatedEvidence = {
          ...previousEvidence,
          reconciled: false,
          coverageComplete: false,
          checkedPairs: 0,
          modifiedAfterExtraction: true,
        } as Prisma.InputJsonObject;

        // Optimistic concurrency check: only one
        // operation can advance this draft version.
        const updated = await tx.statementExtractionDraft.updateMany({
          where: {
            id: draft.id,
            accountScopeId: input.accountScopeId,
            revision: draft.revision,
            version: draft.version,
            status: { not: 'RELEASED' },
          },
          data: {
            revision: newRevision,
            version: { increment: 1 },
            status: 'NEEDS_REVIEW',
            reviewDecision: 'needs_review',
            reviewReasons,
            extractionEvidence: updatedEvidence,
            releasedRevision: null,
            releaseMode: null,
            releasedAt: null,
          },
        });

        if (updated.count !== 1) {
          throw new ConflictException('Draft changed during correction');
        }

        const rowUpdate = await tx.statementExtractionRow.updateMany({
          where: {
            id: target.id,
            draftId: draft.id,
          },
          data: {
            ...((changes.description !== undefined || changes.direction !== undefined) && {
              accountHash: null,
              recipientHash: null,
            }),
            ...(changes.date !== undefined && {
              date: changes.date,
            }),
            ...(changes.description !== undefined && {
              description: changes.description,
            }),
            ...(changes.amount !== undefined && {
              amount: new Prisma.Decimal(changes.amount),
            }),
            ...(changes.direction !== undefined && {
              direction: changes.direction,
            }),
            ...(changes.balance !== undefined && {
              balance: changes.balance === null ? null : new Prisma.Decimal(changes.balance),
            }),
            ...(changes.reference !== undefined && {
              reference: changes.reference,
            }),
          },
        });

        if (rowUpdate.count !== 1) {
          throw new ConflictException('Transaction changed during correction');
        }

        return {
          draftId: draft.id,
          rowId: target.id,
          status: 'NEEDS_REVIEW' as const,
          reviewDecision: 'needs_review' as const,
          revision: newRevision,
          version: draft.version + 1,
          reviewReasons,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw new ConflictException('Concurrent draft update. Reload and retry.');
    }

    throw error;
  }
}
