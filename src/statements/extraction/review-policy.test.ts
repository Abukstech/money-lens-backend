
import { describe, expect, it } from 'vitest';

import {
  evaluateExtractionEvidence,
  type ExtractionEvidence,
} from './review-policy';

const validEvidence: ExtractionEvidence = {
  totalPages: 2,
  pagesWithText: 2,

  transactionCount: 30,
  invalidRowCount: 0,
  parserIssueCount: 0,
  continuationCount: 0,

  coverageComplete: true,

  reconciled: true,
  checkedPairs: 29,
};

describe('MoneyLens extraction review policy', () => {
  it('allows fully validated extraction candidates', () => {
    const result = evaluateExtractionEvidence(
      validEvidence,
    );

    expect(result.decision).toBe('candidate_pass');
    expect(result.reasons).toHaveLength(0);
    expect(result.automaticAcceptanceEligible).toBe(true);
  });

  it('flags missing transaction coverage', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      coverageComplete: false,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain(
      'INCOMPLETE_COVERAGE',
    );
  });

  it('flags unresolved parser issues', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      parserIssueCount: 1,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain('PARSER_ISSUES');
  });

  it('flags multiline reconstruction', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      continuationCount: 2,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain(
      'MULTILINE_CONTINUATIONS',
    );
  });

  it('rejects unverified balance reconciliation', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      reconciled: false,
      checkedPairs: 0,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain(
      'RECONCILIATION_NOT_CONFIRMED',
    );
  });

  it('flags pages without extractable text', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      pagesWithText: 1,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain('UNREADABLE_PAGES');
  });

  it('does not automatically accept one transaction', () => {
    const result = evaluateExtractionEvidence({
      ...validEvidence,
      transactionCount: 1,
      checkedPairs: 0,
      reconciled: false,
    });

    expect(result.decision).toBe('needs_review');
    expect(result.reasons).toContain(
      'INSUFFICIENT_TRANSACTIONS',
    );
  });
});
