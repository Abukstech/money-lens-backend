
import { createHash } from 'node:crypto';

export interface DraftTransaction {
  date: string;
  description: string;
  amount: string;
  direction: 'debit' | 'credit';
  currency: string;
  balance?: string | null;
  reference?: string | null;
  accountIdentifier?: string | null;
  recipientIdentifier?: string | null;
  page: number;
  row: number;
}

export function calculateDocumentHash(
  buffer: Buffer,
): string {
  return createHash('sha256')
    .update(buffer)
    .digest('hex');
}

export function calculateDraftRevision(
  documentHash: string,
  rows: readonly DraftTransaction[],
): string {
  if (!/^[a-f0-9]{64}$/i.test(documentHash)) {
    throw new Error('Invalid document hash');
  }

  // Explicit property ordering gives us consistent
  // serialization for the supported draft fields.
  const payload = {
    version: 1,
    documentHash: documentHash.toLowerCase(),
    transactions: rows.map(row => ({
      date: row.date,
      description: row.description,
      amount: row.amount,
      direction: row.direction,
      currency: row.currency,
      balance: row.balance ?? null,
      reference: row.reference ?? null,
      accountIdentifier: row.accountIdentifier ?? null,
      recipientIdentifier: row.recipientIdentifier ?? null,
      page: row.page,
      row: row.row,
    })),
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}
