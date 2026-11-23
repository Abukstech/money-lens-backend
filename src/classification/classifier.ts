import { Inject, Injectable } from '@nestjs/common';
import { Transaction } from '@prisma/client';
import { Db } from '../common/db';
import { Registry } from '../merchants/registry';
import { Transactions, assertCategoryDirection, economicType } from '../transactions/service';
import { JevClient } from './jev';
import { Decision, Policy } from './policy';
import { narrationFacts, PATTERN_VERSION } from './evidence';
import { categorySchema, mapHint } from './ontology';

@Injectable()
export class Classifier {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Transactions) private readonly transactions: Transactions,
    @Inject(Registry) private readonly registry: Registry,
    @Inject(JevClient) private readonly jev: JevClient,
    @Inject(Policy) private readonly policy: Policy,
  ) {}

  async decide(t: Transaction): Promise<Decision> {
    const base = this.policy.base(t.description, t.direction);
    const facts = narrationFacts(t.description, t.direction);
    if (t.status === 'user_confirmed') {
      return {
        ...base,
        category: categorySchema.parse(t.category),
        suggestedCategory: null,
        status: t.status,
        source: t.source,
        confidence: t.confidence,
        economicType: t.economicType,
        reasonCode: 'USER_CONFIRMED',
        linkedTransactionId: t.linkedTransactionId,
        channel: t.channel,
      };
    }
    if (t.validationIssues.length || facts.contradiction)
      return { ...base, reasonCode: 'EXTRACTION_REVIEW_REQUIRED' };

    // A reversal is not a fresh purchase, even if its narration mentions a bill.
    if (facts.reversal) {
      if (t.direction === 'credit' && t.referenceHash) {
        const candidates = await this.db.transaction.findMany({
          where: {
            userId: t.userId,
            id: { not: t.id },
            direction: 'debit',
            referenceHash: t.referenceHash,
            amount: t.amount,
            ...(t.accountHash ? { accountHash: t.accountHash } : {}),
            date: { lte: t.date, gte: new Date(t.date.valueOf() - 120 * 86400000) },
            validationIssues: { isEmpty: true },
          },
          take: 2,
        });
        if (candidates.length === 1 && (t.accountHash || !candidates[0].accountHash)) {
          const linked = await this.db.transaction.count({
            where: {
              userId: t.userId,
              linkedTransactionId: candidates[0].id,
              id: { not: t.id },
              status: { in: ['auto_classified', 'user_confirmed'] },
            },
          });
          if (!linked)
            return {
              ...base,
              category: 'refund',
              status: 'auto_classified',
              source: 'deterministic',
              confidence: 1,
              economicType: 'refund',
              linkedTransactionId: candidates[0].id,
              reasonCode: 'REFUND_RECONCILED',
              evidence: {
                patternIds: ['unique_refund_reference'],
                patternVersion: PATTERN_VERSION,
              },
            };
        }
      }
      return {
        ...base,
        suggestedCategory: t.direction === 'credit' ? 'refund' : null,
        reasonCode: 'REFUND_RECONCILIATION_REQUIRED',
      };
    }

    if (facts.paymentStatusUnclear)
      return { ...base, reasonCode: 'PAYMENT_STATUS_REVIEW_REQUIRED' };

    if (t.recipientHash) {
      const rules = await this.db.recipientRule.findMany({
        where: {
          userId: t.userId,
          recipientHash: t.recipientHash,
          deletedAt: null,
          direction: t.direction,
          currency: t.currency,
          minAmount: { lte: t.amount },
          maxAmount: { gte: t.amount },
        },
        orderBy: { id: 'asc' },
      });
      const matching = rules.filter(
        (rule) =>
          rule.narrationTokens.length > 0 &&
          rule.narrationTokens.every((token) =>
            ` ${facts.n} `.includes(` ${token.toUpperCase()} `),
          ),
      );
      if (new Set(matching.map((rule) => rule.category)).size > 1)
        return { ...base, reasonCode: 'CONFLICTING_USER_RULES' };
      if (matching.length) {
        const rule = matching[0];
        const category = categorySchema.safeParse(rule.category);
        if (category.success && !['unknown', 'transfer_unknown'].includes(category.data)) {
          try {
            assertCategoryDirection(category.data, t.direction);
            return {
              ...base,
              category: category.data,
              status: 'auto_classified',
              source: 'user_rule',
              confidence: 1,
              economicType: economicType(category.data, t.direction),
              reasonCode: 'USER_RULE_MATCHED',
              evidence: { ruleId: rule.id, ruleVersion: rule.version },
            };
          } catch {
            return { ...base, reasonCode: 'INVALID_USER_RULE' };
          }
        }
      }
    }
    if (facts.conflictingPurposes) return { ...base, reasonCode: 'CONFLICTING_PURPOSES' };
    const matches = this.registry.match(t.description);
    if (matches.ambiguous) return { ...base, reasonCode: 'CONFLICTING_MERCHANTS' };
    const purpose = facts.cash ? 'cash_withdrawal' : facts.purposes[0];
    if (t.direction === 'debit' && purpose) {
      return {
        ...base,
        category: purpose,
        status: 'auto_classified',
        source: 'deterministic',
        confidence: 1,
        merchantId: matches.merchants[0]?.id ?? null,
        economicType: economicType(purpose, t.direction),
        reasonCode: 'EXPLICIT_PURPOSE',
        evidence: {
          patternIds: facts.cash ? ['cash_withdrawal'] : facts.patterns,
          patternVersion: PATTERN_VERSION,
        },
      };
    }
    if (!this.jev.available())
      return {
        ...base,
        suggestedCategory:
          t.direction === 'debit' &&
          matches.hint &&
          !['income', 'refund', 'internal_transfer', 'savings', 'investments'].includes(
            matches.hint,
          )
            ? matches.hint
            : null,
        merchantId: matches.merchants[0]?.id ?? null,
        reasonCode: 'JEV_NOT_CONFIGURED',
      };
    let invoked = false;
    try {
      const answer = await this.jev.classify(
        {
          description: t.description,
          direction: t.direction,
          currency: t.currency,
          channel: facts.channel,
          isTransfer: facts.transfer,
          isPossibleReversal: facts.reversal,
          merchantEvidence: matches.merchants.map((m) => ({
            name: m.name,
            categoryHint: mapHint(m.category_hint) ?? m.category_hint,
            verification: m.evidence_status,
            requiresContext: m.requires_context,
            geographicScope: m.geographic_scope,
            knownLocations: m.known_locations,
            typicalPurchases: m.typical_purchases.map((p) => ({
              category: p.category,
              examples: p.examples,
              evidence: p.evidence,
              sourceUrls: p.source_urls,
            })),
          })),
          intermediaryNames: matches.processors.map((p) => p.name),
        },
        () => {
          invoked = true;
        },
      );
      const decision: Decision = {
        ...base,
        merchantId: matches.merchants[0]?.id ?? null,
        source: 'jev',
        jevInvoked: invoked,
        modelVersion: answer.model,
        inputTokens: answer.inputTokens,
        outputTokens: answer.outputTokens,
        confidence: answer.confidence,
      };
      const valid = categorySchema.safeParse(answer.category);
      if (
        !valid.success ||
        !Number.isFinite(answer.confidence) ||
        !Number.isFinite(answer.choiceProbability) ||
        answer.confidence < 0 ||
        answer.confidence > 1 ||
        answer.choiceProbability < 0 ||
        answer.choiceProbability > 1
      )
        return { ...decision, confidence: null, reasonCode: 'INVALID_JEV_DECISION' };
      const category = valid.data;
      decision.evidence = {
        semanticAcceptanceConfidence: Math.min(answer.confidence, answer.choiceProbability),
      };
      if (matches.processors.length && !matches.merchants.length && !facts.hasPurpose)
        return { ...decision, reasonCode: 'INSUFFICIENT_PURPOSE_EVIDENCE' };
      if (facts.transfer && !facts.hasPurpose && !matches.merchants.length)
        return { ...decision, reasonCode: 'UNEXPLAINED_TRANSFER' };
      try {
        assertCategoryDirection(category, t.direction);
      } catch {
        return { ...decision, reasonCode: 'ADDITIONAL_CONTEXT_REQUIRED' };
      }
      if (
        [
          'unknown',
          'transfer_unknown',
          'other',
          'internal_transfer',
          'refund',
          'gift_received',
          'loan_received',
          'repayment_received',
        ].includes(category)
      )
        return {
          ...decision,
          suggestedCategory: ['unknown', 'transfer_unknown'].includes(category) ? null : category,
          reasonCode: 'ADDITIONAL_CONTEXT_REQUIRED',
        };
      const accepted = this.policy.applySuggestion(
        decision,
        category,
        Math.min(answer.confidence, answer.choiceProbability),
        facts.semanticPurposes.includes(category) &&
          this.policy.semanticAutoEnabled(answer.model, this.registry.checksum, category),
      );
      return {
        ...accepted,
        confidence: answer.confidence,
        economicType:
          accepted.status === 'auto_classified'
            ? economicType(accepted.category, t.direction)
            : 'unresolved',
      };
    } catch {
      return { ...base, jevInvoked: invoked, reasonCode: 'JEV_UNAVAILABLE' };
    }
  }

  async run(id: string, expectedRevision: number) {
    const t = await this.db.transaction.findUnique({ where: { id } });
    if (!t || t.revision !== expectedRevision || t.status === 'user_confirmed') return;
    const start = Date.now();
    const decision = await this.decide(t);
    await this.transactions.persistDecision(t, decision, Date.now() - start);
  }
}
