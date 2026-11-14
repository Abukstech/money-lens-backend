
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import seed from './data/nigeria-merchants.json';
import { normalizeNarration } from '../common/privacy';
import {
  mapHint,
  categorySchema,
} from '../classification/ontology';

const typicalPurchaseSchema = z.object({
  category: categorySchema,
  examples: z.array(z.string().min(1)).min(1).max(20),
  evidence: z.enum([
    'official_catalog',
    'business_type_inference',
  ]),
  source_urls: z.array(z.string().url()),
}).strict();

const vendorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  entity_type: z.string(),
  category_hint: z.string(),
  aliases: z.array(z.string().min(1)).min(1),
  match_strategy: z.literal('token_boundary'),
  evidence_status: z.enum([
    'official_verified',
    'candidate',
  ]),
  source_urls: z.array(z.string().url()),
  is_intermediary: z.boolean(),
  requires_context: z.boolean(),
  geographic_scope: z.string(),
  notes: z.string(),

  // New: possible goods and services.
  typical_purchases: z
    .array(typicalPurchaseSchema)
    .default([]),

  // New: researched branch or service locations.
  known_locations: z
    .array(z.string().min(1))
    .default([]),
}).strict();

const seedSchema = z.object({
  schema_version: z.literal('1.0.0'),
  vendors: z.array(vendorSchema),
  categories: z.array(z.string()),
  narration_patterns: z.array(
    z.object({
      id: z.string(),
      regex: z.string(),
      channel: z.string().nullable(),
      category: z.string().nullable(),
      reason: z.string(),
    }).strict(),
  ),
}).passthrough();

export type Vendor = z.infer<typeof vendorSchema>;

@Injectable()
export class Registry {
  readonly checksum = createHash('sha256')
    .update(JSON.stringify(seed))
    .digest('hex');

  readonly vendors: Vendor[];

  readonly provenance = {
    version: seed.schema_version,
    createdAt: seed.created_at,
    disclaimer: seed.disclaimer,
  };

  constructor() {
    const parsed = seedSchema.parse(seed);

    if (
      new Set(parsed.vendors.map(v => v.id)).size !==
      parsed.vendors.length
    ) {
      throw new Error('DUPLICATE_MERCHANT_ID');
    }

    const aliases = new Map<string, string>();

    for (const vendor of parsed.vendors) {
      for (const alias of vendor.aliases) {
        const normalized = normalizeNarration(alias);

        if (
          !normalized ||
          (
            aliases.has(normalized) &&
            aliases.get(normalized) !== vendor.id
          )
        ) {
          throw new Error('MERCHANT_ALIAS_COLLISION');
        }

        aliases.set(normalized, vendor.id);
      }
    }

    this.vendors = parsed.vendors;
  }

  match(description: string) {
    const text = ` ${normalizeNarration(description)} `;

    const matches = this.vendors.filter(vendor =>
      vendor.aliases.some(alias =>
        text.includes(
          ` ${normalizeNarration(alias)} `,
        ),
      ),
    );

    const processors = matches.filter(vendor =>
      vendor.is_intermediary ||
      [
        'bank',
        'payment_processor',
        'financial_platform',
      ].includes(vendor.entity_type),
    );

    const merchants = matches.filter(
      vendor => !processors.includes(vendor),
    );

    return {
      merchants,
      processors,
      ambiguous: merchants.length > 1,
      hint:
        merchants.length === 1
          ? mapHint(merchants[0].category_hint)
          : null,
    };
  }

  get(id: string | null) {
    return this.vendors.find(vendor => vendor.id === id);
  }
}
