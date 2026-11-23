import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import DecimalJs from 'decimal.js';
const Decimal = DecimalJs.clone({ precision: 40 });
import { Db } from '../common/db';
import { Privacy, normalizeNarration, sanitizeNarration } from '../common/privacy';
import {
  TransactionInput,
  correctionInput,
  feedbackInput,
  bulkFeedbackInput,
  ruleUpdate,
} from './contracts';
import { z } from 'zod';
import { Category, ONTOLOGY_VERSION, POLICY_VERSION } from '../classification/ontology';
import { Decision } from '../classification/policy';
import { Registry } from '../merchants/registry';
import {
  informativeTokens,
  meaningfulRuleTokens,
  narrationFacts,
} from '../classification/evidence';

export function economicType(category: string, direction: string) {
  if (category === 'unknown' || category === 'transfer_unknown') return 'unresolved';
  if (category === 'cash_withdrawal') return 'cash_movement';
  if (category === 'internal_transfer') return 'internal_transfer';
  if (['gift_received', 'loan_received', 'repayment_received'].includes(category))
    return 'other_credit';
  if (category === 'refund') return 'refund';
  if (category === 'savings' || category === 'investments') return 'capital_movement';
  return direction === 'credit' ? 'income' : 'expense';
}
export function assertCategoryDirection(category: string, direction: string) {
  if (
    (direction === 'debit' &&
      ['income', 'refund', 'gift_received', 'loan_received', 'repayment_received'].includes(
        category,
      )) ||
    (direction === 'credit' &&
      category !== 'income' &&
      category !== 'refund' &&
      category !== 'internal_transfer' &&
      !['gift_received', 'loan_received', 'repayment_received'].includes(category))
  )
    throw new BadRequestException('CATEGORY_DIRECTION_CONFLICT');
}
export function auditData(t: Transaction, reasonCode: string) {
  return {
    transactionId: t.id,
    revision: t.revision,
    category: t.category,
    suggestedCategory: t.suggestedCategory,
    status: t.status,
    source: t.source,
    confidence: t.confidence,
    merchantId: t.merchantId,
    linkedTransactionId: t.linkedTransactionId,
    channel: t.channel,
    economicType: t.economicType,
    jevInvoked: t.jevInvoked,
    modelVersion: t.modelVersion,
    ontologyVersion: t.ontologyVersion,
    policyVersion: t.policyVersion,
    datasetChecksum: t.datasetChecksum,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    reasonCode,
    evidence: t.evidence === null ? Prisma.DbNull : t.evidence,
  };
}
@Injectable()
export class Transactions {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Privacy) private readonly privacy: Privacy,
    @Inject(Registry) private readonly registry: Registry,
  ) {}
  async owned(userId: string, id: string, client: Prisma.TransactionClient = this.db) {
    const t = await client.transaction.findFirst({ where: { id, userId } });
    if (!t) throw new NotFoundException('TRANSACTION_NOT_FOUND');
    return t;
  }
  inputData(userId: string, input: TransactionInput) {
    return {
      date: new Date(input.date),
      description: sanitizeNarration(input.description),
      amount: input.amount,
      direction: input.direction,
      currency: input.currency,
      balance: input.balance ?? null,
      referenceHash: input.reference
        ? this.privacy.hash(userId, 'reference', input.reference)
        : null,
      recipientHash: input.recipientIdentifier
        ? this.privacy.hash(userId, 'recipient', input.recipientIdentifier)
        : null,
    };
  }
  async submit(userId: string, input: TransactionInput) {
    const sourceRow = `manual:${input.id}`;
    return this.db.$transaction(async (tx) => {
      const t = await tx.transaction.upsert({
        where: { userId_sourceRow: { userId, sourceRow } },
        update: {},
        create: { userId, sourceRow, ...this.inputData(userId, input) },
      });
      const desired = this.inputData(userId, input);
      if (
        t.date.valueOf() !== desired.date.valueOf() ||
        t.description !== desired.description ||
        !t.amount.equals(desired.amount) ||
        t.direction !== desired.direction ||
        t.currency !== desired.currency ||
        t.balance?.toString() !==
          (desired.balance ? new Decimal(desired.balance).toString() : undefined) ||
        t.referenceHash !== desired.referenceHash ||
        t.recipientHash !== desired.recipientHash
      )
        throw new ConflictException('IDEMPOTENCY_KEY_REUSED');
      if (t.status !== 'user_confirmed') await this.enqueue(tx, t);
      return this.present(t);
    });
  }
  async enqueue(tx: Prisma.TransactionClient, t: Transaction) {
    return tx.classificationTask.upsert({
      where: { transactionId_revision: { transactionId: t.id, revision: t.revision } },
      update: {},
      create: { transactionId: t.id, revision: t.revision },
    });
  }
  async requeue(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.owned(userId, id, tx);
      if (t.status === 'user_confirmed') return { transactionId: id, status: t.status };
      const task = await this.enqueue(tx, t);
      return { transactionId: id, jobId: task.id, status: 'queued' };
    });
  }
  private policyFallbackCategory(t: Transaction): Category {
    return narrationFacts(t.description, t.direction).transfer ? 'transfer_unknown' : 'unknown';
  }
  async persistDecision(snapshot: Transaction, decision: Decision, latencyMs: number) {
    return this.db.$transaction(async (tx) => {
      if (decision.linkedTransactionId && decision.source === 'deterministic') {
        await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${decision.linkedTransactionId} AND "userId" = ${snapshot.userId} FOR UPDATE`;
        const alreadyLinked = await tx.transaction.count({
          where: {
            userId: snapshot.userId,
            linkedTransactionId: decision.linkedTransactionId,
            id: { not: snapshot.id },
            status: { in: ['auto_classified', 'user_confirmed'] },
          },
        });
        if (alreadyLinked)
          decision = {
            ...decision,
            category: 'unknown',
            suggestedCategory: 'refund',
            status: 'requires_user_tagging',
            economicType: 'unresolved',
            linkedTransactionId: null,
            confidence: null,
            evidence: null,
            reasonCode: 'REFUND_RECONCILIATION_REQUIRED',
          };
      }
      if (
        decision.evidence?.ruleId &&
        !(await tx.recipientRule.findFirst({
          where: {
            id: decision.evidence.ruleId,
            userId: snapshot.userId,
            version: decision.evidence.ruleVersion,
            deletedAt: null,
          },
        }))
      )
        decision = {
          ...decision,
          category: this.policyFallbackCategory(snapshot),
          suggestedCategory: null,
          status: 'requires_user_tagging',
          source: 'unknown_fallback',
          confidence: null,
          economicType: 'unresolved',
          reasonCode: 'USER_RULE_CHANGED',
        };
      const { reasonCode, evidence, ...data } = decision;
      const changed = await tx.transaction.updateMany({
        where: {
          id: snapshot.id,
          userId: snapshot.userId,
          revision: snapshot.revision,
          status: { not: 'user_confirmed' },
        },
        data: {
          ...data,
          reasonCode,
          evidence: evidence ?? Prisma.DbNull,
          ontologyVersion: ONTOLOGY_VERSION,
          policyVersion: POLICY_VERSION,
          datasetChecksum: this.registry.checksum,
          latencyMs,
          classifiedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) return false;
      const t = await this.owned(snapshot.userId, snapshot.id, tx);
      await tx.classificationRevision.create({ data: auditData(t, reasonCode) });
      return true;
    });
  }
  async correct(userId: string, id: string, input: z.infer<typeof correctionInput>) {
    return this.db.$transaction(async (tx) => {
      const previous = await this.owned(userId, id, tx);
      if (previous.revision !== input.revision) throw new ConflictException('REVISION_CONFLICT');
      const changed = await tx.transaction.updateMany({
        where: { id, userId, revision: input.revision },
        data: {
          ...this.inputData(userId, { ...input, id }),
          validationIssues: [],
          category: 'unknown',
          suggestedCategory: null,
          status: 'pending',
          source: 'extraction_correction',
          reasonCode: 'EXTRACTION_CORRECTED',
          evidence: Prisma.DbNull,
          confidence: null,
          economicType: 'unresolved',
          merchantId: null,
          channel: null,
          linkedTransactionId: null,
          modelVersion: null,
          jevInvoked: false,
          inputTokens: 0,
          outputTokens: 0,
          classifiedAt: null,
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ConflictException('REVISION_CONFLICT');
      const t = await this.owned(userId, id, tx);
      await tx.classificationRevision.create({ data: auditData(t, 'EXTRACTION_CORRECTED') });
      if (t.statementId) {
        const statement = await tx.statement.findFirst({ where: { id: t.statementId, userId } });
        const unresolved = await tx.transaction.count({
          where: { statementId: t.statementId, validationIssues: { isEmpty: false } },
        });
        if (statement?.status === 'needs_review' && !statement.errorCode && unresolved === 0)
          await tx.statement.update({
            where: { id: t.statementId },
            data: { status: 'extracted' },
          });
      }
      await this.enqueue(tx, t);
      return this.present(t);
    });
  }
  async feedback(userId: string, id: string, input: z.infer<typeof feedbackInput>) {
    const result = await this.bulkFeedback(userId, {
      ...input,
      items: [{ transactionId: id, revision: input.revision }],
    });
    return result.items[0];
  }
  async bulkFeedback(userId: string, input: z.infer<typeof bulkFeedbackInput>) {
    return this.db.$transaction(async (tx) => {
      const rows = await Promise.all(
        input.items.map((i) => this.owned(userId, i.transactionId, tx)),
      );
      for (const [index, t] of rows.entries()) {
        assertCategoryDirection(input.category, t.direction);
        if (t.revision !== input.items[index].revision)
          throw new ConflictException('REVISION_CONFLICT');
        if (t.validationIssues.length)
          throw new BadRequestException('EXTRACTION_CORRECTION_REQUIRED');
        if (input.rememberForFuture) {
          const c = input.conditions;
          if (!t.recipientHash || !c) throw new BadRequestException('STABLE_RECIPIENT_REQUIRED');
          if (
            t.recipientHash !== rows[0].recipientHash ||
            c.direction !== t.direction ||
            c.currency !== t.currency ||
            !t.amount.gte(c.minAmount) ||
            !t.amount.lte(c.maxAmount) ||
            !meaningfulRuleTokens(c.narrationTokens) ||
            !c.narrationTokens.every((token) =>
              ` ${normalizeNarration(t.description)} `.includes(` ${token.toUpperCase()} `),
            )
          )
            throw new BadRequestException('RULE_DOES_NOT_MATCH_TRANSACTION');
        }
      }
      const items = [];
      for (const t of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
        const reasonCode =
          t.status === 'auto_classified' && t.category !== input.category
            ? 'USER_CORRECTED_AUTOMATIC'
            : 'USER_CONFIRMED';
        const changed = await tx.transaction.updateMany({
          where: { id: t.id, userId, revision: t.revision },
          data: {
            category: input.category,
            suggestedCategory: null,
            status: 'user_confirmed',
            source: 'user_confirmed',
            confidence: 1,
            economicType: economicType(input.category, t.direction),
            reasonCode,
            evidence: Prisma.DbNull,
            linkedTransactionId: input.category === 'refund' ? t.linkedTransactionId : null,
            revision: { increment: 1 },
            classifiedAt: new Date(),
            ontologyVersion: ONTOLOGY_VERSION,
            policyVersion: POLICY_VERSION,
          },
        });
        if (changed.count !== 1) throw new ConflictException('REVISION_CONFLICT');
        const updated = await this.owned(userId, t.id, tx);
        await tx.classificationRevision.create({ data: auditData(updated, reasonCode) });
        items.push(this.present(updated));
      }
      if (input.rememberForFuture && input.conditions) {
        const c = input.conditions;
        const rule = await tx.recipientRule.create({
          data: {
            userId,
            recipientHash: rows[0].recipientHash!,
            category: input.category,
            ...c,
            narrationTokens: c.narrationTokens.map((token) => token.toUpperCase()),
          },
        });
        await tx.ruleRevision.create({
          data: {
            ruleId: rule.id,
            version: rule.version,
            category: rule.category,
            direction: rule.direction,
            currency: rule.currency,
            minAmount: rule.minAmount,
            maxAmount: rule.maxAmount,
            narrationTokens: rule.narrationTokens,
          },
        });
      }
      return { items };
    });
  }

  private reviewKey(t: Transaction) {
    const facts = narrationFacts(t.description, t.direction);
    const identity = t.recipientHash
      ? `recipient:${t.recipientHash}`
      : informativeTokens(t.description).length
        ? `text:${facts.n}`
        : `row:${t.id}`;
    const pattern = [...facts.purposes, ...facts.purposeTokens].sort().join(',');
    return this.privacy.hash(
      t.userId,
      'review-group',
      `${t.direction}|${t.currency}|${identity}|${pattern}`,
    );
  }
  private async reviewRows(userId: string, statementId: string) {
    if (!(await this.db.statement.findFirst({ where: { id: statementId, userId } })))
      throw new NotFoundException('STATEMENT_NOT_FOUND');
    return this.db.transaction.findMany({
      where: {
        userId,
        statementId,
        status: { in: ['requires_user_tagging', 'failed'] },
        validationIssues: { isEmpty: true },
      },
      orderBy: { id: 'asc' },
    });
  }
  async reviewGroups(userId: string, statementId: string, cursor?: string) {
    const rows = await this.reviewRows(userId, statementId);
    const groups = new Map<string, Transaction[]>();
    for (const t of rows) {
      const key = this.reviewKey(t);
      const existing = groups.get(key);
      if (existing) existing.push(t);
      else groups.set(key, [t]);
    }
    const keys = [...groups.keys()].sort().filter((key) => !cursor || key > cursor);
    return {
      items: keys.slice(0, 50).map((key) => {
        const members = groups.get(key)!;
        const first = members[0];
        const tokens = narrationFacts(first.description, first.direction)
          .purposeTokens.flatMap((phrase) => phrase.split(' '))
          .filter((token) => /^[A-Z]{3,30}$/.test(token));
        const commonTokens = [...new Set(tokens)].filter((token) =>
          members.every((t) => ` ${normalizeNarration(t.description)} `.includes(` ${token} `)),
        );
        const suggestions = new Set(members.map((t) => t.suggestedCategory));
        const amounts = members.map((t) => new Decimal(t.amount.toString()));
        return {
          key,
          count: members.length,
          direction: first.direction,
          currency: first.currency,
          totalAmount: amounts.reduce((sum, a) => sum.plus(a), new Decimal(0)).toFixed(2),
          suggestedCategory: suggestions.size === 1 ? first.suggestedCategory : null,
          previews: members.slice(0, 3).map((t) => this.present(t)),
          memoryEligible:
            !!first.recipientHash && commonTokens.length > 0 && meaningfulRuleTokens(commonTokens),
          proposedConditions:
            first.recipientHash && commonTokens.length > 0
              ? {
                  direction: first.direction,
                  currency: first.currency,
                  minAmount: amounts.reduce((min, amount) => Decimal.min(min, amount)).toFixed(2),
                  maxAmount: amounts.reduce((max, amount) => Decimal.max(max, amount)).toFixed(2),
                  narrationTokens: commonTokens.slice(0, 10),
                }
              : null,
        };
      }),
      nextCursor: keys.length > 50 ? keys[49] : null,
      transactionCount: rows.length,
      groupCount: groups.size,
    };
  }
  async reviewMembers(userId: string, statementId: string, key: string, cursor?: string) {
    const rows = (await this.reviewRows(userId, statementId)).filter(
      (t) => this.reviewKey(t) === key && (!cursor || t.id > cursor),
    );
    return {
      items: rows.slice(0, 100).map((t) => this.present(t)),
      nextCursor: rows.length > 100 ? rows[99].id : null,
    };
  }

  present(t: Transaction) {
    const merchant = this.registry.get(t.merchantId);
    return {
      transactionId: t.id,
      statementId: t.statementId,
      date: t.date.toISOString().slice(0, 10),
      description: t.description,
      amount: t.amount.toFixed(2),
      direction: t.direction,
      currency: t.currency,
      balance: t.balance?.toFixed(2) ?? null,
      page: t.page,
      row: t.row,
      validationIssues: t.validationIssues,
      revision: t.revision,
      category: t.category,
      suggestedCategory: t.suggestedCategory,
      linkedTransactionId: t.linkedTransactionId,
      channel: t.channel,
      economicType: t.economicType,
      merchant: merchant
        ? {
            name: merchant.name,
            matchSource: 'merchant_registry',
            evidenceStatus: merchant.evidence_status,
          }
        : null,
      classification: {
        status: t.status,
        source: t.source,
        confidence: t.confidence,
        reasonCode: t.reasonCode,
        memoryEligible: !!t.recipientHash,
        reviewRequired: !['auto_classified', 'user_confirmed'].includes(t.status),
      },
      financialAssessment: { status: 'pending_context', score: null },
      metadata: {
        ontologyVersion: t.ontologyVersion,
        policyVersion: t.policyVersion,
        datasetChecksum: t.datasetChecksum,
        jevInvoked: t.jevInvoked,
        modelVersion: t.modelVersion,
        classifiedAt: t.classifiedAt,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        latencyMs: t.latencyMs,
      },
    };
  }
  async list(userId: string, pending = false, cursor?: string) {
    const rows = await this.db.transaction.findMany({
      where: {
        userId,
        ...(pending ? { status: { in: ['pending', 'requires_user_tagging', 'failed'] } } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: 101,
    });
    return {
      items: rows.slice(0, 100).map((t) => this.present(t)),
      nextCursor: rows.length > 100 ? rows[99].id : null,
    };
  }
  async history(userId: string, id: string) {
    await this.owned(userId, id);
    return this.db.classificationRevision.findMany({
      where: { transactionId: id },
      orderBy: { revision: 'asc' },
    });
  }
  async summary(userId: string, statementId?: string) {
    if (statementId && !(await this.db.statement.findFirst({ where: { id: statementId, userId } })))
      throw new NotFoundException('STATEMENT_NOT_FOUND');
    const groups = await this.db.transaction.groupBy({
      by: ['category', 'status', 'direction', 'economicType', 'validationIssues'],
      where: { userId, ...(statementId ? { statementId } : {}) },
      _sum: { amount: true },
      _count: true,
    });
    const totals: Partial<Record<Category, string>> = {};
    let unresolved = new Decimal(0),
      unresolvedCredits = new Decimal(0),
      expenses = new Decimal(0),
      debits = new Decimal(0),
      known = new Decimal(0);
    let count = 0,
      unresolvedCount = 0,
      automaticCount = 0,
      unresolvedTransferCount = 0,
      reviewableCount = 0,
      extractionReviewCount = 0;
    let totalValue = new Decimal(0),
      acceptedValue = new Decimal(0);
    for (const g of groups) {
      const amount = g._sum.amount ?? new Prisma.Decimal(0);
      count += g._count;
      totalValue = totalValue.plus(amount.toString());
      if (g.status === 'auto_classified') automaticCount += g._count;
      const hasExtractionIssues = (g.validationIssues?.length ?? 0) > 0;
      const accepted =
        !hasExtractionIssues && ['auto_classified', 'user_confirmed'].includes(g.status);
      if (hasExtractionIssues) extractionReviewCount += g._count;
      else if (['requires_user_tagging', 'failed'].includes(g.status)) reviewableCount += g._count;
      if (accepted) {
        known = known.plus(g._count);
        acceptedValue = acceptedValue.plus(amount.toString());
      }
      if (!accepted) unresolvedCount += g._count;
      if (!accepted && g.category === 'transfer_unknown') unresolvedTransferCount += g._count;
      if (g.direction === 'credit' && !accepted)
        unresolvedCredits = unresolvedCredits.plus(amount.toString());
      if (g.direction === 'debit') {
        debits = debits.plus(amount.toString());
        if (!accepted) unresolved = unresolved.plus(amount.toString());
        else if (g.economicType === 'expense') {
          expenses = expenses.plus(amount.toString());
          totals[g.category as Category] = new Decimal(totals[g.category as Category] ?? 0)
            .plus(amount.toString())
            .toFixed(2);
        }
      }
    }
    const [incompleteStatementCount, automaticDecisionCount, automaticCorrectionCount] =
      await Promise.all([
        this.db.statement.count({
          where: {
            userId,
            ...(statementId ? { id: statementId } : {}),
            status: { not: 'extracted' },
          },
        }),
        this.db.classificationRevision.count({
          where: {
            status: 'auto_classified',
            transaction: { userId, ...(statementId ? { statementId } : {}) },
          },
        }),
        this.db.classificationRevision.count({
          where: {
            reasonCode: 'USER_CORRECTED_AUTOMATIC',
            transaction: { userId, ...(statementId ? { statementId } : {}) },
          },
        }),
      ]);
    return {
      currency: 'NGN',
      transactionCount: count,
      unresolvedTransactionCount: unresolvedCount,
      reviewableTransactionCount: reviewableCount,
      extractionReviewCount,
      unresolvedTransferCount,
      automaticTransactionCount: automaticCount,
      automaticCoverageByCount: count ? automaticCount / count : 0,
      acceptedCoverageByValue: totalValue.gt(0) ? acceptedValue.div(totalValue).toNumber() : null,
      automaticDecisionCount,
      automaticCorrectionCount,
      observedAutomaticCorrectionRate: automaticDecisionCount
        ? automaticCorrectionCount / automaticDecisionCount
        : null,
      classifiedExpenseAmount: expenses.toFixed(2),
      unclassifiedDebitAmount: unresolved.toFixed(2),
      unclassifiedCreditAmount: unresolvedCredits.toFixed(2),
      totalDebitAmount: debits.toFixed(2),
      categories: totals,
      classificationCoverage: count ? known.div(count).toNumber() : 1,
      hasUnclassifiedExpenses: unresolved.gt(0) || incompleteStatementCount > 0,
      incompleteStatementCount,
      analysisComplete: known.eq(count) && incompleteStatementCount === 0,
      financialAssessment: { status: 'pending_context', score: null },
    };
  }
  async rules(userId: string) {
    const rules = await this.db.recipientRule.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rules.map(({ recipientHash: _recipientHash, ...rule }) => ({
      ...rule,
      minAmount: rule.minAmount.toFixed(2),
      maxAmount: rule.maxAmount.toFixed(2),
    }));
  }
  async updateRule(
    userId: string,
    id: string,
    input: z.infer<typeof ruleUpdate> | { version: number; deleted: true },
  ) {
    return this.db.$transaction(async (tx) => {
      const rule = await tx.recipientRule.findFirst({ where: { id, userId, deletedAt: null } });
      if (!rule) throw new NotFoundException('RULE_NOT_FOUND');
      const data =
        'deleted' in input
          ? { deletedAt: new Date() }
          : {
              category: input.category,
              ...input.conditions,
              narrationTokens: input.conditions.narrationTokens.map((s) => s.toUpperCase()),
            };
      if (!('deleted' in input))
        assertCategoryDirection(input.category, input.conditions.direction);
      const updated = await tx.recipientRule.updateMany({
        where: { id, userId, version: input.version, deletedAt: null },
        data: { ...data, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('REVISION_CONFLICT');
      const r = (await tx.recipientRule.findUnique({ where: { id } }))!;
      await tx.ruleRevision.create({
        data: {
          ruleId: id,
          version: r.version,
          category: r.category,
          direction: r.direction,
          currency: r.currency,
          minAmount: r.minAmount,
          maxAmount: r.maxAmount,
          narrationTokens: r.narrationTokens,
          deleted: !!r.deletedAt,
        },
      });
      return { ruleId: id, version: r.version, deleted: !!r.deletedAt };
    });
  }
}
