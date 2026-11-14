export interface FinancialAssessment {
  status: 'pending_context';
  score: null;
}
export const experimentalWeights = {
  flexibility: 0.3,
  resilience: 0.25,
  sustainability: 0.2,
  goalAlignment: 0.15,
  consistency: 0.1,
} as const;
export interface ScoringInput {
  userId: string;
  ontologyVersion: string;
  classifiedTransactionIds: string[];
  unclassifiedDebitAmount: string;
  classificationCoverage: number;
}
