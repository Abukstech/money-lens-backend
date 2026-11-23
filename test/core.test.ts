import { describe, expect, it, vi } from 'vitest';
import { Config } from '../src/common/config';
import { Privacy, normalizeNarration, sanitizeNarration } from '../src/common/privacy';
import { Registry } from '../src/merchants/registry';
import { Policy } from '../src/classification/policy';
import { JevClient, semanticNarration } from '../src/classification/jev';
import { Classifier } from '../src/classification/classifier';
import { Db } from '../src/common/db';
import { Transactions } from '../src/transactions/service';
import { money, date, feedbackInput, transactionInput } from '../src/transactions/contracts';
import { fixtures } from '../scripts/fixtures';
import { transaction } from './helpers';
import { afterEach } from 'vitest';
import { categorySchema } from '../src/classification/ontology';
const config = new Config();
const registry = new Registry();
const privacy = new Privacy(config);
const db = new Db();
const transactions = new Transactions(db, privacy, registry);
const jev = new JevClient(config, privacy);
const policy = new Policy(config);
const classifier = new Classifier(db, transactions, registry, jev, policy);

describe('contracts and privacy', () => {
  it('uses exact decimal values and rejects excess precision/invalid dates', () => {
    expect(money.parse('0.10')).toBe('0.10');
    expect(money.parse(45800)).toBe('45800.00');
    for (const n of ['0.001', '1e3', 'NaN', '-4', '1000000000000000000.01'])
      expect(money.safeParse(n).success).toBe(false);
    expect(date.safeParse('2026-02-30').success).toBe(false);
    expect(
      transactionInput.safeParse({
        id: 'a',
        date: '2026-01-01',
        amount: '1',
        direction: 'debit',
        userId: 'forged',
      }).success,
    ).toBe(false);
  });
  it('removes account numbers/emails/control characters before persistence', () => {
    const safe = sanitizeNarration('POS SPAR 0123456789 test@example.com\n');
    expect(safe).not.toContain('0123456789');
    expect(safe).not.toContain('test@example.com');
    expect(safe).not.toContain('\n');
    expect(normalizeNarration('pos--- SPAR  ikeja')).toBe('POS SPAR IKEJA');
  });
  it('scopes stable hashes by user and purpose', () => {
    expect(privacy.hash('a', 'document', 'same')).not.toBe(privacy.hash('b', 'document', 'same'));
    expect(privacy.hash('a', 'account', 'same')).not.toBe(privacy.hash('a', 'recipient', 'same'));
  });
  it('requires a known category and explicit conditions when remembering', () => {
    expect(feedbackInput.safeParse({ revision: 0, category: 'unknown' }).success).toBe(false);
    expect(
      feedbackInput.safeParse({ revision: 0, category: 'housing', rememberForFuture: true })
        .success,
    ).toBe(false);
  });
  it('omits private transfer counterparties from semantic state', () => {
    expect(semanticNarration('NIP TRF ADEBAYO TUNDE RENT', [])).toBe(
      'NIP TRF RENT [PRIVATE COUNTERPARTY OMITTED]',
    );
  });
  it('rejects display names as stable recipient identifiers', () => {
    expect(
      transactionInput.safeParse({
        id: 'a',
        date: '2026-01-01',
        amount: '1',
        direction: 'debit',
        recipientIdentifier: 'ADEBAYO TUNDE',
      }).success,
    ).toBe(false);
  });
  it('does not enable semantic automation without calibration evidence', () =>
    expect(policy.semanticAutoEnabled()).toBe(false));
});
it('keeps analysis incomplete when only unknown credits remain', async () => {
  const mockDb = {
    transaction: {
      groupBy: async () => [
        {
          category: 'unknown',
          status: 'requires_user_tagging',
          direction: 'credit',
          economicType: 'unresolved',
          _sum: { amount: transaction('UNKNOWN CREDIT').amount },
          _count: 1,
        },
      ],
    },
    statement: { count: async () => 0 },
    classificationRevision: { count: async () => 0 },
  } as unknown as Db;
  const summary = await new Transactions(mockDb, privacy, registry).summary('synthetic-user');
  expect(summary.analysisComplete).toBe(false);
  expect(summary.classificationCoverage).toBe(0);
});

