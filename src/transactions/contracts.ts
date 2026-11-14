import { z } from 'zod';
import Decimal from 'decimal.js';
import { confirmedCategory } from '../classification/ontology';

export const money = z
  .union([
    z.string(),
    z
      .number()
      .finite()
      .refine(
        (n) =>
          new Decimal(String(n)).times(100).isInteger() &&
          new Decimal(String(n)).times(100).lte(Number.MAX_SAFE_INTEGER),
      ),
  ])
  .transform(String)
  .refine((s) => /^\d{1,18}(\.\d{1,2})?$/.test(s))
  .transform((s) => new Decimal(s).toFixed(2));
export const signedMoney = z
  .string()
  .regex(/^-?\d{1,18}(\.\d{1,2})?$/)
  .transform((s) => new Decimal(s).toFixed(2));
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
  });
export const stableIdentifier = z.string().regex(/^\d{3,6}:\d{10}$/);
export const transactionInput = z
  .object({
    id: z.string().min(1).max(100),
    date,
    description: z.string().max(2000).default(''),
    amount: money.refine((s) => new Decimal(s).gt(0)),
    direction: z.enum(['debit', 'credit']),
    currency: z.literal('NGN').default('NGN'),
    balance: signedMoney.optional(),
    reference: z.string().max(200).optional(),
    recipientIdentifier: stableIdentifier.optional(),
  })
  .strict();
export const correctionInput = transactionInput
  .omit({ id: true })
  .extend({ revision: z.number().int().min(0) })
  .strict();
export const ruleConditions = z
  .object({
    direction: z.enum(['debit', 'credit']),
    currency: z.literal('NGN'),
    minAmount: money,
    maxAmount: money,
    narrationTokens: z
      .array(z.string().regex(/^[A-Za-z]{3,30}$/))
      .min(1)
      .max(10),
  })
  .strict()
  .refine((v) => new Decimal(v.minAmount).lte(v.maxAmount));
export const feedbackInput = z
  .object({
    revision: z.number().int().min(0),
    category: confirmedCategory,
    rememberForFuture: z.boolean().default(false),
    conditions: ruleConditions.optional(),
  })
  .strict()
  .refine((v) => !v.rememberForFuture || !!v.conditions);
export const ruleUpdate = z
  .object({
    version: z.number().int().min(1),
    category: confirmedCategory,
    conditions: ruleConditions,
  })
  .strict();
export type TransactionInput = z.infer<typeof transactionInput>;
