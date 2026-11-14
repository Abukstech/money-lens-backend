import base from '../test/fixtures/base-narrations.json';
const merchantIds: Record<number, string> = {
  0: 'spar',
  1: 'shoprite',
  2: 'chicken_republic',
  3: 'bolt',
  4: 'uber',
  5: 'ikedc',
  6: 'ekedc',
  7: 'mtn',
  8: 'airtel',
  9: 'glo',
  23: 'spar',
};
export const fixtures = base.flatMap(([description, expectedCategory, expectedStatus], i) =>
  [
    description,
    description.toLowerCase(),
    description.replace(/ /g, '  '),
    `REF ${100000 + i} / ${description.replace(/ /g, '-')}`,
  ].map((n, j) => ({
    id: `synthetic-${i}-${j}`,
    description: n,
    expectedCategory,
    expectedStatus,
    expectedMerchantId: merchantIds[i] ?? null,
    origin: 'authored_synthetic' as const,
    direction: (expectedCategory === 'refund' ? 'credit' : 'debit') as 'debit' | 'credit',
  })),
);
