import { z } from 'zod';
import { money } from '../transactions/contracts';
import { categorySchema } from '../classification/ontology';

export const monthSchema = z.string().regex(/^(?:19\d{2}|[2-9]\d{3})-(?:0[1-9]|1[0-2])$/);
export const contextInput = z
  .object({
    takeHomeIncome: money.nullable(),
    savingsTarget: money.nullable(),
    spendingCoverageConfirmed: z.boolean(),
    currency: z.literal('NGN').default('NGN'),
  })
  .strict();
export const analysisInput = z.object({ month: monthSchema }).strict();
export const messageInput = z.object({ message: z.string().trim().min(1).max(2000) }).strict();
export const scenarioInput = z
  .object({
    category: categorySchema,
    reductionPercent: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .nullable(),
    reductionAmount: money.nullable(),
  })
  .strict()
  .refine((v) => (v.reductionPercent === null) !== (v.reductionAmount === null));
export type ScenarioInput = z.infer<typeof scenarioInput>;
export interface Metric {
  value: string;
  kind: 'money' | 'percent' | 'count';
  label: string;
}
export interface MonthlyFacts {
  month: string;
  currency: 'NGN';
  asOf: string;
  calculationVersion: string;
  dataVersion: string;
  incomeSource: 'user_reported' | 'observed_classified' | 'unknown';
  goalStatus: 'met' | 'not_met_in_records' | 'not_provided';
  coverage: {
    records: number;
    classifiedRecords: number;
    classificationCoverage: number;
    spendingCoverageConfirmed: boolean;
    partialMonth: boolean;
    futureMonth: boolean;
    complete: boolean;
  };
  metrics: Record<string, Metric>;
  limitations: string[];
  questions: string[];
}
const statement = z.string().min(1).max(1500);
const evidence = z.array(z.string().min(1).max(100)).min(1).max(12);
export const draftSchema = z
  .object({
    narrative: statement,
    findings: z
      .array(
        z
          .object({
            observation: statement,
            evidenceIds: evidence,
            consequence: statement,
            suggestedAction: statement,
            assumptions: z.array(statement).max(6),
            missingContext: z.array(statement).max(6),
          })
          .strict(),
      )
      .max(6),
    actions: z
      .array(
        z
          .object({
            text: statement,
            evidenceIds: evidence,
            scenarioId: z.string().max(80).nullable(),
          })
          .strict(),
      )
      .max(6),
    limitations: z.array(statement).max(8),
    questions: z.array(statement).max(6),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;
export interface Scenario {
  id: string;
  category: string;
  metrics: Record<string, Metric>;
  assumptions: string[];
}
export interface Report {
  status: 'ready' | 'limited' | 'facts_only' | 'refused' | 'unavailable' | 'invalid_output';
  facts: MonthlyFacts;
  narrative: string | null;
  findings: Draft['findings'];
  actions: Draft['actions'];
  scenarios: Scenario[];
  limitations: string[];
  questions: string[];
  metadata: {
    model: string | null;
    promptVersion: string;
    calculationVersion: string;
    inputTokens: number;
    outputTokens: number;
    reasonCode: string | null;
  };
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export const PROMPT_VERSION = '1.0.0';
export const CALCULATION_VERSION = '1.0.0';
