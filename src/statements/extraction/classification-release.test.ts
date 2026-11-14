
import { describe, expect, it } from 'vitest';

import {
  evaluateExtractionEvidence,
  type ExtractionEvidence,
} from './review-policy';

import {
  evaluateClassificationRelease,
  type ManualExtractionApproval,
} from './classification-release';

const evidence: ExtractionEvidence = {
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

const approval: ManualExtractionApproval = {
  reviewerId: 'reviewer-123',
  approvedRevision: 'revision-1',
  sourceDocumentChecked: true,
  allTransactionsConfirmed: true,
  confirmedTransactionCount: 30,
};

describe('MoneyLens classification release gate', () => {
  it('allows a validated extraction candidate', () => {
    const review = evaluateExtractionEvidence(evidence);

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('automatic_candidate');
  });

  it('blocks unreviewed statements without balances', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      reconciled: false,
      checkedPairs: 0,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-1',
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'MANUAL_REVIEW_REQUIRED',
    );
  });

  it('allows manually verified statements without balances', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      reconciled: false,
      checkedPairs: 0,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-1',
      approval,
    });

    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('manual_verified');
  });

  it('rejects approval for an outdated draft revision', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      continuationCount: 1,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-2',
      approval,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'STALE_REVIEW_APPROVAL',
    );
  });

  it('does not permit approval to bypass missing transactions', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      coverageComplete: false,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-1',
      approval,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'INCOMPLETE_COVERAGE',
    );
  });

  it('does not permit approval to bypass parser errors', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      parserIssueCount: 1,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 30,
      draftRevision: 'revision-1',
      approval,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'PARSER_ISSUES',
    );
  });

  it('rejects a mismatched transaction count', () => {
    const review = evaluateExtractionEvidence({
      ...evidence,
      reconciled: false,
      checkedPairs: 0,
    });

    const result = evaluateClassificationRelease({
      review,
      transactionCount: 29,
      draftRevision: 'revision-1',
      approval,
    });

    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'TRANSACTION_COUNT_MISMATCH',
    );
  });
});
