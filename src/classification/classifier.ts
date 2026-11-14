import { Inject, Injectable } from '@nestjs/common';
import { Transaction } from '@prisma/client';
import { Db } from '../common/db';
import { normalizeNarration } from '../common/privacy';
import { Registry } from '../merchants/registry';
import { Transactions, economicType } from '../transactions/service';
import { JevClient } from './jev';
import { Decision, narrationFacts, Policy } from './policy';
import { Category, categorySchema, mapHint } from './ontology';

const safeMerchantCategories = new Set<Category>([
  'groceries',
  'dining',
  'utilities',
  'transport',
  'telecommunications',
  'healthcare',
  'education',
  'shopping',
  'entertainment',
  'subscriptions',
  'gambling',
]);
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
    const base = this.policy.base(
      t.description,
      t.direction,
    );
  
    const facts = narrationFacts(
      t.description,
      t.direction,
    );
  
    // Extraction integrity is separate from categorization.
    const blockingIssues = t.validationIssues.filter(
      issue => issue !== 'POSSIBLE_DUPLICATE_REVIEW',
    );
  
    if (blockingIssues.length || facts.contradiction) {
      return {
        ...base,
        reasonCode: 'EXTRACTION_REVIEW_REQUIRED',
      };
    }
  
    const matches = this.registry.match(t.description);
  
    if (matches.ambiguous) {
      return {
        ...base,
        reasonCode: 'CONFLICTING_MERCHANTS',
      };
    }
   
const context = {
  description: t.description,
  direction: t.direction,
  currency: t.currency,
  channel: facts.channel,
  isTransfer: facts.transfer,
  isPossibleReversal: facts.reversal,

  merchantEvidence: matches.merchants.map(m => ({
    name: m.name,

    categoryHint:
      mapHint(m.category_hint) ?? m.category_hint,

    verification: m.evidence_status,
    requiresContext: m.requires_context,

    geographicScope: m.geographic_scope,
    knownLocations: m.known_locations,

    typicalPurchases: m.typical_purchases.map(p => ({
      category: p.category,
      examples: p.examples,
      evidence: p.evidence,
      sourceUrls: p.source_urls,
    })),
  })),

  intermediaryNames: matches.processors.map(
    p => p.name,
  ),
};

if (
  process.env.JEV_DEBUG_PAYLOAD === '1' &&
  process.env.JEV_BENCH_LIVE === '1'
) {
  console.log(
    '\n[JEV CLASSIFIER CONTEXT]\n',
    JSON.stringify(context, null, 2),
  );
}

  
    if (!this.jev.available()) {
      return {
        ...base,
        reasonCode: 'JEV_NOT_CONFIGURED',
      };
    }
  
    let invoked = false;
  
    try {
      const answer = await this.jev.classify(
        context,
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

      const acceptanceConfidence = Math.min(
        answer.confidence,
        answer.choiceProbability,
      );
  
      // Reject invalid or unsafe automatic outcomes.
      const valid = categorySchema.safeParse(answer.category);
  
      if (
        !valid.success ||
        !Number.isFinite(answer.confidence) ||
        answer.confidence < 0 ||
        answer.confidence > 1
      ) {
        return {
          ...decision,
          reasonCode: 'INVALID_JEV_DECISION',
        };
      }
  
      const category = valid.data;

      const intermediaryOnly =
  matches.processors.length > 0 &&
  matches.merchants.length === 0;

const explicitTransferPurpose =
  /\b(SALARY|PAYROLL|RENT|TUITION|SCHOOL FEES|AIRTIME|DATA BUNDLE|ELECTRICITY|FAMILY SUPPORT|FREELANCE PAYMENT|ESTATE LEVY)\b/.test(facts.n) ||
  matches.merchants.length > 0;

if (intermediaryOnly) {
  return {
    ...decision,
    reasonCode: 'INSUFFICIENT_PURPOSE_EVIDENCE',
  };
}

if (facts.transfer && !explicitTransferPurpose) {
  return {
    ...decision,
    reasonCode: 'UNEXPLAINED_TRANSFER',
  };
}

if (facts.reversal && t.direction === 'credit') {
  return {
    ...decision,
    suggestedCategory:
      category === 'refund' ? 'refund' : null,
    reasonCode: 'REFUND_RECONCILIATION_REQUIRED',
  };
}
  
      // JEV must not invent verified account ownership,
      // refund links, or economic purpose.
      const requiresContext = [
        'unknown',
        'transfer_unknown',
        'other',
        'internal_transfer',
        'refund',
      ].includes(category);
  
      const directionConflict =
        (t.direction === 'debit' &&
          category === 'income') ||
        (t.direction === 'credit' &&
          !['income', 'refund', 'internal_transfer',
            'unknown', 'transfer_unknown'].includes(category));
  
      if (requiresContext || directionConflict) {
        return {
          ...decision,
          suggestedCategory:
            category === 'unknown' ||
            category === 'transfer_unknown'
              ? null
              : category,
          reasonCode: 'ADDITIONAL_CONTEXT_REQUIRED',
        };
      }
  
      // JEV chooses the category.
      // Our existing policy applies the confidence threshold.
      const accepted = this.policy.applySuggestion(
        decision,
        category,
        acceptanceConfidence,
        this.policy.semanticAutoEnabled()
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
      return {
        ...base,
        jevInvoked: invoked,
        reasonCode: 'JEV_UNAVAILABLE',
      };
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
