import {
  Inject,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Transaction } from '@prisma/client';
import Decimal from 'decimal.js';
import { Db } from '../common/db';
import { Privacy, normalizeNarration, sanitizeNarration } from '../common/privacy';
import { TransactionInput, correctionInput, feedbackInput, ruleUpdate } from './contracts';
import { z } from 'zod';
import { Category, ONTOLOGY_VERSION, POLICY_VERSION } from '../classification/ontology';
import { Decision } from '../classification/policy';
import { Registry } from '../merchants/registry';

export function economicType(category: string, direction: string) {
  if (category === 'unknown' || category === 'transfer_unknown') return 'unresolved';
  if (category === 'cash_withdrawal') return 'cash_movement';
  if (category === 'internal_transfer') return 'internal_transfer';
  if (category === 'refund') return 'refund';
  if (category === 'savings' || category === 'investments') return 'capital_movement';
  return direction === 'credit' ? 'income' : 'expense';
}
export function assertCategoryDirection(category: string, direction: string) {
  if (
    (direction === 'debit' && ['income', 'refund'].includes(category)) ||
    (direction === 'credit' &&
      category !== 'income' &&
      category !== 'refund' &&
      category !== 'internal_transfer')
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
  async persistDecision(snapshot: Transaction, decision: Decision, latencyMs: number) {
    return this.db.$transaction(async (tx) => {
      const { reasonCode, ...data } = decision;
      const changed = await tx.transaction.updateMany({
        where: {
          id: snapshot.id,
          userId: snapshot.userId,
          revision: snapshot.revision,
          status: { not: 'user_confirmed' },
        },
        data: {
          ...data,
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
    return this.db.$transaction(async (tx) => {
      const t = await this.owned(userId, id, tx);
      assertCategoryDirection(input.category, t.direction);
      if (t.revision !== input.revision) throw new ConflictException('REVISION_CONFLICT');
      if (t.validationIssues.length)
        throw new BadRequestException('EXTRACTION_CORRECTION_REQUIRED');
      if (input.rememberForFuture && (!t.recipientHash || !input.conditions))
        throw new BadRequestException('STABLE_RECIPIENT_REQUIRED');
      if (
        input.rememberForFuture &&
        input.conditions &&
        (input.conditions.direction !== t.direction ||
          !t.amount.gte(input.conditions.minAmount) ||
          !t.amount.lte(input.conditions.maxAmount) ||
          !input.conditions.narrationTokens.every((s) =>
            ` ${normalizeNarration(t.description)} `.includes(` ${s.toUpperCase()} `),
          ))
      )
        throw new BadRequestException('RULE_DOES_NOT_MATCH_TRANSACTION');
      const changed = await tx.transaction.updateMany({
        where: { id, userId, revision: input.revision },
        data: {
          category: input.category,
          suggestedCategory: null,
          status: 'user_confirmed',
          source: 'user_confirmed',
          confidence: 1,
          economicType: economicType(input.category, t.direction),
          revision: { increment: 1 },
          classifiedAt: new Date(),
        },
      });
      if (changed.count !== 1) throw new ConflictException('REVISION_CONFLICT');
      const updated = await this.owned(userId, id, tx);
      await tx.classificationRevision.create({ data: auditData(updated, 'USER_CONFIRMED') });
      if (input.rememberForFuture && input.conditions) {
        const c = input.conditions;
        const rule = await tx.recipientRule.create({
          data: {
            userId,
            recipientHash: t.recipientHash!,
            category: input.category,
            direction: c.direction,
            currency: c.currency,
            minAmount: c.minAmount,
            maxAmount: c.maxAmount,
            narrationTokens: c.narrationTokens.map((s) => s.toUpperCase()),
          },
        });
        await tx.ruleRevision.create({
          data: {
            ruleId: rule.id,
            version: 1,
            category: rule.category,
            direction: rule.direction,
            currency: rule.currency,
            minAmount: rule.minAmount,
            maxAmount: rule.maxAmount,
            narrationTokens: rule.narrationTokens,
          },
        });
      }
      return this.present(updated);
    });
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
  async summary(userId: string) {
    const groups = await this.db.transaction.groupBy({
      by: ['category', 'status', 'direction', 'economicType'],
      where: { userId },
      _sum: { amount: true },
      _count: true,
    });
    const totals: Partial<Record<Category, string>> = {};
    let unresolved = new Decimal(0),
      expenses = new Decimal(0),
      debits = new Decimal(0),
      known = new Decimal(0);
    let count = 0;
    for (const g of groups) {
      const amount = g._sum.amount ?? new Prisma.Decimal(0);
      count += g._count;
      const accepted = ['auto_classified', 'user_confirmed'].includes(g.status);
      if (accepted) known = known.plus(g._count);
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
    const incompleteStatementCount = await this.db.statement.count({
      where: { userId, status: { not: 'extracted' } },
    });
    return {
      currency: 'NGN',
      classifiedExpenseAmount: expenses.toFixed(2),
      unclassifiedDebitAmount: unresolved.toFixed(2),
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
