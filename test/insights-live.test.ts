import { expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { Config } from '../src/common/config';
import { Privacy } from '../src/common/privacy';
import { calculateFacts, FactRow } from '../src/insights/facts';
import { OpenAIInsights } from '../src/insights/openai';
import { renderReport } from '../src/insights/render';

const live = process.env.RUN_OPENAI_INSIGHTS_SMOKE === 'true' ? it : it.skip;
live(
  'opt-in OpenAI smoke test uses authored synthetic aggregates only',
  async () => {
    if (!process.env.LIVE_OPENAI_API_KEY) throw new Error('LIVE_OPENAI_API_KEY_REQUIRED');
    const config = new Config();
    config.values.OPENAI_API_KEY = process.env.LIVE_OPENAI_API_KEY;
    const row = (category: string, amount: string, id: string): FactRow => ({
      id,
      date: new Date('2026-09-02'),
      amount: new Prisma.Decimal(amount),
      direction: 'debit',
      category,
      status: 'user_confirmed',
      validationIssues: [],
      linkedTransactionId: null,
      revision: 1,
    });
    const facts = calculateFacts(
      '2026-09',
      [row('housing', '380000', 'synthetic-rent'), row('dining', '100000', 'synthetic-dining')],
      { takeHomeIncome: '500000', savingsTarget: '50000', spendingCoverageConfirmed: true },
      [],
      [],
      0,
      0,
      new Date('2026-10-25'),
    );
    const result = await new OpenAIInsights(config, new Privacy(config)).generate(
      facts,
      'Explain the goal tradeoff. What if flexible dining expenses fell by thirty percent?',
      [],
      AbortSignal.timeout(45000),
    );
    const report = renderReport(result.draft, facts, result.scenarios);
    expect(report.narrative.length).toBeGreaterThan(0);
    expect(result.scenarios.some((s) => s.category === 'dining')).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
    // Do not print provider bodies, prompts, or reports even in this synthetic smoke test.
  },
  50000,
);
