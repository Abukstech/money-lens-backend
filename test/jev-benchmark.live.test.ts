import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { Db } from '../src/common/db';
import { Transactions } from '../src/transactions/service';
import { Registry } from '../src/merchants/registry';
import { JevClient, type SemanticAnswer } from '../src/classification/jev';
import { Policy, narrationFacts } from '../src/classification/policy';
import { Classifier } from '../src/classification/classifier';
import { fixtures } from '../scripts/fixtures';
import { transaction } from './helpers';

// Explicitly opt in: ordinary `npx vitest run` must never make paid API calls.
const liveTest = process.env.JEV_BENCH_LIVE === '1' ? it : it.skip;

type BenchmarkRow = {
  id: string;
  expected: string;
  predicted: string | null;
  finalCategory: string;
  suggestedCategory: string | null;
  status: string;
  reasonCode: string;
  confidence: number | null;
  choiceProbability: number | null;
  acceptanceScore: number | null;
  jevInvoked: boolean;
  processorOnly: boolean;
  reversal: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
};

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : Number((numerator / denominator).toFixed(4));

liveTest('live JEV accuracy and safe auto-tagging benchmark', async () => {
  const requested = Number(process.env.JEV_BENCH_LIMIT ?? '20');
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error('JEV_BENCH_LIMIT must be a positive integer');
  }

  // Spread the sample over the whole labelled corpus. The first 20 fixtures
  // are not representative because related narrations occur in groups.


  const targetIds = (process.env.JEV_BENCH_IDS ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const count = Math.min(requested, fixtures.length);

const selected = targetIds.length > 0
  ? fixtures.filter(f => targetIds.includes(f.id))
  : Array.from({ length: count }, (_, i) =>
      fixtures[Math.floor((i * fixtures.length) / count)],
    );

if (
  targetIds.length > 0 &&
  selected.length !== new Set(targetIds).size
) {
  throw new Error('One or more benchmark fixture IDs were not found');
}

  const config = new Config();
  const privacy = new Privacy(config);
  const registry = new Registry();
  const db = new Db();
  const transactions = new Transactions(db, privacy, registry);
  const jev = new JevClient(config, privacy);
  const policy = new Policy(config);

  if (!jev.available()) {
    throw new Error('JEV_API_KEY is unavailable in the benchmark process');
  }

  // WHAT-IF simulation only. The production calibration gate is unchanged.
  vi.spyOn(policy, 'semanticAutoEnabled').mockReturnValue(true);

  const classifier = new Classifier(
    db, transactions, registry, jev, policy,
  );

  // Capture the real provider response while passing it to the real classifier.
  // This causes ONE JEV call per evaluated transaction, not two.
  const originalClassify = jev.classify.bind(jev);
  const capture: { current: SemanticAnswer | null } = { current: null };
  const readCapturedAnswer = (): SemanticAnswer | null =>
    capture.current;
  vi.spyOn(jev, 'classify').mockImplementation(async (state, onInvoke) => {
    const response = await originalClassify(state, onInvoke);
    capture.current = response;
    return response;
  });

  const rows: BenchmarkRow[] = [];
  try {
    for (const fixture of selected) {
      capture.current = null;
      const matches = registry.match(fixture.description);
      const facts = narrationFacts(fixture.description, fixture.direction);
      const start = Date.now();
      const decision = await classifier.decide(
        transaction(fixture.description, { direction: fixture.direction }),
      );
      const answer = readCapturedAnswer();
      const acceptanceScore = answer
        ? Math.min(answer.confidence, answer.choiceProbability)
        : null;

      rows.push({
        id: fixture.id,
        expected: fixture.expectedCategory,
        predicted: answer?.category ?? null,
        finalCategory: decision.category,
        suggestedCategory: decision.suggestedCategory,
        status: decision.status,
        reasonCode: decision.reasonCode,
        confidence: answer?.confidence ?? null,
        choiceProbability: answer?.choiceProbability ?? null,
        acceptanceScore,
        jevInvoked: decision.jevInvoked,
        processorOnly: matches.processors.length > 0 && matches.merchants.length === 0,
        reversal: facts.reversal,
        durationMs: Date.now() - start,
        inputTokens: answer?.inputTokens ?? 0,
        outputTokens: answer?.outputTokens ?? 0,
      });
    }
  } finally {
    vi.restoreAllMocks();
    await db.$disconnect();
  }

  const answered = rows.filter(r => r.predicted !== null);
  const accepted = rows.filter(r => r.status === 'auto_classified');
  const correctlyAccepted = accepted.filter(r => r.finalCategory === r.expected);
  const badAutomatic = accepted.filter(r =>
    r.processorOnly || r.reversal || r.predicted !== r.finalCategory,
  );
  const bands = [
    { label: '<0.75', min: 0, max: 0.75 },
    { label: '0.75–0.89', min: 0.75, max: 0.9 },
    { label: '0.90–0.94', min: 0.9, max: 0.95 },
    { label: '0.95–1.00', min: 0.95, max: 1.001 },
  ].map(band => {
    const sample = answered.filter(r =>
      r.acceptanceScore !== null &&
      r.acceptanceScore >= band.min &&
      r.acceptanceScore < band.max,
    );
    return {
      band: band.label,
      count: sample.length,
      correct: sample.filter(r => r.predicted === r.expected).length,
      accuracy: ratio(
        sample.filter(r => r.predicted === r.expected).length,
        sample.length,
      ),
    };
  });

  const summary = {
    benchmarkType: 'live_jev_classifier_what_if_calibrated',
    note: 'Simulated semanticAutoEnabled=true ONLY in this test; production setting unchanged',
    evaluated: rows.length,
    availableFixtures: fixtures.length,
    providerAnswered: answered.length,
    providerErrorsOrEarlyBlocks: rows.length - answered.length,
    rawModelAccuracy: ratio(
      answered.filter(r => r.predicted === r.expected).length,
      answered.length,
    ),
    potentialAutoCoverage: ratio(accepted.length, rows.length),
    potentialAutoPrecision: ratio(correctlyAccepted.length, accepted.length),
    automaticAccepted: accepted.length,
    automaticCorrect: correctlyAccepted.length,
    requiresUserTagging: rows.filter(r => r.status === 'requires_user_tagging').length,
    unsafeOrNonJevAutoAccepted: badAutomatic.length,
    totalInputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
    totalOutputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
    confidenceBands: bands,
  };

  const reportDirectory = join(process.cwd(), 'reports');
  mkdirSync(reportDirectory, { recursive: true });
  const filename = `jev-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const reportPath = join(reportDirectory, filename);
  // Only synthetic fixture IDs and classification results are written.
  // Do not add raw customer narration, statements or provider credentials.
  writeFileSync(reportPath, JSON.stringify({ summary, rows }, null, 2));

  console.log('\nJEV BENCHMARK SUMMARY\n', JSON.stringify(summary, null, 2));
  console.log('\nREPORT:', reportPath);
  console.log('\nHIGH-CONFIDENCE ERRORS:');
  console.table(rows.filter(r =>
    r.acceptanceScore !== null && r.acceptanceScore >= 0.9 &&
    r.predicted !== r.expected,
  ).map(r => ({
    id: r.id,
    expected: r.expected,
    predicted: r.predicted,
    score: r.acceptanceScore,
    final: r.finalCategory,
    status: r.status,
  })));

  // Do not let a completely unavailable API produce a misleading 'passed' run.
  expect(answered.length).toBeGreaterThan(0);
  // Protect the single-category-authority and intermediary/reversal invariants.
  expect(badAutomatic).toHaveLength(0);
}, 1_200_000);
