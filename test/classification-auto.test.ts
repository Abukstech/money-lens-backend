import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONTOLOGY_VERSION, POLICY_VERSION } from '../src/classification/ontology';
import { explicitRowIdentifiers } from '../src/statements/extraction/row-identifiers';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { Db } from '../src/common/db';
import { Registry } from '../src/merchants/registry';
import { Transactions, assertCategoryDirection } from '../src/transactions/service';
import { Classifier } from '../src/classification/classifier';
import { JevClient, semanticNarration } from '../src/classification/jev';
import { Policy } from '../src/classification/policy';
import { narrationFacts } from '../src/classification/evidence';
import { transaction } from './helpers';
import { bulkFeedbackInput } from '../src/transactions/contracts';
import { calculateFacts } from '../src/insights/facts';

const config = new Config();
const registry = new Registry();
const db = new Db();
const jev = new JevClient(config, new Privacy(config));
const classifier = new Classifier(
  db,
  new Transactions(db, new Privacy(config), registry),
  registry,
  jev,
  new Policy(config),
);
afterEach(() => vi.restoreAllMocks());

describe('automatic purpose classification', () => {
  it.each([
    [
      'Bill payment for Airtel recharge for [REDACTED]with amount @airtelnigeria by @merchant',
      'telecommunications',
    ],
    ['bill-payment / airtel / recharge [REDACTED]', 'telecommunications'],
    ['PAYSTACK BILL PAYMENT AIRTEL RECHARGE', 'telecommunications'],
    ['NIP TRF MTN DATA BUNDLE', 'telecommunications'],
    ['MTN DATA', 'telecommunications'],
    ['AIRTEL MOBILE DATA PURCHASE', 'telecommunications'],
    ['Stamp Duty', 'financial_fees'],
    ['stamp-duty', 'financial_fees'],
    ['EMTL', 'financial_fees'],
    ['EKEDC ELECTRICITY TOKEN', 'utilities'],
    ['IKEDC PREPAID TOKEN', 'utilities'],
    ['BILL PAYMENT DSTV SUBSCRIPTION', 'subscriptions'],
    ['ATM CASH WITHDRAWAL', 'cash_withdrawal'],
  ])('accepts explicit purpose: %s', async (description, category) => {
    const decision = await classifier.decide(transaction(description));
    expect(decision).toMatchObject({
      category,
      status: 'auto_classified',
      jevInvoked: false,
      source: 'deterministic',
    });
    expect(decision.evidence?.patternVersion).toBeTruthy();
  });
  it.each([
    'BILL PAYMENT',
    'POS DATA ERROR',
    'MTN DATA ERROR',
    'AIRTEL RECHARGE FAILED',
    'PAYSTACK PAYMENT',
    'RECHARGE',
    'PREPAID CARD',
    'AIRTEL',
    'NETFLIX',
    'TRANSFER SOMEONE',
    'AIRTEL RECHARGE ELECTRICITY PAYMENT',
    'AIRTEL RECHARGE RENT PAYMENT',
    'ELECTRICITY GENERATOR REPAIR',
  ])('does not guess: %s', async (description) => {
    expect((await classifier.decide(transaction(description))).status).toBe(
      'requires_user_tagging',
    );
  });
  it('routes credits, reversals and invalid extraction before purchase rules', async () => {
    for (const t of [
      transaction('AIRTEL RECHARGE', { direction: 'credit' }),
      transaction('REVERSAL AIRTEL RECHARGE', { direction: 'credit' }),
      transaction('Stamp Duty', { validationIssues: ['POSSIBLE_DUPLICATE_REVIEW'] }),
    ]) {
      expect((await classifier.decide(t)).status).toBe('requires_user_tagging');
    }
  });
  it('preserves confirmed classifications', async () => {
    const decision = await classifier.decide(
      transaction('AIRTEL RECHARGE', {
        category: 'business_expenses',
        status: 'user_confirmed',
        source: 'user_confirmed',
        economicType: 'expense',
      }),
    );
    expect(decision.category).toBe('business_expenses');
    expect(decision.status).toBe('user_confirmed');
  });
  it('recognizes embedded bank transfer codes without treating a company name as earnings', async () => {
    const description =
      'Credit from EXAMPLE SERVICES LIMITED - website /AT68_TRF2MPTitgom[REDACTED]';
    expect(narrationFacts(description, 'credit').transfer).toBe(true);
    expect(
      await classifier.decide(transaction(description, { direction: 'credit' })),
    ).toMatchObject({ category: 'transfer_unknown', status: 'requires_user_tagging' });
  });
  it('preserves authored bill clues while excluding private transfer text', () => {
    const text = semanticNarration(
      'TRF2XYZ TO PRIVATE PERSON FOR PAYSTACK AIRTEL RECHARGE STAMP DUTY',
      [],
    );
    expect(text).toContain('RECHARGE');
    expect(text).toContain('STAMP DUTY');
    expect(text).not.toContain('PRIVATE PERSON');
    expect(text).not.toContain('PAYSTACK');
  });
  it('does not automatically turn family support into earnings even with a calibrated income model', async () => {
    vi.spyOn(Policy.prototype, 'semanticAutoEnabled').mockReturnValue(true);
    vi.spyOn(jev, 'available').mockReturnValue(true);
    vi.spyOn(jev, 'classify').mockResolvedValue({
      category: 'income',
      confidence: 0.99,
      choiceProbability: 0.99,
      model: 'synthetic',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(
      (await classifier.decide(transaction('NIP FAMILY SUPPORT', { direction: 'credit' }))).status,
    ).toBe('requires_user_tagging');
  });
  it('allows a processor with explicit purpose to reach the semantic suggestion path', async () => {
    vi.spyOn(jev, 'available').mockReturnValue(true);
    vi.spyOn(jev, 'classify').mockResolvedValue({
      category: 'housing',
      confidence: 0.99,
      choiceProbability: 0.99,
      model: 'synthetic',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(await classifier.decide(transaction('PAYSTACK TRANSFER RENT'))).toMatchObject({
      suggestedCategory: 'housing',
      status: 'requires_user_tagging',
    });
  });
});

describe('incoming payments and bulk contracts', () => {
  it.each(['gift_received', 'loan_received', 'repayment_received'])(
    'accepts %s only as a credit',
    (category) => {
      expect(() => assertCategoryDirection(category, 'credit')).not.toThrow();
      expect(() => assertCategoryDirection(category, 'debit')).toThrow();
    },
  );
  it('does not count gifts, loans or reimbursements as earnings or net them against spending', () => {
    const rows = ['gift_received', 'loan_received', 'repayment_received'].map((category, i) =>
      transaction('CONFIRMED', {
        id: String(i),
        category,
        status: 'user_confirmed',
        direction: 'credit',
      }),
    );
    rows.push(transaction('EXPENSE', { category: 'dining', status: 'user_confirmed' }));
    const facts = calculateFacts('2026-10', rows, null, [], [], 0, 0, new Date('2026-11-15'));
    expect(facts.metrics.observed_income.value).toBe('0.00');
    expect(facts.metrics.gifts_received.value).toBe('45000.00');
    expect(facts.metrics.loans_received.value).toBe('45000.00');
    expect(facts.metrics.repayments_received.value).toBe('45000.00');
    expect(facts.metrics.net_expenses.value).toBe('45000.00');
  });
  it('rejects duplicate rows, oversized requests and unscoped memory', () => {
    const item = { transactionId: 't1', revision: 0 };
    expect(bulkFeedbackInput.safeParse({ items: [item, item], category: 'housing' }).success).toBe(
      false,
    );
    expect(
      bulkFeedbackInput.safeParse({
        items: Array.from({ length: 101 }, (_, i) => ({ ...item, transactionId: String(i) })),
        category: 'housing',
      }).success,
    ).toBe(false);
    expect(
      bulkFeedbackInput.safeParse({ items: [item], category: 'housing', rememberForFuture: true })
        .success,
    ).toBe(false);
  });
});

describe('identity and semantic rollout safeguards', () => {
  it('requires an explicit labelled bank/account pair and rejects conflicting identities', () => {
    expect(explicitRowIdentifiers('TO EXAMPLE PERSON 1234567890')).toEqual({});
    expect(explicitRowIdentifiers('BENEFICIARY 999:1234567890')).toEqual({
      recipientIdentifier: '999:1234567890',
    });
    expect(explicitRowIdentifiers('BENEFICIARY 999:1234567890 BENEFICIARY 999:1111111111')).toEqual(
      {},
    );
  });
  it('binds automatic model acceptance to measured category precision and deployment evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'moneylens-calibration-'));
    const isolated = new Config();
    isolated.values.SEMANTIC_AUTO_ACCEPT = true;
    isolated.values.CALIBRATION_EVIDENCE_PATH = join(directory, 'evidence.json');
    const policy = new Policy(isolated);
    const evidence = {
      policyVersion: POLICY_VERSION,
      ontologyVersion: ONTOLOGY_VERSION,
      datasetChecksum: registry.checksum,
      model: isolated.values.JEV_MODEL,
      returnedModel: 'reviewed-model',
      autoClassifyThreshold: isolated.values.AUTO_CLASSIFY_THRESHOLD,
      humanReviewed: true,
      reportSha256: 'a'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z',
      categories: { housing: { precision: 0.98, sampleSize: 100 } },
    };
    const save = () =>
      writeFileSync(isolated.values.CALIBRATION_EVIDENCE_PATH!, JSON.stringify(evidence));
    try {
      save();
      expect(policy.semanticAutoEnabled('reviewed-model', registry.checksum, 'housing')).toBe(true);
      expect(policy.semanticAutoEnabled('different-model', registry.checksum, 'housing')).toBe(
        false,
      );
      expect(policy.semanticAutoEnabled('reviewed-model', 'changed', 'housing')).toBe(false);
      expect(policy.semanticAutoEnabled('reviewed-model', registry.checksum, 'education')).toBe(
        false,
      );
      evidence.categories.housing.precision = 0.97;
      save();
      expect(policy.semanticAutoEnabled('reviewed-model', registry.checksum, 'housing')).toBe(
        false,
      );
      evidence.categories.housing.precision = 0.99;
      evidence.categories.housing.sampleSize = 2;
      save();
      expect(policy.semanticAutoEnabled('reviewed-model', registry.checksum, 'housing')).toBe(
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
