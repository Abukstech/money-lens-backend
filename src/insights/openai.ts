import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Config } from '../common/config';
import { Privacy } from '../common/privacy';
import { Capacity } from '../common/concurrency';
import { ProviderError, providerRequest } from '../common/provider-http';
import { ChatMessage, MonthlyFacts, Scenario } from './contracts';
import { INSIGHTS_INSTRUCTIONS, REPORT_JSON_SCHEMA, SCENARIO_TOOL } from './prompt';
import { simulateCategoryCut } from './scenarios';

const functionCall = z
  .object({
    type: z.literal('function_call'),
    id: z.string().optional(),
    call_id: z.string().min(1),
    name: z.string(),
    arguments: z.string().max(2000),
  })
  .passthrough();
const message = z
  .object({
    type: z.literal('message'),
    content: z.array(
      z.union([
        z.object({ type: z.literal('output_text'), text: z.string().max(32000) }).passthrough(),
        z.object({ type: z.literal('refusal'), refusal: z.string() }).passthrough(),
      ]),
    ),
  })
  .passthrough();
const reasoning = z
  .object({
    type: z.literal('reasoning'),
    id: z.string(),
    summary: z.array(z.unknown()),
    encrypted_content: z.string().optional(),
  })
  .passthrough();
const responseSchema = z.object({
  status: z.string(),
  model: z.string().min(1),
  output: z.array(z.union([functionCall, message, reasoning])).max(20),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
});
export class InsightRefusal extends Error {
  constructor() {
    super('INSIGHT_REFUSED');
  }
}
@Injectable()
export class OpenAIInsights {
  private readonly capacity: Capacity;
  constructor(
    @Inject(Config) private readonly config: Config,
    @Inject(Privacy) private readonly privacy: Privacy,
  ) {
    this.capacity = new Capacity(config.values.INSIGHTS_CONCURRENCY);
  }
  async generate(
    facts: MonthlyFacts,
    question: string,
    history: ChatMessage[],
    parentSignal: AbortSignal,
  ) {
    if (!this.config.values.OPENAI_API_KEY) throw new ProviderError('OPENAI_NOT_CONFIGURED');
    this.privacy.verifyProvider('openai');
    const release = this.capacity.acquire();
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(this.config.values.INSIGHTS_DEADLINE_MS),
    ]);
    const scenarios: Scenario[] = [];
    let inputTokens = 0,
      outputTokens = 0,
      model: string | null = null;
    const publicFacts = {
      month: facts.month,
      currency: facts.currency,
      asOf: facts.asOf,
      calculationVersion: facts.calculationVersion,
      incomeSource: facts.incomeSource,
      goalStatus: facts.goalStatus,
      coverage: facts.coverage,
      metrics: facts.metrics,
      limitations: facts.limitations,
      questions: facts.questions,
    };
    const input: unknown[] = [
      { role: 'developer', content: INSIGHTS_INSTRUCTIONS },
      { role: 'developer', content: JSON.stringify({ authoritativeFacts: publicFacts }) },
      ...history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: question },
    ];
    try {
      for (let round = 0; round < 3; round++) {
        signal.throwIfAborted();
        const headers: Record<string, string> = {};
        if (this.config.values.OPENAI_ORGANIZATION_ID)
          headers['OpenAI-Organization'] = this.config.values.OPENAI_ORGANIZATION_ID;
        if (this.config.values.OPENAI_PROJECT_ID)
          headers['OpenAI-Project'] = this.config.values.OPENAI_PROJECT_ID;
        const response = responseSchema.parse(
          await providerRequest(
            'https://api.openai.com/v1/responses',
            this.config.values.OPENAI_API_KEY,
            {
              model: this.config.values.OPENAI_INSIGHTS_MODEL,
              store: false,
              background: false,
              reasoning: { effort: 'none' },
              include: ['reasoning.encrypted_content'],
              max_output_tokens: 4096,
              input,
              tools: [SCENARIO_TOOL],
              tool_choice: round === 2 ? 'none' : 'auto',
              parallel_tool_calls: false,
              text: {
                format: {
                  type: 'json_schema',
                  name: 'moneylens_insight',
                  strict: true,
                  schema: REPORT_JSON_SCHEMA,
                },
              },
            },
            { signal, attempts: 2, maxBytes: 256 * 1024, headers },
          ),
        );
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
        model = response.model;
        if (
          response.output.some(
            (item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'),
          )
        )
          throw new InsightRefusal();
        if (response.status !== 'completed') throw new ProviderError('INCOMPLETE_INSIGHT');
        const calls = response.output.filter((item) => item.type === 'function_call');
        if (calls.length) {
          if (round === 2 || calls.length > 2) throw new ProviderError('INVALID_INSIGHT_TOOL_CALL');
          input.push(...response.output);
          for (const call of calls) {
            if (call.name !== 'simulate_category_cut' || scenarios.length >= 3)
              throw new ProviderError('INVALID_INSIGHT_TOOL_CALL');
            let output: unknown;
            try {
              const scenario = simulateCategoryCut(
                facts,
                JSON.parse(call.arguments),
                `cut_${scenarios.length + 1}`,
              );
              scenarios.push(scenario);
              output = scenario;
            } catch {
              output = {
                error: 'INVALID_SCENARIO',
                instructions:
                  'Use an expense category and exactly one valid reduction no larger than its known net spending.',
              };
            }
            input.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(output),
            });
          }
          continue;
        }
        const texts = response.output.flatMap((item) =>
          item.type === 'message'
            ? item.content.flatMap((c) => (c.type === 'output_text' ? [c.text] : []))
            : [],
        );
        if (texts.length !== 1) throw new ProviderError('INVALID_INSIGHT_OUTPUT');
        let draft: unknown;
        try {
          draft = JSON.parse(texts[0]);
        } catch {
          throw new ProviderError('INVALID_INSIGHT_OUTPUT');
        }
        return { draft, scenarios, model, inputTokens, outputTokens };
      }
      throw new ProviderError('INSIGHT_TOOL_LIMIT');
    } finally {
      release();
    }
  }
}
