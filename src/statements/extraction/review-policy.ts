
export type ExtractionDecision =
  | 'candidate_pass'
  | 'needs_review';

export type ReviewReason =
  | 'NO_TRANSACTIONS'
  | 'INSUFFICIENT_TRANSACTIONS'
  | 'UNREADABLE_PAGES'
  | 'INVALID_ROWS'
  | 'PARSER_ISSUES'
  | 'INCOMPLETE_COVERAGE'
  | 'MULTILINE_CONTINUATIONS'
  | 'RECONCILIATION_NOT_CONFIRMED'
  | 'MANUAL_CORRECTION_PENDING_REVALIDATION';


export interface ExtractionEvidence {
  totalPages: number;
  pagesWithText: number;

  transactionCount: number;
  invalidRowCount: number;
  parserIssueCount: number;
  continuationCount: number;

  coverageComplete: boolean;

  reconciled: boolean;
  checkedPairs: number;
}

export interface ExtractionReviewResult {
  decision: ExtractionDecision;
  reasons: ReviewReason[];
  automaticAcceptanceEligible: boolean;
}

export function evaluateExtractionEvidence(
  evidence: ExtractionEvidence,
): ExtractionReviewResult {
  const reasons: ReviewReason[] = [];

  if (evidence.transactionCount === 0) {
    reasons.push('NO_TRANSACTIONS');
  } else if (evidence.transactionCount === 1) {
    reasons.push('INSUFFICIENT_TRANSACTIONS');
  }

  if (
    evidence.totalPages < 1 ||
    evidence.pagesWithText < evidence.totalPages
  ) {
    reasons.push('UNREADABLE_PAGES');
  }

  if (evidence.invalidRowCount > 0) {
    reasons.push('INVALID_ROWS');
  }

  if (evidence.parserIssueCount > 0) {
    reasons.push('PARSER_ISSUES');
  }

  if (!evidence.coverageComplete) {
    reasons.push('INCOMPLETE_COVERAGE');
  }

  if (evidence.continuationCount > 0) {
    reasons.push('MULTILINE_CONTINUATIONS');
  }

  const expectedPairs =
    Math.max(0, evidence.transactionCount - 1);

  if (
    !evidence.reconciled ||
    evidence.checkedPairs !== expectedPairs
  ) {
    reasons.push('RECONCILIATION_NOT_CONFIRMED');
  }

  const automaticAcceptanceEligible =
    reasons.length === 0;

  return {
    decision: automaticAcceptanceEligible
      ? 'candidate_pass'
      : 'needs_review',

    reasons,
    automaticAcceptanceEligible,
  };
}
