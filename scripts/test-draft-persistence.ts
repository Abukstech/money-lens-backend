
import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { getExtractionDraftForScope } from '../src/statements/extraction/draft-access';

import { createExtractionDraft } from '../src/statements/extraction/draft-persistence';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error('PDF path is required');
  }

  // Prevent this test from writing to a remote database.
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is missing');
  }

  const db = new URL(databaseUrl);

  if (
    !['localhost', '127.0.0.1'].includes(db.hostname)
  ) {
    throw new Error(
      'This script is restricted to a local database',
    );
  }

  const prisma = new PrismaClient();
  let draftId: string | undefined;

  try {
    const pdf = await readFile(filePath);

    const result = await createExtractionDraft(prisma, {
      pdf,
      signal: new AbortController().signal,

      // Development-only synthetic identifiers.
      accountScopeId: 'local-test-scope',
      createdByUserId: 'local-test-user',
    });

    draftId = result.id;

    const stored = await prisma.statementExtractionDraft.findUniqueOrThrow({
      where: {
        id: result.id,
      },
      include: {
        rows: {
          orderBy: {
            position: 'asc',
          },
        },
      },
    });

    console.log({
      draftId: stored.id,
      status: stored.status,
      reviewDecision: stored.reviewDecision,
      transactionCount: stored.rows.length,
      revisionMatches: stored.revision === result.revision,
      reviewReasons: result.reviewReasons,
    });

    if (
      stored.rows.length !== 30 ||
      stored.status !== 'VALIDATED' ||
      stored.revision !== result.revision
    ) {
      throw new Error('Draft persistence verification failed');
    }

    const accessibleDraft = await getExtractionDraftForScope(
      prisma,
      {
        draftId: result.id,
        accountScopeId: 'local-test-scope',
      },
    );
    
    const inaccessibleDraft = await getExtractionDraftForScope(
      prisma,
      {
        draftId: result.id,
        accountScopeId: 'another-client-scope',
      },
    );
    
    if (!accessibleDraft) {
      throw new Error('Authorized draft retrieval failed');
    }
    
    if (accessibleDraft.rows.length !== 30) {
      throw new Error('Incorrect transaction count');
    }
    
    if (inaccessibleDraft !== null) {
      throw new Error('Cross-account access was not blocked');
    }
    
    console.log({
      authorizedAccess: true,
      crossAccountAccessBlocked: true,
      retrievedTransactions: accessibleDraft.rows.length,
    });

    console.log('Draft persistence test passed');
  } finally {
    // Remove the temporary test draft.
    // Its rows are deleted by the cascade relation.
    try {
      if (draftId) {
        await prisma.statementExtractionDraft.delete({
          where: { id: draftId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
