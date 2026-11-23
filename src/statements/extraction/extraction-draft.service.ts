import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Db } from '../../common/db';
import { Privacy } from '../../common/privacy';

import { createExtractionDraft } from './draft-persistence';
import { getExtractionDraftForScope } from './draft-access';
import { correctExtractionDraftRow } from './draft-correction';
import { calculateDraftRevision } from './draft-revision';
import { StatementExtractor } from './statement-extractor';

export interface ExtractionActorContext {
  userId: string;
  accountScopeId: string;
}

@Injectable()
export class ExtractionDraftService {
  constructor(
    @Inject(Db)
    private readonly prisma: Db,
    @Inject(StatementExtractor) private readonly extractor: StatementExtractor,
    @Inject(Privacy) private readonly privacy: Privacy,
  ) {
    if (!this.prisma) {
      throw new Error('MoneyLens Db dependency was not injected');
    }
  }

  async createFromPdf(
    pdf: Buffer,
    actor: ExtractionActorContext,
    signal: AbortSignal = new AbortController().signal,
    deadlineAt?: number,
  ) {
    return createExtractionDraft(
      this.prisma,
      {
        pdf,
        signal,
        accountScopeId: actor.accountScopeId,
        createdByUserId: actor.userId,
        hashIdentifier: (kind, value) => this.privacy.hash(actor.userId, kind, value),
      },
      (buffer, processingSignal) =>
        this.extractor.extract(buffer, processingSignal, 'DMY', deadlineAt),
    );
  }

  async correctRow(
    draftId: string,
    rowId: string,
    actor: ExtractionActorContext,
    payload: unknown,
  ) {
    return correctExtractionDraftRow(this.prisma, {
      draftId,
      rowId,
      userId: actor.userId,
      accountScopeId: actor.accountScopeId,
      payload,
    });
  }

  async getValidatedRowsForClassification(draftId: string, actor: ExtractionActorContext) {
    const draft = await this.prisma.statementExtractionDraft.findFirst({
      where: {
        id: draftId,
        accountScopeId: actor.accountScopeId,
        createdByUserId: actor.userId,
      },
      include: {
        rows: {
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!draft) {
      throw new NotFoundException('Draft not found');
    }

    if (
      draft.status !== 'VALIDATED' ||
      draft.reviewDecision !== 'candidate_pass' ||
      !Array.isArray(draft.reviewReasons) ||
      draft.reviewReasons.length > 0 ||
      draft.rows.length === 0
    ) {
      throw new ConflictException('Statement has not passed extraction validation');
    }

    const transactions = draft.rows.map((row) => ({
      date: row.date,
      description: row.description,
      amount: row.amount.toFixed(2),
      direction: row.direction,
      currency: row.currency,
      balance: row.balance?.toFixed(2) ?? null,
      reference: row.reference,
      accountIdentifier: row.accountIdentifier,
      recipientIdentifier: row.recipientIdentifier,
      accountHash: row.accountHash,
      recipientHash: row.recipientHash,
      page: row.page,
      row: row.row,
    }));

    const revision = calculateDraftRevision(draft.documentHash, transactions);

    if (revision !== draft.revision) {
      throw new ConflictException('Statement transaction integrity check failed');
    }

    return transactions;
  }

  /**
   * Retrieve an extraction draft within
   * an authorized account scope.
   */
  async findById(draftId: string, actor: ExtractionActorContext) {
    const draft = await getExtractionDraftForScope(this.prisma, {
      draftId,
      accountScopeId: actor.accountScopeId,
    });

    if (!draft) {
      throw new NotFoundException('Extraction draft not found');
    }

    return draft;
  }
}