describe('merchant registry', () => {
  it('validates all 248 seed vendors and exposes reproducible provenance', () => {
    expect(registry.vendors).toHaveLength(248);
    expect(registry.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
  it('matches token boundaries and separates processors', () => {
    expect(registry.match('POS SPARKLE').merchants).toHaveLength(0);
    expect(registry.match('POS SPAR IKEJA').hint).toBe('groceries');
    expect(registry.match('PAYSTACK SPAR').merchants.map((m) => m.id)).toEqual(['spar']);
    expect(registry.match('PAYSTACK SPAR').processors).toHaveLength(1);
    expect(registry.match('SPAR SHOPRITE').ambiguous).toBe(true);
    expect(registry.match('OPAY TRANSFER').hint).toBeNull();
  });
});

describe('200 authored Nigerian narration fixtures', () => {
  for (const f of fixtures) {
    it(f.id, () => {
      // Preserve our labelled examples for JEV evaluation.
      expect(f.description.trim().length).toBeGreaterThan(0);
      expect(['debit', 'credit']).toContain(f.direction);

      expect(categorySchema.safeParse(f.expectedCategory).success).toBe(true);

      // The registry supplies merchant evidence, not final categories.
      const matches = registry.match(f.description);

      for (const merchant of matches.merchants) {
        expect(registry.get(merchant.id)?.id).toBe(merchant.id);
      }

      // Context sent to JEV must not expose account numbers.
      const safe = semanticNarration(
        f.description,
        matches.merchants.map((m) => m.name),
      );

      expect(safe.length).toBeGreaterThan(0);
      expect(safe).not.toMatch(/\b\d{10,}\b/);
    });
  }
});

describe('evidence and confidence gates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('does not allow model confidence to resolve processor-only purpose', async () => {
    vi.spyOn(jev, 'available').mockReturnValue(true);
    vi.spyOn(jev, 'classify').mockImplementation(async (_state, onInvoke) => {
      onInvoke();
      return {
        category: 'shopping',
        choiceProbability: 0.97,
        confidence: 0.999,
        model: 'synthetic',
        inputTokens: 5,
        outputTokens: 1,
      };
    });
    const d = await classifier.decide(transaction('FLUTTERWAVE PAYMENT'));
    expect(d.category).toBe('unknown');
    expect(d.status).toBe('requires_user_tagging');
    expect(d.jevInvoked).toBe(true);
  });
  it('falls back safely on semantic failure', async () => {
    vi.spyOn(jev, 'available').mockReturnValue(true);
    vi.spyOn(jev, 'classify').mockImplementation(async (_state, onInvoke) => {
      onInvoke();
      throw new Error('SENSITIVE_PROVIDER_MARKER');
    });
    const d = await classifier.decide(transaction('UNIDENTIFIED PAYMENT'));
    expect(d.category).toBe('unknown');
    expect(d.jevInvoked).toBe(true);
    expect(JSON.stringify(d)).not.toContain('SENSITIVE_PROVIDER_MARKER');
  });
  it('requires extraction correction before purpose acceptance', async () => {
    const d = await classifier.decide(
      transaction('ATM CASH', { validationIssues: ['BALANCE_RECONCILIATION_MISMATCH'] }),
    );
    expect(d.category).toBe('unknown');
  });

  it('routes ATM reversals to reconciliation before acceptance', async () => {
    vi.spyOn(jev, 'available').mockReturnValue(true);

    vi.spyOn(jev, 'classify').mockImplementation(async (_state, onInvoke) => {
      onInvoke();

      return {
        category: 'refund',
        confidence: 0.98,
        choiceProbability: 0.98,
        model: 'synthetic',
        inputTokens: 5,
        outputTokens: 1,
      };
    });

    const d = await classifier.decide(
      transaction('ATM CASH WITHDRAWAL REVERSAL', {
        direction: 'credit',
      }),
    );

    expect(d.suggestedCategory).toBe('refund');
    expect(d.status).toBe('requires_user_tagging');
    expect(d.jevInvoked).toBe(false);
  });

  it('handles confidence boundaries conservatively', () => {
    const base = policy.base('PAYMENT', 'debit');
    expect(policy.applySuggestion(base, 'housing', 0.74, true).suggestedCategory).toBeNull();
    expect(policy.applySuggestion(base, 'housing', 0.75, true).status).toBe(
      'requires_user_tagging',
    );
    expect(policy.applySuggestion(base, 'housing', 0.9, true).status).toBe('auto_classified');
    expect(policy.applySuggestion(base, 'housing', 0.99, false).status).toBe(
      'requires_user_tagging',
    );
  });
});
