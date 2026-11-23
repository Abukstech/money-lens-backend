import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Config } from '../src/common/config';
import { Db } from '../src/common/db';
import { Privacy } from '../src/common/privacy';
import { Registry } from '../src/merchants/registry';
import { narrationFacts } from '../src/classification/evidence';
import { Policy } from '../src/classification/policy';
import { JevClient } from '../src/classification/jev';
import { Classifier } from '../src/classification/classifier';
import { Transactions } from '../src/transactions/service';
import DecimalJs from 'decimal.js';
const Decimal = DecimalJs.clone({ precision: 40 });
import { Prisma } from '@prisma/client';
import { money } from '../src/transactions/contracts';
import {
  categories,
  categorySchema,
  ONTOLOGY_VERSION,
  POLICY_VERSION,
} from '../src/classification/ontology';
import { fixtures } from './fixtures';
import { transaction } from '../test/helpers';

async function main() {
  const config = new Config();
  // Offline evaluation by default. Never spend API credits merely by evaluating fixtures.
  if (process.env.EVALUATE_LIVE !== 'true') config.values.JEV_API_KEY = '';
  // Measure prospective semantic acceptance without enabling production automation.
  config.values.SEMANTIC_AUTO_ACCEPT = false;
  const db = new Db();
  const privacy = new Privacy(config);
  const registry = new Registry();
  const classifier = new Classifier(
    db,
    new Transactions(db, privacy, registry),
    registry,
    new JevClient(config, privacy),
    new Policy(config),
  );
  const file = process.argv[2];
  const reviewedSchema = z.object({
    humanReviewed: z.literal(true),
    reviewer: z.string().min(1),
    reviewedAt: z.string().datetime(),
    cases: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          direction: z.enum(['debit', 'credit']),
          expectedCategory: categorySchema,
          expectedStatus: z.enum(['auto_classified', 'requires_user_tagging']),
          amount: money.default('45000.00'),
          expectedMerchantId: z.string().nullable().optional(),
        }),
      )
      .min(1),
  });
  const dataset = file
    ? reviewedSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).cases
    : fixtures;
  const results: {
    expected: string;
    predicted: string;
    statusCorrect: boolean;
    pendingExpected: boolean;
    pendingActual: boolean;
    confidence: number | null;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    expectedMerchantId: string | null | undefined;
    actualMerchantId: string | null;
    acceptedCategory: string;
    autoAccepted: boolean;
    direction: string;
    amount: string;
    source: string;
    semanticCandidate: boolean;
  }[] = [];
  for (const f of dataset) {
    const start = performance.now();
    const decision = await classifier.decide(
      transaction(f.description, { direction: f.direction, amount: new Prisma.Decimal(f.amount) }),
    );
    const merchantMatches = registry.match(f.description);
    results.push({
      expectedMerchantId: f.expectedMerchantId,
      actualMerchantId:
        merchantMatches.merchants.length === 1 ? merchantMatches.merchants[0].id : null,
      acceptedCategory: decision.category,
      autoAccepted: decision.status === 'auto_classified',
      amount: f.amount,
      direction: f.direction,
      source: decision.source,
      semanticCandidate:
        decision.source === 'jev' &&
        decision.reasonCode === 'CONFIRMATION_REQUIRED' &&
        !!decision.suggestedCategory &&
        narrationFacts(f.description, f.direction).semanticPurposes.includes(
          decision.suggestedCategory,
        ) &&
        (decision.evidence?.semanticAcceptanceConfidence ?? 0) >=
          config.values.AUTO_CLASSIFY_THRESHOLD,
      expected: f.expectedCategory,
      predicted: decision.suggestedCategory ?? decision.category,
      statusCorrect: f.expectedStatus === decision.status,
      pendingExpected: f.expectedStatus === 'requires_user_tagging',
      pendingActual: decision.status === 'requires_user_tagging',
      confidence: decision.confidence,
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
      latencyMs: performance.now() - start,
    });
  }
  const accuracy = results.filter((r) => r.expected === r.predicted).length / results.length;
  const labels = categories.filter((c) => results.some((r) => r.expected === c));
  const f1 = labels.map((c) => {
    const tp = results.filter((r) => r.expected === c && r.predicted === c).length;
    const fp = results.filter((r) => r.expected !== c && r.predicted === c).length;
    const fn = results.filter((r) => r.expected === c && r.predicted !== c).length;
    return (2 * tp) / (2 * tp + fp + fn) || 0;
  });
  const confident = results.filter((r) => r.confidence !== null && r.source === 'jev');
  const automatic = results.filter((r) => r.autoAccepted);
  const semanticCandidates = results.filter((r) => r.semanticCandidate);
  const sum = (rows: typeof results) =>
    rows.reduce((total, r) => total.plus(r.amount), new Decimal(0));
  const automaticPrecision = automatic.length
    ? automatic.filter((r) => r.acceptedCategory === r.expected).length / automatic.length
    : null;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const inputTokens = results.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens = results.reduce((a, r) => a + r.outputTokens, 0);
  const inputRate = process.env.JEV_INPUT_USD_PER_MILLION;
  const outputRate = process.env.JEV_OUTPUT_USD_PER_MILLION;
  console.log(
    JSON.stringify(
      {
        dataset: file ? 'human_reviewed' : 'authored_synthetic_regression',
        cases: results.length,
        policyVersion: POLICY_VERSION,
        ontologyVersion: ONTOLOGY_VERSION,
        datasetChecksum: registry.checksum,
        automaticPrecision,
        semanticCandidateCount: semanticCandidates.length,
        semanticCandidatePrecision: semanticCandidates.length
          ? semanticCandidates.filter((r) => r.predicted === r.expected).length /
            semanticCandidates.length
          : null,
        semanticCandidateByCategory: Object.fromEntries(
          categories.map((category) => {
            const slice = semanticCandidates.filter((r) => r.predicted === category);
            return [
              category,
              {
                sampleSize: slice.length,
                precision: slice.length
                  ? slice.filter((r) => r.expected === category).length / slice.length
                  : null,
              },
            ];
          }),
        ),
        precisionTarget: 0.98,
        meetsObservedPrecisionTarget:
          !!file && automaticPrecision !== null && automaticPrecision >= 0.98,
        automaticCoverageByCount: automatic.length / results.length,
        automaticCoverageByValue: sum(results).gt(0)
          ? sum(automatic).div(sum(results)).toNumber()
          : null,
        automaticByCategory: Object.fromEntries(
          categories.map((category) => {
            const slice = automatic.filter((r) => r.acceptedCategory === category);
            return [
              category,
              {
                sampleSize: slice.length,
                precision: slice.length
                  ? slice.filter((r) => r.expected === category).length / slice.length
                  : null,
              },
            ];
          }),
        ),
        unresolvedTransfers: results.filter(
          (r) => r.pendingActual && r.acceptedCategory === 'transfer_unknown',
        ).length,
        categorySuggestionAccuracy: accuracy,
        macroF1: f1.reduce((a, b) => a + b, 0) / f1.length,
        macroF1Categories: labels,
        pendingRoutingAccuracy: results.filter((r) => r.statusCorrect).length / results.length,
        unknownDetectionAccuracy:
          results
            .filter((r) => ['unknown', 'transfer_unknown'].includes(r.expected))
            .filter((r) => r.expected === r.predicted).length /
          Math.max(
            1,
            results.filter((r) => ['unknown', 'transfer_unknown'].includes(r.expected)).length,
          ),
        incorrectHighConfidencePredictions: results.filter(
          (r) => r.confidence !== null && r.confidence >= 0.9 && r.expected !== r.predicted,
        ).length,
        confidenceBrierScore: confident.length
          ? confident.reduce(
              (a, r) => a + (r.confidence! - Number(r.expected === r.predicted)) ** 2,
              0,
            ) / confident.length
          : null,
        latencyMs: {
          median: latencies[Math.floor(latencies.length / 2)],
          p95: latencies[Math.floor(latencies.length * 0.95)],
        },
        inputTokens,
        outputTokens,
        estimatedUsdPerTransaction:
          inputRate && outputRate
            ? (inputTokens * Number(inputRate) + outputTokens * Number(outputRate)) /
              1000000 /
              results.length
            : null,
        merchantFalsePositiveRate: results.some((r) => r.expectedMerchantId === null)
          ? results.filter((r) => r.expectedMerchantId === null && r.actualMerchantId !== null)
              .length / results.filter((r) => r.expectedMerchantId === null).length
          : null,
        userCorrectionRate: null,
        limitations: [
          'Synthetic fixtures are not production accuracy evidence.',
          'Reviewed inputs must be representative and held out; observed precision is not a population guarantee.',
          'Question reduction and subsequent correction rates require live grouped-review and audit observations.',
          'Confidence calibration excludes deterministic and user-rule confidence values.',
          'Merchant false positives are evaluated only where merchant identities were labeled.',
          'User correction rate requires observed user feedback.',
          'Confidence calibration requires representative human-reviewed held-out data.',
        ],
      },
      null,
      2,
    ),
  );
  await db.$disconnect();
}
void main().catch(() => {
  process.stderr.write('EVALUATION_FAILED\n');
  process.exitCode = 1;
});
