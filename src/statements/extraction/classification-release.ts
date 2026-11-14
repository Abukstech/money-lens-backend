
import type {
    ExtractionReviewResult,
    ReviewReason,
  } from './review-policy';
  
  export interface ManualExtractionApproval {
    reviewerId: string;
    approvedRevision: string;
    sourceDocumentChecked: boolean;
    allTransactionsConfirmed: boolean;
    confirmedTransactionCount: number;
  }
  
  export interface ClassificationReleaseInput {
    review: ExtractionReviewResult;
    transactionCount: number;
    draftRevision: string;
    approval?: ManualExtractionApproval | null;
  }
  
  export type ReleaseMode =
    | 'automatic_candidate'
    | 'manual_verified'
    | null;
  
  export interface ClassificationReleaseResult {
    allowed: boolean;
    mode: ReleaseMode;
    blockers: string[];
  }
  
  const HARD_BLOCKERS = new Set<ReviewReason>([
    'NO_TRANSACTIONS',
    'UNREADABLE_PAGES',
    'INVALID_ROWS',
    'PARSER_ISSUES',
    'INCOMPLETE_COVERAGE',
    'MANUAL_CORRECTION_PENDING_REVALIDATION',
  ]);
  
  export function evaluateClassificationRelease(
    input: ClassificationReleaseInput,
  ): ClassificationReleaseResult {
    const {
      review,
      transactionCount,
      draftRevision,
      approval,
    } = input;
  
    const blockers: string[] = [];
  
    if (
      !Number.isSafeInteger(transactionCount) ||
      transactionCount < 1
    ) {
      blockers.push('INVALID_TRANSACTION_COUNT');
    }
  
    if (!draftRevision.trim()) {
      blockers.push('INVALID_DRAFT_REVISION');
    }
  
    // These issues require correction and revalidation.
    // Manual approval alone must not bypass them.
    for (const reason of review.reasons) {
      if (HARD_BLOCKERS.has(reason)) {
        blockers.push(reason);
      }
    }
  
    if (blockers.length > 0) {
      return {
        allowed: false,
        mode: null,
        blockers,
      };
    }
  
    // A complete automated extraction may proceed
    // to classification staging.
    if (review.decision === 'candidate_pass') {
      if (
        !review.automaticAcceptanceEligible ||
        review.reasons.length > 0
      ) {
        return {
          allowed: false,
          mode: null,
          blockers: ['INCONSISTENT_REVIEW_DECISION'],
        };
      }
  
      return {
        allowed: true,
        mode: 'automatic_candidate',
        blockers: [],
      };
    }
  
    // Only reviewable cases reach this stage:
    // e.g. missing balances, multiline narrations,
    // or a valid single-transaction statement.
    if (!approval) {
      blockers.push('MANUAL_REVIEW_REQUIRED');
    } else {
      if (!approval.reviewerId.trim()) {
        blockers.push('REVIEWER_REQUIRED');
      }
  
      if (approval.approvedRevision !== draftRevision) {
        blockers.push('STALE_REVIEW_APPROVAL');
      }
  
      if (!approval.sourceDocumentChecked) {
        blockers.push('SOURCE_DOCUMENT_NOT_VERIFIED');
      }
  
      if (!approval.allTransactionsConfirmed) {
        blockers.push('TRANSACTIONS_NOT_CONFIRMED');
      }
  
      if (
        approval.confirmedTransactionCount !==
        transactionCount
      ) {
        blockers.push('TRANSACTION_COUNT_MISMATCH');
      }
    }
  
    if (blockers.length > 0) {
      return {
        allowed: false,
        mode: null,
        blockers,
      };
    }
  
    return {
      allowed: true,
      mode: 'manual_verified',
      blockers: [],
    };
  }
  