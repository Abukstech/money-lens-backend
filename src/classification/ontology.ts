import { z } from 'zod';
export const categories = [
  'groceries',
  'dining',
  'housing',
  'utilities',
  'transport',
  'telecommunications',
  'healthcare',
  'education',
  'shopping',
  'entertainment',
  'subscriptions',
  'travel',
  'personal_care',
  'family_support',
  'donations_gifts',
  'business_expenses',
  'savings',
  'investments',
  'debt_repayment',
  'financial_fees',
  'insurance',
  'taxes',
  'gambling',
  'cash_withdrawal',
  'internal_transfer',
  'income',
  'gift_received',
  'loan_received',
  'repayment_received',
  'refund',
  'transfer_unknown',
  'other',
  'unknown',
] as const;
export type Category = (typeof categories)[number];
export const categorySchema = z.enum(categories);
export const confirmedCategory = categorySchema.refine(
  (c) => c !== 'unknown' && c !== 'transfer_unknown',
  'Choose a known purpose',
);
export const ONTOLOGY_VERSION = '1.1.0';
export const POLICY_VERSION = '2.0.0-evidence-first';
export const definitions: Record<Category, string> = {
  groceries: 'Likely supermarket or food market purchases; exact items unknown',
  dining: 'Restaurants and prepared meals',
  housing: 'Rent and housing costs',
  utilities: 'Electricity, water and household utility bills',
  transport: 'Transport and mobility expenses',
  telecommunications: 'Airtime, mobile data and internet service',
  healthcare: 'Medical care and pharmacy purchases',
  education: 'Tuition and education costs',
  shopping: 'Retail goods with supporting purpose evidence',
  entertainment: 'Recreation and entertainment',
  subscriptions: 'Recurring service or streaming subscriptions',
  travel: 'Travel and accommodation',
  personal_care: 'Personal care services and products',
  family_support: 'User-supported family assistance',
  donations_gifts: 'Donations or gifts',
  business_expenses: 'Verified business costs',
  savings: 'Transfers explicitly intended as savings',
  investments: 'Investment contributions, not merely a platform match',
  debt_repayment: 'Debt principal repayments',
  financial_fees: 'Explicit bank and transaction charges',
  insurance: 'Insurance premiums',
  taxes: 'Explicit tax payments',
  gambling: 'Betting or gambling activity',
  cash_withdrawal: 'Cash movement; final consumption unknown',
  internal_transfer: 'Transfer between verified accounts owned by the same user',
  income: 'Identifiable earned or other income; a credit alone is insufficient',
  gift_received: 'Incoming gifts or family support confirmed by the user; not earned income',
  loan_received: 'Borrowed money received; not earned income',
  repayment_received:
    'Money repaid or reimbursed to the user; not automatically netted against expenses',
  refund: 'Refund or reversal; reconcile original transaction when possible',
  transfer_unknown: 'Transfer with unidentified economic purpose',
  other: 'Known purpose outside this taxonomy; never a substitute for unknown',
  unknown: 'Insufficient or conflicting purpose evidence',
};
const mapping: Record<string, Category | null> = {
  electricity: 'utilities',
  water: 'utilities',
  telecom: 'telecommunications',
  internet: 'telecommunications',
  streaming: 'subscriptions',
  bank_fees: 'financial_fees',
  investment: 'investments',
  debt: 'debt_repayment',
  business: 'business_expenses',
  giving: 'donations_gifts',
  reversal_or_refund: 'refund',
  fuel: null,
  delivery: null,
  payment_intermediary: null,
  bank: null,
};
export function mapHint(hint: string): Category | null {
  return hint in mapping
    ? mapping[hint]
    : categorySchema.safeParse(hint).success
      ? (hint as Category)
      : null;
}
