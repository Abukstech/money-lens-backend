import { Inject, Injectable, HttpException } from '@nestjs/common';
import { Db } from '../common/db';
import { Config } from '../common/config';
import { ProviderError } from '../common/provider-http';
import { FinancialFacts } from './facts';
import { OpenAIInsights, InsightRefusal } from './openai';
import { InsightsSessions } from './sessions';
import { InvalidInsight, renderReport, sanitizeQuestion } from './render';
import { ChatMessage, MonthlyFacts, PROMPT_VERSION, Report } from './contracts';
import { ZodError } from 'zod';

@Injectable()
export class Insights {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Config) private readonly config: Config,
    @Inject(FinancialFacts) private readonly facts: FinancialFacts,
    @Inject(OpenAIInsights) private readonly openai: OpenAIInsights,
    @Inject(InsightsSessions) private readonly sessions: InsightsSessions,
  ) {}
  private async rateLimit(userId: string) {
    const key = `insights:${userId}`;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
      const bucket = await tx.authRateBucket.findUnique({ where: { key } });
      const now = new Date();
      const inWindow = !!bucket && now.valueOf() - bucket.windowStartedAt.valueOf() < 3600000;
      if (inWindow && bucket.count >= this.config.values.INSIGHTS_REQUESTS_PER_HOUR)
        throw new HttpException('INSIGHTS_RATE_LIMITED', 429);
      await tx.authRateBucket.upsert({
        where: { key },
        create: { key, count: 1, windowStartedAt: now, lastRequestedAt: now },
        update: {
          count: inWindow ? bucket.count + 1 : 1,
          windowStartedAt: inWindow ? bucket.windowStartedAt : now,
          lastRequestedAt: now,
        },
      });
    });
  }
  private empty(
    facts: MonthlyFacts,
    status: Report['status'],
    reasonCode: string | null = null,
  ): Report {
    return {
      status,
      facts,
      narrative: null,
      findings: [],
      actions: [],
      scenarios: [],
      limitations: facts.limitations,
      questions: facts.questions,
      metadata: {
        model: null,
        promptVersion: PROMPT_VERSION,
        calculationVersion: facts.calculationVersion,
        inputTokens: 0,
        outputTokens: 0,
        reasonCode,
      },
    };
  }
  private async generate(
    facts: MonthlyFacts,
    question: string,
    history: ChatMessage[],
    signal: AbortSignal,
  ): Promise<Report> {
    signal.throwIfAborted();
    if (!facts.coverage.records || facts.coverage.futureMonth)
      return this.empty(facts, 'facts_only');
    try {
      const result = await this.openai.generate(facts, question, history, signal);
      signal.throwIfAborted();
      const rendered = renderReport(result.draft, facts, result.scenarios);
      return {
        status: facts.coverage.complete ? 'ready' : 'limited',
        facts,
        ...rendered,
        scenarios: result.scenarios,
        limitations: [...new Set([...facts.limitations, ...rendered.limitations])],
        questions: [...new Set([...facts.questions, ...rendered.questions])],
        metadata: {
          model: result.model,
          promptVersion: PROMPT_VERSION,
          calculationVersion: facts.calculationVersion,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          reasonCode: null,
        },
      };
    } catch (error) {
      if (signal.aborted) throw new HttpException('INSIGHTS_REQUEST_CANCELLED', 408);
      const invalid =
        error instanceof InvalidInsight ||
        error instanceof ZodError ||
        (error instanceof ProviderError &&
          [
            'INVALID_INSIGHT_OUTPUT',
            'INCOMPLETE_INSIGHT',
            'INVALID_INSIGHT_TOOL_CALL',
            'INSIGHT_TOOL_LIMIT',
          ].includes(error.code));
      const status =
        error instanceof InsightRefusal ? 'refused' : invalid ? 'invalid_output' : 'unavailable';
      const safeReason =
        error instanceof ProviderError
          ? error.code
          : error instanceof InsightRefusal
            ? 'INSIGHT_REFUSED'
            : invalid
              ? 'INVALID_INSIGHT_OUTPUT'
              : error instanceof HttpException &&
                  ['PROVIDER_PRIVACY_EVIDENCE_REQUIRED', 'PROCESSING_CAPACITY_EXCEEDED'].includes(
                    error.message,
                  )
                ? error.message
                : 'INSIGHTS_UNAVAILABLE';
      return this.empty(facts, status, safeReason);
    }
  }
  async analyze(userId: string, month: string) {
    const operation = this.sessions.operation(userId);
    const signal = AbortSignal.any([
      operation.signal,
      AbortSignal.timeout(this.config.values.INSIGHTS_DEADLINE_MS),
    ]);
    try {
      await this.rateLimit(userId);
      const facts = await this.facts.build(userId, month);
      signal.throwIfAborted();
      const report = await this.generate(
        facts,
        'Explain the most important evidence-backed spending tradeoffs for this month and practical next steps. Recognize recorded savings progress and ask for missing context.',
        [],
        signal,
      );
      signal.throwIfAborted();
      return report;
    } catch (error) {
      if (signal.aborted) throw new HttpException('INSIGHTS_REQUEST_CANCELLED', 408);
      throw error;
    } finally {
      operation.release();
    }
  }
  createConversation(userId: string, month: string) {
    return this.sessions.create(userId, month);
  }
  deleteConversation(userId: string, id: string) {
    return this.sessions.delete(userId, id);
  }
  async message(userId: string, id: string, message: string) {
    const lease = this.sessions.acquire(userId, id);
    const operation = this.sessions.operation(userId);
    const signal = AbortSignal.any([
      operation.signal,
      AbortSignal.timeout(this.config.values.INSIGHTS_DEADLINE_MS),
    ]);
    try {
      await this.rateLimit(userId);
      const facts = await this.facts.build(userId, lease.session.month);
      signal.throwIfAborted();
      const question = sanitizeQuestion(message);
      const contextRefreshed =
        lease.session.dataVersion !== null && lease.session.dataVersion !== facts.dataVersion;
      if (contextRefreshed) lease.session.history = [];
      const report = await this.generate(facts, question, lease.session.history, signal);
      signal.throwIfAborted();
      this.sessions.current(userId, id);
      const conversation = report.narrative
        ? this.sessions.append(userId, id, question, report.narrative, facts.dataVersion)
        : this.sessions.present(lease.session);
      return { ...conversation, contextRefreshed, report };
    } catch (error) {
      if (signal.aborted) throw new HttpException('INSIGHTS_REQUEST_CANCELLED', 408);
      throw error;
    } finally {
      operation.release();
      lease.release();
    }
  }
}
