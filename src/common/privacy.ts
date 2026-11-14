import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Config } from './config';

export function sanitizeNarration(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
    .replace(/(?:\+?\d[\s.-]*){10,}/g, '[REDACTED]')
    .replace(/\b(?:ACCOUNT\s*NAME|ACCOUNT\s*HOLDER|ADDRESS)\s*[:=].*$/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
export function normalizeNarration(value: string): string {
  return sanitizeNarration(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
@Injectable()
export class Privacy {
  constructor(@Inject(Config) private readonly config: Config) {}
  hash(userId: string, kind: string, value: string | Buffer): string {
    return createHmac('sha256', this.config.values.IDENTIFIER_HASH_KEY)
      .update(`${userId}\0${kind}\0`)
      .update(value)
      .digest('hex');
  }
  verifyProvider(provider: 'mistral' | 'jev' | 'openai'): void {
    if (this.config.values.NODE_ENV !== 'production') return;
    const path =
      provider === 'openai'
        ? this.config.values.OPENAI_EVIDENCE_PATH
        : provider === 'mistral'
          ? this.config.values.ZDR_EVIDENCE_PATH
          : this.config.values.JEV_EVIDENCE_PATH;
    try {
      const envelope = z
        .object({ payload: z.string(), signature: z.string() })
        .strict()
        .parse(JSON.parse(readFileSync(path!, 'utf8')));
      const key = readFileSync(this.config.values.PROVIDER_EVIDENCE_PUBLIC_KEY_PATH!, 'utf8');
      if (
        !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))
      )
        throw new Error();
      const evidence = z
        .object({
          provider: z.enum(['mistral', 'jev', 'openai']),
          projectId: z.string().min(1).optional(),
          organizationId: z.string().min(1),
          apiKeySha256: z.string().regex(/^[a-f0-9]{64}$/),
          approvedBy: z.string().min(1),
          confirmationReference: z.string().min(1),
          expiresAt: z.string().datetime(),
          model: z.string(),
          endpoint: z.string(),
          zeroRetentionConfirmed: z.boolean(),
          processingTermsReviewed: z.literal(true),
        })
        .strict()
        .parse(JSON.parse(envelope.payload));
      const model =
        provider === 'openai'
          ? this.config.values.OPENAI_INSIGHTS_MODEL
          : provider === 'mistral'
            ? this.config.values.MISTRAL_MODEL
            : this.config.values.JEV_MODEL;
      const organization =
        provider === 'openai'
          ? this.config.values.OPENAI_ORGANIZATION_ID
          : provider === 'mistral'
            ? this.config.values.MISTRAL_ORGANIZATION_ID
            : this.config.values.JEV_ORGANIZATION_ID;
      const apiKey =
        provider === 'openai'
          ? this.config.values.OPENAI_API_KEY
          : provider === 'mistral'
            ? this.config.values.MISTRAL_API_KEY
            : this.config.values.JEV_API_KEY;
      if (
        !organization ||
        !apiKey ||
        evidence.organizationId !== organization ||
        evidence.apiKeySha256 !== hashToken(apiKey) ||
        evidence.provider !== provider ||
        evidence.model !== model ||
        Date.parse(evidence.expiresAt) <= Date.now() ||
        evidence.endpoint !==
          (provider === 'openai'
            ? '/v1/responses'
            : provider === 'mistral'
              ? '/v1/ocr'
              : '/v1/systemone') ||
        (['mistral', 'openai'].includes(provider) && !evidence.zeroRetentionConfirmed) ||
        (provider === 'openai' &&
          (!this.config.values.OPENAI_PROJECT_ID ||
            evidence.projectId !== this.config.values.OPENAI_PROJECT_ID))
      )
        throw new Error();
    } catch {
      throw new ServiceUnavailableException('PROVIDER_PRIVACY_EVIDENCE_REQUIRED');
    }
  }
}
