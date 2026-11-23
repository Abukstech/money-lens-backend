import { Inject, Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { Config } from '../common/config';
import { Category, ONTOLOGY_VERSION, POLICY_VERSION } from './ontology';
export { narrationFacts } from './evidence';
import { narrationFacts } from './evidence';
export interface Decision {
  category: Category;
  suggestedCategory: Category | null;
  status: string;
  source: string;
  confidence: number | null;
  merchantId: string | null;
  linkedTransactionId: string | null;
  channel: string | null;
  economicType: string;
  jevInvoked: boolean;
  modelVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  reasonCode: string;
  evidence?: {
    patternIds?: string[];
    patternVersion?: string;
    ruleId?: string;
    ruleVersion?: number;
    semanticAcceptanceConfidence?: number;
  } | null;
}
@Injectable()
export class Policy {
  constructor(@Inject(Config) private readonly config: Config) {}
  semanticAutoEnabled(model?: string, datasetChecksum?: string, category?: Category) {
    if (!this.config.values.SEMANTIC_AUTO_ACCEPT) return false;
    try {
      const evidence = JSON.parse(
        readFileSync(this.config.values.CALIBRATION_EVIDENCE_PATH!, 'utf8'),
      ) as Record<string, unknown>;
      const slices = evidence.categories as
        Record<string, { precision?: number; sampleSize?: number }> | undefined;
      const slice = category ? slices?.[category] : undefined;
      return (
        !!slice &&
        typeof slice.precision === 'number' &&
        slice.precision >= 0.98 &&
        slice.precision <= 1 &&
        typeof slice.sampleSize === 'number' &&
        Number.isInteger(slice.sampleSize) &&
        slice.sampleSize >= 100 &&
        evidence.autoClassifyThreshold === this.config.values.AUTO_CLASSIFY_THRESHOLD &&
        evidence.policyVersion === POLICY_VERSION &&
        evidence.ontologyVersion === ONTOLOGY_VERSION &&
        !!datasetChecksum &&
        evidence.datasetChecksum === datasetChecksum &&
        !!model &&
        evidence.returnedModel === model &&
        evidence.model === this.config.values.JEV_MODEL &&
        evidence.humanReviewed === true &&
        typeof evidence.reportSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(evidence.reportSha256) &&
        typeof evidence.expiresAt === 'string' &&
        Date.parse(evidence.expiresAt) > Date.now()
      );
    } catch {
      return false;
    }
  }
  base(description: string, direction: string): Decision {
    const f = narrationFacts(description, direction);
    return {
      category: f.transfer ? 'transfer_unknown' : 'unknown',
      suggestedCategory: null,
      status: 'requires_user_tagging',
      source: 'unknown_fallback',
      confidence: null,
      merchantId: null,
      linkedTransactionId: null,
      channel: f.channel,
      economicType: 'unresolved',
      jevInvoked: false,
      modelVersion: null,
      inputTokens: 0,
      outputTokens: 0,
      reasonCode: 'INSUFFICIENT_EVIDENCE',
    };
  }

  applySuggestion(
    d: Decision,
    category: Category,
    confidence: number,
    allowAuto: boolean,
  ): Decision {
    // Unknown categories must not be automatically accepted.
    if (category === 'unknown' || category === 'transfer_unknown') {
      return {
        ...d,
        category,
        reasonCode: 'INSUFFICIENT_EVIDENCE',
      };
    }

    // Confidence is too low to provide a reliable suggestion.
    if (confidence < this.config.values.REQUIRE_REVIEW_THRESHOLD) {
      return {
        ...d,
        reasonCode: 'LOW_CONFIDENCE',
      };
    }

    // Accept automatically only when both conditions are met.
    const autoAccepted = allowAuto && confidence >= this.config.values.AUTO_CLASSIFY_THRESHOLD;

    return {
      ...d,
      category: autoAccepted ? category : d.category,
      suggestedCategory: category,
      status: autoAccepted ? 'auto_classified' : 'requires_user_tagging',
      confidence,

      reasonCode: autoAccepted ? 'EVIDENCE_ACCEPTED' : 'CONFIRMATION_REQUIRED',
    };
  }
}
