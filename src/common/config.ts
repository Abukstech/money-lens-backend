import { Injectable } from '@nestjs/common';
import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z
          .string()
          .url()
          .refine((origin) => new URL(origin).origin === origin),
      ),
    ),
  JWT_SECRET: z.string().min(32),
  IDENTIFIER_HASH_KEY: z.string().min(32),
  EMAIL_DELIVERY_MODE: z.enum(['resend', 'console']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(20).default(20),
  OCR_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  OCR_DEADLINE_MS: z.coerce.number().int().min(100).max(120000).default(120000),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_ORGANIZATION_ID: z.string().optional(),
  OPENAI_PROJECT_ID: z.string().optional(),
  OPENAI_INSIGHTS_MODEL: z.string().default('gpt-5.4-mini-2026-03-17'),
  OPENAI_EVIDENCE_PATH: z.string().optional(),
  INSIGHTS_DEADLINE_MS: z.coerce.number().int().min(100).max(45000).default(45000),
  INSIGHTS_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(4),
  INSIGHTS_REQUESTS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_OCR_ENABLED: z.enum(['true', 'false']).optional(),
  PADDLE_OCR_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .url()
      .regex(/^https?:\/\//)
      .optional(),
  ),
  PADDLE_OCR_TOKEN: z.string().min(32).optional(),
  MISTRAL_OCR_FALLBACK_ENABLED: flag,
  MISTRAL_OCR_REQUESTS_PER_SECOND: z.coerce.number().min(0.001).finite().optional(),
  MISTRAL_OCR_PAGES_PER_MINUTE: z.coerce.number().int().min(1).max(100000).optional(),
  MISTRAL_ORGANIZATION_ID: z.string().optional(),
  JEV_ORGANIZATION_ID: z.string().optional(),
  MISTRAL_MODEL: z.string().default('mistral-ocr-latest'),
  ZDR_EVIDENCE_PATH: z.string().optional(),
  PROVIDER_EVIDENCE_PUBLIC_KEY_PATH: z.string().optional(),
  JEV_API_KEY: z.string().optional(),
  JEV_MODEL: z.string().default('jev-latest'),
  JEV_EVIDENCE_PATH: z.string().optional(),
  JEV_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(15000),
  JEV_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  AUTO_CLASSIFY_THRESHOLD: z.coerce.number().min(0.75).max(1).default(0.9),
  REQUIRE_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
  SEMANTIC_AUTO_ACCEPT: flag,
  CALIBRATION_EVIDENCE_PATH: z.string().optional(),
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
@Injectable()
export class Config {
  readonly values = schema
    .transform(({ MISTRAL_OCR_ENABLED, MISTRAL_OCR_FALLBACK_ENABLED, ...values }) => ({
      ...values,
      MISTRAL_OCR_ENABLED:
        MISTRAL_OCR_ENABLED === undefined
          ? MISTRAL_OCR_FALLBACK_ENABLED
          : MISTRAL_OCR_ENABLED === 'true',
    }))
    .parse(process.env);
  constructor() {
    if (this.values.EMAIL_DELIVERY_MODE === 'console' && this.values.NODE_ENV !== 'development')
      throw new Error('DEVELOPMENT_EMAIL_MODE_REQUIRED');
    if (this.values.AUTO_CLASSIFY_THRESHOLD < this.values.REQUIRE_REVIEW_THRESHOLD)
      throw new Error('INVALID_CONFIDENCE_THRESHOLDS');
  }
}
