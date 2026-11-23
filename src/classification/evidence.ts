import { normalizeNarration } from '../common/privacy';
import { Category } from './ontology';

export const PATTERN_VERSION = '1.0.0';
const purposePatterns: { id: string; category: Category; pattern: RegExp }[] = [
  {
    id: 'telecom_topup',
    category: 'telecommunications',
    pattern:
      /\b(AIRTIME|DATA BUNDLE|DATA PLAN|INTERNET SUBSCRIPTION|VTU)\b|\b(?:MTN|AIRTEL|GLO|9MOBILE)\b.*\b(?:RECHARGE|DATA)\b|\b(?:RECHARGE|DATA)\b.*\b(?:MTN|AIRTEL|GLO|9MOBILE)\b/,
  },
  {
    id: 'electricity_bill',
    category: 'utilities',
    pattern:
      /\b(ELECTRICITY (?:BILL|TOKEN|PAYMENT|PREPAID)|WATER BILL|METER TOKEN)\b|\b(?:BILL PAYMENT|PURCHASE)\b.*\bELECTRICITY\b|\b(?:IKEDC|EKEDC|IBEDC|AEDC|KEDCO|PHED)\b.*\b(?:PREPAID|TOKEN|BILL|PAYMENT)\b/,
  },
  {
    id: 'service_subscription',
    category: 'subscriptions',
    pattern:
      /\b(?:DSTV|GOTV|STARTIMES|NETFLIX|SPOTIFY)\b.*\b(?:SUBSCRIPTION|RENEWAL|BILL PAYMENT)\b|\b(?:SUBSCRIPTION|RENEWAL|BILL PAYMENT)\b.*\b(?:DSTV|GOTV|STARTIMES|NETFLIX|SPOTIFY)\b/,
  },
  {
    id: 'bank_charge',
    category: 'financial_fees',
    pattern:
      /\b(SMS ALERT(?: FEE| CHARGE)?|STAMP DUTY|TRANSFER CHARGE|MAINTENANCE FEE|EMTL|ELECTRONIC MONEY TRANSFER LEVY)\b/,
  },
];

const additionalPurposes =
  /\b(SALARY|PAYROLL|WAGES|RENT|TENANCY|TUITION|SCHOOL FEES|FAMILY SUPPORT|FREELANCE PAYMENT|ESTATE LEVY|INSURANCE PREMIUM|TAX PAYMENT)\b/g;
const genericTokens = new Set([
  'NIP',
  'NEFT',
  'TRF',
  'TRANSFER',
  'PAYMENT',
  'CREDIT',
  'DEBIT',
  'FROM',
  'TO',
  'FOR',
  'BILL',
  'REDACTED',
  'REF',
  'REFERENCE',
  'WEB',
  'POS',
  'BANK',
  'ACCOUNT',
]);

/** Shared by routing, purpose acceptance and the minimized model payload. */
export function narrationFacts(description: string, direction: string) {
  const n = normalizeNarration(description);
  const transfer = /\b(NIP|NEFT|TRF|TRANSFER)\b|\bTRF2[A-Z0-9]*\b/.test(n);
  const cash = /\bATM\b.*\b(WDL|WITHDRAWAL|CASH)\b|\b(CASHOUT|CASH OUT|POS WITHDRAWAL)\b/.test(n);
  const reversal = /\b(REVERSAL|REVERSED|REFUND|REV POS)\b/.test(n);
  const matches = purposePatterns.filter((p) => p.pattern.test(n));
  const purposes = [...new Set(matches.map((p) => p.category))];
  const contextualPurposes = (
    [
      /\b(RENT|TENANCY)\b/.test(n) ? 'housing' : null,
      /\b(TUITION|SCHOOL FEES)\b/.test(n) ? 'education' : null,
      /\b(SALARY|PAYROLL|WAGES|FREELANCE PAYMENT)\b/.test(n) ? 'income' : null,
      /\bFAMILY SUPPORT\b/.test(n)
        ? direction === 'credit'
          ? 'gift_received'
          : 'family_support'
        : null,
      /\bINSURANCE PREMIUM\b/.test(n) ? 'insurance' : null,
      /\bTAX PAYMENT\b/.test(n) ? 'taxes' : null,
    ] as (Category | null)[]
  ).filter((category): category is Category => category !== null);
  const phrases = [
    ...new Set([
      ...matches.flatMap((p) => (n.match(p.pattern)?.[0] ? [n.match(p.pattern)![0]] : [])),
      ...(n.match(additionalPurposes) ?? []),
      ...(reversal ? ['REVERSAL'] : []),
      ...(cash ? ['CASH WITHDRAWAL'] : []),
    ]),
  ];
  // Extract only vocabulary from authored patterns; never forward a matched span
  // containing arbitrary private recipient text between a biller and purpose.
  const safeVocabulary =
    /\b(AIRTIME|DATA BUNDLE|DATA PLAN|INTERNET SUBSCRIPTION|VTU|RECHARGE|MTN|AIRTEL|GLO|9MOBILE|ELECTRICITY|WATER BILL|METER TOKEN|IKEDC|EKEDC|IBEDC|AEDC|KEDCO|PHED|PREPAID|TOKEN|DSTV|GOTV|STARTIMES|NETFLIX|SPOTIFY|SUBSCRIPTION|RENEWAL|SMS ALERT|STAMP DUTY|TRANSFER CHARGE|MAINTENANCE FEE|EMTL|ELECTRONIC MONEY TRANSFER LEVY|SALARY|PAYROLL|WAGES|RENT|TENANCY|TUITION|SCHOOL FEES|FAMILY SUPPORT|FREELANCE PAYMENT|ESTATE LEVY|INSURANCE PREMIUM|TAX PAYMENT|REFUND|REVERSAL|OWN SAVINGS ACCOUNT)\b/g;
  const purposeTokens = [...new Set(n.match(safeVocabulary) ?? [])];
  return {
    n,
    transfer,
    cash,
    reversal,
    fee: purposes.includes('financial_fees'),
    purposes,
    patterns: matches.map((p) => p.id),
    purposeTokens,
    semanticPurposes: [...new Set([...purposes, ...contextualPurposes])],
    hasPurpose: phrases.length > 0,
    conflictingPurposes:
      new Set([...purposes, ...contextualPurposes]).size > 1 ||
      (cash && (purposes.length > 0 || contextualPurposes.length > 0)),
    channel: cash
      ? 'cash'
      : transfer
        ? 'bank_transfer'
        : /\bPOS\b/.test(n)
          ? 'pos'
          : /\bWEB\b/.test(n)
            ? 'web'
            : null,
    paymentStatusUnclear: /\b(DATA ERROR|FAILED|DECLINED|CANCELLED|CANCELED|UNSUCCESSFUL)\b/.test(
      n,
    ),
    contradiction: direction === 'credit' && cash && !reversal,
  };
}

export function informativeTokens(description: string) {
  return normalizeNarration(description)
    .split(' ')
    .filter((t) => /^[A-Z]{3,30}$/.test(t) && !genericTokens.has(t));
}

export function meaningfulRuleTokens(tokens: string[]) {
  return tokens.some((t) => !genericTokens.has(t.toUpperCase()));
}
