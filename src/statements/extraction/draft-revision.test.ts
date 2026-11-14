
import { describe, expect, it } from 'vitest';

import {
  calculateDocumentHash,
  calculateDraftRevision,
  type DraftTransaction,
} from './draft-revision';

const documentHash = calculateDocumentHash(
  Buffer.from('synthetic MoneyLens PDF'),
);

const rows: DraftTransaction[] = [
  {
    date: '2026-10-15',
    description: 'POS PURCHASE',
    amount: '2500.00',
    direction: 'debit',
    currency: 'NGN',
    balance: '97500.00',
    reference: 'TXN001',
    page: 0,
    row: 0,
  },
  {
    date: '2026-10-16',
    description: 'SALARY PAYMENT',
    amount: '150000.00',
    direction: 'credit',
    currency: 'NGN',
    balance: '247500.00',
    reference: 'TXN002',
    page: 0,
    row: 1,
  },
];

describe('MoneyLens draft revision integrity', () => {
  it('generates the same revision for identical data', () => {
    const first = calculateDraftRevision(
      documentHash,
      rows,
    );

    const second = calculateDraftRevision(
      documentHash,
      rows,
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when a transaction amount changes', () => {
    const original = calculateDraftRevision(
      documentHash,
      rows,
    );

    const edited = calculateDraftRevision(
      documentHash,
      [
        { ...rows[0], amount: '3500.00' },
        rows[1],
      ],
    );

    expect(edited).not.toBe(original);
  });

  it('changes when transaction direction changes', () => {
    const original = calculateDraftRevision(
      documentHash,
      rows,
    );

    const edited = calculateDraftRevision(
      documentHash,
      [
        { ...rows[0], direction: 'credit' },
        rows[1],
      ],
    );

    expect(edited).not.toBe(original);
  });

  it('changes when the transaction order changes', () => {
    const original = calculateDraftRevision(
      documentHash,
      rows,
    );

    const reordered = calculateDraftRevision(
      documentHash,
      [...rows].reverse(),
    );

    expect(reordered).not.toBe(original);
  });

  it('changes when the source document changes', () => {
    const original = calculateDraftRevision(
      documentHash,
      rows,
    );

    const differentDocument = calculateDocumentHash(
      Buffer.from('different PDF content'),
    );

    const updated = calculateDraftRevision(
      differentDocument,
      rows,
    );

    expect(updated).not.toBe(original);
  });
});
