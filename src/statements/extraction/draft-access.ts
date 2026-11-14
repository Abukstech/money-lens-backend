
import type { PrismaClient } from '@prisma/client';

export interface GetExtractionDraftInput {
  draftId: string;
  accountScopeId: string;
}

export async function getExtractionDraftForScope(
  prisma: PrismaClient,
  input: GetExtractionDraftInput,
) {
  const { draftId, accountScopeId } = input;

  if (!draftId.trim() || !accountScopeId.trim()) {
    throw new Error('Draft ID and account scope are required');
  }

  const draft = await prisma.statementExtractionDraft.findFirst({
    where: {
      id: draftId,
      accountScopeId,
    },

    select: {
      id: true,
      status: true,
      reviewDecision: true,
      reviewReasons: true,
      extractionEvidence: true,
      revision: true,
      version: true,
      releasedAt: true,
      createdAt: true,
      updatedAt: true,

      rows: {
        orderBy: {
          position: 'asc',
        },
        select: {
          id: true,
          position: true,
          date: true,
          description: true,
          amount: true,
          direction: true,
          currency: true,
          balance: true,
          reference: true,
          page: true,
          row: true,
        },
      },
    },
  });

  if (!draft) {
    return null;
  }

  return {
    ...draft,

    rows: draft.rows.map((row) => ({
      ...row,

      // Return financial values as exact decimal strings.
      // Never convert money to JavaScript Number.
      amount: row.amount.toFixed(2),

      balance:
        row.balance === null
          ? null
          : row.balance.toFixed(2),
    })),
  };
}
